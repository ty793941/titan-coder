import { randomBytes, randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { DomainError, workflowCommandSchema, workflowRetryRequestSchema, type WorkflowCommand } from '@titan/contracts';
import { sql, type Selectable, type Transaction } from 'kysely';
import { DatabaseService } from '../../database/database.service.js';
import type { BackgroundJobTable, Database, ExecutionScheduleTable } from '../../database/types.js';
import { canonicalJson, sameToken, tokenHash } from '../daemons/execution-policy.js';
import { EventsService } from '../events/events.service.js';
import { lockBackgroundJob, lockSchedule } from './orchestration-policy.js';

@Injectable()
export class WorkflowCommandsService {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService, @Inject(EventsService) private readonly events: EventsService) {}

  async enqueue(trx: Transaction<Database>, kind: WorkflowCommand['kind'], targetId: string, definitionVersion?: number): Promise<void> {
    const request = { kind, targetId, ...(definitionVersion ? { definitionVersion } : {}) };
    await trx.insertInto('workflow_command').values({
      id: `cmd_${randomUUID()}`, kind, target_id: targetId, definition_version: definitionVersion ?? null,
      idempotency_key: `${kind}:${targetId}:${definitionVersion ?? 1}`, request_hash: tokenHash(canonicalJson(request)),
    }).onConflict(oc => oc.column('idempotency_key').doNothing()).execute();
  }

  async claim(workerId: string): Promise<WorkflowCommand | undefined> {
    return this.database.db.transaction().execute(async trx => {
      const now = new Date();
      // 不撤销尚有效的外部投递租约；旧版本待投递或过期命令仅标记obsolete，不修改同步状态。
      const obsolete = await trx.selectFrom('workflow_command').select('id')
        .where('kind', '=', 'sync_schedule').where(eb => eb.or([
          eb('status', '=', 'pending'), eb.and([eb('status', '=', 'claimed'), eb('lease_expires_at', '<=', now)]),
        ])).where(eb => eb.exists(eb.selectFrom('execution_schedule').select('id')
          .whereRef('execution_schedule.id', '=', 'workflow_command.target_id')
          .whereRef('execution_schedule.version', '>', 'workflow_command.definition_version')))
        .orderBy('id', 'asc').limit(100).forUpdate().skipLocked().execute();
      if (obsolete.length) await trx.updateTable('workflow_command')
        .set({ status: 'completed', error_code: 'SCHEDULE_DEFINITION_SUPERSEDED', claim_token_hash: null, lease_expires_at: null })
        .where('id', 'in', obsolete.map(row => row.id)).execute();
      const exhausted = await trx.selectFrom('workflow_command').selectAll()
        .where('status', '=', 'claimed').where('lease_expires_at', '<=', now).where('attempts', '>=', 10)
        .orderBy('id', 'asc').limit(100).forUpdate().skipLocked().execute();
      for (const row of exhausted) {
        const target = row.kind === 'start_job' ? await lockBackgroundJob(trx, row.target_id, true) : undefined;
        if (row.kind === 'start_job' && !target) continue;
        const schedule = row.kind === 'sync_schedule' ? await lockSchedule(trx, row.target_id, true) : undefined;
        if (row.kind === 'sync_schedule' && !schedule) continue;
        await trx.updateTable('workflow_command')
          .set({ status: 'failed', error_code: 'WORKFLOW_COMMAND_FAILED', claim_token_hash: null, lease_expires_at: null })
          .where('id', '=', row.id).execute();
        if (target) await this.failUnexecuted(trx, target.row);
        if (schedule) await this.failScheduleSync(trx, schedule.row, row.definition_version!);
      }
      const candidates = await trx.selectFrom('workflow_command').selectAll().where('attempts', '<', 10)
        .where(eb => eb.or([
          eb.and([eb('status', '=', 'pending'), eb('next_attempt_at', '<=', now)]),
          eb.and([eb('status', '=', 'claimed'), eb('lease_expires_at', '<=', now)]),
        ])).where(eb => eb.or([
          eb('kind', '!=', 'sync_schedule'),
          eb.and([
            eb.exists(eb.selectFrom('execution_schedule').select('id')
              .whereRef('execution_schedule.id', '=', 'workflow_command.target_id')
              .whereRef('execution_schedule.version', '=', 'workflow_command.definition_version')),
            eb.not(eb.exists(eb.selectFrom('workflow_command as active').select('active.id')
              .whereRef('active.target_id', '=', 'workflow_command.target_id').where('active.kind', '=', 'sync_schedule')
              .where('active.status', '=', 'claimed').where('active.lease_expires_at', '>', now))),
          ]),
        ])).orderBy('created_at', 'asc').orderBy('id', 'asc').limit(100).forUpdate().skipLocked().execute();
      for (const row of candidates) {
        if (row.kind === 'sync_schedule') {
          const lock = await sql<{ acquired: boolean }>`select pg_try_advisory_xact_lock(hashtextextended(${`schedule-command:${row.target_id}`}, 0)) as acquired`.execute(trx);
          if (!lock.rows[0]?.acquired) continue;
          const schedule = await trx.selectFrom('execution_schedule').select('version').where('id', '=', row.target_id).executeTakeFirst();
          if (schedule?.version !== row.definition_version) continue;
          const active = await trx.selectFrom('workflow_command').select('id').where('kind', '=', 'sync_schedule')
            .where('target_id', '=', row.target_id).where('status', '=', 'claimed').where('lease_expires_at', '>', new Date()).executeTakeFirst();
          if (active) continue;
        }
        if (row.kind === 'sync_schedule') {
          const target = await lockSchedule(trx, row.target_id, true);
          if (!target || target.row.version !== row.definition_version || (target.row.worker_id && target.row.worker_id !== workerId)) continue;
          await trx.updateTable('execution_schedule').set({ worker_id: workerId }).where('id', '=', row.target_id).execute();
        } else {
          const target = await lockBackgroundJob(trx, row.target_id, true);
          if (!target || (target.row.worker_id && target.row.worker_id !== workerId)) continue;
          await trx.updateTable('background_job').set({ worker_id: workerId }).where('id', '=', row.target_id).execute();
        }
        const claimToken = randomBytes(32).toString('hex');
        await trx.updateTable('workflow_command').set({ status: 'claimed', attempts: row.attempts + 1, worker_id: workerId,
          claim_token_hash: tokenHash(claimToken), lease_expires_at: new Date(Date.now() + 30000) }).where('id', '=', row.id).execute();
        return workflowCommandSchema.parse({ id: row.id, claimToken, kind: row.kind, targetId: row.target_id, ...(row.definition_version ? { definitionVersion: row.definition_version } : {}) });
      }
      return undefined;
    });
  }

  async acknowledge(id: string, claimToken: string, workerId: string, retry?: ReturnType<typeof workflowRetryRequestSchema.parse>): Promise<void> {
    await this.database.db.transaction().execute(async trx => {
      const source = await trx.selectFrom('workflow_command').select(['kind', 'target_id']).where('id', '=', id).executeTakeFirst();
      if (!source) throw new DomainError('RESOURCE_NOT_FOUND', 'workflow command was not found');
      // ACK先取得领域锁，避免与领域事务内的enqueue形成command→session反向等待。
      const job = source.kind === 'start_job' ? await lockBackgroundJob(trx, source.target_id) : undefined;
      const schedule = source.kind === 'sync_schedule' ? await lockSchedule(trx, source.target_id) : undefined;
      const row = await trx.selectFrom('workflow_command').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
      if (!row) throw new DomainError('RESOURCE_NOT_FOUND', 'workflow command was not found');
      if (!retry && row.status === 'completed' && row.worker_id === workerId && sameToken(claimToken, row.claim_token_hash)) return;
      if (row.status !== 'claimed' || row.worker_id !== workerId || !sameToken(claimToken, row.claim_token_hash) || !row.lease_expires_at || row.lease_expires_at.getTime() <= Date.now()) {
        throw new DomainError('WORKFLOW_COMMAND_LEASE_EXPIRED', 'workflow command lease is no longer valid');
      }
      const status = !retry ? 'completed' : retry.retryable && row.attempts < 10 ? 'pending' : 'failed';
      await trx.updateTable('workflow_command').set({ status, claim_token_hash: !retry ? row.claim_token_hash : null, lease_expires_at: null,
        error_code: retry?.errorCode ?? null, next_attempt_at: new Date(Date.now() + Math.min(300000, 1000 * 2 ** (row.attempts - 1))) }).where('id', '=', id).execute();
      if (status === 'failed' && job) await this.failUnexecuted(trx, job.row);
      if (status === 'failed' && schedule) await this.failScheduleSync(trx, schedule.row, row.definition_version!);
      if (!retry && row.kind === 'sync_schedule') {
        await trx.updateTable('execution_schedule').set(eb => ({ sync_status: eb.case().when('enabled', '=', true).then('active').else('paused').end() }))
          .where('id', '=', row.target_id).where('version', '=', row.definition_version!).where('sync_status', '=', 'pending_sync').execute();
      }
    });
  }

  private async failUnexecuted(trx: Transaction<Database>, job: Selectable<BackgroundJobTable>) {
    if (job.run_id || job.cancel_requested || ['completed', 'failed', 'cancelled', 'expired'].includes(job.status)) return;
    await trx.updateTable('background_job').set({ status: 'failed', error_code: 'WORKFLOW_COMMAND_FAILED', version: job.version + 1 }).where('id', '=', job.id).execute();
    await this.events.append(trx, { eventType: 'background_job.failed', projectId: job.project_id, taskId: job.task_id, sessionId: job.session_id,
      actor: { type: 'system', id: 'control-plane' }, payload: { jobId: job.id, status: 'failed', errorCode: 'WORKFLOW_COMMAND_FAILED' } });
  }

  private async failScheduleSync(trx: Transaction<Database>, schedule: Selectable<ExecutionScheduleTable>, definitionVersion: number) {
    if (schedule.version !== definitionVersion) return;
    await trx.updateTable('execution_schedule').set({ sync_status: 'blocked' }).where('id', '=', schedule.id).where('version', '=', definitionVersion).execute();
    await this.events.append(trx, { eventType: 'schedule.sync_failed', projectId: schedule.project_id, taskId: schedule.task_id, sessionId: schedule.session_id,
      actor: { type: 'system', id: 'control-plane' }, payload: { scheduleId: schedule.id, version: definitionVersion, errorCode: 'WORKFLOW_COMMAND_FAILED' } });
  }
}
