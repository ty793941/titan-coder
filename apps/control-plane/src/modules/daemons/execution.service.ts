import { randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { DomainError, executionCheckpointSchema, executionConfigSchema, runProgressSchema } from '@titan/contracts';
import type { ExecutionCheckpoint, ExecutionConfig, ProgressAck, RunDispatch } from '@titan/daemon-protocol';
import { sql } from 'kysely';
import { DatabaseService } from '../../database/database.service.js';
import { EventsService } from '../events/events.service.js';
import { canonicalJson, daemonStatus, latestApprovedPlan, sameToken, tokenHash, validateExecution } from './execution-policy.js';

const terminal = new Set(['completed', 'failed', 'cancelled']);
const leaseMs = 120000;

@Injectable()
export class ExecutionService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(EventsService) private readonly events: EventsService,
  ) {}

  async claim(daemonId: string): Promise<RunDispatch | undefined> {
    return this.database.db.transaction().execute(async trx => {
      const daemon = await trx.selectFrom('daemon').selectAll().where('id', '=', daemonId).forUpdate().executeTakeFirst();
      if (!daemon || daemonStatus(daemon) !== 'ready') throw new DomainError('DAEMON_UNAVAILABLE', 'daemon must be ready before claiming work');
      const active = await trx.selectFrom('execution_job').select(({ fn }) => fn.countAll().as('count'))
        .where('daemon_id', '=', daemonId).where('status', '=', 'claimed').executeTakeFirstOrThrow();
      if (Number(active.count) >= daemon.max_concurrent_sessions) return undefined;
      for (let scanned = 0; scanned < 100; scanned++) {
        const job = await trx.selectFrom('execution_job').selectAll().where('daemon_id', '=', daemonId)
          .where('status', '=', 'queued').where('cancel_requested', '=', false).orderBy('created_at', 'asc').orderBy('id', 'asc')
          .forUpdate().skipLocked().executeTakeFirst();
        if (!job) return undefined;
        const context = await trx.selectFrom('run').innerJoin('session', 'session.id', 'run.session_id')
          .innerJoin('task', 'task.id', 'session.task_id')
          .select(['run.status', 'run.checkpoint_id', 'session.id as session_id', 'task.id as task_id', 'task.project_id'])
          .where('run.id', '=', job.run_id).executeTakeFirstOrThrow();
        if (terminal.has(context.status)) {
          await trx.updateTable('execution_job').set({ status: context.status }).where('id', '=', job.id).execute();
          continue;
        }
        try {
          await latestApprovedPlan(trx, context.task_id, job.plan_hash);
        } catch (error) {
          if (!(error instanceof DomainError) || error.code !== 'PLAN_HASH_STALE') throw error;
          await trx.updateTable('execution_job').set({ status: 'blocked' }).where('id', '=', job.id).execute();
          await trx.updateTable('run').set(eb => ({ status: 'waiting_input', error_code: 'PLAN_HASH_STALE', version: eb('version', '+', 1) })).where('id', '=', job.run_id).execute();
          await trx.updateTable('session').set(eb => ({ status: 'waiting_input', version: eb('version', '+', 1) })).where('id', '=', context.session_id).execute();
          await this.events.append(trx, { eventType: 'run.waiting_input', projectId: context.project_id, taskId: context.task_id,
            sessionId: context.session_id, runId: job.run_id, actor: { type: 'system', id: 'control-plane' }, payload: { errorCode: 'PLAN_HASH_STALE' } });
          continue;
        }
        const config = executionConfigSchema.parse(job.config) as ExecutionConfig;
        await validateExecution(trx, config);
        let checkpoint: ExecutionCheckpoint | undefined;
        if (context.checkpoint_id) {
          const saved = await trx.selectFrom('checkpoint').innerJoin('run', 'run.id', 'checkpoint.run_id')
            .select(['checkpoint.snapshot', 'run.session_id']).where('checkpoint.id', '=', context.checkpoint_id).executeTakeFirst();
          if (!saved || saved.session_id !== context.session_id) throw new DomainError('VALIDATION_FAILED', 'checkpoint is not owned by the session');
          checkpoint = executionCheckpointSchema.parse(saved.snapshot) as ExecutionCheckpoint;
        }
        const claimToken = randomBytes(32).toString('hex');
        await trx.updateTable('execution_job').set({ status: 'claimed', claim_token_hash: tokenHash(claimToken), lease_expires_at: new Date(Date.now() + leaseMs) }).where('id', '=', job.id).execute();
        return {
          jobId: job.id, runId: job.run_id, sessionId: context.session_id, taskId: context.task_id,
          projectId: context.project_id, goal: job.goal, planHash: job.plan_hash, config, claimToken,
          ...(checkpoint ? { checkpoint } : {}),
        };
      }
      return undefined;
    });
  }

  async progress(daemonId: string, runId: string, source: unknown): Promise<ProgressAck> {
    const input = runProgressSchema.parse(source);
    const { claimToken, ...content } = input;
    const requestHash = tokenHash(canonicalJson(content));
    return this.database.db.transaction().execute(async trx => {
      const daemon = await trx.selectFrom('daemon').selectAll().where('id', '=', daemonId).forUpdate().executeTakeFirstOrThrow();
      if (daemon.status === 'revoked') throw new DomainError('PERMISSION_DENIED', 'daemon is revoked');
      const job = await trx.selectFrom('execution_job').selectAll().where('run_id', '=', runId).where('daemon_id', '=', daemonId).forUpdate().executeTakeFirst();
      if (!job) throw new DomainError('RESOURCE_NOT_FOUND', 'execution job was not found');
      if (!sameToken(claimToken, job.claim_token_hash)) throw new DomainError('PERMISSION_DENIED', 'invalid claim token');
      const run = await trx.selectFrom('run').selectAll().where('id', '=', runId).forUpdate().executeTakeFirstOrThrow();
      const ack = (accepted: boolean): ProgressAck => ({ accepted, status: run.status, cancelRequested: job.cancel_requested });
      await sql`select pg_advisory_xact_lock(hashtextextended(${`progress:${input.eventId}`}, 0))`.execute(trx);
      const previous = await trx.selectFrom('execution_progress').selectAll().where('event_id', '=', input.eventId).executeTakeFirst();
      if (previous) {
        if (previous.job_id !== job.id || previous.request_hash !== requestHash) throw new DomainError('IDEMPOTENCY_CONFLICT', 'eventId was reused with different progress');
        return ack(false);
      }
      if (terminal.has(run.status)) return ack(false);
      if (!job.lease_expires_at || job.lease_expires_at.getTime() <= Date.now() || job.status !== 'claimed') throw new DomainError('PERMISSION_DENIED', 'claim lease expired');
      if (input.sequence !== Number(job.last_sequence) + 1) throw new DomainError('EVENT_SEQUENCE_GAP', 'progress sequence must be contiguous');
      await trx.insertInto('execution_progress').values({ event_id: input.eventId, job_id: job.id, sequence: input.sequence, request_hash: requestHash }).execute();
      if (input.checkpoint) {
        const saved = await trx.selectFrom('checkpoint').selectAll().where('id', '=', input.checkpoint.id).executeTakeFirst();
        if (saved) {
          if (saved.run_id !== runId || canonicalJson(saved.snapshot) !== canonicalJson(input.checkpoint)) throw new DomainError('VERSION_CONFLICT', 'checkpoint id already belongs to another snapshot');
        } else {
          await trx.insertInto('checkpoint').values({ id: input.checkpoint.id, run_id: runId, sequence: input.sequence, snapshot: JSON.stringify(input.checkpoint) }).execute();
        }
      }
      const status = ['output', 'checkpoint'].includes(input.type) ? run.status : input.type;
      await trx.updateTable('run').set({ status, version: run.version + 1,
        ...(input.checkpoint ? { checkpoint_id: input.checkpoint.id } : {}),
        ...(input.type === 'failed' ? { error_code: typeof input.payload.errorCode === 'string' ? input.payload.errorCode : 'TOOL_EXECUTION_FAILED' } : {}),
      }).where('id', '=', runId).execute();
      await trx.updateTable('session').set(eb => ({ status, version: eb('version', '+', 1) })).where('id', '=', run.session_id).execute();
      await trx.updateTable('execution_job').set({ status: terminal.has(status) ? status : 'claimed', last_sequence: input.sequence,
        lease_expires_at: new Date(Date.now() + leaseMs), ...(status === 'cancelled' ? { cancel_requested: true } : {}),
      }).where('id', '=', job.id).execute();
      const context = await trx.selectFrom('session').innerJoin('task', 'task.id', 'session.task_id').select(['task.project_id', 'task.id as task_id']).where('session.id', '=', run.session_id).executeTakeFirstOrThrow();
      await this.events.append(trx, { eventId: input.eventId, eventType: `run.${input.type}`, projectId: context.project_id, taskId: context.task_id,
        sessionId: run.session_id, runId, actor: { type: 'daemon', id: daemonId },
        payload: { ...input.payload, progressEventId: input.eventId, progressSequence: input.sequence, ...(input.checkpoint ? { checkpointId: input.checkpoint.id } : {}) },
      });
      return { accepted: true, status, cancelRequested: job.cancel_requested || status === 'cancelled' };
    });
  }

  async control(daemonId: string, runId: string): Promise<{ cancelRequested: boolean; status: string }> {
    const row = await this.database.db.selectFrom('execution_job').innerJoin('run', 'run.id', 'execution_job.run_id')
      .select(['execution_job.cancel_requested', 'run.status']).where('execution_job.daemon_id', '=', daemonId).where('run.id', '=', runId).executeTakeFirst();
    if (!row) throw new DomainError('RESOURCE_NOT_FOUND', 'execution job was not found');
    return { cancelRequested: row.cancel_requested, status: row.status };
  }

  async job(daemonId: string, runId: string) {
    const row = await this.database.db.selectFrom('execution_job').select(['id', 'run_id', 'status', 'cancel_requested', 'last_sequence', 'lease_expires_at'])
      .where('daemon_id', '=', daemonId).where('run_id', '=', runId).executeTakeFirst();
    if (!row) throw new DomainError('RESOURCE_NOT_FOUND', 'execution job was not found');
    return { jobId: row.id, runId: row.run_id, status: row.status, cancelRequested: row.cancel_requested, lastSequence: Number(row.last_sequence), leaseExpiresAt: row.lease_expires_at?.toISOString() ?? null };
  }
}
