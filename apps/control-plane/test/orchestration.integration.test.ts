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
const bindings = new Map<string, Promise<unknown>>();
const internal = async (path: string, body?: unknown, token: string | null = workflowToken) => {
  const match = /^\/(jobs|schedules)\/([^/]+)/.exec(path);
  if (token === workflowToken && match) {
    const table = match[1] === 'jobs' ? 'background_job' : 'execution_schedule';
    const target = await db.selectFrom(table).select('worker_id').where('id', '=', match[2]!).executeTakeFirst();
    if (target && !target.worker_id) {
      const targetId = match[2]!;
      if (!bindings.has(targetId)) bindings.set(targetId, claimTarget(targetId));
      try { await bindings.get(targetId); } finally { bindings.delete(targetId); }
    }
  }
  return request(`/internal/workflow${path}`, body, token);
};
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
  await claimTarget(race.jobId);
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
    const bindings = await client.query('SELECT table_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema=$1 AND table_name=ANY($2) AND column_name=$3', [schema, ['background_job', 'execution_schedule'], 'worker_id']);
    expect(bindings.rows).toHaveLength(2);
    expect(bindings.rows.every(row => row.data_type === 'text' && row.is_nullable === 'YES')).toBe(true);
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
  expect((await internal(`/schedules/${schedule.id}/occurrences`, occurrence)).body).toMatchObject({ code: 'DAEMON_UNAVAILABLE', retryable: true });
  expect((await request(`/schedules/${schedule.id}`)).body).toMatchObject({ enabled: true, version: 2 });
  await db.updateTable('daemon').set({ last_heartbeat_at: new Date() }).where('id', '=', f.daemon.daemonId).execute();
  const recovered = await internal(`/schedules/${schedule.id}/occurrences`, occurrence);
  expect(recovered.body.status).toBe('created');
  await db.updateTable('daemon').set({ last_heartbeat_at: new Date(Date.now() - 40000) }).where('id', '=', f.daemon.daemonId).execute();
  expect((await internal(`/jobs/${recovered.body.jobId}/dispatch`, {})).body).toMatchObject({ code: 'DAEMON_UNAVAILABLE', retryable: true });
  expect((await internal(`/jobs/${recovered.body.jobId}`)).body.status).toBe('pending_dispatch');
  expect((await request(`/schedules/${schedule.id}`)).body).toMatchObject({ enabled: true, version: 2, runCount: 0 });
  await db.updateTable('daemon').set({ last_heartbeat_at: new Date() }).where('id', '=', f.daemon.daemonId).execute();
  const dispatched = await internal(`/jobs/${recovered.body.jobId}/dispatch`, {});
  expect(dispatched.body.runId).toBeDefined();
  expect((await request(`/schedules/${schedule.id}`)).body.runCount).toBe(1);
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

it('replays only a completed ACK from the same worker and claim generation without resyncing', async () => {
  const f = await fixture();
  await db.updateTable('workflow_command').set({ status: 'completed' }).execute();
  const schedule = (await request(`/sessions/${f.session.id}/schedules`, f.scheduleInput)).body;
  const firstClaim = (await internal('/commands/claim', { workerId: 'worker_test' })).body;
  await db.updateTable('workflow_command').set({ lease_expires_at: new Date(Date.now() - 1) }).where('id', '=', firstClaim.id).execute();
  const currentClaim = (await internal('/commands/claim', { workerId: 'worker_test' })).body;
  const path = `/commands/${currentClaim.id}/complete`;
  const body = { claimToken: currentClaim.claimToken };
  expect((await internal(path, body)).status).toBe(204);
  const completed = await db.selectFrom('workflow_command').selectAll().where('id', '=', currentClaim.id).executeTakeFirstOrThrow();
  expect(completed).toMatchObject({ status: 'completed', lease_expires_at: null, worker_id: 'worker_test', attempts: 2 });
  await db.updateTable('execution_schedule').set({ sync_status: 'pending_sync' }).where('id', '=', schedule.id).execute();
  const replies = await Promise.all([internal(path, body), internal(path, body)]);
  expect(replies.map(reply => reply.status)).toEqual([204, 204]);
  expect(completed.claim_token_hash).toMatch(/^[a-f0-9]{64}$/);
  expect(completed.claim_token_hash).not.toBe(body.claimToken);
  expect(await db.selectFrom('workflow_command').selectAll().where('id', '=', currentClaim.id).executeTakeFirstOrThrow()).toEqual(completed);
  expect((await request(`/schedules/${schedule.id}`)).body.syncStatus).toBe('pending_sync');
  expect((await internal(path, { claimToken: firstClaim.claimToken })).status).toBe(409);
  expect((await internal(path, { claimToken: 'b'.repeat(64) })).status).toBe(409);
  expect((await internal(`/commands/${currentClaim.id}/retry`, { ...body, retryable: true, errorCode: 'WORKFLOW_COMMAND_FAILED' })).status).toBe(409);
  const { WorkflowCommandsService } = await import('../dist/modules/orchestration/workflow-commands.service.js');
  await expect(app.get(WorkflowCommandsService).acknowledge(currentClaim.id, body.claimToken, 'worker_other')).rejects.toThrow('WORKFLOW_COMMAND_LEASE_EXPIRED');
});

it('returns authenticated execution metadata for ordinary and occurrence workflows with resolved ownership', async () => {
  const f = await fixture();
  const job = (await request(`/sessions/${f.session.id}/background-jobs`, f.jobInput)).body;
  const path = `/jobs/${job.jobId}/execution`;
  for (const token of [null, consoleToken, f.daemon.authToken]) expect((await internal(path, undefined, token)).status).toBe(401);
  expect((await internal(path)).body).toEqual({ jobId: job.jobId, workflowId: `titan/background/${job.jobId}/v1`, workflowVersion: 1 });
  expect((await internal('/jobs/missing/execution')).status).toBe(404);
  expect((await internal(`/jobs/${job.jobId}`)).body).not.toHaveProperty('workflowId');
  const schedule = (await request(`/sessions/${f.session.id}/schedules`, f.scheduleInput)).body;
  await request(`/schedules/${schedule.id}/enable`, { expectedVersion: 1 });
  const occurrence = { definitionVersion: 2, occurrenceId: `titan/occurrence/${randomUUID()}`, scheduledAt: new Date().toISOString() };
  const scheduled = (await internal(`/schedules/${schedule.id}/occurrences`, occurrence)).body;
  expect((await internal(`/jobs/${scheduled.jobId}/execution`)).body).toEqual({ jobId: scheduled.jobId, workflowId: occurrence.occurrenceId, workflowVersion: 1 });
  await db.updateTable('schedule_occurrence').set({ occurrence_id: `titan/other/${randomUUID()}` }).where('job_id', '=', scheduled.jobId).execute();
  expect((await internal(`/jobs/${scheduled.jobId}/execution`)).status).toBe(404);
  const other = await fixture();
  await db.updateTable('background_job').set({ task_id: other.task.id }).where('id', '=', job.jobId).execute();
  expect((await internal(path)).status).toBe(404);
});

it('coalesces obsolete pending schedule commands and claims only the latest definition', async () => {
  const f = await fixture();
  await db.updateTable('workflow_command').set({ status: 'completed' }).execute();
  const schedule = (await request(`/sessions/${f.session.id}/schedules`, f.scheduleInput)).body;
  await request(`/schedules/${schedule.id}/enable`, { expectedVersion: 1 });
  await request(`/schedules/${schedule.id}/pause`, { expectedVersion: 2 });
  const claim = await internal('/commands/claim', { workerId: 'worker_test' });
  expect(claim.body).toMatchObject({ kind: 'sync_schedule', targetId: schedule.id, definitionVersion: 3 });
  const obsolete = await db.selectFrom('workflow_command').select(['status', 'error_code']).where('target_id', '=', schedule.id).where('definition_version', '<', 3).execute();
  expect(obsolete).toEqual([{ status: 'completed', error_code: 'SCHEDULE_DEFINITION_SUPERSEDED' }, { status: 'completed', error_code: 'SCHEDULE_DEFINITION_SUPERSEDED' }]);
  expect((await request(`/schedules/${schedule.id}`)).body.syncStatus).toBe('pending_sync');
});

it('serializes a schedule across dispatchers until ACK or lease expiry without starving other schedules', async () => {
  const f = await fixture();
  await db.updateTable('workflow_command').set({ status: 'completed' }).execute();
  const schedule = (await request(`/sessions/${f.session.id}/schedules`, f.scheduleInput)).body;
  const old = (await internal('/commands/claim', { workerId: 'worker_test' })).body;
  expect(old.definitionVersion).toBe(1);
  await request(`/schedules/${schedule.id}/enable`, { expectedVersion: 1 });
  expect((await internal('/commands/claim', { workerId: 'worker_test' })).status).toBe(204);
  const g = await fixture();
  const other = (await request(`/sessions/${g.session.id}/schedules`, g.scheduleInput)).body;
  const independent = (await internal('/commands/claim', { workerId: 'worker_test' })).body;
  expect(independent.targetId).toBe(other.id);
  await internal(`/commands/${independent.id}/complete`, { claimToken: independent.claimToken });
  expect((await internal(`/commands/${old.id}/complete`, { claimToken: old.claimToken })).status).toBe(204);
  expect((await request(`/schedules/${schedule.id}`)).body.syncStatus).toBe('pending_sync');
  const claims = await Promise.all([internal('/commands/claim', { workerId: 'worker_test' }), internal('/commands/claim', { workerId: 'worker_test' })]);
  expect(claims.map(reply => reply.status).sort()).toEqual([200, 204]);
  const current = claims.find(reply => reply.status === 200)!.body;
  expect(current).toMatchObject({ targetId: schedule.id, definitionVersion: 2 });
  await request(`/schedules/${schedule.id}/pause`, { expectedVersion: 2 });
  await db.updateTable('workflow_command').set({ lease_expires_at: new Date(Date.now() - 1) }).where('id', '=', current.id).execute();
  const recovered = (await internal('/commands/claim', { workerId: 'worker_test' })).body;
  expect(recovered).toMatchObject({ targetId: schedule.id, definitionVersion: 3 });
  expect((await internal(`/commands/${current.id}/complete`, { claimToken: current.claimToken })).status).toBe(409);
  expect((await request(`/schedules/${schedule.id}`)).body.syncStatus).toBe('pending_sync');
  await internal(`/commands/${recovered.id}/complete`, { claimToken: recovered.claimToken });
  expect((await request(`/schedules/${schedule.id}`)).body.syncStatus).toBe('paused');
});

it.each(['obsolete', 'exhausted'])('skips locked %s cleanup rows instead of blocking command claims', async mode => {
  const f = await fixture();
  await db.updateTable('workflow_command').set({ status: 'completed' }).execute();
  const schedule = (await request(`/sessions/${f.session.id}/schedules`, f.scheduleInput)).body;
  const command = await db.selectFrom('workflow_command').select('id').where('target_id', '=', schedule.id).executeTakeFirstOrThrow();
  if (mode === 'obsolete') await request(`/schedules/${schedule.id}/enable`, { expectedVersion: 1 });
  else await db.updateTable('workflow_command').set({ status: 'claimed', attempts: 10, lease_expires_at: new Date(Date.now() - 1) }).where('id', '=', command.id).execute();
  await request(`/sessions/${f.session.id}/background-jobs`, f.jobInput);
  let claim: ReturnType<typeof internal> | undefined;
  let settled = false;
  let returnedWhileLocked = false;
  await db.transaction().execute(async trx => {
    await trx.selectFrom('workflow_command').select('id').where('id', '=', command.id).forUpdate().execute();
    claim = internal('/commands/claim', { workerId: 'worker_test' });
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([claim.then(() => { settled = true; }), new Promise<void>(resolve => { timer = setTimeout(resolve, 300); })]);
    returnedWhileLocked = settled;
    clearTimeout(timer);
  });
  expect((await claim!).status).toBe(200);
  expect(returnedWhileLocked).toBe(true);
});

const rawInternal = (path: string, body?: unknown) => request(`/internal/workflow${path}`, body, workflowToken);

async function claimTarget(targetId: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const reply = await rawInternal('/commands/claim', { workerId: 'worker_test' });
    expect(reply.status).toBe(200);
    if (reply.body.targetId === targetId) return reply.body;
    await rawInternal(`/commands/${reply.body.id}/complete`, { claimToken: reply.body.claimToken });
  }
  throw new Error('target command was not claimable');
}

it('denies unclaimed and different-worker jobs before any refresh or execution side effect', async () => {
  const f = await fixture();
  const job = (await request(`/sessions/${f.session.id}/background-jobs`, f.jobInput)).body;
  await db.updateTable('background_job').set({ deadline_at: new Date(Date.now() - 1) }).where('id', '=', job.jobId).execute();
  const before = await db.selectFrom('background_job').selectAll().where('id', '=', job.jobId).executeTakeFirstOrThrow();
  const events = await db.selectFrom('event').selectAll().where('session_id', '=', f.session.id).execute();
  for (const [suffix, body] of [['', undefined], ['/execution', undefined], ['/dispatch', {}], ['/cancel', { reason: 'cancelled' }], ['/fail', { errorCode: 'WORKFLOW_COMMAND_FAILED' }]] as const) {
    expect((await rawInternal(`/jobs/${job.jobId}${suffix}`, body)).status).toBe(403);
  }
  expect(await db.selectFrom('background_job').selectAll().where('id', '=', job.jobId).executeTakeFirstOrThrow()).toEqual(before);
  expect(await db.selectFrom('event').selectAll().where('session_id', '=', f.session.id).execute()).toEqual(events);
  await claimTarget(job.jobId);
  const { WorkflowAuth } = await import('../dist/common/workflow-auth.js');
  const auth = app.get(WorkflowAuth);
  await auth.initialize({ workerId: 'worker_other', credentialRef: 'keychain://synthetic-workflow' }, async () => workflowToken);
  try {
    for (const [suffix, body] of [['', undefined], ['/execution', undefined], ['/dispatch', {}], ['/cancel', { reason: 'cancelled' }], ['/fail', { errorCode: 'WORKFLOW_COMMAND_FAILED' }]] as const) {
      expect((await rawInternal(`/jobs/${job.jobId}${suffix}`, body)).status).toBe(403);
    }
    expect(await db.selectFrom('background_job').selectAll().where('id', '=', job.jobId).executeTakeFirstOrThrow()).toMatchObject({ status: 'pending_dispatch', cancel_requested: false, worker_id: 'worker_test' });
    expect((await request(`/background-jobs/${job.jobId}`)).status).toBe(200);
  } finally { await auth.initialize({ workerId: 'worker_test', credentialRef: 'keychain://synthetic-workflow' }, async () => workflowToken); }
});

it('binds schedules at claim and inherits identity for occurrence jobs across credential restart', async () => {
  const f = await fixture();
  const schedule = (await request(`/sessions/${f.session.id}/schedules`, f.scheduleInput)).body;
  await request(`/schedules/${schedule.id}/enable`, { expectedVersion: 1 });
  const occurrence = { definitionVersion: 2, occurrenceId: `titan/binding/${randomUUID()}`, scheduledAt: new Date().toISOString() };
  expect((await rawInternal(`/schedules/${schedule.id}`)).status).toBe(403);
  expect((await rawInternal(`/schedules/${schedule.id}/occurrences`, occurrence)).status).toBe(403);
  expect(await db.selectFrom('schedule_occurrence').selectAll().where('schedule_id', '=', schedule.id).execute()).toEqual([]);
  const command = await claimTarget(schedule.id);
  await rawInternal(`/commands/${command.id}/complete`, { claimToken: command.claimToken });
  expect((await db.selectFrom('execution_schedule').selectAll().where('id', '=', schedule.id).executeTakeFirstOrThrow())).toMatchObject({ worker_id: 'worker_test' });
  const { WorkflowAuth } = await import('../dist/common/workflow-auth.js');
  const auth = app.get(WorkflowAuth);
  await auth.initialize({ workerId: 'worker_other', credentialRef: 'keychain://synthetic-workflow' }, async () => workflowToken);
  try {
    expect((await rawInternal(`/schedules/${schedule.id}`)).status).toBe(403);
    expect((await rawInternal(`/schedules/${schedule.id}/occurrences`, occurrence)).status).toBe(403);
  } finally { await auth.initialize({ workerId: 'worker_test', credentialRef: 'keychain://synthetic-workflow' }, async () => workflowToken); }
  const job = (await rawInternal(`/schedules/${schedule.id}/occurrences`, occurrence)).body;
  expect(job.status).toBe('created');
  expect(await db.selectFrom('background_job').selectAll().where('id', '=', job.jobId).executeTakeFirstOrThrow()).toMatchObject({ worker_id: 'worker_test' });
  expect((await rawInternal(`/jobs/${job.jobId}/dispatch`, {})).status).toBe(200);
  expect((await rawInternal(`/jobs/${job.jobId}`)).body).toMatchObject({ jobId: job.jobId, status: 'dispatching' });
});

it('expires undispatched jobs on GET with durable cancellation intent without Temporal', async () => {
  const f = await fixture();
  const job = (await request(`/sessions/${f.session.id}/background-jobs`, f.jobInput)).body;
  await db.updateTable('background_job').set({ deadline_at: new Date(Date.now() - 1) }).where('id', '=', job.jobId).execute();
  const first = await request(`/background-jobs/${job.jobId}`);
  expect(first.body).toMatchObject({ status: 'expired', cancelRequested: true, errorCode: 'BACKGROUND_JOB_EXPIRED' });
  expect((await request(`/background-jobs/${job.jobId}`)).body).toEqual(first.body);
  expect(await db.selectFrom('workflow_command').selectAll().where('target_id', '=', job.jobId).where('kind', '=', 'cancel_job').execute()).toHaveLength(1);
  expect(await db.selectFrom('event').selectAll().where('session_id', '=', f.session.id).where('event_type', '=', 'background_job.cancel_requested').execute()).toHaveLength(1);
  expect(await db.selectFrom('run').selectAll().where('session_id', '=', f.session.id).execute()).toEqual([]);
});

it.each(['permanent', 'retry_exhausted', 'lease_exhausted'] as const)('closes unexecuted start_job intent on %s command failure', async mode => {
  const f = await fixture();
  const job = (await request(`/sessions/${f.session.id}/background-jobs`, f.jobInput)).body;
  const command = await claimTarget(job.jobId);
  if (mode !== 'permanent') await db.updateTable('workflow_command').set({ attempts: 10, ...(mode === 'lease_exhausted' ? { lease_expires_at: new Date(Date.now() - 1) } : {}) }).where('id', '=', command.id).execute();
  if (mode === 'lease_exhausted') await rawInternal('/commands/claim', { workerId: 'worker_test' });
  else expect((await rawInternal(`/commands/${command.id}/retry`, { claimToken: command.claimToken, errorCode: 'TOOL_EXECUTION_FAILED', retryable: mode !== 'permanent' })).status).toBe(204);
  expect((await request(`/background-jobs/${job.jobId}`)).body).toMatchObject({ status: 'failed', errorCode: 'WORKFLOW_COMMAND_FAILED' });
  expect(await db.selectFrom('event').selectAll().where('session_id', '=', f.session.id).where('event_type', '=', 'background_job.failed').execute()).toHaveLength(1);
  expect(await db.selectFrom('run').selectAll().where('session_id', '=', f.session.id).execute()).toEqual([]);
});

it('fails only the bound background job idempotently without falsifying a live Run', async () => {
  const f = await fixture();
  const job = (await request(`/sessions/${f.session.id}/background-jobs`, f.jobInput)).body;
  await claimTarget(job.jobId);
  const run = (await rawInternal(`/jobs/${job.jobId}/dispatch`, {})).body;
  const runBefore = await db.selectFrom('run').selectAll().where('id', '=', run.runId).executeTakeFirstOrThrow();
  const executionBefore = await db.selectFrom('execution_job').selectAll().where('run_id', '=', run.runId).executeTakeFirstOrThrow();
  const path = `/jobs/${job.jobId}/fail`;
  expect((await rawInternal(path, { errorCode: 'not-a-code' })).status).toBe(400);
  expect((await rawInternal(path, { errorCode: 'WORKFLOW_COMMAND_FAILED', message: 'unsafe' })).status).toBe(400);
  const failed = await rawInternal(path, { errorCode: 'WORKFLOW_COMMAND_FAILED' });
  expect(failed.status).toBe(200);
  expect(failed.body).toEqual({ jobId: job.jobId, runId: run.runId, status: 'failed', deadlineAt: job.deadlineAt, errorCode: 'WORKFLOW_COMMAND_FAILED' });
  expect((await rawInternal(path, { errorCode: 'WORKFLOW_COMMAND_FAILED' })).body).toEqual(failed.body);
  expect((await rawInternal(`/jobs/${job.jobId}`)).body).toEqual(failed.body);
  expect(await db.selectFrom('event').selectAll().where('session_id', '=', f.session.id).where('event_type', '=', 'background_job.failed').execute()).toHaveLength(1);
  expect(await db.selectFrom('run').selectAll().where('id', '=', run.runId).executeTakeFirstOrThrow()).toEqual(runBefore);
  expect(await db.selectFrom('execution_job').selectAll().where('run_id', '=', run.runId).executeTakeFirstOrThrow()).toEqual(executionBefore);
});

it('disables and syncs a schedule at its final atomic dispatch while preserving the current Run', async () => {
  const f = await fixture();
  const schedule = (await request(`/sessions/${f.session.id}/schedules`, { ...f.scheduleInput, maxRuns: 1 })).body;
  await request(`/schedules/${schedule.id}/enable`, { expectedVersion: 1 });
  await claimTarget(schedule.id);
  const occurrence = { definitionVersion: 2, occurrenceId: `titan/final/${randomUUID()}`, scheduledAt: new Date().toISOString() };
  const job = (await rawInternal(`/schedules/${schedule.id}/occurrences`, occurrence)).body;
  const replies = await Promise.all([rawInternal(`/jobs/${job.jobId}/dispatch`, {}), rawInternal(`/jobs/${job.jobId}/dispatch`, {})]);
  expect(replies[0].body.runId).toBeDefined();
  expect(replies[1].body.runId).toBe(replies[0].body.runId);
  expect((await request(`/schedules/${schedule.id}`)).body).toMatchObject({ enabled: false, runCount: 1, version: 3, syncStatus: 'pending_sync' });
  expect(await db.selectFrom('workflow_command').selectAll().where('target_id', '=', schedule.id).where('definition_version', '=', 3).execute()).toHaveLength(1);
  expect(await db.selectFrom('run').selectAll().where('id', '=', replies[0].body.runId).executeTakeFirstOrThrow()).toMatchObject({ status: 'queued' });
});

it('rolls back target worker binding with a failed command claim and never reassigns it to another identity', async () => {
  const f = await fixture();
  await db.updateTable('workflow_command').set({ status: 'completed' }).execute();
  const job = (await request(`/sessions/${f.session.id}/background-jobs`, f.jobInput)).body;
  await admin.query(`ALTER TABLE ${schema}.workflow_command ADD CONSTRAINT reject_claim CHECK (status <> 'claimed') NOT VALID`);
  try { expect((await rawInternal('/commands/claim', { workerId: 'worker_test' })).status).toBe(500); }
  finally { await admin.query(`ALTER TABLE ${schema}.workflow_command DROP CONSTRAINT reject_claim`); }
  expect(await db.selectFrom('background_job').select('worker_id').where('id', '=', job.jobId).executeTakeFirstOrThrow()).toEqual({ worker_id: null });
  expect(await db.selectFrom('workflow_command').select(['attempts', 'worker_id', 'status']).where('target_id', '=', job.jobId).executeTakeFirstOrThrow()).toEqual({ attempts: 0, worker_id: null, status: 'pending' });
  const command = await claimTarget(job.jobId);
  await db.updateTable('workflow_command').set({ lease_expires_at: new Date(Date.now() - 1) }).where('id', '=', command.id).execute();
  const { WorkflowAuth } = await import('../dist/common/workflow-auth.js');
  const auth = app.get(WorkflowAuth);
  await auth.initialize({ workerId: 'worker_other', credentialRef: 'keychain://synthetic-workflow' }, async () => workflowToken);
  try { expect((await rawInternal('/commands/claim', { workerId: 'worker_other' })).status).toBe(204); }
  finally { await auth.initialize({ workerId: 'worker_test', credentialRef: 'keychain://synthetic-workflow' }, async () => workflowToken); }
  expect(await db.selectFrom('background_job').select('worker_id').where('id', '=', job.jobId).executeTakeFirstOrThrow()).toEqual({ worker_id: 'worker_test' });
  expect((await rawInternal('/commands/claim', { workerId: 'worker_test' })).body.id).toBe(command.id);
});

it.each(['job', 'schedule', 'exhausted_job'] as const)('skips a locked %s domain target without binding or starving an independent Session', async kind => {
  const f = await fixture(); const g = await fixture();
  await db.updateTable('workflow_command').set({ status: 'completed' }).execute();
  const target = kind === 'schedule'
    ? (await request(`/sessions/${f.session.id}/schedules`, f.scheduleInput)).body.id
    : (await request(`/sessions/${f.session.id}/background-jobs`, f.jobInput)).body.jobId;
  if (kind === 'exhausted_job') {
    const command = await claimTarget(target);
    await db.updateTable('workflow_command').set({ attempts: 10, lease_expires_at: new Date(Date.now() - 1) }).where('id', '=', command.id).execute();
  }
  const other = (await request(`/sessions/${g.session.id}/background-jobs`, g.jobInput)).body;
  let claim: ReturnType<typeof rawInternal> | undefined;
  let returnedWhileLocked = false;
  await db.transaction().execute(async trx => {
    await trx.selectFrom('session').select('id').where('id', '=', f.session.id).forUpdate().execute();
    claim = rawInternal('/commands/claim', { workerId: 'worker_test' });
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([claim.then(() => { returnedWhileLocked = true; }), new Promise<void>(resolve => { timer = setTimeout(resolve, 300); })]);
    clearTimeout(timer);
  });
  expect(returnedWhileLocked).toBe(true);
  expect((await claim!).body.targetId).toBe(other.jobId);
  if (kind === 'exhausted_job') {
    expect(await db.selectFrom('background_job').select('status').where('id', '=', target).executeTakeFirstOrThrow()).toEqual({ status: 'pending_dispatch' });
    await rawInternal('/commands/claim', { workerId: 'worker_test' });
    expect((await request(`/background-jobs/${target}`)).body).toMatchObject({ status: 'failed', errorCode: 'WORKFLOW_COMMAND_FAILED' });
  } else {
    const table = kind === 'schedule' ? 'execution_schedule' : 'background_job';
    expect(await db.selectFrom(table).select('worker_id').where('id', '=', target).executeTakeFirstOrThrow()).toEqual({ worker_id: null });
    expect((await claimTarget(target)).targetId).toBe(target);
  }
});

it.each(['permanent', 'retry_exhausted', 'lease_exhausted'] as const)('blocks the current schedule on %s sync failure and requires a new admin version to recover', async mode => {
  const f = await fixture();
  const schedule = (await request(`/sessions/${f.session.id}/schedules`, f.scheduleInput)).body;
  await request(`/schedules/${schedule.id}/enable`, { expectedVersion: 1 });
  const command = await claimTarget(schedule.id);
  const occurrence = { definitionVersion: 2, occurrenceId: `titan/sync-failure/${randomUUID()}`, scheduledAt: new Date().toISOString() };
  const admitted = (await rawInternal(`/schedules/${schedule.id}/occurrences`, occurrence)).body;
  expect(admitted.status).toBe('created');
  if (mode !== 'permanent') await db.updateTable('workflow_command').set({ attempts: 10, ...(mode === 'lease_exhausted' ? { lease_expires_at: new Date(Date.now() - 1) } : {}) }).where('id', '=', command.id).execute();
  if (mode === 'lease_exhausted') await rawInternal('/commands/claim', { workerId: 'worker_test' });
  else expect((await rawInternal(`/commands/${command.id}/retry`, { claimToken: command.claimToken, retryable: mode !== 'permanent', errorCode: 'TOOL_EXECUTION_FAILED' })).status).toBe(204);
  expect((await request(`/schedules/${schedule.id}`)).body).toMatchObject({ version: 2, syncStatus: 'blocked', runCount: 0 });
  expect(await db.selectFrom('workflow_command').select('status').where('id', '=', command.id).executeTakeFirstOrThrow()).toEqual({ status: 'failed' });
  const failures = await db.selectFrom('event').select(['event_id', 'payload']).where('session_id', '=', f.session.id).where('event_type', '=', 'schedule.sync_failed').execute();
  expect(failures).toHaveLength(1);
  expect(failures[0]!.payload).toMatchObject({ scheduleId: schedule.id, version: 2, errorCode: 'WORKFLOW_COMMAND_FAILED' });
  expect((await rawInternal(`/jobs/${admitted.jobId}/dispatch`, {})).body.status).toBe('cancelled');
  expect((await rawInternal(`/schedules/${schedule.id}/occurrences`, { ...occurrence, occurrenceId: `titan/blocked/${randomUUID()}`, scheduledAt: new Date().toISOString() })).body).toEqual({ status: 'skipped' });
  expect(await db.selectFrom('run').selectAll().where('session_id', '=', f.session.id).execute()).toEqual([]);
  expect((await rawInternal(`/commands/${command.id}/complete`, { claimToken: command.claimToken })).status).toBe(409);
  await rawInternal('/commands/claim', { workerId: 'worker_test' });
  expect(await db.selectFrom('event').select('event_id').where('session_id', '=', f.session.id).where('event_type', '=', 'schedule.sync_failed').execute()).toEqual(failures.map(row => ({ event_id: row.event_id })));
  const enabled = await request(`/schedules/${schedule.id}/enable`, { expectedVersion: 2 });
  expect(enabled.body).toMatchObject({ version: 3, syncStatus: 'pending_sync', enabled: true });
  const recovery = await claimTarget(schedule.id);
  expect(recovery.definitionVersion).toBe(3);
  await rawInternal(`/commands/${recovery.id}/complete`, { claimToken: recovery.claimToken });
  expect((await request(`/schedules/${schedule.id}`)).body.syncStatus).toBe('active');
});

it.each(['permanent', 'lease_exhausted'] as const)('does not block a newer schedule version on old %s sync failure', async mode => {
  const f = await fixture();
  const schedule = (await request(`/sessions/${f.session.id}/schedules`, f.scheduleInput)).body;
  const old = await claimTarget(schedule.id);
  await request(`/schedules/${schedule.id}/enable`, { expectedVersion: 1 });
  if (mode === 'lease_exhausted') {
    await db.updateTable('workflow_command').set({ attempts: 10, lease_expires_at: new Date(Date.now() - 1) }).where('id', '=', old.id).execute();
    await rawInternal('/commands/claim', { workerId: 'worker_test' });
  } else expect((await rawInternal(`/commands/${old.id}/retry`, { claimToken: old.claimToken, retryable: false, errorCode: 'TOOL_EXECUTION_FAILED' })).status).toBe(204);
  expect((await request(`/schedules/${schedule.id}`)).body).toMatchObject({ version: 2, syncStatus: 'pending_sync', enabled: true });
  expect(await db.selectFrom('event').selectAll().where('session_id', '=', f.session.id).where('event_type', '=', 'schedule.sync_failed').execute()).toEqual([]);
});

it.each(['session', 'execution_schedule'] as const)('defers exhausted schedule cleanup under a locked %s without starving other targets', async table => {
  const f = await fixture(); const g = await fixture();
  await db.updateTable('workflow_command').set({ status: 'completed' }).execute();
  const schedule = (await request(`/sessions/${f.session.id}/schedules`, f.scheduleInput)).body;
  const command = await claimTarget(schedule.id);
  await db.updateTable('workflow_command').set({ attempts: 10, lease_expires_at: new Date(Date.now() - 1) }).where('id', '=', command.id).execute();
  const other = (await request(`/sessions/${g.session.id}/background-jobs`, g.jobInput)).body;
  let claim: ReturnType<typeof rawInternal> | undefined;
  let returnedWhileLocked = false;
  await db.transaction().execute(async trx => {
    await trx.selectFrom(table).select('id').where('id', '=', table === 'session' ? f.session.id : schedule.id).forUpdate().execute();
    claim = rawInternal('/commands/claim', { workerId: 'worker_test' });
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([claim.then(() => { returnedWhileLocked = true; }), new Promise<void>(resolve => { timer = setTimeout(resolve, 300); })]);
    clearTimeout(timer);
  });
  expect(returnedWhileLocked).toBe(true);
  expect((await claim!).body.targetId).toBe(other.jobId);
  expect(await db.selectFrom('workflow_command').select('status').where('id', '=', command.id).executeTakeFirstOrThrow()).toEqual({ status: 'claimed' });
  expect((await request(`/schedules/${schedule.id}`)).body.syncStatus).toBe('pending_sync');
  await rawInternal('/commands/claim', { workerId: 'worker_test' });
  expect((await request(`/schedules/${schedule.id}`)).body.syncStatus).toBe('blocked');
});

it('locks an observed execution job and Run before its Session while daemon progress holds the Run', async () => {
  const f = await fixture();
  const run = (await request(`/sessions/${f.session.id}/runs`, { idempotencyKey: randomUUID() })).body;
  let observation: ReturnType<typeof request> | undefined;
  const result = await db.transaction().execute(async trx => {
    const backend = await sql<{ pid: number }>`select pg_backend_pid() as pid`.execute(trx);
    await trx.selectFrom('execution_job').select('id').where('run_id', '=', run.id).forUpdate().execute();
    await trx.selectFrom('run').select('id').where('id', '=', run.id).forUpdate().execute();
    observation = request(`/sessions/${f.session.id}/background-jobs`, { ...f.jobInput, kind: 'observe', runId: run.id });
    let blocked = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      const waiting = await admin.query('SELECT pid FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))', [backend.rows[0]!.pid]);
      if (waiting.rows.length) { blocked = true; break; }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(blocked).toBe(true);
    await trx.updateTable('session').set({ status: 'running' }).where('id', '=', f.session.id).execute();
    return 'committed';
  }).catch(error => error.code);
  expect(result).toBe('committed');
  expect((await observation!).status).toBe(201);
});

it.each(['deadline', 'explicit_cancel', 'internal_expiry'] as const)('honors %s after workflow failure while retaining the failed orchestration result', async mode => {
  const f = await fixture();
  const job = (await request(`/sessions/${f.session.id}/background-jobs`, f.jobInput)).body;
  await claimTarget(job.jobId);
  const run = (await rawInternal(`/jobs/${job.jobId}/dispatch`, {})).body;
  await db.updateTable('run').set({ status: 'running' }).where('id', '=', run.runId).execute();
  await db.updateTable('session').set({ status: 'running' }).where('id', '=', f.session.id).execute();
  expect((await rawInternal(`/jobs/${job.jobId}/fail`, { errorCode: 'WORKFLOW_COMMAND_FAILED' })).body.status).toBe('failed');
  expect(await db.selectFrom('run').select('status').where('id', '=', run.runId).executeTakeFirstOrThrow()).toEqual({ status: 'running' });
  if (mode !== 'explicit_cancel') await db.updateTable('background_job').set({ deadline_at: new Date(Date.now() - 1) }).where('id', '=', job.jobId).execute();
  const cancelled = mode === 'explicit_cancel' ? await request(`/background-jobs/${job.jobId}/cancel`, {})
    : mode === 'internal_expiry' ? await rawInternal(`/jobs/${job.jobId}/cancel`, { reason: 'expired' }) : await request(`/background-jobs/${job.jobId}`);
  expect(cancelled.status).toBe(200);
  const view = (await request(`/background-jobs/${job.jobId}`)).body;
  expect(view).toMatchObject({ status: 'failed', cancelRequested: true, errorCode: 'WORKFLOW_COMMAND_FAILED' });
  expect(await db.selectFrom('run').select('status').where('id', '=', run.runId).executeTakeFirstOrThrow()).toEqual({ status: 'cancelled' });
  expect(await db.selectFrom('execution_job').select('cancel_requested').where('run_id', '=', run.runId).executeTakeFirstOrThrow()).toEqual({ cancel_requested: true });
  await request(`/background-jobs/${job.jobId}/cancel`, {});
  expect((await request(`/background-jobs/${job.jobId}`)).body).toEqual(view);
  expect(await db.selectFrom('event').select('event_id').where('run_id', '=', run.runId).where('event_type', '=', 'run.cancelled').execute()).toHaveLength(1);
  expect(await db.selectFrom('event').select('event_id').where('session_id', '=', f.session.id).where('event_type', '=', 'background_job.cancel_requested').execute()).toHaveLength(1);
});
