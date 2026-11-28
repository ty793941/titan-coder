# 协作责任与评审后端基础实施计划

> 执行方式：按任务逐项实现、测试和只读评审；使用独立工作树，不修改正式 UI 布局。

**目标：** 为 Titan 建立可持久化、可审计、带版本和幂等边界的项目协作责任基础，支持成员/Agent 责任、任务分配、评审请求、任务交接和项目 Inbox 查询。

**架构：** 在 PostgreSQL 中新增项目成员、工作项、分配、评审请求、交接和 Inbox 事实表；控制面通过独立 Collaboration Service 在事务内完成状态变更、事件和审计。工作项第一版以现有 Task 为业务目标来源，但保留稳定 `work_item` ID，后续可以承载 Task 下的拆分工作。成员和 Agent 只保存主体引用，不保存凭证、Prompt、Checkpoint 或原始工具输出。所有写操作使用项目/资源锁、版本校验和幂等记录。

**技术栈：** Node.js 22、TypeScript、NestJS/Fastify、Kysely、PostgreSQL、Zod、OpenAPI、Vitest。

---

## 实施记录与范围修正

- [x] 契约、六张协作事实表、响应 Schema、OpenAPI 和可重复执行数据库脚本。
- [x] 成员引用、可选工作项、责任分配、个人接纳/拒绝/完成、固定管理身份和事务审计。
- [x] 串行/并行评审、目标版本检查、责任交接接纳/拒绝、唯一负责人和幂等重放。
- [x] 当前操作者的项目 Inbox、分页、已读/隐藏、来源状态原子收敛和旁路拒绝。
- [x] 控制面 199 项、契约 60 项、原网关/前端 69 项回归通过；全仓无缓存 33 项构建/类型/静态检查任务通过；最终只读评审 `approve`。

实现前核实的身份边界：现有系统只有可信本机 Console，没有成员登录。故管理操作沿用Console，个人动作只允许当前 `human/local-user`，Inbox 不接受客户端指定主体。外部成员和Agent只登记责任引用，不伪造完整多人权限。当前project也没有status字段，不以不存在的项目归档状态做权限判断。

实现收敛：条件评审拒绝创建，只支持有执行语义的serial/parallel；requiredDecision固定approve，允许评审人合法要求修改；拒绝产生有原因的评审记录及blocked Inbox，不自动创建返工Task。成员停用/移除、工作项状态推进及Task下多工作项拆分未包含本轮。上下文工件额外限定同Task，列表先校验父资源存在。

共享服务直接在既有AppModule注册，取消最初新增的子Module以避免重复EventsService实例。完整回归发现并修复了这个SSE兼容缺陷；未通过增加超时掩盖它。串行尾节点按前序关系确定，不依赖事务创建时间；并发不同评审人和时间戳乱序均有真实数据库回归。

后文保留最初分步设计作为实施输入，最终接口与范围以 `docs/collaboration-backend-acceptance.md` 为准；未实现项继续记入 `docs/non-ui-delivery-status.md`，不因为本轮基础交付而勾选整个Phase 3。

## 文件结构与职责

- `packages/contracts/src/collaboration.ts`：成员、工作项、分配、评审请求、交接和 Inbox 的 Zod Schema、类型及错误码。
- `packages/contracts/src/index.ts`：导出协作契约。
- `packages/contracts/openapi/control-plane.openapi.json`：协作 API 的公开契约。
- `database/schema.sql`：新增协作事实表、约束和索引，保持可重复执行。
- `apps/control-plane/src/database/types.ts`：Kysely 协作表类型。
- `apps/control-plane/src/modules/collaboration/collaboration.service.ts`：事务、锁、版本、幂等、事件和审计。
- `apps/control-plane/src/modules/collaboration/collaboration.controller.ts`：项目成员、工作项、分配、评审、交接和 Inbox 路由。
- `apps/control-plane/src/modules/collaboration/collaboration.module.ts`：模块边界。
- `apps/control-plane/src/app.module.ts`：注册协作模块。
- `apps/control-plane/test/collaboration.integration.test.ts`：真实 PostgreSQL 事务、并发和幂等测试。
- `apps/control-plane/test/collaboration-schema.integration.test.ts`：Schema、初始化和迁移幂等测试。
- `packages/contracts/test/collaboration.test.ts`：契约拒绝额外字段、无效主体和非法状态测试。
- `docs/collaboration-backend-acceptance.md`：中文接口、状态、失败恢复和验收证据。
- `docs/implementation-roadmap.md`：记录 Phase 3 后端协作基础已完成边界。

## Task 1：冻结协作契约和数据库边界

**Files:**

- Create: `packages/contracts/src/collaboration.ts`
- Modify: `packages/contracts/src/index.ts`
- Modify: `packages/contracts/src/errors.ts`
- Modify: `packages/contracts/openapi/control-plane.openapi.json`
- Modify: `database/schema.sql`
- Create: `packages/contracts/test/collaboration.test.ts`
- Create: `apps/control-plane/test/collaboration-schema.integration.test.ts`

- [ ] **Step 1：写失败契约测试**

覆盖：主体类型只允许 `human/agent`；责任类型只允许 `human-owner/agent-owner/reviewer/observer`；工作项状态只允许 `backlog/ready/in_progress/blocked/review/completed/cancelled`；评审模式只允许 `serial/parallel/conditional`；交接必须包含原因、开放问题、风险和下一步；所有请求拒绝未知字段、空主体 ID、非法时间和无限长度数组。

```ts
it('拒绝带凭证和额外字段的分配请求', () => {
  expect(() => assignmentCreateRequestSchema.parse({
    subjectType: 'human',
    subjectId: 'member-1',
    responsibility: 'human-owner',
    reviewers: [],
    secret: 'never-accepted',
  })).toThrow();
});

it('要求评审请求使用合法的目标和决策门禁', () => {
  expect(() => reviewRequestCreateSchema.parse({
    targetType: 'prompt',
    targetId: 'prompt-1',
    reviewerSubject: { subjectType: 'human', subjectId: 'member-1' },
    gate: 'unknown',
    requiredDecision: 'approve',
  })).toThrow();
});
```

- [ ] **Step 2：运行契约测试确认红灯**

运行：`pnpm --filter @titan/contracts exec vitest run test/collaboration.test.ts --maxWorkers=1`

预期：因为协作 Schema、错误码和测试文件尚不存在而失败。

- [ ] **Step 3：实现最小契约**

定义以下稳定契约：

```ts
export const subjectRefSchema = z.object({
  subjectType: z.enum(['human', 'agent']),
  subjectId: id,
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
```

同时定义 `collaborationErrorCodeSchema`：`COLLABORATION_NOT_FOUND`、`COLLABORATION_VERSION_CONFLICT`、`COLLABORATION_PERMISSION_DENIED`、`COLLABORATION_INVALID_STATE`、`COLLABORATION_DUPLICATE`、`COLLABORATION_ASSIGNMENT_REQUIRED`、`COLLABORATION_REVIEW_REQUIRED`、`COLLABORATION_HANDOFF_CONFLICT`。

- [ ] **Step 4：增加数据库事实表**

在 `database/schema.sql` 增加：

```sql
CREATE TABLE IF NOT EXISTS project_member (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id),
  subject_type TEXT NOT NULL CHECK (subject_type IN ('human', 'agent')),
  subject_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'manager', 'developer', 'reviewer', 'observer')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('invited', 'active', 'suspended', 'removed')),
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (project_id, subject_type, subject_id)
);

CREATE TABLE IF NOT EXISTS work_item (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id),
  task_id TEXT NOT NULL UNIQUE REFERENCES task(id),
  status TEXT NOT NULL DEFAULT 'backlog' CHECK (status IN ('backlog', 'ready', 'in_progress', 'blocked', 'review', 'completed', 'cancelled')),
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS assignment (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id),
  work_item_id TEXT NOT NULL REFERENCES work_item(id),
  subject_type TEXT NOT NULL CHECK (subject_type IN ('human', 'agent')),
  subject_id TEXT NOT NULL,
  responsibility TEXT NOT NULL CHECK (responsibility IN ('human-owner', 'agent-owner', 'reviewer', 'observer')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('pending', 'active', 'accepted', 'declined', 'completed', 'superseded')),
  reviewers JSONB NOT NULL DEFAULT '[]'::jsonb,
  due_at TIMESTAMPTZ,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS review_request (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id),
  target_type TEXT NOT NULL CHECK (target_type IN ('task', 'artifact', 'run', 'work-item')),
  target_id TEXT NOT NULL,
  reviewer_type TEXT NOT NULL CHECK (reviewer_type IN ('human', 'agent')),
  reviewer_id TEXT NOT NULL,
  gate TEXT NOT NULL,
  required_decision TEXT NOT NULL CHECK (required_decision IN ('approve', 'changes_requested')),
  mode TEXT NOT NULL DEFAULT 'serial' CHECK (mode IN ('serial', 'parallel', 'conditional')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'changes_requested', 'cancelled', 'expired')),
  due_at TIMESTAMPTZ,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS handoff (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id),
  work_item_id TEXT NOT NULL REFERENCES work_item(id),
  from_assignment_id TEXT NOT NULL REFERENCES assignment(id),
  to_subject_type TEXT NOT NULL CHECK (to_subject_type IN ('human', 'agent')),
  to_subject_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  context_artifact_id TEXT REFERENCES artifact(artifact_id),
  open_questions JSONB NOT NULL DEFAULT '[]'::jsonb,
  risks JSONB NOT NULL DEFAULT '[]'::jsonb,
  next_actions JSONB NOT NULL DEFAULT '[]'::jsonb,
  status TEXT NOT NULL DEFAULT 'pending_acceptance' CHECK (status IN ('pending_acceptance', 'accepted', 'declined', 'cancelled')),
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS collaboration_inbox_item (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id),
  subject_type TEXT NOT NULL CHECK (subject_type IN ('human', 'agent')),
  subject_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('assignment', 'review', 'handoff', 'approval', 'blocked')),
  source_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'read', 'resolved', 'dismissed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ,
  UNIQUE (subject_type, subject_id, kind, source_id)
);
```

为项目、工作项、主体、状态和 Inbox 查询增加索引；初始化 SQL 不插入伪造成员或协作记录。

- [ ] **Step 5：运行数据库幂等测试**

运行：`DATABASE_URL=postgresql://titan:titan@127.0.0.1:55432/titan pnpm --filter @titan/control-plane exec vitest run test/collaboration-schema.integration.test.ts --maxWorkers=1`

预期：首次和重复执行 Schema 成功，约束拒绝非法状态，重复成员、重复分配 Inbox 唯一键生效。

- [ ] **Step 6：提交契约与数据库边界**

```bash
git add packages/contracts/src/collaboration.ts packages/contracts/src/index.ts packages/contracts/src/errors.ts packages/contracts/openapi/control-plane.openapi.json packages/contracts/test/collaboration.test.ts database/schema.sql apps/control-plane/test/collaboration-schema.integration.test.ts
git commit -m "新增：冻结协作责任与评审契约"
```

## Task 2：实现工作项、成员和分配事务

**Files:**

- Create: `apps/control-plane/src/modules/collaboration/collaboration.service.ts`
- Create: `apps/control-plane/src/modules/collaboration/collaboration.controller.ts`
- Create: `apps/control-plane/src/modules/collaboration/collaboration.module.ts`
- Modify: `apps/control-plane/src/database/types.ts`
- Modify: `apps/control-plane/src/app.module.ts`
- Create: `apps/control-plane/test/collaboration.integration.test.ts`

- [ ] **Step 1：写失败集成测试**

覆盖：从已存在 Task 创建 WorkItem；同一 Task 重复创建返回同一 WorkItem；项目成员只能在所属项目分配；主体未加入项目时拒绝分配；同一 WorkItem 只能有一个 active human-owner 和一个 active agent-owner；旧版本更新返回 `COLLABORATION_VERSION_CONFLICT`；重复 Idempotency-Key 不产生第二条 assignment；成功写入事件和审计。

```ts
it('为 Task 建立稳定 WorkItem 并幂等分配责任人', async () => {
  const workItem = await collaboration.createWorkItem(task.id);
  const first = await collaboration.createAssignment(workItem.id, {
    subjectType: 'human', subjectId: 'member-owner',
    responsibility: 'human-owner', reviewers: [], idempotencyKey: 'assign-1',
  });
  const replay = await collaboration.createAssignment(workItem.id, {
    subjectType: 'human', subjectId: 'member-owner',
    responsibility: 'human-owner', reviewers: [], idempotencyKey: 'assign-1',
  });
  expect(replay.id).toBe(first.id);
  await expect(collaboration.createAssignment(workItem.id, {
    subjectType: 'human', subjectId: 'other',
    responsibility: 'human-owner', reviewers: [], idempotencyKey: 'assign-2',
  })).rejects.toMatchObject({ code: 'COLLABORATION_ASSIGNMENT_REQUIRED' });
});
```

- [ ] **Step 2：运行集成测试确认红灯**

运行：`DATABASE_URL=postgresql://titan:titan@127.0.0.1:55432/titan pnpm --filter @titan/control-plane exec vitest run test/collaboration.integration.test.ts --maxWorkers=1 --testTimeout=30000`

预期：因为协作 Service、模块和表类型尚不存在而失败。

- [ ] **Step 3：补 Kysely 表类型和模块注册**

在数据库类型中增加表字段类型；`CollaborationModule` 注入 `DatabaseService`、`IdempotencyService`、`EventsService`，并在 `AppModule` 注册 Controller/Service。所有 ID 使用 `randomUUID()` 加稳定前缀，所有外部输入先用 contracts Schema 解析。

- [ ] **Step 4：实现 WorkItem 与成员操作**

提供：

- `POST /api/tasks/:taskId/work-item`：在项目锁内幂等创建 WorkItem，并生成 `work_item.created` 事件。
- `POST /api/projects/:projectId/members`：加入/更新项目主体角色，使用项目和主体唯一键。
- `GET /api/projects/:projectId/members`：只返回主体引用、角色、状态、版本和时间。
- `GET /api/work-items/:workItemId`：返回关联 Task、状态、负责人摘要和版本。

成员删除使用 `status=removed` 软删除；已经被分配或评审的主体不能通过删除绕过历史责任记录。

- [ ] **Step 5：实现分配事务**

`POST /api/work-items/:workItemId/assignments` 在一个事务内完成：锁定 WorkItem、校验主体属于项目且为 active、校验责任类型冲突、写 assignment、写 Inbox item、写 `assignment.created` 事件和审计记录、保存幂等响应。所有版本字段参与更新条件。

提供：

- `GET /api/work-items/:workItemId/assignments`
- `POST /api/assignments/:assignmentId/accept`
- `POST /api/assignments/:assignmentId/decline`
- `POST /api/assignments/:assignmentId/complete`

接受、拒绝和完成必须校验当前状态，重复同一终态请求返回稳定结果，状态冲突返回 `COLLABORATION_INVALID_STATE`。

- [ ] **Step 6：运行工作项和分配集成测试**

运行同一集成命令，预期所有事务、锁竞争、幂等、项目隔离、事件和审计断言通过。

- [ ] **Step 7：提交工作项和分配实现**

```bash
git add apps/control-plane/src/modules/collaboration apps/control-plane/src/database/types.ts apps/control-plane/src/app.module.ts apps/control-plane/test/collaboration.integration.test.ts
git commit -m "新增：实现项目工作项与责任分配事务"
```

## Task 3：实现评审请求和任务交接

**Files:**

- Modify: `apps/control-plane/src/modules/collaboration/collaboration.service.ts`
- Modify: `apps/control-plane/src/modules/collaboration/collaboration.controller.ts`
- Modify: `apps/control-plane/test/collaboration.integration.test.ts`
- Modify: `packages/contracts/src/collaboration.ts`
- Modify: `packages/contracts/test/collaboration.test.ts`

- [ ] **Step 1：写失败评审/交接测试**

覆盖：只能对本项目的 Task、Artifact、Run 或 WorkItem 创建评审；评审人必须是项目 active 成员；同一目标/门禁/评审人重复请求幂等；串行评审必须等待前一项完成；拒绝评审生成 `changes_requested` 和可追溯 Inbox；交接必须来自当前 active owner；新责任人接受后旧分配成为 `superseded`，未接受前不能覆盖原责任；交接中的上下文只保存 Artifact 引用和结构化问题/风险/下一步。

- [ ] **Step 2：运行失败测试**

运行：`DATABASE_URL=postgresql://titan:titan@127.0.0.1:55432/titan pnpm --filter @titan/control-plane exec vitest run test/collaboration.integration.test.ts --maxWorkers=1 --testTimeout=30000`

预期：评审和交接接口尚不存在，新增测试失败。

- [ ] **Step 3：实现评审请求事务**

新增：

- `POST /api/review-requests`
- `GET /api/projects/:projectId/review-requests`
- `POST /api/review-requests/:id/approve`
- `POST /api/review-requests/:id/request-changes`
- `POST /api/review-requests/:id/cancel`

创建时锁定目标项目和目标记录，检查 gate 与目标状态；写 `review_request`、Inbox item、事件和审计。批准/要求修改使用 `expectedVersion`，成功更新版本和 `resolved_at`。评审拒绝不得删除原 Artifact 或覆盖原 Task，必须产生结构化变更原因。

- [ ] **Step 4：实现交接事务**

新增：

- `POST /api/assignments/:assignmentId/handoffs`
- `GET /api/work-items/:workItemId/handoffs`
- `POST /api/handoffs/:id/accept`
- `POST /api/handoffs/:id/decline`

创建交接时锁定旧 assignment 和 WorkItem，校验旧责任人仍为 active owner，校验目标主体为项目 active 成员，写 `handoff` 和目标 Inbox；不改变旧分配。接受时同一事务把旧 assignment 标记 `superseded`、创建新 assignment、更新 WorkItem 版本、关闭交接 Inbox，并写 `handoff.accepted` 事件。拒绝只关闭交接，不改变原责任人。

- [ ] **Step 5：运行评审和交接测试**

预期：评审串行/并行状态、版本冲突、交接接受/拒绝、重复请求、跨项目访问和审计证据全部通过。

- [ ] **Step 6：提交评审和交接实现**

```bash
git add packages/contracts/src/collaboration.ts packages/contracts/test/collaboration.test.ts apps/control-plane/src/modules/collaboration apps/control-plane/test/collaboration.integration.test.ts
git commit -m "新增：实现评审请求与任务交接事务"
```

## Task 4：实现项目 Inbox 查询和状态收敛

**Files:**

- Modify: `apps/control-plane/src/modules/collaboration/collaboration.service.ts`
- Modify: `apps/control-plane/src/modules/collaboration/collaboration.controller.ts`
- Modify: `packages/contracts/src/collaboration.ts`
- Modify: `apps/control-plane/test/collaboration.integration.test.ts`
- Create: `apps/control-plane/test/collaboration-inbox.integration.test.ts`

- [ ] **Step 1：写 Inbox 失败测试**

覆盖：按 `projectId`、主体类型/ID、状态和分页筛选；返回 assignment、review、handoff 和 blocked 的统一摘要；只返回安全字段；已读和解决状态具有版本校验；项目成员不能读取另一个项目的 Inbox；重复读取不改变状态；来源对象删除或终态后 Inbox 可以收敛为 resolved。

- [ ] **Step 2：运行失败测试**

运行：`DATABASE_URL=postgresql://titan:titan@127.0.0.1:55432/titan pnpm --filter @titan/control-plane exec vitest run test/collaboration-inbox.integration.test.ts --maxWorkers=1 --testTimeout=30000`

预期：Inbox 查询和状态接口尚不存在而失败。

- [ ] **Step 3：实现 Inbox API**

新增：

- `GET /api/me/inbox?projectId=&subjectType=human&subjectId=&status=pending&limit=&offset=`
- `POST /api/inbox/:id/read`
- `POST /api/inbox/:id/resolve`
- `POST /api/inbox/:id/dismiss`

查询使用 `collaboration_inbox_item` 主表和关联摘要，按 `created_at DESC, id DESC` 排序，最大 limit 100。返回 `kind`、来源 ID、标题、项目/工作项引用、优先级、状态、创建时间和安全摘要，不返回 Prompt、凭证、Checkpoint、原始 Tool 输出或内部 HTTP 正文。

- [ ] **Step 4：实现状态收敛**

在同一数据库事务内关闭：已完成/取消的 assignment、已解决的 review、已接受/拒绝的 handoff。状态收敛必须幂等，并写 `inbox.resolved` 或 `inbox.dismissed` 事件；如果来源版本已变化，使用 `COLLABORATION_VERSION_CONFLICT` 而不是覆盖。

- [ ] **Step 5：运行 Inbox 和全协作回归**

运行：

```bash
DATABASE_URL=postgresql://titan:titan@127.0.0.1:55432/titan pnpm --filter @titan/control-plane exec vitest run test/collaboration.integration.test.ts test/collaboration-inbox.integration.test.ts --maxWorkers=1 --testTimeout=30000
pnpm --filter @titan/contracts exec vitest run --maxWorkers=1
```

预期：协作相关测试全部通过，旧控制面测试不回归。

- [ ] **Step 6：提交 Inbox 实现**

```bash
git add apps/control-plane/src/modules/collaboration packages/contracts/src/collaboration.ts apps/control-plane/test/collaboration-inbox.integration.test.ts apps/control-plane/test/collaboration.integration.test.ts
git commit -m "新增：提供项目协作 Inbox 与责任状态收敛"
```

## Task 5：完成契约、OpenAPI、文档和全仓门禁

**Files:**

- Modify: `packages/contracts/openapi/control-plane.openapi.json`
- Create: `docs/collaboration-backend-acceptance.md`
- Modify: `docs/implementation-roadmap.md`
- Modify: `packages/contracts/openapi/generate.mjs` only if generator registration is required

- [ ] **Step 1：生成并检查 OpenAPI**

运行：`node packages/contracts/openapi/generate.mjs --check`

预期：生成文件与契约一致，协作路径包含请求、响应、错误码和安全要求。

- [ ] **Step 2：写中文验收文档**

文档记录：表结构、主体引用、责任类型、状态机、接口清单、幂等键、版本字段、项目隔离、审计事件、Inbox 收敛、失败恢复、不可逆动作边界和未包含的 Presence/外部系统/多人实时通知。

- [ ] **Step 3：执行全仓验证**

运行：

```bash
pnpm exec turbo run build typecheck lint --force --output-logs=errors-only
pnpm --filter @titan/contracts exec vitest run --maxWorkers=1
DATABASE_URL=postgresql://titan:titan@127.0.0.1:55432/titan pnpm --filter @titan/control-plane exec vitest run test/collaboration-schema.integration.test.ts test/collaboration.integration.test.ts test/collaboration-inbox.integration.test.ts --maxWorkers=1 --testTimeout=30000
node packages/contracts/openapi/generate.mjs --check
git diff --check
```

预期：所有构建、类型、静态检查、契约、数据库和协作集成测试通过；不把未执行的 Docker、Temporal 或付费模型验收写成通过。

- [ ] **Step 4：只读代码评审**

评审重点：跨项目主体越权、重复 owner、评审/交接并发锁、版本覆盖、Inbox 状态收敛、事件/审计敏感信息、数据库幂等和 OpenAPI 对齐。修复所有 P1/P2 后重新验证。

- [ ] **Step 5：提交文档和路线图**

```bash
git add packages/contracts/openapi/control-plane.openapi.json docs/collaboration-backend-acceptance.md docs/implementation-roadmap.md
git commit -m "文档：归档协作责任与评审后端验收"
```

- [ ] **Step 6：通过代理推送**

确认 `docs/study.html`、`study.html`、`.superpowers/` 和其他用户未跟踪文件没有进入暂存区，然后执行：

```bash
HTTPS_PROXY=http://127.0.0.1:7890 \
HTTP_PROXY=http://127.0.0.1:7890 \
ALL_PROXY=socks5://127.0.0.1:7890 \
git push origin chore/initial-project
```

推送后核对本地 HEAD 与 `refs/remotes/origin/chore/initial-project` 一致。
