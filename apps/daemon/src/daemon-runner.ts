import { hostname } from 'node:os';
import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import type { DaemonRegistration, RunDispatch } from '@titan/daemon-protocol';
import { DaemonClient, DaemonHttpError, DaemonTransportError, type DeviceCredential } from './daemon-client.js';
import { readDeviceCredential, saveDeviceCredential } from './device-state.js';
import { PersistentOutbox } from './persistent-outbox.js';
import { ensurePrivateDirectory } from './private-state.js';
import { sanitizeProgress } from './progress-safety.js';
import { RuntimeWorker } from './runtime-worker.js';
import { WorkspaceManager } from './workspace-manager.js';
import { StateLease } from './state-lease.js';

export type DaemonRunnerOptions = {
  baseUrl: string;
  stateDirectory: string;
  workspaceRoots: string[];
  machineName?: string;
  allowRuntime?: Array<'codex' | 'qwen'>;
  runnerCommand?: string;
  runnerArgs?: string[];
  credentialEnv?: string[];
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
  private active: RuntimeWorker | undefined;
  private workerError: unknown;
  private running = false;

  constructor(options: DaemonRunnerOptions) {
    this.options = structuredClone(options);
    if (!options.workspaceRoots.length || options.workspaceRoots.some(root => !isAbsolute(root)) || !isAbsolute(options.stateDirectory)) throw new Error('ABSOLUTE_LOCAL_PATHS_REQUIRED');
    for (const value of [options.pollIntervalMs, options.heartbeatIntervalMs, options.retryMaxMs, options.requestTimeoutMs, options.cancelGraceMs, options.killGraceMs]) {
      if (value !== undefined && (!Number.isSafeInteger(value) || value < 1 || value > 86_400_000)) throw new Error('INVALID_DAEMON_INTERVAL');
    }
    if (options.allowRuntime?.some(runtime => runtime !== 'codex' && runtime !== 'qwen')) throw new Error('INVALID_RUNTIME_ALLOWLIST');
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
        machineName: options.machineName ?? hostname(), environmentType: 'local',
        capabilities: options.allowRuntime ?? ['codex', 'qwen'],
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
            if (!ack.accepted) throw new Error('PROGRESS_NOT_ACCEPTED');
            await outbox.acknowledge(pending.progress.eventId);
          }
          if (!this.active && !outbox.pending().length) {
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
      },
    };
    if (input.checkpoint) dispatch.checkpoint = sanitizeProgress({ eventId: 'validation', sequence: 1, claimToken: input.claimToken, type: 'checkpoint', payload: {}, checkpoint: input.checkpoint }).checkpoint!;
    return dispatch;
  }
}
