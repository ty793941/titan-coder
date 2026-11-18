import { DomainError } from '@titan/contracts';
import type { PermissionDecision, PermissionRequest, PermissionRule } from './types.js';

export class PermissionEngine {
  constructor(private readonly rules: PermissionRule[]) {}

  decide(request: PermissionRequest): { decision: PermissionDecision; source?: string; reason: string } {
    const matches = this.rules.filter(rule => this.matches(rule, request));
    const denied = matches.find(rule => rule.decision === 'deny');
    if (denied) return { decision: 'deny', source: denied.source, reason: 'explicit deny policy matched' };
    const asks = matches.find(rule => rule.decision === 'ask');
    if (asks) return { decision: 'ask', source: asks.source, reason: 'approval policy matched' };
    const allowed = matches.find(rule => rule.decision === 'allow');
    if (allowed) return { decision: 'allow', source: allowed.source, reason: 'allow policy matched' };
    return { decision: 'deny', reason: 'no policy matched; default deny' };
  }

  requireExecution(request: PermissionRequest): void {
    const result = this.decide(request);
    if (result.decision === 'deny') throw new DomainError('PERMISSION_DENIED', result.reason, { source: result.source });
    if (result.decision === 'ask' && !request.approvalToken) {
      throw new DomainError('APPROVAL_REQUIRED', result.reason, { source: result.source });
    }
  }

  private matches(rule: PermissionRule, request: PermissionRequest): boolean {
    const resourceMatches = request.resource === rule.resource
      || request.resource.startsWith(`${rule.resource}/`)
      || rule.resource === '*';
    return resourceMatches && (rule.action === request.action || rule.action === '*');
  }
}
