# Agent Runtime 实现设计

> 文档状态：v0.1
>
> 目的：把 Claude Code 风格的 Tool、Skill、Hook、Permission 和 Subagent 编排落成可实现的运行时契约。运行时采用 Node.js 22 LTS + TypeScript；接口和数据结构仍保持清晰、可版本化。

## 1. 设计目标

Agent Runtime 是项目经理 Agent 的执行内核。它必须做到：

1. 项目经理可以把一个目标拆成多个内部 Agent 任务并发执行。
2. Agent 只能通过注册过的 Tool 访问文件、代码、数据库、浏览器或外部系统。
3. Skill 是可安装、可组合、可版本锁定的能力包，可以全局启用，也可以按项目动态安装。
4. Hook 可以在会话、任务、Agent、Skill、Tool 和交付阶段拦截执行。
5. Permission 在每次实际动作前重新计算，不能只在会话开始时判断一次。
6. 运行过程可暂停、取消、重试、恢复和审计。

## 2. 核心层全景

Claude Code 官方文档将核心能力描述为“模型负责推理，Tool 负责行动，Harness 负责上下文和运行控制”，并在其上叠加 Skills、Subagents、动态 Workflows、MCP、Hooks、Plugins、Permissions、Sessions、Memory 和 Artifacts。本项目在此基础上增加执行守护、外部管理系统集成和多人团队协作，采用以下 18 个核心层，避免把职责不同的机制混成一个“Agent 层”。

| 层 | 主要职责 | 本项目对应对象 |
|---|---|---|
| 1. 用户入口层 | 接收目标、反馈、决策和交付请求 | Project Manager Conversation |
| 2. Agentic Loop 层 | Gather Context → Act → Verify，决定下一步 | Manager Loop、Worker Loop |
| 3. 模型与路由层 | 模型选择、成本、降级、结构化输出 | Model Provider、Model Policy |
| 4. 上下文组装层 | 系统规则、项目规则、任务、工具说明、历史压缩 | Context Assembler、Compactor |
| 5. 记忆层 | 用户偏好、项目规则、Agent 学习和检索 | User Memory、Project Memory、Agent Memory |
| 6. 会话与检查点层 | JSONL 事件、恢复、分叉、回滚和跨设备继续 | Session、Checkpoint、Fork |
| 7. Tool 层 | 文件、搜索、命令、代码、Web、外部动作 | Tool Manifest、Executor |
| 8. Skill 层 | 可复用知识、流程、模板和任务能力 | Skill Package、Activation、Lock |
| 9. Subagent / Team 层 | 隔离上下文、角色协作、并发和消息 | Subagent、Agent Team、Assignment |
| 10. Workflow 层 | 可重复的动态扇出、汇总、重试和长任务 | Workflow Definition、Run Graph |
| 11. Hook / Event 层 | 在生命周期事件上执行脚本、HTTP、MCP、Prompt 或 Agent | Hook、Event Bus |
| 12. 外部连接层 | 通过 MCP、Webhook、Channel 连接外部系统 | MCP Server、Connector、Channel |
| 13. 配置与策略层 | 全局、组织、项目、运行配置及优先级 | Settings、Policy、Rule |
| 14. 权限与安全执行层 | Allow/Ask/Deny、审批、沙箱、工作区隔离 | Permission Engine、Sandbox |
| 15. 工件、观测与交付层 | 工件、日志、指标、评估、发布和分享 | Artifact、Trace、Eval、Release |
| 16. 外部管理系统集成层 | Bug、需求、开发任务的领域映射、双向同步和冲突处理 | Integration、Mapping、Sync Job |
| 17. 多人团队协作层 | 人类成员、Agent、责任、评审、接力、通知和共同决策 | Team、Assignment、Comment、Handoff |
| 18. 执行守护层 | 本地/远程 Agent 进程、Session、工作区和事件同步 | Daemon、Executor、Heartbeat、Outbox |

### 2.1 核心层依赖关系

```text
┌────────────────────────────────────────────────────────────────────┐
│ 用户入口：Project Manager Conversation                            │
└──────────────────────────────┬─────────────────────────────────────┘
                               ▼
┌────────────────────────────────────────────────────────────────────┐
│ Agentic Loop：理解 → 计划 → 执行 → 观察 → 验证 → 汇总             │
└───────┬──────────────┬──────────────┬──────────────┬───────────────┘
        ▼              ▼              ▼              ▼
   Model Router   Context/Memory   Session       Workflow Graph
        │              │              │              │
        └──────────────┴──────┬───────┴──────────────┘
                              ▼
                    Skill / Subagent / Team
                              │
             ┌────────────────┼────────────────┐
             ▼                ▼                ▼
           Tool             Hook             MCP
             │                │                │
             └────────────────┴────────────────┘
                              ▼
                  Permission + Sandbox + Policy
                              ▼
                  Workspace / External Systems
                              ▼
                Artifact + Event + Trace + Release
                              │
                              ▼
             External Management Integration Layer
             Bug / Requirement / Dev Task / Status Sync
                              │
                              ▼
                 Human Team Collaboration Layer
                 Members / Ownership / Review / Handoff
                              │
                              ▼
                   Daemon Execution Layer
             Local / Remote Process + Workspace Sync
```

### 2.2 官方概念到本项目的映射

| 官方概念 | 本项目实现方式 | 边界 |
|---|---|---|
| Agentic harness | Runtime Orchestrator + Context/Session/Policy | 包裹模型，不等于单个 Agent |
| CLAUDE.md / AGENTS.md | Project Instructions + Rules | 持久规则，不承担长流程执行 |
| Output styles | Manager Response Profile | 只控制表达方式，不授予权限 |
| Skills | Skill Package | 知识和流程，可自动选择或显式调用 |
| Subagents | Isolated Worker Agent | 独立上下文，返回摘要和工件 |
| Agent teams | Team Coordinator | 多个并行会话和显式消息 |
| Dynamic workflows | Workflow Script / Run Graph | 将大任务编译为可重跑的扇出图 |
| Hooks | Hook Runner | 生命周期自动化和决策拦截 |
| MCP | MCP Gateway | 外部工具和资源连接，不等于 Skill |
| Permissions | Permission Engine + Sandbox | 由运行时执行，模型只能提出请求 |
| Sessions | Session Store + Checkpoint | 可恢复、分叉、跨界面继续 |
| Plugins / Marketplaces | Extension Registry | 打包分发 Skill、Hook、Subagent、MCP |
| Artifacts | Artifact Store | 将运行结果变成可审阅、可分享、可发布产物 |

外部管理系统集成不是 MCP 的别名：MCP 负责连接协议和能力暴露，集成层负责业务对象语义、字段映射、同步策略、幂等和冲突处理。

多人团队协作也不是 Agent Team 的别名：Agent Team 负责内部 Agent 的隔离执行，人类团队协作层负责真实成员的身份、职责、评论、认领、审批、通知、交接和共同决策。

## 3. Daemon 执行层

Agent Runtime 不直接把 Agent 进程嵌入 Web API。控制面通过执行计划调度本地或远程 Daemon，Daemon 在授权工作区启动 Agent Session、执行命令、采集事件并同步结果。

Daemon 负责进程组、Session、Worktree、工作区根目录、网络策略、心跳、断网 Outbox、孤儿进程清理和版本兼容检查。控制面负责 Task、权限、审批、阶段、Artifact 和最终业务状态。Daemon 失联时，Session 进入 `reconnecting`，不能被推断为完成。

```text
Control Plane
  ├── Task / Plan / Permission / Review
  └── Session Dispatch
          │
          ▼
Daemon
  ├── Agent Process
  ├── Tool Executor
  ├── Worktree Manager
  ├── Event Collector
  └── Offline Outbox
          │
          ▼
Event Store + Artifact Store
```

完整的 Daemon 注册、Task/Session/Artifact/Worktree 分离、QRSPI 流程和多人实时协作规范见 [`docs/execution-and-collaboration-design.md`](execution-and-collaboration-design.md)。

### 3.1 Agent Runtime Gateway

平台使用统一的 Agent Runtime Gateway 选择原生执行引擎：

```text
Agent Runtime Gateway
├── Codex App Server Adapter
├── Claude Agent SDK Adapter
├── Gemini Native Adapter
├── DeepSeek Adapter
├── Qwen Adapter
├── Zhipu Adapter
└── Relay Adapter
```

Codex 通过 Codex App Server 运行，Claude 通过 Claude Agent SDK 运行；两者不能被简化为只有 `complete()` 的文本模型接口。Adapter 负责创建 Session、注入上下文、接收原生事件、连接 Tool/Hook/Permission、提交 Artifact 和执行恢复。

统一接口：

```text
createSession(config) -> NativeSession
streamEvents(session) -> RuntimeEvent[]
sendInput(session, input) -> accepted
pause(session) -> checkpoint
resume(session, checkpoint) -> accepted
cancel(session) -> cancelled
close(session) -> closed
```

### 3.2 双执行环境

Session 的 `environmentType` 只能是 `local` 或 `cloud`：

| 环境 | 执行位置 | 典型用途 | 凭证处理 |
|---|---|---|---|
| `local` | 用户电脑上的 Daemon、本地进程组或本地容器 | 本地仓库、IDE、浏览器、个人开发 | 操作系统密钥链或本地加密存储 |
| `cloud` | 云端 Daemon/Runner 的隔离容器 | 远程协作、长期运行、Cron、共享任务 | Secret Broker 注入短期凭证 |

两种环境使用同一套 Task、Session、Artifact、Worktree、Permission 和 Event 协议。控制面根据 Daemon 能力、工作区位置、数据区域、成本和组织策略选择环境；Session 失联时进入 `reconnecting`，不能视为完成。

### 3.3 认证模式

每个 Runtime Profile 支持：

- `native-login`：调用 Codex App Server 或 Claude Agent SDK 的官方登录流程。
- `api-key`：使用官方 API Key。
- `relay-api-key`：使用中转站 Base URL、模型和 API Key。

凭证只保存引用，不写入 Task、Prompt、Event、Artifact 或普通业务表。云端 Session 只获得短期凭证；本机 Session 使用设备绑定和本地安全存储。官方登录和中转站是独立认证路径，不能互相继承权限。

### 3.4 Runtime Event Normalizer

原生 Runtime 事件必须转换为平台统一事件：`session.started`、`session.authenticated`、`model.started`、`model.streamed`、`tool.requested`、`permission.required`、`tool.completed`、`artifact.created`、`checkpoint.created`、`session.paused`、`session.resumed`、`session.completed` 和 `session.failed`。

无法由原生 SDK 拦截的动作，必须通过 Daemon Sandbox、工作区白名单、网络策略、进程组和宿主审计补齐安全边界。

## 4. Agentic Loop 与模型路由

### 4.1 Agentic Loop

每个 Agent 都遵循同一个循环，但项目经理和内部 Agent 的输出目标不同：

```text
Gather Context
      ▼
Plan / Select Skills
      ▼
Request Tool or Spawn Worker
      ▼
Observe Result / Event
      ▼
Verify Against Acceptance Criteria
      ├── 未通过：修正计划并继续循环
      ├── 需要用户决策：交给 Project Manager
      └── 通过：提交 Artifact 和摘要
```

模型只能提出 Tool、Skill、Subagent 和 Workflow 请求；所有副作用由 Runtime 根据 Permission 和 Hook 决定是否执行。

### 4.2 Model Gateway

Model Gateway 负责：模型目录、能力标签、上下文窗口、结构化输出、成本、延迟、失败重试和降级策略。项目经理可以使用高推理模型做计划，开发和测试 Agent 可以使用更低成本模型执行重复任务。

模型路由输入：任务类型、复杂度、上下文长度、预算、延迟目标、数据区域和组织策略。路由输出必须记录模型、版本、参数、Token、成本和失败原因。

## 5. 上下文、记忆与会话

### 5.1 Context Assembler

上下文按以下顺序构造，越靠前优先级越高：

1. 平台安全规则和系统协议。
2. 组织与项目策略。
3. 项目指令、路径规则和领域词汇。
4. 当前项目经理会话与用户目标。
5. 工作项、已批准工件和验收标准。
6. 已激活 Skill 的说明和 Tool Schema。
7. 相关代码、历史事件和记忆检索结果。

Context Assembler 必须标记每段上下文的来源、版本、大小和可信度；超过预算时先压缩运行日志，再裁剪低优先级检索内容。

### 5.2 Memory

记忆分为：

- 用户记忆：表达偏好、沟通方式和长期约束。
- 项目记忆：目录、架构、命令、术语、已确认决策和常见失败。
- Agent 记忆：某一角色的工作经验和可复用检查项。
- Run 临时记忆：本次执行的中间结论，Run 结束后归档或丢弃。

记忆写入必须经过 `memory.write.before` Hook，标记来源、时间、置信度和过期策略，禁止把密钥、个人敏感数据和未验证推测写入长期记忆。

### 5.3 Session 与 Checkpoint

Session 以追加事件保存：用户消息、模型响应、Tool 调用、Hook 决策、权限审批、Subagent 结果、工件引用和成本。每个不可逆动作前创建 Checkpoint；支持 Resume、Fork、Rollback 和跨界面继续。

## 6. Tool、Skill、Subagent 与 Workflow 的边界

| 机制 | 是否有独立上下文 | 主要作用 | 典型输出 |
|---|---:|---|---|
| Tool | 否 | 执行一次原子能力 | Tool Result |
| Skill | 可选 | 提供知识、模板和流程 | Instructions / Artifact |
| Subagent | 是 | 隔离上下文完成专业任务 | Summary / Artifact |
| Agent Team | 是，多成员 | 多 Agent 长时间协作和消息传递 | Team Result |
| Dynamic Workflow | 由运行图决定 | 扇出、交叉验证、批量迁移 | Aggregated Result |
| Hook | 否 | 生命周期自动化和决策拦截 | Allow / Deny / Ask / Context |

项目经理先选择 Skill 和 Workflow，再派发 Subagent；Subagent 只能使用分派结果中声明的 Skill、Tool、工作区和预算。

## 7. Team、动态 Workflow 与跨会话消息

### 7.1 Agent Team

Agent Team 是一组并行 Subagent 加一个协调器。每个成员拥有独立上下文和权限快照，消息通过 Team Bus 传递；成员不能直接修改另一个成员的工作区。

### 7.2 Dynamic Workflow

当任务需要大量并行工作、重复执行或交叉验证时，项目经理生成版本化 Workflow：节点类型包括 `plan`、`fan-out`、`agent`、`tool`、`join`、`verify`、`retry`、`approval` 和 `publish`。

```text
Workflow v1
  ├── fan-out: 每个模块
  │     ├── Backend Developer
  │     ├── Frontend Developer
  │     └── Unit Tester
  ├── join: 合并工件和差异
  ├── verify: Integration Tester + Security Tester
  ├── approval: Project Manager → User
  └── publish: Release Manager
```

Workflow 必须可暂停、可恢复、可重跑，并为每个节点保存输入快照、输出工件和重试次数。

### 7.3 Cross-session Messaging

跨会话消息用于把一个项目经理会话、后台 Workflow 和外部事件连接起来。消息必须带 `conversationId`、`runId`、`sender`、`recipient`、`replyTo`、`priority`、`expiresAt` 和工件引用，禁止通过非结构化文本隐式传递权限。

## 8. 外部连接与 MCP

MCP Gateway 将外部服务暴露为 Tool、Resource、Prompt 或事件 Channel。服务器有独立的连接配置、认证、健康状态、能力发现、工具搜索和断线重连策略。

MCP 安全规则：

- 外部服务器必须经过信任、来源和权限审查。
- 每个服务器、工具和资源都参与 Permission Engine 决策。
- 远程内容视为不可信输入，不能覆盖项目规则或授予权限。
- MCP 工具调用同样经过 `tool.before`、审批、输出扫描和 `tool.after`。

## 9. 外部管理系统集成层

### 9.1 设计目标

集成层让项目经理可以把内部 Idea、Spec、Work Item、Bug、Test Report 和 Release Package 与外部管理系统中的需求、缺陷、开发任务、迭代和版本关联起来。它必须支持“读外部状态、创建外部对象、更新外部对象、接收外部变更、生成内部工件”五类动作。

典型对接对象包括：需求管理、Bug 管理、开发任务管理、测试管理、版本/迭代管理和评论/附件。具体厂商通过 Connector Adapter 接入，不能把厂商字段直接散落在核心业务代码中。

### 9.2 规范化领域模型

平台内部使用规范化模型，外部系统通过映射适配：

```text
Internal Idea / Spec ───────▶ External Requirement
Internal Bug ───────────────▶ External Bug / Issue
Internal WorkItem ──────────▶ External Development Task
Internal TestReport ────────▶ External Test Case / Test Result
Internal ReleasePackage ────▶ External Version / Release

External Webhook / Polling ─▶ Integration Event ─▶ Project Manager
                                                   │
                                                   ▼
                                           Internal Artifact / State
```

规范化对象最小字段：`canonicalId`、`externalSystemId`、`externalObjectId`、`objectType`、`title`、`description`、`status`、`priority`、`assignee`、`labels`、`parent`、`links`、`attachments`、`updatedAt`、`sourceVersion`。

### 9.3 Connector Adapter

每个 Connector 必须实现：

```text
connect(credentialsRef, config) -> ConnectionStatus
discoverCapabilities() -> CapabilitySet
get(objectType, externalId) -> ExternalObject
search(query) -> ExternalObject[]
create(objectType, payload, idempotencyKey) -> ExternalObject
update(objectType, externalId, patch, expectedVersion) -> ExternalObject
transition(objectType, externalId, targetState, expectedVersion) -> ExternalObject
subscribe(webhookConfig) -> Subscription
normalize(externalObject) -> CanonicalObject
```

Connector 不得直接修改内部项目状态；它只产生规范化事件，由 Integration Service 经过映射和策略校验后处理。

### 9.4 项目绑定与映射

项目管理员为每个外部系统建立 Project Binding：外部项目/空间、默认负责人、迭代、标签前缀、字段映射、状态映射、同步方向和冲突策略。

映射类型：

- 字段映射：标题、描述、优先级、负责人、标签、截止时间。
- 状态映射：`draft`、`ready`、`in_progress`、`blocked`、`done`、`cancelled`。
- 关系映射：父子任务、关联 Bug、阻塞、重复、来源工件。
- 身份映射：平台成员与外部系统用户的稳定映射。
- 附件映射：截图、日志、测试报告和发布证据的引用与权限。

### 9.5 同步策略

支持三种模式：

1. **只读同步**：只把外部对象和状态读入平台，适合初次接入。
2. **平台主导**：平台创建和更新外部对象，外部变更通过 Webhook 回流。
3. **双向协同**：平台和外部系统都可修改，但必须使用版本号、字段级冲突检测和人工解决队列。

同步任务必须支持增量游标、分页、速率限制、重试、死信队列、幂等键和断点恢复。Webhook 处理必须校验签名、去重事件 ID 和校验对象版本。

### 9.6 冲突处理

冲突类型：字段同时修改、状态逆向推进、对象已删除、负责人不存在、权限不足、外部版本落后和映射缺失。

默认策略：

- 描述、标签等低风险字段：按字段时间戳合并并记录来源。
- 状态、负责人、优先级和版本字段：进入冲突队列，由项目经理向用户展示差异和建议。
- 删除、关闭、发布等不可逆动作：禁止自动覆盖，必须审批。

项目经理只向用户展示冲突摘要；完整原始 payload 留在受保护的 Integration Event 中。

### 9.7 外部系统安全

- 凭证只保存引用，不进入 Prompt、日志、Skill 或 Artifact。
- 每个 Connector 配置独立的作用域、网络策略和权限白名单。
- 外部内容视为不可信输入，不能覆盖项目规则或触发未授权 Tool。
- 创建、更新、关闭、删除、发布和评论发送都经过 Permission Engine 和相应 Hook。
- 外部系统不可用时，平台保留本地待同步变更，并由项目经理展示同步状态。

## 10. 多人团队协作层

### 10.1 协作原则

1. **一个项目，多种身份**：同一个人可以在不同项目担任不同角色；角色权限和工作分配分开建模。
2. **人和 Agent 都有责任边界**：每个工作项、决策、评审和审批都必须有责任人，且区分 `humanOwner` 与 `agentOwner`。
3. **项目经理统一编排**：人类成员可以直接互相评论和协作；涉及 Agent 的任务、风险和交付仍通过项目经理汇总。
4. **异步优先，实时可选**：评论、提及、通知和状态变化必须可异步处理；实时协作只作为加速手段。
5. **可接力、可追责、可回放**：交接时保存上下文、已完成内容、未决问题、下一步和责任变更记录。

### 10.2 人类成员角色

| 角色 | 责任 | 典型动作 |
|---|---|---|
| Product Owner | 目标、范围、优先级和产品决策 | 审批 Spec、确认取舍、验收结果 |
| Project Lead | 计划、依赖、风险和协调 | 分派工作、推进里程碑、处理阻塞 |
| Tech Lead | 技术方案、代码边界和质量 | 审核架构、合并代码、批准技术例外 |
| Designer | 用户流程、视觉和可访问性 | 评审原型、维护设计工件 |
| Developer | 代码、接口、迁移和实现证据 | 认领任务、提交变更、请求评审 |
| Tester / QA | 测试策略、缺陷和验收证据 | 执行测试、提交缺陷、签署质量门禁 |
| Release Owner | 发布窗口、回滚和运行责任 | 批准发布、跟踪上线、执行回滚 |
| Observer | 只读观察和报告 | 查看进度、订阅通知、导出报告 |

### 10.3 协作对象

平台需要把以下协作对象作为一等实体：

- **Team**：项目团队、子团队和跨项目团队。
- **Human Assignment**：将工作项、评审、审批或决策分派给真实成员。
- **Agent Assignment**：由项目经理分派给内部 Agent；与 Human Assignment 可并存。
- **Comment Thread**：挂在 Idea、Spec、原型节点、代码差异、Bug、任务或发布包上的讨论串。
- **Mention**：`@成员`、`@团队`、`@项目经理` 和 `@角色` 的可追踪提及。
- **Review Request**：请求特定成员或角色在指定门禁前评审。
- **Handoff**：把责任从一个人或 Agent 转交给另一个责任主体。
- **Decision Record**：记录选项、依据、决策人、参与者和影响范围。
- **Notification Subscription**：按项目、工作项、事件类型和严重级别订阅通知。

### 10.4 人与 Agent 的协作边界

```text
┌───────────────────┐       目标 / 决策 / 反馈       ┌───────────────────┐
│ 人类团队成员      │ ◀────────────────────────────▶ │ 项目经理 Agent    │
└─────────┬─────────┘                               └─────────┬─────────┘
          │ 评论、认领、评审、审批、交接                           │ 计划、调度、汇总
          ▼                                                       ▼
┌───────────────────┐                               ┌───────────────────┐
│ Team Collaboration│                               │ Agent Runtime     │
│ Board / Inbox     │                               │ Subagent / Tool   │
└─────────┬─────────┘                               └─────────┬─────────┘
          └──────────────────────┬───────────────────────────┘
                                 ▼
                    Shared Work Items / Artifacts / Decisions
```

人类成员可以直接协作，不必通过项目经理转发普通评论；但以下动作必须进入项目经理和运行时门禁：改变阶段、修改验收标准、覆盖 Agent 产物、执行高风险 Tool、解决跨系统冲突、批准发布和改变权限。

### 10.5 并发编辑与工作区协作

- 文档、Spec、原型和配置采用版本号或操作序列实现乐观并发控制。
- 代码默认使用 Worktree、分支或等价隔离工作区；禁止多个 Agent 或成员无协调地写同一工作区。
- 同一工件出现冲突时，系统展示字段级/行级差异、来源、时间和责任人。
- 合并前必须运行 `merge.before` Hook，并通过冲突检查、自动测试和必要的人工 Review Request。
- 长时间编辑需要 presence、编辑锁提示和超时释放；锁不能替代版本校验。

### 10.6 交接与审批接力

交接包至少包含：当前目标、完成项、未完成项、阻塞、关键链接、最近事件、待决策问题、风险、下一步和新责任人。

审批支持串行、并行和条件接力：例如 Product Owner 批准范围后，Tech Lead 批准方案，QA 批准测试，Release Owner 批准发布。任何审批人拒绝时，项目经理生成变更任务并保留原审批记录。

### 10.7 通知与工作台

通知事件包括：被提及、任务分派、评审请求、审批请求、阻塞、外部同步冲突、Agent 失败、发布窗口和 SLA 临近。成员可以设置实时通知、摘要通知、免打扰和按严重级别过滤。

项目经理为每个成员生成个性化 Inbox，但不改变项目事实；Inbox 只显示该成员有权查看且尚未处理的工作。

## 11. 配置、插件与分发

配置采用多层来源：平台托管、组织、用户、项目共享、项目本地、Run 临时参数。高优先级安全策略不能被低优先级配置覆盖；列表型配置按规则合并并记录来源。

Plugin 是分发层，允许把 Skill、Hook、Subagent、MCP Server、Workflow 和默认权限一起打包。Marketplace 负责索引、版本、签名、来源、兼容性、许可证和撤销状态；安装仍必须经过 Skill/Hook/Permission 门禁。

## 12. 工作区、执行环境与代码智能

Runtime 需要抽象执行环境：本地工作区、隔离容器、云环境、远程控制和 CI Runner。每个 Agent Assignment 绑定一个 Workspace Scope；并发开发默认使用独立 Worktree 或等价隔离目录。

Code Intelligence 作为可选适配器连接语言服务器，提供符号导航、引用查找、类型错误和增量诊断。它属于 Tool/Adapter 能力，不应硬编码进模型或 Skill。

## 13. 工件、事件、观测与评估

除 Artifact 外，Runtime 还要保存：

- Event：每次状态变化、消息、Hook、Tool、审批和重试。
- Trace：跨项目经理、Workflow、Subagent、Tool 的因果链。
- Metric：耗时、Token、成本、成功率、重试、人工接管和门禁失败。
- Eval：对 Skill、模型路由、计划质量、代码质量和交付结果的离线/在线评估。
- Release Evidence：需求、代码差异、测试、审批、迁移和回滚证据。

评估结果可以触发 Skill 降级、模型切换、人工复核或禁止发布，但不能静默修改权限策略。

## 14. 运行时拓扑

```text
┌─────────────────────────────────────────────────────────────────┐
│                        Project Manager Agent                    │
│  用户对话、目标拆解、计划生成、结果汇总、决策请求、最终交付       │
└──────────────────────────────┬──────────────────────────────────┘
                               │ Plan / Task Envelope
┌──────────────────────────────▼──────────────────────────────────┐
│                         Runtime Orchestrator                    │
│  调度、并发、重试、检查点、预算、取消、事件流                     │
└───────┬─────────────────┬─────────────────┬────────────────────┘
        │                 │                 │
        ▼                 ▼                 ▼
┌──────────────┐  ┌──────────────┐  ┌────────────────────────────┐
│ Skill Manager │  │ Hook Runner  │  │ Permission Engine           │
│ 发现/解析/安装│  │ before/after │  │ deny/allow/approval         │
└──────┬───────┘  └──────┬───────┘  └──────────────┬─────────────┘
       │                  │                         │
       └──────────────────┼─────────────────────────┘
                          ▼
                   ┌──────────────┐
                   │ Tool Runner  │
                   │ Schema/沙箱/日志│
                   └──────┬───────┘
                          ▼
               ┌──────────────────────┐
               │ File / Code / DB / Web│
               │ Model / VCS / Deploy │
               └──────────────────────┘
```

## 15. Tool 设计

### 15.1 Tool 的组成

一个 Tool 由注册信息、输入输出 Schema、执行器和策略组成：

```json
{
  "id": "workspace.write",
  "version": "1.0.0",
  "description": "在指定工作区创建或修改文件",
  "category": "workspace",
  "riskLevel": "medium",
  "inputSchema": "schema://workspace.write.input.v1",
  "outputSchema": "schema://workspace.write.output.v1",
  "capabilities": ["workspace.read", "workspace.write"],
  "sideEffects": ["file-write"],
  "supportsDryRun": true,
  "executor": "executor://workspace",
  "timeoutSec": 120,
  "retryPolicy": {"maxAttempts": 2, "backoffMs": 500},
  "requiredHooks": ["tool.before", "tool.after"]
}
```

执行器必须实现以下接口语义：

```text
validate(input, context) -> ValidationResult
preview(input, context) -> ImpactPreview
execute(input, context) -> ToolResult
rollback(result, context) -> RollbackResult
```

不支持回滚的 Tool 必须声明 `rollback: manual`，并在高风险动作前生成人工回滚步骤。

### 15.2 Tool 调用流程

```text
Agent 请求 Tool
      │
      ▼
解析 Tool 版本与输入 Schema
      │失败 → TOOL_INPUT_INVALID
      ▼
Permission Engine 计算权限
      │拒绝 → TOOL_PERMISSION_DENIED
      ▼
Hook: tool.before
      │拦截 → TOOL_BLOCKED_BY_HOOK
      ▼
风险评估与 dry-run 预览
      │需要确认 → APPROVAL_REQUIRED
      ▼
沙箱执行器执行
      │超时/失败 → TOOL_TIMEOUT / TOOL_EXECUTION_FAILED
      ▼
输出 Schema 校验与敏感信息扫描
      │失败 → TOOL_OUTPUT_INVALID
      ▼
Hook: tool.after → Artifact / Event / Audit
```

### 15.3 Tool 的最小权限

Tool 只获得本次 Run 的工作区、路径、命令、网络域名和数据表范围。`workspace.write` 不等于可以写任意路径；`db.migration.validate` 不等于可以执行迁移；`release.execute` 不等于可以直接发布生产环境。

## 16. Skill 设计

### 16.1 Skill 的定义

Skill 是一个可安装的能力包，描述“何时使用、如何规划、允许使用哪些 Tool、必须运行哪些 Hook、产出什么工件”。Skill 不直接拥有超越 Agent 的权限，也不能绕过 Permission Engine。

Skill 包结构建议如下：

```text
skill-package/
├── skill.yaml                 # 身份、版本、触发条件、依赖
├── instructions.md            # 给 Agent 的执行约束和步骤
├── input.schema.json          # 输入工件和参数
├── output.schema.json         # 输出工件和结果
├── tool-bindings.yaml         # 所需 Tool 与最小权限
├── hook-bindings.yaml         # before/after Hook
├── prompts/                   # 可选的角色提示片段
├── templates/                 # 可选的文档、代码和测试模板
└── tests/                     # Skill 自检和兼容性测试
```

### 16.2 Skill Manifest

```yaml
id: delivery.database-migration
version: 1.3.0
displayName: 数据库迁移交付
description: 生成可重复执行、可预览、可回滚的数据库变更工件
scope: project
activation: auto
trustedPublisher: platform
entry:
  instructions: instructions.md
  inputSchema: input.schema.json
  outputSchema: output.schema.json
requires:
  skills: [delivery.spec-review@^1.0.0]
  tools: [db.schema.read@^1.0.0, db.migration.validate@^1.0.0]
  hooks: [tool.before, task.after]
produces: [schema, migration-script, rollback-plan]
permissions:
  - action: db.schema.read
    resource: project.database.schema
  - action: artifact.write
    resource: project.artifact.schema
```

### 16.3 Skill 的两种安装范围

#### 全局 Skill

- 安装范围：组织或用户。
- 默认对所有项目可发现，可由策略设置为全部自动启用或仅允许使用。
- 适合编码规范、通用安全检查、通用文档规范、基础测试和发布审计。
- 版本由组织锁定，项目不能自行升级或替换受管版本。
- 全局 Skill 不能写入项目私有数据，除非项目级 Permission 显式授予。

#### 项目 Skill

- 安装范围：单个项目。
- 适合特定领域、特定代码库、特定数据库、特定部署环境或项目专用设计系统。
- 项目可以固定版本、启用/停用、配置参数和绑定工作区。
- 项目 Skill 只对当前项目及其子任务可见。

还支持 Run 临时 Skill：只在一次 Run 的沙箱中加载，Run 结束后自动卸载，适合一次性迁移、实验性研究或用户上传的短期规则。

### 16.4 Skill 动态选择与安装流程

```text
用户目标
  │
  ▼
项目经理提取任务能力
  │ 例如：数据库迁移、Vue 页面、接口测试
  ▼
Skill Registry 检索候选 Skill
  │
  ▼
过滤：信任发布者、版本兼容、项目策略、Agent 权限、依赖完整性
  │
  ├── 已安装且已启用 ──────▶ 创建 Skill Activation
  │
  ├── 全局 Skill 可用 ─────▶ 直接激活，不重复安装
  │
  ├── 项目 Skill 缺失 ─────▶ 生成安装预览
  │                              │
  │                  自动安装策略允许？
  │                         ├── 是 ─▶ 下载、校验、安装、锁版本
  │                         └── 否 ─▶ 项目经理向用户请求确认
  │
  └── 无匹配 Skill ────────▶ 项目经理降级为基础 Agent 流程并报告能力缺口
```

### 16.5 动态 Skill 选择规则

选择器输入：用户目标、工作项类型、项目标签、已批准工件、代码指纹、可用 Tool、权限策略和预算。

选择器输出：

```json
{
  "selectedSkills": [
    {"id": "frontend.form", "version": "2.1.0", "scope": "global"},
    {"id": "project.auth-domain", "version": "1.0.2", "scope": "project"}
  ],
  "installRequests": [],
  "rejectedCandidates": [
    {"id": "deploy.production", "reason": "project-policy-deny"}
  ],
  "missingCapabilities": []
}
```

选择顺序固定为：

1. 先复用已激活 Skill。
2. 再复用全局锁定 Skill。
3. 再从项目已安装但未激活的 Skill 中选择。
4. 最后检索可信 Registry 并提出项目安装请求。
5. 任何自动安装都必须写入 `skill-lock`，记录包摘要、来源、版本和依赖树。

### 16.6 Skill 安装安全

- 只允许可信 Registry 或管理员批准的本地包。
- 安装前校验签名、摘要、许可证、依赖和声明权限。
- Skill 的 Tool 权限必须经过 Permission Engine 重新计算。
- Skill 不能在安装脚本中直接执行任意命令；安装阶段只能写入 Skill Cache。
- 更新采用新版本并行安装，验证通过后切换，不原地覆盖当前版本。
- 卸载前检查是否仍被运行、工作项或其他 Skill 依赖。

## 17. Hook 设计

### 17.1 Hook 绑定层级

Hook 可以由平台、组织、项目、Skill 或单次 Run 注册。执行顺序从外到内：

```text
Platform → Organization → Project → Skill → Run → Agent → Tool
```

同一事件存在多个 Hook 时，先执行高优先级阻断检查，再执行普通检查；任何 `deny` 都会阻止后续副作用。

### 17.2 Hook 合同

```json
{
  "id": "security.secret-scan",
  "version": "1.0.0",
  "event": "tool.after",
  "priority": 100,
  "mode": "blocking",
  "input": ["tool.output", "run.context"],
  "output": ["allow", "deny", "redact", "approval-required"],
  "timeoutSec": 10,
  "failurePolicy": "fail-closed"
}
```

### 17.3 必须实现的 Hook

| Hook | 实现要求 |
|---|---|
| `session.start` | 建立上下文快照、加载全局 Skill、计算初始权限 |
| `plan.before` | 校验计划是否包含角色、依赖、预算和验收标准 |
| `skill.install.before` | 校验来源、签名、版本、依赖和安装权限 |
| `skill.activate.before` | 校验项目策略、Tool 绑定和资源范围 |
| `agent.before` | 生成 Agent 级权限快照和工作区隔离 |
| `tool.before` | 校验参数、权限、风险、dry-run 和审批 |
| `tool.after` | 校验输出、脱敏、产物归档和审计 |
| `merge.before` | 检查并发任务冲突、测试和工件版本 |
| `release.before` | 校验发布包、迁移脚本、回滚计划和审批 |
| `assignment.created` | 校验责任主体、权限、职责分离和通知对象 |
| `comment.created` | 校验可见范围、提及权限、敏感信息和订阅通知 |
| `review.requested` | 校验评审人、门禁、截止时间和是否存在利益冲突 |
| `handoff.before` | 校验上下文包、接收方权限、未决问题和责任变更 |
| `approval.requested` | 校验审批链、职责分离、影响范围和确认方式 |
| `session.end` | 保存 Skill 激活、成本、日志和恢复点 |

## 18. Permission 设计

### 18.1 决策模型

每次动作都计算以下决策元组：

```text
Decision(subject, action, resource, project, run, context)
```

示例：

```json
{
  "subject": "agent.backend-developer",
  "action": "workspace.write",
  "resource": "workspace:/src/server/order/OrderService.ts",
  "project": "project_xxx",
  "run": "run_xxx",
  "context": {"skill": "backend.feature", "riskLevel": "medium"}
}
```

### 18.2 权限层级

从宽到严依次是：平台默认、组织策略、项目策略、角色策略、Skill 声明、Run 限制、用户审批。最终权限取所有层级的交集。

决策优先级：

```text
显式 Deny
  > 风险门禁未满足
  > 缺少用户审批
  > 显式 Allow
  > 继承 Allow
  > 默认 Deny
```

权限不能由 Skill 自行提升。项目经理也不能跳过组织 Deny 或高风险审批。

### 18.3 权限快照

Run 开始时生成权限快照；每次 Skill 安装、Skill 激活、Agent 派发、Tool 调用和用户审批后重新生成增量快照。审计记录保存“当时为什么允许或拒绝”。

## 19. 实现模块与调用接口

```text
runtime/
├── manager/              # 项目经理会话与用户交付
├── orchestrator/         # 计划、队列、并发、重试、检查点
├── daemon-control/        # Daemon 注册、心跳、能力、派发和撤销
├── session-service/       # Task/Session 生命周期和恢复
├── skill-manager/        # Registry、解析、安装、锁定、激活
├── tool-registry/        # Tool Manifest、Schema、执行器发现
├── hook-runner/          # Hook 注册、排序、执行和失败策略
├── permission-engine/    # 多层策略求交集和审批判断
├── integration-service/  # 外部需求/Bug/任务连接、映射、同步、冲突
├── connector-adapters/   # 各外部管理系统的 API/MCP/Webhook 适配器
├── team-collaboration/   # 成员、责任、评论、评审、审批、交接
├── notification-service/ # Inbox、提及、订阅和通知投递
├── workspace-manager/    # 工作区、分支、沙箱和冲突检测
├── artifact-store/       # 工件、版本、校验、评论和引用关系
├── sync-outbox/          # Daemon 断网缓存、重试、去重和死信
└── event-store/          # 运行事件、日志、指标和审计
```

最小调用链：

```text
ManagerMessage
  → Manager.plan()
  → SkillSelector.resolve()
  → SkillManager.ensureInstalled()
  → HookRunner.emit("plan.before")
  → Orchestrator.dispatch()
  → PermissionEngine.snapshot()
  → Agent.execute()
  → ToolRunner.invoke()
  → HookRunner.emit("tool.after")
  → ArtifactStore.commit()
  → IntegrationService.sync()
  → CollaborationService.notifyAndRoute()
  → Manager.summarize()
```

## 20. Skill Registry API

### 20.1 搜索 Skill

`GET /api/skills/catalog?capability=database-migration&scope=project`

返回候选 Skill、版本、信任状态、依赖、所需权限、兼容项目标签和安装方式。

### 20.2 安装 Skill

`POST /api/projects/{projectId}/skills/install`

```json
{
  "skillId": "delivery.database-migration",
  "version": "1.3.0",
  "source": "trusted-registry",
  "activation": "auto",
  "dryRun": true
}
```

`dryRun=true` 只返回影响范围、依赖树、权限变化和审批要求；真正安装必须通过 `skill.install.before`。

### 20.3 激活与停用 Skill

- `POST /api/projects/{projectId}/skills/{skillId}/activate`
- `POST /api/projects/{projectId}/skills/{skillId}/deactivate`
- `GET /api/projects/{projectId}/skills/lock`

`skill-lock` 必须记录：Skill ID、版本、包摘要、来源、安装者、安装时间、依赖树、权限声明和当前激活状态。

## 21. 数据模型补充

| 表 | 关键字段 | 说明 |
|---|---|---|
| `skill_registry` | `skill_id`, `version`, `publisher`, `package_uri`, `checksum`, `trust_status` | Skill 包索引 |
| `skill_installation` | `id`, `project_id`, `scope`, `skill_id`, `version`, `status` | 全局/项目/Run 安装记录 |
| `skill_activation` | `id`, `installation_id`, `run_id`, `activation_mode`, `status` | 某次运行的 Skill 激活 |
| `skill_lock` | `project_id`, `lock_version`, `dependency_tree`, `checksum` | 项目版本锁定 |
| `tool_registry` | `tool_id`, `version`, `manifest`, `executor_ref`, `trust_status` | Tool 注册表 |
| `hook_registry` | `hook_id`, `version`, `event`, `priority`, `failure_policy` | Hook 注册表 |
| `permission_policy` | `scope`, `subject`, `action`, `resource`, `effect` | 多层权限策略 |
| `approval_request` | `id`, `run_id`, `action`, `preview`, `status`, `approved_by` | 高风险审批 |
| `external_connection` | `id`, `organization_id`, `provider`, `credential_ref`, `status` | 外部系统连接和凭证引用 |
| `project_binding` | `id`, `project_id`, `connection_id`, `external_project_key`, `sync_mode` | 项目与外部项目绑定 |
| `external_object_link` | `id`, `binding_id`, `internal_type`, `internal_id`, `external_type`, `external_id`, `version` | 内外部对象映射 |
| `sync_event` | `id`, `binding_id`, `direction`, `external_event_id`, `cursor`, `status` | 同步事件和增量游标 |
| `integration_conflict` | `id`, `link_id`, `conflict_type`, `payload`, `status`, `resolution` | 冲突队列 |
| `team` | `id`, `project_id`, `name`, `team_type` | 项目团队和子团队 |
| `team_member` | `team_id`, `member_id`, `role`, `notification_policy` | 团队成员与职责 |
| `assignment` | `id`, `work_item_id`, `subject_type`, `subject_id`, `responsibility`, `status` | 人类或 Agent 的责任分配 |
| `handoff` | `id`, `assignment_id`, `from_subject`, `to_subject`, `context_artifact_id` | 责任交接和上下文包 |
| `comment_thread` | `id`, `project_id`, `target_type`, `target_id`, `visibility` | 讨论串 |
| `comment` | `id`, `thread_id`, `author_id`, `body`, `mentions`, `created_at` | 评论和提及 |
| `review_request` | `id`, `target_type`, `target_id`, `reviewer_subject`, `gate`, `status` | 评审请求 |
| `review_decision` | `id`, `review_request_id`, `decision`, `comment`, `decided_by` | 评审决定 |
| `notification_subscription` | `id`, `member_id`, `scope`, `event_filters`, `delivery` | 通知订阅 |
| `daemon` | `id`, `organization_id`, `environment_type`, `capabilities`, `status`, `last_heartbeat_at` | 本地/远程执行守护进程 |
| `daemon_workspace` | `id`, `daemon_id`, `root_path`, `repository_id`, `status` | Daemon 工作区根目录 |
| `task` | `id`, `project_id`, `goal`, `stage`, `status`, `plan_hash`, `version` | 用户业务目标 |
| `work_item` | `id`, `task_id`, `type`, `status`, `priority`, `depends_on` | Task 下可选的调度拆分 |
| `session` | `id`, `task_id`, `work_item_id`, `daemon_id`, `runtime`, `agent_role`, `status`, `last_event_sequence` | Agent 持续上下文 |
| `run` | `id`, `session_id`, `attempt`, `status`, `checkpoint`, `error_code` | Session 的一次执行尝试 |
| `worktree` | `id`, `task_id`, `repository_id`, `base_revision`, `path`, `branch_name`, `status` | Task 级代码隔离工作区 |
| `artifact_comment` | `id`, `artifact_id`, `artifact_version`, `author_id`, `anchor`, `action_required`, `status` | Artifact 评论和 Agent 回写触发 |
| `daemon_outbox_event` | `id`, `daemon_id`, `event_id`, `sequence`, `payload`, `status`, `retry_count` | Daemon 断网事件缓存 |

## 22. 典型场景：按需安装数据库迁移 Skill

1. 用户对项目经理说“为订单模块增加状态字段，并准备可回滚迁移”。
2. 项目经理识别能力：`database-schema`、`migration`、`rollback`。
3. Skill Selector 发现项目未安装 `delivery.database-migration`，但全局只有只读 Schema Skill。
4. 项目经理生成安装预览：版本、来源、依赖、权限、将创建的 Hook 和 Tool。
5. 如果项目策略允许可信 Skill 自动安装，运行时安装并锁定版本；否则项目经理向用户请求一次确认。
6. Skill 激活后，Database Developer 生成 Schema、迁移脚本和回滚计划。
7. `db.migration.validate` Tool 运行；`tool.after` Hook 检查幂等性、字符集、危险 SQL 和回滚完整性。
8. 项目经理汇总结果，只向用户展示变更摘要、风险和需要确认的发布动作。

## 23. MVP 验收标准

- [ ] Tool 有 Manifest、输入输出 Schema、风险等级、dry-run 和审计记录。
- [ ] Hook 可以按层级注册、排序、阻断和记录失败策略。
- [ ] Permission Engine 对每次 Tool 调用计算最终决策。
- [ ] 支持全局 Skill、项目 Skill 和 Run 临时 Skill 三种范围。
- [ ] Skill 安装前可以预览依赖、权限和影响范围。
- [ ] 项目 Skill 版本写入 lock，运行中不能无提示漂移。
- [ ] 项目经理可以自动选择已安装 Skill，并对缺失 Skill 生成安装请求。
- [ ] 内部 Agent 只能使用项目经理分配的 Skill、Tool 和工作区。
- [ ] 用户只在项目经理会话中看到 Skill 安装确认、风险提示和最终交付。

## 24. 资料来源

本设计参考 Claude Code 官方文档（访问日期：2026-11-06）：

- [How Claude Code works](https://code.claude.com/docs/en/how-claude-code-works)：Agentic Loop、模型、Tool、上下文、Session、Checkpoint、Permission。
- [Extend Claude Code](https://code.claude.com/docs/en/features-overview)：CLAUDE.md、Output Style、Skill、Subagent、Dynamic Workflow、MCP、Hook、Plugin、Artifact 的职责边界。
- [Explore the .claude directory](https://code.claude.com/docs/en/claude-directory)：项目级/用户级配置、规则、Skill、Subagent、Memory、Plugin 的加载位置。
- [Extend Claude with skills](https://code.claude.com/docs/en/skills)：Skill 的 Markdown 形态、Frontmatter、自动/显式调用、Fork Context、共享和评估。
- [Hooks reference](https://code.claude.com/docs/en/hooks)：Hook 事件、脚本/HTTP/MCP/Prompt/Agent 类型、决策控制、异步和安全限制。
- [Connect Claude Code to tools via MCP](https://code.claude.com/docs/en/mcp)：MCP Server、Tool/Resource/Prompt、连接范围、信任、动态工具发现和事件 Channel。
- [Configure permissions](https://code.claude.com/docs/en/permissions)：Allow/Ask/Deny、规则优先级、Permission Mode、Sandbox 和工具级权限。
- [Settings files and precedence](https://code.claude.com/docs/en/settings)：托管、组织、用户、项目共享、项目本地和命令行配置优先级。
- [Orchestrate subagents at scale with dynamic workflows](https://code.claude.com/docs/en/workflows)：动态 Workflow、扇出、后台运行、恢复、成本和可重复执行。
- [Manage sessions](https://code.claude.com/docs/en/sessions)：Resume、Fork、Clear、Compact、导出、跨会话和事件记录。

## 25. s01–s17 专业实现规范

本文件定义系统层、模块边界和数据模型；具体的 17 个 Harness 机制、生产级实现规范、状态机、失败策略和验收清单见 [`docs/agent-runtime-practices.md`](agent-runtime-practices.md)。该文档对应：

```text
s01 Agent Loop       s02 Tool Use          s03 Permission
s04 Hooks             s05 TodoWrite        s06 Subagent
s07 Skill Loading     s08 Context Compact  s09 Memory
s10 Task System       s11 Background       s12 Cron Scheduler
s13 Agent Teams       s14 MCP Plugin       s15 Integrated Harness
s16 Workflow Runtime  s17 Goal Loop
```

