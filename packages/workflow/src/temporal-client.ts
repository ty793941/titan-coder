import {
  Client,
  Connection,
  ScheduleAlreadyRunning,
  ScheduleNotFoundError,
  ScheduleOverlapPolicy,
  WorkflowExecutionAlreadyStartedError,
  WorkflowIdConflictPolicy,
  WorkflowIdReusePolicy,
  type ScheduleOptions,
  type ScheduleOptionsStartWorkflowAction,
  type WorkflowHandle,
} from '@temporalio/client';
import type { ErrorCode, Schedule } from '@titan/contracts';
import type { JobInput } from './types.js';

type AnyWorkflow = (...args: any[]) => Promise<any>;

export const TEMPORAL_NAMESPACE = 'titan';
export const TEMPORAL_TASK_QUEUE = 'titan-orchestration-v1';
export const BACKGROUND_WORKFLOW_TYPE = 'backgroundJobV1';
export const SCHEDULE_WORKFLOW_TYPE = 'scheduledOccurrenceV1';
const TEMPORAL_RPC_TIMEOUT_MS = 5_000;

export class TemporalClientError extends Error {
  readonly name = 'TemporalClientError';

  constructor(
    readonly code: ErrorCode,
    readonly retryable: boolean,
  ) {
    super(code);
  }
}

export type TemporalOrchestrationClient = {
  startBackgroundJob(input: JobInput): Promise<void>;
  cancelBackgroundJob(workflowId: string): Promise<void>;
  syncSchedule(schedule: Schedule): Promise<void>;
  close(): Promise<void>;
};

export type TemporalClientOptions = {
  address: string;
  namespace?: string;
  taskQueue?: string;
};

export async function connectTemporalClient(options: TemporalClientOptions): Promise<TemporalOrchestrationClient> {
  try {
    const connection = await Connection.connect({ address: options.address, connectTimeout: '5 seconds' });
    const client = new Client({ connection, namespace: options.namespace ?? TEMPORAL_NAMESPACE });
    return new TemporalClientAdapter(client, connection, options.taskQueue ?? TEMPORAL_TASK_QUEUE);
  } catch {
    throw new TemporalClientError('DAEMON_UNAVAILABLE', true);
  }
}

export function backgroundWorkflowId(jobId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(jobId)) throw new TemporalClientError('VALIDATION_FAILED', false);
  return `titan/background/${jobId}/v1`;
}

class TemporalClientAdapter implements TemporalOrchestrationClient {
  private readonly scheduleLocks = new Map<string, Promise<void>>();

  constructor(
    private readonly client: Client,
    private readonly connection: Connection,
    private readonly taskQueue: string,
  ) {}

  async startBackgroundJob(input: JobInput): Promise<void> {
    const workflowId = backgroundWorkflowId(input.jobId);
    try {
      await this.withDeadline(() => this.client.workflow.start(BACKGROUND_WORKFLOW_TYPE, {
        args: [input],
        taskQueue: this.taskQueue,
        workflowId,
        workflowIdReusePolicy: WorkflowIdReusePolicy.REJECT_DUPLICATE,
        workflowIdConflictPolicy: WorkflowIdConflictPolicy.FAIL,
        memo: { titanJobId: input.jobId, titanWorkflowVersion: input.workflowVersion },
      }));
    } catch (error) {
      if (error instanceof WorkflowExecutionAlreadyStartedError) {
        await this.verifyExistingBackgroundWorkflow(error, input, workflowId);
        return;
      }
      throw toTemporalError(error);
    }
  }

  async cancelBackgroundJob(workflowId: string): Promise<void> {
    if (!/^[A-Za-z0-9][A-Za-z0-9_/:.\-]{0,499}$/.test(workflowId)) throw new TemporalClientError('VALIDATION_FAILED', false);
    try {
      await this.withDeadline(() => this.client.workflow.getHandle(workflowId).signal('cancel'));
    } catch (error) {
      if (isWorkflowNotFound(error)) return;
      throw toTemporalError(error);
    }
  }

  async syncSchedule(schedule: Schedule): Promise<void> {
    const previous = this.scheduleLocks.get(schedule.id) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(() => this.syncScheduleNow(schedule));
    this.scheduleLocks.set(schedule.id, current);
    try {
      await current;
    } finally {
      if (this.scheduleLocks.get(schedule.id) === current) this.scheduleLocks.delete(schedule.id);
    }
  }

  private async syncScheduleNow(schedule: Schedule): Promise<void> {
    const scheduleId = `${schedule.temporalScheduleId}-v${schedule.version}`;
    if (await this.hasNewerSchedule(schedule)) {
      await this.pauseSchedule(scheduleId);
      return;
    }
    const definition = makeScheduleOptions(schedule, scheduleId, this.taskQueue);
    try {
      await this.withDeadline(() => this.client.schedule.create(definition));
    } catch (error) {
      if (!(error instanceof ScheduleAlreadyRunning)) throw toTemporalError(error);
      const handle = this.client.schedule.getHandle(scheduleId);
      let description;
      try {
        description = await this.withDeadline(() => handle.describe());
      } catch (describeError) {
        if (describeError instanceof ScheduleNotFoundError) throw new TemporalClientError('DAEMON_UNAVAILABLE', true);
        throw toTemporalError(describeError);
      }
      if (!sameScheduleMemo(description.memo, schedule)) throw new TemporalClientError('VERSION_CONFLICT', false);
      try {
        await this.withDeadline(() => handle.update(() => ({
          spec: definition.spec,
          action: definition.action,
          policies: definition.policies!,
          state: { paused: !schedule.enabled, remainingActions: Math.max(0, schedule.maxRuns - schedule.runCount) },
        })));
      } catch (updateError) {
        throw toTemporalError(updateError);
      }
    }
    await pausePreviousScheduleVersions(this.client, schedule, scheduleId, operation => this.withDeadline(operation));
  }

  async close(): Promise<void> {
    await this.connection.close();
  }

  private async verifyExistingBackgroundWorkflow(error: WorkflowExecutionAlreadyStartedError, input: JobInput, workflowId: string): Promise<void> {
    if (error.workflowId !== workflowId || error.workflowType !== BACKGROUND_WORKFLOW_TYPE) throw new TemporalClientError('WORKFLOW_COMMAND_FAILED', false);
    try {
      const description = await this.withDeadline(() => (error.runId ? this.client.workflow.getHandle(workflowId, error.runId) : this.client.workflow.getHandle(workflowId)).describe());
      const memo = description.memo;
      if (description.type !== BACKGROUND_WORKFLOW_TYPE || description.taskQueue !== this.taskQueue || memo?.titanJobId !== input.jobId || memo?.titanWorkflowVersion !== input.workflowVersion) {
        throw new TemporalClientError('WORKFLOW_COMMAND_FAILED', false);
      }
    } catch (verifyError) {
      if (verifyError instanceof TemporalClientError) throw verifyError;
      throw new TemporalClientError('WORKFLOW_COMMAND_FAILED', false);
    }
  }

  private async hasNewerSchedule(schedule: Schedule): Promise<boolean> {
    if (schedule.version >= 2147483646) return false;
    const nextId = `${schedule.temporalScheduleId}-v${schedule.version + 1}`;
    try {
      await this.withDeadline(() => this.client.schedule.getHandle(nextId).describe());
      return true;
    } catch (error) {
      if (!(error instanceof ScheduleNotFoundError)) throw toTemporalError(error);
    }

    const prefix = `${schedule.temporalScheduleId}-v`;
    const iterator = this.client.schedule.list({ pageSize: 1000 })[Symbol.asyncIterator]();
    try {
      while (true) {
        const result = await this.withDeadline(() => iterator.next());
        if (result.done) return false;
        const match = new RegExp(`^${escapeRegExp(prefix)}(\\d+)$`).exec(result.value.scheduleId);
        if (match && Number(match[1]) > schedule.version) return true;
      }
    } catch (error) {
      throw toTemporalError(error);
    }
  }

  private async pauseSchedule(scheduleId: string): Promise<void> {
    try {
      await this.withDeadline(() => this.client.schedule.getHandle(scheduleId).pause('superseded by a newer definition'));
    } catch (error) {
      if (!(error instanceof ScheduleNotFoundError)) throw toTemporalError(error);
    }
  }

  private withDeadline<T>(operation: () => Promise<T>): Promise<T> {
    return this.connection.withDeadline(Date.now() + TEMPORAL_RPC_TIMEOUT_MS, operation);
  }
}

function makeScheduleOptions(schedule: Schedule, scheduleId: string, taskQueue: string): ScheduleOptions<ScheduleOptionsStartWorkflowAction<AnyWorkflow>> {
  const spec = {
    ...(schedule.cron ? { cronExpressions: [schedule.cron] } : { intervals: [{ every: schedule.intervalSeconds! * 1000 }] }),
    timezone: schedule.timezone,
    startAt: new Date(schedule.startsAt),
    endAt: new Date(schedule.endsAt),
  };
  return {
    scheduleId,
    spec,
    action: {
      type: 'startWorkflow',
      workflowType: SCHEDULE_WORKFLOW_TYPE,
      taskQueue,
      args: [{ scheduleId: schedule.id, definitionVersion: schedule.version }],
    },
    policies: {
      overlap: ScheduleOverlapPolicy.SKIP,
      catchupWindow: schedule.catchupWindowSeconds * 1000,
      pauseOnFailure: false,
    },
    memo: { titanScheduleId: schedule.id, titanDefinitionVersion: schedule.version },
    state: {
      paused: !schedule.enabled,
      remainingActions: Math.max(0, schedule.maxRuns - schedule.runCount),
    },
  };
}

async function pausePreviousScheduleVersions(
  client: Client,
  schedule: Schedule,
  currentId: string,
  withDeadline: <T>(operation: () => Promise<T>) => Promise<T>,
): Promise<void> {
  for (let version = 1; version < schedule.version; version += 1) {
    const previousId = `${schedule.temporalScheduleId}-v${version}`;
    if (previousId === currentId) continue;
    try {
      await withDeadline(() => client.schedule.getHandle(previousId).pause('superseded by a newer definition'));
    } catch (error) {
      if (!(error instanceof ScheduleNotFoundError)) throw toTemporalError(error);
    }
  }
}

function sameScheduleMemo(memo: Record<string, unknown> | undefined, schedule: Schedule): boolean {
  return memo?.titanScheduleId === schedule.id && memo?.titanDefinitionVersion === schedule.version;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isWorkflowNotFound(error: unknown): boolean {
  if (error instanceof Error && error.name === 'WorkflowNotFoundError') return true;
  return Boolean(error && typeof error === 'object' && 'code' in error && (error as { code?: unknown }).code === 5);
}

function toTemporalError(_error: unknown): TemporalClientError {
  return new TemporalClientError('DAEMON_UNAVAILABLE', true);
}

export type BackgroundWorkflowHandle = WorkflowHandle;
