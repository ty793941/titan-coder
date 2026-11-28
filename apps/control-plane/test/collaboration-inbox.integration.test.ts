import { randomUUID } from 'node:crypto';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { createTestApp } from '../src/test-app.js';
import { EventsService } from '../src/modules/events/events.service.js';

let api: Awaited<ReturnType<typeof createTestApp>>;
const auth = 'Bearer collaboration-inbox-test';
const post = (path: string, body: unknown = {}, key = randomUUID()) =>
  api
    .post(path)
    .set('Authorization', auth)
    .set('Idempotency-Key', key)
    .send(body);
const get = (query = '') =>
  api
    .get(`/api/me/inbox?projectId=project_dev${query}`)
    .set('Authorization', auth);
beforeEach(async () => {
  vi.stubEnv('TITAN_CONSOLE_TOKEN', 'collaboration-inbox-test');
  api = await createTestApp();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await api?.close();
  vi.unstubAllEnvs();
});
async function assign() {
  await post('/api/projects/project_dev/members', {
    subjectType: 'human',
    subjectId: 'local-user',
    role: 'reviewer',
  }).expect(201);
  const { body: item } = await post('/api/tasks/task_dev/work-item').expect(
    201,
  );
  const { body: assignment } = await post(
    `/api/work-items/${item.id}/assignments`,
    {
      subjectType: 'human',
      subjectId: 'local-user',
      responsibility: 'human-owner',
      reviewers: [],
    },
  ).expect(201);
  return { item, assignment };
}

it('并发串行评审只有一个根节点，且不允许混用串并行队列', async () => {
  await assign();
  for (const subjectId of ['reviewer-a', 'reviewer-b', 'reviewer-c'])
    await post('/api/projects/project_dev/members', {
      subjectType: 'human',
      subjectId,
      role: 'reviewer',
    }).expect(201);
  const body = {
    projectId: 'project_dev',
    targetType: 'task',
    targetId: 'task_dev',
    gate: 'questions',
    requiredDecision: 'approve',
    mode: 'serial',
  };
  const results = await Promise.all(
    ['reviewer-a', 'reviewer-b'].map((subjectId) =>
      post('/api/review-requests', {
        ...body,
        reviewerSubject: { subjectType: 'human', subjectId },
      }).expect(201),
    ),
  );
  expect(
    results.filter((result) => result.body.predecessorId === null),
  ).toHaveLength(1);
  const root = results.find(
    (result) => result.body.predecessorId === null,
  )!.body;
  const second = results.find(
    (result) => result.body.predecessorId !== null,
  )!.body;
  expect(second.predecessorId).toBe(root.id);
  await api.db
    .updateTable('review_request')
    .set({ created_at: new Date('2020-01-01') })
    .where('id', '=', second.id)
    .execute();
  const third = await post('/api/review-requests', {
    ...body,
    reviewerSubject: { subjectType: 'human', subjectId: 'reviewer-c' },
  }).expect(201);
  expect(third.body.predecessorId).toBe(second.id);
  await post('/api/review-requests', {
    ...body,
    mode: 'parallel',
    reviewerSubject: { subjectType: 'human', subjectId: 'local-user' },
  }).expect(409);
});

it('不存在的协作父资源读取返回404而非空集合', async () => {
  for (const path of [
    '/api/projects/missing/members',
    '/api/projects/missing/review-requests',
    '/api/work-items/missing/assignments',
    '/api/work-items/missing/handoffs',
  ])
    await api.get(path).set('Authorization', auth).expect(404);
});

it('我的Inbox不能用请求参数冒充主体或读取未加入的项目', async () => {
  await api.get('/api/me/inbox?projectId=project_dev').expect(401);
  await get().expect(403);
  await assign();
  await get('&subjectId=other').expect(400);
  await get('&limit=101').expect(400);
  await api
    .get('/api/me/inbox?projectId=another')
    .set('Authorization', auth)
    .expect(403);
  const first = await get().expect(200);
  const second = await get().expect(200);
  expect(second.body).toEqual(first.body);
  expect(first.body).toHaveLength(1);
  expect(first.body[0]).toMatchObject({
    subjectId: 'local-user',
    kind: 'assignment',
    status: 'pending',
    version: 1,
  });
});

it('接受分配后Inbox原子收敛并阻止用Inbox解决旁路', async () => {
  const { assignment } = await assign();
  const inbox = (await get().expect(200)).body[0];
  await post(`/api/inbox/${inbox.id}/resolve`, { expectedVersion: 1 }).expect(
    409,
  );
  await post(`/api/inbox/${inbox.id}/read`, { expectedVersion: 1 }).expect(200);
  await post(`/api/inbox/${inbox.id}/read`, { expectedVersion: 1 }).expect(200);
  await post(`/api/inbox/${inbox.id}/dismiss`, { expectedVersion: 1 }).expect(
    409,
  );
  await post(`/api/assignments/${assignment.id}/accept`, {
    expectedVersion: 1,
  }).expect(200);
  const done = await get('&status=resolved').expect(200);
  expect(done.body).toHaveLength(1);
  expect(done.body[0].version).toBe(3);
  expect((await get().expect(200)).body).toEqual([]);
});

it('事件写入失败回滚分配、Inbox、审计和幂等记录', async () => {
  const { item } = await assign();
  const before = await api.db.selectFrom('assignment').select('id').execute();
  const fail = vi
    .spyOn(EventsService.prototype, 'append')
    .mockRejectedValueOnce(new Error('synthetic event failure'));
  const path = `/api/work-items/${item.id}/assignments`;
  const input = {
    subjectType: 'human',
    subjectId: 'local-user',
    responsibility: 'observer',
    reviewers: [],
  };
  await post(path, input, 'retry-rollback').expect(500);
  expect(await api.db.selectFrom('assignment').select('id').execute()).toEqual(
    before,
  );
  expect(
    await api.db.selectFrom('collaboration_inbox_item').select('id').execute(),
  ).toHaveLength(1);
  expect(
    await api.db
      .selectFrom('idempotency_record')
      .select('idempotency_key')
      .where('idempotency_key', '=', 'retry-rollback')
      .execute(),
  ).toHaveLength(0);
  fail.mockRestore();
  await post(path, input, 'retry-rollback').expect(201);
});

it('评审拒绝保留原因并生成阻塞事项，不修改工件审批或启动任务', async () => {
  await assign();
  const { body: review } = await post('/api/review-requests', {
    projectId: 'project_dev',
    targetType: 'task',
    targetId: 'task_dev',
    reviewerSubject: { subjectType: 'human', subjectId: 'local-user' },
    gate: 'questions',
    requiredDecision: 'approve',
  }).expect(201);
  await post(`/api/review-requests/${review.id}/request-changes`, {
    expectedVersion: 1,
  }).expect(400);
  await post(`/api/review-requests/${review.id}/request-changes`, {
    expectedVersion: 1,
    reason: '需要补充退款边界',
  }).expect(200);
  const inbox = await get().expect(200);
  expect(
    inbox.body.some((item: { kind: string }) => item.kind === 'blocked'),
  ).toBe(true);
  expect(
    await api.db.selectFrom('session').select('id').execute(),
  ).toHaveLength(0);
});

it('串行评审不能越过前序门禁且目标新版本使旧评审失效', async () => {
  await assign();
  await post('/api/projects/project_dev/members', {
    subjectType: 'human',
    subjectId: 'prior',
    role: 'reviewer',
  }).expect(201);
  const request = {
    projectId: 'project_dev',
    targetType: 'task',
    targetId: 'task_dev',
    reviewerSubject: { subjectType: 'human', subjectId: 'prior' },
    gate: 'questions',
    requiredDecision: 'approve',
    mode: 'serial',
  };
  const { body: prior } = await post('/api/review-requests', request).expect(
    201,
  );
  const { body: own } = await post('/api/review-requests', {
    ...request,
    reviewerSubject: { subjectType: 'human', subjectId: 'local-user' },
  }).expect(201);
  await post(`/api/review-requests/${own.id}/approve`, {
    expectedVersion: 1,
  }).expect(409);
  await api.db
    .updateTable('review_request')
    .set({ status: 'approved', version: 2 })
    .where('id', '=', prior.id)
    .execute();
  await api.db
    .updateTable('task')
    .set({ version: 2 })
    .where('id', '=', 'task_dev')
    .execute();
  await post(`/api/review-requests/${own.id}/approve`, {
    expectedVersion: 1,
  }).expect(409);
  await post(`/api/review-requests/${own.id}/cancel`, {
    expectedVersion: 1,
  }).expect(200);
});
