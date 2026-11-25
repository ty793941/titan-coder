import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ApplicationFailure } from '@temporalio/client';
import { Worker } from '@temporalio/worker';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import type {
  JobInput,
  JobObservation,
  OrchestrationActivities,
  ScheduleOccurrenceInput,
} from '../src/types.js';
import { HISTORY_CONTINUE_AS_NEW_THRESHOLD, cancelSignal } from '../src/workflows.js';

const taskQueue = `titan-workflow-test-${randomUUID()}`;

function observation(input: JobInput, status: JobObservation['status'], deadlineAt = '2099-01-01T00:00:00.000Z'): JobObservation {
  return { jobId: input.jobId, status, deadlineAt };
}

async function runWorkflow<T>(
  environment: TestWorkflowEnvironment,
  workflowType: string,
  activities: OrchestrationActivities,
  input: T,
  options: { searchAttributes?: Record<string, Date[]> } = {},
): Promise<Awaited<ReturnType<typeof environment.client.workflow.start>>> {
  const worker = await Worker.create({
    connection: environment.nativeConnection,
    namespace: environment.namespace,
    taskQueue,
    workflowsPath: new URL('../src/workflows.ts', import.meta.url).pathname,
    activities,
  });

  const workflowId = `${workflowType}-${randomUUID()}`;
  const handlePromise = environment.client.workflow.start(workflowType, {
    args: [input],
    taskQueue,
    workflowId,
    ...options,
  });
  const handle = await handlePromise;
  await worker.runUntil(handle.result());
  return handle;
}

describe('persistent Temporal workflows', () => {
  it('retries a lost dispatch response with the same job ID and then observes the run', async () => {
    const environment = await TestWorkflowEnvironment.createTimeSkipping();
    let dispatchCalls = 0;
    let observeCalls = 0;
    const runs = new Map<string, string>();
    const input: JobInput = { jobId: 'job_retry', workflowVersion: 1 };

    try {
      const activities: OrchestrationActivities = {
        async dispatchJob(value) {
          expect(value).toEqual(input);
          dispatchCalls += 1;
          if (!runs.has(value.jobId)) runs.set(value.jobId, 'run_once');
          if (dispatchCalls === 1) {
            throw new Error(`response lost for ${value.jobId}`);
          }
          return { ...observation(value, 'running'), runId: runs.get(value.jobId)! };
        },
        async observeJob(value) {
          observeCalls += 1;
          return observation(value, observeCalls === 1 ? 'running' : 'completed');
        },
        async cancelJob(value) {
          return observation(value, value.reason === 'expired' ? 'expired' : 'cancelled');
        },
        async failJob(value) {
          return { ...observation(value, 'failed'), errorCode: value.errorCode };
        },
        async scheduleOccurrence() {
          return { status: 'created', jobId: 'unused' };
        },
      };

      const handle = await runWorkflow(environment, 'backgroundJobV1', activities, input);
      await expect(handle.result()).resolves.toMatchObject({ jobId: input.jobId, status: 'completed' });
      expect(dispatchCalls).toBe(2);
      expect(observeCalls).toBe(2);
      expect([...runs.values()]).toEqual(['run_once']);
      const history = await handle.fetchHistory();
      expect(history.events?.filter((event) => event.timerStartedEventAttributes).map((event) =>
        Number(event.timerStartedEventAttributes?.startToFireTimeout?.seconds),
      )).toEqual([5, 5]);
    } finally {
      await environment.teardown();
    }
  });

  it.each([
    { errorCode: 'DAEMON_UNAVAILABLE' as const, retryable: true, reportFailures: 4, dispatchAttempts: 3 },
    { errorCode: 'VERSION_CONFLICT' as const, retryable: false, reportFailures: 0, dispatchAttempts: 1 },
  ])('reports $errorCode after dispatch failure without dispatching a new run', async ({ errorCode, retryable, reportFailures, dispatchAttempts }) => {
    const environment = await TestWorkflowEnvironment.createTimeSkipping();
    const input: JobInput = { jobId: `job_failure_${errorCode.toLowerCase()}`, workflowVersion: 1 };
    let dispatchCalls = 0;
    let failJobCalls = 0;
    let failedObservation: JobObservation | undefined;

    try {
      const activities: OrchestrationActivities = {
        async dispatchJob() {
          dispatchCalls += 1;
          throw ApplicationFailure.create({ message: errorCode, type: errorCode, nonRetryable: !retryable });
        },
        async observeJob(value) {
          return observation(value, 'pending_dispatch');
        },
        async cancelJob(value) {
          return observation(value, 'cancelled');
        },
        async failJob(value) {
          failJobCalls += 1;
          if (failJobCalls <= reportFailures) {
            throw ApplicationFailure.create({ message: 'DAEMON_UNAVAILABLE', type: 'DAEMON_UNAVAILABLE', nonRetryable: false });
          }
          failedObservation = { ...observation(value, 'failed'), errorCode: value.errorCode };
          return failedObservation;
        },
        async scheduleOccurrence() {
          return { status: 'created', jobId: 'unused' };
        },
      };
      const worker = await Worker.create({
        connection: environment.nativeConnection,
        namespace: environment.namespace,
        taskQueue,
        workflowsPath: new URL('../src/workflows.ts', import.meta.url).pathname,
        activities,
      });
      const handle = await environment.client.workflow.start('backgroundJobV1', {
        args: [input],
        taskQueue,
        workflowId: `failure-${randomUUID()}`,
      });
      const resultPromise = handle.result();
      await worker.runUntil((async () => {
        await expect(resultPromise).rejects.toBeTruthy();
      })());

      expect(dispatchCalls).toBe(dispatchAttempts);
      expect(failJobCalls).toBe(reportFailures + 1);
      expect(failedObservation).toEqual({
        jobId: input.jobId,
        status: 'failed',
        deadlineAt: '2099-01-01T00:00:00.000Z',
        errorCode,
      });
    } finally {
      await environment.teardown();
    }
  }, 60_000);

  it('waits through waiting_input and reconnecting without dispatching another attempt', async () => {
    const environment = await TestWorkflowEnvironment.createTimeSkipping();
    let dispatchCalls = 0;
    let observeCalls = 0;
    const input: JobInput = { jobId: 'job_waiting', workflowVersion: 1 };

    try {
      const activities: OrchestrationActivities = {
        async dispatchJob(value) {
          dispatchCalls += 1;
          return observation(value, 'waiting_input');
        },
        async observeJob(value) {
          observeCalls += 1;
          return observation(value, observeCalls < 3 ? 'reconnecting' : 'completed');
        },
        async cancelJob(value) {
          return observation(value, 'cancelled');
        },
        async failJob(value) {
          return { ...observation(value, 'failed'), errorCode: value.errorCode };
        },
        async scheduleOccurrence() {
          return { status: 'created', jobId: 'unused' };
        },
      };

      const handle = await runWorkflow(environment, 'backgroundJobV1', activities, input);
      await expect(handle.result()).resolves.toMatchObject({ jobId: input.jobId, status: 'completed' });
      expect(dispatchCalls).toBe(1);
      expect(observeCalls).toBe(3);
    } finally {
      await environment.teardown();
    }
  });

  it('cancels with a non-cancellable cleanup activity when the workflow is cancelled', async () => {
    const environment = await TestWorkflowEnvironment.createTimeSkipping();
    let cancelReason: 'cancelled' | 'expired' | undefined;
    const input: JobInput = { jobId: 'job_cancel', workflowVersion: 1 };

    try {
      const activities: OrchestrationActivities = {
        async dispatchJob(value) {
          return observation(value, 'running');
        },
        async observeJob(value) {
          return observation(value, 'running');
        },
        async cancelJob(value) {
          cancelReason = value.reason;
          return observation(value, 'cancelled');
        },
        async failJob(value) {
          return { ...observation(value, 'failed'), errorCode: value.errorCode };
        },
        async scheduleOccurrence() {
          return { status: 'created', jobId: 'unused' };
        },
      };

      const worker = await Worker.create({
        connection: environment.nativeConnection,
        namespace: environment.namespace,
        taskQueue,
        workflowsPath: new URL('../src/workflows.ts', import.meta.url).pathname,
        activities,
      });
      const handle = await environment.client.workflow.start('backgroundJobV1', {
        args: [input],
        taskQueue,
        workflowId: `cancel-${randomUUID()}`,
      });
      await handle.cancel();
      const runPromise = handle.result();
      const rejectedResult = expect(runPromise).rejects.toMatchObject({ cause: { name: 'CancelledFailure' } });
      const workerPromise = worker.runUntil((async () => {
        await rejectedResult;
      })());
      await workerPromise;
      expect(cancelReason).toBe('cancelled');
    } finally {
      await environment.teardown();
    }
  });

  it('writes the same cancellation intent when the cancel signal is received', async () => {
    const environment = await TestWorkflowEnvironment.createTimeSkipping();
    let cancelReason: 'cancelled' | 'expired' | undefined;
    const input: JobInput = { jobId: 'job_signal_cancel', workflowVersion: 1 };

    try {
      const activities: OrchestrationActivities = {
        async dispatchJob(value) {
          return observation(value, 'running');
        },
        async observeJob(value) {
          return observation(value, 'running');
        },
        async cancelJob(value) {
          cancelReason = value.reason;
          return observation(value, 'cancelled');
        },
        async failJob(value) {
          return { ...observation(value, 'failed'), errorCode: value.errorCode };
        },
        async scheduleOccurrence() {
          return { status: 'created', jobId: 'unused' };
        },
      };
      const worker = await Worker.create({
        connection: environment.nativeConnection,
        namespace: environment.namespace,
        taskQueue,
        workflowsPath: new URL('../src/workflows.ts', import.meta.url).pathname,
        activities,
      });
      const handle = await environment.client.workflow.start('backgroundJobV1', {
        args: [input],
        taskQueue,
        workflowId: `signal-cancel-${randomUUID()}`,
      });
      const resultPromise = handle.result();
      const workerPromise = worker.runUntil((async () => {
        await resultPromise;
        const deadline = Date.now() + 5_000;
        while (cancelReason === undefined && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      })());
      await handle.signal(cancelSignal);
      await workerPromise;
      await expect(resultPromise).resolves.toMatchObject({ jobId: input.jobId, status: 'cancelled' });
      expect(cancelReason).toBe('cancelled');
    } finally {
      await environment.teardown();
    }
  });

  it('expires using the control-plane deadline and does not extend it in the workflow', async () => {
    const environment = await TestWorkflowEnvironment.createTimeSkipping();
    let cancelReason: 'cancelled' | 'expired' | undefined;
    const input: JobInput = { jobId: 'job_deadline', workflowVersion: 1 };

    try {
      const activities: OrchestrationActivities = {
        async dispatchJob(value) {
          return observation(value, 'running', '2000-01-01T00:00:00.000Z');
        },
        async observeJob(value) {
          return observation(value, 'running', '2000-01-01T00:00:00.000Z');
        },
        async cancelJob(value) {
          cancelReason = value.reason;
          return observation(value, 'expired', '2000-01-01T00:00:00.000Z');
        },
        async failJob(value) {
          return { ...observation(value, 'failed'), errorCode: value.errorCode };
        },
        async scheduleOccurrence() {
          return { status: 'created', jobId: 'unused' };
        },
      };

      const handle = await runWorkflow(environment, 'backgroundJobV1', activities, input);
      await expect(handle.result()).resolves.toMatchObject({ jobId: input.jobId, status: 'expired' });
      expect(cancelReason).toBe('expired');
    } finally {
      await environment.teardown();
    }
  });

  it('creates one occurrence with the native scheduled start time and monitors its job', async () => {
    const environment = await TestWorkflowEnvironment.createFromExistingServer({
      address: '127.0.0.1:7233',
      namespace: 'titan',
    });
    let occurrenceInput: ScheduleOccurrenceInput | undefined;
    let scheduleDispatchCalls = 0;
    let observeCalls = 0;
    const input = { scheduleId: 'schedule_1', definitionVersion: 3 };

    try {
      const activities: OrchestrationActivities = {
        async dispatchJob(value) {
          scheduleDispatchCalls += 1;
          return observation(value, 'running');
        },
        async observeJob(value) {
          observeCalls += 1;
          return observation(value, 'completed');
        },
        async cancelJob(value) {
          return observation(value, 'cancelled');
        },
        async failJob(value) {
          return { ...observation(value, 'failed'), errorCode: value.errorCode };
        },
        async scheduleOccurrence(value) {
          occurrenceInput = value;
          return { status: 'created', jobId: 'job_occurrence' };
        },
      };

      const scheduledAt = new Date('2030-02-03T04:05:06.000Z');
      const handle = await runWorkflow(environment, 'scheduledOccurrenceV1', activities, input, {
        searchAttributes: { TemporalScheduledStartTime: [scheduledAt] },
      });
      await expect(handle.result()).resolves.toEqual({ status: 'completed', jobId: 'job_occurrence' });
      expect(occurrenceInput).toMatchObject({
        scheduleId: input.scheduleId,
        definitionVersion: input.definitionVersion,
        occurrenceId: expect.any(String),
        scheduledAt: scheduledAt.toISOString(),
      });
      expect(observeCalls).toBe(1);
      expect(scheduleDispatchCalls).toBe(1);
    } finally {
      await environment.teardown();
    }
  });

  it('does not extend the first control-plane deadline when a later observation changes it', async () => {
    const environment = await TestWorkflowEnvironment.createTimeSkipping();
    const input: JobInput = { jobId: 'job_fixed_deadline', workflowVersion: 1 };
    let deadlineAt = '';
    let observes = 0;
    try {
      const activities: OrchestrationActivities = {
        async dispatchJob(value) {
          deadlineAt = new Date(await environment.currentTimeMs() + 1_000).toISOString();
          return observation(value, 'running', deadlineAt);
        },
        async observeJob(value) {
          observes += 1;
          return observation(value, observes > 1 ? 'completed' : 'running');
        },
        async cancelJob(value) { return observation(value, 'expired', deadlineAt); },
        async failJob(value) { return { ...observation(value, 'failed'), errorCode: value.errorCode }; },
        async scheduleOccurrence() { return { status: 'skipped' }; },
      };
      const handle = await runWorkflow(environment, 'backgroundJobV1', activities, input);
      await expect(handle.result()).resolves.toMatchObject({ status: 'expired' });
      expect(observes).toBe(0);
      const history = await handle.fetchHistory();
      const timers = history.events?.filter((event) => event.timerStartedEventAttributes);
      expect(timers).toHaveLength(1);
      expect(Number(timers?.[0]?.timerStartedEventAttributes?.startToFireTimeout?.seconds)).toBeLessThanOrEqual(1);
    } finally { await environment.teardown(); }
  });

  it('rejects a manually started scheduled workflow without native schedule metadata', async () => {
    const environment = await TestWorkflowEnvironment.createTimeSkipping();
    let activityCalls = 0;
    const input = { scheduleId: 'schedule_without_metadata', definitionVersion: 1 };

    try {
      const activities: OrchestrationActivities = {
        async dispatchJob(value) {
          return observation(value, 'completed');
        },
        async observeJob(value) {
          return observation(value, 'completed');
        },
        async cancelJob(value) {
          return observation(value, 'cancelled');
        },
        async failJob(value) {
          return { ...observation(value, 'failed'), errorCode: value.errorCode };
        },
        async scheduleOccurrence() {
          activityCalls += 1;
          return { status: 'created', jobId: 'unexpected' };
        },
      };

      await expect(runWorkflow(environment, 'scheduledOccurrenceV1', activities, input)).rejects.toMatchObject({
        cause: { message: 'SCHEDULED_START_TIME_MISSING' },
      });
      expect(activityCalls).toBe(0);
    } finally {
      await environment.teardown();
    }
  });

  it('continues as new at the history threshold without dispatching the job again', async () => {
    const environment = await TestWorkflowEnvironment.createTimeSkipping();
    let dispatchCalls = 0;
    let observeCalls = 0;
    const input: JobInput = { jobId: 'job_continue_as_new', workflowVersion: 1 };

    try {
      const activities: OrchestrationActivities = {
        async dispatchJob(value) {
          dispatchCalls += 1;
          return observation(value, 'running');
        },
        async observeJob(value) {
          observeCalls += 1;
          return observation(value, observeCalls > HISTORY_CONTINUE_AS_NEW_THRESHOLD + 10 ? 'completed' : 'running');
        },
        async cancelJob(value) {
          return observation(value, value.reason === 'expired' ? 'expired' : 'cancelled');
        },
        async failJob(value) {
          return { ...observation(value, 'failed'), errorCode: value.errorCode };
        },
        async scheduleOccurrence() {
          return { status: 'created', jobId: 'unused' };
        },
      };

      const handle = await runWorkflow(environment, 'backgroundJobV1', activities, input);
      await expect(handle.result()).resolves.toMatchObject({ jobId: input.jobId, status: 'completed' });
      expect(dispatchCalls).toBe(1);
      expect(observeCalls).toBeGreaterThan(HISTORY_CONTINUE_AS_NEW_THRESHOLD);
      const firstHistory = await environment.client.workflow.getHandle(handle.workflowId, handle.firstExecutionRunId).fetchHistory();
      expect(firstHistory.events?.some((event) => event.workflowExecutionContinuedAsNewEventAttributes)).toBe(true);
      expect(firstHistory.events?.length).toBeGreaterThanOrEqual(HISTORY_CONTINUE_AS_NEW_THRESHOLD);
      const finalHistory = await handle.fetchHistory();
      expect(finalHistory.events?.[0]?.workflowExecutionStartedEventAttributes?.continuedExecutionRunId).toBeTruthy();
    } finally {
      await environment.teardown();
    }
  }, 120_000);

  it('replays a real history and contains no synthetic credential or prompt values', async () => {
    const environment = await TestWorkflowEnvironment.createTimeSkipping();
    const input: JobInput = { jobId: 'job_replay_safe', workflowVersion: 1 };
    const localRecord = {
      apiKey: 'sk-test-api-key', baseUrl: 'https://secret.example/v1',
      prompt: 'prompt-with-secret', serviceToken: 'synthetic-service-token',
      jobId: input.jobId, status: 'completed' as const, deadlineAt: '2099-01-01T00:00:00.000Z',
    };
    const syntheticValues = [localRecord.apiKey, localRecord.baseUrl, localRecord.prompt, localRecord.serviceToken];

    try {
      const activities: OrchestrationActivities = {
        async dispatchJob(value) {
          return { jobId: value.jobId, status: localRecord.status, deadlineAt: localRecord.deadlineAt };
        },
        async observeJob(value) {
          return observation(value, 'completed');
        },
        async cancelJob(value) {
          return observation(value, 'cancelled');
        },
        async failJob(value) {
          return { ...observation(value, 'failed'), errorCode: value.errorCode };
        },
        async scheduleOccurrence() {
          return { status: 'created', jobId: 'unused' };
        },
      };
      const handle = await runWorkflow(environment, 'backgroundJobV1', activities, input);
      const history = await handle.fetchHistory();
      const decodedPayloads: string[] = [];
      function inspectPayloads(value: unknown): void {
        if (!value || typeof value !== 'object') return;
        if ('data' in value && value.data instanceof Uint8Array) {
          decodedPayloads.push(Buffer.from(value.data).toString('utf8'));
        }
        for (const child of Object.values(value)) inspectPayloads(child);
      }
      inspectPayloads(history);
      expect(decodedPayloads.some((payload) => payload.includes(input.jobId))).toBe(true);
      const serializedHistory = JSON.stringify(history) + decodedPayloads.join('\n');
      for (const value of syntheticValues) {
        expect(serializedHistory).not.toContain(value);
      }
      await Worker.runReplayHistory(
        { workflowsPath: new URL('../src/workflows.ts', import.meta.url).pathname },
        history,
        handle.workflowId,
      );
    } finally {
      await environment.teardown();
    }
  });

  it('continues the scheduled job under the same Workflow ID without admitting or dispatching twice', async () => {
    const environment = await TestWorkflowEnvironment.createFromExistingServer({ address: '127.0.0.1:7233', namespace: 'titan' });
    const workflowId = `schedule-continue-${randomUUID()}`;
    let admissions = 0;
    let dispatches = 0;
    try {
      const activities: OrchestrationActivities = {
        async scheduleOccurrence(value) {
          admissions += 1;
          expect(value.occurrenceId).toBe(workflowId);
          return { status: 'created', jobId: 'job_scheduled_continue' };
        },
        async dispatchJob(value) {
          dispatches += 1;
          const handle = environment.client.workflow.getHandle(workflowId);
          for (let offset = 0; offset < HISTORY_CONTINUE_AS_NEW_THRESHOLD; offset += 50) {
            await Promise.all(Array.from({ length: 50 }, () => handle.signal('history_pressure')));
          }
          return observation(value, 'running');
        },
        async observeJob(value) { return observation(value, 'completed'); },
        async cancelJob(value) { return observation(value, 'cancelled'); },
        async failJob(value) { return { ...observation(value, 'failed'), errorCode: value.errorCode }; },
      };
      const handle = await environment.client.workflow.start('scheduledOccurrenceV1', {
        args: [{ scheduleId: 'schedule_continue', definitionVersion: 1 }], taskQueue, workflowId,
        searchAttributes: { TemporalScheduledStartTime: [new Date('2030-02-03T04:05:06.000Z')] },
      });
      const worker = await Worker.create({
        connection: environment.nativeConnection, namespace: environment.namespace, taskQueue,
        workflowsPath: new URL('../src/workflows.ts', import.meta.url).pathname, activities,
      });
      const result = await worker.runUntil(handle.result());
      expect(result).toMatchObject({ jobId: 'job_scheduled_continue', status: 'completed' });
      expect(admissions).toBe(1);
      expect(dispatches).toBe(1);
      const firstHistory = await environment.client.workflow.getHandle(workflowId, handle.firstExecutionRunId).fetchHistory();
      const continued = firstHistory.events?.find((event) => event.workflowExecutionContinuedAsNewEventAttributes)?.workflowExecutionContinuedAsNewEventAttributes;
      expect(continued?.workflowType?.name).toBe('backgroundJobV1');
      expect(firstHistory.events?.some((event) => event.startChildWorkflowExecutionInitiatedEventAttributes)).toBe(false);
      expect(JSON.parse(Buffer.from(continued!.input!.payloads![0]!.data!).toString())).toEqual({
        jobId: 'job_scheduled_continue', workflowVersion: 1,
      });
    } finally { await environment.teardown(); }
  }, 60_000);

  it.each(['cancel', 'signal'] as const)('records cancellation during schedule admission via %s', async (mode) => {
    const environment = await TestWorkflowEnvironment.createFromExistingServer({ address: '127.0.0.1:7233', namespace: 'titan' });
    let admitted!: () => void;
    const admissionStarted = new Promise<void>((resolve) => { admitted = resolve; });
    let release!: () => void;
    const admissionGate = new Promise<void>((resolve) => { release = resolve; });
    let dispatches = 0;
    let cancelledJob: string | undefined;
    try {
      const activities: OrchestrationActivities = {
        async scheduleOccurrence() {
          admitted();
          await admissionGate;
          return { status: 'created', jobId: 'job_admission_cancel' };
        },
        async dispatchJob(value) { dispatches += 1; return observation(value, 'completed'); },
        async observeJob(value) { return observation(value, 'completed'); },
        async cancelJob(value) { cancelledJob = value.jobId; return observation(value, 'cancel_requested'); },
        async failJob(value) { return { ...observation(value, 'failed'), errorCode: value.errorCode }; },
      };
      const handle = await environment.client.workflow.start('scheduledOccurrenceV1', {
        args: [{ scheduleId: 'schedule_admission', definitionVersion: 1 }], taskQueue,
        workflowId: `schedule-admission-${randomUUID()}`,
        searchAttributes: { TemporalScheduledStartTime: [new Date('2030-02-03T04:05:06.000Z')] },
      });
      const worker = await Worker.create({
        connection: environment.nativeConnection, namespace: environment.namespace, taskQueue,
        workflowsPath: new URL('../src/workflows.ts', import.meta.url).pathname, activities,
      });
      await worker.runUntil(async () => {
        await admissionStarted;
        if (mode === 'cancel') await handle.cancel();
        else await handle.signal(cancelSignal);
        release();
        if (mode === 'cancel') await expect(handle.result()).rejects.toMatchObject({ cause: { name: 'CancelledFailure' } });
        else await expect(handle.result()).resolves.toMatchObject({ status: 'cancel_requested' });
      });
      expect(cancelledJob).toBe('job_admission_cancel');
      expect(dispatches).toBe(0);
    } finally { release(); await environment.teardown(); }
  });
});
