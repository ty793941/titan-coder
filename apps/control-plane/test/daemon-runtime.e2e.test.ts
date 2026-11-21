import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { createApp } from '../dist/main.js';
import { DatabaseService } from '../dist/database/database.service.js';
import { DaemonRunner } from '../../daemon/dist/daemon-runner.js';

describe('control plane to daemon to runtime', () => {
  it.each(['evidence', 'missing-credential', 'lost-ack'])('executes %s through the real daemon and persists the result', async mode => {
    const previous = process.env.DATABASE_URL;
    const connectionString = previous ?? 'postgresql://titan@127.0.0.1:55432/titan';
    const admin = new Pool({ connectionString });
    const schema = `full_run_${randomUUID().replaceAll('-', '')}`;
    await admin.query(`CREATE SCHEMA ${schema}`);
    const url = new URL(connectionString);
    url.searchParams.set('options', `-c search_path=${schema}`);
    process.env.DATABASE_URL = url.toString();
    const app = await createApp();
    process.env.DATABASE_URL = previous;
    const db = app.get(DatabaseService).db;
    await app.listen(0, '127.0.0.1');
    const base = await app.getUrl();
    let droppedAck = false;
    const proxy = createServer(async (incoming, outgoing) => {
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
        const response = await fetch(`${base}${incoming.url}`, {
          method: incoming.method,
          headers: { 'content-type': 'application/json', ...(incoming.headers.authorization ? { authorization: incoming.headers.authorization } : {}) },
          ...(chunks.length ? { body: Buffer.concat(chunks).toString('utf8') } : {}),
        });
        const text = await response.text();
        if (mode === 'lost-ack' && incoming.url?.endsWith('/progress') && !droppedAck && response.ok) {
          droppedAck = true;
          outgoing.destroy();
          return;
        }
        outgoing.writeHead(response.status, { 'content-type': 'application/json' }); outgoing.end(text);
      } catch { outgoing.writeHead(503); outgoing.end(); }
    });
    proxy.listen(0, '127.0.0.1'); await once(proxy, 'listening');
    const proxyAddress = proxy.address();
    if (!proxyAddress || typeof proxyAddress === 'string') throw new Error('proxy not listening');
    const root = await realpath(await mkdtemp(join(tmpdir(), 'titan-full-run-')));
    const stateDirectory = join(root, 'daemon');
    const abort = new AbortController();
    const options = { baseUrl: `http://127.0.0.1:${proxyAddress.port}`, stateDirectory, workspaceRoots: [root], pollIntervalMs: 30, heartbeatIntervalMs: 100,
      cancelGraceMs: 30, killGraceMs: 50, ...(mode !== 'missing-credential' ? { runnerArgs: [fileURLToPath(new URL('./fixtures/runtime-evidence.mjs', import.meta.url))] } : {}) };
    let runnerError: unknown;
    const running = new DaemonRunner(options).run(abort.signal).catch(error => { runnerError = error; });
    const until = async <T>(check: () => Promise<T | undefined>): Promise<T> => {
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline) {
        if (runnerError) throw runnerError;
        const result = await check();
        if (result) return result;
        await new Promise(resolve => setTimeout(resolve, 30));
      }
      throw new Error('daemon runtime condition timed out');
    };
    const request = async (path: string, body?: unknown) => {
      const response = await fetch(`${base}/api${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const data = await response.json();
      if (!response.ok) throw new Error(`${response.status}: ${JSON.stringify(data)}`);
      return data;
    };
    try {
      const daemon = await until(async () => db.selectFrom('daemon').selectAll().executeTakeFirst());
      const task = await request('/projects/project_dev/tasks', { title: 'cross-process', goal: 'create evidence', acceptanceCriteria: ['artifact exists'], priority: 'high', idempotencyKey: randomUUID() });
      const plan = await request(`/tasks/${task.id}/artifacts`, { type: 'plan', content: '# Approved local plan' });
      await request(`/artifacts/${plan.artifactId}/approve`, {});
      const session = await request(`/tasks/${task.id}/sessions`, { entryAgent: 'project-manager', goal: 'create evidence', planHash: plan.checksum, idempotencyKey: randomUUID(), execution: {
        daemonId: daemon.id, runtime: 'qwen', credentialRef: 'env://TITAN_INTENTIONALLY_MISSING_KEY', workspacePath: root, allowedTools: ['artifact.write'], maxTurns: 3, timeoutMs: 5000,
      } });
      const run = await request(`/sessions/${session.id}/runs`, { idempotencyKey: randomUUID() });
      const expected = mode !== 'missing-credential' ? 'completed' : 'waiting_input';
      const result = await until(async () => {
        const row = await db.selectFrom('run').selectAll().where('id', '=', run.id).executeTakeFirst();
        return row?.status === expected ? row : undefined;
      });
      expect(result.status).toBe(expected);
      const job = await db.selectFrom('execution_job').selectAll().where('run_id', '=', run.id).executeTakeFirstOrThrow();
      expect(job.status).toBe(expected);
      if (mode !== 'missing-credential') {
        expect(await readFile(join(root, '.titan/artifacts/acceptance.md'), 'utf8')).toContain('Local execution evidence');
        expect(await db.selectFrom('checkpoint').select('id').where('run_id', '=', run.id).executeTakeFirst()).toBeDefined();
      }
      if (mode === 'lost-ack') expect(droppedAck).toBe(true);
      const response = await fetch(`${base}/api/runs/${run.id}/events`);
      expect(await response.text()).toContain(`event: run.${expected}`);
    } finally {
      abort.abort(); await running;
      proxy.closeAllConnections(); await new Promise<void>(resolve => proxy.close(() => resolve()));
      await app.close();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end();
      if (previous === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previous;
    }
  }, 15000);
});
