import { describe, expect, it } from 'vitest';
import { CodexAdapter } from '../src/adapters/codex-adapter.js';
import { QwenAdapter } from '../src/adapters/qwen-adapter.js';
import { createCodexApiKeyAdapter, createQwenOfficialAdapter } from '../src/adapters/provider-adapters.js';

describe('runtime adapters', () => {
  it('normalizes Codex App Server events', async () => {
    const adapter = new CodexAdapter({
      create: async () => ({ id: 'native_1' }),
      events: async function* () { yield { type: 'turn.started' }; yield { type: 'turn.completed' }; },
      send: async () => undefined,
      pause: async () => ({ id: 'checkpoint_1' }),
      resume: async () => undefined,
      cancel: async () => undefined,
      close: async () => undefined,
    });
    const session = await adapter.createSession({ runtime: 'codex', credentialRef: 'keychain://codex' });
    expect((await Array.fromAsync(adapter.streamEvents(session))).map(event => event.type)).toEqual(['session.started', 'session.completed']);
  });

  it('rejects a Qwen session without a credential reference', async () => {
    const adapter = new QwenAdapter({
      send: async function* () { yield { type: 'done' }; },
    });
    await expect(adapter.createSession({ runtime: 'qwen' })).rejects.toThrow('RUNTIME_ADAPTER_UNAVAILABLE');
  });

  it('creates a Qwen official adapter without exposing the API key in events', async () => {
    const adapter = createQwenOfficialAdapter({
      apiKey: 'qwen-secret',
      fetcher: async (_input, init) => {
        expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer qwen-secret');
        return new Response(JSON.stringify({ choices: [{ message: { content: 'hello' } }] }), { status: 200 });
      },
    });
    const session = await adapter.createSession({ runtime: 'qwen', credentialRef: 'secret://qwen', modelRef: 'qwen-plus' });
    await adapter.sendInput(session, { text: 'hello' });
    const events = await Array.fromAsync(adapter.streamEvents(session));
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'text', payload: 'hello' }),
      expect.objectContaining({ type: 'session.completed' }),
    ]));
    expect(JSON.stringify(events)).not.toContain('qwen-secret');
  });

  it('rejects a missing Codex executable rather than using the Responses API', async () => {
    const adapter = createCodexApiKeyAdapter({
      apiKey: 'codex-secret',
      executable: '/missing/titan-codex',
    });
    await expect(adapter.createSession({ runtime: 'codex', credentialRef: 'secret://codex' })).rejects.toThrow('RUNTIME_ADAPTER_UNAVAILABLE');
  });
});
