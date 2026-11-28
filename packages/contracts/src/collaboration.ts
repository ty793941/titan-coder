import { z } from 'zod';

const id = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/);
const key = z.string().trim().min(1).max(200);
const instant = z.string().datetime();
const version = z.number().int().min(1).max(2147483646);
const safeText = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine(
      (value) =>
        !/(?:https?|wss?):\/\/|-----BEGIN [^-]*PRIVATE KEY-----|(?:api[_-]?key|token|secret|password)\s*[:=]\s*[^\s,;]+|\bBearer\s+[A-Za-z0-9._~+/=-]{8,}|\bsk-[A-Za-z0-9_-]{8,}/i.test(
          value,
        ),
      '协作说明不得包含凭证或服务URL',
    );

export const collaborationErrorCodeSchema = z.enum([
  'COLLABORATION_NOT_FOUND',
  'COLLABORATION_VERSION_CONFLICT',
  'COLLABORATION_PERMISSION_DENIED',
  'COLLABORATION_INVALID_STATE',
  'COLLABORATION_DUPLICATE',
  'COLLABORATION_ASSIGNMENT_REQUIRED',
  'COLLABORATION_REVIEW_REQUIRED',
  'COLLABORATION_HANDOFF_CONFLICT',
]);

export const subjectRefSchema = z
  .object({
    subjectType: z.enum(['human', 'agent']),
    subjectId: id,
  })
  .strict();

export const assignmentCreateRequestSchema = z
  .object({
    subjectType: subjectRefSchema.shape.subjectType,
    subjectId: id,
    responsibility: z.enum([
      'human-owner',
      'agent-owner',
      'reviewer',
      'observer',
    ]),
    reviewers: z
      .array(id)
      .max(20)
      .refine(
        (values) => new Set(values).size === values.length,
        '评审人不能重复',
      ),
    dueAt: instant.optional(),
    idempotencyKey: key.optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.responsibility !== 'human-owner' || value.subjectType === 'human',
    '人类负责人必须为human',
  )
  .refine(
    (value) =>
      value.responsibility !== 'agent-owner' || value.subjectType === 'agent',
    'Agent负责人必须为agent',
  );

export const reviewRequestCreateSchema = z
  .object({
    projectId: id,
    targetType: z.enum(['task', 'artifact', 'run', 'work-item']),
    targetId: id,
    reviewerSubject: subjectRefSchema,
    gate: z.enum([
      'questions',
      'research',
      'design',
      'structure',
      'plan',
      'implement',
      'verify',
      'review',
      'release',
    ]),
    requiredDecision: z.enum(['approve', 'changes_requested']),
    mode: z.enum(['serial', 'parallel']).default('serial'),
    dueAt: instant.optional(),
    idempotencyKey: key.optional(),
  })
  .strict();

export const collaborationHandoffCreateRequestSchema = z
  .object({
    toSubject: subjectRefSchema,
    reason: safeText(2000),
    contextArtifactId: id.optional(),
    openQuestions: z.array(safeText(1000)).max(50),
    risks: z.array(safeText(1000)).max(50),
    nextActions: z.array(safeText(1000)).max(50),
    idempotencyKey: key.optional(),
  })
  .strict();

export const collaborationVersionRequestSchema = z
  .object({ expectedVersion: version })
  .strict();
export const collaborationReviewDecisionSchema =
  collaborationVersionRequestSchema
    .extend({ reason: safeText(2000).optional() })
    .strict();
export const collaborationMemberRequestSchema = subjectRefSchema
  .extend({
    role: z.enum(['owner', 'manager', 'developer', 'reviewer', 'observer']),
    expectedVersion: version.optional(),
  })
  .strict();
export const collaborationEmptyRequestSchema = z.object({}).strict();
export const collaborationPageSchema = z
  .object({
    projectId: id,
    status: z
      .enum(['pending', 'read', 'resolved', 'dismissed'])
      .default('pending'),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    offset: z.coerce.number().int().min(0).max(1000000).default(0),
  })
  .strict();

export type AssignmentCreateRequest = z.infer<
  typeof assignmentCreateRequestSchema
>;
export type ReviewRequestCreate = z.infer<typeof reviewRequestCreateSchema>;
export type CollaborationHandoffCreateRequest = z.infer<
  typeof collaborationHandoffCreateRequestSchema
>;

const stored = { id, projectId: id, version, createdAt: instant };
export const collaborationMemberSchema = z
  .object({
    ...stored,
    subjectType: subjectRefSchema.shape.subjectType,
    subjectId: id,
    role: z.enum(['owner', 'manager', 'developer', 'reviewer', 'observer']),
    status: z.enum(['invited', 'active', 'suspended', 'removed']),
  })
  .strict();
export const collaborationAssignmentSchema = z
  .object({
    ...stored,
    workItemId: id,
    subjectType: subjectRefSchema.shape.subjectType,
    subjectId: id,
    responsibility: z.enum([
      'human-owner',
      'agent-owner',
      'reviewer',
      'observer',
    ]),
    status: z.enum([
      'pending',
      'active',
      'accepted',
      'declined',
      'completed',
      'superseded',
    ]),
    reviewers: z.array(id).max(20),
    dueAt: instant.nullable(),
  })
  .strict();
export const collaborationWorkItemSchema = z
  .object({
    ...stored,
    taskId: id,
    status: z.enum([
      'backlog',
      'ready',
      'in_progress',
      'blocked',
      'review',
      'completed',
      'cancelled',
    ]),
  })
  .strict();
export const collaborationWorkItemDetailSchema = collaborationWorkItemSchema
  .extend({ assignments: z.array(collaborationAssignmentSchema).max(100) })
  .strict();
export const collaborationReviewSchema = z
  .object({
    ...stored,
    targetType: reviewRequestCreateSchema.shape.targetType,
    targetId: id,
    reviewerType: subjectRefSchema.shape.subjectType,
    reviewerId: id,
    gate: reviewRequestCreateSchema.shape.gate,
    requiredDecision: reviewRequestCreateSchema.shape.requiredDecision,
    mode: z.enum(['serial', 'parallel']),
    status: z.enum([
      'pending',
      'approved',
      'changes_requested',
      'cancelled',
      'expired',
    ]),
    dueAt: instant.nullable(),
    resolvedAt: instant.nullable(),
    resolutionReason: z.string().max(2000).nullable(),
    targetVersion: version,
    predecessorId: id.nullable(),
  })
  .strict();
export const collaborationHandoffSchema = z
  .object({
    ...stored,
    workItemId: id,
    fromAssignmentId: id,
    toSubjectType: subjectRefSchema.shape.subjectType,
    toSubjectId: id,
    reason: z.string().max(2000),
    contextArtifactId: id.nullable(),
    openQuestions: z.array(z.string()).max(50),
    risks: z.array(z.string()).max(50),
    nextActions: z.array(z.string()).max(50),
    status: z.enum(['pending_acceptance', 'accepted', 'declined', 'cancelled']),
    resolvedAt: instant.nullable(),
    newAssignmentId: id.nullable(),
  })
  .strict();
export const collaborationInboxSchema = z
  .object({
    ...stored,
    subjectType: subjectRefSchema.shape.subjectType,
    subjectId: id,
    kind: z.enum(['assignment', 'review', 'handoff', 'approval', 'blocked']),
    sourceId: id,
    status: z.enum(['pending', 'read', 'resolved', 'dismissed']),
    resolvedAt: instant.nullable(),
  })
  .strict();
export const collaborationInboxListItemSchema = collaborationInboxSchema
  .extend({ title: z.string().max(120) })
  .strict();
