import { describe, expect, it } from 'vitest';
import * as contracts from '../src/index.js';

const proposal = { title: '退款进度', goal: '客户了解处理结果', acceptanceCriteria: ['可查看进度'], priority: 'medium', questions: '# 问题确认\n退款进度需要可追溯。' };
describe('工作提案契约', () => {
  it('只允许有界业务草稿，不接受权限和空标准', () => {
    expect(contracts).toHaveProperty('workProposalSchema');
    expect(contracts.workProposalSchema.parse(proposal)).toEqual(proposal);
    for (const input of [{ ...proposal, allowedTools: [] }, { ...proposal, acceptanceCriteria: [] }, { ...proposal, questions: 'x'.repeat(8001) }, { ...proposal, title: '' }])
      expect(contracts.workProposalSchema.safeParse(input).success).toBe(false);
  });
  it('确认必须指定来源回合、确切checksum和confirmed=true', () => {
    expect(contracts).toHaveProperty('workProposalConfirmationSchema');
    const input = { turnId: '11111111-1111-4111-8111-111111111111', proposalChecksum: `sha256:${'a'.repeat(64)}`, confirmed: true };
    expect(contracts.workProposalConfirmationSchema.parse(input)).toEqual(input);
    for (const bad of [{ ...input, confirmed: false }, { ...input, confirmed: undefined }, { ...input, proposal }, { ...input, proposalChecksum: 'invalid' }])
      expect(contracts.workProposalConfirmationSchema.safeParse(bad).success).toBe(false);
  });
  it('兼容旧问答并显式启用提案模式', () => {
    const request = { requestId: '11111111-1111-4111-8111-111111111111', text: '提出退款工作目标', provider: 'qwen' };
    expect(contracts.conversationRequestSchema.parse(request)).toEqual(request);
    expect(contracts.conversationRequestSchema.safeParse({ ...request, mode: 'work-proposal' }).success).toBe(true);
    expect(contracts.conversationRequestSchema.safeParse({ ...request, mode: 'execute' }).success).toBe(false);
  });
  it('解码后提案业务文本拒绝服务URL和凭证模式', () => {
    for (const goal of ['https://private.invalid/v1', 'api_key=synthetic-value', 'Bearer abcdefghijkl', 'sk-syntheticvalue123'])
      expect(contracts.workProposalSchema.safeParse({ ...proposal, goal }).success).toBe(false);
  });
});
