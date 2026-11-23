# Phase 2A Cloud Worker MVP 设计

> 文档状态：已确认设计
>
> 日期：2026-11-23
>
> 上游：`docs/implementation-roadmap.md` Phase 2、Phase 1 本机 Daemon 与执行协议

## 1. 目标

在 Phase 1 本机 Headless MVP 的基础上，增加一个可以在本机验收的 Cloud Worker MVP。Cloud Worker 使用 Docker 容器模拟云端 Session，复用现有 Agent Runtime、Dispatch、Progress、Checkpoint、Outbox 和 SSE 协议，并为后续真实 Temporal、Secret Broker、对象存储和 Kubernetes 执行环境保留适配器边界。

本切片必须实现以下闭环：

```text
本机 Session 暂停
  -> 生成 Checkpoint 与 Worktree Snapshot/Patch 清单
  -> 创建新的 cloud Session
  -> Cloud Worker 注册并领取执行租约
  -> 为 Session 创建独立 Docker 容器
  -> 启动现有 Runtime Worker
  -> 回传事件、心跳和最终状态
  -> 清理容器并保留可审计事实
```

## 2. 范围

### 2.1 包含

- `environmentType=cloud` 的 Cloud Worker 注册、心跳、能力声明和租约领取。
- 一个云端 Session 对应一个隔离 Docker 容器。
- 容器创建、启动、检查、停止、取消、超时和清理。
- 云端 Session 使用独立临时工作区和受限 Worktree 挂载。
- 本机到云端的 Session Handoff：暂停、Checkpoint、Snapshot/Patch 清单、目标 Session 创建和父子关系。
- 短期 Secret Lease 和进程内 Secret Broker 适配器。
- Cloud Worker 重启恢复、容器状态恢复和 `reconnecting` 状态。
- 云端容器事件到现有 `RunProgress`、Control Plane Outbox 和 SSE 的转换。
- 本地假 Runtime、假 Container Runtime、假 Secret Broker 和必要的真实 Docker 最小验收。
- OpenAPI、Zod、Daemon 协议、数据库脚本、测试和本地启动文档。

### 2.2 不包含

- 真实 Temporal Cluster、Redis Streams、MinIO、Vault、KMS 或 Kubernetes。
- 多租户计费、组织级云资源配额和生产级弹性调度。
- 容器内原生 Claude、Gemini 或其他新 Runtime。
- 热迁移同一个运行中的 Session 进程。
- 完整的多人协作 UI、评论、Presence、Team Inbox 和实时 Handoff 操作界面。
- 任意路径上传、任意工作区挂载或未经登记的 Git 仓库同步。

## 3. 设计原则

1. Control Plane 维护 Task、Session、Run、Artifact、Handoff 和权限事实；Cloud Worker 只负责执行和回传事实。
2. Cloud Worker 与本机 Daemon 复用同一个 Dispatch、Progress、Heartbeat 和取消协议。
3. Session Handoff 创建新的目标 Session，不把本机进程迁移成跨环境共享进程。
4. 所有容器、Secret Lease、Snapshot Transfer 和 Handoff 操作必须幂等并可恢复。
5. Secret 只通过引用和一次性租约传递；绝不写入数据库、Prompt、Artifact、事件、日志、argv 或普通环境变量。
6. Phase 2A 的本地实现通过接口隔离真实基础设施，后续替换实现不改变领域状态和协议。

## 4. 架构

### 4.1 Control Plane

Control Plane 继续负责：

- 创建和查询 Session、Run、Artifact 与 Handoff。
- 验证云端 Daemon 能力、Workspace 归属、Plan Hash、权限快照和 Secret Lease。
- 生成云端执行 Dispatch，保存容器生命周期和 Handoff 状态。
- 接收 Cloud Worker 的 Progress、Heartbeat、事件和最终状态。
- 将事实写入 PostgreSQL Outbox，并通过现有 SSE 向客户端提供事件。

Control Plane 不直接调用 Docker，不读取 Secret，不持有容器内工作区，也不通过普通环境变量向容器传递凭证。

### 4.2 Daemon 内置 Cloud Executor

Cloud Worker MVP 不新增独立服务进程，而是把 Cloud Executor 作为现有 Daemon 的执行模式。Daemon 以 `environmentType=cloud` 和云端能力注册时，由 Cloud Executor 负责：

- 使用已有 Daemon 注册和心跳协议连接 Control Plane。
- 领取带租约的云端 Dispatch。
- 校验 Dispatch 版本、Session、Run、Workspace Snapshot 和 Secret Lease。
- 通过 Container Runtime 创建并管理一个 Session 容器。
- 为容器准备临时工作区、Snapshot/Patch 输入和一次性 Secret 注入通道。
- 将容器 stdout/stderr、Runtime Event 和生命周期变化转换为平台 Progress。
- 处理取消、超时、Worker 重启、容器丢失和租约过期。
- 在执行结束后清理临时资源，并将清理结果写入审计事实。

Cloud Executor 不能推进 Task 阶段、批准 Artifact、修改权限或操作不属于自身租约的容器。

### 4.3 Session Container

每个云端 Session 创建一个独立容器。容器必须满足：

- 使用项目指定的固定 Runtime Worker 镜像或本地构建镜像。
- 使用临时根文件系统和独立临时工作区。
- 只挂载本次 Session 的已登记 Worktree 或 Snapshot 解包目录。
- 使用非 root 用户运行 Runtime Worker。
- 网络访问由显式配置控制；Phase 2A 默认只允许测试所需的本地服务访问。
- Secret 通过一次性 stdin 或受控 IPC 注入，禁止作为 argv 或普通环境变量传递。
- 容器退出后由 Cloud Worker 回收，容器 ID、退出码和清理状态保留在审计记录中。

### 4.4 可替换适配器

新增接口并提供本地实现：

```text
ContainerRuntime
  create(spec) -> ContainerHandle
  start(handle) -> void
  inspect(handle) -> ContainerStatus
  stop(handle, reason) -> void
  remove(handle) -> void

SnapshotTransfer
  createManifest(worktree) -> SnapshotManifest
  verifyManifest(manifest) -> void
  materialize(manifest, destination) -> MaterializedWorkspace

SecretBroker
  issueLease(input) -> SecretLease
  consumeLease(leaseRef, sessionId) -> SecretStream
  revokeLease(leaseRef) -> void
```

Phase 2A 的 `ContainerRuntime` 使用 Docker CLI 或 Docker API 的受限实现；`SnapshotTransfer` 使用本机受控目录和 Git Patch/Snapshot；`SecretBroker` 使用 Daemon 内 Cloud Executor 进程内存中的一次性租约。接口不得泄露真实 Secret 到返回对象、日志或持久化字段。

## 5. 状态与持久化

### 5.1 Cloud Execution

`cloud_execution` 表表示一次云端容器执行，至少包含：

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | UUID | 云端执行记录 ID |
| `session_id` | UUID | 目标 Session |
| `run_id` | UUID | 当前 Run |
| `daemon_id` | UUID | Cloud Worker Daemon |
| `container_id` | text nullable | Docker 容器 ID，不包含凭证 |
| `workspace_id` | UUID nullable | 已登记 Workspace |
| `status` | enum | `queued/creating/starting/running/stopping/completed/failed/cancelled` |
| `attempt` | integer | 执行尝试号 |
| `lease_expires_at` | timestamptz | Worker 租约截止时间 |
| `last_heartbeat_at` | timestamptz nullable | 最近 Worker 心跳 |
| `error_code` | text nullable | 稳定错误码 |
| `error_stage` | text nullable | 失败阶段 |
| `exit_code` | integer nullable | 容器退出码 |
| `created_at` | timestamptz | 创建时间 |
| `ended_at` | timestamptz nullable | 结束时间 |
| `version` | integer | 乐观并发版本 |

唯一约束为 `session_id + run_id + attempt`。同一执行尝试不能拥有两个活动容器。

### 5.2 Session Handoff

`session_handoff` 表表示一次环境交接，至少包含：

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | UUID | Handoff ID |
| `task_id` | UUID | 所属 Task |
| `source_session_id` | UUID | 本机源 Session |
| `target_session_id` | UUID nullable | 创建成功后的云端 Session |
| `checkpoint_id` | UUID | 暂停时生成的 Checkpoint |
| `snapshot_manifest` | JSONB | revision、URI、SHA-256、文件数和大小 |
| `status` | enum | `requested/snapshotting/transferring/starting/completed/failed` |
| `requested_by` | text | 操作者或系统角色引用 |
| `error_code` | text nullable | 稳定错误码 |
| `created_at` | timestamptz | 创建时间 |
| `completed_at` | timestamptz nullable | 完成时间 |
| `version` | integer | 乐观并发版本 |

源 Session 永远保留。目标 Session 的 `parentSessionId` 指向源 Session，目标 Run 使用新的 Run ID 和 attempt，不覆盖源 Run。

### 5.3 Secret Lease

`secret_lease` 表只保存引用和生命周期信息：

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | UUID | Lease ID |
| `credential_ref` | text | 如 `keychain://...` 或云端 Secret 引用 |
| `purpose` | text | Provider 或工具用途 |
| `session_id` | UUID | 绑定目标 Session |
| `expires_at` | timestamptz | 过期时间 |
| `consumed_at` | timestamptz nullable | 单次消费时间 |
| `revoked_at` | timestamptz nullable | 撤销时间 |
| `created_at` | timestamptz | 创建时间 |

表中禁止保存 Secret 值、Keychain 返回值、Base URL 私密凭证和容器注入内容。`credential_ref` 只允许已登记的引用格式。

### 5.4 容器状态机

```text
queued -> creating -> starting -> running -> stopping -> completed
                                      ├──> failed
                                      ├──> cancelled
                                      └──> reconnecting（Worker/网络失联时由 Session 状态表示）
```

状态转换必须使用版本条件更新。重复收到相同事件只返回已保存结果，不重复创建容器、写入最终状态或消费 Secret Lease。

## 6. Handoff 数据流

1. Control Plane 验证源 Session 属于目标 Task，状态为 `paused` 或可安全暂停，且调用者拥有 Handoff 权限。
2. Local Daemon 完成当前 Run 的暂停，生成 Checkpoint 并回传最后成功事件序列。
3. Handoff Service 验证 Checkpoint、Plan Hash、Workspace 归属和 Worktree 基线。
4. Snapshot Transfer 生成不可变清单：Git revision、Patch/Snapshot URI、SHA-256、文件数量、总大小和创建时间。
5. Control Plane 原子创建 Handoff、目标 cloud Session 和首个目标 Run；目标 Session 记录 `parentSessionId`。
6. Control Plane 为目标 Run 创建一次性 Secret Lease，并只向 Cloud Worker 发送 Lease 引用。
7. Cloud Worker 领取 Dispatch，验证清单和 Lease，物化临时工作区，创建容器并开始执行。
8. Cloud Worker 回传 `container.created`、`container.started`、Runtime Progress、Heartbeat 和终态事件。
9. 目标 Run 完成后，Control Plane 标记 Handoff `completed`；任一阶段失败则写入 `failed`、错误阶段和恢复建议。

同一 Handoff 的幂等键由调用者提供。重复请求返回原 Handoff 和目标 Session，不创建第二个目标 Session。

## 7. API 与协议变更

### 7.1 HTTP API

- `POST /sessions/:sessionId/handoff`
  - 请求：`targetEnvironment=cloud`、`checkpointId`、`workspaceSync`、`idempotencyKey`。
  - 响应：Handoff ID、源/目标 Session、状态、错误信息和 Snapshot 清单摘要。
  - 不接受 Secret、任意本地路径或未经登记的 URI。
- `GET /handoffs/:handoffId`
  - 返回 Handoff 状态、阶段、目标 Session、Snapshot 元数据和恢复建议。
- `POST /cloud-executions/:executionId/cancel`
  - 使用请求幂等键；重复取消返回当前终态。

### 7.2 ExecutionConfig 与 Dispatch

扩展执行配置和派发数据：

```json
{
  "environmentType": "cloud",
  "daemonId": "daemon_cloud_1",
  "runtime": "codex",
  "credentialRef": "keychain://provider-reference",
  "workspacePath": "/workspace/session",
  "snapshotManifestRef": "snapshot://handoff_1",
  "secretLeaseRef": "lease://lease_1",
  "allowedTools": ["artifact_write"],
  "maxTurns": 20,
  "timeoutMs": 900000
}
```

`credentialRef`、`snapshotManifestRef` 和 `secretLeaseRef` 都是引用；协议消息中不得出现 Secret 明文。旧版本本机 Daemon 收到没有云端字段的 Dispatch 时必须保持现有行为。

### 7.3 Daemon 能力

Cloud Worker 注册能力至少包含：

- `cloud-session`
- `container`
- `snapshot-transfer`
- `secret-lease`

Control Plane 只有在 Daemon 状态为 `ready`、能力完整、并发未满和心跳未过期时才向其派发云端 Session。

### 7.4 事件

新增事件类型：

- `container.created`
- `container.started`
- `container.stopped`
- `handoff.created`
- `handoff.completed`
- `handoff.failed`
- `cloud_execution.reconnecting`

事件沿用现有 Envelope，必须携带 `projectId`、`taskId`、`sessionId` 或 `runId`、`sequence`、`traceId`、`actor`、`payloadVersion` 和脱敏 payload。

## 8. 错误与恢复

| 错误码 | 阶段 | 可重试 | 恢复动作 |
|---|---|---:|---|
| `CLOUD_CONTAINER_CREATE_FAILED` | creating | 是 | 清理部分资源后按 attempt 重试 |
| `CLOUD_CONTAINER_START_FAILED` | starting | 是 | 检查镜像、Workspace 和能力后重试 |
| `CLOUD_CONTAINER_TIMEOUT` | running | 否 | 停止容器，Run 进入 failed |
| `CLOUD_CONTAINER_NOT_FOUND` | inspect | 是 | 查询租约后重建或进入 reconnecting |
| `CLOUD_WORKER_DISCONNECTED` | heartbeat | 是 | Session 进入 reconnecting，等待恢复扫描 |
| `CLOUD_SECRET_LEASE_EXPIRED` | secret | 否 | 生成 waiting_input 或 failed，不自动读取新凭证 |
| `CLOUD_SECRET_CONSUMED` | secret | 否 | 禁止重复执行，保留审计记录 |
| `HANDOFF_CHECKPOINT_INVALID` | snapshotting | 否 | Handoff failed，要求新的暂停和 Checkpoint |
| `HANDOFF_SNAPSHOT_FAILED` | snapshotting | 是 | 保留源 Session，按幂等键重试 |
| `HANDOFF_TRANSFER_FAILED` | transferring | 是 | 校验清单后重试物化 |
| `HANDOFF_TARGET_UNAVAILABLE` | starting | 是 | 等待可用 Cloud Worker，不标记源 Session 完成 |

Cloud Executor 或 Daemon 重启恢复规则：

1. 启动时扫描本地租约和 Control Plane 返回的未终态 `cloud_execution`。
2. 对 `creating`、`starting`、`running`、`stopping` 记录检查容器 ID 和状态。
3. 容器存在且租约有效时恢复事件采集，不重新创建容器。
4. 容器不存在时，先查询最后一个生命周期事件；若没有终态且策略允许，则使用原幂等键重建。
5. 租约过期、状态无法确认或 Snapshot 校验失败时进入 `reconnecting`/`failed`，并写入错误阶段。

## 9. 安全要求

- Cloud Worker 使用独立工作目录，不允许从 Dispatch 直接接受任意宿主路径。
- Snapshot 只允许引用 Control Plane 登记的 Worktree；校验 revision、路径归属、文件数量、总大小和 SHA-256。
- 容器以非 root 用户运行，使用临时文件系统和最小挂载范围。
- Secret Lease 绑定 Session、用途和过期时间，只能消费一次；撤销和消费均可审计。
- Secret 通过 stdin 或受控 IPC 注入，禁止 argv、普通环境变量、事件、Prompt、Artifact 和日志。
- 所有错误摘要、容器输出和 Snapshot 元数据执行 Secret、Token、绝对敏感路径和控制字符脱敏。
- Container Runtime 只能操作当前 Cloud Worker 租约下的容器。
- 取消、停止和删除前检查活动进程、未同步事件、责任归属和租约状态。

## 10. 测试策略

### 10.1 契约测试

- 验证新增 Schema 的枚举、长度、引用格式和必填字段。
- 验证旧本机 Dispatch 不带云端字段时仍能通过解析。
- 验证 Secret 明文字段被拒绝，OpenAPI 与 Zod 字段一致。
- 验证 Handoff 和 Cloud Execution 状态机拒绝越级转换和重复终态。

### 10.2 Container Runtime 测试

使用假的 Docker Client 覆盖：

- 幂等创建和同一执行尝试不重复创建。
- 启动、检查、停止、超时、容器不存在和清理。
- Docker 错误映射为稳定错误码和阶段。
- 容器 argv、环境、日志和错误摘要不包含 Secret。

### 10.3 Secret Broker 测试

- Lease 绑定目标 Session 和用途。
- Lease 过期、撤销或已消费时无法读取。
- 同一 Lease 并发消费最多成功一次。
- 持久化记录和日志只包含引用、状态和时间，不包含 Secret 值。

### 10.4 Handoff 测试

- 本机暂停生成 Checkpoint，且目标 Session 记录父 Session。
- Snapshot revision、路径、数量、大小或 SHA-256 不匹配时阻断目标启动。
- 重复 Handoff 返回相同目标，不创建重复 Session。
- 传输失败、目标 Worker 不可用和源 Session 失败均保留可追溯状态。

### 10.5 集成测试

- Cloud Worker 注册、领取 Dispatch、Heartbeat、Progress、Cancel 和最终清理。
- Worker 重启后恢复现有容器或进入明确 `reconnecting`。
- Control Plane Outbox/SSE 收到容器和 Handoff 生命周期事件。
- Docker 可用时运行一个不调用付费模型的最小真实容器验收；Docker 不可用时假适配器测试仍必须完整通过。

### 10.6 回归测试

必须继续通过现有本机 Daemon、Codex、Qwen、Control Plane、Web Console、OpenAPI、数据库和 CLI 测试。任何 Cloud Worker 变更不得改变 Phase 1 的本机默认路径。

## 11. 验收标准

1. 显式启用本地 Cloud Worker 后，它能以 cloud Daemon 身份注册，并在控制面显示 `ready`、能力和心跳。
2. 创建 cloud Session 后，Cloud Worker 能创建独立容器，启动现有 Runtime Worker，回传事件和最终状态，并完成清理。
3. 同一 `sessionId + runId + attempt` 不会产生两个活动容器。
4. Cloud Worker 或容器重启后，执行可以恢复事件采集，或者进入带原因的 `reconnecting`，不会静默完成或重复消费 Secret。
5. 本机 Session 可以暂停并创建新的 cloud Session，Checkpoint、Snapshot/Patch 清单、父子 Session、Run 和事件均可查询。
6. 取消、超时、Secret 过期、Snapshot 校验失败和目标不可用都显示稳定错误码、失败阶段和恢复动作。
7. 真实 Secret 不出现在数据库、Prompt、Artifact、事件、日志、argv 或普通环境变量中。
8. 现有本机 Daemon、Codex/Qwen Provider、UI、OpenAPI 和全仓测试继续通过。
9. 文档提供本地启动、Docker 依赖、Handoff 操作、故障恢复和清理方式。

## 12. 后续替换边界

Phase 2A 完成后，以下组件可以在不改变领域状态和公开协议的情况下替换：

- 本地 Container Runtime -> Kubernetes Job/Pod Runtime。
- 进程内 Secret Broker -> Vault/KMS/云 Secret Broker。
- 本地 Snapshot Transfer -> S3/MinIO 对象存储和远程 Git Bundle。
- PostgreSQL 恢复扫描 -> Temporal Workflow/Activity。
- 本地 Cloud Worker -> 多区域 Cloud Worker 集群。

这些替换不属于本切片的完成门槛。
