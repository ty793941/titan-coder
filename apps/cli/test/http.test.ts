import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import { ApiClient } from '../src/client.js';
import { runCli } from '../src/main.js';

const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

async function serve(handler: (request: IncomingMessage, response: ServerResponse) => void) {
  const server = createServer(handler);
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

describe('CLI HTTP contract', () => {
  it('uses the local daemon token for authenticated daemon requests without printing it', async () => {
    const previous = process.env.TITAN_DAEMON_TOKEN;
    process.env.TITAN_DAEMON_TOKEN = 'test-device-token';
    const seen: Array<string | undefined> = [];
    const base = await serve((req, res) => { seen.push(req.headers.authorization); res.end('{"status":"ready"}'); });
    try {
      const result = await runCli(['daemon', 'heartbeat', 'daemon_1', '--base-url', base, '--json']);
      await runCli(['task', 'get', 'task_1', '--base-url', base]);
      expect(seen).toEqual(['Bearer test-device-token', undefined]);
      expect(result.stdout).not.toContain('test-device-token');
    } finally {
      if (previous === undefined) delete process.env.TITAN_DAEMON_TOKEN;
      else process.env.TITAN_DAEMON_TOKEN = previous;
    }
  });

  it('posts tasks to the task collection and preserves kebab-case idempotency flags', async () => {
    let observed: unknown;
    const base = await serve(async (req, res) => {
      let body = '';
      for await (const chunk of req) body += chunk;
      observed = { path: req.url, method: req.method, key: req.headers['idempotency-key'], body: JSON.parse(body) };
      res.end('{"id":"task_1"}');
    });
    const result = await runCli(['task', 'create', '--base-url', base, '--project', 'project_1', '--title', 'title', '--goal', 'goal', '--idempotency-key', 'key-1', '--json']);
    expect(result.exitCode).toBe(0);
    expect(observed).toEqual({ path: '/api/projects/project_1/tasks', method: 'POST', key: 'key-1', body: { title: 'title', goal: 'goal', acceptanceCriteria: ['goal'], priority: 'medium' } });
  });

  it('maps session and daemon flags into API fields', async () => {
    const seen: Array<{ path: string | undefined; body: unknown }> = [];
    const base = await serve(async (req, res) => {
      let body = '';
      for await (const chunk of req) body += chunk;
      seen.push({ path: req.url, body: JSON.parse(body) });
      res.end('{}');
    });
    await runCli(['session', 'create', 'task_1', '--goal', 'goal', '--plan-hash', 'hash', '--idempotency-key', 'session-key', '--base-url', base]);
    await runCli(['daemon', 'register', '--workspace-root', '/tmp/worker', '--max-concurrent-sessions', '3', '--daemon-version', '2.0', '--base-url', base]);
    expect(seen[0]).toEqual({ path: '/api/tasks/task_1/sessions', body: { entryAgent: 'project-manager', goal: 'goal', planHash: 'hash', idempotencyKey: 'session-key' } });
    expect(seen[1]?.body).toMatchObject({ workspaceRoots: ['/tmp/worker'], maxConcurrentSessions: 3, daemonVersion: '2.0' });
  });

  it.each([
    [['task', 'get', 'task_1'], 'GET', '/api/tasks/task_1'],
    [['session', 'get', 'session_1'], 'GET', '/api/sessions/session_1'],
    [['run', 'create', 'session_1', '--idempotency-key', 'run-key'], 'POST', '/api/sessions/session_1/runs'],
    [['run', 'cancel', 'run_1'], 'POST', '/api/runs/run_1/cancel'],
    [['daemon', 'heartbeat', 'daemon_1'], 'POST', '/api/daemons/daemon_1/heartbeat'],
  ])('sends %j to the existing API', async (args, method, path) => {
    let seen: unknown;
    const base = await serve(async (req, res) => {
      let body = '';
      for await (const chunk of req) body += chunk;
      seen = { method: req.method, path: req.url, body, key: req.headers['idempotency-key'] };
      res.statusCode = args[1] === 'cancel' ? 204 : 200;
      res.end('{}');
    });
    const result = await runCli([...args, '--base-url', base, '--json']);
    expect(result.exitCode).toBe(0);
    expect(seen).toMatchObject({ method, path });
    if (args[1] === 'create') expect(seen).toMatchObject({ body: '{"idempotencyKey":"run-key"}', key: 'run-key' });
    expect(typeof result.stdout).toBe('string');
  });

  it('handles 204 without parsing an absent body and rejects malformed successful JSON', async () => {
    const base = await serve((req, res) => {
      res.statusCode = req.url === '/empty' ? 204 : 200;
      res.end('invalid');
    });
    const client = new ApiClient(base);
    await expect(client.request('/empty')).resolves.toBeUndefined();
    await expect(client.request('/invalid')).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });

  it('provides help without an API connection', async () => {
    const result = await runCli(['--help']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('run create');
    expect(result.stdout).toContain('--follow');
  });

  it('sets the actual executable process exit code', async () => {
    const base = await serve((_req, res) => {
      res.statusCode = 404;
      res.end('{"code":"RESOURCE_NOT_FOUND","message":"missing"}');
    });
    const child = spawn(process.execPath, ['dist/main.js', 'task', 'get', 'missing', '--base-url', base, '--json'], { cwd: import.meta.dirname + '/..' });
    let output = '';
    child.stdout.on('data', data => { output += data; });
    const [code] = await once(child, 'close');
    expect(code).toBe(2);
    expect(JSON.parse(output)).toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
  });
});

describe('incremental SSE', () => {
  it('parses separate CRLF and CR frames, UTF-8 fragments, and multiline data without losing leading spaces', async () => {
    const base = await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const bytes = Buffer.from(': ping\r\n\r\nid: 1\r\ndata: 中文\r\ndata:  indented\r\n\r\nid: 2\rdata: second\r\rdata: incomplete');
      let index = 0;
      const send = () => {
        if (index === bytes.length) { res.end(); return; }
        res.write(bytes.subarray(index, ++index));
        setImmediate(send);
      };
      send();
    });
    expect(await new ApiClient(base).stream('/events')).toEqual([
      { id: '1', data: '中文\n indented' },
      { id: '2', data: 'second' },
    ]);
  });

  it('parses fragmented CRLF frames and keeps the envelope eventId', async () => {
    const base = await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(': heartbeat\r');
      setTimeout(() => {
        res.write('\n\r\nid: 2\r\nevent: run.completed\r\ndata: {"eventId":"evt_original",\r');
        setTimeout(() => res.end('\ndata: "sequence":2}\r\n\r\n'), 5);
      }, 5);
    });
    const result = await runCli(['run', 'events', 'run_1', '--base-url', base, '--json']);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([{ eventId: 'evt_original', sequence: 2, eventType: 'run.completed' }]);
  });

  it('flushes follow events before connection closure and abort closes the socket', async () => {
    let closed = false;
    const base = await serve((_req, res) => {
      res.on('close', () => { closed = true; });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('id: 1\ndata: {"eventId":"evt_1","sequence":1}\n\n');
    });
    const controller = new AbortController();
    const output: string[] = [];
    const pending = runCli(['run', 'events', 'run_1', '--follow', '--base-url', base, '--json'], {
      signal: controller.signal,
      write: text => { output.push(text); controller.abort(); },
    });
    const result = await pending;
    expect(result.exitCode).toBe(0);
    expect(output.map(line => JSON.parse(line))).toEqual([{ eventId: 'evt_1', sequence: 1 }]);
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(closed).toBe(true);
  });

  it('reconnects with Last-Event-ID and backfills a gap without duplicating events', async () => {
    const requests: Array<{ path: string | undefined; cursor: string | string[] | undefined }> = [];
    const base = await serve((req, res) => {
      requests.push({ path: req.url, cursor: req.headers['last-event-id'] });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      if (requests.length === 1) res.end('id: 1\ndata: {"eventId":"evt_1","sequence":1}\n\n');
      else if (req.url?.includes('follow=true')) res.write('id: 3\ndata: {"eventId":"evt_3","sequence":3}\n\n');
      else res.end('id: 2\ndata: {"eventId":"evt_2","sequence":2}\n\nid: 3\ndata: {"eventId":"evt_3","sequence":3}\n\n');
    });
    const controller = new AbortController();
    const output: string[] = [];
    const result = await runCli(['run', 'events', 'run_1', '--follow', '--base-url', base, '--json'], {
      signal: controller.signal,
      reconnectDelayMs: 1,
      write: text => { output.push(text); if (output.length === 3) controller.abort(); },
    });
    expect(result.exitCode).toBe(0);
    expect(output.map(line => JSON.parse(line).sequence)).toEqual([1, 2, 3]);
    expect(requests).toEqual([
      { path: '/api/runs/run_1/events?follow=true', cursor: undefined },
      { path: '/api/runs/run_1/events?follow=true', cursor: '1' },
      { path: '/api/runs/run_1/events', cursor: '1' },
    ]);
  });

  it('bounds retries when the stream keeps closing', async () => {
    let count = 0;
    const base = await serve((_req, res) => { count += 1; res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(); });
    const result = await runCli(['run', 'events', 'run_1', '--follow', '--base-url', base], { maxReconnects: 2, reconnectDelayMs: 1 });
    expect(result.exitCode).toBe(1);
    expect(count).toBe(3);
    expect(result.stdout).toContain('SSE_RECONNECT_EXHAUSTED');
  });

  it('resumes after an interrupted socket and ignores an already emitted sequence', async () => {
    const cursors: Array<string | string[] | undefined> = [];
    const base = await serve((req, res) => {
      cursors.push(req.headers['last-event-id']);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('id: 1\ndata: {"eventId":"evt_1","sequence":1}\n\n');
      if (cursors.length === 1) setTimeout(() => res.destroy(), 15);
      else res.write('id: 2\ndata: {"eventId":"evt_2","sequence":2}\n\n');
    });
    const controller = new AbortController();
    const output: string[] = [];
    const result = await runCli(['run', 'events', 'run_1', '--follow', '--base-url', base], {
      signal: controller.signal, reconnectDelayMs: 1,
      write: text => { output.push(text); if (output.length === 2) controller.abort(); },
    });
    expect(result.exitCode).toBe(0);
    expect(cursors).toEqual([undefined, '1']);
    expect(output.map(line => JSON.parse(line).sequence)).toEqual([1, 2]);
  });

  it('does not retry permanent API failures', async () => {
    let count = 0;
    const base = await serve((_req, res) => {
      count += 1;
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{"code":"RESOURCE_NOT_FOUND","message":"missing"}');
    });
    const result = await runCli(['run', 'events', 'missing', '--follow', '--base-url', base, '--json'], { reconnectDelayMs: 1 });
    expect(result.exitCode).toBe(2);
    expect(count).toBe(1);
  });

  it('reports an unrecoverable replay gap instead of printing later events', async () => {
    const paths: Array<string | undefined> = [];
    const base = await serve((req, res) => {
      paths.push(req.url);
      if (req.url?.includes('follow=true')) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('id: 3\ndata: {"eventId":"evt_3","sequence":3}\n\n');
      } else {
        res.writeHead(409, { 'content-type': 'application/json' });
        res.end('{"code":"EVENT_SEQUENCE_GAP","message":"missing sequence 1"}');
      }
    });
    const output: string[] = [];
    const result = await runCli(['run', 'events', 'run_1', '--follow', '--base-url', base, '--json'], { write: text => { output.push(text); }, reconnectDelayMs: 1 });
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('EVENT_SEQUENCE_GAP');
    expect(output).toEqual([]);
    expect(paths).toEqual(['/api/runs/run_1/events?follow=true', '/api/runs/run_1/events']);
  });

  it('aborts during reconnect backoff without sending another request', async () => {
    const controller = new AbortController();
    let count = 0;
    const base = await serve((_req, res) => {
      count += 1;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end();
      setTimeout(() => controller.abort(), 20);
    });
    const result = await runCli(['run', 'events', 'run_1', '--follow', '--base-url', base], { signal: controller.signal, reconnectDelayMs: 5000 });
    expect(result.exitCode).toBe(0);
    expect(count).toBe(1);
  });

  it('retries an SSE database error with the last emitted sequence', async () => {
    const cursors: Array<string | string[] | undefined> = [];
    const base = await serve((req, res) => {
      cursors.push(req.headers['last-event-id']);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      if (cursors.length === 1) res.end('id: 1\ndata: {"eventId":"evt_1","sequence":1}\n\nevent: stream.error\ndata: {"code":"INTERNAL_ERROR","message":"unavailable","retryable":true}\n\n');
      else res.write('id: 2\ndata: {"eventId":"evt_2","sequence":2}\n\n');
    });
    const controller = new AbortController();
    const output: string[] = [];
    const result = await runCli(['run', 'events', 'run_1', '--follow', '--base-url', base], {
      signal: controller.signal, reconnectDelayMs: 1,
      write: text => { output.push(text); if (output.length === 2) controller.abort(); },
    });
    expect(result.exitCode).toBe(0);
    expect(cursors).toEqual([undefined, '1']);
    expect(output.map(line => JSON.parse(line).sequence)).toEqual([1, 2]);
  });

  it('honors SIGINT in an actual follow process and closes its connection', async () => {
    let close: (() => void) | undefined;
    const closed = new Promise<void>(resolve => { close = resolve; });
    const base = await serve((_req, res) => {
      res.on('close', () => close?.());
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('id: 1\ndata: {"eventId":"evt_1","sequence":1}\n\n');
    });
    const child = spawn(process.execPath, ['dist/main.js', 'run', 'events', 'run_1', '--follow', '--base-url', base, '--json'], { cwd: import.meta.dirname + '/..' });
    const exited = once(child, 'close');
    await once(child.stdout, 'data');
    child.kill('SIGINT');
    const [code] = await exited;
    expect(code).toBe(0);
    await closed;
  });
});
