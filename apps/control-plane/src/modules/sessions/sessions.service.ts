import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { DomainError, sessionCreateRequestSchema } from '@titan/contracts';
import type { Session } from '@titan/domain';
import { DatabaseService } from '../../database/database.service.js';
import { IdempotencyService } from '../../common/idempotency.service.js';
import { EventsService } from '../events/events.service.js';
import { ArtifactsService } from '../artifacts/artifacts.service.js';

@Injectable()
export class SessionsService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(IdempotencyService) private readonly idempotency: IdempotencyService,
    @Inject(EventsService) private readonly events: EventsService,
    @Inject(ArtifactsService) private readonly artifacts: ArtifactsService,
  ) {}

  async create(taskId: string, input: unknown, headerKey?: string): Promise<Session> {
    const source = input as { idempotencyKey?: string };
    const parsed = sessionCreateRequestSchema.parse({ ...source, idempotencyKey: headerKey ?? source.idempotencyKey });
    return this.database.db.transaction().execute(async trx => {
      const task = await trx.selectFrom('task').select(['id']).where('id', '=', taskId).executeTakeFirst();
      if (!task) throw new DomainError('RESOURCE_NOT_FOUND', `task ${taskId} was not found`);
      if (parsed.planHash && !(await this.artifacts.hasApprovedPlan(taskId, parsed.planHash))) {
        throw new DomainError('PLAN_HASH_STALE', `approved plan ${parsed.planHash} was not found`);
      }
      const existing = await this.idempotency.read<Session>(trx, `task:${taskId}:session:create`, parsed.idempotencyKey, parsed);
      if (existing) return existing;
      const session: Session = {
        id: `session_${randomUUID()}` as Session['id'],
        taskId: taskId as Session['taskId'],
        status: 'queued',
        entryAgent: parsed.entryAgent,
        ...(parsed.planHash ? { planHash: parsed.planHash } : {}),
        createdAt: new Date().toISOString(),
      };
      await trx.insertInto('session').values({
        id: session.id, task_id: session.taskId, entry_agent: session.entryAgent,
        status: session.status, plan_hash: session.planHash ?? null, version: 1,
        created_at: new Date(session.createdAt),
      }).execute();
      const taskProject = await trx.selectFrom('task').select(['project_id']).where('id', '=', taskId).executeTakeFirstOrThrow();
      await this.events.append(trx, {
        eventType: 'session.created', projectId: taskProject.project_id, taskId, sessionId: session.id,
        actor: { type: 'system', id: 'control-plane' }, payload: session as unknown as Record<string, unknown>,
      });
      await this.idempotency.write(trx, `task:${taskId}:session:create`, parsed.idempotencyKey, parsed, session as unknown as Record<string, unknown>, 201);
      return session;
    });
  }

  async get(sessionId: string): Promise<Session> {
    const row = await this.database.db.selectFrom('session').selectAll().where('id', '=', sessionId).executeTakeFirst();
    if (!row) throw new DomainError('RESOURCE_NOT_FOUND', `session ${sessionId} was not found`);
    return {
      id: row.id as Session['id'], taskId: row.task_id as Session['taskId'], status: row.status as Session['status'],
      entryAgent: row.entry_agent as 'project-manager',
      ...(row.plan_hash ? { planHash: row.plan_hash } : {}), createdAt: row.created_at.toISOString(),
    };
  }
}
