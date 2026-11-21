import { DomainError } from '@titan/contracts';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import type { CodexTransport } from './codex-adapter.js';
import { CodexStdioRpc, type RpcMessage } from './codex-stdio-rpc.js';
import { providerError, resolveApiKey, type ProviderCredentials } from './provider-credentials.js';
import type { CheckpointReference, NativeRuntimeEvent, RuntimeInput, RuntimeSessionConfig } from './runtime-adapter.js';

export type CodexProviderOptions = ProviderCredentials & { executable?: string; args?: string[]; timeoutMs?: number };

class TurnEvents {
  private readonly values: NativeRuntimeEvent[] = [];
  private wake: (() => void) | undefined;
  private failure: Error | undefined;
  private reading = false;

  push(event: NativeRuntimeEvent): void {
    if (this.failure) return;
    if (this.values.length >= 4096) throw providerError('Codex', 'event queue exceeded limit');
    this.values.push(event);
    this.wake?.();
  }

  fail(error: Error): void { this.failure ??= error; this.wake?.(); }

  async *read(): AsyncIterable<NativeRuntimeEvent> {
    if (this.reading) throw providerError('Codex', 'only one stream may run');
    this.reading = true;
    try {
      while (true) {
        if (this.failure) throw this.failure;
        const event = this.values.shift();
        if (event) {
          yield event;
          if (event.type === 'turn.completed') return;
        } else {
          await new Promise<void>(resolve => { this.wake = resolve; });
          this.wake = undefined;
        }
      }
    } finally { this.reading = false; }
  }
}

type SessionState = {
  rpc: CodexStdioRpc;
  home: string;
  config: RuntimeSessionConfig;
  threadId: string;
  turnId: string | undefined;
  busy: boolean;
  hasTurn: boolean;
  paused: boolean;
  events: TurnEvents;
  checkpoints: Set<string>;
  tools: Map<string, string | number>;
  timer: ReturnType<typeof setTimeout> | undefined;
  detach: (() => void) | undefined;
  detachTurn: (() => void) | undefined;
  turnFinished: Promise<void>;
  finishTurn: (() => void) | undefined;
  dispose: Promise<void> | undefined;
};

export class CodexStdioTransport implements CodexTransport {
  private readonly sessions = new Map<string, SessionState>();
  constructor(private readonly options: CodexProviderOptions) {}

  async create(config: RuntimeSessionConfig): Promise<{ id: string }> {
    if (config.runtime !== 'codex') throw providerError('Codex', 'runtime mismatch');
    if (config.baseUrl) throw providerError('Codex', 'custom baseUrl is unsupported by this official API-key adapter');
    if (config.budget?.maxOutputTokens !== undefined) throw providerError('Codex', 'maxOutputTokens is unsupported by App Server');
    const cwd = config.cwd ?? config.workspace ?? process.cwd();
    if (!isAbsolute(cwd)) throw providerError('Codex', 'cwd must be absolute');
    if (config.signal?.aborted) throw providerError('Codex', 'session aborted');
    let apiKey = await resolveApiKey(this.options, config.credentialRef!);
    const home = await mkdtemp(join(tmpdir(), 'titan-codex-'));
    let state: SessionState | undefined;
    try {
      if (config.signal?.aborted) throw providerError('Codex', 'session aborted');
      const timeoutMs = config.timeoutMs ?? this.options.timeoutMs ?? 60_000;
      const rpc = new CodexStdioRpc(this.options.executable ?? 'codex', [
        ...(this.options.args ?? ['app-server', '--listen', 'stdio://']),
        '-c', 'cli_auth_credentials_store="ephemeral"',
        '-c', 'sandbox_mode="read-only"',
        '-c', 'approval_policy="never"',
        '-c', 'shell_environment_policy.inherit="none"',
        '-c', 'features.shell_tool=false',
        '-c', 'tools.view_image=false',
      ], cwd, home, timeoutMs,
      message => { if (state) this.onMessage(state, message); },
      error => {
        if (state) {
          state.events.fail(error);
          void this.dispose(state);
        }
      });
      state = { rpc, home, config: { ...config, cwd }, threadId: '', turnId: undefined, busy: false, hasTurn: false, paused: false, events: new TurnEvents(), checkpoints: new Set(), tools: new Map(), timer: undefined, detach: undefined, detachTurn: undefined, turnFinished: Promise.resolve(), finishTurn: undefined, dispose: undefined };
      if (config.signal) {
        const current = state;
        const abort = () => { current.events.fail(providerError('Codex', 'session aborted')); void this.dispose(current); };
        config.signal.addEventListener('abort', abort, { once: true });
        state.detach = () => config.signal?.removeEventListener('abort', abort);
        if (config.signal.aborted) { abort(); throw providerError('Codex', 'session aborted'); }
      }
      await rpc.request('initialize', { clientInfo: { name: 'titan', title: 'Titan Runtime', version: '0.1.0' }, capabilities: { experimentalApi: true } });
      rpc.notify('initialized');
      await rpc.request('account/login/start', { type: 'apiKey', apiKey });
      apiKey = '';
      const result = await rpc.request('thread/start', {
        model: config.modelRef ?? null,
        cwd,
        sandbox: 'read-only',
        approvalPolicy: 'never',
        // 恢复依赖 rollout；只写入当前子进程的临时目录，认证仍采用内存存储。
        ephemeral: false,
        ...(config.workspace ? { runtimeWorkspaceRoots: [config.workspace] } : {}),
        ...(config.tools?.length ? { dynamicTools: config.tools.map(tool => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })) } : {}),
      });
      if (typeof result?.thread?.id !== 'string' || !result.thread.id) throw providerError('Codex', 'thread/start returned no thread');
      state.threadId = result.thread.id;
      this.sessions.set(state.threadId, state);
      return { id: state.threadId };
    } catch (error) {
      if (state) await this.dispose(state);
      else await rm(home, { recursive: true, force: true });
      if (config.signal?.aborted) throw providerError('Codex', 'session aborted');
      if (error instanceof DomainError) throw error;
      throw providerError('Codex', 'App Server initialization failed');
    } finally { apiKey = ''; }
  }

  async *events(session: { id: string }): AsyncIterable<NativeRuntimeEvent> {
    const state = this.get(session);
    yield* state.events.read();
  }

  async send(session: { id: string }, input: RuntimeInput): Promise<void> {
    const state = this.get(session);
    if (state.paused) throw providerError('Codex', 'session is paused');
    if (input.signal?.aborted) throw providerError('Codex', 'turn aborted');
    if (input.toolResults?.length) {
      if (input.text || input.toolResults.some(result => !state.tools.has(result.id)) || new Set(input.toolResults.map(result => result.id)).size !== input.toolResults.length) throw providerError('Codex', 'unknown tool result');
      for (const result of input.toolResults) {
        state.rpc.respond(state.tools.get(result.id)!, { success: !result.isError, contentItems: [{ type: 'inputText', text: result.output }] });
        state.tools.delete(result.id);
      }
      return;
    }
    if (state.busy || !input.text.trim()) throw providerError('Codex', 'turn is active or user text is empty');
    state.busy = true;
    state.turnFinished = new Promise(resolve => { state.finishTurn = resolve; });
    const timeoutMs = state.config.timeoutMs ?? this.options.timeoutMs ?? 60_000;
    state.timer = setTimeout(() => { state.events.fail(providerError('Codex', 'turn timed out')); void this.dispose(state); }, timeoutMs);
    if (input.signal) {
      const abort = () => { state.events.fail(providerError('Codex', 'turn aborted')); void this.dispose(state); };
      input.signal.addEventListener('abort', abort, { once: true });
      state.detachTurn = () => input.signal?.removeEventListener('abort', abort);
    }
    try {
      const result = await state.rpc.request('turn/start', {
        threadId: state.threadId,
        input: [{ type: 'text', text: input.text, text_elements: [] }],
        model: state.config.modelRef ?? null,
        cwd: state.config.cwd,
        approvalPolicy: 'never',
        sandboxPolicy: { type: 'readOnly', networkAccess: false },
      });
      if (typeof result?.turn?.id !== 'string') throw providerError('Codex', 'turn/start returned no turn');
      state.hasTurn = true;
      if (state.busy) state.turnId = result.turn.id;
    } catch (error) {
      state.events.fail(error instanceof Error ? error : providerError('Codex', 'turn/start failed'));
      await this.dispose(state);
      throw error;
    }
  }

  async pause(session: { id: string }): Promise<CheckpointReference> {
    const state = this.get(session);
    if (!state.hasTurn) throw providerError('Codex', 'pause before the first turn is unsupported because no rollout exists');
    if (state.tools.size) throw providerError('Codex', 'pause during a dynamic tool call is unsupported');
    await this.interrupt(state);
    const id = randomUUID();
    state.checkpoints.add(id);
    state.paused = true;
    return { id };
  }

  async resume(session: { id: string }, checkpoint: CheckpointReference): Promise<void> {
    const state = this.get(session);
    if (!state.checkpoints.has(checkpoint.id)) throw new DomainError('CHECKPOINT_NOT_FOUND', 'Codex checkpoint is unknown or belongs to another session');
    if (!state.paused) throw providerError('Codex', 'session is not paused');
    const result = await state.rpc.request('thread/resume', { threadId: state.threadId, cwd: state.config.cwd, model: state.config.modelRef ?? null, sandbox: 'read-only', approvalPolicy: 'never' });
    if (result?.thread?.id !== state.threadId) throw providerError('Codex', 'thread/resume returned a different thread');
    state.paused = false;
    state.checkpoints.delete(checkpoint.id);
    state.events = new TurnEvents();
  }

  async cancel(session: { id: string }): Promise<void> {
    const state = this.sessions.get(session.id);
    if (!state) return;
    try { await this.interrupt(state); } finally { await this.dispose(state); }
  }

  async close(session: { id: string }): Promise<void> {
    const state = this.sessions.get(session.id);
    if (state) await this.dispose(state);
  }

  private get(session: { id: string }): SessionState {
    const state = this.sessions.get(session.id);
    if (!state || state.dispose) throw providerError('Codex', 'session is closed or unknown');
    return state;
  }

  private async interrupt(state: SessionState): Promise<void> {
    if (state.turnId && state.busy) {
      await state.rpc.request('turn/interrupt', { threadId: state.threadId, turnId: state.turnId });
      await state.turnFinished;
      if (state.dispose) throw providerError('Codex', 'interrupt failed because the session closed');
    }
  }

  private onMessage(state: SessionState, message: RpcMessage): void {
    const params = message.params ?? {};
    if (message.id !== undefined) {
      if (message.method === 'item/commandExecution/requestApproval' || message.method === 'item/fileChange/requestApproval') state.rpc.respond(message.id, { decision: 'decline' });
      else if (message.method === 'execCommandApproval' || message.method === 'applyPatchApproval') state.rpc.respond(message.id, { decision: 'denied' });
      else if (message.method === 'item/permissions/requestApproval') state.rpc.respond(message.id, { permissions: {}, scope: 'turn' });
      else if (message.method === 'item/tool/call' && state.busy && params.threadId === state.threadId && typeof params.callId === 'string' && !state.tools.has(params.callId) && state.config.tools?.some(tool => tool.name === params.tool)) {
        state.tools.set(params.callId, message.id);
        state.events.push({ type: 'tool.requested', payload: { id: params.callId, name: params.tool, arguments: params.arguments } });
      } else state.rpc.reject(message.id);
      return;
    }
    if (params.threadId !== state.threadId || !state.busy) return;
    const turnId = params.turnId ?? params.turn?.id;
    if (state.turnId && turnId && turnId !== state.turnId) return;
    if (message.method === 'turn/started') {
      state.turnId = params.turn?.id;
      state.events.push({ type: 'turn.started' });
    } else if (message.method === 'item/agentMessage/delta' && typeof params.delta === 'string') {
      state.events.push({ type: 'text', payload: params.delta });
    } else if (message.method === 'turn/completed') {
      clearTimeout(state.timer);
      state.detachTurn?.();
      state.detachTurn = undefined;
      state.busy = false;
      state.turnId = undefined;
      state.tools.clear();
      state.finishTurn?.();
      state.finishTurn = undefined;
      if (params.turn?.status === 'failed') {
        state.events.fail(providerError('Codex', 'turn failed'));
        void this.dispose(state);
      } else if (params.turn?.status === 'interrupted') state.events.fail(providerError('Codex', 'turn interrupted'));
      else state.events.push({ type: 'turn.completed' });
    } else if (message.method === 'error' && params.willRetry !== true) {
      state.events.fail(providerError('Codex', 'App Server reported a turn error'));
      void this.dispose(state);
    }
  }

  private dispose(state: SessionState): Promise<void> {
    if (!state.dispose) {
      state.dispose = Promise.resolve().then(async () => {
        clearTimeout(state.timer);
        state.detach?.();
        state.detachTurn?.();
        state.finishTurn?.();
        state.events.fail(providerError('Codex', 'session closed'));
        await state.rpc.stop();
        await rm(state.home, { recursive: true, force: true });
        if (this.sessions.get(state.threadId) === state) this.sessions.delete(state.threadId);
      });
    }
    return state.dispose;
  }
}
