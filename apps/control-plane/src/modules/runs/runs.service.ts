import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { DomainError, runCreateRequestSchema } from '@titan/contracts';
import type { Run } from '@titan/domain';
import { DatabaseService } from '../../database/database.service.js';
import { IdempotencyService } from '../../common/idempotency.service.js';
import { EventsService } from '../events/events.service.js';

@Injectable()
export class RunsService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(IdempotencyService) private readonly idempotency: IdempotencyService,
    @Inject(EventsService) private readonly events: EventsService,
  ) {}

  async create(sessionId: string, input: unknown, headerKey?: string): Promise<Run> {
    const source = input as { idempotencyKey?: string };
    const parsed = runCreateRequestSchema.parse({ ...source, idempotencyKey: headerKey ?? source.idempotencyKey });
    return this.database.db.transaction().execute(async trx => {
      const session = await trx.selectFrom('session').select(['id', 'task_id']).where('id', '=', sessionId).executeTakeFirst();
      if (!session) throw new DomainError('RESOURCE_NOT_FOUND', `session ${sessionId} was not found`);
      const existing = await this.idempotency.read<Run>(trx, `session:${sessionId}:run:create`, parsed.idempotencyKey, parsed);
      if (existing) return existing;
      const lastRun = await trx.selectFrom('run').select(['attempt']).where('session_id', '=', sessionId).orderBy('attempt', 'desc').executeTakeFirst();
      const run: Run = {
        id: `run_${randomUUID()}` as Run['id'],
        sessionId: sessionId as Run['sessionId'],
        attempt: (lastRun?.attempt ?? 0) + 1,
        status: 'queued',
        ...(parsed.checkpointId ? { checkpointId: parsed.checkpointId } : {}),
        createdAt: new Date().toISOString(),
      };
      await trx.insertInto('run').values({
        id: run.id, session_id: run.sessionId, attempt: run.attempt, status: run.status,
        checkpoint_id: run.checkpointId ?? null, error_code: null, version: 1,
        created_at: new Date(run.createdAt),
      }).execute();
      const project = await trx.selectFrom('task').select(['project_id']).where('id', '=', session.task_id).executeTakeFirstOrThrow();
      await this.events.append(trx, {
        eventType: 'run.created', projectId: project.project_id, taskId: session.task_id,
        sessionId, runId: run.id, actor: { type: 'system', id: 'control-plane' }, payload: run as unknown as Record<string, unknown>,
      });
      await this.idempotency.write(trx, `session:${sessionId}:run:create`, parsed.idempotencyKey, parsed, run as unknown as Record<string, unknown>, 201);
      return run;
    });
  }

  async get(runId: string): Promise<Run> {
    const row = await this.database.db.selectFrom('run').selectAll().where('id', '=', runId).executeTakeFirst();
    if (!row) throw new DomainError('RESOURCE_NOT_FOUND', `run ${runId} was not found`);
    return {
      id: row.id as Run['id'], sessionId: row.session_id as Run['sessionId'], attempt: row.attempt,
      status: row.status as Run['status'], ...(row.checkpoint_id ? { checkpointId: row.checkpoint_id } : {}),
      ...(row.error_code ? { errorCode: row.error_code } : {}), createdAt: row.created_at.toISOString(),
    };
  }

  async fail(runId: string, errorCode: string): Promise<void> {
    await this.database.db.transaction().execute(async trx => {
      const row = await trx.selectFrom('run').selectAll().where('id', '=', runId).forUpdate().executeTakeFirst();
      if (!row) throw new DomainError('RESOURCE_NOT_FOUND', `run ${runId} was not found`);
      if (row.status !== 'queued' && row.status !== 'running') {
        throw new DomainError('INVALID_STATE_TRANSITION', `run ${runId} cannot fail from ${row.status}`);
      }
      await trx.updateTable('run').set({ status: 'failed', error_code: errorCode, version: row.version + 1 }).where('id', '=', runId).execute();
      const context = await trx.selectFrom('session').innerJoin('task', 'task.id', 'session.task_id')
        .select(['task.project_id', 'task.id as task_id', 'session.id as session_id'])
        .where('session.id', '=', row.session_id).executeTakeFirstOrThrow();
      await this.events.append(trx, {
        eventType: 'run.failed', projectId: context.project_id, taskId: context.task_id,
        sessionId: context.session_id, runId, actor: { type: 'system', id: 'control-plane' },
        payload: { errorCode },
      });
    });
  }

  async complete(runId: string): Promise<void> {
    await this.database.db.transaction().execute(async trx => {
      const row = await trx.selectFrom('run').selectAll().where('id', '=', runId).forUpdate().executeTakeFirst();
      if (!row) throw new DomainError('RESOURCE_NOT_FOUND', `run ${runId} was not found`);
      if (row.status !== 'queued' && row.status !== 'running') {
        throw new DomainError('INVALID_STATE_TRANSITION', `run ${runId} cannot complete from ${row.status}`);
      }
      await trx.updateTable('run').set({ status: 'completed', version: row.version + 1 }).where('id', '=', runId).execute();
      const context = await trx.selectFrom('session').innerJoin('task', 'task.id', 'session.task_id')
        .select(['task.project_id', 'task.id as task_id', 'session.id as session_id'])
        .where('session.id', '=', row.session_id).executeTakeFirstOrThrow();
      await this.events.append(trx, {
        eventType: 'run.completed', projectId: context.project_id, taskId: context.task_id,
        sessionId: context.session_id, runId, actor: { type: 'system', id: 'control-plane' },
        payload: { status: 'completed' },
      });
    });
  }
}
