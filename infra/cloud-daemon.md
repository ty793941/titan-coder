# 本机 Cloud Worker 镜像与配置

本切片提供 Docker adapters、真实 container-worker 镜像和宿主 Daemon 配置样例。宿主 Daemon 已接通 `environmentType=cloud`、租约消费、容器执行、恢复和 Handoff；完整操作与验证命令见 `docs/cloud-worker-acceptance.md`。

## 构建与版本

在仓库根目录执行，必须使用根目录作为 build context：

```bash
docker build --pull=false -f apps/agent-runtime/Dockerfile -t titan-session:phase2a .
```

镜像使用 Node.js 22 Debian slim 多阶段构建，固定 pnpm `10.34.5` 和官方 npm `@openai/codex@0.172.0`。该 Codex 版本于 2026-11-24 从 npm 官方 latest 元数据确认；构建必须运行 Linux `codex --version` 和 container-worker 模块加载检查，不能把 macOS 可执行文件复制进镜像。npm 根据目标平台安装 Linux ARM64 或 x64 可选依赖。

构建只读取 Dockerfile.dockerignore 放行的四个工作区源码和包配置，不发送宿主 node_modules、dist、Git 元数据、本机状态或凭证目录。构建命令选择 `@titan/agent-runtime...`，TypeScript 固定为 `5.9.3`；pnpm 的共享 lockfile 安装仍可能解析根目录开发依赖。配方使用 `pnpm deploy --legacy --prod` 生成运行目录，目标是保留 dist、生产依赖及其相对链接。镜像入口使用绝对路径，避免 DockerRuntime 设置 `/workspace` 工作目录后找不到模块。

构建需要访问基础镜像 registry 和 npm。npm 每次请求超时 20 秒，最多重试一次；调用方还应对整体构建设置总时限。网络失败不能视为构建通过。代理仅可在宿主临时环境配置，不写入 Dockerfile、镜像 ENV 或配置样例。

## 宿主配置

复制并调整 `infra/cloud-daemon.example.json` 中的绝对路径。先由当前非 root 宿主用户创建 state、snapshots 和 workspaces 目录；snapshotRoot 的父目录必须已存在。所有受控目录由该用户拥有，不可对其他用户开放写权限。snapshotRoot 是本机模拟的共享目录，源 Daemon 和 cloud Daemon 必须访问同一个目录；公共 manifest 不包含宿主路径。

Session 的执行配置通过 Control Plane 引用凭证，例如 Qwen 使用 `credentialRef: keychain://titan-qwen`，Codex 使用 `credentialRef: keychain://titan-openai` 和 `baseUrlRef: keychain://titan-openai-base-url`。这些是 macOS Keychain 引用；API Key 和 Provider URL 不放入宿主配置、镜像、普通环境变量或命令行。Cloud Executor 先确认 CP lease 的单次消费，宿主 SecretBroker 再解析凭证，随后用容器 stdin 注入一次 bootstrap，并关闭 stdin。

源端本机 Daemon 通过 `handoff.snapshotRoot` 启用快照导出；它与 Cloud Daemon 使用同一个 Snapshot 目录，但必须使用不同的 state 目录和设备身份。

默认 `cloud.network=none` 用于离线验收。真实模型调用需要宿主信任策略显式批准，将该字段改为 `bridge` 或批准的专用网络；不提供自动开启网络的行为。配置中 `baseUrl` 是 Control Plane 地址，不是模型 Provider URL。

镜像默认 `USER node`；DockerRuntime 用宿主当前非 root UID:GID 覆盖，以读写宿主拥有的 0700 工作区及 0600 文件。根文件系统只读，仅本次工作区 bind 和受限 `/tmp` tmpfs 可写。API 约定容器工作区为 `/workspace/session`，调用方须保证 `/workspace` 挂载中包含该目录。镜像不声明匿名 Volume；adapter 拒绝额外挂载。

## 真实镜像验收

在 Node.js 22、已安装依赖且完成 workspace build 的仓库根目录执行：

```bash
TITAN_RUNTIME_IMAGE_TESTS=1 TITAN_CODEX_IMAGE_TESTS=1 pnpm exec vitest run apps/daemon/test/cloud/runtime-image.integration.test.ts
```

该测试将真实 Qwen dispatch 和空 credentials 经 stdin 传给 container-worker，期望先输出 `running`、再输出 `waiting_input`，最终 result 为 `waiting_input`。测试还检查重建 DockerRuntime 后 find/inspect/logs 恢复、只读根目录、非 root UID、默认断网、权限收缩及 tmpfs 可写；第二项检查 Linux Codex 版本。它不使用真实 Key，不发起模型请求，也不能证明真实 Provider 连通性。

完整镜像因官方 Linux Codex 包下载受阻时，可仅验证同一 Dockerfile 的 worker stage，使用单独标签并明确保留 Codex 验证为未通过状态：

```bash
docker build --pull=false --target worker -f apps/agent-runtime/Dockerfile -t titan-session:worker-smoke .
TITAN_RUNTIME_IMAGE_TESTS=1 TITAN_RUNTIME_TEST_IMAGE=titan-session:worker-smoke pnpm exec vitest run apps/daemon/test/cloud/runtime-image.integration.test.ts
```

worker stage 运行真实 container-worker，保留相同的生产依赖、入口和权限设置，但不含 Codex，不能替代 `titan-session:phase2a` 的最终验收或用于实际 Codex Session。

容器内 npm 下载或源码构建受阻时，也可先在宿主完成 runtime build，再导出纯 JavaScript 生产依赖，用单独的离线配方验收真实 Linux worker。以下构建的 context 是新建的 deploy 目录；路径需选择尚不存在的位置，避免覆盖其他产物：

```bash
pnpm --filter @titan/agent-runtime... build
pnpm --filter @titan/agent-runtime deploy --legacy --prod --offline /absolute/new/runtime-deploy
docker build --pull=false --network=none -f apps/agent-runtime/Dockerfile.offline -t titan-session:worker-smoke /absolute/new/runtime-deploy
TITAN_RUNTIME_IMAGE_TESTS=1 TITAN_RUNTIME_TEST_IMAGE=titan-session:worker-smoke pnpm exec vitest run apps/daemon/test/cloud/runtime-image.integration.test.ts
```

如果本机缺少 registry 元数据，deploy 的严格 offline 模式可能失败。可在宿主临时使用 `npm_config_fetch_timeout=8000 npm_config_fetch_retries=0`，将 deploy 参数改为 `--prefer-offline --registry=https://registry.npmjs.org`，有界补齐元数据。此配方只适用于当前 runtime 的纯 JavaScript 生产依赖；不把宿主 native addons 或 macOS Codex 复制到 Linux 镜像。

快照仅接受具备完整 40/64 位 Git HEAD 的工作区；缺少 revision 返回 `CLOUD_SNAPSHOT_REVISION`。checksum 格式为 `sha256:<64位hex>`，与 CP 契约一致。写入失败的私有 staging 保留待显式回收；无法核验 Docker owner 时保留资源，恢复后以确定名称和 labels 查询。

## 本次验证状态

2026-11-24：完整 `titan-session:phase2a` 镜像已从源码构建成功，包含 Linux Codex `0.172.0` 和 pnpm `10.34.5`。此前宿主 `.tsbuildinfo` 被带入构建上下文导致的缺少输出问题，已通过 Docker ignore 排除增量编译缓存修复。

Node 22.23.5 下开启全部 Docker、Handoff 和原生 Codex 测试的全仓验收为 493 项通过、0 跳过。真实镜像验证覆盖缺凭证 Runtime、恢复日志、非 root、只读根、断网、tmpfs、pnpm 版本、实际 `pnpm test` 和 Linux Codex 版本。未使用真实模型 Key 或调用付费 Provider。

CloudExecutor 传递给 `LocalSnapshotStore.materialize()` 的 manifest 保留 `sha256:` 前缀。源码构建的 worker stage 包含 pnpm；仅复制部署目录的 `Dockerfile.offline` 不包含 pnpm 和 Codex，只能用于缺凭证入口检查，不能替代完整镜像验收。使用离线配方时，测试加上 `-t 'runs missing-credential'` 以限定其验证范围。
