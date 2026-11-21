import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';
import { beforeAll, afterAll, expect, it } from 'vitest';
import { createApp } from '../dist/main.js';
import { DatabaseService } from '../dist/database/database.service.js';

const originalUrl = process.env.DATABASE_URL;
const connectionString = originalUrl ?? 'postgresql://titan@127.0.0.1:55432/titan';
const admin = new Pool({ connectionString });
const schema = `dispatch_test_${randomUUID().replaceAll('-', '')}`;
let app: Awaited<ReturnType<typeof createApp>>;
let base: string;
let db: DatabaseService['db'];

beforeAll(async () => {
  await admin.query(`CREATE SCHEMA ${schema}`);
  const url = new URL(connectionString);
  url.searchParams.set('options', `-c search_path=${schema}`);
  process.env.DATABASE_URL = url.toString();
  const client = await admin.connect();
  try {
    await client.query(`SET search_path TO ${schema}`);
    for (let pass = 0; pass < 2; pass++) {
      for (const file of ['schema.sql', 'init-data.sql']) await client.query(await readFile(new URL(`../../../database/${file}`, import.meta.url), 'utf8'));
    }
  } finally { client.release(); }
  await start();
}, 15000);

async function start() {
  app = await createApp();
  db = app.get(DatabaseService).db;
  await app.listen(0, '127.0.0.1');
  base = await app.getUrl();
}

afterAll(async () => {
  await app?.close();
  await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  await admin.end();
  if (originalUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalUrl;
});

async function request(path: string, body?: unknown, token?: string, method = body === undefined ? 'GET' : 'POST') {
  const response = await fetch(`${base}/api${path}`, {
    method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: response.status === 204 ? undefined : await response.json() };
}

async function fixture() {
  const daemon = await request('/daemons/register', { machineName: 'dispatch-test', environmentType: 'local', capabilities: ['codex'], workspaceRoots: ['/tmp/titan'], maxConcurrentSessions: 1, daemonVersion: '0.1.0' });
  expect(daemon.status).toBe(201);
  expect(daemon.body.authToken).toEqual(expect.any(String));
  const task = await request('/projects/project_dev/tasks', { title: 'execution', goal: 'execute', acceptanceCriteria: ['done'], priority: 'high', idempotencyKey: randomUUID() });
  const checksum = `sha256:${'a'.repeat(64)}`;
  await db.insertInto('artifact').values({ artifact_id: `artifact_${randomUUID()}`, project_id: 'project_dev', task_id: task.body.id, session_id: null, type: 'plan', version: 1, schema_version: 1, uri: `file:///tmp/plan-${randomUUID()}`, checksum, status: 'approved', source_artifacts: '[]', created_by_type: 'user', created_by_id: 'test', created_at: new Date(), review_state: 'approved', reference: null, metadata: '{}' }).execute();
  const config = { daemonId: daemon.body.daemonId, runtime: 'codex', credentialRef: 'keychain:test', workspacePath: '/tmp/titan/repo', allowedTools: ['workspace.read'], maxTurns: 10, timeoutMs: 60000 };
  const session = await request(`/tasks/${task.body.id}/sessions`, { entryAgent: 'project-manager', goal: 'execute', planHash: checksum, execution: config, idempotencyKey: randomUUID() });
  expect(session.status).toBe(201);
  const run = await request(`/sessions/${session.body.id}/runs`, { idempotencyKey: randomUUID() });
  expect(run.status).toBe(201);
  return { daemon: daemon.body, task: task.body, session: session.body, run: run.body, config, checksum };
}

it('authenticates daemon operations, atomically claims once, deduplicates progress and persists checkpoints across restart', async () => {
  const f = await fixture();
  const path = `/daemons/${f.daemon.daemonId}`;
  const storedDaemon = await db.selectFrom('daemon').select('auth_token_hash').where('id', '=', f.daemon.daemonId).executeTakeFirstOrThrow();
  expect(storedDaemon.auth_token_hash).toMatch(/^[a-f0-9]{64}$/);
  expect(storedDaemon.auth_token_hash).not.toBe(f.daemon.authToken);
  expect((await request(path)).body).not.toHaveProperty('authToken');
  expect((await request(`${path}/heartbeat`, {})).status).toBe(401);
  expect((await request(`${path}/revoke`, {})).status).toBe(401);
  expect((await request(`${path}/events`, {})).status).toBe(401);
  expect((await request(`${path}/events`)).status).toBe(401);
  expect((await request(`${path}/runs/${f.run.id}/progress`, {})).status).toBe(401);
  expect((await request(`${path}/runs/${f.run.id}/job`)).status).toBe(401);
  expect((await request(`${path}/runs/${f.run.id}/control`)).status).toBe(401);
  expect((await request(`${path}/claim`, {})).status).toBe(401);
  expect((await request(`${path}/claim`, {}, 'wrong')).status).toBe(401);
  const claims = await Promise.all([request(`${path}/claim`, {}, f.daemon.authToken), request(`${path}/claim`, {}, f.daemon.authToken)]);
  expect(claims.map(x => x.status).sort()).toEqual([200, 204]);
  const dispatch = claims.find(x => x.status === 200)!.body;
  expect(dispatch).toMatchObject({ runId: f.run.id, sessionId: f.session.id, taskId: f.task.id, projectId: 'project_dev', goal: 'execute', planHash: f.checksum, config: f.config });
  const progressPath = `${path}/runs/${f.run.id}/progress`;
  const extraSession = await request(`/tasks/${f.task.id}/sessions`, { entryAgent: 'project-manager', goal: 'second', planHash: f.checksum, execution: f.config, idempotencyKey: randomUUID() });
  await request(`/sessions/${extraSession.body.id}/runs`, { idempotencyKey: randomUUID() });
  expect((await request(`${path}/claim`, {}, f.daemon.authToken)).status).toBe(204);
  const progress = { eventId: randomUUID(), sequence: 1, claimToken: dispatch.claimToken, type: 'running', payload: {} };
  expect((await request(progressPath, progress, f.daemon.authToken)).body).toEqual({ accepted: true, status: 'running', cancelRequested: false });
  expect((await request(progressPath, progress, f.daemon.authToken)).body.accepted).toBe(false);
  expect((await request(progressPath, { ...progress, eventId: randomUUID() }, f.daemon.authToken)).status).toBe(409);
  expect((await request(progressPath, { ...progress, sequence: 2, claimToken: 'wrong' }, f.daemon.authToken)).status).toBe(403);
  const checkpoint = { id: `checkpoint_${randomUUID()}`, messages: [{ role: 'assistant', text: 'saved' }], successfulTools: [], evidence: [] };
  expect((await request(progressPath, { ...progress, eventId: randomUUID(), sequence: 2, type: 'checkpoint', checkpoint }, f.daemon.authToken)).status).toBe(200);
  const savedEvents = await db.selectFrom('event').innerJoin('outbox_event', 'outbox_event.event_id', 'event.event_id').select(['event.event_type', 'event.payload']).where('run_id', '=', f.run.id).execute();
  expect(savedEvents).toHaveLength(3);
  expect(savedEvents.map(e => e.event_type)).toEqual(expect.arrayContaining(['run.created', 'run.running', 'run.checkpoint']));
  expect(await db.selectFrom('event').select('event_id').where('event_id', '=', progress.eventId).executeTakeFirst()).toEqual({ event_id: progress.eventId });
  expect((await db.selectFrom('checkpoint').selectAll().where('id', '=', checkpoint.id).executeTakeFirst())?.snapshot).toEqual(checkpoint);
  const other = await request(`/tasks/${f.task.id}/sessions`, { entryAgent: 'project-manager', goal: 'other', idempotencyKey: randomUUID() });
  expect((await request(`/sessions/${other.body.id}/runs`, { checkpointId: checkpoint.id, idempotencyKey: randomUUID() })).status).toBe(400);
  expect((await request(`/sessions/${f.session.id}/runs`, { checkpointId: 'absent', idempotencyKey: randomUUID() })).status).toBe(404);
  await app.close();
  await start();
  expect((await request(`${path}/runs/${f.run.id}/control`, undefined, f.daemon.authToken)).body).toEqual({ cancelRequested: false, status: 'running' });
  expect((await request(`/runs/${f.run.id}/cancel`, {})).status).toBe(200);
  expect((await request(progressPath, { ...progress, eventId: randomUUID(), sequence: 3, type: 'completed' }, f.daemon.authToken)).body).toEqual({ accepted: false, status: 'cancelled', cancelRequested: true });
  expect((await request(`/runs/${f.run.id}`)).body.status).toBe('cancelled');
  expect((await request(`${path}/runs/${f.run.id}/control`, undefined, f.daemon.authToken)).body).toEqual({ cancelRequested: true, status: 'cancelled' });
  const retry = await request(`/sessions/${f.session.id}/runs`, { checkpointId: checkpoint.id, idempotencyKey: randomUUID() });
  expect(retry.status).toBe(201);
  const extraRun = await db.selectFrom('run').select('id').where('session_id', '=', extraSession.body.id).executeTakeFirstOrThrow();
  await request(`/runs/${extraRun.id}/cancel`, {});
  await app.close(); await start();
  const recovered = await request(`${path}/claim`, {}, f.daemon.authToken);
  expect(recovered.status).toBe(200);
  expect(recovered.body).toMatchObject({ runId: retry.body.id, checkpoint });
  expect((await request(`${path}/revoke`, {}, f.daemon.authToken)).status).toBe(204);
  expect((await request(`${path}/heartbeat`, {}, f.daemon.authToken)).status).toBe(403);
  expect((await request(`${path}/claim`, {}, f.daemon.authToken)).status).toBe(403);
});

it('rejects stale plans, invalid execution scope and expired daemon claims without failing a run', async () => {
  const f = await fixture();
  const sessionBody = { entryAgent: 'project-manager', goal: 'execute', planHash: f.checksum, execution: f.config, idempotencyKey: randomUUID() };
  expect((await request(`/tasks/${f.task.id}/sessions`, { ...sessionBody, planHash: undefined })).status).toBe(409);
  expect((await request(`/tasks/${f.task.id}/sessions`, { ...sessionBody, execution: { ...f.config, workspacePath: '/tmp/titan-other' } })).status).toBe(403);
  expect((await request(`/tasks/${f.task.id}/sessions`, { ...sessionBody, execution: { ...f.config, runtime: 'qwen' } })).status).toBe(403);
  await db.updateTable('daemon').set({ last_heartbeat_at: new Date(Date.now() - 40000) }).where('id', '=', f.daemon.daemonId).execute();
  expect((await request(`/daemons/${f.daemon.daemonId}`)).body.status).toBe('reconnecting');
  expect((await request(`/daemons/${f.daemon.daemonId}/claim`, {}, f.daemon.authToken)).status).toBe(400);
  await db.updateTable('daemon').set({ last_heartbeat_at: new Date(Date.now() - 100000) }).where('id', '=', f.daemon.daemonId).execute();
  expect((await request(`/daemons/${f.daemon.daemonId}`)).body.status).toBe('disconnected');
  expect((await request(`/runs/${f.run.id}`)).body.status).toBe('queued');
  await db.insertInto('artifact').values({ artifact_id: `artifact_${randomUUID()}`, project_id: 'project_dev', task_id: f.task.id, session_id: null, type: 'plan', version: 2, schema_version: 1, uri: 'file:///tmp/plan2', checksum: `sha256:${'b'.repeat(64)}`, status: 'approved', source_artifacts: '[]', created_by_type: 'user', created_by_id: 'test', created_at: new Date(), review_state: 'approved' }).execute();
  expect((await request(`/tasks/${f.task.id}/sessions`, { ...sessionBody, execution: undefined })).status).toBe(409);
  expect((await request(`/sessions/${f.session.id}/runs`, { idempotencyKey: randomUUID() })).status).toBe(409);
  expect((await request(`/sessions/${f.session.id}/runs`, { planHash: `sha256:${'c'.repeat(64)}`, idempotencyKey: randomUUID() })).status).toBe(409);
});

it('rejects expired leases and cross-daemon access and validates progress strictly', async () => {
  const f = await fixture();
  const d = `/daemons/${f.daemon.daemonId}`;
  const claim = await request(`${d}/claim`, {}, f.daemon.authToken);
  const input = { eventId: randomUUID(), sequence: 1, claimToken: claim.body.claimToken, type: 'running', payload: {} };
  expect((await request(`${d}/runs/${f.run.id}/progress`, { ...input, unexpected: true }, f.daemon.authToken)).status).toBe(400);
  expect((await request(`${d}/runs/${f.run.id}/progress`, { ...input, type: 'checkpoint' }, f.daemon.authToken)).status).toBe(400);
  expect((await request(`${d}/runs/${f.run.id}/progress`, { ...input, type: 'checkpoint', checkpoint: { id: randomUUID(), messages: [], evidence: [], successfulTools: [{ id: 'tool_1', name: 'workspace.read', inputHash: 'hash' }] } }, f.daemon.authToken)).status).toBe(400);
  const other = await fixture();
  expect((await request(`/daemons/${other.daemon.daemonId}/runs/${f.run.id}/progress`, input, other.daemon.authToken)).status).toBe(404);
  expect((await request(`/daemons/${other.daemon.daemonId}/runs/${f.run.id}/control`, undefined, other.daemon.authToken)).status).toBe(404);
  await db.updateTable('execution_job').set({ lease_expires_at: new Date(Date.now() - 1) }).where('run_id', '=', f.run.id).execute();
  expect((await request(`${d}/runs/${f.run.id}/progress`, input, f.daemon.authToken)).status).toBe(403);
  expect((await request(`/runs/${f.run.id}`)).body.status).toBe('queued');
});

it('rejects non-object request bodies and does not allow legacy terminal endpoints to bypass execution progress', async () => {
  const f = await fixture();
  expect((await request(`/sessions/${f.session.id}/runs`, null)).status).toBe(400);
  expect((await request(`/tasks/${f.task.id}/sessions`, null)).status).toBe(400);
  expect((await request(`/runs/${f.run.id}/complete`, {})).status).toBe(403);
  expect((await request(`/runs/${f.run.id}/fail`, { errorCode: 'FORGED' })).status).toBe(403);
  expect((await request(`/runs/${f.run.id}`)).body.status).toBe('queued');
});

it('accepts semantically identical repeated checkpoints and progress payloads regardless of JSON key order', async () => {
  const f = await fixture();
  const d = `/daemons/${f.daemon.daemonId}`;
  const claim = await request(`${d}/claim`, {}, f.daemon.authToken);
  const path = `${d}/runs/${f.run.id}/progress`;
  const cp = { id: `cp_${randomUUID()}`, messages: [], successfulTools: [], evidence: [] };
  const input = { eventId: randomUUID(), sequence: 1, claimToken: claim.body.claimToken, type: 'checkpoint', payload: { a: 1, b: 2 }, checkpoint: cp };
  expect((await request(path, input, f.daemon.authToken)).status).toBe(200);
  expect((await request(path, { ...input, payload: { b: 2, a: 1 } }, f.daemon.authToken)).body.accepted).toBe(false);
  expect((await request(path, { ...input, eventId: randomUUID(), sequence: 2 }, f.daemon.authToken)).status).toBe(200);
});

it('initializes a second cold schema using the application startup scripts', async () => {
  const cold = `cold_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE SCHEMA ${cold}`);
  const previous = process.env.DATABASE_URL;
  const url = new URL(connectionString);
  url.searchParams.set('options', `-c search_path=${cold}`);
  process.env.DATABASE_URL = url.toString();
  let coldApp: Awaited<ReturnType<typeof createApp>> | undefined;
  try {
    coldApp = await createApp();
    const database = coldApp.get(DatabaseService).db;
    expect(await database.selectFrom('task').select('id').where('id', '=', 'task_dev').executeTakeFirst()).toEqual({ id: 'task_dev' });
    expect(await database.selectFrom('execution_job').selectAll().execute()).toEqual([]);
    expect(await database.selectFrom('checkpoint').selectAll().execute()).toEqual([]);
  } finally {
    await coldApp?.close();
    process.env.DATABASE_URL = previous;
    await admin.query(`DROP SCHEMA ${cold} CASCADE`);
  }
});

it('blocks an obsolete queued plan without starving newer valid jobs on the same daemon', async () => {
  const f = await fixture();
  const nextChecksum = `sha256:${'d'.repeat(64)}`;
  await db.insertInto('artifact').values({ artifact_id: `artifact_${randomUUID()}`, project_id: 'project_dev', task_id: f.task.id, session_id: null, type: 'plan', version: 2, schema_version: 1, uri: 'file:///tmp/new-plan', checksum: nextChecksum, status: 'approved', source_artifacts: '[]', created_by_type: 'user', created_by_id: 'test', created_at: new Date(), review_state: 'approved' }).execute();
  const session = await request(`/tasks/${f.task.id}/sessions`, { entryAgent: 'project-manager', goal: 'latest plan', planHash: nextChecksum, execution: f.config, idempotencyKey: randomUUID() });
  expect(session.status).toBe(201);
  const nextRun = await request(`/sessions/${session.body.id}/runs`, { idempotencyKey: randomUUID() });
  expect(nextRun.status).toBe(201);
  const claim = await request(`/daemons/${f.daemon.daemonId}/claim`, {}, f.daemon.authToken);
  expect(claim.status).toBe(200);
  expect(claim.body).toMatchObject({ runId: nextRun.body.id, planHash: nextChecksum });
  expect((await request(`/runs/${f.run.id}`)).body).toMatchObject({ status: 'waiting_input', errorCode: 'PLAN_HASH_STALE' });
  expect((await request(`/daemons/${f.daemon.daemonId}/runs/${f.run.id}/job`, undefined, f.daemon.authToken)).body.status).toBe('blocked');
});

it('expires a lost claim, releases the slot, and requires a manual retry from its checkpoint', async () => {
  const f = await fixture();
  const daemonPath = `/daemons/${f.daemon.daemonId}`;
  const claim = await request(`${daemonPath}/claim`, {}, f.daemon.authToken);
  const checkpoint = { id: `checkpoint_${randomUUID()}`, messages: [], successfulTools: [], evidence: [] };
  const progress = { eventId: randomUUID(), sequence: 1, claimToken: claim.body.claimToken, type: 'checkpoint', payload: {}, checkpoint };
  expect((await request(`${daemonPath}/runs/${f.run.id}/progress`, progress, f.daemon.authToken)).status).toBe(200);
  await db.updateTable('execution_job').set({ lease_expires_at: new Date(Date.now() - 1) }).where('run_id', '=', f.run.id).execute();

  const nextSession = await request(`/tasks/${f.task.id}/sessions`, { entryAgent: 'project-manager', goal: 'manual retry', planHash: f.checksum, execution: f.config, idempotencyKey: randomUUID() });
  const nextRun = await request(`/sessions/${nextSession.body.id}/runs`, { idempotencyKey: randomUUID() });
  const recovered = await request(`${daemonPath}/claim`, {}, f.daemon.authToken);

  expect(recovered.status).toBe(200);
  expect(recovered.body.runId).toBe(nextRun.body.id);
  expect((await request(`/runs/${f.run.id}`)).body).toMatchObject({ status: 'paused', checkpointId: checkpoint.id });
  expect((await request(`${daemonPath}/runs/${f.run.id}/job`, undefined, f.daemon.authToken)).body).toMatchObject({ status: 'blocked' });
  expect((await request(`${daemonPath}/runs/${f.run.id}/progress`, { ...progress, eventId: randomUUID(), sequence: 2, type: 'completed' }, f.daemon.authToken)).status).toBe(403);

  await request(`/runs/${f.run.id}/cancel`, {});
  const retry = await request(`/sessions/${f.session.id}/runs`, { checkpointId: checkpoint.id, idempotencyKey: randomUUID() });
  expect(retry.status).toBe(201);
  expect(retry.body.checkpointId).toBe(checkpoint.id);
});

it('renews an active claim through authenticated control polling only while the daemon is ready', async () => {
  const f = await fixture();
  const daemonPath = `/daemons/${f.daemon.daemonId}`;
  const claim = await request(`${daemonPath}/claim`, {}, f.daemon.authToken);
  await db.updateTable('execution_job').set({ lease_expires_at: new Date(Date.now() + 1000) }).where('run_id', '=', f.run.id).execute();
  const before = await db.selectFrom('execution_job').select('lease_expires_at').where('run_id', '=', f.run.id).executeTakeFirstOrThrow();
  const refreshed = await request(`${daemonPath}/runs/${f.run.id}/control`, undefined, f.daemon.authToken);
  const after = await db.selectFrom('execution_job').select('lease_expires_at').where('run_id', '=', f.run.id).executeTakeFirstOrThrow();
  expect(refreshed.body).toMatchObject({ cancelRequested: false, status: 'queued' });
  expect(after.lease_expires_at?.getTime()).toBeGreaterThan(before.lease_expires_at?.getTime() ?? 0);

  await db.updateTable('daemon').set({ last_heartbeat_at: new Date(Date.now() - 40000) }).where('id', '=', f.daemon.daemonId).execute();
  const beforeStalePoll = await db.selectFrom('execution_job').select('lease_expires_at').where('run_id', '=', f.run.id).executeTakeFirstOrThrow();
  await request(`${daemonPath}/runs/${f.run.id}/control`, undefined, f.daemon.authToken);
  const afterStalePoll = await db.selectFrom('execution_job').select('lease_expires_at').where('run_id', '=', f.run.id).executeTakeFirstOrThrow();
  expect(afterStalePoll.lease_expires_at?.getTime()).toBe(beforeStalePoll.lease_expires_at?.getTime());
  expect(claim.body.claimToken).toEqual(expect.any(String));
});

it('acknowledges a late terminal progress event as cancelled after cancellation without accepting it', async () => {
  const f = await fixture();
  const daemonPath = `/daemons/${f.daemon.daemonId}`;
  const claim = await request(`${daemonPath}/claim`, {}, f.daemon.authToken);
  await request(`/runs/${f.run.id}/cancel`, {});
  await db.updateTable('execution_job').set({ lease_expires_at: new Date(Date.now() - 1) }).where('run_id', '=', f.run.id).execute();
  const late = await request(`${daemonPath}/runs/${f.run.id}/progress`, {
    eventId: randomUUID(), sequence: 1, claimToken: claim.body.claimToken, type: 'completed', payload: { status: 'completed' },
  }, f.daemon.authToken);
  expect(late.body).toEqual({ accepted: false, status: 'cancelled', cancelRequested: true });
});

it('records artifact metadata, tool output audit, and hook or tool executions from progress', async () => {
  const f = await fixture();
  const daemonPath = `/daemons/${f.daemon.daemonId}`;
  const claim = await request(`${daemonPath}/claim`, {}, f.daemon.authToken);
  const artifactUuid = randomUUID();
  const artifactPath = `${f.config.workspacePath}/.titan/artifacts/${artifactUuid}/answer.md`;
  const artifactOutput = {
    kind: 'artifact', reference: `artifact://${artifactUuid}/answer.md`, uri: pathToFileURL(artifactPath).toString(),
    checksum: `sha256:${'e'.repeat(64)}`, artifactType: 'source-diff', output: 'written',
  };
  const checkpoint = {
    id: `checkpoint_${randomUUID()}`, messages: [],
    successfulTools: [{ id: 'artifact-write-1', name: 'artifact.write', inputHash: 'hash', output: artifactOutput }], evidence: [],
  };
  const checkpointProgress = { eventId: randomUUID(), sequence: 1, claimToken: claim.body.claimToken, type: 'checkpoint', payload: {}, checkpoint };
  expect((await request(`${daemonPath}/runs/${f.run.id}/progress`, checkpointProgress, f.daemon.authToken)).status).toBe(200);
  const outputProgress = {
    eventId: randomUUID(), sequence: 2, claimToken: claim.body.claimToken, type: 'output',
    payload: { source: 'tool', status: 'completed', toolName: 'artifact.write', toolCallId: 'artifact-write-1', output: { ...artifactOutput, apiKey: 'must-not-persist', text: 'Bearer secret-token' } },
  };
  expect((await request(`${daemonPath}/runs/${f.run.id}/progress`, outputProgress, f.daemon.authToken)).status).toBe(200);
  expect((await request(`${daemonPath}/runs/${f.run.id}/progress`, {
    eventId: randomUUID(), sequence: 3, claimToken: claim.body.claimToken, type: 'output',
    payload: { source: 'hook', status: 'completed', toolName: 'post-artifact', toolCallId: 'hook-1', output: { result: 'ok' } },
  }, f.daemon.authToken)).status).toBe(200);

  const artifact = await db.selectFrom('artifact').selectAll().where('reference', '=', artifactOutput.reference).executeTakeFirst();
  expect(artifact).toMatchObject({ project_id: 'project_dev', task_id: f.task.id, session_id: f.session.id, type: 'source-diff', uri: artifactOutput.uri, checksum: artifactOutput.checksum, version: 1 });
  expect(artifact?.metadata).toMatchObject({ kind: 'artifact', reference: artifactOutput.reference, output: 'written' });
  expect(await db.selectFrom('tool_call').selectAll().where('run_id', '=', f.run.id).executeTakeFirst()).toMatchObject({ tool_use_id: 'artifact-write-1', tool_name: 'artifact.write', status: 'completed' });
  expect(await db.selectFrom('hook_execution').selectAll().where('run_id', '=', f.run.id).executeTakeFirst()).toMatchObject({ hook_name: 'post-artifact', status: 'completed' });
  const audit = await db.selectFrom('audit_log').selectAll().where('target_id', '=', 'artifact-write-1').executeTakeFirstOrThrow();
  expect(JSON.stringify(audit.payload)).not.toContain('must-not-persist');
  expect(JSON.stringify(audit.payload)).not.toContain('secret-token');
  expect((await db.selectFrom('event').select('event_type').where('run_id', '=', f.run.id).execute()).map(row => row.event_type)).toContain('artifact.created');
  const listed = await request(`/tasks/${f.task.id}/artifacts`);
  expect(listed.body).toEqual(expect.arrayContaining([expect.objectContaining({ reference: artifactOutput.reference, metadata: expect.objectContaining({ artifactType: 'source-diff' }) })]));
});

it('accepts failed progress error code from either payload.errorCode or payload.code', async () => {
  const f = await fixture();
  const daemonPath = `/daemons/${f.daemon.daemonId}`;
  const claim = await request(`${daemonPath}/claim`, {}, f.daemon.authToken);
  expect((await request(`${daemonPath}/runs/${f.run.id}/progress`, {
    eventId: randomUUID(), sequence: 1, claimToken: claim.body.claimToken, type: 'failed', payload: { code: 'RUNTIME_PROVIDER_FAILED' },
  }, f.daemon.authToken)).status).toBe(200);
  expect((await request(`/runs/${f.run.id}`)).body.errorCode).toBe('RUNTIME_PROVIDER_FAILED');
});

it('rejects oversized checkpoint messages before persisting user content', async () => {
  const f = await fixture();
  const daemonPath = `/daemons/${f.daemon.daemonId}`;
  const claim = await request(`${daemonPath}/claim`, {}, f.daemon.authToken);
  const response = await request(`${daemonPath}/runs/${f.run.id}/progress`, {
    eventId: randomUUID(), sequence: 1, claimToken: claim.body.claimToken, type: 'checkpoint', payload: {},
    checkpoint: { id: `checkpoint_${randomUUID()}`, messages: [{ role: 'user', text: 'x'.repeat(1_100_000) }], successfulTools: [], evidence: [] },
  }, f.daemon.authToken);
  expect(response.status).toBe(413);
});
