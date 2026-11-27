# 项目经理本机对话设计与实施计划

## 目标与边界

接通正式项目空间的项目经理问答，支持按项目保存历史、明确选择模型、请求幂等、取消、刷新恢复及安全错误反馈。沿用单用户、本机网关的授权边界，不扩展公网或多人权限。用户已授权后续设计默认同意并完成提交、推送。

采用本机对话专用 Daemon 通道：网关校验来源、CSRF 和项目归属；受控子进程承载问答，通过现有 RuntimeAdapter 调用模型。Codex 继续使用原生 App Server，Qwen 使用原有适配器。模型只获得项目目标、工作阶段和最近对话，不获得文件工具、审批或写入权限。发送问题才可能调用付费模型，读取历史和打开面板不发模型请求。

对话不是执行 Run，不创建隐式任务、不绕过已批准计划，也不自动推进阶段。原始对话文本存入本机 `0700` 私有目录下的 `0600` 文件；业务数据库和 Temporal 不接收消息、Prompt 或 Key。Key 和 Codex URL 只在 Daemon 内通过固定 Keychain 引用解析，不接受浏览器传入凭证、URL 或工具权限。上下文来自控制面的安全字段，模型建议以建议呈现，真实操作继续走原有审批。

## 模块与接口

- `packages/contracts/src/conversation.ts`：输入、上下文、回合和快照的严格协议。
- `apps/agent-runtime/src/conversation.ts`：有限预算的只读模型调用；复用凭证和适配器；取消时关闭原生会话。
- `apps/daemon/src/conversations.ts`：私有文件历史、同项目串行、全局并发上限、幂等、取消、重启中断收敛。
- `apps/daemon/src/conversation-cli.ts`：仅通过受控 IPC 提供读取、发送和取消，不监听网络。
- `apps/web-console/server/conversations.mjs`：启动与关闭对话 Daemon、关联 IPC 请求、进程退出和超时处理。
- 现有 `gateway.mjs`：认证项目上下文并转发本机协议。
- `ManagerConversation.vue`：历史、模型选择、输入、正在回复、取消、重试、安全错误和移动布局。

接口：

| 方法 | 路径 | 行为 |
| --- | --- | --- |
| GET | `/local-api/projects/:projectId/conversation` | 读取本机对话，不调用模型 |
| POST | `/local-api/projects/:projectId/conversation/turns` | `{ requestId, text, provider, modelRef? }`，幂等接受一轮问答 |
| POST | `/local-api/projects/:projectId/conversation/cancel` | `{ turnId }`，仅取消本项目当前回合 |

每个项目最多一个进行中回合，同 Daemon 最多两个模型调用。每轮最长 120 秒，输入 4000 字，模型回复最多 16000 字，保留最近 40 回合；上下文仅使用最近 10 轮和有界项目摘要。重启后中断回合标记失败，不自动重试计费。未知错误只展示固定错误码文案。

## 实施与验证

- [x] 先写只读模型调用失败测试，再实现完成、取消、工具拒绝、敏感内容与错误边界。
- [x] 先写历史持久化、幂等、并发、取消、重启、路径与文件权限失败测试，再实现 Daemon。
- [x] 先写网关来源/CSRF/项目隔离测试，再实现 IPC 通道和路由。
- [x] 先写正式对话组件测试，再接入面板，替代原状态摘要入口。
- [x] 执行相关包测试、全仓构建/类型/静态检查及真实 Chrome 离线验收；没有可用 Provider 授权时不伪称付费模型验收成功。
- [x] 只读评审后修复问题，更新中文验收记录，合并、中文提交、通过代理推送，清理已完成工作树。

验证：相关包 334 项测试通过；无缓存构建、类型和静态检查共 33 项任务通过；真实 IPC 启动关闭/重启及四屏宽浏览器通过，最终只读评审 `approve`。幂等查找先于新请求截止检查，已接受回合在 ACK 丢失后仍可定位；关闭会中止活动回复与凭证读取。问答不接受 URL，摘要/历史/回复中的 URL 与凭证被去除。具体结果和能力边界见 `docs/project-manager-conversation.md`。

交付：实现提交 `b6c780c`、`cb45254` 已合并并推送至 `origin/chore/initial-project`。主工作区重建及 64 项前端测试通过；原 `5175` 预览已安全更新，真实 Chrome 验证对话面板和生产 IPC 历史读取正常，未调用付费模型。本轮 `project-manager-chat` 工作树已清理，用户未跟踪文件保持原样。
