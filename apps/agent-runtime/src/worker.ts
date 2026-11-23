import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentLoop, CheckpointStore, containsSensitive, containsSensitivePath, containsUnsafePath, FileCheckpointStore, FileToolExecutionLedger, GoalGate, HookRunner, PermissionEngine, ToolRegistry } from '@titan/agent-core';
import type { ExecutionCheckpoint, Hook, RuntimeAdapter, RuntimeSessionConfig } from '@titan/agent-core';
import type { Checkpoint } from '@titan/agent-core';
import { createCodexApiKeyAdapter, createQwenOfficialAdapter } from '@titan/agent-core';
import type { RunDispatch, RunProgress } from '@titan/daemon-protocol';
import type { AgentRunResult } from '@titan/agent-core';
import { resolveCredential, validateProviderBaseUrl } from './credentials.js';
import { loadSkillContext, persistSkillContextSnapshot, sanitizeSkillSecrets } from './skills.js';
import { createRuntimeTools, runtimeToolSpecs } from './tools.js';

type WorkerMessage = { dispatch?: RunDispatch; type?: 'cancel' | 'checkpoint'; checkpoint?: RunDispatch['checkpoint'] };
type RuntimeConfigWithLocalPolicy = RunDispatch['config'] & {
  localPolicy?: { trustedCode?: boolean; enabledSkills?: unknown };
  enabledSkills?: unknown;
};
export type WorkerDependencies = {
  adapterFactory?: (config: RuntimeSessionConfig, credential: string) => RuntimeAdapter;
  credentialResolver?: (credentialRef: string) => Promise<string | undefined>;
  checkpointRoot?: string;
  sendProgress?: (progress: RunProgress) => void;
  signal?: AbortSignal;
};

const payloadKeys = new Set(['source', 'text', 'code', 'message', 'status', 'turn', 'toolCallId', 'toolName', 'hookName', 'reference', 'evidence', 'output', 'result', 'checkpointId', 'inputHash', 'reason']);

function safePayload(payload: Record<string, unknown>, secretValues: string[]): Record<string, unknown> {
  const safe = Object.fromEntries(Object.entries(payload).filter(([key]) => payloadKeys.has(key)));
  return sanitizeSkillSecrets(safe, secretValues);
}

function runtimeSafetyHooks(): Hook[] {
  return [{
    name: 'runtime-input-output-safety', phase: 'before', priority: 1, blocking: true,
    run: async context => {
      if (containsSensitive(context.input, context.secretValues) || containsSensitivePath(context.input) || containsUnsafePath(context.input, context.workspacePath)) return 'deny';
      return 'allow';
    },
  }, {
    name: 'runtime-output-safety', phase: 'after', priority: 1, blocking: true,
    run: async context => {
      if (containsSensitive(context.output, context.secretValues) || containsSensitivePath(context.output) || containsUnsafePath(context.output, context.workspacePath)) return 'deny';
      return 'allow';
    },
  }];
}

function contextMarker(contextReference: string | undefined): string {
  return `[trusted context snapshot${contextReference ? `: ${contextReference}` : ''}]`;
}

function projectContextValue(value: unknown, contextSources: readonly string[], contextReferences: readonly string[], contextReference: string | undefined): unknown {
  if (typeof value === 'string') {
    if (/^\s*[\[{]/.test(value) && /"reference"\s*:\s*"workspace:\/\/(?:AGENTS\.md|\.titan\/skills\/)/.test(value)) {
      try {
        return JSON.stringify(projectContextValue(JSON.parse(value), contextSources, contextReferences, contextReference));
      } catch {
        return value;
      }
    }
    const blockStart = value.indexOf('<trusted-project-context>');
    const blockEnd = value.indexOf('</trusted-project-context>', blockStart);
    const projectedBlock = blockStart >= 0 && blockEnd >= 0 ? `${value.slice(0, blockStart)}${contextMarker(contextReference)}${value.slice(blockEnd + '</trusted-project-context>'.length)}` : value;
    return contextSources.filter(Boolean).reduce((text, source) => text.split(source).join(contextMarker(contextReference)), projectedBlock);
  }
  if (Array.isArray(value)) return value.map(item => projectContextValue(item, contextSources, contextReferences, contextReference));
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const reference = typeof record.reference === 'string' ? record.reference : undefined;
    const projected = Object.fromEntries(Object.entries(record).map(([key, child]) => [key, projectContextValue(child, contextSources, contextReferences, contextReference)]));
    if (reference && (contextReferences.includes(reference) || reference === 'workspace://AGENTS.md' || reference.startsWith('workspace://.titan/skills/')) && typeof record.text === 'string') projected.text = contextMarker(contextReference);
    return projected;
  }
  return value;
}

function projectCheckpoint(checkpoint: Checkpoint | ExecutionCheckpoint, contextSources: readonly string[], contextReferences: readonly string[], contextReference: string | undefined, secretValues: string[]): ExecutionCheckpoint {
  return sanitizeSkillSecrets(projectContextValue(checkpoint, contextSources, contextReferences, contextReference), secretValues) as ExecutionCheckpoint;
}

class RedactingCheckpointStore extends CheckpointStore {
  constructor(
    private readonly delegate: FileCheckpointStore,
    private readonly contextSources: readonly string[],
    private readonly contextReferences: readonly string[],
    private readonly contextReference: string | undefined,
    private readonly secrets: string[],
  ) {
    super(secrets);
  }

  override async save(checkpoint: Checkpoint): Promise<ExecutionCheckpoint> {
    return this.delegate.save(projectCheckpoint(checkpoint, this.contextSources, this.contextReferences, this.contextReference, this.secrets));
  }

  override async get(id: string): Promise<ExecutionCheckpoint> {
    return this.delegate.get(id);
  }

  override async hydrate(checkpoint: ExecutionCheckpoint): Promise<ExecutionCheckpoint> {
    return this.delegate.hydrate(projectCheckpoint(checkpoint, this.contextSources, this.contextReferences, this.contextReference, this.secrets));
  }
}

function adapterFor(config: RuntimeSessionConfig, credential: string): RuntimeAdapter {
  if (config.runtime === 'qwen') return createQwenOfficialAdapter({ apiKey: credential });
  return createCodexApiKeyAdapter({ apiKey: credential, ...(process.env.TITAN_CODEX_BINARY ? { executable: process.env.TITAN_CODEX_BINARY } : {}) });
}

export async function executeDispatch(dispatch: RunDispatch, dependencies: WorkerDependencies = {}): Promise<AgentRunResult> {
  let sequence = 0;
  let secretValues: string[] = [];
  const send = dependencies.sendProgress ?? (progress => { if (process.send && process.connected) process.send({ type: 'progress', progress }); });
  const emit = (type: RunProgress['type'], payload: Record<string, unknown>, checkpoint?: RunProgress['checkpoint']): void => {
    const progress: RunProgress = { eventId: randomUUID(), sequence: ++sequence, claimToken: dispatch.claimToken, type, payload: safePayload(payload, secretValues), ...(checkpoint ? { checkpoint } : {}) };
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
  const baseUrl = dispatch.config.baseUrlRef ? await credentialResolver(dispatch.config.baseUrlRef) : undefined;
  if (credential) secretValues = [credential];
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
  let validatedBaseUrl: string | undefined;
  if (dispatch.config.runtime === 'codex' && !baseUrl) {
    const result: AgentRunResult = { status: 'waiting_input', replayedToolUseIds: [], evidence: [], error: 'Codex API URL is unavailable' };
    emit('waiting_input', { status: 'waiting_input', message: 'Codex API URL is unavailable' });
    return result;
  }
  if (baseUrl) validatedBaseUrl = validateProviderBaseUrl(baseUrl);
  const runtimeConfig = dispatch.config as RuntimeConfigWithLocalPolicy;
  const configuredSkills = runtimeConfig.localPolicy?.enabledSkills ?? runtimeConfig.enabledSkills ?? [];
  if (!Array.isArray(configuredSkills) || configuredSkills.some(skill => typeof skill !== 'string')) {
    const result: AgentRunResult = { status: 'failed', replayedToolUseIds: [], evidence: [], error: 'skill activation list is invalid' };
    emit('failed', { status: 'failed', message: result.error });
    return result;
  }
  let contextSnapshot: Awaited<ReturnType<typeof loadSkillContext>>;
  let contextReference: string | undefined;
  try {
    contextSnapshot = await loadSkillContext({ workspacePath: dispatch.config.workspacePath, allowedTools: dispatch.config.allowedTools, enabledSkillIds: configuredSkills, secretValues });
    if (contextSnapshot) contextReference = await persistSkillContextSnapshot(dispatch.config.workspacePath, contextSnapshot, secretValues);
  } catch (error) {
    const result: AgentRunResult = { status: 'failed', replayedToolUseIds: [], evidence: [], error: error instanceof Error ? error.message : String(error) };
    emit('failed', { status: 'failed', message: result.error });
    return result;
  }
  if (contextSnapshot) {
    const skillSummary = contextSnapshot.skills.map(skill => `${skill.id}@${skill.version}(${skill.digest})`).join(', ');
    emit('output', { reference: contextReference, text: `已载入项目上下文${skillSummary ? `：${skillSummary}` : ''}` });
  }
  const goal = contextSnapshot ? `${dispatch.goal}\n\n${contextSnapshot.text}` : dispatch.goal;
  const adapterConfig: RuntimeSessionConfig = {
    runtime: dispatch.config.runtime,
    credentialRef: dispatch.config.credentialRef,
    ...(dispatch.config.modelRef ? { modelRef: dispatch.config.modelRef } : {}),
    ...(validatedBaseUrl ? { baseUrl: validatedBaseUrl } : {}),
    cwd: dispatch.config.workspacePath,
    workspace: dispatch.config.workspacePath,
    timeoutMs: dispatch.config.timeoutMs,
    ...(dependencies.signal ? { signal: dependencies.signal } : {}),
    tools: runtimeToolSpecs.filter(tool => dispatch.config.allowedTools.includes(tool.name)),
  };
  const adapter = dependencies.adapterFactory ? dependencies.adapterFactory(adapterConfig, credential) : adapterFor(adapterConfig, credential);
  const emitAudit = (event: { source: 'hook' | 'tool'; status: string; toolName?: string; toolCallId?: string; hookName?: string; reason?: string; inputHash?: string }): void => {
    emit('output', { source: event.source, status: event.status, ...(event.toolName ? { toolName: event.toolName } : {}), ...(event.toolCallId ? { toolCallId: event.toolCallId } : {}), ...(event.hookName ? { hookName: event.hookName } : {}), ...(event.reason ? { reason: event.reason } : {}), ...(event.inputHash ? { inputHash: event.inputHash } : {}) });
  };
  const permissions = new PermissionEngine(dispatch.config.allowedTools.map(action => ({ source: 'run' as const, action, resource: dispatch.runId, decision: 'allow' as const })));
  const hooks = new HookRunner(runtimeSafetyHooks(), { onAudit: emitAudit });
  const sessionScope = createHash('sha256').update(`${dispatch.projectId}:${dispatch.taskId}:${dispatch.sessionId}`).digest('hex');
  const ledgerRoot = join(dispatch.config.workspacePath, '.titan', 'tool-ledger', sessionScope);
  const tools = new ToolRegistry({ permission: permissions, hooks, ledger: new FileToolExecutionLedger(ledgerRoot, dispatch.config.workspacePath), onAudit: emitAudit });
  for (const tool of createRuntimeTools()) tools.register(tool);
  const checkpointStore = new FileCheckpointStore(dependencies.checkpointRoot ?? join(dispatch.config.workspacePath, '.titan', 'checkpoints'), dispatch.config.workspacePath, secretValues);
  const contextSources = contextSnapshot ? [contextSnapshot.text, ...contextSnapshot.sourceTexts] : [];
  const contextReferences = contextSnapshot?.references ?? [];
  const checkpoints = new RedactingCheckpointStore(checkpointStore, contextSources, contextReferences, contextReference, secretValues);
  const loop = new AgentLoop({
    adapter,
    tools,
    checkpoints,
    goalGate: new GoalGate(),
    toolSpecs: runtimeToolSpecs.filter(tool => dispatch.config.allowedTools.includes(tool.name)),
    onProgress: progress => {
      const publicCheckpoint = progress.checkpoint ? projectCheckpoint(progress.checkpoint, contextSources, contextReferences, contextReference, secretValues) : undefined;
      if (progress.type === 'checkpoint') emit('checkpoint', { checkpointId: publicCheckpoint?.id, evidence: publicCheckpoint?.evidence ?? [] }, publicCheckpoint);
      else if (progress.type === 'tool') emit('output', { source: 'tool', status: 'requested', ...progress.payload });
      else emit('output', progress.payload);
    },
  });
  const result = await loop.run({
    runId: dispatch.runId,
    goal,
    runtime: dispatch.config.runtime,
    credentialRef: dispatch.config.credentialRef,
    ...(dispatch.config.modelRef ? { modelRef: dispatch.config.modelRef } : {}),
    ...(validatedBaseUrl ? { baseUrl: validatedBaseUrl } : {}),
    workspacePath: dispatch.config.workspacePath,
    allowedTools: dispatch.config.allowedTools,
    timeoutMs: dispatch.config.timeoutMs,
    maxTurns: dispatch.config.maxTurns,
    ...(dependencies.signal ? { signal: dependencies.signal } : {}),
    ...(dispatch.checkpoint ? { checkpoint: dispatch.checkpoint } : {}),
    secretValues,
    trustedCode: runtimeConfig.localPolicy?.trustedCode === true,
  });
  const checkpoint = result.checkpoint;
  const publicCheckpoint = checkpoint ? projectCheckpoint(checkpoint, contextSources, contextReferences, contextReference, secretValues) : undefined;
  if (result.status === 'satisfied') emit('completed', { status: 'completed', evidence: result.evidence, ...(publicCheckpoint ? { checkpointId: publicCheckpoint.id } : {}) }, publicCheckpoint);
  else if (result.status === 'waiting_input') emit('waiting_input', { status: 'waiting_input', message: result.error ?? 'human input is required', evidence: result.evidence, ...(publicCheckpoint ? { checkpointId: publicCheckpoint.id } : {}) }, publicCheckpoint);
  else if (result.status === 'cancelled') emit('cancelled', { status: 'cancelled', message: result.error ?? 'run cancelled', evidence: result.evidence, ...(publicCheckpoint ? { checkpointId: publicCheckpoint.id } : {}) }, publicCheckpoint);
  else emit('failed', { status: 'failed', message: result.error ?? 'runtime failed', evidence: result.evidence, ...(publicCheckpoint ? { checkpointId: publicCheckpoint.id } : {}) }, publicCheckpoint);
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
