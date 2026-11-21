import { z } from 'zod';

const boundedText = z.string().trim().min(1).max(2000);
const identifier = z.string().trim().min(1).max(200);
const idempotencyKey = z.string().trim().min(1).max(200);

export const prioritySchema = z.enum(['low', 'medium', 'high', 'critical']);
export const taskStageSchema = z.enum([
  'questions', 'research', 'design', 'structure', 'plan', 'implement',
  'verify', 'review', 'delivered',
]);
export const executionStatusSchema = z.enum([
  'queued', 'starting', 'running', 'waiting_input', 'paused', 'reconnecting',
  'completed', 'failed', 'cancelled',
]);
export const artifactTypeSchema = z.enum([
  'questions', 'research', 'design', 'structure', 'plan', 'source-diff',
  'test-report', 'review', 'release-package', 'decision-record',
]);

export type ArtifactType = z.infer<typeof artifactTypeSchema>;

export const projectCreateRequestSchema = z.object({
  name: boundedText.max(120),
  goal: boundedText,
  idempotencyKey,
});

export const taskCreateRequestSchema = z.object({
  title: boundedText.max(120),
  goal: boundedText,
  acceptanceCriteria: z.array(boundedText).min(1).max(50),
  priority: prioritySchema,
  humanOwner: identifier.optional(),
  idempotencyKey: idempotencyKey.optional(),
});

export const executionConfigSchema = z.object({
  daemonId: identifier,
  runtime: z.enum(['codex', 'qwen']),
  credentialRef: identifier,
  modelRef: identifier.optional(),
  workspacePath: z.string().min(1).max(4096),
  allowedTools: z.array(identifier).max(100),
  maxTurns: z.number().int().positive().max(10000),
  timeoutMs: z.number().int().positive().max(86400000),
}).strict();

export const executionCheckpointSchema = z.object({
  id: identifier,
  messages: z.array(z.object({ role: z.enum(['user', 'assistant', 'tool']), text: z.string().max(1000000) }).strict()).max(10000),
  successfulTools: z.array(z.object({ id: identifier, name: identifier, inputHash: identifier, output: z.unknown() }).strict()
    .refine(value => Object.prototype.hasOwnProperty.call(value, 'output'), { message: 'output is required', path: ['output'] })).max(10000),
  evidence: z.array(z.object({ kind: identifier, reference: z.string().max(10000) }).strict()).max(10000),
}).strict();

export const runProgressSchema = z.object({
  eventId: identifier,
  sequence: z.number().int().positive().safe(),
  claimToken: identifier,
  type: z.enum(['running', 'output', 'checkpoint', 'completed', 'failed', 'cancelled', 'waiting_input']),
  payload: z.record(z.unknown()),
  checkpoint: executionCheckpointSchema.optional(),
}).strict().superRefine((value, context) => {
  if (value.type === 'checkpoint' && !value.checkpoint) context.addIssue({ code: z.ZodIssueCode.custom, message: 'checkpoint is required', path: ['checkpoint'] });
});

export const daemonRegistrationSchema = z.object({
  machineName: identifier,
  environmentType: z.enum(['local', 'cloud']),
  capabilities: z.array(identifier).max(100),
  workspaceRoots: z.array(z.string().min(1).max(4096)).min(1).max(100),
  maxConcurrentSessions: z.number().int().positive().max(1000),
  daemonVersion: identifier,
}).strict();

export const daemonEventSchema = z.object({
  daemonId: identifier.optional(),
  eventId: identifier, sequence: z.number().int().positive().safe(),
  eventType: identifier, payload: z.record(z.unknown()),
}).strict();

export const sessionCreateRequestSchema = z.object({
  entryAgent: z.literal('project-manager'),
  goal: boundedText,
  planHash: z.string().trim().min(1).max(200).optional(),
  daemonId: identifier.optional(),
  execution: executionConfigSchema.optional(),
  idempotencyKey,
}).strict();

export const runCreateRequestSchema = z.object({
  inputSnapshotId: identifier.optional(),
  checkpointId: identifier.optional(),
  planHash: z.string().trim().min(1).max(200).optional(),
  idempotencyKey,
}).strict();

export const eventEnvelopeSchema = z.object({
  eventId: identifier,
  eventType: identifier,
  payloadVersion: z.number().int().positive(),
  sequence: z.number().int().positive(),
  traceId: identifier,
  projectId: identifier,
  taskId: identifier.optional(),
  sessionId: identifier.optional(),
  runId: identifier.optional(),
  actor: z.object({
    type: z.enum(['user', 'agent', 'daemon', 'system']),
    id: identifier,
  }),
  occurredAt: z.string().datetime({ offset: true }),
  payload: z.unknown(),
});

export const artifactSchema = z.object({
  artifactId: identifier,
  projectId: identifier,
  taskId: identifier,
  sessionId: identifier.optional(),
  type: artifactTypeSchema,
  version: z.number().int().positive(),
  schemaVersion: z.number().int().positive(),
  uri: z.string().url(),
  checksum: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  status: z.enum(['draft', 'approved', 'archived']),
  sourceArtifacts: z.array(identifier).max(50),
  createdBy: z.object({ type: z.enum(['user', 'agent', 'daemon', 'system']), id: identifier }),
  createdAt: z.string().datetime({ offset: true }),
  reviewState: z.enum(['pending', 'approved', 'changes_requested']),
});

export type ProjectCreateRequest = z.infer<typeof projectCreateRequestSchema>;
export type TaskCreateRequest = z.infer<typeof taskCreateRequestSchema>;
export type SessionCreateRequest = z.infer<typeof sessionCreateRequestSchema>;
export type RunCreateRequest = z.infer<typeof runCreateRequestSchema>;
