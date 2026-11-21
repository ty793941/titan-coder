import { EventEmitter } from 'node:events';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { EventEnvelope } from '@titan/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventsController } from '../dist/modules/events/events.controller.js';
import type { EventsService } from '../dist/modules/events/events.service.js';

const transports: Transport[] = [];
afterEach(() => {
  for (const raw of transports.splice(0)) raw.disconnect();
  vi.restoreAllMocks();
});

class Transport extends EventEmitter {
  destroyed = false;
  writableEnded = false;
  frames: string[] = [];
  blocked = false;
  flushed = false;
  writeHead() {}
  flushHeaders() { this.flushed = true; }
  write(frame: string) { this.frames.push(frame); return !this.blocked; }
  end(frame?: string) { if (frame) this.frames.push(frame); this.writableEnded = true; }
  disconnect() { this.destroyed = true; this.emit('close'); }
}

function transport(events: Pick<EventsService, 'listForRun'>) {
  const raw = new Transport();
  transports.push(raw);
  const request = { log: { error() {} } } as unknown as FastifyRequest;
  const reply = { raw, hijack() {} } as unknown as FastifyReply;
  const controller = new EventsController(events as EventsService);
  return { raw, start: () => controller.stream('run_test', undefined, 'true', request, reply) };
}

async function waitFor(check: () => boolean) {
  const deadline = performance.now() + 2000;
  while (!check()) {
    if (performance.now() > deadline) throw new Error('transport condition timeout');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

function envelope(sequence: number): EventEnvelope {
  return {
    eventId: `evt_${sequence}` as EventEnvelope['eventId'],
    eventType: 'run.completed',
    payloadVersion: 1,
    sequence,
    traceId: 'trace_test',
    projectId: 'project_test' as EventEnvelope['projectId'],
    runId: 'run_test' as EventEnvelope['runId'],
    actor: { type: 'system', id: 'transport-test' },
    occurredAt: '2026-11-21T00:00:00.000Z',
    payload: {},
  };
}

describe('SSE flow control', () => {
  it('waits for drain before writing the next event or polling again', async () => {
    let reads = 0;
    const { raw, start } = transport({
      async listForRun() {
        reads += 1;
        return reads === 1 ? [envelope(1), envelope(2)] : [];
      },
    });
    raw.blocked = true;
    const pending = start();
    await waitFor(() => raw.frames.length > 0);
    await new Promise(resolve => setTimeout(resolve, 350));
    expect(raw.flushed).toBe(true);
    expect(raw.frames.filter(frame => frame.startsWith('id:'))).toHaveLength(1);
    expect(reads).toBe(1);
    raw.blocked = false;
    raw.emit('drain');
    await waitFor(() => reads === 2);
    expect(raw.frames.filter(frame => frame.startsWith('id:')).map(frame => frame.split('\n')[0])).toEqual(['id: 1', 'id: 2']);
    expect(reads).toBe(2);
    raw.disconnect();
    await pending;
    expect(raw.listenerCount('drain')).toBe(0);
    expect(raw.listenerCount('close')).toBe(0);
  });

  it('sends idle heartbeat comments and releases timers when the response closes', async () => {
    let clock = 1000;
    vi.spyOn(Date, 'now').mockImplementation(() => clock);
    let reads = 0;
    const { raw, start } = transport({ async listForRun() { reads += 1; return []; } });
    const pending = start();
    await waitFor(() => raw.frames.length > 0);
    clock = 16_001;
    await waitFor(() => raw.frames.includes(': heartbeat\n\n'));
    expect(raw.frames).toContain(': connected\n\n');
    expect(raw.frames).toContain(': heartbeat\n\n');
    expect(raw.frames.every(frame => frame.startsWith(':'))).toBe(true);
    raw.disconnect();
    await pending;
    const count = reads;
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(reads).toBe(count);
    expect(raw.listenerCount('close')).toBe(0);
    expect(raw.listenerCount('error')).toBe(0);
  });

  it('releases a backpressure wait when the response closes before drain', async () => {
    const { raw, start } = transport({ async listForRun() { return []; } });
    raw.blocked = true;
    const pending = start();
    await waitFor(() => raw.frames.length > 0);
    raw.disconnect();
    await pending;
    expect(raw.listenerCount('drain')).toBe(0);
  });
});
