import { ChildProcess, spawn as nodeSpawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { createHash } from 'node:crypto';
import { lstatSync, type Stats } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { assertCloudDirectory } from './snapshot-store.js';
import type { ContainerHandle, ContainerScope, ContainerSpec, ContainerStatus, DockerRuntimeOptions, DockerRuntimeDependencies } from './types.js';

export type { ContainerHandle, ContainerScope, ContainerSpec, ContainerStatus, DockerRuntimeOptions, DockerRuntimeDependencies } from './types.js';

const OWNER = 'io.titan.cloud.owner';
const SESSION = 'io.titan.cloud.session';
const RUN = 'io.titan.cloud.run';
const WORKSPACE = 'io.titan.cloud.workspace';
function fail(code: string): never { throw new Error(`CLOUD_CONTAINER_${code}`); }
const validScope = (value: string) => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,200}$/.test(value);
interface DockerInspection {
  Id: string;
  Name: string;
  Config: { Labels: Record<string, string> };
  State: { Status: string; ExitCode: number };
  Mounts: { Type: string; Source: string; Destination: string }[];
}

export class DockerRuntime {
  private readonly options: DockerRuntimeOptions;
  private readonly spawn: NonNullable<DockerRuntimeDependencies['spawn']>;
  private readonly timeoutMs: number;
  private readonly maxOutput: number;
  private readonly streamTimeoutMs: number;
  private readonly rootIdentity: Stats;
  private readonly creating = new Map<string, { workspace: string; promise: Promise<ContainerHandle> }>();

  constructor(options: DockerRuntimeOptions, dependencies: DockerRuntimeDependencies = {}) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._/:@-]{0,255}$/.test(options.image) || !validScope(options.ownerId)
      || (options.network !== undefined && !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,100}$/.test(options.network))) fail('CONFIG');
    if (process.getuid?.() === undefined || process.getuid() === 0 || process.getgid?.() === undefined) fail('CONFIG');
    let root: string;
    try { root = assertCloudDirectory(options.workspaceRoot); } catch { fail('WORKSPACE'); }
    this.options = { ...options, workspaceRoot: root };
    this.rootIdentity = lstatSync(root);
    if (this.rootIdentity.uid !== process.getuid?.() || (this.rootIdentity.mode & 0o022) !== 0) fail('WORKSPACE');
    this.spawn = dependencies.spawn ?? ((command, args, spawnOptions) => nodeSpawn(command, args, spawnOptions));
    this.timeoutMs = dependencies.timeoutMs ?? 15_000;
    this.streamTimeoutMs = dependencies.timeoutMs ?? 900_000;
    this.maxOutput = dependencies.maxOutputBytes ?? 1024 * 1024;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || !Number.isSafeInteger(this.maxOutput) || this.maxOutput < 1) fail('CONFIG');
  }

  async create(spec: ContainerSpec): Promise<ContainerHandle> {
    const name = this.name(spec);
    const pending = this.creating.get(name);
    if (pending) {
      if (pending.workspace !== resolve(spec.workspacePath)) fail('WORKSPACE');
      return pending.promise;
    }
    const operation = this.createOnce(spec, name);
    this.creating.set(name, { workspace: resolve(spec.workspacePath), promise: operation });
    try { return await operation; } finally { this.creating.delete(name); }
  }

  private async createOnce(spec: ContainerSpec, name: string): Promise<ContainerHandle> {
    let workspace: string;
    try {
      workspace = assertCloudDirectory(spec.workspacePath);
      this.assertRoot();
      this.assertAncestors(workspace);
      const child = relative(this.options.workspaceRoot, workspace);
      const metadata = lstatSync(workspace);
      if (!child || child === '..' || child.startsWith('../') || isAbsolute(child) || workspace.includes(',')
        || /[\x00-\x1f\x7f]/.test(workspace) || metadata.uid !== process.getuid?.() || (metadata.mode & 0o022) !== 0) fail('WORKSPACE');
    } catch { fail('WORKSPACE'); }
    const originalWorkspace = lstatSync(workspace);
    const existing = await this.find(spec);
    this.assertRoot();
    this.assertAncestors(workspace);
    const currentWorkspace = lstatSync(workspace);
    if (currentWorkspace.dev !== originalWorkspace.dev || currentWorkspace.ino !== originalWorkspace.ino) fail('WORKSPACE');
    if (existing) {
      const data = await this.owned(existing);
      if (!data) fail('MISSING');
      this.assertMounts(data, workspace);
      return existing;
    }
    const args = [
      'create', '--name', name, '--label', `${OWNER}=${this.options.ownerId}`, '--label', `${SESSION}=${spec.sessionId}`, '--label', `${RUN}=${spec.runId}`,
      '--label', `${WORKSPACE}=${this.workspaceHash(workspace, originalWorkspace)}`,
      '--pull=never', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges', `--network=${this.options.network ?? 'none'}`,
      `--user=${process.getuid!()}:${process.getgid!()}`, '--pids-limit=128', '--memory=512m', '--cpus=1',
      '--tmpfs', '/tmp:rw,nosuid,nodev,noexec,size=64m,mode=1777', '--mount', `type=bind,src=${workspace},dst=/workspace`,
      '--workdir=/workspace', '--interactive', this.options.image,
    ];
    try {
      const id = (await this.command(args)).trim();
      if (!/^[a-f0-9]{64}$/.test(id)) fail('OUTPUT');
      const handle = { id, name };
      const data = await this.owned(handle);
      if (!data) fail('MISSING');
      try { this.assertMounts(data, workspace); }
      catch (error) { await this.remove(handle); throw error; }
      return handle;
    } catch (error) {
      // Docker 的名称唯一约束处理不同 Runtime 实例之间的创建竞争。
      const raced = await this.find(spec);
      if (raced) {
        const data = await this.owned(raced);
        if (!data) fail('MISSING');
        this.assertMounts(data, workspace);
        return raced;
      }
      throw error;
    }
  }

  async find(scope: ContainerScope): Promise<ContainerHandle | undefined> {
    const name = this.name(scope);
    const data = await this.query(name);
    if (!data) return undefined;
    const handle = { id: data.Id, name };
    this.checkOwner(data, handle, scope);
    return handle;
  }

  async inspect(handle: ContainerHandle): Promise<ContainerStatus> {
    const data = await this.owned(handle);
    if (!data) return { state: 'missing' };
    switch (data.State.Status) {
      case 'created': return { state: 'created' };
      case 'running': return { state: 'running' };
      case 'exited': case 'dead': return { state: 'exited', exitCode: data.State.ExitCode };
      default: fail('STATE');
    }
  }

  start(handle: ContainerHandle, bootstrap: Uint8Array): ChildProcessWithoutNullStreams {
    if (!(bootstrap instanceof Uint8Array) || bootstrap.byteLength > 2 * 1024 * 1024) fail('BOOTSTRAP');
    return this.stream(handle, ['start', '--attach', '--interactive', handle.id], Buffer.from(bootstrap));
  }

  logs(handle: ContainerHandle): ChildProcessWithoutNullStreams {
    return this.stream(handle, ['logs', '--follow', handle.id]);
  }

  async stop(handle: ContainerHandle): Promise<void> {
    if (await this.owned(handle)) await this.command(['stop', '--time=5', handle.id]);
  }

  async remove(handle: ContainerHandle): Promise<void> {
    if (await this.owned(handle)) await this.command(['rm', '--force', '--volumes', handle.id]);
  }

  private name(scope: ContainerScope): string {
    if (!validScope(scope.sessionId) || !validScope(scope.runId)) fail('CONFIG');
    const digest = createHash('sha256').update(JSON.stringify([this.options.ownerId, scope.sessionId, scope.runId])).digest('hex');
    return `titan-cloud-${digest.slice(0, 40)}`;
  }

  private assertRoot(): void {
    try {
      assertCloudDirectory(this.options.workspaceRoot);
      const current = lstatSync(this.options.workspaceRoot);
      if (current.dev !== this.rootIdentity.dev || current.ino !== this.rootIdentity.ino || current.uid !== process.getuid?.() || (current.mode & 0o022) !== 0) fail('WORKSPACE');
    } catch { fail('WORKSPACE'); }
  }

  private assertAncestors(workspace: string): void {
    try {
      assertCloudDirectory(workspace);
      let current = this.options.workspaceRoot;
      for (const part of relative(current, workspace).split('/').filter(Boolean)) {
        if (part === '..') fail('WORKSPACE');
        current = resolve(current, part);
        const info = lstatSync(current);
        if (info.uid !== process.getuid?.() || (info.mode & 0o022) !== 0) fail('WORKSPACE');
      }
    } catch { fail('WORKSPACE'); }
  }

  private workspaceHash(path: string, info: Stats = lstatSync(path)): string {
    return createHash('sha256').update(JSON.stringify([path, info.dev, info.ino])).digest('hex');
  }

  private assertMounts(data: DockerInspection, expectedWorkspace?: string): void {
    this.assertRoot();
    if (!Array.isArray(data.Mounts) || data.Mounts.length !== 1) fail('WORKSPACE');
    const mount = data.Mounts[0]!;
    if (mount.Type !== 'bind' || mount.Destination !== '/workspace' || typeof mount.Source !== 'string' || mount.Source === this.options.workspaceRoot) fail('WORKSPACE');
    if (expectedWorkspace !== undefined && mount.Source !== expectedWorkspace) fail('WORKSPACE');
    this.assertAncestors(mount.Source);
    if (data.Config.Labels[WORKSPACE] !== this.workspaceHash(mount.Source)) fail('WORKSPACE');
  }

  private checkOwner(data: DockerInspection, handle: ContainerHandle, expected?: ContainerScope): void {
    const labels = data.Config?.Labels;
    if (!labels || labels[OWNER] !== this.options.ownerId || !validScope(labels[SESSION]!) || !validScope(labels[RUN]!)) fail('OWNER');
    const scope = { sessionId: labels[SESSION]!, runId: labels[RUN]! };
    if (data.Id !== handle.id || data.Name !== `/${handle.name}` || this.name(scope) !== handle.name
      || (expected && (scope.sessionId !== expected.sessionId || scope.runId !== expected.runId))) fail('OWNER');
  }

  private async owned(handle: ContainerHandle): Promise<DockerInspection | undefined> {
    if (!handle || !/^[a-f0-9]{64}$/.test(handle.id) || !/^titan-cloud-[a-f0-9]{40}$/.test(handle.name)) fail('OWNER');
    const data = await this.query(handle.id);
    if (data) this.checkOwner(data, handle);
    return data;
  }

  private async query(id: string): Promise<DockerInspection | undefined> {
    const result = await this.command(['inspect', '--type=container', id], true);
    if (result === '') return undefined;
    let values: unknown;
    try { values = JSON.parse(result); } catch { fail('OUTPUT'); }
    if (!Array.isArray(values) || values.length !== 1) fail('OUTPUT');
    const value = values[0] as DockerInspection;
    if (!value || typeof value.Id !== 'string' || !/^[a-f0-9]{64}$/.test(value.Id) || !value.State || !Number.isInteger(value.State.ExitCode)) fail('OUTPUT');
    return value;
  }

  private spawnDocker(args: readonly string[]): ChildProcessWithoutNullStreams {
    const options: SpawnOptionsWithoutStdio = { stdio: ['pipe', 'pipe', 'pipe'], shell: false, windowsHide: true };
    try { return this.spawn('docker', args, options); } catch { fail('EXEC'); }
  }

  private command(args: string[], allowMissing = false): Promise<string> {
    return new Promise((resolveResult, reject) => {
      let child: ChildProcessWithoutNullStreams;
      try { child = this.spawnDocker(args); } catch { reject(new Error('CLOUD_CONTAINER_EXEC')); return; }
      const output: Buffer[] = [];
      const errors: Buffer[] = [];
      let size = 0;
      let settled = false;
      const end = (error?: string, result = '') => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) { child.kill('SIGKILL'); reject(new Error(`CLOUD_CONTAINER_${error}`)); }
        else resolveResult(result);
      };
      const timer = setTimeout(() => end('TIMEOUT'), this.timeoutMs);
      const read = (chunks: Buffer[]) => (chunk: Buffer | string) => {
        if (settled) return;
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += bytes.length;
        if (size > this.maxOutput) { end('OUTPUT_LIMIT'); return; }
        chunks.push(bytes);
      };
      child.stdout.on('data', read(output));
      child.stderr.on('data', read(errors));
      child.on('error', () => end('EXEC'));
      child.on('close', code => {
        if (code === 0) end(undefined, Buffer.concat(output).toString('utf8'));
        else if (allowMissing && /^\s*(?:Error(?: response from daemon)?:\s*)?No such (?:object|container):?[^\r\n]*\s*$/i.test(Buffer.concat(errors).toString('utf8'))) end();
        else end('EXEC');
      });
      child.stdin.on('error', () => end('EXEC'));
      child.stdin.end();
    });
  }

  private stream(handle: ContainerHandle, args: string[], bootstrap?: Buffer): ChildProcessWithoutNullStreams {
    // 同步返回桥接句柄，在异步 owner 校验完成前不创建 start/logs 子进程。
    const bridge = new ChildProcess() as ChildProcessWithoutNullStreams;
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    Object.assign(bridge, { stdin, stdout, stderr, stdio: [stdin, stdout, stderr] });
    let actual: ChildProcessWithoutNullStreams | undefined;
    let ended = false;
    let timer: NodeJS.Timeout | undefined;
    let bytes = 0;
    const finish = (error?: Error, code: number | null = null, signal: NodeJS.Signals | null = null) => {
      if (ended) return;
      ended = true;
      clearTimeout(timer);
      if (error) actual?.kill('SIGKILL');
      stdout.end(); stderr.end(); stdin.destroy();
      bootstrap?.fill(0);
      Object.assign(bridge, { exitCode: code, signalCode: signal });
      if (error) bridge.emit('error', error);
      bridge.emit('exit', code, signal);
      bridge.emit('close', code, signal);
    };
    bridge.kill = (signal = 'SIGTERM') => { actual?.kill(signal); finish(undefined, null, signal as NodeJS.Signals); return true; };
    void this.owned(handle).then(data => {
      if (ended) return;
      if (!data) throw new Error('CLOUD_CONTAINER_MISSING');
      if (args[0] === 'start') this.assertMounts(data);
      actual = this.spawnDocker(args);
      Object.defineProperty(bridge, 'pid', { value: actual.pid, configurable: true });
      timer = setTimeout(() => finish(new Error('CLOUD_CONTAINER_TIMEOUT')), this.streamTimeoutMs);
      actual.on('error', () => finish(new Error('CLOUD_CONTAINER_EXEC')));
      actual.on('close', (code, signal) => finish(undefined, code, signal));
      const forward = (target: PassThrough) => (chunk: Buffer | string) => {
        if (ended) return;
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += buffer.length;
        if (bytes > this.maxOutput) { finish(new Error('CLOUD_CONTAINER_OUTPUT_LIMIT')); return; }
        if (!target.write(buffer)) actual?.stdout.pause();
      };
      actual.stdout.on('data', forward(stdout));
      // stderr 可能含凭证或 Docker 原始错误；不向调用方透传。
      actual.stderr.on('data', chunk => { if (ended) return; bytes += Buffer.byteLength(chunk); if (bytes > this.maxOutput) finish(new Error('CLOUD_CONTAINER_OUTPUT_LIMIT')); });
      stdout.on('drain', () => actual?.stdout.resume());
      actual.stdin.on('error', () => finish(new Error('CLOUD_CONTAINER_INPUT')));
      if (bootstrap) actual.stdin.end(bootstrap, () => bootstrap.fill(0));
      else actual.stdin.end();
      stdin.end();
      bridge.emit('spawn');
    }).catch(error => finish(new Error(error instanceof Error && /^CLOUD_CONTAINER_[A-Z_]+$/.test(error.message) ? error.message : 'CLOUD_CONTAINER_EXEC')));
    return bridge;
  }
}
