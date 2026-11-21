import { DomainError } from '@titan/contracts';
import type { Hook, HookAuditEvent, HookContext, HookDecision, HookPhase } from './types.js';

type HookRunnerOptions = { onAudit?: (event: HookAuditEvent) => void | Promise<void> };

export class HookRunner {
  constructor(private readonly hooks: Hook[], private readonly options: HookRunnerOptions = {}) {}

  async run(phase: HookPhase, context: Omit<HookContext, 'phase'>): Promise<HookDecision> {
    const hooks = this.hooks.filter(hook => hook.phase === phase).sort((left, right) => left.priority - right.priority);
    for (const hook of hooks) {
      await this.options.onAudit?.({ source: 'hook', status: 'started', hookName: hook.name, phase, ...(context.toolName ? { toolName: context.toolName } : {}), ...(context.toolCallId ? { toolCallId: context.toolCallId } : {}), ...(context.runId ? { runId: context.runId } : {}) });
      try {
        const decision = await hook.run({ ...context, phase });
        await this.options.onAudit?.({ source: 'hook', status: decision === 'deny' ? 'denied' : 'allowed', hookName: hook.name, phase, ...(context.toolName ? { toolName: context.toolName } : {}), ...(context.toolCallId ? { toolCallId: context.toolCallId } : {}), ...(context.runId ? { runId: context.runId } : {}) });
        if (decision === 'deny') return 'deny';
      } catch (error) {
        await this.options.onAudit?.({ source: 'hook', status: 'failed', hookName: hook.name, phase, ...(context.toolName ? { toolName: context.toolName } : {}), ...(context.toolCallId ? { toolCallId: context.toolCallId } : {}), ...(context.runId ? { runId: context.runId } : {}), reason: String(error) });
        if (hook.blocking ?? true) {
          throw new DomainError('TOOL_BLOCKED_BY_HOOK', `hook ${hook.name} failed`, { cause: String(error) });
        }
      }
    }
    return 'allow';
  }
}
