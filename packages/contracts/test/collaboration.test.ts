import { describe, expect, it } from 'vitest';
import { assignmentCreateRequestSchema, reviewRequestCreateSchema } from '../src/collaboration.js';

describe('collaboration contracts', () => {
  it('rejects secrets and unknown fields in assignment requests', () => {
    expect(() => assignmentCreateRequestSchema.parse({
      subjectType: 'human', subjectId: 'member-1', responsibility: 'human-owner', reviewers: [],
      secret: 'never-accepted',
    })).toThrow();
  });

  it('requires a supported review target and gate', () => {
    expect(() => reviewRequestCreateSchema.parse({
      targetType: 'prompt', targetId: 'prompt-1',
      reviewerSubject: { subjectType: 'human', subjectId: 'member-1' },
      gate: 'unknown', requiredDecision: 'approve',
    })).toThrow();
  });
});
