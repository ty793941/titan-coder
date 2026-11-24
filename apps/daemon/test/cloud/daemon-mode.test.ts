import { createServer } from 'node:http';
import { mkdtemp, mkdir, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { DaemonRunner } from '../../src/daemon-runner.js';
import { DaemonClient } from '../../src/daemon-client.js';

describe('Daemon cloud and handoff wiring', () => {
  it('rejects cloud mode without a trusted container configuration', () => {
    expect(() => new DaemonRunner({ baseUrl: 'http://localhost:3000', stateDirectory: '/tmp/state', workspaceRoots: ['/tmp/work'], environmentType: 'cloud' })).toThrow('CLOUD_CONFIGURATION_REQUIRED');
  });

  it('sends lifecycle and failure messages only to the authenticated daemon routes', async () => {
    const requests: Array<{ path: string; auth: string | undefined; body: unknown }> = [];
    const server = createServer(async (req, res) => {
      let bytes = '';
      for await (const chunk of req) bytes += chunk;
      requests.push({ path: req.url!, auth: req.headers.authorization, body: bytes ? JSON.parse(bytes) : undefined });
      res.setHeader('content-type', 'application/json');
      res.end(req.url!.endsWith('pending') ? '{"requests":[]}' : '{}');
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address() as { port: number };
      const client = new DaemonClient(`http://127.0.0.1:${address.port}`);
      const device = { daemonId: 'daemon1', authToken: 'device-token', baseUrl: client.baseUrl };
      await client.pendingHandoffs(device);
      await client.cloudLifecycle(device, 'run1', { claimToken: 'claim', status: 'creating', consumeSecret: true });
      await client.failHandoff(device, 'handoff1', 'HANDOFF_SNAPSHOT_FAILED');
      expect(requests.map(r => r.path)).toEqual(['/api/daemons/daemon1/handoffs/pending', '/api/daemons/daemon1/runs/run1/cloud', '/api/daemons/daemon1/handoffs/handoff1/failure']);
      expect(requests.every(r => r.auth === 'Bearer device-token')).toBe(true);
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  });

  it('exports a stopped source workspace and acknowledges the same immutable snapshot on retry', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'titan-handoff-mode-')));
    const workspace = join(root, 'workspace');
    await mkdir(workspace, { mode: 0o700 });
    await writeFile(join(workspace, 'source.txt'), 'handoff content');
    execFileSync('git', ['init', '--quiet', workspace]);
    execFileSync('git', ['-C', workspace, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-qm', 'base']);
    let acknowledged = false;
    let attempts = 0;
    const manifests: unknown[] = [];
    const controller = new AbortController();
    const server = createServer(async (req, res) => {
      let bytes = '';
      for await (const chunk of req) bytes += chunk;
      res.setHeader('content-type', 'application/json');
      if (req.url!.endsWith('register')) { res.end('{"daemonId":"source","authToken":"device"}'); return; }
      if (req.url!.endsWith('heartbeat')) { res.end('{}'); return; }
      if (req.url!.endsWith('pending')) { res.end(JSON.stringify({ requests: acknowledged ? [] : [{ id: 'handoff1', sourceSessionId: 'session1', sourceRunId: 'run1', checkpointId: 'checkpoint1', workspacePath: workspace }] })); return; }
      if (req.url!.endsWith('snapshot')) {
        const body = JSON.parse(bytes);
        manifests.push(body.manifest);
        expect(body.stopped).toBe(true);
        attempts++;
        if (attempts === 1) { res.statusCode = 503; res.end('{}'); return; }
        acknowledged = true; controller.abort(); res.end('{}'); return;
      }
      res.statusCode = 204; res.end();
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const timer = setTimeout(() => controller.abort(), 3000);
    try {
      const address = server.address() as { port: number };
      await new DaemonRunner({ baseUrl: `http://127.0.0.1:${address.port}`, stateDirectory: join(root, 'state'), workspaceRoots: [workspace], handoff: { snapshotRoot: join(root, 'snapshots') }, pollIntervalMs: 10, heartbeatIntervalMs: 20 }).run(controller.signal);
      expect(acknowledged).toBe(true);
      expect(manifests).toHaveLength(2);
      expect(manifests[1]).toEqual(manifests[0]);
      expect(JSON.stringify(manifests)).not.toContain(workspace);
    } finally { clearTimeout(timer); await new Promise<void>(resolve => server.close(() => resolve())); }
  });
});
