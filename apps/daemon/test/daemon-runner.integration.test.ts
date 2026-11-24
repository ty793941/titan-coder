import { createServer, type Server } from 'node:http';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, stat, symlink, writeFile } from 'node:fs/promises';
import { execFileSync, spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RunDispatch, RunProgress } from '@titan/daemon-protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DaemonRunner, type DaemonRunnerOptions } from '../src/daemon-runner.js';
import { DockerRuntime } from '../src/cloud/docker-runtime.js';
import { LocalSnapshotStore } from '../src/cloud/snapshot-store.js';
import { PersistentOutbox } from '../src/persistent-outbox.js';

const fixture = fileURLToPath(new URL('./fixtures/runtime-worker.cjs', import.meta.url));
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()!(); vi.restoreAllMocks(); });

async function until(predicate: () => boolean | Promise<boolean>, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs;
  while (!await predicate()) {
    if (Date.now() > deadline) throw new Error('condition timed out');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

async function harness(goal = 'complete', overrides: Partial<DaemonRunnerOptions> = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'titan-daemon-http-')));
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  const pending: RunDispatch[] = [];
  const events: RunProgress[] = [];
  const attempts: RunProgress[] = [];
  let registrationCount = 0;
  let registration: Record<string, unknown> = {};
  let heartbeatCount = 0;
  let offline = false;
  let cancelRequested = false;
  let revoked = false;
  let claimFailures = 0;
  let badProgressResponse = false;
  const progressDenials = new Map<string, (progress: RunProgress) => Record<string, unknown>>();
  const fenced = new Set<string>();
  const claimTimes: number[] = [];
  const server: Server = createServer(async (request, response) => {
    let content = '';
    for await (const chunk of request) content += chunk;
    const body = content ? JSON.parse(content) : {};
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/api/daemons/register') {
      registrationCount++;
      registration = body;
      expect(body.workspaceRoots).toEqual([workspace]);
      response.end(JSON.stringify({ daemonId: 'daemon-1', authToken: 'device-secret-token' }));
      return;
    }
    if (revoked || request.headers.authorization !== 'Bearer device-secret-token') { response.statusCode = 401; response.end('{}'); return; }
    if (request.url?.endsWith('/heartbeat')) { heartbeatCount++; response.end('{}'); return; }
    if (request.url?.endsWith('/cloud')) { response.end(JSON.stringify({ secretConsumed: body.consumeSecret === true })); return; }
    if (request.url?.endsWith('/claim')) {
      claimTimes.push(Date.now());
      if (claimFailures > 0) { claimFailures--; response.statusCode = 503; response.end('{}'); return; }
      const dispatch = pending.shift();
      response.statusCode = dispatch ? 200 : 204;
      response.end(dispatch ? JSON.stringify(dispatch) : undefined);
      return;
    }
    const runId = request.url?.split('/runs/')[1]?.split('/')[0] ?? '';
    if (request.url?.endsWith('/control')) { response.end(JSON.stringify(fenced.has(runId) ? { cancelRequested: true, status: 'reconnecting' } : { cancelRequested, status: 'running' })); return; }
    if (request.url?.endsWith('/progress')) {
      attempts.push(body);
      const denial = progressDenials.get(runId);
      if (denial) { response.statusCode = 403; response.end(JSON.stringify(denial(body))); return; }
      if (badProgressResponse) { response.end(JSON.stringify({ accepted: 'unknown' })); return; }
      if (offline) { request.socket.destroy(); return; }
      if (!events.some(event => event.eventId === body.eventId)) events.push(body);
      response.end(JSON.stringify({ accepted: true, status: body.type, cancelRequested }));
      return;
    }
    response.statusCode = 404;
    response.end('{}');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing port');
  const dispatch: RunDispatch = {
    jobId: 'job-1', runId: 'run-1', sessionId: 'session-1', taskId: 'task-1', projectId: 'project-1', goal,
    planHash: 'approved-plan', claimToken: 'claim-secret-token',
    config: { daemonId: 'daemon-1', runtime: 'qwen', credentialRef: 'keychain:qwen', workspacePath: workspace, allowedTools: [], maxTurns: 4, timeoutMs: 2000 },
  };
  pending.push(dispatch);
  const options: DaemonRunnerOptions = {
    baseUrl: `http://127.0.0.1:${address.port}`, stateDirectory: join(root, '.titan'), workspaceRoots: [workspace],
    runnerCommand: process.execPath, runnerArgs: [fixture], pollIntervalMs: 15, heartbeatIntervalMs: 30,
    retryMaxMs: 80, requestTimeoutMs: 1000, cancelGraceMs: 30, killGraceMs: 100,
    ...overrides,
  };
  const sessions: Array<{ abort: AbortController; promise: Promise<void>; errors: unknown[] }> = [];
  const start = (dependencies?: { credentialResolver?: (ref: string) => Promise<string | undefined> }) => {
    const abort = new AbortController();
    const errors: unknown[] = [];
    const promise = new DaemonRunner(options, dependencies).run(abort.signal).catch(error => { errors.push(error); });
    const session = { abort, promise, errors };
    sessions.push(session);
    return session;
  };
  cleanup.push(async () => { for (const session of sessions) session.abort.abort(); await Promise.all(sessions.map(session => session.promise)); });
  return { root, workspace, dispatch, events, attempts, pending, options, start, claimTimes,
    denyProgress: (runId: string, denial: (progress: RunProgress) => Record<string, unknown>) => { progressDenials.set(runId, denial); },
    fence: (runId: string) => { fenced.add(runId); },
    failClaims: (count: number) => { claimFailures = count; },
    invalidProgressAck: () => { badProgressResponse = true; },
    offline: (value: boolean) => { offline = value; }, cancel: () => { cancelRequested = true; }, revoke: () => { revoked = true; },
    registrations: () => registrationCount, registration: () => registration, heartbeats: () => heartbeatCount,
  };
}

describe('DaemonRunner real HTTP and child IPC', () => {
  it('drains cancelled fence proofs from an existing outbox and resumes polling without Docker', async () => {
    const h = await harness();
    h.options.environmentType = 'cloud';
    h.options.cloud = { image: 'titan-session:fixture', workspaceRoot: h.workspace, snapshotRoot: join(h.root, 'snapshots') };
    h.pending.length = 0;
    const path = join(h.options.stateDirectory, 'outbox.jsonl');
    const outbox = await PersistentOutbox.open(path);
    await outbox.append({ daemonId: 'daemon-1', runId: 'run-1', progress: { eventId: 'cancelled-old-event', sequence: 1, claimToken: 'old-claim', type: 'completed', payload: {} } });
    h.denyProgress('run-1', progress => ({ code: 'PERMISSION_DENIED', details: { reason: 'CLOUD_PROGRESS_FENCED', environmentType: 'cloud', daemonId: 'daemon-1', runId: 'run-1', eventId: progress.eventId, jobStatus: 'cancelled', runStatus: 'cancelled' } }));
    const session = h.start();
    await until(async () => !(await PersistentOutbox.open(path)).pending().length || session.errors.length > 0);
    expect(session.errors).toEqual([]);
    await until(() => h.claimTimes.length >= 2 && h.heartbeats() >= 2);
    session.abort.abort();
    await session.promise;
    expect(session.errors).toEqual([]);
    expect((await PersistentOutbox.open(path)).pending()).toEqual([]);
    const attempts = h.attempts.length;
    const heartbeats = h.heartbeats();
    const restarted = h.start();
    await until(() => h.heartbeats() > heartbeats);
    restarted.abort.abort();
    await restarted.promise;
    expect(restarted.errors).toEqual([]);
    expect(h.attempts).toHaveLength(attempts);
  });
  it.each(['reconnecting', 'manager-cancel'])('discards only fenced cloud progress, waits for container stop, and continues heartbeats and claims across restart: %s', async mode => {
    const h = await harness();
    execFileSync('git', ['init', '--quiet', h.workspace]);
    execFileSync('git', ['-C', h.workspace, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '--quiet', '--allow-empty', '-m', 'fixture']);
    const snapshotRoot = join(h.root, 'snapshots');
    const snapshot = await new LocalSnapshotStore({ root: snapshotRoot, workspaceRoots: [h.workspace] }).exportWorkspace(h.workspace);
    h.options.environmentType = 'cloud';
    h.options.cloud = { image: 'titan-session:fixture', workspaceRoot: h.workspace, snapshotRoot };
    Object.assign(h.dispatch.config, { environmentType: 'cloud', workspacePath: '/workspace/session', credentialRef: 'keychain://fixture' });
    h.dispatch.cloud = { executionId: 'cloud-1', snapshot, secretLeaseId: 'lease-1', secretLeaseExpiresAt: new Date(Date.now() + 60000).toISOString() };
    const second = structuredClone(h.dispatch);
    Object.assign(second, { runId: 'run-2', sessionId: 'session-2', jobId: 'job-2' });
    h.pending.push(second);
    const handle = { id: 'a'.repeat(64), name: `titan-cloud-${'b'.repeat(40)}` };
    let state: 'missing' | 'created' | 'running' | 'exited' = 'missing';
    let allowStop!: () => void;
    const stopGate = new Promise<void>(resolve => { allowStop = resolve; });
    cleanup.push(async () => { allowStop(); });
    vi.spyOn(DockerRuntime.prototype, 'create').mockImplementation(async () => { state = 'created'; return handle; });
    vi.spyOn(DockerRuntime.prototype, 'find').mockImplementation(async () => state === 'missing' ? undefined : handle);
    vi.spyOn(DockerRuntime.prototype, 'inspect').mockImplementation(async () => ({ state }));
    const remove = vi.spyOn(DockerRuntime.prototype, 'remove').mockImplementation(async () => { expect(state).not.toBe('running'); state = 'missing'; });
    const stop = vi.spyOn(DockerRuntime.prototype, 'stop').mockImplementation(async () => { await stopGate; state = 'exited'; });
    vi.spyOn(DockerRuntime.prototype, 'start').mockImplementation(() => {
      state = 'running';
      const stream = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() }) as unknown as ChildProcessWithoutNullStreams;
      stream.kill = () => { stream.stdout.end(); stream.stderr.end(); stream.emit('close', 0, null); return true; };
      setImmediate(() => stream.stdout.write(`${JSON.stringify({ version: 1, type: 'progress', progress: {
        eventId: 'stale-running', sequence: 1, claimToken: h.dispatch.claimToken, type: 'running', payload: {},
      } })}\n`));
      return stream;
    });
    h.offline(true);
    let resolutions = 0;
    const session = h.start({ credentialResolver: async () => ++resolutions === 1 ? 'private-test-key' : undefined });
    await until(() => h.attempts.length > 0);
    let managerCancelled = false;
    h.denyProgress('run-1', progress => ({ code: 'PERMISSION_DENIED', details: { reason: 'CLOUD_PROGRESS_FENCED', environmentType: 'cloud',
      daemonId: 'daemon-1', runId: 'run-1', eventId: progress.eventId,
      jobStatus: managerCancelled ? 'cancelled' : 'blocked', runStatus: managerCancelled ? 'cancelled' : 'reconnecting' } }));
    if (mode === 'reconnecting') h.fence('run-1');
    h.offline(false);
    await until(() => stop.mock.calls.length > 0 || session.errors.length > 0);
    const heartbeats = h.heartbeats();
    await until(() => h.heartbeats() > heartbeats || session.errors.length > 0, 500).catch(async () => {
      allowStop();
      await session.promise;
      expect(session.errors).toEqual([]);
    });
    expect(session.errors).toEqual([]);
    expect(remove).not.toHaveBeenCalled();
    expect(h.claimTimes).toHaveLength(1);
    await until(async () => (await readFile(join(h.options.stateDirectory, 'outbox.jsonl'), 'utf8')).includes('"operation":"discard"'));
    managerCancelled = mode === 'manager-cancel';
    allowStop();
    await until(() => h.events.some(event => event.type === 'waiting_input') || session.errors.length > 0);
    expect(session.errors).toEqual([]);
    await until(async () => JSON.parse(await readFile(join(h.options.stateDirectory, 'cloud', 'active.json'), 'utf8')) === null);
    session.abort.abort(); await session.promise;
    expect(h.claimTimes.length).toBeGreaterThan(1);
    expect(h.events.map(event => event.type)).toEqual(['waiting_input']);
    const path = join(h.options.stateDirectory, 'outbox.jsonl');
    expect((await PersistentOutbox.open(path)).pending()).toEqual([]);
    const records = (await readFile(path, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    const discarded = records.filter(record => record.operation === 'discard');
    expect(discarded.length).toBeGreaterThanOrEqual(2);
    expect(discarded.every(record => record.fence.runId === 'run-1' && record.fence.reason === 'CLOUD_PROGRESS_FENCED')).toBe(true);
    if (managerCancelled) {
      expect(discarded[0].fence).toMatchObject({ jobStatus: 'blocked', runStatus: 'reconnecting' });
      expect(discarded.at(-1).fence).toMatchObject({ jobStatus: 'cancelled', runStatus: 'cancelled' });
      expect(h.attempts.some(event => event.type === 'cancelled')).toBe(true);
    }
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(remove).toHaveBeenCalledTimes(2);
    const attempts = h.attempts.length;
    const resumed = h.start();
    const previousHeartbeats = h.heartbeats();
    await until(() => h.heartbeats() > previousHeartbeats);
    resumed.abort.abort(); await resumed.promise;
    expect(resumed.errors).toEqual([]);
    expect(h.attempts).toHaveLength(attempts);
  });

  it.each(['local', 'cloud', 'wrong-run', 'wrong-event', 'wrong-daemon', 'wrong-status', 'wrong-code', 'mixed-status'])('stops and retains progress for an untrusted 403: %s', async mode => {
    const h = await harness();
    if (mode !== 'local') {
      h.options.environmentType = 'cloud';
      h.options.cloud = { image: 'titan-session:fixture', workspaceRoot: h.workspace, snapshotRoot: join(h.root, 'snapshots') };
      h.pending.length = 0;
      const outbox = await PersistentOutbox.open(join(h.options.stateDirectory, 'outbox.jsonl'));
      await outbox.append({ daemonId: 'daemon-1', runId: 'run-1', progress: { eventId: 'old-event', sequence: 1, claimToken: 'claim', type: 'completed', payload: {} } });
    }
    h.denyProgress('run-1', progress => ({ code: mode === 'wrong-code' ? 'VALIDATION_FAILED' : 'PERMISSION_DENIED', details: mode === 'cloud' ? {} : {
      reason: 'CLOUD_PROGRESS_FENCED', environmentType: 'cloud', daemonId: mode === 'wrong-daemon' ? 'other' : 'daemon-1', runId: mode === 'wrong-run' ? 'other' : 'run-1',
      eventId: mode === 'wrong-event' ? 'other' : progress.eventId, jobStatus: 'blocked', runStatus: mode === 'wrong-status' ? 'running' : mode === 'mixed-status' ? 'cancelled' : 'reconnecting',
    } }));
    const session = h.start();
    await until(() => session.errors.length > 0);
    await session.promise;
    expect(String(session.errors[0])).toContain('DAEMON_AUTH_REJECTED');
    const path = join(h.options.stateDirectory, 'outbox.jsonl');
    expect((await PersistentOutbox.open(path)).pending().length).toBeGreaterThan(0);
    expect(await readFile(path, 'utf8')).not.toContain('"operation":"discard"');
  });

  it('registers cloud capabilities and waits for a missing dependency-resolved credential without starting Docker', async () => {
    const h = await harness();
    execFileSync('git', ['init', '--quiet', h.workspace]);
    execFileSync('git', ['-C', h.workspace, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '--quiet', '--allow-empty', '-m', 'fixture']);
    const snapshotRoot = join(h.root, 'snapshots');
    const store = new LocalSnapshotStore({ root: snapshotRoot, workspaceRoots: [h.workspace] });
    const snapshot = await store.exportWorkspace(h.workspace);
    h.options.environmentType = 'cloud';
    h.options.cloud = { image: 'titan-session:fixture', workspaceRoot: h.workspace, snapshotRoot };
    Object.assign(h.options, { credentialResolver: 'remote-json-must-not-be-used' });
    Object.assign(h.dispatch.config, { environmentType: 'cloud', workspacePath: '/workspace/session', credentialRef: 'keychain://fixture' });
    h.dispatch.cloud = { executionId: 'cloud-1', snapshot, secretLeaseId: 'lease-1', secretLeaseExpiresAt: new Date(Date.now() + 60000).toISOString() };
    vi.spyOn(DockerRuntime.prototype, 'create').mockResolvedValue({ id: 'a'.repeat(64), name: `titan-cloud-${'b'.repeat(40)}` });
    vi.spyOn(DockerRuntime.prototype, 'inspect').mockResolvedValue({ state: 'created' });
    vi.spyOn(DockerRuntime.prototype, 'find').mockResolvedValue(undefined);
    vi.spyOn(DockerRuntime.prototype, 'stop').mockResolvedValue();
    const start = vi.spyOn(DockerRuntime.prototype, 'start');
    const resolver = vi.fn(async () => undefined);
    const session = h.start({ credentialResolver: resolver });
    await until(() => h.events.some(event => event.type === 'waiting_input'));
    session.abort.abort(); await session.promise;
    expect(resolver).toHaveBeenCalledExactlyOnceWith('keychain://fixture');
    expect(start).not.toHaveBeenCalled();
    expect(h.registration()).toMatchObject({ environmentType: 'cloud', capabilities: ['codex', 'qwen', 'cloud-session', 'container', 'snapshot-transfer', 'secret-lease'] });
    expect(h.events.at(-1)).toMatchObject({ type: 'waiting_input', payload: { code: 'CLOUD_SECRET_UNAVAILABLE' } });
    expect(session.errors).toEqual([]);
  });

  it('takes skill activation and trusted-code policy only from the local daemon configuration', async () => {
    const h = await harness('policy', { localPolicy: { enabledSkills: ['review.local'], trustedCode: false } });
    Object.assign(h.dispatch.config, { localPolicy: { enabledSkills: ['remote.escalation'], trustedCode: true } });
    const session = h.start();
    await until(() => h.events.some(event => event.type === 'completed'));
    session.abort.abort(); await session.promise;
    const output = h.events.find(event => event.type === 'output')?.payload.text;
    expect(JSON.parse(String(output))).toEqual({ enabledSkills: ['review.local'], trustedCode: false });
    expect(session.errors).toEqual([]);
  });

  it('registers, claims and completes with private credentials and a filtered worker environment', async () => {
    process.env.DAEMON_TEST_KEY = 'private-api-value';
    process.env.DAEMON_TEST_FORBIDDEN = 'do-not-pass';
    cleanup.push(async () => { delete process.env.DAEMON_TEST_KEY; delete process.env.DAEMON_TEST_FORBIDDEN; });
    const h = await harness('complete', { credentialEnv: ['DAEMON_TEST_KEY'] });
    const session = h.start();
    await until(() => h.events.some(event => event.type === 'completed'));
    await until(() => h.heartbeats() >= 1);
    session.abort.abort();
    await session.promise;
    expect(session.errors).toEqual([]);
    expect(h.events.map(event => event.type)).toEqual(['running', 'output', 'completed']);
    expect(h.events[1]?.payload.text).toBe('worker:[REDACTED]:filtered');
    const credentials = join(h.options.stateDirectory, 'device.json');
    expect((await stat(credentials)).mode & 0o777).toBe(0o600);
    const disk = await readFile(join(h.options.stateDirectory, 'outbox.jsonl'), 'utf8');
    expect(disk).not.toContain('private-api-value');
    expect(disk).not.toContain('should-not-be-durable');
    expect(h.registrations()).toBe(1);
  });

  it('retries disconnected progress with the original eventId and sequence', async () => {
    const h = await harness();
    h.offline(true);
    const session = h.start();
    await until(() => h.attempts.length > 1);
    h.offline(false);
    await until(() => h.events.some(event => event.type === 'completed'));
    session.abort.abort(); await session.promise;
    expect(h.attempts[0]).toEqual(h.attempts[1]);
    expect(h.events.map(event => event.sequence)).toEqual([1, 2, 3]);
  });

  it('backs off transient claim failures and then uses only the locally configured Node runner', async () => {
    const h = await harness();
    Object.assign(h.dispatch, { runnerCommand: '/remote-command-must-never-run', runnerArgs: ['--eval', 'process.exit(9)'] });
    Object.assign(h.dispatch.config, { env: { NODE_OPTIONS: '--remote-injection' } });
    h.failClaims(3);
    const session = h.start();
    await until(() => h.events.some(event => event.type === 'completed'));
    session.abort.abort(); await session.promise;
    expect(h.claimTimes.length).toBeGreaterThanOrEqual(4);
    expect(h.claimTimes[2]! - h.claimTimes[1]!).toBeGreaterThanOrEqual(25);
    expect(h.claimTimes[3]! - h.claimTimes[2]!).toBeGreaterThanOrEqual(50);
    expect(session.errors).toEqual([]);
  });

  it('replays unacknowledged disk progress after reconstruction and never resends acknowledged events', async () => {
    const h = await harness();
    h.offline(true);
    const first = h.start();
    await until(() => h.attempts.length > 0);
    await until(async () => (await readFile(join(h.options.stateDirectory, 'outbox.jsonl'), 'utf8')).includes('completed'));
    first.abort.abort(); await first.promise;
    h.offline(false);
    const second = h.start();
    await until(() => h.events.some(event => event.type === 'completed'));
    second.abort.abort(); await second.promise;
    const attempts = h.attempts.length;
    const third = h.start();
    await until(() => h.heartbeats() >= 3);
    third.abort.abort(); await third.promise;
    expect(h.attempts).toHaveLength(attempts);
    expect(h.registrations()).toBe(1);
    expect([...first.errors, ...second.errors, ...third.errors]).toEqual([]);
  });

  it('cancels a stubborn worker and its descendant with bounded process group termination', async () => {
    const h = await harness('stubborn');
    const session = h.start();
    await until(() => h.events.some(event => event.payload.pid));
    const pid = h.events.find(event => event.payload.pid)!.payload.pid as number;
    h.cancel();
    await until(() => h.events.some(event => event.type === 'cancelled'));
    await until(() => { try { process.kill(pid, 0); return false; } catch { return true; } });
    session.abort.abort(); await session.promise;
    expect(h.events.some(event => event.type === 'failed')).toBe(false);
  });

  it('fails a worker that exceeds its configured deadline', async () => {
    const h = await harness('hang');
    h.dispatch.config.timeoutMs = 150;
    const session = h.start();
    await until(() => h.events.some(event => event.type === 'failed'));
    session.abort.abort(); await session.promise;
    expect(h.events.find(event => event.type === 'failed')?.payload.code).toBe('RUN_TIMEOUT');
    expect(h.events.some(event => event.type === 'cancelled')).toBe(false);
  });

  it('records unexpected worker exit as failure', async () => {
    const h = await harness('exit');
    const session = h.start();
    await until(() => h.events.some(event => event.type === 'failed'));
    session.abort.abort(); await session.promise;
    expect(h.events.find(event => event.type === 'failed')?.payload.code).toBe('WORKER_EXITED');
  });

  it.each(['wrong-token', 'wrong-sequence'])('rejects invalid worker progress: %s', async goal => {
    const h = await harness(goal);
    const session = h.start();
    await until(() => h.events.some(event => event.type === 'failed'));
    session.abort.abort(); await session.promise;
    expect(h.events.find(event => event.type === 'failed')?.payload.code).toBe('WORKER_PROTOCOL_ERROR');
  });

  it('reaps a worker that reports completed but keeps its IPC channel open', async () => {
    const h = await harness('terminal-hang');
    const session = h.start();
    await until(() => h.events.some(event => event.type === 'completed'));
    h.pending.push({ ...h.dispatch, runId: 'run-2', goal: 'complete' });
    await until(() => h.events.filter(event => event.type === 'completed').length === 2);
    session.abort.abort(); await session.promise;
    expect(session.errors).toEqual([]);
    expect(h.events.some(event => event.type === 'failed')).toBe(false);
  });

  it('refuses two resident daemons sharing one credential and outbox directory', async () => {
    const h = await harness('hang');
    const first = h.start();
    await until(() => h.events.some(event => event.type === 'running'));
    const second = h.start();
    await Promise.race([second.promise, new Promise(resolve => setTimeout(resolve, 200))]);
    expect(second.errors.map(String).join()).toContain('DAEMON_STATE_LOCKED');
    first.abort.abort(); await first.promise;
    expect(h.registrations()).toBe(1);
  });

  it('rejects escaping missing workspaces and unsupported runtimes before starting a child', async () => {
    const h = await harness();
    const outside = join(h.root, 'outside');
    await mkdir(outside);
    await symlink(outside, join(h.workspace, 'escape'));
    h.dispatch.config.workspacePath = join(h.workspace, 'escape', 'missing', 'deep');
    const session = h.start();
    await until(() => h.events.some(event => event.type === 'failed'));
    expect(h.events.some(event => event.type === 'running')).toBe(false);
    expect(h.events[0]?.payload.code).toBe('INVALID_DISPATCH');
    h.pending.push({ ...h.dispatch, runId: 'run-2', config: { ...h.dispatch.config, workspacePath: h.workspace, runtime: 'other' as 'qwen' } });
    await until(() => h.events.filter(event => event.type === 'failed').length === 2);
    session.abort.abort(); await session.promise;
  });

  it('stops when a persisted daemon credential is revoked instead of registering a replacement identity', async () => {
    const h = await harness('hang');
    const session = h.start();
    await until(() => h.events.some(event => event.type === 'running'));
    h.revoke();
    await until(() => session.errors.length > 0);
    await session.promise;
    expect(String(session.errors[0])).toContain('DAEMON_AUTH_REJECTED');
    expect(h.registrations()).toBe(1);
  });

  it('stops on an invalid acknowledgment and preserves unacknowledged events on disk', async () => {
    const h = await harness('hang');
    h.invalidProgressAck();
    const session = h.start();
    await Promise.race([session.promise, new Promise(resolve => setTimeout(resolve, 1000))]);
    expect(session.errors.map(String).join()).toContain('INVALID_PROGRESS_ACK');
    const log = await readFile(join(h.options.stateDirectory, 'outbox.jsonl'), 'utf8');
    expect(log).toContain('"operation":"append"');
    expect(log).not.toContain('"operation":"ack"');
  });

  it('runs the daemon CLI as a resident process and replays disk events after an actual process restart', async () => {
    const h = await harness();
    const configPath = join(h.root, 'daemon-config.json');
    await writeFile(configPath, JSON.stringify(h.options));
    const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
    const start = () => {
      const child = spawn(process.execPath, [cli, '--config', configPath], { stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      child.stdout.on('data', chunk => { output += chunk; });
      child.stderr.on('data', chunk => { output += chunk; });
      const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
      cleanup.push(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); await closed; });
      return { child, closed, output: () => output };
    };
    h.offline(true);
    const first = start();
    await until(() => {
      if (first.child.exitCode !== null) throw new Error(first.output());
      return h.attempts.length > 0;
    });
    await until(async () => (await readFile(join(h.options.stateDirectory, 'outbox.jsonl'), 'utf8')).includes('completed'));
    // 等待 RuntimeWorker 正常退出后模拟 Daemon 进程崩溃，隔离验证 Outbox 恢复语义。
    await new Promise(resolve => setTimeout(resolve, 180));
    first.child.kill('SIGKILL'); await first.closed;
    h.offline(false);
    const second = start();
    await until(() => h.events.some(event => event.type === 'completed'));
    second.child.kill('SIGTERM'); await second.closed;
    expect(second.child.exitCode).toBe(0);
    expect(h.registrations()).toBe(1);
    expect(first.output() + second.output()).not.toContain('device-secret-token');
    expect(first.output() + second.output()).not.toContain('claim-secret-token');
    const count = h.attempts.length;
    const third = start();
    const heartbeatCount = h.heartbeats();
    await until(() => h.heartbeats() > heartbeatCount);
    third.child.kill('SIGTERM'); await third.closed;
    expect(h.attempts).toHaveLength(count);
  });
});
