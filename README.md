# Titan Coder

Titan Coder 是一个面向产品和研发交付的 Agent 工作台。第一阶段先交付无 UI 的本机 Headless MVP，通过 REST API、CLI 和 SSE 验证 `Project → Task → Session → Run → Artifact` 闭环。

## 当前阶段

Phase 1 已提供本机 Daemon 自动认领 Run、独立 Node Worker、持久进度 Outbox、Checkpoint 恢复、QRSPI 审批门禁和实时 SSE。Codex 使用 App Server stdio 原生协议，Qwen 使用官方兼容 API；真实模型推理尚待配置凭证后验收。Web UI、云端 Session、多人协作、外部系统与其他 Provider 留到后续阶段。

## 本地开发

要求 Node.js 22 LTS 和 pnpm 10.34.5。

```bash
pnpm install
docker compose -f infra/docker-compose.yml up -d --wait postgres
pnpm build
DATABASE_URL=postgresql://titan:titan@127.0.0.1:55432/titan pnpm test --force
pnpm typecheck
```

本机基础设施配置在 `infra/docker-compose.yml`。数据库脚本位于 `database/schema.sql` 和 `database/init-data.sql`。

启动控制面：

```bash
DATABASE_URL=postgresql://titan:titan@127.0.0.1:55432/titan node apps/control-plane/dist/main.js
```

另一个终端启动 Daemon，工作区路径必须使用真实绝对路径：

```bash
node apps/daemon/dist/cli.js --url http://127.0.0.1:3000 --workspace-root "$PWD" --state-dir "$PWD/.titan/daemon"
```

逐项验收见 [Phase 1 验收说明](docs/phase-1-acceptance.md)。API 契约见 `packages/contracts/openapi/control-plane.openapi.json`；Proto/ConnectRPC 与跨环境快照的冻结边界见 [协议说明](docs/phase-1-protocols.md)。

## 本机 Git 变更证据导出

Daemon 导出接口为 `WorktreeManager.exportChanges({ worktreePath, baseRevision, outputDirectory })`，返回 `GitEvidenceBundle`：`bundlePath`、`patchPath`、`snapshotPath`、`previewPath` 和内存中的 `snapshot`。`worktreePath` 必须是授权根目录下真实的 linked worktree 根目录；`baseRevision` 必须是当前工作树 HEAD 的完整 40/64 位 commit OID 或其祖先；`outputDirectory` 必须位于授权根目录且在源 worktree 外。

导出目录使用 UUID，包含权限为 0600 的 `patch.diff`、`snapshot.json` 和 `preview.json`。Patch 使用原始字节的 `sha256:<64 位小写十六进制>`，通过私有临时 `GIT_INDEX_FILE` 合并 tracked、staged、unstaged、untracked、delete、rename 和 binary 变化；不会修改源 index、Git 配置、源提交或执行 hooks、external diff、textconv、clean filter。`snapshot.json` 的 `patchUri` 固定为 `patch.diff`，`fileList` 路径为仓库相对 POSIX 路径；`excludes` 是冻结协议要求的最小排除 pattern 字符串数组，`excludedFiles` 和 `preview.json.files` 才保存本机 bundle 的相对路径与排除原因。

默认排除 `.git`、`.titan`、`.humanlayer`、`.ssh`、`credentials`、任意 `.env*` 父目录、`node_modules`、构建/覆盖率目录、凭证文件、密钥扩展名、符号链接、submodule、超过 1 MiB 的文件，以及命中 secret pattern 的完整文件；排除项只在 preview 和 manifest 中记录相对路径与原因，不写入文件内容。Patch 输出固定关闭颜色、relative path、mnemonic prefix，并固定 `a/`、`b/` 前缀和 diff indicator。Patch 上限为 4 MiB，扫描最多 10,000 个目录项，累计读取上限为 32 MiB，Git 子进程单次超时为 30 秒，本机 snapshot 元数据上限为 8 MiB。untracked 和 binary 已直接进入本地 Git binary patch，不生成外部 `contentUri`；这个 local bundle 合约不宣称与跨环境 Handoff Proto 完全等价。该 bundle 仅用于本机临时验收和后续受控流程，不跨云上传、不在生产环境自动 apply。

## 目录

- `apps/`：Control Plane、Agent Runtime、Daemon 和 CLI 应用。
- `packages/`：共享契约、领域模型、Agent Core、Daemon 协议和观测能力。
- `docs/`：产品规格、阶段路线、设计文档和实施计划。
