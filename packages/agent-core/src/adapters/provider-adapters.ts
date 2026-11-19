import { DomainError } from '@titan/contracts';
import { CodexAdapter, type CodexTransport } from './codex-adapter.js';
import { QwenAdapter, type QwenTransport } from './qwen-adapter.js';
import type { NativeSession, RuntimeAdapter, RuntimeInput, RuntimeSessionConfig } from './runtime-adapter.js';
import type { CheckpointReference } from './runtime-adapter.js';

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
type ProviderOptions = { apiKey: string; fetcher?: Fetcher; baseUrl?: string };

export function createQwenOfficialAdapter(options: ProviderOptions): RuntimeAdapter {
  const fetcher = options.fetcher ?? fetch;
  const transport: QwenTransport = {
    send: async function* (session: NativeSession) {
      const response = await fetcher(`${options.baseUrl ?? 'https://dashscope.aliyuncs.com/compatible-mode/v1'}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', Authorization: `Bearer ${options.apiKey}` },
        body: JSON.stringify({ model: session.id.split(':')[1] ?? 'qwen-plus', messages: [{ role: 'user', content: '继续执行当前任务' }] }),
      });
      if (!response.ok) throw new DomainError('RUNTIME_ADAPTER_UNAVAILABLE', `Qwen API returned ${response.status}`);
      const body = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
      yield { type: 'text', payload: body.choices?.[0]?.message?.content ?? '' };
      yield { type: 'done' };
    },
  };
  return new QwenAdapter(transport);
}

export function createCodexApiKeyAdapter(options: ProviderOptions): RuntimeAdapter {
  const fetcher = options.fetcher ?? fetch;
  let config: RuntimeSessionConfig | undefined;
  const transport: CodexTransport = {
    create: async (sessionConfig) => {
      config = sessionConfig;
      return { id: `codex:${sessionConfig.modelRef ?? 'gpt-5-codex'}` };
    },
    events: async function* () {
      const response = await fetcher(`${options.baseUrl ?? 'https://api.openai.com/v1'}/responses`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', Authorization: `Bearer ${options.apiKey}` },
        body: JSON.stringify({ model: config?.modelRef ?? 'gpt-5-codex', input: '继续执行当前任务' }),
      });
      if (!response.ok) throw new DomainError('RUNTIME_ADAPTER_UNAVAILABLE', `Codex API returned ${response.status}`);
      const body = await response.json() as { output_text?: string };
      yield { type: 'turn.started' };
      yield { type: 'text', payload: body.output_text ?? '' };
      yield { type: 'turn.completed' };
    },
    send: async () => undefined,
    pause: async (): Promise<CheckpointReference> => ({ id: `codex_checkpoint_${Date.now()}` }),
    resume: async () => undefined,
    cancel: async () => undefined,
    close: async () => undefined,
  };
  return new CodexAdapter(transport);
}
