# Phase 1 评审记录

> 评审日期：2026-11-18
>
> 当前评审结论：`approve`（Phase 1 Foundation / Headless Vertical Slice）
>
> 完整 Phase 1 状态：`in_progress`

## 1. 需求覆盖

本轮实现完成了可运行的 Headless 基础垂直切片：共享契约、领域状态机、PostgreSQL 控制面、幂等和失败 Run 保留、Artifact 文件与元数据、基础 Agent Core、Worktree、CLI 和自动化验收均已归档。

核心证据位于：

- `packages/contracts/test/schemas.test.ts`
- `packages/domain/test/state-machine.test.ts`
- `packages/agent-core/test/*.test.ts`
- `apps/control-plane/test/phase-1.e2e.test.ts`
- `apps/daemon/test/*.test.ts`
- `apps/cli/test/commands.test.ts`

## 2. 安全与权限检查

- Tool Permission 默认无匹配即 Deny，显式 Deny 优先于 Ask/Allow。
- Workspace 路径会经过规范化，并检查是否位于授权根目录下。
- Git Worktree 创建使用受控仓库路径和分支名清洗。
- Tool 的 `toolUseId` 重复调用返回已保存结果，不重复执行 Executor。
- 凭证只作为 `credentialRef` 进入 Adapter 配置，未写入事件和 Artifact。
- API 错误统一转换为稳定错误码；内部异常不向普通响应暴露堆栈。

## 3. 数据一致性与恢复检查

- Project/Task/Session/Run 状态与事件、Outbox 在同一 PostgreSQL 事务中写入。
- 幂等键和 `(session_id, attempt)` 约束防止重复业务结果。
- 旧 Run 的错误字段和事件保留，重试创建新 Run。
- Artifact 内容写入受控本地目录，数据库保存版本、校验值和来源。
- 本地 Daemon 状态在心跳超时后转为 `reconnecting`，不会因为心跳丢失直接完成或失败业务 Run。

## 4. 需要后续变更的门禁

以下内容仍是完整 Phase 1 的后续门禁，不影响当前 Foundation 验收通过：

1. 接入真实 Codex App Server 和 Qwen Transport，并在本机 Daemon 中完成一次受控 Session。
2. 将 Daemon 控制面同步扩展为跨进程实时调度和自动派发。
3. 将 SSE 客户端补齐自动断线重连和断档补拉。
4. 将 CLI 的 SSE 自动断线重连和断档补拉接入实际 API。
5. 将 Plan 批准扩展为多角色版本评审和完整人工门禁。

## 5. 回滚路径

- 代码回滚：保留 `chore/initial-project` 工作区差异，按文件回退，不删除用户工作区。
- 数据库回滚：本轮只新增幂等表、事实表、事件表和索引，没有删除字段或历史数据；回滚前应停止 Control Plane，保留 PostgreSQL 备份，再执行对应反向脚本。
- Artifact 回滚：数据库按 `artifact_id/version` 保留旧版本，文件按版本名保存；恢复时切换引用，不覆盖旧内容。
- Worktree 回滚：不自动删除 Worktree；先确认无运行进程、未同步事件和未提交变更，再由宿主清理。
