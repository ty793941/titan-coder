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

export const sessionCreateRequestSchema = z.object({
  entryAgent: z.literal('project-manager'),
  goal: boundedText,
  planHash: z.string().trim().min(1).max(200).optional(),
  daemonId: identifier.optional(),
  idempotencyKey,
});

export const runCreateRequestSchema = z.object({
  inputSnapshotId: identifier.optional(),
  checkpointId: identifier.optional(),
  planHash: z.string().trim().min(1).max(200).optional(),
  idempotencyKey,
});

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
