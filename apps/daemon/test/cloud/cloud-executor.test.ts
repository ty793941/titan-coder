import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { RunDispatch, RunProgress } from '@titan/daemon-protocol';
import type { DockerRuntime } from '../../src/cloud/docker-runtime.js';
import type { ContainerHandle, ContainerSpec, ContainerStatus } from '../../src/cloud/types.js';
import { LocalSnapshotStore } from '../../src/cloud/snapshot-store.js';
import { SecretBroker } from '../../src/cloud/secret-broker.js';

async function executorClass(): Promise<typeof import('../../src/cloud/cloud-executor.js').CloudExecutor> {
  const module = await import('../../src/cloud/cloud-executor.js');
  expect(module.CloudExecutor).toBeTypeOf('function');
  return module.CloudExecutor;
}

class FakeDocker {
  readonly handle = { id: 'a'.repeat(64), name: `titan-cloud-${'b'.repeat(40)}` };
  readonly calls: string[] = [];
  readonly history: string[] = [];
  readonly streams: ChildProcessWithoutNullStreams[] = [];
  status: ContainerStatus = { state: 'missing' };
  bootstrap: any;
  spec: ContainerSpec | undefined;
  stopGate: Promise<void> | undefined;
  async find(): Promise<ContainerHandle | undefined> { this.calls.push('find'); return this.status.state === 'missing' ? undefined : this.handle; }
  async create(spec: ContainerSpec): Promise<ContainerHandle> { this.calls.push('create'); this.spec = spec; this.status = { state: 'created' }; return this.handle; }
  async inspect(): Promise<ContainerStatus> { this.calls.push('inspect'); return this.status; }
  start(_handle: ContainerHandle, bytes: Uint8Array): ChildProcessWithoutNullStreams {
    this.calls.push('start'); this.bootstrap = JSON.parse(Buffer.from(bytes).toString()); this.status = { state: 'running' };
    return this.stream();
  }
  logs(): ChildProcessWithoutNullStreams {
    this.calls.push('logs');
    const stream = this.stream();
    queueMicrotask(() => {
      for (const line of this.history) if (stream.exitCode === null) stream.stdout.write(line);
      if (this.status.state === 'exited') this.close(stream, 0);
    });
    return stream;
  }
  async stop(): Promise<void> { this.calls.push('stop'); await this.stopGate; this.finish(137); }
  async remove(): Promise<void> { this.calls.push('remove'); this.status = { state: 'missing' }; }
  private stream(): ChildProcessWithoutNullStreams {
    const stream = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, signalCode: null }) as unknown as ChildProcessWithoutNullStreams;
    stream.kill = () => { this.calls.push('detach'); this.close(stream, 0); return true; };
    this.streams.push(stream);
    return stream;
  }
  close(stream: ChildProcessWithoutNullStreams, code: number): void {
    if (stream.exitCode !== null) return;
    Object.assign(stream, { exitCode: code }); stream.stdout.end(); stream.stderr.end(); stream.emit('close', code, null);
  }
  emitFrame(frame: unknown): void { this.emitRaw(`${JSON.stringify(frame)}\n`); }
  emitRaw(line: string): void { this.history.push(line); for (const stream of this.streams) if (stream.exitCode === null) stream.stdout.write(line); }
  finish(code = 0): void { this.status = { state: 'exited', exitCode: code }; for (const stream of this.streams) this.close(stream, code); }
}

async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('TEST_CONDITION_TIMEOUT');
    await new Promise(resolve => setTimeout(resolve, 2));
  }
}

async function fixture(timeoutMs = 5000) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'titan-cloud-executor-')));
  const workspaceRoot = join(root, 'workspaces');
  const source = join(root, 'source');
  await mkdir(workspaceRoot, { mode: 0o700 }); await mkdir(source, { mode: 0o700 });
  await writeFile(join(source, 'answer.txt'), 'snapshot source');
  execFileSync('git', ['init', '--quiet', source]);
  execFileSync('git', ['-C', source, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '--quiet', '--allow-empty', '-m', 'fixture']);
  const snapshots = new LocalSnapshotStore({ root: join(root, 'snapshots'), workspaceRoots: [source, workspaceRoot] });
  const snapshot = await snapshots.exportWorkspace(source);
  const dispatch: RunDispatch = {
    jobId: 'job-1', projectId: 'project-1', taskId: 'task-1', sessionId: 'session-1', runId: 'run-1',
    claimToken: 'claim-1', planHash: 'plan-1', goal: 'produce artifact',
    config: { daemonId: 'daemon-1', runtime: 'codex', credentialRef: 'broker://key', baseUrlRef: 'broker://url', workspacePath: '/untrusted/remote',
      environmentType: 'cloud', snapshotManifestRef: 'snapshot://one', secretLeaseRef: 'lease://one', allowedTools: ['artifact.write'], maxTurns: 2, timeoutMs,
      localPolicy: { trustedCode: true, enabledSkills: ['remote-skill'] } },
    cloud: { executionId: 'execution-1', snapshot, secretLeaseId: 'lease-1', secretLeaseExpiresAt: new Date(Date.now() + 60_000).toISOString() },
  };
  const runtime = new FakeDocker();
  const lifecycle: any[] = [];
  const progress: RunProgress[] = [];
  const resolved: string[] = [];
  const broker = new SecretBroker(async ref => { resolved.push(ref); return ref === 'broker://key' ? 'exact-private-value' : 'https://private.example/v1'; });
  const options = {
    stateDirectory: join(root, 'state'), workspaceRoot, runtime: runtime as unknown as DockerRuntime, snapshots, broker,
    lifecycle: async (body: any) => { lifecycle.push(body); return { secretConsumed: body.consumeSecret === true }; },
    onProgress: async (event: RunProgress) => { progress.push(event); }, initialSequence: 0,
    localPolicy: { trustedCode: false, enabledSkills: ['host-skill'] },
  };
  const frame = (sequence: number, type: RunProgress['type'] = 'output', payload: Record<string, unknown> = {}) => ({
    version: 1, type: 'progress', progress: { eventId: `event-${sequence}`, sequence, claimToken: dispatch.claimToken, type, payload },
  });
  return { root, dispatch, runtime, lifecycle, progress, resolved, options, frame, statePath: join(options.stateDirectory, 'active.json'), hostSession: join(workspaceRoot, dispatch.sessionId, 'session') };
}

describe('CloudExecutor', () => {
  it('roundtrips the actual LocalSnapshotStore sha256 manifest without rewriting its checksum', async () => {
    const Executor = await executorClass();
    const f = await fixture();
    expect(f.dispatch.cloud!.snapshot.checksum).toMatch(/^sha256:[a-f0-9]{64}$/);
    const executor = new Executor(f.dispatch, f.options);
    await until(() => f.runtime.calls.includes('start') || f.progress.length > 0);
    if (f.runtime.calls.includes('start')) {
      f.runtime.emitFrame(f.frame(1, 'completed'));
      f.runtime.finish();
    }
    await executor.done;
    expect(f.progress.at(-1)?.type).toBe('completed');
    expect(await readFile(join(f.hostSession, 'answer.txt'), 'utf8')).toBe('snapshot source');
    await executor.cleanup();
  });

  it('materializes a private mount, consumes the CP lease before the broker, and strips remote bootstrap fields', async () => {
    const Executor = await executorClass();
    const f = await fixture();
    const executor = new Executor(f.dispatch, f.options);
    await until(() => f.runtime.calls.includes('start'));
    expect(f.lifecycle.map(body => [body.status, body.consumeSecret === true])).toEqual([['creating', false], ['creating', true], ['starting', false], ['running', false]]);
    expect(f.runtime.spec?.workspacePath).toBe(join(f.options.workspaceRoot, f.dispatch.sessionId));
    expect((await stat(join(f.options.workspaceRoot, f.dispatch.sessionId))).mode & 0o777).toBe(0o700);
    expect(await readFile(join(f.hostSession, 'answer.txt'), 'utf8')).toBe('snapshot source');
    expect(f.runtime.bootstrap.dispatch.cloud).toBeUndefined();
    const config = f.runtime.bootstrap.dispatch.config;
    for (const key of ['environmentType', 'snapshotManifestRef', 'secretLeaseRef']) expect(config[key]).toBeUndefined();
    expect(config.workspacePath).toBe('/workspace/session');
    expect(config.localPolicy).toEqual(f.options.localPolicy);
    expect(f.runtime.bootstrap.credentials).toEqual({ 'broker://key': 'exact-private-value', 'broker://url': 'https://private.example/v1' });
    const state = await readFile(f.statePath, 'utf8');
    expect(state).not.toContain('exact-private-value'); expect(state).not.toContain('https://private.example/v1');
    expect((await stat(f.statePath)).mode & 0o777).toBe(0o600);
    f.runtime.emitFrame(f.frame(1, 'running'));
    f.runtime.emitFrame(f.frame(2, 'completed'));
    f.runtime.finish(); await executor.done;
    expect(f.progress.map(event => event.type)).toEqual(['running', 'completed']);
    expect(f.runtime.calls).not.toContain('remove');
    await executor.cleanup();
    expect(f.runtime.calls).toContain('remove');
    expect(JSON.parse(await readFile(f.statePath, 'utf8'))).toBeNull();
    expect(await readFile(join(f.hostSession, 'answer.txt'), 'utf8')).toBe('snapshot source');
  });

  it('holds a declared completion until Docker confirms container exit', async () => {
    const Executor = await executorClass(); const f = await fixture(); const executor = new Executor(f.dispatch, f.options);
    await until(() => f.runtime.calls.includes('start'));
    f.runtime.emitFrame(f.frame(1, 'completed'));
    await new Promise(resolve => setImmediate(resolve));
    expect(f.progress).toEqual([]);
    f.runtime.finish(); await executor.done;
    expect(f.progress.at(-1)?.type).toBe('completed');
  });

  it('sanitizes exact secrets and maps only structured artifact locations into the private host session', async () => {
    const Executor = await executorClass(); const f = await fixture(); const executor = new Executor(f.dispatch, f.options);
    await until(() => f.runtime.calls.includes('start'));
    const uri = 'file:///workspace/session/.titan/artifacts/version/answer.txt';
    const event = f.frame(1, 'checkpoint', { text: `exact-private-value https://private.example/v1 ${uri}`, evidence: [{ kind: 'artifact', reference: uri }] }) as any;
    event.progress.checkpoint = { id: 'checkpoint-1', messages: [{ role: 'assistant', text: uri }], successfulTools: [{ id: 'tool-1', name: 'artifact.write', inputHash: 'hash-1', output: { kind: 'artifact', uri, checksum: `sha256:${'a'.repeat(64)}` } }], evidence: [{ kind: 'artifact', reference: uri }] };
    f.runtime.emitFrame(event); f.runtime.emitFrame(f.frame(2, 'completed')); f.runtime.finish(); await executor.done;
    const checkpoint = f.progress[0]!.checkpoint!;
    expect((checkpoint.successfulTools[0]!.output as any).uri).toBe(pathToFileURL(join(f.hostSession, '.titan/artifacts/version/answer.txt')).href);
    expect(checkpoint.messages[0]!.text).toBe(uri);
    expect(JSON.stringify(f.progress)).not.toContain('exact-private-value'); expect(JSON.stringify(f.progress)).not.toContain('https://private.example/v1');
    expect(f.progress[0]!.payload.text).toContain(uri);
  });

  it.each(['claim', 'sequence', 'invalid', 'oversized', 'second-terminal'])('fails safely on %s without trusting container output', async mode => {
    const Executor = await executorClass(); const f = await fixture(); const executor = new Executor(f.dispatch, f.options);
    await until(() => f.runtime.calls.includes('start'));
    if (mode === 'invalid') f.runtime.emitRaw('{exact-private-value\n');
    else if (mode === 'oversized') f.runtime.emitRaw('x'.repeat(1024 * 1024 + 1));
    else if (mode === 'second-terminal') { f.runtime.emitFrame(f.frame(1, 'completed')); f.runtime.emitFrame(f.frame(2, 'completed')); }
    else { const value = f.frame(mode === 'sequence' ? 2 : 1); if (mode === 'claim') value.progress.claimToken = 'foreign'; f.runtime.emitFrame(value); }
    await executor.done;
    expect(f.runtime.calls).toContain('stop');
    expect(f.progress.at(-1)?.type).toBe('failed');
    expect(JSON.stringify(f.progress)).not.toContain('exact-private-value');
  });

  it.each([0, 1])('fails an exit without a terminal progress (exit=%s)', async code => {
    const Executor = await executorClass(); const f = await fixture(); const executor = new Executor(f.dispatch, f.options);
    await until(() => f.runtime.calls.includes('start'));
    f.runtime.emitFrame(f.frame(1, 'running')); f.runtime.finish(code); await executor.done;
    expect(f.progress.at(-1)?.type).toBe('failed');
  });

  it('does not accept completed when Docker exits nonzero', async () => {
    const Executor = await executorClass(); const f = await fixture(); const executor = new Executor(f.dispatch, f.options);
    await until(() => f.runtime.calls.includes('start'));
    f.runtime.emitFrame(f.frame(1, 'completed')); f.runtime.finish(1); await executor.done;
    expect(f.progress.at(-1)?.type).toBe('failed');
  });

  it('waits for cancellation stop confirmation before emitting cancelled', async () => {
    const Executor = await executorClass(); const f = await fixture(); const executor = new Executor(f.dispatch, f.options);
    await until(() => f.runtime.calls.includes('start'));
    let release!: () => void; f.runtime.stopGate = new Promise(resolve => { release = resolve; });
    executor.cancel(); await until(() => f.runtime.calls.includes('stop'));
    expect(f.progress).toEqual([]); release(); await executor.done;
    expect(f.progress.at(-1)?.type).toBe('cancelled');
  });

  it('stops a timed out container and emits the fixed timeout code', async () => {
    const Executor = await executorClass(); const f = await fixture(80); const executor = new Executor(f.dispatch, f.options);
    await executor.done;
    expect(f.runtime.calls).toContain('stop');
    expect(f.progress.at(-1)).toMatchObject({ type: 'failed', payload: { code: 'CLOUD_CONTAINER_TIMEOUT' } });
  });

  it('does not resolve credentials or start when the CP consumption CAS fails', async () => {
    const Executor = await executorClass(); const f = await fixture();
    const executor = new Executor(f.dispatch, { ...f.options, lifecycle: async body => { if (body.consumeSecret) throw new Error('CLOUD_SECRET_CONSUMED exact-private-value'); } });
    await executor.done;
    expect(f.runtime.calls).toContain('create'); expect(f.runtime.calls).not.toContain('start'); expect(f.resolved).toEqual([]);
    expect(f.progress.at(-1)?.type).toBe('waiting_input');
    expect(JSON.stringify(f.progress)).not.toContain('exact-private-value');
  });

  it('detaches on shutdown, replays logs using outbox sequence, and never consumes or starts again', async () => {
    const Executor = await executorClass(); const f = await fixture(); const executor = new Executor(f.dispatch, { ...f.options, initialSequence: 5 });
    await until(() => f.runtime.calls.includes('start'));
    f.runtime.emitFrame(f.frame(1, 'running')); f.runtime.emitFrame(f.frame(2, 'output', { text: 'before restart' }));
    await until(() => f.progress.length === 2);
    executor.shutdown(); await executor.done;
    expect(f.runtime.status.state).toBe('running'); expect(f.runtime.calls).not.toContain('stop');
    const recovered = await Executor.recover({ ...f.options, recoverSequence: () => 7 });
    expect(recovered).toBeDefined(); await until(() => f.runtime.calls.includes('logs'));
    f.runtime.emitFrame(f.frame(3, 'completed')); f.runtime.finish(); await recovered!.done;
    expect(f.progress.map(event => event.sequence)).toEqual([6, 7, 8]);
    expect(f.progress.map(event => event.eventId)).toEqual(['event-1', 'event-2', 'event-3']);
    expect(f.resolved).toHaveLength(2); expect(f.runtime.calls.filter(call => call === 'start')).toHaveLength(1);
    await recovered!.cleanup();
  });

  it('fences missing containers on recovery without creating or consuming again', async () => {
    const Executor = await executorClass(); const f = await fixture(); const executor = new Executor(f.dispatch, f.options);
    await until(() => f.runtime.calls.includes('start')); executor.shutdown(); await executor.done;
    f.runtime.status = { state: 'missing' };
    const recovered = await Executor.recover(f.options); await recovered!.done;
    expect(f.progress.at(-1)).toMatchObject({ type: 'waiting_input', payload: { code: 'CLOUD_RECOVERY_FENCED' } });
    expect(f.runtime.calls.filter(call => call === 'create')).toHaveLength(1); expect(f.resolved).toHaveLength(2);
  });

  it('recovers an exited container from logs and waits for explicit cleanup', async () => {
    const Executor = await executorClass(); const f = await fixture(); const executor = new Executor(f.dispatch, f.options);
    await until(() => f.runtime.calls.includes('start')); executor.shutdown(); await executor.done;
    f.runtime.emitFrame(f.frame(1, 'completed')); f.runtime.finish();
    const recovered = await Executor.recover(f.options); await recovered!.done;
    expect(f.progress.at(-1)?.type).toBe('completed'); expect(f.runtime.calls).not.toContain('remove'); await recovered!.cleanup();
  });

  it('rejects a secret-bearing event ID rather than changing its replay identity', async () => {
    const Executor = await executorClass(); const f = await fixture(); const executor = new Executor(f.dispatch, f.options);
    await until(() => f.runtime.calls.includes('start'));
    const value = f.frame(1, 'output'); value.progress.eventId = 'exact-private-value';
    f.runtime.emitFrame(value); f.runtime.emitFrame(f.frame(2, 'completed')); f.runtime.finish(); await executor.done;
    expect(f.progress.at(-1)?.type).toBe('failed');
    expect(JSON.stringify(f.progress)).not.toContain('exact-private-value');
  });

  it('propagates fixed outbox delivery failure and preserves recovery state', async () => {
    const Executor = await executorClass(); const f = await fixture();
    const executor = new Executor(f.dispatch, { ...f.options, onProgress: async () => { throw new Error('private-outbox-path exact-private-value'); } });
    const done = expect(executor.done).rejects.toThrow(/^CLOUD_PROGRESS_DELIVERY_FAILED$/);
    await until(() => f.runtime.calls.includes('start'));
    f.runtime.emitFrame(f.frame(1, 'running')); await done;
    expect(f.runtime.calls).toContain('stop');
    expect(JSON.parse(await readFile(f.statePath, 'utf8')).completed).toBe(false);
    expect(f.runtime.calls).not.toContain('remove');
  });

  it('fences an unconfirmed stop and refuses cleanup of a live container', async () => {
    const Executor = await executorClass(); const f = await fixture();
    f.runtime.stop = async () => { f.runtime.calls.push('stop'); throw new Error('private-daemon-error'); };
    const executor = new Executor(f.dispatch, f.options); await until(() => f.runtime.calls.includes('start'));
    executor.cancel(); await executor.done;
    expect(f.progress.at(-1)).toMatchObject({ type: 'waiting_input', payload: { code: 'CLOUD_CONTAINER_STOP_UNCONFIRMED' } });
    await expect(executor.cleanup()).rejects.toThrow('CLOUD_CLEANUP_NOT_READY');
    expect(JSON.parse(await readFile(f.statePath, 'utf8')).completed).toBe(false);
    expect(f.runtime.calls).not.toContain('remove');
  });

  it('fences recovery of a created container without consuming its lease or starting it', async () => {
    const Executor = await executorClass(); const f = await fixture(); const executor = new Executor(f.dispatch, f.options);
    await until(() => f.runtime.calls.includes('start')); executor.shutdown(); await executor.done;
    f.runtime.status = { state: 'created' };
    const recovered = await Executor.recover(f.options); await recovered!.done;
    expect(f.progress.at(-1)?.type).toBe('waiting_input');
    expect(f.runtime.calls.filter(call => call === 'start')).toHaveLength(1);
    expect(f.resolved).toHaveLength(2);
  });

  it('reopens completed active state for cleanup without replaying its terminal event', async () => {
    const Executor = await executorClass(); const f = await fixture(); const executor = new Executor(f.dispatch, f.options);
    await until(() => f.runtime.calls.includes('start'));
    f.runtime.emitFrame(f.frame(1, 'completed')); f.runtime.finish(); await executor.done;
    const recovered = await Executor.recover({ ...f.options, recoverSequence: () => 1 }); await recovered!.done;
    expect(f.progress).toHaveLength(1); expect(f.runtime.calls).not.toContain('logs');
    await recovered!.cleanup(); expect(await Executor.recover(f.options)).toBeUndefined();
  });

  it('fences truncated container logs before treating an outbox sequence as recovered', async () => {
    const Executor = await executorClass(); const f = await fixture(); const executor = new Executor(f.dispatch, f.options);
    await until(() => f.runtime.calls.includes('start'));
    f.runtime.emitFrame(f.frame(1, 'running')); await until(() => f.progress.length === 1);
    executor.shutdown(); await executor.done;
    f.runtime.history.splice(0, 1);
    f.runtime.emitFrame(f.frame(2, 'completed')); f.runtime.finish();
    const recovered = await Executor.recover({ ...f.options, recoverSequence: () => 1 }); await recovered!.done;
    expect(f.progress.at(-1)).toMatchObject({ type: 'waiting_input', payload: { code: 'CLOUD_RECOVERY_FENCED' } });
    expect(f.runtime.calls.filter(call => call === 'start')).toHaveLength(1);
  });

  it('does not delete artifacts or rewrite text when rejecting an escaping artifact output', async () => {
    const Executor = await executorClass(); const f = await fixture(); const executor = new Executor(f.dispatch, f.options);
    await until(() => f.runtime.calls.includes('start'));
    f.runtime.emitFrame(f.frame(1, 'output', { output: { kind: 'artifact', uri: 'file:///workspace/session/.titan/artifacts/../private.txt' } }));
    await executor.done;
    expect(f.progress.at(-1)?.type).toBe('failed'); expect(f.runtime.calls).not.toContain('remove');
    expect(await readFile(join(f.hostSession, 'answer.txt'), 'utf8')).toBe('snapshot source');
  });

  it('fences recovery when the host workspace root changes', async () => {
    const Executor = await executorClass(); const f = await fixture(); const executor = new Executor(f.dispatch, f.options);
    await until(() => f.runtime.calls.includes('start')); executor.shutdown(); await executor.done;
    const otherRoot = join(f.root, 'other-root'); await mkdir(otherRoot, { mode: 0o700 });
    const recovered = await Executor.recover({ ...f.options, workspaceRoot: otherRoot });
    const done = recovered!.done;
    await until(() => f.progress.length > 0 || f.runtime.calls.includes('logs'));
    if (f.runtime.calls.includes('logs')) { f.runtime.emitFrame(f.frame(1, 'completed')); f.runtime.finish(); }
    await done;
    expect(f.runtime.calls).not.toContain('logs');
    expect(f.progress.at(-1)).toMatchObject({ type: 'waiting_input', payload: { code: 'CLOUD_RECOVERY_FENCED' } });
  });

  it('fences a running container instead of trusting a completed active record', async () => {
    const Executor = await executorClass(); const f = await fixture(); const executor = new Executor(f.dispatch, f.options);
    await until(() => f.runtime.calls.includes('start')); f.runtime.emitFrame(f.frame(1, 'completed')); f.runtime.finish(); await executor.done;
    f.runtime.status = { state: 'running' };
    const recovered = await Executor.recover({ ...f.options, recoverSequence: () => 1 }); await recovered!.done;
    expect(f.progress.at(-1)?.type).toBe('waiting_input');
    expect(f.runtime.calls).toContain('stop');
  });

  it('does not consume a lease after shutdown during the pre-start inspection', async () => {
    const Executor = await executorClass(); const f = await fixture();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let inspecting = false;
    const original = f.runtime.inspect.bind(f.runtime);
    f.runtime.inspect = async () => { const status = await original(); if (status.state === 'created') { inspecting = true; await gate; } return status; };
    const executor = new Executor(f.dispatch, f.options);
    await until(() => inspecting); executor.shutdown(); release(); await executor.done;
    expect(f.lifecycle.some(body => body.consumeSecret)).toBe(false);
    expect(f.resolved).toEqual([]); expect(f.runtime.calls).not.toContain('start');
  });

  it('enforces the deadline even while a secret resolver is pending', async () => {
    const Executor = await executorClass(); const f = await fixture(60);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const broker = new SecretBroker(async ref => { await gate; return ref === 'broker://key' ? 'exact-private-value' : 'https://private.example/v1'; });
    const executor = new Executor(f.dispatch, { ...f.options, broker });
    const finishedInTime = await Promise.race([executor.done.then(() => true), new Promise<boolean>(resolve => setTimeout(() => resolve(false), 250))]);
    release(); await executor.done;
    expect(finishedInTime).toBe(true);
    expect(f.progress.at(-1)).toMatchObject({ type: 'failed', payload: { code: 'CLOUD_CONTAINER_TIMEOUT' } });
    expect(f.runtime.calls).not.toContain('start');
  });

  it('starts stopping the container even if an outbox write is still pending', async () => {
    const Executor = await executorClass(); const f = await fixture();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let writing = false;
    const executor = new Executor(f.dispatch, { ...f.options, onProgress: async event => {
      if (event.type === 'running') { writing = true; await gate; }
      f.progress.push(event);
    } });
    await until(() => f.runtime.calls.includes('start')); f.runtime.emitFrame(f.frame(1, 'running'));
    await until(() => writing); executor.cancel();
    await new Promise(resolve => setTimeout(resolve, 40));
    const stoppedBeforeWrite = f.runtime.calls.includes('stop');
    release(); await executor.done;
    expect(stoppedBeforeWrite).toBe(true);
    expect(f.progress.at(-1)?.type).toBe('cancelled');
  });

  it('preserves the original deadline across shutdown and recovery', async () => {
    const Executor = await executorClass(); const f = await fixture(150); const executor = new Executor(f.dispatch, f.options);
    await until(() => f.runtime.calls.includes('start')); executor.shutdown(); await executor.done;
    await new Promise(resolve => setTimeout(resolve, 170));
    const recovered = await Executor.recover(f.options); await recovered!.done;
    expect(f.progress.at(-1)).toMatchObject({ type: 'failed', payload: { code: 'CLOUD_CONTAINER_TIMEOUT' } });
    expect(f.runtime.calls).toContain('stop'); expect(f.runtime.calls).not.toContain('logs');
  });

  it('never emits a conflicting terminal when active-state persistence fails after outbox completion', async () => {
    const Executor = await executorClass(); const f = await fixture();
    const executor = new Executor(f.dispatch, { ...f.options, onProgress: async event => {
      f.progress.push(event);
      if (event.type === 'completed') { await rename(f.statePath, `${f.statePath}.saved`); await mkdir(f.statePath); }
    } });
    const failed = executor.done.catch(error => error);
    await until(() => f.runtime.calls.includes('start')); f.runtime.emitFrame(f.frame(1, 'completed')); f.runtime.finish();
    expect(await failed).toBeInstanceOf(Error);
    expect(f.progress.map(event => event.type)).toEqual(['completed']);
    expect(f.runtime.calls).not.toContain('remove');
  });
});
