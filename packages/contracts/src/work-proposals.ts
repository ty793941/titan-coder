import { z } from 'zod';

const sensitiveText = /(?:https?|wss?):\/\/|-----BEGIN [^-]*PRIVATE KEY-----|(?:api[_-]?key|token|secret|password)\s*[:=]\s*[^\s,;]+|\bBearer\s+[A-Za-z0-9._~+/=-]{8,}|\b(?:sk|key|token)[-_][A-Za-z0-9_-]{8,}\b/i;
const proposalText = (max: number) => z.string().trim().min(1).max(max).refine(value => !sensitiveText.test(value), '提案不得包含凭证或服务URL');
export const workProposalSchema = z.object({
  title: proposalText(120),
  goal: proposalText(2000),
  acceptanceCriteria: z.array(proposalText(500)).min(1).max(20),
  priority: z.enum(['low', 'medium', 'high', 'critical']),
  questions: proposalText(8000),
}).strict();
export const proposalChecksumSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
export const workProposalConfirmationSchema = z.object({
  turnId: z.string().uuid(),
  proposalChecksum: proposalChecksumSchema,
  confirmed: z.literal(true),
}).strict();
export const workProposalAcceptRequestSchema = z.object({
  sourceTurnId: z.string().uuid(),
  proposalChecksum: proposalChecksumSchema,
  proposal: workProposalSchema,
  confirmed: z.literal(true),
}).strict();
export type WorkProposal = z.infer<typeof workProposalSchema>;
