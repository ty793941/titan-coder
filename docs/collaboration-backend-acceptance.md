# 协作责任与评审后端：接口和验收

## 1. 本轮交付范围

本轮只修改后端契约、数据库脚本、控制面服务和测试，不修改 Vue、CSS、原型或 UI 请求客户端。

提供可信本机管理端的项目成员引用、工作项、责任分配、串行/并行评审、责任交接和个人 Inbox。它是 Phase 3 的一个后端切片，不代表 Phase 3 或所有非 UI 阶段完成。

## 2. 身份和权限

所有本轮新增路由均要求既有 Console Bearer；身份由服务端 `authenticateConsole` 认证，操作者固定为 `human/local-user`。不接受 `actorId` 或任意请求头、查询参数模拟成员。

- Console 是可信本机管理员，可以登记项目主体、分配责任、发起和取消评审、安排交接以及读取协作元数据。
- `project_member` 是项目中的主体/角色记录，不是账户、邀请邮件、登录凭证或真实组织授权。
- 个人接受/拒绝/完成分配、提交评审结果和接收交接，只允许目标主体为 `human/local-user` 且仍是项目 active 成员。
- 人类和 Agent 的其他主体可登记责任引用，但本切片不允许代签它们的个人决定。对应的成员登录、Agent 身份与跨用户授权尚未接入。
- 评审决议是独立事实，不会绕过现有 QRSPI 门禁，不会自动批准 Artifact、推进 Task、创建 Session、执行 Run 或改变工具权限。
- `project` 当前没有归档状态字段；这里的 active 指成员状态，不虚构项目状态或组织权限。

## 3. 数据结构

新增表由 `database/schema.sql` 定义，`database/init-data.sql` 同步声明不初始化模拟成员、待处理审批或凭证。部署只通过脚本升级，禁止直接修改线上结构。

| 表 | 核心字段 | 约束与用途 |
| --- | --- | --- |
| `project_member` | id、project_id、subject_type、subject_id、role、status、version | 项目/主体类型/主体 ID 唯一；角色为 owner/manager/developer/reviewer/observer |
| `work_item` | id、project_id、task_id、status、version | 本切片每 Task 最多一个可选工作项；未使用的 Task 不强制创建工作项 |
| `assignment` | id、project_id、work_item_id、subject_type、subject_id、responsibility、status、reviewers、due_at、version | 当前 human-owner、agent-owner 各最多一个；observer/reviewer 可有多人 |
| `review_request` | id、project_id、target_type、target_id、target_version、reviewer_type、reviewer_id、gate、required_decision、mode、predecessor_id、status、resolution_reason、due_at、resolved_at、version | 同目标/门禁/评审主体最多一条 pending；绑定目标版本 |
| `handoff` | id、project_id、work_item_id、from_assignment_id、to_subject_type、to_subject_id、reason、context_artifact_id、open_questions、risks、next_actions、new_assignment_id、status、version | 一个原分配最多一条待接收交接；接受前不替换原责任 |
| `collaboration_inbox_item` | id、project_id、subject_type、subject_id、kind、source_id、status、version、created_at、resolved_at | 主体/事项类别/来源唯一；读、隐藏和解决不改变来源门禁 |

各事实还保存创建时间。输出使用 camelCase，时间为 ISO 8601，空时间/引用使用 `null`。新表采用 TEXT ID，与既有 Project、Task、Artifact 外键类型一致。

Schema 可以重复执行，Inbox 版本、评审目标版本/前序、交接新分配引用均用幂等 `ALTER ... ADD COLUMN IF NOT EXISTS`。数据库测试在随机独立 schema 中验证两次执行和责任人唯一约束。

## 4. 公共请求规则

- 所有请求使用严格 Zod Schema，拒绝未知字段。ID 为 1–200 字符，限定字母、数字、下划线和连字符。
- 时间字段使用 UTC ISO 8601。版本 `expectedVersion` 为 1–2147483646 整数。
- 创建分配、评审和交接必须提供 `Idempotency-Key` 请求头或正文 `idempotencyKey`，长度 1–200；请求头优先。
- 同一去重作用域内同键同正文重放已保存结果；异正文返回 `409 IDEMPOTENCY_CONFLICT`。重放返回创建时快照，当前状态应通过查询读取。
- 状态修改必须提供当前版本。相同动作重试携带前一版本时，若对象正好停留在该动作后的版本，则返回当前结果，不重复事件；更早的版本返回冲突。
- 评审拒绝原因、交接说明和问题/风险/下一步采用有界文本，按已知模式拒绝服务 URL、Bearer、私钥和凭证形态文本。该扫描不等于能识别任意未知秘密，调用方仍不能把凭证或原始模型上下文放入这些字段。

## 5. 接口清单

完整字段和响应 Schema 见 `packages/contracts/src/collaboration.ts` 和生成的 OpenAPI。

| 方法与路径 | 请求 | 返回 |
| --- | --- | --- |
| POST `/api/tasks/:taskId/work-item` | `{}` | 201 WorkItem；同 Task 并发或重复创建返回同一 ID |
| POST `/api/projects/:projectId/members` | subjectType、subjectId、role、可选 expectedVersion | 201 Member；已有同角色直接返回，变更角色必须校验版本 |
| GET `/api/projects/:projectId/members` | 无 | 200 Member[]，最多 100 |
| GET `/api/work-items/:workItemId` | 无 | 200 WorkItem 与最多 100 条分配 |
| POST `/api/work-items/:workItemId/assignments` | subjectType、subjectId、responsibility、reviewers、可选 dueAt/idempotencyKey | 201 Assignment，初始 pending |
| GET `/api/work-items/:workItemId/assignments` | 无 | 200 Assignment[]，最多 100 |
| POST `/api/assignments/:id/accept` | expectedVersion | 200 accepted Assignment |
| POST `/api/assignments/:id/decline` | expectedVersion | 200 declined Assignment |
| POST `/api/assignments/:id/complete` | expectedVersion | 200 completed Assignment |
| POST `/api/review-requests` | projectId、targetType、targetId、reviewerSubject、gate、requiredDecision、可选 mode/dueAt/idempotencyKey | 201 ReviewRequest，初始 pending |
| GET `/api/projects/:projectId/review-requests` | 无 | 200 ReviewRequest[]，最多 100 |
| POST `/api/review-requests/:id/approve` | expectedVersion、可选 reason | 200 approved ReviewRequest |
| POST `/api/review-requests/:id/request-changes` | expectedVersion、必填 reason | 200 changes_requested ReviewRequest，并为 local-user 创建 blocked Inbox |
| POST `/api/review-requests/:id/cancel` | expectedVersion、可选 reason | 200 cancelled ReviewRequest；管理动作可关闭不可继续的评审 |
| POST `/api/assignments/:id/handoffs` | toSubject、reason、openQuestions、risks、nextActions、可选 contextArtifactId/idempotencyKey | 201 pending_acceptance Handoff |
| GET `/api/work-items/:id/handoffs` | 无 | 200 Handoff[]，最多 100 |
| POST `/api/handoffs/:id/accept` | expectedVersion | 200 accepted Handoff 和新 assignment 引用 |
| POST `/api/handoffs/:id/decline` | expectedVersion | 200 declined Handoff，原负责人保持有效 |
| GET `/api/me/inbox` | 必填 projectId；可选 status/limit/offset | 200 当前 local-user 的 Inbox[] |
| POST `/api/inbox/:id/read` | expectedVersion | 200 read Inbox |
| POST `/api/inbox/:id/resolve` | expectedVersion | 200 resolved，仅允许明确确认 blocked 提示 |
| POST `/api/inbox/:id/dismiss` | expectedVersion | 200 dismissed；只隐藏提示，不完成来源对象 |

成员列表、工作项分配列表和交接列表按创建时间、ID 稳定排序；评审和 Inbox 按创建时间倒序、ID 排序。Inbox 默认 50、最多 100，offset 最大 1000000；拒绝 subjectId、subjectType 和其他未知查询参数。缺失父资源的列表返回 404，不伪装为空集合。

### 分配示例

```json
{
  "subjectType": "human",
  "subjectId": "local-user",
  "responsibility": "human-owner",
  "reviewers": [],
  "idempotencyKey": "assign-owner-1"
}
```

human-owner 仅可分配给 human，agent-owner 仅可分配给 agent；评审人 ID 列表最多 20、不能重复且须在本项目 active 成员中。所有主体存在性检查均限制在工作项所属项目中。

### 评审示例

```json
{
  "projectId": "project_dev",
  "targetType": "task",
  "targetId": "task_dev",
  "reviewerSubject": { "subjectType": "human", "subjectId": "local-user" },
  "gate": "questions",
  "requiredDecision": "approve",
  "mode": "serial",
  "idempotencyKey": "review-questions-1"
}
```

`requiredDecision` 固定为 `approve`，含义为门禁需要批准，而不是强制评审人只能批准；评审人始终可以要求修改。targetType 允许 task/artifact/run/work-item；gate 为 questions/research/design/structure/plan/implement/verify/review/release。评审主体须为项目 active 成员且角色是 owner、manager 或 reviewer。

Task 和 Artifact 要求门禁匹配其阶段或工件类型。创建保存目标版本，决议时重新锁定并检查；版本已变化则拒绝旧评审。到期的评审不能批准或拒绝，可以取消后重新发起；当前不提供后台自动到期扫描。

### 交接示例

```json
{
  "toSubject": { "subjectType": "human", "subjectId": "local-user" },
  "reason": "由新负责人继续推动接口审阅",
  "openQuestions": ["异常退款的处理方式需要确认"],
  "risks": ["历史接口存在兼容约束"],
  "nextActions": ["阅读已登记的阶段资料"],
  "idempotencyKey": "handoff-owner-1"
}
```

reason 最多 2000 字；问题/风险/下一步各最多 50 项，每项最多 1000 字。contextArtifactId 如提供，必须属于同一项目及同一工作项 Task。不能交接给自己，也不能通过交接把人类负责人改为 Agent 负责人。重复接受同一版本不会新增第二个 owner。

## 6. 状态机与并发

- 分配：pending → accepted/declined，accepted/active → completed。待交接时不能单独改变原分配状态。
- 评审：pending → approved/changes_requested/cancelled。同目标、门禁的 pending 队列不能混用串行与并行。串行前序关系由稳定 ID 链确定，不依赖事务时间戳；前序未批准则后序不能作出决议。
- 交接：pending_acceptance → accepted/declined。接受事务使原分配成为 superseded observer，创建 accepted 新 owner，更新 WorkItem 版本并收敛相关 Inbox；拒绝不改变原责任。
- Inbox：pending → read/resolved/dismissed，read → resolved/dismissed。分配接纳/完成、评审决议和交接决议在同一事务内关闭来源 Inbox。`resolve` 不能绕过原对象的审批或交接。

所有协作写事务先锁定项目行，再读取/更新资源，统一锁顺序；按目标版本校验评审时还锁定目标行。每个成功写事务写 Event、Outbox 和 Audit；事件/审计只记录 ID、版本、动作和责任引用，交接正文和拒绝原因只保留在专用业务字段。

共享 IdempotencyService、EventsService 沿用 AppModule 单例注册，不在协作子模块复制注册。新增模块的重复注册曾导致既有 SSE 故障注入测试失效，修复后原 14 项事件/SSE 测试及全量控制面回归通过。

## 7. 错误与恢复

| HTTP | 错误码 | 恢复 |
| --- | --- | --- |
| 400 | VALIDATION_FAILED | 修改未知字段、版本、主体类型、数组、模式或敏感文本 |
| 401 | PERMISSION_DENIED | 服务端重新提供合法 Console 身份，不向模型或日志发送令牌 |
| 403 | COLLABORATION_PERMISSION_DENIED | 检查本项目成员和角色；不能冒充外部主体 |
| 404 | COLLABORATION_NOT_FOUND | 重新查询真实项目/工作项/评审/交接 |
| 409 | COLLABORATION_VERSION_CONFLICT | 重新读取当前版本并审阅，不覆盖新状态 |
| 409 | COLLABORATION_DUPLICATE | 读取已有责任或评审，安全重试应复用原幂等键 |
| 409 | IDEMPOTENCY_CONFLICT | 同键正文已变化，应恢复原请求或明确发起新请求 |
| 409 | COLLABORATION_INVALID_STATE | 检查来源终态、到期、责任类别或评审模式 |
| 409 | COLLABORATION_REVIEW_REQUIRED | 等待前序评审批准或取消并重新组织评审 |
| 409 | COLLABORATION_HANDOFF_CONFLICT | 先处理原交接，不覆盖责任 |

网络响应丢失时：创建使用同键同正文重放；动作使用原 expectedVersion 重试。同一事务内的事件写入失败会回滚分配、Inbox、审计和幂等响应，可以再次提交原请求。不清理或删除历史记录。

## 8. 验收证据与未包含内容

环境：Node.js 24.22.3、本机 PostgreSQL，测试使用随机独立 schema，不访问付费模型或外部管理系统，不修改 UI，不执行生产部署。

- 协作数据库专项覆盖表结构重复执行、主体认证与角色、分配/评审并发去重、唯一责任人、串行关系、时序乱序、目标版本冲突、交接接受/拒绝、个人身份不可伪造、Inbox 收敛、缺失父资源和事务回滚。
- 真实控制面非进程级回归 199 项通过；契约回归 60 项通过；原前端/网关回归 69 项通过。合计 328 项，无失败、无跳过；协作数据库专项已包含在 199 项内，不重复计算。
- 全仓无缓存构建、类型和静态检查 33 项任务通过；OpenAPI 一致性和差异检查通过。最终只读 Reviewer 为 `approve`。

```bash
pnpm exec turbo run build typecheck lint --force --output-logs=errors-only
DATABASE_URL=postgresql://titan:titan@127.0.0.1:55432/titan pnpm --filter @titan/control-plane exec vitest run --exclude 'test/*e2e.test.ts' --maxWorkers=1 --testTimeout=30000
pnpm --filter @titan/contracts exec vitest run --maxWorkers=1
pnpm --filter @titan/web-console exec vitest run --maxWorkers=1 --testTimeout=30000
node packages/contracts/openapi/generate.mjs --check
git diff --check
```

本切片尚未提供：成员登录/邀请/SSO/组织与项目权限系统、成员移除/暂停、多人实时协作、评论/提及、通知、条件评审、审批职责分离、评审拒绝后自动创建返工 Task、工作项依赖图和拆分调度、交接自动化、后台到期扫描及 Agent 身份执行。不将这些内容记作完成，也未复跑本轮无关的 Docker/Temporal 全链路验收。
