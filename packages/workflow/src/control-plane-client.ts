import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  jobObservationSchema,
  orchestrationErrorCodeSchema,
  scheduleOccurrenceResultSchema,
  scheduleSchema,
  backgroundJobSchema,
  workflowCommandSchema,
  type ErrorCode,
  type JobObservation as ContractJobObservation,
  type Schedule,
  type WorkflowCommand,
} from '@titan/contracts';
import type {
  CancelJobInput,
  JobInput,
  JobObservation,
  OrchestrationActivities,
  FailJobInput,
  ScheduleOccurrenceInput,
  ScheduleOccurrenceResult,
} from './types.js';
import { SAFE_ERROR_CODES, isSafeErrorCode } from './types.js';

const execFileAsync = promisify(execFile);
const MAX_JSON_BYTES = 2 * 1024 * 1024;
const MAX_ERROR_JSON_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_BEARER_BYTES = 4 * 1024;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;
const RETRYABLE_ERROR_CODES = new Set<ErrorCode>([
  'DAEMON_UNAVAILABLE', 'TOOL_TIMEOUT', 'RUNTIME_ADAPTER_UNAVAILABLE', 'HANDOFF_TARGET_UNAVAILABLE',
]);

export type WorkflowBearerSource = {
  readKeychain?: (service: string) => Promise<string>;
  readStdin?: () => Promise<string>;
};

export class WorkflowClientError extends Error {
  readonly name = 'WorkflowClientError';

  constructor(
    readonly code: ErrorCode,
    readonly retryable: boolean,
  ) {
    super(code);
  }
}

export class WorkflowBearer {
  private constructor(readonly value: string) {}

  static async fromKeychain(ref: string, source: WorkflowBearerSource = {}): Promise<WorkflowBearer> {
    const service = parseKeychainRef(ref);
    const value = await (source.readKeychain ?? readKeychain)(service);
    return new WorkflowBearer(validateBearer(value));
  }

  static async fromStdin(ref: string, source: WorkflowBearerSource = {}): Promise<WorkflowBearer> {
    if (ref !== 'stdin://workflow') throw new WorkflowClientError('VALIDATION_FAILED', false);
    const value = await (source.readStdin ?? readWorkflowStdin)();
    return new WorkflowBearer(validateBearer(value));
  }
}

export async function resolveWorkflowBearer(ref: string, source: WorkflowBearerSource = {}): Promise<string> {
  if (ref.startsWith('keychain://')) return (await WorkflowBearer.fromKeychain(ref, source)).value;
  return (await WorkflowBearer.fromStdin(ref, source)).value;
}

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export type ControlPlaneClientOptions = {
  baseUrl: string;
  bearer: string | WorkflowBearer;
  requestTimeoutMs?: number;
  fetchImpl?: FetchLike;
};

export class ControlPlaneClient implements OrchestrationActivities {
  private readonly baseUrl: URL;
  private readonly bearer: string;
  private readonly requestTimeoutMs: number;
  private readonly fetchImpl: FetchLike;

  constructor(options: ControlPlaneClientOptions) {
    this.baseUrl = validateBaseUrl(options.baseUrl);
    this.bearer = typeof options.bearer === 'string' ? validateBearer(options.bearer) : options.bearer.value;
    this.requestTimeoutMs = validateTimeout(options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS);
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async claimCommand(workerId: string): Promise<WorkflowCommand | undefined> {
    const value = await this.requestJson('api/internal/workflow/commands/claim', {
      method: 'POST',
      body: JSON.stringify({ workerId: validateId(workerId) }),
    });
    return value === undefined ? undefined : parseContract(workflowCommandSchema, value);
  }

  async completeCommand(command: Pick<WorkflowCommand, 'id' | 'claimToken'>): Promise<void> {
    await this.request(`api/internal/workflow/commands/${encodeId(command.id)}/complete`, {
      method: 'POST',
      body: JSON.stringify({ claimToken: command.claimToken }),
    });
  }

  async retryCommand(command: Pick<WorkflowCommand, 'id' | 'claimToken'>, retryable: boolean, errorCode: ErrorCode): Promise<void> {
    const safeErrorCode = orchestrationErrorCodeSchema.parse(errorCode);
    await this.request(`api/internal/workflow/commands/${encodeId(command.id)}/retry`, {
      method: 'POST',
      body: JSON.stringify({ claimToken: command.claimToken, retryable, errorCode: safeErrorCode }),
    });
  }

  async observeJob(input: JobInput): Promise<JobObservation> {
    const value = await this.requestJson(`api/internal/workflow/jobs/${encodeId(input.jobId)}`);
    return toJobObservation(parseContract(jobObservationSchema, value));
  }

  async getJobExecution(jobId: string): Promise<JobExecution> {
    const value = await this.requestJson(`api/internal/workflow/jobs/${encodeId(jobId)}/execution`);
    try {
      return jobExecutionSchema.parse(value);
    } catch {
      throw new WorkflowClientError('WORKFLOW_COMMAND_FAILED', false);
    }
  }

  async dispatchJob(input: JobInput): Promise<JobObservation> {
    const value = await this.requestJson(`api/internal/workflow/jobs/${encodeId(input.jobId)}/dispatch`, {
      method: 'POST',
      body: '{}',
    });
    return toJobObservation(parseContract(jobObservationSchema, value));
  }

  async cancelJob(input: CancelJobInput): Promise<JobObservation> {
    const value = await this.requestJson(`api/internal/workflow/jobs/${encodeId(input.jobId)}/cancel`, {
      method: 'POST',
      body: JSON.stringify({ reason: input.reason }),
    });
    return toJobObservation(parseContract(jobObservationSchema, value));
  }

  async failJob(input: FailJobInput): Promise<JobObservation> {
    const errorCode = validateSafeErrorCode(input.errorCode);
    const value = await this.requestJson(`api/internal/workflow/jobs/${encodeId(input.jobId)}/fail`, {
      method: 'POST',
      body: JSON.stringify({ errorCode }),
    });
    return toJobObservation(parseContract(jobObservationSchema, value));
  }

  async getSchedule(scheduleId: string): Promise<Schedule> {
    return parseContract(scheduleSchema, await this.requestJson(`api/internal/workflow/schedules/${encodeId(scheduleId)}`));
  }

  async scheduleOccurrence(input: ScheduleOccurrenceInput): Promise<ScheduleOccurrenceResult> {
    const value = await this.requestJson(`api/internal/workflow/schedules/${encodeId(input.scheduleId)}/occurrences`, {
      method: 'POST',
      body: JSON.stringify({
        definitionVersion: input.definitionVersion,
        occurrenceId: validateOccurrenceId(input.occurrenceId),
        scheduledAt: input.scheduledAt,
      }),
    });
    return parseContract(scheduleOccurrenceResultSchema, value);
  }

  private async requestJson(path: string, init: RequestInit = {}): Promise<unknown> {
    return this.request(path, init, readJson);
  }

  private async request<T = Response>(path: string, init: RequestInit = {}, consume?: (response: Response) => Promise<T>): Promise<T> {
    const url = new URL(path, this.baseUrl);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    const abort = () => controller.abort();
    init.signal?.addEventListener('abort', abort, { once: true });
    try {
      const response = await this.fetchImpl(url, {
        ...init,
        headers: { ...init.headers, authorization: `Bearer ${this.bearer}`, 'content-type': 'application/json' },
        redirect: 'error',
        signal: controller.signal,
      });
      if (response.status !== 204 && (response.status < 200 || response.status >= 300)) {
        if (response.status === 401 || response.status === 403) throw httpStatusError(response.status);
        const code = await readSafeErrorCode(response);
        throw code ? new WorkflowClientError(code, RETRYABLE_ERROR_CODES.has(code)) : httpStatusError(response.status);
      }
      if (consume) return await consume(response);
      return response as T;
    } catch (error) {
      if (error instanceof WorkflowClientError) throw error;
      throw new WorkflowClientError('DAEMON_UNAVAILABLE', true);
    } finally {
      clearTimeout(timer);
      init.signal?.removeEventListener('abort', abort);
    }
  }
}

function validateBaseUrl(value: string): URL {
  try {
    if (/\r|\n/.test(value)) throw new Error();
    const url = new URL(value);
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    const loopback = host === 'localhost' || host === '127.0.0.1' || host === '::1';
    if (!loopback || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error();
    url.pathname = url.pathname.endsWith('/') ? url.pathname : `${url.pathname}/`;
    return url;
  } catch {
    throw new WorkflowClientError('VALIDATION_FAILED', false);
  }
}

function validateTimeout(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 120_000) throw new WorkflowClientError('VALIDATION_FAILED', false);
  return value;
}

function validateBearer(value: string): string {
  if (Buffer.byteLength(value) > MAX_BEARER_BYTES || !/^\S{16,4096}$/.test(value)) throw new WorkflowClientError('PERMISSION_DENIED', false);
  return value;
}

function parseKeychainRef(ref: string): string {
  const match = /^keychain:\/\/([A-Za-z0-9_-]{1,200})$/.exec(ref);
  if (!match) throw new WorkflowClientError('VALIDATION_FAILED', false);
  return match[1]!;
}

async function readKeychain(service: string): Promise<string> {
  try {
    const result = await execFileAsync('/usr/bin/security', ['find-generic-password', '-s', service, '-a', 'titan', '-w'], { maxBuffer: MAX_BEARER_BYTES, timeout: DEFAULT_TIMEOUT_MS });
    return result.stdout.trim();
  } catch {
    throw new WorkflowClientError('PERMISSION_DENIED', false);
  }
}

async function readWorkflowStdin(): Promise<string> {
  if (process.stdin.isTTY) throw new WorkflowClientError('PERMISSION_DENIED', false);
  let value = '';
  try {
    for await (const chunk of process.stdin) {
      value += String(chunk);
      if (Buffer.byteLength(value) > MAX_BEARER_BYTES) throw new Error();
    }
    return value.trim();
  } catch {
    throw new WorkflowClientError('PERMISSION_DENIED', false);
  }
}

function validateId(value: string): string {
  if (!SAFE_ID.test(value)) throw new WorkflowClientError('VALIDATION_FAILED', false);
  return value;
}

function validateOccurrenceId(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_/:.\-]{0,499}$/.test(value)) throw new WorkflowClientError('VALIDATION_FAILED', false);
  return value;
}

function encodeId(value: string): string {
  return encodeURIComponent(validateId(value));
}

function httpStatusError(status: number): WorkflowClientError {
  if (status >= 500) return new WorkflowClientError('DAEMON_UNAVAILABLE', true);
  if (status === 401 || status === 403) return new WorkflowClientError('PERMISSION_DENIED', false);
  if (status === 404) return new WorkflowClientError('RESOURCE_NOT_FOUND', false);
  if (status === 409) return new WorkflowClientError('VERSION_CONFLICT', false);
  return new WorkflowClientError('WORKFLOW_COMMAND_FAILED', false);
}

async function readSafeErrorCode(response: Response): Promise<ErrorCode | undefined> {
  const length = response.headers.get('content-length');
  if (length && Number(length) > MAX_ERROR_JSON_BYTES) return undefined;
  if (!response.body) return undefined;
  const reader = response.body.getReader();
  let bytes = 0;
  let text = '';
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_ERROR_JSON_BYTES) {
        await reader.cancel();
        return undefined;
      }
      text += new TextDecoder().decode(chunk.value, { stream: true });
    }
    const value = JSON.parse(text) as unknown;
    if (!value || typeof value !== 'object' || !('code' in value)) return undefined;
    const code = (value as { code?: unknown }).code;
    return isSafeErrorCode(code) ? code : undefined;
  } catch {
    return undefined;
  }
}

function validateSafeErrorCode(value: ErrorCode): ErrorCode {
  if (!SAFE_ERROR_CODES.has(value)) throw new WorkflowClientError('VALIDATION_FAILED', false);
  return value;
}

async function readJson(response: Response): Promise<unknown> {
  if (response.status === 204) return undefined;
  const length = response.headers.get('content-length');
  if (length && Number(length) > MAX_JSON_BYTES) throw new WorkflowClientError('WORKFLOW_COMMAND_FAILED', false);
  if (!response.body) throw new WorkflowClientError('WORKFLOW_COMMAND_FAILED', false);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = '';
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_JSON_BYTES) {
        await reader.cancel();
        throw new WorkflowClientError('WORKFLOW_COMMAND_FAILED', false);
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
    return JSON.parse(text);
  } catch (error) {
    if (error instanceof WorkflowClientError) throw error;
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new WorkflowClientError('DAEMON_UNAVAILABLE', true);
    }
    if (error && typeof error === 'object' && 'name' in error && (error as { name?: unknown }).name === 'AbortError') {
      throw new WorkflowClientError('DAEMON_UNAVAILABLE', true);
    }
    throw new WorkflowClientError('WORKFLOW_COMMAND_FAILED', false);
  }
}

function parseContract<T>(schema: { parse(value: unknown): T }, value: unknown): T {
  try {
    return schema.parse(value);
  } catch {
    throw new WorkflowClientError('WORKFLOW_COMMAND_FAILED', false);
  }
}

function toJobObservation(value: ContractJobObservation): JobObservation {
  return {
    jobId: value.jobId,
    status: value.status,
    deadlineAt: value.deadlineAt,
    ...(value.runId !== undefined ? { runId: value.runId } : {}),
    ...(value.errorCode !== undefined ? { errorCode: value.errorCode } : {}),
  };
}

type JobExecution = {
  jobId: string;
  workflowId: string;
  workflowVersion: 1;
};

// The dedicated jobExecutionSchema is present in the current control-plane contract.
// Picking the same fields from the older BackgroundJob schema keeps this worker source
// buildable against the Phase 2B base while preserving strict contract projection.
const jobExecutionSchema = backgroundJobSchema.pick({ jobId: true, workflowId: true, workflowVersion: true });
