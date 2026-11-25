# Phase 2B：Temporal 编排与定时执行验收

## 1. 范围与运行主体

本阶段新增 `packages/workflow` 和 `apps/workflow-worker`。PostgreSQL 维护后台任务、调度定义和权限事实，Temporal 保存确定性编排历史及计时器，Daemon 继续执行模型、Tool 和容器。Workflow Worker 不运行 Docker，不读取 Provider Key 或 URL，也不替代 Daemon 的心跳和执行租约。

支持显式启动本机后台 Run、观察已有本机或云端 Run，以及有限次数的本机 Schedule。云端 Run 仍通过 Phase 2A Handoff 创建；不能借 Schedule 复用云端容器或已消费的 Secret Lease。

## 2. 前置环境

- Node.js 22 或兼容的新版本、pnpm 10.34.5、Docker Desktop 和本机 PostgreSQL。
- Temporal TypeScript SDK 固定为 1.26.0。
- 本地 Temporal 使用官方 CLI 镜像 `temporalio/temporal:1.5.1`，当前 Compose 固定 ARM64 digest，其他架构先核验对应官方 digest。
- `infra/temporal.compose.yml` 的数据库使用独立 SQLite 命名卷，仅用于开发验收；不属于生产集群部署。

在仓库根目录执行：

```bash
pnpm install --frozen-lockfile
pnpm build
docker compose -p titan-temporal -f infra/temporal.compose.yml --profile temporal up -d
docker compose -p titan-temporal -f infra/temporal.compose.yml exec -T temporal temporal operator cluster health --address 127.0.0.1:7233
```

gRPC 地址为 `127.0.0.1:7233`，namespace 为 `titan`，开发 UI 为 `http://127.0.0.1:8233`。端口只发布到本机回环地址，默认 Compose profile 不启动 Temporal。存储和架构说明见 `docs/temporal-infra.md`。

## 3. 独立服务凭证

Workflow 服务凭证必须与 Console Token、Daemon Token 和模型 Key 分开。

macOS 可通过“钥匙串访问”创建通用密码项：服务名称 `titan-workflow-service`，账户 `titan`，密码使用独立随机值。不要通过含有实际密码的 Shell 参数创建该条目，不把值写入配置文件、环境变量、日志、Artifact 或聊天。

控制面和 Worker 都使用引用 `keychain://titan-workflow-service`。控制面只在内存中保存其摘要，Worker 仅在内存读取一次。服务身份配置失效时，内部接口返回认证错误，不回退到 Console 或 Daemon 身份。

自动化测试和受控启动器还可以使用 `stdin://workflow`：父进程经 stdin 发送一次有界凭证，随后关闭 stdin。stdin EOF 结束凭证读取，不表示取消模型任务。测试用合成凭证，不改写用户 Keychain。

## 4. 启动控制面与 Worker

先启动带独立 Workflow 身份的控制面。下面环境变量仅包含非敏感引用和标识：

```bash
TITAN_WORKFLOW_WORKER_ID=local \
TITAN_WORKFLOW_CREDENTIAL_REF=keychain://titan-workflow-service \
CONTROL_PLANE_PORT=3301 \
node apps/control-plane/dist/main.js
```

PostgreSQL 连接沿用已有控制面配置。管理请求继续需要原有 Console 身份；该身份由当前启动方式安全提供，不能用 Workflow 凭证替代。

审阅 `infra/workflow-worker.example.json`，其中只包含本机服务地址、namespace、固定 Task Queue、Worker ID、凭证引用和超时。确认 `controlPlaneUrl` 指向实际控制面，`workerId` 与控制面一致，然后在仓库根目录启动：

```bash
node apps/workflow-worker/dist/main.js --config infra/workflow-worker.example.json
```

固定 Task Queue 为 `titan-orchestration-v1`。Worker 注册 Workflow/Activity，同时运行命令 Dispatcher。SIGTERM/SIGINT 停止该进程的投递与消费，不取消仍由 Daemon 执行的 Run。使用同一 namespace、Task Queue、Worker ID 和服务身份重启，即可继续消费既有 Workflow。

## 5. 后台任务操作

对已配置本机执行环境且绑定当前批准 Plan 的 Session，使用 Console 认证调用：

```http
POST /api/sessions/<sessionId>/background-jobs
Authorization: Bearer <Console 凭证>
Content-Type: application/json

{
  "kind": "run",
  "runInBackground": true,
  "planHash": "sha256:<当前批准计划的哈希>",
  "deadlineAt": "<未来24小时内的UTC时间>",
  "idempotencyKey": "<本次请求的稳定幂等键>"
}
```

创建首先返回 `pending_dispatch`。同一事务保存业务意图和 `workflow_command`，不会提前生成可被 Daemon 领取的执行作业。Dispatcher 启动固定 Workflow ID 后，派发 Activity 再通过原 Run 领域服务原子创建 Run、执行作业和后台关联；响应丢失或重放返回同一 Run。

查询和取消：

- `GET /api/background-jobs/:id`。
- `GET /api/sessions/:sessionId/background-jobs?limit=50&offset=0`。
- `POST /api/background-jobs/:id/cancel`，JSON 正文为 `{}`。

观察已有 Run 时，使用同一创建接口，设置 `kind=observe` 并提供同一 Session 的 `runId`。该操作不启动第二个 Run、容器或凭证租约。

`waiting_input`、`paused` 和 `reconnecting` 不自动触发新 attempt。编排失败使用安全错误码回写后台任务；实际 Run 的事实仍由 Daemon 维护。编排失败后关联 Run 仍在运行的，显式取消和持久截止时间仍然有效，不因为后台任务已经 `failed` 而失去停止能力。

## 6. Schedule 操作

创建入口为 `POST /api/sessions/:sessionId/schedules`，始终默认未启用。输入字段：

| 字段 | 要求 |
| --- | --- |
| `planHash` | 当前批准计划，与 Session 一致 |
| `timezone` | 显式 IANA 时区，例如 `Asia/Shanghai` 或 `UTC` |
| `cron` / `intervalSeconds` | 两者互斥；五个数字 Cron 字段或至少60秒间隔 |
| `startsAt` / `endsAt` | UTC 时间，结束晚于开始；仅限制新接纳、新派发 |
| `maxRuns` | 1–100，按实际成功创建的 Run 计数 |
| `overlapPolicy` | 固定 `skip` |
| `catchupWindowSeconds` | 10–3600，默认60；恢复窗口内最多接纳一次补投 |
| `enabled` | 创建时必须为 `false` |
| `idempotencyKey` | 稳定请求键 |

查询 `GET /api/schedules/:id`；启用和暂停分别调用 `POST /api/schedules/:id/enable`、`pause`，正文携带 `expectedVersion`。`update` 接受完整时间定义及 `expectedVersion`，成功后生成新版本。

Schedule 使用 Temporal Schedule API。每次触发都重新检查业务定义版本、启用状态、Plan、Daemon、任务归属和 Session 活动 Run。实际执行次数在创建 Run 的同一事务中占用；跳过、重放和失败接纳不消耗次数。达到 `maxRuns` 后控制面自动禁用定义并投递暂停同步。

暂停或结束只阻止未来执行，不截断已经开始的 Run；已启动 Run 保留自己的执行预算。相同触发 ID、相同计划时刻或旧定义都不能重复创建 Run。

同步中的状态为 `pending_sync`，确认后为 `active` 或 `paused`。最新同步命令永久失败或重试耗尽后，状态为 `blocked` 并写入 `schedule.sync_failed`；即使期望 `enabled=true`，控制面仍拒绝该阻塞定义的新执行。管理员通过新版本 update/enable 恢复，旧版本失败不得覆盖新版。

## 7. 恢复、授权与取消

- 命令领取证明只在内部认证通道使用，数据库保存摘要；Activity 不携带命令凭证到 Temporal 历史。
- 任务和调度在领取命令时原子绑定 Worker ID，内部 API 只允许已绑定身份操作。Schedule occurrence 的后台任务继承对应身份。
- Temporal 接受命令但控制面 ACK 响应丢失时，重试核对固定 Workflow ID，不启动第二条执行。
- 命令投递每次有30秒租约，最多10次尝试，瞬态错误退避重试；领域锁忙碌时继续公平扫描后续目标，不阻塞其他 Session。
- Activity 重试耗尽后，通过可恢复的短 `failJob` Activity 写回安全失败码；后台意图尚未启动 Workflow 就过期时，控制面读取也会收敛为 `expired`。
- 管理取消先保存业务意图，再发取消信号。Temporal 已取消不代表容器已退出，实际进程退出和工件清理由 Daemon 证据确认。
- Continue-As-New 保留相同后台任务及业务 Run，只延续观察，不重新派发模型。
- Key、Provider URL、服务凭证、Prompt、完整 Checkpoint 和 Tool 输出不得进入 Workflow 参数、Activity 返回值、Memo 或 Search Attributes。

## 8. 自动化验收

先启动 Temporal、PostgreSQL，并完成全仓构建。核心验收命令：

```bash
pnpm --filter @titan/workflow exec vitest run test --maxWorkers=1 --testTimeout=120000
pnpm --filter @titan/workflow-worker exec vitest run test --maxWorkers=1
TITAN_TEMPORAL_E2E=1 pnpm --filter @titan/control-plane exec vitest run test/temporal-orchestration.e2e.test.ts test/temporal-worker-cli.e2e.test.ts --maxWorkers=1 --testTimeout=120000
pnpm exec vitest run --root infra test/temporal-infra.test.ts --maxWorkers=1
```

独立 PostgreSQL 集成测试通过 `DATABASE_URL` 指定连接；测试创建并清理独立随机 schema，不修改公共业务表。真实 CLI 测试使用 stdin 合成凭证，验证进程 SIGTERM/重启、同一 Run、丢失 ACK、原生 Schedule 触发、定义更新、暂停和历史扫描。

包含 Phase 2A 的完整门禁使用现有 Linux Session 镜像和本机原生 Codex：

```bash
TITAN_TEMPORAL_E2E=1 TITAN_CLOUD_E2E=1 TITAN_REAL_DOCKER_TESTS=1 \
TITAN_RUNTIME_IMAGE_TESTS=1 TITAN_CODEX_IMAGE_TESTS=1 \
TITAN_RUNTIME_TEST_IMAGE=titan-session:phase2a \
TITAN_CODEX_BINARY=/absolute/path/to/codex \
pnpm exec turbo run test --force --concurrency=1 --env-mode=loose -- --maxWorkers=1 --testTimeout=120000
```

该命令使用真实 Temporal/Docker 和离线模型 fixture，不调用付费 Provider。测试结果及环境限制以 `docs/phase-2b-review.md` 为准。

## 9. 停用与边界

停用 Worker 前先暂停不需要继续触发的 Schedule；单纯停止 Worker 不代表取消已有 Run，也不代表取消 Temporal 上的未来定时意图。停止 Temporal 时保留 SQLite 卷，不使用 `down --volumes`。

本阶段没有开放定时创建 cloud Session、cloud pause/resume、跨主机 Snapshot/Git 同步、生产 Temporal Cloud、Vault/KMS、多租户身份或团队协作 UI。已有本机及 Cloud Executor 路径继续兼容。
