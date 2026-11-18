import { DomainError } from '@titan/contracts';
import type { CheckpointStore } from './checkpoints.js';
import type { GoalGate } from './goal-gate.js';
import type { ToolRegistry } from './tool-registry.js';
import type { RuntimeAdapter } from './adapters/runtime-adapter.js';

type AgentLoopOptions = {
  adapter: RuntimeAdapter;
  tools: ToolRegistry;
  checkpoints: CheckpointStore;
  goalGate: GoalGate;
};

export type AgentRunResult = {
  status: 'continue' | 'satisfied' | 'failed';
  replayedToolUseIds: string[];
};

export class AgentLoop {
  constructor(private readonly options: AgentLoopOptions) {}

  async run(input: { runId: string; goal: string }): Promise<AgentRunResult> {
    const session = await this.options.adapter.createSession({ runtime: 'qwen', credentialRef: 'runtime://test' });
    const evidence: { kind: string; reference: string }[] = [];
    for await (const event of this.options.adapter.streamEvents(session)) {
      if (event.type === 'completed') break;
      if (event.type === 'session.completed') evidence.push({ kind: 'runtime', reference: input.runId });
    }
    const decision = this.options.goalGate.evaluate(evidence);
    return { status: decision.decision === 'satisfied' ? 'satisfied' : 'continue', replayedToolUseIds: [] };
  }

  async resume(input: { checkpointId: string }): Promise<AgentRunResult> {
    const checkpoint = await this.options.checkpoints.get(input.checkpointId);
    return { status: 'continue', replayedToolUseIds: checkpoint.successfulToolUseIds };
  }
}
