import type { GoalDecision, GoalEvidence } from './types.js';

export class GoalGate {
  evaluate(evidence: GoalEvidence[]): { decision: GoalDecision; reason: string } {
    const durableEvidence = evidence.filter(item => item.kind === 'artifact' || item.kind === 'test');
    if (durableEvidence.length > 0) return { decision: 'satisfied', reason: 'goal has artifact or test evidence' };
    return { decision: 'continue', reason: 'goal has no artifact or test evidence' };
  }
}
