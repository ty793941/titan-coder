import { z } from "zod";
import { workProposalSchema, proposalChecksumSchema } from "./work-proposals.js";

export const conversationProjectIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,120}$/);
export const conversationRequestSchema = z
  .object({
    requestId: z.string().uuid(),
    text: z.string().trim().min(1).max(4000),
    provider: z.enum(["codex", "qwen"]),
    mode: z.literal("work-proposal").optional(),
    modelRef: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .regex(/^[A-Za-z0-9._:/-]+$/)
      .optional(),
  })
  .strict();
export const conversationContextSchema = z
  .object({
    projectId: conversationProjectIdSchema,
    name: z.string().max(200),
    goal: z.string().max(2000),
    tasks: z
      .array(
        z
          .object({
            id: z.string().max(120),
            title: z.string().max(200),
            stage: z.string().max(40),
            status: z.string().max(40),
          })
          .strict(),
      )
      .max(20),
  })
  .strict();
export const conversationTurnSchema = z
  .object({
    id: z.string().uuid(),
    requestId: z.string().uuid(),
    fingerprint: z.string().length(64),
    text: z.string().max(4000),
    provider: z.enum(["codex", "qwen"]),
    modelRef: z.string().max(120).optional(),
    status: z.enum(["running", "completed", "failed", "cancelled"]),
    reply: z.string().max(16000).optional(),
    mode: z.literal("work-proposal").optional(),
    proposal: workProposalSchema.optional(),
    proposalChecksum: proposalChecksumSchema.optional(),
    errorCode: z
      .enum([
        "CONVERSATION_FAILED",
        "CONVERSATION_TIMEOUT",
        "CONVERSATION_INTERRUPTED",
        "CONVERSATION_READ_ONLY",
        "CONVERSATION_PROPOSAL_INVALID",
      ])
      .optional(),
    createdAt: z.string().datetime(),
    finishedAt: z.string().datetime().optional(),
  })
  .strict();
export const conversationSnapshotSchema = z
  .object({
    projectId: conversationProjectIdSchema,
    turns: z.array(conversationTurnSchema).max(40),
  })
  .strict();
export type ConversationRequest = z.infer<typeof conversationRequestSchema>;
export type ConversationContext = z.infer<typeof conversationContextSchema>;
export type ConversationTurn = z.infer<typeof conversationTurnSchema>;
export type ConversationSnapshot = z.infer<typeof conversationSnapshotSchema>;
