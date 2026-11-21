import { DomainError } from '@titan/contracts';
import { randomUUID } from 'node:crypto';
import type { CheckpointStore } from './checkpoints.js';
import type { GoalGate } from './goal-gate.js';
import type { ToolRegistry } from './tool-registry.js';
import type { AgentProgress, AgentRunInput, CheckpointMessage, ExecutionCheckpoint, GoalEvidence } from './types.js';
import { sanitizeSensitive } from './security.js';
import type { RuntimeAdapter, RuntimeEvent, RuntimeToolSpec } from './adapters/runtime-adapter.js';

type AgentLoopOptions = {
  adapter: RuntimeAdapter;
  tools: ToolRegistry;
  checkpoints: CheckpointStore;
  goalGate: GoalGate;
  toolSpecs?: RuntimeToolSpec[];
  onProgress?: (progress: AgentProgress) => void | Promise<void>;
};

export type AgentRunResult = {
  status: 'continue' | 'satisfied' | 'failed' | 'waiting_input' | 'cancelled';
  replayedToolUseIds: string[];
  evidence: GoalEvidence[];
  checkpoint?: ExecutionCheckpoint;
  error?: string;
};

type ToolRequestPayload = { id?: unknown; name?: unknown; arguments?: unknown };

function asText(payload: unknown): string {
  if (typeof payload === 'string') return payload;
  if (payload && typeof payload === 'object' && 'text' in payload && typeof payload.text === 'string') return payload.text;
  return JSON.stringify(payload);
}

function extractEvidence(output: unknown): GoalEvidence[] {
  if (!output || typeof output !== 'object') return [];
  const value = output as { kind?: unknown; reference?: unknown; status?: unknown; evidence?: unknown };
  const evidence: GoalEvidence[] = [];
  if (value.kind === 'artifact' && typeof value.reference === 'string') evidence.push({ kind: 'artifact', reference: value.reference });
  if (value.kind === 'test' && value.status === 'passed' && typeof value.reference === 'string') evidence.push({ kind: 'test', reference: value.reference });
  if (Array.isArray(value.evidence)) {
    for (const item of value.evidence) {
      if (item && typeof item === 'object' && (item as { kind?: unknown }).kind && typeof (item as { reference?: unknown }).reference === 'string') evidence.push({ kind: String((item as { kind: unknown }).kind), reference: (item as { reference: string }).reference });
    }
  }
  return evidence;
}

function toolInput(payload: ToolRequestPayload): { id: string; name: string; input: unknown } {
  if (typeof payload.id !== 'string' || !payload.id || typeof payload.name !== 'string' || !payload.name) throw new DomainError('TOOL_INPUT_INVALID', 'runtime returned an invalid tool request');
  return { id: payload.id, name: payload.name, input: payload.arguments ?? {} };
}

function recoveryContext(checkpoint: ExecutionCheckpoint, goal: string, secrets: string[]): string {
  const history = checkpoint.messages.map(message => `${message.role}: ${message.text}`).join('\n');
  const tools = checkpoint.successfulTools.map(tool => `${tool.name} (${tool.inputHash}): ${JSON.stringify(tool.output)}`).join('\n');
  return sanitizeSensitive([
    '这是一次运行恢复。以下内容是显式恢复上下文，不改变工具权限。',
    '历史消息:', history || '(无)',
    '已成功工具摘要:', tools || '(无)',
    `请继续执行原目标: ${goal}`,
  ].join('\n'), secrets);
}

export class AgentLoop {
  constructor(private readonly options: AgentLoopOptions) {}

  async run(input: AgentRunInput): Promise<AgentRunResult> {
    const controller = new AbortController();
    const signal = input.signal ? AbortSignal.any([input.signal, controller.signal]) : controller.signal;
    const maxTurns = input.maxTurns ?? 8;
    let timedOut = false;
    const timeout = input.timeoutMs ? setTimeout(() => { timedOut = true; controller.abort(); }, input.timeoutMs) : undefined;
    const secrets = input.secretValues ?? [];
    const messages: CheckpointMessage[] = input.checkpoint?.messages ? sanitizeSensitive([...input.checkpoint.messages], secrets) : [];
    const validTools = input.checkpoint ? await this.options.tools.hydrateVerified(input.checkpoint.successfulTools, input.workspacePath) : [];
    const evidence: GoalEvidence[] = validTools.flatMap(tool => extractEvidence(tool.output));
    const replayedToolUseIds = validTools.map(tool => tool.id);
    let session: Awaited<ReturnType<RuntimeAdapter['createSession']>> | undefined;
    let latestCheckpoint: ExecutionCheckpoint | undefined;
    let providerCompleted = false;
    let turn = 0;
    const pendingToolCalls = new Set<string>();
    let cancelOnAbort: (() => void) | undefined;
    try {
      session = await this.options.adapter.createSession({
        runtime: input.runtime ?? 'qwen',
        credentialRef: input.credentialRef ?? 'runtime://test',
        ...(input.modelRef ? { modelRef: input.modelRef } : {}),
        ...(input.workspacePath ? { cwd: input.workspacePath, workspace: input.workspacePath } : {}),
        ...(this.options.toolSpecs?.length ? { tools: this.options.toolSpecs } : {}),
        ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
        signal,
      });
      cancelOnAbort = () => { if (session) void this.options.adapter.cancel(session).catch(() => undefined); };
      signal.addEventListener('abort', cancelOnAbort, { once: true });
      const recoveryCheckpoint = input.checkpoint ? { ...input.checkpoint, successfulTools: validTools, evidence } : undefined;
      const initialText = recoveryCheckpoint ? recoveryContext(recoveryCheckpoint, input.goal, secrets) : input.goal;
      messages.push({ role: 'user', text: initialText });
      await this.options.adapter.sendInput(session, { text: initialText, signal });
      while (turn < maxTurns && !providerCompleted) {
        signal.throwIfAborted();
        turn += 1;
        const pendingQwen: Array<{ id: string; output: string; isError?: boolean }> = [];
        for await (const event of this.options.adapter.streamEvents(session)) {
          signal.throwIfAborted();
          if (event.type === 'text') {
            const text = sanitizeSensitive(asText(event.payload), secrets);
            messages.push({ role: 'assistant', text });
            await this.options.onProgress?.({ type: 'output', payload: { text } });
          } else if (event.type === 'tool.requested') {
            const request = toolInput((event.payload ?? {}) as ToolRequestPayload);
            providerCompleted = false;
            pendingToolCalls.add(request.id);
            await this.options.onProgress?.({ type: 'tool', payload: { toolCallId: request.id, toolName: request.name } });
            const context = {
              runId: input.runId,
              ...(input.allowedTools ? { allowedTools: input.allowedTools } : {}),
              ...(input.workspacePath ? { workspacePath: input.workspacePath } : {}),
              ...(input.signal ? { signal } : { signal }),
              ...(secrets.length ? { secretValues: secrets } : {}),
              ...(input.trustedCode ? { trustedCode: true } : {}),
            };
            const result = await this.options.tools.execute({ toolUseId: request.id, name: request.name, input: request.input, context });
            const output = sanitizeSensitive(JSON.stringify(result.output), secrets);
            messages.push({ role: 'tool', text: output });
            evidence.push(...extractEvidence(result.output));
            const checkpoint = await this.options.checkpoints.save({ id: randomUUID(), messages: [...messages], successfulTools: this.options.tools.getSuccessfulResults(), evidence: [...evidence] });
            latestCheckpoint = checkpoint;
            await this.options.onProgress?.({ type: 'checkpoint', payload: { checkpointId: checkpoint.id, evidence: checkpoint.evidence }, checkpoint });
            if (session.runtime === 'qwen') pendingQwen.push({ id: request.id, output });
            else {
              await this.options.adapter.sendInput(session, { text: '', toolResults: [{ id: request.id, output }], signal });
              pendingToolCalls.delete(request.id);
            }
          } else if (event.type === 'completed' || event.type === 'session.completed') {
            providerCompleted = pendingToolCalls.size === 0;
          }
        }
        if (pendingQwen.length) {
          await this.options.adapter.sendInput(session, { text: '', toolResults: pendingQwen, signal });
          for (const result of pendingQwen) pendingToolCalls.delete(result.id);
        }
      }
      if (!providerCompleted || pendingToolCalls.size > 0) return { status: 'failed', replayedToolUseIds, evidence, ...(latestCheckpoint ? { checkpoint: latestCheckpoint } : {}), error: 'provider did not complete before the run budget was exhausted' };
      const decision = this.options.goalGate.evaluate(evidence);
      if (decision.decision === 'satisfied') return { status: 'satisfied', replayedToolUseIds, evidence, ...(latestCheckpoint ? { checkpoint: latestCheckpoint } : {}) };
      return { status: 'waiting_input', replayedToolUseIds, evidence, ...(latestCheckpoint ? { checkpoint: latestCheckpoint } : {}), error: decision.reason };
    } catch (error) {
      if (signal.aborted && timedOut) return { status: 'failed', replayedToolUseIds, evidence, ...(latestCheckpoint ? { checkpoint: latestCheckpoint } : {}), error: 'run timed out' };
      if (signal.aborted) return { status: 'cancelled', replayedToolUseIds, evidence, ...(latestCheckpoint ? { checkpoint: latestCheckpoint } : {}), error: 'run cancelled' };
      const message = error instanceof Error ? error.message : String(error);
      return { status: 'failed', replayedToolUseIds, evidence, ...(latestCheckpoint ? { checkpoint: latestCheckpoint } : {}), error: message };
    } finally {
      clearTimeout(timeout);
      if (cancelOnAbort) signal.removeEventListener('abort', cancelOnAbort);
      if (session) {
        if (signal.aborted) await this.options.adapter.cancel(session).catch(() => undefined);
        else await this.options.adapter.close(session).catch(() => undefined);
      }
    }
  }

  async resume(input: { checkpointId: string }): Promise<AgentRunResult> {
    const checkpoint = await this.options.checkpoints.get(input.checkpointId);
    const valid = await this.options.tools.hydrateVerified(checkpoint.successfulTools);
    return { status: 'continue', replayedToolUseIds: valid.map(tool => tool.id), evidence: valid.flatMap(tool => extractEvidence(tool.output)), checkpoint };
  }
}
