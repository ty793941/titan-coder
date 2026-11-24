# Phase 2A Cloud Worker 本机验收

本阶段的 Cloud Worker 是现有 Daemon 的 `environmentType=cloud` 执行模式。它在宿主 Daemon 内创建一个独立 Docker Session Container，使用 Snapshot 和一次性 Secret Lease 启动现有 Runtime Worker。

## 前置条件

- Node.js 22、pnpm 10.34.5 和 Docker Desktop。
- PostgreSQL 运行在 `127.0.0.1:55432`，数据库初始化脚本已执行。
- 工作区、Snapshot 目录和 Daemon state 目录由当前非 root 用户拥有，目录权限为 `0700`。
- Docker 镜像构建所需的 registry/npm 网络可用。

构建完整 Session 镜像：

```bash
docker build --pull=false -f apps/agent-runtime/Dockerfile -t titan-session:phase2a .
docker run --rm --network=none --entrypoint=codex titan-session:phase2a --version
docker run --rm --network=none --read-only --user=1000:1000 --tmpfs /tmp:rw,nosuid,nodev,noexec,size=16m,mode=1777 --entrypoint=pnpm titan-session:phase2a --version
```

第二条命令应输出 `codex-cli 0.172.0`，第三条应输出 `10.34.5`。worker stage 从 Linux build stage 复制固定版本的 pnpm，完整 runtime 镜像继承该命令，支持显式允许 `trustedCode` 时执行 `pnpm test`；运行时无需下载 pnpm。镜像中的 Codex 是 Linux 版本；宿主 macOS 应用中的 Codex 二进制不会复制进镜像。

## 宿主 Daemon 配置

复制 `infra/cloud-daemon.example.json`，替换其中的绝对路径。Cloud Daemon 需要：

- `environmentType: "cloud"`。
- `cloud.image: "titan-session:phase2a"`。
- `cloud.workspaceRoot` 和 `cloud.snapshotRoot` 位于当前用户可写的受控目录。
- `network: "none"` 用于离线验收；真实模型调用需要显式改为受信网络。
- `credentialEnv: []`，模型 Key 和 Provider URL 只使用 Keychain 引用。

源端本机 Daemon 可以在同一进程配置中启用 `handoff.snapshotRoot`，也可以使用单独的本机 Daemon 配置。源 Daemon 和 Cloud Daemon 必须能访问同一个受控 Snapshot 目录。

## Handoff 流程

1. 启动 PostgreSQL、Control Plane 和本机 Daemon。
2. 创建项目、Task、已批准 Plan 和本机 Session。
3. 启动本机 Run，等待至少一个 Checkpoint，然后暂停 Run。
4. 通过管理 API 创建 Handoff：

```http
POST /api/sessions/<sourceSessionId>/handoff
Authorization: Bearer <TITAN_CONSOLE_TOKEN>
Content-Type: application/json

{
  "checkpointId": "checkpoint_xxx",
  "targetEnvironment": "cloud",
  "workspaceSync": { "mode": "git-snapshot" },
  "idempotencyKey": "handoff_xxx"
}
```

5. 源 Daemon 轮询 pending Handoff。它会确认源 Run 已停止、Outbox 已排空，并从受控工作区创建不可变 Snapshot Manifest。
6. Control Plane 验证 Manifest、源 Session 最新 Run、Cloud Daemon 能力和容量，然后创建新的目标 Session、Run、Checkpoint、Cloud Execution 和 Secret Lease。
7. Cloud Executor 物化 Snapshot，在 `/workspace/session` 中创建容器，消费一次性 Lease，通过 stdin 注入凭证并启动 Runtime Worker。
8. 通过 Session、Run、Handoff、Cloud Execution 和 SSE 接口观察 `container.created`、`container.started`、Progress、Checkpoint 和最终状态。

目标 Session 使用新的 ID 和新的 Checkpoint ID；源 Session、源 Run 和源 Checkpoint 始终保留。跨环境只导入可移植消息，源机器的工具账本和测试证据需要在目标环境重新建立。

## 安全验收

检查以下内容：

- `docker inspect` 的容器使用非 root UID、只读根文件系统、`cap-drop=ALL`、`no-new-privileges`、默认 `network=none` 和受限 `/tmp` tmpfs。
- 容器 argv、Docker environment、Progress、Event、Artifact、Checkpoint、Cloud Worker state 和普通日志中没有 API Key、Provider URL 或 Daemon Token。
- Secret Lease 只能被绑定 Session 消费一次；过期、撤销和重复消费都会失败。
- Snapshot Manifest 只包含 `snapshot://` 引用、Git revision、`sha256:` 校验和、文件数量及总大小，不包含宿主工作区路径。
- Artifact 只能落在 `<cloudWorkspaceRoot>/<sessionId>/session/.titan/artifacts/`，正文读取会再次校验路径、inode 和 checksum。
- 容器退出后不会立即删除：必须先由 Control Plane 接收终态 Progress，Daemon Outbox 完成 ACK，之后 Cloud Executor 才清理容器；工作区和已归档工件保留。

## 故障恢复

- Cloud Daemon 心跳失联时，旧 Progress 会被拒绝，Job 进入 blocked，Session/Run 进入 `reconnecting`，不会续租或自动重跑。
- Cloud Executor 重启时，只能重新连接拥有者一致且仍存在的容器；不会重新消费 Secret Lease 或重复启动模型。
- 容器缺失、Snapshot 校验失败、Lease 过期和容器超时会产生稳定错误码，并保留源 Session 和 Handoff 事实。
- Handoff 使用幂等键；重复请求返回同一 Handoff 和目标 Session。源 Session 出现更新的 Run 后，旧 Run 的 Snapshot ACK 会被拒绝。
- 取消操作先由 Control Plane 设置取消意图，Cloud Executor 停止并确认容器后再提交 `cancelled`。

## 自动化验收

```bash
export PATH="/path/to/node-22/bin:$PATH"
export DATABASE_URL=postgresql://titan:titan@127.0.0.1:55432/titan

pnpm build
pnpm typecheck
pnpm lint
pnpm --filter @titan/contracts test
pnpm --filter @titan/agent-runtime test
pnpm --filter @titan/daemon test
TITAN_RUNTIME_IMAGE_TESTS=1 TITAN_CODEX_IMAGE_TESTS=1 \
  TITAN_RUNTIME_TEST_IMAGE=titan-session:phase2a \
  pnpm exec vitest run apps/daemon/test/cloud/runtime-image.integration.test.ts
TITAN_CLOUD_E2E=1 pnpm --filter @titan/control-plane test -- cloud-daemon.e2e.test.ts
```

真实 Docker E2E 使用本地 fixture Runtime，不调用付费模型；它验证源 Daemon、Cloud Executor、容器、Snapshot、Checkpoint、Artifact、Secret 边界和清理时序。Runtime 镜像 smoke 会在非 root、只读根和断网条件下验证 pnpm 固定版本并实际执行无依赖 fixture 的 `pnpm test`。完整 Linux Codex 镜像 smoke 会额外验证固定 Codex 版本，但不会调用 Provider。

## 当前边界

本阶段尚未接入真实 Temporal、Redis Streams、MinIO/S3、Vault/KMS、Kubernetes、多租户计费或生产级云调度。Container Runtime、Snapshot Store 和 Secret Broker 已通过接口隔离，后续可替换这些基础设施。
