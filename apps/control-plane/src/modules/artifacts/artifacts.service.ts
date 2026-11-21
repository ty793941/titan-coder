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

  async approve(artifactId: string): Promise<Artifact> {
    const row = await this.database.db.selectFrom('artifact').selectAll().where('artifact_id', '=', artifactId).executeTakeFirst();
    if (!row) throw new DomainError('RESOURCE_NOT_FOUND', `artifact ${artifactId} was not found`);
    if (row.type !== 'plan') throw new DomainError('INVALID_STATE_TRANSITION', 'only plan artifacts can be approved by this gate');
    await this.database.db.updateTable('artifact').set({ status: 'approved', review_state: 'approved' }).where('artifact_id', '=', artifactId).execute();
    return this.toArtifact({ ...row, status: 'approved', review_state: 'approved' });
  }

  async list(taskId: string, resolution?: string): Promise<Artifact[]> {
    const rows = await this.database.db.selectFrom('artifact').selectAll().where('task_id', '=', taskId)
      .orderBy('created_at', 'asc').execute();
    const visibleRows = resolution === 'latest-approved'
      ? [...rows.filter(row => row.status === 'approved' && row.review_state === 'approved')]
        .sort((left, right) => right.version - left.version)
        .filter((row, index, all) => all.findIndex(candidate => candidate.type === row.type) === index)
      : rows;
    return visibleRows.map(row => this.toArtifact(row));
  }

  async hasApprovedPlan(taskId: string, checksum: string): Promise<boolean> {
    const row = await this.database.db.selectFrom('artifact').select('checksum')
      .where('task_id', '=', taskId).where('type', '=', 'plan')
      .where('status', '=', 'approved')
      .where('review_state', '=', 'approved').orderBy('version', 'desc').executeTakeFirst();
    return row?.checksum === checksum;
  }

  private toArtifact(row: {
    artifact_id: string; project_id: string; task_id: string; session_id: string | null;
    type: string; version: number; schema_version: number; uri: string; checksum: string;
    status: string; source_artifacts: unknown; created_by_type: string; created_by_id: string;
    created_at: Date; review_state: string; reference: string | null; metadata: unknown;
  }): Artifact {
    const artifact = {
      artifactId: row.artifact_id as Artifact['artifactId'], projectId: row.project_id as Artifact['projectId'],
      taskId: row.task_id as Artifact['taskId'], ...(row.session_id ? { sessionId: row.session_id as Artifact['sessionId'] } : {}),
      type: row.type as Artifact['type'], version: row.version, schemaVersion: row.schema_version,
      uri: row.uri, checksum: row.checksum as Artifact['checksum'], status: row.status as Artifact['status'],
      sourceArtifacts: row.source_artifacts as string[], createdBy: { type: row.created_by_type as Artifact['createdBy']['type'], id: row.created_by_id },
      createdAt: row.created_at.toISOString(), reviewState: row.review_state as Artifact['reviewState'],
      ...(row.reference ? { reference: row.reference } : {}), metadata: row.metadata,
    };
    return artifact as unknown as Artifact;
  }
}
