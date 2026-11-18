import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';

describe('Phase 1 headless vertical slice', () => {
  it('completes the local flow with a failed run, retry, artifacts and SSE evidence', async () => {
    const { createTestApp } = await import('../src/test-app.js');
    const api = await createTestApp();
    const suffix = randomUUID();
    const project = await api.post('/api/projects').send({ name: 'Phase 1', goal: '验证本机闭环', idempotencyKey: `project-${suffix}` }).expect(201);
    const task = await api.post(`/api/projects/${project.body.id}/tasks`)
      .set('Idempotency-Key', `task-${suffix}`)
      .send({ title: 'Headless MVP', goal: '验证可恢复交付', acceptanceCriteria: ['测试通过'], priority: 'high' })
      .expect(201);
    const session = await api.post(`/api/tasks/${task.body.id}/sessions`)
      .set('Idempotency-Key', `session-${suffix}`)
      .send({ entryAgent: 'project-manager', goal: '完成第一阶段', idempotencyKey: `session-${suffix}` })
      .expect(201);
    const failedRun = await api.post(`/api/sessions/${session.body.id}/runs`)
      .set('Idempotency-Key', `run-${suffix}-1`)
      .send({ idempotencyKey: `run-${suffix}-1` })
      .expect(201);
    await api.post(`/api/runs/${failedRun.body.id}/fail`).send({ errorCode: 'TOOL_EXECUTION_FAILED' }).expect(204);
    const resumedRun = await api.post(`/api/sessions/${session.body.id}/runs`)
      .set('Idempotency-Key', `run-${suffix}-2`)
      .send({ idempotencyKey: `run-${suffix}-2`, checkpointId: 'checkpoint_phase_1' })
      .expect(201);
    await api.post(`/api/runs/${resumedRun.body.id}/complete`).expect(204);

    for (const type of ['questions', 'plan', 'source-diff', 'test-report']) {
      await api.post(`/api/tasks/${task.body.id}/artifacts`)
        .set('Idempotency-Key', `${type}-${suffix}`)
        .send({ type, content: `# ${type}`, sourceArtifacts: [] })
        .expect(201);
    }

    const artifacts = await api.get(`/api/tasks/${task.body.id}/artifacts`).expect(200);
    expect(artifacts.body.map((artifact: { type: string }) => artifact.type)).toEqual(expect.arrayContaining(['questions', 'plan', 'source-diff', 'test-report']));
    const events = await api.get(`/api/runs/${resumedRun.body.id}/events`).expect(200);
    expect(events.text).toContain('event: run.completed');
    const oldRun = await api.get(`/api/runs/${failedRun.body.id}`).expect(200);
    expect(oldRun.body.errorCode).toBe('TOOL_EXECUTION_FAILED');
    await api.close();
  }, 15000);
});
