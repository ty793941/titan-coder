# Phase 1 协议冻结与实现边界

文档版本：1.1.0。对应路线图 `implementation-roadmap.md` §2.1。OpenAPI info.version 为 1.1.0，生成模板版本为 2，已对齐主线新增的 pause/resume。本次只维护离线协议、契约测试和本说明，不改变 Controller、共享 Zod、数据库或 Runtime。

## 1. 冻结产物与事实来源

| 产物 | 路径 | 当前用途 |
|---|---|---|
| HTTP API | `packages/contracts/openapi/control-plane.openapi.json` | OpenAPI 3.1，描述实际 HTTP/JSON 与 SSE 路由 |
| 可复现生成器 | `packages/contracts/openapi/generate.mjs` | 从构建后的现有 Zod 转换结构，手工维护 Controller/Service 的操作语义及响应 |
| Daemon RPC | `packages/daemon-protocol/proto/titan/daemon/v1/daemon_gateway.proto` | proto3 服务与消息冻结，供后续 ConnectRPC 适配 |
| Handoff / Git Snapshot | `packages/daemon-protocol/proto/titan/snapshot/v1/snapshot.proto` | proto3 快照格式冻结；不提供迁移或代码上传服务 |
| 契约测试 | `packages/contracts/test/openapi*.test.ts` | JSON 解析、Controller 路由/状态码/认证比对、Zod 声明对齐、Proto 编译及序列化往返 |

运行时事实以 `apps/control-plane/src/modules` 的 Controller、Service 和 `packages/contracts/src/schemas.ts` 为依据。离线生成器不是运行时的路由或校验框架，不替代共享 Zod。生成 JSON 的 `x-generation` 保存来源、模板版本和生成时间；生成器遇到未支持的 Zod 类型会报错。

当前 Daemon 客户端为 `apps/daemon/src/daemon-client.ts`，通过 HTTP 调用。没有运行中的 ConnectRPC Server、生成客户端、RPC 元数据认证适配、RPC 错误转换或 REST 自动转码。Proto 中的 `DaemonGateway` 是冻结接口，不能据此宣称 RPC 已部署。

## 2. 对象关系与状态边界

- Project 包含 Task；Task 是业务目标；Session 是 Task 的持续上下文；Run 是 Session 的单次执行尝试；同一 Session 重试创建新 Run，`attempt` 递增。
- Artifact 属于 Project/Task，可选关联同一 Task 的 Session。`sourceArtifacts` 引用同一 Task 的既有 Artifact，不是任意外部 URI。
- `execution_job` 是控制面给某个 Daemon 的 Run 调度记录；不是新的 Task 或 Session。Phase 1 每个 Run 至多一个作业。
- Worktree 是代码隔离工作区；路径不是业务对象 ID，也不能替代 Session Checkpoint。
- WorkItem 是 Task 内的可选调度拆分概念；本次不增加 WorkItem API、持久对象或运行逻辑。Product Lifecycle 不等于 Task 的 QRSPI `stage` 或 Run 的执行 `status`；独立 Product Lifecycle API 也不属于当前路由。

Task 阶段类型允许 `questions/research/design/structure/plan/implement/verify/review/delivered`；当前 stage 路由仅提供从 questions 到 implement 的逐阶段推进。Run/Session 状态类型允许 `queued/starting/running/waiting_input/paused/reconnecting/completed/failed/cancelled`；存在状态枚举不表示拥有对应操作入口。

`paused` 可由显式 `POST /api/runs/{runId}/pause` 或领取租约过期且已有检查点时产生。pause 返回 200 和原 Run，将 Run/Session 标为 paused，已有作业标为 paused、cancelRequested=true；重复暂停可重放，completed/failed/cancelled 不可暂停。响应只证明业务状态已记录，不证明操作系统进程已经停止。

`POST /api/runs/{runId}/resume` 返回 201，在同一 Session 创建新 queued Run，attempt 递增，旧 Run 保持 paused。请求复用 runCreateRequestSchema，checkpointId、planHash 均可省略；省略 checkpointId 时选源 Run 最新检查点，没有检查点则创建无检查点的新尝试。显式检查点必须属于同一 Session。普通创建 Run 会阻止已有 queued/starting/running/waiting_input/paused 尝试；resume 允许旧 paused 尝试保留，但仍拒绝其它 queued/starting/running/waiting_input 尝试。恢复重新排队，不是原进程或原生模型会话热恢复，也不是跨环境 Handoff。Proto 未增加 Pause/Resume RPC，RPC 仍仅冻结、未部署。

## 3. 存储事实边界

| 存储或组件 | 当前事实及权限 | 不能推断的能力 |
|---|---|---|
| PostgreSQL 业务表 | Project、Task、Session、Run、Artifact 元数据、execution_job、Checkpoint、审批/审计等持久事实 | Artifact 文件正文不在普通业务表中；表存在不代表每个高级 API 已提供 |
| PostgreSQL `event` | 平台 EventEnvelope 的持久事实；与业务变更在同一事务写入 | 不依赖 Redis 提供历史重放 |
| PostgreSQL `outbox_event` | 与 event 同事务写入，保存待发布标记和重试计数 | 当前没有 Redis 发布 Worker；不能把 `published_at=NULL` 当成事件未入库 |
| PostgreSQL `execution_progress` | 全局 eventId、job 内连续 sequence 和请求摘要，用于已接收进度去重 | 不是模型上下文全文或原始 claimToken 存储 |
| PostgreSQL `daemon_outbox_event` | 通用 Daemon 事件接收记录；与 Run progress 路由不同 | 不自动推进 Run，不是本机磁盘 Outbox，也没有完整分发/死信工作流 |
| Daemon 本机 PersistentOutbox | 先持久 append，确认接收后记 ack；恢复未确认的进度发送；处理末尾不完整日志行 | 不替代控制面业务状态，不保证跨环境迁移；它保留进度 claimToken 以重发，只能留在本机私有状态 |
| Daemon 私有状态 | 目录 0700、文件 0600、拒绝符号链接；设备令牌、领取租约等只用于本机恢复与发送 | 不能写进普通日志、公共 Artifact、Git Snapshot 或 HandoffSnapshot |
| Redis Streams | 后续可替换的分发/缓存层，当前没有执行路径依赖它 | 不能作为任务状态、检查点、审批或事件历史的事实来源 |
| Temporal | Phase 1 采用 PostgreSQL 状态机和调度记录；完整 Worker 留待后续 | 本次没有引入 Temporal 服务或跨重启长工作流保证 |

SSE 当前直接查询 PostgreSQL `event`；follow 使用周期轮询，不消费 Redis Streams 或 `outbox_event` 发布标记。控制面重启可以读取已提交的业务与事件数据，但不是跨机器 Runtime 进程或 Git 工作区恢复。

## 4. 实际 HTTP 操作与状态码

| 方法与路径 | 成功响应 | 关键约束 |
|---|---|---|
| `POST /api/projects` | 201 Project | 创建幂等键必需 |
| `POST /api/projects/{projectId}/tasks` | 201 Task | acceptanceCriteria 至少一项；初始 questions/active |
| `GET /api/tasks/{taskId}` | 200 Task | 不存在返回 404 |
| `GET /api/tasks/{taskId}/events` | 200 EventEnvelope[] | JSON 查询，未知 Task 当前为空数组；不提供 SSE 游标 |
| `POST /api/tasks/{taskId}/stage` | 200 Task | stage、expectedVersion，准备工件批准链门禁 |
| `POST /api/tasks/{taskId}/sessions` | 201 Session | entryAgent 固定 project-manager；execution 可省略 |
| `GET /api/sessions/{sessionId}` | 200 Session | 返回业务视图，不泄露 execution 配置 |
| `POST /api/sessions/{sessionId}/runs` | 201 Run | 创建新尝试；允许仅用幂等请求头和空正文 |
| `GET /api/runs/{runId}` | 200 Run | 含可选 checkpointId、errorCode |
| `POST /api/runs/{runId}/pause` | 200 Run | 无必需正文；原 Run 暂停，作业通过停止信号通知 Daemon |
| `POST /api/runs/{runId}/resume` | 201 新 Run | 源 Run 必须 paused；幂等键必需，可选 checkpointId/planHash |
| `POST /api/runs/{runId}/fail` | 204 | 仅无 execution_job 的 Run；errorCode 默认 TOOL_EXECUTION_FAILED |
| `POST /api/runs/{runId}/complete` | 204 | 仅无 execution_job 的 Run |
| `POST /api/runs/{runId}/cancel` | 200 Run | 记录取消事实；实际进程终止由 Daemon 完成 |
| `GET /api/runs/{runId}/events` | 200 text/event-stream | 重放及可选 follow，见 §8 |
| `POST /api/tasks/{taskId}/artifacts` | 201 Artifact | type/content、可选 sessionId/sourceArtifacts；创建新版本 |
| `GET /api/tasks/{taskId}/artifacts` | 200 Artifact[] | resolution=latest-approved 才按类型选最高已批准版本 |
| `GET /api/artifacts/{artifactId}` | 200 Artifact | 元数据，不下载文件正文 |
| `POST /api/artifacts/{artifactId}/approve` | 200 Artifact | 只批准最新准备阶段版本，不自动推进 Task |
| `POST /api/daemons/register` | 201 DaemonView + authToken | 当前本机注册不要求 Bearer，不幂等 |
| `GET /api/daemons/{daemonId}` | 200 DaemonView | 当前不要求 Bearer，不返回令牌或摘要 |
| `POST /api/daemons/{daemonId}/heartbeat` | 200 DaemonView | Bearer；正文可省略，使用服务端接收时间 |
| `POST /api/daemons/{daemonId}/revoke` | 204 | Bearer；撤销后后续访问被拒绝 |
| `POST /api/daemons/{daemonId}/events` | 201/200 `{created}` | Bearer；通用事件，重复为 200/false |
| `GET /api/daemons/{daemonId}/events` | 200 接收记录[] | Bearer；按 sequence 升序 |
| `POST /api/daemons/{daemonId}/claim` | 200 RunDispatch / 204 | Bearer；空正文或 {}，容量满或无作业时无正文 |
| `POST /api/daemons/{daemonId}/runs/{runId}/progress` | 200 ProgressAck | Bearer + claimToken，连续序号与去重 |
| `GET /api/daemons/{daemonId}/runs/{runId}/control` | 200 RunControl | Bearer；取消轮询，条件满足时续租 |
| `GET /api/daemons/{daemonId}/runs/{runId}/job` | 200 ExecutionJob | Bearer；job 状态、lastSequence、leaseExpiresAt，不含 claimToken |

没有通用 Project 列表/详情、Session 列表、Run 列表、Handoff 或 Snapshot 上传路由。无 execution 的 fail/complete 可以用于本机协议闭环；真实 execution Run 必须通过已认证 Daemon 的 progress 上报终态，手动入口返回 403。

部分输入字段目前仅被接受：Task `humanOwner` 未写入表；Run `inputSnapshotId` 未持久化；Session 外层 `daemonId` 仅在提供 execution 时检查一致性。不得把这些字段解释成已实现的人类分配、输入快照恢复或 Daemon 调度。

## 5. 认证、权限与凭证

注册返回 `authToken`，为 64 位小写十六进制随机值；服务端仅存 SHA-256 摘要。除注册和查询 Daemon 元数据外，Daemon 路由要求 `Authorization: Bearer <authToken>`，并检查路径 `daemonId` 的归属。缺少或错误令牌返回 HTTP 401、`PERMISSION_DENIED`；有效令牌访问已撤销 Daemon 返回 403。

Project、Task、Session、Run、Artifact 和 SSE 目前没有 Controller 层用户身份认证，操作者使用本机 `local-user` 或固定系统角色。OpenAPI 逐操作声明真实 `security`，不声称已经具备远程多租户或团队权限校验。服务入口默认绑定 127.0.0.1；DaemonClient 拒绝含 userinfo/query/hash 的控制面 URL，非回环 HTTP 要求改用 HTTPS。

真实 Session 的 `execution` 包含 `daemonId/runtime/credentialRef/workspacePath/allowedTools/maxTurns/timeoutMs`，可选 `modelRef`。runtime 仅 codex/qwen；maxTurns 为 1..10000；timeoutMs 为 1..86400000；allowedTools 至多 100 项。执行要求 ready 的 local Daemon、对应 runtime capability，以及位于注册 workspaceRoots 内的绝对路径。`cloud` 可以声明，但现有执行策略拒绝云端运行。

`credentialRef` 是本机凭证引用，不能放 API Key 明文。`claimToken` 是单个 execution_job 的领取租约证明，必须与 Daemon Bearer 同时校验；它不是模型凭证。模型密钥不应出现在任何请求的任意 credentials 对象、Proto 消息、事件、工件或快照中。本次没有获取或使用模型密钥，也没有变更 Qwen/Codex 认证方式。

## 6. 幂等键与错误

### 6.1 创建请求的幂等作用域

| 操作 | 键输入 | 数据库作用域 |
|---|---|---|
| Project 创建 | 请求头优先，否则正文 idempotencyKey | `project:create` |
| Task 创建 | 请求头优先，否则正文 idempotencyKey | `project:{projectId}:task:create` |
| Session 创建 | 请求头优先，否则正文 idempotencyKey | `task:{taskId}:session:create` |
| Run 创建 | 请求头优先，否则正文 idempotencyKey | `session:{sessionId}:run:create` |
| Run resume | 请求头优先，否则正文 idempotencyKey | `run:{runId}:resume` |
| Artifact 创建 | 只读取请求头；缺省生成 `artifact-<Date.now()>` | `task:{taskId}:artifact:create` |

除 Artifact 外，上述创建及 resume 的键 trim 后长度为 1..200；OpenAPI 中正文键和请求头均为可选，但操作标记 `x-idempotency-required=true` 表示二者至少满足一处。OpenAPI 不能用单个 JSON Schema 表达跨请求头与正文的这一约束，客户端不得省略二者。resume 支持仅提供幂等请求头和空正文，同键同请求重放同一个新 Run，仍返回 201，不再增加 attempt；同键异请求为 IDEMPOTENCY_CONFLICT。Artifact 请求头当前没有相同长度校验；生成的时间键不能保证安全重试，应显式传入稳定键。

同作用域同键同请求重放保存的响应；异请求返回 409 `IDEMPOTENCY_CONFLICT`。当前创建控制器重放仍返回 201。IdempotencyService 对解析后对象的 `JSON.stringify` 做摘要，不是通用、跨语言的语义等价 JSON 哈希，也不构成分布式严格 exactly-once 保证。

Run progress 不使用 Idempotency-Key：`eventId` 全局唯一，`(jobId,sequence)` 唯一且要求连续。claimToken 不进入请求内容摘要；规范化检查点和其余内容的 canonical JSON 进入摘要。相同 eventId、相同 job 和内容返回 `accepted=false`；不同 job 或内容为 409。被接收的 progress 会产生平台 event；跨其它平台事件复用 eventId 同样冲突。已终态的新进度可能直接 `accepted=false`，调用方还需检查返回 status 和 cancelRequested。

通用 Daemon events 仅按 `(daemonId,eventId)` 去重；重复不检查正文差异，返回 created=false；数据库另有 `(daemonId,sequence)` 唯一约束，但服务未将该唯一约束冲突转换为友好的 409，可能落入 500。此路径不承诺与 progress 相同的连续序号或冲突检测。

### 6.2 统一错误结构

```json
{
  "code": "VERSION_CONFLICT",
  "message": "VERSION_CONFLICT: task version has changed",
  "details": { "expectedVersion": 1, "actualVersion": 2 },
  "traceId": "trace_example",
  "retryable": false,
  "occurredAt": "2026-11-21T00:00:00.000Z"
}
```

字段固定为 `code/message/details/traceId/retryable/occurredAt`，没有额外 `error` 包装。DomainError 的 message 当前带错误码前缀。错误 traceId 使用请求 `X-Trace-Id`，未提供时服务端生成；成功事件的 traceId 当前不会自动继承这个请求头。

| HTTP 状态 | 错误语义 |
|---|---|
| 400 | Zod VALIDATION_FAILED；或未在 Filter 特判的领域错误，如 INVALID_STATE_TRANSITION、APPROVAL_REQUIRED、DAEMON_UNAVAILABLE |
| 401 | 无效 Daemon 认证，响应 code 为 PERMISSION_DENIED |
| 403 | 领域 PERMISSION_DENIED |
| 404 | RESOURCE_NOT_FOUND |
| 409 | IDEMPOTENCY_CONFLICT、VERSION_CONFLICT、EVENT_SEQUENCE_GAP、PLAN_HASH_STALE |
| 500 | 未归类异常，code 为 INTERNAL_ERROR；不返回底层异常详情 |

`retryable=true` 仅对应 DAEMON_UNAVAILABLE、TOOL_TIMEOUT、RUNTIME_ADAPTER_UNAVAILABLE。它不由 HTTP 是否为 5xx 决定；执行副作用是否可安全重试仍取决于操作幂等性。OpenAPI 包含完整现有错误码目录及 Filter 使用的 INTERNAL_ERROR，不代表每个操作都会触发所有错误码。

## 7. QRSPI、版本与过期计划

stage 请求严格包含 `stage` 和正整数 `expectedVersion`（最大 2147483646），不接受额外字段。Task 必须 active，expectedVersion 必须等于当前 version，只能向相邻阶段推进。每次成功推进 version 加一，并产生 task.stage.changed 事件；版本不匹配为 VERSION_CONFLICT。没有实现 If-Match 请求头或通用任意状态写入。

从 questions 到 implement，门禁依次要求 questions/research/design/structure/plan 各准备阶段**最新版本**均为 status=approved、reviewState=approved，且后一个 Artifact 的 sourceArtifacts 包含最新前置 Artifact ID。approve 只允许这五类工件的最新版本，过期版本为 VERSION_CONFLICT；审批与 stage 推进是独立操作。

Session 传入 planHash 时必须匹配该 Task **最新已批准** Plan checksum；execution 存在时 planHash 必需。Run 的显式 planHash 必须与 Session 绑定计划一致；创建真实作业及领取作业时再次检查最新已批准计划。领取时发现 PLAN_HASH_STALE，会将作业 blocked、Run/Session waiting_input 并写事件，而不是继续执行旧计划。当前最新已批准计划检查与 stage 门禁的“最新版本必须批准”不是同一查询；本次如实冻结，不扩展成未实现的自动失效传播或自动重规划。

Artifact `version` 按 Task/type 递增，`schemaVersion` 是格式版本，内容 checksum 为 `sha256:<64 小写十六进制>`。平台事件 `payloadVersion` 当前写为 1；Task version 是业务并发版本。Session/Run 虽有内部 version 列，当前 HTTP 业务视图不暴露它们，也不接受对应 expectedVersion。

## 8. Checkpoint、租约与 SSE

Checkpoint 由 `id/messages/successfulTools/evidence` 组成，三组数组各至多 1000 项。messages 仅 user/assistant/tool，每条 text 至多 32768 字符；successfulTools 每项包含 `id/name/inputHash/output`，output 必须存在，JSON null 合法；evidence 每项为 kind/reference，reference 至多 10000 字符。控制面脱敏后整个检查点 JSON 的 UTF-8 字节数不得超过 1 MiB；本机进度日志还对整体 progress 采用 1 MiB 限制。

progress.type 为 checkpoint 时 checkpoint 必需；其余类型也允许附带检查点。checkpointId 不得替换成另一 Run 或另一份内容；恢复 Run 必须引用同一 Session 的检查点。resume 默认按源 Run 的 checkpoint sequence 降序、createdAt 降序选取最新检查点，显式 checkpointId 可引用同 Session 的其它检查点；无检查点也可以创建新尝试，不能声称恢复了未保存的上下文。Checkpoint 是执行恢复记录，既不包含可迁移进程，也不替代代码快照。

显式 pause 后，Daemon control 返回 status=paused、cancelRequested=true，作业查询允许 paused 状态。认证及 claimToken 校验有效时，迟到 progress 返回 accepted=false/status=paused/cancelRequested=true，不覆盖暂停状态；若过期处理已清除领取证明，仍会被拒绝。pause 不增加原生模型热暂停指令，resume 创建新 Run 并使用 Session execution 配置重新调度。

Claim 生成 120 秒租约；progress 与 ready Daemon 对仍有效 claimed 作业的 control 轮询可以续租，paused 作业不续租。Daemon 心跳超过 30 秒显示 reconnecting，超过 90 秒显示 disconnected；不直接标记 Run failed。后续 claim 扫描到过期作业时，有检查点转 paused，无检查点转 waiting_input，作业 blocked、cancelRequested=true 并清除领取证明，记录 EXECUTION_LEASE_EXPIRED，阻止自动重放。

SSE 的 `Last-Event-ID` 是 **Run 内平台事件 sequence 的十进制字符串**，不是 eventId、progress.sequence 或全局数据库行号。缺省 0；只接受数字且数值为 0..9007199254740991。游标超前或事件序号存在缺口为 EVENT_SEQUENCE_GAP。事件 sequence 按 run 优先、否则 task、否则 project 的 scope 单独分配；Task 关联事件查询可能混合多个作用域，不能用一个 Task 列表序号去恢复 Run SSE。

缺省只重放已持久事件并关闭；只有 `follow=true` 才保持连接，每 250ms 查询增量，空闲约 15 秒发送注释心跳。注释不改变游标；连接关闭后用最后处理成功的 sequence 重连。客户端处理可能重复，必须按 sequence/eventId 去重。

正常帧：`id: <sequence>`、`event: <eventType>`、`data: <EventEnvelope JSON>`。起流前错误使用统一 HTTP ApiError；发送响应头以后只能用 `event: stream.error` 帧结束，数据为 `{code,message,retryable}`，没有 traceId/details/occurredAt。EVENT_SEQUENCE_GAP 的 retryable 为 false，其余流异常为 INTERNAL_ERROR/true；客户端不能把流错误帧当成业务成功或推进游标。

## 9. Protobuf / ConnectRPC 冻结规则

DaemonGateway 当前仅冻结 Register、Heartbeat、Claim、Progress、Control 五个 unary 方法。注册、查询状态、撤销、通用 events、job 诊断的完整 HTTP 面由 OpenAPI 描述；本次不虚构已经部署的 RPC 等价入口。RPC 如后续扩展，应新增消息/方法，不复用既有 field number。

保留既有 Proto 与 Handoff/Git 快照格式，未增加 RPC 热恢复服务。HTTP pause/resume 已实现；Proto Control 仍仅提供 cancel_requested/status，显式暂停复用停止信号。Proto 内关于未增加 Pause/Resume 控制字段的说明只适用于冻结 RPC 边界，不能解释为 HTTP 路由仍为预留。

Proto 字段使用 snake_case，标准 Proto JSON 转换通常为 lowerCamelCase，但它不是当前 REST 正文的无损自动等价表示：uint64 的标准 JSON 输出为十进制字符串，而 HTTP sequence 为安全整数；RPC request 还有 daemon_id/run_id 包装，REST 从路径取得。Timestamp 对应 HTTP ISO8601 时间，ClaimResponse.dispatch 缺失对应 HTTP 204；缺失 checkpoint 与空检查点必须区分。后续适配器必须检查 JS 安全整数、presence 和范围，不能直接 JSON.parse 后强制断言类型。

proto3 编译只保证语法、字段类型与序列化，不验证非空、枚举字符串、数组上限、权限或哈希格式。RunDispatch 必须具有上下文 ID、goal、planHash、config、claimToken；SuccessfulTool.output、type=checkpoint 的 checkpoint、EventEnvelope.payload 等 presence 语义仍需应用校验。现有 HTTP 继续由 Zod 与 Service 执行校验，Proto 不引入重复 Runtime 空抽象。

未来协议演进要求：保持 package `titan.daemon.v1` / `titan.snapshot.v1`；只追加兼容字段；移除字段时保留对应 number/name；字段语义或身份作用域不兼容时使用新主版本。OpenAPI info.version、事件 payloadVersion、Artifact/schemaVersion 和 Snapshot/schema_version 分别演进，不共用一个“版本号”。

## 10. Git / Patch / WorkspaceSnapshot

本机 WorktreeManager 已提供创建分支和 `exportChanges`：导出私有 UUID bundle，包含 Git binary patch、本机 snapshot.json 与排除预览，保留源 index 和源提交。这里的 Proto 继续冻结后续跨环境同步格式，没有增加下载、应用 Patch 或上传 API。

本机 bundle 的 `excludes` 是最小排除 pattern 字符串数组，`excludedFiles` 是额外的本机预览元数据；`patchUri` 为相对 bundle 的 `patch.diff`。untracked/binary 已直接编码进本机 Patch，无单独 contentUri。本机 bundle 不宣称是已经完成传输、权限和跨环境校验的 HandoffSnapshot，不能按 Proto 字段名称相似就直接迁移。

WorkspaceSnapshot 冻结如下字段，Proto 的 snake_case 与文档 lowerCamelCase 对应：

| 字段 | 约束与含义 |
|---|---|
| schemaVersion | 固定 1；接收方拒绝不支持的主版本 |
| repo | 无凭证的仓库标识、仓库 URL 或已授权本机路径；拒绝 URL userinfo、签名查询或内嵌 token |
| baseRevision | 完整的 40 或 64 位十六进制 Git commit object ID；必须存在且属于授权仓库 |
| branchName | 可选元数据；不是执行命令，不可绕过 Git ref-format 验证 |
| patchUri | 受控工件引用；不得以未授权外部 URI 自动下载执行 |
| patchSha | Patch 原始字节的 `sha256:<64 小写十六进制>`，包括 binary patch 原始字节，不能改变换行或编码后复用摘要 |
| fileList | 变更文件清单；每个仓库相对路径唯一，与 Patch 和单独内容引用对应 |
| excludes | 显式排除清单；只能增加限制，不能移除最小排除集合 |

SnapshotFile 包含 `path/change/sizeBytes`；change 为 added/modified/deleted/renamed/untracked。非 deleted 项需要最终内容 checksum；deleted 项不携带最终内容；renamed 需要 previousPath，且前后路径均安全。untracked 及单独保存的二进制文件需要 contentUri；未跟踪文件不会仅凭 Git diff 自动进入 Patch。所有引用均在授权资源范围解析，校验最终字节数与 checksum，禁止因字段为空而默认读取本机任意文件。

最小排除集合为 `.git`（文件和目录）、`.env`、`.env.*`、`**/.env`、`**/.env.*`、`node_modules/**`、`**/node_modules/**`、`.titan/**`、`**/.titan/**`、`.humanlayer/**`、`.ssh/**`、`**/*.pem`、`**/*.key`、凭证存储目录、日志、构建产物及临时文件。含访问令牌的 Git remote 配置、设备状态、Daemon Outbox、claimToken、模型 API Key、环境变量展开结果都不能进入同步包；`.env.example` 如确需作为公开模板共享，必须另行明确审核，不能隐式放宽 `.env.*` 排除。

路径统一为仓库相对 POSIX 路径；拒绝绝对路径、Windows 盘符/UNC、反斜杠、空段、`.`、`..`、NUL、重复路径、符号链接越界，以及大小写不敏感文件系统上的目标冲突。不允许利用 Patch 的前缀、rename 或二进制内容绕过排除规则。后续接收方应先 dry-run 校验 baseRevision 和整包摘要，再在新的隔离工作区应用，验证最终清单；失败保留源工作区并报告冲突，不覆盖目标既有未提交工作。

这些是冻结的验证条件；当前没有 Snapshot 导出/应用校验器，也没有自动脱敏保证。Proto 往返测试不能代替这些安全与内容校验。

## 11. HandoffSnapshot 与验证条件

HandoffSnapshot 冻结字段为 `schemaVersion/snapshotId/projectId/taskId/sourceSessionId/sourceRunId/sourceCheckpointId/targetEnvironment/planHash/workspace/lastEventSequence/createdAt/createdBy/sourceArtifactIds`。targetEnvironment 仅 local/cloud；workspace 使用 §10 的 WorkspaceSnapshot。源身份不可被目标改写；未来目标创建新 Session，不能用原 Session ID 迁移进程或把 Run attempt 混合到另一 Session。

后续 Handoff 接收实现必须同时满足以下条件；当前仅冻结，尚无接收路由或运行时验证器：

1. schemaVersion 为支持版本；必需身份、时间、操作者与源工件引用完整；snapshotId 的重复请求须校验同一内容，不可用同 ID 替换快照。
2. 源 Session 属于 taskId/projectId，sourceRunId 属于源 Session，sourceCheckpointId 属于该 Session 且对应获准使用的源 Run；引用内容经过脱敏，成功工具输出有 presence。
3. 源执行已停止在明确安全点；没有未确认副作用；本机 Outbox 待确认项先与控制面核对。不能把仅仅 disconnected 当作可以安全转移的完成信号。
4. lastEventSequence 是源 Run 已持久确认的 EventEnvelope 游标，非 progress 游标；不得超前、缺口或以本机未确认事件代替控制面事实。
5. planHash 仍匹配目标 Task 最新已批准 Plan；目标执行仍遵循 QRSPI、版本与审批门禁，旧快照不能扩大授权或绕过 PLAN_HASH_STALE。
6. workspace 满足仓库归属、baseRevision、patchSha、文件 checksum、大小、排除清单及路径安全校验。缺失提交、Patch 冲突或不支持的快照版本必须阻断。
7. 目标环境、Daemon capability、工具集合、预算、工作区和凭证引用重新计算权限；不继承源 claimToken、Daemon Bearer、模型会话认证或任意执行授权。
8. 创建目标 Session/Run、记录 source→target 关联、迁移状态与补偿路径；在目标确认前保留源快照和可恢复状态，禁止源与目标并发重复执行有副作用工具。

Phase 1 不实际执行第 8 步或跨环境迁移；cloud 目标只是冻结值。本机 checkpoint→新 Run 恢复也不等于 Handoff。

## 12. 验证方式、限制与后续缺项

在仓库根目录使用 Node >=22 与锁定 pnpm：

```bash
pnpm --filter @titan/contracts build
node packages/contracts/openapi/generate.mjs --check
pnpm --filter @titan/contracts test
pnpm --filter @titan/contracts typecheck
```

更新 Zod 后先 build，再运行 `node packages/contracts/openapi/generate.mjs` 重建 JSON。生成器不会自动发现新增 Controller；契约测试会对比真实路由并提示遗漏，维护者需同步更新显式操作定义。它只转换已支持的 Zod 结构；refine/superRefine 的跨字段规则必须继续手工维护，例如 successfulTools.output 必填和 checkpoint 条件必填。

`openapi.test.ts` 使用 JSON.parse 读取实际 JSON，比较所有现有 Controller 的路径、方法、默认或显式 HTTP 状态码与 Daemon authenticate 边界，校验本地引用、请求绑定、Zod 字段及必填声明、执行限制、SSE 与错误字段；不是启动数据库的集成测试或完整 OpenAPI 官方 meta-schema 验证器。

多个隔离 worktree 尚未合并时，可用 `TITAN_CONTRACT_SOURCE_ROOT=/绝对路径 pnpm --filter @titan/contracts test` 显式指定只读 Controller 源码根目录；未设置时默认检查当前仓库。生成 JSON 始终保存在 contracts worktree，不修改被对照的源码。主线合并 pause/resume 后默认路由检查应覆盖全部 29 个方法/路径，不跳过新增路由。

`openapi-proto.test.ts` 在有 protoc 时编译两份文件，解析 descriptor，并实际编码/解码 RunDispatch、Checkpoint、EventEnvelope、HandoffSnapshot 样例；无 protoc 时明确 skip，不能宣称已编译。本次环境检测为 `libprotoc 36.0`，已实际运行编译与往返测试。Proto 样例只证明格式和字段可序列化，不证明 Snapshot 内容安全、所有 required 语义或迁移可执行。

尚缺的协议实现明确列为后续项：ConnectRPC 服务与客户端适配及 RPC 错误/认证映射；Snapshot 导出、校验、传输、应用；Handoff 业务状态机及端到端验证；原进程/原生模型会话热恢复；Redis 发布/订阅与 Temporal Worker；WorkItem、独立 Product Lifecycle 及完整团队授权接口。HTTP pause/resume 不再列为预留。本次冻结不将其它预留项记为已经运行或 Phase 1 全部完成。
