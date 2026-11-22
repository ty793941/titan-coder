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

## 目录

- `apps/`：Control Plane、Agent Runtime、Daemon 和 CLI 应用。
- `packages/`：共享契约、领域模型、Agent Core、Daemon 协议和观测能力。
- `docs/`：产品规格、阶段路线、设计文档和实施计划。
