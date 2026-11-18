# Phase 1 测试报告

> 报告日期：2026-11-18
>
> 分支：`chore/initial-project`
>
> 阶段：Headless 本机 MVP 基础闭环

## 1. 验证环境

- Node.js：`v24.5.0`，项目引擎约束为 `>=22.0.0`。
- pnpm：`10.34.5`。
- PostgreSQL：Docker Compose 启动的 `postgres:17-alpine` 容器，映射到 `127.0.0.1:55432`，数据库名为 `titan`，容器状态为 `healthy`。
- Docker Compose：`infra/docker-compose.yml` 配置通过，Control Plane 集成测试已使用 Compose PostgreSQL 实际执行。
- 测试数据库连接：`postgresql://titan@127.0.0.1:55432/titan`。

## 2. 验证命令

```bash
DATABASE_URL=postgresql://titan@127.0.0.1:55432/titan pnpm lint
DATABASE_URL=postgresql://titan@127.0.0.1:55432/titan pnpm typecheck
DATABASE_URL=postgresql://titan@127.0.0.1:55432/titan pnpm test
DATABASE_URL=postgresql://titan@127.0.0.1:55432/titan pnpm build
docker compose -f infra/docker-compose.yml config
```

上述命令均以退出码 `0` 完成；Control Plane 测试另外使用 `postgresql://titan:titan@127.0.0.1:55432/titan` 验证。

## 3. 测试覆盖

| 模块 | 验证内容 | 结果 |
|---|---|---|
| `@titan/contracts` | 请求 Schema、事件身份和边界校验 | 2 tests passed |
| `@titan/domain` | Task/Run 状态转换、Artifact 校验和 SHA-256 | 4 tests passed |
| `@titan/agent-core` | Permission、Hook、Tool 幂等、Goal、Checkpoint、Adapter | 7 tests passed |
| `@titan/daemon-protocol` | Daemon 注册和事件信封字段 | 1 test passed |
| `@titan/daemon` | 工作区路径限制、Git Worktree、心跳重连 | 3 tests passed |
| `@titan/cli` | Task JSON 输出和稳定错误码 | 2 tests passed |
| `@titan/agent-runtime` | 无证据时 Goal 保持继续状态 | 1 test passed |
| `@titan/control-plane` | PostgreSQL 项目/Task、幂等、Run 重试、空 JSON body、Artifact、SSE、Daemon 控制面 | 6 tests passed |

全仓共报告 `26 tests passed`，无失败测试。

## 4. 端到端证据

`apps/control-plane/test/phase-1.e2e.test.ts` 验证了以下顺序：

1. 创建 Project 和 Task。
2. 创建 Session 和首个 Run。
3. 将首个 Run 标记为 `failed`，保留 `TOOL_EXECUTION_FAILED`。
4. 为同一 Session 创建第二个 Run，递增 `attempt` 并保留旧 Run。
5. 标记第二个 Run 为 `completed`。
6. 写入 `questions`、`plan`、`source-diff` 和 `test-report` Artifact。
7. 查询 Artifact 列表并确认类型集合。
8. 读取 Run SSE，确认出现 `event: run.completed`。

## 5. 已知限制

- Codex 和 Qwen Adapter 已完成统一接口、凭证引用检查和事件归一化；真实 Codex App Server/Qwen 网络 Transport 仍由宿主注入，未在自动化测试中调用外部模型服务。
- Daemon 的工作区、Worktree、进程组和重连状态已可在本机包内验证；Control Plane 的 Daemon 注册/心跳 API 与跨进程事件 Outbox 仍需下一轮接入。
- SSE 已支持历史回放、`Last-Event-ID`、序列断档错误和 `follow=true` 持久轮询订阅；CLI 端的自动断线重连和补拉仍需下一轮接入。
- Artifact 内容使用本地受控目录，S3/MinIO 只保留基础设施配置，尚未接入对象存储适配器。
- CLI 已实现 Task 创建和 Run 查询；Session、Run 事件订阅和 Daemon 管理命令仍需扩展。
- Daemon 已支持控制面注册、心跳、撤销和事件 Outbox 去重；跨进程实时调度和 Daemon 自动派发仍需下一轮接入。
