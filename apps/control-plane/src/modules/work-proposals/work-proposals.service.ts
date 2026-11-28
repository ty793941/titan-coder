import { createHash, randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { conversationProjectIdSchema, DomainError, workProposalAcceptRequestSchema } from '@titan/contracts';
import type { Artifact, Task } from '@titan/domain';
import { DatabaseService } from '../../database/database.service.js';
import { IdempotencyService } from '../../common/idempotency.service.js';
import { TasksService } from '../tasks/tasks.service.js';
import { ArtifactsService } from '../artifacts/artifacts.service.js';
import { EventsService } from '../events/events.service.js';

type AcceptedProposal = { sourceTurnId: string; proposalChecksum: string; task: Task; artifact: Artifact };

@Injectable()
export class WorkProposalsService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(IdempotencyService) private readonly idempotency: IdempotencyService,
    @Inject(TasksService) private readonly tasks: TasksService,
    @Inject(ArtifactsService) private readonly artifacts: ArtifactsService,
    @Inject(EventsService) private readonly events: EventsService,
  ) {}

  async accept(projectId: string, input: unknown): Promise<AcceptedProposal> {
    conversationProjectIdSchema.parse(projectId);
    const parsed = workProposalAcceptRequestSchema.parse(input);
    const { proposal, sourceTurnId, proposalChecksum } = parsed;
    const checksum = `sha256:${createHash('sha256').update(JSON.stringify(proposal)).digest('hex')}`;
    if (checksum !== proposalChecksum) throw new DomainError('VALIDATION_FAILED', 'proposal checksum mismatch');
    return this.database.db.transaction().execute(async trx => {
      // 同项目来源回合在持久事务锁下去重，HTTP 重试键变化也不能重复创建。
      const project = await trx.selectFrom('project').select('id').where('id', '=', projectId).forUpdate().executeTakeFirst();
      if (!project) throw new DomainError('RESOURCE_NOT_FOUND', 'project was not found');
      const scope = `project:${projectId}:work-proposal`;
      const existing = await this.idempotency.read<AcceptedProposal>(trx, scope, sourceTurnId, parsed);
      if (existing) return existing;
      const { questions, ...taskInput } = proposal;
      const task = await this.tasks.createInTransaction(trx, projectId, taskInput, `proposal:${sourceTurnId}`);
      const artifact = await this.artifacts.createInTransaction(trx, task.id, { type: 'questions', content: questions, sourceArtifacts: [] }, `proposal:${sourceTurnId}`);
      const result = { sourceTurnId, proposalChecksum, task, artifact };
      const event = await this.events.append(trx, {
        eventType: 'work_proposal.accepted', projectId, taskId: task.id,
        actor: { type: 'user', id: 'local-user' },
        payload: { sourceTurnId, proposalChecksum, taskId: task.id, artifactId: artifact.artifactId },
      });
      await trx.insertInto('audit_log').values({
        id: `audit_${randomUUID()}`, actor_type: 'user', actor_id: 'local-user',
        action: 'work_proposal.accepted', target_type: 'task', target_id: task.id, trace_id: event.traceId,
        payload: { projectId, sourceTurnId, proposalChecksum, artifactId: artifact.artifactId },
      }).execute();
      await this.idempotency.write(trx, scope, sourceTurnId, parsed, result as unknown as Record<string, unknown>, 201);
      return result;
    });
  }
}
