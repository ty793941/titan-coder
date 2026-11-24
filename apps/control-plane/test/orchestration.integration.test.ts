import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { beforeAll, afterAll, expect, it } from 'vitest';
import { sql } from 'kysely';
import { createApp } from '../dist/main.js';
import { DatabaseService } from '../dist/database/database.service.js';

const admin = new Pool({ connectionString: process.env.DATABASE_URL });
const originalUrl = process.env.DATABASE_URL;
const schema = `orchestration_${randomUUID().replaceAll('-', '')}`;
const consoleToken = 'synthetic-console-identity';
const workflowToken = 'synthetic-workflow-identity';
let app: Awaited<ReturnType<typeof createApp>>;
let base: string;
let db: DatabaseService['db'];

beforeAll(async () => {
  await admin.query(`CREATE SCHEMA ${schema}`);
  const url = new URL(originalUrl!);
  url.searchParams.set('options', `-c search_path=${schema}`);
  process.env.DATABASE_URL = url.toString();
  process.env.TITAN_CONSOLE_TOKEN = consoleToken;
  app = await createApp({ workflowIdentity: { workerId: 'worker_test', credentialRef: 'keychain://synthetic-workflow' }, resolveWorkflowCredential: async () => workflowToken });
  db = app.get(DatabaseService).db;
  await app.listen(0, '127.0.0.1'); base = await app.getUrl();
}, 30000);
afterAll(async () => {
  await app?.close(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end();
  if (originalUrl === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = originalUrl;
  delete process.env.TITAN_CONSOLE_TOKEN;
});

async function request(path: string, body?: unknown, token: string | null = consoleToken) {
  const response = await fetch(`${base}/api${path}`, {
    method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: response.status === 204 ? undefined : await response.json() };
}
const internal = (path: string, body?: unknown, token: string | null = workflowToken) => request(`/internal/workflow${path}`, body, token);
const count = async (table: 'run' | 'execution_job' | 'workflow_command' | 'background_job') => Number((await db.selectFrom(table).select(eb => eb.fn.countAll().as('count')).executeTakeFirstOrThrow()).count);

async function fixture() {
  const daemon = await request('/daemons/register', { machineName: 'orchestration', environmentType: 'local', capabilities: ['codex'], workspaceRoots: ['/tmp/titan'], maxConcurrentSessions: 4, daemonVersion: '0.1.0' });
  const task = await request('/projects/project_dev/tasks', { title: 'background', goal: 'execute', acceptanceCriteria: ['done'], priority: 'high', idempotencyKey: randomUUID() });
  const planHash = `sha256:${'a'.repeat(64)}`;
  await db.insertInto('artifact').values({ artifact_id: `artifact_${randomUUID()}`, project_id: 'project_dev', task_id: task.body.id, session_id: null, type: 'plan', version: 1, schema_version: 1, uri: `file:///tmp/plan-${randomUUID()}`, checksum: planHash, status: 'approved', source_artifacts: '[]', created_by_type: 'user', created_by_id: 'test', created_at: new Date(), review_state: 'approved', reference: null, metadata: '{}' }).execute();
  const session = await request(`/tasks/${task.body.id}/sessions`, { entryAgent: 'project-manager', goal: 'execute', planHash, execution: { daemonId: daemon.body.daemonId, runtime: 'codex', credentialRef: 'keychain:test', workspacePath: '/tmp/titan/repo', allowedTools: ['workspace.read'], maxTurns: 10, timeoutMs: 60000 }, idempotencyKey: randomUUID() });
  expect(session.status).toBe(201);
  const jobInput = { kind: 'run', runInBackground: true, planHash, deadlineAt: new Date(Date.now() + 600000).toISOString(), idempotencyKey: randomUUID() };
  const scheduleInput = { planHash, timezone: 'UTC', intervalSeconds: 60, startsAt: new Date(Date.now() - 600000).toISOString(), endsAt: new Date(Date.now() + 3600000).toISOString(), maxRuns: 2, overlapPolicy: 'skip', catchupWindowSeconds: 60, enabled: false, idempotencyKey: randomUUID() };
  return { daemon: daemon.body, task: task.body, session: session.body, planHash, jobInput, scheduleInput };
}

it('creates only pending intent, authenticates both boundaries, and dispatches exactly one Run under concurrency', async () => {
  const f = await fixture(); const path = `/sessions/${f.session.id}/background-jobs`;
  expect((await request(path, f.jobInput, null)).status).toBe(401);
  expect((await request(path, f.jobInput, workflowToken)).status).toBe(401);
  const before = await count('execution_job');
  const created = await request(path, f.jobInput); expect(created.status).toBe(201);
  expect(created.body).toMatchObject({ status: 'pending_dispatch', sessionId: f.session.id, kind: 'run' });
  expect(await count('execution_job')).toBe(before);
  expect((await request(path, f.jobInput)).body.jobId).toBe(created.body.jobId);
  expect((await request(path, { ...f.jobInput, deadlineAt: new Date(Date.now() + 700000).toISOString() })).status).toBe(409);
  const dispatch = `/jobs/${created.body.jobId}/dispatch`;
  expect((await internal(dispatch, {}, consoleToken)).status).toBe(401);
  expect((await internal(dispatch, {}, f.daemon.authToken)).status).toBe(401);
  const replies = await Promise.all([internal(dispatch, {}), internal(dispatch, {})]);
  expect(replies.map(r => r.status)).toEqual([200, 200]);
  expect(replies[0].body.runId).toBe(replies[1].body.runId);
  expect(await count('execution_job')).toBe(before + 1);
  expect(Object.keys(replies[0].body).sort()).toEqual(['deadlineAt', 'jobId', 'runId', 'status']);
  expect((await request(`/sessions/${f.session.id}/background-jobs?limit=1&offset=0`)).body).toHaveLength(1);
  expect((await request(`/sessions/${f.session.id}/background-jobs?limit=101`)).status).toBe(400);
});

it('cancellation and deadlines cannot be bypassed by a late dispatch or race', async () => {
  const f = await fixture();
  const job = (await request(`/sessions/${f.session.id}/background-jobs`, f.jobInput)).body;
  expect((await request(`/background-jobs/${job.jobId}/cancel`, {})).body.status).toBe('cancelled');
  expect((await internal(`/jobs/${job.jobId}/dispatch`, {})).body.status).toBe('cancelled');
  expect((await db.selectFrom('run').select('id').where('session_id', '=', f.session.id).execute())).toEqual([]);
  const next = (await request(`/sessions/${f.session.id}/background-jobs`, { ...f.jobInput, idempotencyKey: randomUUID() })).body;
  await db.updateTable('background_job').set({ deadline_at: new Date(Date.now() - 1) }).where('id', '=', next.jobId).execute();
  expect((await internal(`/jobs/${next.jobId}/dispatch`, {})).body.status).toBe('expired');
  const race = (await request(`/sessions/${f.session.id}/background-jobs`, { ...f.jobInput, idempotencyKey: randomUUID() })).body;
  await Promise.all([internal(`/jobs/${race.jobId}/dispatch`, {}), request(`/background-jobs/${race.jobId}/cancel`, {})]);
  expect((await internal(`/jobs/${race.jobId}`)).body.status).toBe('cancelled');
  const rows = await db.selectFrom('run').selectAll().where('session_id', '=', f.session.id).execute();
  expect(rows.length).toBeLessThanOrEqual(1);
  if (rows[0]) expect(rows[0].status).toBe('cancelled');
});

it('observes only an existing same-Session local or cloud Run without replaying execution or leases', async () => {
  const f = await fixture(); const other = await fixture();
  const run = (await request(`/sessions/${f.session.id}/runs`, { idempotencyKey: randomUUID() })).body;
  const input = { ...f.jobInput, kind: 'observe', runId: run.id };
  expect((await request(`/sessions/${other.session.id}/background-jobs`, { ...input, planHash: other.planHash })).status).toBe(400);
  await db.updateTable('session').set({ environment_type: 'cloud' }).where('id', '=', f.session.id).execute();
  const before = await count('execution_job');
  const created = await request(`/sessions/${f.session.id}/background-jobs`, input); expect(created.status).toBe(201);
  const result = await internal(`/jobs/${created.body.jobId}/dispatch`, {});
  expect(result.body.runId).toBe(run.id); expect(await count('execution_job')).toBe(before);
  expect((await request(`/sessions/${f.session.id}/background-jobs`, { ...f.jobInput, idempotencyKey: randomUUID() })).status).toBe(400);
});

it('rolls back Run, queue and association when an event insert fails', async () => {
  const f = await fixture(); const job = (await request(`/sessions/${f.session.id}/background-jobs`, f.jobInput)).body;
  const before = await count('execution_job');
  await admin.query(`ALTER TABLE ${schema}.event ADD CONSTRAINT reject_run_created CHECK (event_type <> 'run.created') NOT VALID`);
  try { expect((await internal(`/jobs/${job.jobId}/dispatch`, {})).status).toBe(500); }
  finally { await admin.query(`ALTER TABLE ${schema}.event DROP CONSTRAINT reject_run_created`); }
  expect(await count('execution_job')).toBe(before);
  expect((await internal(`/jobs/${job.jobId}`)).body).not.toHaveProperty('runId');
  expect((await internal(`/jobs/${job.jobId}/dispatch`, {})).status).toBe(200);
});

it('uses token hashes, exclusive skip-locked leases, worker identity binding and bounded retries', async () => {
  const f = await fixture(); await request(`/sessions/${f.session.id}/background-jobs`, f.jobInput);
  await db.updateTable('workflow_command').set({ status: 'completed' }).execute();
  const job = (await request(`/sessions/${f.session.id}/background-jobs`, { ...f.jobInput, idempotencyKey: randomUUID() })).body;
  expect((await internal('/commands/claim', { workerId: 'worker_other' })).status).toBe(403);
  const results = await Promise.all([internal('/commands/claim', { workerId: 'worker_test' }), internal('/commands/claim', { workerId: 'worker_test' })]);
  expect(results.map(r => r.status).sort()).toEqual([200, 204]);
  const command = results.find(r => r.status === 200)!.body;
  expect(command).toMatchObject({ kind: 'start_job', targetId: job.jobId });
  const row = await db.selectFrom('workflow_command').selectAll().where('id', '=', command.id).executeTakeFirstOrThrow();
  expect(row.claim_token_hash).not.toBe(command.claimToken); expect(row.claim_token_hash).toMatch(/^[a-f0-9]{64}$/);
  await db.updateTable('workflow_command').set({ lease_expires_at: new Date(Date.now() - 1) }).where('id', '=', command.id).execute();
  expect((await internal(`/commands/${command.id}/complete`, { claimToken: command.claimToken })).status).toBe(409);
  const reclaim = (await internal('/commands/claim', { workerId: 'worker_test' })).body;
  expect(reclaim.id).toBe(command.id); expect(reclaim.claimToken).not.toBe(command.claimToken);
  expect((await internal(`/commands/${command.id}/complete`, { claimToken: command.claimToken })).status).toBe(409);
  expect((await internal(`/commands/${command.id}/retry`, { claimToken: reclaim.claimToken, retryable: true, errorCode: 'WORKFLOW_COMMAND_FAILED' })).status).toBe(204);
  expect((await internal('/commands/claim', { workerId: 'worker_test' })).status).toBe(204);
  await db.updateTable('workflow_command').set({ next_attempt_at: new Date(0), attempts: 9 }).where('id', '=', command.id).execute();
  const last = (await internal('/commands/claim', { workerId: 'worker_test' })).body;
  await internal(`/commands/${last.id}/retry`, { claimToken: last.claimToken, retryable: true, errorCode: 'WORKFLOW_COMMAND_FAILED' });
  expect((await db.selectFrom('workflow_command').select('status').where('id', '=', command.id).executeTakeFirstOrThrow()).status).toBe('failed');
});

it('versions schedules, defers maxRuns to atomic dispatch and does not enqueue occurrence start commands', async () => {
  const f = await fixture(); const created = await request(`/sessions/${f.session.id}/schedules`, f.scheduleInput); expect(created.status).toBe(201);
  const schedule = created.body; expect(schedule).toMatchObject({ enabled: false, version: 1, syncStatus: 'pending_sync', runCount: 0 });
  expect((await request(`/sessions/${f.session.id}/schedules`, f.scheduleInput)).body.id).toBe(schedule.id);
  expect((await request(`/schedules/${schedule.id}/enable`, { expectedVersion: 2 })).status).toBe(409);
  const enabled = (await request(`/schedules/${schedule.id}/enable`, { expectedVersion: 1 })).body; expect(enabled.version).toBe(2);
  const occurrence = { definitionVersion: 2, occurrenceId: 'titan/occurrence/test-1', scheduledAt: new Date().toISOString() };
  const before = await count('workflow_command');
  const result = (await internal(`/schedules/${schedule.id}/occurrences`, occurrence)).body;
  expect(result.status).toBe('created'); expect(await count('workflow_command')).toBe(before);
  expect((await internal(`/schedules/${schedule.id}/occurrences`, occurrence)).body).toEqual(result);
  expect((await request(`/schedules/${schedule.id}`)).body.runCount).toBe(0);
  const dispatched = await Promise.all([internal(`/jobs/${result.jobId}/dispatch`, {}), internal(`/jobs/${result.jobId}/dispatch`, {})]);
  expect(dispatched[0].body.runId).toBe(dispatched[1].body.runId);
  expect((await request(`/schedules/${schedule.id}`)).body.runCount).toBe(1);
  const overlap = (await internal(`/schedules/${schedule.id}/occurrences`, { ...occurrence, occurrenceId: 'titan/occurrence/test-2', scheduledAt: new Date().toISOString() })).body;
  expect(overlap.status).toBe('skipped');
  await request(`/runs/${dispatched[0].body.runId}/cancel`, {});
  const second = (await internal(`/schedules/${schedule.id}/occurrences`, { ...occurrence, occurrenceId: 'titan/occurrence/test-3', scheduledAt: new Date().toISOString() })).body;
  const secondRun = (await internal(`/jobs/${second.jobId}/dispatch`, {})).body;
  expect(secondRun.runId).toBeDefined();
  await request(`/runs/${secondRun.runId}/cancel`, {});
  expect((await internal(`/schedules/${schedule.id}/occurrences`, { ...occurrence, occurrenceId: 'titan/occurrence/test-4', scheduledAt: new Date().toISOString() })).body.status).toBe('skipped');
  expect((await request(`/schedules/${schedule.id}`)).body.runCount).toBe(2);
  expect((await db.selectFrom('background_job').select('workflow_id').where('id', '=', result.jobId).executeTakeFirstOrThrow()).workflow_id).toBe(occurrence.occurrenceId);
});

it('rechecks pause, old definitions, catchup and plan at admission and dispatch', async () => {
  const f = await fixture(); const schedule = (await request(`/sessions/${f.session.id}/schedules`, f.scheduleInput)).body;
  await request(`/schedules/${schedule.id}/enable`, { expectedVersion: 1 });
  const occurrence = { definitionVersion: 2, occurrenceId: 'titan/schedule/pause', scheduledAt: new Date().toISOString() };
  const job = (await internal(`/schedules/${schedule.id}/occurrences`, occurrence)).body;
  await request(`/schedules/${schedule.id}/pause`, { expectedVersion: 2 });
  expect((await internal(`/jobs/${job.jobId}/dispatch`, {})).body.status).toBe('cancelled');
  expect((await internal(`/schedules/${schedule.id}/occurrences`, { ...occurrence, occurrenceId: 'titan/schedule/old' })).body.status).toBe('skipped');
  expect((await request(`/schedules/${schedule.id}/enable`, { expectedVersion: 2 })).status).toBe(409);
  await request(`/schedules/${schedule.id}/enable`, { expectedVersion: 3 });
  const missed = { definitionVersion: 4, occurrenceId: 'titan/schedule/missed', scheduledAt: new Date(Date.now() - 90000).toISOString() };
  expect((await internal(`/schedules/${schedule.id}/occurrences`, missed)).body.status).toBe('skipped');
  const catchup = (await internal(`/schedules/${schedule.id}/occurrences`, { ...missed, occurrenceId: 'titan/schedule/catchup-1', scheduledAt: new Date(Date.now() - 20000).toISOString() })).body;
  expect(catchup.status).toBe('created');
  const another = (await internal(`/schedules/${schedule.id}/occurrences`, { ...missed, occurrenceId: 'titan/schedule/catchup-2', scheduledAt: new Date(Date.now() - 15000).toISOString() })).body;
  expect(another.status).toBe('skipped');
  await db.updateTable('artifact').set({ status: 'draft' }).where('task_id', '=', f.task.id).execute();
  expect((await internal(`/jobs/${catchup.jobId}/dispatch`, {})).body.status).toBe('cancelled');
  expect((await request(`/schedules/${schedule.id}`)).body.enabled).toBe(false);
  expect((await db.selectFrom('event').select('event_type').where('session_id', '=', f.session.id).execute()).map(row => row.event_type)).toContain('schedule.blocked');
});

it('applies the migration twice without creating fake jobs and uses TEXT foreign keys', async () => {
  const client = await admin.connect();
  try {
    await client.query(`SET search_path TO ${schema}`);
    for (let pass = 0; pass < 2; pass++) for (const file of ['schema.sql', 'init-data.sql']) await client.query(await readFile(new URL(`../../../database/${file}`, import.meta.url), 'utf8'));
    const columns = await client.query('SELECT table_name, data_type FROM information_schema.columns WHERE table_schema=$1 AND table_name=ANY($2) AND column_name=$3', [schema, ['background_job', 'workflow_command', 'execution_schedule', 'schedule_occurrence'], 'id']);
    expect(columns.rows).toHaveLength(4); expect(columns.rows.every(row => row.data_type === 'text')).toBe(true);
  } finally { client.release(); }
});

it('does not allow a service credential to reuse an existing daemon identity', async () => {
  const f = await fixture();
  const { WorkflowAuth } = await import('../dist/common/workflow-auth.js');
  const identity = app.get(WorkflowAuth);
  await expect(identity.initialize({ workerId: 'worker_test', credentialRef: 'keychain://mock' }, async () => f.daemon.authToken)).rejects.toThrow('independent');
});

it('revalidates plan and daemon scope before dispatch and never queues a stale plan', async () => {
  const f = await fixture(); const job = (await request(`/sessions/${f.session.id}/background-jobs`, f.jobInput)).body;
  await db.updateTable('daemon').set({ status: 'revoked' }).where('id', '=', f.daemon.daemonId).execute();
  expect((await internal(`/jobs/${job.jobId}/dispatch`, {})).body.code).toBe('DAEMON_UNAVAILABLE');
  expect((await db.selectFrom('run').select('id').where('session_id', '=', f.session.id).execute())).toEqual([]);
  await db.updateTable('daemon').set({ status: 'ready' }).where('id', '=', f.daemon.daemonId).execute();
  await db.updateTable('artifact').set({ status: 'draft' }).where('task_id', '=', f.task.id).execute();
  expect((await internal(`/jobs/${job.jobId}/dispatch`, {})).body).toMatchObject({ status: 'failed', errorCode: 'PLAN_HASH_STALE' });
  expect((await request(`/sessions/${f.session.id}/background-jobs`, { ...f.jobInput, idempotencyKey: randomUUID() })).status).toBe(409);
});

it('only the current definition ACK becomes active and updates require the complete bounded definition', async () => {
  const f = await fixture();
  await db.updateTable('workflow_command').set({ status: 'completed' }).execute();
  const created = (await request(`/sessions/${f.session.id}/schedules`, f.scheduleInput)).body;
  const command = (await internal('/commands/claim', { workerId: 'worker_test' })).body;
  await request(`/schedules/${created.id}/enable`, { expectedVersion: 1 });
  expect((await internal(`/commands/${command.id}/complete`, { claimToken: command.claimToken })).status).toBe(204);
  expect((await request(`/schedules/${created.id}`)).body).toMatchObject({ version: 2, syncStatus: 'pending_sync' });
  const latest = (await internal('/commands/claim', { workerId: 'worker_test' })).body;
  await internal(`/commands/${latest.id}/complete`, { claimToken: latest.claimToken });
  expect((await request(`/schedules/${created.id}`)).body.syncStatus).toBe('active');
  expect((await request(`/schedules/${created.id}/update`, { expectedVersion: 2, maxRuns: 3 })).status).toBe(400);
  const { enabled: _enabled, idempotencyKey: _key, ...definition } = f.scheduleInput;
  const updated = await request(`/schedules/${created.id}/update`, { ...definition, maxRuns: 3, expectedVersion: 2 });
  expect(updated.status).toBe(200); expect(updated.body).toMatchObject({ version: 3, maxRuns: 3, runCount: 0 });
  expect((await request(`/schedules/${created.id}/pause`, { expectedVersion: 2 })).status).toBe(409);
  expect((await internal(`/schedules/${created.id}`)).body).not.toHaveProperty('execution');
});

it('atomically consumes the final run slot at dispatch and supersedes a pending old definition', async () => {
  const f = await fixture();
  const schedule = (await request(`/sessions/${f.session.id}/schedules`, { ...f.scheduleInput, maxRuns: 1 })).body;
  await request(`/schedules/${schedule.id}/enable`, { expectedVersion: 1 });
  const at = Date.now() - 100;
  const jobs = await Promise.all([0, 1].map(index => internal(`/schedules/${schedule.id}/occurrences`, { definitionVersion: 2, occurrenceId: `titan/race/${randomUUID()}`, scheduledAt: new Date(at + index).toISOString() })));
  expect(jobs.every(reply => reply.body.status === 'created')).toBe(true);
  const dispatched = await Promise.all(jobs.map(reply => internal(`/jobs/${reply.body.jobId}/dispatch`, {})));
  expect(dispatched.filter(reply => reply.body.runId)).toHaveLength(1);
  expect((await request(`/schedules/${schedule.id}`)).body.runCount).toBe(1);
  const runId = dispatched.find(reply => reply.body.runId)!.body.runId;
  await request(`/runs/${runId}/cancel`, {});
  expect((await internal(`/jobs/${jobs[1]!.body.jobId}/dispatch`, {})).body.runId ?? runId).toBe(runId);
  const g = await fixture(); const oldSchedule = (await request(`/sessions/${g.session.id}/schedules`, g.scheduleInput)).body;
  await request(`/schedules/${oldSchedule.id}/enable`, { expectedVersion: 1 });
  const occurrence = { definitionVersion: 2, occurrenceId: `titan/old/${randomUUID()}`, scheduledAt: new Date().toISOString() };
  const oldJob = (await internal(`/schedules/${oldSchedule.id}/occurrences`, occurrence)).body;
  const { enabled: _enabled, idempotencyKey: _key, ...definition } = g.scheduleInput;
  await request(`/schedules/${oldSchedule.id}/update`, { ...definition, expectedVersion: 2 });
  expect((await internal(`/jobs/${oldJob.jobId}/dispatch`, {})).body).toMatchObject({ status: 'cancelled', errorCode: 'SCHEDULE_DEFINITION_SUPERSEDED' });
  expect((await internal(`/schedules/${oldSchedule.id}/occurrences`, { ...occurrence, scheduledAt: new Date(Date.now() - 1).toISOString() })).status).toBe(409);
});

it('rejects internal and management payload expansion and premature expiration', async () => {
  const f = await fixture(); const job = (await request(`/sessions/${f.session.id}/background-jobs`, f.jobInput)).body;
  expect((await internal(`/jobs/${job.jobId}/cancel`, { reason: 'expired' })).status).toBe(400);
  expect((await internal(`/jobs/${job.jobId}/dispatch`, { apiKey: 'synthetic' })).status).toBe(400);
  expect((await request(`/background-jobs/${job.jobId}/cancel`, { reason: 'expired' })).status).toBe(400);
  expect((await internal('/commands/claim', { workerId: 'worker_test', leaseMs: 999999 })).status).toBe(400);
  expect((await request(`/sessions/${f.session.id}/schedules`, { ...f.scheduleInput, enabled: true })).status).toBe(400);
  for (const path of [`/background-jobs/${job.jobId}`, `/sessions/${f.session.id}/background-jobs`, `/sessions/${f.session.id}/schedules`]) expect((await request(path, undefined, null)).status).toBe(401);
  for (const path of [`/jobs/${job.jobId}`, '/schedules/missing']) expect((await internal(path, undefined, null)).status).toBe(401);
});

it('does not invert daemon progress locks when cancellation races a terminal report', async () => {
  const f = await fixture(); const job = (await request(`/sessions/${f.session.id}/background-jobs`, f.jobInput)).body;
  const run = (await internal(`/jobs/${job.jobId}/dispatch`, {})).body;
  let cancellation: ReturnType<typeof request> | undefined;
  await db.transaction().execute(async trx => {
    await trx.selectFrom('execution_job').select('id').where('run_id', '=', run.runId).forUpdate().execute();
    await trx.selectFrom('run').select('id').where('id', '=', run.runId).forUpdate().execute();
    cancellation = request(`/background-jobs/${job.jobId}/cancel`, {});
    await sql`select pg_sleep(0.1)`.execute(trx);
    await trx.updateTable('session').set({ status: 'running' }).where('id', '=', f.session.id).execute();
  });
  expect((await cancellation!).status).toBe(200);
  expect((await internal(`/jobs/${job.jobId}`)).body.status).toBe('cancelled');
});

it('keeps schedules enabled across transient daemon disconnection', async () => {
  const f = await fixture(); const schedule = (await request(`/sessions/${f.session.id}/schedules`, f.scheduleInput)).body;
  await request(`/schedules/${schedule.id}/enable`, { expectedVersion: 1 });
  await db.updateTable('daemon').set({ last_heartbeat_at: new Date(Date.now() - 40000) }).where('id', '=', f.daemon.daemonId).execute();
  const occurrence = { definitionVersion: 2, occurrenceId: `titan/disconnect/${randomUUID()}`, scheduledAt: new Date().toISOString() };
  expect((await internal(`/schedules/${schedule.id}/occurrences`, occurrence)).body.status).toBe('skipped');
  expect((await request(`/schedules/${schedule.id}`)).body).toMatchObject({ enabled: true, version: 2 });
  await db.updateTable('daemon').set({ last_heartbeat_at: new Date() }).where('id', '=', f.daemon.daemonId).execute();
  expect((await internal(`/schedules/${schedule.id}/occurrences`, { ...occurrence, occurrenceId: `titan/recovered/${randomUUID()}`, scheduledAt: new Date().toISOString() })).body.status).toBe('created');
});

it('records workflow cancellation as the authenticated system identity', async () => {
  const f = await fixture(); const job = (await request(`/sessions/${f.session.id}/background-jobs`, f.jobInput)).body;
  const run = (await internal(`/jobs/${job.jobId}/dispatch`, {})).body;
  await internal(`/jobs/${job.jobId}/cancel`, { reason: 'cancelled' });
  const event = await db.selectFrom('event').select(['actor_type', 'actor_id']).where('run_id', '=', run.runId).where('event_type', '=', 'run.cancelled').executeTakeFirstOrThrow();
  expect(event).toEqual({ actor_type: 'system', actor_id: 'worker_test' });
});

it('keeps pause compatible with daemon job then run locking', async () => {
  const f = await fixture(); const job = (await request(`/sessions/${f.session.id}/background-jobs`, f.jobInput)).body;
  const run = (await internal(`/jobs/${job.jobId}/dispatch`, {})).body;
  let pause: ReturnType<typeof request> | undefined;
  await db.transaction().execute(async trx => {
    await trx.selectFrom('execution_job').select('id').where('run_id', '=', run.runId).forUpdate().execute();
    pause = request(`/runs/${run.runId}/pause`, {});
    await sql`select pg_sleep(0.1)`.execute(trx);
    await trx.selectFrom('run').select('id').where('id', '=', run.runId).forUpdate().execute();
  });
  expect((await pause!).status).toBe(200);
  expect((await internal(`/jobs/${job.jobId}`)).body.status).toBe('waiting_input');
});

it('does not invert source execution locks during handoff snapshot validation', async () => {
  const f = await fixture(); const job = (await request(`/sessions/${f.session.id}/background-jobs`, f.jobInput)).body;
  const run = (await internal(`/jobs/${job.jobId}/dispatch`, {})).body;
  const checkpointId = `checkpoint_${randomUUID()}`;
  await db.insertInto('checkpoint').values({ id: checkpointId, run_id: run.runId, sequence: 1, snapshot: JSON.stringify({ id: checkpointId, messages: [], evidence: [], successfulTools: [] }) }).execute();
  await db.updateTable('run').set({ status: 'paused', checkpoint_id: checkpointId }).where('id', '=', run.runId).execute();
  await db.updateTable('session').set({ status: 'paused' }).where('id', '=', f.session.id).execute();
  const handoff = await request(`/sessions/${f.session.id}/handoff`, { checkpointId, targetEnvironment: 'cloud', workspaceSync: { mode: 'git-snapshot' }, idempotencyKey: randomUUID() });
  expect(handoff.status).toBe(201);
  let snapshot: ReturnType<typeof request> | undefined;
  await db.transaction().execute(async trx => {
    await trx.selectFrom('execution_job').select('id').where('run_id', '=', run.runId).forUpdate().execute();
    await trx.selectFrom('run').select('id').where('id', '=', run.runId).forUpdate().execute();
    snapshot = request(`/daemons/${f.daemon.daemonId}/handoffs/${handoff.body.id}/snapshot`, { stopped: true, manifest: { schemaVersion: 1, snapshotId: randomUUID(), baseRevision: 'a'.repeat(40), checksum: `sha256:${'c'.repeat(64)}`, fileCount: 1, totalBytes: 1 } }, f.daemon.authToken);
    await sql`select pg_sleep(0.1)`.execute(trx);
    await trx.updateTable('session').set({ status: 'paused' }).where('id', '=', f.session.id).execute();
  });
  expect((await snapshot!).status).toBe(409);
});

it('serializes manual resume with existing-run control before locking the session', async () => {
  const f = await fixture(); const job = (await request(`/sessions/${f.session.id}/background-jobs`, f.jobInput)).body;
  const run = (await internal(`/jobs/${job.jobId}/dispatch`, {})).body;
  await request(`/runs/${run.runId}/pause`, {});
  let resume: ReturnType<typeof request> | undefined;
  await db.transaction().execute(async trx => {
    await trx.selectFrom('execution_job').select('id').where('run_id', '=', run.runId).forUpdate().execute();
    await trx.selectFrom('run').select('id').where('id', '=', run.runId).forUpdate().execute();
    resume = request(`/runs/${run.runId}/resume`, { idempotencyKey: randomUUID() });
    await sql`select pg_sleep(0.1)`.execute(trx);
    await trx.updateTable('session').set({ status: 'paused' }).where('id', '=', f.session.id).execute();
  });
  expect((await resume!).status).toBe(201);
  expect((await internal(`/jobs/${job.jobId}`)).body).toMatchObject({ runId: run.runId, status: 'waiting_input' });
  expect((await internal(`/jobs/${job.jobId}/cancel`, { reason: 'cancelled' })).body.status).toBe('cancelled');
  expect((await request(`/sessions/${f.session.id}`)).body.status).toBe('queued');
  expect((await request(`/runs/${(await resume!).body.id}`)).body.status).toBe('queued');
});
