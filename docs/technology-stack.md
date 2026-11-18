# TypeScript 全栈技术栈

> 文档状态：v0.1
>
> 方案：快速开发方案（TypeScript 全栈）
>
> 目标：使用同一语言覆盖控制面、Agent Runtime、Daemon、集成服务和前端，同时保留生产系统需要的事务、权限、持久化、任务恢复和本地执行隔离。

## 1. 技术栈总览

| 层 | 选型 | 选择理由 |
|---|---|---|
| 运行时 | Node.js 22 LTS | 统一服务端运行时，兼容 Agent、MCP 和本地进程能力 |
| 语言 | TypeScript 5.x，严格模式 | 类型安全、共享契约、适合 Agent 工具协议 |
| 控制面 | NestJS + Fastify Adapter | 模块化、依赖注入、鉴权、OpenAPI 和团队协作友好 |
| Agent Runtime | TypeScript 独立包 | 直接实现 Loop、Tool、Skill、Hook、Subagent、Goal 和 MCP |
| Daemon | Node.js + TypeScript 独立进程 | 与 Agent Runtime 共享协议、Tool 和工作区代码；支持本机和云端执行环境 |
| 前端 | Vue 3 + TypeScript + Vite | 适合复杂控制台和多人协作工作台 |
| 前端状态 | Pinia + TanStack Query | 本地 UI 状态与服务端状态分离 |
| UI 组件 | Ant Design Vue | 管理台、表格、审批、任务和权限组件成熟 |
| API 契约 | OpenAPI + Zod | HTTP 契约和运行时校验统一 |
| Daemon 协议 | Protobuf + ConnectRPC | 双向流、版本化、跨进程和断线重连 |
| 主数据库 | PostgreSQL 17 | 事务、JSONB、全文检索和成熟生态 |
| 向量检索 | pgvector | 与业务数据同库，降低初期系统复杂度 |
| SQL 访问 | `pg` + Kysely | SQL 优先、类型安全、便于遵守统一 SQL 脚本规范 |
| 缓存与锁 | Redis 7 | 会话缓存、租约、限流、短期队列和在线状态 |
| 持久工作流 | Temporal TypeScript SDK | Task、Cron、Background、Workflow、重试和恢复 |
| 事件分发 | PostgreSQL Outbox + Redis Streams | 可靠写入、可重放、快速开发；后续可替换 NATS |
| Artifact 存储 | S3；本地使用 MinIO | 大文件、版本和权限隔离 |
| 身份认证 | Keycloak + OIDC/OAuth 2.1 | 组织、成员、角色、SSO 和服务账号 |
| 日志 | Pino | Node.js 高性能结构化日志 |
| 可观测性 | OpenTelemetry + Prometheus + Grafana + Loki + Tempo | Trace、Metric、Log 统一关联 |
| 测试 | Vitest、Playwright、Testcontainers | 单元、浏览器、数据库和集成验证 |
| 包管理 | pnpm Workspaces | 多包仓库、锁文件和依赖复用 |
| 构建编排 | Turborepo | 增量构建、缓存和多包任务编排 |
| 本地环境 | Docker Compose | 一键启动 PostgreSQL、Redis、MinIO、Temporal、Keycloak |
| 生产环境 | Docker + Kubernetes + Helm | 服务扩展、Daemon 部署和环境隔离 |

## 1.1 Agent Runtime Gateway

Agent Runtime Gateway 负责选择完整的 Agent 执行引擎，不把 Codex 或 Claude 简化成普通文本模型调用：

| Runtime | 接入方式 | 执行环境 |
|---|---|---|
| Codex | Codex App Server Adapter | 本机 Session 或云端 Session 容器 |
| Claude | Claude Agent SDK Adapter | 本机 Session 或云端 Session 容器 |
| Gemini | Gemini Native Adapter | 本机 Session 或云端 Session 容器 |
| DeepSeek | Native / OpenAI-Compatible Adapter | 本机 Session 或云端 Session 容器 |
| Qwen | Native / OpenAI-Compatible Adapter | 本机 Session 或云端 Session 容器 |
| 智谱 | Native / OpenAI-Compatible Adapter | 本机 Session 或云端 Session 容器 |
| 中转站 | Relay Adapter，支持兼容协议 | 本机 Session 或云端 Session 容器 |

所有 Adapter 使用统一的 Session Event、Tool、Permission、Artifact 和 Checkpoint 契约。Agent 不直接依赖厂商 SDK。

## 1.2 双执行环境

### 本机 Session Environment

本机 Daemon 运行在用户电脑上，Session 可以使用本机代码仓库、Git、IDE、浏览器和已授权的本地资源。凭证使用操作系统密钥链或本地加密存储，控制面只保存凭证引用。

### 云端 Session Environment

云端 Daemon/Runner 在隔离容器中运行 Session，适合远程协作、长期任务、定时任务和多人共享。容器使用临时文件系统、独立 Worktree、网络白名单和短期凭证，Session 结束后清理。

两种环境共享同一套 `Task → Session → Artifact → Worktree → Event` 协议，差异只由 `environmentType`、凭证注入方式和工作区绑定决定。

## 1.3 认证模式

每个 Runtime Profile 支持三种认证方式：

| 模式 | 说明 | 凭证保存 |
|---|---|---|
| `native-login` | 使用 Codex App Server 或 Claude Agent SDK 的官方登录流程 | 本机密钥链或云端 Secret Broker |
| `api-key` | 使用官方 API Key | Vault/Secret Broker，只保存引用 |
| `relay-api-key` | 使用中转站 Base URL 和 API Key | Vault/Secret Broker，只保存引用 |

原生登录和 API Key 是独立认证路径。中转站不会继承官方登录权限；每个 Provider Profile 都要单独配置 Base URL、模型、能力和权限。

## 2. 仓库结构

```text
/
├── apps/
│   ├── control-plane/       # NestJS 控制面 API
│   ├── agent-runtime/       # Agent Loop 与运行时服务
│   ├── daemon/              # 本地/远程执行 Daemon
│   ├── integration-service/  # 外部需求、Bug、开发任务集成
│   └── web-console/          # Vue 3 控制台
├── packages/
│   ├── contracts/            # OpenAPI、Zod、Protobuf 生成类型
│   ├── domain/               # Task、Session、Artifact、Worktree 领域模型
│   ├── agent-core/           # Loop、Tool、Skill、Hook、Permission
│   ├── workflow/             # Temporal Workflow 与 Activity
│   ├── daemon-protocol/      # Daemon/控制面协议
│   ├── observability/        # Trace、Log、Metric 封装
│   └── ui-kit/               # 前端共享组件和主题
├── database/
│   ├── schema.sql
│   └── init-data.sql
├── infra/
│   ├── docker-compose.yml
│   ├── helm/
│   └── temporal/
├── docs/
└── package.json
```

## 3. 服务边界

### 3.1 Control Plane

负责：组织、成员、权限、Project、Task、Artifact 元数据、Review、Approval、Daemon 注册、Session 调度、审计和对外 API。

不负责：直接运行用户命令、直接持有本地工作区、直接执行模型 Tool。

### 3.2 Agent Runtime

负责：Agent Loop、Context、Memory、Tool Registry、Skill Registry、Hook Runner、Subagent、Goal Gate、MCP Gateway 和项目经理会话。

通过 Control Plane 读取权限和业务状态，通过 Daemon 执行本地命令、代码和 Worktree 操作。

### 3.3 Daemon

负责：本机或云端进程组、Agent Session、Workspace、Worktree、命令、测试、文件变更、心跳、断网 Outbox 和事件同步。

Daemon 只接受带版本的执行计划和权限快照；不能自行推进业务阶段、批准发布或修改组织权限。

云端执行采用 Cloud Worker + Session Container。一个云端 Session 默认一个隔离容器；Temporal 负责容器生命周期编排，容器内 Daemon/Runner 负责 Agent 进程和工作区。进程热迁移不在目标范围内，跨环境使用 Session Handoff。

### 3.4 Integration Service

负责外部需求、Bug、开发任务、测试和版本系统的 Connector、字段映射、状态映射、同步游标、Webhook、幂等和冲突队列。

## 4. 关键实现约束

### 4.1 API 和类型

- HTTP API 由 NestJS Controller 暴露，使用 OpenAPI 生成客户端和文档。
- 输入参数使用 Zod 校验；领域层不直接接收 HTTP DTO。
- Protobuf 只用于 Daemon/控制面协议，不把内部数据库表直接暴露为 RPC。
- 事件使用版本化 Envelope：`eventId`、`eventType`、`payloadVersion`、`sequence`、`traceId`、`occurredAt`。

### 4.2 数据库

- 所有表结构和初始化数据继续遵守 `/database/schema.sql` 与 `/database/init-data.sql`。
- Kysely 只作为类型安全访问层，不替代 SQL 脚本规范。
- PostgreSQL 默认使用 UTF8；迁移必须经过预览、测试和回滚检查。
- Task、Session、Artifact、Worktree、Daemon、Outbox 使用版本号和幂等键。

### 4.3 工作流

- Temporal Workflow 负责长任务、Cron、Background Task、QRSPI 阶段和恢复。
- Agent Loop 仍由模型决定下一步；Temporal 只固化稳定的编排和恢复逻辑。
- Workflow Activity 必须幂等；外部写操作必须使用业务幂等键。
- Workflow 版本升级使用新版本，历史 Run 使用原版本恢复。

第一阶段可以使用 PostgreSQL 状态机和 Outbox 完成单机可恢复闭环；Temporal 接口和 Workflow 版本契约在第一阶段冻结，云端长任务阶段再启用完整 Temporal Worker。

### 4.4 Daemon 安全

- Daemon 注册使用设备身份和短期凭证，支持撤销和轮换。
- 本地执行范围由 `workspaceRoots`、命令白名单、网络策略和 Permission 快照共同限制。
- 生产环境代码执行放入受限容器；本地环境使用进程组、超时和工作区隔离。
- Daemon 不能把 Token、密钥和完整 Prompt 写入日志或 Artifact。
- 本机 Session 使用本地密钥链、设备绑定和用户授权范围；云端 Session 使用短期凭证和容器级注入。
- Codex 和 Claude Session 优先使用原生运行时；中转站 Session 必须明确标记 `relay`，独立计费和审计。

### 4.5 实时协作

- SSE 用于 Task、Session、Artifact 和运行进度事件。
- WebSocket 用于 presence、评论输入状态和低延迟协作事件。
- 客户端依据 `sequence` 检测断档，断档后从 Control Plane 补拉。
- Redis 只保存短期在线状态；项目事实仍以 PostgreSQL 和 Event Store 为准。

## 5. 开发与测试命令

```bash
pnpm install
pnpm dev
pnpm lint
pnpm typecheck
pnpm test
pnpm test:e2e
pnpm build
```

服务端测试使用 Vitest、Testcontainers 和真实 PostgreSQL；前端关键流程使用 Playwright；Daemon 使用临时工作区、真实进程组和可控测试命令验证恢复、取消和超时。

## 6. 分阶段落地

完整阶段计划见 [`docs/implementation-roadmap.md`](implementation-roadmap.md)。

### Phase 1 Headless MVP

- NestJS Control Plane
- Node.js Agent Runtime
- Node.js Daemon
- 本机 Session Environment
- Codex App Server Adapter、Qwen 通用 Agent Runtime Adapter
- 本机认证引用和 Qwen API Key Profile
- PostgreSQL、Redis、MinIO
- REST、CLI 和 SSE 实时事件
- 基础权限和审计

第一阶段实施范围见 [`docs/implementation-roadmap.md`](implementation-roadmap.md)：第一阶段不交付 Web UI，只保留 Vue 3 技术栈和 API 契约，为后续控制台接入做准备。

### 云端执行阶段

- 多 Daemon 调度和负载策略
- Cloud Worker、Session Container 和 Temporal Worker
- Git/Patch/Snapshot 同步和 Session Handoff

### UI 与协作阶段

- Vue 3 控制台、Task/Session/Artifact/Worktree 工作台
- WebSocket 多人实时协作
- Redis Streams 事件重放
- Artifact 评论、评审、审批和接管

### 模型与生产治理阶段

- Claude、Gemini、DeepSeek、智谱等模型 Adapter
- 外部系统 Connector Marketplace
- Kubernetes、Helm 和生产 Keycloak 集群

### 规模化阶段

- 多区域 Daemon
- 更强的远程执行 Sandbox
- NATS JetStream 替换高吞吐事件分发
- 多模型路由和成本优化

