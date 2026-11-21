import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { afterEach, describe, expect, it } from 'vitest';
import { createCodexApiKeyAdapter } from '../src/adapters/provider-adapters.js';

// 用真实子进程校验线路协议；不访问供应商，也不使用真实凭证。
const serverScript = String.raw`
const { createInterface } = require('node:readline');
const { existsSync } = require('node:fs');
const send = (message) => process.stdout.write(JSON.stringify(message) + '\n');
let initialized = false, loggedIn = false, turn = 0, thread;
let approvalId;
let interruptedFinished = false;
const mode = process.argv[1];
createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  const { id, method, params: p } = message;
  const ok = (result = {}) => send({ id, result });
  const fail = () => send({ id, error: { code: -32602, message: 'secret-test-key' } });
  if (!method) {
    if (id === 'approval') {
      if (message.result?.decision !== 'decline') process.exit(22);
      send({ method: 'item/agentMessage/delta', params: { threadId: thread, turnId: 'turn-1', delta: 'approval denied' } });
      send({ method: 'turn/completed', params: { threadId: thread, turn: { id: 'turn-1', status: 'completed' } } });
    }
    if (id === 'tool') {
      if (mode === 'unknown-tool') {
        if (!message.error) process.exit(25);
        return send({ method: 'turn/completed', params: { threadId: thread, turn: { id: 'turn-1', status: 'completed' } } });
      }
      if (message.result?.success !== true) process.exit(23);
      send({ method: 'item/agentMessage/delta', params: { threadId: thread, turnId: 'turn-1', delta: message.result.contentItems[0].text } });
      send({ method: 'turn/completed', params: { threadId: thread, turn: { id: 'turn-1', status: 'completed' } } });
    }
    return;
  }
  if (method === 'initialize') {
    if (mode === 'timeout') return;
    if (mode === 'exit') process.exit(17);
    if (mode === 'malformed') return process.stdout.write('secret-test-key\n');
    if (mode === 'login-error') return fail();
    if (!p.clientInfo?.name || p.capabilities?.experimentalApi !== true) return fail();
    return ok({ userAgent: 'fixture' });
  }
  if (method === 'initialized') { initialized = true; return; }
  if (method === 'account/login/start') {
    if (!initialized || p.type !== 'apiKey' || p.apiKey !== 'secret-test-key') return fail();
    if (!process.argv.includes('cli_auth_credentials_store="ephemeral"')) return fail();
    if (existsSync(process.env.CODEX_HOME + '/auth.json')) process.exit(24);
    loggedIn = true;
    return ok({ type: 'apiKey' });
  }
  if (method === 'thread/start') {
    if (!loggedIn || p.approvalPolicy !== 'never' || p.sandbox !== 'read-only' || p.cwd !== process.cwd() || p.ephemeral !== false) return fail();
    thread = 'thread-' + process.pid;
    return ok({ thread: { id: thread } });
  }
  if (method === 'thread/resume') {
    if (p.threadId !== thread || p.sandbox !== 'read-only' || p.approvalPolicy !== 'never') return fail();
    if (mode === 'late-interrupt' && !interruptedFinished) return fail();
    return ok({ thread: { id: thread } });
  }
  if (method === 'turn/start') {
    if (p.threadId !== thread || p.input[0].type !== 'text' || !Array.isArray(p.input[0].text_elements) || p.sandboxPolicy.type !== 'readOnly' || p.sandboxPolicy.networkAccess !== false) return fail();
    const current = 'turn-' + (++turn);
    ok({ turn: { id: current, status: 'inProgress' } });
    send({ method: 'turn/started', params: { threadId: thread, turn: { id: current } } });
    if (mode === 'hang' || mode === 'late-interrupt') return;
    if (mode === 'crash') return process.exit(18);
    if (mode === 'rpc-error') return send({ method: 'turn/completed', params: { threadId: thread, turn: { id: current, status: 'failed', error: { message: 'secret-test-key' } } } });
    if (mode === 'approval') return send({ id: 'approval', method: 'item/commandExecution/requestApproval', params: { threadId: thread, turnId: current } });
    if (mode === 'tool' || mode === 'unknown-tool') return send({ id: 'tool', method: 'item/tool/call', params: { threadId: thread, turnId: current, callId: 'call-1', tool: mode === 'tool' ? 'lookup' : 'unregistered', arguments: { q: 'hello' } } });
    const delta = mode === 'resources' ? JSON.stringify({ home: process.env.CODEX_HOME, pid: process.pid, args: process.argv, keyEnv: process.env.OPENAI_API_KEY }) : p.input[0].text + ':' + p.model;
    send({ method: 'item/agentMessage/delta', params: { threadId: thread, turnId: current, delta } });
    send({ method: 'turn/completed', params: { threadId: thread, turn: { id: current, status: 'completed' } } });
    return;
  }
  if (method === 'turn/interrupt') {
    if (p.turnId !== 'turn-' + turn || p.threadId !== thread) return fail();
    ok();
    const complete = () => {
      interruptedFinished = true;
      send({ method: 'turn/completed', params: { threadId: thread, turn: { id: p.turnId, status: 'interrupted' } } });
    };
    return mode === 'late-interrupt' ? setTimeout(complete, 30) : complete();
  }
  fail();
});
`;

const sessions: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(sessions.splice(0).map(close => close())); });

async function fixture(mode = 'normal', timeoutMs = 1000) {
  const adapter = createCodexApiKeyAdapter({
    apiKey: async (ref: string) => { expect(ref).toBe('secret://codex'); return 'secret-test-key'; },
    executable: process.execPath,
    args: ['-e', serverScript, mode],
    timeoutMs,
  });
  const session = await adapter.createSession({ runtime: 'codex', credentialRef: 'secret://codex', modelRef: 'codex-test', cwd: process.cwd(), ...(mode === 'tool' || mode === 'unknown-tool' ? { tools: [{ name: 'lookup', description: 'Lookup', inputSchema: { type: 'object' } }] } : {}) });
  sessions.push(() => adapter.close(session));
  return { adapter, session };
}

describe('Codex App Server stdio provider', () => {
  it('initializes, logs in with an in-memory key, and sends actual input with independent threads', async () => {
    const first = await fixture();
    const second = await fixture();
    expect(first.session.id).not.toBe(second.session.id);
    await first.adapter.sendInput(first.session, { text: 'first input' });
    const events = await Array.fromAsync(first.adapter.streamEvents(first.session));
    expect(events.map(event => event.type)).toEqual(['session.started', 'text', 'session.completed']);
    expect(events[1]?.payload).toBe('first input:codex-test');
    await first.adapter.sendInput(first.session, { text: 'follow-up' });
    expect(await Array.fromAsync(first.adapter.streamEvents(first.session))).toContainEqual({ type: 'text', payload: 'follow-up:codex-test' });
    expect(JSON.stringify(events)).not.toContain('secret-test-key');
  });

  it('declines server approvals by default and continues reading notifications', async () => {
    const { adapter, session } = await fixture('approval');
    await adapter.sendInput(session, { text: 'approval' });
    expect(await Array.fromAsync(adapter.streamEvents(session))).toContainEqual({ type: 'text', payload: 'approval denied' });
  });

  it('delivers dynamic tools to the caller and returns the actual tool result to App Server', async () => {
    const { adapter, session } = await fixture('tool');
    await adapter.sendInput(session, { text: 'lookup' });
    const iterator = adapter.streamEvents(session)[Symbol.asyncIterator]();
    expect((await iterator.next()).value?.type).toBe('session.started');
    expect((await iterator.next()).value).toEqual({ type: 'tool.requested', payload: { id: 'call-1', name: 'lookup', arguments: { q: 'hello' } } });
    await adapter.sendInput(session, { text: '', toolResults: [{ id: 'call-1', output: 'found' }] });
    expect((await iterator.next()).value).toEqual({ type: 'text', payload: 'found' });
    expect((await iterator.next()).value?.type).toBe('session.completed');
    await iterator.return?.();
  });

  it('interrupts a turn, resumes its real thread, and rejects foreign checkpoints', async () => {
    const { adapter, session } = await fixture('hang');
    await adapter.sendInput(session, { text: 'pause me' });
    const checkpoint = await adapter.pause(session);
    await expect(adapter.resume(session, { id: 'foreign' })).rejects.toThrow('CHECKPOINT_NOT_FOUND');
    await adapter.resume(session, checkpoint);
    await adapter.sendInput(session, { text: 'continue' });
    await adapter.cancel(session);
    await expect(adapter.sendInput(session, { text: 'closed' })).rejects.toThrow('RUNTIME_ADAPTER_UNAVAILABLE');
  });

  it('waits for interrupt completion before resuming a paused thread', async () => {
    const { adapter, session } = await fixture('late-interrupt');
    await adapter.sendInput(session, { text: 'pause' });
    const checkpoint = await adapter.pause(session);
    await adapter.resume(session, checkpoint);
  });

  it('explicitly rejects a checkpoint before the first turn can materialize a rollout', async () => {
    const { adapter, session } = await fixture();
    await expect(adapter.pause(session)).rejects.toThrow('unsupported');
  });

  it('honors cancellation while App Server initialization is still pending', async () => {
    const controller = new AbortController();
    const adapter = createCodexApiKeyAdapter({ apiKey: 'secret-test-key', executable: process.execPath, args: ['-e', serverScript, 'timeout'], timeoutMs: 200 });
    const pending = adapter.createSession({ runtime: 'codex', credentialRef: 'secret://codex', signal: controller.signal });
    const rejection = expect(pending).rejects.toThrow('aborted');
    controller.abort();
    await rejection;
  });

  it.each(['exit', 'timeout', 'malformed', 'login-error'])('rejects %s during initialization and cleans the child up', async (mode) => {
    await expect(fixture(mode, 150)).rejects.toThrow('RUNTIME_ADAPTER_UNAVAILABLE');
  });

  it.each(['crash', 'rpc-error', 'hang'])('terminates the event stream on %s without leaking secrets', async (mode) => {
    const { adapter, session } = await fixture(mode, 200);
    await adapter.sendInput(session, { text: 'test failure' });
    const error = await Array.fromAsync(adapter.streamEvents(session)).catch(error => error);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain('RUNTIME_ADAPTER_UNAVAILABLE');
    expect(error.message).not.toContain('secret-test-key');
  });

  it('aborts an in-flight turn and ends readers without waiting for the request timeout', async () => {
    const { adapter, session } = await fixture('hang');
    const controller = new AbortController();
    await adapter.sendInput(session, { text: 'cancel', signal: controller.signal });
    const stream = Array.fromAsync(adapter.streamEvents(session));
    controller.abort();
    await expect(stream).rejects.toThrow('RUNTIME_ADAPTER_UNAVAILABLE');
  });

  it('rejects unregistered dynamic tools instead of forwarding unauthorized capabilities', async () => {
    const { adapter, session } = await fixture('unknown-tool', 200);
    await adapter.sendInput(session, { text: 'tool' });
    expect((await Array.fromAsync(adapter.streamEvents(session))).some(event => event.type === 'tool.requested')).toBe(false);
  });

  it('detaches a completed input signal so it cannot cancel a subsequent turn', async () => {
    const { adapter, session } = await fixture();
    const controller = new AbortController();
    await adapter.sendInput(session, { text: 'one', signal: controller.signal });
    await Array.fromAsync(adapter.streamEvents(session));
    controller.abort();
    await adapter.sendInput(session, { text: 'two' });
    expect(await Array.fromAsync(adapter.streamEvents(session))).toContainEqual({ type: 'text', payload: 'two:codex-test' });
  });

  it('reaps the child and removes its temporary home on close without passing a key in argv or env', async () => {
    const { adapter, session } = await fixture('resources');
    await adapter.sendInput(session, { text: 'resources' });
    const events = await Array.fromAsync(adapter.streamEvents(session));
    const resources = JSON.parse(events.find(event => event.type === 'text')!.payload as string) as { home: string; pid: number; args: string[]; keyEnv?: string };
    expect(resources.keyEnv).toBeUndefined();
    expect(resources.args.join(' ')).not.toContain('secret-test-key');
    expect((await stat(resources.home)).isDirectory()).toBe(true);
    await adapter.close(session);
    await expect(stat(resources.home)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(() => process.kill(resources.pid, 0)).toThrow();
    await adapter.close(session);
  });

  it.runIf(process.env.TITAN_CODEX_BINARY)('accepts ephemeral API-key login in the actual installed Codex without creating credential files', async () => {
    const home = await mkdtemp(join(tmpdir(), 'titan-codex-probe-'));
    const child = spawn(process.env.TITAN_CODEX_BINARY!, ['app-server', '--listen', 'stdio://', '-c', 'cli_auth_credentials_store="ephemeral"'], { env: { PATH: process.env.PATH, HOME: process.env.HOME, CODEX_HOME: home }, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stderr.resume();
    let nextId = 0;
    const pending = new Map<number, (message: any) => void>();
    const lines = createInterface({ input: child.stdout });
    lines.on('line', line => {
      const message = JSON.parse(line);
      if (typeof message.id === 'number') pending.get(message.id)?.(message);
    });
    const request = (method: string, params: unknown) => new Promise<any>((resolve, reject) => {
      const id = ++nextId;
      const timeout = setTimeout(() => reject(new Error(`${method} timed out`)), 3000);
      pending.set(id, message => { clearTimeout(timeout); pending.delete(id); resolve(message); });
      child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    });
    try {
      expect(await request('initialize', { clientInfo: { name: 'titan-test', version: '0.1.0' }, capabilities: { experimentalApi: true } })).toHaveProperty('result');
      child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
      expect(await request('account/login/start', { type: 'apiKey', apiKey: 'sk-titan-not-a-real-key' })).toMatchObject({ result: { type: 'apiKey' } });
      const started = await request('thread/start', { cwd: process.cwd(), sandbox: 'read-only', approvalPolicy: 'never', ephemeral: false });
      expect(started).toHaveProperty('result.thread.id');
      expect(await request('thread/inject_items', { threadId: started.result.thread.id, items: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'local protocol probe without inference' }] }] })).toHaveProperty('result');
      expect(await request('thread/resume', { threadId: started.result.thread.id, cwd: process.cwd(), sandbox: 'read-only', approvalPolicy: 'never' })).toMatchObject({ result: { thread: { id: started.result.thread.id } } });
      const files = await readdir(home, { recursive: true, withFileTypes: true });
      expect(files.some(file => file.name === 'auth.json')).toBe(false);
      for (const file of files.filter(file => file.isFile())) {
        expect((await readFile(join(file.parentPath, file.name))).includes(Buffer.from('sk-titan-not-a-real-key'))).toBe(false);
      }
    } finally {
      lines.close();
      const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
      child.kill('SIGTERM');
      await closed;
      await rm(home, { recursive: true, force: true });
    }
  });
});
