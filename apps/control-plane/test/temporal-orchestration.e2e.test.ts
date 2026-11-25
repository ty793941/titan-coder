import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../dist/main.js';
import { DatabaseService } from '../dist/database/database.service.js';
import { createTemporalDaemonFixture } from './fixtures/temporal-daemon.mjs';

const enabled = process.env.TITAN_TEMPORAL_E2E === '1';
const temporalRequire = createRequire(new URL('../../../packages/workflow/package.json', import.meta.url));
const { Client } = temporalRequire('@temporalio/client');
const { NativeConnection } = temporalRequire('@temporalio/worker');
const { Worker } = temporalRequire('@temporalio/worker');

const temporalAddress = process.env.TITAN_TEMPORAL_ADDRESS ?? '127.0.0.1:7233';
const temporalNamespace = process.env.TITAN_TEMPORAL_NAMESPACE ?? 'titan';
const taskQueue = `titan-e2e-${randomUUID()}`;
const consoleToken = `console-${randomUUID()}`;
const workflowToken = `workflow-${randomUUID()}`;
const workerId = `worker_${randomUUID().replaceAll('-', '')}`;
const originalDatabaseUrl = process.env.DATABASE_URL ?? 'postgresql://titan:titan@127.0.0.1:55432/titan';
const admin = new Pool({ connectionString: originalDatabaseUrl });
const schema = `temporal_e2e_${randomUUID().replaceAll('-', '')}`;
const workflowPath = fileURLToPath(new URL('../../../packages/workflow/dist/src/workflows.js', import.meta.url));

let app: Awaited<ReturnType<typeof createApp>> | undefined;
let baseUrl = '';
let db: DatabaseService['db'];

async function waitFor(condition: () => Promise<boolean>, timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('condition timed out');
}

async function request(path: string, options: { method?: string; token?: string; body?: unknown } = {}) {
  const response = await fetch(`${baseUrl}/api${path}`, {
    method: options.method ?? (options.body === undefined ? 'GET' : 'POST'),
    headers: {
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text.length === 0 ? undefined : JSON.parse(text),
  };
}

function consoleRequest(path: string, body?: unknown) {
  return request(path, { token: consoleToken, ...(body === undefined ? {} : { body }) });
}

function workflowRequest(path: string, body?: unknown) {
  return request(`/internal/workflow${path}`, { token: workflowToken, ...(body === undefined ? {} : { body }) });
}

async function createFixture() {
  const project = await consoleRequest('/projects', {
    name: `Temporal E2E ${randomUUID()}`,
    goal: 'exercise persistent orchestration',
    idempotencyKey: randomUUID(),
  });
  expect(project.status).toBe(201);

  const task = await consoleRequest(`/projects/${project.body.id}/tasks`, {
    title: 'Temporal background execution',
    goal: 'run a deterministic daemon fixture',
    acceptanceCriteria: ['the run completes once'],
    priority: 'high',
    idempotencyKey: randomUUID(),
  });
  expect(task.status).toBe(201);

  const daemon = await consoleRequest('/daemons/register', {
    machineName: `temporal-e2e-${randomUUID()}`,
    environmentType: 'local',
    capabilities: ['codex'],
    workspaceRoots: ['/tmp/titan-temporal-e2e'],
    maxConcurrentSessions: 2,
    daemonVersion: 'temporal-e2e',
  });
  expect(daemon.status).toBe(201);

  const planHash = `sha256:${'e'.repeat(64)}`;
  await db.insertInto('artifact').values({
    artifact_id: `artifact_${randomUUID()}`,
    project_id: project.body.id,
    task_id: task.body.id,
    session_id: null,
    type: 'plan',
    version: 1,
    schema_version: 1,
    uri: `file:///tmp/temporal-plan-${randomUUID()}`,
    checksum: planHash,
    status: 'approved',
    source_artifacts: '[]',
    created_by_type: 'user',
    created_by_id: 'temporal-e2e',
    created_at: new Date(),
    review_state: 'approved',
    reference: null,
    metadata: '{}',
  }).execute();

  const session = await consoleRequest(`/tasks/${task.body.id}/sessions`, {
    entryAgent: 'project-manager',
    goal: 'run deterministic temporal fixture',
    planHash,
    daemonId: daemon.body.daemonId,
    execution: {
      daemonId: daemon.body.daemonId,
      runtime: 'codex',
      credentialRef: 'keychain://temporal-e2e-runtime',
      workspacePath: '/tmp/titan-temporal-e2e',
      allowedTools: ['workspace.read'],
      maxTurns: 1,
      timeoutMs: 60000,
    },
    idempotencyKey: randomUUID(),
  });
  expect(session.status).toBe(201);

  const job = await consoleRequest(`/sessions/${session.body.id}/background-jobs`, {
    kind: 'run',
    runInBackground: true,
    planHash,
    deadlineAt: new Date(Date.now() + 600000).toISOString(),
    idempotencyKey: randomUUID(),
  });
  expect(job.status).toBe(201);

  return {
    project: project.body,
    task: task.body,
    daemon: daemon.body,
    session: session.body,
    job: job.body,
    planHash,
    daemonFixture: createTemporalDaemonFixture({ baseUrl, daemonId: daemon.body.daemonId, authToken: daemon.body.authToken }),
  };
}

async function claimStartCommand() {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const result = await workflowRequest('/commands/claim', { workerId });
    if (result.status === 200 && result.body.kind === 'start_job') return result.body;
    if (result.status !== 204) throw new Error(`workflow command claim failed with HTTP ${result.status}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('start_job command claim timed out');
}

async function startWorkflow(job: { workflowId: string; jobId: string }) {
  const connection = await NativeConnection.connect({ address: temporalAddress });
  const client = new Client({ connection, namespace: temporalNamespace });
  const handle = await client.workflow.start('backgroundJobV1', {
    workflowId: job.workflowId,
    taskQueue,
    args: [{ jobId: job.jobId, workflowVersion: 1 }],
  });
  return { connection, client, handle };
}

async function startWorker(activities: Record<string, (input: any) => Promise<any>>) {
  const connection = await NativeConnection.connect({ address: temporalAddress });
  const worker = await Worker.create({
    connection,
    namespace: temporalNamespace,
    taskQueue,
    workflowsPath: workflowPath,
    activities,
  });
  const run = worker.run();
  return {
    worker,
    run,
    stop: async () => {
      await worker.shutdown();
      await run.catch(() => undefined);
      await connection.close();
    },
  };
}

const suite = describe.skipIf(!enabled);

beforeAll(async () => {
  if (!enabled) return;
  await admin.query(`CREATE SCHEMA ${schema}`);
  const scopedUrl = new URL(originalDatabaseUrl);
  scopedUrl.searchParams.set('options', `-c search_path=${schema}`);
  process.env.DATABASE_URL = scopedUrl.toString();
  process.env.TITAN_CONSOLE_TOKEN = consoleToken;
  app = await createApp({
    workflowIdentity: { workerId, credentialRef: 'keychain://temporal-e2e-workflow' },
    resolveWorkflowCredential: async () => workflowToken,
  });
  db = app.get(DatabaseService).db;
  await app.listen(0, '127.0.0.1');
  baseUrl = await app.getUrl();
}, 30000);

afterAll(async () => {
  if (!enabled) return;
  await app?.close();
  await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  await admin.end();
  delete process.env.TITAN_CONSOLE_TOKEN;
  process.env.DATABASE_URL = originalDatabaseUrl;
}, 30000);

suite('real Temporal orchestration', () => {
  it('creates one background Run and observes the same run after Worker restart', async () => {
    const fixture = await createFixture();
    const command = await claimStartCommand();
    const activities = {
      dispatchJob: async (input: { jobId: string; workflowVersion: 1 }) => (await workflowRequest(`/jobs/${input.jobId}/dispatch`, {})).body,
      observeJob: async (input: { jobId: string; workflowVersion: 1 }) => (await workflowRequest(`/jobs/${input.jobId}`)).body,
      cancelJob: async (input: { jobId: string; workflowVersion: 1; reason: 'cancelled' | 'expired' }) => (await workflowRequest(`/jobs/${input.jobId}/cancel`, { reason: input.reason })).body,
      failJob: async (input: { jobId: string; workflowVersion: 1; errorCode: string }) => (await workflowRequest(`/jobs/${input.jobId}/fail`, { errorCode: input.errorCode })).body,
      scheduleOccurrence: async () => ({ status: 'skipped' }),
    };
    let worker = await startWorker(activities);
    const temporal = await startWorkflow(fixture.job);
    try {
      const execution = await fixture.daemonFixture.claimExecution();
      expect(execution.runId).toBeDefined();
      await workflowRequest(`/commands/${command.id}/complete`, { claimToken: command.claimToken });
      await fixture.daemonFixture.progress(execution.runId, execution.claimToken, 1, 'running', { output: 'fixture started' });
      await waitFor(async () => (await db.selectFrom('run').select('status').where('id', '=', execution.runId).executeTakeFirst())?.status === 'running');
      expect((await db.selectFrom('run').selectAll().where('session_id', '=', fixture.session.id).execute())).toHaveLength(1);

      await worker.stop();
      worker = await startWorker(activities);
      await fixture.daemonFixture.progress(execution.runId, execution.claimToken, 2, 'completed', { output: 'fixture completed' });
      await expect(temporal.handle.result()).resolves.toMatchObject({ jobId: fixture.job.jobId, status: 'completed', runId: execution.runId });

      const runs = await db.selectFrom('run').selectAll().where('session_id', '=', fixture.session.id).execute();
      expect(runs).toHaveLength(1);
      expect(runs[0]?.id).toBe(execution.runId);
      expect(runs[0]?.status).toBe('completed');
      expect((await db.selectFrom('background_job').select(['run_id', 'status']).where('id', '=', fixture.job.jobId).executeTakeFirstOrThrow())).toEqual({ run_id: execution.runId, status: 'completed' });
    } finally {
      await worker.stop();
      await temporal.connection.close();
    }
  }, 90000);

  it('accepts replay of a command ACK after the first ACK response is lost', async () => {
    const fixture = await createFixture();
    const command = await claimStartCommand();
    const first = await workflowRequest(`/commands/${command.id}/complete`, { claimToken: command.claimToken });
    expect(first.status).toBe(204);
    const replay = await workflowRequest(`/commands/${command.id}/complete`, { claimToken: command.claimToken });
    expect(replay.status).toBe(204);
    expect((await db.selectFrom('workflow_command').select(['status', 'attempts']).where('id', '=', command.id).executeTakeFirstOrThrow())).toMatchObject({ status: 'completed', attempts: 1 });
    expect(fixture.job.workflowId).toContain(fixture.job.jobId);
  }, 30000);

  it('keeps sensitive progress values out of persisted execution history', async () => {
    const fixture = await createFixture();
    const command = await claimStartCommand();
    expect(command.targetId).toBe(fixture.job.jobId);
    const dispatched = await workflowRequest(`/jobs/${fixture.job.jobId}/dispatch`, {});
    expect(dispatched.status).toBe(200);
    const execution = await fixture.daemonFixture.claimExecution();
    const secret = `e2e-secret-${randomUUID()}`;
    const checkpoint = {
      id: `checkpoint_${randomUUID()}`,
      messages: [{ role: 'assistant', text: `Bearer ${secret}` }],
      successfulTools: [{ id: 'tool_1', name: 'workspace.read', inputHash: 'hash_1', output: { apiKey: secret } }],
      evidence: [{ kind: 'trace', reference: `password=${secret}` }],
    };
    expect((await fixture.daemonFixture.progress(execution.runId, execution.claimToken, 1, 'running', { token: secret, output: 'started' })).status).toBe(200);
    expect((await fixture.daemonFixture.progress(execution.runId, execution.claimToken, 2, 'checkpoint', { authorization: `Bearer ${secret}`, output: 'checkpointed' }, randomUUID(), checkpoint)).status).toBe(200);
    expect((await fixture.daemonFixture.progress(execution.runId, execution.claimToken, 3, 'completed', { output: 'completed' }, randomUUID())).status).toBe(200);

    const [events, checkpoints, audits] = await Promise.all([
      db.selectFrom('event').select('payload').where('run_id', '=', execution.runId).execute(),
      db.selectFrom('checkpoint').select('snapshot').where('run_id', '=', execution.runId).execute(),
      db.selectFrom('audit_log').select('payload').where('target_id', '=', 'tool_1').execute(),
    ]);
    const history = JSON.stringify({ events, checkpoints, audits });
    expect(history).not.toContain(secret);
    expect(history).toContain('[REDACTED]');
  }, 30000);
});
