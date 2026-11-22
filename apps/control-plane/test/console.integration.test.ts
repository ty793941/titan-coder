import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp } from '../src/test-app.js';

describe('Console read-only state', () => {
  let api: Awaited<ReturnType<typeof createTestApp>>;
  const token = randomUUID();
  const originalToken = process.env.TITAN_CONSOLE_TOKEN;
  let projectId: string;
  let taskId: string;
  let sessionId: string;
  let runId: string;

  beforeAll(async () => {
    process.env.TITAN_CONSOLE_TOKEN = token;
    api = await createTestApp();
    const project = await api.post('/api/projects').send({ name: 'Console project', goal: 'Read facts', idempotencyKey: randomUUID() }).expect(201);
    projectId = project.body.id;
    const task = await api.post(`/api/projects/${projectId}/tasks`).set('Idempotency-Key', randomUUID())
      .send({ title: 'Console task', goal: 'Read state', acceptanceCriteria: ['Facts visible'], priority: 'high' }).expect(201);
    taskId = task.body.id;
    const session = await api.post(`/api/tasks/${taskId}/sessions`).set('Idempotency-Key', randomUUID())
      .send({ entryAgent: 'project-manager', goal: 'Read session' }).expect(201);
    sessionId = session.body.id;
    const run = await api.post(`/api/sessions/${sessionId}/runs`).set('Idempotency-Key', randomUUID()).send({}).expect(201);
    runId = run.body.id;
    await api.db.updateTable('session').set({ execution_config: JSON.stringify({
      daemonId: 'daemon_console', runtime: 'qwen', credentialRef: 'env:PRIVATE_KEY', workspacePath: '/work',
      allowedTools: ['artifact.write'], maxTurns: 5, timeoutMs: 1000,
      apiKey: 'never-return-this-key', permissionSnapshot: { token: 'never-return-this-token' },
      localPolicy: { enabledSkills: ['research'], trustedCode: false, secret: 'never-return-policy-secret' },
    }) }).where('id', '=', sessionId).execute();
    await api.post('/api/daemons/register').send({ machineName: 'console-machine', environmentType: 'local',
      capabilities: ['qwen'], workspaceRoots: ['/work'], maxConcurrentSessions: 1, daemonVersion: '0.1.0' }).expect(201);
  });

  afterAll(async () => {
    await api?.close();
    if (originalToken === undefined) delete process.env.TITAN_CONSOLE_TOKEN;
    else process.env.TITAN_CONSOLE_TOKEN = originalToken;
  });

  const state = (query: Record<string, string | number> = {}) => api.get('/api/console/state').set('Authorization', `Bearer ${token}`).query(query);

  it('requires a configured console token, rejects wrong and absent tokens', async () => {
    await api.get('/api/console/state').expect(401);
    await api.get('/api/console/state').set('Authorization', 'Bearer wrong').expect(401);
    delete process.env.TITAN_CONSOLE_TOKEN;
    try { await state().expect(401); } finally { process.env.TITAN_CONSOLE_TOKEN = token; }
  });

  it('returns persisted domain facts scoped to the selected task without internal secrets', async () => {
    const response = await state({ projectId, taskId }).expect(200);
    expect(Object.keys(response.body).sort()).toEqual(['daemons', 'projects', 'runs', 'sessions', 'tasks']);
    expect(response.body.projects).toEqual([expect.objectContaining({ id: projectId, name: 'Console project', goal: 'Read facts', version: 1 })]);
    expect(response.body.tasks).toEqual([expect.objectContaining({ id: taskId, projectId, stage: 'questions', acceptanceCriteria: ['Facts visible'] })]);
    expect(response.body.sessions).toEqual([expect.objectContaining({ id: sessionId, taskId, status: 'queued', execution: {
      daemonId: 'daemon_console', runtime: 'qwen', workspacePath: '/work', allowedTools: ['artifact.write'], maxTurns: 5, timeoutMs: 1000,
    } })]);
    expect(response.body.runs).toEqual([expect.objectContaining({ id: runId, sessionId, attempt: 1, status: 'queued' })]);
    expect(response.body.daemons).toContainEqual(expect.objectContaining({ machineName: 'console-machine', capabilities: ['qwen'], workspaceRoots: ['/work'] }));
    for (const secret of ['credentialRef', 'PRIVATE_KEY', 'apiKey', 'permissionSnapshot', 'localPolicy', 'authToken', 'auth_token_hash', 'claimToken', 'never-return']) {
      expect(JSON.stringify(response.body)).not.toContain(secret);
    }
    const taskOnly = await state({ taskId }).expect(200);
    expect(taskOnly.body.projects.map((item: { id: string }) => item.id)).toEqual([projectId]);
  });

  it('returns an empty child selection for projects with no tasks', async () => {
    const project = await api.post('/api/projects').send({ name: 'Empty', goal: 'No invented children', idempotencyKey: randomUUID() }).expect(201);
    const response = await state({ projectId: project.body.id }).expect(200);
    expect(response.body.tasks).toEqual([]);
    expect(response.body.sessions).toEqual([]);
    expect(response.body.runs).toEqual([]);
  });

  it('bounds every collection and keeps descendants within returned parents', async () => {
    const response = await state({ limit: 1 }).expect(200);
    for (const items of Object.values(response.body)) expect((items as unknown[]).length).toBeLessThanOrEqual(1);
    for (const task of response.body.tasks) expect(response.body.projects.some((project: { id: string }) => project.id === task.projectId)).toBe(true);
    for (const session of response.body.sessions) expect(response.body.tasks.some((task: { id: string }) => task.id === session.taskId)).toBe(true);
    for (const run of response.body.runs) expect(response.body.sessions.some((session: { id: string }) => session.id === run.sessionId)).toBe(true);
  });

  it.each([{ limit: 0 }, { limit: 101 }, { limit: 1.5 }, { limit: 'no' }, { projectId: ' ' }, { taskId: '../secret' }, { unknown: 'query' }])('validates query %j', async query => {
    const response = await state(query).expect(400);
    expect(response.body.code).toBe('VALIDATION_FAILED');
  });

  it('returns stable 404 for stale ids and mismatched project/task', async () => {
    for (const query of [{ projectId: 'project_missing' }, { taskId: 'task_missing' }, { projectId: 'project_dev', taskId }]) {
      const response = await state(query).expect(404);
      expect(response.body.code).toBe('RESOURCE_NOT_FOUND');
    }
  });

  it('defaults to at most 100 projects and still resolves a selected task outside the default window', async () => {
    const owner = await api.db.selectFrom('project').select('organization_id').where('id', '=', projectId).executeTakeFirstOrThrow();
    await api.db.insertInto('project').values(Array.from({ length: 101 }, (_, index) => ({
      id: `project_${randomUUID()}`, organization_id: owner.organization_id, name: `Project ${index}`,
      goal: 'Bounded console state', version: 1, created_at: new Date(Date.now() + 1000 + index),
    }))).execute();
    const response = await state().expect(200);
    expect(response.body.projects).toHaveLength(100);
    expect(response.body.projects.map((project: { id: string }) => project.id)).not.toContain(projectId);
    const selected = await state({ taskId, limit: 1 }).expect(200);
    expect(selected.body.projects[0].id).toBe(projectId);
    expect(selected.body.tasks[0].id).toBe(taskId);
  });
});
