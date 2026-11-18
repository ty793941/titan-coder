import { describe, expect, it } from 'vitest';
import { transitionExecution, transitionTask } from '../src';

describe('domain state transitions', () => {
  it('moves a task from questions to research', () => {
    expect(transitionTask('questions', 'start-research')).toEqual('research');
  });

  it('rejects a task transition that skips the approved stage', () => {
    expect(() => transitionTask('questions', 'start-implement')).toThrow('INVALID_STATE_TRANSITION');
  });

  it('moves a failed run to a new queued retry without changing the old run', () => {
    expect(transitionExecution('failed', 'retry')).toEqual('queued');
  });
});
