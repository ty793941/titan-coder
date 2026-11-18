import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';

describe('Control Plane task API', () => {
  it('creates a project and task with a traceable task.created event', async () => {
    const { createTestApp } = await import('../src/test-app.js');
    const api = await createTestApp();
    const suffix = randomUUID();
    const project = await api.post('/api/projects').send({
      name: 'Titan',
      goal: '验证交付闭环',
      idempotencyKey: `project-create-${suffix}`,
    }).expect(201);
    const task = await api.post(`/api/projects/${project.body.id}/tasks`)
      .set('Idempotency-Key', `task-create-${suffix}`)
      .send({
        title: '首个任务',
        goal: '验证 Task 到 Run',
        acceptanceCriteria: ['Run 可恢复'],
        priority: 'high',
      })
      .expect(201);

    expect(task.body.stage).toBe('questions');
    expect(task.body.status).toBe('active');

    const events = await api.get(`/api/tasks/${task.body.id}/events`).expect(200);
    expect(events.body).toContainEqual(expect.objectContaining({ eventType: 'task.created' }));
    await api.close();
  });

  it('returns the original task for a repeated idempotency key', async () => {
    const { createTestApp } = await import('../src/test-app.js');
    const api = await createTestApp();
    const suffix = randomUUID();
    const payload = {
      title: '幂等任务',
      goal: '验证重复请求不会创建两条记录',
      acceptanceCriteria: ['只有一个任务'],
      priority: 'medium',
    };
    const first = await api.post('/api/projects/project_dev/tasks')
      .set('Idempotency-Key', `task-create-${suffix}`)
      .send(payload)
      .expect(201);
    const second = await api.post('/api/projects/project_dev/tasks')
      .set('Idempotency-Key', `task-create-${suffix}`)
      .send(payload)
      .expect(201);

    expect(second.body.id).toBe(first.body.id);
    await api.close();
  });
});
