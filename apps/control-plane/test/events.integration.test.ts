import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../dist/main.js';
import { DatabaseService } from '../dist/database/database.service.js';
import { EventsService } from '../dist/modules/events/events.service.js';

const schema = `events_test_${randomUUID().replaceAll('-', '')}`;
const originalUrl = process.env.DATABASE_URL;
const admin = new Pool({ connectionString: originalUrl ?? 'postgresql://titan:titan@127.0.0.1:55432/titan' });
let app: Awaited<ReturnType<typeof createApp>>;
let db: DatabaseService['db'];
let events: EventsService;
let base: string;
let schemaCreated = false;
const controllers: AbortController[] = [];

beforeAll(async () => {
  await admin.query(`CREATE SCHEMA ${schema}`);
  schemaCreated = true;
  const url = new URL(originalUrl ?? 'postgresql://titan:titan@127.0.0.1:55432/titan');
  url.searchParams.set('options', `-c search_path=${schema}`);
  process.env.DATABASE_URL = url.toString();
  const client = await admin.connect();
  try {
    await client.query(`SET search_path TO ${schema}`);
    for (const file of ['schema.sql', 'init-data.sql']) await client.query(await readFile(new URL(`../../../database/${file}`, import.meta.url), 'utf8'));
  } finally { client.release(); }
  app = await createApp();
  db = app.get(DatabaseService).db;
  events = app.get(EventsService);
  await app.listen(0, '127.0.0.1');
  base = await app.getUrl();
}, 15000);

afterEach(async () => {
  for (const controller of controllers.splice(0)) controller.abort();
  await new Promise(resolve => setTimeout(resolve, 30));
  vi.restoreAllMocks();
});

afterAll(async () => {
  try {
    await app?.close();
    if (schemaCreated) await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  } finally {
    await admin.end();
    if (originalUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalUrl;
  }
});

async function newRun() {
  const sessionId = `session_${randomUUID()}`;
  const runId = `run_${randomUUID()}`;
  await db.insertInto('session').values({ id: sessionId, task_id: 'task_dev', entry_agent: 'project-manager', status: 'running', plan_hash: null, version: 1, created_at: new Date() }).execute();
  await db.insertInto('run').values({ id: runId, session_id: sessionId, attempt: 1, status: 'running', checkpoint_id: null, error_code: null, version: 1, created_at: new Date() }).execute();
  return { runId, sessionId };
}

async function append(run: Awaited<ReturnType<typeof newRun>>) {
  return db.transaction().execute(trx => events.append(trx, { eventType: 'run.output', projectId: 'project_dev', taskId: 'task_dev', sessionId: run.sessionId, runId: run.runId, actor: { type: 'system', id: 'events-test' }, payload: { text: 'output' } }));
}

async function follow(runId: string) {
  const controller = new AbortController();
  controllers.push(controller);
  const response = await fetch(`${base}/api/runs/${runId}/events?follow=true`, { signal: controller.signal });
  return { controller, response, reader: response.body!.getReader() };
}

async function waitFor(check: () => boolean, timeout = 2500) {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error('condition timeout');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

describe('event persistence', () => {
  it('serializes concurrent appends into unique contiguous numeric sequences', async () => {
    const run = await newRun();
    const results = await Promise.allSettled(Array.from({ length: 12 }, () => append(run)));
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(0);
    const replay = await events.listForRun(run.runId);
    expect(replay.map(event => event.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect((await events.listForTask('task_dev')).every(event => typeof event.sequence === 'number')).toBe(true);
  });

  it('reports a missing internal sequence instead of silently replaying past it', async () => {
    const run = await newRun();
    await append(run);
    const second = await append(run);
    await db.updateTable('event').set({ sequence: 3 }).where('event_id', '=', second.eventId).execute();
    await expect(events.listForRun(run.runId, 0)).rejects.toMatchObject({ code: 'EVENT_SEQUENCE_GAP' });
    await expect(events.listForRun(run.runId, 1)).rejects.toMatchObject({ code: 'EVENT_SEQUENCE_GAP' });
    await expect(events.listForRun(run.runId, 3)).resolves.toEqual([]);
  });

  it('returns 404 for an absent run', async () => {
    const response = await fetch(`${base}/api/runs/run_missing/events`);
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
  });

  it('replays after a valid numeric cursor and rejects a cursor ahead of the stream', async () => {
    const run = await newRun();
    await append(run);
    await append(run);
    const replay = await fetch(`${base}/api/runs/${run.runId}/events`, { headers: { 'Last-Event-ID': '1' } });
    expect(replay.status).toBe(200);
    const text = await replay.text();
    expect(text).toContain('id: 2\n');
    expect(text).toContain('"sequence":2');
    expect(text).not.toContain('id: 1\n');
    const ahead = await fetch(`${base}/api/runs/${run.runId}/events`, { headers: { 'Last-Event-ID': '3' } });
    expect(ahead.status).toBe(409);
    expect(await ahead.json()).toMatchObject({ code: 'EVENT_SEQUENCE_GAP' });
  });

  it.each(['-1', '1.5', 'NaN', 'Infinity', '9007199254740992', '1e2', ''])('rejects invalid cursor %j', async cursor => {
    const run = await newRun();
    const response = await fetch(`${base}/api/runs/${run.runId}/events`, { headers: { 'Last-Event-ID': cursor } });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});

describe('live SSE lifecycle', () => {
  it('delivers events appended after subscription and stops polling after abort', async () => {
    const run = await newRun();
    const spy = vi.spyOn(events, 'listForRun');
    const { reader, response, controller } = await follow(run.runId);
    expect(response.status).toBe(200);
    const event = await append(run);
    let text = '';
    while (!text.includes('data:')) text += new TextDecoder().decode((await reader.read()).value);
    expect(text).toContain(`"eventId":"${event.eventId}"`);
    expect(text).toContain('"sequence":1');
    controller.abort();
    await reader.cancel().catch(() => undefined);
    await new Promise(resolve => setTimeout(resolve, 350));
    const calls = spy.mock.calls.length;
    await new Promise(resolve => setTimeout(resolve, 350));
    expect(spy.mock.calls.length).toBe(calls);
  }, 5000);

  it('contains polling database failures and closes the stream without crashing the server', async () => {
    const run = await newRun();
    await append(run);
    const original = events.listForRun.bind(events);
    let calls = 0;
    vi.spyOn(events, 'listForRun').mockImplementation(async (...args) => {
      calls += 1;
      if (calls > 1) throw new Error('simulated database failure with private SQL');
      return original(...args);
    });
    const { reader } = await follow(run.runId);
    let text = '';
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      text += new TextDecoder().decode(next.value);
    }
    expect(text).toContain('event: stream.error');
    expect(text).toContain('INTERNAL_ERROR');
    expect(text).not.toContain('private SQL');
    const count = calls;
    await new Promise(resolve => setTimeout(resolve, 350));
    expect(calls).toBe(count);
    const response = await fetch(`${base}/api/tasks/task_dev`);
    expect(response.status).toBe(200);
  }, 4000);

  it('does not overlap queries or duplicate sequences when queries take longer than the polling period', async () => {
    const run = await newRun();
    await append(run);
    const original = events.listForRun.bind(events);
    let active = 0;
    let maximum = 0;
    let calls = 0;
    vi.spyOn(events, 'listForRun').mockImplementation(async (...args) => {
      calls += 1;
      active += 1;
      maximum = Math.max(maximum, active);
      try {
        const rows = await original(...args);
        if (calls > 1) await new Promise(resolve => setTimeout(resolve, 600));
        return rows;
      } finally { active -= 1; }
    });
    const { reader, controller } = await follow(run.runId);
    let text = '';
    const consuming = (async () => {
      try {
        while (true) {
          const next = await reader.read();
          if (next.done) return;
          text += new TextDecoder().decode(next.value);
        }
      } catch (error) { if (!controller.signal.aborted) throw error; }
    })();
    await append(run);
    await waitFor(() => text.includes('id: 2\n'));
    await new Promise(resolve => setTimeout(resolve, 650));
    controller.abort();
    await consuming;
    expect(maximum).toBe(1);
    expect(text.match(/^id: 2$/gm)).toHaveLength(1);
    await waitFor(() => active === 0);
  }, 5000);
});
