import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { DomainError } from '@titan/contracts';
import type { Transaction } from 'kysely';
import type { Database } from '../../database/types.js';
import { DatabaseService } from '../../database/database.service.js';
import { IdempotencyService } from '../../common/idempotency.service.js';
import { EventsService } from '../events/events.service.js';

export type CollaborationTransaction = Transaction<Database>;
export const localActor = { type: 'user' as const, id: 'local-user' };
export const activeAssignments = ['pending', 'active', 'accepted'];

export function view(row: object): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase()),
      value instanceof Date ? value.toISOString() : value,
    ]),
  );
}

export function checkVersion(actual: number, expected: number) {
  if (actual !== expected)
    throw new DomainError('COLLABORATION_VERSION_CONFLICT', '资源版本已变化');
}

@Injectable()
export class CollaborationContext {
  constructor(
    @Inject(DatabaseService) readonly database: DatabaseService,
    @Inject(IdempotencyService) readonly idempotency: IdempotencyService,
    @Inject(EventsService) private readonly events: EventsService,
  ) {}

  async existingProject(projectId: string) {
    const row = await this.database.db
      .selectFrom('project')
      .select('id')
      .where('id', '=', projectId)
      .executeTakeFirst();
    if (!row) throw new DomainError('COLLABORATION_NOT_FOUND', '项目不存在');
  }

  async existingWorkItem(id: string) {
    const row = await this.database.db
      .selectFrom('work_item')
      .select('id')
      .where('id', '=', id)
      .executeTakeFirst();
    if (!row) throw new DomainError('COLLABORATION_NOT_FOUND', '工作项不存在');
  }

  async project(trx: CollaborationTransaction, projectId: string) {
    const project = await trx
      .selectFrom('project')
      .select('id')
      .where('id', '=', projectId)
      .forUpdate()
      .executeTakeFirst();
    if (!project)
      throw new DomainError('COLLABORATION_NOT_FOUND', '项目不存在');
  }

  async member(
    trx: CollaborationTransaction,
    projectId: string,
    type: string,
    id: string,
  ) {
    const member = await trx
      .selectFrom('project_member')
      .selectAll()
      .where('project_id', '=', projectId)
      .where('subject_type', '=', type)
      .where('subject_id', '=', id)
      .where('status', '=', 'active')
      .executeTakeFirst();
    if (!member)
      throw new DomainError(
        'COLLABORATION_PERMISSION_DENIED',
        '主体不是当前项目的有效成员',
      );
    return member;
  }

  async myAction(
    trx: CollaborationTransaction,
    projectId: string,
    type: string,
    id: string,
  ) {
    if (type !== 'human' || id !== localActor.id)
      throw new DomainError(
        'COLLABORATION_PERMISSION_DENIED',
        '不能以Console身份冒充其他成员或Agent',
      );
    await this.member(trx, projectId, type, id);
  }

  async record(
    trx: CollaborationTransaction,
    projectId: string,
    action: string,
    targetId: string,
    payload: Record<string, unknown>,
    taskId?: string,
  ) {
    const event = await this.events.append(trx, {
      projectId,
      ...(taskId ? { taskId } : {}),
      eventType: action,
      actor: localActor,
      payload,
    });
    await trx
      .insertInto('audit_log')
      .values({
        id: `audit_${randomUUID()}`,
        actor_type: localActor.type,
        actor_id: localActor.id,
        action,
        target_type: action.split('.')[0]!,
        target_id: targetId,
        trace_id: event.traceId,
        payload,
        created_at: new Date(),
      })
      .execute();
  }

  async inbox(
    trx: CollaborationTransaction,
    projectId: string,
    subjectType: string,
    subjectId: string,
    kind: string,
    sourceId: string,
  ) {
    await trx
      .insertInto('collaboration_inbox_item')
      .values({
        id: `inbox_${randomUUID()}`,
        project_id: projectId,
        subject_type: subjectType,
        subject_id: subjectId,
        kind,
        source_id: sourceId,
        status: 'pending',
        resolved_at: null,
      })
      .onConflict((oc) =>
        oc
          .columns(['subject_type', 'subject_id', 'kind', 'source_id'])
          .doNothing(),
      )
      .execute();
  }

  async resolveInbox(
    trx: CollaborationTransaction,
    projectId: string,
    kind: string,
    sourceId: string,
  ) {
    const rows = await trx
      .selectFrom('collaboration_inbox_item')
      .selectAll()
      .where('project_id', '=', projectId)
      .where('kind', '=', kind)
      .where('source_id', '=', sourceId)
      .where('status', 'in', ['pending', 'read'])
      .execute();
    for (const row of rows) {
      await trx
        .updateTable('collaboration_inbox_item')
        .set({
          status: 'resolved',
          version: row.version + 1,
          resolved_at: new Date(),
        })
        .where('id', '=', row.id)
        .execute();
      await this.record(trx, projectId, 'inbox.resolved', row.id, {
        inboxId: row.id,
        sourceId,
        kind,
      });
    }
  }
}
