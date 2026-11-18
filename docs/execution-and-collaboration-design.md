# 执行与协作系统设计

> 文档状态：v0.1
>
> 目标：定义本地执行守护进程、Task/Session/Artifact/Worktree 分离、QRSPI 交付流程和多人实时协作能力。执行层采用 Node.js 22 LTS + TypeScript，协议使用 Protobuf + ConnectRPC，本文固定职责、状态、接口和数据关系。

## 1. 设计原则

1. 控制面维护项目事实、权限、任务和产物；执行守护进程负责实际运行 Agent、命令和代码工作区。
2. Task 表示业务目标，Session 表示 Agent 的持续上下文，Run 表示一次执行尝试，Artifact 表示可审阅产物，Worktree 表示隔离工作区。
3. 复杂任务先经过 Questions、Research、Design、Structure、Plan，再进入 Implement。
4. 本地执行状态可以断网运行，网络恢复后按事件序列增量同步。
5. 多人可以同时查看、评论、评审和接管任务；所有变更使用版本号和事件记录解决并发。
6. 项目经理 Agent 是用户交付入口，但不替代真实成员的责任、评审和审批。

## 2. 本地执行守护进程

### 2.1 职责

每台执行机器运行一个 Daemon。Daemon 通过受信连接与控制面通信，在本地完成：

- 启动、停止、暂停和恢复 Agent Session。
- 管理多个项目、仓库、Worktree 和执行环境。
- 运行命令、测试、构建和代码工具。
- 采集模型、Tool、Hook、进程和文件变更事件。
- 维护本地凭证引用、网络策略和工作区权限。
- 在断网时缓存事件和产物元数据，恢复后按序同步。
- 发现残留进程、孤儿 Worktree 和未提交变更并上报。

Daemon 不保存组织级业务真相，也不自行改变任务阶段、审批结果或成员权限。控制面下发带版本的执行计划，Daemon 返回事实和执行证据。

### 2.2 拓扑

```text
┌────────────────────────────┐
│ Web / Desktop / Mobile      │
│ 项目经理会话与团队工作台    │
└──────────────┬─────────────┘
               │ HTTPS / Event Stream
┌──────────────▼─────────────┐
│ Control Plane               │
│ Task / Session / Artifact   │
│ Permission / Review / Sync  │
└──────────────┬─────────────┘
               │ 双向事件与执行计划
      ┌────────▼────────┐       ┌────────▼────────┐
      │ Local Daemon A  │       │ Remote Daemon B  │
      │ workspace       │       │ workspace       │
      │ Agent sessions  │       │ Agent sessions  │
      └───────┬─────────┘       └───────┬─────────┘
              ▼                         ▼
       Claude / Codex /           其他模型和执行器
       其他 Agent Runtime
```

### 2.3 Daemon 状态机

`registered` → `connecting` → `ready` → `draining` → `offline` / `revoked`。

Session 派发前必须检查 Daemon：在线状态、能力标签、版本、剩余并发、工作区可用性、权限策略和心跳时间。Daemon 被撤销后不得接收新 Session；运行中的 Session 进入 `reconnecting` 或 `waiting_input`，不能静默丢失。

### 2.4 Daemon 注册字段

| 字段 | 类型 | 必填 | 说明 |
|---|---|---:|---|
| `daemonId` | string | 是 | 守护进程唯一标识 |
| `organizationId` | string | 是 | 所属组织 |
| `machineName` | string | 是 | 机器显示名 |
| `environmentType` | enum | 是 | `local`、`cloud` |
| `capabilities` | array | 是 | 模型、命令、浏览器、容器、代码智能能力 |
| `workspaceRoots` | array | 是 | 允许管理的目录根 |
| `maxConcurrentSessions` | integer | 是 | 最大并行 Session 数 |
| `daemonVersion` | string | 是 | 协议兼容版本 |
| `lastHeartbeatAt` | datetime | 是 | 最近心跳 |
| `status` | enum | 是 | Daemon 状态 |

### 2.5 双执行环境

Session 的执行环境统一抽象为：

| `environmentType` | 执行位置 | 适用场景 | 凭证处理 |
|---|---|---|---|
| `local` | 用户电脑上的 Daemon、本地进程组或本地容器 | 本地仓库、IDE、浏览器和个人资源 | 操作系统密钥链或本地加密存储 |
| `cloud` | 云端 Daemon/Runner 的隔离容器 | 远程协作、长期任务、Cron 和共享任务 | Secret Broker 注入短期凭证 |

两种环境使用同一套 Task、Session、Artifact、Worktree、Permission 和 Event 协议。控制面根据工作区位置、Daemon 能力、数据区域、成本和组织策略选择环境。

### 2.6 Agent Runtime Gateway

Session 不直接调用厂商模型 API，而是由 Gateway 选择原生 Agent Runtime：

| Runtime | 接入方式 |
|---|---|
| Codex | Codex App Server Adapter |
| Claude | Claude Agent SDK Adapter |
| Gemini | Gemini Native Adapter |
| DeepSeek | Native / OpenAI-Compatible Adapter |
| Qwen | Native / OpenAI-Compatible Adapter |
| 智谱 | Native / OpenAI-Compatible Adapter |
| 中转站 | Relay Adapter |

认证模式：`native-login`、`api-key`、`relay-api-key`。原生登录和中转站是独立权限域；本机 Session 使用本地安全存储，云端 Session 使用短期 Secret Broker 凭证。所有 Adapter 必须转换为统一的 Session Event、Tool、Permission、Artifact 和 Checkpoint 协议。

Runtime 分为三类：

1. **原生 Coding Agent Runtime**：直接接入 Codex App Server、Claude Agent SDK 等完整 Agent Runtime，保留原生 Tool、上下文、权限和会话能力。
2. **通用 Agent Runtime**：平台自己实现 Loop、Tool、Skill、Memory、Context 和 Goal，使用 Qwen、DeepSeek、智谱、Gemini 等模型或兼容 API。
3. **第三方 Agent Runtime Adapter**：通过 SDK、CLI、协议或 MCP 接入其他 Agent 系统，统一转换 Session Event 和权限边界。

云端执行采用“Worker + Session Container”结构。一个云端 Session 默认对应一个隔离容器；Temporal 负责创建、等待、恢复和销毁流程，Agent 进程由容器内的 Daemon/Runner 管理，不能把长时间 Agent 进程直接塞进 Temporal Activity。

## 3. Task、Session、Artifact、Worktree 分离

### 3.1 关系

```text
Project
  └── Task：业务目标
       ├── Session：一次 Agent 执行
       │    ├── Run：一次执行尝试
       │    └── Daemon
       ├── Artifact：结构化产物
       ├── Worktree：隔离代码工作区
       ├── WorkItem：可选的调度拆分
       └── Review / Decision / Handoff
```

Task 不等于聊天会话。一个 Task 可以串行或并行启动多个 Session，也可以由不同模型、不同 Daemon 和不同角色 Agent 执行。

规范关系：

```text
Task
 ├── Session
 │    ├── Run
 │    └── Run
 ├── Session
 │    └── Run
 └── Artifact

Task
 └── WorkItem（可选）
      ├── Assignment
      ├── Dependency
      └── Schedule
```

### 3.2 Task

Task 表示一个完整业务目标，字段至少包括：`taskId`、`projectId`、`title`、`goal`、`acceptanceCriteria`、`stage`、`status`、`priority`、`dependencies`、`humanOwner`、`agentOwner`、`planHash`、`createdBy`、`dueAt` 和 `version`。

Task 状态：`draft` → `clarifying` → `researching` → `designing` → `structuring` → `planning` → `implementing` → `verifying` → `reviewing` → `delivered`，任意阶段可进入 `blocked`、`paused`、`cancelled` 或 `failed`。

### 3.3 Session

Session 表示某个 Agent Runtime 针对 Task 的持续上下文和执行通道。字段至少包括：`sessionId`、`taskId`、`workItemId?`、`parentSessionId`、`daemonId`、`runtime`、`agentRole`、`modelRef`、`workspaceId`、`permissionSnapshotId`、`contextSnapshotId`、`status`、`startedAt`、`endedAt`、`lastEventSequence` 和 `usage`。

Session 状态：`queued` → `starting` → `running` → `waiting_input` / `paused` / `reconnecting` → `completed` / `failed` / `cancelled`。

### 3.4 Run

Run 表示一个 Session 中的一次执行尝试。一次 Run 可以因为模型错误、Tool 失败、网络断开、审批等待或用户取消而结束；重试会创建新的 Run，不能覆盖原 Run。

Run 字段至少包括：`runId`、`sessionId`、`attempt`、`trigger`、`inputSnapshotId`、`permissionSnapshotId`、`checkpointId`、`status`、`startedAt`、`endedAt`、`errorCode`、`usage` 和 `resultArtifactIds`。

Run 状态：`queued` → `starting` → `running` → `waiting_input` / `paused` / `reconnecting` → `completed` / `failed` / `cancelled`。`waiting_input` 不算失败；只有执行环境确认无法继续时才进入 `failed`。

### 3.5 Artifact

Artifact 是任务过程中的结构化成果，不把所有成果堆进聊天记录。Artifact 字段：`artifactId`、`taskId`、`sessionId`、`type`、`version`、`uri`、`checksum`、`schemaVersion`、`status`、`sourceArtifacts`、`createdBy`、`reviewState` 和 `visibility`。

标准类型：`questions`、`research`、`design`、`structure`、`plan`、`source-diff`、`test-report`、`review`、`release-package`、`decision-record`。

Artifact 必须支持版本、差异、评论、引用、审批、权限和回写。Agent 读取 Artifact 时使用固定版本或明确的 `latest-approved` 解析规则，禁止读取漂移中的未审阅内容。

### 3.6 WorkItem（可选）

WorkItem 不是 Task 的别名，也不是每个 Task 的必需实体。只有在需要独立工作队列、责任分派、依赖关系、优先级、排期、租约或并发调度时，才从 Task 下拆出 WorkItem。

WorkItem 字段至少包括：`workItemId`、`taskId`、`title`、`goal`、`acceptanceCriteria`、`status`、`priority`、`dependsOn`、`humanOwner`、`agentOwner`、`assignmentId`、`schedule` 和 `version`。

WorkItem 状态：`draft` → `ready` → `claimed` → `in_progress` → `blocked` / `completed` / `failed` / `cancelled`。

规则：

- Task 是用户目标的事实来源；WorkItem 只是可调度的执行拆分。
- Session 可以直接挂 Task，也可以挂 WorkItem；两者不能同时作为同一 Session 的主目标。
- WorkItem 依赖图必须无环，认领必须原子化，并使用租约防止重复执行。
- 没有独立调度需求时，不创建 WorkItem，避免空壳任务和重复状态。

### 3.7 Worktree

Worktree 是 Task 级代码隔离单元，字段至少包括：`worktreeId`、`taskId`、`repositoryId`、`baseRevision`、`path`、`branchName`、`ownerAssignmentId`、`status`、`dirtyState`、`lastSyncAt` 和 `cleanupPolicy`。

Worktree 状态：`requested` → `creating` → `ready` → `in_use` → `reviewing` → `merged` / `preserved` / `cleanup_pending`。

规则：

- 默认一个 Task 一个主 Worktree，并允许子任务创建隔离 Worktree。
- 多个 Session 不能同时无协调写入同一 Worktree。
- 合并前检查基线版本、文件冲突、未提交变更、测试和 Review Gate。
- 删除 Worktree 由宿主控制面执行，必须先检查未同步事件、运行中进程、未提交变更和责任归属。

## 4. QRSPI 交付流程

### 4.1 阶段定义

| 阶段 | 目标 | 必须产物 | 进入条件 | 完成门禁 |
|---|---|---|---|---|
| Questions | 澄清目标、范围、约束和验收 | `questions` | Task 已创建 | 开放问题已回答或明确接受假设 |
| Research | 研究代码、依赖、外部系统和风险 | `research` | Questions 已确认 | 事实有来源，风险有等级 |
| Design | 形成可评审的产品和技术方案 | `design` | Research 已归档 | 方案、边界、异常和取舍完整 |
| Structure | 拆分模块、任务、依赖和责任 | `structure` | Design 已批准 | DAG 无环，所有任务有 Owner |
| Plan | 明确文件、接口、测试和回滚 | `plan` | Structure 已批准 | 文件清单、测试命令和验收标准完整 |
| Implement | 按计划编码、测试、修复和交付 | `source-diff`、`test-report`、`review` | Plan 已批准 | 测试、评审、迁移和回滚门禁通过 |

### 4.2 阶段转换

```text
Questions → Research → Design → Structure → Plan → Implement
    ▲          │          │          │          │          │
    └──────────┴──────────┴──────────┴──────────┴── changes_requested
```

项目经理可以在阶段之间调度不同角色 Agent 并发工作，但不能跳过必需 Artifact 或人工审批。低风险小任务可以合并阶段，必须在 Task 中记录使用的简化规则和理由。

### 4.3 计划与执行绑定

Plan 生成 `planHash`。Task、Session、Worktree、外部同步和审批都绑定该哈希；如果验收标准、文件范围、依赖或权限发生变化，旧计划自动失效，项目经理必须生成新版本。

## 5. Artifact 协作

Artifact 页面必须提供：

- 版本选择和版本差异。
- 上游来源、下游引用和当前评审状态。
- 行级或段落级评论、提及和解决状态。
- 请求修改、批准、退回和锁定版本。
- 发送给项目经理或指定 Agent 的结构化反馈。
- 从 Artifact 创建 Task、Review Request 或 Decision Record。

评论写入 `artifact_comment`，包含 `artifactId`、`artifactVersion`、`authorId`、`anchor`、`body`、`mentions`、`status` 和 `createdAt`。Agent 只能读取有权限的评论；评论被标记为 `agent_action_required` 时，项目经理才能将其转为修改任务。

## 6. 多人和 Agent 实时协作

### 6.1 共享视图

成员可以查看：Task 阶段、Session 状态、Daemon、实时日志、Worktree 变更、Artifact 版本、评审请求、风险和阻塞。原始 Agent 输出仍由项目经理整理后作为交付结论。

### 6.2 实时事件

统一事件类型包括：`task.updated`、`session.started`、`session.progressed`、`artifact.created`、`artifact.commented`、`worktree.changed`、`review.requested`、`approval.required`、`daemon.offline`、`sync.conflict` 和 `handoff.created`。

事件必须带：`eventId`、`projectId`、`taskId`、`sessionId`、`actor`、`sequence`、`occurredAt`、`visibility` 和 `payloadVersion`。客户端使用序列号检测断档，断档时从控制面补拉事件。

### 6.3 责任与接管

- 人类成员可以认领 Task、评审 Artifact、批准阶段和接管 Session。
- 接管必须创建 Handoff，记录原责任人、接收人、上下文快照、风险和下一步。
- 成员离线、Daemon 失联或 Agent 失败时，Task 不自动完成；进入 `blocked` 或 `reconnecting` 并通知项目经理。
- 高风险动作必须由符合职责分离规则的成员审批。

## 7. 关键接口

### 7.1 注册 Daemon

`POST /api/daemons/register`

请求字段：`machineName`、`environmentType`、`capabilities`、`workspaceRoots`、`maxConcurrentSessions`、`daemonVersion`。

响应字段：`daemonId`、`status`、`heartbeatIntervalSec`、`sessionProtocolVersion` 和 `credentialRef`。

异常：`ORGANIZATION_FORBIDDEN`、`DAEMON_VERSION_UNSUPPORTED`、`WORKSPACE_ROOT_INVALID`、`REGISTRATION_REVOKED`。

### 7.2 创建 Task

`POST /api/projects/{projectId}/tasks`

请求：`title`、`goal`、`acceptanceCriteria`、`priority`、`humanOwner`、`requestedCapabilities`、`repositoryIds`。

响应：`taskId`、`status=clarifying`、`stage=questions`、`managerConversationId` 和 `nextActions`。

### 7.3 启动 Session

`POST /api/tasks/{taskId}/sessions`

请求：`agentRole`、`modelRef`、`daemonId`、`workspacePolicy`、`inputArtifactIds`、`allowedSkills`、`allowedTools`、`budget` 和 `planHash`。

响应：`sessionId`、`status=queued`、`workspaceId`、`eventStreamUrl` 和 `checkpointId`。

异常：`TASK_PLAN_REQUIRED`、`PLAN_HASH_STALE`、`DAEMON_UNAVAILABLE`、`WORKSPACE_CONFLICT`、`PERMISSION_DENIED`。

### 7.4 提交 Artifact 评论

`POST /api/artifacts/{artifactId}/versions/{version}/comments`

请求：`anchor`、`body`、`mentions`、`actionRequired`。

响应：`commentId`、`status`、`notifiedSubjects` 和 `nextAction`。

### 7.5 请求交接

`POST /api/tasks/{taskId}/handoffs`

请求：`fromSubject`、`toSubject`、`reason`、`contextSnapshotId`、`openQuestions`、`risks` 和 `nextActions`。

响应：`handoffId`、`status=pending_acceptance`、`newAssignmentId`。

## 8. 数据一致性与恢复

- 控制面采用事件序列和版本号作为事实来源；Daemon 状态是可重建的执行投影。
- Daemon 本地事件使用 Outbox，上传成功后标记 `synced`，失败进入重试或死信。
- Task、Session、Artifact、Worktree 和 Assignment 的状态变化必须通过事务或幂等事件更新。
- Session 重启从最后确认的 Event Sequence 和 Checkpoint 恢复；已完成 Tool 调用命中结果缓存。
- Worktree 清理前必须完成事件同步、产物归档、未提交变更处理和权限检查。

### 8.1 代码同步

代码同步以 Git 为主，Artifact 和事件使用平台同步：

| 数据 | 同步方式 |
|---|---|
| 已提交代码 | Git Clone、Fetch、Push |
| 未提交代码 | Patch 或受控 Snapshot |
| Agent 事件 | 持久事件流 + Daemon Outbox |
| Task、Plan、Artifact | Control Plane API 和版本化对象存储 |

禁止通过 WebSocket 持续传输整个项目目录。Snapshot 默认排除 `.env`、SSH 私钥、云凭证、缓存和构建产物；上传前必须显示文件清单和敏感文件排除结果。

### 8.2 Session Handoff

平台不承诺跨主机进程热迁移，采用 Session Handoff：暂停源 Session，生成交接快照，在目标环境创建新的 Session。

交接模式：

- **任务级交接**：保留 Task，创建新的目标 Session，加载 Artifact、计划和上下文摘要。
- **原生会话恢复**：仅在 Runtime 支持导出/恢复且主机数据、凭证和版本完整时尝试。
- **代码交接**：只同步 Git 提交、Patch 或 Snapshot，目标 Session 重新分析上下文。

交接快照必须包含：源 Session、目标环境、仓库、分支、基线提交、Patch/Snapshot、已完成步骤、未决问题、决策、重要文件、Artifact 引用和风险。

### 8.3 事实来源

```text
PostgreSQL：Task、Session、Run、Artifact 元数据、权限、审批、审计事实
Temporal：长流程、Cron、Workflow、重试和恢复状态
PostgreSQL Outbox：事务内产生的待发布事件
Redis Streams：实时通知、在线协作和短期事件投影
Daemon Outbox：本机/云端断网事件缓存
S3/MinIO：Artifact 内容、Patch、Snapshot 和日志文件
```

Redis Streams 不作为业务事实来源；Daemon 状态是可由事件重建的执行投影。

## 9. 生产验收清单

- [ ] 每台执行机器可以注册、心跳、撤销和恢复 Daemon。
- [ ] 控制面可以在多个 Daemon 间按能力和负载调度 Session。
- [ ] Task、Session、Artifact、Worktree 可独立查询、版本化和审计。
- [ ] 一个 Task 可以拥有多个不同模型、不同角色和不同 Daemon 的 Session。
- [ ] 并行 Session 不能覆盖彼此 Worktree 或 Artifact 版本。
- [ ] QRSPI 阶段门禁、回退和 `planHash` 失效规则可执行。
- [ ] Artifact 支持版本、评论、评审、引用和 Agent 回写。
- [ ] 多人可以查看实时事件、评论设计、请求评审、审批和接管任务。
- [ ] 断网、Daemon 失联、进程崩溃和控制面重启后可以恢复。
- [ ] 高风险动作仍通过 Permission、Hook、审批和审计链路。

