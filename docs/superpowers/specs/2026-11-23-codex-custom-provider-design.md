# Codex 自定义 API Provider 设计

## 目标

让本机验收 UI 支持配置兼容 OpenAI Responses API 的 Codex API URL 与 API Key，同时继续通过 Codex App Server 原生 stdio 协议执行 Thread、Turn、Tool、Permission 和事件流程。

## 边界

- 支持 `https://` 或本机 `http://` 的兼容 Responses API Base URL；启动时规范化为去除末尾 `/` 的 Base URL，Codex Provider 自己拼接 `/v1/responses`。
- API URL 和 API Key 分别保存在 macOS Keychain：`titan-openai-base-url` 与 `titan-openai`。
- UI 只显示 URL 的协议/主机/路径摘要和凭证是否存在，不回显 Key。
- Session 使用 `credentialRef=keychain://titan-openai` 与 `baseUrl=keychain://titan-openai-base-url`。
- Daemon 只传递凭证引用和 URL 引用，不读取或写入数据库中的 Key 正文。
- App Server 使用自定义 `model_providers.titan` 配置，`wire_api=responses`、`env_key=OPENAI_API_KEY`、`requires_openai_auth=true`，并指定 `model_provider=titan`。
- Provider 错误区分 URL 解析、认证、HTTP 状态、Thread 初始化和 Turn 执行阶段。

## 安全

- URL 校验拒绝 `file:`、`javascript:`、用户名/密码、片段、换行、空主机和过长值；默认只允许 HTTPS，`127.0.0.1`/`localhost` 允许 HTTP 本机测试。
- Key 只通过进程 stdin 交给 Keychain 命令；不进入 argv、环境变量、数据库、Prompt、Artifact、事件或普通日志。
- Keychain 配置读取只返回存在状态；实际值只在 Worker 启动 Provider 时在内存中短暂存在。
- 自定义 URL 不能由任务、模型输出或远程 Dispatch 动态改变；只来自本机 Keychain 与本机 UI 配置。

## 失败行为

- URL 缺失：Session 创建前在 UI 阻止执行并提示配置 URL。
- URL/Key 任一缺失：Worker 发送 `waiting_input`，Run 不得伪造完成。
- HTTP 401/403：返回 `RUNTIME_ADAPTER_UNAVAILABLE`，消息标识 `provider authentication`。
- HTTP 404/405：返回 `RUNTIME_ADAPTER_UNAVAILABLE`，消息标识 `responses endpoint`。
- 5xx、超时和网络断开：保留错误阶段和可重试信息，按当前 Run/Daemon 重试策略处理。

## 验收

1. URL/Key 的 Keychain 存储和格式校验测试通过。
2. Codex App Server 启动参数包含自定义 Provider 配置，协议假服务器验证配置字段。
3. 自定义 Responses API 假服务器验证 URL、Authorization、模型和请求路径，且返回内容可形成 Runtime Event。
4. UI 只显示 URL 摘要和配置状态，不显示 Key。
5. 全仓测试、类型检查、构建通过；真实 Provider 推理由用户配置凭证后单独验收。
