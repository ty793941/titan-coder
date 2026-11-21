import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentLoop, FileCheckpointStore, GoalGate, HookRunner, PermissionEngine, ToolRegistry } from '@titan/agent-core';
import type { RuntimeAdapter, RuntimeSessionConfig } from '@titan/agent-core';
import { createCodexApiKeyAdapter, createQwenOfficialAdapter } from '@titan/agent-core';
import type { RunDispatch, RunProgress } from '@titan/daemon-protocol';
import type { AgentRunResult } from '@titan/agent-core';
import { resolveCredential } from './credentials.js';
import { createRuntimeTools, runtimeToolSpecs } from './tools.js';

type WorkerMessage = { dispatch?: RunDispatch; type?: 'cancel' | 'checkpoint'; checkpoint?: RunDispatch['checkpoint'] };
export type WorkerDependencies = {
  adapterFactory?: (config: RuntimeSessionConfig, credential: string) => RuntimeAdapter;
  credentialResolver?: (credentialRef: string) => Promise<string | undefined>;
  checkpointRoot?: string;
  sendProgress?: (progress: RunProgress) => void;
  signal?: AbortSignal;
};

const payloadKeys = new Set(['text', 'code', 'message', 'status', 'turn', 'toolCallId', 'toolName', 'reference', 'evidence', 'output', 'result', 'checkpointId']);

function safePayload(payload: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(payload).filter(([key]) => payloadKeys.has(key)));
}

function adapterFor(config: RuntimeSessionConfig, credential: string): RuntimeAdapter {
  if (config.runtime === 'qwen') return createQwenOfficialAdapter({ apiKey: credential });
  return createCodexApiKeyAdapter({ apiKey: credential });
}

export async function executeDispatch(dispatch: RunDispatch, dependencies: WorkerDependencies = {}): Promise<AgentRunResult> {
  let sequence = 0;
  const send = dependencies.sendProgress ?? (progress => { if (process.send && process.connected) process.send({ type: 'progress', progress }); });
  const emit = (type: RunProgress['type'], payload: Record<string, unknown>, checkpoint?: RunProgress['checkpoint']): void => {
    const progress: RunProgress = { eventId: randomUUID(), sequence: ++sequence, claimToken: dispatch.claimToken, type, payload: safePayload(payload), ...(checkpoint ? { checkpoint } : {}) };
    send(progress);
  };
  emit('running', { status: 'running' });
  if (dependencies.signal?.aborted) {
    const result: AgentRunResult = { status: 'cancelled', replayedToolUseIds: [], evidence: [], error: 'run cancelled' };
    emit('cancelled', { status: 'cancelled', message: 'run cancelled' });
    return result;
  }
  const credentialResolver = dependencies.credentialResolver ?? resolveCredential;
  const credential = await credentialResolver(dispatch.config.credentialRef);
  if (dependencies.signal?.aborted) {
    const result: AgentRunResult = { status: 'cancelled', replayedToolUseIds: [], evidence: [], error: 'run cancelled' };
    emit('cancelled', { status: 'cancelled', message: 'run cancelled' });
    return result;
  }
  if (!credential) {
    const result: AgentRunResult = { status: 'waiting_input', replayedToolUseIds: [], evidence: [], error: 'provider credential is unavailable' };
    emit('waiting_input', { status: 'waiting_input', message: 'provider credential is unavailable' });
    return result;
  }
  const adapterConfig: RuntimeSessionConfig = {
    runtime: dispatch.config.runtime,
    credentialRef: dispatch.config.credentialRef,
    ...(dispatch.config.modelRef ? { modelRef: dispatch.config.modelRef } : {}),
    cwd: dispatch.config.workspacePath,
    workspace: dispatch.config.workspacePath,
    timeoutMs: dispatch.config.timeoutMs,
    ...(dependencies.signal ? { signal: dependencies.signal } : {}),
    tools: runtimeToolSpecs.filter(tool => dispatch.config.allowedTools.includes(tool.name)),
  };
  const adapter = dependencies.adapterFactory ? dependencies.adapterFactory(adapterConfig, credential) : adapterFor(adapterConfig, credential);
  const permissions = new PermissionEngine(dispatch.config.allowedTools.map(action => ({ source: 'run' as const, action, resource: dispatch.runId, decision: 'allow' as const })));
  const tools = new ToolRegistry({ permission: permissions, hooks: new HookRunner([]) });
  for (const tool of createRuntimeTools()) tools.register(tool);
  const checkpoints = new FileCheckpointStore(dependencies.checkpointRoot ?? join(dispatch.config.workspacePath, '.titan', 'checkpoints'));
  const loop = new AgentLoop({
    adapter,
    tools,
    checkpoints,
    goalGate: new GoalGate(),
    toolSpecs: runtimeToolSpecs.filter(tool => dispatch.config.allowedTools.includes(tool.name)),
    onProgress: progress => {
      if (progress.type === 'checkpoint') emit('checkpoint', { checkpointId: progress.checkpoint?.id, evidence: progress.checkpoint?.evidence ?? [] }, progress.checkpoint);
      else if (progress.type === 'tool') emit('output', progress.payload);
      else emit('output', progress.payload);
    },
  });
  const result = await loop.run({
    runId: dispatch.runId,
    goal: dispatch.goal,
    runtime: dispatch.config.runtime,
    credentialRef: dispatch.config.credentialRef,
    ...(dispatch.config.modelRef ? { modelRef: dispatch.config.modelRef } : {}),
    workspacePath: dispatch.config.workspacePath,
    allowedTools: dispatch.config.allowedTools,
    timeoutMs: dispatch.config.timeoutMs,
    maxTurns: dispatch.config.maxTurns,
    ...(dependencies.signal ? { signal: dependencies.signal } : {}),
    ...(dispatch.checkpoint ? { checkpoint: dispatch.checkpoint } : {}),
  });
  const checkpoint = result.checkpoint;
  if (result.status === 'satisfied') emit('completed', { status: 'completed', evidence: result.evidence, ...(checkpoint ? { checkpointId: checkpoint.id } : {}) }, checkpoint);
  else if (result.status === 'waiting_input') emit('waiting_input', { status: 'waiting_input', message: result.error ?? 'human input is required', evidence: result.evidence, ...(checkpoint ? { checkpointId: checkpoint.id } : {}) }, checkpoint);
  else if (result.status === 'cancelled') emit('cancelled', { status: 'cancelled', message: result.error ?? 'run cancelled', evidence: result.evidence, ...(checkpoint ? { checkpointId: checkpoint.id } : {}) }, checkpoint);
  else emit('failed', { status: 'failed', message: result.error ?? 'runtime failed', evidence: result.evidence, ...(checkpoint ? { checkpointId: checkpoint.id } : {}) }, checkpoint);
  return result;
}

export function installWorkerProcess(): void {
  let controller: AbortController | undefined;
  let active: Promise<AgentRunResult> | undefined;
  process.on('disconnect', () => {
    controller?.abort();
    if (active) void active.then(() => process.exit(0), () => process.exit(1));
    else process.exit(0);
  });
  process.on('message', (message: WorkerMessage) => {
    if (message.type === 'cancel') { controller?.abort(); return; }
    if (!message.dispatch || active) return;
    controller = new AbortController();
    active = executeDispatch(message.dispatch, { signal: controller.signal });
    void active.then(() => { active = undefined; controller = undefined; }, () => { active = undefined; controller = undefined; });
  });
}

if (process.env.TITAN_RUNTIME_WORKER === '1' || (typeof process.send === 'function' && process.argv[1] === fileURLToPath(import.meta.url))) installWorkerProcess();
