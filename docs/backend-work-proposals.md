# 项目经理工作提案后端接口与交付记录

## 1. 能力边界

本轮只交付后端，不修改 Vue、CSS、前端请求客户端或页面流程。客户端可通过 HTTP 让项目经理生成结构化提案，再明确确认该版本，由控制面创建真实任务与问题确认工件。

生成仍使用原有 Codex App Server 或 Qwen Adapter，`tools=[]`，不写项目工作区、不批准阶段、不创建执行作业。确认只建立 `questions/active` Task 和 `questions/draft/pending` Artifact，不等于批准工件。后续审批和阶段推进继续走既有门禁。

本轮没有新增数据库表或迁移。对话、提案保存在本机 `.titan/project-manager/` 私有历史，Task/Artifact 元数据、Outbox、审计和幂等结果由 PostgreSQL 维护。工件正文使用既有受控文件存储。

## 2. 生成提案

`POST /local-api/projects/:projectId/conversation/turns`

本机网关鉴权要求与现有问答一致：回环 Host、同源 `Origin`、`Content-Type: application/json` 和 `X-Titan-CSRF`。CSRF 可从 `GET /local-api/status` 取得；模型凭证由 Keychain 在后端解析，不放入请求。客户端不能自报项目上下文。

| 字段 | 类型 | 必填 | 规则 |
| --- | --- | --- | --- |
| `requestId` | UUID | 是 | 同项目幂等；同 ID 改内容返回冲突 |
| `text` | string | 是 | trim 后 1–4000 字；禁止凭证及服务 URL |
| `provider` | enum | 是 | `codex` 或 `qwen` |
| `modelRef` | string | 否 | 1–120 字，原模型名字符白名单 |
| `mode` | literal | 提案必填 | `work-proposal`；省略保持原只读问答 |

请求示例：

```json
{
  "requestId": "95ed9110-47c9-4c89-8976-e011a5e87249",
  "text": "为退款进度建立一个可验收目标，整理问题确认草稿，未知事项标为待确认。",
  "provider": "qwen",
  "mode": "work-proposal"
}
```

返回 `202` 和项目历史快照 `{ projectId, turns }`，表示已接纳，不表示模型已生成结果。使用 `GET /local-api/projects/:projectId/conversation` 读取状态；读取不启动模型。支持原取消接口 `POST .../conversation/cancel`，正文 `{ turnId }`。

提案完成回合新增字段：

| 字段 | 类型 | 规则 |
| --- | --- | --- |
| `mode` | literal | `work-proposal` |
| `proposal` | object | 仅 completed 的合法提案才生成 |
| `proposalChecksum` | string | `sha256:` 加 64 位小写十六进制 |
| `reply` | string | 安全摘要，说明尚未创建任务 |
| `errorCode` | enum | 失败时可为 `CONVERSATION_PROPOSAL_INVALID`；不返回模型原始错误 |

`proposal` 结构：

| 字段 | 类型 | 必填 | 规则 |
| --- | --- | --- | --- |
| `title` | string | 是 | trim 后 1–120 字 |
| `goal` | string | 是 | trim 后 1–2000 字 |
| `acceptanceCriteria` | string[] | 是 | 1–20 项，每项 trim 后 1–500 字 |
| `priority` | enum | 是 | `low/medium/high/critical` |
| `questions` | string | 是 | trim 后 1–8000 字，问题确认 Markdown |

禁止额外字段。文本解码后检测凭证模式和服务 URL，Daemon 再检测当前实际 Key 和 Provider URL；JSON Unicode 转义不能绕过检查。非法 JSON、额外权限字段、超长或敏感输出使回合失败，无可确认提案，不自动重试付费调用。

## 3. 确认提案

`POST /local-api/projects/:projectId/conversation/accept`

必须满足同源、JSON 和 CSRF。请求仅允许以下字段：

| 字段 | 类型 | 必填 | 规则 |
| --- | --- | --- | --- |
| `turnId` | UUID | 是 | 当前项目已完成、mode=work-proposal 的历史回合 |
| `proposalChecksum` | string | 是 | 必须匹配该回合保存的规范提案校验和 |
| `confirmed` | literal | 是 | 只能为 `true` |

客户端不得发送替换正文、目标 Task/Artifact ID、执行参数或审批状态。网关从私有历史读取提案并复核 checksum，再调用控制面。

请求示例（`turnId` 应使用实际读取到的回合 ID）：

```json
{
  "turnId": "7b587452-bb79-439d-8b08-9e72487cd58f",
  "proposalChecksum": "sha256:503ed35bbf9d2e34b9cf647bb2169c7192cda895eac4ab0608ee35f418116f21",
  "confirmed": true
}
```

该 checksum 对应下面规范 JSON，实际集成直接使用服务端返回的 checksum，不从展示摘要重新计算：

```json
{"title":"退款进度目标","goal":"减少重复咨询","acceptanceCriteria":["客户可查进度"],"priority":"medium","questions":"# 问题确认\n交付可追溯的退款状态。"}
```

规范化由 `workProposalSchema.parse` 完成，字段顺序固定为 title、goal、acceptanceCriteria、priority、questions，使用 `JSON.stringify` 的 UTF-8 字节计算 SHA-256。

成功及重放均返回 `201`：

| 返回字段 | 内容 |
| --- | --- |
| `sourceTurnId` | 被确认的来源回合 UUID |
| `proposalChecksum` | 被确认的提案校验和 |
| `task` | 标准 Task：id、projectId、title、goal、acceptanceCriteria、priority、stage、status、version、createdAt |
| `artifact` | 标准 Artifact：artifactId、projectId、taskId、type、version、schemaVersion、uri、checksum、status、reviewState、sourceArtifacts、createdBy、createdAt |

`task.stage=questions`、`task.status=active`、`artifact.type=questions`、`artifact.status=draft`、`artifact.reviewState=pending`。原始响应可用于既有查询、正文读取和审批接口；重放返回初次接纳的创建快照，读取当前可变状态使用标准 Task/Artifact 查询接口。

## 4. 控制面接口与原子性

`POST /api/projects/:projectId/work-proposals/accept`

此入口仅供可信后端直接调用，需要独立于模型凭证的 Console Bearer。它接受 `{ sourceTurnId, proposalChecksum, proposal, confirmed: true }`，仍需严格字段与 checksum 校验。它信任已认证调用者提供的来源，不独立读取本机历史，也不能证明模型判断正确。

浏览器侧通用 `/api/` 代理对 `/api/projects/:projectId/work-proposals` 全部路径返回 `403 PROPOSAL_CONFIRMATION_REQUIRED`，不能借代理自动附加 Bearer 绕过历史确认。浏览器必须通过本机 `/local-api/` 确认入口。

确认事务先锁定项目，以 `project:${projectId}:work-proposal` 和 `sourceTurnId` 固定去重。更换 HTTP `Idempotency-Key` 不会创建新任务。同来源异规范正文返回 `409 IDEMPOTENCY_CONFLICT`。同来源同正文在并发、响应丢失或重启后重放原结果。

TasksService、ArtifactsService、`task.created`、`artifact.created`、`work_proposal.accepted`、Outbox、审计和幂等记录共用一个事务。`work_proposal.accepted` 与审计只保存来源回合、校验和、项目/任务/工件 ID 及操作者，不保存模型 Prompt 或原始回复。接纳失败时回滚数据库写入；已有工件文件写入机制可能留下无数据库引用的私有孤立文件，本轮不引入自动删除。

## 5. 错误与恢复

| 情况 | 状态或错误码 | 恢复方式 |
| --- | --- | --- |
| 来源/Host 不符、缺少 CSRF | 403 `LOCAL_ORIGIN_REQUIRED/CSRF_INVALID` | 读取最新本机状态，使用同源请求 |
| 未完成、失败、已取消、checksum 不符 | 409 `CONVERSATION_PROPOSAL_CONFLICT` | 重新读取该项目历史，审阅完成的版本 |
| 项目或回合不存在 | 404 `NOT_FOUND` | 核对项目和回合；历史只保留最近 40 回合 |
| 替换正文、缺少确认、额外字段 | 400 `INVALID_REQUEST` | 仅提交三个允许字段 |
| 模型输出非法或敏感 | 回合 failed，`CONVERSATION_PROPOSAL_INVALID` | 修正目标后显式重新生成；不自动重试 |
| 控制面不可用或确认超时 | 503 `CONTROL_PLANE_UNAVAILABLE` | 使用同一回合和 checksum 重试，防止重复创建 |
| 直接控制面缺少/错误 Bearer | 401 | 仅由可信后端注入身份 |
| 直接控制面 checksum 不符 | 400 `VALIDATION_FAILED` | 使用规范提案和正确 checksum |
| 同来源修改正文再次确认 | 409 `IDEMPOTENCY_CONFLICT` | 不覆盖既有任务，生成新的提案 |

取消先于持久完成被接受时，即使模型已经返回文本，也会保存 cancelled，不能确认。超时和崩溃恢复为失败，均不自动产生任务或重新调用模型。超过历史保留窗口的未确认提案不保证可恢复；已确认任务由控制面长期维护。

## 6. 本轮验证

环境为 Node.js 24.22.3 与本机 PostgreSQL；模型使用明确的离线夹具，没有付费模型调用，没有修改生产配置或数据结构。

| 范围 | 通过数量 |
| --- | --- |
| 控制面全部非进程级测试，含提案确认 | 185 |
| 原生模型 Runtime 完整包 | 66 |
| Daemon，排除三项本轮无关 Docker 集成文件 | 161 |
| 契约与 OpenAPI/Proto | 54 |
| 网关所在包及旧问答回归 | 69 |
| 提案后端真实 PostgreSQL 全链路 | 1 |
| 总计 | 536 |

以上选定范围无失败、无跳过；没有把未运行的进程级、Temporal 或 Docker 完整验收计入。全仓无缓存构建、类型与静态检查 33/33 任务通过，OpenAPI 一致性及 `git diff --check` 通过。最终只读评审为 `approve`，两项安全缺陷均先复现后修复并复核。

全链路覆盖：生成 → 私有历史恢复 → 正文确认 → 真实任务及待审批工件 → 重复确认返回相同 ID。并发确认 6 次只创建一份；工件失败回滚任务、事件和幂等记录后可重试。另验证 Unicode 转义的实际凭证不会进入快照或磁盘历史、通用 API 确认旁路被拒绝。

```bash
pnpm exec turbo run build typecheck lint --force --output-logs=errors-only
pnpm --filter @titan/contracts exec vitest run --maxWorkers=1
pnpm --filter @titan/agent-runtime exec vitest run --maxWorkers=1
pnpm --filter @titan/daemon exec vitest run --exclude 'test/cloud/*.integration.test.ts' --maxWorkers=1 --testTimeout=30000
pnpm --filter @titan/web-console exec vitest run --maxWorkers=1 --testTimeout=30000
DATABASE_URL=postgresql://titan:titan@127.0.0.1:55432/titan pnpm --filter @titan/control-plane exec vitest run --exclude 'test/*e2e.test.ts' --maxWorkers=1 --testTimeout=30000
DATABASE_URL=postgresql://titan:titan@127.0.0.1:55432/titan pnpm --filter @titan/control-plane exec vitest run test/work-proposals.e2e.test.ts --maxWorkers=1 --testTimeout=30000
node packages/contracts/openapi/generate.mjs --check
```
