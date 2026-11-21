import { constants } from 'node:fs';
import type { RunProgress } from '@titan/daemon-protocol';
import { openPrivateFile } from './private-state.js';
import { sanitizeProgress } from './progress-safety.js';

export type PendingProgress = { daemonId: string; runId: string; progress: RunProgress };
type RecordEntry = { operation: 'append'; event: PendingProgress } | { operation: 'ack'; eventId: string };

export class PersistentOutbox {
  private readonly events = new Map<string, PendingProgress>();
  private readonly acknowledged = new Set<string>();
  private chain: Promise<unknown> = Promise.resolve();

  private constructor(private readonly path: string, private readonly secrets: readonly string[]) {}

  static async open(path: string, secrets: readonly string[] = []): Promise<PersistentOutbox> {
    const outbox = new PersistentOutbox(path, secrets);
    const file = await openPrivateFile(path, constants.O_CREAT | constants.O_RDWR);
    try {
      const bytes = await file.readFile();
      const end = bytes.lastIndexOf(10) + 1;
      const complete = bytes.subarray(0, end).toString('utf8');
      for (const line of complete.split('\n')) if (line) outbox.apply(JSON.parse(line) as RecordEntry);
      if (end < bytes.length) { await file.truncate(end); await file.sync(); }
    } finally { await file.close(); }
    return outbox;
  }

  pending(): PendingProgress[] {
    return structuredClone([...this.events.values()].filter(event => !this.acknowledged.has(event.progress.eventId)));
  }

  lastSequence(runId: string): number {
    return Math.max(0, ...[...this.events.values()].filter(event => event.runId === runId).map(event => event.progress.sequence));
  }

  append(event: PendingProgress): Promise<void> {
    const safe = { daemonId: event.daemonId, runId: event.runId, progress: sanitizeProgress(event.progress, this.secrets) };
    return this.serialize(async () => {
      const existing = this.events.get(safe.progress.eventId);
      if (existing) {
        if (JSON.stringify(existing) !== JSON.stringify(safe)) throw new Error('EVENT_ID_CONFLICT');
        return;
      }
      await this.persist({ operation: 'append', event: safe });
    });
  }

  acknowledge(eventId: string): Promise<void> {
    return this.serialize(async () => {
      if (!this.events.has(eventId)) throw new Error('UNKNOWN_EVENT');
      if (!this.acknowledged.has(eventId)) await this.persist({ operation: 'ack', eventId });
    });
  }

  private serialize(operation: () => Promise<void>): Promise<void> {
    const pending = this.chain.then(operation);
    this.chain = pending.catch(() => undefined);
    return pending;
  }

  private async persist(record: RecordEntry): Promise<void> {
    const file = await openPrivateFile(this.path, constants.O_CREAT | constants.O_APPEND | constants.O_WRONLY);
    try { await file.writeFile(`${JSON.stringify(record)}\n`); await file.sync(); }
    finally { await file.close(); }
    this.apply(record);
  }

  private apply(record: RecordEntry): void {
    if (record.operation === 'append') {
      if (typeof record.event.daemonId !== 'string' || typeof record.event.runId !== 'string') throw new Error('INVALID_OUTBOX_RECORD');
      const progress = sanitizeProgress(record.event.progress, this.secrets);
      this.events.set(progress.eventId, { daemonId: record.event.daemonId, runId: record.event.runId, progress });
    } else if (record.operation === 'ack' && typeof record.eventId === 'string') this.acknowledged.add(record.eventId);
    else throw new Error('INVALID_OUTBOX_RECORD');
  }
}
