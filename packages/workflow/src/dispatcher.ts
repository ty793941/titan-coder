import { errorCodes, type ErrorCode, type Schedule, type WorkflowCommand } from '@titan/contracts';
import type { JobObservation } from './types.js';
import { backgroundWorkflowId, TemporalClientError } from './temporal-client.js';

const terminalStatuses = new Set<JobObservation['status']>(['cancelled', 'expired', 'completed', 'failed']);

export type DispatcherControlPlane = {
  claimCommand(workerId: string): Promise<WorkflowCommand | undefined>;
  completeCommand(command: Pick<WorkflowCommand, 'id' | 'claimToken'>): Promise<void>;
  retryCommand(command: Pick<WorkflowCommand, 'id' | 'claimToken'>, retryable: boolean, errorCode: ErrorCode): Promise<void>;
  observeJob(input: { jobId: string; workflowVersion: 1 }): Promise<JobObservation>;
  getJobExecution(jobId: string): Promise<{ jobId: string; workflowId: string; workflowVersion: 1 }>;
  getSchedule(scheduleId: string): Promise<Schedule>;
};

export type DispatcherTemporal = {
  startBackgroundJob(input: { jobId: string; workflowVersion: 1 }): Promise<void>;
  cancelBackgroundJob(workflowId: string): Promise<void>;
  syncSchedule(schedule: Schedule): Promise<void>;
};

export type DispatcherOptions = {
  controlPlane: DispatcherControlPlane;
  temporal: DispatcherTemporal;
  workerId?: string;
  pollIntervalMs?: number;
  resolveCancelWorkflowId?: (jobId: string) => Promise<string | undefined>;
};

export class Dispatcher {
  private readonly controlPlane: DispatcherControlPlane;
  private readonly temporal: DispatcherTemporal;
  private readonly workerId: string;
  private readonly pollIntervalMs: number;
  private readonly resolveCancelWorkflowId: (jobId: string) => Promise<string | undefined>;
  private readonly startedJobs = new Set<string>();
  private stopped = true;
  private loop: Promise<void> | undefined;

  constructor(options: DispatcherOptions) {
    this.controlPlane = options.controlPlane;
    this.temporal = options.temporal;
    this.workerId = options.workerId ?? 'local';
    this.pollIntervalMs = options.pollIntervalMs ?? 1_000;
    this.resolveCancelWorkflowId = options.resolveCancelWorkflowId ?? (async (jobId) => backgroundWorkflowId(jobId));
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(this.workerId) || !Number.isInteger(this.pollIntervalMs) || this.pollIntervalMs < 1 || this.pollIntervalMs > 60_000) {
      throw new Error('VALIDATION_FAILED');
    }
  }

  start(): Promise<void> {
    if (!this.loop) {
      this.stopped = false;
      this.loop = this.runLoop().finally(() => { this.loop = undefined; this.stopped = true; });
    }
    return this.loop;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.loop;
  }

  async process(command: WorkflowCommand): Promise<void> {
    try {
      await this.execute(command);
      await this.controlPlane.completeCommand(command);
    } catch (error) {
      const safe = safeFailure(error);
      try {
        await this.controlPlane.retryCommand(command, safe.retryable, safe.code);
      } catch {
        // A lost ACK remains claimable after the lease expires; no raw error is retained.
      }
    }
  }

  private async execute(command: WorkflowCommand): Promise<void> {
    if (command.kind === 'start_job') {
      const input = { jobId: command.targetId, workflowVersion: 1 as const };
      const observation = await this.controlPlane.observeJob(input);
      if (terminalStatuses.has(observation.status) || observation.status === 'cancel_requested') return;
      if (this.startedJobs.has(command.targetId)) return;
      await this.temporal.startBackgroundJob(input);
      this.startedJobs.add(command.targetId);
      return;
    }

    if (command.kind === 'cancel_job') {
      const execution = await this.controlPlane.getJobExecution(command.targetId);
      const workflowId = execution.workflowId ?? await this.resolveCancelWorkflowId(command.targetId);
      if (workflowId) await this.temporal.cancelBackgroundJob(workflowId);
      return;
    }

    let schedule = await this.controlPlane.getSchedule(command.targetId);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await this.temporal.syncSchedule(schedule);
      const latest = await this.controlPlane.getSchedule(command.targetId);
      if (latest.version === schedule.version) return;
      if (latest.version < schedule.version) throw new TemporalClientError('VERSION_CONFLICT', true);
      schedule = latest;
    }
    throw new TemporalClientError('VERSION_CONFLICT', true);
  }

  private async runLoop(): Promise<void> {
    while (!this.stopped) {
      try {
        const command = await this.controlPlane.claimCommand(this.workerId);
        if (command) await this.process(command);
      } catch {
        // Polling failures are retried by the next bounded interval without logging raw data.
      }
      if (!this.stopped) await delay(this.pollIntervalMs);
    }
  }
}

function safeFailure(error: unknown): { code: ErrorCode; retryable: boolean } {
  if (error instanceof TemporalClientError) return { code: error.code, retryable: error.retryable };
  if (error && typeof error === 'object' && 'code' in error) {
    const value = (error as { code?: unknown }).code;
    if (typeof value === 'string' && (errorCodes as readonly string[]).includes(value)) {
      return { code: value as ErrorCode, retryable: 'retryable' in error ? Boolean((error as { retryable?: unknown }).retryable) : false };
    }
  }
  return { code: 'WORKFLOW_COMMAND_FAILED', retryable: true };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
