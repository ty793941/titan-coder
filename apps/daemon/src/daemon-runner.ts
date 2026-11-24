import { hostname } from 'node:os';
import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import type { DaemonRegistration, RunDispatch } from '@titan/daemon-protocol';
import { cloudSnapshotManifestSchema } from '@titan/contracts';
import { resolveCredential } from '../../agent-runtime/dist/credentials.js';
import { DaemonClient, DaemonHttpError, DaemonTransportError, type DeviceCredential } from './daemon-client.js';
import { readDeviceCredential, saveDeviceCredential } from './device-state.js';
import { PersistentOutbox } from './persistent-outbox.js';
import { ensurePrivateDirectory, openPrivateFile } from './private-state.js';
import { sanitizeProgress } from './progress-safety.js';
import { RuntimeWorker } from './runtime-worker.js';
import { WorkspaceManager } from './workspace-manager.js';
import { StateLease } from './state-lease.js';
import { CloudExecutor, type CloudExecutorOptions } from './cloud/cloud-executor.js';
import { DockerRuntime } from './cloud/docker-runtime.js';
import { LocalSnapshotStore } from './cloud/snapshot-store.js';
import { SecretBroker } from './cloud/secret-broker.js';

export type DaemonRunnerOptions = {
  baseUrl: string;
  stateDirectory: string;
  workspaceRoots: string[];
  machineName?: string;
  allowRuntime?: Array<'codex' | 'qwen'>;
  runnerCommand?: string;
  runnerArgs?: string[];
  credentialEnv?: string[];
  localPolicy?: { enabledSkills?: string[]; trustedCode?: boolean };
  environmentType?: 'local' | 'cloud';
  cloud?: { image: string; workspaceRoot: string; snapshotRoot: string; network?: string };
  handoff?: { snapshotRoot: string };
  pollIntervalMs?: number;
  heartbeatIntervalMs?: number;
  retryMaxMs?: number;
  requestTimeoutMs?: number;
  cancelGraceMs?: number;
  killGraceMs?: number;
};

function pause(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise(resolve => {
    const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve(); };
    const timer = setTimeout(finish, milliseconds);
    signal.addEventListener('abort', finish, { once: true });
  });
}

function retryable(error: unknown): boolean {
  return error instanceof DaemonTransportError || error instanceof DaemonHttpError && (error.status === 408 || error.status === 429 || error.status >= 500);
}

export class DaemonRunner {
  private readonly options: DaemonRunnerOptions;
  private readonly client: DaemonClient;
  private readonly workspace: WorkspaceManager;
  private active: RuntimeWorker | CloudExecutor | undefined;
  private finishedCloud: CloudExecutor | undefined;
  private cloudOptions: CloudExecutorOptions | undefined;
  private sourceSnapshots: LocalSnapshotStore | undefined;
  private workerError: unknown;
  private running = false;

  constructor(options: DaemonRunnerOptions) {
    this.options = structuredClone(options);
    if (!options.workspaceRoots.length || options.workspaceRoots.some(root => !isAbsolute(root)) || !isAbsolute(options.stateDirectory)) throw new Error('ABSOLUTE_LOCAL_PATHS_REQUIRED');
    if (options.environmentType !== undefined && !['local', 'cloud'].includes(options.environmentType)) throw new Error('INVALID_EXECUTION_ENVIRONMENT');
    if (options.environmentType === 'cloud' && !options.cloud) throw new Error('CLOUD_CONFIGURATION_REQUIRED');
    if (options.cloud && (options.environmentType !== 'cloud' || !isAbsolute(options.cloud.workspaceRoot) || !isAbsolute(options.cloud.snapshotRoot) ||
      options.workspaceRoots.length !== 1 || resolve(options.workspaceRoots[0]!) !== resolve(options.cloud.workspaceRoot))) throw new Error('INVALID_CLOUD_CONFIGURATION');
    if (options.handoff && (!isAbsolute(options.handoff.snapshotRoot) || options.environmentType === 'cloud')) throw new Error('INVALID_HANDOFF_CONFIGURATION');
    for (const value of [options.pollIntervalMs, options.heartbeatIntervalMs, options.retryMaxMs, options.requestTimeoutMs, options.cancelGraceMs, options.killGraceMs]) {
      if (value !== undefined && (!Number.isSafeInteger(value) || value < 1 || value > 86_400_000)) throw new Error('INVALID_DAEMON_INTERVAL');
    }
    if (options.allowRuntime?.some(runtime => runtime !== 'codex' && runtime !== 'qwen')) throw new Error('INVALID_RUNTIME_ALLOWLIST');
    if (options.localPolicy && ((options.localPolicy.trustedCode !== undefined && typeof options.localPolicy.trustedCode !== 'boolean') ||
        options.localPolicy.enabledSkills?.some(id => typeof id !== 'string' || !/^[a-zA-Z0-9._-]{1,200}$/.test(id)))) throw new Error('INVALID_LOCAL_POLICY');
    this.client = new DaemonClient(options.baseUrl, options.requestTimeoutMs);
    this.workspace = new WorkspaceManager(options.workspaceRoots);
  }

  async run(signal: AbortSignal): Promise<void> {
    if (this.running) throw new Error('DAEMON_ALREADY_RUNNING');
    this.running = true;
    const options = this.options;
    const pollMs = options.pollIntervalMs ?? 1000;
    const heartbeatMs = options.heartbeatIntervalMs ?? 10_000;
    const retryMaxMs = Math.max(pollMs, options.retryMaxMs ?? 5000);
    let failures = 0;
    let lastHeartbeat = 0;
    let heartbeatSequence = 0;
    let lease: StateLease | undefined;
    try {
      const command = await realpath(options.runnerCommand ?? process.execPath);
      if (command !== await realpath(process.execPath)) throw new Error('WORKER_MUST_USE_TRUSTED_NODE');
      const args = options.runnerArgs ?? [fileURLToPath(new URL('../../agent-runtime/dist/worker.js', import.meta.url))];
      if (args.length !== 1 || !args[0] || !isAbsolute(args[0]) || !/\.(?:cjs|mjs|js)$/.test(args[0])) throw new Error('WORKER_REQUIRES_LOCAL_NODE_SCRIPT');
      const script = await realpath(args[0]);
      const env: NodeJS.ProcessEnv = {};
      for (const name of ['PATH', 'HOME', 'TMPDIR', 'LANG', ...(options.credentialEnv ?? [])]) {
        if (!/^[A-Z_][A-Z0-9_]*$/.test(name) || /^(?:NODE_|LD_|DYLD_)/.test(name)) throw new Error('UNSAFE_WORKER_ENVIRONMENT');
        if (process.env[name] !== undefined) env[name] = process.env[name];
      }
      const secrets = (options.credentialEnv ?? []).map(name => env[name]).filter((value): value is string => Boolean(value));
      await ensurePrivateDirectory(options.stateDirectory);
      lease = await StateLease.acquire(options.stateDirectory);
      const credentialPath = join(options.stateDirectory, 'device.json');
      let credential = await readDeviceCredential(credentialPath, this.client.baseUrl);
      const registration: DaemonRegistration = {
        machineName: options.machineName ?? hostname(), environmentType: options.environmentType ?? 'local',
        capabilities: [...(options.allowRuntime ?? ['codex', 'qwen']), ...(options.cloud ? ['cloud-session', 'container', 'snapshot-transfer', 'secret-lease'] : [])],
        workspaceRoots: await Promise.all(options.workspaceRoots.map(root => this.workspace.assertAllowed(root))),
        maxConcurrentSessions: 1, daemonVersion: '0.1.0',
      };
      while (!credential && !signal.aborted) {
        try {
          credential = await this.client.register(registration, signal);
          await saveDeviceCredential(credentialPath, credential);
          failures = 0;
        } catch (error) {
          if (signal.aborted) return;
          // 文件持久化失败不能当作网络错误重试注册，避免产生重复设备。
          if (credential || !retryable(error)) throw error;
          await pause(Math.min(retryMaxMs, pollMs * 2 ** Math.min(failures++, 8)), signal);
        }
      }
      if (!credential) return;
      const device = credential;
      secrets.push(device.authToken);
      const outbox = await PersistentOutbox.open(join(options.stateDirectory, 'outbox.jsonl'), secrets);
      if (options.handoff) this.sourceSnapshots = new LocalSnapshotStore({ root: options.handoff.snapshotRoot, workspaceRoots: registration.workspaceRoots });
      if (options.cloud) {
        const cloud = options.cloud;
        this.cloudOptions = {
          stateDirectory: join(options.stateDirectory, 'cloud'), workspaceRoot: cloud.workspaceRoot,
          runtime: new DockerRuntime({ image: cloud.image, workspaceRoot: cloud.workspaceRoot, ownerId: device.daemonId, ...(cloud.network ? { network: cloud.network } : {}) }),
          snapshots: new LocalSnapshotStore({ root: cloud.snapshotRoot, workspaceRoots: [cloud.workspaceRoot] }),
          broker: new SecretBroker(async reference => reference.startsWith('keychain://') ? resolveCredential(reference) : undefined),
          lifecycle: body => {
            if (!this.active) throw new Error('CLOUD_ACTIVE_SESSION_REQUIRED');
            return this.client.cloudLifecycle(device, this.active.dispatch.runId, body);
          },
          onProgress: progress => outbox.append({ daemonId: device.daemonId, runId: this.active!.dispatch.runId, progress: sanitizeProgress(progress, [device.authToken]) }),
          initialSequence: 0, recoverSequence: runId => outbox.lastSequence(runId),
          ...(options.localPolicy ? { localPolicy: options.localPolicy } : {}),
        };
        const recovered = await CloudExecutor.recover(this.cloudOptions);
        if (recovered) this.trackCloud(recovered);
      }
      while (!signal.aborted) {
        if (this.workerError) throw this.workerError;
        try {
          if (Date.now() - lastHeartbeat >= heartbeatMs) {
            await this.client.heartbeat(device, { daemonId: device.daemonId, sequence: ++heartbeatSequence, occurredAt: new Date().toISOString() }, signal);
            lastHeartbeat = Date.now();
          }
          if (this.active) {
            const control = await this.client.control(device, this.active.dispatch.runId, signal);
            if (control.cancelRequested || control.status === 'cancelled') this.active?.cancel();
          }
          const pending = outbox.pending()[0];
          if (pending) {
            if (pending.daemonId !== device.daemonId) throw new Error('OUTBOX_DEVICE_MISMATCH');
            const ack = await this.client.progress(device, pending.runId, pending.progress, signal);
            if (ack.cancelRequested && this.active?.dispatch.runId === pending.runId) this.active.cancel();
            // accepted=false 表示控制面已去重或终态已固定，HTTP 成功即可确认本地重放。
            await outbox.acknowledge(pending.progress.eventId);
          }
          if (this.finishedCloud && !outbox.pending().length) {
            await this.finishedCloud.cleanup();
            this.finishedCloud = undefined;
            this.active = undefined;
          }
          if (!this.active && !outbox.pending().length) {
            if (this.sourceSnapshots) await this.exportHandoffs(device, signal);
            const dispatch = await this.client.claim(device, signal);
            if (dispatch) await this.launch(dispatch, device, outbox, command, [script], env);
          }
          failures = 0;
        } catch (error) {
          if (signal.aborted) break;
          if (!retryable(error)) throw error;
          failures++;
        }
        await pause(failures ? Math.min(retryMaxMs, pollMs * 2 ** Math.min(failures - 1, 8)) : pollMs, signal);
      }
    } finally {
      try { if (this.active) { this.active.shutdown(); await this.active.done; } }
      finally { if (lease) await lease.release(); this.running = false; }
    }
  }

  private async launch(input: RunDispatch, device: DeviceCredential, outbox: PersistentOutbox, command: string, args: string[], env: NodeJS.ProcessEnv): Promise<void> {
    if (this.cloudOptions) {
      if (input.config?.daemonId !== device.daemonId || input.config.environmentType !== 'cloud' || !input.cloud ||
        input.config.workspacePath !== '/workspace/session' || !(this.options.allowRuntime ?? ['codex', 'qwen']).includes(input.config.runtime)) throw new Error('INVALID_CLOUD_DISPATCH');
      const executor = new CloudExecutor(input, { ...this.cloudOptions, initialSequence: outbox.lastSequence(input.runId) });
      this.trackCloud(executor);
      return;
    }
    let dispatch: RunDispatch;
    try { dispatch = await this.validateDispatch(input, device); }
    catch {
      if (!input || typeof input.runId !== 'string' || !input.runId || typeof input.claimToken !== 'string' || !input.claimToken) throw new Error('INVALID_DISPATCH_IDENTITY');
      await outbox.append({ daemonId: device.daemonId, runId: input.runId, progress: {
        eventId: randomUUID(), sequence: outbox.lastSequence(input.runId) + 1, claimToken: input.claimToken, type: 'failed',
        payload: { code: 'INVALID_DISPATCH', message: 'Dispatch violates local runtime or workspace policy' },
      } });
      return;
    }
    const secrets = [device.authToken, dispatch.claimToken, ...(this.options.credentialEnv ?? []).map(name => env[name] ?? '')];
    const worker = new RuntimeWorker(dispatch, {
      command, args, env, cancelGraceMs: this.options.cancelGraceMs ?? 300,
      killGraceMs: this.options.killGraceMs ?? 1000, initialSequence: outbox.lastSequence(dispatch.runId),
      onProgress: progress => outbox.append({ daemonId: device.daemonId, runId: dispatch.runId, progress: sanitizeProgress(progress, secrets) }),
    });
    this.active = worker;
    void worker.done.then(() => { if (this.active === worker) this.active = undefined; }, error => { this.workerError = error; });
  }

  private trackCloud(executor: CloudExecutor): void {
    this.active = executor;
    void executor.done.then(() => { this.finishedCloud = executor; }, error => { this.workerError = error; });
  }

  private async exportHandoffs(device: DeviceCredential, signal: AbortSignal): Promise<void> {
    const pending = await this.client.pendingHandoffs(device, signal);
    for (const request of pending.requests) {
      if (signal.aborted) return;
      if (!/^[a-zA-Z0-9_-]{1,200}$/.test(request.id)) throw new Error('INVALID_HANDOFF_ID');
      const path = join(this.options.stateDirectory, `handoff-${request.id}.json`);
      let manifest;
      try {
        let file;
        try { file = await openPrivateFile(path, constants.O_RDONLY); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        if (file) {
          try { manifest = cloudSnapshotManifestSchema.parse(JSON.parse(await file.readFile('utf8'))); }
          finally { await file.close(); }
        } else {
          const workspacePath = await this.workspace.assertAllowed(request.workspacePath);
          const exported = await this.sourceSnapshots!.exportWorkspace(workspacePath);
          manifest = cloudSnapshotManifestSchema.parse({ ...exported, checksum: exported.checksum.startsWith('sha256:') ? exported.checksum : `sha256:${exported.checksum}` });
          const saved = await openPrivateFile(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY);
          try { await saved.writeFile(JSON.stringify(manifest)); await saved.sync(); }
          finally { await saved.close(); }
        }
      } catch {
        await this.client.failHandoff(device, request.id, 'HANDOFF_SNAPSHOT_FAILED', signal);
        continue;
      }
      try { await this.client.acknowledgeSnapshot(device, request.id, manifest, signal); }
      catch (error) {
        // 目标容量或批准计划暂不可用时保留同一快照，下轮继续确认。
        if (error instanceof DaemonHttpError && [400, 409].includes(error.status)) continue;
        throw error;
      }
    }
  }

  private async validateDispatch(input: RunDispatch, device: DeviceCredential): Promise<RunDispatch> {
    const config = input?.config;
    for (const value of [input?.jobId, input?.runId, input?.sessionId, input?.taskId, input?.projectId, input?.planHash, input?.claimToken]) {
      if (typeof value !== 'string' || !value || value.length > 4096) throw new Error('INVALID_DISPATCH');
    }
    if (typeof input.goal !== 'string' || !input.goal || input.goal.length > 1024 * 1024 || !config || config.daemonId !== device.daemonId ||
        !(this.options.allowRuntime ?? ['codex', 'qwen']).includes(config.runtime) ||
        typeof config.credentialRef !== 'string' || !config.credentialRef || config.credentialRef.length > 4096 ||
        (config.modelRef !== undefined && typeof config.modelRef !== 'string') ||
        !Number.isSafeInteger(config.maxTurns) || config.maxTurns < 1 || config.maxTurns > 10_000 ||
        !Number.isSafeInteger(config.timeoutMs) || config.timeoutMs < 1 || config.timeoutMs > 86_400_000 ||
        !Array.isArray(config.allowedTools) || config.allowedTools.length > 1000 || config.allowedTools.some(tool => typeof tool !== 'string') ||
        typeof config.workspacePath !== 'string' || !isAbsolute(config.workspacePath)) throw new Error('INVALID_DISPATCH');
    const workspacePath = await this.workspace.assertAllowed(config.workspacePath);
    if (!(await stat(workspacePath)).isDirectory()) throw new Error('INVALID_WORKSPACE');
    const dispatch: RunDispatch = {
      jobId: input.jobId, runId: input.runId, sessionId: input.sessionId, taskId: input.taskId, projectId: input.projectId,
      goal: input.goal, planHash: input.planHash, claimToken: input.claimToken,
      config: {
        daemonId: config.daemonId, runtime: config.runtime, credentialRef: config.credentialRef,
        workspacePath: resolve(workspacePath), allowedTools: [...config.allowedTools], maxTurns: config.maxTurns, timeoutMs: config.timeoutMs,
        ...(config.modelRef === undefined ? {} : { modelRef: config.modelRef }),
        ...(config.baseUrlRef === undefined ? {} : { baseUrlRef: config.baseUrlRef }),
        ...(this.options.localPolicy ? { localPolicy: structuredClone(this.options.localPolicy) } : {}),
      },
    };
    if (input.checkpoint) dispatch.checkpoint = sanitizeProgress({ eventId: 'validation', sequence: 1, claimToken: input.claimToken, type: 'checkpoint', payload: {}, checkpoint: input.checkpoint }).checkpoint!;
    return dispatch;
  }
}
