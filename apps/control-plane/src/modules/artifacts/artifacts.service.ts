import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { artifactSchema, artifactTypeSchema, DomainError } from '@titan/contracts';
import { createArtifactVersion } from '@titan/domain';
import type { Artifact } from '@titan/domain';
import { DatabaseService } from '../../database/database.service.js';
import { IdempotencyService } from '../../common/idempotency.service.js';
import { EventsService } from '../events/events.service.js';
import { qrspiArtifactStages } from '../tasks/qrspi-gate.js';

const identifier = z.string().trim().min(1).max(200);
const artifactInputSchema = z.object({
  type: artifactTypeSchema,
  content: z.string().max(1048576),
  sourceArtifacts: z.array(identifier).max(50).refine(values => new Set(values).size === values.length, 'source artifacts must be unique').optional(),
  sessionId: identifier.optional(),
}).strict();

@Injectable()
export class ArtifactsService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(IdempotencyService) private readonly idempotency: IdempotencyService,
    @Inject(EventsService) private readonly events: EventsService,
  ) {}

  async create(taskId: string, input: unknown, idempotencyKey: string): Promise<Artifact> {
    const parsed = artifactInputSchema.parse(input);
    const { type } = parsed;
    return this.database.db.transaction().execute(async trx => {
      const task = await trx.selectFrom('task').select(['id', 'project_id']).where('id', '=', taskId).forUpdate().executeTakeFirst();
      if (!task) throw new DomainError('RESOURCE_NOT_FOUND', `task ${taskId} was not found`);
      const existing = await this.idempotency.read<Artifact>(trx, `task:${taskId}:artifact:create`, idempotencyKey, parsed);
      if (existing) return existing;
      if (parsed.sessionId) {
        const session = await trx.selectFrom('session').select('id').where('id', '=', parsed.sessionId).where('task_id', '=', taskId).executeTakeFirst();
        if (!session) throw new DomainError('VALIDATION_FAILED', 'artifact session must belong to its task');
      }
      if (parsed.sourceArtifacts?.length) {
        const sources = await trx.selectFrom('artifact').select('artifact_id').where('artifact_id', 'in', parsed.sourceArtifacts)
          .where('task_id', '=', taskId).where('project_id', '=', task.project_id).execute();
        if (sources.length !== parsed.sourceArtifacts.length) throw new DomainError('VALIDATION_FAILED', 'source artifacts must exist and belong to the same task');
      }
      const previous = await trx.selectFrom('artifact').select(({ fn }) => fn.max('version').as('max_version'))
        .where('task_id', '=', taskId).where('type', '=', type).executeTakeFirst();
      const version = Number(previous?.max_version ?? 0) + 1;
      const artifactId = `artifact_${randomUUID()}`;
      const artifactRoot = resolve(process.cwd(), process.cwd().endsWith('/control-plane') ? '../../.titan/artifacts' : '.titan/artifacts');
      await mkdir(artifactRoot, { recursive: true });
      const filePath = resolve(artifactRoot, `${artifactId}-v${version}.md`);
      await writeFile(filePath, parsed.content, { encoding: 'utf8', flag: 'wx' });
      const artifact = createArtifactVersion({
        artifactId, projectId: task.project_id, taskId,
        type, uri: pathToFileURL(filePath).toString(), content: parsed.content,
        ...(parsed.sessionId ? { sessionId: parsed.sessionId } : {}),
        sourceArtifacts: parsed.sourceArtifacts ?? [], createdBy: { type: 'agent', id: 'project-manager' },
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
      await this.events.append(trx, {
        eventType: 'artifact.created', projectId: task.project_id, taskId,
        ...(parsed.sessionId ? { sessionId: parsed.sessionId } : {}), actor: versioned.createdBy,
        payload: { artifactId, type, version, checksum: versioned.checksum, sourceArtifacts: versioned.sourceArtifacts },
      });
      await this.idempotency.write(trx, `task:${taskId}:artifact:create`, idempotencyKey, parsed, versioned as unknown as Record<string, unknown>, 201);
      return versioned;
    });
  }

  async approve(artifactId: string): Promise<Artifact> {
    return this.database.db.transaction().execute(async trx => {
      const owner = await trx.selectFrom('artifact').select('task_id').where('artifact_id', '=', artifactId).executeTakeFirst();
      if (!owner) throw new DomainError('RESOURCE_NOT_FOUND', `artifact ${artifactId} was not found`);
      // 创建、审批和阶段推进都先锁 task，避免新版本绕过最新版本检查。
      await trx.selectFrom('task').select('id').where('id', '=', owner.task_id).forUpdate().executeTakeFirstOrThrow();
      const row = await trx.selectFrom('artifact').selectAll().where('artifact_id', '=', artifactId).forUpdate().executeTakeFirstOrThrow();
      if (!qrspiArtifactStages.some(type => type === row.type)) throw new DomainError('INVALID_STATE_TRANSITION', 'only QRSPI preparation artifacts can be approved by this gate');
      const latest = await trx.selectFrom('artifact').select('artifact_id').where('task_id', '=', row.task_id).where('type', '=', row.type)
        .orderBy('version', 'desc').executeTakeFirstOrThrow();
      if (latest.artifact_id !== artifactId) throw new DomainError('VERSION_CONFLICT', 'only the latest artifact version can be approved', { latestArtifactId: latest.artifact_id });
      const artifact = this.toArtifact(row);
      if (artifact.status === 'approved' && artifact.reviewState === 'approved') return artifact;
      if (artifact.status === 'archived') throw new DomainError('INVALID_STATE_TRANSITION', 'archived artifacts cannot be approved');
      await trx.updateTable('artifact').set({ status: 'approved', review_state: 'approved' }).where('artifact_id', '=', artifactId).execute();
      const payload = { artifactId, type: row.type, version: row.version, checksum: row.checksum, decision: 'approved' };
      const event = await this.events.append(trx, {
        eventType: 'artifact.approved', projectId: row.project_id, taskId: row.task_id,
        actor: { type: 'user', id: 'local-user' }, payload,
      });
      await trx.insertInto('audit_log').values({
        id: `audit_${randomUUID()}`, actor_type: 'user', actor_id: 'local-user', action: 'artifact.approved',
        target_type: 'artifact', target_id: artifactId, trace_id: event.traceId,
        payload: { ...payload, projectId: row.project_id, taskId: row.task_id },
      }).execute();
      return { ...artifact, status: 'approved', reviewState: 'approved' };
    });
  }

  async get(artifactId: string): Promise<Artifact> {
    const row = await this.database.db.selectFrom('artifact').selectAll().where('artifact_id', '=', artifactId).executeTakeFirst();
    if (!row) throw new DomainError('RESOURCE_NOT_FOUND', `artifact ${artifactId} was not found`);
    return this.toArtifact(row);
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
    return artifactSchema.parse(artifact) as Artifact;
  }
}
