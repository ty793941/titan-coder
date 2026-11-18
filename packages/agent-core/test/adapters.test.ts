import { describe, expect, it } from 'vitest';
import { CodexAdapter } from '../src/adapters/codex-adapter.js';
import { QwenAdapter } from '../src/adapters/qwen-adapter.js';

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
});
