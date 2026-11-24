# Phase 2A 交付与验证记录

日期：2026-11-24。范围为已确认的本机 Docker Cloud Worker MVP，规格见 `docs/superpowers/specs/2026-11-23-cloud-worker-mvp-design.md`；执行以实施计划的修订节为准。

## 已交付能力

- Daemon 内置 Cloud Executor，复用设备身份、claim/control/progress 和持久 Outbox。
- 一个云端 Session 对应一个隔离 Docker 容器，具备 owner 校验、超时、取消、重连日志和 ACK 后清理。
- 源本机 Session 暂停、停止确认、Snapshot 导出、目标 cloud Session 和新 Checkpoint 导入，保留父子 Session 和来源关系。
- 只保存引用的 Secret Lease 和宿主内存 Secret Broker；通过 stdin 注入本次执行需要的 Key 与 URL。
- Snapshot 路径、敏感文件、文件数量、大小、精确字节 checksum 校验；保留业务认证源码和受限所有者执行位，明确凭证数据始终排除；宿主保留 cloud Workspace 和 Artifact。
- 云端工件登记及正文读取，严格绑定 Daemon、Session、路径和 checksum。
- 心跳/执行租约 fencing、旧事件私有 discard 审计、管理取消竞态收束、旧 Handoff 持久失败。
- 固定 Linux Codex 0.172.0、pnpm 10.34.5 的 Session 镜像。
- 自定义 Codex Provider URL 通过原生 Thread RPC 配置，保留 App Server 链路，避免 URL 进入 argv。

## 验证环境与结果

最终复测宿主 Node.js 24.22.3、pnpm 10.34.5，Session 镜像为 Node.js 22.23.5，使用 Docker Desktop 和独立 PostgreSQL 测试 schema。此前分模块实现使用 Node.js 22.23.5 验证。最终全仓执行按包串行、每包一个 Vitest Worker，普通测试上限 30 秒，较长 Docker 测试单独指定上限。

| 模块 | 通过数 |
| --- | ---: |
| daemon-protocol | 1 |
| contracts | 43 |
| cli | 30 |
| web-console | 31 |
| domain | 4 |
| agent-core | 62 |
| control-plane | 135 |
| agent-runtime | 59 |
| daemon | 146 |
| 合计 | 511 |

最终门禁为 511 项通过、0 失败、0 跳过，包含真实 Docker、真实源 Daemon 到云端容器 Handoff、原生 Codex 与本地 Responses 假服务，以及最终镜像中实际执行 `pnpm test`。真实容器测试还验证 Daemon shutdown 只断开 Docker CLI、容器继续运行，恢复不重新消费凭证或启动模型，取消及超时通过显式 Docker stop 收尾。构建、类型检查、Lint 和 OpenAPI 一致性检查通过。Lint 沿用项目现有 TypeScript 检查，不表示启用了独立 ESLint。

此前默认高并发运行发生数据库初始化超时，并导致同一测试文件后续用例级联失败。最终通过限定 Worker 数量及独立测试 schema 执行完整门禁；未放宽业务断言。

最终只读 Reviewer 结论为 `approve`，没有剩余可操作 P1/P2。复核重点包括 fencing 后取消竞态、Outbox 安全收束、旧 Handoff、工件路径授权、容器 detach 信号、快照凭证数据排除及脚本执行位、镜像工具完整性。

## 交付入口

- `docs/cloud-worker-acceptance.md`：启动、Handoff、凭证、恢复和完整验收命令。
- `infra/cloud-daemon.example.json`：云端 Daemon 的本机配置样例。
- `apps/agent-runtime/Dockerfile`：完整 Runtime 镜像。
- `database/schema.sql`、`database/init-data.sql`：幂等增量结构和基础数据。

## 保留限制

- 本阶段只完成 Phase 2A，没有接入 Temporal、Cron、S3/MinIO 远程传输、Vault/KMS、Kubernetes 或跨主机调度。
- Snapshot 使用同一宿主的受控共享目录和完整文件快照；不宣称已实现远程 Git push/fetch 或独立 Patch 传输。
- 只支持本机到云端的新 Session Handoff；cloud Run 的 pause 显式返回 `CLOUD_PAUSE_UNSUPPORTED`，不生成假暂停状态。
- Handoff 的停止确认来自认证源 Daemon。控制面校验其归属、最新 Run、Checkpoint 和活动状态，不直接探测远程进程。
- 真实 Docker E2E 使用离线模型适配 fixture；未执行真实 Provider 的付费推理。完整镜像验证了 Linux Codex 可执行程序和 Runtime 入口。
- 默认容器断网。真实 Provider 访问需要在宿主可信配置中选择网络，目标项目依赖也需要在受控镜像或工作区内准备。

## 回退与保留

如需停用云端执行，停止 cloud Daemon 并保留其私有 state、Outbox、Snapshot 和 Workspace；本机 Daemon 默认路径不变。运行中容器应先通过管理取消和退出确认收尾。新增数据库结构为幂等、可共存结构，不自动删除表、工件或历史状态，不直接修改生产数据库。
