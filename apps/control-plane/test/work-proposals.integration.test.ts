import { createHash, randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestApp } from '../src/test-app.js';
import { ArtifactsService } from '../src/modules/artifacts/artifacts.service.js';

const proposal = { title: '退款进度目标', goal: '减少重复咨询', acceptanceCriteria: ['客户可查进度'], priority: 'medium', questions: '# 问题确认\n交付可追溯的退款状态。' };
const checksum = (value: unknown) => `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
const input = () => ({ sourceTurnId: randomUUID(), proposal, proposalChecksum: checksum(proposal), confirmed: true });
let api: Awaited<ReturnType<typeof createTestApp>>;
beforeEach(async () => { vi.stubEnv('TITAN_CONSOLE_TOKEN', 'proposal-test-console'); api = await createTestApp(); });
afterEach(async () => { await api?.close(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });
const post = (body: unknown, key = randomUUID()) => api.post('/api/projects/project_dev/work-proposals/accept').set('Authorization', 'Bearer proposal-test-console').set('Idempotency-Key', key).send(body);

describe('工作提案原子接纳', () => {
  it('只有认证用户可以确认，任务和工件不自动批准或执行', async () => {
    await api.post('/api/projects/project_dev/work-proposals/accept').send(input()).expect(401);
    const source = input();
    const result = await post(source).expect(201);
    expect(result.body.task).toMatchObject({ title: proposal.title, stage: 'questions', version: 1, projectId: 'project_dev' });
    expect(result.body.artifact).toMatchObject({ type: 'questions', status: 'draft', reviewState: 'pending', version: 1, taskId: result.body.task.id });
    const content = await api.get(`/api/artifacts/${result.body.artifact.artifactId}/content`).set('Authorization', 'Bearer proposal-test-console').expect(200);
    expect(content.body.content).toBe(proposal.questions);
    const events = await api.get(`/api/tasks/${result.body.task.id}/events`).expect(200);
    const accepted = events.body.find((event: { eventType: string }) => event.eventType === 'work_proposal.accepted');
    expect(accepted.payload).toMatchObject({ sourceTurnId: source.sourceTurnId, proposalChecksum: source.proposalChecksum });
    expect(JSON.stringify(accepted)).not.toContain(proposal.questions);
    const audit = await api.db.selectFrom('audit_log').selectAll().where('target_id', '=', result.body.task.id).where('action', '=', 'work_proposal.accepted').executeTakeFirst();
    expect(audit).toMatchObject({ actor_type: 'user', actor_id: 'local-user', trace_id: accepted.traceId });
    expect(await api.db.selectFrom('session').select('id').where('task_id', '=', result.body.task.id).execute()).toEqual([]);
  });
  it('同一来源并发确认即使换请求幂等键也只创建一次', async () => {
    const source = input();
    const results = await Promise.all(Array.from({ length: 6 }, () => post(source).expect(201)));
    expect(new Set(results.map(result => result.body.task.id)).size).toBe(1);
    expect(new Set(results.map(result => result.body.artifact.artifactId)).size).toBe(1);
    const changed = { ...proposal, title: '不同目标' };
    await post({ ...source, proposal: changed, proposalChecksum: checksum(changed) }).expect(409);
  });
  it('缺少显式确认、校验和不符或额外权限字段均无业务副作用', async () => {
    const before = await api.db.selectFrom('task').select('id').execute();
    for (const body of [{ ...input(), confirmed: false }, { ...input(), confirmed: undefined }, { ...input(), proposalChecksum: `sha256:${'0'.repeat(64)}` }, { ...input(), allowedTools: ['workspace.write'] }]) await post(body).expect(400);
    expect(await api.db.selectFrom('task').select('id').execute()).toEqual(before);
  });
  it('工件创建失败时回滚任务、事件与幂等记录，重试可成功', async () => {
    const source = input();
    const before = await api.db.selectFrom('task').select('id').execute();
    const fail = vi.spyOn(ArtifactsService.prototype, 'createInTransaction').mockRejectedValueOnce(new Error('synthetic storage failure'));
    await post(source).expect(500);
    expect(await api.db.selectFrom('task').select('id').execute()).toEqual(before);
    expect(await api.db.selectFrom('idempotency_record').selectAll().where('idempotency_key', '=', source.sourceTurnId).execute()).toEqual([]);
    fail.mockRestore();
    await post(source).expect(201);
  });
});
