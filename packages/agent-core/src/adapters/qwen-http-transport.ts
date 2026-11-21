import { DomainError } from '@titan/contracts';
import { providerError, resolveApiKey, type ProviderCredentials } from './provider-credentials.js';
import type { QwenMessage, QwenToolCall, QwenTransport } from './qwen-adapter.js';

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
export type QwenProviderOptions = ProviderCredentials & { fetcher?: Fetcher; baseUrl?: string; timeoutMs?: number };

function parseMessage(body: unknown): QwenMessage {
  const raw = body as { choices?: Array<{ message?: QwenMessage }> } | null;
  const message = raw?.choices?.[0]?.message;
  if (!message || (typeof message.content !== 'string' && message.content !== null) || (!message.content && !message.tool_calls?.length)) {
    throw providerError('Qwen', 'invalid response shape');
  }
  const calls = message.tool_calls;
  if (calls !== undefined && (!Array.isArray(calls) || calls.some((call: QwenToolCall) => !call || typeof call.id !== 'string' || !call.id || call.type !== 'function' || typeof call.function?.name !== 'string' || typeof call.function.arguments !== 'string') || new Set(calls.map(call => call.id)).size !== calls.length)) {
    throw providerError('Qwen', 'invalid tool calls');
  }
  for (const call of calls ?? []) {
    const args: unknown = JSON.parse(call.function.arguments);
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw providerError('Qwen', 'invalid tool arguments');
  }
  return { role: 'assistant', content: message.content, ...(calls?.length ? { tool_calls: calls } : {}) };
}

export function createQwenHttpTransport(options: QwenProviderOptions): QwenTransport {
  return {
    send: async function* (_session, turn) {
      const timeoutMs = turn.config.timeoutMs ?? options.timeoutMs ?? 60_000;
      const signal = AbortSignal.any([turn.signal, AbortSignal.timeout(timeoutMs)]);
      try {
        const apiKey = await resolveApiKey(options, turn.config.credentialRef!);
        signal.throwIfAborted();
        const baseUrl = (turn.config.baseUrl ?? options.baseUrl ?? 'https://dashscope.aliyuncs.com/compatible-mode/v1').replace(/\/$/, '');
        const response = await (options.fetcher ?? fetch)(`${baseUrl}/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', Authorization: `Bearer ${apiKey}` },
          signal,
          body: JSON.stringify({
            model: turn.config.modelRef ?? 'qwen-plus',
            messages: turn.messages,
            ...(turn.config.tools?.length ? { tools: turn.config.tools.map(tool => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.inputSchema } })) } : {}),
            ...(turn.config.budget?.maxOutputTokens !== undefined ? { max_tokens: turn.config.budget.maxOutputTokens } : {}),
          }),
        });
        if (!response.ok) {
          await response.body?.cancel();
          throw providerError('Qwen', 'HTTP request failed', { status: response.status });
        }
        const message = parseMessage(await response.json());
        const tools = new Set(turn.config.tools?.map(tool => tool.name));
        if (message.tool_calls?.some(call => !tools.has(call.function.name))) throw providerError('Qwen', 'unregistered tool requested');
        yield { type: 'assistant.message', payload: message };
        if (message.content) yield { type: 'text', payload: message.content };
        for (const call of message.tool_calls ?? []) {
          yield { type: 'tool.requested', payload: { id: call.id, name: call.function.name, arguments: JSON.parse(call.function.arguments) as unknown } };
        }
        if (!message.tool_calls?.length) yield { type: 'done' };
      } catch (error) {
        if (error instanceof DomainError) throw error;
        throw providerError('Qwen', signal.aborted ? 'request aborted or timed out' : 'HTTP transport or response failed');
      }
    },
  };
}
