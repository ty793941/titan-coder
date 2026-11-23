# Codex 自定义 Provider 实施计划

> **For agentic workers:** 按任务顺序执行；每项先写失败测试，再实现最小改动，验证后提交并推送。

**Goal:** 支持兼容 OpenAI Responses API 的 Codex 自定义 URL + Key 配置，并保留原生 Codex App Server 执行协议。

**Architecture:** UI 通过本机网关把 URL/Key 分别写入 macOS Keychain；Session 只保存两个引用。Daemon 将 URL 引用传入 Runtime，Codex App Server 通过本机 Provider 配置调用自定义 Responses endpoint；Control Plane 和任务协议不保存秘密正文。

**Tech Stack:** Vue 3、Node.js 22、TypeScript、Node `security` Keychain CLI、Codex App Server stdio JSON-RPC、OpenAI Responses-compatible HTTP。

**Spec:** `docs/superpowers/specs/2026-11-23-codex-custom-provider-design.md`

## Global Constraints

- API URL 与 API Key 不得进入数据库、Prompt、Artifact、事件、日志、argv 或普通环境变量。
- Codex 必须继续通过 Codex App Server Adapter 运行；不得回退为普通 Responses 文本调用。
- 所有 URL/Key 错误必须返回稳定可行动错误；缺凭证进入 `waiting_input`。
- 只修改完成本功能所需文件；现有 Qwen、Headless 和 UI 验收行为保持兼容。
- 使用 Node 22 验证；每次逻辑增量完成后提交并通过本机代理推送。

### Task 1: Keychain URL 与执行契约

**Files:**
- Modify: `packages/daemon-protocol/src/execution.ts`
- Modify: `packages/contracts/src/schemas.ts`
- Modify: `apps/agent-runtime/src/credentials.ts`
- Modify: `apps/agent-runtime/test/credentials.test.ts`
- Test: `packages/contracts/test/schemas.test.ts`

- [ ] 写 URL 校验失败测试：拒绝凭证、密码、片段、非 HTTP(S) 和外部 HTTP。
- [ ] 写 URL 引用解析测试：`keychain://titan-openai-base-url` 读取但不回显。
- [ ] 添加 `baseUrlRef` 到 ExecutionConfig，兼容旧配置缺省值。
- [ ] 实现严格 URL 校验和 Keychain URL 读取。
- [ ] 运行 `pnpm --filter @titan/contracts test`、`pnpm --filter @titan/agent-runtime test`、typecheck。
- [ ] 提交并通过代理推送。

### Task 2: Codex App Server 自定义 Provider

**Files:**
- Modify: `packages/agent-core/src/adapters/codex-stdio-transport.ts`
- Modify: `packages/agent-core/src/adapters/provider-adapters.ts`
- Modify: `packages/agent-core/test/codex-provider.test.ts`

- [ ] 写假 App Server 测试，断言启动配置包含 provider name、base URL、Responses wire API、model provider 和 API Key env key。
- [ ] 写 URL/Key 解析失败、401、404 和成功响应测试。
- [ ] 实现 App Server 参数注入，避免把 URL/Key 写入 argv 或日志。
- [ ] 改进 RPC/Provider 错误阶段信息，保留方法和 HTTP 状态但脱敏。
- [ ] 运行 Agent Core 测试、typecheck、build。
- [ ] 提交并通过代理推送。

### Task 3: UI URL 配置与真实 HTTP 验收

**Files:**
- Modify: `apps/web-console/server/keychain.mjs`
- Modify: `apps/web-console/server/gateway.mjs`
- Modify: `apps/web-console/src/api.ts`
- Modify: `apps/web-console/src/types.ts`
- Modify: `apps/web-console/src/components/CredentialCard.vue`
- Modify: `apps/web-console/test/gateway.test.ts`
- Modify: `apps/web-console/test/credentials.test.ts`
- Modify: `docs/ui-acceptance.md`

- [ ] 写 URL 保存和状态测试，断言 Key 与 URL 分别落入不同 Keychain service。
- [ ] 写 UI 不回显 Key、URL 摘要可见、空 URL 阻止提交测试。
- [ ] 实现 `titan-openai-base-url` 的 Keychain 存取和本机 API。
- [ ] 在 Codex 卡片加入 API URL 字段与校验提示；Qwen 保持现有地域说明。
- [ ] Session 配置带 `baseUrlRef`，不带 URL/Key 正文。
- [ ] 运行 UI typecheck/build/test 与浏览器验收。
- [ ] 更新文档、提交并通过代理推送。

### Task 4: 全仓验收

- [ ] 使用 Node 22 执行 build/lint/typecheck/test/OpenAPI/Compose 校验。
- [ ] 使用假的 Responses API 服务验证自定义 URL 请求头、路径、模型和事件，不消耗真实 Key。
- [ ] 真实 Key 由用户在 UI 中输入后再执行 Codex 真实模型 Run；不在自动化测试中保存或输出 Key。
- [ ] 更新 Phase 1 报告和评审状态，提交并推送最终结果。
