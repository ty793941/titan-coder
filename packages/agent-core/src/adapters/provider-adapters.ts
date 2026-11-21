import { CodexAdapter } from './codex-adapter.js';
import { CodexStdioTransport, type CodexProviderOptions } from './codex-stdio-transport.js';
import { QwenAdapter } from './qwen-adapter.js';
import { createQwenHttpTransport, type QwenProviderOptions } from './qwen-http-transport.js';
import type { RuntimeAdapter } from './runtime-adapter.js';

export type { CodexProviderOptions, QwenProviderOptions };

export function createQwenOfficialAdapter(options: QwenProviderOptions): RuntimeAdapter {
  return new QwenAdapter(createQwenHttpTransport(options));
}

export function createCodexApiKeyAdapter(options: CodexProviderOptions): RuntimeAdapter {
  return new CodexAdapter(new CodexStdioTransport(options));
}
