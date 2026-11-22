# Phase 1 测试报告

> 报告日期：2026-11-22
>
> 分支：`chore/initial-project`
>
> 阶段：Headless 本机执行增量；真实模型推理待凭证验收

## 1. 验证环境

- Node.js：本轮 `v22.23.5`，项目要求 Node 22。
- pnpm：`10.34.5`。
- PostgreSQL：最终验证使用 Docker `postgres:17-alpine`，实际版本 `17.12`，容器 `healthy`，监听 `127.0.0.1:55432`。测试按随机 schema 隔离并清理。
- Docker Compose：配置校验和目标数据库运行验证通过。此前使用临时 `14.19 (Homebrew)` 的联调也通过；最终已停止该临时实例，释放端口并在 PostgreSQL 17 重跑完整测试。
- Codex：本机 `codex-cli 0.147.0`，启用 `TITAN_CODEX_BINARY` 完成真实 App Server 认证、线程和恢复协议探测；使用合成测试 Key，不发起模型推理。
- Protobuf：本机 protoc 编译和消息往返测试通过；不代表已运行 ConnectRPC 服务。
- 最终测试数据库连接：`postgresql://titan:titan@127.0.0.1:55432/titan`（仅开发 Compose 默认凭证）。

## 2. 验证命令

```bash
pnpm build
pnpm lint
pnpm typecheck
DATABASE_URL=postgresql://titan:titan@127.0.0.1:55432/titan TITAN_CODEX_BINARY="$(command -v codex)" pnpm test --force
node packages/contracts/openapi/generate.mjs --check
docker compose -f infra/docker-compose.yml config --quiet
```

上述检查以退出码 `0` 完成。测试配置关闭缓存并依赖本包构建，避免沿用旧 dist 或数据库检查结果。当前 `lint` 脚本实际执行 TypeScript 静态检查，没有独立 ESLint 检查。

## 3. 测试覆盖

| 模块 | 验证内容 | 结果 |
|---|---|---|
| `@titan/contracts` | Zod、OpenAPI 路由/Schema 一致性、Proto 编译及往返 | 24 tests passed |
| `@titan/domain` | Task/Run 状态转换、Artifact 校验和 SHA-256 | 4 tests passed |
| `@titan/agent-core` | 原生 Provider、多轮工具、恢复、失败测试阻断、持久日志与清理 | 57 tests passed |
| `@titan/daemon-protocol` | Daemon 注册和事件信封字段 | 1 test passed |
| `@titan/daemon` | 常驻子进程、磁盘 Outbox、取消、超时、Worktree 与本机策略 | 24 tests passed |
| `@titan/cli` | 真 HTTP、退出码、增量 SSE、重连、断档补拉与暂停恢复 | 30 tests passed |
| `@titan/agent-runtime` | 真实文件、Worker、Skill 锁定、秘密与工作区边界 | 31 tests passed |
| `@titan/control-plane` | 认证、派发、租约、冷库/重启、产物审计、SSE、QRSPI、暂停恢复 | 58 tests passed |

本轮全仓共 `229 tests passed`，0 失败、0 跳过；Turborepo 测试及其构建共 16 个任务通过。不设置 `TITAN_CODEX_BINARY` 时跳过 1 项本机 Codex 探测；缺少 protoc 时另外跳过 3 项 Proto 测试，必须查看具体输出。

## 4. 端到端证据

`apps/control-plane/test/phase-1.e2e.test.ts` 保留基础 API 记录闭环。新增 `daemon-runtime.e2e.test.ts` 使用生产 Daemon、生产 Runtime Worker 和确定性 Adapter 验证：

1. 创建 Project 和 Task。
2. 批准 Plan、创建 execution Session 与 queued Run。
3. Daemon 自动注册、认领并启动真实 Node 子进程。
4. Worker 经 Permission、前后 Hook 和持久工具日志写入不可变文件。
5. 进度经本机 Outbox 上传，数据库登记 Artifact、Checkpoint、Hook 和工具执行终态。
6. 从 Artifact API 取回 URI，读取真实文件并核对 SHA-256、Session 归属及上游 Plan。
7. SSE 返回自动执行产生的 run.completed。
8. 人为丢失进度 ACK 后幂等重放，仍正常完成且不重复执行。
9. 使用生产 Worker 但没有 Key 的场景进入 waiting_input，不伪造模型成功。

其他测试覆盖无 Key 的原生 Codex 协议子进程、Qwen 本机 HTTP、取消顽固后代、暂停后迟到结果保护、恢复为新 Run、过期认领释放、静默任务续租、完整 QRSPI 批准链、符号链接拒绝和本地 Skill 摘要锁。

## 5. 已知限制

- 尚未使用真实 Codex/Qwen Key 执行模型推理；合成 Key 的协议认证探测不等价于账号调用成功。
- pause/resume 是检查点重建上下文和新 Run，不是跨进程原生会话热迁移。结果不确定的工具日志安全阻断，需要人工核实，不能保证任意命令恰好一次。
- 文件/命令工具提供白名单、秘密检查和进程监督，不提供通用 OS 沙箱。测试文件本身是本机可信代码；恶意并发目录替换仍需更强宿主隔离。
- SSE 直接读取 PostgreSQL 持久事件；Redis Streams 发布、完整 ConnectRPC 服务及云端 Handoff 未部署，详见协议说明。
- GoalGate 是有限规则，检查证据和未解决失败，不自动证明所有自然语言业务目标。
