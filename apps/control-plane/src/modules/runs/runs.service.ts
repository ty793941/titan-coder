import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Inject, Injectable } from '@nestjs/common';
import { DomainError, executionConfigSchema, runCreateRequestSchema } from '@titan/contracts';
import type { Run } from '@titan/domain';
import type { Transaction } from 'kysely';
import { DatabaseService } from '../../database/database.service.js';
import type { Database } from '../../database/types.js';
import { IdempotencyService } from '../../common/idempotency.service.js';
import { EventsService } from '../events/events.service.js';
import { latestApprovedPlan, validateExecution } from '../daemons/execution-policy.js';
import { CloudExecutionsService } from '../cloud-executions/cloud-executions.service.js';
import { authenticateConsole } from '../../common/console-auth.js';

type CreateRunOptions = {
  allowPaused?: boolean;
  idempotencyScope?: string;
  resumeFromRunId?: string;
};

@Injectable()
export class RunsService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(IdempotencyService) private readonly idempotency: IdempotencyService,
    @Inject(EventsService) private readonly events: EventsService,
    @Inject(CloudExecutionsService) private readonly cloud: CloudExecutionsService,
  ) {}

  async create(sessionId: string, input: unknown, headerKey?: string, options: CreateRunOptions = {}): Promise<Run> {
    const source = z.record(z.unknown()).parse(input === undefined ? {} : input);
    const parsed = runCreateRequestSchema.parse({ ...source, idempotencyKey: headerKey ?? source.idempotencyKey });
    return this.database.db.transaction().execute(trx => this.createInTransaction(trx, sessionId, parsed, options));
  }

  async resume(runId: string, input: unknown, headerKey?: string, authorization?: string): Promise<Run> {
    const source = z.record(z.unknown()).parse(input === undefined ? {} : input);
    const parsed = runCreateRequestSchema.parse({ ...source, idempotencyKey: headerKey ?? source.idempotencyKey });
    const scope = `run:${runId}:resume`;
    return this.database.db.transaction().execute(async trx => {
      const sourceRun = await trx.selectFrom('run').select(['id', 'session_id']).where('id', '=', runId).executeTakeFirst();
      if (!sourceRun) throw new DomainError('RESOURCE_NOT_FOUND', `run ${runId} was not found`);
      await this.authorizeCloudRun(trx, sourceRun.session_id, authorization);
      const run = await this.createInTransaction(trx, sourceRun.session_id, parsed, {
        allowPaused: true,
        idempotencyScope: scope,
        resumeFromRunId: runId,
      });
      return run;
    });
  }

  private async createInTransaction(
    trx: Transaction<Database>,
    sessionId: string,
    parsed: z.infer<typeof runCreateRequestSchema>,
    options: CreateRunOptions,
  ): Promise<Run> {
    const session = await trx.selectFrom('session').selectAll().where('id', '=', sessionId).forUpdate().executeTakeFirst();
    if (!session) throw new DomainError('RESOURCE_NOT_FOUND', `session ${sessionId} was not found`);
    const existing = await this.idempotency.read<Run>(trx, options.idempotencyScope ?? `session:${sessionId}:run:create`, parsed.idempotencyKey, parsed);
    if (existing) return existing;
    if (session.environment_type === 'cloud') throw new DomainError('INVALID_STATE_TRANSITION', 'cloud attempts require a new authorized handoff');
    if (options.resumeFromRunId) {
      const sourceRun = await trx.selectFrom('run').selectAll().where('id', '=', options.resumeFromRunId).forUpdate().executeTakeFirst();
      if (!sourceRun || sourceRun.session_id !== sessionId) throw new DomainError('RESOURCE_NOT_FOUND', `run ${options.resumeFromRunId} was not found`);
      if (sourceRun.status !== 'paused') throw new DomainError('INVALID_STATE_TRANSITION', `run ${options.resumeFromRunId} cannot resume from ${sourceRun.status}`);
    }
    if (parsed.planHash && parsed.planHash !== session.plan_hash) throw new DomainError('PLAN_HASH_STALE', 'run plan must match the session plan');
    const plan = session.plan_hash ? await latestApprovedPlan(trx, session.task_id, session.plan_hash) : undefined;
    const config = session.execution_config ? executionConfigSchema.parse(session.execution_config) : undefined;
    if (config) {
      if (!plan) throw new DomainError('PLAN_HASH_STALE', 'execution requires an approved plan');
      await validateExecution(trx, config);
    }
    let checkpointId = parsed.checkpointId;
    if (!checkpointId && options.resumeFromRunId) {
      const latestCheckpoint = await trx.selectFrom('checkpoint').select('id').where('run_id', '=', options.resumeFromRunId)
        .orderBy('sequence', 'desc').orderBy('created_at', 'desc').executeTakeFirst();
      checkpointId = latestCheckpoint?.id;
    }
    if (checkpointId) {
      const checkpoint = await trx.selectFrom('checkpoint').innerJoin('run', 'run.id', 'checkpoint.run_id')
        .select(['checkpoint.id', 'run.session_id']).where('checkpoint.id', '=', checkpointId).executeTakeFirst();
      if (!checkpoint) throw new DomainError('RESOURCE_NOT_FOUND', 'checkpoint was not found');
      if (checkpoint.session_id !== sessionId) throw new DomainError('VALIDATION_FAILED', 'checkpoint belongs to another session');
    }
    const activeStatuses = options.allowPaused
      ? ['queued', 'starting', 'running', 'waiting_input']
      : ['queued', 'starting', 'running', 'waiting_input', 'paused'];
    const active = await trx.selectFrom('run').select('id').where('session_id', '=', sessionId)
      .where('status', 'in', activeStatuses).executeTakeFirst();
    if (active) throw new DomainError('VERSION_CONFLICT', 'session already has an active run');
    const lastRun = await trx.selectFrom('run').select(['attempt']).where('session_id', '=', sessionId).orderBy('attempt', 'desc').executeTakeFirst();
    const run: Run = {
      id: `run_${randomUUID()}` as Run['id'], sessionId: sessionId as Run['sessionId'], attempt: (lastRun?.attempt ?? 0) + 1,
      status: 'queued', ...(checkpointId ? { checkpointId } : {}), createdAt: new Date().toISOString(),
    };
    await trx.insertInto('run').values({
      id: run.id, session_id: run.sessionId, attempt: run.attempt, status: run.status,
      checkpoint_id: run.checkpointId ?? null, error_code: null, version: 1, created_at: new Date(run.createdAt),
    }).execute();
    if (config && plan) {
      await trx.insertInto('execution_job').values({
        id: `job_${randomUUID()}`, run_id: run.id, daemon_id: config.daemonId,
        plan_hash: plan.checksum, plan_snapshot: JSON.stringify(plan), config: JSON.stringify(config), goal: session.goal ?? '',
      }).execute();
    }
    if (options.allowPaused || (config && plan)) {
      await trx.updateTable('session').set({ status: 'queued', version: session.version + 1 }).where('id', '=', sessionId).execute();
    }
    const project = await trx.selectFrom('task').select(['project_id']).where('id', '=', session.task_id).executeTakeFirstOrThrow();
    await this.events.append(trx, {
      eventType: 'run.created', projectId: project.project_id, taskId: session.task_id,
      sessionId, runId: run.id, actor: { type: 'system', id: 'control-plane' }, payload: run as unknown as Record<string, unknown>,
    });
    await this.idempotency.write(trx, options.idempotencyScope ?? `session:${sessionId}:run:create`, parsed.idempotencyKey, parsed, run as unknown as Record<string, unknown>, 201);
    return run;
  }

  async get(runId: string): Promise<Run> {
    const row = await this.database.db.selectFrom('run').selectAll().where('id', '=', runId).executeTakeFirst();
    if (!row) throw new DomainError('RESOURCE_NOT_FOUND', `run ${runId} was not found`);
    return {
      id: row.id as Run['id'], sessionId: row.session_id as Run['sessionId'], attempt: row.attempt,
      status: row.status as Run['status'], ...(row.checkpoint_id ? { checkpointId: row.checkpoint_id } : {}),
      ...(row.error_code ? { errorCode: row.error_code } : {}), createdAt: row.created_at.toISOString(),
    };
  }

  async pause(runId: string, authorization?: string): Promise<Run> {
    await this.database.db.transaction().execute(async trx => {
      const run = await trx.selectFrom('run').selectAll().where('id', '=', runId).forUpdate().executeTakeFirst();
      if (!run) throw new DomainError('RESOURCE_NOT_FOUND', `run ${runId} was not found`);
      await this.authorizeCloudRun(trx, run.session_id, authorization);
      const job = await trx.selectFrom('execution_job').selectAll().where('run_id', '=', runId).forUpdate().executeTakeFirst();
      if (run.status === 'paused') {
        if (job && (!job.cancel_requested || job.status !== 'paused')) {
          await trx.updateTable('execution_job').set({ status: 'paused', cancel_requested: true }).where('id', '=', job.id).execute();
        }
        return;
      }
      if (['completed', 'failed', 'cancelled'].includes(run.status)) {
        throw new DomainError('INVALID_STATE_TRANSITION', `run ${runId} cannot pause from ${run.status}`);
      }
      if (job) await trx.updateTable('execution_job').set({ status: 'paused', cancel_requested: true }).where('id', '=', job.id).execute();
      await trx.updateTable('run').set({ status: 'paused', version: run.version + 1 }).where('id', '=', runId).execute();
      await trx.updateTable('session').set(eb => ({ status: 'paused', version: eb('version', '+', 1) })).where('id', '=', run.session_id).execute();
      const context = await trx.selectFrom('session').innerJoin('task', 'task.id', 'session.task_id')
        .select(['task.project_id', 'task.id as task_id']).where('session.id', '=', run.session_id).executeTakeFirstOrThrow();
      await this.events.append(trx, {
        eventType: 'run.paused', projectId: context.project_id, taskId: context.task_id, sessionId: run.session_id, runId,
        actor: { type: 'user', id: 'local-user' }, payload: { status: 'paused', checkpointId: run.checkpoint_id },
      });
    });
    return this.get(runId);
  }

  async cancel(runId: string, authorization?: string): Promise<Run> {
    await this.database.db.transaction().execute(async trx => {
      const job = await trx.selectFrom('execution_job').selectAll().where('run_id', '=', runId).forUpdate().executeTakeFirst();
      const run = await trx.selectFrom('run').selectAll().where('id', '=', runId).forUpdate().executeTakeFirst();
      if (!run) throw new DomainError('RESOURCE_NOT_FOUND', 'run was not found');
      await this.authorizeCloudRun(trx, run.session_id, authorization);
      if (['completed', 'failed', 'cancelled'].includes(run.status)) return;
      if (job) await trx.updateTable('execution_job').set({ cancel_requested: true, status: 'cancelled' }).where('id', '=', job.id).execute();
      await trx.updateTable('run').set({ status: 'cancelled', version: run.version + 1 }).where('id', '=', runId).execute();
      await trx.updateTable('session').set(eb => ({ status: 'cancelled', version: eb('version', '+', 1) })).where('id', '=', run.session_id).execute();
      await this.cloud.finish(trx, runId, 'cancelled');
      const context = await trx.selectFrom('session').innerJoin('task', 'task.id', 'session.task_id').select(['task.project_id', 'task.id as task_id']).where('session.id', '=', run.session_id).executeTakeFirstOrThrow();
      await this.events.append(trx, { eventType: 'run.cancelled', projectId: context.project_id, taskId: context.task_id, sessionId: run.session_id, runId, actor: { type: 'user', id: 'local-user' }, payload: { status: 'cancelled' } });
    });
    return this.get(runId);
  }

  private async authorizeCloudRun(trx: Transaction<Database>, sessionId: string, authorization?: string): Promise<void> {
    const session = await trx.selectFrom('session').select('environment_type').where('id', '=', sessionId).executeTakeFirstOrThrow();
    if (session.environment_type === 'cloud') authenticateConsole(authorization);
  }

  async fail(runId: string, errorCode: string): Promise<void> {
    await this.database.db.transaction().execute(async trx => {
      const job = await trx.selectFrom('execution_job').select('id').where('run_id', '=', runId).executeTakeFirst();
      if (job) throw new DomainError('PERMISSION_DENIED', 'execution runs require authenticated daemon progress');
      const row = await trx.selectFrom('run').selectAll().where('id', '=', runId).forUpdate().executeTakeFirst();
      if (!row) throw new DomainError('RESOURCE_NOT_FOUND', `run ${runId} was not found`);
      if (row.status !== 'queued' && row.status !== 'running') {
        throw new DomainError('INVALID_STATE_TRANSITION', `run ${runId} cannot fail from ${row.status}`);
      }
      await trx.updateTable('run').set({ status: 'failed', error_code: errorCode, version: row.version + 1 }).where('id', '=', runId).execute();
      const context = await trx.selectFrom('session').innerJoin('task', 'task.id', 'session.task_id')
        .select(['task.project_id', 'task.id as task_id', 'session.id as session_id'])
        .where('session.id', '=', row.session_id).executeTakeFirstOrThrow();
      await this.events.append(trx, {
        eventType: 'run.failed', projectId: context.project_id, taskId: context.task_id,
        sessionId: context.session_id, runId, actor: { type: 'system', id: 'control-plane' },
        payload: { errorCode },
      });
    });
  }

  async complete(runId: string): Promise<void> {
    await this.database.db.transaction().execute(async trx => {
      const job = await trx.selectFrom('execution_job').select('id').where('run_id', '=', runId).executeTakeFirst();
      if (job) throw new DomainError('PERMISSION_DENIED', 'execution runs require authenticated daemon progress');
      const row = await trx.selectFrom('run').selectAll().where('id', '=', runId).forUpdate().executeTakeFirst();
      if (!row) throw new DomainError('RESOURCE_NOT_FOUND', `run ${runId} was not found`);
      if (row.status !== 'queued' && row.status !== 'running') {
        throw new DomainError('INVALID_STATE_TRANSITION', `run ${runId} cannot complete from ${row.status}`);
      }
      await trx.updateTable('run').set({ status: 'completed', version: row.version + 1 }).where('id', '=', runId).execute();
      const context = await trx.selectFrom('session').innerJoin('task', 'task.id', 'session.task_id')
        .select(['task.project_id', 'task.id as task_id', 'session.id as session_id'])
        .where('session.id', '=', row.session_id).executeTakeFirstOrThrow();
      await this.events.append(trx, {
        eventType: 'run.completed', projectId: context.project_id, taskId: context.task_id,
        sessionId: context.session_id, runId, actor: { type: 'system', id: 'control-plane' },
        payload: { status: 'completed' },
      });
    });
  }
}
