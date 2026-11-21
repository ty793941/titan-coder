import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { AgentLoop } from '../src/agent-loop.js';
import { CheckpointStore, FileCheckpointStore } from '../src/checkpoints.js';
import { GoalGate } from '../src/goal-gate.js';
import { HookRunner } from '../src/hook-runner.js';
import { PermissionEngine } from '../src/permission-engine.js';
import { ToolRegistry } from '../src/tool-registry.js';
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
    await expect(registry.execute(request)).resolves.toMatchObject({ replayed: true, uncertain: true });
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
});
