import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';

describe('Control Plane run API', () => {
  it('creates a second run after failure and preserves the first run', async () => {
    const { createTestApp } = await import('../src/test-app.js');
    const api = await createTestApp();
    const suffix = randomUUID();
    const session = await api.post('/api/tasks/task_dev/sessions')
      .set('Idempotency-Key', `session-create-${suffix}`)
      .send({
        entryAgent: 'project-manager',
        goal: '验证运行重试',
        idempotencyKey: `session-create-${suffix}`,
      })
      .expect(201);
    const first = await api.post(`/api/sessions/${session.body.id}/runs`)
      .set('Idempotency-Key', `run-create-${suffix}-1`)
      .send({ idempotencyKey: `run-create-${suffix}-1` })
      .expect(201);

    await api.post(`/api/runs/${first.body.id}/fail`)
      .send({ errorCode: 'TOOL_EXECUTION_FAILED' })
      .expect(204);
    const retry = await api.post(`/api/sessions/${session.body.id}/runs`)
      .set('Idempotency-Key', `run-create-${suffix}-2`)
      .send({ idempotencyKey: `run-create-${suffix}-2` })
      .expect(201);

    expect(retry.body.attempt).toBe(2);
    const oldRun = await api.get(`/api/runs/${first.body.id}`).expect(200);
    expect(oldRun.body.errorCode).toBe('TOOL_EXECUTION_FAILED');
    await api.close();
  });
});
