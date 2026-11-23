import { describe, expect, it } from 'vitest';
import { eventEnvelopeSchema, executionConfigSchema, taskCreateRequestSchema } from '@titan/contracts';

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

  it('accepts a separate Codex API URL credential reference', () => {
    expect(executionConfigSchema.parse({
      daemonId: 'daemon_1', runtime: 'codex', credentialRef: 'keychain://titan-openai',
      baseUrlRef: 'keychain://titan-openai-base-url', workspacePath: '/workspace',
      allowedTools: ['artifact.write'], maxTurns: 3, timeoutMs: 1000,
    })).toMatchObject({ baseUrlRef: 'keychain://titan-openai-base-url' });
  });
});
