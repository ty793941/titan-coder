import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestApp } from '../src/test-app.js';
import {
  collaborationAssignmentSchema,
  collaborationMemberSchema,
  collaborationWorkItemSchema,
  collaborationReviewSchema,
  collaborationHandoffSchema,
} from '@titan/contracts';

let api: Awaited<ReturnType<typeof createTestApp>>;
const auth = 'Bearer collaboration-test';
const member = (id: string, role = 'developer') =>
  api
    .post('/api/projects/project_dev/members')
    .set('Authorization', auth)
    .send({ subjectType: 'human', subjectId: id, role });
const post = (path: string, body: unknown = {}, key = randomUUID()) =>
  api
    .post(path)
    .set('Authorization', auth)
    .set('Idempotency-Key', key)
    .send(body);
beforeEach(async () => {
  vi.stubEnv('TITAN_CONSOLE_TOKEN', 'collaboration-test');
  api = await createTestApp();
});
afterEach(async () => {
  await api?.close();
  vi.unstubAllEnvs();
});

describe('协作责任事务', () => {
  it('拒绝未认证调用和请求自报操作者', async () => {
    await api.post('/api/tasks/task_dev/work-item').send({}).expect(401);
    await post('/api/tasks/task_dev/work-item', { actorId: 'other' }).expect(
      400,
    );
  });
  it('并发创建工作项只创建一次且项目成员分配幂等', async () => {
    const items = await Promise.all(
      Array.from({ length: 4 }, () =>
        post('/api/tasks/task_dev/work-item').expect(201),
      ),
    );
    expect(new Set(items.map((item) => item.body.id)).size).toBe(1);
    expect(collaborationWorkItemSchema.safeParse(items[0]!.body).success).toBe(
      true,
    );
    const membership = await member('local-user', 'owner').expect(201);
    expect(collaborationMemberSchema.safeParse(membership.body).success).toBe(
      true,
    );
    const path = `/api/work-items/${items[0]!.body.id}/assignments`;
    const input = {
      subjectType: 'human',
      subjectId: 'local-user',
      responsibility: 'human-owner',
      reviewers: [],
    };
    const first = await post(path, input, 'assign-1').expect(201);
    const replay = await post(path, input, 'assign-1').expect(201);
    expect(collaborationAssignmentSchema.safeParse(first.body).success).toBe(
      true,
    );
    expect(replay.body).toEqual(first.body);
    await post(path, { ...input, subjectId: 'unknown' }).expect(403);
    await post(`/api/assignments/${first.body.id}/accept`, {
      expectedVersion: 1,
    }).expect(200);
    await post(`/api/assignments/${first.body.id}/complete`, {
      expectedVersion: 1,
    }).expect(409);
    const done = await post(`/api/assignments/${first.body.id}/complete`, {
      expectedVersion: 2,
    }).expect(200);
    expect(done.body).toMatchObject({ status: 'completed', version: 3 });
    expect(
      await api.db
        .selectFrom('audit_log')
        .select('id')
        .where('target_id', '=', first.body.id)
        .execute(),
    ).toHaveLength(3);
  });
  it('拒绝重复负责人和跨项目成员，同时允许多个观察者', async () => {
    const { body: item } = await post('/api/tasks/task_dev/work-item').expect(
      201,
    );
    for (const id of ['local-user', 'second']) await member(id).expect(201);
    const path = `/api/work-items/${item.id}/assignments`;
    const input = {
      subjectType: 'human',
      subjectId: 'local-user',
      responsibility: 'human-owner',
      reviewers: [],
    };
    await post(path, input).expect(201);
    await post(path, { ...input, subjectId: 'second' }).expect(409);
    await post(path, { ...input, responsibility: 'observer' }).expect(201);
    await post(path, {
      ...input,
      responsibility: 'observer',
      subjectId: 'second',
    }).expect(201);
    await post(path, {
      ...input,
      subjectType: 'agent',
      responsibility: 'human-owner',
    }).expect(400);
  });
});

describe('协作评审与交接', () => {
  it('评审不可冒充其他成员，决议只记录评审而不自动批准工件', async () => {
    await member('local-user', 'reviewer').expect(201);
    await member('other', 'reviewer').expect(201);
    const body = {
      projectId: 'project_dev',
      targetType: 'task',
      targetId: 'task_dev',
      reviewerSubject: { subjectType: 'human', subjectId: 'other' },
      gate: 'questions',
      requiredDecision: 'approve',
      mode: 'parallel',
    };
    const other = await post('/api/review-requests', body).expect(201);
    await post(`/api/review-requests/${other.body.id}/approve`, {
      expectedVersion: 1,
    }).expect(403);
    const own = await post('/api/review-requests', {
      ...body,
      reviewerSubject: { subjectType: 'human', subjectId: 'local-user' },
    }).expect(201);
    const accepted = await post(`/api/review-requests/${own.body.id}/approve`, {
      expectedVersion: 1,
    }).expect(200);
    expect(collaborationReviewSchema.safeParse(accepted.body).success).toBe(
      true,
    );
    expect(accepted.body).toMatchObject({ status: 'approved', version: 2 });
    await post('/api/review-requests', { ...body, mode: 'conditional' }).expect(
      400,
    );
  });
  it('交接等待接收人确认，接受后原负责人降为观察者且只产生一个新负责人', async () => {
    await member('previous', 'owner').expect(201);
    await member('local-user', 'owner').expect(201);
    const { body: item } = await post('/api/tasks/task_dev/work-item').expect(
      201,
    );
    const { body: assignment } = await post(
      `/api/work-items/${item.id}/assignments`,
      {
        subjectType: 'human',
        subjectId: 'previous',
        responsibility: 'human-owner',
        reviewers: [],
      },
    ).expect(201);
    const input = {
      toSubject: { subjectType: 'human', subjectId: 'local-user' },
      reason: '交接负责人',
      openQuestions: ['仍需评审'],
      risks: [],
      nextActions: ['阅读上下文'],
    };
    const { body: handoff } = await post(
      `/api/assignments/${assignment.id}/handoffs`,
      input,
    ).expect(201);
    expect(collaborationHandoffSchema.safeParse(handoff).success).toBe(true);
    expect(
      (await api.db
        .selectFrom('assignment')
        .selectAll()
        .where('id', '=', assignment.id)
        .executeTakeFirst())!.status,
    ).toBe('pending');
    const responses = await Promise.all(
      Array.from({ length: 3 }, () =>
        post(`/api/handoffs/${handoff.id}/accept`, { expectedVersion: 1 }),
      ),
    );
    expect(
      responses.filter((response) => response.status === 200),
    ).toHaveLength(3);
    const current = await api.db
      .selectFrom('assignment')
      .selectAll()
      .where('work_item_id', '=', item.id)
      .where('responsibility', '=', 'human-owner')
      .where('status', 'in', ['pending', 'active', 'accepted'])
      .execute();
    expect(current).toHaveLength(1);
    expect(current[0]!.subject_id).toBe('local-user');
    const original = await api.db
      .selectFrom('assignment')
      .selectAll()
      .where('id', '=', assignment.id)
      .executeTakeFirstOrThrow();
    expect(original).toMatchObject({
      responsibility: 'observer',
      status: 'superseded',
    });
  });

  it('异键并发创建评审不会重复，交接拒绝后旧责任保持有效', async () => {
    await member('local-user', 'reviewer').expect(201);
    const reviewInput = {
      projectId: 'project_dev',
      targetType: 'task',
      targetId: 'task_dev',
      reviewerSubject: { subjectType: 'human', subjectId: 'local-user' },
      gate: 'questions',
      requiredDecision: 'approve',
    };
    const reviews = await Promise.all(
      Array.from({ length: 4 }, () =>
        post('/api/review-requests', reviewInput),
      ),
    );
    expect(reviews.filter((result) => result.status === 201)).toHaveLength(1);
    expect(reviews.filter((result) => result.status === 409)).toHaveLength(3);
    await member('previous', 'owner').expect(201);
    const { body: item } = await post('/api/tasks/task_dev/work-item').expect(
      201,
    );
    const { body: assignment } = await post(
      `/api/work-items/${item.id}/assignments`,
      {
        subjectType: 'human',
        subjectId: 'previous',
        responsibility: 'human-owner',
        reviewers: [],
      },
    ).expect(201);
    const { body: handoff } = await post(
      `/api/assignments/${assignment.id}/handoffs`,
      {
        toSubject: { subjectType: 'human', subjectId: 'local-user' },
        reason: '更换责任人',
        openQuestions: [],
        risks: [],
        nextActions: [],
      },
    ).expect(201);
    await post(`/api/handoffs/${handoff.id}/decline`, {
      expectedVersion: 1,
    }).expect(200);
    const old = await api.db
      .selectFrom('assignment')
      .selectAll()
      .where('id', '=', assignment.id)
      .executeTakeFirstOrThrow();
    expect(old).toMatchObject({
      subject_id: 'previous',
      responsibility: 'human-owner',
      status: 'pending',
    });
  });
});
