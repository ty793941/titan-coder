import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, realpath, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DockerRuntime } from '../../src/cloud/docker-runtime.js';

const enabled = process.env.TITAN_REAL_DOCKER_TESTS === '1';
describe.skipIf(!enabled)('DockerRuntime local-image lifecycle', () => {
  it('runs a non-root stdin worker, streams NDJSON and preserves writable output', async () => {
    const image = `titan-adapters-test:${process.pid}`;
    const base = ['node:22-alpine', 'alpine:3.22', 'nginx:alpine'].find(candidate => {
      try {
        const image = JSON.parse(execFileSync('docker', ['image', 'inspect', candidate], { encoding: 'utf8', stdio: 'pipe', timeout: 5000, maxBuffer: 1024 * 1024 }))[0];
        return Object.keys(image.Config.Volumes ?? {}).length === 0;
      }
      catch { return false; }
    });
    expect(base, 'a local test image must be available; no image is pulled').toBeDefined();
    const command = `read -r bootstrap; printf done > /workspace/result; printf '%s\\n' '{"type":"completed"}'`;
    const dockerfile = `FROM ${base}\nENTRYPOINT ${JSON.stringify(['/bin/sh', '-c', command])}\n`;
    execFileSync('docker', ['build', '--pull=false', '--network=none', '-t', image, '-'], {
      input: dockerfile, env: { ...process.env, DOCKER_BUILDKIT: '0' }, stdio: ['pipe', 'pipe', 'pipe'], timeout: 30_000, maxBuffer: 1024 * 1024,
    });
    const root = await realpath(await mkdtemp(join(tmpdir(), 'titan-real-cloud-')));
    const workspace = join(root, 'session');
    await mkdir(workspace, { mode: 0o700 });
    const runtime = new DockerRuntime({ image, workspaceRoot: root, ownerId: 'adapter-test' });
    let handle: { id: string; name: string } | undefined;
    try {
      handle = await runtime.create({ sessionId: 'session', runId: 'run', workspacePath: workspace });
      expect(await runtime.inspect(handle)).toEqual({ state: 'created' });
      const inspection = JSON.parse(execFileSync('docker', ['inspect', handle.id], { encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024 }))[0];
      expect(inspection.Mounts).toEqual(expect.arrayContaining([expect.objectContaining({ Type: 'bind', Source: workspace, Destination: '/workspace' })]));
      expect(inspection.Mounts).toHaveLength(1);
      const processHandle = runtime.start(handle, Buffer.from('{"secrets":{}}\n'));
      let text = '';
      processHandle.stdout.on('data', chunk => { text += chunk.toString(); });
      const code = await new Promise<number | null>((resolve, reject) => { processHandle.on('error', reject); processHandle.on('close', resolve); });
      expect(code).toBe(0);
      expect(JSON.parse(text.trim())).toEqual({ type: 'completed' });
      expect(await readFile(join(workspace, 'result'), 'utf8')).toBe('done');
      expect(await runtime.inspect(handle)).toEqual({ state: 'exited', exitCode: 0 });
      const logs = runtime.logs(handle);
      let logged = '';
      logs.stdout.on('data', chunk => { logged += chunk.toString(); });
      await new Promise<void>((resolve, reject) => { logs.on('error', reject); logs.on('close', () => resolve()); });
      expect(JSON.parse(logged.trim())).toEqual({ type: 'completed' });
      await runtime.stop(handle);
      await runtime.remove(handle);
      expect(await runtime.inspect(handle)).toEqual({ state: 'missing' });
    } finally {
      if (handle) await runtime.remove(handle);
      execFileSync('docker', ['image', 'rm', image], { stdio: 'pipe', timeout: 10_000 });
    }
  }, 60_000);
});
