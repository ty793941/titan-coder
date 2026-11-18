# 第一阶段 Headless 本机 MVP 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在空仓库中交付一个通过 REST API、CLI 和 SSE 运行的本机 Headless MVP，打通 `Project → Task → Session → Run → Event / Artifact`，并验证权限、Hook、Worktree、Daemon、失败重试和恢复闭环。

**Architecture:** 使用 pnpm Workspace 管理共享契约、领域模型、Agent Core、Daemon 协议和应用服务。Control Plane 通过 NestJS/Fastify 维护 PostgreSQL 事实、Outbox 和 SSE；Agent Runtime 与本机 Daemon 通过版本化协议隔离，Runtime Adapter 负责 Codex/Qwen 事件归一化，CLI 只调用 API 和事件流。

**Tech Stack:** Node.js 22 LTS、TypeScript 5.x strict、pnpm Workspaces、Turborepo、NestJS + Fastify、Zod、Kysely + `pg`、PostgreSQL 17、Vitest、Pino、SSE、Git CLI。

**Spec:** `docs/superpowers/specs/2026-11-17-phase-1-headless-mvp-design.md`

## Global Constraints

- 使用 Node.js 22 LTS；所有 TypeScript 包启用严格模式。
- 第一阶段只实现本机 Headless MVP，不实现 Web UI、云端 Session、多人协作、外部系统和其他模型 Provider。
- 用户只能通过 Project Manager API/CLI 入口操作；内部 Runtime、Daemon 和 Tool 不直接对用户输出业务结论。
- 核心关系固定为 `Task → Session → Run → Artifact`；重试创建新 Run，不能覆盖旧 Run。
- PostgreSQL 是 Task、Session、Run、Artifact、Event、权限、审批、审计和 Outbox 的事实来源。
- 所有事件追加写入并携带 `eventId`、`payloadVersion`、`sequence`、`traceId`、关联实体和 `occurredAt`。
- 所有写接口支持幂等键和版本检查；冲突返回稳定错误码，不能静默覆盖。
- 所有 Tool 调用遵循输入校验 → Permission → Hook → 执行 → 输出校验 → 审计的顺序。
- 默认拒绝未声明的 Tool、路径、命令、网络和数据资源；高风险动作需要预览、审批和回滚信息。
- 数据库表结构只写入 `database/schema.sql`，初始化数据只写入 `database/init-data.sql`，脚本必须可重复执行并使用 UTF8MB4 兼容文本。
- 代码注释使用中文且只解释非显然原因；禁止无调用方的空抽象和无关重构。
- 每个新增行为遵循先写失败测试、确认失败原因、写最小实现、确认通过、再重构的 TDD 顺序。
- 不在本计划执行 Git commit、push 或发布操作；提交由用户明确要求后单独进行。

---

### Task 1: 建立 Workspace、共享契约和领域状态机

**Files:**
- Create: `package.json`
- Create: `pnpm-workspace.yaml`
- Create: `turbo.json`
- Create: `tsconfig.json`
- Create: `.node-version`
- Create: `.gitignore`
- Create: `README.md`
- Create: `packages/contracts/package.json`
- Create: `packages/contracts/tsconfig.json`
- Create: `packages/contracts/src/ids.ts`
- Create: `packages/contracts/src/errors.ts`
- Create: `packages/contracts/src/events.ts`
- Create: `packages/contracts/src/schemas.ts`
- Create: `packages/contracts/src/index.ts`
- Create: `packages/domain/package.json`
- Create: `packages/domain/tsconfig.json`
- Create: `packages/domain/src/entities.ts`
- Create: `packages/domain/src/state-machine.ts`
- Create: `packages/domain/src/artifacts.ts`
- Create: `packages/domain/src/index.ts`
- Create: `packages/contracts/test/schemas.test.ts`
- Create: `packages/domain/test/state-machine.test.ts`
- Create: `packages/domain/test/artifacts.test.ts`
- Create: `packages/agent-core/package.json`
- Create: `packages/daemon-protocol/package.json`
- Create: `packages/observability/package.json`

**Interfaces:**
- Consumes: Phase 1 design sections 5 and 6; no application code.
- Produces: `ProjectId`, `TaskId`, `SessionId`, `RunId`, `ArtifactId`; `ErrorCode`; `EventEnvelope<TPayload>`; Zod schemas for project/task/session/run/artifact/event; `TaskStage`, `TaskStatus`, `ExecutionStatus`, `ArtifactType`; `transitionTask`, `transitionExecution`, `createArtifactVersion`.

- [ ] **Step 1: Write the failing contract tests**

```typescript
import { describe, expect, it } from 'vitest';
import { eventEnvelopeSchema, taskCreateRequestSchema } from '@titan/contracts';

describe('contracts', () => {
  it('accepts a task creation request with bounded fields', () => {
    expect(taskCreateRequestSchema.parse({
      title: '认证重构',
      goal: '保持登录行为并补齐回归测试',
      acceptanceCriteria: ['认证测试通过'],
      priority: 'high',
    })).toMatchObject({ priority: 'high' });
  });

  it('rejects an event without traceable identity', () => {
    expect(() => eventEnvelopeSchema.parse({
      eventId: 'evt_1',
      eventType: 'task.created',
      payloadVersion: 1,
      sequence: 1,
      projectId: 'project_1',
      actor: { type: 'system', id: 'system' },
      occurredAt: new Date().toISOString(),
      payload: {},
    })).toThrow();
  });
});
```

- [ ] **Step 2: Run the contract tests and verify the expected missing-module failure**

Run: `pnpm --filter @titan/contracts test -- schemas.test.ts`

Expected: FAIL because `@titan/contracts` and its schemas do not exist yet.

- [ ] **Step 3: Write the failing state and artifact tests**

```typescript
import { describe, expect, it } from 'vitest';
import { createArtifactVersion, transitionExecution, transitionTask } from '../src';

describe('domain state transitions', () => {
  it('moves a task from questions to research', () => {
    expect(transitionTask('questions', 'start-research')).toEqual('research');
  });

  it('rejects a task transition that skips the approved stage', () => {
    expect(() => transitionTask('questions', 'start-implement')).toThrow('INVALID_STATE_TRANSITION');
  });

  it('moves a failed run to a new queued retry without changing the old run', () => {
    expect(transitionExecution('failed', 'retry')).toEqual('queued');
  });
});

describe('artifact versions', () => {
  it('creates version one with an immutable checksum reference', () => {
    const artifact = createArtifactVersion({
      artifactId: 'artifact_1', projectId: 'project_1', taskId: 'task_1',
      type: 'questions', uri: 'file:///tmp/questions.md', content: '# Questions',
      createdBy: { type: 'agent', id: 'project-manager' },
    });
    expect(artifact.version).toBe(1);
    expect(artifact.checksum).toMatch(/^sha256:/);
  });
});
```

- [ ] **Step 4: Run the domain tests and verify they fail for missing implementations**

Run: `pnpm --filter @titan/domain test`

Expected: FAIL because the state transition and artifact functions are not defined.

- [ ] **Step 5: Add the workspace and package configuration**

Set the root package name to `@titan/root`, package manager to `pnpm@10.34.5`, engine to `node >=22.0.0`, and scripts to `build`, `dev`, `lint`, `typecheck`, and `test` using Turborepo. Set `pnpm-workspace.yaml` to include `apps/*` and `packages/*`; set `turbo.json` task dependencies so `build` depends on `^build`, while `test`, `lint`, and `typecheck` depend on `^build`.

Use a shared strict `tsconfig.json` with `target: ES2022`, `module: NodeNext`, `moduleResolution: NodeNext`, `noUncheckedIndexedAccess: true`, `exactOptionalPropertyTypes: true`, and declaration output enabled for packages.

- [ ] **Step 6: Implement the contracts package minimally**

Define branded string aliases for IDs, the stable `ErrorCode` union, the `EventEnvelope<TPayload>` type, event type literals, and Zod schemas. Bound text to 1–2000 characters, arrays to 1–50 items, and require positive integer `sequence`/`payloadVersion`. Export only through `src/index.ts`.

- [ ] **Step 7: Implement the domain package minimally**

Define the Task, Session, Run, Artifact and Project value shapes. Implement transition tables as pure functions; return the next state for valid commands and throw an error whose message begins with `INVALID_STATE_TRANSITION:` for invalid commands. `createArtifactVersion` must compute a SHA-256 checksum of the UTF-8 content and return version `1` with `reviewState: 'pending'`.

- [ ] **Step 8: Run package verification**

Run: `pnpm install && pnpm --filter @titan/contracts test && pnpm --filter @titan/domain test && pnpm typecheck`

Expected: all contract/domain tests pass and TypeScript reports zero errors. If Node 20 rejects the declared engine, use the installed Node 24 binary for verification while keeping the project engine at Node 22.

### Task 2: Implement the Control Plane, PostgreSQL schema, Outbox and SSE

**Files:**
- Create: `apps/control-plane/package.json`
- Create: `apps/control-plane/tsconfig.json`
- Create: `apps/control-plane/src/main.ts`
- Create: `apps/control-plane/src/app.module.ts`
- Create: `apps/control-plane/src/database/database.module.ts`
- Create: `apps/control-plane/src/database/database.service.ts`
- Create: `apps/control-plane/src/database/repositories/project.repository.ts`
- Create: `apps/control-plane/src/database/repositories/task.repository.ts`
- Create: `apps/control-plane/src/database/repositories/session.repository.ts`
- Create: `apps/control-plane/src/database/repositories/run.repository.ts`
- Create: `apps/control-plane/src/database/repositories/event.repository.ts`
- Create: `apps/control-plane/src/database/repositories/artifact.repository.ts`
- Create: `apps/control-plane/src/modules/projects/projects.controller.ts`
- Create: `apps/control-plane/src/modules/projects/projects.service.ts`
- Create: `apps/control-plane/src/modules/tasks/tasks.controller.ts`
- Create: `apps/control-plane/src/modules/tasks/tasks.service.ts`
- Create: `apps/control-plane/src/modules/sessions/sessions.controller.ts`
- Create: `apps/control-plane/src/modules/sessions/sessions.service.ts`
- Create: `apps/control-plane/src/modules/runs/runs.controller.ts`
- Create: `apps/control-plane/src/modules/runs/runs.service.ts`
- Create: `apps/control-plane/src/modules/events/events.controller.ts`
- Create: `apps/control-plane/src/modules/events/events.service.ts`
- Create: `apps/control-plane/src/common/http-error.filter.ts`
- Create: `apps/control-plane/src/common/idempotency.service.ts`
- Create: `apps/control-plane/test/tasks.integration.test.ts`
- Create: `apps/control-plane/test/runs.integration.test.ts`
- Create: `database/schema.sql`
- Create: `database/init-data.sql`
- Create: `infra/docker-compose.yml`
- Create: `.env.example`

**Interfaces:**
- Consumes: `@titan/contracts` schemas and errors; `@titan/domain` entities and transition functions.
- Produces: `POST /api/projects`, `POST /api/projects/:projectId/tasks`, `GET /api/tasks/:taskId`, `POST /api/tasks/:taskId/sessions`, `GET /api/sessions/:sessionId`, `POST /api/sessions/:sessionId/runs`, `GET /api/runs/:runId`, `POST /api/runs/:runId/cancel`, `GET /api/runs/:runId/events`, `GET /api/tasks/:taskId/artifacts`; repositories with transactional outbox writes.

- [ ] **Step 1: Write the failing API integration test for project and task creation**

```typescript
it('creates a project and task with a traceable task.created event', async () => {
  const project = await api.post('/api/projects').send({ name: 'Titan', goal: '验证交付闭环' }).expect(201);
  const task = await api.post(`/api/projects/${project.body.id}/tasks`)
    .set('Idempotency-Key', 'task-create-1')
    .send({ title: '首个任务', goal: '验证 Task 到 Run', acceptanceCriteria: ['Run 可恢复'], priority: 'high' })
    .expect(201);
  expect(task.body.stage).toBe('questions');
  expect(await queryEvents(task.body.id)).toContainEqual(expect.objectContaining({ eventType: 'task.created' }));
});
```

- [ ] **Step 2: Run the API test and verify it fails because the app and schema are absent**

Run: `pnpm --filter @titan/control-plane test -- tasks.integration.test.ts`

Expected: FAIL because no NestJS application or PostgreSQL tables exist.

- [ ] **Step 3: Write failing tests for idempotency and retry semantics**

```typescript
it('returns the original task for a repeated idempotency key', async () => {
  const first = await createTask('task-create-2');
  const second = await createTask('task-create-2');
  expect(second.body.id).toBe(first.body.id);
});

it('creates a second run after failure and preserves the first run', async () => {
  const session = await createSession();
  const first = await createRun(session.body.id);
  await markRunFailed(first.body.id, 'TOOL_EXECUTION_FAILED');
  const retry = await createRun(session.body.id);
  expect(retry.body.attempt).toBe(2);
  expect((await getRun(first.body.id)).body.errorCode).toBe('TOOL_EXECUTION_FAILED');
});
```

- [ ] **Step 4: Add idempotent PostgreSQL schema and initialization scripts**

Create UTF8-compatible PostgreSQL tables for `project`, `task`, `session`, `run`, `artifact`, `event`, `outbox_event`, `idempotency_record`, `daemon`, `checkpoint`, `tool_call`, `hook_execution`, `permission_snapshot`, `approval` and `audit_log`. Add unique constraints for public IDs, `(scope, idempotency_key)`, `(run_id, sequence)` and event IDs. Use `CREATE TABLE IF NOT EXISTS` and `CREATE INDEX IF NOT EXISTS`. `init-data.sql` inserts one development organization/project only when absent.

- [ ] **Step 5: Implement Kysely database access and transaction boundaries**

Configure `pg` with an explicit PostgreSQL connection string, pool limits and `application_name`. Keep SQL table types in the Control Plane database module. Each create/state transition transaction writes the business row, event row and outbox row together. Repositories return domain-shaped objects and never expose Kysely rows to controllers.

- [ ] **Step 6: Implement NestJS controllers and stable error mapping**

Use Zod at the HTTP boundary, map validation to `VALIDATION_FAILED`, missing resources to `RESOURCE_NOT_FOUND`, duplicate keys with different payloads to `IDEMPOTENCY_CONFLICT`, and stale versions to `VERSION_CONFLICT`. Return `{ code, message, details, traceId, retryable, occurredAt }` for errors. Controllers only parse request metadata and call application services.

- [ ] **Step 7: Implement SSE from the persisted event stream**

`GET /api/runs/:runId/events` must accept `Last-Event-ID`, query events after that numeric sequence, emit each event with `id: sequence` and `event: eventType`, then subscribe to new outbox projections. On sequence gaps, return a typed `EVENT_SEQUENCE_GAP` detail instructing the client to replay from the database.

- [ ] **Step 8: Run database and API verification**

Run: `docker compose -f infra/docker-compose.yml up -d postgres`

Run: `pnpm --filter @titan/control-plane test -- --runInBand && pnpm typecheck`

Expected: project/task/session/run integration tests pass against a disposable PostgreSQL database; duplicate writes, stale versions, old-run preservation and event sequence behavior are covered.

### Task 3: Implement Agent Runtime Core and Runtime Adapters

**Files:**
- Create: `packages/agent-core/package.json`
- Create: `packages/agent-core/tsconfig.json`
- Create: `packages/agent-core/src/types.ts`
- Create: `packages/agent-core/src/tool-registry.ts`
- Create: `packages/agent-core/src/permission-engine.ts`
- Create: `packages/agent-core/src/hook-runner.ts`
- Create: `packages/agent-core/src/checkpoints.ts`
- Create: `packages/agent-core/src/goal-gate.ts`
- Create: `packages/agent-core/src/agent-loop.ts`
- Create: `packages/agent-core/src/adapters/runtime-adapter.ts`
- Create: `packages/agent-core/src/adapters/fake-adapter.ts`
- Create: `packages/agent-core/src/adapters/codex-adapter.ts`
- Create: `packages/agent-core/src/adapters/qwen-adapter.ts`
- Create: `packages/agent-core/src/index.ts`
- Create: `apps/agent-runtime/package.json`
- Create: `apps/agent-runtime/tsconfig.json`
- Create: `apps/agent-runtime/src/main.ts`
- Create: `packages/agent-core/test/permission-engine.test.ts`
- Create: `packages/agent-core/test/tool-registry.test.ts`
- Create: `packages/agent-core/test/agent-loop.test.ts`
- Create: `packages/agent-core/test/adapters.test.ts`

**Interfaces:**
- Consumes: `EventEnvelope`, stable errors, Run/Checkpoint domain types and Control Plane event persistence interface.
- Produces: `ToolRegistry.register/execute`, `PermissionEngine.decide`, `HookRunner.run`, `AgentLoop.run`, `RuntimeAdapter` with `createSession/streamEvents/sendInput/pause/resume/cancel/close`, normalized `RuntimeEvent` values.

- [ ] **Step 1: Write a failing permission test**

```typescript
it('denies an action when any policy layer explicitly denies it', () => {
  const engine = new PermissionEngine([
    { source: 'platform', action: 'workspace.write', resource: '/repo', decision: 'allow' },
    { source: 'run', action: 'workspace.write', resource: '/repo', decision: 'deny' },
  ]);
  expect(engine.decide({ action: 'workspace.write', resource: '/repo/a.ts' }).decision).toBe('deny');
});
```

- [ ] **Step 2: Run it and verify it fails because the engine is absent**

Run: `pnpm --filter @titan/agent-core test -- permission-engine.test.ts`

Expected: FAIL with the missing `PermissionEngine` implementation.

- [ ] **Step 3: Write failing Tool/Hook tests**

```typescript
it('runs permission and pre/post hooks around a tool exactly once', async () => {
  const calls: string[] = [];
  const registry = new ToolRegistry({ permission: allowAll(), hooks: recordingHooks(calls) });
  registry.register({ name: 'test.echo', version: 1, input: echoInput, execute: async input => input });
  await registry.execute({ toolUseId: 'tool_1', name: 'test.echo', input: { value: 'ok' }, context: testContext() });
  expect(calls).toEqual(['permission', 'pre', 'execute', 'post', 'audit']);
});
```

- [ ] **Step 4: Implement PermissionEngine and HookRunner minimally**

Make Deny win over Ask and Allow; make Ask return `waiting_input` when no approval token is present. HookRunner orders hooks by priority, applies timeout and max attempt limits, and marks blocking hook failure as denied. Every decision returns a serializable reason and policy source.

- [ ] **Step 5: Implement ToolRegistry with idempotent toolUseId handling**

Validate the registered input schema before permission evaluation, keep an in-memory result cache for the package-level core and expose a persistence callback for the Control Plane. A repeated `toolUseId` returns the original result without invoking the executor. Normalize executor failures to `TOOL_EXECUTION_FAILED` and timeout to `TOOL_TIMEOUT`.

- [ ] **Step 6: Write failing AgentLoop, GoalGate and Checkpoint tests**

```typescript
it('does not stop merely because the adapter emitted no tool call', async () => {
  const result = await loop.run({ goal: goalRequiringArtifact(), adapter: adapterWithTextOnlyFirstTurn() });
  expect(result.status).toBe('continue');
});

it('resumes from the latest successful checkpoint without repeating a tool', async () => {
  const result = await loop.resume({ checkpointId: 'checkpoint_2' });
  expect(result.replayedToolUseIds).toEqual(['tool_1']);
});
```

- [ ] **Step 7: Implement AgentLoop, GoalGate and CheckpointStore**

AgentLoop must emit lifecycle events, drain adapter events, route Tool requests through ToolRegistry, persist a checkpoint before an irreversible action, and call GoalGate with evidence. GoalGate returns `satisfied`, `continue`, `defer`, `impossible`, or `error`; it must reject completion without an artifact/test evidence reference.

- [ ] **Step 8: Implement unified RuntimeAdapter and Codex/Qwen adapters**

Define provider-independent session/input/checkpoint types. `FakeAdapter` drives deterministic tests. `CodexAdapter` wraps a transport interface for the Codex App Server and maps native messages to normalized events. `QwenAdapter` wraps a generic chat/stream transport and uses the same loop/tool contract. Missing transport or credential reference returns `RUNTIME_ADAPTER_UNAVAILABLE`; no secret value is stored in events or logs.

- [ ] **Step 9: Run Runtime verification**

Run: `pnpm --filter @titan/agent-core test && pnpm --filter @titan/agent-core build && pnpm typecheck`

Expected: permission precedence, hook order, tool idempotency, loop continuation, checkpoint replay and Codex/Qwen event normalization tests pass.

### Task 4: Implement Local Daemon, Worktree Manager and CLI

**Files:**
- Create: `packages/daemon-protocol/tsconfig.json`
- Create: `packages/daemon-protocol/src/messages.ts`
- Create: `packages/daemon-protocol/src/index.ts`
- Create: `apps/daemon/package.json`
- Create: `apps/daemon/tsconfig.json`
- Create: `apps/daemon/src/main.ts`
- Create: `apps/daemon/src/daemon.service.ts`
- Create: `apps/daemon/src/process-group.ts`
- Create: `apps/daemon/src/workspace-manager.ts`
- Create: `apps/daemon/src/worktree-manager.ts`
- Create: `apps/daemon/src/outbox.ts`
- Create: `apps/daemon/test/workspace-manager.test.ts`
- Create: `apps/daemon/test/worktree-manager.test.ts`
- Create: `apps/daemon/test/daemon-recovery.test.ts`
- Create: `apps/cli/package.json`
- Create: `apps/cli/tsconfig.json`
- Create: `apps/cli/src/main.ts`
- Create: `apps/cli/src/client.ts`
- Create: `apps/cli/src/commands/task.ts`
- Create: `apps/cli/src/commands/session.ts`
- Create: `apps/cli/src/commands/run.ts`
- Create: `apps/cli/src/commands/daemon.ts`
- Create: `apps/cli/test/commands.test.ts`

**Interfaces:**
- Consumes: daemon message schemas, Control Plane endpoints, `RuntimeAdapter`, Permission Snapshot and Worktree domain rules.
- Produces: daemon register/heartbeat/outbox behavior; safe Workspace and Git Worktree operations; `platform task/session/run/daemon` CLI commands with JSON/text output and stable exit codes.

- [ ] **Step 1: Write failing Workspace and Worktree tests**

```typescript
it('rejects a workspace path outside the configured root', async () => {
  await expect(manager.assertAllowed('/tmp/other/file.ts')).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
});

it('creates a task worktree on a requested branch and reports its revision', async () => {
  const worktree = await manager.create({ repositoryPath, branchName: 'task/task_1' });
  expect(worktree.branchName).toBe('task/task_1');
  expect(worktree.baseRevision).toMatch(/^[0-9a-f]+$/);
});
```

- [ ] **Step 2: Run daemon tests and verify they fail for missing managers**

Run: `pnpm --filter @titan/daemon test`

Expected: FAIL because WorkspaceManager and WorktreeManager do not exist.

- [ ] **Step 3: Implement path, command and environment restrictions**

Canonicalize paths with `realpath`, require them to remain beneath one configured `workspaceRoot`, reject symlink escapes, pass only an explicit environment allowlist to child processes, and enforce a command allowlist. Use process groups so cancellation kills the group and waits for confirmed exit.

- [ ] **Step 4: Implement Git Worktree operations**

Use `git worktree add --no-checkout <path> <branch>` only after validating the repository and branch. Record base revision from `git rev-parse HEAD`, inspect dirty state before reuse, reject an active lock or unsynchronized outbox, and expose diff/patch metadata without deleting a worktree automatically.

- [ ] **Step 5: Implement Daemon registration, heartbeat and reconnecting state**

Send `POST /api/daemons/register` and periodic heartbeats. Mark a daemon `reconnecting` after one missed interval and `disconnected` after the configured grace period; do not mark active Sessions or Runs failed solely because of heartbeat loss. Persist local events in an append-only outbox and deduplicate by `eventId` during replay.

- [ ] **Step 6: Write failing CLI command tests**

```typescript
it('creates a task through the API and prints JSON when --json is set', async () => {
  const result = await runCli(['task', 'create', '--project', 'project_1', '--title', '首个任务', '--goal', '验证闭环', '--json']);
  expect(JSON.parse(result.stdout)).toMatchObject({ stage: 'questions' });
  expect(result.exitCode).toBe(0);
});

it('prints stable error code and nonzero exit code for API failures', async () => {
  const result = await runCli(['run', 'get', 'run_missing', '--json']);
  expect(result.stdout).toContain('RESOURCE_NOT_FOUND');
  expect(result.exitCode).toBe(2);
});
```

- [ ] **Step 7: Implement CLI API client and commands**

Use native `fetch` and `EventSource`-compatible SSE parsing. Support `--json`, `--base-url`, and `--idempotency-key`. Map API error codes to exit codes: validation `2`, permission/approval `3`, unavailable/retryable `4`, unknown `1`. Do not import repositories or access PostgreSQL.

- [ ] **Step 8: Run daemon and CLI verification**

Run: `pnpm --filter @titan/daemon test && pnpm --filter @titan/cli test && pnpm typecheck`

Expected: path restrictions, worktree isolation, process cancellation, daemon reconnecting behavior, outbox deduplication and CLI JSON/error behavior pass.

### Task 5: Complete the Phase 1 vertical slice and produce verification artifacts

**Files:**
- Create: `apps/control-plane/test/phase-1.e2e.test.ts`
- Create: `apps/agent-runtime/test/phase-1-runtime.e2e.test.ts`
- Create: `docs/phase-1-test-report.md`
- Create: `docs/phase-1-review.md`
- Create: `docs/phase-1-release-package.md`
- Modify: `README.md`
- Modify: `docs/implementation-roadmap.md`
- Modify: `docs/technology-stack.md`

**Interfaces:**
- Consumes: all previous task APIs, Fake Runtime Adapter, temporary PostgreSQL, temporary repository and CLI.
- Produces: a deterministic Phase 1 acceptance test and four traceable delivery artifacts: `source-diff`, `test-report`, `review`, and `release-package` metadata.

- [ ] **Step 1: Write the failing end-to-end acceptance test**

```typescript
it('completes the local headless flow with a failed run and checkpoint recovery', async () => {
  const project = await createProject();
  const task = await createTask(project.id);
  const session = await createSession(task.id);
  const failedRun = await createRun(session.id, { adapterMode: 'fail-once' });
  expect(failedRun.status).toBe('failed');
  const resumedRun = await createRun(session.id, { resumeFrom: failedRun.checkpointId });
  expect(resumedRun.status).toBe('completed');
  expect(await listArtifacts(task.id)).toEqual(expect.arrayContaining([
    expect.objectContaining({ type: 'questions' }),
    expect.objectContaining({ type: 'plan' }),
    expect.objectContaining({ type: 'source-diff' }),
    expect.objectContaining({ type: 'test-report' }),
  ]));
});
```

- [ ] **Step 2: Run the acceptance test and verify the first real failure**

Run: `pnpm --filter @titan/control-plane test -- phase-1.e2e.test.ts`

Expected: FAIL at the first unconnected boundary; preserve the output and fix the production boundary rather than weakening the assertion.

- [ ] **Step 3: Connect Control Plane, Runtime and Daemon through the real interfaces**

Wire Run creation to Runtime dispatch, Runtime events to the Event repository and Outbox, Tool results to Audit and Artifact repositories, and Daemon heartbeat status to Session/Run reconnecting state. Use Fake Adapter in the acceptance test and leave real Codex/Qwen credentials outside automated tests.

- [ ] **Step 4: Add QRSPI artifact generation and gate checks**

Implement the six stage artifact types `questions`, `research`, `design`, `structure`, `plan`, and `source-diff`. Refuse `Implement` when the approved Plan is missing or its `planHash` is stale. Store each artifact version and source references in PostgreSQL, with content under the controlled local artifact directory.

- [ ] **Step 5: Add the Phase 1 failure and recovery cases**

Cover repeated idempotency requests, old Run preservation, duplicate ToolUse suppression, SSE `Last-Event-ID`, Daemon heartbeat loss, control-plane restart recovery from persisted checkpoint, worktree dirty-state protection, and permission denial. Each case must assert a stable error code or state, not an implementation detail.

- [ ] **Step 6: Run the complete verification suite**

Run: `pnpm lint && pnpm typecheck && pnpm test && pnpm build`

Expected: all packages and apps pass with zero TypeScript errors, zero test failures, and successful production builds. Run `docker compose -f infra/docker-compose.yml config` to validate the local service configuration.

- [ ] **Step 7: Write the verification artifacts**

`docs/phase-1-test-report.md` must record exact commands, dates, pass/fail counts, database/container prerequisites and known limits. `docs/phase-1-review.md` must include scope coverage, security/permission review, recovery review, rollback path and unresolved risks. `docs/phase-1-release-package.md` must list artifact IDs/types, required environment variables, startup commands, database initialization order, rollback steps and excluded Phase 2/3 features.

- [ ] **Step 8: Re-run final verification and inspect the complete diff**

Run: `git --git-dir=/Users/zhanghai/.humanlayer/repos/github.com/ty793941/titan-coder/.repository/.git --work-tree=/Users/zhanghai/.humanlayer/workspaces/code-coder-ca7b diff --check` and `git --git-dir=/Users/zhanghai/.humanlayer/repos/github.com/ty793941/titan-coder/.repository/.git --work-tree=/Users/zhanghai/.humanlayer/workspaces/code-coder-ca7b status --short --branch`.

Expected: no whitespace errors, all intended files are visible on `chore/initial-project`, and no generated secrets or local database data are included.
