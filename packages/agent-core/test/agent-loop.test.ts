import { describe, expect, it } from 'vitest';
import { AgentLoop } from '../src/agent-loop.js';
import { CheckpointStore } from '../src/checkpoints.js';
import { GoalGate } from '../src/goal-gate.js';
import { HookRunner } from '../src/hook-runner.js';
import { PermissionEngine } from '../src/permission-engine.js';
import { ToolRegistry } from '../src/tool-registry.js';
import { FakeAdapter } from '../src/adapters/fake-adapter.js';

describe('AgentLoop', () => {
  it('does not stop merely because the adapter emitted no tool call', async () => {
    const adapter = new FakeAdapter([{ type: 'text', text: '需要继续验证' }, { type: 'completed' }]);
    const loop = new AgentLoop({
      adapter,
      tools: new ToolRegistry({ permission: new PermissionEngine([]), hooks: new HookRunner([]) }),
      checkpoints: new CheckpointStore(),
      goalGate: new GoalGate(),
    });

    const result = await loop.run({ runId: 'run_1', goal: '生成带证据的结果' });
    expect(result.status).toBe('waiting_input');
  });

  it('resumes from the latest successful checkpoint without repeating a tool', async () => {
    const checkpoints = new CheckpointStore();
    await checkpoints.save({ id: 'checkpoint_2', runId: 'run_1', successfulToolUseIds: ['tool_1'], evidence: [] });
    const loop = new AgentLoop({
      adapter: new FakeAdapter([]),
      tools: new ToolRegistry({ permission: new PermissionEngine([]), hooks: new HookRunner([]) }),
      checkpoints,
      goalGate: new GoalGate(),
    });

    const result = await loop.resume({ checkpointId: 'checkpoint_2' });
    expect(result.replayedToolUseIds).toEqual(['tool_1']);
  });
});
