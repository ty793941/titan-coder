import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { DomainError, backgroundJobCreateRequestSchema, backgroundJobSchema, jobExecutionSchema, jobObservationSchema, orchestrationErrorCodeSchema, orchestrationPageSchema, type ErrorCode } from '@titan/contracts';
import { sql, type Selectable, type Transaction } from 'kysely';
import { DatabaseService } from '../../database/database.service.js';
import type { BackgroundJobTable, Database, ExecutionScheduleTable, SessionTable } from '../../database/types.js';
import { IdempotencyService } from '../../common/idempotency.service.js';
import { RunsService, type RunCancellationActor } from '../runs/runs.service.js';
import { EventsService } from '../events/events.service.js';
import { WorkflowCommandsService } from './workflow-commands.service.js';
import { lockSession, hasActiveRun, validateLocalSession } from './orchestration-policy.js';

const terminal = ['completed', 'failed', 'cancelled', 'expired'];

@Injectable()
export class BackgroundJobsService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(IdempotencyService) private readonly idempotency: IdempotencyService,
    @Inject(RunsService) private readonly runs: RunsService,
    @Inject(EventsService) private readonly events: EventsService,
    @Inject(WorkflowCommandsService) private readonly commands: WorkflowCommandsService,
  ) {}

  async create(sessionId: string, input: unknown) {
    const parsed = backgroundJobCreateRequestSchema.parse(input);
    return this.database.db.transaction().execute(async trx => {
      const session = await lockSession(trx, sessionId);
      const scope = `session:${sessionId}:background:create`;
      const previous = await this.idempotency.read(trx, scope, parsed.idempotencyKey, parsed);
      if (previous) return previous;
      if (Date.parse(parsed.deadlineAt) <= Date.now() || Date.parse(parsed.deadlineAt) > Date.now() + 86400000) throw new DomainError('VALIDATION_FAILED', 'deadline must be in the next 24 hours');
      if (parsed.planHash !== session.plan_hash) throw new DomainError('PLAN_HASH_STALE', 'background job plan does not match the session');
      if (parsed.kind === 'run') {
        await validateLocalSession(trx, session, parsed.planHash);
      } else {
        const run = await trx.selectFrom('run').selectAll().where('id', '=', parsed.runId!).executeTakeFirst();
        if (!run || run.session_id !== sessionId) throw new DomainError('VALIDATION_FAILED', 'observed run must belong to the same session');
        if (await trx.selectFrom('background_job').select('id').where('run_id', '=', run.id).executeTakeFirst()) throw new DomainError('VERSION_CONFLICT', 'run already has a background job');
      }
      const row = await this.insert(trx, session, { kind: parsed.kind, planHash: parsed.planHash, deadlineAt: new Date(parsed.deadlineAt), ...(parsed.runId ? { runId: parsed.runId } : {}) });
      await this.commands.enqueue(trx, 'start_job', row.id);
      const view = this.toView(row);
      await this.idempotency.write(trx, scope, parsed.idempotencyKey, parsed, view, 201);
      return view;
    });
  }

  async insert(trx: Transaction<Database>, session: Selectable<SessionTable>, input: {
    kind: 'run' | 'observe'; planHash: string; deadlineAt: Date; runId?: string;
    scheduleId?: string; definitionVersion?: number; workflowId?: string;
  }) {
    const task = await trx.selectFrom('task').select('project_id').where('id', '=', session.task_id).executeTakeFirstOrThrow();
    const id = `bg_${randomUUID()}`;
    const row = await trx.insertInto('background_job').values({
      id, project_id: task.project_id, task_id: session.task_id, session_id: session.id,
      kind: input.kind, run_id: input.runId ?? null, schedule_id: input.scheduleId ?? null, definition_version: input.definitionVersion ?? null,
      workflow_id: input.workflowId ?? `titan/background/${id}/v1`, deadline_at: input.deadlineAt, plan_hash: input.planHash, requested_by: 'local-user',
    }).returningAll().executeTakeFirstOrThrow();
    await this.event(trx, row, 'background_job.created');
    return row;
  }

  async get(id: string) {
    return this.database.db.transaction().execute(async trx => {
      const { row } = await this.lock(trx, id);
      return this.toView(await this.refresh(trx, row));
    });
  }

  async observe(id: string) {
    const view = await this.get(id);
    return jobObservationSchema.parse({ jobId: view.jobId, status: view.status, deadlineAt: view.deadlineAt, ...(view.runId ? { runId: view.runId } : {}), ...(view.errorCode ? { errorCode: view.errorCode } : {}) });
  }

  async execution(id: string) {
    const row = await this.database.db.selectFrom('background_job as job')
      .innerJoin('session', 'session.id', 'job.session_id')
      .innerJoin('task', 'task.id', 'session.task_id')
      .leftJoin('run', 'run.id', 'job.run_id')
      .leftJoin('execution_schedule as schedule', 'schedule.id', 'job.schedule_id')
      .leftJoin('schedule_occurrence as occurrence', 'occurrence.job_id', 'job.id')
      .select(['job.id', 'job.workflow_id', 'job.workflow_version'])
      .where('job.id', '=', id).whereRef('job.task_id', '=', 'task.id').whereRef('job.project_id', '=', 'task.project_id')
      .where(eb => eb.or([eb('job.run_id', 'is', null), eb('run.session_id', '=', eb.ref('session.id'))]))
      .where(eb => eb.or([
        eb.and([eb('job.schedule_id', 'is', null), eb('job.workflow_id', '=', `titan/background/${id}/v1`)]),
        eb.and([
          eb('schedule.session_id', '=', eb.ref('session.id')), eb('schedule.task_id', '=', eb.ref('task.id')),
          eb('schedule.project_id', '=', eb.ref('task.project_id')), eb('occurrence.schedule_id', '=', eb.ref('schedule.id')),
          eb('occurrence.definition_version', '=', eb.ref('job.definition_version')), eb('occurrence.occurrence_id', '=', eb.ref('job.workflow_id')),
        ]),
      ])).executeTakeFirst();
    if (!row) throw new DomainError('RESOURCE_NOT_FOUND', 'background job execution was not found');
    return jobExecutionSchema.parse({ jobId: row.id, workflowId: row.workflow_id, workflowVersion: row.workflow_version });
  }

  async list(sessionId: string, query: unknown) {
    const page = orchestrationPageSchema.parse(query);
    if (!await this.database.db.selectFrom('session').select('id').where('id', '=', sessionId).executeTakeFirst()) throw new DomainError('RESOURCE_NOT_FOUND', 'session was not found');
    const rows = await this.database.db.selectFrom('background_job').select('id').where('session_id', '=', sessionId).orderBy('created_at', 'desc').orderBy('id', 'asc').limit(page.limit).offset(page.offset).execute();
    const views = [];
    for (const row of rows) views.push(await this.get(row.id));
    return views;
  }

  async dispatch(id: string) {
    await this.database.db.transaction().execute(async trx => {
      const { row, session, schedule } = await this.lock(trx, id);
      if (terminal.includes(row.status) || row.cancel_requested) return;
      if (row.deadline_at.getTime() <= Date.now()) { await this.cancelLocked(trx, row, 'expired'); return; }
      if (row.run_id) { await this.refresh(trx, row); return; }
      if (schedule) {
        const reason = await this.scheduleGate(trx, session, schedule, row.definition_version!);
        if (reason) { await this.skipScheduled(trx, row, reason); return; }
      } else {
        try { await validateLocalSession(trx, session, row.plan_hash); }
        catch (error) {
          if (!(error instanceof DomainError) || error.code === 'DAEMON_UNAVAILABLE') throw error;
          await trx.updateTable('background_job').set({ status: 'failed', error_code: error.code, version: row.version + 1 }).where('id', '=', id).execute();
          await this.event(trx, { ...row, status: 'failed', error_code: error.code }, 'background_job.failed');
          return;
        }
      }
      const run = await this.runs.createInTransaction(trx, session.id, { planHash: row.plan_hash, idempotencyKey: row.id }, { idempotencyScope: `background:${row.id}:dispatch` });
      await trx.updateTable('background_job').set({ run_id: run.id, status: 'dispatching', version: row.version + 1 }).where('id', '=', id).execute();
      if (schedule) {
        await trx.updateTable('execution_schedule').set({ run_count: schedule.run_count + 1 }).where('id', '=', schedule.id).execute();
        await trx.updateTable('schedule_occurrence').set({ status: 'dispatched' }).where('job_id', '=', id).execute();
      }
      await this.event(trx, { ...row, run_id: run.id, status: 'dispatching' }, 'background_job.dispatched');
    });
    return this.observe(id);
  }

  async cancel(id: string, reason: 'cancelled' | 'expired' = 'cancelled', enqueue = true, actor: RunCancellationActor = { type: 'user', id: 'local-user' }) {
    await this.database.db.transaction().execute(async trx => {
      const { row } = await this.lock(trx, id);
      const current = await this.refresh(trx, row);
      if (terminal.includes(current.status)) return;
      if (reason === 'expired' && current.deadline_at.getTime() > Date.now()) throw new DomainError('INVALID_STATE_TRANSITION', 'job has not reached its persisted deadline');
      await this.cancelLocked(trx, current, reason, actor);
      if (enqueue) await this.commands.enqueue(trx, 'cancel_job', id);
    });
    return this.get(id);
  }

  async scheduleGate(trx: Transaction<Database>, session: Selectable<SessionTable>, schedule: Selectable<ExecutionScheduleTable>, definitionVersion: number): Promise<ErrorCode | undefined> {
    if (schedule.version !== definitionVersion) return 'SCHEDULE_DEFINITION_SUPERSEDED';
    if (!schedule.enabled) return 'SCHEDULE_DISABLED';
    if (Date.now() < schedule.starts_at.getTime() || Date.now() >= schedule.ends_at.getTime()) return 'SCHEDULE_OUTSIDE_WINDOW';
    try { await validateLocalSession(trx, session, schedule.plan_hash); }
    catch (error) {
      if (!(error instanceof DomainError)) throw error;
      if (error.code === 'DAEMON_UNAVAILABLE') throw error;
      await trx.updateTable('execution_schedule').set({ enabled: false, sync_status: 'blocked', version: schedule.version + 1 }).where('id', '=', schedule.id).execute();
      await this.commands.enqueue(trx, 'sync_schedule', schedule.id, schedule.version + 1);
      await this.events.append(trx, { eventType: 'schedule.blocked', projectId: schedule.project_id, taskId: schedule.task_id, sessionId: schedule.session_id, actor: { type: 'system', id: 'control-plane' }, payload: { scheduleId: schedule.id, errorCode: error.code } });
      return error.code;
    }
    if (schedule.run_count >= schedule.max_runs) return 'SCHEDULE_MAX_RUNS_REACHED';
    if (await hasActiveRun(trx, session.id)) return 'SCHEDULE_OVERLAP';
    return undefined;
  }

  private async lock(trx: Transaction<Database>, id: string) {
    // 先串行化同一后台任务，再按Daemon既有job→run→session顺序锁定，避免进度/取消死锁。
    await sql`select pg_advisory_xact_lock(hashtextextended(${`background:${id}`}, 0))`.execute(trx);
    const source = await trx.selectFrom('background_job').select(['session_id', 'schedule_id', 'run_id']).where('id', '=', id).executeTakeFirst();
    if (!source) throw new DomainError('RESOURCE_NOT_FOUND', 'background job was not found');
    if (source.run_id) {
      await trx.selectFrom('execution_job').select('id').where('run_id', '=', source.run_id).forUpdate().execute();
      await trx.selectFrom('run').select('id').where('id', '=', source.run_id).forNoKeyUpdate().execute();
    }
    const session = await lockSession(trx, source.session_id);
    const schedule = source.schedule_id ? await trx.selectFrom('execution_schedule').selectAll().where('id', '=', source.schedule_id).forUpdate().executeTakeFirstOrThrow() : undefined;
    const row = await trx.selectFrom('background_job').selectAll().where('id', '=', id).forUpdate().executeTakeFirstOrThrow();
    return { row, session, schedule };
  }

  private async refresh(trx: Transaction<Database>, row: Selectable<BackgroundJobTable>) {
    if (!row.run_id || terminal.includes(row.status) || row.cancel_requested) return row;
    const run = await trx.selectFrom('run').select(['status', 'error_code']).where('id', '=', row.run_id).executeTakeFirstOrThrow();
    const status = ['queued', 'starting'].includes(run.status) ? 'dispatching' : run.status === 'paused' ? 'waiting_input' : run.status;
    const safe = orchestrationErrorCodeSchema.safeParse(run.error_code);
    const errorCode = run.error_code ? safe.success ? safe.data : 'TOOL_EXECUTION_FAILED' : null;
    if (status === row.status && errorCode === row.error_code) return row;
    jobObservationSchema.shape.status.parse(status);
    const updated = await trx.updateTable('background_job').set({ status, error_code: errorCode, version: row.version + 1 }).where('id', '=', row.id).returningAll().executeTakeFirstOrThrow();
    await this.event(trx, updated, 'background_job.observed');
    return updated;
  }

  private async cancelLocked(trx: Transaction<Database>, row: Selectable<BackgroundJobTable>, reason: 'cancelled' | 'expired', actor: RunCancellationActor = { type: 'system', id: 'control-plane' }) {
    if (row.run_id) await this.runs.cancelInTransaction(trx, row.run_id, actor);
    await trx.updateTable('background_job').set({ status: reason, cancel_requested: true, error_code: reason === 'expired' ? 'BACKGROUND_JOB_EXPIRED' : null, version: row.version + 1 }).where('id', '=', row.id).execute();
    await this.event(trx, { ...row, status: reason }, 'background_job.cancel_requested', actor);
  }

  private async skipScheduled(trx: Transaction<Database>, row: Selectable<BackgroundJobTable>, reason: ErrorCode) {
    await trx.updateTable('background_job').set({ status: 'cancelled', cancel_requested: true, error_code: reason, version: row.version + 1 }).where('id', '=', row.id).execute();
    await trx.updateTable('schedule_occurrence').set({ status: 'skipped', error_code: reason }).where('job_id', '=', row.id).execute();
    await this.event(trx, { ...row, status: 'cancelled', error_code: reason }, 'schedule.occurrence_skipped');
  }

  private toView(row: Selectable<BackgroundJobTable>) {
    return backgroundJobSchema.parse({ jobId: row.id, projectId: row.project_id, taskId: row.task_id, sessionId: row.session_id,
      kind: row.kind, status: row.status, deadlineAt: row.deadline_at.toISOString(), planHash: row.plan_hash, workflowId: row.workflow_id,
      workflowVersion: row.workflow_version, cancelRequested: row.cancel_requested, version: row.version, createdAt: row.created_at.toISOString(),
      ...(row.run_id ? { runId: row.run_id } : {}), ...(row.error_code ? { errorCode: row.error_code } : {}),
    });
  }

  private async event(trx: Transaction<Database>, row: Selectable<BackgroundJobTable>, eventType: string, actor: RunCancellationActor = { type: 'system', id: 'control-plane' }) {
    await this.events.append(trx, { eventType, projectId: row.project_id, taskId: row.task_id, sessionId: row.session_id,
      actor, payload: { jobId: row.id, status: row.status, ...(row.run_id ? { runId: row.run_id } : {}), ...(row.error_code ? { errorCode: row.error_code } : {}) } });
  }
}
