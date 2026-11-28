# 项目经理工作提案后端设计

## 目标与范围

按用户最新要求只实现后端：把现有只读咨询扩展为可校验的工作提案，显式确认后创建真实任务和问题确认草稿。沿用 Codex App Server、Qwen Adapter、对话 Daemon、Keychain、项目上下文、取消和恢复机制。不修改 Vue、CSS 或其他前端页面，不接入自动审批或自动代码执行。

## 方案与边界

采用“生成提案 → 确认版本 → 原子落库”。模型直接写业务数据会绕过权限和审批，用户手动复制问答又无法保证来源和幂等；因此模型仅返回严格 JSON，Daemon 校验后保存结构化提案，控制面只接受明确确认的业务草稿。

对话请求新增可选 `mode: work-proposal`。省略时维持原只读问答。提案字段为 `title`、`goal`、`acceptanceCriteria`、`priority`、`questions`，不接受工具、URL、凭证、审批状态和执行配置。长度和数组数量有上限。提案回合保留模型响应摘要和校验后的结构，不持久化组装 Prompt；生成失败、取消或中断不得留下可确认提案。

确认入口为 `POST /local-api/projects/:projectId/conversation/accept`，请求仅含 `turnId`、`proposalChecksum`、`confirmed: true`。同源 JSON 与 CSRF 验证后，网关从本项目私有历史读取已完成提案，比较规范 JSON 的 SHA-256，再调用控制面。客户端不能替换提案正文或指定 Task/Artifact ID。

控制面入口为 `POST /api/projects/:projectId/work-proposals/accept`，使用 Console Bearer，输入为 `sourceTurnId`、`proposalChecksum`、`proposal`、`confirmed: true`。校验规范提案的 SHA-256；以项目＋来源回合唯一范围重放结果，不接受改正文或换幂等键重复创建。事务内锁定 project，再复用 TasksService 与 ArtifactsService 的受限事务入口，创建 questions 阶段任务及 pending/draft 工件。成功事件只记录来源回合、checksum 和对象 ID，不能记录模型原始回复、完整 Prompt 或密钥。

任务和工件全部成功后才提交，失败回滚业务记录及幂等响应。文件内容采用已有工件存储；文件写入后事务回滚可能保留不被数据库引用的私有孤立文件，与已有工件写入语义一致，不自动删除文件。无新业务表，无数据库迁移。已有服务公开接口不变。

## 验收

- 严格契约拒绝额外权限字段、空标准、超长内容、错误确认、错误校验和。
- 原生 Adapter 仍无工具，结构化回复非法时返回安全错误，不做自动模型重试。
- 同项目回合生成与重试保持既有并发、取消、历史恢复语义。
- 确认不存在/未完成/跨项目回合、校验和不符、缺少 CSRF 或 Console Bearer 均拒绝。
- 确认创建真实任务＋待审批工件；多请求并发、响应丢失后重试、换幂等键不重复；异正文冲突；工件失败时任务和事件回滚。
- 完成问答回合到真实控制面落库的无付费模型集成验收。

用户已授权后续合理设计默认同意，按上述边界直接实现、验证、评审和提交推送。
