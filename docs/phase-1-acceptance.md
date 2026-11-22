# Phase 1 本机验收说明

> 更新日期：2026-11-22
>
> Foundation 已由用户验收通过。本轮为自动执行、恢复、安全边界和协议产物增量；完整 Phase 1 保留 Codex/Qwen 真实凭证推理的验收门禁。

## 1. 验收对象

原 Headless 验收仍可通过 REST API、CLI、SSE、磁盘文件和数据库记录进行。根据用户追加需求，现提供本机 UI：运行 `pnpm ui` 后打开 `http://127.0.0.1:5173`，在“环境与 Key”添加凭证，详见 [UI 验收说明](ui-acceptance.md)。不把手动标记 Run 完成视作真实模型执行证据。

```text
Project → Task → 准备工件与批准 → Session(execution)
→ Run 自动入队 → Daemon 原子认领 → Node Worker
→ Provider + Tool/Permission/Hook → Artifact + Checkpoint
→ 本机 Outbox → PostgreSQL + 审计 + SSE
```

## 2. 环境与启动

要求 Node.js 22、pnpm 10.34.5、Git、PostgreSQL；Codex 原生执行另外要求安装 `codex`。Proto 编译测试需要 `protoc`；没有安装时对应三项测试明确跳过。

在项目根目录执行：

```bash
pnpm install
docker compose -f infra/docker-compose.yml up -d --wait postgres
pnpm build
DATABASE_URL=postgresql://titan:titan@127.0.0.1:55432/titan node apps/control-plane/dist/main.js
```

控制面默认监听 `http://127.0.0.1:3000`，启动时执行仓库中的幂等 SQL。若使用已有 PostgreSQL，设置对应的 `DATABASE_URL`，不要混用本机临时实例和 Docker 同一端口。

另一个终端运行：

```bash
node apps/daemon/dist/cli.js --url http://127.0.0.1:3000 --workspace-root "$PWD" --state-dir "$PWD/.titan/daemon"
```

`device.json` 保存设备身份与 token，权限 0600，不提交、不粘贴到对话。只查看设备 ID：

```bash
node --input-type=module -e 'import {readFile} from "node:fs/promises"; console.log(JSON.parse(await readFile(".titan/daemon/device.json", "utf8")).daemonId)'
```

日常使用 CLI 前可查看：

```bash
node apps/cli/dist/main.js --help
```

## 3. 无 Key 自动化验收

测试会使用独立 PostgreSQL schema、本机临时工作区、HTTP 服务和真实子进程；不会请求真实模型推理。测试先构建，避免 dist 与源码不一致：

```bash
pnpm build
DATABASE_URL=postgresql://titan:titan@127.0.0.1:55432/titan pnpm test --force
pnpm typecheck
pnpm lint
```

单独验收跨进程执行及丢失 ACK 后补发：

```bash
DATABASE_URL=postgresql://titan:titan@127.0.0.1:55432/titan pnpm --filter @titan/control-plane exec vitest run test/daemon-runtime.e2e.test.ts
```

该测试通过确定性 Adapter 驱动生产 Worker、文件工具和 Daemon，校验真实文件内容、SHA-256、Task Artifact API 元数据、上游 Plan、Hook/Tool 审计、Checkpoint 和 SSE。另有一条使用生产 Worker 且不提供 Key，必须进入 `waiting_input`，不能完成。

可进一步运行：

| 验收目标 | 测试入口 |
|---|---|
| 六阶段批准链、过期版本与跳级拒绝 | `apps/control-plane/test/gates.integration.test.ts` |
| 认证、重复认领、重启恢复、租约与产物审计 | `apps/control-plane/test/execution.integration.test.ts` |
| 暂停、恢复新 attempt、迟到进度与旧 Run 保留 | `apps/control-plane/test/pause.integration.test.ts` |
| SSE 增量、取消、慢查询和数据库异常隔离 | `apps/control-plane/test/events.integration.test.ts` |
| CLI 真 HTTP、真实退出码、重连与断档补拉 | `apps/cli/test/http.test.ts` |
| Daemon 常驻进程、子进程取消与本机磁盘 Outbox | `apps/daemon/test/daemon-runner.integration.test.ts` |
| Git Patch、二进制/未跟踪文件、源索引不变和敏感排除 | `apps/daemon/test/git-evidence.test.ts` |
| 真实 stdio Codex 协议与离线故障场景 | `packages/agent-core/test/codex-provider.test.ts` |
| Qwen 本地 HTTP 历史、模型与工具回合 | `packages/agent-core/test/qwen-provider.test.ts` |
| 本机 Skill 锁定、摘要及权限拒绝 | `apps/agent-runtime/test/skills.test.ts` |

## 4. 手动 REST 验收顺序

使用 OpenAPI 导入接口工具；所有创建请求都传稳定的 `Idempotency-Key`。第一步创建项目与 Task，或使用开发项目 `project_dev` 创建新 Task。

QRSPI 顺序固定为 `questions → research → design → structure → plan → implement`。对每个准备阶段创建 Artifact、批准最新版本，然后推进 Task：

```json
{
  "type": "questions",
  "content": "# 问题与确认结果\n验收目标：产出一个可检查的本机文件。",
  "sourceArtifacts": []
}
```

调用 `POST /api/tasks/{taskId}/artifacts` 得到 `artifactId`，再调用 `POST /api/artifacts/{artifactId}/approve`。从 research 起，`sourceArtifacts` 必须引用对应最新的直接上游 Artifact。使用 `GET /api/tasks/{taskId}` 的当前 `version` 推进：

```json
{ "stage": "research", "expectedVersion": 1 }
```

实际 `expectedVersion` 以查询结果为准；工件创建、批准和阶段推进均可能更新 Task 版本。跳级、未批准、旧版本或失效上游必须失败。

获得最新批准 Plan 的 `checksum` 与 Daemon ID 后，创建 execution Session：

```json
{
  "entryAgent": "project-manager",
  "goal": "调用 artifact.write 生成 acceptance.md，写入一段验收结果，然后说明产物引用。",
  "planHash": "替换为批准 Plan 的 sha256 checksum",
  "execution": {
    "daemonId": "替换为本机 Daemon ID",
    "runtime": "qwen",
    "credentialRef": "env://DASHSCOPE_API_KEY",
    "modelRef": "qwen-plus",
    "workspacePath": "/替换为已授权的真实绝对工作区",
    "allowedTools": ["artifact.write"],
    "maxTurns": 6,
    "timeoutMs": 120000
  },
  "idempotencyKey": "accept-session-001"
}
```

创建 `POST /api/sessions/{sessionId}/runs`，正文为 `{"idempotencyKey":"accept-run-001"}`。无 Key 时 Daemon 仍应认领并启动 Worker，Run 随后进入 `waiting_input`，而不是停留 queued 或返回 completed。

Key 配置后使用新的有效尝试；暂停的 Run 可以调用 resume，等待凭证的旧 Run 可先 cancel，再从同一 Session 创建新 Run。若 Plan 已更换，需要使用最新 Plan 建立新的合法 Session。

```bash
node apps/cli/dist/main.js run get RUN_ID --json
node apps/cli/dist/main.js run events RUN_ID --follow --json
node apps/cli/dist/main.js run pause RUN_ID --json
node apps/cli/dist/main.js run resume RUN_ID --idempotency-key accept-resume-001 --json
node apps/cli/dist/main.js run cancel RUN_ID --json
```

恢复不是进程热迁移：旧 Run 保持 paused，新 attempt 重建模型上下文并恢复已核实的工具结果。已有失败测试必须成功复测，产生中间产物不能解除失败门禁。产物查询使用 `GET /api/tasks/{taskId}/artifacts`，返回固定版本 URI、checksum、Session 与来源；文件正文留在授权工作区中。

## 5. 凭证准备与真实 Provider 验收

优先在本机密钥链配置凭证，Session 只保存 `keychain://服务名` 引用。也可使用专用终端内的临时环境变量；不要把值放在启动参数、Git、普通日志或 Artifact 中。

环境变量方案需要启动 Daemon 时显式声明允许传递的变量名：

```bash
node apps/daemon/dist/cli.js --url http://127.0.0.1:3000 --workspace-root "$PWD" --state-dir "$PWD/.titan/daemon" --credential-env DASHSCOPE_API_KEY --credential-env OPENAI_API_KEY
```

Qwen 使用 `env://DASHSCOPE_API_KEY`；Codex 使用 `env://OPENAI_API_KEY` 并将 runtime 改为 codex。模型名必须选择实际账号有权使用的型号；Codex 通过本机 App Server 的 `account/login/start` 接收内存 Key，不改成普通 Responses 文本调用。

真实 Provider 验收必须各完成一次同类受控任务，保留 Run ID、原生事件、工具/Hook 审计、文件 SHA-256 和 Artifact 元数据；不能只验证 Key 存在或返回文本。当前尚未执行这两项真实推理。

## 6. 本机 Skill 和执行策略

Skill 仅从工作区 `.titan/skills/skill-lock.json` 发现。锁中记录 `id/version/path/sha256/tools`；无锁为空 catalog，不自动安装。启用列表与 `trustedCode` 只来自本机 Daemon JSON 配置的 `localPolicy`，HTTP 派发不能扩大它们。

```json
{ "localPolicy": { "enabledSkills": ["project.review"], "trustedCode": false } }
```

摘要不符、越界、符号链接、过大文件和 Tool 权限扩张必须阻断。`pnpm test` 只有本机显式允许 trustedCode 才执行；本机测试代码拥有用户权限，当前不提供通用 OS 文件系统与网络沙箱。

## 7. 导出本机代码变更证据

从 Daemon 模块使用 `WorktreeManager.exportChanges`。这是本机模块接口，不是云端上传 API；先完成构建：

```javascript
import { WorktreeManager } from './apps/daemon/dist/main.js';

const manager = new WorktreeManager('/absolute/authorized-root');
const worktree = await manager.create({
  repositoryPath: '/absolute/authorized-root/project',
  branchName: 'task/acceptance',
});

// 在 worktree.path 中完成受控修改后执行。
const bundle = await manager.exportChanges({
  worktreePath: worktree.path,
  baseRevision: worktree.baseRevision,
  outputDirectory: '/absolute/authorized-root/evidence',
});
console.log(bundle.patchPath, bundle.snapshot.patchSha, bundle.previewPath);
```

导出文件为 `patch.diff`、`snapshot.json`、`preview.json`。核对基线、变更清单、排除原因和 SHA-256；在另外的临时克隆中运行 `git apply --check` 再做 apply roundtrip 验收。源索引、源提交和用户 Git 配置必须保持不变。超限、非 linked Worktree、非祖先基线、越界路径必须失败。

本机 bundle 将 untracked/binary 内容直接放进 Git binary patch；`excludedFiles` 是本机额外预览信息，不能直接当作云端 Handoff。导出不会上传或在用户工作树中应用 Patch。

## 8. 完成边界

本轮自动化验证不能替代真实 Codex/Qwen Key 推理验收。ConnectRPC 运行服务、云端 Handoff、跨机器 Snapshot 应用、多角色团队审批属于冻结接口或后续阶段，未宣称部署。基础 GoalGate 只检查 Provider 正常结束、预算、真实产物/通过测试证据和未解决的失败测试，不自动证明任意自然语言业务验收标准。
