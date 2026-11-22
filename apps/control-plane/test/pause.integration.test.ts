import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { createTestApp } from '../src/test-app.js';

const apps: Array<Awaited<ReturnType<typeof createTestApp>>> = [];

beforeAll(async () => {
  if (!process.env.DATABASE_URL) process.env.DATABASE_URL = 'postgresql://titan@127.0.0.1:55432/titan';
});

afterAll(async () => {
  for (const app of apps.splice(0)) await app.close();
});

async function fixture(options: { withExecution?: boolean } = {}) {
  const api = await createTestApp();
  apps.push(api);
  const daemon = await api.post('/api/daemons/register').send({
    machineName: `pause-test-${randomUUID()}`,
    environmentType: 'local',
    capabilities: ['codex'],
    workspaceRoots: ['/tmp/titan'],
    maxConcurrentSessions: 1,
    daemonVersion: '0.1.0',
  }).expect(201);
  const task = await api.post('/api/projects/project_dev/tasks')
    .set('Idempotency-Key', `task-${randomUUID()}`)
    .send({ title: 'pause', goal: 'pause and resume', acceptanceCriteria: ['done'], priority: 'high' })
    .expect(201);
  const checksum = `sha256:${'a'.repeat(64)}`;
  await api.db.insertInto('artifact').values({
    artifact_id: `artifact_${randomUUID()}`, project_id: 'project_dev', task_id: task.body.id,
    session_id: null, type: 'plan', version: 1, schema_version: 1, uri: `file:///tmp/plan-${randomUUID()}`,
    checksum, status: 'approved', source_artifacts: '[]', created_by_type: 'user', created_by_id: 'test',
    created_at: new Date(), review_state: 'approved', reference: null, metadata: '{}',
  }).execute();
  const config = {
    daemonId: daemon.body.daemonId,
    runtime: 'codex' as const,
    credentialRef: 'keychain:test',
    workspacePath: '/tmp/titan/repo',
    allowedTools: ['workspace.read'],
    maxTurns: 10,
    timeoutMs: 60000,
  };
  const session = await api.post(`/api/tasks/${task.body.id}/sessions`)
    .set('Idempotency-Key', `session-${randomUUID()}`)
    .send({
      entryAgent: 'project-manager', goal: 'pause and resume', planHash: checksum,
      ...(options.withExecution === false ? {} : { execution: config }),
      idempotencyKey: `session-${randomUUID()}`,
    }).expect(201);
  const run = await api.post(`/api/sessions/${session.body.id}/runs`)
    .set('Idempotency-Key', `run-${randomUUID()}`)
    .send({ idempotencyKey: `run-${randomUUID()}` }).expect(201);
  return { api, daemon: daemon.body, task: task.body, session: session.body, run: run.body, config, checksum };
}

async function checkpointProgress(fixtureValue: Awaited<ReturnType<typeof fixture>>, claimToken: string) {
  const checkpoint = { id: `checkpoint_${randomUUID()}`, messages: [{ role: 'assistant', text: 'saved' }], successfulTools: [], evidence: [] };
  await fixtureValue.api.post(`/api/daemons/${fixtureValue.daemon.daemonId}/runs/${fixtureValue.run.id}/progress`)
    .set('Authorization', `Bearer ${fixtureValue.daemon.authToken}`)
    .send({ eventId: randomUUID(), sequence: 1, claimToken, type: 'checkpoint', payload: {}, checkpoint }).expect(200);
  return checkpoint;
}

describe('explicit run pause and resume', () => {
  it('pauses with its latest checkpoint and rejects late terminal progress', async () => {
    const f = await fixture();
    const daemonPath = `/api/daemons/${f.daemon.daemonId}`;
    const claim = await f.api.post(`${daemonPath}/claim`).set('Authorization', `Bearer ${f.daemon.authToken}`).send({}).expect(200);
    const checkpoint = await checkpointProgress(f, claim.body.claimToken);

    const paused = await f.api.post(`/api/runs/${f.run.id}/pause`).expect(200);
    expect(paused.body).toMatchObject({ id: f.run.id, status: 'paused', checkpointId: checkpoint.id });
    expect(await f.api.post(`/api/runs/${f.run.id}/pause`).expect(200).then(response => response.body)).toEqual(paused.body);
    await f.api.post(`/api/sessions/${f.session.id}/runs`).set('Idempotency-Key', `direct-${randomUUID()}`)
      .send({ idempotencyKey: `direct-${randomUUID()}` }).expect(409);
    expect(await f.api.get(`/api/runs/${f.run.id}`).expect(200).then(response => response.body.status)).toBe('paused');
    expect(await f.api.get(`${daemonPath}/runs/${f.run.id}/control`).set('Authorization', `Bearer ${f.daemon.authToken}`).expect(200).then(response => response.body))
      .toMatchObject({ status: 'paused', cancelRequested: true });
    expect(await f.api.get(`${daemonPath}/runs/${f.run.id}/job`).set('Authorization', `Bearer ${f.daemon.authToken}`).expect(200).then(response => response.body))
      .toMatchObject({ status: 'paused', cancelRequested: true });

    const late = await f.api.post(`${daemonPath}/runs/${f.run.id}/progress`)
      .set('Authorization', `Bearer ${f.daemon.authToken}`)
      .send({ eventId: randomUUID(), sequence: 2, claimToken: claim.body.claimToken, type: 'completed', payload: {} }).expect(200);
    expect(late.body).toEqual({ accepted: false, status: 'paused', cancelRequested: true });
    await f.api.get(`/api/runs/${f.run.id}`).expect(200).then(response => expect(response.body.status).toBe('paused'));
  });

  it('creates a new attempt from a checkpoint and returns it for repeated resume idempotency', async () => {
    const f = await fixture();
    const daemonPath = `/api/daemons/${f.daemon.daemonId}`;
    const claim = await f.api.post(`${daemonPath}/claim`).set('Authorization', `Bearer ${f.daemon.authToken}`).send({}).expect(200);
    const checkpoint = await checkpointProgress(f, claim.body.claimToken);
    await f.api.post(`/api/runs/${f.run.id}/pause`).expect(200);
    const key = `resume-${randomUUID()}`;

    const resumed = await f.api.post(`/api/runs/${f.run.id}/resume`)
      .set('Idempotency-Key', key).send({ idempotencyKey: key }).expect(201);
    expect(resumed.body).toMatchObject({ sessionId: f.session.id, attempt: 2, status: 'queued', checkpointId: checkpoint.id });
    expect(resumed.body.id).not.toBe(f.run.id);
    expect(await f.api.get(`/api/runs/${f.run.id}`).expect(200).then(response => response.body.status)).toBe('paused');

    const repeated = await f.api.post(`/api/runs/${f.run.id}/resume`)
      .set('Idempotency-Key', key).send({ idempotencyKey: key }).expect(201);
    expect(repeated.body).toEqual(resumed.body);
    const nextClaim = await f.api.post(`${daemonPath}/claim`).set('Authorization', `Bearer ${f.daemon.authToken}`).send({}).expect(200);
    expect(nextClaim.body).toMatchObject({ runId: resumed.body.id, checkpoint });
  });

  it('allows a paused run without a checkpoint to resume from its goal', async () => {
    const f = await fixture({ withExecution: false });
    await f.api.post(`/api/runs/${f.run.id}/pause`).expect(200);
    const key = `resume-${randomUUID()}`;
    const resumed = await f.api.post(`/api/runs/${f.run.id}/resume`)
      .set('Idempotency-Key', key).send({ idempotencyKey: key }).expect(201);
    expect(resumed.body).toMatchObject({ sessionId: f.session.id, attempt: 2, status: 'queued' });
    expect(resumed.body).not.toHaveProperty('checkpointId');
    expect(await f.api.get(`/api/sessions/${f.session.id}`).expect(200).then(response => response.body.status)).toBe('queued');
  });

  it('blocks resume when the latest approved plan changed and marks expired claims as stopped', async () => {
    const f = await fixture();
    const daemonPath = `/api/daemons/${f.daemon.daemonId}`;
    const claim = await f.api.post(`${daemonPath}/claim`).set('Authorization', `Bearer ${f.daemon.authToken}`).send({}).expect(200);
    await checkpointProgress(f, claim.body.claimToken);
    await f.api.db.updateTable('execution_job').set({ lease_expires_at: new Date(Date.now() - 1) }).where('run_id', '=', f.run.id).execute();
    await f.api.post(`${daemonPath}/claim`).set('Authorization', `Bearer ${f.daemon.authToken}`).send({}).expect(204);
    expect(await f.api.get(`/api/runs/${f.run.id}`).expect(200).then(response => response.body)).toMatchObject({ status: 'paused', errorCode: 'EXECUTION_LEASE_EXPIRED' });
    expect(await f.api.get(`${daemonPath}/runs/${f.run.id}/job`).set('Authorization', `Bearer ${f.daemon.authToken}`).expect(200).then(response => response.body))
      .toMatchObject({ status: 'blocked', cancelRequested: true });

    const nextChecksum = `sha256:${'b'.repeat(64)}`;
    await f.api.db.insertInto('artifact').values({
      artifact_id: `artifact_${randomUUID()}`, project_id: 'project_dev', task_id: f.task.id,
      session_id: null, type: 'plan', version: 2, schema_version: 1, uri: `file:///tmp/plan-${randomUUID()}`,
      checksum: nextChecksum, status: 'approved', source_artifacts: '[]', created_by_type: 'user', created_by_id: 'test',
      created_at: new Date(), review_state: 'approved', reference: null, metadata: '{}',
    }).execute();
    const key = `resume-${randomUUID()}`;
    await f.api.post(`/api/runs/${f.run.id}/resume`).set('Idempotency-Key', key).send({ idempotencyKey: key }).expect(409)
      .then(response => expect(response.body.code).toBe('PLAN_HASH_STALE'));
  });
});
