import type { GoalDecision, GoalEvidence } from './types.js';

export class GoalGate {
  evaluate(evidence: GoalEvidence[]): { decision: GoalDecision; reason: string } {
    if (evidence.length > 0) return { decision: 'satisfied', reason: 'goal has persisted evidence' };
    return { decision: 'continue', reason: 'goal has no artifact or test evidence' };
  }
}
