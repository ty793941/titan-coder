import { DomainError, executionConfigSchema } from '@titan/contracts';
import type { Selectable, Transaction } from 'kysely';
import type { Database, SessionTable } from '../../database/types.js';
import { latestApprovedPlan, validateExecution } from '../daemons/execution-policy.js';

export async function lockSession(trx: Transaction<Database>, sessionId: string) {
  const session = await trx.selectFrom('session').selectAll().where('id', '=', sessionId).forUpdate().executeTakeFirst();
  if (!session) throw new DomainError('RESOURCE_NOT_FOUND', 'session was not found');
  return session;
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
