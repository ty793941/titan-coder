import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp } from '../src/test-app.js';

type Api = Awaited<ReturnType<typeof createTestApp>>;
type Artifact = { artifactId: string; checksum: string; uri: string; version: number };
const stages = ['questions', 'research', 'design', 'structure', 'plan', 'implement'] as const;

describe('Phase 1 persistent QRSPI gates', () => {
  let api: Api;
  beforeAll(async () => { api = await createTestApp(); });
  afterAll(async () => { await api?.close(); });

  async function task() {
    const project = await api.post('/api/projects').send({ name: 'QRSPI', goal: 'Persistent gates', idempotencyKey: randomUUID() }).expect(201);
    const response = await api.post(`/api/projects/${project.body.id}/tasks`).set('Idempotency-Key', randomUUID())
      .send({ title: 'Gate task', goal: 'Approve each stage', acceptanceCriteria: ['Ordered approvals'], priority: 'high' }).expect(201);
    return response.body.id as string;
  }

  async function artifact(taskId: string, type: string, sources: string[] = []): Promise<Artifact> {
    const response = await api.post(`/api/tasks/${taskId}/artifacts`).set('Idempotency-Key', randomUUID())
      .send({ type, content: `# ${type} ${randomUUID()}`, sourceArtifacts: sources }).expect(201);
    return response.body as Artifact;
  }

  async function chain(taskId: string, count = 5) {
    const artifacts: Artifact[] = [];
    for (const type of stages.slice(0, count)) {
      const created = await artifact(taskId, type, artifacts.length ? [artifacts.at(-1)!.artifactId] : []);
      await api.post(`/api/artifacts/${created.artifactId}/approve`).expect(200);
      artifacts.push(created);
    }
    return artifacts;
  }

  it('rejects skips and unapproved stages without changing task or history', async () => {
    const id = await task();
    const skipped = await api.post(`/api/tasks/${id}/stage`).send({ stage: 'design', expectedVersion: 1 }).expect(400);
    expect(skipped.body.code).toBe('INVALID_STATE_TRANSITION');
    const missing = await api.post(`/api/tasks/${id}/stage`).send({ stage: 'research', expectedVersion: 1 }).expect(400);
    expect(missing.body.code).toBe('APPROVAL_REQUIRED');
    await artifact(id, 'questions');
    await api.post(`/api/tasks/${id}/stage`).send({ stage: 'research', expectedVersion: 1 }).expect(400);
    const current = await api.get(`/api/tasks/${id}`).expect(200);
    expect(current.body).toMatchObject({ stage: 'questions', version: 1 });
    expect((await api.get(`/api/tasks/${id}/events`)).body.map((event: { eventType: string }) => event.eventType)).not.toContain('task.stage.changed');
  });

  it('persists all six stages with atomic task versions, approval audit, events and outbox', async () => {
    const id = await task();
    let previous: Artifact | undefined;
    for (let index = 0; index < 5; index += 1) {
      const created = await artifact(id, stages[index]!, previous ? [previous.artifactId] : []);
      const originalContent = await readFile(new URL(created.uri), 'utf8');
      await api.post(`/api/artifacts/${created.artifactId}/approve`).expect(200);
      const fixed = await api.get(`/api/artifacts/${created.artifactId}`).expect(200);
      expect(fixed.body).toMatchObject({ artifactId: created.artifactId, checksum: created.checksum, status: 'approved', reviewState: 'approved', metadata: {} });
      expect(await readFile(new URL(created.uri), 'utf8')).toBe(originalContent);
      const advanced = await api.post(`/api/tasks/${id}/stage`).send({ stage: stages[index + 1], expectedVersion: index + 1 }).expect(200);
      expect(advanced.body).toMatchObject({ id, stage: stages[index + 1], version: index + 2 });
      previous = created;
    }
    const events = await api.db.selectFrom('event').selectAll().where('task_id', '=', id).orderBy('sequence').execute();
    const transitions = events.filter(event => event.event_type === 'task.stage.changed');
    expect(transitions.map(event => event.payload)).toEqual([
      expect.objectContaining({ fromStage: 'questions', toStage: 'research', version: 2 }),
      expect.objectContaining({ fromStage: 'research', toStage: 'design', version: 3 }),
      expect.objectContaining({ fromStage: 'design', toStage: 'structure', version: 4 }),
      expect.objectContaining({ fromStage: 'structure', toStage: 'plan', version: 5 }),
      expect.objectContaining({ fromStage: 'plan', toStage: 'implement', version: 6 }),
    ]);
    expect(events.map(event => Number(event.sequence))).toEqual(Array.from({ length: events.length }, (_, index) => index + 1));
    const outbox = await api.db.selectFrom('outbox_event').selectAll().where('event_id', 'in', events.map(event => event.event_id)).execute();
    expect(outbox).toHaveLength(events.length);
    for (const event of events) expect(outbox.find(row => row.event_id === event.event_id)?.payload).toEqual(event.payload);
    const approvals = events.filter(event => event.event_type === 'artifact.approved');
    expect(approvals).toHaveLength(5);
    for (const event of approvals) expect(event).toMatchObject({ actor_type: 'user', actor_id: 'local-user' });
    const audit = await api.db.selectFrom('audit_log').selectAll().where('action', '=', 'artifact.approved').execute();
    expect(audit).toHaveLength(5);
    expect(audit.every(row => row.actor_type === 'user' && row.actor_id === 'local-user')).toBe(true);
    expect(audit.map(row => row.trace_id).sort()).toEqual(approvals.map(row => row.trace_id).sort());
  });

  it('rejects malformed stage requests and reports missing tasks', async () => {
    const id = await task();
    for (const body of [null, {}, { stage: 'research', expectedVersion: '1' }, { stage: 'research', expectedVersion: 0 },
      { stage: 'research', expectedVersion: 1.5 }, { stage: 'delivered', expectedVersion: 1 }, { stage: 'research', expectedVersion: 1, actor: 'other' }]) {
      const response = await api.post(`/api/tasks/${id}/stage`).send(body).expect(400);
      expect(response.body.code).toBe('VALIDATION_FAILED');
    }
    await api.post('/api/tasks/task_missing/stage').send({ stage: 'research', expectedVersion: 1 }).expect(404);
  });

  it('rejects stale expectedVersion even when the requested transition is valid', async () => {
    const id = await task();
    await chain(id, 2);
    await api.post(`/api/tasks/${id}/stage`).send({ stage: 'research', expectedVersion: 1 }).expect(200);
    const response = await api.post(`/api/tasks/${id}/stage`).send({ stage: 'design', expectedVersion: 1 }).expect(409);
    expect(response.body.code).toBe('VERSION_CONFLICT');
    expect((await api.get(`/api/tasks/${id}`)).body).toMatchObject({ stage: 'research', version: 2 });
  });

  it('serializes two callers using the same task version into one winner', async () => {
    const id = await task();
    await chain(id, 1);
    const responses = await Promise.all([1, 2].map(() => api.post(`/api/tasks/${id}/stage`).send({ stage: 'research', expectedVersion: 1 })));
    expect(responses.map(response => response.status).sort()).toEqual([200, 409]);
    const transitions = await api.db.selectFrom('event').selectAll().where('task_id', '=', id).where('event_type', '=', 'task.stage.changed').execute();
    expect(transitions).toHaveLength(1);
    expect((await api.get(`/api/tasks/${id}`)).body.version).toBe(2);
  });

  it('requires the newest artifact to be approved and rejects approval of older versions', async () => {
    const id = await task();
    const [old] = await chain(id, 1);
    const latest = await artifact(id, 'questions');
    const stale = await api.post(`/api/artifacts/${old!.artifactId}/approve`).expect(409);
    expect(stale.body.code).toBe('VERSION_CONFLICT');
    await api.post(`/api/tasks/${id}/stage`).send({ stage: 'research', expectedVersion: 1 }).expect(400);
    await api.post(`/api/artifacts/${latest.artifactId}/approve`).expect(200);
    await api.post(`/api/tasks/${id}/stage`).send({ stage: 'research', expectedVersion: 1 }).expect(200);
    expect((await api.get(`/api/artifacts/${old!.artifactId}`)).body.version).toBe(1);
    expect((await api.get(`/api/artifacts/${latest.artifactId}`)).body.version).toBe(2);
  });

  it('serializes artifact version allocation and same-key retries', async () => {
    const id = await task();
    const versions = await Promise.all([artifact(id, 'questions'), artifact(id, 'questions')]);
    expect(versions.map(row => row.version).sort()).toEqual([1, 2]);
    const key = randomUUID();
    const responses = await Promise.all([1, 2].map(() => api.post(`/api/tasks/${id}/artifacts`).set('Idempotency-Key', key)
      .send({ type: 'research', content: '# Same request' })));
    expect(responses.map(response => response.status)).toEqual([201, 201]);
    expect(responses[0]!.body.artifactId).toBe(responses[1]!.body.artifactId);
    const rows = await api.db.selectFrom('artifact').selectAll().where('task_id', '=', id).where('type', '=', 'research').execute();
    expect(rows).toHaveLength(1);
  });

  it('checks source and session ownership against the artifact task', async () => {
    const id = await task();
    const other = await task();
    const source = await artifact(other, 'questions');
    const session = await api.post(`/api/tasks/${other}/sessions`).set('Idempotency-Key', randomUUID())
      .send({ entryAgent: 'project-manager', goal: 'Explore' }).expect(201);
    for (const fields of [{ sourceArtifacts: [source.artifactId] }, { sourceArtifacts: ['artifact_missing'] }, { sessionId: session.body.id }, { sessionId: 'session_missing' }]) {
      const response = await api.post(`/api/tasks/${id}/artifacts`).set('Idempotency-Key', randomUUID())
        .send({ type: 'research', content: '# Ownership', ...fields }).expect(400);
      expect(response.body.code).toBe('VALIDATION_FAILED');
    }
    const ownSession = await api.post(`/api/tasks/${id}/sessions`).set('Idempotency-Key', randomUUID())
      .send({ entryAgent: 'project-manager', goal: 'Explore' }).expect(201);
    await api.post(`/api/tasks/${id}/artifacts`).set('Idempotency-Key', randomUUID())
      .send({ type: 'questions', content: '# Own session', sessionId: ownSession.body.id }).expect(201);
  });

  it('rejects missing ancestry and a superseded upstream before implementation', async () => {
    const id = await task();
    const artifacts = await chain(id);
    for (let index = 1; index < 5; index += 1) await api.post(`/api/tasks/${id}/stage`).send({ stage: stages[index], expectedVersion: index }).expect(200);
    const replacement = await artifact(id, 'design', [artifacts[1]!.artifactId]);
    await api.post(`/api/artifacts/${replacement.artifactId}/approve`).expect(200);
    const response = await api.post(`/api/tasks/${id}/stage`).send({ stage: 'implement', expectedVersion: 5 }).expect(400);
    expect(response.body.code).toBe('APPROVAL_REQUIRED');
    const structure = await artifact(id, 'structure', [replacement.artifactId]);
    await api.post(`/api/artifacts/${structure.artifactId}/approve`).expect(200);
    const unlinkedPlan = await artifact(id, 'plan');
    await api.post(`/api/artifacts/${unlinkedPlan.artifactId}/approve`).expect(200);
    await api.post(`/api/tasks/${id}/stage`).send({ stage: 'implement', expectedVersion: 5 }).expect(400);
    const plan = await artifact(id, 'plan', [structure.artifactId]);
    await api.post(`/api/artifacts/${plan.artifactId}/approve`).expect(200);
    await api.post(`/api/tasks/${id}/stage`).send({ stage: 'implement', expectedVersion: 5 }).expect(200);
  });

  it('keeps exploration CRUD and plan-only approval compatible, but cannot bypass task gates', async () => {
    const id = await task();
    const plan = await artifact(id, 'plan');
    await api.post(`/api/artifacts/${plan.artifactId}/approve`).expect(200);
    await api.post(`/api/tasks/${id}/sessions`).set('Idempotency-Key', randomUUID())
      .send({ entryAgent: 'project-manager', goal: 'Explore', planHash: plan.checksum }).expect(201);
    await api.post(`/api/tasks/${id}/stage`).send({ stage: 'implement', expectedVersion: 1 }).expect(400);
    const source = await artifact(id, 'source-diff');
    const response = await api.post(`/api/artifacts/${source.artifactId}/approve`).expect(400);
    expect(response.body.code).toBe('INVALID_STATE_TRANSITION');
  });

  it('returns fixed metadata, validates stored metadata and never reads a supplied file path', async () => {
    const id = await task();
    const first = await artifact(id, 'questions');
    await artifact(id, 'questions');
    const response = await api.get(`/api/artifacts/${first.artifactId}?path=/etc/passwd&content=true`).expect(200);
    expect(response.body).toMatchObject({ artifactId: first.artifactId, version: 1, checksum: first.checksum });
    expect(response.body.content).toBeUndefined();
    await api.get('/api/artifacts/artifact_missing').expect(404);
    await api.db.updateTable('artifact').set({ metadata: JSON.stringify(['invalid']) }).where('artifact_id', '=', first.artifactId).execute();
    const invalid = await api.get(`/api/artifacts/${first.artifactId}`).expect(400);
    expect(invalid.body.code).toBe('VALIDATION_FAILED');
  });

  it('rolls back stage and event writes when the outbox rejects the transition', async () => {
    const id = await task();
    await chain(id, 1);
    const before = await api.db.selectFrom('event').selectAll().where('task_id', '=', id).execute();
    await sql`alter table outbox_event add constraint gates_reject_stage check (payload->>'toStage' is distinct from 'research') not valid`.execute(api.db);
    try {
      await api.post(`/api/tasks/${id}/stage`).send({ stage: 'research', expectedVersion: 1 }).expect(500);
      expect((await api.get(`/api/tasks/${id}`)).body).toMatchObject({ stage: 'questions', version: 1 });
      expect(await api.db.selectFrom('event').selectAll().where('task_id', '=', id).execute()).toEqual(before);
    } finally {
      await sql`alter table outbox_event drop constraint gates_reject_stage`.execute(api.db);
    }
  });

  it('rolls back approval and audit on outbox failure and makes repeated approval idempotent', async () => {
    const id = await task();
    const created = await artifact(id, 'questions');
    await sql`alter table outbox_event add constraint gates_reject_approval check (payload->>'artifactId' is distinct from ${sql.lit(created.artifactId)} or payload->>'decision' is distinct from 'approved')`.execute(api.db);
    try {
      await api.post(`/api/artifacts/${created.artifactId}/approve`).expect(500);
      expect((await api.get(`/api/artifacts/${created.artifactId}`)).body).toMatchObject({ status: 'draft', reviewState: 'pending' });
      expect(await api.db.selectFrom('audit_log').selectAll().where('target_id', '=', created.artifactId).execute()).toHaveLength(0);
      expect(await api.db.selectFrom('event').selectAll().where('task_id', '=', id).where('event_type', '=', 'artifact.approved').execute()).toHaveLength(0);
    } finally {
      await sql`alter table outbox_event drop constraint gates_reject_approval`.execute(api.db);
    }
    const responses = await Promise.all([1, 2].map(() => api.post(`/api/artifacts/${created.artifactId}/approve`)));
    expect(responses.map(response => response.status)).toEqual([200, 200]);
    expect(await api.db.selectFrom('audit_log').selectAll().where('target_id', '=', created.artifactId).execute()).toHaveLength(1);
  });
});
