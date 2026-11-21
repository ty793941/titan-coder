# 本机常驻 Daemon

本模块保留 `DaemonService`、`DaemonOutbox` 和原有工作区接口，新增真实 HTTP 控制面客户端、磁盘 Outbox、Node RuntimeWorker 进程监督和 CLI。共享执行类型严格来自 `@titan/daemon-protocol` 的 `execution.ts`，没有复制执行 DTO。

## 启动与配置

在仓库根目录构建依赖及运行时后启动：

```bash
pnpm --filter @titan/daemon... build
pnpm --filter @titan/agent-runtime... build
node apps/daemon/dist/cli.js --url http://127.0.0.1:3000 --workspace-root /absolute/repository
```

也可以使用只由本机操作者维护的 JSON 配置文件：

```json
{
  "baseUrl": "http://127.0.0.1:3000",
  "stateDirectory": "/absolute/repository/.titan/daemon",
  "workspaceRoots": ["/absolute/repository"],
  "allowRuntime": ["codex", "qwen"],
  "pollIntervalMs": 1000,
  "heartbeatIntervalMs": 10000,
  "retryMaxMs": 5000,
  "requestTimeoutMs": 5000,
  "cancelGraceMs": 300,
  "killGraceMs": 1000
}
```

```bash
node apps/daemon/dist/cli.js --config /absolute/local/daemon.json
```

简单命令行的默认状态目录为 `~/.titan/daemons/<控制面与根目录摘要>/`。配置文件必须指定绝对 `stateDirectory` 和非空的绝对 `workspaceRoots`。状态目录仅应放在本机磁盘，禁止提交到仓库。一个状态目录同时只允许一个常驻进程；正常退出会释放锁，重启时只回收可证明原 PID 已退出的锁。PID 复用或锁持有者不明时会安全拒绝启动，需要操作者检查。

`runnerCommand` 默认是当前 `process.execPath`，只接受与当前 Node 可执行文件相同的真实路径。`runnerArgs` 默认只有 `apps/agent-runtime/dist/worker.js` 的绝对路径，允许操作者通过本机配置指定另一个可信 `.js`、`.mjs` 或 `.cjs` 文件；不接受 `--eval` 或额外启动参数。HTTP Dispatch 中的命令、参数或环境配置都不会成为进程启动参数。

子进程环境只保留 `PATH`、`HOME`、`TMPDIR`、`LANG`。如部署方式需要明确注入 API Key，可以用本机配置的 `credentialEnv` 字段列出环境变量名，或重复使用 `--credential-env NAME`，配置中只写名称，不写 Key。`NODE_*`、`LD_*`、`DYLD_*` 注入变量被拒绝。`config.credentialRef` 原样交给可信 RuntimeWorker，由 RuntimeWorker 的本机凭证解析器读取；Daemon 不解析 keychain，也不把完整父进程环境传给子进程。

## HTTP 契约

| 操作 | 请求 | 响应 |
|---|---|---|
| 注册 | `POST /api/daemons/register`，JSON `DaemonRegistration` | 至少含 `daemonId`、`authToken` |
| 心跳 | `POST /api/daemons/:daemonId/heartbeat`，JSON `DaemonHeartbeat` | 任意成功响应，支持空响应 |
| 领取 | `POST /api/daemons/:daemonId/claim`，JSON `{}` | `200 RunDispatch` 或 `204` |
| 进度 | `POST /api/daemons/:daemonId/runs/:runId/progress`，JSON `RunProgress` | `ProgressAck` |
| 控制 | `GET /api/daemons/:daemonId/runs/:runId/control` | `{ "cancelRequested": boolean, "status": string }` |

注册以后的所有请求使用设备级 `Authorization: Bearer <authToken>`。`claimToken` 只在执行协议内使用。`401`、`403` 会停止进程并清理当前 Worker，不会重新注册以绕过撤销。跨主机 HTTP 被拒绝，远程控制面必须使用 HTTPS，重定向被拒绝。单个请求有超时与 2 MiB 响应上限，暂时网络失败使用最高 `retryMaxMs` 的指数退避。当前每台 Daemon 一次执行一个 Run，注册的 `maxConcurrentSessions` 固定为 `1`。

注册凭证通过同步落盘与原子重命名保存为 `device.json`，权限为 `0600`，状态目录权限为 `0700`。设备凭证绑定控制面 URL，不允许把其他控制面的设备凭证静默复用。CLI 只输出稳定错误码，不输出 HTTP 响应体、设备 token、claimToken 或 API Key。

## RuntimeWorker IPC

父进程使用 Node `spawn` 的 stdio IPC 通道启动固定本机程序，不使用 shell。启动后发送：

```typescript
{ dispatch: RunDispatch }
```

Worker 的进度消息必须是：

```typescript
{ type: 'progress', progress: RunProgress }
```

Worker 事件必须使用当前 `claimToken`，`sequence` 从正整数开始并递增；重复投递只能复用相同的 `eventId` 与内容。Daemon 不改写 Worker 的 `eventId` 或 `sequence`。不符合协议会清理进程组并生成 `WORKER_PROTOCOL_ERROR`。本次 Daemon 交付不实现 `apps/agent-runtime/dist/worker.js`，该文件由 Agent Runtime 工作项交付。

取消消息为 `{ type: 'cancel' }`。父进程轮询 `/control`，同时消费 ProgressAck 中的 `cancelRequested`。取消后先发 IPC，经过 `cancelGraceMs` 发送进程组 `SIGTERM`，再经过 `killGraceMs` 发送进程组 `SIGKILL`，即使父 Worker 已退出也覆盖残留后代。执行超时产生 `failed/RUN_TIMEOUT`，意外退出产生 `failed/WORKER_EXITED`。外部取消产生 `cancelled`，不会再被退出或超时覆盖为失败。`waiting_input` 作为本次执行的停止点处理。完成后仍占用 IPC 的 Worker 也会被有界清理。

## Outbox 与恢复

`PersistentOutbox` 使用 `outbox.jsonl` 存储 append 和 ack 操作，每条记录写入后执行 `fsync`。消息先进入磁盘队列，收到 `accepted: true` 后才把 ack 同步到磁盘；重建后重放未确认事件，保留原来的 `eventId`、`sequence` 和 `claimToken`。控制面必须按事件身份幂等确认重试；返回 `accepted: false` 会停止 Daemon，保留待处理记录供排查。崩溃造成的最后半条记录会被截断，完整但损坏的 JSON 记录会阻止恢复。

Outbox 是受保护的本机运行状态，包含重发所需的 claimToken；不得作为普通日志或 Artifact 上传。设备 authToken 只保存在设备凭证文件。`payload` 顶层只保留以下字段，其他字段被丢弃：

```text
text code message reason status turn toolCallId toolName reference evidence usage
output result error checkpointId exitCode signal source pid
```

嵌套对象过滤凭证、token、环境变量和 API Key 字段，并清理已知本机 Key、设备 token、当前 claimToken 以及常见凭证字符串。Checkpoint 按共享协议重建字段，采用相同文本清理。单条进度上限为 1 MiB，嵌套深度上限为 20。该过滤用于减少意外泄漏，可信 Worker 仍必须遵守自身的凭证保密规则。

## 工作区与 Worktree

允许根目录在启动时规范化。已存在路径使用 `realpath`，不存在的路径向上找到真实祖先后再拼接缺失部分；拒绝跨根目录 symlink、损坏 symlink 与越界路径。Dispatch 的工作目录必须已经存在且是目录。只向 Worker 传递规范化路径。

`WorktreeManager` 使用 Git 验证原始分支名称，拒绝参数注入与 revision shorthand，不再静默修改名称。创建工作树时会检出文件，路径包含分支摘要以避免名称碰撞，并通过目录锁防止并发创建同一工作树。不会删除现有工作树；崩溃留下的工作树创建锁需要操作者检查后处理。

## 验证与边界

```bash
pnpm --filter @titan/daemon... build
pnpm --filter @titan/daemon typecheck
pnpm --filter @titan/daemon test
```

集成测试使用真实本机 HTTP Server 与真实 Node 子进程，覆盖自动领取完成、断线补发、Daemon 进程崩溃后的 Outbox 恢复与 ack、凭证撤销、取消顽固进程及后代、超时、异常退出、协议拒绝、目录逃逸、固定启动命令和状态目录互斥。无需 API Key、Docker 或 PostgreSQL。

当前边界如下：

- 本次实现提供工作目录白名单、凭证隔离和进程组监督，没有实现操作系统文件系统沙箱或网络沙箱；可信 Node Worker 拥有本机用户的进程权限，工具级权限需要 RuntimeWorker 自身执行。
- `SIGTERM` 和 `SIGINT` 支持清理与落盘；Daemon 被 `SIGKILL` 或主机断电时无法立即清理仍在执行的 Worker，外部服务监督器及 Worker 的 IPC disconnect 处理应覆盖该情况。本次进程重启测试在 Worker 已完成且进度未确认时杀死 Daemon。
- Outbox 暂不压缩，也不提供跨机器共享或多进程并发写入；状态目录锁约束一个实例。Heartbeat sequence 目前按进程递增，重新启动后从 1 开始。
- 断网重放保证已落盘事件的交付；不会自动恢复被杀死 Worker 的内存执行状态。相同 Run 再次派发的序列起点需要控制面与 RuntimeWorker 共同约定，冻结 Dispatch 当前没有下一个序号字段。
- 本模块未修改控制面 API、数据库、共享类型或 RuntimeWorker 入口；跨模块联调与真实模型验证由主线验收。
