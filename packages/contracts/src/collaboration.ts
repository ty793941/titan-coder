import { z } from 'zod';

const id = z.string().trim().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/);
const key = z.string().trim().min(1).max(200);
const instant = z.string().datetime();

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

export const subjectRefSchema = z.object({
  subjectType: z.enum(['human', 'agent']), subjectId: id,
}).strict();

export const assignmentCreateRequestSchema = z.object({
  subjectType: subjectRefSchema.shape.subjectType,
  subjectId: id,
  responsibility: z.enum(['human-owner', 'agent-owner', 'reviewer', 'observer']),
  reviewers: z.array(z.string().trim().min(1).max(200)).max(20),
  dueAt: instant.optional(),
  idempotencyKey: key.optional(),
}).strict();

export const reviewRequestCreateSchema = z.object({
  targetType: z.enum(['task', 'artifact', 'run', 'work-item']),
  targetId: id,
  reviewerSubject: subjectRefSchema,
  gate: z.enum(['questions', 'research', 'design', 'structure', 'plan', 'implement', 'verify', 'review', 'release']),
  requiredDecision: z.enum(['approve', 'changes_requested']),
  mode: z.enum(['serial', 'parallel', 'conditional']).default('serial'),
  dueAt: instant.optional(),
  idempotencyKey: key.optional(),
}).strict();

export const handoffCreateRequestSchema = z.object({
  toSubject: subjectRefSchema,
  reason: z.string().trim().min(1).max(2000),
  contextArtifactId: id.optional(),
  openQuestions: z.array(z.string().trim().min(1).max(1000)).max(50),
  risks: z.array(z.string().trim().min(1).max(1000)).max(50),
  nextActions: z.array(z.string().trim().min(1).max(1000)).max(50),
  idempotencyKey: key.optional(),
}).strict();

export const collaborationVersionRequestSchema = z.object({ expectedVersion: z.number().int().min(1).max(2147483646) }).strict();
export const collaborationPageSchema = z.object({
  projectId: id.optional(), subjectType: z.enum(['human', 'agent']).optional(), subjectId: id.optional(),
  status: z.enum(['pending', 'read', 'resolved', 'dismissed']).default('pending'),
  limit: z.coerce.number().int().min(1).max(100).default(50), offset: z.coerce.number().int().min(0).max(1000000).default(0),
}).strict();

export type AssignmentCreateRequest = z.infer<typeof assignmentCreateRequestSchema>;
export type ReviewRequestCreate = z.infer<typeof reviewRequestCreateSchema>;
export type HandoffCreateRequest = z.infer<typeof handoffCreateRequestSchema>;
