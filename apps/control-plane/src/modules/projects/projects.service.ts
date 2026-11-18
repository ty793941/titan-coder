import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { projectCreateRequestSchema } from '@titan/contracts';
import type { Project } from '@titan/domain';
import { DatabaseService } from '../../database/database.service.js';
import { IdempotencyService } from '../../common/idempotency.service.js';
import { EventsService } from '../events/events.service.js';

@Injectable()
export class ProjectsService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(IdempotencyService) private readonly idempotency: IdempotencyService,
    @Inject(EventsService) private readonly events: EventsService,
  ) {}

  async create(input: unknown, idempotencyKey?: string): Promise<Project> {
    const parsed = projectCreateRequestSchema.parse({ ...input as object, idempotencyKey: idempotencyKey ?? (input as { idempotencyKey?: string }).idempotencyKey });
    return this.database.db.transaction().execute(async trx => {
      const existing = await this.idempotency.read<Project>(trx, 'project:create', parsed.idempotencyKey, parsed);
      if (existing) return existing;
      const project: Project = {
        id: `project_${randomUUID()}` as Project['id'],
        name: parsed.name,
        goal: parsed.goal,
        createdAt: new Date().toISOString(),
        version: 1,
      };
      await trx.insertInto('organization').values({
        id: 'org_dev', name: 'Titan Development', status: 'active', created_at: new Date(),
      }).onConflict(oc => oc.column('id').doNothing()).execute();
      await trx.insertInto('project').values({
        id: project.id,
        organization_id: 'org_dev',
        name: project.name,
        goal: project.goal,
        version: project.version,
        created_at: new Date(project.createdAt),
      }).execute();
      await this.events.append(trx, {
        eventType: 'project.created', projectId: project.id,
        actor: { type: 'user', id: 'local-user' }, payload: project as unknown as Record<string, unknown>,
      });
      await this.idempotency.write(trx, 'project:create', parsed.idempotencyKey, parsed, project as unknown as Record<string, unknown>, 201);
      return project;
    });
  }
}
