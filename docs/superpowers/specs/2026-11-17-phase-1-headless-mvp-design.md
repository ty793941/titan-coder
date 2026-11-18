# 第一阶段 Headless 本机 MVP 设计

> 文档状态：已确认设计
>
> 日期：2026-11-17
>
> 上游文档：`docs/product-spec.md`、`docs/implementation-roadmap.md`、`docs/technology-stack.md`、`docs/agent-runtime-design.md`、`docs/agent-runtime-practices.md`、`docs/execution-and-collaboration-design.md`

## 1. 目标

第一阶段交付一个没有 Web UI 的本机 Headless MVP，通过 REST API、CLI 和 SSE 验证从用户目标到可审阅交付证据的最小闭环：

```text
Task → Session → Run → Event / Artifact
              │
              ├── Agent Runtime
              ├── Tool / Permission / Hook
              └── Local Daemon / Worktree
```

阶段验收必须覆盖以下行为：

1. 通过 API 或 CLI 创建 Task。
2. 为 Task 创建 Session，并为同一 Session 创建多次 Run。
3. Run 失败后创建新的 Run，保留原 Run 的错误、事件和产物引用。
4. Codex 和 Qwen 通过统一 Runtime Adapter 产生标准 Session Event。
5. Task 可以生成 Questions、Research、Design、Structure、Plan、Implement Artifact。
6. Tool 调用经过输入校验、Permission、Hook、审计和错误归一化。
7. 代码操作只发生在授权的本机 Workspace 和 Git Worktree 中。
8. Daemon 心跳断开后进入 `reconnecting` 或 `disconnected`，不能被标记为已完成。
9. 控制面重启后，可以从 PostgreSQL、Outbox 和 Checkpoint 恢复可继续的状态。

## 2. 范围与非目标

### 2.1 本阶段范围

- pnpm Workspace、Node.js 22 LTS、TypeScript 严格模式和 Turborepo 基线。
- `packages/contracts`、`packages/domain`、`packages/agent-core`、`packages/daemon-protocol` 和 `packages/observability`。
- NestJS + Fastify Control Plane。
- PostgreSQL 17 作为 Task、Session、Run、Artifact、权限、审批、审计和 Outbox 的事实来源。
- 本机 Agent Runtime、Tool Registry、Permission Engine、Hook Runner、Checkpoint、Context Snapshot 和 Goal Gate。
- Codex App Server Adapter 与 Qwen 通用 Adapter 的统一接口及事件归一化。
- 本机 Daemon 的注册、心跳、Session 子进程、Workspace、Git Worktree、取消、超时和 Outbox。
- REST API、CLI 和 SSE 事件流。
- 可重复执行的 `/database/schema.sql` 和 `/database/init-data.sql`。
- 从 Questions 到 Implement 的 QRSPI 阶段产物和阶段门禁。

### 2.2 明确不做

- Web、桌面和移动端 UI。
- 云端 Session、云端 Daemon、容器编排和实际 Session Handoff。
- Claude、Gemini、DeepSeek、智谱以及其他 Provider 的实现。
- 多人实时协作、Presence、WebSocket、Team Inbox 和外部管理系统同步。
- Marketplace、生产发布、复杂计费、多仓库联动和 Kubernetes 生产部署。
- 通过模型直接上传或执行任意 Workflow/Skill 脚本。

第一阶段会冻结这些后续扩展点的契约，但不会实现对应的运行环境：`ExecutionEnvironment`、`RuntimeAdapter`、`SessionHandoff`、`ArtifactStore`、`EventSink` 和 `WorkflowEngine`。

## 3. 设计取舍

### 3.1 推荐方案：协议优先的四层垂直切片

第一阶段拆成四个依赖明确的实现增量，先固定共享契约，再逐步接通真实执行链路：

```text
基础协议与领域模型
        ↓
Control Plane + PostgreSQL + Outbox + SSE
        ↓
Agent Runtime + Tool / Permission / Hook
        ↓
本机 Daemon + Worktree + CLI + 端到端验收
```

该方案保留后续云端和 UI 的替换点，同时每个增量都能通过自动化测试验证。它避免先做没有调用方的空接口，也避免把 Control Plane、Runtime 和 Daemon 耦合成一个进程。

### 3.2 放弃的方案

**一次性搭建所有服务骨架**：可以快速得到很多目录，但无法证明 Task、Run、Tool 和恢复行为真正可用，且会产生大量没有调用方的抽象。

**先做内存版端到端原型再迁移数据库**：适合验证模型调用，但会掩盖幂等、Outbox、版本号和重启恢复问题，与第一阶段的主要风险不匹配。

**先实现完整 Temporal 工作流**：第一阶段只需要本机可恢复闭环，完整 Temporal Worker 属于后续云端和长任务阶段；此时使用 PostgreSQL 状态机并冻结替换接口，能减少基础设施负担。

## 4. 仓库结构

```text
/
├── apps/
│   ├── control-plane/       # NestJS REST API、SSE 和应用服务
│   ├── agent-runtime/       # 本机 Runtime 编排入口
│   ├── daemon/              # 本机进程、Workspace 和 Worktree 管理
│   └── cli/                 # Headless 命令行入口
├── packages/
│   ├── contracts/           # Zod Schema、API/事件/错误契约
│   ├── domain/              # Task、Session、Run、Artifact 和状态规则
│   ├── agent-core/          # Loop、Tool、Skill、Hook、Permission、Goal
│   ├── daemon-protocol/     # Daemon 注册、心跳和 Session 协议
│   └── observability/       # Pino、Trace、审计和指标字段
├── database/
│   ├── schema.sql
│   └── init-data.sql
├── infra/
│   └── docker-compose.yml   # PostgreSQL、Redis、MinIO 的本机依赖
├── docs/
│   ├── product-spec.md
│   ├── implementation-roadmap.md
│   ├── technology-stack.md
│   └── superpowers/
│       ├── specs/
│       └── plans/
├── package.json
├── pnpm-workspace.yaml
├── turbo.json
├── tsconfig.json
├── .env.example
├── .gitignore
└── README.md
```

`apps/control-plane` 只负责 HTTP 边界、鉴权入口和应用服务编排；领域规则放在 `packages/domain`；数据库访问只由 Control Plane 的基础设施实现完成。`apps/daemon` 负责实际进程和文件操作，不能直接推进业务阶段或批准高风险动作。

## 5. 核心领域模型

### 5.1 对象关系

```text
Project
 └── Task
      ├── Session
      │    └── Run
      │         ├── Event
      │         ├── ToolCall
      │         ├── HookExecution
      │         └── Checkpoint
      ├── Artifact
      └── WorkItem（需要独立调度时才创建）
```

`Task` 表示用户目标，`Session` 表示一个持续执行通道，`Run` 表示一次执行尝试。重试只创建新 Run，不覆盖旧 Run。`Artifact` 是版本化、可引用的结构化成果，不把交付结果只保存在聊天记录中。

### 5.2 状态规则

Task 的阶段为：`questions`、`research`、`design`、`structure`、`plan`、`implement`、`verify`、`review`、`delivered`。

Session 和 Run 共用执行状态：`queued`、`starting`、`running`、`waiting_input`、`paused`、`reconnecting`、`completed`、`failed`、`cancelled`。

Task、Session、Run 和 Artifact 的状态转换必须是领域层的纯函数，输入包含当前状态和带版本的命令，输出为新状态或稳定错误码。非法转换返回 `INVALID_STATE_TRANSITION`，不会修改持久化状态。

### 5.3 Artifact

Artifact 最少包含：`artifactId`、`projectId`、`taskId`、`sessionId`、`type`、`version`、`schemaVersion`、`uri`、`checksum`、`status`、`sourceArtifacts`、`createdBy`、`createdAt` 和 `reviewState`。

第一阶段使用 Markdown/JSON 文件保存内容，PostgreSQL 保存元数据、版本、来源和校验值。更新 Artifact 必须创建新版本；读取时必须指定固定版本或 `latest-approved`。

## 6. 统一事件与错误契约

### 6.1 Event Envelope

所有 Control Plane、Runtime 和 Daemon 事件使用同一结构：

```typescript
type EventEnvelope<TPayload> = {
  eventId: string;
  eventType: string;
  payloadVersion: number;
  sequence: number;
  traceId: string;
  projectId: string;
  taskId?: string;
  sessionId?: string;
  runId?: string;
  actor: { type: 'user' | 'agent' | 'daemon' | 'system'; id: string };
  occurredAt: string;
  payload: TPayload;
};
```

事件使用追加写入和唯一幂等键。SSE 以 `sequence` 作为 `id`，客户端发现序列断档后通过查询 API 补拉，不把 Redis 作为业务事实来源。

第一阶段至少支持：`task.created`、`task.updated`、`session.created`、`session.started`、`session.progressed`、`run.created`、`run.failed`、`run.completed`、`tool.requested`、`permission.required`、`tool.completed`、`hook.executed`、`checkpoint.created`、`artifact.created`、`daemon.heartbeat`、`daemon.disconnected` 和 `audit.recorded`。

### 6.2 稳定错误码

错误响应统一包含 `code`、`message`、`details`、`traceId`、`retryable` 和 `occurredAt`。第一阶段目录至少包含：

- `VALIDATION_FAILED`
- `RESOURCE_NOT_FOUND`
- `VERSION_CONFLICT`
- `IDEMPOTENCY_CONFLICT`
- `INVALID_STATE_TRANSITION`
- `TASK_PLAN_REQUIRED`
- `PLAN_HASH_STALE`
- `PERMISSION_DENIED`
- `APPROVAL_REQUIRED`
- `TOOL_INPUT_INVALID`
- `TOOL_BLOCKED_BY_HOOK`
- `TOOL_EXECUTION_FAILED`
- `TOOL_TIMEOUT`
- `DAEMON_UNAVAILABLE`
- `WORKSPACE_CONFLICT`
- `CHECKPOINT_NOT_FOUND`
- `RUNTIME_ADAPTER_UNAVAILABLE`

## 7. Control Plane 设计

### 7.1 API

第一阶段提供以下最小资源接口：

```text
POST /api/projects
POST /api/projects/:projectId/tasks
GET  /api/tasks/:taskId
POST /api/tasks/:taskId/sessions
GET  /api/sessions/:sessionId
POST /api/sessions/:sessionId/runs
GET  /api/runs/:runId
POST /api/runs/:runId/cancel
GET  /api/runs/:runId/events
GET  /api/tasks/:taskId/artifacts
POST /api/daemons/register
POST /api/daemons/:daemonId/heartbeat
```

项目创建接口负责生成项目、默认阶段模板和初始项目策略；后续 Task、Daemon 和 Artifact 请求都必须引用已存在且有权限访问的项目。

创建 Session 时必须检查 Task 是否存在、阶段是否允许执行、`planHash` 是否新鲜、Daemon 是否可用、Workspace 是否冲突以及权限快照是否有效。每个写接口接受幂等键；重复请求返回原结果，参数不同则返回 `IDEMPOTENCY_CONFLICT`。

### 7.2 持久化

PostgreSQL 保存 Project、Task、Session、Run、Artifact、Event、ToolCall、HookExecution、Checkpoint、Daemon、Approval、PermissionSnapshot、AuditLog、IdempotencyRecord 和 OutboxEvent。

一次状态变化与对应 OutboxEvent 必须在同一事务提交。发布器读取未发送的 OutboxEvent，按序发布到 SSE 投影并标记发送结果；重复发布由 `eventId` 去重。

Redis 和 MinIO 在第一阶段只作为本机依赖和替换点保留：Redis 可用于短期锁/缓存，Artifact 内容先使用受控本地目录；不会把 Redis 或文件目录当作 Task 状态事实来源。

## 8. Agent Runtime 设计

### 8.1 Loop 边界

Runtime 每一轮执行以下顺序：

```text
读取 Context Snapshot
  → UserPrompt / Session Hook
  → 调用 Runtime Adapter
  → 记录模型事件
  → Permission + PreToolUse
  → 执行 Tool / Subagent
  → 输出校验 + PostToolUse
  → 创建 Artifact / Checkpoint
  → Goal Gate
  → completed 或进入下一轮
```

模型只能提出 Tool、Skill、Subagent 和停止请求；只有 Runtime 才能执行副作用、改变 Run 状态、提交 Artifact 或批准停止。重复的 `toolUseId` 命中已保存结果，不重新产生副作用。

### 8.2 Tool、Permission 和 Hook

Tool 注册信息包含名称、版本、输入/输出 Schema、风险等级、能力、资源范围、副作用、超时、重试和回滚声明。执行顺序固定为：

```text
解析版本 → 输入校验 → Permission → tool.before
→ dry-run/审批 → Sandbox 执行 → 输出校验
→ tool.after → Event / Artifact / Audit
```

Permission 采用 `allow`、`ask`、`deny` 三态。显式 Deny、风险门禁和缺少审批优先于 Allow。文件路径、命令、网络、工作区和外部连接分别授权；`ask` 在没有交互终端时必须失败关闭并返回 `waiting_input`。

阻断型 Hook 默认 fail-closed，观测型 Hook 记录失败后继续。Hook 具有超时、重试次数、优先级、失败策略和递归深度；结果写入 Event Store。

### 8.3 Adapter

统一 Runtime Adapter 接口：

```typescript
interface RuntimeAdapter {
  createSession(config: RuntimeSessionConfig): Promise<NativeSession>;
  streamEvents(session: NativeSession): AsyncIterable<NativeRuntimeEvent>;
  sendInput(session: NativeSession, input: RuntimeInput): Promise<void>;
  pause(session: NativeSession): Promise<CheckpointReference>;
  resume(session: NativeSession, checkpoint: CheckpointReference): Promise<void>;
  cancel(session: NativeSession): Promise<void>;
  close(session: NativeSession): Promise<void>;
}
```

Codex Adapter 调用 Codex App Server；Qwen Adapter 使用统一通用 Loop 和 API Key Profile。两者都必须把原生事件转换为平台事件，并隐藏厂商 SDK 类型，不让领域层依赖 Provider。

## 9. 本机 Daemon 设计

Daemon 维护本机执行资源，不维护组织级业务事实。注册时上报 `machineName`、`environmentType=local`、`capabilities`、`workspaceRoots`、`maxConcurrentSessions` 和 `daemonVersion`；心跳超时进入 `reconnecting`/`disconnected`，恢复后按序发送 Outbox。

Daemon 为每个 Session 创建受控进程组，设置工作目录、环境变量白名单、命令白名单、超时和取消令牌。Workspace Manager 负责创建和检查 Git Worktree，拒绝越过授权根目录、已有运行锁或未同步变更的冲突操作。

Daemon 的事件和日志只保存凭证引用、参数摘要和结果摘要，禁止记录 Token、私钥和完整 Prompt。控制面通过带版本的执行计划和 Permission Snapshot 派发动作，Daemon 不能自行推进 Task 阶段、批准发布或修改权限。

## 10. CLI 设计

CLI 只调用 Control Plane API 和 SSE，不直接写数据库。第一阶段提供：

```text
platform task create
platform task get <task-id>
platform session create <task-id>
platform run create <session-id>
platform run get <run-id>
platform run events <run-id>
platform run cancel <run-id>
platform daemon start
platform daemon status
```

CLI 输出机器可读 JSON 和适合终端阅读的文本两种格式，所有命令返回稳定退出码，并在错误中显示 `code`、`traceId` 和下一步建议。

## 11. 安全、恢复与回滚

- 默认拒绝所有未声明的 Tool、路径、命令、网络和数据库资源。
- 凭证只保存 `credentialRef`；不写入 Prompt、Event、Artifact、普通业务表或日志。
- 高风险动作先生成影响预览，再进入 Approval，最后使用一次性确认令牌执行。
- 不可逆 Tool 声明人工回滚步骤；文件修改通过 Worktree、Patch 和 Snapshot 保留恢复依据。
- 控制面重启从 PostgreSQL 状态、Outbox 和 Checkpoint 恢复；Daemon 重启先查询子进程实际状态，再决定恢复或失败。
- Run 重试创建新的 `attempt`，成功的 Tool 调用通过 `toolUseId` 和执行记录去重。
- 任何状态推进都检查版本号，冲突返回 `VERSION_CONFLICT`，不覆盖新版本。

## 12. 测试策略与验收证据

### 12.1 单元测试

- Task、Session、Run、Artifact 和 QRSPI 状态转换。
- Event Envelope、错误码和 Zod Schema。
- Permission 的 Deny/Ask/Allow 优先级。
- Hook 顺序、超时、失败策略和递归保护。
- ToolUse 幂等、Goal Gate 和 Checkpoint 选择。

### 12.2 集成测试

- PostgreSQL Repository、事务和 Outbox 原子写入。
- API 幂等键、版本冲突、权限和 SSE 序列补拉。
- Daemon 注册、心跳断开、恢复和 Outbox 去重。
- Git Worktree 创建、路径限制、并发冲突和清理保护。

### 12.3 端到端验收

使用临时 PostgreSQL、临时 Workspace 和可控 Runtime Adapter 完成：

1. 创建 Project，再创建 Task。
2. 创建 Session 和首个 Run。
3. Runtime 请求一个受授权 Tool，并产生事件、审计和 Artifact。
4. 首个 Run 故意失败，确认错误和证据保留。
5. 创建第二个 Run，从 Checkpoint 恢复并完成。
6. 通过 CLI 订阅 SSE，确认事件顺序和断档补拉。
7. 终止 Daemon，确认状态为 `reconnecting`/`disconnected`，恢复后继续。

Codex 和 Qwen 的真实 Adapter 另做受环境凭证控制的适配器测试；核心领域和 Control Plane 测试使用确定性 Fake Adapter，避免测试依赖外部模型服务。

## 13. 实施顺序与完成门禁

实施顺序固定为：

1. 基础协议、领域模型、错误码、事件和测试工具。
2. Control Plane、数据库脚本、Repository、API、Outbox 和 SSE。
3. Runtime Core、Tool、Permission、Hook、Checkpoint 和 Adapter。
4. Daemon、Worktree、CLI 和本机进程管理。
5. 集成验收、文档、测试报告和 Reviewer 检查。

每个增量必须满足：

- 相关测试先失败后通过。
- `pnpm lint`、`pnpm typecheck`、`pnpm test` 有实际输出。
- 变更文件、验收证据和风险被记录。
- 数据库变更同步更新 `database/schema.sql` 和 `database/init-data.sql`。
- 任何高风险动作都有预览、审批、审计和回滚路径。

第一阶段最终完成条件是：四个增量全部通过 Phase 1 验收标准，且生成 `source-diff`、`test-report`、`review` 和 `release-package` Artifact 元数据。
