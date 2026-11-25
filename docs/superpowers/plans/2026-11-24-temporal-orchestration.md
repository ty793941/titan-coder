# Phase 2B Temporal Orchestration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付真实 Temporal 后台任务、Worker 恢复、可靠命令投递及有限次数本机定时执行，保持现有 Daemon 和 cloud Handoff 执行契约。

**Architecture:** PostgreSQL 保存授权和业务状态，专用 workflow_command Outbox 投递 Temporal 命令。Temporal Workflow 通过短 Activity 调用控制面领域接口，通过持久 Timer 等待；模型和容器继续由 Daemon 执行。新增 `packages/workflow`、`apps/workflow-worker`，控制面采用单独 orchestration 模块，不引入重复执行队列。

**Tech Stack:** Node.js 22、TypeScript、pnpm 10.34.5、Temporal TypeScript SDK 1.26.0、NestJS/Fastify、Kysely/PostgreSQL、Zod/OpenAPI、Vitest、Docker。

---

## 共同约束与接口

执行记录（2026-11-25）：任务1–6和任务7的评审/门禁/文档已完成。实际数据库、Schedule 和命令测试集中于 `apps/control-plane/test/orchestration.integration.test.ts`、`orchestration-schema.integration.test.ts`；真实进程验收位于 `temporal-orchestration.e2e.test.ts` 和 `temporal-worker-cli.e2e.test.ts`。本机服务固定为官方 CLI 镜像1.5.1及已核验ARM64 digest。最终617项通过、无失败和跳过，详细证据见 `docs/phase-2b-review.md`。最后提交推送状态以本计划末项及 Git 远端核对结果为准。

每项按失败测试、观察红灯、最小实现、绿灯、差异检查、提交推进。数据库测试使用独立 schema，真实模型不参与验收。根工作区缺少 `.git` 文件，Git 操作沿用当前会话显式 `--git-dir`、`--work-tree`；各实现隔离工作树可使用普通 Git。用户 `docs/study.html` 始终排除。

固定 `@temporalio/client`、`worker`、`workflow`、`testing` 为 `1.26.0`。服务镜像在本地实际查验 manifest 后固定版本或 digest；不使用 latest。SDK 查询证据为 `pnpm view @temporalio/worker version --registry=https://registry.npmjs.org`。

公共 Activity 仅使用以下安全结构；不得传 Prompt、完整 Checkpoint、工具输出、凭证、宿主路径或 HTTP 原始异常：

```ts
import type { ErrorCode } from '@titan/contracts';

export type JobInput = { jobId: string; workflowVersion: 1 };
export type JobObservation = {
  jobId: string;
  status: 'pending_dispatch' | 'dispatching' | 'running' | 'waiting_input' | 'reconnecting' | 'cancel_requested' | 'completed' | 'failed' | 'cancelled' | 'expired';
  deadlineAt: string;
  runId?: string;
  errorCode?: ErrorCode;
};
export interface OrchestrationActivities {
  dispatchJob(input: JobInput): Promise<JobObservation>;
  observeJob(input: JobInput): Promise<JobObservation>;
  cancelJob(input: JobInput & { reason: 'cancelled' | 'expired' }): Promise<JobObservation>;
  failJob(input: JobInput & { errorCode: ErrorCode }): Promise<JobObservation>;
  scheduleOccurrence(input: {
    scheduleId: string; definitionVersion: number; occurrenceId: string; scheduledAt: string;
  }): Promise<{ status: 'created' | 'skipped'; jobId?: string }>;
}
```

内部接口只接受独立 Workflow 服务身份，不能把 Console/Daemon 凭证混用：

- `POST /api/internal/workflow/commands/claim`：领取固定格式命令和投递租约；无任务返回 204。
- `POST /api/internal/workflow/commands/:id/complete`、`retry`：携带领取证明确认/退避，过期证明拒绝。
- `POST /api/internal/workflow/jobs/:id/dispatch`、`cancel`、`fail`；`GET /api/internal/workflow/jobs/:id` 和 `execution`。领取命令时绑定资源身份，Activity 仅可操作同一 Worker 的任务。
- `GET /api/internal/workflow/schedules/:id`：返回脱敏定义；`POST /api/internal/workflow/schedules/:id/occurrences`：按版本及稳定触发 ID 原子接纳。

命令格式为 `{ id, claimToken, kind: 'start_job'|'cancel_job'|'sync_schedule', targetId, definitionVersion? }`。命令在数据库内领取后再调用网络，不持有事务锁等待 Temporal。任务 Workflow ID 为 `titan/background/<jobId>/v1`。

## Task 1：契约与持久化

**Files:**
- Create: `packages/contracts/src/orchestration.ts`
- Modify: `packages/contracts/src/index.ts`, `packages/contracts/src/errors.ts`
- Modify: `database/schema.sql`, `database/init-data.sql`
- Modify: `apps/control-plane/src/database/types.ts`
- Test: `packages/contracts/test/orchestration.test.ts`

- [x] 写失败契约测试：拒绝省略 `runInBackground=true`、无效时区、六字段 cron、低于一分钟 interval、无限 maxRuns、同时包含 cron/interval、任意 Workflow 名称和额外 Secret 字段。
- [x] 运行 `pnpm --filter @titan/contracts exec vitest run test/orchestration.test.ts --maxWorkers=1`，确认因新能力缺失失败。
- [x] 实现严格 Schema、4 张表和 TEXT 外键：background_job、workflow_command、execution_schedule、schedule_occurrence。增加任务/命令/触发唯一键、版本、截止时间、重试/租约和分页上限；不复用业务 outbox 发布标志。
- [x] 表中所有 Secret 字段均禁止；业务记录只保存计划哈希和资源引用。定时任务默认未启用，maxRuns 1–100，catchup 10–3600 秒，固定 overlap=skip。
- [x] 构建契约并执行契约及数据库初始化两次的幂等测试，提交领域契约。

## Task 2：后台任务与内部身份

**Files:**
- Create: `apps/control-plane/src/common/workflow-auth.ts`
- Create: `apps/control-plane/src/modules/orchestration/background-jobs.service.ts`
- Create: `apps/control-plane/src/modules/orchestration/orchestration.controller.ts`
- Modify: `apps/control-plane/src/modules/runs/runs.service.ts`, `apps/control-plane/src/app.module.ts`
- Test: `apps/control-plane/test/orchestration.integration.test.ts`

- [x] 先写 HTTP 集成失败测试：后台任务 API 接受后无 execution_job；内部 dispatch 重试返回同一 Run；observe 不能改写 cloud Run；跨 Session、过期计划、无认证及取消后派发均拒绝。
- [x] 运行 `pnpm --filter @titan/control-plane exec vitest run test/orchestration.integration.test.ts --maxWorkers=1 --testTimeout=30000`，确认缺失路由或行为红灯。
- [x] 对已有 Run 创建事务暴露受限领域入口，复用原校验；后台派发在同一事务创建 Run、execution_job、关联和事件。保留普通 cloud attempt 的禁止规则。
- [x] 服务身份从本机 Keychain 引用或受控 stdin Secret 引导到内存，测试通过依赖注入或模拟 resolver，不增加生产明文 Secret 环境变量。
- [x] 取消意图必须立即落库，重复请求保持同一状态；取消 pending 任务不能因后续迟到 start 命令启动模型。截止时间使用服务端保存值，不能被 Workflow 任意延长。
- [x] 通过集成回归后提交授权后台任务实现。

## Task 3：命令 Outbox 与调度领域

**Files:**
- Create: `apps/control-plane/src/modules/orchestration/workflow-commands.service.ts`
- Create: `apps/control-plane/src/modules/orchestration/schedules.service.ts`
- Create: `apps/control-plane/src/modules/orchestration/workflow-internal.controller.ts`
- Test: `apps/control-plane/test/orchestration.integration.test.ts`
- Test: `apps/control-plane/test/orchestration-schema.integration.test.ts`

- [x] 写失败测试覆盖投递租约竞争、过期 ACK、接受后响应丢失、定义版本覆盖、暂停与派发竞态、同触发重试、超过 maxRuns、同 Session 活动 Run、错过窗口和 Plan 失效。
- [x] 运行领域测试，确认红灯后实现领域事务；另补旧表升级回归。
- [x] 命令领取使用 skip locked、有界 lease、独立 claimToken；只有同一代次可 ACK。瞬态失败有界退避并保留错误码，永久业务错误不无限重试。
- [x] 调度定义创建固定 disabled；enable/update/pause 使用 expectedVersion 和命令 Outbox。Activity 触发时重新验证启用状态、版本、Plan、Daemon 和 Session 并发；同一个 occurrence 不重复占用 maxRuns。
- [x] schedule occurrence 在当前 Temporal Workflow 中派发业务任务，不额外投递重复 start_job；后台任务绑定该稳定 occurrence Workflow ID。
- [x] 超限、旧版本、错过窗口或重叠触发保留 skipped 原因及事件；过期 Plan 收紧授权并禁用定义。通过后提交版本调度与命令租约实现。

## Task 4：确定性 Workflow 与历史安全

**Files:**
- Create: `packages/workflow/package.json`, `packages/workflow/tsconfig.json`
- Create: `packages/workflow/src/types.ts`, `packages/workflow/src/workflows.ts`
- Create: `packages/workflow/test/workflows.test.ts`
- Modify: `pnpm-lock.yaml`

- [x] 使用官方 Temporal 测试环境写失败测试：Activity 响应丢失重试、Timer 等待、取消、deadline、waiting_input/reconnecting、不重复派发、Continue-As-New 和历史重放。
- [x] 运行 `pnpm --filter @titan/workflow exec vitest run test/workflows.test.ts --maxWorkers=1 --testTimeout=60000`，观察红灯。
- [x] 实现 `backgroundJobV1(input: JobInput)` 和 `scheduledOccurrenceV1(input: {scheduleId,definitionVersion})`。Workflow 只调用上述 Activity 接口，日志仅 ID/固定错误码，每轮观察间隔固定5秒，不接受用户传入代码或任意计时参数。
- [x] `backgroundJobV1` 首次幂等 dispatch，后续只 observe；状态终止或到期退出，等待人工状态不创建新 attempt。取消通过不可取消的短清理 Activity 写入业务取消意图，不能把 Temporal 已取消伪装成 Docker 已停止。
- [x] 调度 Workflow 从 Temporal 原生触发元数据获取 scheduledAt，稳定 Workflow ID 作 occurrenceId。Continue-As-New 继续相同业务任务，输入始终只有 ID 和版本。
- [x] 真实历史扫描合成敏感值并执行 replay，通过后提交 Workflow 实现；补 Activity 耗尽时的安全失败回报。

## Task 5：Activity Client、Dispatcher 与 Worker

**Files:**
- Create: `packages/workflow/src/control-plane-client.ts`
- Create: `packages/workflow/src/temporal-client.ts`
- Create: `packages/workflow/src/dispatcher.ts`, `packages/workflow/src/index.ts`
- Create: `apps/workflow-worker/package.json`, `apps/workflow-worker/tsconfig.json`
- Create: `apps/workflow-worker/src/config.ts`, `apps/workflow-worker/src/main.ts`
- Test: `packages/workflow/test/control-plane-client.test.ts`, `packages/workflow/test/dispatcher.test.ts`

- [x] 先写失败测试：禁止非回环 HTTP/重定向、认证仅 Header、禁止错误正文进入 Temporal、start 成功但 ACK 失败后重试不重复、cancel 先于 start、安全 shutdown。
- [x] 实现上述最小客户端和命令 Dispatcher，命令输入输出进行严格校验。Temporal start 使用固定 Workflow ID 和拒绝重复的重用策略；已有已完成 Workflow 也不能因同命令重试启动第二次。
- [x] Schedule 用官方 Schedule API，fixed SKIP、有限 catchupWindow、timezone、start/end，目标 Workflow 名称固定；旧版本命令不能覆盖较新定义。禁止 argv/环境携带模型或服务 Secret。
- [x] Worker 启动用 `--config` 读取无 Secret 配置，Secret 通过 Keychain 引用或单次 stdin 输入读取；同一内存身份供 Activity 和 Dispatcher 使用。SIGTERM 关闭轮询与 Worker，不取消实际 Daemon 运行。
- [x] 网络/认证失败只记录固定错误码。通过测试后提交 Worker 和 Dispatcher 实现，并补真实服务的跨 Client 版本竞争测试。

## Task 6：真实服务、接口工件与闭环

**Files:**
- Create: `infra/temporal.compose.yml`, `infra/workflow-worker.example.json`
- Create: `apps/control-plane/test/temporal-orchestration.e2e.test.ts`
- Create: `apps/control-plane/test/temporal-worker-cli.e2e.test.ts`
- Modify: `packages/contracts/openapi/generate.mjs`, `packages/contracts/openapi/control-plane.openapi.json`
- Modify: `packages/contracts/test/openapi.test.ts`

- [x] 新增真实服务失败验收：启动真实 CP/Temporal、无模型的受控 Daemon fixture，创建后台任务、停止并重启 Worker、观察原 Run 完成且 attempt 不增加。
- [x] 独立私有持久卷运行本机 Temporal，端口只绑定127.0.0.1，默认 profile 不启用。保留已有数据库服务及卷，不自动删除资源。
- [x] 验证真实 Schedule 默认disabled、启用后有限次数、暂停、missed/overlap、旧定义消息；模拟服务接受后重启Dispatcher，命令和Run均不重复。
- [x] 生成 OpenAPI 并执行 `node packages/contracts/openapi/generate.mjs --check`；内部路由使用独立 WorkflowBearer security definition。
- [x] 通过后提交真实 Temporal 与 Worker CLI 端到端验收。

## Task 7：评审、回归与交付

**Files:**
- Create: `docs/temporal-acceptance.md`, `docs/phase-2b-review.md`
- Modify: `docs/implementation-roadmap.md`

- [x] 只读 Reviewer 检查任务重复、两个事实库一致性、取消竞态、Schedule 时间/限次、服务身份与历史脱敏；修复可操作发现并保留红绿证据。
- [x] 执行 `pnpm build`、`pnpm typecheck`、`pnpm lint`，以及基线所有真实 Docker/原生 Codex专项和新增 Temporal 门禁。测试在包目录或Turbo包脚本运行，避免扫描 `.titan/workers`。
- [x] 文档记录实际 SDK/服务版本、启动命令、Keychain/受控 stdin 身份配置、关闭与恢复、失败诊断、真实测试数量和未包含项。
- [ ] 检查差异、仅提交相关文件，沿用 `HTTPS_PROXY=http://127.0.0.1:7890 HTTP_PROXY=http://127.0.0.1:7890 ALL_PROXY=socks5://127.0.0.1:7890 git push origin chore/initial-project` 推送。

## 分工与完成状态

控制面领域、Temporal Workflow、基础设施可在互不重叠的隔离工作树实施；共享接口以本计划定义为准。项目经理完成客户端/Dispatcher/Worker集成和最终门禁，不把子代理声明等同于验收通过。

全部 checkbox 只有在对应证据存在后才能勾选。规格第1–9节分别由任务1–6覆盖，第10节由各任务测试与任务7覆盖，第11节作为本轮非目标保持明确。
