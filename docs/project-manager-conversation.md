# 项目经理本机对话：操作与验收

## 使用方式

1. 运行 `pnpm ui`，打开正式项目工作台。
2. 进入“项目”，选择一个项目，点击“询问项目经理”。
3. 选择 Codex 或 Qwen，可填写账户有权限的模型名称；留空使用适配器默认模型。
4. 输入问题并点击“发送问题”。仅此操作可能产生模型调用费用，打开面板、读取历史和刷新不会调用模型。
5. 回复期间可以“停止回复”；已发送的问题和最终状态保留在历史中。刷新页面后再次打开相同项目即可继续查看。

缺少凭证时，“配置模型”会跳转现有环境设置。Codex 使用 `keychain://titan-openai` 和 `keychain://titan-openai-base-url`；Qwen 使用 `keychain://titan-qwen`。不接受浏览器直接传入 Key、API URL、工具权限、执行预算或 Provider 配置。

## 能力与权限

本轮交付为本机只读咨询：模型基于项目名称、目标、最多 20 个工作阶段与最近对话节选回答。它不读取项目工作区、不执行工具、不创建 Run、不修改文件，也不批准或推进阶段。建议的后续操作仍通过正式产品原有审批入口完成，不把模型声称的完成当作业务事实。

后续后端增量已支持显式 `mode=work-proposal` 生成结构化工作提案，再由客户端确认具体 checksum 后原子创建任务与待审批的问题确认工件。默认问答仍保持上述只读语义；没有新增前端按钮。完整字段、确认安全边界和 536 项相关验收证据见 [工作提案后端接口](backend-work-proposals.md)。

Codex 继续复用原生 App Server、Thread、Turn 及其取消机制，未改为普通 Responses API 直连。每轮从有限历史重建对话上下文，不宣称维持同一个跨重启原生 Thread。Qwen 使用原有官方适配器。

对话独立于任务执行 Session/Run，由对话专用 Daemon 托管。它只接受父进程 IPC，不监听网络，不消费普通执行队列。打开历史不会顺便启动或认领代码执行作业。

## 本机历史与恢复

- 存储目录为项目根目录下 `.titan/project-manager/`，目录权限 `0700`，记录文件权限 `0600`。项目 ID 哈希后用作文件名，读取拒绝符号链接，写入采用临时文件、同步和原子替换。
- 每个项目保留最近 40 个问答回合；幂等恢复基于该保留窗口。同一请求 ID 和相同内容返回既有回合，内容不同则拒绝，不重复调用模型。
- 每个项目最多一个活动回合，本机最多同时两个模型调用。凭证读取最长 5 秒，IPC 新发送接纳预算 10 秒，模型回合最长 120 秒。
- 服务关闭时先取消活动回复与凭证读取，再等待状态保存。进程崩溃遗留的回合在下次读取时标记为中断，不自动重试产生费用。
- 问题最多 4000 字，回复最多 16000 字；模型仅收到最近 10 轮的有界节选。历史文件上限 4 MiB。
- 历史属于本机私有状态，不进入 PostgreSQL 业务表或 Temporal History。不会将完整 Prompt、项目上下文快照、模型原始错误或工具输出写入业务事件。

问题中不接受 HTTP/WebSocket URL 或凭证形态的文本，防止误贴私有服务地址或 Key。项目摘要、历史节选和回复中的 URL 会去除；已解析的模型凭证和 URL 以及其他凭证模式会被隐藏。URL 配置请使用环境设置，对话中使用文字说明目标。

## 本机接口

所有接口只在已有回环网关提供。变更请求要求同源 JSON 和 `X-Titan-CSRF`，网关从控制面确认项目存在，并构造安全字段的上下文，不接受客户端自报项目上下文。

| 方法 | 路径 | 字段与返回 |
| --- | --- | --- |
| GET | `/local-api/projects/:projectId/conversation` | 返回 `{ projectId, turns }`，只读取历史 |
| POST | `/local-api/projects/:projectId/conversation/turns` | 严格输入 `{ requestId, text, provider, modelRef? }`；`requestId` 为 UUID，`provider` 为 `codex/qwen`；返回 202 与已接受的历史快照 |
| POST | `/local-api/projects/:projectId/conversation/cancel` | 严格输入 `{ turnId }`；只取消本项目匹配的当前回合，返回最新快照 |

回合包含 `id`、`requestId`、请求指纹、用户问题、提供方、可选模型名、状态、可选回复、创建/结束时间及固定错误码。状态为 `running/completed/failed/cancelled`。202 表示已接受，不表示模型已回复；前端在运行期间轮询历史，成功回复或终止后停止轮询。

| 错误 | 含义与处理 |
| --- | --- |
| `CONVERSATION_CREDENTIAL_REQUIRED` | 未配置所选模型凭证或 Codex URL，前往环境设置 |
| `CONVERSATION_SENSITIVE_INPUT` | 问题可能包含凭证或 URL，移除后重新发送 |
| `CONVERSATION_BUSY` | 项目正在回复或本机并发已满，等待或停止当前回合 |
| `CONVERSATION_REQUEST_CONFLICT` | 请求 ID 已用于不同内容，重新编辑并生成新请求 |
| `CONVERSATION_UNAVAILABLE` | Daemon 未就绪、接纳超时或关闭，刷新后重试 |
| `CONVERSATION_HISTORY_INVALID` | 历史文件无法安全读取，不覆盖或忽略损坏记录 |
| `CONVERSATION_TIMEOUT/INTERRUPTED/FAILED/READ_ONLY` | 回合终止原因，历史保留，不自动调用模型重试 |

## 验证证据

环境：Node.js 24.22.3、真实 Chrome、本机 PostgreSQL。全仓无缓存构建、类型与静态检查 33/33 任务通过，OpenAPI 生成结果一致。

| 范围 | 通过数量 |
| --- | --- |
| Agent Runtime 包完整回归，含 6 项新对话测试 | 65 |
| Daemon 回归，含 15 项对话测试 | 155 |
| 正式产品、网关及真实 IPC 生命周期回归 | 64 |
| 共享契约与 OpenAPI/Proto 回归 | 50 |
| 合计 | 334 |

以上用例无失败、无跳过；Daemon 命令显式排除了本轮无关的三个 Docker 集成测试文件，未把它们计入通过数量。未执行真实付费模型调用。

浏览器通过真实控制面、真实对话历史服务与 RuntimeAdapter 接口，模型使用明确标记“离线验收回复”的夹具。已验证：发送 → 回复 → 刷新恢复历史 → 再次发送 → 停止回复；375、768、1024、1440 屏宽无横向溢出，`pageerror=0`。独立子进程 IPC 测试验证并发启动握手、读取、关闭和重新启动。

```bash
pnpm exec turbo run build typecheck lint --force --output-logs=errors-only
pnpm --filter @titan/agent-runtime exec vitest run --maxWorkers=1
pnpm --filter @titan/daemon exec vitest run --exclude 'test/cloud/*.integration.test.ts' --maxWorkers=1 --testTimeout=30000
pnpm --filter @titan/web-console exec vitest run --maxWorkers=1 --testTimeout=30000
pnpm --filter @titan/contracts exec vitest run --maxWorkers=1
node packages/contracts/openapi/generate.mjs --check
```

浏览器夹具：`apps/web-console/test/fixtures/manager-server.mjs`；脚本：`apps/web-console/test/manager-browser-smoke.py`。使用本机 Chrome 和 Python Playwright，端口 5177/3341。截图工件为 `manager-conversation-375.png`、`manager-conversation-768.png`、`manager-conversation-1024.png`、`manager-conversation-1440.png`。夹具历史位于独立的 `.titan/manager-browser-history/`，不会作为真实模型回复出现在正式对话历史中。
