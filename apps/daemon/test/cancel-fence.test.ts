import { createServer } from 'node:http';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DaemonClient, DaemonHttpError } from '../src/daemon-client.js';
import { PersistentOutbox } from '../src/persistent-outbox.js';

describe('cancelled cloud progress fence over HTTP', () => {
  it('parses a cancellation proof and durably discards exactly the matching pending event', async () => {
    const progress = { eventId: 'stale-event', sequence: 1, claimToken: 'old-claim', type: 'completed' as const, payload: {} };
    const proof = { reason: 'CLOUD_PROGRESS_FENCED', environmentType: 'cloud', daemonId: 'daemon_1', runId: 'run_1', eventId: progress.eventId, jobStatus: 'cancelled', runStatus: 'cancelled' };
    const server = createServer(async (request, response) => {
      expect(request.url).toBe('/api/daemons/daemon_1/runs/run_1/progress');
      expect(request.headers.authorization).toBe('Bearer device-token');
      let body = '';
      for await (const chunk of request) body += chunk;
      expect(JSON.parse(body)).toEqual(progress);
      response.writeHead(403, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ code: 'PERMISSION_DENIED', details: proof }));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('missing test server');
      const baseUrl = `http://127.0.0.1:${address.port}`;
      const client = new DaemonClient(baseUrl);
      const root = await mkdtemp(join(tmpdir(), 'titan-cancel-fence-'));
      const path = join(root, 'outbox.jsonl');
      const outbox = await PersistentOutbox.open(path);
      const event = { daemonId: 'daemon_1', runId: 'run_1', progress };
      const other = { ...event, runId: 'run_2', progress: { ...progress, eventId: 'other-event' } };
      await outbox.append(event);
      await outbox.append(other);
      const error = await client.progress({ daemonId: 'daemon_1', authToken: 'device-token', baseUrl }, event.runId, progress).catch(value => value);
      expect(error).toBeInstanceOf(DaemonHttpError);
      expect(error.fence).toEqual(proof);
      for (const change of [{ daemonId: 'other-daemon' }, { runId: 'other-run' }, { eventId: 'other-event' }]) {
        await expect(outbox.discardFenced(progress.eventId, { ...error.fence, ...change })).rejects.toThrow('OUTBOX_FENCE_MISMATCH');
      }
      expect(outbox.pending()).toHaveLength(2);
      await outbox.discardFenced(progress.eventId, error.fence);
      await outbox.discardFenced(progress.eventId, error.fence);
      const recovered = await PersistentOutbox.open(path);
      expect(recovered.pending()).toEqual([other]);
      expect(recovered.lastSequence('run_1')).toBe(1);
      const records = (await readFile(path, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
      expect(records.filter(row => row.operation === 'discard')).toEqual([{ operation: 'discard', eventId: progress.eventId, fence: proof, occurredAt: expect.any(String) }]);
      expect(records.some(row => row.operation === 'ack')).toBe(false);
    } finally {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});
