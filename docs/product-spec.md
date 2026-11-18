# Idea-to-Delivery Agent Platform 产品文档

> 文档状态：v0.2 角色协作修订版
>
> 技术栈：TypeScript 全栈方案。Node.js 22 LTS + TypeScript 覆盖控制面、Agent Runtime、Daemon 和集成服务；Vue 3 + TypeScript 覆盖控制台。详细选型见 [`docs/technology-stack.md`](technology-stack.md)。

## 1. 产品定义

Idea-to-Delivery Agent Platform 是一个面向产品团队、研发团队和个人开发者的交付工作台。它把一个模糊的 Idea 转化为可评审的产品规格、可验证的原型、可执行的研发任务、可测试的软件包和可回滚的发布物。

产品的核心不是“自动生成代码”，而是把产品决策、设计产物、工程变更和交付证据串成一条可追溯链路，并使用 Claude Code 风格的 Agent Runtime 承担研究、规划、设计、实现、测试和评审等重复工作。

## 2. 目标与成功标准

### 2.1 目标

1. 让用户从一句 Idea 快速得到结构化产品方案。
2. 让产品、设计、研发和测试在同一个工作项上协作。
3. 让 Agent 通过 Hook、Subagent 和 Tool 执行可控、可暂停、可恢复的任务。
4. 让每次交付都有需求、代码、测试和审批证据。
5. 保持模型、代码执行环境和部署平台可替换。
6. 让用户只需与项目经理 Agent 沟通，不需要理解内部 Agent 的调度细节。
7. 让 AI 按统一工程标准编写可理解、可复用、可审阅、可回滚的代码。

### 2.2 MVP 成功标准

- 新建一个项目后，用户可以在 30 分钟内完成 Idea、需求规格和第一个原型流程。
- 一个工作项可以自动生成任务拆解、接口草案和数据库草案，并由人工审阅后进入实现。
- Agent 运行可以查看实时日志、当前 Hook、调用的 Tool、生成的工件和成本。
- 失败任务可以从最近检查点恢复，且不会重复执行已确认的不可逆动作。
- 交付包可以关联到需求、提交、测试报告、评审结论和发布版本。
- 用户可以只通过项目经理完成目标澄清、进度跟踪、决策确认和最终交付。

## 3. 用户与权限

### 3.1 人机沟通边界

用户只与项目经理 Agent 沟通。项目经理 Agent 是产品的统一工作入口，负责接收目标、解释当前状态、汇总内部 Agent 结果、提出必要决策问题并交付最终结果。

内部角色 Agent 不直接出现在用户对话中。开发、测试、设计和研究 Agent 的原始日志保留在运行详情中，由项目经理选择性摘要；只有在用户主动打开运行详情时，才可以查看内部执行证据。

```text
┌──────────────┐     目标 / 决策 / 反馈      ┌──────────────────┐
│    用户       │ ◀────────────────────────▶ │ 项目经理 Agent    │
└──────────────┘                             └────────┬─────────┘
                                                     │
                           ┌─────────────────────────┼─────────────────────────┐
                           ▼                         ▼                         ▼
                    ┌────────────┐           ┌────────────┐           ┌────────────┐
                    │ 产品与研究 │           │ 设计与架构 │           │ 开发与测试 │
                    │ 内部 Agent │           │ 内部 Agent │           │ 内部 Agent │
                    └─────┬──────┘           └─────┬──────┘           └─────┬──────┘
                          └───────────────结果、工件、风险、问题───────────────┘
```

| 角色 | 主要目标 | 核心权限 |
|---|---|---|
| 产品负责人 | 明确问题、目标和验收标准 | 创建项目、维护 Idea/Spec、审批阶段 |
| 设计师 | 产出流程和原型 | 编辑设计工件、运行原型 Agent |
| 开发者 | 将规格转成可运行代码 | 读取已批准规格、修改工作区、运行测试 |
| 测试人员 | 验证行为和回归 | 执行测试、提交缺陷、生成测试报告 |
| 评审人 | 控制质量和风险 | 审阅工件、批准或退回 |
| 发布管理员 | 负责版本和上线 | 生成发布包、执行发布、回滚 |
| 组织管理员 | 管理组织与策略 | 成员、角色、预算、Tool 策略、审计 |

权限采用“组织 → 项目 → 工作项 → 工件/运行”的层级继承，并允许在运行级别收紧 Tool 权限。项目经理拥有项目级编排权限，但不能跳过高风险审批；内部 Agent 的权限由项目经理计划进一步收紧。

### 3.2 内部 Agent 团队

| Agent 角色 | 是否可并发 | 主要职责 | 默认汇报对象 |
|---|---:|---|---|
| Project Manager | 否（每个用户会话一个主 Agent） | 唯一对话入口、拆解、调度、汇总、交付 | 用户 |
| Product Analyst | 是 | 问题澄清、用户故事、范围和指标 | Project Manager |
| Researcher | 是 | 竞品、领域、用户和代码上下文研究 | Project Manager |
| Designer | 是 | 流程、原型、交互和可访问性 | Project Manager |
| Architect | 条件并发 | 模块、接口、数据模型和 ADR | Project Manager |
| Frontend Developer | 是 | 前端代码、状态和页面测试 | Project Manager |
| Backend Developer | 是 | 后端代码、领域逻辑和接口测试 | Project Manager |
| Database Developer | 是 | Schema、迁移脚本和数据校验 | Project Manager |
| Integration Agent | 是 | 外部需求、Bug、开发任务连接、映射和同步 | Project Manager |
| Unit / Integration / E2E Tester | 是 | 分层测试和回归报告 | Project Manager |
| Reviewer | 通常串行 | 汇总需求、代码、安全和交付质量 | Project Manager |
| Release Manager | 通常串行 | 发布检查、交付包和回滚方案 | Project Manager |

用户不能直接选择或指挥内部 Agent；用户表达的是目标、约束和决策，项目经理负责把它们转换为内部任务。

### 3.3 多人团队协作

一个项目支持多个真实成员和多个内部 Agent 同时参与。真实成员可以直接进行评论、提及、认领、评审、审批和交接；项目经理 Agent 负责跨角色计划、汇总和阶段推进。

每个工作项至少维护以下责任关系：

- `humanOwner`：对结果负责的真实成员。
- `agentOwner`：当前执行的内部 Agent 或 Agent Team。
- `reviewers`：需要给出评审意见的成员或角色。
- `approvers`：可以推进门禁的成员或角色。
- `watchers`：接收进度和风险通知的成员。

人类成员的普通协作不需要经过项目经理转发；以下行为必须进入统一门禁：修改验收标准、改变阶段、覆盖他人产物、解决跨系统冲突、执行高风险动作、发布和修改权限。

## 4. 产品范围

### 4.1 MVP 范围

- 项目和成员管理
- Idea 收集与结构化
- 需求规格生成与版本评审
- 用户流程和原型工件管理
- Agent Run 控制台
- Hook、Subagent、Tool 注册与运行记录
- 任务拆解、代码工作区和测试报告归档
- 数据库 Schema 草案与迁移脚本工件
- 评审、发布准备和交付包
- 审计日志、成本和运行指标

### 4.2 暂不纳入 MVP

- 多租户计费结算
- 复杂企业 SSO 与 SCIM
- 全自动生产发布
- 自研大模型训练
- 面向公众的模板市场
- 跨组织协同和外部客户门户

## 5. 端到端用户流程

```text
┌──────────────┐
│ 1. Idea      │ 用户输入问题、目标用户、约束和成功指标
└──────┬───────┘
       ▼
┌──────────────┐
│ 2. Research  │ 研究 Agent 补齐事实、竞品和风险
└──────┬───────┘
       ▼
┌──────────────┐
│ 3. Spec      │ 规划 Agent 生成需求、验收标准和里程碑
└──────┬───────┘
       ▼
┌──────────────┐
│ 4. Prototype │ 设计 Agent 产出流程、页面和交互说明
└──────┬───────┘
       ▼
┌──────────────┐
│ 5. Plan      │ 架构 Agent 拆分模块、API、数据和任务
└──────┬───────┘
       ▼
┌──────────────┐
│ 6. Build     │ 实现 Agent 在受限工作区修改代码
└──────┬───────┘
       ▼
┌──────────────┐
│ 7. Verify    │ 测试 Agent 执行测试并归档证据
└──────┬───────┘
       ▼
┌──────────────┐
│ 8. Review    │ 评审人检查需求、风险、代码和交付物
└──────┬───────┘
       ▼
┌──────────────┐
│ 9. Release   │ 生成版本、迁移计划、回滚方案和交付包
└──────────────┘
```

每一步都可以人工执行、Agent 执行或混合执行。用户只需要与项目经理确认关键决策；阶段推进必须满足门禁；被退回后保留原版本，产生新的修订版本。

## 6. 信息架构

```text
工作台
├── 项目总览
│   ├── 里程碑与阶段状态
│   ├── 风险与阻塞
│   └── 最近运行与交付
├── 产品
│   ├── Ideas
│   ├── Research
│   ├── Specs
│   └── Decisions / ADR
├── 设计
│   ├── User Flows
│   ├── Prototypes
│   └── Design Review
├── 工程
│   ├── Work Items
│   ├── Tasks / Sessions
│   ├── Daemons
│   ├── Worktrees
│   ├── API Contracts
│   ├── Database Schemas
│   ├── Workspace
│   └── Test Reports
├── 外部管理系统
│   ├── 连接器与授权
│   ├── 项目绑定
│   ├── 需求同步
│   ├── Bug 同步
│   ├── 开发任务同步
│   └── 冲突队列
├── 团队协作
│   ├── Team Board
│   ├── 我的 Inbox
│   ├── 评论与提及
│   ├── 评审与审批
│   ├── 交接记录
│   └── 通知订阅
├── 执行与交付流程
│   ├── Questions
│   ├── Research
│   ├── Design
│   ├── Structure
│   ├── Plan
│   └── Implement
├── Agent Runtime
│   ├── Runs
│   ├── Hooks
│   ├── Subagents
│   ├── Tools
│   └── Cost & Metrics
└── 交付
    ├── Review Queue
    ├── Release Packages
    ├── Environments
    └── Audit Logs
```

工程规范：[`docs/engineering-principles.md`](engineering-principles.md)

## 7. 核心模块设计

### 7.1 Project Workspace

字段：项目名称、目标、领域、成员、默认策略、代码工作区、外部资源、当前阶段、归档状态。

关键行为：创建项目、邀请成员、设置阶段模板、绑定代码仓库、查看项目时间线、归档项目。

#### 7.1.1 Project Manager Conversation

每个项目可以有一个或多个会话，但每个会话只有一个项目经理 Agent 作为入口。会话保存用户消息、项目经理回复、决策请求、确认结果和关联 Run。

项目经理回复必须区分：

- `progress`：阶段进展和已完成工件。
- `decision_required`：需要用户选择或确认的事项。
- `blocked`：内部任务无法继续的原因和建议处理方式。
- `delivery`：阶段或项目交付结果。

### 7.2 Idea & Research

Idea 字段：标题、问题描述、目标用户、使用场景、假设、成功指标、约束、来源、状态。

Research 工件字段：问题、来源、证据摘录、结论、可信度、待验证项、关联 Idea。

状态：`draft` → `researching` → `ready_for_spec` → `archived`。

### 7.3 Spec & Decision

Spec 必须包含：背景、目标、非目标、用户故事、验收标准、边界条件、异常场景、指标、依赖、风险和开放问题。

每个 Spec 版本都必须关联：输入 Idea、研究证据、决策记录和批准人。

### 7.4 Prototype

原型以流程为中心，而不是只保存图片。一个 Prototype 包含页面节点、交互连线、状态、文案、组件引用、可访问性说明和验收任务。

原型验收点示例：

- 首次用户能否在 3 步内完成核心任务。
- 空状态、错误状态、加载状态和权限不足状态是否有定义。
- 键盘导航、焦点顺序和文本对比度是否满足要求。

### 7.5 Work Items

WorkItem 是 Task 下可选的调度拆分，不是 Task 的同义词。只有需要独立队列、依赖关系、责任分派、优先级、排期、租约或并发调度时才创建 WorkItem。

工作项类型：`feature`、`bug`、`research`、`design`、`backend`、`frontend`、`database`、`test`、`release`。

字段：`workItemId`、`taskId`、标题、描述、优先级、负责人、依赖、输入工件、输出工件、验收标准、状态、估算、实际成本、租约和版本。

统一关系：

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

### 7.6 Agent Runtime

Agent Runtime 是平台的执行内核，由 Agentic Loop、模型与路由、上下文与记忆、会话与检查点、Tool、Skill、Subagent/Team、Workflow、Hook/Event、MCP、配置与插件、权限与沙箱、Daemon 执行层、工作区、工件与观测等层组成。项目经理是这些能力的统一编排者。

运行时必须覆盖 `learn-claude-code` s01–s17 的完整机制链：Loop、Tool、Permission、Hooks、Todo、Subagent、Skill、Context Compact、Memory、Task System、Background Task、Cron、Agent Teams、MCP Plugin、Integrated Harness、Workflow Runtime 和 Goal Loop。专业实现规范见 [`docs/agent-runtime-practices.md`](agent-runtime-practices.md)。

```text
┌────────────┐      目标       ┌────────────┐
│ Task       │ ───────────────▶ │ Session    │
└─────┬──────┘                 └─────┬──────┘
      │ 可选调度拆分                  │一次或多次执行
      ▼                              ▼
┌────────────┐                 ┌────────────┐
│ WorkItem   │                 │ Run        │
└────────────┘                 └─────┬──────┘
                                      │项目经理生成计划
                         ┌────────────▼────────────┐
                         │ Project Manager Agent   │
                         │ 统一沟通、拆解、汇总、门禁 │
                         └────────────┬────────────┘
                                      │并发调度内部角色
         ┌────────────────────────────┼────────────────────────────┐
         ▼                            ▼                            ▼
   ┌────────────┐              ┌────────────┐              ┌────────────┐
   │ Developer  │              │ Tester     │              │ Designer / │
   │ Frontend   │              │ Unit       │              │ Architect  │
   │ Backend    │              │ Integration│              │ Researcher │
   │ Database   │              │ E2E        │              └─────┬──────┘
   └─────┬──────┘              └─────┬──────┘                    │
         └──────────────┬────────────┴──────────────┬────────────┘
                        ▼                           ▼
                 ┌────────────┐              ┌────────────┐
                 │ Artifacts  │              │ Event/Log  │
                 └──────┬─────┘              └──────┬─────┘
                        └──────────▶ 项目经理汇总 ◀───┘
```

Run 页面必须展示：当前阶段、上下文摘要、Hook 时间线、Subagent 树、Tool 调用、实时输出、产物、成本、错误、暂停/取消/重试入口。

#### 7.6.1 Runtime 核心层

Runtime 不只包含 Tool、Skill、Hook 和 Permission，而是由以下核心层组成：

1. **用户入口层**：项目经理会话，是用户唯一沟通入口。
2. **Agentic Loop 层**：理解、计划、执行、观察、验证、汇总。
3. **模型与路由层**：模型能力、成本、延迟、结构化输出和降级。
4. **上下文组装层**：项目规则、工作项、工件、Skill、Tool Schema 和历史压缩。
5. **记忆层**：用户记忆、项目记忆、Agent 记忆和 Run 临时记忆。
6. **会话与检查点层**：事件记录、恢复、分叉、回滚和跨界面继续。
7. **Tool 层**：文件、搜索、命令、代码智能、Web 和外部动作。
8. **Skill 层**：可复用知识、工作流、模板和任务能力。
9. **Subagent / Team 层**：隔离上下文、角色 Agent、并发协作和消息。
10. **Workflow 层**：动态扇出、汇总、交叉验证、长任务和可重跑图。
11. **Hook / Event 层**：在生命周期事件上执行脚本、HTTP、MCP、Prompt 或 Agent。
12. **MCP / 外部连接层**：外部 Tool、Resource、Prompt、Webhook 和事件 Channel。
13. **配置与插件层**：平台、组织、用户、项目、Run 配置及 Plugin/Marketplace 分发。
14. **权限与安全执行层**：Allow/Ask/Deny、审批、沙箱、工作区和网络隔离。
15. **工件、观测与评估层**：Artifact、Trace、Metric、Eval、发布证据和交付包。
16. **外部管理系统集成层**：需求、Bug、开发任务、测试和版本对象的连接、映射、双向同步和冲突处理。
17. **多人团队协作层**：真实成员、Agent、责任、评论、评审、审批、交接和通知。
18. **Daemon 执行层**：本地/远程 Agent 进程、Session、Worktree、心跳和事件同步。

完整实现契约、层间依赖和官方资料映射见 [`docs/agent-runtime-design.md`](agent-runtime-design.md)。

Daemon、Task/Session/Artifact/Worktree 分离、QRSPI 阶段和多人实时协作见 [`docs/execution-and-collaboration-design.md`](execution-and-collaboration-design.md)。

### 7.7 Review & Release

评审包自动汇总：需求版本、原型版本、API 合同、数据库脚本、代码差异、测试结果、风险、迁移计划、回滚方案和审计记录。

发布状态：`draft` → `candidate` → `approved` → `scheduled` → `released` → `rolled_back`。

### 7.8 外部管理系统集成

平台支持对接外部需求管理、Bug 管理、开发任务管理、测试管理和版本管理系统。MCP 负责连接协议和 Tool 暴露，集成层负责业务对象的规范化、字段映射、状态转换、双向同步和冲突处理。

支持的对象：

- 需求：Idea/Spec ↔ 外部 Requirement/Epic/Story。
- Bug：内部 Bug ↔ 外部 Bug/Issue/Defect。
- 开发任务：Work Item ↔ 外部 Task/Sub-task/Ticket。
- 测试：Test Report ↔ 外部 Test Case/Test Run/Test Result。
- 版本：Release Package ↔ 外部 Version/Release/Milestone。

项目绑定必须配置：外部项目、同步方向、字段映射、状态映射、成员映射、默认迭代、标签规则、Webhook、冲突策略和速率限制。

同步模式：

1. 只读同步：读取外部状态和对象，平台不写回。
2. 平台主导：平台创建/更新外部对象，外部变更通过 Webhook 回流。
3. 双向协同：两边均可修改，使用版本号、字段级合并和冲突队列。

项目经理负责把外部变更转换成用户可读的进度、风险或决策请求。例如外部 Bug 被标记为阻塞时，项目经理应更新关联 Work Item，并向用户说明影响范围和建议动作。

### 7.9 Team Collaboration

团队协作模块提供：

- Team：项目团队、子团队、跨项目团队和角色组。
- Assignment：人类任务、Agent 任务、评审任务、审批任务和观察任务。
- Comment Thread：挂载在 Idea、Spec、原型节点、代码差异、Bug、任务或发布包上的讨论。
- Mention：`@成员`、`@团队`、`@项目经理` 和 `@角色`。
- Review Request：指定成员或角色在门禁前评审。
- Handoff：把责任与上下文交给新的成员或 Agent。
- Decision Record：记录选项、依据、参与者、决策人和影响。
- Notification Subscription：按项目、对象、事件类型和严重级别订阅。

并发协作规则：

1. 文档、Spec、原型和配置采用版本号或操作序列的乐观并发控制。
2. 代码默认使用 Worktree、分支或等价隔离目录。
3. 同一工件冲突时展示字段级或行级差异、来源、时间和责任人。
4. 合并前执行 `merge.before` Hook，并根据策略触发自动测试和人工评审。
5. 长时间编辑显示 presence 和编辑锁提示，锁超时自动释放，锁不能替代版本校验。

交接包必须包含当前目标、完成项、未完成项、阻塞、风险、关键链接、最近事件、待决策问题、下一步和新责任人。

### 7.10 Daemon、Task、Session 与 Worktree

平台控制面不直接执行用户机器上的 Agent。每台执行机器由 Daemon 注册并维持心跳，项目经理根据能力、负载和权限把 Session 派发到合适的 Daemon。Daemon 负责本地 Agent 进程、命令、工作区、Worktree 和事件上传。

一个 Task 表示完整业务目标，可以拥有多个 Session、Artifact、Worktree 和 Assignment。Session 表示一次 Agent 执行，允许不同模型、角色和 Daemon 并行参与。Artifact 是可版本化、可评论和可评审的结构化成果；Worktree 是 Task 级代码隔离目录。

### 7.10.1 Agent Runtime Gateway

平台通过统一 Gateway 选择原生 Agent 执行引擎：

| Runtime | Adapter | 支持环境 |
|---|---|---|
| Codex | Codex App Server Adapter | 本机 Session、云端 Session 容器 |
| Claude | Claude Agent SDK Adapter | 本机 Session、云端 Session 容器 |
| Gemini | Gemini Native Adapter | 本机 Session、云端 Session 容器 |
| DeepSeek | Native / OpenAI-Compatible Adapter | 本机 Session、云端 Session 容器 |
| Qwen | Native / OpenAI-Compatible Adapter | 本机 Session、云端 Session 容器 |
| 智谱 | Native / OpenAI-Compatible Adapter | 本机 Session、云端 Session 容器 |
| 中转站 | Relay Adapter | 本机 Session、云端 Session 容器 |

Codex 和 Claude 使用原生运行时，平台通过 Adapter 接收原生事件并转换为统一 Session Event；不把它们降级为普通文本补全接口。

### 7.10.2 Session 执行环境和认证

Session 环境：

- `local`：运行在用户电脑上的 Daemon，可访问本机代码、Git、IDE、浏览器和授权资源。
- `cloud`：运行在云端隔离容器中的 Daemon/Runner，适合远程协作、长期任务、Cron 和多人共享。

认证模式：

- `native-login`：使用 Codex App Server 或 Claude Agent SDK 的官方登录流程。
- `api-key`：使用官方 API Key。
- `relay-api-key`：使用中转站 Base URL、模型和 API Key。

原生登录、官方 API Key 和中转站 API/Key 是独立认证路径。凭证只保存引用；本机使用操作系统密钥链或本地加密存储，云端使用 Secret Broker 注入短期凭证。Session 结束后清理容器凭证。

### 7.11 QRSPI 交付流程

复杂任务默认按以下阶段推进：

```text
Questions → Research → Design → Structure → Plan → Implement
```

每一阶段都有明确产物、进入条件、完成门禁和回退路径。没有批准的 Design、Structure 和 Plan，开发 Agent 不得进入 Implement。小型低风险任务可以合并阶段，但必须记录简化理由和风险。

## 8. Agent 编排设计

### 8.1 运行上下文

每次 Run 绑定：项目快照、工作项、已批准工件、角色权限、Tool 白名单、预算、超时、模型策略和恢复点。

上下文分层：

1. **系统层**：全局安全规则和 Agent 协议。
2. **项目层**：项目目标、术语、目录、编码规范和外部资源。
3. **工作项层**：当前需求、输入工件、验收标准和依赖。
4. **运行层**：本次任务的临时计划、Tool 输出和中间结论。

### 8.2 项目经理调度模型

项目经理 Agent 是所有内部任务的父节点。它先生成任务图，再由运行时编排器执行；运行时编排器不能绕过项目经理直接接受用户输入或向用户输出。

项目经理的职责边界：

1. 将用户目标转换为 Task、验收标准和必要的执行拆分。
2. 识别可以并发的任务，并为每个内部 Agent 分配隔离工作区、输入工件和 Tool 白名单。
3. 等待所有必需结果，合并同类工件，检测冲突和缺口。
4. 对失败任务决定重试、改派、降级或向用户提问。
5. 在阶段门禁处生成面向用户的进度摘要和决策请求。

### 8.3 Subagent 调度

项目经理根据工作项类型选择角色链。例如“实现一个带数据库变更的功能”：

```text
用户
 │
 ▼
Project Manager
 │
 ├── Architect ───────────────▶ API Contract + Schema Draft
 ├── Backend Developer ───────▶ Service + Repository + Tests
 ├── Frontend Developer ──────▶ Page + State + Tests
 ├── Database Developer ──────▶ Migration Script + Validation
 ├── Integration Agent ───────▶ External Requirement / Bug / Task Sync
 ├── Unit Tester ──────────────▶ Unit Test Report
 ├── Integration Tester ───────▶ Contract / Integration Report
 ├── E2E Tester ───────────────▶ User Flow Report
 └── Reviewer ─────────────────▶ Consolidated Review
                                      │
                                      ▼
                              Project Manager 汇总交付
```

开发 Agent、测试 Agent、研究 Agent 和部分设计 Agent 可以并发运行。并行任务只能写入各自隔离的工作区或工件草稿，合并前必须通过冲突检测和评审。项目经理负责定义依赖：例如测试 Agent 可以在接口草案批准后提前并行设计测试，但端到端测试必须等待可运行构建产物。

### 8.4 项目经理对用户的交付格式

项目经理每次向用户汇报都必须包含：

- 当前阶段和完成百分比（基于工作项，不凭模型主观估计）。
- 已完成的工件与链接。
- 并发 Agent 的结果摘要和冲突处理结论。
- 风险、阻塞和需要用户决定的问题。
- 下一步动作、预计依赖和是否需要授权。

内部 Agent 的原始输出只作为证据，不直接作为用户结论。

### 8.5 Tool 执行模型

Tool 调用顺序固定为：参数校验 → 权限校验 → 风险评估 → 预览（必要时）→ 执行 → 结果校验 → 产物归档 → 审计。

任何 Tool 都不能绕过 Hook；运行时错误必须转换为稳定错误码，不把原始敏感信息直接返回给前端。

## 9. 数据模型

### 9.1 实体关系（概念模型）

```text
Organization 1──N Project 1──N Task 1──N Session 1──N Run
                      │              │          │          ├──N ToolCall
                      │              │          │          ├──N HookExecution
                      │              │          │          └──N Artifact
                      │              │          │
                      │              │          └──N WorkItem（可选）
                      │              │                     └──N WorkItemDependency
                      │              │
                      │              ├──N Worktree
                      │              ├──N TaskArtifact
                      │              └──N Daemon 1──N Session
                      │
                      ├──N Conversation 1──N ManagerMessage
                      ├──N AgentAssignment 1──N AgentOutput
                      ├──N ExternalConnection 1──N ProjectBinding
                      ├──N ExternalObjectLink 1──N SyncEvent
                      ├──N IntegrationConflict
                      ├──N Team 1──N TeamMember
                      ├──N Assignment 1──N Handoff
                      ├──N CommentThread 1──N Comment
                      ├──N ReviewRequest 1──N ReviewDecision
                      └──N NotificationSubscription
                      │
                      ├──N Idea 1──N ResearchFinding
                      ├──N Spec 1──N SpecVersion
                      ├──N Prototype 1──N PrototypeNode
                      ├──N Decision
                      ├──N Member
                      └──N ReleasePackage 1──N ReleaseCheck

Member N──N Project (ProjectMember)
Role N──N Permission (RolePermission)
```

### 9.2 核心表建议

| 表 | 关键字段 | 说明 |
|---|---|---|
| `organization` | `id`, `name`, `status` | 组织边界 |
| `project` | `id`, `organization_id`, `name`, `stage` | 项目主实体 |
| `task` | `id`, `project_id`, `goal`, `stage`, `status`, `plan_hash`, `version` | 用户业务目标 |
| `work_item` | `id`, `task_id`, `type`, `status`, `priority`, `depends_on` | Task 下可选的调度拆分 |
| `session` | `id`, `task_id`, `work_item_id`, `daemon_id`, `runtime`, `agent_role`, `status` | Agent 持续上下文 |
| `run` | `id`, `session_id`, `attempt`, `status`, `checkpoint`, `error_code` | Session 的一次执行尝试 |
| `conversation` | `id`, `project_id`, `manager_agent_id`, `status` | 用户与项目经理会话 |
| `manager_message` | `id`, `conversation_id`, `sender`, `message_type`, `run_id` | 用户消息与项目经理回复 |
| `agent_assignment` | `id`, `run_id`, `role`, `workspace_scope`, `status` | 项目经理分派的内部任务 |
| `agent_output` | `id`, `assignment_id`, `summary`, `artifact_ids`, `open_questions` | 内部 Agent 返回给项目经理的结果 |
| `daemon` | `id`, `organization_id`, `environment_type`, `capabilities`, `status`, `last_heartbeat_at` | 本地/远程执行守护进程 |
| `daemon_workspace` | `id`, `daemon_id`, `root_path`, `repository_id`, `status` | Daemon 工作区根目录 |
| `worktree` | `id`, `task_id`, `repository_id`, `base_revision`, `path`, `branch_name`, `status` | Task 级代码隔离工作区 |
| `task_artifact` | `id`, `task_id`, `artifact_id`, `relation_type` | Task 与 Artifact 关联 |
| `artifact_comment` | `id`, `artifact_id`, `artifact_version`, `author_id`, `anchor`, `action_required`, `status` | Artifact 评论和修改请求 |
| `daemon_outbox_event` | `id`, `daemon_id`, `event_id`, `sequence`, `payload`, `status`, `retry_count` | Daemon 断网事件缓存 |
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
| `artifact` | `id`, `project_id`, `type`, `version`, `uri`, `checksum` | 版本化产物 |
| `tool_call` | `id`, `run_id`, `tool_name`, `risk_level`, `status` | 工具调用记录 |
| `hook_execution` | `id`, `run_id`, `hook_name`, `status`, `duration_ms` | Hook 记录 |
| `audit_log` | `id`, `actor_id`, `action`, `target`, `payload` | 审计记录 |
| `release_package` | `id`, `project_id`, `version`, `status`, `rollback_plan` | 交付包 |

完整表结构在实现阶段写入 `/database/schema.sql`，初始化和演示数据写入 `/database/init-data.sql`。

## 10. API 契约

API 先定义资源与行为，采用 NestJS + Fastify、OpenAPI、Zod 和 Protobuf/ConnectRPC 实现。所有请求必须带组织、项目和幂等键上下文。

### 10.1 创建 Idea

`POST /api/projects/{projectId}/ideas`

请求：

```json
{
  "title": "为新用户生成首个交付计划",
  "problem": "用户有想法但不知道如何拆解为可执行任务",
  "targetUsers": ["产品经理", "独立开发者"],
  "successMetrics": ["首个计划生成时间少于 10 分钟"],
  "constraints": ["需要保留人工审批"],
  "source": "user-input",
  "idempotencyKey": "idea-create-001"
}
```

响应：

```json
{
  "id": "idea_xxx",
  "status": "draft",
  "nextActions": ["start-research", "write-spec"],
  "createdAt": "2026-11-06T10:00:00+08:00"
}
```

异常：`PROJECT_NOT_FOUND`、`FORBIDDEN`、`VALIDATION_FAILED`、`IDEMPOTENCY_CONFLICT`。

### 10.2 创建 Agent Session

`POST /api/tasks/{taskId}/sessions`

请求：

```json
{
  "entryAgent": "project-manager",
  "goal": "生成需求规格和验收标准",
  "workItemId": null,
  "inputArtifactIds": ["artifact_idea_v1"],
  "requestedCapabilities": ["research", "specification"],
  "approvalMode": "required-for-side-effects",
  "budget": {"maxDurationSec": 900, "maxCost": 2.0 }
}
```

响应：

```json
{
  "sessionId": "session_xxx",
  "entryAgent": "project-manager",
  "status": "queued",
  "eventStreamUrl": "/api/sessions/session_xxx/events",
  "nextAction": "create-run"
}
```

### 10.3 创建 Session Run

`POST /api/sessions/{sessionId}/runs`

请求：

```json
{
  "inputSnapshotId": "context_snapshot_xxx",
  "planHash": "sha256:plan_xxx",
  "budget": {"maxDurationSec": 900, "maxCost": 2.0},
  "trigger": "manager-dispatch"
}
```

响应：

```json
{
  "runId": "run_xxx",
  "sessionId": "session_xxx",
  "attempt": 1,
  "status": "queued",
  "streamUrl": "/api/runs/run_xxx/events",
  "cancelUrl": "/api/runs/run_xxx/cancel"
}
```

同一 Session 重试必须创建新的 `Run`，保留原 Run 的状态、错误和证据。若 Task 使用 WorkItem，则 Session 请求必须带 `workItemId`，且 WorkItem 必须已被合法认领。

### 10.4 查询运行状态

`GET /api/runs/{runId}` 返回：项目经理摘要、状态、当前 Hook、Subagent 树、Tool 调用、工件、错误、成本、检查点和下一步动作。内部 Agent 的原始输出通过运行详情访问，不作为主对话默认内容。

### 10.5 与项目经理对话

`POST /api/projects/{projectId}/manager/messages`

请求：

```json
{
  "conversationId": "conversation_xxx",
  "message": "把登录流程拆成前后端并行任务，并告诉我什么时候需要确认数据库方案",
  "attachments": ["artifact_spec_v2"]
}
```

响应：

```json
{
  "conversationId": "conversation_xxx",
  "messageId": "message_xxx",
  "managerStatus": "delegating",
  "runId": "run_xxx",
  "needsUserDecision": false
}
```

项目经理可以在后续消息中返回阶段性摘要、风险和决策请求。

### 10.6 审批高风险动作

`POST /api/runs/{runId}/approvals`

请求包含：`approvalId`、`decision`、`comment`、`confirmationToken`。审批只能作用于预览过的动作，令牌一次性使用并写入审计日志。

### 10.6.1 注册执行 Daemon

`POST /api/daemons/register`

请求字段：`machineName`、`environmentType`、`capabilities`、`workspaceRoots`、`maxConcurrentSessions`、`daemonVersion`。

响应字段：`daemonId`、`status`、`heartbeatIntervalSec`、`sessionProtocolVersion`、`credentialRef`。

异常：`ORGANIZATION_FORBIDDEN`、`DAEMON_VERSION_UNSUPPORTED`、`WORKSPACE_ROOT_INVALID`、`REGISTRATION_REVOKED`。

### 10.6.2 创建 Task

`POST /api/projects/{projectId}/tasks`

请求：

```json
{
  "title": "重构用户认证系统",
  "goal": "保持现有登录行为，替换认证模块并补齐回归测试",
  "acceptanceCriteria": ["认证测试通过", "迁移可回滚"],
  "priority": "high",
  "humanOwner": "member_xxx",
  "requestedCapabilities": ["research", "design", "backend", "testing"],
  "repositoryIds": ["repo_platform_api"]
}
```

响应：

```json
{
  "taskId": "task_xxx",
  "stage": "questions",
  "status": "clarifying",
  "managerConversationId": "conversation_xxx",
  "nextActions": ["answer-questions", "start-research"]
}
```

### 10.6.3 Session 派发规则

Session 创建后由项目经理和调度器选择 `agentRole`、`modelRef`、`daemonId`、`workspacePolicy`、`allowedSkills`、`allowedTools`、`budget` 和 `planHash`。这些字段写入 Session 的权限快照和执行计划，再创建 Session Run。

派发前必须检查：`TASK_PLAN_REQUIRED`、`PLAN_HASH_STALE`、`DAEMON_UNAVAILABLE`、`WORKSPACE_CONFLICT` 和 `PERMISSION_DENIED`。派发成功后，唯一的执行接口是 `POST /api/sessions/{sessionId}/runs`。

### 10.6.4 Artifact 评论

`POST /api/artifacts/{artifactId}/versions/{version}/comments`

请求字段：`anchor`、`body`、`mentions`、`actionRequired`。当 `actionRequired=true` 时，项目经理创建修改 Task 或把评论挂到现有 Session 的下一轮上下文。

### 10.6.5 Task 交接

`POST /api/tasks/{taskId}/handoffs`

请求字段：`fromSubject`、`toSubject`、`reason`、`contextSnapshotId`、`openQuestions`、`risks`、`nextActions`。

响应字段：`handoffId`、`status=pending_acceptance`、`newAssignmentId`。

### 10.7 外部系统连接与项目绑定

`POST /api/organizations/{organizationId}/external-connections`

请求：

```json
{
  "provider": "issue-tracker",
  "displayName": "研发任务系统",
  "transport": "mcp",
  "credentialRef": "secret://org/issue-tracker",
  "capabilities": ["requirements.read", "bugs.read_write", "tasks.read_write"],
  "approvalMode": "required-for-write"
}
```

响应：

```json
{
  "connectionId": "connection_xxx",
  "status": "pending_verification",
  "discoveredCapabilities": [],
  "nextAction": "verify-connection"
}
```

`POST /api/projects/{projectId}/external-bindings` 用于绑定外部项目，并提交 `connectionId`、`externalProjectKey`、`syncMode`、`fieldMappings`、`statusMappings`、`memberMappings` 和 `conflictPolicy`。

### 10.8 外部对象同步

`POST /api/projects/{projectId}/integrations/sync`

请求：

```json
{
  "bindingId": "binding_xxx",
  "objectTypes": ["requirement", "bug", "development-task"],
  "direction": "bidirectional",
  "dryRun": true,
  "idempotencyKey": "sync-project-001"
}
```

`dryRun=true` 返回将创建、更新、跳过和冲突的对象清单；真实同步必须通过 `integration.sync.before` Hook。Webhook 入口必须校验签名、去重事件 ID 和对象版本。

### 10.9 冲突处理

`GET /api/projects/{projectId}/integration-conflicts` 查询冲突队列。

`POST /api/integration-conflicts/{conflictId}/resolve` 请求包含 `resolution`（`keep_internal`、`keep_external`、`merge_fields`、`defer`）、字段级变更和审批说明。状态、负责人、优先级、关闭、删除和发布等高风险冲突不能自动覆盖。

### 10.10 团队协作 API

创建团队成员分配：

`POST /api/work-items/{workItemId}/assignments`

```json
{
  "subjectType": "human",
  "subjectId": "member_xxx",
  "responsibility": "human-owner",
  "reviewers": ["role:tech-lead"],
  "dueAt": "2026-11-10T18:00:00+08:00"
}
```

评论和提及：

`POST /api/comment-threads/{threadId}/comments`

```json
{
  "body": "接口方案已更新，请 @tech-lead 评审错误码设计。",
  "mentions": ["member_tech_lead"],
  "attachments": ["artifact_api_contract_v3"]
}
```

请求交接：

`POST /api/assignments/{assignmentId}/handoffs`

请求包含 `toSubject`、`reason`、`contextArtifactId`、`openQuestions`、`risks` 和 `nextActions`。交接完成后，原责任人变为观察者，除非项目策略允许共同负责。

发起评审：

`POST /api/review-requests`

请求包含 `targetType`、`targetId`、`reviewerSubject`、`gate`、`requiredDecision` 和 `dueAt`。支持串行、并行和条件评审；任何拒绝都会生成变更任务并保留原记录。

查询我的 Inbox：

`GET /api/me/inbox?projectId={projectId}&status=pending`

返回被提及、任务分配、评审请求、审批请求、阻塞、外部同步冲突和 SLA 临近事件。

## 11. 状态机与门禁

```text
Idea
  │ ready_for_spec
  ▼
Spec ──approved──▶ Prototype ──approved──▶ Plan
  ▲                  │                      │
  └──changes───────┘  └──changes───────────┘
                                           │ ready_for_build
                                           ▼
                                         Build
                                           │ tests_passed
                                           ▼
                                         Review
                                      ┌────┴────┐
                                      │         │
                                  approved  changes_requested
                                      │         │
                                      ▼         └──▶ Build
                                    Release
```

门禁示例：

- `Spec → Prototype`：目标、用户故事、验收标准齐全。
- `Prototype → Plan`：核心流程、异常状态和原型验收点齐全。
- `Plan → Build`：接口、数据模型、任务依赖和风险已评审。
- `Build → Review`：测试报告、数据库脚本、代码差异和变更说明齐全。
- `Review → Release`：评审通过、迁移可回滚、发布包可复现。

## 12. 非功能要求

### 12.1 安全

- 所有资源按组织和项目隔离。
- Tool 使用白名单和工作区路径限制。
- 密钥进入专用密钥管理，不写入 Prompt、日志或 Artifact。
- 高风险动作双重确认，审计日志不可修改。

### 12.2 可观测性

- 统一记录 `traceId`、`runId`、`workItemId`、`toolCallId`。
- 指标至少包含成功率、平均耗时、重试次数、模型成本、Token 用量、Tool 失败率和人工接管率。
- 日志支持按项目、运行、Agent、Hook、Tool 和时间范围检索。

### 12.3 可靠性

- Run、Hook 和 Tool 都支持超时、重试、取消和恢复。
- 不可逆动作必须具备预览和回滚说明。
- Artifact 使用版本和校验值，支持重新生成与差异比较。

### 12.4 可替换性

以下能力必须通过接口隔离：模型、Embedding、向量检索、代码执行器、浏览器、对象存储、消息通知、版本控制和部署平台。

## 13. 交付路线图

本节描述产品能力从 Idea 到 Release 的生命周期；工程实施阶段、范围和暂缓项见 [`docs/implementation-roadmap.md`](implementation-roadmap.md)。工程第一阶段采用无 UI 的 Headless 本机 MVP，只接入 Codex 和 Qwen；云端 Session、Session Handoff、Web UI、多人协作、其他模型和外部系统按后续阶段实施。

### Phase 0：基线与协议

- 完成 `AGENTS.md`、产品规格、领域词汇、Artifact Schema、Run Schema 和错误码。
- 固化工程判断标准、设计模式使用规则、变更等级、复用检查和完成定义。
- 建立最小控制面 API 与运行事件模型。
- 建立 Daemon 注册、心跳、执行计划、事件 Outbox 和 Task/Session/Artifact/Worktree 数据模型。

### Phase 1：Idea → Spec

- 项目、成员、Idea、Research、Spec、评审。
- Planner、Researcher、基础 Hook 和只读 Tool。
- 落地 Questions → Research → Design → Structure → Plan 的阶段门禁。

### Phase 2：Spec → Prototype

- 流程、页面、原型工件、设计评审。
- Designer Subagent 和原型工件适配器。

### Phase 3：Prototype → Build

- 工作项、代码工作区、API/Schema 工件、受限写入 Tool。
- Implementer、Tester、Reviewer Subagent。
- 支持多 Daemon、多 Session、Task Worktree 和并行 Agent 执行。

### Phase 4：Build → Release

- 测试门禁、交付包、发布检查、迁移预览、回滚记录和审计。
- Release Manager 与环境适配器。

## 14. MVP 验收清单

- [ ] 可以创建组织、项目和成员。
- [ ] 用户可以只通过项目经理会话完成目标输入、进度跟踪和决策确认。
- [ ] 可以从 Idea 生成版本化 Spec，并完成审批。
- [ ] 可以从 Spec 生成 Prototype 工件和验收点。
- [ ] 可以创建 Task；只有需要独立调度时才创建 WorkItem，并通过 Session/Run 执行。
- [ ] 可以注册本地/远程 Daemon，并按能力和负载调度 Session。
- [ ] Task、Session、Artifact、Worktree 可以独立查询、版本化和审计。
- [ ] 复杂任务经过 Questions、Research、Design、Structure、Plan 后才能 Implement。
- [ ] 一个 Task 可以包含多个不同模型、角色和 Daemon 的 Session。
- [ ] Artifact 支持版本、评论、评审、引用和 Agent 回写。
- [ ] Daemon 断网、进程崩溃或控制面重启后可以恢复 Session 和事件同步。
- [ ] 可以看到 Hook、Subagent、Tool 的实时状态和历史记录。
- [ ] Agent Runtime 覆盖 s01–s17，并且每个机制都有持久化状态、权限边界、失败策略和验收证据。
- [ ] 可以暂停、取消、重试和从检查点恢复 Run。
- [ ] 可以生成 API、数据库和测试工件。
- [ ] 可以生成评审包并完成批准/退回。
- [ ] 可以生成带回滚方案的 Release Package。
- [ ] 可以配置外部需求、Bug 和开发任务管理系统连接。
- [ ] 可以绑定外部项目并配置字段、状态、成员和同步模式映射。
- [ ] 可以执行只读、平台主导和双向同步，并支持 dry-run、增量游标、重试和断点恢复。
- [ ] 外部系统冲突进入队列，由项目经理向用户展示差异并完成处理。
- [ ] 多个真实成员可以在同一项目中评论、提及、认领、评审、审批和交接。
- [ ] 每个工作项都能区分人类责任人、Agent 责任人、评审人、审批人和关注者。
- [ ] 并发编辑、版本冲突和代码隔离有明确提示与门禁。
- [ ] 成员可以使用个人 Inbox 和通知订阅跟踪待办。
- [ ] AI 任务执行前完成范围评估、复用检查和变更等级判断。
- [ ] 代码评审可以检查设计模式使用依据、最小改动范围和实际验证证据。
- [ ] 所有关键动作都写入审计日志。

