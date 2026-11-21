import { DomainError } from '@titan/contracts';
import { randomUUID } from 'node:crypto';
import { providerError } from './provider-credentials.js';
import type { CheckpointReference, NativeSession, RuntimeAdapter, RuntimeEvent, RuntimeInput, RuntimeSessionConfig } from './runtime-adapter.js';

export type QwenMessage = { role: 'user' | 'assistant' | 'tool'; content: string | null; tool_calls?: QwenToolCall[]; tool_call_id?: string };
export type QwenToolCall = { id: string; type: 'function'; function: { name: string; arguments: string } };
export type QwenTurn = { config: RuntimeSessionConfig; messages: QwenMessage[]; signal: AbortSignal };
export type QwenTransport = { send: (session: NativeSession, turn: QwenTurn) => AsyncIterable<{ type: string; payload?: unknown }> };
type SessionState = {
  config: RuntimeSessionConfig;
  messages: QwenMessage[];
  pendingTools: Set<string>;
  ready: boolean;
  active: boolean;
  sessionSignal: AbortSignal | undefined;
  signal: AbortSignal | undefined;
  controller: AbortController | undefined;
};

export class QwenAdapter implements RuntimeAdapter {
  private readonly sessions = new Map<string, SessionState>();
  constructor(private readonly transport: QwenTransport) {}

  async createSession(config: RuntimeSessionConfig): Promise<NativeSession> {
    if (!config.credentialRef) throw new DomainError('RUNTIME_ADAPTER_UNAVAILABLE', 'Qwen credential reference is required');
    if (config.runtime !== 'qwen') throw providerError('Qwen', 'runtime mismatch');
    if (config.signal?.aborted) throw providerError('Qwen', 'session aborted');
    const session: NativeSession = { id: `qwen:${randomUUID()}`, runtime: 'qwen' };
    const { signal, ...settings } = config;
    this.sessions.set(session.id, { config: structuredClone(settings), messages: [], pendingTools: new Set(), ready: false, active: false, sessionSignal: signal, signal, controller: undefined });
    return session;
  }

  async *streamEvents(session: NativeSession): AsyncIterable<RuntimeEvent> {
    const state = this.get(session);
    if (!state.ready || state.active) throw providerError('Qwen', 'input is required and only one stream may run');
    const controller = new AbortController();
    state.controller = controller;
    state.active = true;
    const signal = state.signal ? AbortSignal.any([controller.signal, state.signal]) : controller.signal;
    try {
      signal.throwIfAborted();
      for await (const event of this.transport.send(session, { config: state.config, messages: state.messages, signal })) {
        signal.throwIfAborted();
        if (event.type === 'assistant.message') {
          const message = event.payload as QwenMessage;
          state.messages.push(message);
          state.pendingTools = new Set(message.tool_calls?.map(call => call.id));
          state.ready = false;
        } else if (event.type === 'done') yield { type: 'session.completed', payload: event.payload };
        else if (event.type === 'text') yield { type: 'text', payload: event.payload };
        else if (event.type === 'tool.requested') yield { type: 'tool.requested', payload: event.payload };
        else yield { type: 'model.streamed', payload: event.payload };
      }
    } catch (error) {
      if (error instanceof DomainError) throw error;
      throw providerError('Qwen', signal.aborted ? 'request aborted' : 'transport failed');
    } finally {
      controller.abort();
      state.active = false;
      state.controller = undefined;
    }
  }

  async sendInput(session: NativeSession, input: RuntimeInput): Promise<void> {
    const state = this.get(session);
    if (state.active || state.ready) throw providerError('Qwen', 'a turn is already pending');
    if (input.signal?.aborted || state.sessionSignal?.aborted) throw providerError('Qwen', 'request aborted');
    if (state.pendingTools.size) {
      const results = input.toolResults ?? [];
      if (input.text || results.length !== state.pendingTools.size || new Set(results.map(result => result.id)).size !== results.length || results.some(result => !state.pendingTools.has(result.id))) {
        throw providerError('Qwen', 'all pending tool results are required');
      }
      state.messages.push(...results.map(result => ({ role: 'tool' as const, tool_call_id: result.id, content: result.output })));
      state.pendingTools.clear();
    } else {
      if (!input.text.trim() || input.toolResults?.length) throw providerError('Qwen', 'user text is required');
      state.messages.push({ role: 'user', content: input.text });
    }
    state.ready = true;
    state.signal = input.signal && state.sessionSignal ? AbortSignal.any([input.signal, state.sessionSignal]) : input.signal ?? state.sessionSignal;
  }

  async pause(_session: NativeSession): Promise<CheckpointReference> { throw providerError('Qwen', 'pause is unsupported'); }
  async resume(_session: NativeSession, _checkpoint: CheckpointReference): Promise<void> { throw providerError('Qwen', 'resume is unsupported'); }
  async cancel(session: NativeSession): Promise<void> { await this.close(session); }
  async close(session: NativeSession): Promise<void> {
    const state = this.sessions.get(session.id);
    state?.controller?.abort();
    this.sessions.delete(session.id);
  }

  private get(session: NativeSession): SessionState {
    const state = this.sessions.get(session.id);
    if (session.runtime !== 'qwen' || !state) throw providerError('Qwen', 'session is closed or unknown');
    return state;
  }
}
