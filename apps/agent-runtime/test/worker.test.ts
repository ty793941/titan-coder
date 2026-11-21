import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { RunDispatch, RunProgress } from '@titan/daemon-protocol';
import type { NativeSession, RuntimeAdapter, RuntimeEvent, RuntimeInput, RuntimeSessionConfig } from '@titan/agent-core';
import { executeDispatch } from '../src/worker.js';
import { hashToolInput } from '@titan/agent-core';

class FixtureAdapter implements RuntimeAdapter {
  private readonly session: NativeSession = { id: `fixture-${Math.random()}`, runtime: 'qwen' };
  private sent = false;
  private toolResult = false;
  readonly goals: string[] = [];

  async createSession(_config: RuntimeSessionConfig): Promise<NativeSession> { return this.session; }
  async *streamEvents(): AsyncIterable<RuntimeEvent> {
    if (!this.sent) {
      yield { type: 'tool.requested', payload: { id: 'artifact-1', name: 'artifact.write', arguments: { path: 'answer.txt', content: 'answer' } } };
      this.sent = true;
      return;
    }
    if (this.toolResult) {
      yield { type: 'text', payload: 'artifact created' };
      yield { type: 'session.completed' };
    }
  }
  async sendInput(_session: NativeSession, input: RuntimeInput): Promise<void> { if (input.toolResults?.length) this.toolResult = true; else this.goals.push(input.text); }
  async pause(): Promise<{ id: string }> { return { id: 'fixture' }; }
  async resume(): Promise<void> {}
  async cancel(): Promise<void> {}
  async close(): Promise<void> {}
}

function dispatch(overrides: Partial<RunDispatch> = {}): RunDispatch {
  return {
    jobId: 'job-1', runId: 'run-1', sessionId: 'session-1', taskId: 'task-1', projectId: 'project-1', goal: '写入真实 artifact', planHash: 'plan-1',
    config: { daemonId: 'daemon-1', runtime: 'qwen', credentialRef: 'env://DASHSCOPE_API_KEY', modelRef: 'qwen-test', workspacePath: '', allowedTools: ['artifact.write'], maxTurns: 3, timeoutMs: 5000 }, claimToken: 'claim-1',
    ...overrides,
  };
}

describe('Runtime worker', () => {
  const roots: string[] = [];
  afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

  it('forwards the real goal, emits sequence-one progress, writes an artifact checksum, and completes with evidence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'titan-worker-')); roots.push(root);
    const adapter = new FixtureAdapter();
    const progress: RunProgress[] = [];
    const result = await executeDispatch(dispatch({ config: { ...dispatch().config, workspacePath: root } }), {
      adapterFactory: () => adapter,
      credentialResolver: async () => 'fixture-secret',
      sendProgress: progressEvent => { progress.push(progressEvent); },
    });
    expect(result.status).toBe('satisfied');
    expect(adapter.goals).toEqual(['写入真实 artifact']);
    expect(progress[0]).toMatchObject({ sequence: 1, type: 'running', claimToken: 'claim-1' });
    expect(progress.every(event => event.eventId)).toBe(true);
    expect(new Set(progress.map(event => event.eventId)).size).toBe(progress.length);
    expect(progress.map(event => event.sequence)).toEqual(progress.map((_event, index) => index + 1));
    expect(progress.some(event => event.payload.source === 'hook')).toBe(true);
    expect(progress.some(event => event.payload.source === 'tool')).toBe(true);
    const artifactOutput = progress.find(event => event.type === 'checkpoint')?.checkpoint?.successfulTools[0]?.output as { uri: string; reference: string; checksum: string };
    const artifact = await readFile(fileURLToPath(artifactOutput.uri), 'utf8');
    expect(artifact).toBe('answer');
    expect(progress.at(-1)).toMatchObject({ type: 'completed', payload: { status: 'completed' } });
    expect(progress.at(-1)?.payload.evidence).toEqual([{ kind: 'artifact', reference: artifactOutput.reference }]);
    expect(Object.keys(progress.find(event => event.type === 'checkpoint')?.checkpoint ?? {}).sort()).toEqual(['evidence', 'id', 'messages', 'successfulTools']);
    const allowedPayloadKeys = new Set(['source', 'text', 'code', 'message', 'status', 'turn', 'toolCallId', 'toolName', 'hookName', 'reference', 'evidence', 'output', 'result', 'checkpointId', 'inputHash', 'reason']);
    expect(progress.every(event => Object.keys(event.payload).every(key => allowedPayloadKeys.has(key)))).toBe(true);
  });

  it('keeps goals and sessions isolated across two dispatches', async () => {
    const firstRoot = await mkdtemp(join(tmpdir(), 'titan-worker-one-')); roots.push(firstRoot);
    const secondRoot = await mkdtemp(join(tmpdir(), 'titan-worker-two-')); roots.push(secondRoot);
    const first = new FixtureAdapter();
    const second = new FixtureAdapter();
    const config = dispatch().config;
    const baseDependencies = { credentialResolver: async () => 'fixture-secret' };
    await executeDispatch(dispatch({ goal: 'first goal', config: { ...config, workspacePath: firstRoot } }), { ...baseDependencies, adapterFactory: () => first, sendProgress: () => undefined });
    await executeDispatch(dispatch({ runId: 'run-2', goal: 'second goal', config: { ...config, workspacePath: secondRoot } }), { ...baseDependencies, adapterFactory: () => second, sendProgress: () => undefined });
    expect(first.goals).toEqual(['first goal']);
    expect(second.goals).toEqual(['second goal']);
  });

  it('hydrates a checkpoint and replays a successful tool without recreating its file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'titan-worker-replay-')); roots.push(root);
    const first = new FixtureAdapter();
    const firstResult = await executeDispatch(dispatch({ config: { ...dispatch().config, workspacePath: root } }), { adapterFactory: () => first, credentialResolver: async () => 'fixture-secret', sendProgress: () => undefined });
    expect(firstResult.checkpoint).toBeDefined();
    const firstArtifact = firstResult.checkpoint?.successfulTools[0]?.output as { uri: string; reference: string };
    await unlink(fileURLToPath(firstArtifact.uri));
    const second = new FixtureAdapter();
    const secondResult = await executeDispatch(dispatch({ config: { ...dispatch().config, workspacePath: root }, checkpoint: firstResult.checkpoint }), { adapterFactory: () => second, credentialResolver: async () => 'fixture-secret', sendProgress: () => undefined });
    expect(secondResult.status).toBe('satisfied');
    const secondArtifact = secondResult.checkpoint?.successfulTools[0]?.output as { uri: string; reference: string };
    await expect(readFile(fileURLToPath(secondArtifact.uri), 'utf8')).resolves.toBe('answer');
    expect(secondArtifact.reference).not.toBe(firstArtifact.reference);
    expect(firstResult.checkpoint?.successfulTools[0]?.inputHash).toBe(hashToolInput({ path: 'answer.txt', content: 'answer' }));
  });

  it('maps an abort to cancelled and lets the adapter clean up', async () => {
    const root = await mkdtemp(join(tmpdir(), 'titan-worker-cancel-')); roots.push(root);
    let release!: () => void;
    let cancelled = false;
    const adapter: RuntimeAdapter = {
      async createSession(config) { return { id: `cancel-${config.workspace}`, runtime: 'qwen' }; },
      async *streamEvents() { await new Promise<void>(resolve => { release = resolve; }); },
      async sendInput() {}, async pause() { return { id: 'checkpoint' }; }, async resume() {},
      async cancel() { cancelled = true; release?.(); }, async close() {},
    };
    const controller = new AbortController();
    const running = executeDispatch(dispatch({ config: { ...dispatch().config, workspacePath: root } }), { adapterFactory: () => adapter, credentialResolver: async () => 'fixture-secret', sendProgress: () => undefined, signal: controller.signal });
    await new Promise<void>(resolve => setImmediate(resolve));
    controller.abort();
    await expect(running).resolves.toMatchObject({ status: 'cancelled' });
    expect(cancelled).toBe(true);
  });

  it('returns waiting_input when the provider credential is absent without creating a fake success', async () => {
    const root = await mkdtemp(join(tmpdir(), 'titan-worker-')); roots.push(root);
    const progress: RunProgress[] = [];
    const result = await executeDispatch(dispatch({ config: { ...dispatch().config, workspacePath: root } }), {
      credentialResolver: async () => undefined,
      sendProgress: progressEvent => { progress.push(progressEvent); },
    });
    expect(result.status).toBe('waiting_input');
    expect(progress.at(-1)).toMatchObject({ type: 'waiting_input' });
    expect(progress.some(event => event.type === 'completed')).toBe(false);
  });

  it('rejects a tool absent from dispatch.allowedTools and reports failed with evidence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'titan-worker-')); roots.push(root);
    const adapter = new FixtureAdapter();
    const progress: RunProgress[] = [];
    const result = await executeDispatch(dispatch({ config: { ...dispatch().config, workspacePath: root, allowedTools: [] } }), {
      adapterFactory: () => adapter,
      credentialResolver: async () => 'fixture-secret',
      sendProgress: progressEvent => { progress.push(progressEvent); },
    });
    expect(result.status).toBe('failed');
    expect(progress.at(-1)).toMatchObject({ type: 'failed', payload: { evidence: expect.any(Array) } });
  });
});
