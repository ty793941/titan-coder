import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Inject, Injectable } from '@nestjs/common';
import { artifactTypeSchema, DomainError } from '@titan/contracts';
import { createArtifactVersion } from '@titan/domain';
import type { Artifact } from '@titan/domain';
import { DatabaseService } from '../../database/database.service.js';
import { IdempotencyService } from '../../common/idempotency.service.js';

type ArtifactInput = { type: string; content: string; sourceArtifacts?: string[]; sessionId?: string };

@Injectable()
export class ArtifactsService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(IdempotencyService) private readonly idempotency: IdempotencyService,
  ) {}

  async create(taskId: string, input: ArtifactInput, idempotencyKey: string): Promise<Artifact> {
    const type = artifactTypeSchema.parse(input.type);
    return this.database.db.transaction().execute(async trx => {
      const task = await trx.selectFrom('task').innerJoin('project', 'project.id', 'task.project_id')
        .select(['task.id as task_id', 'task.project_id']).where('task.id', '=', taskId).executeTakeFirst();
      if (!task) throw new DomainError('RESOURCE_NOT_FOUND', `task ${taskId} was not found`);
      const existing = await this.idempotency.read<Artifact>(trx, `task:${taskId}:artifact:create`, idempotencyKey, input);
      if (existing) return existing;
      const previous = await trx.selectFrom('artifact').select(({ fn }) => fn.max('version').as('max_version'))
        .where('task_id', '=', taskId).where('type', '=', type).executeTakeFirst();
      const version = Number(previous?.max_version ?? 0) + 1;
      const artifactId = `artifact_${randomUUID()}`;
      const artifactRoot = resolve(process.cwd(), process.cwd().endsWith('/control-plane') ? '../../.titan/artifacts' : '.titan/artifacts');
      await mkdir(artifactRoot, { recursive: true });
      const filePath = resolve(artifactRoot, `${artifactId}-v${version}.md`);
      await writeFile(filePath, input.content, 'utf8');
      const artifact = createArtifactVersion({
        artifactId, projectId: task.project_id, taskId,
        type, uri: pathToFileURL(filePath).toString(), content: input.content,
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        sourceArtifacts: input.sourceArtifacts ?? [], createdBy: { type: 'agent', id: 'project-manager' },
      });
      const versioned = { ...artifact, version };
      await trx.insertInto('artifact').values({
        artifact_id: versioned.artifactId, project_id: versioned.projectId, task_id: versioned.taskId,
        session_id: versioned.sessionId ?? null, type: versioned.type, version: versioned.version,
        schema_version: versioned.schemaVersion, uri: versioned.uri, checksum: versioned.checksum,
        status: versioned.status, source_artifacts: JSON.stringify(versioned.sourceArtifacts),
        created_by_type: versioned.createdBy.type, created_by_id: versioned.createdBy.id,
        created_at: new Date(versioned.createdAt), review_state: versioned.reviewState,
      }).execute();
      await this.idempotency.write(trx, `task:${taskId}:artifact:create`, idempotencyKey, input as unknown as Record<string, unknown>, versioned as unknown as Record<string, unknown>, 201);
      return versioned;
    });
  }

  async list(taskId: string): Promise<Artifact[]> {
    const rows = await this.database.db.selectFrom('artifact').selectAll().where('task_id', '=', taskId)
      .orderBy('created_at', 'asc').execute();
    return rows.map(row => {
      const artifact = {
      artifactId: row.artifact_id as Artifact['artifactId'], projectId: row.project_id as Artifact['projectId'],
      taskId: row.task_id as Artifact['taskId'], ...(row.session_id ? { sessionId: row.session_id as Artifact['sessionId'] } : {}),
      type: row.type as Artifact['type'], version: row.version, schemaVersion: row.schema_version,
      uri: row.uri, checksum: row.checksum as Artifact['checksum'], status: row.status as Artifact['status'],
      sourceArtifacts: row.source_artifacts as string[], createdBy: { type: row.created_by_type as Artifact['createdBy']['type'], id: row.created_by_id },
      createdAt: row.created_at.toISOString(), reviewState: row.review_state as Artifact['reviewState'],
      };
      return artifact as Artifact;
    });
  }
}
