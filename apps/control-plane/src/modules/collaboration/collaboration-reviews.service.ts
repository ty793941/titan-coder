import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import {
  DomainError,
  collaborationReviewDecisionSchema,
  reviewRequestCreateSchema,
} from '@titan/contracts';
import {
  CollaborationContext,
  checkVersion,
  localActor,
  view,
  type CollaborationTransaction,
} from './collaboration-context.js';

@Injectable()
export class CollaborationReviewsService {
  constructor(
    @Inject(CollaborationContext)
    private readonly context: CollaborationContext,
  ) {}

  private async target(
    trx: CollaborationTransaction,
    projectId: string,
    type: string,
    id: string,
  ) {
    if (type === 'task') {
      const row = await trx
        .selectFrom('task')
        .selectAll()
        .where('id', '=', id)
        .where('project_id', '=', projectId)
        .forUpdate()
        .executeTakeFirst();
      if (row) return { version: row.version, stage: row.stage };
    } else if (type === 'artifact') {
      const row = await trx
        .selectFrom('artifact')
        .selectAll()
        .where('artifact_id', '=', id)
        .where('project_id', '=', projectId)
        .forUpdate()
        .executeTakeFirst();
      if (row && row.status !== 'archived')
        return { version: row.version, stage: row.type };
    } else if (type === 'work-item') {
      const row = await trx
        .selectFrom('work_item')
        .selectAll()
        .where('id', '=', id)
        .where('project_id', '=', projectId)
        .forUpdate()
        .executeTakeFirst();
      if (row) return { version: row.version };
    } else if (type === 'run') {
      const row = await trx
        .selectFrom('run')
        .innerJoin('session', 'session.id', 'run.session_id')
        .innerJoin('task', 'task.id', 'session.task_id')
        .select(['run.version'])
        .where('run.id', '=', id)
        .where('task.project_id', '=', projectId)
        .forUpdate('run')
        .executeTakeFirst();
      if (row) return { version: row.version };
    }
    throw new DomainError(
      'COLLABORATION_NOT_FOUND',
      '评审目标不属于当前项目或已不可用',
    );
  }

  async create(input: unknown, key?: string) {
    const parsed = reviewRequestCreateSchema.parse(input);
    key ??= parsed.idempotencyKey;
    if (!key || key.length > 200 || !key.trim())
      throw new DomainError('VALIDATION_FAILED', '需要Idempotency-Key');
    const requestKey = key;
    return this.context.database.db.transaction().execute(async (trx) => {
      await this.context.project(trx, parsed.projectId);
      const scope = `project:${parsed.projectId}:review`;
      const replay = await this.context.idempotency.read<
        Record<string, unknown>
      >(trx, scope, requestKey, parsed);
      if (replay) return replay;
      const member = await this.context.member(
        trx,
        parsed.projectId,
        parsed.reviewerSubject.subjectType,
        parsed.reviewerSubject.subjectId,
      );
      if (!['owner', 'manager', 'reviewer'].includes(member.role))
        throw new DomainError(
          'COLLABORATION_PERMISSION_DENIED',
          '评审主体缺少评审角色',
        );
      const target = await this.target(
        trx,
        parsed.projectId,
        parsed.targetType,
        parsed.targetId,
      );
      if (target.stage && target.stage !== parsed.gate)
        throw new DomainError(
          'COLLABORATION_INVALID_STATE',
          '评审门禁不匹配目标阶段',
        );
      const pending = await trx
        .selectFrom('review_request')
        .selectAll()
        .where('project_id', '=', parsed.projectId)
        .where('target_type', '=', parsed.targetType)
        .where('target_id', '=', parsed.targetId)
        .where('gate', '=', parsed.gate)
        .where('status', '=', 'pending')
        .orderBy('created_at')
        .orderBy('id')
        .execute();
      if (pending.some((row) => row.mode !== parsed.mode))
        throw new DomainError(
          'COLLABORATION_INVALID_STATE',
          '当前门禁已有不同模式的待处理评审，请先关闭原队列',
        );
      if (
        pending.some(
          (row) =>
            row.reviewer_type === parsed.reviewerSubject.subjectType &&
            row.reviewer_id === parsed.reviewerSubject.subjectId,
        )
      )
        throw new DomainError('COLLABORATION_DUPLICATE', '已有相同待处理评审');
      // 时间戳可能来自先开始、后取得项目锁的事务，串行尾节点应由关系确定。
      const predecessors = new Set(pending.map((row) => row.predecessor_id));
      const tail = pending.find((row) => !predecessors.has(row.id));
      const row = await trx
        .insertInto('review_request')
        .values({
          id: `review_${randomUUID()}`,
          project_id: parsed.projectId,
          target_type: parsed.targetType,
          target_id: parsed.targetId,
          reviewer_type: parsed.reviewerSubject.subjectType,
          reviewer_id: parsed.reviewerSubject.subjectId,
          gate: parsed.gate,
          required_decision: parsed.requiredDecision,
          mode: parsed.mode,
          due_at: parsed.dueAt ? new Date(parsed.dueAt) : null,
          resolved_at: null,
          target_version: target.version,
          predecessor_id: parsed.mode === 'serial' ? (tail?.id ?? null) : null,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await this.context.inbox(
        trx,
        row.project_id,
        row.reviewer_type,
        row.reviewer_id,
        'review',
        row.id,
      );
      await this.context.record(
        trx,
        row.project_id,
        'review.requested',
        row.id,
        {
          reviewId: row.id,
          targetType: row.target_type,
          targetId: row.target_id,
          reviewerId: row.reviewer_id,
          gate: row.gate,
        },
      );
      const result = view(row);
      await this.context.idempotency.write(
        trx,
        scope,
        requestKey,
        parsed,
        result,
        201,
      );
      return result;
    });
  }

  async list(projectId: string) {
    await this.context.existingProject(projectId);
    return (
      await this.context.database.db
        .selectFrom('review_request')
        .selectAll()
        .where('project_id', '=', projectId)
        .orderBy('created_at', 'desc')
        .orderBy('id')
        .limit(100)
        .execute()
    ).map(view);
  }

  async decide(
    id: string,
    action: 'approved' | 'changes_requested' | 'cancelled',
    input: unknown,
  ) {
    const parsed = collaborationReviewDecisionSchema.parse(input);
    if (action === 'changes_requested' && !parsed.reason)
      throw new DomainError('VALIDATION_FAILED', '要求修改必须说明原因');
    return this.context.database.db.transaction().execute(async (trx) => {
      const source = await trx
        .selectFrom('review_request')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirst();
      if (!source)
        throw new DomainError('COLLABORATION_NOT_FOUND', '评审不存在');
      await this.context.project(trx, source.project_id);
      const row = await trx
        .selectFrom('review_request')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirstOrThrow();
      if (action !== 'cancelled') {
        await this.context.myAction(
          trx,
          row.project_id,
          row.reviewer_type,
          row.reviewer_id,
        );
        const member = await this.context.member(
          trx,
          row.project_id,
          row.reviewer_type,
          row.reviewer_id,
        );
        if (!['owner', 'manager', 'reviewer'].includes(member.role))
          throw new DomainError(
            'COLLABORATION_PERMISSION_DENIED',
            '评审角色已撤销',
          );
      }
      if (row.status === action && row.version === parsed.expectedVersion + 1)
        return view(row);
      checkVersion(row.version, parsed.expectedVersion);
      if (row.status !== 'pending')
        throw new DomainError('COLLABORATION_INVALID_STATE', '评审已结束');
      if (action !== 'cancelled') {
        if (row.due_at && row.due_at <= new Date())
          throw new DomainError(
            'COLLABORATION_INVALID_STATE',
            '评审期限已过，请取消后重新发起',
          );
        const target = await this.target(
          trx,
          row.project_id,
          row.target_type,
          row.target_id,
        );
        checkVersion(target.version, row.target_version);
        if (row.predecessor_id) {
          const prior = await trx
            .selectFrom('review_request')
            .select('status')
            .where('id', '=', row.predecessor_id)
            .executeTakeFirstOrThrow();
          if (prior.status !== 'approved')
            throw new DomainError(
              'COLLABORATION_REVIEW_REQUIRED',
              '串行前序评审尚未批准',
            );
        }
      }
      const updated = await trx
        .updateTable('review_request')
        .set({
          status: action,
          resolution_reason: parsed.reason ?? null,
          resolved_at: new Date(),
          version: row.version + 1,
        })
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirstOrThrow();
      await this.context.resolveInbox(trx, row.project_id, 'review', id);
      if (action === 'changes_requested')
        await this.context.inbox(
          trx,
          row.project_id,
          'human',
          localActor.id,
          'blocked',
          id,
        );
      await this.context.record(trx, row.project_id, `review.${action}`, id, {
        reviewId: id,
        targetId: row.target_id,
        version: updated.version,
      });
      return view(updated);
    });
  }
}
