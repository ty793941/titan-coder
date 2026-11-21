import { mkdtemp, readFile, stat, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PersistentOutbox } from '../src/persistent-outbox.js';

describe('PersistentOutbox', () => {
  it('replays original identities and persists acknowledgments across recreation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'titan-outbox-'));
    const path = join(root, 'outbox.jsonl');
    const event = { daemonId: 'daemon', runId: 'run', progress: {
      eventId: 'event', sequence: 7, claimToken: 'claim', type: 'output' as const,
      payload: { text: 'hello', apiKey: 'do-not-store', unknown: 'drop', nested: { accessToken: 'private' } },
    } };
    const outbox = await PersistentOutbox.open(path);
    await outbox.append(event);
    await outbox.append(event);
    expect((await PersistentOutbox.open(path)).pending()).toEqual([{ ...event, progress: { ...event.progress, payload: { text: 'hello' } } }]);
    expect((await readFile(path, 'utf8'))).not.toContain('do-not-store');
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    await outbox.acknowledge('event');
    expect((await PersistentOutbox.open(path)).pending()).toEqual([]);
    expect((await PersistentOutbox.open(path)).lastSequence('run')).toBe(7);
  });

  it('recovers an incomplete final append without losing earlier durable records', async () => {
    const root = await mkdtemp(join(tmpdir(), 'titan-outbox-'));
    const path = join(root, 'outbox.jsonl');
    const event = { daemonId: 'daemon', runId: 'run', progress: { eventId: 'event', sequence: 1, claimToken: 'claim', type: 'running' as const, payload: {} } };
    await (await PersistentOutbox.open(path)).append(event);
    await appendFile(path, '{"operation":');
    const recovered = await PersistentOutbox.open(path);
    expect(recovered.pending()).toEqual([event]);
    await recovered.acknowledge('event');
    expect((await PersistentOutbox.open(path)).pending()).toEqual([]);
  });
});
