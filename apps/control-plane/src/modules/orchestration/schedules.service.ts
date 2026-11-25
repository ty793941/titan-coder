import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { DomainError, orchestrationPageSchema, scheduleCreateRequestSchema, scheduleUpdateRequestSchema, scheduleVersionRequestSchema, scheduleOccurrenceRequestSchema, scheduleSchema, type ErrorCode } from '@titan/contracts';
import type { Selectable, Transaction } from 'kysely';
import { DatabaseService } from '../../database/database.service.js';
import type { Database, ExecutionScheduleTable } from '../../database/types.js';
import { IdempotencyService } from '../../common/idempotency.service.js';
import { EventsService } from '../events/events.service.js';
import { BackgroundJobsService } from './background-jobs.service.js';
import { WorkflowCommandsService } from './workflow-commands.service.js';
import { lockSession, lockSchedule, requireAssignedWorker, validateLocalSession } from './orchestration-policy.js';

type Definition = ReturnType<typeof scheduleUpdateRequestSchema.parse>;
const definitionColumns = (input: Omit<Definition, 'expectedVersion'>) => ({
  plan_hash: input.planHash, timezone: input.timezone, cron: input.cron ?? null, interval_seconds: input.intervalSeconds ?? null,
  starts_at: new Date(input.startsAt), ends_at: new Date(input.endsAt), max_runs: input.maxRuns,
  overlap_policy: input.overlapPolicy, catchup_window_seconds: input.catchupWindowSeconds,
});

@Injectable()
export class SchedulesService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(IdempotencyService) private readonly idempotency: IdempotencyService,
    @Inject(EventsService) private readonly events: EventsService,
    @Inject(BackgroundJobsService) private readonly jobs: BackgroundJobsService,
    @Inject(WorkflowCommandsService) private readonly commands: WorkflowCommandsService,
  ) {}

  async create(sessionId: string, input: unknown) {
    const parsed = scheduleCreateRequestSchema.parse(input);
    return this.database.db.transaction().execute(async trx => {
      const session = await lockSession(trx, sessionId);
      const scope = `session:${sessionId}:schedule:create`;
      const previous = await this.idempotency.read(trx, scope, parsed.idempotencyKey, parsed);
      if (previous) return previous;
      await validateLocalSession(trx, session, parsed.planHash);
      if (Date.parse(parsed.endsAt) <= Date.now()) throw new DomainError('VALIDATION_FAILED', 'schedule must end in the future');
      const task = await trx.selectFrom('task').select('project_id').where('id', '=', session.task_id).executeTakeFirstOrThrow();
      const id = `schedule_${randomUUID()}`;
      const row = await trx.insertInto('execution_schedule').values({ id, project_id: task.project_id, task_id: session.task_id,
        session_id: sessionId, ...definitionColumns(parsed), temporal_schedule_id: id, requested_by: 'local-user',
      }).returningAll().executeTakeFirstOrThrow();
      await this.commands.enqueue(trx, 'sync_schedule', id, row.version);
      await this.event(trx, row, 'schedule.created');
      const view = this.toView(row);
      await this.idempotency.write(trx, scope, parsed.idempotencyKey, parsed, view, 201);
      return view;
    });
  }

  async get(id: string, workerId?: string) {
    const row = await this.database.db.selectFrom('execution_schedule').selectAll().where('id', '=', id).executeTakeFirst();
    if (!row) throw new DomainError('RESOURCE_NOT_FOUND', 'schedule was not found');
    if (workerId !== undefined) requireAssignedWorker(row.worker_id, workerId);
    return this.toView(row);
  }

  async list(sessionId: string, query: unknown) {
    const page = orchestrationPageSchema.parse(query);
    if (!await this.database.db.selectFrom('session').select('id').where('id', '=', sessionId).executeTakeFirst()) throw new DomainError('RESOURCE_NOT_FOUND', 'session was not found');
    return (await this.database.db.selectFrom('execution_schedule').selectAll().where('session_id', '=', sessionId)
      .orderBy('created_at', 'desc').orderBy('id', 'asc').limit(page.limit).offset(page.offset).execute()).map(row => this.toView(row));
  }

  async change(id: string, action: 'update' | 'enable' | 'pause', input: unknown) {
    const parsed = action === 'update' ? scheduleUpdateRequestSchema.parse(input) : scheduleVersionRequestSchema.parse(input);
    return this.database.db.transaction().execute(async trx => {
      const { row, session } = await this.lock(trx, id);
      if (row.version !== parsed.expectedVersion) throw new DomainError('VERSION_CONFLICT', 'schedule definition version changed');
      if (action !== 'pause') {
        const definition = action === 'update' ? parsed as Definition : undefined;
        await validateLocalSession(trx, session, definition?.planHash ?? row.plan_hash);
        if ((definition ? Date.parse(definition.endsAt) : row.ends_at.getTime()) <= Date.now()) throw new DomainError('VALIDATION_FAILED', 'schedule has ended');
        if (definition && definition.maxRuns < row.run_count) throw new DomainError('VALIDATION_FAILED', 'maxRuns cannot be less than consumed runs');
      }
      const updated = await trx.updateTable('execution_schedule').set({
        ...(action === 'update' ? definitionColumns(parsed as Definition) : {}),
        enabled: action === 'enable' ? true : action === 'pause' ? false : row.enabled,
        version: row.version + 1, sync_status: 'pending_sync',
      }).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
      await this.commands.enqueue(trx, 'sync_schedule', id, updated.version);
      await this.event(trx, updated, `schedule.${action}`);
      return this.toView(updated);
    });
  }

  async occurrence(id: string, input: unknown, workerId: string) {
    const parsed = scheduleOccurrenceRequestSchema.parse(input);
    return this.database.db.transaction().execute(async trx => {
      const { row, session } = await this.lock(trx, id);
      requireAssignedWorker(row.worker_id, workerId);
      const existing = await trx.selectFrom('schedule_occurrence').selectAll().where('occurrence_id', '=', parsed.occurrenceId).executeTakeFirst();
      if (existing) {
        if (existing.schedule_id !== id || existing.definition_version !== parsed.definitionVersion || existing.scheduled_at.getTime() !== Date.parse(parsed.scheduledAt)) {
          throw new DomainError('IDEMPOTENCY_CONFLICT', 'occurrence identity was already used with a different definition');
        }
        return existing.job_id && existing.status !== 'skipped' ? { status: 'created' as const, jobId: existing.job_id } : { status: 'skipped' as const };
      }
      const sameTime = await trx.selectFrom('schedule_occurrence').select('id').where('schedule_id', '=', id)
        .where('definition_version', '=', parsed.definitionVersion).where('scheduled_at', '=', new Date(parsed.scheduledAt)).executeTakeFirst();
      if (sameTime) return { status: 'skipped' as const };
      let reason = await this.jobs.scheduleGate(trx, session, row, parsed.definitionVersion);
      const now = Date.now(); const scheduledAt = Date.parse(parsed.scheduledAt); const lateMs = now - scheduledAt;
      if (!reason && (scheduledAt < row.starts_at.getTime() || scheduledAt >= row.ends_at.getTime() || scheduledAt > now || lateMs > row.catchup_window_seconds * 1000)) reason = 'SCHEDULE_OUTSIDE_WINDOW';
      // 超过10秒的投递延迟视为补投，同一恢复窗口内最多接纳一次，由调度行锁原子保护。
      const catchup = lateMs > 10000;
      if (!reason && catchup && row.catchup_until && row.catchup_until.getTime() > now) reason = 'SCHEDULE_CATCHUP_SKIPPED';
      let jobId: string | null = null;
      if (!reason) {
        const { config } = await validateLocalSession(trx, session, row.plan_hash);
        const job = await this.jobs.insert(trx, session, { kind: 'run', planHash: row.plan_hash,
          deadlineAt: new Date(now + config.timeoutMs), scheduleId: id,
          definitionVersion: parsed.definitionVersion, workflowId: parsed.occurrenceId, workerId,
        });
        jobId = job.id;
        if (catchup) await trx.updateTable('execution_schedule').set({ catchup_until: new Date(now + row.catchup_window_seconds * 1000) }).where('id', '=', id).execute();
      }
      await trx.insertInto('schedule_occurrence').values({ id: `occurrence_${randomUUID()}`, schedule_id: id,
        definition_version: parsed.definitionVersion, occurrence_id: parsed.occurrenceId, scheduled_at: new Date(parsed.scheduledAt),
        job_id: jobId, status: reason ? 'skipped' : 'created', error_code: reason ?? null,
      }).execute();
      await this.event(trx, row, reason ? 'schedule.occurrence_skipped' : 'schedule.occurrence_created', { occurrenceId: parsed.occurrenceId, ...(reason ? { errorCode: reason } : { jobId }) });
      return jobId ? { status: 'created' as const, jobId } : { status: 'skipped' as const };
    });
  }

  private async lock(trx: Transaction<Database>, id: string) {
    return (await lockSchedule(trx, id))!;
  }

  private toView(row: Selectable<ExecutionScheduleTable>) {
    return scheduleSchema.parse({ id: row.id, sessionId: row.session_id, planHash: row.plan_hash, timezone: row.timezone,
      ...(row.cron ? { cron: row.cron } : { intervalSeconds: row.interval_seconds }), startsAt: row.starts_at.toISOString(), endsAt: row.ends_at.toISOString(),
      maxRuns: row.max_runs, runCount: row.run_count, overlapPolicy: row.overlap_policy, catchupWindowSeconds: row.catchup_window_seconds,
      enabled: row.enabled, version: row.version, syncStatus: row.sync_status, temporalScheduleId: row.temporal_schedule_id, createdAt: row.created_at.toISOString(),
    });
  }

  private async event(trx: Transaction<Database>, row: Selectable<ExecutionScheduleTable>, eventType: string, extra: { occurrenceId?: string; errorCode?: ErrorCode; jobId?: string | null } = {}) {
    await this.events.append(trx, { eventType, projectId: row.project_id, taskId: row.task_id, sessionId: row.session_id,
      actor: { type: 'system', id: 'control-plane' }, payload: { scheduleId: row.id, version: row.version, enabled: row.enabled, ...extra } });
  }
}
