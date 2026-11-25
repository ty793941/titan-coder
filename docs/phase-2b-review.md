# Phase 2B 交付与验证记录

日期：2026-11-25。实现范围为用户确认的 Temporal 持久编排、后台任务和基础定时执行，规格见 `docs/superpowers/specs/2026-11-24-temporal-orchestration-design.md`，操作见 `docs/temporal-acceptance.md`。

## 1. 已交付

- 固定 Temporal TypeScript SDK 1.26.0、新增 Workflow 包、受控 Worker CLI 和 Dispatcher。
- 后台任务意图与专用命令 Outbox 原子写入；固定 Workflow ID、命令租约、幂等派发、ACK 重放和有界退避。
- 对已有本机或 cloud Run 的观察，不创建第二个业务 Run、容器或凭证租约。
- 确定性 Timer、取消信号、截止时间、Continue-As-New、Activity 重试及编排失败回写。
- 本机 Schedule 默认未启用，支持时区、五字段 Cron/间隔、版本、暂停、错过触发窗口和禁止重叠；按实际创建 Run 计数，达到上限自动禁用。
- 独立 Workflow 服务身份，从 Keychain 或受控 stdin 读取；命令领取与资源身份绑定在同一事务中完成。
- 固定版本本机 Temporal CLI 容器、独立持久 SQLite 卷、仅回环地址发布的 gRPC/UI 端口。
- 管理与内部 API 的 Zod/OpenAPI 契约、旧表字段幂等迁移和安全错误码。

## 2. 验证环境

- 宿主 Node.js 24.22.3、pnpm 10.34.5；项目源码和 Session 镜像保持 Node.js 22 兼容目标。
- PostgreSQL 使用本机 55432 实例，测试分别创建独立随机 schema，不操作公共业务表。
- Temporal SDK 1.26.0；本机服务由官方 `temporalio/temporal:1.5.1` CLI 镜像提供，ARM64 digest 固定在 Compose 中。CLI 镜像版本不作为 Temporal 服务端语义版本的替代。
- Temporal gRPC `127.0.0.1:7233`、namespace `titan`；真实 CLI 验收使用独立测试 namespace，避免不同 Worker 争抢固定 Task Queue。
- Phase 2A 的真实 Docker Session 镜像、原生 Codex 与本地 Responses 假服务一并复验，未调用付费模型。

## 3. 最终门禁

全仓按包串行、每包一个 Vitest Worker，关闭 Turbo 测试缓存，并显式开启 Temporal、Docker、cloud Handoff、镜像和原生 Codex 专项。

| 模块 | 通过数量 |
| --- | ---: |
| agent-runtime | 59 |
| cli | 30 |
| control-plane | 193 |
| daemon | 146 |
| web-console | 31 |
| workflow-worker | 2 |
| agent-core | 62 |
| contracts | 50 |
| daemon-protocol | 1 |
| domain | 4 |
| workflow | 34 |
| 全仓合计 | 612 |
| Temporal 基础设施配置（独立验收） | 5 |
| 总计 | 617 |

最终为 617 项通过、0 项失败、0 项跳过。其中全仓命令产生 22 个成功的构建/测试任务，全部重新执行，无缓存命中。构建、全仓类型检查、Lint、OpenAPI 生成一致性和差异格式检查均通过。Lint 沿用项目的 TypeScript 检查，不代表新增了 ESLint。

全仓命令：

```bash
TITAN_TEMPORAL_E2E=1 TITAN_CLOUD_E2E=1 TITAN_REAL_DOCKER_TESTS=1 \
TITAN_RUNTIME_IMAGE_TESTS=1 TITAN_CODEX_IMAGE_TESTS=1 \
TITAN_RUNTIME_TEST_IMAGE=titan-session:phase2a \
TITAN_CODEX_BINARY=/absolute/path/to/codex \
pnpm exec turbo run test --force --concurrency=1 --env-mode=loose --output-logs=errors-only -- --maxWorkers=1 --testTimeout=120000
pnpm exec vitest run --root infra test/temporal-infra.test.ts --maxWorkers=1
```

执行前使用有效 Node 路径及指向独立本机数据库的 `DATABASE_URL`。Workflow 包默认超时放在 Vitest 配置中，允许根命令覆盖，避免脚本重复传递 `--testTimeout`。

## 4. 实际闭环证据

真实 CLI 测试启动编译后的 `apps/workflow-worker/dist/main.js`，从 stdin 注入合成服务凭证，连接真实控制面和 Temporal。以下四项均实际运行：

- Dispatcher 领取命令并启动 Workflow；CLI 收到 SIGTERM 后退出，再用相同配置重启，继续同一 Workflow 与同一 Run。
- 控制面已提交命令 ACK，但代理丢失响应；恢复后没有重复 Workflow 或 Run。
- 公开创建未启用的 Schedule、显式启用、Dispatcher 同步、原生触发、接纳 occurrence 并创建 Run。
- 暂停及更新版本同步至 Temporal，旧定义不能再派发有效业务执行。

官方 Temporal 测试环境及真实服务测试还覆盖了 Activity 响应丢失重试、持久 Timer、人工等待、deadline、取消期间清理、Continue-As-New、真实 History replay、失败回报重试和历史敏感值扫描。

旧表迁移测试只在独立随机 schema 中模拟缺少 `worker_id` 的旧表，重复执行脚本两次，验证新增字段和既有行保留。

## 5. 评审收敛

规格评审与代码质量评审最终均为 `approve`。实际修复并保留失败用例的边界包括：

- 未领取或不匹配 Worker 身份不能观察、派发、取消其他任务或接纳 occurrence。
- 过期、命令耗尽或编排失败不能永久保留待派发状态；同步失败变为阻塞并记录事件。
- observe 创建采用 execution_job → Run → Session 锁序，避免与进度及取消路径死锁。
- 编排失败后，关联活动 Run 仍受显式取消和持久 deadline 约束。
- 队首100个繁忙目标不永久阻塞后续空闲目标；成功领取后恢复最老命令优先。
- Schedule `endsAt` 只限制新触发，不截断已启动执行的预算。
- Temporal Action 跳过不消耗业务 Run 次数；计数在创建 Run 的同一事务中增加。
- 跨 Client 的旧版本迟到创建/更新，在创建后及旧版本暂停后再次核对并收敛；跳过版本的 v1/v3 真实服务竞争也已验证。
- Key、URL、Prompt、服务凭证及 HTTP 错误正文不进入 Workflow 历史和业务日志。

## 6. 已知环境提示

Temporal 官方 time-skipping 测试服务会输出 heartbeat capability 提示，Node 24 下部分 SDK 依赖输出 `fs.F_OK` 弃用警告；失败测试场景也会产生预期的 Temporal Activity/Workflow warning。最终测试进程全部成功，这些提示未被描述为业务失败或隐藏。

## 7. 边界与回退

本阶段不包括定时创建 cloud Session、cloud pause/resume、跨主机 Snapshot/Git、生产对象存储、Vault/KMS、多租户身份、团队 UI 或生产 Temporal Cloud。不能据此将整个 Phase 2 标记完成。

停止 Worker 不会自动停止已有 Daemon Run，也不会删除 Temporal 定时意图；需要先暂停不再需要的 Schedule，显式取消活动后台任务。停用 Temporal 保留 SQLite 卷和历史；新增业务表及列与旧路径共存，不自动删除数据库结构或工件。

用户要求清理完结工作树后，本会话已移除已完成的隔离 worktree，保留分支/提交引用。仍保留 `phase2b-client`，因为其中存在未提交实现，不能安全视为已完结；根工作区用户文件 `docs/study.html` 未纳入提交。
