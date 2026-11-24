import {
  ApplicationFailure,
  CancellationScope,
  condition,
  continueAsNew,
  defineSignal,
  isCancellation,
  makeContinueAsNewFunc,
  proxyActivities,
  setHandler,
  workflowInfo,
} from '@temporalio/workflow';
import type {
  BackgroundJobResult,
  JobInput,
  JobObservation,
  OrchestrationActivities,
  ScheduleOccurrenceInput,
  ScheduledOccurrenceWorkflowResult,
} from './types.js';

export const OBSERVE_INTERVAL_MS = 5_000;
export const HISTORY_CONTINUE_AS_NEW_THRESHOLD = 1_000;
export const cancelSignal = defineSignal('cancel');

const activities = proxyActivities<OrchestrationActivities>({
  startToCloseTimeout: '1 minute',
  retry: {
    maximumAttempts: 3,
    initialInterval: '1 second',
    maximumInterval: '10 seconds',
    backoffCoefficient: 2,
  },
});

const TERMINAL_STATUSES = new Set<JobObservation['status']>([
  'completed',
  'failed',
  'cancelled',
  'expired',
]);

function isTerminal(status: JobObservation['status']): boolean {
  return TERMINAL_STATUSES.has(status);
}

function parseDeadline(deadlineAt: string): number {
  const deadline = Date.parse(deadlineAt);
  if (!Number.isFinite(deadline)) {
    throw ApplicationFailure.nonRetryable('JOB_DEADLINE_INVALID', 'JOB_DEADLINE_INVALID');
  }
  return deadline;
}

async function cancelAfterDeadline(input: JobInput): Promise<JobObservation> {
  return activities.cancelJob({ ...input, reason: 'expired' });
}

async function monitorJob(
  input: JobInput,
  initialObservation: () => Promise<JobObservation>,
  continueWorkflow: () => Promise<never>,
): Promise<BackgroundJobResult> {
  let cancelRequested = false;
  const scope = new CancellationScope();
  setHandler(cancelSignal, () => {
    cancelRequested = true;
  });

  try {
    return await scope.run(async () => {
      if (cancelRequested) {
        return await CancellationScope.nonCancellable(() => activities.cancelJob({ ...input, reason: 'cancelled' }));
      }
      let current = await initialObservation();
      let deadline = parseDeadline(current.deadlineAt);
      while (true) {
        if (cancelRequested) {
          return await CancellationScope.nonCancellable(() => activities.cancelJob({ ...input, reason: 'cancelled' }));
        }
        if (isTerminal(current.status)) {
          return current;
        }

        if (Date.now() >= deadline) {
          return cancelAfterDeadline(input);
        }

        if (workflowInfo().continueAsNewSuggested || workflowInfo().historyLength >= HISTORY_CONTINUE_AS_NEW_THRESHOLD) {
          await continueWorkflow();
        }

        await condition(() => cancelRequested, Math.min(OBSERVE_INTERVAL_MS, deadline - Date.now()));
        if (cancelRequested) {
          continue;
        }
        if (Date.now() >= deadline) {
          return cancelAfterDeadline(input);
        }

        current = await activities.observeJob(input);
        deadline = Math.min(deadline, parseDeadline(current.deadlineAt));
      }
    });
  } catch (error) {
    if (isCancellation(error)) {
      const result = await CancellationScope.nonCancellable(() => activities.cancelJob({ ...input, reason: 'cancelled' }));
      if (cancelRequested) {
        return result;
      }
    }
    throw error;
  }
}

export async function backgroundJobV1(input: JobInput): Promise<BackgroundJobResult> {
  const continued = workflowInfo().continuedFromExecutionRunId !== undefined;
  return monitorJob(
    input,
    () => continued ? activities.observeJob(input) : activities.dispatchJob(input),
    () => continueAsNew<typeof backgroundJobV1>(input),
  );
}

export async function scheduledOccurrenceV1(
  input: Omit<ScheduleOccurrenceInput, 'occurrenceId' | 'scheduledAt'>,
): Promise<ScheduledOccurrenceWorkflowResult> {
  const info = workflowInfo();
  const scheduledAt = info.searchAttributes.TemporalScheduledStartTime?.[0];
  if (!(scheduledAt instanceof Date) || Number.isNaN(scheduledAt.getTime())) {
    throw ApplicationFailure.nonRetryable('SCHEDULED_START_TIME_MISSING', 'SCHEDULED_START_TIME_MISSING');
  }

  const occurrence = await CancellationScope.nonCancellable(() => activities.scheduleOccurrence({
    ...input,
    occurrenceId: info.workflowId,
    scheduledAt: scheduledAt.toISOString(),
  }));

  if (occurrence.status === 'skipped') {
    return { status: 'skipped' };
  }

  if (!occurrence.jobId) {
    throw ApplicationFailure.nonRetryable('SCHEDULE_OCCURRENCE_MISSING_JOB_ID', 'SCHEDULE_OCCURRENCE_MISSING_JOB_ID');
  }

  const jobInput: JobInput = { jobId: occurrence.jobId, workflowVersion: 1 };
  // 在同一 Workflow ID 下继续观察该 job，不重新接纳 occurrence 或创建第二条 Workflow。
  const continueJob = makeContinueAsNewFunc<typeof backgroundJobV1>({ workflowType: 'backgroundJobV1' });
  const result = await monitorJob(
    jobInput,
    () => activities.dispatchJob(jobInput),
    () => continueJob(jobInput),
  );
  return { status: result.status, jobId: result.jobId };
}
