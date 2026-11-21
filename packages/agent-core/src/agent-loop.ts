import { DomainError } from '@titan/contracts';
import { randomUUID } from 'node:crypto';
import type { CheckpointStore } from './checkpoints.js';
import type { GoalGate } from './goal-gate.js';
import type { ToolRegistry } from './tool-registry.js';
import type { AgentProgress, AgentRunInput, ExecutionCheckpoint, GoalEvidence } from './types.js';
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
  const value = output as { kind?: unknown; reference?: unknown; evidence?: unknown };
  const evidence: GoalEvidence[] = [];
  if ((value.kind === 'artifact' || value.kind === 'test') && typeof value.reference === 'string') evidence.push({ kind: value.kind, reference: value.reference });
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

export class AgentLoop {
  constructor(private readonly options: AgentLoopOptions) {}

  async run(input: AgentRunInput): Promise<AgentRunResult> {
    const controller = new AbortController();
    const signal = input.signal ? AbortSignal.any([input.signal, controller.signal]) : controller.signal;
    let timedOut = false;
    const timeout = input.timeoutMs ? setTimeout(() => { timedOut = true; controller.abort(); }, input.timeoutMs) : undefined;
    const messages = input.checkpoint?.messages ? [...input.checkpoint.messages] : [{ role: 'user' as const, text: input.goal }];
    const evidence: GoalEvidence[] = input.checkpoint?.evidence ? [...input.checkpoint.evidence] : [];
    const replayedToolUseIds = input.checkpoint?.successfulTools?.map(tool => tool.id) ?? [];
    if (input.checkpoint) this.options.tools.hydrate(input.checkpoint.successfulTools);
    let session: Awaited<ReturnType<RuntimeAdapter['createSession']>> | undefined;
    let latestCheckpoint: ExecutionCheckpoint | undefined;
    let completed = false;
    let turn = 0;
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
      await this.options.adapter.sendInput(session, { text: input.goal, signal });
      while (turn < (input.maxTurns ?? 8) && !completed) {
        signal.throwIfAborted();
        turn += 1;
        const pendingQwen: Array<{ id: string; output: string; isError?: boolean }> = [];
        for await (const event of this.options.adapter.streamEvents(session)) {
          signal.throwIfAborted();
          if (event.type === 'text') {
            const text = asText(event.payload);
            messages.push({ role: 'assistant', text });
            await this.options.onProgress?.({ type: 'output', payload: { text } });
          } else if (event.type === 'tool.requested') {
            const request = toolInput((event.payload ?? {}) as ToolRequestPayload);
            await this.options.onProgress?.({ type: 'tool', payload: { toolCallId: request.id, toolName: request.name } });
            const context = { runId: input.runId, ...(input.allowedTools ? { allowedTools: input.allowedTools } : {}), ...(input.workspacePath ? { workspacePath: input.workspacePath } : {}) };
            const result = await this.options.tools.execute({ toolUseId: request.id, name: request.name, input: request.input, context });
            const output = JSON.stringify(result.output);
            messages.push({ role: 'tool', text: output });
            evidence.push(...extractEvidence(result.output));
            const checkpoint = await this.options.checkpoints.save({ id: randomUUID(), messages: [...messages], successfulTools: this.options.tools.getSuccessfulResults(), evidence: [...evidence] });
            latestCheckpoint = checkpoint;
            await this.options.onProgress?.({ type: 'checkpoint', payload: { checkpointId: checkpoint.id, evidence: checkpoint.evidence }, checkpoint });
            if (session.runtime === 'qwen') pendingQwen.push({ id: request.id, output });
            else await this.options.adapter.sendInput(session, { text: '', toolResults: [{ id: request.id, output }], signal });
          } else if (event.type === 'completed' || event.type === 'session.completed') {
            completed = true;
          }
        }
        if (pendingQwen.length) await this.options.adapter.sendInput(session, { text: '', toolResults: pendingQwen, signal });
      }
      const decision = this.options.goalGate.evaluate(evidence);
      if (decision.decision === 'satisfied') return { status: 'satisfied', replayedToolUseIds, evidence, ...(latestCheckpoint ? { checkpoint: latestCheckpoint } : {}) };
      if (!completed && turn >= (input.maxTurns ?? 8)) return { status: 'failed', replayedToolUseIds, evidence, ...(latestCheckpoint ? { checkpoint: latestCheckpoint } : {}), error: 'maximum turns exceeded' };
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
    this.options.tools.hydrate(checkpoint.successfulTools);
    return { status: 'continue', replayedToolUseIds: checkpoint.successfulTools.map(tool => tool.id), evidence: checkpoint.evidence, checkpoint };
  }
}
