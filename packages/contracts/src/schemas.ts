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
  baseUrlRef: identifier.optional(),
  environmentType: z.enum(['local', 'cloud']).optional(),
  snapshotManifestRef: z.string().regex(/^snapshot:\/\/[A-Za-z0-9_-]{1,200}$/).optional(),
  secretLeaseRef: z.string().regex(/^lease:\/\/[A-Za-z0-9_-]{1,200}$/).optional(),
  modelRef: identifier.optional(),
  workspacePath: z.string().min(1).max(4096),
  allowedTools: z.array(identifier).max(100),
  maxTurns: z.number().int().positive().max(10000),
  timeoutMs: z.number().int().positive().max(86400000),
}).strict();

export function validateExecutionConfig(input: unknown): z.infer<typeof executionConfigSchema> {
  const config = executionConfigSchema.parse(input);
  if (config.environmentType === 'cloud') {
    if (!config.snapshotManifestRef || !config.secretLeaseRef || config.workspacePath !== '/workspace/session') {
      throw new z.ZodError([{ code: z.ZodIssueCode.custom, path: ['environmentType'], message: 'cloud requires snapshot and lease references and /workspace/session' }]);
    }
    const reference = /^(?:keychain|broker|secret):\/\/[A-Za-z0-9._/-]+$/;
    if (!reference.test(config.credentialRef) || (config.baseUrlRef && !reference.test(config.baseUrlRef))) {
      throw new z.ZodError([{ code: z.ZodIssueCode.custom, path: ['credentialRef'], message: 'cloud credentials must be secure references' }]);
    }
  }
  return config;
}

export const cloudSnapshotManifestSchema = z.object({
  schemaVersion: z.literal(1), snapshotId: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/),
  baseRevision: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/), checksum: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  fileCount: z.number().int().nonnegative().max(10000), totalBytes: z.number().int().nonnegative().max(32 * 1024 * 1024),
}).strict();
export type CloudSnapshotManifest = z.infer<typeof cloudSnapshotManifestSchema>;
export const handoffCreateRequestSchema = z.object({
  checkpointId: identifier, targetEnvironment: z.literal('cloud'),
  workspaceSync: z.object({ mode: z.enum(['git-snapshot', 'git-patch']) }).strict(), idempotencyKey,
}).strict();
export const handoffSnapshotRequestSchema = z.object({ manifest: cloudSnapshotManifestSchema, stopped: z.literal(true) }).strict();
export const handoffFailureRequestSchema = z.object({
  errorCode: z.enum(['HANDOFF_SNAPSHOT_FAILED', 'HANDOFF_TRANSFER_FAILED', 'HANDOFF_TARGET_UNAVAILABLE']),
}).strict();
export const cloudExecutionStatusSchema = z.enum(['queued', 'creating', 'starting', 'running', 'stopping', 'completed', 'failed', 'cancelled']);
export const cloudLifecycleRequestSchema = z.object({
  claimToken: identifier, status: z.enum(['creating', 'starting', 'running', 'stopping', 'completed', 'failed', 'cancelled']),
  containerId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/).optional(),
  errorCode: z.string().regex(/^[A-Z][A-Z0-9_]{0,99}$/).optional(), consumeSecret: z.boolean().optional(),
}).strict();

export const executionCheckpointSchema = z.object({
  id: identifier,
  messages: z.array(z.object({ role: z.enum(['user', 'assistant', 'tool']), text: z.string().max(32768) }).strict()).max(1000),
  successfulTools: z.array(z.object({ id: identifier, name: identifier, inputHash: identifier, output: z.unknown() }).strict()
    .refine(value => Object.prototype.hasOwnProperty.call(value, 'output'), { message: 'output is required', path: ['output'] })).max(1000),
  evidence: z.array(z.object({ kind: identifier, reference: z.string().max(10000) }).strict()).max(1000),
}).strict();

export const artifactWriteOutputSchema = z.object({
  kind: z.literal('artifact'),
  reference: z.string().regex(/^artifact:\/\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/.+$/i),
  uri: z.string().url(),
  checksum: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  artifactType: artifactTypeSchema.default('source-diff'),
  output: z.literal('written'),
}).strict();

export const progressOutputSchema = z.object({
  source: z.enum(['hook', 'tool']),
  status: boundedText.max(100),
  toolName: identifier,
  toolCallId: identifier,
  hookName: identifier.optional(),
  inputHash: identifier.optional(),
  reason: z.string().max(32768).optional(),
  phase: z.enum(['before', 'after']).optional(),
  output: z.unknown(),
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

export const cloudProgressFenceSchema = z.object({
  reason: z.literal('CLOUD_PROGRESS_FENCED'),
  environmentType: z.literal('cloud'),
  daemonId: identifier,
  runId: identifier,
  eventId: identifier,
  jobStatus: z.enum(['blocked', 'cancelled']),
  runStatus: z.enum(['reconnecting', 'cancelled']),
}).strict().refine(value => (value.jobStatus === 'cancelled') === (value.runStatus === 'cancelled'), {
  message: 'cloud fence job and run states must match',
});
export type CloudProgressFence = z.infer<typeof cloudProgressFenceSchema>;

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
  reference: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});

export type ProjectCreateRequest = z.infer<typeof projectCreateRequestSchema>;
export type TaskCreateRequest = z.infer<typeof taskCreateRequestSchema>;
export type SessionCreateRequest = z.infer<typeof sessionCreateRequestSchema>;
export type RunCreateRequest = z.infer<typeof runCreateRequestSchema>;
