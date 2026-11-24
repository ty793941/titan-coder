import { PassThrough, Readable, Writable } from 'node:stream';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentRunResult } from '@titan/agent-core';
import type { RunDispatch, RunProgress } from '@titan/daemon-protocol';

const MAX_BOOTSTRAP_BYTES = 2 * 1024 * 1024;

function dispatch(): RunDispatch {
  return {
    jobId: 'job-1', runId: 'run-1', sessionId: 'session-1', taskId: 'task-1', projectId: 'project-1',
    goal: 'produce evidence', planHash: 'plan-1', claimToken: 'claim-1',
    config: {
      daemonId: 'daemon-1', runtime: 'codex', credentialRef: 'broker://key', baseUrlRef: 'broker://url',
      workspacePath: '/workspace/session', allowedTools: ['artifact.write'], maxTurns: 2, timeoutMs: 5000,
    },
  };
}

function bootstrap() {
  return { version: 1, dispatch: dispatch(), credentials: { 'broker://key': 'fixture-value', 'broker://url': 'https://fixture.example/v1' } };
}

function outputSink() {
  let text = '';
  const output = new Writable({ write(chunk, _encoding, callback) { text += chunk.toString(); callback(); } });
  return { output, text: () => text, frames: () => text.trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) };
}

async function runner(): Promise<typeof import('../src/container-worker.js').runContainerWorker> {
  const module = await import('../src/container-worker.js');
  expect(module.runContainerWorker).toBeTypeOf('function');
  return module.runContainerWorker;
}

function result(status: AgentRunResult['status'] = 'satisfied'): AgentRunResult {
  return { status, evidence: [], replayedToolUseIds: [] };
}

describe('container worker bootstrap', () => {
  afterEach(() => { delete process.env.TITAN_CONTAINER_TEST_KEY; });

  it('executes one chunked bootstrap with scoped memory credentials and emits ordered frames', async () => {
    const run = await runner();
    const sink = outputSink();
    const frame = `${JSON.stringify(bootstrap())}\n`;
    let calls = 0;
    const progress: RunProgress = { eventId: 'event-1', sequence: 1, claimToken: 'claim-1', type: 'running', payload: { status: 'running' } };
    await run({ input: Readable.from([frame.slice(0, 7), frame.slice(7)]), output: sink.output, execute: async (received, dependencies) => {
      calls++;
      expect(received).toEqual(dispatch());
      expect(await dependencies!.credentialResolver!('broker://key')).toBe('fixture-value');
      expect(await dependencies!.credentialResolver!('broker://url')).toBe('https://fixture.example/v1');
      expect(await dependencies!.credentialResolver!('toString')).toBeUndefined();
      expect(dependencies!.signal).toBeInstanceOf(AbortSignal);
      dependencies!.sendProgress!(progress);
      return result();
    } });
    expect(calls).toBe(1);
    expect(sink.frames()).toEqual([
      { version: 1, type: 'progress', progress },
      { version: 1, type: 'result', status: 'satisfied' },
    ]);
  });

  it('does not resolve an absent mapped credential from the environment', async () => {
    const run = await runner();
    process.env.TITAN_CONTAINER_TEST_KEY = 'must-not-use-env';
    const body = bootstrap();
    body.dispatch.config.credentialRef = 'env://TITAN_CONTAINER_TEST_KEY';
    body.credentials = {} as typeof body.credentials;
    const sink = outputSink();
    await run({ input: Readable.from([`${JSON.stringify(body)}\n`]), output: sink.output });
    expect(sink.frames().at(-1)).toEqual({ version: 1, type: 'result', status: 'waiting_input' });
    expect(sink.text()).not.toContain('must-not-use-env');
  });

  it('keeps execution alive after bootstrap EOF', async () => {
    const run = await runner();
    const sink = outputSink();
    await run({ input: Readable.from([`${JSON.stringify(bootstrap())}\n`]), output: sink.output, execute: async (_dispatch, dependencies) => {
      await new Promise(resolve => setImmediate(resolve));
      expect(dependencies!.signal!.aborted).toBe(false);
      return result();
    } });
    expect(sink.frames().at(-1)?.status).toBe('satisfied');
  });

  it('aborts the active dispatch on SIGTERM and removes its signal listener', async () => {
    const run = await runner();
    const sink = outputSink();
    const listeners = process.listenerCount('SIGTERM');
    await run({ input: Readable.from([`${JSON.stringify(bootstrap())}\n`]), output: sink.output, execute: async (_dispatch, dependencies) => {
      const signal = dependencies!.signal!;
      const aborted = new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
      process.emit('SIGTERM');
      await aborted;
      return result('cancelled');
    } });
    expect(sink.frames().at(-1)).toEqual({ version: 1, type: 'result', status: 'cancelled' });
    expect(process.listenerCount('SIGTERM')).toBe(listeners);
  });

  it.each([
    ['empty', ''],
    ['invalid JSON', '{fixture-value\n'],
    ['missing newline', JSON.stringify(bootstrap())],
    ['second frame', `${JSON.stringify(bootstrap())}\n${JSON.stringify(bootstrap())}\n`],
    ['blank second frame', `${JSON.stringify(bootstrap())}\n\n`],
    ['wrong version', `${JSON.stringify({ ...bootstrap(), version: 2 })}\n`],
    ['missing dispatch', '{"version":1,"credentials":{}}\n'],
    ['invalid dispatch', `${JSON.stringify({ ...bootstrap(), dispatch: { ...dispatch(), config: { ...dispatch().config, timeoutMs: 0 } } })}\n`],
    ['extra credential', `${JSON.stringify({ ...bootstrap(), credentials: { ...bootstrap().credentials, 'broker://other': 'fixture-value' } })}\n`],
    ['non-string credential', `${JSON.stringify({ ...bootstrap(), credentials: { 'broker://key': 123 } })}\n`],
    ['unknown bootstrap field', `${JSON.stringify({ ...bootstrap(), extra: 'fixture-value' })}\n`],
    ['oversized', 'x'.repeat(MAX_BOOTSTRAP_BYTES + 1)],
  ])('rejects %s before calling the runtime and emits only a fixed safe failure', async (_name, input) => {
    const run = await runner();
    const sink = outputSink();
    let called = false;
    await run({ input: Readable.from([input]), output: sink.output, execute: async () => { called = true; return result(); } });
    expect(called).toBe(false);
    expect(sink.frames()).toEqual([{ version: 1, type: 'result', status: 'failed' }]);
  });

  it('uses byte limits for multibyte input split across chunks', async () => {
    const run = await runner();
    const sink = outputSink();
    const input = new PassThrough();
    const running = run({ input, output: sink.output, execute: async () => { throw new Error('must not execute'); } });
    input.end(Buffer.from('中'.repeat(Math.ceil(MAX_BOOTSTRAP_BYTES / 3))));
    await running;
    expect(sink.frames()).toEqual([{ version: 1, type: 'result', status: 'failed' }]);
  });

  it('never serializes thrown runtime diagnostics or returns a raw error', async () => {
    const run = await runner();
    const sink = outputSink();
    await run({ input: Readable.from([`${JSON.stringify(bootstrap())}\n`]), output: sink.output, execute: async () => {
      throw new Error('fixture-value https://fixture.example/v1 private-stack');
    } });
    expect(sink.frames()).toEqual([{ version: 1, type: 'result', status: 'failed' }]);
  });

  it('accepts a bootstrap exactly at the byte limit', async () => {
    const run = await runner();
    const body = bootstrap();
    body.credentials['broker://key'] = '';
    const size = Buffer.byteLength(`${JSON.stringify(body)}\n`);
    body.credentials['broker://key'] = 'x'.repeat(MAX_BOOTSTRAP_BYTES - size);
    const frame = `${JSON.stringify(body)}\n`;
    expect(Buffer.byteLength(frame)).toBe(MAX_BOOTSTRAP_BYTES);
    const sink = outputSink();
    await run({ input: Readable.from([frame]), output: sink.output, execute: async () => result() });
    expect(sink.frames().at(-1)?.status).toBe('satisfied');
  });

  it('rejects malformed UTF-8 without executing a repaired JSON document', async () => {
    const run = await runner();
    const body = Buffer.from(`${JSON.stringify(bootstrap())}\n`);
    body[body.indexOf('fixture-value')] = 0xff;
    const sink = outputSink();
    let called = false;
    await run({ input: Readable.from([body]), output: sink.output, execute: async () => { called = true; return result(); } });
    expect(called).toBe(false);
    expect(sink.frames().at(-1)?.status).toBe('failed');
  });

  it('cancels SIGTERM while waiting for bootstrap EOF without calling execute', async () => {
    const run = await runner();
    const input = new PassThrough();
    const sink = outputSink();
    let called = false;
    const running = run({ input, output: sink.output, execute: async () => { called = true; return result(); } });
    input.write(`${JSON.stringify(bootstrap())}\n`);
    process.emit('SIGTERM');
    await running;
    expect(called).toBe(false);
    expect(sink.frames()).toEqual([{ version: 1, type: 'result', status: 'cancelled' }]);
  });

  it('handles a broken output stream without leaking diagnostics or retaining listeners', async () => {
    const run = await runner();
    const output = new Writable({ write(_chunk, _encoding, callback) { callback(new Error('fixture-value private-output-error')); } });
    const listeners = process.listenerCount('SIGTERM');
    let aborted = false;
    const status = await run({ input: Readable.from([`${JSON.stringify(bootstrap())}\n`]), output, execute: async (received, dependencies) => {
      dependencies!.sendProgress!({ eventId: 'event-1', sequence: 1, claimToken: received.claimToken, type: 'running', payload: {} });
      await new Promise<void>(resolve => dependencies!.signal!.addEventListener('abort', () => { aborted = true; resolve(); }, { once: true }));
      return result('cancelled');
    } });
    expect(status).toBe('failed');
    expect(aborted).toBe(true);
    expect(process.listenerCount('SIGTERM')).toBe(listeners);
  });

  it('flushes ordered progress before the result on a slow writable', async () => {
    const run = await runner();
    const chunks: string[] = [];
    const output = new Writable({ highWaterMark: 1, write(chunk, _encoding, callback) {
      setImmediate(() => { chunks.push(chunk.toString()); callback(); });
    } });
    await run({ input: Readable.from([`${JSON.stringify(bootstrap())}\n`]), output, execute: async (received, dependencies) => {
      for (let sequence = 1; sequence <= 3; sequence++) dependencies!.sendProgress!({ eventId: `event-${sequence}`, sequence, claimToken: received.claimToken, type: 'output', payload: { text: `${sequence}` } });
      return result();
    } });
    expect(chunks.map(chunk => JSON.parse(chunk).type)).toEqual(['progress', 'progress', 'progress', 'result']);
    expect(chunks.slice(0, 3).map(chunk => JSON.parse(chunk).progress.sequence)).toEqual([1, 2, 3]);
  });

  it('prints fixed diagnostics for a returned failed progress frame', async () => {
    const run = await runner();
    const sink = outputSink();
    await run({ input: Readable.from([`${JSON.stringify(bootstrap())}\n`]), output: sink.output, execute: async (received, dependencies) => {
      dependencies!.sendProgress!({ eventId: 'event-1', sequence: 1, claimToken: received.claimToken, type: 'failed', payload: { message: 'private-stack fixture-value' } });
      return result('failed');
    } });
    expect(sink.frames()).toEqual([
      { version: 1, type: 'progress', progress: { eventId: 'event-1', sequence: 1, claimToken: 'claim-1', type: 'failed', payload: { code: 'CONTAINER_RUNTIME_FAILED', message: 'Container runtime failed' } } },
      { version: 1, type: 'result', status: 'failed' },
    ]);
  });

  it.each([false, true])('runs the compiled direct entry (invalid=%s) without exposing stderr diagnostics', async invalid => {
    const entry = fileURLToPath(new URL('../dist/container-worker.js', import.meta.url));
    const child = spawn(process.execPath, [entry], { stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: process.env.PATH ?? '' } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    const closed = new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    child.stdin.end(invalid ? '{private-stack\n' : `${JSON.stringify({ ...bootstrap(), credentials: {} })}\n`);
    expect(await closed).toBe(invalid ? 1 : 0);
    expect(stderr).toBe('');
    expect(JSON.parse(stdout.trim().split('\n').at(-1)!)).toEqual({ version: 1, type: 'result', status: invalid ? 'failed' : 'waiting_input' });
  });
});
