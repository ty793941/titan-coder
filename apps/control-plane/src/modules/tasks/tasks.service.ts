import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { DomainError, taskCreateRequestSchema } from '@titan/contracts';
import type { Task } from '@titan/domain';
import { DatabaseService } from '../../database/database.service.js';
import { IdempotencyService } from '../../common/idempotency.service.js';
import { EventsService } from '../events/events.service.js';

@Injectable()
export class TasksService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(IdempotencyService) private readonly idempotency: IdempotencyService,
    @Inject(EventsService) private readonly events: EventsService,
  ) {}

  async create(projectId: string, input: unknown, headerKey?: string): Promise<Task> {
    const source = input as { idempotencyKey?: string };
    const parsed = taskCreateRequestSchema.parse({ ...source, idempotencyKey: headerKey ?? source.idempotencyKey });
    const key = parsed.idempotencyKey;
    if (!key) throw new DomainError('VALIDATION_FAILED', 'Idempotency-Key is required');
    return this.database.db.transaction().execute(async trx => {
      const project = await trx.selectFrom('project').select(['id']).where('id', '=', projectId).executeTakeFirst();
      if (!project) throw new DomainError('RESOURCE_NOT_FOUND', `project ${projectId} was not found`);
      const existing = await this.idempotency.read<Task>(trx, `project:${projectId}:task:create`, key, parsed);
      if (existing) return existing;
      const task: Task = {
        id: `task_${randomUUID()}` as Task['id'],
        projectId: projectId as Task['projectId'],
        title: parsed.title,
        goal: parsed.goal,
        acceptanceCriteria: parsed.acceptanceCriteria,
        priority: parsed.priority,
        stage: 'questions',
        status: 'active',
        version: 1,
        createdAt: new Date().toISOString(),
      };
      await trx.insertInto('task').values({
        id: task.id, project_id: task.projectId, title: task.title, goal: task.goal,
        acceptance_criteria: JSON.stringify(task.acceptanceCriteria), priority: task.priority,
        stage: task.stage, status: task.status, version: task.version,
        created_at: new Date(task.createdAt),
      }).execute();
      await this.events.append(trx, {
        eventType: 'task.created', projectId, taskId: task.id,
        actor: { type: 'user', id: 'local-user' }, payload: task as unknown as Record<string, unknown>,
      });
      await this.idempotency.write(trx, `project:${projectId}:task:create`, key, parsed, task as unknown as Record<string, unknown>, 201);
      return task;
    });
  }

  async get(taskId: string): Promise<Task> {
    const row = await this.database.db.selectFrom('task').selectAll().where('id', '=', taskId).executeTakeFirst();
    if (!row) throw new DomainError('RESOURCE_NOT_FOUND', `task ${taskId} was not found`);
    return {
      id: row.id as Task['id'], projectId: row.project_id as Task['projectId'], title: row.title,
      goal: row.goal, acceptanceCriteria: row.acceptance_criteria as string[], priority: row.priority as Task['priority'],
      stage: row.stage as Task['stage'], status: row.status as Task['status'], version: row.version,
      createdAt: row.created_at.toISOString(),
    };
  }
}
