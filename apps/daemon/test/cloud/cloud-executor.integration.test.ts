import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RunDispatch, RunProgress } from '@titan/daemon-protocol';
import { CloudExecutor } from '../../src/cloud/cloud-executor.js';
import { DockerRuntime } from '../../src/cloud/docker-runtime.js';
import { LocalSnapshotStore } from '../../src/cloud/snapshot-store.js';
import { SecretBroker } from '../../src/cloud/secret-broker.js';
import { initializeSnapshotRepository } from './snapshot-fixture.js';

const enabled = process.env.TITAN_REAL_DOCKER_TESTS === '1';
const image = `titan-detach-test:${process.pid}`;
let imageBuilt = false;
const docker = (args: string[], input?: string) => execFileSync('docker', args, {
  encoding: 'utf8', stdio: 'pipe', timeout: 30_000, maxBuffer: 1024 * 1024,
  ...(input === undefined ? {} : { input }),
}).trim();

// 真实容器在 stdin EOF 后继续工作，SIGTERM 必须留下可检查的退出码 42。
const worker = String.raw`
const fs = require('node:fs');
process.on('SIGTERM', () => {
  fs.writeFileSync('/workspace/term-observed', 'SIGTERM');
  process.exit(42);
});
let text = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { text += chunk; });
process.stdin.on('end', () => {
  const { dispatch } = JSON.parse(text);
  fs.writeFileSync('/workspace/eof-observed', 'EOF');
  let sequence = 0;
  const tick = () => {
    sequence++;
    fs.writeFileSync('/workspace/heartbeat', String(sequence));
    process.stdout.write(JSON.stringify({ version: 1, type: 'progress', progress: {
      eventId: 'fixture-event-' + sequence, sequence, claimToken: dispatch.claimToken,
      type: sequence === 1 ? 'running' : 'output', payload: { text: 'heartbeat ' + sequence }
    } }) + '\n');
  };
  tick();
  setInterval(tick, 100);
});
`;

async function until(predicate: () => boolean | Promise<boolean>, message: string, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(message);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

async function fixture(timeoutMs = 20_000) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'titan-detach-')));
  const source = join(root, 'source');
  const workspaceRoot = join(root, 'workspaces');
  await mkdir(source, { mode: 0o700 });
  await mkdir(workspaceRoot, { mode: 0o700 });
  initializeSnapshotRepository(source);
  const snapshots = new LocalSnapshotStore({ root: join(root, 'snapshots'), workspaceRoots: [source, workspaceRoot] });
  const snapshot = await snapshots.exportWorkspace(source);
  const dispatch: RunDispatch = {
    jobId: 'detach-job', runId: 'detach-run', sessionId: 'detach-session', taskId: 'detach-task', projectId: 'detach-project',
    goal: 'verify docker attach signal isolation', planHash: 'detach-plan', claimToken: 'detach-claim',
    config: { daemonId: 'detach-daemon', environmentType: 'cloud', runtime: 'qwen', credentialRef: 'broker://fixture',
      workspacePath: '/workspace/session', allowedTools: [], maxTurns: 1, timeoutMs },
    cloud: { executionId: 'detach-execution', snapshot, secretLeaseId: 'detach-lease', secretLeaseExpiresAt: new Date(Date.now() + 60_000).toISOString() },
  };
  const calls: string[][] = [];
  const cli: Array<{ args: readonly string[]; child: ChildProcessWithoutNullStreams; closed: Promise<void> }> = [];
  const runtimeOptions = { image, workspaceRoot, ownerId: 'detach-test' };
  const runtimeDependencies = { spawn: (command: string, args: readonly string[], options: Parameters<typeof spawn>[2]) => {
    calls.push([...args]);
    const child = spawn(command, args, options) as ChildProcessWithoutNullStreams;
    const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
    cli.push({ args, child, closed });
    return child;
  } };
  const runtime = new DockerRuntime(runtimeOptions, runtimeDependencies);
  let consumeCount = 0;
  let resolveCount = 0;
  const progress: RunProgress[] = [];
  const options = {
    stateDirectory: join(root, 'state'), workspaceRoot, runtime, snapshots,
    broker: new SecretBroker(async () => { resolveCount++; return 'fixture-credential'; }),
    lifecycle: async (body: { consumeSecret?: boolean }) => { if (body.consumeSecret) consumeCount++; },
    onProgress: async (event: RunProgress) => { progress.push(event); }, initialSequence: 0,
  };
  const parent = join(workspaceRoot, dispatch.sessionId);
  const cleanup = async (executors: CloudExecutor[]) => {
    for (const executor of executors) executor.shutdown();
    await Promise.allSettled(executors.map(executor => executor.done));
    const handle = await runtime.find(dispatch);
    if (handle) {
      await runtime.stop(handle);
      await runtime.remove(handle);
    }
    await Promise.all(cli.map(entry => entry.closed));
  };
  return { options, dispatch, runtime, runtimeOptions, runtimeDependencies, progress, calls, cli, parent, cleanup,
    counts: () => ({ consumeCount, resolveCount }) };
}

describe.skipIf(!enabled)('CloudExecutor real Docker detach', () => {
  beforeAll(() => {
    const base = ['titan-session:phase2a', 'node:22-bookworm-slim'].find(candidate => {
      try { docker(['image', 'inspect', candidate]); return true; } catch { return false; }
    });
    expect(base, 'a local Node image is required; this test never pulls images').toBeDefined();
    docker(['build', '--pull=false', '--network=none', '-t', image, '-'], `FROM ${base}\nENTRYPOINT ${JSON.stringify(['node', '-e', worker])}\n`);
    imageBuilt = true;
  }, 40_000);

  afterAll(() => { if (imageBuilt) docker(['image', 'rm', image]); });

  it('keeps the container running after shutdown, recovers logs without start/consume, and explicitly cancels with exit 42', async () => {
    const f = await fixture();
    const executor = new CloudExecutor(f.dispatch, f.options);
    const executors = [executor];
    try {
      await until(() => f.progress.length >= 2, 'fixture did not survive stdin EOF');
      expect(await readFile(join(f.parent, 'eof-observed'), 'utf8')).toBe('EOF');
      const handle = (await f.runtime.find(f.dispatch))!;
      const attached = f.cli.find(entry => entry.args[0] === 'start')!;
      const before = Number(await readFile(join(f.parent, 'heartbeat'), 'utf8'));
      executor.shutdown();
      await executor.done;
      await attached.closed;
      expect(attached.child.signalCode).toBe('SIGKILL');
      await new Promise(resolve => setTimeout(resolve, 250));
      expect(await f.runtime.inspect(handle)).toEqual({ state: 'running' });
      expect(Number(await readFile(join(f.parent, 'heartbeat'), 'utf8'))).toBeGreaterThan(before);
      expect(f.calls.filter(args => args[0] === 'stop')).toHaveLength(0);
      expect(f.progress.every(event => !['completed', 'cancelled', 'failed'].includes(event.type))).toBe(true);

      const lastSequence = f.progress.at(-1)!.sequence;
      const counts = f.counts();
      const recoveredRuntime = new DockerRuntime(f.runtimeOptions, f.runtimeDependencies);
      const recovered = await CloudExecutor.recover({ ...f.options, runtime: recoveredRuntime, recoverSequence: () => lastSequence,
        broker: new SecretBroker(async () => { throw new Error('recovery must not resolve credentials'); }),
      });
      expect(recovered).toBeDefined();
      executors.push(recovered!);
      await until(() => f.progress.at(-1)!.sequence > lastSequence, 'recovery did not follow live container logs');
      expect(await recoveredRuntime.inspect(handle)).toEqual({ state: 'running' });
      expect(f.calls.filter(args => args[0] === 'logs')).toHaveLength(1);
      expect(f.calls.filter(args => args[0] === 'start')).toHaveLength(1);
      expect(f.counts()).toEqual(counts);
      expect(counts).toEqual({ consumeCount: 1, resolveCount: 1 });
      expect(new Set(f.progress.map(event => event.eventId)).size).toBe(f.progress.length);

      recovered!.cancel();
      await recovered!.done;
      expect(await recoveredRuntime.inspect(handle)).toEqual({ state: 'exited', exitCode: 42 });
      expect(await readFile(join(f.parent, 'term-observed'), 'utf8')).toBe('SIGTERM');
      expect(f.calls.filter(args => args[0] === 'stop')).toHaveLength(1);
      expect(f.progress.at(-1)?.type).toBe('cancelled');
      await recovered!.cleanup();
    } finally { await f.cleanup(executors); }
  }, 30_000);

  it('uses explicit Docker stop for timeout and confirms exit 42 before reporting failed', async () => {
    const f = await fixture(4000);
    const executor = new CloudExecutor(f.dispatch, f.options);
    try {
      await until(() => f.progress.length > 0, 'timeout fixture did not start', 3500);
      const handle = (await f.runtime.find(f.dispatch))!;
      await executor.done;
      expect(await f.runtime.inspect(handle)).toEqual({ state: 'exited', exitCode: 42 });
      expect(f.calls.filter(args => args[0] === 'stop')).toHaveLength(1);
      expect(f.progress.at(-1)).toMatchObject({ type: 'failed', payload: { code: 'CLOUD_CONTAINER_TIMEOUT' } });
      await executor.cleanup();
    } finally { await f.cleanup([executor]); }
  }, 15_000);
});
