# Phase 2B：Temporal 持久编排与基础定时执行设计

> 状态：用户已确认，进入实施；用户确认指令为“继续吧”。
>
> 日期：2026-11-24。
>
> 基线：`1f43e96`；上游为 `docs/implementation-roadmap.md`、`docs/technology-stack.md`、`docs/phase-2a-review.md`。

## 1. 目标与范围

在已交付的 Daemon Cloud Executor 上接入真实 Temporal TypeScript SDK，支持显式启动后台 Run、跟踪既有本机或云端 Run、在 Worker 重启后恢复编排，以及有时区和并发限制的基础定时任务。PostgreSQL 仍是业务事实来源，Daemon 仍是实际执行主体，模型凭证继续由宿主安全解析。

本轮交付三个相互依赖的单元：持久工作流与 Outbox 投递、后台任务 API、Temporal Schedule 与有限次数定时执行。本轮完成后，不把整个 Phase 2 标记为完成；跨主机 Snapshot、远程 Git 同步、生产 Secret Broker 和云资源调度仍单独实施。

## 2. 方案取舍

| 方案 | 优点 | 代价与结论 |
| --- | --- | --- |
| 真实 Temporal 编排，复用现有执行协议 | 落实既定技术栈，具备服务端定时器、历史重放及 Worker 恢复；现有 Daemon 可复用 | 增加显式启用的 Temporal 服务和 Worker；推荐 |
| 继续扩展 PostgreSQL 轮询调度 | 本地依赖少，可沿用现有部署 | 需要自行维护计时、调度历史和工作流恢复，重复既定 Temporal 能力；不采用 |
| 先做控制台云端入口 | 容易展示 Phase 2A 能力 | 不能补足路线图要求的持久编排和定时执行；放在后续 UI 切片 |

## 3. 架构与职责

- **Control Plane**：接受管理请求，检查 Session、Task、Plan 和执行权限，维护后台任务与调度定义，原子写入业务记录、命令 Outbox、审计和事件。
- **Workflow Worker**：独立受控 Node.js 进程，消费专用 Temporal Task Queue；Activity 仅调用控制面受认证的内部接口，不绕过领域服务写数据库，不执行 Docker 或模型。
- **Temporal Workflow**：只接收后台任务 ID、工作流版本和调度定义引用；通过短 Activity 查询或发出幂等命令，通过持久 Timer 等待，不在 Workflow 代码中访问网络、文件或数据库。
- **Daemon**：继续通过 claim、control、progress、租约和 Outbox 执行 Run。Temporal Worker 故障不替代 Daemon 心跳，也不续期执行租约。
- **Temporal Schedule**：提供触发时间、时区、重叠策略和调度暂停。每次触发通过控制面重新校验业务授权。

新增 `packages/workflow` 放置版本化 Workflow、Activity 接口、Temporal Client 适配和历史重放测试；新增 `apps/workflow-worker` 承载 Worker 入口与安全配置。控制面新增 orchestration 模块。源码仍使用 Node.js 22、TypeScript 和 pnpm 10.34.5；SDK 及服务镜像在实施计划中按实际兼容性固定版本，禁止使用浮动 latest。

## 4. 执行模式

### 4.1 显式后台执行

管理者对已登记的本机 Session 创建后台任务，必须明确 `runInBackground=true`、`planHash`、幂等键和执行截止时间。控制面先持久化任务与启动命令；Temporal 可用后启动 Workflow，由启动 Activity 调用现有 Run 创建领域逻辑。

Run、execution_job、后台任务关联及业务事件在同一 PostgreSQL 事务中创建。Activity 重试使用固定的后台任务 ID 作为幂等键；如果创建 Run 成功但响应丢失，重试返回原 Run，不创建第二个 attempt。

Temporal 尚未收到启动命令时，不提前创建会被 Daemon 领取的 execution_job。接口返回已持久化的 `pending_dispatch` 状态，不能伪报已运行。

### 4.2 跟踪已有 Run

管理者可以为已有本机或 cloud Run 创建 `observe` 类型后台任务。它只跟踪该 Run，不重新创建 Session、Run、容器、Checkpoint 或 Secret Lease。请求中的 project/task/session/run 归属必须通过服务端解析，不信任客户端自由组合。

当前 cloud Session 的创建继续通过 Phase 2A Handoff；本轮不开放复用现有云端 Session 的新 attempt，也不把定时器触发解释为新的云端凭证授权。

### 4.3 后台任务与 Run 的状态

后台任务至少包括 `pending_dispatch`、`dispatching`、`running`、`waiting_input`、`reconnecting`、`cancel_requested`、`completed`、`failed`、`cancelled`、`expired`。

- `waiting_input`、`paused` 和 `reconnecting` 不触发自动重跑模型；原 Run 和原因保持可查。
- Workflow 可以持久等待人工处理后再读取同一 Run，但不隐式创建新 attempt。
- 本轮不增加 cloud pause；仍返回 Phase 2A 已定义的 `CLOUD_PAUSE_UNSUPPORTED`。
- 后台任务到达截止时间后，通过控制面记录取消意图，并结束本次编排为 `expired`；不能直接杀宿主或 Docker 进程。
- Temporal Workflow 的完成或取消只证明编排状态；容器实际退出和清理仍以 Daemon 证据为准，响应不能把取消请求接受描述成进程已退出。
- Run 运行上限沿用现有 `timeoutMs <= 86400000`，不能借“长任务恢复”绕过执行预算和限制。

## 5. 双写一致性与恢复

新增专用 `workflow_command` 表，避免复用 `outbox_event.published_at` 抢占现有 SSE/未来其他消费者的投递状态。

启动和取消采用以下链路：

1. 控制面事务写入后台任务、命令和事件。
2. Dispatcher 使用有截止时间的投递租约领取命令；领取完成后释放数据库锁，再调用 Temporal。
3. Workflow ID 固定为 `titan/background/<backgroundJobId>/v1`，同一命令重复发送时查询既有 Workflow，禁止覆盖或重复启动。
4. Temporal 接受后再标记命令完成；响应丢失可安全重试。
5. Dispatcher 重启只回收过期投递租约，不改变既有 Run 或模型执行。

Activity 查询失败可以指数退避重试；权限拒绝、计划失效、资源归属错误和幂等冲突不能当成瞬态故障无限重试。数据库保持后台任务与 Run 的唯一关联。Workflow replay 只重放编排历史；不重新消费 Secret、不执行 Tool，也不直接修复容器。

长等待使用 Temporal Timer 和短查询 Activity；历史接近阈值时 Continue-As-New，保持同一后台任务和业务 Run，只携带 ID、版本、截止时间和安全游标。Continue-As-New 不创建新的业务执行尝试。

## 6. 基础定时执行

本轮 Schedule 目标限定为已批准的本机 Session，每次发生创建一个新的 Run attempt。重复触发不能复用活动 Run 的工作区写权限。

调度定义必需字段：

| 字段 | 约束 |
| --- | --- |
| `sessionId` | 必须为具备执行配置的本机 Session |
| `planHash` | 创建、启用及每次触发都检查仍为最新批准计划 |
| `timezone` | 显式 IANA 时区，不使用服务器本地时区推断 |
| `cron` 或 `intervalSeconds` | 两者互斥；Cron 为五字段，最短间隔一分钟；禁止任意 Workflow 名称或代码 |
| `startsAt`、`endsAt` | UTC 时间；结束时间必须晚于开始时间 |
| `maxRuns` | 有限整数，1–100；创建 Run 前原子检查并占用次数，Activity 重试不重复计数 |
| `overlapPolicy` | 首版固定 `skip`，同一 Session 存在活动 Run 时跳过并记录原因 |
| `catchupWindowSeconds` | 显式 10–3600，默认 60；超过窗口的触发跳过，窗口内最多补投一次，正常短暂投递延迟不视为无效 |
| `enabled` | 创建时固定为 false；必须显式启用，创建定义不立即调用模型 |
| `expectedVersion` | 修改、启用和暂停时使用乐观版本检查 |

Temporal 使用 Schedule API，不使用旧 `cronSchedule` 选项。时间计算交给 Temporal；控制面校验时区、结构、最短频率、限次和结束时间，并在 Activity 派发前重新检查数据库定义版本及启用状态。

每个触发使用稳定的 Temporal Workflow ID 关联一个 `schedule_occurrence`；历史重放、Activity 重试、Dispatcher 重发都不能创建第二个后台任务或 Run。修改后的定义使用新版本，旧版本已排队但尚未派发的触发记为 `skipped/definition_superseded`。

暂停调度只阻止未来触发；已经开始的 Run 保持原状态，需要显式取消后台任务才能请求停止。达到次数或结束时间后不再创建新 Run。计划变更或权限收紧后，调度进入阻塞/禁用状态并记录事件，不能自动提高权限或换用新计划。

Schedule 在 PostgreSQL 与 Temporal 中的更新同样经过命令 Outbox；控制面返回 `pending_sync` 与实际启用状态，只有同步确认后才报告 `active`。业务派发始终以 PostgreSQL 授权状态为准。

当前版本的 `sync_schedule` 永久失败、重试十次耗尽或第十次投递租约过期后，控制面在同一事务中将命令标记失败、调度标记 `sync_status=blocked`，并写入 `schedule.sync_failed` 事件，固定错误码为 `WORKFLOW_COMMAND_FAILED`。保留管理员期望的 `enabled` 和定义版本，便于明确表达同步尚未成功；接纳触发及派发前都拒绝 `blocked`，所以 Temporal 中尚存的旧 Action 也不能创建新 Run，已执行 Run 不受影响。只有版本仍匹配才阻塞，旧版本失败不能覆盖新定义。管理员通过完整 update 或 enable 产生版本加一的同步命令恢复，不自动重试已失败命令或删除任务。耗尽清理按 Session→Schedule 顺序尝试非阻塞目标锁，锁冲突时延后清理，不阻塞其他 Session。

## 7. 最小持久数据

所有业务 ID 沿用现有 TEXT 类型，所有结构变更统一维护 `database/schema.sql` 和 `database/init-data.sql`。

`background_job.worker_id` 和 `execution_schedule.worker_id` 同时通过建表定义及 `schema.sql` 中的 `ALTER TABLE ADD COLUMN IF NOT EXISTS` 维护。已有行保持 nullable 未绑定状态；仅执行 schema 脚本也能升级旧表，重复执行保留旧行及其业务字段，初始化数据脚本不回填 Worker 身份。

- `background_job`：ID、project/task/session/run 引用、类型、工作流类型及版本、Workflow ID、状态、截止时间、计划哈希、操作者、取消意图、错误码、版本和时间；一项任务最多绑定一个业务 Run。
- `workflow_command`：命令 ID、类型、目标引用、版本、幂等键、请求哈希、投递状态、次数、重试时间、投递租约、固定错误摘要和时间；不保存任意 Prompt、Key 或 URL。
- `execution_schedule`：目标 Session、计划哈希、时区、时间规则、起止时间、最大次数、已占用次数、期望启用状态、同步状态、Temporal Schedule ID、版本及操作者。
- `schedule_occurrence`：调度 ID、定义版本、稳定触发 ID、计划/实际时间、后台任务引用、派发/跳过/失败原因；触发 ID 建唯一约束。

不引入第二套 execution_job 或 Secret Lease；不修改既有事件的发布标志来代表 Temporal 投递进度。

## 8. API、身份与敏感信息

管理 API 均复用当前本机 Console Bearer 校验，并通过领域服务检查资源归属：

- `POST /api/sessions/:sessionId/background-jobs`：显式后台 Run 或观察该 Session 已有 Run。
- `GET /api/background-jobs/:id`、`POST /api/background-jobs/:id/cancel`。
- `POST /api/sessions/:sessionId/schedules`、`GET /api/schedules/:id`。
- `POST /api/schedules/:id/update`、`POST /api/schedules/:id/enable`、`POST /api/schedules/:id/pause`。

不增加自动删除接口。列表查询必须限定项目/Session，并使用有上限的分页。

Worker 使用独立的控制面服务身份，仅允许读取其绑定后台任务、幂等派发和取消；不得复用任意 Daemon token，也不得获得注册设备、批准计划或读取凭证的权限。服务认证从本机 Keychain/受控 Secret 通道注入 Worker 内存，不从工作流参数获取。

Temporal 参数、Activity 返回值、Signal、Memo、Search Attributes、错误、日志和 Event History 只允许最小结构化 ID、状态、版本及安全错误码。Provider Key、API URL、完整 Checkpoint、Prompt、Tool 结果和控制面认证值禁止进入 Temporal 历史；Activity 的 HTTP 原始错误正文不得直接返回 Workflow。

## 9. 本地运行与兼容

增加显式启用的 Temporal Compose 配置，服务端存储使用独立持久卷，默认不启动、不暴露公网。开发模式端口只绑定回环地址，部署文档明确其只用于本机验证。生产 Temporal Cloud、TLS 身份和多区域部署不包含在本轮。

既有直接创建 Session/Run、Handoff、Daemon claim/control/progress、Codex App Server 和 UI 保持兼容。新增后台与调度入口在 Temporal 未启用时返回明确错误或持久待投递状态，不能回退为未授权的直接执行。

## 10. 验证与完成门槛

- TDD：先验证重放/重试导致重复派发、取消丢失、过期计划触发、并发重叠及次数超限等用例为红灯，再实现。
- 契约：Zod/OpenAPI、字段边界、时区/时间规则、认证、幂等、版本冲突和跨项目归属测试。
- 持久化：真实 PostgreSQL 独立 schema；覆盖事务回滚、Dispatcher 在 Temporal 接受后崩溃、投递租约竞争及旧定义触发。
- Temporal：官方测试环境验证 Timer、Signal、取消、Activity 重试、Continue-As-New 和历史重放；不能只用假的 Client 冒充真实集成。
- 本地服务：启动真实 Temporal，完成 Worker 停止再重启、同一任务继续观察且 Run 不重复；Schedule 暂停、限次、重叠和错过触发策略。
- 云端回归：观察 Phase 2A 的 Docker Run 不启动第二个容器，不重新消费凭证，不改变 ACK 后清理、fencing 和取消语义。
- 历史扫描：使用合成 Key、URL、服务 Token 和 Prompt，检查 Workflow History、Memo、日志及事件均不包含值。
- 完整门禁：保留 Phase 2A 的 511 项基线，并执行新增测试、构建、类型检查、Lint、OpenAPI 检查及只读 Reviewer；提交并按既有约定通过代理推送。

## 11. 明确后续工作

跨主机 Snapshot/Artifact 对象存储、远程 Git Clone/Fetch/Push/Patch、生产 Secret Broker、定时创建新的 cloud Session、cloud pause/resume、多租户调度和团队协作 UI 不由本轮设计隐式启用，分别形成后续可验收切片。

## 12. 依据

- `apps/control-plane/src/modules/runs/runs.service.ts`：现有 Run 创建事务、计划校验、幂等与 cloud attempt 限制。
- `apps/control-plane/src/modules/handoffs/handoffs.service.ts`：本机暂停后创建 cloud Session、新 Checkpoint、Secret Lease 和执行作业。
- `apps/control-plane/src/modules/daemons/execution.service.ts`：执行租约、心跳 fencing、Progress 与 control 续租。
- `apps/control-plane/src/modules/events/events.service.ts`：业务事件及 Outbox 原子写入。
- [Temporal TypeScript Workflow basics](https://docs.temporal.io/develop/typescript/workflows/basics)：确定性 Workflow 与副作用 Activity 边界。
- [Temporal TypeScript Schedules](https://docs.temporal.io/develop/typescript/workflows/schedules)：Schedules、overlap、catchup 和暂停行为；官方推荐 Schedules 优于旧 Cron Jobs。
- [Temporal TypeScript cancellation](https://docs.temporal.io/develop/typescript/workflows/cancellation)：Activity 取消与实际执行结束的区别。

本设计已完成源码与官方文档核对。实现及验证进展见同日期实施计划和 Phase 2B 验证记录；不得以设计确认代替实际测试证据。
