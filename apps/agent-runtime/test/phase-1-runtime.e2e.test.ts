import { describe, expect, it } from 'vitest';
import { FakeAdapter } from '@titan/agent-core';
import { createRuntime } from '../src/main.js';

describe('Phase 1 runtime vertical slice', () => {
  it('keeps a goal active when the first model turn has no evidence', async () => {
    const runtime = createRuntime(new FakeAdapter([{ type: 'text', payload: 'continue' }, { type: 'completed' }]));
    const result = await runtime.run({ runId: 'run_runtime_1', goal: '生成可审阅产物' });
    expect(result.status).toBe('continue');
  });
});
