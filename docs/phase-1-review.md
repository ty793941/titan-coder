# Phase 1 评审记录

> 评审日期：2026-11-22
>
> 当前评审结论：`approve`（Phase 1 Foundation / Headless Vertical Slice）
>
> 本轮代码复审：`approve`（已发现的派发、恢复、安全与完成判定缺陷均已复核修复）
>
> 完整 Phase 1 状态：`waiting_provider_acceptance`；目标 Docker PostgreSQL 17.12 全仓验证已通过

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

1. 使用真实 Codex API Key 和 Qwen 官方 API 凭证，在本机 Daemon 中各完成一次受控 Session，核对事件、Hook/Tool 审计、真实产物与 SHA-256。

目标 `postgres:17-alpine` 环境已在最终验证中恢复，实际 PostgreSQL 17.12、Node 22 下全部 229 个测试通过。

本轮已交付自动派发和持久 Outbox、暂停/取消/恢复、SSE 重连补拉、QRSPI 单用户审批链、本地 Skill 加载、原生 Codex 与 Qwen 多轮工具协议。多角色团队评审属于后续协作阶段，不作为额外 Phase 1 范围。

复审修复了秘密在快照落盘前未过滤、目录 symlink 越界、失效 Claim 占用、静默执行续租、上下文恢复、失败测试假完成、工具结果不确定状态、跨 Session 日志串用和后代进程清理。复审批准只证明这些已发现缺陷完成修复，不代替完整产品验收或任意风险的安全证明。

## 5. 回滚路径

- 代码回滚：保留 `chore/initial-project` 工作区差异，按文件回退，不删除用户工作区。
- 数据库回滚：本轮只新增幂等表、事实表、事件表和索引，没有删除字段或历史数据；回滚前应停止 Control Plane，保留 PostgreSQL 备份，再执行对应反向脚本。
- Artifact 回滚：数据库按 `artifact_id/version` 保留旧版本，文件按版本名保存；恢复时切换引用，不覆盖旧内容。
- Worktree 回滚：不自动删除 Worktree；先确认无运行进程、未同步事件和未提交变更，再由宿主清理。
