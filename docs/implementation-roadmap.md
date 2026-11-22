# 分阶段实施计划

> 文档状态：v0.2
>
> 目标：先用无 UI 的 Headless 方式验证 Agent Runtime 核心闭环，再逐步增加云端执行、多人协作、模型 Provider 和外部管理系统。

## 1. 阶段总览

```text
Phase 1  协议冻结 + Headless 本机 MVP：Codex + Qwen
    ↓
Phase 2  云端 Session、容器和 Session Handoff
    ↓
Phase 3  Web UI、多人协作和 Artifact 审阅
    ↓
Phase 4  模型扩展、外部系统和生产治理
    ↓
Phase 5  高级自动化：Teams、Cron、Workflow Marketplace、规模化部署
```

## 2. Phase 1：协议冻结 + Headless 本机 MVP

这是第一个可运行阶段。通过 REST API、CLI 和 SSE 事件流交互，不交付 Web UI；只接入 Codex 和 Qwen。

当前仓库已提供原生 Codex App Server、Qwen 官方 API 适配、受认证的持久化 Run 派发、常驻 Daemon/Worker、本地 Outbox、检查点与工具日志、SSE 重连、QRSPI 审批和本机 Skill 加载。无 Key 联调已覆盖跨进程真实文件与审计归档，真实 Codex/Qwen 推理仍待凭证后验收。完成边界见 [`docs/phase-1-review.md`](phase-1-review.md)，操作见 [`docs/phase-1-acceptance.md`](phase-1-acceptance.md)。

### 2.1 协议与边界冻结

- `Task → Session → Run → Artifact` 关系。
- `WorkItem` 作为 Task 下可选调度拆分的定义。
- Product Lifecycle 与 QRSPI 两层状态机。
- Agent Runtime Gateway 三类 Runtime 分类。
- Local/Cloud Session Environment 定义。
- Native Login、API Key、Relay API Key 三种认证模式。
- Session Event Envelope、错误码、幂等键和版本字段。
- PostgreSQL、Temporal、Outbox、Redis Streams、Daemon Outbox 的事实来源边界。
- Git + Patch/Snapshot 代码同步协议。
- Session Handoff 协议。
- Daemon 注册、心跳、撤销和能力声明协议。

交付物：OpenAPI、Protobuf/ConnectRPC、Zod Schema、领域类型、Permission 规范、Session Event 规范、错误码目录和验收测试计划。

### 2.2 Headless MVP 范围

#### 控制面

- NestJS + Fastify Control Plane。
- Project、Task、Artifact 元数据。
- Session、Run 创建、暂停、取消、重试和查询。
- PostgreSQL 业务事实存储。
- PostgreSQL Outbox 和 SSE 事件流。
- 基础 Permission、Approval、Audit。

#### Agent Runtime

- Agent Runtime Gateway。
- Codex App Server Adapter。
- Qwen 通用 Agent Runtime Adapter。
- Tool Registry、文件工具、代码搜索、命令执行和测试工具。
- Session、Plan、PreToolUse、PostToolUse、Stop Hook。
- Context Snapshot、Checkpoint 和 Run 恢复。
- Skill Catalog 和本地项目 Skill 加载。
- Goal Gate 基础版本。

#### 本机 Daemon

- 本机 Daemon 注册和心跳。
- Daemon 子进程管理 Agent Session。
- 本机 Workspace 和 Git Worktree。
- 进程组、超时、取消和日志采集。
- 本机凭证引用和权限范围。

#### 交付流程

- Questions、Research、Design、Structure、Plan、Implement 六个阶段。
- Markdown/JSON Artifact。
- Git 提交、Diff、Patch 和 Snapshot 元数据。
- Headless 项目经理 CLI/API。

### 2.3 Phase 1 明确不做

- Web UI、桌面 UI、移动端 UI。
- 云端 Session 容器和远程 Daemon 的实际执行。
- Session 跨环境 Handoff 的实际迁移，只冻结协议并验证快照格式。
- Claude、Gemini、DeepSeek、智谱和其他 Provider。
- 多人实时协作、Presence、WebSocket 和团队 Inbox。
- 外部需求、Bug、开发任务管理系统集成。
- Agent Marketplace、Plugin Marketplace 和公开 Skill 市场。
- 多区域部署、Kubernetes 生产集群和复杂弹性调度。
- 自动生产发布和复杂计费。
- 多仓库复杂联动；Phase 1 默认一个 Task 一个主仓库。

### 2.4 Phase 1 暂不作为验收门槛的机制

- Agent Teams：使用单项目经理和有限并发 Session 验证。
- Cron：支持手动启动和 API 调度。
- Background Tasks：支持可取消的本机后台 Job，不做跨重启复杂调度。
- Temporal 完整 Worker：冻结接口，使用 PostgreSQL 状态机验证本机闭环。
- Memory 自动整理：使用显式 Project Context 和有限 Session Memory。
- 多模型交叉评审：只保留接口，不做自动仲裁。

### 2.5 Phase 1 验收标准

- 用户可以通过 CLI/API 创建 Task。
- Task 可以创建 Session，Session 可以创建多个 Run。
- Run 失败后可以创建新 Run，旧 Run 的错误和证据保留。
- Codex 可以在本机 Daemon 中运行并产生 Session Event。
- Qwen 可以通过通用 Agent Runtime 运行同一套 Tool 和 Hook。
- Task 可以生成 Questions、Research、Design、Structure、Plan、Implement Artifact。
- 代码在独立 Worktree 中修改，支持 Git Diff 和 Patch。
- Tool 调用经过 Permission、Hook、审计和错误处理。
- Daemon 断开后状态显示为 `disconnected` 或 `reconnecting`，不能直接标记 `failed`。
- 控制面重启后可以根据 PostgreSQL 和 Outbox 恢复 Task、Session 和 Run 状态。

## 3. Phase 2：云端 Session 与 Handoff

### 目标

把 Phase 1 Headless MVP 扩展为本机和云端双执行环境。

### 包含

- Cloud Worker 和 Session Container。
- 一个云端 Session 一个隔离容器。
- Container Workspace 和云端 Worktree。
- Secret Broker 和云端短期凭证。
- Temporal Worker、Cron、长任务恢复和后台任务。
- Git Clone、Fetch、Push、Patch、Snapshot 同步。
- Session Handoff：本机暂停，云端创建新 Session。
- `disconnected`、`reconnecting`、`waiting_input` 状态。
- 云端 Session 的 SSE 事件和日志回传。

### 暂不包含

- Web UI 完整协作体验。
- 复杂多租户计费。
- 原生 Claude、Gemini 等更多 Runtime。

## 4. Phase 3：Web UI 与多人协作

### 包含

- Vue 3 控制台。
- Project Manager 对话界面。
- Task、Session、Run、Artifact、Worktree 工作台。
- Artifact 版本、评论、评审和 Agent 回写。
- Team、Assignment、Review Request、Handoff 和 Inbox。
- WebSocket Presence 和实时协作事件。
- 本机/云端 Session 选择和 Handoff 操作。
- Daemon 管理、凭证配置和运行监控。

### 交付目标

真实成员可以查看运行、评审 Artifact、批准阶段、接管 Session，并通过项目经理获得统一交付摘要。

## 5. Phase 4：模型和外部系统扩展

### 模型扩展

- Claude Agent SDK Adapter。
- Gemini Adapter。
- DeepSeek Adapter。
- 智谱 Adapter。
- 其他 Qwen 模型配置和中转站 Profile。
- ProviderProfile、AuthProfile、RuntimeBinding、CredentialLease、ModelHealth、UsageRecord。
- 模型路由、成本、健康检查、降级和交叉评审。

### 外部系统扩展

- 需求管理连接器。
- Bug 管理连接器。
- 开发任务连接器。
- 测试管理和版本管理连接器。
- 字段、状态、成员、关系映射。
- Webhook、增量同步、冲突队列和幂等回写。

## 6. Phase 5：高级自动化和规模化

- Agent Teams 和长期协作成员。
- 完整 Cron Scheduler。
- Dynamic Workflow Runtime 和 Journal/Resume。
- Skill/Plugin Marketplace。
- 多区域 Daemon 和云端调度。
- Kubernetes 弹性扩缩容。
- 更强的 Sandbox、网络策略和数据区域治理。
- 评估集、模型质量对比、成本优化和自动回归。
- 企业 SSO、SCIM、审计导出和组织级策略治理。

## 7. 第一阶段技术取舍

Phase 1 不做 UI 和云端运行时，但冻结后续扩展点：

- `ExecutionEnvironment`：`local` / `cloud`。
- `RuntimeAdapter`：Codex、Qwen 以及后续 Provider。
- `SessionHandoff`：本机到云端的交接协议。
- `ArtifactStore`：本地文件、S3/MinIO 的统一接口。
- `EventSink`：PostgreSQL Outbox、Redis Streams、云端事件流。
- `WorkflowEngine`：Phase 1 使用 PostgreSQL 状态机，Phase 2 接入 Temporal Worker。

这样 Phase 1 可以快速验证核心闭环，同时不会把本机执行、云端执行、模型适配和 UI 绑定在一起。
