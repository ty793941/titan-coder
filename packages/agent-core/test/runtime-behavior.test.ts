import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { AgentLoop } from '../src/agent-loop.js';
import { CheckpointStore, FileCheckpointStore } from '../src/checkpoints.js';
import { GoalGate } from '../src/goal-gate.js';
import { HookRunner } from '../src/hook-runner.js';
import { PermissionEngine } from '../src/permission-engine.js';
import { hashToolInput, ToolRegistry } from '../src/tool-registry.js';
import { FileToolExecutionLedger } from '../src/tool-ledger.js';
import { FakeAdapter } from '../src/adapters/fake-adapter.js';
import type { NativeSession, RuntimeAdapter, RuntimeEvent, RuntimeInput, RuntimeSessionConfig } from '../src/adapters/runtime-adapter.js';

class TwoTurnAdapter implements RuntimeAdapter {
  readonly inputs: RuntimeInput[] = [];
  private turn = 0;
  private readonly session: NativeSession = { id: 'session-test', runtime: 'qwen' };

  async createSession(_config: RuntimeSessionConfig): Promise<NativeSession> { return this.session; }

  async *streamEvents(): AsyncIterable<RuntimeEvent> {
    if (this.turn === 1) {
      yield { type: 'tool.requested', payload: { id: 'tool-1', name: 'artifact.write', arguments: { path: 'answer.txt', content: 'evidence' } } };
      return;
    }
    yield { type: 'text', payload: '完成' };
    yield { type: 'session.completed' };
  }

  async sendInput(_session: NativeSession, input: RuntimeInput): Promise<void> {
    this.inputs.push(input);
    this.turn += 1;
  }

  async pause(): Promise<{ id: string }> { return { id: 'provider-checkpoint' }; }
  async resume(): Promise<void> {}
  async cancel(): Promise<void> {}
  async close(): Promise<void> {}
}

class RecordingAdapter implements RuntimeAdapter {
  readonly inputs: RuntimeInput[] = [];
  private readonly session: NativeSession = { id: 'recording-session', runtime: 'qwen' };

  async createSession(_config: RuntimeSessionConfig): Promise<NativeSession> { return this.session; }
  async *streamEvents(): AsyncIterable<RuntimeEvent> {
    yield { type: 'session.completed' };
  }
  async sendInput(_session: NativeSession, input: RuntimeInput): Promise<void> { this.inputs.push(input); }
  async pause(): Promise<{ id: string }> { return { id: 'checkpoint' }; }
  async resume(): Promise<void> {}
  async cancel(): Promise<void> {}
  async close(): Promise<void> {}
}

class FailedTestAdapter implements RuntimeAdapter {
  private turn = 0;
  private readonly session: NativeSession = { id: 'failed-test-session', runtime: 'qwen' };
  async createSession(_config: RuntimeSessionConfig): Promise<NativeSession> { return this.session; }
  async *streamEvents(): AsyncIterable<RuntimeEvent> {
    if (this.turn === 1) yield { type: 'tool.requested', payload: { id: 'failed-test', name: 'command.test', arguments: { command: ['pnpm', 'test'] } } };
    else yield { type: 'session.completed' };
  }
  async sendInput(): Promise<void> { this.turn += 1; }
  async pause(): Promise<{ id: string }> { return { id: 'checkpoint' }; }
  async resume(): Promise<void> {}
  async cancel(): Promise<void> {}
  async close(): Promise<void> {}
}

describe('Runtime safety behavior', () => {
  it('does not treat a session completion event as goal evidence', () => {
    expect(new GoalGate().evaluate([{ kind: 'runtime', reference: 'session.completed' }]).decision).toBe('continue');
  });

  it('persists the frozen checkpoint shape and reloads it after a new store instance', async () => {
    const root = await mkdtemp(join(tmpdir(), 'titan-checkpoint-'));
    try {
      const first = new FileCheckpointStore(root);
      await first.save({
        id: 'checkpoint-1',
        messages: [{ role: 'user', text: 'goal' }],
        successfulTools: [{ id: 'tool-1', name: 'artifact.write', inputHash: 'hash-1', output: { reference: 'artifact://answer.txt' } }],
        evidence: [{ kind: 'artifact', reference: 'artifact://answer.txt' }],
      });
      const second = new FileCheckpointStore(root);
      await expect(second.get('checkpoint-1')).resolves.toMatchObject({ id: 'checkpoint-1', successfulTools: [{ id: 'tool-1' }] });
      const files = await readFile(join(root, 'checkpoint-1.json'), 'utf8');
      expect(JSON.parse(files)).toEqual({
        id: 'checkpoint-1',
        messages: [{ role: 'user', text: 'goal' }],
        successfulTools: [{ id: 'tool-1', name: 'artifact.write', inputHash: 'hash-1', output: { reference: 'artifact://answer.txt' } }],
        evidence: [{ kind: 'artifact', reference: 'artifact://answer.txt' }],
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('replays the same tool id only when its input hash is unchanged', async () => {
    const executed: unknown[] = [];
    const registry = new ToolRegistry({
      permission: new PermissionEngine([{ source: 'run', action: 'test.echo', resource: 'run-1', decision: 'allow' }]),
      hooks: new HookRunner([]),
    });
    registry.register({ name: 'test.echo', version: 1, input: z.object({ value: z.string() }), execute: async input => { executed.push(input); return input; } });
    const request = { toolUseId: 'tool-1', name: 'test.echo', input: { value: 'same' }, context: { runId: 'run-1', allowedTools: ['test.echo'] } };
    await registry.execute(request);
    const replay = await registry.execute(request);
    expect(replay.replayed).toBe(true);
    expect(executed).toHaveLength(1);
    await expect(registry.execute({ ...request, input: { value: 'changed' } })).rejects.toThrow('TOOL_INPUT_INVALID');
  });

  it('records an uncertain result before a post-hook failure so the side effect is not repeated', async () => {
    let executions = 0;
    const registry = new ToolRegistry({
      permission: new PermissionEngine([{ source: 'run', action: 'test.write', resource: 'run-uncertain', decision: 'allow' }]),
      hooks: new HookRunner([{ name: 'post-fails', phase: 'after', priority: 1, run: async () => 'deny' }]),
    });
    registry.register({ name: 'test.write', version: 1, input: z.object({ value: z.string() }), execute: async input => { executions += 1; return input; } });
    const request = { toolUseId: 'uncertain-1', name: 'test.write', input: { value: 'once' }, context: { runId: 'run-uncertain', allowedTools: ['test.write'] } };
    await expect(registry.execute(request)).rejects.toThrow('TOOL_BLOCKED_BY_HOOK');
    await expect(registry.execute(request)).rejects.toThrow('TOOL_EXECUTION_UNCERTAIN');
    expect(executions).toBe(1);
  });

  it('runs a tool round, checkpoints its evidence, and ignores session.completed as proof', async () => {
    const root = await mkdtemp(join(tmpdir(), 'titan-loop-'));
    try {
      const adapter = new TwoTurnAdapter();
      const registry = new ToolRegistry({
        permission: new PermissionEngine([{ source: 'run', action: 'artifact.write', resource: 'run-1', decision: 'allow' }]),
        hooks: new HookRunner([]),
      });
      registry.register({
        name: 'artifact.write',
        version: 1,
        input: z.object({ path: z.string(), content: z.string() }),
        execute: async input => ({ kind: 'artifact', reference: `artifact://${input.path}`, checksum: createHash('sha256').update(input.content).digest('hex') }),
      });
      const checkpoints = new FileCheckpointStore(root);
      const loop = new AgentLoop({ adapter, tools: registry, checkpoints, goalGate: new GoalGate() });
      const result = await loop.run({ runId: 'run-1', goal: '生成证据', runtime: 'qwen', credentialRef: 'test://qwen', allowedTools: ['artifact.write'], maxTurns: 3 });
      expect(result.status).toBe('satisfied');
      expect(result.evidence).toEqual([{ kind: 'artifact', reference: 'artifact://answer.txt' }]);
      expect(adapter.inputs).toHaveLength(2);
      expect(adapter.inputs[1]?.toolResults?.[0]?.id).toBe('tool-1');
      await expect(checkpoints.get(result.checkpoint!.id)).resolves.toMatchObject({ successfulTools: [{ id: 'tool-1' }] });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('fails when evidence exists before the provider completes', async () => {
    const registry = new ToolRegistry({
      permission: new PermissionEngine([{ source: 'run', action: 'artifact.write', resource: 'run-budget', decision: 'allow' }]),
      hooks: new HookRunner([]),
    });
    registry.register({
      name: 'artifact.write',
      version: 1,
      input: z.object({ value: z.string() }),
      execute: async input => ({ kind: 'artifact', reference: 'artifact://pending', checksum: createHash('sha256').update(input.value).digest('hex') }),
    });
    const adapter = new FakeAdapter([{ type: 'tool.requested', payload: { id: 'pending-tool', name: 'artifact.write', arguments: { value: 'evidence' } } }]);
    const loop = new AgentLoop({ adapter, tools: registry, checkpoints: new CheckpointStore(), goalGate: new GoalGate() });

    const result = await loop.run({ runId: 'run-budget', goal: '完成目标', allowedTools: ['artifact.write'], maxTurns: 1 });

    expect(result.status).toBe('failed');
    expect(result.error).toContain('provider did not complete');
  });

  it('does not treat a failed command.test result as goal evidence', async () => {
    const registry = new ToolRegistry({
      permission: new PermissionEngine([{ source: 'run', action: 'command.test', resource: 'run-failed-test', decision: 'allow' }]),
      hooks: new HookRunner([]),
    });
    registry.register({ name: 'command.test', version: 1, input: z.object({ command: z.array(z.string()) }), execute: async () => ({ kind: 'test', reference: 'test://failed', status: 'failed', result: 'exit:1' }) });
    const loop = new AgentLoop({ adapter: new FailedTestAdapter(), tools: registry, checkpoints: new CheckpointStore(), goalGate: new GoalGate() });

    const result = await loop.run({ runId: 'run-failed-test', goal: '验证测试', allowedTools: ['command.test'], maxTurns: 2 });

    expect(result.status).toBe('waiting_input');
    expect(result.evidence).toEqual([]);
  });

  it('sends checkpoint history and successful tool summaries as explicit recovery context', async () => {
    const adapter = new RecordingAdapter();
    const loop = new AgentLoop({ adapter, tools: new ToolRegistry({ permission: new PermissionEngine([]), hooks: new HookRunner([]) }), checkpoints: new CheckpointStore(), goalGate: new GoalGate() });

    await loop.run({
      runId: 'run-recovery',
      goal: '继续目标',
      checkpoint: {
        id: 'checkpoint-recovery',
        messages: [{ role: 'user', text: '原始目标' }, { role: 'assistant', text: '已经完成第一步' }],
        successfulTools: [{ id: 'old-call', name: 'workspace.read', inputHash: 'hash', output: { reference: 'workspace://a.txt', text: '结果摘要' } }],
        evidence: [],
      },
    });

    expect(adapter.inputs[0]?.text).toContain('原始目标');
    expect(adapter.inputs[0]?.text).toContain('workspace.read');
    expect(adapter.inputs[0]?.text).toContain('结果摘要');
    expect(adapter.inputs[0]?.text).toContain('继续目标');
  });

  it('reuses a hydrated side effect by canonical tool name and input hash with a new call id', async () => {
    let executions = 0;
    const registry = new ToolRegistry({
      permission: new PermissionEngine([{ source: 'run', action: 'test.echo', resource: 'run-canonical', decision: 'allow' }]),
      hooks: new HookRunner([]),
    });
    registry.register({ name: 'test.echo', version: 1, input: z.object({ value: z.string() }), execute: async input => { executions += 1; return input; } });
    registry.hydrate([{ id: 'old-call', name: 'test.echo', inputHash: 'will-be-replaced', output: { value: 'same' } }]);
    const first = { toolUseId: 'new-call', name: 'test.echo', input: { value: 'same' }, context: { runId: 'run-canonical', allowedTools: ['test.echo'] } };
    const hydrated = registry.getSuccessfulResults()[0]!;
    registry.hydrate([{ ...hydrated, inputHash: hashToolInput(first.input) }]);

    const result = await registry.execute(first);

    expect(result.replayed).toBe(true);
    expect(executions).toBe(0);
  });

  it('blocks an uncertain side effect after a new registry loads the persistent ledger', async () => {
    const root = await mkdtemp(join(tmpdir(), 'titan-ledger-'));
    try {
      let executions = 0;
      const options = {
        permission: new PermissionEngine([{ source: 'run', action: 'test.write', resource: 'run-ledger', decision: 'allow' }]),
        hooks: new HookRunner([{ name: 'post-fails', phase: 'after' as const, priority: 1, run: async () => 'deny' as const }]),
        ledger: new FileToolExecutionLedger(root),
      };
      const first = new ToolRegistry(options);
      first.register({ name: 'test.write', version: 1, input: z.object({ value: z.string() }), execute: async input => { executions += 1; return input; } });
      await expect(first.execute({ toolUseId: 'first-call', name: 'test.write', input: { value: 'once' }, context: { runId: 'run-ledger', allowedTools: ['test.write'] } })).rejects.toThrow('TOOL_BLOCKED_BY_HOOK');

      const second = new ToolRegistry({ ...options, ledger: new FileToolExecutionLedger(root) });
      second.register({ name: 'test.write', version: 1, input: z.object({ value: z.string() }), execute: async input => { executions += 1; return input; } });
      await expect(second.execute({ toolUseId: 'new-call', name: 'test.write', input: { value: 'once' }, context: { runId: 'run-ledger', allowedTools: ['test.write'] } })).rejects.toThrow('TOOL_EXECUTION_UNCERTAIN');
      expect(executions).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does not reuse an artifact whose file checksum no longer matches', async () => {
    const root = await mkdtemp(join(tmpdir(), 'titan-artifact-checksum-'));
    try {
      const artifact = join(root, 'artifact.txt');
      await writeFile(artifact, 'changed');
      const registry = new ToolRegistry({ permission: new PermissionEngine([]), hooks: new HookRunner([]) });
      const checkpoint = { id: 'checkpoint-artifact', messages: [], successfulTools: [{ id: 'artifact-call', name: 'artifact.write', inputHash: 'hash', output: { kind: 'artifact', uri: `file://${artifact}`, checksum: 'sha256:old' } }], evidence: [{ kind: 'artifact', reference: 'artifact://old' }] };

      await expect(registry.hydrateVerified(checkpoint.successfulTools, root)).resolves.toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('redacts checkpoint secrets and rejects oversized snapshots', async () => {
    const root = await mkdtemp(join(tmpdir(), 'titan-checkpoint-secret-'));
    try {
      const store = new FileCheckpointStore(root, root, ['fixture-secret']);
      await store.save({ id: 'secret-checkpoint', messages: [{ role: 'assistant', text: 'fixture-secret' }], successfulTools: [{ id: 'tool', name: 'workspace.read', inputHash: 'hash', output: { text: 'fixture-secret' } }], evidence: [] });
      const saved = await readFile(join(root, 'secret-checkpoint.json'), 'utf8');
      expect(saved).not.toContain('fixture-secret');
      await expect(store.save({ id: 'too-large', messages: [{ role: 'user', text: 'x'.repeat(1024 * 1024) }], successfulTools: [], evidence: [] })).rejects.toThrow('1 MiB');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects a checkpoint root symlink that points outside the workspace', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'titan-checkpoint-root-'));
    const outside = await mkdtemp(join(tmpdir(), 'titan-checkpoint-outside-'));
    try {
      await symlink(outside, join(workspace, 'checkpoints'));
      const store = new FileCheckpointStore(join(workspace, 'checkpoints'), workspace);
      await expect(store.save({ id: 'unsafe', messages: [], successfulTools: [], evidence: [] })).rejects.toThrow(/symlink|workspace/);
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });
});
