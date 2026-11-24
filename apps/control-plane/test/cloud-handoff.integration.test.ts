import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp } from '../src/test-app.js';

let api: Awaited<ReturnType<typeof createTestApp>>;
const consoleToken = `test-console-${randomUUID()}`;
const oldToken = process.env.TITAN_CONSOLE_TOKEN;
const manifest = () => ({ schemaVersion: 1, snapshotId: `snapshot_${randomUUID()}`, baseRevision: 'a'.repeat(40), checksum: `sha256:${'b'.repeat(64)}`, fileCount: 2, totalBytes: 100 });
const auth = (token: string) => `Bearer ${token}`;
const cloudCapabilities = ['codex', 'cloud-session', 'container', 'snapshot-transfer', 'secret-lease'];

beforeAll(async () => { process.env.TITAN_CONSOLE_TOKEN = consoleToken; api = await createTestApp(); }, 20000);
afterAll(async () => { await api?.close(); if (oldToken === undefined) delete process.env.TITAN_CONSOLE_TOKEN; else process.env.TITAN_CONSOLE_TOKEN = oldToken; });

async function fixture(capabilities = cloudCapabilities) {
  await api.db.updateTable('daemon').set({ status: 'revoked' }).where('environment_type', '=', 'cloud').execute();
  const source = (await api.post('/api/daemons/register').send({ machineName: 'source', environmentType: 'local', capabilities: ['codex'], workspaceRoots: ['/tmp/titan'], maxConcurrentSessions: 1, daemonVersion: '0.2.0' }).expect(201)).body;
  const target = (await api.post('/api/daemons/register').send({ machineName: 'cloud', environmentType: 'cloud', capabilities, workspaceRoots: ['/var/lib/titan/cloud'], maxConcurrentSessions: 10, daemonVersion: '0.2.0' }).expect(201)).body;
  const task = (await api.post('/api/projects/project_dev/tasks').send({ title: 'handoff', goal: 'continue in cloud', acceptanceCriteria: ['done'], priority: 'high', idempotencyKey: randomUUID() }).expect(201)).body;
  const planHash = `sha256:${'c'.repeat(64)}`;
  await api.db.insertInto('artifact').values({ artifact_id: `artifact_${randomUUID()}`, project_id: 'project_dev', task_id: task.id, session_id: null, type: 'plan', version: 1, schema_version: 1, uri: `file:///tmp/${randomUUID()}`, checksum: planHash, status: 'approved', source_artifacts: '[]', created_by_type: 'user', created_by_id: 'test', created_at: new Date(), review_state: 'approved', reference: null, metadata: '{}' }).execute();
  const session = (await api.post(`/api/tasks/${task.id}/sessions`).send({ entryAgent: 'project-manager', goal: 'continue', planHash, execution: { daemonId: source.daemonId, runtime: 'codex', credentialRef: 'keychain://codex', baseUrlRef: 'keychain://url', workspacePath: '/tmp/titan/repo', allowedTools: ['artifact.write'], maxTurns: 3, timeoutMs: 60000 }, idempotencyKey: randomUUID() }).expect(201)).body;
  const run = (await api.post(`/api/sessions/${session.id}/runs`).send({ idempotencyKey: randomUUID() }).expect(201)).body;
  const dispatch = (await api.post(`/api/daemons/${source.daemonId}/claim`).set('Authorization', auth(source.authToken)).send({}).expect(200)).body;
  const checkpoint = { id: `cp_${randomUUID()}`, messages: [{ role: 'assistant', text: 'portable context' }], successfulTools: [{ id: 'write_1', name: 'workspace.write', inputHash: 'hash', output: { path: '/tmp/titan/repo/result' } }], evidence: [{ kind: 'file', reference: 'file:///tmp/source-only' }] };
  await api.post(`/api/daemons/${source.daemonId}/runs/${run.id}/progress`).set('Authorization', auth(source.authToken)).send({ eventId: randomUUID(), sequence: 1, claimToken: dispatch.claimToken, type: 'checkpoint', payload: {}, checkpoint }).expect(200);
  await api.post(`/api/runs/${run.id}/pause`).expect(200);
  return { source, target, task, session, run, checkpoint };
}

async function requested(f: Awaited<ReturnType<typeof fixture>>, key = randomUUID()) {
  const body = { checkpointId: f.checkpoint.id, targetEnvironment: 'cloud', workspaceSync: { mode: 'git-snapshot' }, idempotencyKey: key };
  const response = await api.post(`/api/sessions/${f.session.id}/handoff`).set('Authorization', auth(consoleToken)).send(body).expect(201);
  return { body, handoff: response.body };
}

async function ready() {
  const f = await fixture();
  const { handoff } = await requested(f);
  const snapshot = manifest();
  const started = (await api.post(`/api/daemons/${f.source.daemonId}/handoffs/${handoff.id}/snapshot`).set('Authorization', auth(f.source.authToken)).send({ manifest: snapshot, stopped: true }).expect(200)).body;
  const dispatch = (await api.post(`/api/daemons/${f.target.daemonId}/claim`).set('Authorization', auth(f.target.authToken)).send({}).expect(200)).body;
  return { ...f, handoff: started, snapshot, dispatch };
}

describe('bounded cloud control plane', () => {
  it('requires management auth and records only requested until a source daemon acknowledges a snapshot', async () => {
    const f = await fixture();
    const body = { checkpointId: f.checkpoint.id, targetEnvironment: 'cloud', workspaceSync: { mode: 'git-patch' }, idempotencyKey: randomUUID() };
    await api.post(`/api/sessions/${f.session.id}/handoff`).send(body).expect(401);
    const { handoff, body: request } = await requested(f);
    expect(handoff).toMatchObject({ status: 'requested', sourceSessionId: f.session.id, sourceRunId: f.run.id, checkpointId: f.checkpoint.id, requestedBy: 'local-user' });
    expect(handoff.targetSessionId).toBeNull();
    const replay = await api.post(`/api/sessions/${f.session.id}/handoff`).set('Authorization', auth(consoleToken)).send(request).expect(200);
    expect(replay.body.id).toBe(handoff.id);
    await api.post(`/api/sessions/${f.session.id}/handoff`).set('Authorization', auth(consoleToken)).send({ ...request, workspaceSync: { mode: 'git-patch' } }).expect(409);
    await api.get(`/api/handoffs/${handoff.id}`).expect(401);
    const pending = await api.get(`/api/daemons/${f.source.daemonId}/handoffs/pending`).set('Authorization', auth(f.source.authToken)).expect(200);
    expect(pending.body.requests).toEqual([expect.objectContaining({ id: handoff.id, workspacePath: '/tmp/titan/repo', checkpointId: f.checkpoint.id })]);
    expect((await api.get(`/api/daemons/${f.target.daemonId}/handoffs/pending`).set('Authorization', auth(f.target.authToken)).expect(200)).body.requests).toEqual([]);
    await api.post(`/api/daemons/${f.target.daemonId}/handoffs/${handoff.id}/snapshot`).set('Authorization', auth(f.target.authToken)).send({ manifest: manifest(), stopped: true }).expect(403);
    await api.post(`/api/daemons/${f.source.daemonId}/handoffs/${handoff.id}/snapshot`).set('Authorization', auth(f.source.authToken)).send({ manifest: manifest(), stopped: false }).expect(400);
  });

  it('atomically imports portable context and dispatches a child cloud session exactly once', async () => {
    const f = await ready();
    expect(f.dispatch.config).toMatchObject({ environmentType: 'cloud', workspacePath: '/workspace/session', baseUrlRef: 'keychain://url', snapshotManifestRef: `snapshot://${f.snapshot.snapshotId}` });
    expect(f.dispatch.cloud).toMatchObject({ snapshot: f.snapshot, executionId: expect.any(String), secretLeaseId: expect.any(String), secretLeaseExpiresAt: expect.any(String) });
    expect(f.dispatch.checkpoint).toMatchObject({ messages: f.checkpoint.messages, successfulTools: [], evidence: [] });
    expect(f.dispatch.checkpoint.id).not.toBe(f.checkpoint.id);
    const session = await api.get(`/api/sessions/${f.dispatch.sessionId}`).expect(200);
    expect(session.body).toMatchObject({ parentSessionId: f.session.id, environmentType: 'cloud' });
    const copied = await api.db.selectFrom('checkpoint').selectAll().where('id', '=', f.dispatch.checkpoint.id).executeTakeFirstOrThrow();
    expect(copied.source_checkpoint_id).toBe(f.checkpoint.id);
    const replay = await api.post(`/api/daemons/${f.source.daemonId}/handoffs/${f.handoff.id}/snapshot`).set('Authorization', auth(f.source.authToken)).send({ manifest: f.snapshot, stopped: true }).expect(200);
    expect(replay.body.targetSessionId).toBe(f.dispatch.sessionId);
    await api.post(`/api/daemons/${f.source.daemonId}/handoffs/${f.handoff.id}/snapshot`).set('Authorization', auth(f.source.authToken)).send({ manifest: manifest(), stopped: true }).expect(409);
    expect(await api.db.selectFrom('run').select('id').where('session_id', '=', f.dispatch.sessionId).execute()).toHaveLength(1);
  });

  it('authenticates lifecycle, consumes a secret once, keeps run status separate and synchronizes terminal progress', async () => {
    const f = await ready();
    const path = `/api/daemons/${f.target.daemonId}/runs/${f.dispatch.runId}`;
    const body = { claimToken: f.dispatch.claimToken, status: 'creating', consumeSecret: true };
    await api.post(`${path}/cloud`).send(body).expect(401);
    await api.post(`${path}/cloud`).set('Authorization', auth(f.target.authToken)).send({ ...body, claimToken: 'wrong' }).expect(403);
    const consumed = await api.post(`${path}/cloud`).set('Authorization', auth(f.target.authToken)).send(body).expect(200);
    expect(consumed.body.secretConsumed).toBe(true);
    await api.post(`${path}/cloud`).set('Authorization', auth(f.target.authToken)).send(body).expect(409);
    for (const status of ['starting', 'running']) await api.post(`${path}/cloud`).set('Authorization', auth(f.target.authToken)).send({ claimToken: f.dispatch.claimToken, status, containerId: 'container_1' }).expect(200);
    expect((await api.get(`/api/runs/${f.dispatch.runId}`).expect(200)).body.status).toBe('queued');
    await api.post(`${path}/progress`).set('Authorization', auth(f.target.authToken)).send({ claimToken: f.dispatch.claimToken, eventId: randomUUID(), sequence: 1, type: 'completed', payload: {} }).expect(200);
    const execution = await api.get(`/api/cloud-executions/${f.dispatch.cloud.executionId}`).set('Authorization', auth(consoleToken)).expect(200);
    expect(execution.body.status).toBe('completed');
    expect((await api.get(`/api/handoffs/${f.handoff.id}`).set('Authorization', auth(consoleToken)).expect(200)).body.status).toBe('completed');
    const events = await api.db.selectFrom('event').innerJoin('outbox_event', 'event.event_id', 'outbox_event.event_id').select('event.event_type').where('run_id', '=', f.dispatch.runId).execute();
    expect(events.map(e => e.event_type)).toContain('container.started');
    expect(events.map(e => e.event_type)).toContain('container.stopped');
    expect(JSON.stringify(execution.body)).not.toContain(f.dispatch.claimToken);
    const lease = await api.db.selectFrom('secret_lease').selectAll().where('id', '=', f.dispatch.cloud.secretLeaseId).executeTakeFirstOrThrow();
    expect(lease.consumed_at).toBeTruthy();
    expect(lease.credential_ref).toBe('keychain://codex');
  });

  it('renews both execution leases and fences an expired cloud claim without reexecution', async () => {
    const f = await ready();
    const path = `/api/daemons/${f.target.daemonId}/runs/${f.dispatch.runId}`;
    const near = new Date(Date.now() + 1000);
    await api.db.updateTable('execution_job').set({ lease_expires_at: near }).where('run_id', '=', f.dispatch.runId).execute();
    await api.db.updateTable('cloud_execution').set({ lease_expires_at: near }).where('id', '=', f.dispatch.cloud.executionId).execute();
    await api.get(`${path}/control`).set('Authorization', auth(f.target.authToken)).expect(200);
    const renewed = await api.db.selectFrom('cloud_execution').selectAll().where('id', '=', f.dispatch.cloud.executionId).executeTakeFirstOrThrow();
    expect(renewed.lease_expires_at!.getTime()).toBeGreaterThan(near.getTime());
    await api.db.updateTable('execution_job').set({ lease_expires_at: new Date(Date.now() - 1) }).where('run_id', '=', f.dispatch.runId).execute();
    await api.post(`${path}/cloud`).set('Authorization', auth(f.target.authToken)).send({ claimToken: f.dispatch.claimToken, status: 'creating' }).expect(403);
    await api.post(`/api/daemons/${f.target.daemonId}/claim`).set('Authorization', auth(f.target.authToken)).send({}).expect(204);
    expect((await api.get(`/api/sessions/${f.dispatch.sessionId}`).expect(200)).body.status).toBe('reconnecting');
    expect((await api.db.selectFrom('execution_job').selectAll().where('run_id', '=', f.dispatch.runId).executeTakeFirstOrThrow()).status).toBe('blocked');
    await api.post(`/api/daemons/${f.target.daemonId}/claim`).set('Authorization', auth(f.target.authToken)).send({}).expect(204);
  });

  it('cancels through management auth, revokes the lease and remains idempotent', async () => {
    const f = await ready();
    const path = `/api/cloud-executions/${f.dispatch.cloud.executionId}`;
    await api.get(path).expect(401);
    await api.post(`${path}/cancel`).send({}).expect(401);
    const key = randomUUID();
    const first = await api.post(`${path}/cancel`).set('Authorization', auth(consoleToken)).set('Idempotency-Key', key).send({}).expect(200);
    const second = await api.post(`${path}/cancel`).set('Authorization', auth(consoleToken)).set('Idempotency-Key', key).send({}).expect(200);
    expect(second.body).toEqual(first.body);
    expect(first.body.status).toBe('cancelled');
    expect((await api.get(`/api/runs/${f.dispatch.runId}`).expect(200)).body.status).toBe('cancelled');
    expect((await api.db.selectFrom('secret_lease').selectAll().where('id', '=', f.dispatch.cloud.secretLeaseId).executeTakeFirstOrThrow()).revoked_at).toBeTruthy();
  });

  it('requires every cloud capability and preserves a requested handoff when no eligible target exists', async () => {
    const f = await fixture(cloudCapabilities.filter(value => value !== 'secret-lease'));
    const { handoff } = await requested(f);
    const path = `/api/daemons/${f.source.daemonId}/handoffs/${handoff.id}/snapshot`;
    const snapshot = manifest();
    const missing = await api.post(path).set('Authorization', auth(f.source.authToken)).send({ manifest: snapshot, stopped: true }).expect(409);
    expect(missing.body.code).toBe('HANDOFF_TARGET_UNAVAILABLE');
    expect((await api.get(`/api/handoffs/${handoff.id}`).set('Authorization', auth(consoleToken)).expect(200)).body.status).toBe('requested');
    await api.db.updateTable('daemon').set({ capabilities: JSON.stringify(cloudCapabilities) }).where('id', '=', f.target.daemonId).execute();
    const responses = await Promise.all([1, 2].map(() => api.post(path).set('Authorization', auth(f.source.authToken)).send({ manifest: snapshot, stopped: true })));
    expect(responses.map(response => response.status)).toEqual([200, 200]);
    expect(responses[0]!.body.targetSessionId).toBe(responses[1]!.body.targetSessionId);
  });

  it('fences disconnected executions during management observation without requiring a new claim', async () => {
    const f = await ready();
    await api.db.updateTable('daemon').set({ last_heartbeat_at: new Date(Date.now() - 100000) }).where('id', '=', f.target.daemonId).execute();
    const response = await api.get(`/api/cloud-executions/${f.dispatch.cloud.executionId}`).set('Authorization', auth(consoleToken)).expect(200);
    expect(response.body.errorCode).toBe('CLOUD_WORKER_DISCONNECTED');
    expect((await api.get(`/api/sessions/${f.dispatch.sessionId}`).expect(200)).body.status).toBe('reconnecting');
    const job = await api.db.selectFrom('execution_job').selectAll().where('run_id', '=', f.dispatch.runId).executeTakeFirstOrThrow();
    expect(job).toMatchObject({ status: 'blocked', claim_token_hash: null, cancel_requested: true });
  });

  it('consumes a secret with compare-and-set and rejects expired credentials and impossible lifecycle transitions', async () => {
    const f = await ready();
    const path = `/api/daemons/${f.target.daemonId}/runs/${f.dispatch.runId}/cloud`;
    const headers = auth(f.target.authToken);
    await api.post(path).set('Authorization', headers).send({ claimToken: f.dispatch.claimToken, status: 'running' }).expect(400);
    const body = { claimToken: f.dispatch.claimToken, status: 'creating', consumeSecret: true };
    const results = await Promise.all([1, 2].map(() => api.post(path).set('Authorization', headers).send(body)));
    expect(results.map(value => value.status).sort()).toEqual([200, 409]);
    expect((await api.db.selectFrom('audit_log').select('id').where('target_id', '=', f.dispatch.cloud.secretLeaseId).execute())).toHaveLength(1);
    await api.post(path).set('Authorization', headers).send({ claimToken: f.dispatch.claimToken, status: 'starting', containerId: 'container_a' }).expect(200);
    await api.post(path).set('Authorization', headers).send({ claimToken: f.dispatch.claimToken, status: 'running', containerId: 'container_b' }).expect(409);
    const g = await ready();
    await api.db.updateTable('secret_lease').set({ expires_at: new Date(Date.now() - 1) }).where('id', '=', g.dispatch.cloud.secretLeaseId).execute();
    const expired = await api.post(`/api/daemons/${g.target.daemonId}/runs/${g.dispatch.runId}/cloud`).set('Authorization', auth(g.target.authToken)).send({ claimToken: g.dispatch.claimToken, status: 'creating', consumeSecret: true }).expect(409);
    expect(expired.body.code).toBe('CLOUD_SECRET_LEASE_EXPIRED');
  });

  it('blocks cross-session checkpoints, resumed sources and unregistered cloud creation paths', async () => {
    const f = await fixture();
    const g = await fixture();
    const body = { checkpointId: g.checkpoint.id, targetEnvironment: 'cloud', workspaceSync: { mode: 'git-patch' }, idempotencyKey: randomUUID() };
    await api.post(`/api/sessions/${f.session.id}/handoff`).set('Authorization', auth(consoleToken)).send(body).expect(400);
    const { handoff } = await requested(f);
    await api.post(`/api/runs/${f.run.id}/resume`).send({ idempotencyKey: randomUUID() }).expect(201);
    await api.post(`/api/daemons/${f.source.daemonId}/handoffs/${handoff.id}/snapshot`).set('Authorization', auth(f.source.authToken)).send({ manifest: manifest(), stopped: true }).expect(400);
    const cloud = await ready();
    await api.post(`/api/sessions/${cloud.dispatch.sessionId}/runs`).send({ idempotencyKey: randomUUID() }).expect(400);
  });

  it('does not starve the daemon queue on an expired unclaimed secret lease', async () => {
    const f = await fixture();
    const { handoff } = await requested(f);
    const created = await api.post(`/api/daemons/${f.source.daemonId}/handoffs/${handoff.id}/snapshot`).set('Authorization', auth(f.source.authToken)).send({ manifest: manifest(), stopped: true }).expect(200);
    await api.db.updateTable('secret_lease').set({ expires_at: new Date(Date.now() - 1) }).where('session_id', '=', created.body.targetSessionId).execute();
    await api.post(`/api/daemons/${f.target.daemonId}/claim`).set('Authorization', auth(f.target.authToken)).send({}).expect(204);
    expect((await api.get(`/api/sessions/${created.body.targetSessionId}`).expect(200)).body.status).toBe('waiting_input');
    expect((await api.get(`/api/handoffs/${handoff.id}`).set('Authorization', auth(consoleToken)).expect(200)).body).toMatchObject({ status: 'failed', errorCode: 'CLOUD_SECRET_LEASE_EXPIRED' });
  });

  it('closes the cloud container attempt on waiting_input while retaining the run waiting state', async () => {
    const f = await ready();
    await api.post(`/api/daemons/${f.target.daemonId}/runs/${f.dispatch.runId}/progress`).set('Authorization', auth(f.target.authToken)).send({ claimToken: f.dispatch.claimToken, eventId: randomUUID(), sequence: 1, type: 'waiting_input', payload: { message: 'credential unavailable' } }).expect(200);
    expect((await api.get(`/api/runs/${f.dispatch.runId}`).expect(200)).body.status).toBe('waiting_input');
    expect((await api.get(`/api/cloud-executions/${f.dispatch.cloud.executionId}`).set('Authorization', auth(consoleToken)).expect(200)).body.status).toBe('failed');
  });

  it('requires console auth for legacy cloud run mutations without changing local pause authentication', async () => {
    const f = await ready();
    for (const action of ['pause', 'cancel', 'resume']) await api.post(`/api/runs/${f.dispatch.runId}/${action}`).send({ idempotencyKey: randomUUID() }).expect(401);
    await api.post(`/api/runs/${f.dispatch.runId}/cancel`).set('Authorization', auth(consoleToken)).send({}).expect(200);
    expect((await api.get(`/api/cloud-executions/${f.dispatch.cloud.executionId}`).set('Authorization', auth(consoleToken)).expect(200)).body.status).toBe('cancelled');
  });

  it('rejects progress and control renewal when only the cloud execution lease expired', async () => {
    const f = await ready();
    await api.db.updateTable('cloud_execution').set({ lease_expires_at: new Date(Date.now() - 1) }).where('id', '=', f.dispatch.cloud.executionId).execute();
    const path = `/api/daemons/${f.target.daemonId}/runs/${f.dispatch.runId}`;
    await api.post(`${path}/progress`).set('Authorization', auth(f.target.authToken)).send({ claimToken: f.dispatch.claimToken, eventId: randomUUID(), sequence: 1, type: 'completed', payload: {} }).expect(403);
    expect((await api.get(`${path}/control`).set('Authorization', auth(f.target.authToken)).expect(200)).body).toMatchObject({ status: 'reconnecting', cancelRequested: true });
    expect((await api.get(`/api/sessions/${f.dispatch.sessionId}`).expect(200)).body.status).toBe('reconnecting');
  });
});
