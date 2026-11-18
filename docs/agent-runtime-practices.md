# Agent Runtime 专业实现规范：s01–s17

> 文档状态：v0.1
>
> 适用范围：项目经理 Agent、内部 Subagent、Agent Team、Workflow Runtime、Tool、Skill、Hook、MCP Plugin 和所有后台任务。
>
> 参考来源：`learn-claude-code` s01–s17。该项目提供 s01–s17 Harness 机制参考；本文在此基础上补充生产系统需要的持久化、一致性、并发、安全、可观测性、恢复和治理。

参考仓库：[ty793941/learn-claude-code](https://github.com/ty793941/learn-claude-code)。本文以该项目的机制为参考，统一规定正式产品的工程边界和验收要求。

## 1. 总体原则：模型负责判断，Harness 负责边界

Agent 不是一串固定 Prompt，也不是把多个模型调用硬连起来的流程图。平台应该提供一个稳定的 Agent Loop，模型在上下文中选择下一步，Harness 负责：

- 提供可验证、可审计、最小权限的 Tool。
- 组装项目规则、记忆、Skill、外部连接和任务上下文。
- 控制资源、预算、并发、超时、审批和恢复。
- 把 Tool、Hook、Subagent、Workflow 和外部事件的结果放回同一个会话事件流。
- 在模型判断不可靠时提供独立的质量门禁、目标评估和人工接管。

```text
用户 / 团队成员
       │ 目标、约束、决策、反馈
       ▼
Project Manager Agent
       │ 生成计划和内部任务
       ▼
┌───────────────────────────────────────────────────────┐
│                    Integrated Harness                 │
│ Context + Memory + Skills + Tasks + Permissions       │
│ Hooks + Tools + Subagents + Teams + MCP + Workflows   │
│ Background + Cron + Checkpoints + Observability      │
└───────────────┬───────────────────────────────────────┘
                ▼
          messages[] / Event Log
                │
                └──▶ 下一轮模型判断，直到 Goal Gate 允许停止
```

## 2. 统一运行模型

### 2.1 Run、Turn、Event 和 Artifact

| 对象 | 作用 | 生命周期 |
|---|---|---|
| Run | 一次目标执行，包含预算、权限、工作区和恢复点 | 可暂停、恢复、取消、完成或失败 |
| Turn | 一次模型调用及其 Tool 结果 | 属于一个 Run，按序编号 |
| Event | 用户消息、模型响应、Tool、Hook、审批、后台通知等事实 | 追加写入，不原地修改 |
| Artifact | 需求、代码、测试、报告、计划和交付包等版本化产物 | 不可变版本，引用上游来源 |
| Goal | 判断 Run 是否可以停止的可验证条件 | 可替换、暂停、清除、恢复 |

Run 的最小上下文：`runId`、`conversationId`、`projectId`、`workItemId`、`parentRunId`、`goal`、`turnIndex`、`budget`、`permissionSnapshot`、`workspaceScope`、`checkpointId` 和 `status`。

### 2.2 统一循环的边界

```text
接收输入
  → 组装上下文
  → 触发 UserPrompt / Session Hook
  → 调用模型
  → 记录模型响应
  → 若有 Tool：逐个执行并记录结果
  → 注入后台、Cron、Team 和外部事件
  → 运行 Stop / Goal Gate
  → 允许停止，或把继续原因写入 messages[] 后进入下一轮
```

只有 Harness 可以改变 Run 状态、发放权限、提交 Artifact、调度后台任务和确认停止。模型只能提出请求。

## 3. s01 Agent Loop：一个循环 + 工具 = 一个 Agent

### 实现要求

- 使用追加式 Event Store 保存每一轮的原始响应、Tool 请求、Tool 结果和状态变化。
- 为每轮分配 `turnId`、`traceId` 和幂等键；重试模型请求时不能重复执行已经成功的 Tool。
- 对模型响应做结构化解析：文本、Tool 调用、思考摘要、拒绝、错误和结束原因分开保存。
- 设置全局 `maxTurns`、Token 预算、时间预算、并发预算和连续失败上限。
- 支持用户中断、优先级消息、后台通知和团队事件在下一轮安全注入。
- 将“没有 Tool 调用”视为“本轮模型想停止”，交给 Stop/Goal Gate 判断，不直接代表整个目标完成。

### 必须保证

1. 每个 Tool 调用最多产生一个最终副作用结果。
2. 同一个 `toolUseId` 重放时返回已保存的结果。
3. 任何异常都能定位到 `runId`、`turnId` 和 `toolCallId`。
4. Run 重启后可以从最近成功事件继续，而不是依赖进程内存。

## 4. s02 Tool Use：添加工具就是添加一个处理函数

### 实现要求

Tool 必须由 Manifest、Schema、Executor、Policy 和 Observability 五部分组成：

| 部分 | 要求 |
|---|---|
| Manifest | 名称、版本、描述、风险、能力、资源范围、是否有副作用 |
| Input Schema | 严格校验类型、必填项、长度、枚举和互斥字段 |
| Executor | 在指定 Sandbox、Workspace 和 Network Scope 内执行 |
| Policy | Allow/Ask/Deny、审批要求、限流、超时、幂等和回滚 |
| Observability | 参数摘要、耗时、结果摘要、错误码、成本和审计 |

Tool 处理顺序：`解析版本 → 输入校验 → 权限决策 → PreToolUse Hook → dry-run/审批 → 执行 → 输出校验 → PostToolUse Hook → Artifact/Event`。

### 专业约束

- Tool 必须原子化、可组合，避免一个 Tool 同时做读取、决策、写入和发布。
- 大输出必须分页、截断、摘要，并保留可恢复的完整输出地址。
- Tool 的外部副作用必须有幂等键和状态查询接口。
- Tool 名称、Schema 和能力版本化；禁止静默改变输入或输出语义。
- 新增 Tool 前优先检查已有 Tool 是否可以通过参数复用。

## 5. s03 Permission：先设边界，再给自由

### 实现要求

采用多层策略和三态决策：`allow`、`ask`、`deny`。策略来源按优先级合并：平台托管 → 组织 → 用户 → 项目共享 → 项目本地 → Run 限制。`deny` 不能被更窄的 `allow` 绕过。

每次动作都计算：

```text
Decision(subject, action, resource, project, run, context)
```

决策至少考虑：Agent 角色、Skill、Tool、路径、命令、网络域名、数据表、外部项目、环境、风险等级、审批令牌和职责分离。

### 专业约束

- 权限由运行时执行，Prompt 和 AGENTS.md 只能影响模型意图，不能授予权限。
- 权限快照在 Skill 激活、Subagent 派发、Tool 调用、审批和配置变更后重新计算。
- 异步 Agent 没有交互式终端时，遇到 `ask` 必须失败关闭并回到项目经理，而不是绕过审批。
- 文件范围、工作区、网络和外部连接必须分别授权。
- 生产发布、删除、权限变更、外部写入和批量更新必须有预览、审批和审计。

## 6. s04 Hooks：在循环周围挂钩子，而非重写循环

### 实现要求

Hook 是版本化事件处理器，可以是 Command、HTTP、MCP、Prompt 或 Agent。Hook 不直接修改主循环，而是返回标准决策：`allow`、`deny`、`ask`、`modify`、`inject_context` 或 `observe`。

必须区分三类 Hook：

- **阻断 Hook**：权限、密钥扫描、路径校验、审批和数据完整性；默认 fail-closed。
- **变更 Hook**：补充参数、脱敏、标准化和上下文注入；必须记录修改前后差异。
- **观测 Hook**：日志、指标、通知和审计；失败可以记录后继续。

### 事件集合

`SessionStart`、`UserPromptSubmit`、`PlanBefore`、`SkillActivateBefore`、`AgentStart`、`PreToolUse`、`PermissionRequest`、`PostToolUse`、`ToolFailure`、`TaskCreated`、`TaskCompleted`、`SubagentStart`、`SubagentStop`、`MergeBefore`、`PreCompact`、`PostCompact`、`Stop`、`GoalEvaluate`、`SessionEnd`。

### 专业约束

- Hook 必须有超时、重试上限、优先级、失败策略和递归保护。
- Hook 不应再次隐式触发同一个事件；需要递归时必须携带深度和来源。
- Hook 输出不能直接成为权限授予依据，必须重新进入 Permission Engine。
- Hook 运行结果写入 Event Store，支持回放和故障定位。

## 7. s05 TodoWrite：先计划，再执行

### 实现要求

Todo 是短期计划，不等同于持久化 Task Graph：

- Todo 记录当前 Turn 需要完成的步骤、顺序、状态和验收条件。
- 计划必须包含目标、非目标、依赖、风险、预计 Tool 和完成证据。
- 计划变更必须记录原因；重大变更触发 `PlanChanged` 事件。
- Todo 可以被项目经理汇总，但不能替代跨会话任务系统。

计划状态：`draft` → `proposed` → `approved` → `executing` → `verified` → `superseded`。

计划审批绑定 `planHash`。任务认领、并发分派、外部同步和发布动作会使旧计划失效，不能继续使用过期批准。

## 8. s06 Subagent：给子任务全新的 messages[]

### 实现要求

Subagent 是隔离上下文的 Worker，不是把主会话复制一遍。分派信封必须包含：

`runId`、`parentRunId`、`role`、`goal`、`inputs`、`approvedArtifacts`、`allowedSkills`、`allowedTools`、`workspaceScope`、`budget`、`humanReviewers`、`returnSchema` 和 `handoffPolicy`。

返回信封必须包含：

`status`、`summary`、`artifacts`、`evidence`、`openQuestions`、`risks`、`tests`、`nextActions` 和 `usage`。

### 专业约束

- 默认不继承主会话全部历史，只加载必要的项目规则和输入工件。
- Subagent 的原始消息保存在独立 Session，主会话只接收摘要、证据和工件引用。
- 一次性 Subagent 解决上下文隔离；持久 Team Member 解决长期并行协作，不能混用生命周期。
- Subagent 不能直接向用户发消息、修改其他 Agent 的工作区或提升权限。

## 9. s07 Skill Loading：按需加载知识

### 实现要求

Skill 包含元数据、触发条件、指令、参考资料、模板、Tool 绑定、Hook 绑定、输入输出 Schema 和测试。上下文只加载 Skill 摘要，正文按需加载。

Skill 选择顺序：已激活 → 全局锁定 → 项目已安装 → 可信 Registry 候选 → 项目经理确认安装。

支持：

- 全局 Skill：通用安全、测试、代码规范和审计。
- 项目 Skill：领域规则、代码库约定、数据库和部署环境。
- Run Skill：单次实验或迁移，运行结束自动卸载。

### 专业约束

- Skill 版本和依赖写入 `skill-lock`，禁止运行中无提示漂移。
- 自动安装前展示来源、签名、摘要、许可证、依赖、权限和影响范围。
- Skill 不能自行扩大 Tool 权限，所有 Tool 调用重新经过 Permission Engine。
- Skill 正文应短而可执行；大型参考资料使用附属文件和检索，不全部塞入系统 Prompt。

## 10. s08 Context Compact：上下文总会满

### 实现要求

采用分层压缩流水线：

```text
完整 Event Archive
  → Tool Result Snip
  → 已消费结果 Micro Compact
  → 老消息摘要
  → 重要事件/计划/未决问题重建
  → 新 Context Snapshot
```

压缩前保存完整历史地址、校验值和范围。压缩后必须保留：当前目标、验收标准、已批准决策、未完成 Todo、最新 Tool 结果、失败原因、权限状态、任务依赖和 Artifact 引用。

### 专业约束

- 不能只按字符长度截断；按消息重要性、是否已消费、是否可重建和是否影响决策排序。
- 最新完整结果、当前错误和用户最近指令优先保留。
- 压缩摘要必须标记来源和不确定性，禁止把推测写成事实。
- Prompt 过长、摘要失败或摘要模型不可用时，安全停止并请求项目经理处理。

## 11. s09 Memory：记住重要的，忘记不重要的

### 实现要求

记忆分为用户、组织、项目、Agent、Run 五个范围。每条记忆包含：内容、来源 Event、创建人、置信度、适用范围、标签、更新时间、过期时间、敏感级别和撤销状态。

记忆流水线：检索 → 相关性排序 → 权限过滤 → 注入上下文；结束时抽取候选 → 去重 → 冲突检测 → 人工/策略批准 → 归档。

### 专业约束

- 记忆不是事实数据库；关键事实必须回到 Artifact、Event 或外部权威系统。
- 禁止把密钥、Token、个人敏感数据、完整用户内容和未验证推测写入长期记忆。
- 项目记忆不能跨项目泄露；成员离开项目后按策略撤销可见性。
- 长期记忆支持 TTL、版本、纠错和删除证明。

## 12. s10 Task System：按需拆出可持久化 WorkItem

### 实现要求

Task 是用户目标，不默认创建任务图。只有需要独立队列、依赖关系、责任分派、租约或调度时，才在 Task 下创建持久化 WorkItem Graph。Task 记录：`taskId`、`projectId`、`goal`、`acceptance`、`stage`、`status`、`planHash` 和 `artifacts`；WorkItem 记录：`workItemId`、`taskId`、`title`、`acceptance`、`dependsOn`、`status`、`owner`、`lease`、`workspace`、`priority` 和 `version`。

WorkItem 状态：`draft` → `ready` → `claimed` → `in_progress` → `blocked` / `completed` / `failed` / `cancelled`。WorkItem 的一次执行通过 `Session` 创建 `Run`，重试创建新 Run，不覆盖旧 Run。

### 专业约束

- 只有 WorkItem 可被队列认领；Task 不能被多个 Agent 重复认领。
- WorkItem 认领必须原子化；使用租约、版本号和过期回收，禁止两个 Agent 同时持有同一 WorkItem。
- Task 完成必须提交最终 Artifact 和验收证据，WorkItem 完成只能证明一个拆分项完成。
- WorkItem 依赖图禁止环；结构锁定后，只有项目经理可以改变依赖。
- Task、WorkItem、Session、Run、Worktree、Artifact 和外部管理系统对象必须能互相追溯。

## 13. s11 Background Tasks：慢操作放后台

### 实现要求

后台任务是持久 Job：`jobId`、进程组/容器、输入快照、环境、状态、日志地址、取消令牌、重试策略和结果 Artifact。主 Loop 立即收到 `async_launched`，Job 完成后写入 Event Store，并通过 Inbox/Notification 注入下一轮。

### 专业约束

- 只有显式 `run_in_background=true` 才能后台执行，避免模型误把关键验证放后台。
- 进程组、容器和子进程要有清理策略；外部派生进程必须记录限制。
- 结果投递至少一次，事件必须去重；重复通知不能重复业务副作用。
- 后台任务不能竞争交互式 stdin；需要审批时转为 `waiting_input`。
- Run 结束时必须明确取消、保留或转移仍在运行的 Job。

## 14. s12 Cron Scheduler：定时触发，无需人工干预

### 实现要求

Cron 使用持久化调度器，任务包含时区、开始时间、重复规则、misfire 策略、最大并发、幂等键、目标项目、目标会话、权限快照和通知策略。

投递状态：`scheduled` → `due` → `queued` → `delivered` → `acknowledged` / `retrying` / `dead_letter`。

### 专业约束

- 记录时区和夏令时规则，禁止用服务器本地时间猜测。
- 一次性任务在进入队列前持久化为 `pending_delivery`，模型调用失败时恢复队列。
- 重启后可恢复，重复触发必须通过幂等键去重。
- Cron 只能触发已授权的 Workflow/Run，不能自动获得更高权限。

## 15. s13 Agent Teams：多个 Agent 协同工作

### 实现要求

Agent Team 由 Team Coordinator、成员 Session、Mailbox、Task Board、Workspace Manager 和 Join/Review Gate 组成。团队成员有独立上下文、权限快照和工作区，可通过结构化消息通信。

```text
Project Manager
      │ Team Plan
      ▼
Team Coordinator ──┬── Backend Agent ──┐
                   ├── Frontend Agent  ├── Join / Conflict / Review
                   ├── Test Agent      ─┘
                   └── Integration Agent
```

### 专业约束

- Task 认领必须原子化，成员空闲时再扫描 ready Task，不能忙碌时抢任务。
- 每个成员的文件操作必须使用其 assignment 绑定的 Workspace。
- 消息要有 `sender`、`recipient`、`replyTo`、`priority`、`expiresAt` 和 Artifact 引用。
- Agent Team 与人类团队协作分开治理；人类审批、责任和评审不能被 Agent 消息替代。
- 并行结果合并前必须运行冲突检测、测试和 `merge.before` Hook。

## 16. s14 MCP Plugin：通过 MCP 接入外部工具

### 实现要求

MCP Gateway 负责连接生命周期、能力发现、Tool Search、认证、健康检查、断线重连、限流和输出限制。外部 Server 只提供能力，不提供授权；宿主 Permission Engine 决定能否调用。

### 专业约束

- 工具命名必须命名空间化，例如 `mcp__server__tool`，并拒绝名称冲突。
- Server、Tool、Resource、Prompt 和 Channel 都要有独立信任状态和权限范围。
- 外部内容视为不可信输入，不能覆盖 AGENTS.md、项目策略或系统 Prompt。
- 远程 Tool 支持超时、重试、断线恢复、输出截断和敏感信息扫描。
- 对外部需求、Bug、开发任务的同步由 Integration Service 负责，MCP 只是连接层。

## 17. s15 Integrated Harness：多个机制，一个循环

### 实现要求

每轮模型调用前后必须遵守固定事件顺序：

```text
UserPromptSubmit
  → External / Cron / Background / Team event drain
  → Context Assemble
  → Memory + Skill + MCP capability snapshot
  → Compaction check
  → Model call
  → PreToolUse + Permission
  → Tool / Subagent / Workflow execution
  → PostToolUse
  → Event persist + Artifact commit
  → Stop / Goal Gate
```

集成 Harness 不能把每个机制变成独立循环，否则会出现重复审批、重复消息、状态不一致和无法恢复的问题。所有机制必须共享：Run ID、Event Store、Permission Engine、Context Snapshot、Task Identity 和 Trace。

## 18. s16 Workflow Runtime：固定编排流程用代码实现

### 实现要求

Workflow 只能从宿主注册表选择，模型不能直接上传或执行任意脚本。Workflow 元数据包含：名称、版本、输入 Schema、输出 Schema、权限、阶段、并发上限、超时、恢复策略和人工门禁。

Workflow 节点支持：`agent`、`tool`、`parallel`、`pipeline`、`join`、`verify`、`approval`、`retry`、`publish`。

每个调用使用稳定 Call Key：基于 Workflow 版本、节点类型、标签、输入和 Schema 的哈希，不依赖并发完成顺序。Resume 时命中 Journal 的成功节点缓存，只重跑变化节点及其下游依赖。

### 专业约束

- 固定编排用 Workflow；探索性下一步仍交给主 Agent Loop。
- Workflow 运行必须有 Journal、事件流、阶段进度、取消和恢复。
- 结构化输出按 Schema 校验，单个 Agent 失败不能污染整个结果。
- Workflow 版本变更后默认新建 Run；旧 Run 使用原版本恢复。

## 19. s17 Goal Loop：由目标决定循环何时停止

### 实现要求

Goal 必须可检查，包含：

1. 目标终态。
2. 证明终态的命令、Artifact 或外部状态。
3. 不得违反的约束。
4. 最大连续阻塞次数、最大总 Turn、预算和超时。

Goal Evaluator 使用独立模型或规则引擎，只能读取经过脱敏和压缩的会话证据，不能自行调用 Tool。它返回：`satisfied`、`continue`、`defer`、`impossible` 或 `error`。

### 专业约束

- “本轮没有 Tool 调用”不等于“项目完成”。
- 后台任务、Workflow 和外部同步仍在运行时，Goal Gate 必须返回 `defer`。
- Evaluator 不能接受没有命令输出、测试报告或 Artifact 证据的口头声明。
- 达到预算、Turn 或连续阻塞上限时，停止自动继续并把控制权交给用户。
- Evaluator 出错时不能声称完成；保持 Goal 活跃并报告无法判断的原因。

## 20. 17 个机制的专业组合关系

```text
基础循环：s01 + s02 + s03 + s04
计划与知识：s05 + s07 + s08 + s09
持久任务：s10 + s11 + s12
并发协作：s06 + s13 + s14
统一运行时：s15
固定编排：s16
完成判定：s17
```

推荐执行顺序：

1. 先建立 s01–s04 的最小可信执行边界。
2. 加入 s05、s07–s09，让 Agent 能计划、按需获取知识并控制上下文。
3. 加入 s10–s12，保证长任务、后台任务和定时任务可恢复。
4. 加入 s06、s13、s14，支持隔离协作和外部能力。
5. 用 s15 统一事件、权限、上下文、任务和审计。
6. 用 s16 固化重复编排，用 s17 判断整个目标是否真正完成。

## 21. 跨机制生产级验收清单

- [ ] 任意 Run 都能从 Event Store 和 Checkpoint 恢复。
- [ ] 任意 Tool 调用都有 Schema、权限决策、Hook 结果和审计记录。
- [ ] 所有异步任务都有持久状态、取消、重试、去重和结果通知。
- [ ] 所有 Subagent 都有独立上下文、权限快照、预算和返回 Schema。
- [ ] Skill、MCP、Workflow 和外部连接都经过版本、来源、信任和权限校验。
- [ ] 并发 Task 认领原子化，代码工作区和 Artifact 版本不会互相覆盖。
- [ ] Context Compact 保留目标、验收、决策、错误、任务和最新证据。
- [ ] Memory 有来源、权限、TTL、撤销和冲突处理。
- [ ] Goal Evaluator 只基于证据判断，不把模型口头声明当作事实。
- [ ] 项目经理是唯一用户交付入口，内部 Agent 不直接承诺结果。
- [ ] 人类团队成员可以评论、评审、审批、交接和接管 Agent 任务。
- [ ] 所有高风险动作都具备预览、人工确认和回滚路径。

## 22. 执行与协作扩展

上述 s01–s17 机制必须运行在受控 Daemon 和统一交付模型上：

- Daemon 负责本地/远程 Agent 进程、Session、Worktree、命令执行、心跳和断网事件 Outbox。
- Task、Session、Artifact、Worktree 必须分离建模，一个 Task 可以拥有多个不同角色、模型和 Daemon 的 Session。
- 复杂 Task 默认经过 Questions、Research、Design、Structure、Plan、Implement 六个阶段；阶段产物和 `planHash` 是后续执行的前置条件。
- Artifact 必须支持版本、差异、评论、评审、引用和 Agent 回写，不能把交付成果只保存在聊天记录中。
- 多人可以实时查看 Task、Session、Worktree 和 Artifact，进行评论、评审、审批、接管和交接；这些动作全部进入统一事件流和权限门禁。

Session 执行由 Agent Runtime Gateway 统一管理：Codex 使用 Codex App Server，Claude 使用 Claude Agent SDK，Gemini、DeepSeek、Qwen、智谱和中转站使用独立 Adapter。Session 可以运行在本机环境或云端隔离容器中，并支持原生登录、官方 API Key 和中转站 API/Key 三种认证模式。不同 Runtime 的原生事件必须转换为统一的 Session Event、Tool、Permission、Artifact 和 Checkpoint 协议。

详细字段、状态机、接口和验收清单见 [`docs/execution-and-collaboration-design.md`](execution-and-collaboration-design.md)。

