import { createServer, type Server } from 'node:http';
import { mkdtemp, mkdir, readFile, realpath, stat, symlink, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RunDispatch, RunProgress } from '@titan/daemon-protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { DaemonRunner, type DaemonRunnerOptions } from '../src/daemon-runner.js';

const fixture = fileURLToPath(new URL('./fixtures/runtime-worker.cjs', import.meta.url));
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()!(); });

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
  let heartbeatCount = 0;
  let offline = false;
  let cancelRequested = false;
  let revoked = false;
  let claimFailures = 0;
  let badProgressResponse = false;
  const claimTimes: number[] = [];
  const server: Server = createServer(async (request, response) => {
    let content = '';
    for await (const chunk of request) content += chunk;
    const body = content ? JSON.parse(content) : {};
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/api/daemons/register') {
      registrationCount++;
      expect(body.workspaceRoots).toEqual([workspace]);
      response.end(JSON.stringify({ daemonId: 'daemon-1', authToken: 'device-secret-token' }));
      return;
    }
    if (revoked || request.headers.authorization !== 'Bearer device-secret-token') { response.statusCode = 401; response.end('{}'); return; }
    if (request.url?.endsWith('/heartbeat')) { heartbeatCount++; response.end('{}'); return; }
    if (request.url?.endsWith('/claim')) {
      claimTimes.push(Date.now());
      if (claimFailures > 0) { claimFailures--; response.statusCode = 503; response.end('{}'); return; }
      const dispatch = pending.shift();
      response.statusCode = dispatch ? 200 : 204;
      response.end(dispatch ? JSON.stringify(dispatch) : undefined);
      return;
    }
    if (request.url?.endsWith('/control')) { response.end(JSON.stringify({ cancelRequested, status: 'running' })); return; }
    if (request.url?.endsWith('/progress')) {
      attempts.push(body);
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
  const start = () => {
    const abort = new AbortController();
    const errors: unknown[] = [];
    const promise = new DaemonRunner(options).run(abort.signal).catch(error => { errors.push(error); });
    const session = { abort, promise, errors };
    sessions.push(session);
    return session;
  };
  cleanup.push(async () => { for (const session of sessions) session.abort.abort(); await Promise.all(sessions.map(session => session.promise)); });
  return { root, workspace, dispatch, events, attempts, pending, options, start, claimTimes,
    failClaims: (count: number) => { claimFailures = count; },
    invalidProgressAck: () => { badProgressResponse = true; },
    offline: (value: boolean) => { offline = value; }, cancel: () => { cancelRequested = true; }, revoke: () => { revoked = true; },
    registrations: () => registrationCount, heartbeats: () => heartbeatCount,
  };
}

describe('DaemonRunner real HTTP and child IPC', () => {
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
