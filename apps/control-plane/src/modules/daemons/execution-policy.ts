import { createHash, timingSafeEqual } from 'node:crypto';
import { isAbsolute, relative } from 'node:path';
import { DomainError, validateExecutionConfig } from '@titan/contracts';
import type { Kysely, Transaction } from 'kysely';
import type { Database } from '../../database/types.js';

export const tokenHash = (value: string): string => createHash('sha256').update(value).digest('hex');
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
export const sameToken = (value: string, hash: string | null): boolean => {
  if (!hash || !/^[a-f0-9]{64}$/.test(hash)) return false;
  return timingSafeEqual(Buffer.from(tokenHash(value), 'hex'), Buffer.from(hash, 'hex'));
};

export function daemonStatus(row: { status: string; last_heartbeat_at: Date }): string {
  if (row.status === 'revoked') return 'revoked';
  const elapsed = Date.now() - row.last_heartbeat_at.getTime();
  if (elapsed > 90000) return 'disconnected';
  if (elapsed > 30000) return 'reconnecting';
  return row.status;
}

export async function latestApprovedPlan(db: Kysely<Database> | Transaction<Database>, taskId: string, checksum: string) {
  const plan = await db.selectFrom('artifact').selectAll().where('task_id', '=', taskId)
    .where('type', '=', 'plan').where('status', '=', 'approved').where('review_state', '=', 'approved')
    .orderBy('version', 'desc').executeTakeFirst();
  if (!plan || plan.checksum !== checksum) throw new DomainError('PLAN_HASH_STALE', 'only the latest approved plan checksum is valid');
  return plan;
}

export const cloudCapabilities = ['cloud-session', 'container', 'snapshot-transfer', 'secret-lease'];

export async function validateExecution(db: Kysely<Database> | Transaction<Database>, config: ReturnType<typeof validateExecutionConfig>): Promise<void> {
  validateExecutionConfig(config);
  const daemon = await db.selectFrom('daemon').selectAll().where('id', '=', config.daemonId).executeTakeFirst();
  if (!daemon || daemonStatus(daemon) !== 'ready') throw new DomainError('DAEMON_UNAVAILABLE', 'execution daemon must be ready');
  const environment = config.environmentType ?? 'local';
  const required = environment === 'cloud' ? [config.runtime, ...cloudCapabilities] : [config.runtime];
  if (daemon.environment_type !== environment || !required.every(capability => (daemon.capabilities as string[]).includes(capability))) {
    throw new DomainError('PERMISSION_DENIED', 'daemon does not support the requested local runtime');
  }
  if (environment === 'cloud') return;
  const withinScope = isAbsolute(config.workspacePath) && (daemon.workspace_roots as string[]).some(root => {
    if (!isAbsolute(root)) return false;
    const path = relative(root, config.workspacePath);
    return path === '' || (path !== '..' && !path.startsWith('../') && !isAbsolute(path));
  });
  if (!withinScope) throw new DomainError('PERMISSION_DENIED', 'workspace path is outside daemon roots');
}
