import { describe, expect, it } from 'vitest';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, renameSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DockerRuntime } from '../../src/cloud/docker-runtime.js';

function fixture(extraMount = false) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'titan-cloud-docker-')));
  const workspace = join(root, 'session');
  mkdirSync(workspace, { mode: 0o700 });
  const calls: string[][] = [];
  const children: ChildProcessWithoutNullStreams[] = [];
  const inputs: string[] = [];
  let container: Record<string, unknown> | undefined;
  let forged = false;
  const spawn = (_command: string, args: readonly string[]) => {
    calls.push([...args]);
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true }) as unknown as ChildProcessWithoutNullStreams;
    children.push(child);
    child.stdin.on('data', chunk => inputs.push(chunk.toString()));
    queueMicrotask(() => {
      if (args[0] === 'logs' || args[0] === 'start') return;
      if (args[0] === 'create') {
        if (container) { child.stderr.end('Conflict: name already in use'); child.emit('close', 1); return; }
        const labels: Record<string, string> = {};
        args.forEach((arg, index) => { if (arg === '--label') { const [key, value] = args[index + 1]!.split('='); labels[key!] = value!; } });
        container = { Id: 'a'.repeat(64), Name: `/${args[args.indexOf('--name') + 1]}`, Config: { Labels: labels }, State: { Status: 'created', ExitCode: 0 }, Mounts: [{ Type: 'bind', Source: args[args.indexOf('--mount') + 1]!.split(',')[1]!.slice(4), Destination: '/workspace' }] };
        if (extraMount) (container.Mounts as unknown[]).push({ Type: 'volume', Source: '/docker/data', Destination: '/data' });
        child.stdout.end('a'.repeat(64));
        child.emit('close', 0);
      } else if (args[0] === 'inspect') {
        if (!container) { child.stderr.end('Error: No such object'); child.emit('close', 1); }
        else { child.stdout.end(JSON.stringify([{ ...container, ...(forged ? { Config: { Labels: {} } } : {}) }])); child.emit('close', 0); }
      } else if (args[0] === 'rm') { container = undefined; child.emit('close', 0); }
      else child.emit('close', 0);
    });
    return child;
  };
  const runtime = new DockerRuntime({ image: 'titan-worker:local', workspaceRoot: root, ownerId: 'daemon-1' }, { spawn });
  return { root, workspace, calls, runtime, children, inputs, spawn, forge: () => { forged = true; } };
}

describe('DockerRuntime', () => {
  it('creates a deterministic, non-root, hardened container and finds it by scope', async () => {
    const { runtime, workspace, calls } = fixture();
    const spec = { sessionId: 'session-1', runId: 'run-1', workspacePath: workspace };
    const [first, second] = await Promise.all([runtime.create(spec), runtime.create(spec)]);
    expect(first).toEqual(second);
    expect(calls.filter(args => args[0] === 'create')).toHaveLength(1);
    const args = calls.find(args => args[0] === 'create')!;
    for (const value of ['--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--network=none', '--pull=never']) expect(args).toContain(value);
    expect(args).toContain(`--user=${process.getuid!()}:${process.getgid!()}`);
    expect(args).toContain(`type=bind,src=${workspace},dst=/workspace`);
    expect(args).toContain('--tmpfs');
    expect(await runtime.find(spec)).toEqual(first);
    expect(await runtime.inspect(first)).toEqual({ state: 'created' });
    await runtime.stop(first);
    await runtime.remove(first);
    expect(await runtime.inspect(first)).toEqual({ state: 'missing' });
    expect(await runtime.find(spec)).toBeUndefined();
  });

  it('writes bootstrap only to attached stdin and returns synchronous process handles', async () => {
    const { runtime, workspace, calls, inputs } = fixture();
    const handle = await runtime.create({ sessionId: 's', runId: 'r', workspacePath: workspace });
    const bootstrap = Buffer.from('{"key":"private-value"}\n');
    const child = runtime.start(handle, bootstrap);
    expect(child).not.toBeInstanceOf(Promise);
    await new Promise(resolve => setImmediate(resolve));
    expect(inputs).toContain(bootstrap.toString());
    expect(child.stdin.writableEnded).toBe(true);
    expect(calls.some(args => args.join(' ').includes('private-value'))).toBe(false);
    expect(calls.find(args => args[0] === 'start')).toEqual(['start', '--attach', '--interactive', handle.id]);
    const logs = runtime.logs(handle);
    expect(logs.stdout).toBeDefined();
    await new Promise(resolve => setImmediate(resolve));
    expect(calls.find(args => args[0] === 'logs')).toEqual(['logs', '--follow', handle.id]);
    child.kill();
    logs.kill();
  });

  it('rejects foreign handles and verifies labels before stop/remove/start/logs', async () => {
    const { runtime, workspace, calls, forge } = fixture();
    await expect(runtime.stop({ id: 'b'.repeat(64), name: 'foreign' })).rejects.toThrow('CLOUD_CONTAINER_OWNER');
    const handle = await runtime.create({ sessionId: 's', runId: 'r', workspacePath: workspace });
    forge();
    await expect(runtime.stop(handle)).rejects.toThrow('CLOUD_CONTAINER_OWNER');
    await expect(runtime.remove(handle)).rejects.toThrow('CLOUD_CONTAINER_OWNER');
    const child = runtime.start(handle, Buffer.from('secret'));
    const errors: Error[] = [];
    child.on('error', error => errors.push(error));
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(errors[0]?.message).toBe('CLOUD_CONTAINER_OWNER');
    expect(calls.filter(args => ['start', 'stop', 'rm'].includes(args[0]!))).toHaveLength(0);
  });

  it('rejects escaping paths, unsafe config and a workspace root mount', async () => {
    const { runtime, root } = fixture();
    for (const workspacePath of [tmpdir(), root]) await expect(runtime.create({ sessionId: 's', runId: 'r', workspacePath })).rejects.toThrow('CLOUD_CONTAINER_WORKSPACE');
    expect(() => new DockerRuntime({ image: '--privileged', workspaceRoot: root, ownerId: 'd' })).toThrow('CLOUD_CONTAINER_CONFIG');
  });

  it('redacts CLI failure output and bounds command time', async () => {
    const { root } = fixture();
    const runtime = new DockerRuntime({ image: 'worker:local', workspaceRoot: root, ownerId: 'd' }, {
      timeoutMs: 10,
      spawn: () => {
        const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true }) as unknown as ChildProcessWithoutNullStreams;
        queueMicrotask(() => { child.stderr.write('sk-secret-in-docker-output'); });
        return child;
      },
    });
    await expect(runtime.find({ sessionId: 's', runId: 'r' })).rejects.toThrow(/^CLOUD_CONTAINER_TIMEOUT$/);
  });

  it('recovers a cross-instance create race using Docker name uniqueness', async () => {
    const { root, workspace, runtime, spawn } = fixture();
    const other = new DockerRuntime({ image: 'titan-worker:local', workspaceRoot: root, ownerId: 'daemon-1' }, { spawn });
    const spec = { sessionId: 'session-1', runId: 'run-1', workspacePath: workspace };
    const handles = await Promise.all([runtime.create(spec), other.create(spec)]);
    expect(handles[0]).toEqual(handles[1]);
  });

  it('refuses a workspace root replaced after construction', async () => {
    const { root, runtime } = fixture();
    renameSync(root, `${root}.old`);
    mkdirSync(root);
    mkdirSync(join(root, 'session'));
    await expect(runtime.create({ sessionId: 's', runId: 'r', workspacePath: join(root, 'session') })).rejects.toThrow('CLOUD_CONTAINER_WORKSPACE');
  });

  it('bounds streamed output and suppresses raw Docker stderr', async () => {
    const { runtime, workspace, children } = fixture();
    const handle = await runtime.create({ sessionId: 's', runId: 'r', workspacePath: workspace });
    const stream = runtime.logs(handle);
    const errors: Error[] = [];
    let stderr = '';
    stream.on('error', error => errors.push(error));
    stream.stderr.on('data', chunk => { stderr += chunk.toString(); });
    await new Promise(resolve => setImmediate(resolve));
    const native = children.at(-1)!;
    native.stderr.write('sk-private-material');
    native.stdout.write(Buffer.alloc(1024 * 1024 + 1));
    expect(errors[0]?.message).toBe('CLOUD_CONTAINER_OUTPUT_LIMIT');
    expect(stderr).toBe('');
  });

  it('cancels a pending owner verification without spawning start', async () => {
    const { runtime, workspace, calls } = fixture();
    const handle = await runtime.create({ sessionId: 's', runId: 'r', workspacePath: workspace });
    const stream = runtime.start(handle, Buffer.from('bootstrap'));
    stream.kill();
    await new Promise(resolve => setImmediate(resolve));
    expect(calls.filter(args => args[0] === 'start')).toHaveLength(0);
  });

  it('rejects a writable ancestor between trusted root and workspace', async () => {
    const { root, runtime } = fixture();
    const shared = join(root, 'shared');
    mkdirSync(shared);
    chmodSync(shared, 0o777);
    mkdirSync(join(shared, 'session'), { mode: 0o700 });
    await expect(runtime.create({ sessionId: 's', runId: 'r', workspacePath: join(shared, 'session') })).rejects.toThrow('CLOUD_CONTAINER_WORKSPACE');
  });

  it('rejects a bind source replaced with a symlink before start', async () => {
    const { runtime, workspace, calls } = fixture();
    const handle = await runtime.create({ sessionId: 's', runId: 'r', workspacePath: workspace });
    renameSync(workspace, `${workspace}.old`);
    symlinkSync(tmpdir(), workspace);
    const stream = runtime.start(handle, Buffer.from('bootstrap'));
    const errors: Error[] = [];
    stream.on('error', error => errors.push(error));
    await new Promise(resolve => setImmediate(resolve));
    try {
      expect(errors[0]?.message).toBe('CLOUD_CONTAINER_WORKSPACE');
      expect(calls.filter(args => args[0] === 'start')).toHaveLength(0);
    } finally { stream.kill(); }
  });

  it('rejects and cleans up image-declared extra mounts before starting', async () => {
    const { runtime, workspace, calls } = fixture(true);
    await expect(runtime.create({ sessionId: 's', runId: 'r', workspacePath: workspace })).rejects.toThrow('CLOUD_CONTAINER_WORKSPACE');
    expect(calls.filter(args => args[0] === 'rm')).toHaveLength(1);
  });

  it('refuses reuse of the same run with a different authorized workspace', async () => {
    const { root, workspace, runtime } = fixture();
    const other = join(root, 'other');
    mkdirSync(other, { mode: 0o700 });
    const scope = { sessionId: 's', runId: 'r' };
    await runtime.create({ ...scope, workspacePath: workspace });
    await expect(runtime.create({ ...scope, workspacePath: other })).rejects.toThrow('CLOUD_CONTAINER_WORKSPACE');
  });

  it('refuses a concurrent create for the same run with a different workspace', async () => {
    const { root, workspace, runtime } = fixture();
    const other = join(root, 'other');
    mkdirSync(other, { mode: 0o700 });
    const scope = { sessionId: 's', runId: 'r' };
    const first = runtime.create({ ...scope, workspacePath: workspace });
    await expect(runtime.create({ ...scope, workspacePath: other })).rejects.toThrow('CLOUD_CONTAINER_WORKSPACE');
    await first;
  });

  it('rejects a different directory inode at the same bind path before start', async () => {
    const { workspace, runtime, calls } = fixture();
    const handle = await runtime.create({ sessionId: 's', runId: 'r', workspacePath: workspace });
    renameSync(workspace, `${workspace}.old`);
    mkdirSync(workspace, { mode: 0o700 });
    const stream = runtime.start(handle, Buffer.from('bootstrap'));
    const errors: Error[] = [];
    stream.on('error', error => errors.push(error));
    await new Promise(resolve => setImmediate(resolve));
    try {
      expect(errors[0]?.message).toBe('CLOUD_CONTAINER_WORKSPACE');
      expect(calls.filter(args => args[0] === 'start')).toHaveLength(0);
    } finally { stream.kill(); }
  });
});
