import { describe, expect, it } from 'vitest';
import { WorkflowClientError } from '@titan/workflow';
import { runSafeActivity } from '../src/main.js';

describe('workflow worker activity safety', () => {
  it('converts transient client failures to retryable enum ApplicationFailure', async () => {
    await expect(runSafeActivity(async () => {
      throw new WorkflowClientError('DAEMON_UNAVAILABLE', true);
    })).rejects.toSatisfy((error: unknown) => {
      expect(error).toMatchObject({ message: 'DAEMON_UNAVAILABLE', type: 'DAEMON_UNAVAILABLE', nonRetryable: false });
      expect((error as Error).stack).toBe('');
      return true;
    });
  });

  it('converts protocol failures to non-retryable enum ApplicationFailure', async () => {
    await expect(runSafeActivity(async () => {
      throw new WorkflowClientError('WORKFLOW_COMMAND_FAILED', false);
    })).rejects.toSatisfy((error: unknown) => {
      expect(error).toMatchObject({ message: 'WORKFLOW_COMMAND_FAILED', type: 'WORKFLOW_COMMAND_FAILED', nonRetryable: true });
      return true;
    });
  });
});
