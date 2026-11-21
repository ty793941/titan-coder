import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { sql, type Transaction } from 'kysely';
import type { EventEnvelope } from '@titan/contracts';
import { DomainError } from '@titan/contracts';
import type { Database, EventTable, JsonValue } from '../../database/types.js';
import { DatabaseService } from '../../database/database.service.js';

type EventInput = {
  eventId?: string;
  eventType: string;
  projectId: string;
  taskId?: string;
  sessionId?: string;
  runId?: string;
  actor: { type: 'user' | 'agent' | 'daemon' | 'system'; id: string };
  payload: JsonValue;
  traceId?: string;
};

@Injectable()
export class EventsService {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  async append<T extends JsonValue>(trx: Transaction<Database>, input: EventInput): Promise<EventEnvelope<T>> {
    const scopeKey = input.runId ? `run:${input.runId}` : input.taskId ? `task:${input.taskId}` : `project:${input.projectId}`;
    await sql`select pg_advisory_xact_lock(hashtextextended(${scopeKey}, 0))`.execute(trx);
    const last = await trx.selectFrom('event')
      .select(({ fn }) => fn.max('sequence').as('max_sequence'))
      .where('scope_key', '=', scopeKey)
      .executeTakeFirst();
    const sequence = Number(last?.max_sequence ?? 0) + 1;
    if (!Number.isSafeInteger(sequence)) throw new DomainError('EVENT_SEQUENCE_GAP', 'event sequence exceeds the supported range');
    const eventId = input.eventId ?? `evt_${randomUUID()}`;
    if (input.eventId) {
      const existing = await trx.selectFrom('event').select('event_id').where('event_id', '=', eventId).executeTakeFirst();
      if (existing) throw new DomainError('IDEMPOTENCY_CONFLICT', 'eventId already exists in the event stream');
    }
    const row: EventTable = {
      event_id: eventId,
      event_type: input.eventType,
      payload_version: 1,
      sequence,
      trace_id: input.traceId ?? `trace_${randomUUID()}`,
      project_id: input.projectId,
      task_id: input.taskId ?? null,
      session_id: input.sessionId ?? null,
      run_id: input.runId ?? null,
      actor_type: input.actor.type,
      actor_id: input.actor.id,
      occurred_at: new Date(),
      payload: input.payload,
      scope_key: scopeKey,
    };
    await trx.insertInto('event').values(row).execute();
    await trx.insertInto('outbox_event').values({
      event_id: eventId,
      payload: input.payload,
      published_at: null,
      retry_count: 0,
    }).execute();
    return {
      eventId: eventId as EventEnvelope<T>['eventId'],
      eventType: input.eventType as EventEnvelope<T>['eventType'],
      payloadVersion: 1,
      sequence,
      traceId: row.trace_id,
      projectId: row.project_id as EventEnvelope<T>['projectId'],
      ...(row.task_id ? { taskId: row.task_id as EventEnvelope<T>['taskId'] } : {}),
      ...(row.session_id ? { sessionId: row.session_id as EventEnvelope<T>['sessionId'] } : {}),
      ...(row.run_id ? { runId: row.run_id as EventEnvelope<T>['runId'] } : {}),
      actor: input.actor,
      occurredAt: row.occurred_at.toISOString(),
      payload: input.payload as T,
    } as EventEnvelope<T>;
  }

  async listForTask(taskId: string): Promise<EventEnvelope[]> {
    const rows = await this.database.db.selectFrom('event').selectAll()
      .where('task_id', '=', taskId).orderBy('occurred_at', 'asc').execute();
    return rows.map(row => this.toEnvelope(row));
  }

  async listForRun(runId: string, afterSequence = 0): Promise<EventEnvelope[]> {
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) throw new DomainError('VALIDATION_FAILED', 'event cursor must be a non-negative safe integer');
    return this.database.db.transaction().setIsolationLevel('repeatable read').execute(async trx => {
      const run = await trx.selectFrom('run').select('id').where('id', '=', runId).executeTakeFirst();
      if (!run) throw new DomainError('RESOURCE_NOT_FOUND', `run ${runId} not found`);
      const latest = await trx.selectFrom('event')
        .select(({ fn }) => fn.max('sequence').as('max_sequence'))
        .where('run_id', '=', runId)
        .executeTakeFirst();
      const maxSequence = Number(latest?.max_sequence ?? 0);
      if (!Number.isSafeInteger(maxSequence) || afterSequence > maxSequence) {
        throw new DomainError('EVENT_SEQUENCE_GAP', `event cursor ${afterSequence} is ahead of run ${runId}`, { latestSequence: maxSequence });
      }
      const rows = await trx.selectFrom('event').selectAll()
        .where('run_id', '=', runId).where('sequence', '>', afterSequence)
        .orderBy('sequence', 'asc').execute();
      const envelopes = rows.map(row => this.toEnvelope(row));
      let expectedSequence = afterSequence + 1;
      for (const event of envelopes) {
        if (event.sequence !== expectedSequence) throw new DomainError('EVENT_SEQUENCE_GAP', `missing event sequence ${expectedSequence}`, { expectedSequence, receivedSequence: event.sequence, latestSequence: maxSequence });
        expectedSequence += 1;
      }
      return envelopes;
    });
  }

  private toEnvelope(row: EventTable): EventEnvelope {
    const sequence = Number(row.sequence);
    if (!Number.isSafeInteger(sequence) || sequence < 1) throw new DomainError('EVENT_SEQUENCE_GAP', 'invalid stored event sequence');
    return {
      eventId: row.event_id as EventEnvelope['eventId'],
      eventType: row.event_type as EventEnvelope['eventType'],
      payloadVersion: row.payload_version,
      sequence,
      traceId: row.trace_id,
      projectId: row.project_id as EventEnvelope['projectId'],
      ...(row.task_id ? { taskId: row.task_id as EventEnvelope['taskId'] } : {}),
      ...(row.session_id ? { sessionId: row.session_id as EventEnvelope['sessionId'] } : {}),
      ...(row.run_id ? { runId: row.run_id as EventEnvelope['runId'] } : {}),
      actor: { type: row.actor_type as EventEnvelope['actor']['type'], id: row.actor_id },
      occurredAt: row.occurred_at.toISOString(),
      payload: row.payload,
    } as EventEnvelope;
  }
}
