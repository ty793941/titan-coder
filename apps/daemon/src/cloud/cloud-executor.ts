import { constants } from 'node:fs';
import { lstat, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runProgressSchema } from '@titan/contracts';
import type { RunDispatch, RunProgress } from '@titan/daemon-protocol';
import { ensurePrivateDirectory, openPrivateFile } from '../private-state.js';
import { sanitizeProgress } from '../progress-safety.js';
import type { DockerRuntime } from './docker-runtime.js';
import { assertCloudDirectory, type LocalSnapshotStore } from './snapshot-store.js';
import type { SecretBroker } from './secret-broker.js';
import type { ContainerHandle } from './types.js';

export type CloudExecutorOptions = {
  stateDirectory: string;
  workspaceRoot: string;
  runtime: DockerRuntime;
  snapshots: LocalSnapshotStore;
  broker: SecretBroker;
  lifecycle: (body: { claimToken: string; status: 'creating' | 'starting' | 'running'; containerId?: string; consumeSecret?: boolean }) => Promise<unknown>;
  onProgress: (progress: RunProgress) => Promise<void>;
  initialSequence: number;
  localPolicy?: { enabledSkills?: string[]; trustedCode?: boolean };
  recoverSequence?: (runId: string) => number;
};

type ActiveState = {
  version: 1;
  dispatch: RunDispatch;
  handle?: ContainerHandle;
  deadlineAt: number;
  sequenceBase: number;
  completed: boolean;
};
const MAX_FRAME = 1024 * 1024;
const MAX_STREAM = 16 * MAX_FRAME;
const terminal = new Set(['completed', 'failed', 'cancelled', 'waiting_input']);
const scopeId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(value);
const protocolError = () => new Error('CLOUD_WORKER_PROTOCOL_ERROR');

async function readActive(directory: string): Promise<ActiveState | undefined> {
  await ensurePrivateDirectory(directory);
  assertCloudDirectory(directory);
  let file;
  try { file = await openPrivateFile(join(directory, 'active.json'), constants.O_RDONLY); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw new Error('CLOUD_RECOVERY_STATE_INVALID'); }
  try {
    if ((await file.stat()).size > 4 * MAX_FRAME) throw protocolError();
    const state = JSON.parse(await file.readFile('utf8')) as ActiveState | null;
    if (state === null) return undefined;
    if (!state || state.version !== 1 || !scopeId(state.dispatch?.sessionId) || !scopeId(state.dispatch?.runId)
      || typeof state.dispatch.claimToken !== 'string' || !state.dispatch.config || !state.dispatch.cloud
      || !Number.isSafeInteger(state.deadlineAt) || !Number.isSafeInteger(state.sequenceBase) || state.sequenceBase < 0 || typeof state.completed !== 'boolean') throw protocolError();
    return state;
  } catch { throw new Error('CLOUD_RECOVERY_STATE_INVALID'); }
  finally { await file.close(); }
}

export class CloudExecutor {
  readonly done: Promise<void>;
  private readonly options: CloudExecutorOptions;
  private readonly recovering: boolean;
  private state: ActiveState;
  private handle: ContainerHandle | undefined;
  private absenceConfirmed = false;
  private stream: ChildProcessWithoutNullStreams | undefined;
  private readonly interrupt = new AbortController();
  private reason: 'cancel' | 'shutdown' | 'timeout' | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private sequence: number;
  private containerSequence = 0;
  private readonly eventIds = new Set<string>();
  private queue = Promise.resolve();
  private pendingTerminal: RunProgress | undefined;
  private resultSeen = false;
  private secrets: string[] = [];
  private ownsState = false;
  private finished = false;
  private deliveryFailed = false;
  private stopAttempt: Promise<void> | undefined;
  private stage: 'prepare' | 'snapshot' | 'create' | 'secret' | 'start' | 'run' | 'recover' = 'prepare';

  constructor(readonly dispatch: RunDispatch, options: CloudExecutorOptions, recovered?: ActiveState) {
    this.options = { ...options };
    this.recovering = recovered !== undefined;
    this.dispatch = structuredClone(dispatch);
    this.dispatch.config.workspacePath = join(options.workspaceRoot, dispatch.sessionId, 'session');
    delete this.dispatch.config.localPolicy;
    if (options.localPolicy) this.dispatch.config.localPolicy = structuredClone(options.localPolicy);
    this.sequence = options.initialSequence;
    this.state = recovered ?? { version: 1, dispatch: this.dispatch, deadlineAt: Date.now() + dispatch.config.timeoutMs, sequenceBase: options.initialSequence, completed: false };
    this.done = this.execute(this.recovering);
  }

  static async recover(options: CloudExecutorOptions): Promise<CloudExecutor | undefined> {
    const state = await readActive(options.stateDirectory);
    if (!state) return undefined;
    return new CloudExecutor(state.dispatch, { ...options, initialSequence: options.recoverSequence?.(state.dispatch.runId) ?? options.initialSequence }, state);
  }

  cancel(): void { this.stop('cancel'); }
  shutdown(): void { this.stop('shutdown'); }

  private stop(reason: NonNullable<CloudExecutor['reason']>): void {
    if (this.finished || this.reason) return;
    this.reason = reason;
    this.interrupt.abort();
    this.stream?.kill('SIGTERM');
    if (reason !== 'shutdown') void this.stopContainer().catch(() => undefined);
  }

  private stopContainer(): Promise<void> {
    if (!this.handle) return Promise.resolve();
    this.stopAttempt ??= this.options.runtime.stop(this.handle);
    return this.stopAttempt;
  }

  async cleanup(): Promise<void> {
    // 调用方必须先确认 Outbox 已全部 ACK；工作目录和工件始终保留。
    await this.done;
    if (!this.finished || !this.ownsState) throw new Error('CLOUD_CLEANUP_NOT_READY');
    const active = await readActive(this.options.stateDirectory);
    if (!active) return;
    if (active.dispatch.runId !== this.dispatch.runId || active.dispatch.claimToken !== this.dispatch.claimToken) throw new Error('CLOUD_CLEANUP_FENCED');
    if (active.handle) {
      const found = await this.options.runtime.find(this.dispatch);
      if (found && (found.id !== active.handle.id || found.name !== active.handle.name)) throw new Error('CLOUD_CLEANUP_FENCED');
      if (found) {
        if ((await this.options.runtime.inspect(found)).state === 'running') throw new Error('CLOUD_CLEANUP_CONTAINER_RUNNING');
        await this.options.runtime.remove(found);
      }
    }
    await this.persist(null);
  }

  private async persist(state: ActiveState | null = this.state): Promise<void> {
    try {
      await ensurePrivateDirectory(this.options.stateDirectory);
      assertCloudDirectory(this.options.stateDirectory);
      const path = join(this.options.stateDirectory, 'active.json');
      const existing = await lstat(path).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; return undefined; });
      if (existing && (!existing.isFile() || existing.isSymbolicLink())) throw new Error('CLOUD_RECOVERY_STATE_INVALID');
      const bytes = JSON.stringify(state);
      if (Buffer.byteLength(bytes) > 4 * MAX_FRAME) throw new Error('CLOUD_RECOVERY_STATE_INVALID');
      const temporary = join(this.options.stateDirectory, `.active-${randomUUID()}.tmp`);
      const file = await openPrivateFile(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY);
      try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
      assertCloudDirectory(this.options.stateDirectory);
      await rename(temporary, path);
    } catch { throw new Error('CLOUD_RECOVERY_STATE_WRITE_FAILED'); }
  }

  private checkInterrupted(): void {
    if (!this.reason && Date.now() >= this.state.deadlineAt) this.stop('timeout');
    if (this.reason) throw new Error('CLOUD_EXECUTION_INTERRUPTED');
  }

  private wait<T>(operation: Promise<T>, discard?: (value: T) => void): Promise<T> {
    return new Promise((resolve, reject) => {
      const abort = () => { this.interrupt.signal.removeEventListener('abort', abort); reject(new Error('CLOUD_EXECUTION_INTERRUPTED')); };
      this.interrupt.signal.addEventListener('abort', abort, { once: true });
      operation.then(value => {
        this.interrupt.signal.removeEventListener('abort', abort);
        if (this.interrupt.signal.aborted) { discard?.(value); abort(); }
        else resolve(value);
      }, error => { this.interrupt.signal.removeEventListener('abort', abort); reject(error); });
      if (this.interrupt.signal.aborted) abort();
    });
  }

  private async lifecycle(status: 'creating' | 'starting' | 'running', consumeSecret = false): Promise<void> {
    this.checkInterrupted();
    await this.wait(this.options.lifecycle({ claimToken: this.dispatch.claimToken, status, ...(this.handle ? { containerId: this.handle.id } : {}), ...(consumeSecret ? { consumeSecret: true } : {}) }));
    this.checkInterrupted();
  }

  private bootstrap(credentials: Record<string, string>): Buffer {
    const { jobId, projectId, taskId, sessionId, runId, claimToken, goal, planHash, checkpoint } = this.dispatch;
    const source = this.dispatch.config;
    const config = {
      daemonId: source.daemonId, runtime: source.runtime, credentialRef: source.credentialRef,
      ...(source.baseUrlRef ? { baseUrlRef: source.baseUrlRef } : {}), ...(source.modelRef ? { modelRef: source.modelRef } : {}),
      workspacePath: '/workspace/session', allowedTools: source.allowedTools, maxTurns: source.maxTurns, timeoutMs: Math.max(1, this.state.deadlineAt - Date.now()),
      ...(this.options.localPolicy ? { localPolicy: this.options.localPolicy } : {}),
    };
    const bytes = Buffer.from(`${JSON.stringify({ version: 1, dispatch: { jobId, projectId, taskId, sessionId, runId, claimToken, goal, planHash, config, ...(checkpoint ? { checkpoint } : {}) }, credentials })}\n`);
    if (bytes.length > 2 * MAX_FRAME) throw new Error('CLOUD_CONTAINER_BOOTSTRAP');
    return bytes;
  }

  private async execute(recovering: boolean): Promise<void> {
    try {
      if (!scopeId(this.dispatch.sessionId) || !scopeId(this.dispatch.runId) || !this.dispatch.cloud
        || !isAbsolute(this.options.workspaceRoot) || !isAbsolute(this.options.stateDirectory)
        || !Number.isSafeInteger(this.sequence) || this.sequence < this.state.sequenceBase
        || !Number.isSafeInteger(this.dispatch.config.timeoutMs) || this.dispatch.config.timeoutMs < 1 || this.dispatch.config.timeoutMs > 86_400_000) throw protocolError();
      if (recovering) {
        this.ownsState = true;
        this.stage = 'recover';
        if (this.state.dispatch.config.workspacePath !== this.dispatch.config.workspacePath) throw new Error('CLOUD_RECOVERY_FENCED');
        const found = await this.options.runtime.find(this.dispatch);
        this.absenceConfirmed = !found;
        if (this.state.handle && found && (found.id !== this.state.handle.id || found.name !== this.state.handle.name)) throw new Error('CLOUD_RECOVERY_FENCED');
        this.handle = found;
        const status = found ? await this.options.runtime.inspect(found) : { state: 'missing' };
        if (this.state.completed) {
          if (status.state !== 'exited' && status.state !== 'missing') throw new Error('CLOUD_RECOVERY_FENCED');
          this.finished = true; return;
        }
        if (!found) throw new Error('CLOUD_RECOVERY_FENCED');
        if (status.state !== 'running' && status.state !== 'exited') throw new Error('CLOUD_RECOVERY_FENCED');
        this.state.handle = found;
      } else {
        if (await readActive(this.options.stateDirectory)) throw new Error('CLOUD_RECOVERY_FENCED');
        this.ownsState = true;
        await this.persist();
      }
      this.checkInterrupted();
      this.timer = setTimeout(() => this.stop('timeout'), Math.max(0, this.state.deadlineAt - Date.now()));
      let streamDone: Promise<number | null>;
      if (recovering) {
        this.stream = this.options.runtime.logs(this.handle!);
        streamDone = this.collect(this.stream);
      } else {
        await this.lifecycle('creating');
        this.stage = 'snapshot';
        assertCloudDirectory(this.options.workspaceRoot);
        const parent = join(this.options.workspaceRoot, this.dispatch.sessionId);
        await ensurePrivateDirectory(parent);
        assertCloudDirectory(parent);
        await this.options.snapshots.materialize({ ...this.dispatch.cloud.snapshot, checksum: this.dispatch.cloud.snapshot.checksum.replace(/^sha256:/, '') }, join(parent, 'session'));
        this.checkInterrupted();
        this.stage = 'create';
        this.handle = await this.options.runtime.create({ sessionId: this.dispatch.sessionId, runId: this.dispatch.runId, workspacePath: parent });
        this.state.handle = this.handle;
        await this.persist(); this.checkInterrupted();
        if ((await this.options.runtime.inspect(this.handle)).state !== 'created') throw new Error('CLOUD_RECOVERY_FENCED');
        this.stage = 'secret';
        await this.lifecycle('creating', true);
        const credentials = await this.wait(this.options.broker.consume({ leaseId: this.dispatch.cloud.secretLeaseId, sessionId: this.dispatch.sessionId,
          expiresAt: this.dispatch.cloud.secretLeaseExpiresAt, credentialRef: this.dispatch.config.credentialRef, ...(this.dispatch.config.baseUrlRef ? { baseUrlRef: this.dispatch.config.baseUrlRef } : {}) }),
        values => { for (const key of Object.keys(values)) delete values[key]; });
        this.secrets = Object.values(credentials);
        if (this.dispatch.config.baseUrlRef && credentials[this.dispatch.config.baseUrlRef]) {
          try { this.secrets.push(new URL(credentials[this.dispatch.config.baseUrlRef]!).href.replace(/\/$/, '')); } catch { /* 无效 URL 由 Runtime 拒绝。 */ }
        }
        try {
          this.checkInterrupted();
          this.stage = 'start';
          await this.lifecycle('starting');
          this.stream = this.options.runtime.start(this.handle, this.bootstrap(credentials));
          streamDone = this.collect(this.stream);
          void streamDone.catch(() => undefined);
          await this.lifecycle('running');
        } finally { for (const key of Object.keys(credentials)) delete credentials[key]; }
      }
      this.stage = 'run';
      const cliExitCode = await streamDone;
      await this.queue;
      this.checkInterrupted();
      const status = await this.options.runtime.inspect(this.handle!);
      if (status.state !== 'exited') throw new Error('CLOUD_CONTAINER_STREAM_LOST');
      if (!this.pendingTerminal || (this.pendingTerminal.type === 'completed' && (status.exitCode !== 0 || cliExitCode !== 0))) throw new Error('CLOUD_CONTAINER_EXITED');
      const mappedSequence = this.state.sequenceBase + this.pendingTerminal.sequence;
      if (mappedSequence < this.sequence) throw new Error('CLOUD_RECOVERY_FENCED');
      if (mappedSequence > this.sequence) await this.deliver({ ...this.pendingTerminal, sequence: mappedSequence });
      this.finished = true;
      this.state.completed = true;
      await this.persist();
    } catch (error) {
      if (this.finished) throw new Error('CLOUD_RECOVERY_STATE_WRITE_FAILED');
      await this.queue.catch(() => undefined);
      if (this.reason === 'shutdown') return;
      let stopped = !this.state.handle || Boolean(this.handle) || this.absenceConfirmed;
      if (this.handle) {
        try {
          await this.stopContainer();
          stopped = (await this.options.runtime.inspect(this.handle)).state !== 'running';
        } catch { stopped = false; }
      }
      if (this.deliveryFailed) throw new Error('CLOUD_PROGRESS_DELIVERY_FAILED');
      const { code, type } = this.failureDecision(error, stopped);
      await this.deliver({ eventId: randomUUID(), sequence: this.sequence + 1, claimToken: this.dispatch.claimToken, type, payload: { code, message: 'Cloud execution requires attention' } });
      this.finished = stopped;
      if (this.ownsState) { this.state.completed = stopped; await this.persist(); }
    } finally {
      clearTimeout(this.timer);
      this.stream?.kill('SIGTERM');
      this.secrets = [];
    }
  }

  private failureDecision(error: unknown, stopped: boolean): { code: string; type: RunProgress['type'] } {
    if (error instanceof Error && error.message === 'CLOUD_RECOVERY_FENCED') return { code: 'CLOUD_RECOVERY_FENCED', type: 'waiting_input' };
    if (!stopped) return { code: 'CLOUD_CONTAINER_STOP_UNCONFIRMED', type: 'waiting_input' };
    if (this.reason === 'timeout') return { code: 'CLOUD_CONTAINER_TIMEOUT', type: 'failed' };
    if (this.reason === 'cancel') return { code: 'CLOUD_CANCELLED', type: 'cancelled' };
    if (this.recovering) return { code: 'CLOUD_RECOVERY_FENCED', type: 'waiting_input' };
    if (this.stage === 'secret') return { code: 'CLOUD_SECRET_UNAVAILABLE', type: 'waiting_input' };
    const codes: Partial<Record<typeof this.stage, string>> = {
      snapshot: 'CLOUD_SNAPSHOT_FAILED', create: 'CLOUD_CONTAINER_CREATE_FAILED', start: 'CLOUD_CONTAINER_START_FAILED',
    };
    return { code: codes[this.stage] ?? 'CLOUD_WORKER_PROTOCOL_ERROR', type: 'failed' };
  }

  private collect(stream: ChildProcessWithoutNullStreams): Promise<number | null> {
    return new Promise((resolve, reject) => {
      let buffer = Buffer.alloc(0);
      let bytes = 0;
      let closed = false;
      let ended = false;
      let settled = false;
      let exitCode: number | null = null;
      const detach = () => {
        stream.stdout.off('data', data); stream.stdout.off('end', end); stream.off('close', close); stream.off('error', failure);
        this.interrupt.signal.removeEventListener('abort', abort);
      };
      const failure = () => { if (settled) return; settled = true; detach(); stream.kill('SIGTERM'); reject(protocolError()); };
      const complete = () => {
        if (settled || !closed || !ended) return;
        if (buffer.length) { failure(); return; }
        settled = true; detach(); resolve(exitCode);
      };
      const data = (chunk: Buffer | string) => {
        if (settled) return;
        const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += incoming.length;
        if (bytes > MAX_STREAM) { failure(); return; }
        buffer = Buffer.concat([buffer, incoming]);
        let index: number;
        while ((index = buffer.indexOf(10)) >= 0) {
          if (index > MAX_FRAME) { failure(); return; }
          const line = buffer.subarray(0, index);
          buffer = buffer.subarray(index + 1);
          this.queue = this.queue.then(() => this.frame(line));
          void this.queue.catch(failure);
        }
        if (buffer.length > MAX_FRAME) { failure(); return; }
        stream.stdout.pause();
        void this.queue.then(() => stream.stdout.resume(), failure);
      };
      const end = () => { ended = true; complete(); };
      const close = (code: number | null) => { closed = true; exitCode = code; complete(); };
      const abort = () => failure();
      stream.stdout.on('data', data); stream.stdout.on('end', end); stream.on('close', close); stream.on('error', failure);
      stream.stderr.resume();
      this.interrupt.signal.addEventListener('abort', abort, { once: true });
      if (this.interrupt.signal.aborted) failure();
    });
  }

  private async frame(line: Buffer): Promise<void> {
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(line)) as Record<string, unknown>;
    if (!value || value.version !== 1 || this.resultSeen) throw protocolError();
    if (value.type === 'result') {
      const expected = this.pendingTerminal?.type === 'completed' ? 'satisfied' : this.pendingTerminal?.type;
      if (!expected || value.status !== expected || Object.keys(value).some(key => !['version', 'type', 'status'].includes(key))) throw protocolError();
      this.resultSeen = true;
      return;
    }
    if (value.type !== 'progress' || Object.keys(value).some(key => !['version', 'type', 'progress'].includes(key))) throw protocolError();
    const progress = runProgressSchema.parse(value.progress) as RunProgress;
    if (progress.claimToken !== this.dispatch.claimToken || progress.sequence !== this.containerSequence + 1 || this.eventIds.has(progress.eventId) || this.pendingTerminal
      || this.secrets.some(secret => secret && progress.eventId.includes(secret))) throw protocolError();
    this.containerSequence = progress.sequence;
    this.eventIds.add(progress.eventId);
    if (terminal.has(progress.type)) { this.pendingTerminal = progress; return; }
    // 生命周期不产生 RunProgress，固定偏移使日志重放与宿主 Outbox 对齐。
    const sequence = this.state.sequenceBase + progress.sequence;
    if (sequence > this.sequence) await this.deliver({ ...progress, sequence });
  }

  private mapArtifactReference(value: string): string {
    if (!value.startsWith('file:')) return value;
    const prefix = '/workspace/session/.titan/artifacts/';
    const path = fileURLToPath(value);
    if (!path.startsWith(prefix)) throw protocolError();
    const suffix = path.slice(prefix.length);
    if (!suffix || suffix.split('/').some(part => !part || part === '..' || part === '.') || /[\x00-\x1f\\]/.test(suffix)) throw protocolError();
    return pathToFileURL(join(this.options.workspaceRoot, this.dispatch.sessionId, 'session', '.titan', 'artifacts', suffix)).href;
  }

  private project(progress: RunProgress): RunProgress {
    const artifact = (output: unknown): unknown => {
      if (!output || typeof output !== 'object' || (output as { kind?: string }).kind !== 'artifact') return output;
      const result = { ...output } as Record<string, unknown>;
      for (const key of ['uri', 'reference']) if (typeof result[key] === 'string') result[key] = this.mapArtifactReference(result[key] as string);
      return result;
    };
    const evidence = (items: unknown): unknown => Array.isArray(items) ? items.map(item => item?.kind === 'artifact' && typeof item.reference === 'string' ? { ...item, reference: this.mapArtifactReference(item.reference) } : item) : items;
    const payload = { ...progress.payload };
    if ('output' in payload) payload.output = artifact(payload.output);
    if ('evidence' in payload) payload.evidence = evidence(payload.evidence);
    const checkpoint = progress.checkpoint ? { ...progress.checkpoint,
      successfulTools: progress.checkpoint.successfulTools.map(tool => ({ ...tool, output: artifact(tool.output) })),
      evidence: evidence(progress.checkpoint.evidence) as NonNullable<RunProgress['checkpoint']>['evidence'],
    } : undefined;
    return sanitizeProgress({ ...progress, payload, ...(checkpoint ? { checkpoint } : {}) }, this.secrets);
  }

  private async deliver(progress: RunProgress): Promise<void> {
    const safe = this.project(progress);
    try { await this.options.onProgress(safe); }
    catch { this.deliveryFailed = true; throw new Error('CLOUD_PROGRESS_DELIVERY_FAILED'); }
    this.sequence = progress.sequence;
  }
}
