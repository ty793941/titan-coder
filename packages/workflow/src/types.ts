import type { ErrorCode } from '@titan/contracts';

export type JobInput = {
  jobId: string;
  workflowVersion: 1;
};

export type JobStatus =
  | 'pending_dispatch'
  | 'dispatching'
  | 'running'
  | 'waiting_input'
  | 'reconnecting'
  | 'cancel_requested'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'expired';

export type JobObservation = {
  jobId: string;
  status: JobStatus;
  deadlineAt: string;
  runId?: string;
  errorCode?: ErrorCode;
};

export type CancelJobInput = JobInput & {
  reason: 'cancelled' | 'expired';
};

export type FailJobInput = JobInput & {
  errorCode: ErrorCode;
};

export const SAFE_ERROR_CODES = new Set<ErrorCode>([
  'VALIDATION_FAILED', 'RESOURCE_NOT_FOUND', 'VERSION_CONFLICT', 'IDEMPOTENCY_CONFLICT',
  'INVALID_STATE_TRANSITION', 'TASK_PLAN_REQUIRED', 'PLAN_HASH_STALE', 'PERMISSION_DENIED',
  'APPROVAL_REQUIRED', 'TOOL_INPUT_INVALID', 'TOOL_BLOCKED_BY_HOOK', 'TOOL_EXECUTION_FAILED',
  'TOOL_TIMEOUT', 'DAEMON_UNAVAILABLE', 'WORKSPACE_CONFLICT', 'CHECKPOINT_NOT_FOUND',
  'RUNTIME_ADAPTER_UNAVAILABLE', 'EVENT_SEQUENCE_GAP', 'EXECUTION_LEASE_EXPIRED',
  'CLOUD_SECRET_LEASE_EXPIRED', 'CLOUD_SECRET_CONSUMED', 'CLOUD_WORKER_DISCONNECTED',
  'CLOUD_RUNTIME_WAITING_INPUT', 'HANDOFF_CHECKPOINT_INVALID', 'HANDOFF_TARGET_UNAVAILABLE',
  'HANDOFF_SNAPSHOT_FAILED', 'HANDOFF_TRANSFER_FAILED', 'WORKFLOW_COMMAND_LEASE_EXPIRED',
  'WORKFLOW_COMMAND_FAILED', 'BACKGROUND_JOB_EXPIRED', 'SCHEDULE_DISABLED',
  'SCHEDULE_DEFINITION_SUPERSEDED', 'SCHEDULE_MAX_RUNS_REACHED', 'SCHEDULE_OVERLAP',
  'SCHEDULE_OUTSIDE_WINDOW', 'SCHEDULE_CATCHUP_SKIPPED',
]);

export function isSafeErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && SAFE_ERROR_CODES.has(value as ErrorCode);
}

export type ScheduleOccurrenceInput = {
  scheduleId: string;
  definitionVersion: number;
  occurrenceId: string;
  scheduledAt: string;
};

export type BackgroundJobResult = JobObservation;

export type ScheduleOccurrenceResult = {
  status: 'created' | 'skipped';
  jobId?: string;
};

export type ScheduledOccurrenceWorkflowResult =
  | { status: 'skipped' }
  | { status: JobStatus; jobId: string };

export interface OrchestrationActivities {
  dispatchJob(input: JobInput): Promise<JobObservation>;
  observeJob(input: JobInput): Promise<JobObservation>;
  cancelJob(input: CancelJobInput): Promise<JobObservation>;
  failJob(input: FailJobInput): Promise<JobObservation>;
  scheduleOccurrence(input: ScheduleOccurrenceInput): Promise<ScheduleOccurrenceResult>;
}
