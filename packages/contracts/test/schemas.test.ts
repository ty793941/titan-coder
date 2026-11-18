import { describe, expect, it } from 'vitest';
import { eventEnvelopeSchema, taskCreateRequestSchema } from '@titan/contracts';

describe('contracts', () => {
  it('accepts a task creation request with bounded fields', () => {
    expect(taskCreateRequestSchema.parse({
      title: '认证重构',
      goal: '保持登录行为并补齐回归测试',
      acceptanceCriteria: ['认证测试通过'],
      priority: 'high',
    })).toMatchObject({ priority: 'high' });
  });

  it('rejects an event without traceable identity', () => {
    expect(() => eventEnvelopeSchema.parse({
      eventId: 'evt_1',
      eventType: 'task.created',
      payloadVersion: 1,
      sequence: 1,
      projectId: 'project_1',
      actor: { type: 'system', id: 'system' },
      occurredAt: new Date().toISOString(),
      payload: {},
    })).toThrow();
  });
});
