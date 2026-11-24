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
  errorCode?: string;
};

export type CancelJobInput = JobInput & {
  reason: 'cancelled' | 'expired';
};

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
  scheduleOccurrence(input: ScheduleOccurrenceInput): Promise<ScheduleOccurrenceResult>;
}
