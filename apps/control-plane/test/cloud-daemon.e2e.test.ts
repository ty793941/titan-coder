import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { createApp } from '../dist/main.js';
import { DatabaseService } from '../dist/database/database.service.js';
import { DaemonRunner } from '../../daemon/src/daemon-runner.js';

const execute = promisify(execFile);
const fixtures = fileURLToPath(new URL('./fixtures/', import.meta.url));
const digest = (content: string) => `sha256:${createHash('sha256').update(content).digest('hex')}`;
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

async function diskContents(directory: string): Promise<string> {
  let contents = '';
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === '.git') continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) contents += await diskContents(path);
    else if (entry.isFile()) contents += await readFile(path, 'utf8');
  }
  return contents;
}

describe.skipIf(process.env.TITAN_CLOUD_E2E !== '1')('real source daemon to cloud Docker handoff', () => {
  it('persists portable lineage, real tool artifacts and checkpoints, and removes the exited container only after terminal ACK', async () => {
    const image = `titan-session:cloud-e2e-${randomUUID()}`;
    await execute('docker', ['build', '--pull=false', '-f', join(fixtures, 'cloud-session.Dockerfile'), '-t', image, fixtures], { timeout: 60000 });
    const root = await realpath(await mkdtemp(join(tmpdir(), 'titan-cloud-e2e-')));
    const sourceRoot = join(root, 'source');
    const cloudRoot = join(root, 'cloud');
    const snapshotRoot = join(root, 'snapshots');
    const sourceState = join(root, 'source-state');
    const cloudState = join(root, 'cloud-state');
    await mkdir(sourceRoot, { mode: 0o700 });
    await mkdir(cloudRoot, { mode: 0o700 });
    await mkdir(snapshotRoot, { mode: 0o700 });
    await writeFile(join(sourceRoot, 'answer.txt'), 'snapshot roundtrip evidence');
    await execute('git', ['init', '--quiet', sourceRoot]);
    await execute('git', ['-C', sourceRoot, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '--quiet', '--allow-empty', '-m', 'fixture']);
    const previousUrl = process.env.DATABASE_URL;
    const previousToken = process.env.TITAN_CONSOLE_TOKEN;
    const consoleToken = `console-${randomUUID()}`;
    const connectionString = previousUrl ?? 'postgresql://titan@127.0.0.1:55432/titan';
    const admin = new Pool({ connectionString });
    const schema = `cloud_e2e_${randomUUID().replaceAll('-', '')}`;
    await admin.query(`CREATE SCHEMA ${schema}`);
    const databaseUrl = new URL(connectionString);
    databaseUrl.searchParams.set('options', `-c search_path=${schema}`);
    process.env.DATABASE_URL = databaseUrl.toString();
    process.env.TITAN_CONSOLE_TOKEN = consoleToken;
    const app = await createApp();
    if (previousUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousUrl;
    const db = app.get(DatabaseService).db;
    await app.listen(0, '127.0.0.1');
    const base = await app.getUrl();
    const abort = new AbortController();
    const errors: unknown[] = [];
    const protocol: { path: string; body: any; status: number }[] = [];
    const proxyErrors: unknown[] = [];
    let releaseTerminalAck = false;
    let terminalEventId: string | undefined;
    let stoppedBeforeExport = false;
    let sourceOutboxDrained = false;
    const syntheticSecret = `fixture-value-${randomUUID()}`;
    const proxy = createServer(async (incoming, outgoing) => {
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
        const text = Buffer.concat(chunks).toString('utf8');
        const body = text ? JSON.parse(text) : undefined;
        const path = incoming.url!;
        if (path.endsWith('/snapshot')) {
          const pid = Number(await readFile(join(sourceRoot, '.titan/source-pid'), 'utf8'));
          stoppedBeforeExport = !alive(pid);
          const records = (await readFile(join(sourceState, 'outbox.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
          const appended = records.filter(row => row.operation === 'append');
          sourceOutboxDrained = appended.length >= 3 && appended.at(-1).event.progress.type === 'cancelled'
            && appended.every(row => records.some(ack => ack.operation === 'ack' && ack.eventId === row.event.progress.eventId));
        }
        const response = await fetch(`${base}${path}`, {
          method: incoming.method, headers: { 'content-type': 'application/json', ...(incoming.headers.authorization ? { authorization: incoming.headers.authorization } : {}) },
          ...(text ? { body: text } : {}),
        });
        const result = await response.text();
        protocol.push({ path, body, status: response.status });
        if (path.endsWith('/progress') && body.type === 'completed' && response.ok) {
          terminalEventId = body.eventId;
          if (!releaseTerminalAck) { outgoing.writeHead(503); outgoing.end('{}'); return; }
        }
        outgoing.writeHead(response.status, { 'content-type': 'application/json' }); outgoing.end(result);
      } catch (error) { proxyErrors.push(error); outgoing.writeHead(503); outgoing.end('{}'); }
    });
    proxy.listen(0, '127.0.0.1'); await once(proxy, 'listening');
    const address = proxy.address();
    if (!address || typeof address === 'string') throw new Error('PROXY_NOT_LISTENING');
    const proxyBase = `http://127.0.0.1:${address.port}`;
    const common = { baseUrl: proxyBase, pollIntervalMs: 30, heartbeatIntervalMs: 150, requestTimeoutMs: 3000, retryMaxMs: 100, cancelGraceMs: 50, killGraceMs: 100 };
    const source = new DaemonRunner({ ...common, machineName: 'cloud-e2e-source', stateDirectory: sourceState, workspaceRoots: [sourceRoot], handoff: { snapshotRoot }, runnerArgs: [join(fixtures, 'cloud-source.mjs')] });
    const resolved: string[] = [];
    const cloud = new DaemonRunner({ ...common, machineName: 'cloud-e2e-target', stateDirectory: cloudState, workspaceRoots: [cloudRoot], environmentType: 'cloud', cloud: { image, workspaceRoot: cloudRoot, snapshotRoot } }, {
      credentialResolver: async reference => { resolved.push(reference); return reference === 'keychain://fixture' ? syntheticSecret : undefined; },
    });
    const runners = [source, cloud].map(runner => runner.run(abort.signal).catch(error => { errors.push(error); }));
    const until = async <T>(check: () => Promise<T | undefined>, label: string): Promise<T> => {
      const deadline = Date.now() + 20000;
      while (Date.now() < deadline) {
        if (errors.length || proxyErrors.length) throw new Error(`${label}: ${String(errors[0] ?? proxyErrors[0])}`);
        const result = await check();
        if (result) return result;
        await new Promise(resolve => setTimeout(resolve, 30));
      }
      throw new Error(`CLOUD_E2E_TIMEOUT: ${label}`);
    };
    const request = async (path: string, body?: unknown) => {
      const response = await fetch(`${base}/api${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${consoleToken}` }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const data = await response.json();
      if (!response.ok) throw new Error(`${path}: ${response.status}: ${JSON.stringify(data)}`);
      return data;
    };
    let containerId: string | undefined;
    try {
      const sourceDaemon = await until(() => db.selectFrom('daemon').selectAll().where('machine_name', '=', 'cloud-e2e-source').executeTakeFirst(), 'source registration');
      const targetDaemon = await until(() => db.selectFrom('daemon').selectAll().where('machine_name', '=', 'cloud-e2e-target').executeTakeFirst(), 'cloud registration');
      expect(targetDaemon.environment_type).toBe('cloud');
      expect(targetDaemon.capabilities).toContain('secret-lease');
      const task = await request('/projects/project_dev/tasks', { title: 'Docker handoff fixture', goal: 'resume from snapshot', acceptanceCriteria: ['artifact and evidence persisted'], priority: 'high', idempotencyKey: randomUUID() });
      const plan = await request(`/tasks/${task.id}/artifacts`, { type: 'plan', content: '# Approved offline cloud fixture plan' });
      await request(`/artifacts/${plan.artifactId}/approve`, {});
      const session = await request(`/tasks/${task.id}/sessions`, { entryAgent: 'project-manager', goal: 'offline artifact fixture', planHash: plan.checksum, idempotencyKey: randomUUID(), execution: {
        daemonId: sourceDaemon.id, runtime: 'qwen', credentialRef: 'keychain://fixture', workspacePath: sourceRoot, allowedTools: ['artifact.write'], maxTurns: 4, timeoutMs: 20000,
      } });
      const run = await request(`/sessions/${session.id}/runs`, { idempotencyKey: randomUUID() });
      const checkpoint = await until(() => db.selectFrom('checkpoint').selectAll().where('run_id', '=', run.id).executeTakeFirst(), 'source checkpoint');
      await request(`/runs/${run.id}/pause`, {});
      const handoff = await request(`/sessions/${session.id}/handoff`, { checkpointId: checkpoint.id, targetEnvironment: 'cloud', workspaceSync: { mode: 'git-snapshot' }, idempotencyKey: randomUUID() });
      expect(handoff.status).toBe('requested');
      const completed = await until(async () => {
        const row = await db.selectFrom('session_handoff').selectAll().where('id', '=', handoff.id).executeTakeFirstOrThrow();
        if (row.status === 'failed') throw new Error(`HANDOFF_FAILED: ${row.error_code}`);
        return row.status === 'completed' && terminalEventId ? row : undefined;
      }, 'cloud completion');
      expect(stoppedBeforeExport).toBe(true);
      expect(sourceOutboxDrained).toBe(true);
      const snapshotRequest = protocol.find(row => row.path.endsWith('/snapshot'))!;
      expect(snapshotRequest.body.stopped).toBe(true);
      const manifest = snapshotRequest.body.manifest;
      expect(manifest.checksum).toMatch(/^sha256:[a-f0-9]{64}$/);
      expect(digest(await readFile(join(snapshotRoot, `${manifest.snapshotId}.json`), 'utf8'))).toBe(manifest.checksum);
      expect(manifest.fileCount).toBe(1);
      const child = await request(`/sessions/${completed.target_session_id}`);
      expect(child).toMatchObject({ parentSessionId: session.id, environmentType: 'cloud' });
      const childRun = await db.selectFrom('run').selectAll().where('session_id', '=', child.id).executeTakeFirstOrThrow();
      expect(childRun.status).toBe('completed');
      const inherited = await db.selectFrom('checkpoint').selectAll().where('run_id', '=', childRun.id).where('source_checkpoint_id', '=', checkpoint.id).executeTakeFirstOrThrow();
      const cloudCheckpoint = await db.selectFrom('checkpoint').selectAll().where('run_id', '=', childRun.id).where('id', '!=', inherited.id).executeTakeFirstOrThrow();
      expect(cloudCheckpoint.id).not.toBe(checkpoint.id);
      const execution = await db.selectFrom('cloud_execution').selectAll().where('run_id', '=', childRun.id).executeTakeFirstOrThrow();
      containerId = execution.container_id!;
      const inspection = JSON.parse((await execute('docker', ['inspect', containerId])).stdout)[0];
      expect(inspection.State).toMatchObject({ Status: 'exited', ExitCode: 0 });
      expect(inspection.HostConfig).toMatchObject({ ReadonlyRootfs: true, NetworkMode: 'none', CapDrop: ['ALL'] });
      expect(inspection.Config.User).toBe(`${process.getuid!()}:${process.getgid!()}`);
      expect(JSON.stringify(inspection.Config)).not.toContain(syntheticSecret);
      expect((await execute('docker', ['logs', containerId])).stdout).not.toContain(syntheticSecret);
      expect(resolved).toEqual(['keychain://fixture']);
      const artifacts = (await request(`/tasks/${task.id}/artifacts`)).filter((artifact: any) => artifact.sessionId === child.id);
      expect(artifacts.map((artifact: any) => artifact.type).sort()).toEqual(['source-diff', 'test-report']);
      for (const artifact of artifacts) {
        expect(artifact.sourceArtifacts).toContain(plan.artifactId);
        const content = await request(`/artifacts/${artifact.artifactId}/content`);
        expect(digest(content.content)).toBe(artifact.checksum);
        if (artifact.type === 'test-report') expect(JSON.parse(content.content)).toMatchObject({ snapshot: 'snapshot roundtrip evidence', inheritedCheckpointId: inherited.id, argvSafe: true, environmentSafe: true });
        else expect(content.content).toContain('Cloud fixture artifact');
      }
      const tools = await db.selectFrom('tool_call').selectAll().where('run_id', '=', childRun.id).execute();
      expect(tools.filter(tool => tool.status === 'success')).toHaveLength(2);
      const events = await db.selectFrom('event').innerJoin('outbox_event', 'event.event_id', 'outbox_event.event_id').select(['event.event_type', 'event.payload']).where('event.run_id', '=', childRun.id).execute();
      expect(events.map(event => event.event_type)).toEqual(expect.arrayContaining(['container.started', 'container.stopped', 'run.completed']));
      expect(events.filter(event => event.event_type === 'run.completed')).toHaveLength(1);
      expect(JSON.stringify(events)).not.toContain(syntheticSecret);
      const durableProgress = await db.selectFrom('execution_progress').selectAll().where('job_id', '=', (await db.selectFrom('execution_job').select('id').where('run_id', '=', childRun.id).executeTakeFirstOrThrow()).id).execute();
      expect(durableProgress.length).toBeGreaterThan(3);
      expect(new Set(durableProgress.map(event => event.event_id)).size).toBe(durableProgress.length);
      expect((await readdir(join(cloudRoot, child.id, 'session/.titan/checkpoints'))).some(name => name.endsWith('.json'))).toBe(true);
      const disk = await diskContents(root);
      expect(disk).not.toContain(syntheticSecret);
      expect(disk).not.toContain(`"operation":"ack","eventId":"${terminalEventId}"`);
      const active = JSON.parse(await readFile(join(cloudState, 'cloud/active.json'), 'utf8'));
      expect(active.completed).toBe(true);
      const beforeAck = (await readFile(join(cloudState, 'outbox.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
      expect(beforeAck.some(row => row.operation === 'append' && row.event.progress.eventId === terminalEventId)).toBe(true);
      expect(beforeAck.some(row => row.operation === 'ack' && row.eventId === terminalEventId)).toBe(false);
      releaseTerminalAck = true;
      await until(async () => JSON.parse(await readFile(join(cloudState, 'cloud/active.json'), 'utf8')) === null ? true : undefined, 'ACK before container cleanup');
      await expect(execute('docker', ['inspect', containerId])).rejects.toThrow();
      const records = (await readFile(join(cloudState, 'outbox.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
      expect(records.some(row => row.operation === 'ack' && row.eventId === terminalEventId)).toBe(true);
      expect(await readFile(join(cloudRoot, child.id, 'session/answer.txt'), 'utf8')).toBe('snapshot roundtrip evidence');
      expect((await request(`/handoffs/${handoff.id}`)).status).toBe('completed');
      expect(errors).toEqual([]);
      expect(proxyErrors).toEqual([]);
    } finally {
      releaseTerminalAck = true;
      abort.abort(); await Promise.all(runners);
      proxy.closeAllConnections(); await new Promise<void>(resolve => proxy.close(() => resolve()));
      const containers = (await execute('docker', ['ps', '-aq', '--filter', `ancestor=${image}`])).stdout.trim().split('\n').filter(Boolean);
      for (const id of containers) await execute('docker', ['rm', '--force', '--volumes', id]);
      await app.close();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end();
      await execute('docker', ['image', 'rm', image]);
      await rm(root, { recursive: true, force: true });
      if (previousToken === undefined) delete process.env.TITAN_CONSOLE_TOKEN;
      else process.env.TITAN_CONSOLE_TOKEN = previousToken;
    }
  }, 90000);
});
