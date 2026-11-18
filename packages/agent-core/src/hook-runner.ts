import { DomainError } from '@titan/contracts';
import type { Hook, HookContext, HookDecision, HookPhase } from './types.js';

export class HookRunner {
  constructor(private readonly hooks: Hook[]) {}

  async run(phase: HookPhase, context: Omit<HookContext, 'phase'>): Promise<HookDecision> {
    const hooks = this.hooks.filter(hook => hook.phase === phase).sort((left, right) => left.priority - right.priority);
    for (const hook of hooks) {
      try {
        const decision = await hook.run({ ...context, phase });
        if (decision === 'deny') return 'deny';
      } catch (error) {
        if (hook.blocking ?? true) {
          throw new DomainError('TOOL_BLOCKED_BY_HOOK', `hook ${hook.name} failed`, { cause: String(error) });
        }
      }
    }
    return 'allow';
  }
}
