import { DomainError, executionConfigSchema } from '@titan/contracts';
import type { Selectable, Transaction } from 'kysely';
import { sql } from 'kysely';
import type { Database, SessionTable } from '../../database/types.js';
import { latestApprovedPlan, validateExecution } from '../daemons/execution-policy.js';

export async function lockSession(trx: Transaction<Database>, sessionId: string) {
  const session = await trx.selectFrom('session').selectAll().where('id', '=', sessionId).forUpdate().executeTakeFirst();
  if (!session) throw new DomainError('RESOURCE_NOT_FOUND', 'session was not found');
  return session;
}

export function requireAssignedWorker(assignedWorkerId: string | null, workerId: string) {
  if (!assignedWorkerId || assignedWorkerId !== workerId) throw new DomainError('PERMISSION_DENIED', 'resource is not assigned to the authenticated workflow worker');
}

export async function lockSchedule(trx: Transaction<Database>, id: string, skipLocked = false) {
  const source = await trx.selectFrom('execution_schedule').select('session_id').where('id', '=', id).executeTakeFirst();
  if (!source) throw new DomainError('RESOURCE_NOT_FOUND', 'schedule was not found');
  const sessionQuery = trx.selectFrom('session').selectAll().where('id', '=', source.session_id).forUpdate();
  const session = await (skipLocked ? sessionQuery.skipLocked() : sessionQuery).executeTakeFirst();
  if (!session) return undefined;
  const query = trx.selectFrom('execution_schedule').selectAll().where('id', '=', id).forUpdate();
  const row = await (skipLocked ? query.skipLocked() : query).executeTakeFirst();
  return row ? { row, session } : undefined;
}

export async function lockBackgroundJob(trx: Transaction<Database>, id: string, skipLocked = false) {
  // 与 Daemon 一致：后台互斥锁 → execution_job → run → session → schedule → background_job。
  // 命令领取已持有 command 锁，所有目标锁必须非阻塞，避免与取消/过期写命令形成反向等待。
  if (skipLocked) {
    const lock = await sql<{ acquired: boolean }>`select pg_try_advisory_xact_lock(hashtextextended(${`background:${id}`}, 0)) as acquired`.execute(trx);
    if (!lock.rows[0]?.acquired) return undefined;
  } else await sql`select pg_advisory_xact_lock(hashtextextended(${`background:${id}`}, 0))`.execute(trx);
  const source = await trx.selectFrom('background_job').select(['session_id', 'schedule_id', 'run_id']).where('id', '=', id).executeTakeFirst();
  if (!source) throw new DomainError('RESOURCE_NOT_FOUND', 'background job was not found');
  if (source.run_id) {
    const execution = await trx.selectFrom('execution_job').select('id').where('run_id', '=', source.run_id).executeTakeFirst();
    if (execution) {
      const query = trx.selectFrom('execution_job').select('id').where('id', '=', execution.id).forUpdate();
      if (!await (skipLocked ? query.skipLocked() : query).executeTakeFirst()) return undefined;
    }
    const query = trx.selectFrom('run').select('id').where('id', '=', source.run_id).forNoKeyUpdate();
    if (!await (skipLocked ? query.skipLocked() : query).executeTakeFirst()) return undefined;
  }
  const sessionQuery = trx.selectFrom('session').selectAll().where('id', '=', source.session_id).forUpdate();
  const session = await (skipLocked ? sessionQuery.skipLocked() : sessionQuery).executeTakeFirst();
  if (!session) return undefined;
  let schedule;
  if (source.schedule_id) {
    const query = trx.selectFrom('execution_schedule').selectAll().where('id', '=', source.schedule_id).forUpdate();
    schedule = await (skipLocked ? query.skipLocked() : query).executeTakeFirst();
    if (!schedule) return undefined;
  }
  const query = trx.selectFrom('background_job').selectAll().where('id', '=', id).forUpdate();
  const row = await (skipLocked ? query.skipLocked() : query).executeTakeFirst();
  return row ? { row, session, schedule } : undefined;
}

export async function validateLocalSession(trx: Transaction<Database>, session: Selectable<SessionTable>, planHash: string) {
  if (session.environment_type !== 'local') throw new DomainError('INVALID_STATE_TRANSITION', 'new background runs require a local session');
  if (session.plan_hash !== planHash) throw new DomainError('PLAN_HASH_STALE', 'plan must match the authorized session');
  const task = await trx.selectFrom('task').selectAll().where('id', '=', session.task_id).executeTakeFirstOrThrow();
  if (task.status !== 'active') throw new DomainError('PERMISSION_DENIED', 'task is not active');
  await latestApprovedPlan(trx, session.task_id, planHash);
  if (!session.execution_config) throw new DomainError('APPROVAL_REQUIRED', 'background runs require authorized execution configuration');
  const config = executionConfigSchema.parse(session.execution_config);
  if ((config.environmentType ?? 'local') !== 'local') throw new DomainError('PERMISSION_DENIED', 'background execution cannot reuse cloud authorization');
  await validateExecution(trx, config);
  return { task, config };
}

export async function hasActiveRun(trx: Transaction<Database>, sessionId: string): Promise<boolean> {
  return Boolean(await trx.selectFrom('run').select('id').where('session_id', '=', sessionId)
    .where('status', 'in', ['queued', 'starting', 'running', 'waiting_input', 'paused', 'reconnecting']).executeTakeFirst());
}
