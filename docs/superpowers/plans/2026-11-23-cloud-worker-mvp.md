# Phase 2A Cloud Worker MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在现有本机 Daemon 执行闭环上增加一个可用 Docker 容器运行的 Cloud Worker MVP，并完成可恢复的本机到云端 Session Handoff。

**Architecture:** Control Plane 继续维护 Session、Run、Handoff、Cloud Execution 和 Secret Lease 事实；Cloud Worker 通过现有 Daemon HTTP 协议领取 Dispatch，在每个 Session 对应的 Docker 容器中启动现有 Runtime Worker。Container Runtime、Snapshot Transfer 和 Secret Broker 放在独立 `packages/cloud-runtime` 包中，后续可以替换为 Kubernetes、对象存储和真实 Secret Broker。

**Tech Stack:** Node.js 22、TypeScript、pnpm Workspaces、NestJS/Fastify、Kysely/PostgreSQL、Zod/OpenAPI、Vitest、Docker CLI/SDK、现有 Daemon HTTP/JSON 协议。

## 2026-11-24 执行修订（优先于下方初稿）

下方 Task 1–10 是原始拆分，包含经源码复核发现的不兼容示例，禁止直接复制实施。以已确认的最新规格（`9695ede`）及本节为执行依据：不创建 `apps/cloud-worker`，不新建重复调度服务；所有云端执行适配放入 `apps/daemon/src/cloud/`，复用既有主循环、身份、Outbox 和 HTTP Client。

- [ ] A：新增容器专用 NDJSON stdin/stdout 入口，复用 `executeDispatch`；Secret 只进入启动帧，限制帧大小、重复启动、EOF 和取消；原本机 IPC 保持兼容。
- [ ] B：新增 `cloud` 契约和 Kysely 表；现有标识全部沿用 TEXT，保留 `baseUrlRef` 和可组合 ZodObject；容器事件通过独立、认证的 lifecycle 接口发送，不作为 Run 状态。
- [ ] C：新增一次性内存 Secret Broker、Docker 适配器和不可变快照存储；宿主解析 Keychain，容器不读取宿主凭证；快照物化完整工作目录，校验路径、哈希、数量、字节及敏感文件。
- [ ] D：Handoff API 只创建请求；源 Daemon 确认无活动 Worker、Outbox 已排空后导出快照并登记。控制面不访问 Docker 或源文件系统；目标 Checkpoint 创建新 ID 并绑定新 Session，不放开一般跨 Session 恢复规则。
- [ ] E：Daemon 加 cloud 执行模式，使用宿主 Docker 创建独立 Session 容器；`control` 轮询同时续租，生命周期和 Progress 继续回传控制面。容器工作区留在私有持久目录供工件读取。
- [ ] F：恢复时检查拥有者标签和确定性容器名；已有容器只重连日志，不重复消费租约或重新启动模型。失联/租约失效进入 `reconnecting` 或 `waiting_input`；绝不无条件重建已经执行过的容器。
- [ ] G：增加 Runtime 镜像及显式 cloud 配置；Cloud Executor 留在宿主，解决 macOS Keychain、loopback HTTP 和 Docker bind 路径问题。默认容器网络 `none`，需要模型网络时必须由本机可信配置指定网络。
- [ ] H：完成契约、数据库、假服务、真实 Docker、全仓回归、只读 Reviewer；更新验收文档与范围，再提交并通过代理推送。

执行分工：A 由 Runtime 开发在隔离工作树实施，B/D 由控制面开发在隔离工作树实施，C 由容器适配开发在隔离工作树实施，项目经理负责 E/F/G 集成和 H 门禁。每项必须先观察失败测试再实现，通过后以独立提交集成。用户文件 `docs/study.html` 始终排除。

---

## 文件边界

### 新增文件

- `packages/cloud-runtime/package.json`：Cloud Runtime 包元数据和构建脚本。
- `packages/cloud-runtime/tsconfig.json`：Cloud Runtime TypeScript 配置。
- `packages/cloud-runtime/src/types.ts`：Container Runtime、Snapshot Transfer、Secret Broker 的共享类型。
- `packages/cloud-runtime/src/container-runtime.ts`：容器生命周期接口和 Docker 实现。
- `packages/cloud-runtime/src/snapshot-transfer.ts`：受控 Worktree Snapshot/Patch 清单和物化实现。
- `packages/cloud-runtime/src/secret-broker.ts`：一次性内存 Secret Lease 实现。
- `packages/cloud-runtime/src/index.ts`：Cloud Runtime 公共导出。
- `packages/cloud-runtime/test/container-runtime.test.ts`：假的 Docker Client 生命周期测试。
- `packages/cloud-runtime/test/snapshot-transfer.test.ts`：Snapshot 清单和路径校验测试。
- `packages/cloud-runtime/test/secret-broker.test.ts`：租约绑定、过期和单次消费测试。
- `apps/cloud-worker/package.json`：Cloud Worker 进程元数据和脚本。
- `apps/cloud-worker/tsconfig.json`：Cloud Worker TypeScript 配置。
- `apps/cloud-worker/src/worker.ts`：注册、claim、容器执行、心跳和恢复循环。
- `apps/cloud-worker/src/container-session.ts`：单个云端 Session 的生命周期编排。
- `apps/cloud-worker/src/config.ts`：Cloud Worker 配置解析和边界校验。
- `apps/cloud-worker/src/main.ts`：Cloud Worker CLI 入口。
- `apps/cloud-worker/test/container-session.test.ts`：执行、取消、超时和清理测试。
- `apps/cloud-worker/test/worker.test.ts`：注册、领取、断线和恢复测试。
- `apps/cloud-worker/Dockerfile`：本地 Cloud Worker 镜像构建文件。
- `infra/cloud-worker.compose.yml`：显式启用的本地 Cloud Worker Compose 配置。

### 修改文件

- `packages/contracts/src/errors.ts`：加入 Cloud Worker 和 Handoff 错误码。
- `packages/contracts/src/schemas.ts`：加入 Cloud Execution、Handoff、Snapshot Manifest、Secret Lease Schema；扩展 ExecutionConfig 的 cloud 字段。
- `packages/contracts/src/events.ts`：加入容器和 Handoff 事件类型。
- `packages/contracts/openapi/generate.mjs`：声明 Handoff、Cloud Execution API 和脱敏字段描述。
- `packages/contracts/openapi/control-plane.openapi.json`：重新生成并校验 OpenAPI。
- `packages/contracts/test/schemas.test.ts`：契约边界和 Secret 明文拒绝测试。
- `packages/contracts/test/openapi.test.ts`：OpenAPI/Zod 一致性和新路由测试。
- `packages/daemon-protocol/src/execution.ts`：扩展 cloud Dispatch 引用字段。
- `packages/daemon-protocol/src/messages.ts`：扩展能力和 Cloud Worker 事件类型。
- `packages/daemon-protocol/proto/titan/daemon/v1/daemon_gateway.proto`：同步冻结的 Protobuf 字段。
- `packages/daemon-protocol/test/messages.test.ts`：旧本机 Dispatch 和新 cloud Dispatch 兼容性测试。
- `database/schema.sql`：新增 `cloud_execution`、`session_handoff`、`secret_lease` 表和幂等索引。
- `database/init-data.sql`：补充可重复执行的本地 Cloud Worker 初始化配置（不写入 Secret）。
- `apps/control-plane/src/database/types.ts`：新增三张表的 Kysely 类型。
- `apps/control-plane/src/app.module.ts`：注册 Handoff、Cloud Execution Controller/Service。
- `apps/control-plane/src/modules/daemons/daemons.service.ts`：校验 cloud 能力和派发条件。
- `apps/control-plane/src/modules/daemons/execution.service.ts`：创建/领取/心跳/恢复 Cloud Execution。
- `apps/control-plane/src/modules/daemons/execution-policy.ts`：校验 cloud 引用和能力要求。
- `apps/control-plane/src/modules/sessions/sessions.service.ts`：支持创建 cloud Session 和父 Session 关系。
- `apps/control-plane/src/modules/sessions/sessions.controller.ts`：增加 Handoff HTTP 路由入口。
- `apps/control-plane/src/modules/handoffs/handoffs.service.ts`：实现暂停后 Snapshot、目标 Session 和幂等 Handoff。
- `apps/control-plane/src/modules/handoffs/handoffs.controller.ts`：实现 Handoff 查询和创建 API。
- `apps/control-plane/src/modules/cloud-executions/cloud-executions.service.ts`：实现云端执行查询、取消和状态转换。
- `apps/control-plane/src/modules/cloud-executions/cloud-executions.controller.ts`：实现云端执行取消接口。
- `apps/control-plane/test/handoffs.integration.test.ts`：Handoff 数据库集成测试。
- `apps/control-plane/test/cloud-executions.integration.test.ts`：Cloud Execution 生命周期和恢复测试。
- `apps/control-plane/test/daemons.integration.test.ts`：cloud Daemon 注册和能力门禁测试。
- `apps/daemon/src/daemon-runner.ts`：抽取 environmentType/capabilities 配置，保持 local 默认行为。
- `apps/daemon/src/daemon-client.ts`：解析 Cloud Worker 所需的 Dispatch 引用字段。
- `apps/daemon/test/daemon-runner.integration.test.ts`：确认本机 Daemon 不受 cloud 字段影响。
- `package.json`：加入 Cloud Runtime/Cloud Worker 到工作区脚本或 Turbo 依赖图。
- `pnpm-workspace.yaml`：加入新增包和应用路径（如果当前 glob 未覆盖）。
- `docs/implementation-roadmap.md`：将 Phase 2A 标记为已实现边界并记录未接入真实基础设施的限制。
- `docs/cloud-worker-acceptance.md`：本地启动、Docker 检查、Handoff、恢复和清理说明。

---

### Task 1: 冻结 Cloud/Handoff 契约与错误码

**Files:**
- Modify: `packages/contracts/src/errors.ts`
- Modify: `packages/contracts/src/schemas.ts`
- Modify: `packages/contracts/src/events.ts`
- Modify: `packages/daemon-protocol/src/execution.ts`
- Modify: `packages/daemon-protocol/src/messages.ts`
- Modify: `packages/daemon-protocol/proto/titan/daemon/v1/daemon_gateway.proto`
- Test: `packages/contracts/test/schemas.test.ts`
- Test: `packages/daemon-protocol/test/messages.test.ts`

- [ ] **Step 1: Write failing contract tests**

在 `packages/contracts/test/schemas.test.ts` 增加以下行为测试：

```ts
it('accepts cloud execution references without accepting secret values', () => {
  expect(executionConfigSchema.parse({
    daemonId: 'daemon_cloud', runtime: 'codex', credentialRef: 'broker://codex',
    environmentType: 'cloud', snapshotManifestRef: 'snapshot://handoff_1',
    secretLeaseRef: 'lease://lease_1', workspacePath: '/workspace/session',
    allowedTools: ['artifact_write'], maxTurns: 10, timeoutMs: 900000,
  }).environmentType).toBe('cloud');
  expect(() => executionConfigSchema.parse({
    daemonId: 'daemon_cloud', runtime: 'codex', credentialRef: 'sk-secret-value',
    environmentType: 'cloud', workspacePath: '/workspace/session',
    allowedTools: [], maxTurns: 10, timeoutMs: 900000,
  })).toThrow();
});

it('accepts a handoff request and rejects arbitrary host paths', () => {
  expect(handoffCreateRequestSchema.parse({
    checkpointId: 'checkpoint_1', targetEnvironment: 'cloud',
    workspaceSync: { mode: 'git-snapshot' }, idempotencyKey: 'handoff_1',
  }).targetEnvironment).toBe('cloud');
  expect(() => handoffCreateRequestSchema.parse({
    checkpointId: 'checkpoint_1', targetEnvironment: 'cloud',
    workspaceSync: { mode: 'bind-mount', hostPath: '/Users/private' }, idempotencyKey: 'handoff_1',
  })).toThrow();
});
```

- [ ] **Step 2: Run tests and verify they fail**

Run: `pnpm --filter @titan/contracts test -- schemas.test.ts` and `pnpm --filter @titan/daemon-protocol test`

Expected: FAIL because `environmentType`, `snapshotManifestRef`, `secretLeaseRef` and Handoff schemas do not exist.

- [ ] **Step 3: Implement minimal schemas and protocol types**

Add these stable values:

```ts
export const cloudEnvironmentSchema = z.literal('cloud');
export const workspaceSyncSchema = z.object({ mode: z.enum(['git-snapshot', 'git-patch']) }).strict();
export const snapshotManifestSchema = z.object({
  revision: z.string().regex(/^[0-9a-f]{40}$/),
  uri: z.string().regex(/^snapshot:\/\/[A-Za-z0-9._-]+$/),
  checksum: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  fileCount: z.number().int().nonnegative().max(100000),
  totalBytes: z.number().int().nonnegative().max(512 * 1024 * 1024),
}).strict();
export const executionConfigSchema = z.object({
  daemonId: identifier, runtime: z.enum(['codex', 'qwen']), credentialRef: identifier,
  environmentType: z.enum(['local', 'cloud']).default('local'),
  snapshotManifestRef: identifier.optional(), secretLeaseRef: identifier.optional(),
  modelRef: identifier.optional(), workspacePath: z.string().min(1).max(4096),
  allowedTools: z.array(identifier).max(100), maxTurns: z.number().int().positive().max(10000),
  timeoutMs: z.number().int().positive().max(86400000),
}).strict().superRefine((value, context) => {
  if (value.environmentType === 'cloud' && !value.snapshotManifestRef) context.addIssue({ code: z.ZodIssueCode.custom, path: ['snapshotManifestRef'], message: 'cloud execution requires snapshotManifestRef' });
  if (value.environmentType === 'cloud' && !value.secretLeaseRef) context.addIssue({ code: z.ZodIssueCode.custom, path: ['secretLeaseRef'], message: 'cloud execution requires secretLeaseRef' });
});
export const handoffCreateRequestSchema = z.object({
  checkpointId: identifier, targetEnvironment: z.literal('cloud'), workspaceSync: workspaceSyncSchema, idempotencyKey,
}).strict();
```

Add the same optional fields to `ExecutionConfig` and `ExecutionConfig` protobuf fields 10–12. Add the cloud lifecycle event names and all Phase 2A error codes listed in the design specification. Keep local as the default for old Dispatch payloads.

- [ ] **Step 4: Run tests and verify they pass**

Run: `pnpm --filter @titan/contracts build && pnpm --filter @titan/contracts test && pnpm --filter @titan/daemon-protocol test`

Expected: all existing tests plus the new contract tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts packages/daemon-protocol
git commit -m "feat: freeze cloud execution contracts"
```

### Task 2: Add Cloud Runtime adapter package

**Files:**
- Create: `packages/cloud-runtime/package.json`
- Create: `packages/cloud-runtime/tsconfig.json`
- Create: `packages/cloud-runtime/src/types.ts`
- Create: `packages/cloud-runtime/src/container-runtime.ts`
- Create: `packages/cloud-runtime/src/snapshot-transfer.ts`
- Create: `packages/cloud-runtime/src/secret-broker.ts`
- Create: `packages/cloud-runtime/src/index.ts`
- Test: `packages/cloud-runtime/test/container-runtime.test.ts`
- Test: `packages/cloud-runtime/test/snapshot-transfer.test.ts`
- Test: `packages/cloud-runtime/test/secret-broker.test.ts`
- Modify: `package.json`
- Modify: `pnpm-workspace.yaml`

- [ ] **Step 1: Write failing adapter tests**

Test the public interfaces with a fake Docker client:

```ts
it('creates a container idempotently for one execution attempt', async () => {
  const docker = new FakeDockerClient();
  const runtime = new DockerContainerRuntime(docker);
  const spec = { executionKey: 'session_1:run_1:1', image: 'titan-agent-runtime:test', workspace: '/tmp/session_1', argv: ['node', '/app/worker.js'], env: { TITAN_RUN_ID: 'run_1' } };
  const first = await runtime.create(spec);
  const second = await runtime.create(spec);
  expect(second.id).toBe(first.id);
  expect(docker.created).toHaveLength(1);
});

it('consumes a secret lease once and never exposes it in the lease record', async () => {
  const broker = new InMemorySecretBroker({ 'broker://codex': 'secret-value' });
  const lease = await broker.issueLease({ credentialRef: 'broker://codex', sessionId: 'session_1', purpose: 'model', ttlMs: 1000 });
  const stream = await broker.consumeLease(lease.ref, 'session_1');
  expect(await readSecret(stream)).toBe('secret-value');
  await expect(broker.consumeLease(lease.ref, 'session_1')).rejects.toThrow('CLOUD_SECRET_CONSUMED');
  expect(JSON.stringify(lease)).not.toContain('secret-value');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @titan/cloud-runtime test`

Expected: FAIL because the package and adapter classes do not exist.

- [ ] **Step 3: Implement the adapter interfaces**

Define the public types without persisting a secret:

```ts
export type ContainerSpec = {
  executionKey: string; image: string; workspace: string; argv: string[];
  env: Record<string, string>; networkMode: 'none' | 'host';
};
export type ContainerHandle = { id: string; executionKey: string };
export type ContainerStatus = { id: string; state: 'created' | 'running' | 'stopped' | 'missing'; exitCode?: number };
export interface ContainerRuntime { create(spec: ContainerSpec): Promise<ContainerHandle>; start(handle: ContainerHandle, secret?: AsyncIterable<Uint8Array>): Promise<void>; inspect(handle: ContainerHandle): Promise<ContainerStatus>; stop(handle: ContainerHandle, reason: string): Promise<void>; remove(handle: ContainerHandle): Promise<void>; }
export type SnapshotManifest = { revision: string; uri: string; checksum: string; fileCount: number; totalBytes: number };
export interface SnapshotTransfer { createManifest(worktree: string): Promise<SnapshotManifest>; verifyManifest(manifest: SnapshotManifest): Promise<void>; materialize(manifest: SnapshotManifest, destination: string): Promise<string>; }
export type SecretLease = { ref: string; sessionId: string; purpose: string; expiresAt: string };
export interface SecretBroker { issueLease(input: { credentialRef: string; sessionId: string; purpose: string; ttlMs: number }): Promise<SecretLease>; consumeLease(ref: string, sessionId: string): Promise<AsyncIterable<Uint8Array>>; revokeLease(ref: string): Promise<void>; }
```

Implement Docker execution through a narrow injected client so unit tests never require Docker. Reject arbitrary host paths, `NODE_*`, `LD_*`, `DYLD_*`, credential-looking environment names and shell interpolation. Implement the in-memory broker with an atomic consumed flag and expiry check. Implement Snapshot Transfer with `git rev-parse HEAD`, a bounded `git diff --binary`, a SHA-256 manifest and a destination path under a caller-provided private root.

- [ ] **Step 4: Run adapter tests and package checks**

Run: `pnpm --filter @titan/cloud-runtime test && pnpm --filter @titan/cloud-runtime typecheck`

Expected: container, snapshot and secret tests pass; no secret value appears in fake Docker requests or broker records.

- [ ] **Step 5: Commit**

```bash
git add package.json pnpm-workspace.yaml packages/cloud-runtime
git commit -m "feat: add cloud runtime adapters"
```

### Task 3: Add cloud persistence and state transitions

**Files:**
- Modify: `database/schema.sql`
- Modify: `database/init-data.sql`
- Modify: `apps/control-plane/src/database/types.ts`
- Modify: `apps/control-plane/src/modules/daemons/execution-policy.ts`
- Test: `apps/control-plane/test/cloud-executions.integration.test.ts`
- Test: `apps/control-plane/test/daemons.integration.test.ts`

- [ ] **Step 1: Write failing database integration tests**

Add tests that register a cloud daemon, create a queued cloud execution and verify only a ready daemon with all required capabilities can claim it:

```ts
it('claims cloud execution only on a ready capable daemon', async () => {
  const daemon = await api.post('/api/daemons/register').send({
    machineName: 'cloud-worker', environmentType: 'cloud',
    capabilities: ['cloud-session', 'container', 'snapshot-transfer', 'secret-lease'],
    workspaceRoots: ['/var/lib/titan/cloud'], maxConcurrentSessions: 1, daemonVersion: '0.2.0',
  });
  expect(daemon.status).toBe(201);
  const dispatch = await createCloudSessionAndRun(daemon.body.daemonId);
  expect(dispatch.body.config.environmentType).toBe('cloud');
  expect(dispatch.body.config.secretLeaseRef).toMatch(/^lease:\/\//);
});

it('does not persist a secret in cloud execution or lease tables', async () => {
  const rows = await db.selectFrom('secret_lease').selectAll().execute();
  expect(JSON.stringify(rows)).not.toContain('secret-value');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `DATABASE_URL=postgresql://titan:titan@127.0.0.1:55432/titan pnpm --filter @titan/control-plane test -- cloud-executions.integration.test.ts`

Expected: FAIL because the tables, Kysely types and cloud execution fields do not exist.

- [ ] **Step 3: Add idempotent schema and Kysely types**

Append idempotent `CREATE TABLE IF NOT EXISTS` definitions for `cloud_execution`, `session_handoff` and `secret_lease`, plus indexes on `(daemon_id, status)`, `(session_id, run_id, attempt)` and `(source_session_id, created_at)`. Add `environment_type`, `snapshot_manifest_ref` and `secret_lease_ref` to the persisted execution config only through the existing JSONB column; do not add any secret value column.

Add matching `CloudExecutionTable`, `SessionHandoffTable` and `SecretLeaseTable` interfaces to `database/types.ts`, then add them to `Database`.

- [ ] **Step 4: Implement claim and state transition guards**

Extend `validateExecution` so cloud execution requires a cloud daemon, the four cloud capabilities, a `snapshotManifestRef`, a `secretLeaseRef`, and a workspace root that is registered for the daemon. Update `ExecutionService.claim` to insert or claim `cloud_execution` in the same transaction as `execution_job`, using `FOR UPDATE SKIP LOCKED` and the existing claim token hash. Add `cloudExecutionStatusTransition(current, next)` that permits only the state graph from the design.

- [ ] **Step 5: Run the integration tests**

Run: `pnpm --filter @titan/control-plane build && DATABASE_URL=postgresql://titan:titan@127.0.0.1:55432/titan pnpm --filter @titan/control-plane test -- cloud-executions.integration.test.ts daemons.integration.test.ts`

Expected: cloud capability gating, table persistence, lease-safe claim and duplicate-attempt protection pass.

- [ ] **Step 6: Commit**

```bash
git add database apps/control-plane
git commit -m "feat: persist cloud execution state"
```

### Task 4: Implement Handoff persistence and API

**Files:**
- Create: `apps/control-plane/src/modules/handoffs/handoffs.service.ts`
- Create: `apps/control-plane/src/modules/handoffs/handoffs.controller.ts`
- Modify: `apps/control-plane/src/modules/sessions/sessions.service.ts`
- Modify: `apps/control-plane/src/modules/sessions/sessions.controller.ts`
- Modify: `apps/control-plane/src/app.module.ts`
- Test: `apps/control-plane/test/handoffs.integration.test.ts`

- [ ] **Step 1: Write failing Handoff tests**

Cover the complete transaction and idempotency:

```ts
it('creates a cloud child session from a paused local session', async () => {
  const source = await createPausedLocalSession();
  const response = await api.post(`/api/sessions/${source.sessionId}/handoff`).send({
    checkpointId: source.checkpointId, targetEnvironment: 'cloud',
    workspaceSync: { mode: 'git-snapshot' }, idempotencyKey: 'handoff-1',
  });
  expect(response.status).toBe(201);
  expect(response.body.status).toBe('starting');
  expect(response.body.targetSessionId).toBeTruthy();
  const target = await api.get(`/api/sessions/${response.body.targetSessionId}`);
  expect(target.body.parentSessionId).toBe(source.sessionId);
});

it('returns the original Handoff on duplicate idempotency key', async () => {
  const source = await createPausedLocalSession();
  const body = { checkpointId: source.checkpointId, targetEnvironment: 'cloud', workspaceSync: { mode: 'git-patch' }, idempotencyKey: 'handoff-duplicate' };
  const first = await api.post(`/api/sessions/${source.sessionId}/handoff`).send(body);
  const second = await api.post(`/api/sessions/${source.sessionId}/handoff`).send(body);
  expect(second.body.id).toBe(first.body.id);
  expect(second.body.targetSessionId).toBe(first.body.targetSessionId);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @titan/control-plane test -- handoffs.integration.test.ts`

Expected: FAIL because the Handoff route, parent Session field and service do not exist.

- [ ] **Step 3: Add parent Session and Handoff fields**

Add `parent_session_id` and `environment_type` to `session`, and the `session_handoff` table fields from the design. Extend the domain `Session` type with optional `parentSessionId` and `environmentType`. Keep local Session creation defaulted to `environmentType='local'`.

- [ ] **Step 4: Implement `HandoffsService.create` transaction**

The service must lock the source Session and checkpoint, verify source ownership, status (`paused` or `waiting_input` with a checkpoint), task Plan Hash and Worktree registration, then create the Handoff, target Session, target Run, cloud execution config and event records in one transaction. Use the existing `IdempotencyService` with scope `session:${sourceSessionId}:handoff:create`. Store only Snapshot metadata and reference fields.

- [ ] **Step 5: Add Controller routes and query mapping**

Expose `POST /api/sessions/:sessionId/handoff` and `GET /api/handoffs/:handoffId`. Return `201` for a newly created Handoff, `200` for an idempotent replay, `409` for a changed request hash, and `400/404` for invalid Checkpoint or missing Session. Do not accept host paths or Secret fields.

- [ ] **Step 6: Run tests and commit**

Run: `pnpm --filter @titan/control-plane build && pnpm --filter @titan/control-plane test -- handoffs.integration.test.ts`

Expected: child Session, parent relation, Snapshot metadata, events and idempotency tests pass.

```bash
git add database apps/control-plane packages/domain
git commit -m "feat: add local to cloud session handoff"
```

### Task 5: Extend daemon protocol and local runner compatibility

**Files:**
- Modify: `apps/daemon/src/daemon-runner.ts`
- Modify: `apps/daemon/src/daemon-client.ts`
- Modify: `apps/daemon/src/cli.ts`
- Test: `apps/daemon/test/daemon-runner.integration.test.ts`
- Test: `apps/daemon/test/daemon-client.test.ts`

- [ ] **Step 1: Write failing compatibility tests**

Verify local defaults and cloud Dispatch validation independently:

```ts
it('keeps local daemon registration as the default', async () => {
  const options = parseDaemonArgs(['--url', 'http://127.0.0.1:3000', '--workspace-root', '/tmp/repo']);
  expect(options.environmentType).toBe('local');
});

it('preserves cloud references without treating them as local paths', async () => {
  const dispatch = makeDispatch({ environmentType: 'cloud', snapshotManifestRef: 'snapshot://handoff_1', secretLeaseRef: 'lease://lease_1', workspacePath: '/workspace/session' });
  expect(await validateCloudDispatch(dispatch)).toMatchObject({ config: { environmentType: 'cloud', snapshotManifestRef: 'snapshot://handoff_1' } });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @titan/daemon test -- daemon-runner.integration.test.ts daemon-client.test.ts`

Expected: FAIL because the runner hardcodes `environmentType='local'` and validates every Dispatch as a host Worktree.

- [ ] **Step 3: Add explicit environment configuration**

Extend `DaemonRunnerOptions` with `environmentType?: 'local' | 'cloud'` and `capabilities?: string[]`. Keep defaults `local` and `allowRuntime ?? ['codex', 'qwen']`. Registration uses the explicit values; local validation continues to require an absolute allowed workspace, while cloud validation accepts only `/workspace/session` and verifies Snapshot/Lease references.

Do not add Secret values to `DaemonClient`, `RunDispatch`, `PersistentOutbox` or CLI argv. Extend `sanitizeProgress` secret inputs to include any temporary broker stream token used by Cloud Worker.

- [ ] **Step 4: Run local regression tests**

Run: `pnpm --filter @titan/daemon build && pnpm --filter @titan/daemon test`

Expected: all existing local daemon tests pass, including process-group, Outbox, Worktree and integration tests.

- [ ] **Step 5: Commit**

```bash
git add apps/daemon packages/daemon-protocol
git commit -m "feat: preserve daemon protocol for cloud dispatch"
```

### Task 6: Implement Cloud Worker Session lifecycle

**Files:**
- Create: `apps/cloud-worker/package.json`
- Create: `apps/cloud-worker/tsconfig.json`
- Create: `apps/cloud-worker/src/config.ts`
- Create: `apps/cloud-worker/src/container-session.ts`
- Create: `apps/cloud-worker/src/worker.ts`
- Create: `apps/cloud-worker/src/main.ts`
- Test: `apps/cloud-worker/test/container-session.test.ts`
- Test: `apps/cloud-worker/test/worker.test.ts`

- [ ] **Step 1: Write failing lifecycle tests**

Cover registration, claim, start, progress, completion, cancel and timeout using fake `DaemonClient`, `ContainerRuntime`, `SnapshotTransfer` and `SecretBroker`:

```ts
it('runs one cloud Session and removes its container after completion', async () => {
  const runtime = new FakeContainerRuntime();
  const worker = makeCloudWorker({ runtime, dispatch: cloudDispatch() });
  await worker.runOnce();
  expect(runtime.calls).toEqual(['create', 'start', 'inspect', 'remove']);
  expect(worker.progressTypes()).toEqual(['container.created', 'container.started', 'completed']);
});

it('stops the container when control requests cancellation', async () => {
  const runtime = new FakeContainerRuntime({ control: { cancelRequested: true, status: 'running' } });
  await makeCloudWorker({ runtime, dispatch: cloudDispatch() }).runOnce();
  expect(runtime.calls).toContain('stop');
});

it('does not create a second container after worker restart', async () => {
  const runtime = new FakeContainerRuntime({ existing: { executionKey: 'session_1:run_1:1', id: 'container_1', state: 'running' } });
  await makeCloudWorker({ runtime, dispatch: cloudDispatch(), recovering: true }).runOnce();
  expect(runtime.created).toHaveLength(0);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @titan/cloud-worker test`

Expected: FAIL because the application and lifecycle orchestrator do not exist.

- [ ] **Step 3: Implement `ContainerSession`**

Implement the sequence below with `try/finally` cleanup:

```ts
await snapshotTransfer.verifyManifest(dispatch.config.snapshotManifestRef);
const workspace = await snapshotTransfer.materialize(manifest, privateWorkspace);
const lease = await secretBroker.consumeLease(dispatch.config.secretLeaseRef, dispatch.sessionId);
const handle = await runtime.create({ executionKey, image, workspace, argv, env: safeEnv, networkMode: 'none' });
await progress('container.created', { containerId: handle.id });
await runtime.start(handle, lease);
await progress('container.started', { containerId: handle.id });
await streamRuntimeWorker(handle, progress);
await runtime.inspect(handle);
await progress('completed', { containerId: handle.id });
```

On cancellation call `runtime.stop(handle, 'cancelled')`, map timeout to `CLOUD_CONTAINER_TIMEOUT`, and always call `remove` after the final state is acknowledged. Never log `lease` contents or the materialized Secret stream.

- [ ] **Step 4: Implement `CloudWorker` polling and recovery**

Register with `environmentType='cloud'` and the four cloud capabilities. Reuse `DaemonClient` claim/progress/control endpoints, heartbeat every 10 seconds, and back off transport errors. Track one active Session per configured concurrency slot. On startup inspect persisted active execution keys; reuse an existing container, otherwise claim only queued work. Emit `reconnecting` when the Control Plane is unavailable and resume after a successful heartbeat.

- [ ] **Step 5: Run lifecycle tests**

Run: `pnpm --filter @titan/cloud-worker build && pnpm --filter @titan/cloud-worker test`

Expected: lifecycle, cancellation, timeout, recovery and secret-safety tests pass.

- [ ] **Step 6: Commit**

```bash
git add apps/cloud-worker
git commit -m "feat: run cloud sessions in isolated containers"
```

### Task 7: Add local Docker startup and Cloud Worker wiring

**Files:**
- Create: `apps/cloud-worker/Dockerfile`
- Create: `infra/cloud-worker.compose.yml`
- Modify: `infra/docker-compose.yml`
- Modify: `apps/control-plane/src/app.module.ts`
- Modify: `package.json`
- Test: `apps/cloud-worker/test/docker-smoke.test.ts`

- [ ] **Step 1: Write the Docker smoke test**

The test must skip only when Docker is unavailable and otherwise assert a non-root container can run the worker health command without exposing the host workspace:

```ts
it.runIf(await dockerAvailable())('runs the Cloud Worker image with a private workspace', async () => {
  const result = await runDocker(['run', '--rm', '--read-only', '--user', '1000:1000', cloudWorkerImage, '--healthcheck']);
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain('CLOUD_WORKER_READY');
});
```

- [ ] **Step 2: Run the smoke test before implementation**

Run: `pnpm --filter @titan/cloud-worker test -- docker-smoke.test.ts`

Expected: FAIL because the Dockerfile and image command do not exist; if Docker is unavailable, the test reports an explicit skipped result.

- [ ] **Step 3: Add the image and Compose profile**

Build the image from the repository build output, run as UID/GID `1000:1000`, use a private `/workspace/session` volume, and pass only non-secret configuration such as Control Plane URL, Worker state directory, image name and capability list. Mount the Docker socket only in the explicit local development profile and document its local-only risk.

Add `pnpm cloud-worker` to the root scripts as `docker compose -f infra/docker-compose.yml -f infra/cloud-worker.compose.yml --profile cloud-worker up --build`.

- [ ] **Step 4: Run build and smoke checks**

Run: `pnpm build && pnpm cloud-worker -- --help` and, when Docker is available, `pnpm --filter @titan/cloud-worker test -- docker-smoke.test.ts`

Expected: all packages build; the health command prints `CLOUD_WORKER_READY`; the default Compose profile remains unchanged.

- [ ] **Step 5: Commit**

```bash
git add apps/cloud-worker/Dockerfile infra package.json
git commit -m "feat: add local cloud worker container profile"
```

### Task 8: Add OpenAPI, recovery, and full integration coverage

**Files:**
- Modify: `packages/contracts/openapi/generate.mjs`
- Modify: `packages/contracts/openapi/control-plane.openapi.json`
- Modify: `apps/control-plane/src/modules/cloud-executions/cloud-executions.service.ts`
- Create: `apps/control-plane/src/modules/cloud-executions/cloud-executions.controller.ts`
- Test: `apps/control-plane/test/cloud-executions.integration.test.ts`
- Test: `packages/contracts/test/openapi.test.ts`
- Test: `apps/daemon/test/daemon-runner.integration.test.ts`

- [ ] **Step 1: Write failing API and recovery tests**

Cover cancellation, Worker restart, lease expiration and SSE event ordering:

```ts
it('marks an unreachable cloud execution reconnecting instead of completed', async () => {
  const execution = await createClaimedCloudExecution();
  await markWorkerDisconnected(execution.id);
  const response = await api.get(`/api/cloud-executions/${execution.id}`);
  expect(response.body.status).toBe('reconnecting');
  expect(response.body.errorCode).toBe('CLOUD_WORKER_DISCONNECTED');
});

it('cancels a cloud execution idempotently', async () => {
  const execution = await createClaimedCloudExecution();
  const first = await api.post(`/api/cloud-executions/${execution.id}/cancel`).set('Idempotency-Key', 'cancel-1').send({});
  const second = await api.post(`/api/cloud-executions/${execution.id}/cancel`).set('Idempotency-Key', 'cancel-1').send({});
  expect(second.body.status).toBe(first.body.status);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @titan/control-plane test -- cloud-executions.integration.test.ts && pnpm --filter @titan/contracts test -- openapi.test.ts`

Expected: FAIL because Cloud Execution query/cancel routes and generated schemas are absent.

- [ ] **Step 3: Implement recovery scanner and API**

Add `CloudExecutionsService.get`, `cancel`, `heartbeat`, `markReconnecting` and `recover`. `recover` must inspect active rows, use Container Runtime status, and apply the persisted state transition with a version predicate. The controller exposes `GET /api/cloud-executions/:id` and `POST /api/cloud-executions/:id/cancel`, authenticated with the existing daemon/session policy.

Update OpenAPI generator definitions, regenerate the JSON file, and make the existing property/required-field consistency tests include the new fields and routes.

- [ ] **Step 4: Run integration and OpenAPI tests**

Run: `node packages/contracts/openapi/generate.mjs && pnpm --filter @titan/contracts test && pnpm --filter @titan/control-plane test -- cloud-executions.integration.test.ts`

Expected: generated OpenAPI is clean; recovery, cancel, event ordering and route tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts apps/control-plane apps/daemon
git commit -m "feat: add cloud execution recovery APIs"
```

### Task 9: Document operation and run the Phase 2A gate

**Files:**
- Create: `docs/cloud-worker-acceptance.md`
- Modify: `docs/implementation-roadmap.md`
- Test: existing full repository test suites

- [ ] **Step 1: Write the acceptance document**

Document exact commands:

```bash
docker info
pnpm install
pnpm build
docker compose -f infra/docker-compose.yml -f infra/cloud-worker.compose.yml --profile cloud-worker up --build
pnpm --filter @titan/cloud-worker test
```

Document how to create a local Session, pause it, call Handoff, observe `handoff.created`/`container.started`, cancel it, inspect `reconnecting`, and clean containers. State clearly that no real model key is required for lifecycle tests and that the Docker socket profile is local-only.

- [ ] **Step 2: Update the roadmap**

Mark only Phase 2A’s local Cloud Worker, Docker Session Container, local Snapshot Transfer, in-memory Secret Lease, Handoff and recovery scanner as implemented. Keep real Temporal, Redis, MinIO, Vault/KMS, Kubernetes, production Secret Broker and multi-tenant scheduling listed as future work.

- [ ] **Step 3: Run focused verification**

Run:

```bash
pnpm build
pnpm typecheck
pnpm lint
pnpm --filter @titan/contracts test
pnpm --filter @titan/cloud-runtime test
pnpm --filter @titan/cloud-worker test
DATABASE_URL=postgresql://titan:titan@127.0.0.1:55432/titan pnpm --filter @titan/control-plane test
pnpm --filter @titan/daemon test
```

Expected: all focused suites pass; Docker smoke is either passing or explicitly skipped with Docker unavailable.

- [ ] **Step 4: Run the full regression gate**

Run: `DATABASE_URL=postgresql://titan:titan@127.0.0.1:55432/titan pnpm test --force --concurrency=2 && node packages/contracts/openapi/generate.mjs --check`

Expected: existing Phase 1 and new Phase 2A tests pass, OpenAPI generation is unchanged after the check, and no test output contains a Secret value.

- [ ] **Step 5: Inspect and commit documentation**

```bash
git diff --check
git status --short
git add docs/cloud-worker-acceptance.md docs/implementation-roadmap.md
git commit -m "docs: add cloud worker acceptance guide"
```

### Task 10: Final review and proxy push

**Files:**
- Review all Phase 2A changes and generated OpenAPI/schema files.

- [ ] **Step 1: Inspect the complete diff**

Run: `git diff HEAD~9..HEAD --stat`, `git diff HEAD~9..HEAD -- packages/cloud-runtime apps/cloud-worker apps/control-plane packages/contracts packages/daemon-protocol database infra`

Confirm that `docs/study.html` remains untracked and no secret, token, private path or generated runtime state is staged.

- [ ] **Step 2: Run the final status and test evidence check**

Run: `git status --short && git log --oneline -10`

Expected: only `docs/study.html` remains untracked; all Phase 2A commits are present and the verification commands in Task 9 have passing output.

- [ ] **Step 3: Push through the configured proxy**

```bash
HTTPS_PROXY=http://127.0.0.1:7890 \
HTTP_PROXY=http://127.0.0.1:7890 \
ALL_PROXY=socks5://127.0.0.1:7890 \
git push origin chore/initial-project
```

Expected: the remote branch advances without adding `docs/study.html`.
