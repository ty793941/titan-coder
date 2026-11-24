import { randomBytes, randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { DomainError, workflowCommandSchema, workflowRetryRequestSchema, type WorkflowCommand } from '@titan/contracts';
import type { Transaction } from 'kysely';
import { DatabaseService } from '../../database/database.service.js';
import type { Database } from '../../database/types.js';
import { canonicalJson, sameToken, tokenHash } from '../daemons/execution-policy.js';

@Injectable()
export class WorkflowCommandsService {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

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
      await trx.updateTable('workflow_command').set({ status: 'failed', error_code: 'WORKFLOW_COMMAND_FAILED', claim_token_hash: null, lease_expires_at: null })
        .where('status', '=', 'claimed').where('lease_expires_at', '<=', now).where('attempts', '>=', 10).execute();
      const row = await trx.selectFrom('workflow_command').selectAll().where('attempts', '<', 10)
        .where(eb => eb.or([
          eb.and([eb('status', '=', 'pending'), eb('next_attempt_at', '<=', now)]),
          eb.and([eb('status', '=', 'claimed'), eb('lease_expires_at', '<=', now)]),
        ])).orderBy('created_at', 'asc').orderBy('id', 'asc').forUpdate().skipLocked().executeTakeFirst();
      if (!row) return undefined;
      const claimToken = randomBytes(32).toString('hex');
      await trx.updateTable('workflow_command').set({ status: 'claimed', attempts: row.attempts + 1, worker_id: workerId,
        claim_token_hash: tokenHash(claimToken), lease_expires_at: new Date(Date.now() + 30000) }).where('id', '=', row.id).execute();
      return workflowCommandSchema.parse({ id: row.id, claimToken, kind: row.kind, targetId: row.target_id, ...(row.definition_version ? { definitionVersion: row.definition_version } : {}) });
    });
  }

  async acknowledge(id: string, claimToken: string, workerId: string, retry?: ReturnType<typeof workflowRetryRequestSchema.parse>): Promise<void> {
    await this.database.db.transaction().execute(async trx => {
      const row = await trx.selectFrom('workflow_command').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
      if (!row) throw new DomainError('RESOURCE_NOT_FOUND', 'workflow command was not found');
      if (row.status !== 'claimed' || row.worker_id !== workerId || !sameToken(claimToken, row.claim_token_hash) || !row.lease_expires_at || row.lease_expires_at.getTime() <= Date.now()) {
        throw new DomainError('WORKFLOW_COMMAND_LEASE_EXPIRED', 'workflow command lease is no longer valid');
      }
      const status = !retry ? 'completed' : retry.retryable && row.attempts < 10 ? 'pending' : 'failed';
      await trx.updateTable('workflow_command').set({ status, claim_token_hash: null, lease_expires_at: null,
        error_code: retry?.errorCode ?? null, next_attempt_at: new Date(Date.now() + Math.min(300000, 1000 * 2 ** (row.attempts - 1))) }).where('id', '=', id).execute();
      if (!retry && row.kind === 'sync_schedule') {
        await trx.updateTable('execution_schedule').set(eb => ({ sync_status: eb.case().when('enabled', '=', true).then('active').else('paused').end() }))
          .where('id', '=', row.target_id).where('version', '=', row.definition_version!).where('sync_status', '=', 'pending_sync').execute();
      }
    });
  }
}
