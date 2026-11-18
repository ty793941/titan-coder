import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';

describe('Artifact approval gate', () => {
  it('approves a plan and accepts a session bound to its checksum', async () => {
    const { createTestApp } = await import('../src/test-app.js');
    const api = await createTestApp();
    const suffix = randomUUID();
    const project = await api.post('/api/projects').send({ name: 'Plan Gate', goal: '验证 Plan 门禁', idempotencyKey: `project-${suffix}` }).expect(201);
    const task = await api.post(`/api/projects/${project.body.id}/tasks`)
      .set('Idempotency-Key', `task-${suffix}`)
      .send({ title: 'Plan Gate Task', goal: '绑定批准计划', acceptanceCriteria: ['Plan 已批准'], priority: 'high' })
      .expect(201);
    const plan = await api.post(`/api/tasks/${task.body.id}/artifacts`)
      .set('Idempotency-Key', `plan-${suffix}`)
      .send({ type: 'plan', content: '# Plan v1', sourceArtifacts: [] })
      .expect(201);

    await api.post(`/api/artifacts/${plan.body.artifactId}/approve`).expect(200);
    const approved = await api.get(`/api/tasks/${task.body.id}/artifacts?resolution=latest-approved`).expect(200);
    expect(approved.body).toHaveLength(1);
    expect(approved.body[0].artifactId).toBe(plan.body.artifactId);
    expect(approved.body[0].reviewState).toBe('approved');

    const session = await api.post(`/api/tasks/${task.body.id}/sessions`)
      .set('Idempotency-Key', `session-${suffix}`)
      .send({ entryAgent: 'project-manager', goal: '使用批准计划', planHash: plan.checksum, idempotencyKey: `session-${suffix}` })
      .expect(201);
    expect(session.body.planHash).toBe(plan.checksum);
    await api.close();
  });

  it('rejects a session with a stale plan hash', async () => {
    const { createTestApp } = await import('../src/test-app.js');
    const api = await createTestApp();
    const suffix = randomUUID();
    await api.post('/api/tasks/task_dev/sessions')
      .set('Idempotency-Key', `stale-session-${suffix}`)
      .send({ entryAgent: 'project-manager', goal: '拒绝过期计划', planHash: 'sha256:stale', idempotencyKey: `stale-session-${suffix}` })
      .expect(409);
    await api.close();
  });
});
