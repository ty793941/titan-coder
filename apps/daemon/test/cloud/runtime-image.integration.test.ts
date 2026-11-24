import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DockerRuntime } from '../../src/cloud/docker-runtime.js';

const enabled = process.env.TITAN_RUNTIME_IMAGE_TESTS === '1';
const image = process.env.TITAN_RUNTIME_TEST_IMAGE ?? 'titan-session:phase2a';
const docker = (args: string[]) => execFileSync('docker', args, { encoding: 'utf8', stdio: 'pipe', timeout: 15_000, maxBuffer: 1024 * 1024 }).trim();

describe.skipIf(!enabled)('real container worker image', () => {
  it('provides pnpm 10.34.5 for offline trusted-code tests as a non-root user', () => {
    const options = ['run', '--rm', '--pull=never', '--network=none', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--user=1000:1000', '--tmpfs', '/tmp:rw,nosuid,nodev,noexec,size=16m,mode=1777'];
    expect(docker([...options, '--entrypoint=pnpm', image, '--version'])).toBe('10.34.5');
    const setup = `const fs = require('node:fs'); fs.writeFileSync('/tmp/package.json', JSON.stringify({ packageManager: 'pnpm@10.34.5', scripts: { test: 'node smoke.cjs' } })); fs.writeFileSync('/tmp/smoke.cjs', 'console.log("trusted-code-smoke-ok")')`;
    expect(docker([...options, '--workdir=/tmp', '--entrypoint=sh', image, '-c', 'node -e "$1" && pnpm test', 'pnpm-smoke', setup])).toContain('\ntrusted-code-smoke-ok');
  }, 60_000);

  it('runs missing-credential dispatch to waiting_input with recoverable logs and read-only isolation', async () => {
    const metadata = JSON.parse(docker(['image', 'inspect', image]))[0];
    expect(metadata.Os).toBe('linux');
    expect(metadata.Config.User).not.toMatch(/^(?:0|root)?$/);
    expect(metadata.Config.Entrypoint).toEqual(['node', '/opt/titan/apps/agent-runtime/dist/container-worker.js']);
    const root = await realpath(await mkdtemp(join(tmpdir(), 'titan-real-runtime-')));
    const workspace = join(root, 'run');
    await mkdir(workspace, { mode: 0o700 });
    await mkdir(join(workspace, 'session'), { mode: 0o700 });
    const options = { image, workspaceRoot: root, ownerId: 'runtime-image-test' };
    const runtime = new DockerRuntime(options);
    const scope = { sessionId: 'runtime-session', runId: 'runtime-run' };
    const handle = await runtime.create({ ...scope, workspacePath: workspace });
    try {
      const inspected = JSON.parse(docker(['inspect', handle.id]))[0];
      expect(inspected.HostConfig.ReadonlyRootfs).toBe(true);
      expect(inspected.HostConfig.CapDrop).toContain('ALL');
      expect(inspected.HostConfig.SecurityOpt).toContain('no-new-privileges');
      expect(inspected.HostConfig.NetworkMode).toBe('none');
      expect(inspected.HostConfig.Tmpfs).toHaveProperty('/tmp');
      expect(inspected.Config.User).toBe(`${process.getuid!()}:${process.getgid!()}`);
      const body = {
        version: 1,
        dispatch: {
          jobId: 'image-job', runId: scope.runId, sessionId: scope.sessionId, projectId: 'image-project', taskId: 'image-task',
          goal: 'verify offline credential boundary', planHash: 'image-plan', claimToken: 'image-claim',
          config: {
            daemonId: 'cloud-daemon', environmentType: 'cloud', runtime: 'qwen', credentialRef: 'keychain://titan-qwen',
            workspacePath: '/workspace/session', snapshotManifestRef: 'snapshot://image-snapshot', secretLeaseRef: 'lease://image-lease',
            allowedTools: [], maxTurns: 1, timeoutMs: 5000,
          },
        },
        credentials: {},
      };
      const child = runtime.start(handle, Buffer.from(`${JSON.stringify(body)}\n`));
      let stdout = '';
      child.stdout.on('data', chunk => { stdout += chunk.toString(); });
      const exitCode = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
      expect(exitCode).toBe(0);
      const frames = stdout.trim().split('\n').map(line => JSON.parse(line));
      expect(frames.at(-1)).toEqual({ version: 1, type: 'result', status: 'waiting_input' });
      expect(frames.filter(frame => frame.type === 'progress').map(frame => frame.progress.type)).toEqual(['running', 'waiting_input']);
      const recovered = new DockerRuntime(options);
      expect(await recovered.find(scope)).toEqual(handle);
      expect(await recovered.inspect(handle)).toEqual({ state: 'exited', exitCode: 0 });
      const logs = recovered.logs(handle);
      let replay = '';
      logs.stdout.on('data', chunk => { replay += chunk.toString(); });
      await new Promise<void>((resolve, reject) => { logs.once('error', reject); logs.once('close', () => resolve()); });
      expect(replay).toBe(stdout);
      const before = docker(['inspect', '--format', '{{json .Config.Env}}', handle.id]);
      expect(before).not.toMatch(/OPENAI_API_KEY|DASHSCOPE_API_KEY|fixture-value/);
      const shell = 'test ! -w /opt/titan/apps/agent-runtime/dist/container-worker.js && ! touch /opt/titan/write-denied 2>/dev/null && touch /tmp/write-allowed';
      expect(docker(['run', '--rm', '--pull=never', '--network=none', '--read-only', '--user=1000:1000', '--tmpfs', '/tmp:rw,nosuid,nodev,noexec,size=16m,mode=1777', '--entrypoint=sh', image, '-c', shell])).toBe('');
    } finally { await runtime.remove(handle); }
  }, 60_000);

  it.skipIf(process.env.TITAN_CODEX_IMAGE_TESTS !== '1')('contains the pinned official Linux Codex executable', () => {
    expect(docker(['run', '--rm', '--pull=never', '--network=none', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--user=1000:1000', '--tmpfs', '/tmp:rw,nosuid,nodev,noexec,size=16m,mode=1777', '--entrypoint=codex', image, '--version'])).toBe('codex-cli 0.172.0');
  });
});
