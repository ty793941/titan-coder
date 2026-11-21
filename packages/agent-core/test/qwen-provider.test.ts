import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { createQwenOfficialAdapter } from '../src/adapters/provider-adapters.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(cleanups.splice(0).map(cleanup => cleanup())); });

async function httpFixture(handler: (request: IncomingMessage, response: ServerResponse, body: any) => void) {
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    handler(request, response, JSON.parse(Buffer.concat(chunks).toString()));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); }));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing fixture port');
  return `http://127.0.0.1:${address.port}/v1`;
}

describe('Qwen official HTTP provider', () => {
  it('isolates same-model sessions and preserves real user and assistant history', async () => {
    const requests: any[] = [];
    const baseUrl = await httpFixture((request, response, body) => {
      requests.push({ path: request.url, auth: request.headers.authorization, body });
      response.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'reply-' + requests.length } }] }));
    });
    const adapter = createQwenOfficialAdapter({ apiKey: async () => 'qwen-secret', baseUrl });
    const first = await adapter.createSession({ runtime: 'qwen', credentialRef: 'secret://qwen', modelRef: 'qwen-turbo' });
    const second = await adapter.createSession({ runtime: 'qwen', credentialRef: 'secret://qwen', modelRef: 'qwen-turbo' });
    expect(first.id).not.toBe(second.id);
    await adapter.sendInput(first, { text: 'real input' });
    expect(await Array.fromAsync(adapter.streamEvents(first))).toContainEqual({ type: 'text', payload: 'reply-1' });
    await adapter.sendInput(first, { text: 'follow-up' });
    await Array.fromAsync(adapter.streamEvents(first));
    await adapter.sendInput(second, { text: 'other session' });
    await Array.fromAsync(adapter.streamEvents(second));
    expect(requests[1]).toEqual({ path: '/v1/chat/completions', auth: 'Bearer qwen-secret', body: {
      model: 'qwen-turbo', messages: [{ role: 'user', content: 'real input' }, { role: 'assistant', content: 'reply-1' }, { role: 'user', content: 'follow-up' }],
    } });
    expect(requests[2].body.messages).toEqual([{ role: 'user', content: 'other session' }]);
    await adapter.close(first);
    await expect(adapter.sendInput(first, { text: 'closed' })).rejects.toThrow('RUNTIME_ADAPTER_UNAVAILABLE');
  });

  it('passes tool schemas and completes an actual tool-result round', async () => {
    const requests: any[] = [];
    const baseUrl = await httpFixture((_request, response, body) => {
      requests.push(body);
      response.end(JSON.stringify({ choices: [{ message: requests.length === 1
        ? { role: 'assistant', content: null, tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'lookup', arguments: '{"q":"hello"}' } }] }
        : { role: 'assistant', content: 'found it' } }] }));
    });
    const adapter = createQwenOfficialAdapter({ apiKey: 'secret', baseUrl });
    const session = await adapter.createSession({ runtime: 'qwen', credentialRef: 'secret://qwen', tools: [{ name: 'lookup', description: 'Lookup', inputSchema: { type: 'object' } }] });
    await adapter.sendInput(session, { text: 'find hello' });
    const events = await Array.fromAsync(adapter.streamEvents(session));
    expect(events).toContainEqual({ type: 'tool.requested', payload: { id: 'call-1', name: 'lookup', arguments: { q: 'hello' } } });
    expect(events.some(event => event.type === 'session.completed')).toBe(false);
    await expect(adapter.sendInput(session, { text: '', toolResults: [{ id: 'wrong', output: 'bad' }] })).rejects.toThrow('RUNTIME_ADAPTER_UNAVAILABLE');
    await adapter.sendInput(session, { text: '', toolResults: [{ id: 'call-1', output: 'record' }] });
    expect(await Array.fromAsync(adapter.streamEvents(session))).toContainEqual({ type: 'text', payload: 'found it' });
    expect(requests[0].tools).toEqual([{ type: 'function', function: { name: 'lookup', description: 'Lookup', parameters: { type: 'object' } } }]);
    expect(requests[1].messages[2]).toEqual({ role: 'tool', tool_call_id: 'call-1', content: 'record' });
  });

  it.each(['http', 'json', 'shape', 'network'])('normalizes %s failures and never exposes credential-bearing response bodies', async mode => {
    const baseUrl = await httpFixture((_request, response) => {
      if (mode === 'network') return response.destroy();
      if (mode === 'http') response.statusCode = 401;
      response.end(mode === 'json' ? 'secret-sensitive invalid json' : JSON.stringify({ error: { message: 'secret-sensitive' } }));
    });
    const adapter = createQwenOfficialAdapter({ apiKey: 'secret-sensitive', baseUrl });
    const session = await adapter.createSession({ runtime: 'qwen', credentialRef: 'secret://qwen' });
    await adapter.sendInput(session, { text: 'hello' });
    const error = await Array.fromAsync(adapter.streamEvents(session)).catch(error => error);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain('RUNTIME_ADAPTER_UNAVAILABLE');
    expect(error.message).not.toContain('secret-sensitive');
  });

  it('cancels an active HTTP request and rejects unsupported pause and resume', async () => {
    let received!: () => void;
    const started = new Promise<void>(resolve => { received = resolve; });
    const baseUrl = await httpFixture(() => received());
    const adapter = createQwenOfficialAdapter({ apiKey: 'secret', baseUrl });
    const session = await adapter.createSession({ runtime: 'qwen', credentialRef: 'secret://qwen' });
    await expect(adapter.pause(session)).rejects.toThrow('unsupported');
    await expect(adapter.resume(session, { id: 'unknown' })).rejects.toThrow('unsupported');
    const controller = new AbortController();
    await adapter.sendInput(session, { text: 'hello', signal: controller.signal });
    const stream = Array.fromAsync(adapter.streamEvents(session));
    const rejection = expect(stream).rejects.toThrow('RUNTIME_ADAPTER_UNAVAILABLE');
    await started;
    controller.abort();
    await rejection;
    await adapter.cancel(session);
    await expect(adapter.sendInput(session, { text: 'cancelled' })).rejects.toThrow('RUNTIME_ADAPTER_UNAVAILABLE');
  });

  it('aborts with the session signal even when an input signal was also supplied', async () => {
    let received!: () => void;
    const started = new Promise<void>(resolve => { received = resolve; });
    const baseUrl = await httpFixture(() => received());
    const adapter = createQwenOfficialAdapter({ apiKey: 'secret', baseUrl });
    const controller = new AbortController();
    const session = await adapter.createSession({ runtime: 'qwen', credentialRef: 'secret://qwen', signal: controller.signal });
    await adapter.sendInput(session, { text: 'hello', signal: new AbortController().signal });
    const rejection = expect(Array.fromAsync(adapter.streamEvents(session))).rejects.toThrow('RUNTIME_ADAPTER_UNAVAILABLE');
    await started;
    controller.abort();
    await rejection;
  });

  it('times out stalled HTTP responses', async () => {
    const baseUrl = await httpFixture(() => undefined);
    const adapter = createQwenOfficialAdapter({ apiKey: 'secret', baseUrl, timeoutMs: 100 });
    const session = await adapter.createSession({ runtime: 'qwen', credentialRef: 'secret://qwen' });
    await adapter.sendInput(session, { text: 'hello' });
    await expect(Array.fromAsync(adapter.streamEvents(session))).rejects.toThrow('timed out');
  });
});
