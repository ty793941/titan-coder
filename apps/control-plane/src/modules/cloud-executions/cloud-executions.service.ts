import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { cloudLifecycleRequestSchema, cloudSnapshotManifestSchema, DomainError } from '@titan/contracts';
import type { RunDispatch } from '@titan/daemon-protocol';
import type { Selectable, Transaction } from 'kysely';
import { DatabaseService } from '../../database/database.service.js';
import type { CloudExecutionTable, Database } from '../../database/types.js';
import { EventsService } from '../events/events.service.js';
import { daemonStatus, sameToken } from '../daemons/execution-policy.js';

const terminal = new Set(['completed', 'failed', 'cancelled']);
const transitions: Record<string, string[]> = {
  queued: ['creating', 'failed', 'cancelled'], creating: ['starting', 'failed', 'cancelled'],
  starting: ['running', 'stopping', 'failed', 'cancelled'], running: ['stopping', 'completed', 'failed', 'cancelled'],
  stopping: ['completed', 'failed', 'cancelled'], completed: [], failed: [], cancelled: [],
};
const lifecycleEvents: Record<string, string> = { creating: 'container.creating', starting: 'container.created', running: 'container.started', stopping: 'container.stopping', completed: 'container.stopped', failed: 'container.failed', cancelled: 'container.stopped' };

function view(row: Selectable<CloudExecutionTable>) {
  return {
    id: row.id, sessionId: row.session_id, runId: row.run_id, daemonId: row.daemon_id, handoffId: row.handoff_id,
    status: row.status, containerId: row.container_id, attempt: row.attempt, errorCode: row.error_code,
    leaseExpiresAt: row.lease_expires_at?.toISOString() ?? null, lastHeartbeatAt: row.last_heartbeat_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(), endedAt: row.ended_at?.toISOString() ?? null, version: row.version,
  };
}

@Injectable()
export class CloudExecutionsService {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService, @Inject(EventsService) private readonly events: EventsService) {}

  async get(id: string) {
    return this.database.db.transaction().execute(async trx => {
      const owner = await trx.selectFrom('cloud_execution').select(['run_id', 'daemon_id']).where('id', '=', id).executeTakeFirst();
      if (!owner) throw new DomainError('RESOURCE_NOT_FOUND', 'cloud execution was not found');
      const daemon = await trx.selectFrom('daemon').selectAll().where('id', '=', owner.daemon_id).forUpdate().executeTakeFirstOrThrow();
      const job = await trx.selectFrom('execution_job').selectAll().where('run_id', '=', owner.run_id).forUpdate().executeTakeFirstOrThrow();
      const run = await trx.selectFrom('run').selectAll().where('id', '=', owner.run_id).forUpdate().executeTakeFirstOrThrow();
      const row = await trx.selectFrom('cloud_execution').selectAll().where('id', '=', id).forUpdate().executeTakeFirstOrThrow();
      const expired = !job.lease_expires_at || job.lease_expires_at.getTime() <= Date.now() || !row.lease_expires_at || row.lease_expires_at.getTime() <= Date.now();
      if (job.status === 'claimed' && !terminal.has(run.status) && (daemonStatus(daemon) !== 'ready' || expired)) {
        await this.disconnect(trx, run.id);
        return view({ ...row, lease_expires_at: null, error_code: 'CLOUD_WORKER_DISCONNECTED', version: row.version + 1 });
      }
      return view(row);
    });
  }

  async disconnect(trx: Transaction<Database>, runId: string): Promise<void> {
    const job = await trx.selectFrom('execution_job').selectAll().where('run_id', '=', runId).forUpdate().executeTakeFirstOrThrow();
    const run = await trx.selectFrom('run').selectAll().where('id', '=', runId).forUpdate().executeTakeFirstOrThrow();
    const row = await trx.selectFrom('cloud_execution').selectAll().where('run_id', '=', runId).forUpdate().executeTakeFirstOrThrow();
    if (job.status !== 'claimed' || terminal.has(run.status)) return;
    await trx.updateTable('execution_job').set({ status: 'blocked', cancel_requested: true, claim_token_hash: null, lease_expires_at: null }).where('id', '=', job.id).execute();
    await trx.updateTable('run').set({ status: 'reconnecting', error_code: 'CLOUD_WORKER_DISCONNECTED', version: run.version + 1 }).where('id', '=', run.id).execute();
    await trx.updateTable('session').set(eb => ({ status: 'reconnecting', version: eb('version', '+', 1) })).where('id', '=', run.session_id).execute();
    await trx.updateTable('secret_lease').set({ revoked_at: new Date() }).where('id', '=', row.secret_lease_id).where('revoked_at', 'is', null).execute();
    await trx.updateTable('cloud_execution').set({ lease_expires_at: null, error_code: 'CLOUD_WORKER_DISCONNECTED', version: row.version + 1 }).where('id', '=', row.id).where('version', '=', row.version).execute();
    const task = await trx.selectFrom('session').innerJoin('task', 'task.id', 'session.task_id').select(['task.id', 'task.project_id']).where('session.id', '=', run.session_id).executeTakeFirstOrThrow();
    await this.events.append(trx, { eventType: 'cloud_execution.reconnecting', projectId: task.project_id, taskId: task.id, sessionId: run.session_id, runId: run.id, actor: { type: 'system', id: 'control-plane' }, payload: { executionId: row.id, errorCode: 'CLOUD_WORKER_DISCONNECTED', retryRequiresHuman: true } });
  }

  async dispatch(trx: Transaction<Database>, runId: string, leaseExpiresAt: Date): Promise<NonNullable<RunDispatch['cloud']>> {
    const row = await trx.selectFrom('cloud_execution').selectAll().where('run_id', '=', runId).forUpdate().executeTakeFirst();
    if (!row || row.status !== 'queued') throw new DomainError('INVALID_STATE_TRANSITION', 'cloud execution must be queued');
    const lease = await trx.selectFrom('secret_lease').selectAll().where('id', '=', row.secret_lease_id).executeTakeFirstOrThrow();
    if (lease.revoked_at || lease.consumed_at || lease.expires_at.getTime() <= Date.now()) throw new DomainError('CLOUD_SECRET_LEASE_EXPIRED', 'cloud secret lease is unavailable');
    await trx.updateTable('cloud_execution').set({ lease_expires_at: leaseExpiresAt, last_heartbeat_at: new Date(), version: row.version + 1 }).where('id', '=', row.id).where('version', '=', row.version).execute();
    return { executionId: row.id, snapshot: cloudSnapshotManifestSchema.parse(row.snapshot_manifest) as NonNullable<RunDispatch['cloud']>['snapshot'], secretLeaseId: lease.id, secretLeaseExpiresAt: lease.expires_at.toISOString() };
  }

  async lifecycle(daemonId: string, runId: string, source: unknown) {
    const input = cloudLifecycleRequestSchema.parse(source);
    return this.database.db.transaction().execute(async trx => {
      const daemon = await trx.selectFrom('daemon').selectAll().where('id', '=', daemonId).forUpdate().executeTakeFirst();
      if (!daemon || daemon.environment_type !== 'cloud' || daemonStatus(daemon) !== 'ready') throw new DomainError('PERMISSION_DENIED', 'cloud daemon must be ready');
      const job = await trx.selectFrom('execution_job').selectAll().where('run_id', '=', runId).where('daemon_id', '=', daemonId).forUpdate().executeTakeFirst();
      if (!job) throw new DomainError('RESOURCE_NOT_FOUND', 'cloud job was not found');
      if (!sameToken(input.claimToken, job.claim_token_hash) || job.status !== 'claimed' || job.cancel_requested || !job.lease_expires_at || job.lease_expires_at.getTime() <= Date.now()) throw new DomainError('PERMISSION_DENIED', 'cloud claim is fenced or expired');
      const run = await trx.selectFrom('run').selectAll().where('id', '=', runId).forUpdate().executeTakeFirstOrThrow();
      if (terminal.has(run.status) || run.status === 'paused' || run.status === 'reconnecting') throw new DomainError('PERMISSION_DENIED', 'run cannot accept cloud lifecycle');
      const row = await trx.selectFrom('cloud_execution').selectAll().where('run_id', '=', runId).where('daemon_id', '=', daemonId).forUpdate().executeTakeFirst();
      if (!row || !row.lease_expires_at || row.lease_expires_at.getTime() <= Date.now()) throw new DomainError('PERMISSION_DENIED', 'cloud execution lease expired');
      if (row.status !== input.status && !transitions[row.status]?.includes(input.status)) throw new DomainError('INVALID_STATE_TRANSITION', 'invalid cloud lifecycle transition');
      if (row.container_id && input.containerId && row.container_id !== input.containerId) throw new DomainError('VERSION_CONFLICT', 'container identity is immutable');
      if (input.consumeSecret) {
        if (terminal.has(input.status)) throw new DomainError('INVALID_STATE_TRANSITION', 'cannot consume credentials for a terminal container');
        const lease = await trx.selectFrom('secret_lease').selectAll().where('id', '=', row.secret_lease_id).forUpdate().executeTakeFirstOrThrow();
        if (lease.consumed_at) throw new DomainError('CLOUD_SECRET_CONSUMED', 'secret lease was already consumed');
        if (lease.revoked_at || lease.session_id !== row.session_id || lease.expires_at.getTime() <= Date.now()) throw new DomainError('CLOUD_SECRET_LEASE_EXPIRED', 'secret lease is unavailable');
        const changed = await trx.updateTable('secret_lease').set({ consumed_at: new Date() }).where('id', '=', lease.id).where('consumed_at', 'is', null).where('revoked_at', 'is', null).where('expires_at', '>', new Date()).executeTakeFirst();
        if (!Number(changed.numUpdatedRows)) throw new DomainError('CLOUD_SECRET_CONSUMED', 'secret lease consumption raced');
      }
      const changed = row.status !== input.status || (input.containerId !== undefined && row.container_id !== input.containerId) || (input.errorCode !== undefined && row.error_code !== input.errorCode);
      if (changed) {
        await trx.updateTable('cloud_execution').set({ status: input.status, ...(input.containerId ? { container_id: input.containerId } : {}), ...(input.errorCode ? { error_code: input.errorCode } : {}), last_heartbeat_at: new Date(), version: row.version + 1, ...(terminal.has(input.status) ? { ended_at: new Date() } : {}) }).where('id', '=', row.id).where('version', '=', row.version).execute();
        const task = await trx.selectFrom('session').innerJoin('task', 'task.id', 'session.task_id').select(['task.project_id', 'task.id']).where('session.id', '=', run.session_id).executeTakeFirstOrThrow();
        await this.events.append(trx, { eventType: lifecycleEvents[input.status]!, projectId: task.project_id, taskId: task.id, sessionId: run.session_id, runId, actor: { type: 'daemon', id: daemonId }, payload: { executionId: row.id, status: input.status, ...(input.containerId ? { containerId: input.containerId } : {}), ...(input.errorCode ? { errorCode: input.errorCode } : {}) } });
      }
      if (input.consumeSecret) {
        await trx.insertInto('audit_log').values({ id: `audit_${randomUUID()}`, actor_type: 'daemon', actor_id: daemonId, action: 'secret_lease.consumed', target_type: 'secret_lease', target_id: row.secret_lease_id, trace_id: row.id, payload: { sessionId: row.session_id, runId }, created_at: new Date() }).execute();
      }
      return { executionId: row.id, status: input.status, secretConsumed: input.consumeSecret === true, leaseExpiresAt: row.lease_expires_at.toISOString() };
    });
  }

  async renew(trx: Transaction<Database>, runId: string, expiresAt: Date): Promise<void> {
    await trx.updateTable('cloud_execution').set(eb => ({ lease_expires_at: expiresAt, last_heartbeat_at: new Date(), version: eb('version', '+', 1) })).where('run_id', '=', runId).where('status', 'not in', [...terminal]).where('lease_expires_at', '>', new Date()).execute();
  }

  async finish(trx: Transaction<Database>, runId: string, status: string, errorCode?: string): Promise<void> {
    if (!terminal.has(status)) return;
    const row = await trx.selectFrom('cloud_execution').selectAll().where('run_id', '=', runId).forUpdate().executeTakeFirst();
    if (!row) return;
    if (terminal.has(row.status) && row.status !== status) throw new DomainError('INVALID_STATE_TRANSITION', 'cloud terminal state conflicts with run result');
    await trx.updateTable('cloud_execution').set({ status, ended_at: row.ended_at ?? new Date(), lease_expires_at: null, ...(errorCode ? { error_code: errorCode } : {}), version: row.version + 1 }).where('id', '=', row.id).where('version', '=', row.version).execute();
    await trx.updateTable('secret_lease').set({ revoked_at: new Date() }).where('id', '=', row.secret_lease_id).where('revoked_at', 'is', null).execute();
    if (row.status !== status) {
      const task = await trx.selectFrom('session').innerJoin('task', 'task.id', 'session.task_id').select(['task.project_id', 'task.id']).where('session.id', '=', row.session_id).executeTakeFirstOrThrow();
      await this.events.append(trx, { eventType: lifecycleEvents[status]!, projectId: task.project_id, taskId: task.id, sessionId: row.session_id, runId, actor: { type: 'system', id: 'control-plane' }, payload: { executionId: row.id, status, ...(row.container_id ? { containerId: row.container_id } : {}), ...(errorCode ? { errorCode } : {}) } });
    }
    if (row.handoff_id) {
      const handoff = await trx.selectFrom('session_handoff').selectAll().where('id', '=', row.handoff_id).forUpdate().executeTakeFirstOrThrow();
      if (handoff.status === 'starting') {
        const outcome = status === 'completed' ? 'completed' : 'failed';
        await trx.updateTable('session_handoff').set({ status: outcome, error_code: errorCode ?? (status === 'cancelled' ? 'CANCELLED' : null), completed_at: new Date(), version: handoff.version + 1 }).where('id', '=', handoff.id).where('version', '=', handoff.version).execute();
        const task = await trx.selectFrom('task').select('project_id').where('id', '=', handoff.task_id).executeTakeFirstOrThrow();
        await this.events.append(trx, { eventType: `handoff.${outcome}`, projectId: task.project_id, taskId: handoff.task_id, sessionId: row.session_id, runId, actor: { type: 'system', id: 'control-plane' }, payload: { handoffId: handoff.id, targetSessionId: row.session_id, status: outcome } });
      }
    }
  }

  async cancel(id: string) {
    await this.database.db.transaction().execute(async trx => {
      const owner = await trx.selectFrom('cloud_execution').select(['run_id', 'daemon_id']).where('id', '=', id).executeTakeFirst();
      if (!owner) throw new DomainError('RESOURCE_NOT_FOUND', 'cloud execution was not found');
      await trx.selectFrom('daemon').select('id').where('id', '=', owner.daemon_id).forUpdate().executeTakeFirstOrThrow();
      await trx.selectFrom('execution_job').select('id').where('run_id', '=', owner.run_id).forUpdate().executeTakeFirstOrThrow();
      const run = await trx.selectFrom('run').selectAll().where('id', '=', owner.run_id).forUpdate().executeTakeFirstOrThrow();
      if (terminal.has(run.status)) return;
      await trx.updateTable('execution_job').set({ cancel_requested: true, status: 'cancelled' }).where('run_id', '=', run.id).execute();
      await trx.updateTable('run').set({ status: 'cancelled', version: run.version + 1 }).where('id', '=', run.id).execute();
      await trx.updateTable('session').set(eb => ({ status: 'cancelled', version: eb('version', '+', 1) })).where('id', '=', run.session_id).execute();
      await this.finish(trx, run.id, 'cancelled');
      const task = await trx.selectFrom('session').innerJoin('task', 'task.id', 'session.task_id').select(['task.project_id', 'task.id']).where('session.id', '=', run.session_id).executeTakeFirstOrThrow();
      await this.events.append(trx, { eventType: 'run.cancelled', projectId: task.project_id, taskId: task.id, sessionId: run.session_id, runId: run.id, actor: { type: 'user', id: 'local-user' }, payload: { executionId: id, status: 'cancelled' } });
    });
    return this.get(id);
  }
}
