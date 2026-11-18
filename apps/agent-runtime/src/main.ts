import { AgentLoop, CheckpointStore, GoalGate, HookRunner, PermissionEngine, ToolRegistry } from '@titan/agent-core';
import type { RuntimeAdapter } from '@titan/agent-core';

export function createRuntime(adapter: RuntimeAdapter): AgentLoop {
  return new AgentLoop({
    adapter,
    tools: new ToolRegistry({ permission: new PermissionEngine([]), hooks: new HookRunner([]) }),
    checkpoints: new CheckpointStore(),
    goalGate: new GoalGate(),
  });
}
