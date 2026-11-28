# 项目经理工作提案后端实施计划

> 采用 executing-plans 逐项实现；用户已授权默认推进。先观察有意义的失败测试，再实现并验证；所有提交和文档使用中文。

**目标：** 提供无需 UI 的生成和确认工作提案 API，创建可追溯且未批准的任务与问题确认工件。

**架构：** 对话生成无副作用；Daemon 持久化严格提案；网关按来源回合取正文；控制面使用同一 PostgreSQL 事务和已有幂等服务接纳。

**技术栈：** TypeScript、Zod、Nest/Fastify、Kysely/PostgreSQL、现有 RuntimeAdapter 与本机 IPC。

## 一、契约与只读生成

- [ ] 在 `packages/contracts/test/work-proposals.test.ts` 添加严格字段、长度、确认和 checksum 测试，执行 `pnpm --filter @titan/contracts exec vitest run test/work-proposals.test.ts --maxWorkers=1`，确认缺失契约红灯。
- [ ] 创建 `packages/contracts/src/work-proposals.ts` 并从 `index.ts` 导出。结构为 `{ title, goal, acceptanceCriteria, priority, questions }`，数组必须非空且有界；确认体为 `{ turnId, proposalChecksum, confirmed: true }`。为现有 conversation request/turn 新增可选 mode/proposal/proposalChecksum 字段，不影响旧历史。
- [ ] 在 `apps/agent-runtime/test/conversation.test.ts` 测试 mode 提示和工具禁止；在 `apps/daemon/test/conversations.test.ts` 测试合法结构化结果、坏 JSON、额外权限字段、敏感内容、取消和重启恢复。失败后扩展 `conversation.ts` 和 `conversations.ts`。
- [ ] 规范化通过 Zod parse 后的 JSON 计算 SHA-256；模型原文不匹配时固定 `CONVERSATION_PROPOSAL_INVALID`，不自动重试付费调用。

## 二、控制面事务接纳

- [ ] 在 `apps/control-plane/test/work-proposals.integration.test.ts` 添加真实 DB 测试：认证、创建任务与 draft/pending 工件、相同来源并发重放、异正文冲突、checksum、缺少 confirmed、工件失败回滚。
- [ ] 将 `TasksService.create` 内部逻辑抽为 `createInTransaction(trx, projectId, input, key)`，`ArtifactsService.create` 内部逻辑抽为 `createInTransaction(trx, taskId, input, key)`，公开入口维持原事务行为。
- [ ] 新建 `modules/work-proposals/work-proposals.service.ts`、`work-proposals.controller.ts`，注册到 `app.module.ts`。接纳前验证认证和正文，在事务内 `SELECT project FOR UPDATE`，以 `project:${projectId}:work-proposal` 为 scope、`sourceTurnId` 为固定幂等键；读取既有结果后才调用两个领域服务，创建工件类型固定 `questions`。
- [ ] 事件 `work_proposal.accepted` 只记录 sourceTurnId/checksum/taskId/artifactId，操作者为已认证本机用户。无 Session、Run、执行作业或自动审批。

## 三、网关确认与协议文档

- [ ] `apps/web-console/server/gateway.mjs` 增加本机 accept POST，复用同源和 CSRF；从 `conversations.request('read', projectId)` 找本项目 completed+mode 提案，确认 checksum 后仅发送已保存结构。
- [ ] 在 `apps/web-console/test/conversation-gateway.test.ts` 添加缺少 CSRF、跨项目、未完成、checksum 不符、客户端注入正文和重试测试。只修改 server 后端，不修改任何 Vue/CSS/前端 API 客户端。
- [ ] `packages/contracts/openapi/generate.mjs` 增加控制面确认请求/结果与 ConsoleBearer；生成工件并 `--check`。
- [ ] 创建 `docs/backend-work-proposals.md`，列出完整请求/响应字段、错误码、认证、幂等、取消、恢复和验收命令。

## 四、验证与交付

- [ ] Node24 下执行契约、Runtime、Daemon、网关和控制面定向及相关回归；真实 PostgreSQL 集成测试必须连接 `127.0.0.1:55432`。
- [ ] `pnpm exec turbo run build typecheck lint --force --output-logs=errors-only`、OpenAPI `--check` 和 `git diff --check`。
- [ ] 只读评审确认工具/权限、并发重放、回滚、敏感信息和旧问答兼容。修复 P1/P2，更新实际证据；中文提交，通过代理推送。
- [ ] 验证无前端变更，保留用户未跟踪文件；合并已验证提交并清理本轮工作树。
