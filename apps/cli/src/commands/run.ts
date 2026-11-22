import { setTimeout } from 'node:timers/promises';
import { ApiHttpError, type ApiClient, type SseEvent } from '../client.js';

export async function getRun(client: ApiClient, runId: string): Promise<unknown> {
  return client.request(`/api/runs/${encodeURIComponent(runId)}`);
}

export function createRun(client: ApiClient, sessionId: string, args: Record<string, string>): Promise<unknown> {
  const idempotencyKey = args.idempotencyKey ?? `cli-run-${crypto.randomUUID()}`;
  return client.request(`/api/sessions/${encodeURIComponent(sessionId)}/runs`, {
    method: 'POST', headers: { 'Idempotency-Key': idempotencyKey }, body: JSON.stringify({ idempotencyKey }),
  });
}

export function cancelRun(client: ApiClient, runId: string): Promise<void> {
  return client.request(`/api/runs/${encodeURIComponent(runId)}/cancel`, { method: 'POST' });
}

export function pauseRun(client: ApiClient, runId: string): Promise<unknown> {
  return client.request(`/api/runs/${encodeURIComponent(runId)}/pause`, { method: 'POST' });
}

export function resumeRun(client: ApiClient, runId: string, args: Record<string, string>): Promise<unknown> {
  const idempotencyKey = args.idempotencyKey ?? `cli-resume-${crypto.randomUUID()}`;
  const body = {
    idempotencyKey,
    ...(args.planHash ? { planHash: args.planHash } : {}),
    ...(args.checkpointId ? { checkpointId: args.checkpointId } : {}),
  };
  return client.request(`/api/runs/${encodeURIComponent(runId)}/resume`, {
    method: 'POST', headers: { 'Idempotency-Key': idempotencyKey }, body: JSON.stringify(body),
  });
}

export async function getRunEvents(client: ApiClient, runId: string, lastEventId?: string): Promise<unknown[]> {
  const events = await client.stream(`/api/runs/${encodeURIComponent(runId)}/events`, lastEventId);
  return events.map(decodeEvent);
}

export type FollowOptions = {
  signal?: AbortSignal;
  write?: (text: string) => void | Promise<void>;
  maxReconnects?: number;
  reconnectDelayMs?: number;
};

export async function followRunEvents(client: ApiClient, runId: string, lastEventId: string | undefined, options: FollowOptions): Promise<void> {
  const path = `/api/runs/${encodeURIComponent(runId)}/events`;
  let cursor = parseSequence(lastEventId ?? '0');
  let hasCursor = lastEventId !== undefined;
  const emit = async (event: SseEvent) => {
    if (event.event === 'stream.error') {
      const error = JSON.parse(event.data) as { code: string; message: string; retryable?: boolean };
      throw new ApiHttpError(error.code, error.message, error.retryable ? 503 : 409);
    }
    const payload = decodeEvent(event);
    const sequence = parseSequence(event.id ?? String(payload.sequence));
    if (sequence <= cursor) return;
    if (sequence !== cursor + 1) throw new ApiHttpError('EVENT_SEQUENCE_GAP', `Expected sequence ${cursor + 1}, received ${sequence}`, 409);
    await options.write?.(`${JSON.stringify(payload)}\n`);
    cursor = sequence;
    hasCursor = true;
  };
  let replayFailed = false;
  const backfill = async () => {
    try {
      for await (const event of client.iterate(path, String(cursor), options.signal)) {
        await emit(event);
        if (options.signal?.aborted) return;
      }
    } catch (error) {
      replayFailed = true;
      throw error;
    }
  };
  let reconnects = 0;
  while (!options.signal?.aborted) {
    try {
      for await (const event of client.iterate(`${path}?follow=true`, hasCursor ? String(cursor) : undefined, options.signal)) {
        if (event.event !== 'stream.error' && parseSequence(event.id ?? String(decodeEvent(event).sequence)) > cursor + 1) await backfill();
        if (options.signal?.aborted) return;
        await emit(event);
        if (options.signal?.aborted) return;
      }
    } catch (error) {
      if (options.signal?.aborted) return;
      if (replayFailed) throw error;
      if (error instanceof ApiHttpError) {
        if (error.code === 'EVENT_SEQUENCE_GAP') await backfill();
        else if (error.status < 500 && error.status !== 429) throw error;
      } else if (!(error instanceof TypeError)) throw error;
    }
    if (options.signal?.aborted) return;
    if (reconnects >= (options.maxReconnects ?? 5)) throw new ApiHttpError('SSE_RECONNECT_EXHAUSTED', 'Event stream reconnect limit reached', 503);
    const delay = Math.min((options.reconnectDelayMs ?? 250) * 2 ** reconnects, 5000);
    reconnects += 1;
    try { await setTimeout(delay, undefined, options.signal ? { signal: options.signal } : {}); }
    catch (error) { if (options.signal?.aborted) return; throw error; }
  }
}

function decodeEvent(event: SseEvent): Record<string, unknown> {
  try {
    const payload: unknown = JSON.parse(event.data);
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Invalid envelope');
    return { ...payload, ...(event.event ? { eventType: event.event } : {}) };
  } catch {
    throw new ApiHttpError('INVALID_RESPONSE', 'Invalid event envelope JSON', 200);
  }
}

function parseSequence(value: string): number {
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new ApiHttpError('VALIDATION_FAILED', 'Event cursor must be a non-negative safe integer', 400);
  return Number(value);
}
