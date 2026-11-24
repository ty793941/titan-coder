import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { DomainError, executionCheckpointSchema, handoffCreateRequestSchema, handoffFailureRequestSchema, handoffSnapshotRequestSchema, validateExecutionConfig } from '@titan/contracts';
import type { Selectable, Transaction } from 'kysely';
import { DatabaseService } from '../../database/database.service.js';
import type { Database, SessionHandoffTable } from '../../database/types.js';
import { IdempotencyService } from '../../common/idempotency.service.js';
import { EventsService } from '../events/events.service.js';
import { canonicalJson, daemonStatus, latestApprovedPlan, validateExecution, cloudCapabilities } from '../daemons/execution-policy.js';

function view(row: Selectable<SessionHandoffTable>) {
  return { id: row.id, taskId: row.task_id, sourceSessionId: row.source_session_id, sourceRunId: row.source_run_id, targetSessionId: row.target_session_id, checkpointId: row.checkpoint_id, status: row.status, requestedBy: row.requested_by, workspaceSync: { mode: row.workspace_sync }, manifest: row.snapshot_manifest, errorCode: row.error_code, createdAt: row.created_at.toISOString(), completedAt: row.completed_at?.toISOString() ?? null, version: row.version };
}

@Injectable()
export class HandoffsService {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService, @Inject(IdempotencyService) private readonly idempotency: IdempotencyService, @Inject(EventsService) private readonly events: EventsService) {}

  async create(sessionId: string, source: unknown, headerKey?: string) {
    const body = source && typeof source === 'object' ? source : {};
    const input = handoffCreateRequestSchema.parse({ ...body, ...(headerKey ? { idempotencyKey: headerKey } : {}) });
    return this.database.db.transaction().execute(async trx => {
      const session = await trx.selectFrom('session').selectAll().where('id', '=', sessionId).forUpdate().executeTakeFirst();
      if (!session) throw new DomainError('RESOURCE_NOT_FOUND', 'source session was not found');
      const scope = `session:${sessionId}:handoff:create`;
      const existing = await this.idempotency.read<ReturnType<typeof view>>(trx, scope, input.idempotencyKey, input);
      if (existing) return { handoff: existing, created: false };
      if (session.status !== 'paused' || session.environment_type !== 'local' || !session.execution_config || !session.plan_hash) throw new DomainError('INVALID_STATE_TRANSITION', 'handoff requires a paused local execution session');
      const config = validateExecutionConfig(session.execution_config);
      const checkpoint = await trx.selectFrom('checkpoint').innerJoin('run', 'run.id', 'checkpoint.run_id').select(['checkpoint.id', 'run.id as run_id', 'run.session_id', 'run.status', 'run.checkpoint_id']).where('checkpoint.id', '=', input.checkpointId).executeTakeFirst();
      if (!checkpoint || checkpoint.session_id !== sessionId || checkpoint.status !== 'paused' || checkpoint.checkpoint_id !== input.checkpointId) throw new DomainError('HANDOFF_CHECKPOINT_INVALID', 'checkpoint must be the paused source run checkpoint');
      const active = await trx.selectFrom('session_handoff').select('id').where('source_session_id', '=', sessionId).where('status', 'in', ['requested', 'starting']).executeTakeFirst();
      if (active) throw new DomainError('VERSION_CONFLICT', 'source session already has an active handoff');
      await latestApprovedPlan(trx, session.task_id, session.plan_hash);
      const row = await trx.insertInto('session_handoff').values({ id: `handoff_${randomUUID()}`, task_id: session.task_id, source_session_id: sessionId, source_run_id: checkpoint.run_id, source_daemon_id: config.daemonId, checkpoint_id: input.checkpointId, workspace_sync: input.workspaceSync.mode, requested_by: 'local-user' }).returningAll().executeTakeFirstOrThrow();
      const task = await trx.selectFrom('task').select('project_id').where('id', '=', session.task_id).executeTakeFirstOrThrow();
      await this.events.append(trx, { eventType: 'handoff.requested', projectId: task.project_id, taskId: session.task_id, sessionId, runId: checkpoint.run_id, actor: { type: 'user', id: 'local-user' }, payload: { handoffId: row.id, checkpointId: checkpoint.id } });
      const handoff = view(row);
      await this.idempotency.write(trx, scope, input.idempotencyKey, input, handoff, 201);
      return { handoff, created: true };
    });
  }

  async get(id: string) {
    const row = await this.database.db.selectFrom('session_handoff').selectAll().where('id', '=', id).executeTakeFirst();
    if (!row) throw new DomainError('RESOURCE_NOT_FOUND', 'handoff was not found');
    return view(row);
  }

  async pending(daemonId: string) {
    const rows = await this.database.db.selectFrom('session_handoff').innerJoin('session', 'session.id', 'session_handoff.source_session_id').select(['session_handoff.id', 'source_session_id', 'source_run_id', 'checkpoint_id', 'session.execution_config']).where('source_daemon_id', '=', daemonId).where('session_handoff.status', '=', 'requested').orderBy('session_handoff.created_at').limit(100).execute();
    return { requests: rows.map(row => ({ id: row.id, sourceSessionId: row.source_session_id, sourceRunId: row.source_run_id, checkpointId: row.checkpoint_id, workspacePath: validateExecutionConfig(row.execution_config).workspacePath })) };
  }

  async snapshot(daemonId: string, id: string, source: unknown) {
    const { manifest } = handoffSnapshotRequestSchema.parse(source);
    return this.database.db.transaction().execute(async trx => {
      const handoff = await trx.selectFrom('session_handoff').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
      if (!handoff) throw new DomainError('RESOURCE_NOT_FOUND', 'handoff was not found');
      if (handoff.source_daemon_id !== daemonId) throw new DomainError('PERMISSION_DENIED', 'snapshot must be acknowledged by the source daemon');
      if (handoff.status !== 'requested') {
        if (handoff.target_session_id && canonicalJson(handoff.snapshot_manifest) === canonicalJson(manifest)) return view(handoff);
        throw new DomainError('VERSION_CONFLICT', 'handoff manifest is immutable');
      }
      const session = await trx.selectFrom('session').selectAll().where('id', '=', handoff.source_session_id).forUpdate().executeTakeFirstOrThrow();
      const run = await trx.selectFrom('run').selectAll().where('id', '=', handoff.source_run_id).forUpdate().executeTakeFirstOrThrow();
      if (session.status !== 'paused' || run.status !== 'paused' || run.checkpoint_id !== handoff.checkpoint_id) throw new DomainError('HANDOFF_CHECKPOINT_INVALID', 'source session must remain paused at the acknowledged checkpoint');
      const config = validateExecutionConfig(session.execution_config);
      if (config.daemonId !== daemonId) throw new DomainError('PERMISSION_DENIED', 'source daemon changed');
      await validateExecution(trx, config);
      const plan = await latestApprovedPlan(trx, session.task_id, session.plan_hash ?? '');
      const saved = await trx.selectFrom('checkpoint').selectAll().where('id', '=', handoff.checkpoint_id).where('run_id', '=', run.id).executeTakeFirstOrThrow();
      const checkpoint = executionCheckpointSchema.parse(saved.snapshot);
      const target = await this.selectTarget(trx, config.runtime);
      const now = new Date();
      const targetId = `session_${randomUUID()}`;
      const runId = `run_${randomUUID()}`;
      const checkpointId = `checkpoint_${randomUUID()}`;
      const leaseId = `lease_${randomUUID()}`;
      const targetConfig = validateExecutionConfig({ ...config, daemonId: target.id, environmentType: 'cloud', workspacePath: '/workspace/session', snapshotManifestRef: `snapshot://${manifest.snapshotId}`, secretLeaseRef: `lease://${leaseId}` });
      await trx.insertInto('session').values({ id: targetId, task_id: session.task_id, entry_agent: 'project-manager', status: 'queued', plan_hash: plan.checksum, version: 1, created_at: now, execution_config: JSON.stringify(targetConfig), goal: session.goal, environment_type: 'cloud', parent_session_id: session.id }).execute();
      await trx.insertInto('run').values({ id: runId, session_id: targetId, attempt: 1, status: 'queued', checkpoint_id: checkpointId, error_code: null, version: 1, created_at: now }).execute();
      // 跨环境只导入消息；宿主文件结果、工具去重状态和验收证据必须在目标重新建立。
      await trx.insertInto('checkpoint').values({ id: checkpointId, run_id: runId, sequence: 0, source_checkpoint_id: saved.id, snapshot: JSON.stringify({ id: checkpointId, messages: checkpoint.messages, successfulTools: [], evidence: [] }) }).execute();
      await trx.insertInto('secret_lease').values({ id: leaseId, credential_ref: targetConfig.credentialRef, purpose: 'model', session_id: targetId, expires_at: new Date(now.getTime() + 300000) }).execute();
      await trx.insertInto('execution_job').values({ id: `job_${randomUUID()}`, run_id: runId, daemon_id: target.id, plan_hash: plan.checksum, plan_snapshot: JSON.stringify(plan), config: JSON.stringify(targetConfig), goal: session.goal ?? '' }).execute();
      const executionId = `cloud_${randomUUID()}`;
      await trx.insertInto('cloud_execution').values({ id: executionId, session_id: targetId, run_id: runId, daemon_id: target.id, handoff_id: handoff.id, secret_lease_id: leaseId, snapshot_manifest: JSON.stringify(manifest), attempt: 1 }).execute();
      const updated = await trx.updateTable('session_handoff').set({ target_session_id: targetId, snapshot_manifest: JSON.stringify(manifest), status: 'starting', version: handoff.version + 1 }).where('id', '=', handoff.id).where('version', '=', handoff.version).returningAll().executeTakeFirstOrThrow();
      const task = await trx.selectFrom('task').select('project_id').where('id', '=', session.task_id).executeTakeFirstOrThrow();
      const context = { projectId: task.project_id, taskId: session.task_id, sessionId: targetId, actor: { type: 'daemon' as const, id: daemonId } };
      await this.events.append(trx, { ...context, eventType: 'session.created', payload: { id: targetId, parentSessionId: session.id, environmentType: 'cloud' } });
      await this.events.append(trx, { ...context, eventType: 'run.created', runId, payload: { id: runId, attempt: 1, checkpointId } });
      await this.events.append(trx, { ...context, eventType: 'handoff.created', runId, payload: { handoffId: handoff.id, executionId, sourceSessionId: session.id, targetSessionId: targetId, sourceCheckpointId: saved.id, checkpointId, snapshotId: manifest.snapshotId, stopped: true } });
      return view(updated);
    });
  }

  async failure(daemonId: string, id: string, source: unknown) {
    const input = handoffFailureRequestSchema.parse(source);
    return this.database.db.transaction().execute(async trx => {
      const handoff = await trx.selectFrom('session_handoff').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
      if (!handoff) throw new DomainError('RESOURCE_NOT_FOUND', 'handoff was not found');
      if (handoff.source_daemon_id !== daemonId) throw new DomainError('PERMISSION_DENIED', 'handoff failure must be reported by its source daemon');
      if (handoff.status === 'failed' && !handoff.target_session_id) {
        if (handoff.error_code !== input.errorCode) throw new DomainError('VERSION_CONFLICT', 'handoff failure is immutable');
        return view(handoff);
      }
      if (handoff.status !== 'requested' || handoff.target_session_id) throw new DomainError('INVALID_STATE_TRANSITION', 'source failure can only close a requested handoff without a target');
      const updated = await trx.updateTable('session_handoff').set({ status: 'failed', error_code: input.errorCode, completed_at: new Date(), version: handoff.version + 1 }).where('id', '=', handoff.id).where('version', '=', handoff.version).returningAll().executeTakeFirstOrThrow();
      const task = await trx.selectFrom('task').select('project_id').where('id', '=', handoff.task_id).executeTakeFirstOrThrow();
      await this.events.append(trx, { eventType: 'handoff.failed', projectId: task.project_id, taskId: handoff.task_id, sessionId: handoff.source_session_id, runId: handoff.source_run_id, actor: { type: 'daemon', id: daemonId }, payload: { handoffId: id, errorCode: input.errorCode } });
      return view(updated);
    });
  }

  private async selectTarget(trx: Transaction<Database>, runtime: string) {
    const candidates = await trx.selectFrom('daemon').selectAll().where('environment_type', '=', 'cloud').where('status', '=', 'ready').orderBy('created_at', 'desc').orderBy('id').forUpdate().execute();
    for (const daemon of candidates) {
      const capabilities = daemon.capabilities as string[];
      if (daemonStatus(daemon) !== 'ready' || ![runtime, ...cloudCapabilities].every(value => capabilities.includes(value))) continue;
      const count = await trx.selectFrom('execution_job').select(({ fn }) => fn.countAll().as('count')).where('daemon_id', '=', daemon.id).where('status', 'in', ['queued', 'claimed']).executeTakeFirstOrThrow();
      if (Number(count.count) < daemon.max_concurrent_sessions) return daemon;
    }
    throw new DomainError('HANDOFF_TARGET_UNAVAILABLE', 'no ready capable cloud daemon has capacity');
  }
}
