# Phase 1 交付包

> 版本：`0.1.0-phase1-local-execution-candidate`
>
> Foundation 已验收；本轮状态：`candidate`，目标数据库已验证，等待真实 Provider 推理验收

## 1. 包含内容

- pnpm Workspace 和 TypeScript strict 基线。
- `@titan/contracts`：Zod 请求/事件契约、ID 和错误码。
- `@titan/domain`：Project、Task、Session、Run、Artifact 和状态规则。
- `@titan/control-plane`：持久派发、Daemon 认证、原子认领、租约、QRSPI、Artifact 和审计归档、SSE、暂停恢复 API。
- `@titan/agent-core`：多轮 Tool Loop、Permission、Hook、证据 GoalGate、持久检查点和工具日志、原生 Codex/Qwen Adapter。
- `@titan/agent-runtime`：真实 Node IPC Worker、受控文件/测试工具和锁定本地 Skill。
- `@titan/daemon-protocol`、`@titan/daemon`：常驻 HTTP 客户端、进度 Outbox、路径限制、进程组、Worktree 和重连状态。
- `@titan/cli`：Task/Session/Run/Daemon 命令、实时输出、断线重连、补拉和真实进程退出码。
- `database/schema.sql`、`database/init-data.sql` 和 `infra/docker-compose.yml`。
- `docs/phase-1-test-report.md`、`docs/phase-1-review.md` 和本文件。
- `docs/phase-1-acceptance.md`：启动、自动化验收和真实 Key 验收步骤。
- OpenAPI 3.1、Protobuf/ConnectRPC 服务与 Git/Handoff 快照冻结定义；RPC 服务本身尚未部署。

## 2. 启动方式

```bash
pnpm install
docker compose -f infra/docker-compose.yml up -d --wait postgres
psql "$DATABASE_URL" -f database/schema.sql
psql "$DATABASE_URL" -f database/init-data.sql
pnpm build
DATABASE_URL=postgresql://titan:titan@127.0.0.1:55432/titan node apps/control-plane/dist/main.js
```

本机只有 PostgreSQL 可用时，也可以将 `DATABASE_URL` 指向本机实例。Control Plane 默认监听 `127.0.0.1:3000`。

## 3. 关键环境变量

| 变量 | 示例 | 作用 |
|---|---|---|
| `DATABASE_URL` | `postgresql://titan:titan@localhost:55432/titan` | PostgreSQL 连接 |
| `DATABASE_POOL_MAX` | `10` | 连接池上限 |
| `OPENAI_API_KEY` / `DASHSCOPE_API_KEY` | 本机临时注入 | Provider Key；也支持 keychain 引用，不写入仓库 |
| `CONTROL_PLANE_PORT` | `3000` | API 监听端口 |
| `TITAN_API_URL` | `http://127.0.0.1:3000` | CLI API 地址 |
| `TITAN_DAEMON_TOKEN` | 本机临时注入 | CLI 的已认证设备操作，不传给普通 Task 请求 |

## 4. 发布前门禁

```bash
pnpm build
pnpm lint
pnpm typecheck
DATABASE_URL=postgresql://titan:titan@localhost:55432/titan pnpm test --force
node packages/contracts/openapi/generate.mjs --check
docker compose -f infra/docker-compose.yml config
```

## 5. 回滚与未包含内容

回滚时停止 API/Daemon，保留 PostgreSQL 数据和 Artifact 目录，恢复上一版本代码后重新执行兼容的 schema/init 脚本。旧 Artifact、旧 Run 和事件记录不覆盖删除。

本交付包不包含 Web UI、云端 Session、真实外部系统同步、生产发布、完整 Temporal Worker、多人协作和 Marketplace。本轮代码已在 Node 22 和 PostgreSQL 17 上通过验证；真实 Codex/Qwen Key 推理仍需单独验收，不将本轮 candidate 标记为完整 Phase 1 approved。
