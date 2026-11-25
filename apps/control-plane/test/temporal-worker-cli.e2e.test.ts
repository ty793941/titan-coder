import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../dist/main.js';
import { DatabaseService } from '../dist/database/database.service.js';
import { createWorkflowControlPlaneProxy } from './fixtures/workflow-control-plane-proxy.mjs';
import { startWorkflowWorker } from './fixtures/workflow-worker-cli.mjs';
import { createTemporalDaemonFixture } from './fixtures/temporal-daemon.mjs';

const enabled = process.env.TITAN_TEMPORAL_E2E === '1';
const temporalRequire = createRequire(new URL('../../../packages/workflow/package.json', import.meta.url));
const { Client, Connection } = temporalRequire('@temporalio/client');
const { NativeConnection } = temporalRequire('@temporalio/worker');

const temporalAddress = process.env.TITAN_TEMPORAL_ADDRESS ?? '127.0.0.1:7233';
const taskQueue = 'titan-orchestration-v1';
const originalDatabaseUrl = process.env.DATABASE_URL ?? 'postgresql://titan:titan@127.0.0.1:55432/titan';
const consoleToken = `synthetic-console-${randomUUID()}`;
const workflowToken = `synthetic-service-key-${randomUUID()}`;
const workerId = `worker_${randomUUID().replaceAll('-', '')}`;
const schema = `worker_cli_${randomUUID().replaceAll('-', '')}`;
const namespace = `titan-e2e-${randomUUID()}`;
const modelUrl = 'https://synthetic-model.example.invalid/v1';
const prompt = 'synthetic prompt must stay outside Temporal history';
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const workerPath = join(repoRoot, 'apps/workflow-worker/dist/main.js');
const workerConfigMarker = 'synthetic-service-key';

const admin = new Pool({ connectionString: originalDatabaseUrl });
let app: Awaited<ReturnType<typeof createApp>> | undefined;
let baseUrl = '';
let db: DatabaseService['db'];
let temporalConnection: any;

async function waitFor(condition: () => Promise<boolean>, timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`condition timed out after ${timeoutMs}ms`);
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
  return { status: response.status, body: text.length === 0 ? undefined : JSON.parse(text) as Record<string, any> };
}

function consoleRequest(path: string, body?: unknown) {
  return request(path, { token: consoleToken, ...(body === undefined ? {} : { body }) });
}

function workflowRequest(path: string, body?: unknown) {
  return request(`/internal/workflow${path}`, { token: workflowToken, ...(body === undefined ? {} : { body }) });
}

async function createFixture() {
  const project = await consoleRequest('/projects', { name: `Worker CLI ${randomUUID()}`, goal: 'exercise real worker CLI', idempotencyKey: randomUUID() });
  expect(project.status).toBe(201);
  const task = await consoleRequest(`/projects/${project.body!.id}/tasks`, {
    title: 'Real Temporal worker CLI', goal: 'run through the actual dispatcher and worker process', acceptanceCriteria: ['one run completes'], priority: 'high', idempotencyKey: randomUUID(),
  });
  expect(task.status).toBe(201);
  const daemon = await consoleRequest('/daemons/register', {
    machineName: `worker-cli-${randomUUID()}`, environmentType: 'local', capabilities: ['codex'], workspaceRoots: ['/tmp/titan-worker-cli'], maxConcurrentSessions: 2, daemonVersion: 'worker-cli-e2e',
  });
  expect(daemon.status).toBe(201);
  const planHash = `sha256:${'f'.repeat(64)}`;
  await db.insertInto('artifact').values({
    artifact_id: `artifact_${randomUUID()}`, project_id: project.body!.id, task_id: task.body!.id, session_id: null, type: 'plan', version: 1, schema_version: 1,
    uri: `file:///tmp/worker-cli-plan-${randomUUID()}`, checksum: planHash, status: 'approved', source_artifacts: '[]', created_by_type: 'user', created_by_id: 'worker-cli-e2e',
    created_at: new Date(), review_state: 'approved', reference: null, metadata: '{}',
  }).execute();
  const session = await consoleRequest(`/tasks/${task.body!.id}/sessions`, {
    entryAgent: 'project-manager', goal: 'run a real worker CLI', planHash, daemonId: daemon.body!.daemonId,
    execution: { daemonId: daemon.body!.daemonId, runtime: 'codex', credentialRef: 'keychain://synthetic-codex', modelRef: 'synthetic-model', workspacePath: '/tmp/titan-worker-cli', allowedTools: ['workspace.read'], maxTurns: 1, timeoutMs: 60000 },
    idempotencyKey: randomUUID(),
  });
  expect(session.status).toBe(201);
  return {
    project: project.body!, task: task.body!, session: session.body!, daemon: daemon.body!, planHash,
    daemonFixture: createTemporalDaemonFixture({ baseUrl, daemonId: daemon.body!.daemonId, authToken: daemon.body!.authToken }),
  };
}

async function createBackgroundJob(fixture: Awaited<ReturnType<typeof createFixture>>) {
  const job = await consoleRequest(`/sessions/${fixture.session.id}/background-jobs`, {
    kind: 'run', runInBackground: true, planHash: fixture.planHash, deadlineAt: new Date(Date.now() + 600000).toISOString(), idempotencyKey: randomUUID(),
  });
  expect(job.status).toBe(201);
  return job.body!;
}

async function startWorker(controlPlaneUrl: string, reuse?: { configPath: string; configDirectory: string }) {
  return startWorkflowWorker({
    repoRoot, workerPath, controlPlaneUrl, namespace, workerId, credential: workflowToken,
    ...(reuse ? { configPath: reuse.configPath, configDirectory: reuse.configDirectory } : {}),
  });
}

async function getJob(jobId: string) {
  return db.selectFrom('background_job').selectAll().where('id', '=', jobId).executeTakeFirstOrThrow();
}

async function getCommand(commandId: string) {
  return db.selectFrom('workflow_command').selectAll().where('id', '=', commandId).executeTakeFirstOrThrow();
}

async function getTemporalHandle(workflowId: string) {
  const connection = await NativeConnection.connect({ address: temporalAddress });
  const client = new Client({ connection, namespace });
  return { connection, client, handle: client.workflow.getHandle(workflowId) };
}

async function registerTestNamespace() {
  temporalConnection = await Connection.connect({ address: temporalAddress });
  await temporalConnection.workflowService.registerNamespace({ namespace, description: 'bounded Task 6 worker CLI test namespace', ownerEmail: 'test@titan.invalid', workflowExecutionRetentionPeriod: { seconds: 86400 } });
}

async function assertSafeWorkerLogs(logs: string) {
  expect(logs).not.toContain(workflowToken);
  expect(logs).not.toContain(workerConfigMarker);
  expect(logs).not.toContain(modelUrl);
  expect(logs).not.toContain(prompt);
  expect(logs).not.toContain('synthetic-http-body');
}

const suite = describe.skipIf(!enabled);

beforeAll(async () => {
  if (!enabled) return;
  await admin.query(`CREATE SCHEMA ${schema}`);
  const scopedUrl = new URL(originalDatabaseUrl);
  scopedUrl.searchParams.set('options', `-c search_path=${schema}`);
  process.env.DATABASE_URL = scopedUrl.toString();
  process.env.TITAN_CONSOLE_TOKEN = consoleToken;
  await registerTestNamespace();
  app = await createApp({ workflowIdentity: { workerId, credentialRef: 'keychain://synthetic-workflow' }, resolveWorkflowCredential: async () => workflowToken });
  db = app.get(DatabaseService).db;
  await app.listen(0, '127.0.0.1');
  baseUrl = await app.getUrl();
}, 30000);

afterAll(async () => {
  if (!enabled) return;
  await app?.close();
  await temporalConnection?.close();
  await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  await admin.end();
  process.env.DATABASE_URL = originalDatabaseUrl;
  delete process.env.TITAN_CONSOLE_TOKEN;
}, 30000);

suite('real workflow worker CLI integration', () => {
  it('starts through Dispatcher, survives CLI restart, and completes the same Run once', async () => {
    const fixture = await createFixture();
    const job = await createBackgroundJob(fixture);
    const worker = await startWorker(baseUrl);
    const temporal = await getTemporalHandle(job.workflowId);
    let restarted = false;
    let secondWorker: Awaited<ReturnType<typeof startWorker>> | undefined;
    try {
      expect(await readFile(worker.configPath, 'utf8')).not.toContain(workflowToken);
      await waitFor(async () => (await getCommand((await db.selectFrom('workflow_command').select('id').where('target_id', '=', job.jobId).executeTakeFirstOrThrow()).id)).status === 'completed');
      await waitFor(async () => Boolean((await getJob(job.jobId)).run_id));
      const execution = await fixture.daemonFixture.claimExecution();
      expect(execution.runId).toBeDefined();
      expect((await getJob(job.jobId)).run_id).toBe(execution.runId);
      await fixture.daemonFixture.progress(execution.runId, execution.claimToken, 1, 'running', { output: 'worker cli started' });
      await worker.stop();
      restarted = true;
      secondWorker = await startWorker(baseUrl, { configPath: worker.configPath, configDirectory: worker.configDirectory });
      expect(secondWorker.configPath).toBe(worker.configPath);
      try {
        await fixture.daemonFixture.progress(execution.runId, execution.claimToken, 2, 'completed', { output: 'worker cli completed' });
        await expect(temporal.handle.result()).resolves.toMatchObject({ jobId: job.jobId, status: 'completed', runId: execution.runId });
        expect((await db.selectFrom('run').selectAll().where('session_id', '=', fixture.session.id).execute())).toHaveLength(1);
        expect((await getJob(job.jobId)).run_id).toBe(execution.runId);
        const history = await temporal.handle.fetchHistory();
        const historyText = JSON.stringify(history);
        const started = (history.events ?? []).filter((event: any) => event.eventType === 'EVENT_TYPE_WORKFLOW_EXECUTION_STARTED' || event.eventType === 1 || String(event.eventType).includes('WORKFLOW_EXECUTION_STARTED')).length;
        expect(started).toBe(1);
        expect(historyText).not.toContain(workerConfigMarker);
        expect(historyText).not.toContain(modelUrl);
        expect(historyText).not.toContain(prompt);
        await assertSafeWorkerLogs(`${worker.logs}${secondWorker.logs}`);
      } finally {
        await secondWorker.stop();
      }
    } finally {
      if (!restarted && worker.child.exitCode === null && worker.child.signalCode === null) await worker.stop();
      await worker.cleanup();
      await temporal.connection.close();
    }
  }, 90000);

  it('keeps a CP-completed command single when the proxy drops its first complete response', async () => {
    const fixture = await createFixture();
    const job = await createBackgroundJob(fixture);
    const proxy = await createWorkflowControlPlaneProxy({ targetBaseUrl: baseUrl, dropCompleteResponseOnce: true });
    const worker = await startWorker(proxy.baseUrl);
    const temporal = await getTemporalHandle(job.workflowId);
    try {
      await waitFor(async () => proxy.droppedCompleteResponse && (await getCommand((await db.selectFrom('workflow_command').select('id').where('target_id', '=', job.jobId).executeTakeFirstOrThrow()).id)).status === 'completed');
      await waitFor(async () => Boolean((await getJob(job.jobId)).run_id));
      const execution = await fixture.daemonFixture.claimExecution();
      await fixture.daemonFixture.progress(execution.runId, execution.claimToken, 1, 'completed', { output: 'ack drop completed' });
      await expect(temporal.handle.result()).resolves.toMatchObject({ jobId: job.jobId, runId: execution.runId, status: 'completed' });
      const command = await db.selectFrom('workflow_command').select(['status', 'attempts']).where('target_id', '=', job.jobId).executeTakeFirstOrThrow();
      expect(command).toEqual({ status: 'completed', attempts: 1 });
      expect(proxy.forwardedCompleteRequests).toBeGreaterThanOrEqual(1);
      expect((await db.selectFrom('run').select('id').where('session_id', '=', fixture.session.id).execute())).toHaveLength(1);
      await assertSafeWorkerLogs(worker.logs);
    } finally {
      await worker.stop();
      await worker.cleanup();
      await proxy.close();
      await temporal.connection.close();
    }
  }, 90000);

  it('syncs a public schedule and completes one native trigger occurrence through the real worker', async () => {
    const fixture = await createFixture();
    const schedule = await consoleRequest(`/sessions/${fixture.session.id}/schedules`, {
      planHash: fixture.planHash, timezone: 'UTC', intervalSeconds: 60, startsAt: new Date(Date.now() - 59000).toISOString(), endsAt: new Date(Date.now() + 120000).toISOString(),
      maxRuns: 1, overlapPolicy: 'skip', catchupWindowSeconds: 120, enabled: false, idempotencyKey: randomUUID(),
    });
    expect(schedule.status).toBe(201);
    const worker = await startWorker(baseUrl);
    try {
      const enabledSchedule = await consoleRequest(`/schedules/${schedule.body!.id}/enable`, { expectedVersion: 1 });
      expect(enabledSchedule.status).toBe(200);
      await waitFor(async () => (await consoleRequest(`/schedules/${schedule.body!.id}`)).body!.syncStatus === 'active');
      const temporalSchedule = new Client({ connection: temporalConnection, namespace }).schedule.getHandle(`${schedule.body!.temporalScheduleId}-v2`);
      await waitFor(async () => {
        try { return !(await temporalSchedule.describe()).state.paused; } catch { return false; }
      });
      const description = await temporalSchedule.describe();
      expect(description.info.nextActionTimes.length).toBeGreaterThan(0);
      await temporalSchedule.trigger();
      await waitFor(async () => Number((await db.selectFrom('schedule_occurrence').select(({ fn }) => fn.countAll<number>().as('count')).where('schedule_id', '=', schedule.body!.id).executeTakeFirstOrThrow()).count) === 1, 15000);
      const firstOccurrence = await db.selectFrom('schedule_occurrence').selectAll().where('schedule_id', '=', schedule.body!.id).where('status', 'in', ['created', 'dispatched']).orderBy('scheduled_at', 'asc').executeTakeFirstOrThrow();
      await waitFor(async () => Boolean((await getJob(firstOccurrence.job_id!)).run_id));
      const firstJob = await getJob(firstOccurrence.job_id!);
      const firstExecution = await fixture.daemonFixture.claimExecution();
      await fixture.daemonFixture.progress(firstExecution.runId, firstExecution.claimToken, 1, 'completed', { output: 'complete scheduled run' });
      expect(firstJob.run_id).toBe(firstExecution.runId);
      const firstTemporal = await getTemporalHandle(firstOccurrence.occurrence_id);
      let occurrenceHistory: unknown;
      try {
        await expect(firstTemporal.handle.result()).resolves.toMatchObject({ status: 'completed', jobId: firstOccurrence.job_id });
        occurrenceHistory = await firstTemporal.handle.fetchHistory();
      } finally {
        await firstTemporal.connection.close();
      }
      expect((await db.selectFrom('execution_schedule').select('run_count').where('id', '=', schedule.body!.id).executeTakeFirstOrThrow()).run_count).toBe(1);
      expect(JSON.stringify(occurrenceHistory)).toContain('TemporalScheduledStartTime');
      await assertSafeWorkerLogs(worker.logs);
    } finally {
      await worker.stop();
      await worker.cleanup();
    }
  }, 90000);

  it('propagates public pause and a later definition version to native schedules without a manual trigger', async () => {
    const fixture = await createFixture();
    const schedule = await consoleRequest(`/sessions/${fixture.session.id}/schedules`, {
      planHash: fixture.planHash, timezone: 'UTC', intervalSeconds: 60, startsAt: new Date(Date.now() + 60000).toISOString(), endsAt: new Date(Date.now() + 120000).toISOString(),
      maxRuns: 1, overlapPolicy: 'skip', catchupWindowSeconds: 10, enabled: false, idempotencyKey: randomUUID(),
    });
    expect(schedule.status).toBe(201);
    const worker = await startWorker(baseUrl);
    try {
      expect((await consoleRequest(`/schedules/${schedule.body!.id}/enable`, { expectedVersion: 1 })).status).toBe(200);
      await waitFor(async () => (await consoleRequest(`/schedules/${schedule.body!.id}`)).body!.syncStatus === 'active');
      const v2 = new Client({ connection: temporalConnection, namespace }).schedule.getHandle(`${schedule.body!.temporalScheduleId}-v2`);
      expect((await v2.describe()).state.paused).toBe(false);
      const paused = await consoleRequest(`/schedules/${schedule.body!.id}/pause`, { expectedVersion: 2 });
      expect(paused.status).toBe(200);
      await waitFor(async () => (await consoleRequest(`/schedules/${schedule.body!.id}`)).body!.syncStatus === 'paused');
      expect((await v2.describe()).state.paused).toBe(true);
      const updated = await consoleRequest(`/schedules/${schedule.body!.id}/update`, {
        expectedVersion: 3, planHash: fixture.planHash, timezone: 'UTC', intervalSeconds: 60, startsAt: new Date(Date.now() + 60000).toISOString(), endsAt: new Date(Date.now() + 180000).toISOString(),
        maxRuns: 1, overlapPolicy: 'skip', catchupWindowSeconds: 10,
      });
      expect(updated.status).toBe(200);
      expect(updated.body!.version).toBe(4);
      expect((await consoleRequest(`/schedules/${schedule.body!.id}/enable`, { expectedVersion: 4 })).status).toBe(200);
      await waitFor(async () => (await consoleRequest(`/schedules/${schedule.body!.id}`)).body!.syncStatus === 'active');
      const v5 = new Client({ connection: temporalConnection, namespace }).schedule.getHandle(`${schedule.body!.temporalScheduleId}-v5`);
      try {
        await waitFor(async () => {
          try { return !(await v5.describe()).state.paused; } catch { return false; }
        });
      } catch (error) {
        const scheduleRow = await db.selectFrom('execution_schedule').selectAll().where('id', '=', schedule.body!.id).executeTakeFirstOrThrow();
        const commandRows = await db.selectFrom('workflow_command').selectAll().where('target_id', '=', schedule.body!.id).execute();
        throw new Error(`${error instanceof Error ? error.message : String(error)}; schedule=${JSON.stringify({ version: scheduleRow.version, enabled: scheduleRow.enabled, syncStatus: scheduleRow.sync_status, runCount: scheduleRow.run_count })}; commands=${JSON.stringify(commandRows.map(row => ({ kind: row.kind, status: row.status, definitionVersion: row.definition_version, errorCode: row.error_code })))}; worker=${worker.logs}`);
      }
      expect((await v2.describe()).state.paused).toBe(true);
      expect((await v5.describe()).memo).toMatchObject({ titanScheduleId: schedule.body!.id, titanDefinitionVersion: 5 });
      expect(await db.selectFrom('schedule_occurrence').select('id').where('schedule_id', '=', schedule.body!.id).execute()).toEqual([]);
      await assertSafeWorkerLogs(worker.logs);
    } finally {
      await worker.stop();
      await worker.cleanup();
    }
  }, 90000);
});
