# Phase 1 交付包

> 版本：`0.1.0-phase1-foundation`
>
> 状态：`approved-foundation`

## 1. 包含内容

- pnpm Workspace 和 TypeScript strict 基线。
- `@titan/contracts`：Zod 请求/事件契约、ID 和错误码。
- `@titan/domain`：Project、Task、Session、Run、Artifact 和状态规则。
- `@titan/control-plane`：NestJS/Fastify API、PostgreSQL、Outbox 记录和 SSE 历史流。
- `@titan/agent-core`：Permission、Hook、Tool、Goal、Checkpoint 和 Runtime Adapter 契约。
- `@titan/agent-runtime`：本机 Runtime 组合入口。
- `@titan/daemon-protocol`、`@titan/daemon`：Daemon 信封、路径限制、进程组、Worktree 和重连状态。
- `@titan/cli`：Task 创建和 Run 查询的 JSON/文本命令入口。
- `database/schema.sql`、`database/init-data.sql` 和 `infra/docker-compose.yml`。
- `docs/phase-1-test-report.md`、`docs/phase-1-review.md` 和本文件。

## 2. 启动方式

```bash
pnpm install
docker compose -f infra/docker-compose.yml up -d postgres redis minio
psql "$DATABASE_URL" -f database/schema.sql
psql "$DATABASE_URL" -f database/init-data.sql
pnpm build
```

本机只有 PostgreSQL 可用时，也可以将 `DATABASE_URL` 指向本机实例。Control Plane 默认监听 `127.0.0.1:3000`。

## 3. 关键环境变量

| 变量 | 示例 | 作用 |
|---|---|---|
| `DATABASE_URL` | `postgresql://titan:titan@localhost:55432/titan` | PostgreSQL 连接 |
| `DATABASE_POOL_MAX` | `10` | 连接池上限 |
| `ARTIFACT_ROOT` | `.titan/artifacts` | Artifact 内容根目录 |
| `CONTROL_PLANE_PORT` | `3000` | API 监听端口 |
| `TITAN_API_URL` | `http://127.0.0.1:3000` | CLI API 地址 |

## 4. 发布前门禁

```bash
pnpm lint
pnpm typecheck
DATABASE_URL=postgresql://titan:titan@localhost:55432/titan pnpm test
pnpm build
docker compose -f infra/docker-compose.yml config
```

## 5. 回滚与未包含内容

回滚时停止 API/Daemon，保留 PostgreSQL 数据和 Artifact 目录，恢复上一版本代码后重新执行兼容的 schema/init 脚本。旧 Artifact、旧 Run 和事件记录不覆盖删除。

本交付包不包含 Web UI、云端 Session、真实外部系统同步、生产发布、完整 Temporal Worker、多人协作和 Marketplace。完整 Phase 1 的后续门禁仍需在下一轮实现后单独验收。
