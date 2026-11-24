import { z } from 'zod';
import { errorCodes } from './errors.js';

const id = z.string().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/);
const hash = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const instant = z.string().datetime();
const version = z.number().int().min(1).max(2147483646);
const key = z.string().trim().min(1).max(200);
const claimToken = z.string().regex(/^[a-f0-9]{64}$/);
export const backgroundJobStatusSchema = z.enum(['pending_dispatch', 'dispatching', 'running', 'waiting_input', 'reconnecting', 'cancel_requested', 'completed', 'failed', 'cancelled', 'expired']);
export const orchestrationErrorCodeSchema = z.enum(errorCodes);
export const backgroundJobCreateRequestSchema = z.object({
  kind: z.enum(['run', 'observe']), runInBackground: z.literal(true), planHash: hash,
  deadlineAt: instant, idempotencyKey: key, runId: id.optional(),
}).strict().refine(value => (value.kind === 'observe') === Boolean(value.runId), 'only observe requires runId');
export const jobObservationSchema = z.object({
  jobId: id, status: backgroundJobStatusSchema, deadlineAt: instant,
  runId: id.optional(), errorCode: orchestrationErrorCodeSchema.optional(),
}).strict();
export const jobExecutionSchema = z.object({
  jobId: id, workflowId: z.string().min(1).max(500).regex(/^[A-Za-z0-9][A-Za-z0-9_/:.\-]*$/).refine(value => !value.includes('://'), 'workflow ID cannot be a URL'),
  workflowVersion: z.literal(1),
}).strict();
export const backgroundJobSchema = jobObservationSchema.extend({
  projectId: id, taskId: id, sessionId: id, kind: z.enum(['run', 'observe']), planHash: hash,
  workflowId: z.string().min(1).max(500), workflowVersion: z.literal(1), cancelRequested: z.boolean(),
  version, createdAt: instant,
}).strict();
export const orchestrationPageSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).max(1000000).default(0),
}).strict();

function validCron(value: string): boolean {
  const fields = value.split(' ');
  const ranges = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]] as const;
  return fields.length === 5 && fields.every((field, index) => field.split(',').every(part => {
    const match = /^(\*|\d{1,2}(?:-\d{1,2})?)(?:\/(\d{1,2}))?$/.exec(part);
    if (!match) return false;
    const [min, max] = ranges[index]!;
    if (match[2] && (Number(match[2]) < 1 || Number(match[2]) > max - min + 1)) return false;
    if (match[1] === '*') return true;
    const [start, end = start] = match[1]!.split('-').map(Number);
    return start! >= min && end! <= max && start! <= end!;
  }));
}
export const scheduleDefinitionSchema = z.object({
  planHash: hash,
  timezone: z.string().min(1).max(100).refine(value => {
    try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; } catch { return false; }
  }, 'invalid IANA timezone'),
  cron: z.string().min(9).max(100).refine(validCron, 'requires five numeric cron fields').optional(),
  intervalSeconds: z.number().int().min(60).max(31536000).optional(),
  startsAt: instant, endsAt: instant, maxRuns: z.number().int().min(1).max(100),
  overlapPolicy: z.literal('skip'), catchupWindowSeconds: z.number().int().min(10).max(3600).default(60),
});
const validDefinition = (value: z.infer<typeof scheduleDefinitionSchema>) => Boolean(value.cron) !== Boolean(value.intervalSeconds)
  && Date.parse(value.endsAt) > Date.parse(value.startsAt);
export const scheduleCreateRequestSchema = scheduleDefinitionSchema.extend({ enabled: z.literal(false), idempotencyKey: key }).strict().refine(validDefinition, 'requires one time rule and endsAt after startsAt');
export const scheduleUpdateRequestSchema = scheduleDefinitionSchema.extend({ expectedVersion: version }).strict().refine(validDefinition, 'requires one time rule and endsAt after startsAt');
export const scheduleVersionRequestSchema = z.object({ expectedVersion: version }).strict();
export const scheduleSchema = scheduleDefinitionSchema.extend({
  id, sessionId: id, version, enabled: z.boolean(), runCount: z.number().int().min(0).max(100),
  syncStatus: z.enum(['pending_sync', 'active', 'paused', 'blocked']), temporalScheduleId: id,
  createdAt: instant,
}).strict().refine(validDefinition);
export const scheduleOccurrenceRequestSchema = z.object({
  definitionVersion: version, occurrenceId: z.string().min(1).max(500).regex(/^[A-Za-z0-9][A-Za-z0-9_/:.\-]*$/), scheduledAt: instant,
}).strict();
export const scheduleOccurrenceResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('created'), jobId: id }).strict(),
  z.object({ status: z.literal('skipped') }).strict(),
]);
export const workflowCommandSchema = z.object({
  id, claimToken, kind: z.enum(['start_job', 'cancel_job', 'sync_schedule']), targetId: id, definitionVersion: version.optional(),
}).strict();
export const workflowClaimRequestSchema = z.object({ workerId: id }).strict();
export const workflowCompleteRequestSchema = z.object({ claimToken }).strict();
export const workflowRetryRequestSchema = z.object({ claimToken, retryable: z.boolean(), errorCode: orchestrationErrorCodeSchema }).strict();
export const workflowCancelRequestSchema = z.object({ reason: z.enum(['cancelled', 'expired']) }).strict();
export const orchestrationEmptyRequestSchema = z.object({}).strict();
export type JobObservation = z.infer<typeof jobObservationSchema>;
export type JobExecution = z.infer<typeof jobExecutionSchema>;
export type BackgroundJob = z.infer<typeof backgroundJobSchema>;
export type Schedule = z.infer<typeof scheduleSchema>;
export type WorkflowCommand = z.infer<typeof workflowCommandSchema>;
