import { isAbsolute, resolve } from 'node:path';
import { DomainError } from '@titan/contracts';
import type { DatabaseLike } from '../../common/idempotency.service.js';
import type { ArtifactContentRoot } from './artifact-content.js';

export async function cloudArtifactScope(db: DatabaseLike, sessionId: string, daemonId: string): Promise<ArtifactContentRoot> {
  const owner = await db.selectFrom('cloud_execution')
    .innerJoin('session', 'session.id', 'cloud_execution.session_id')
    .innerJoin('daemon', 'daemon.id', 'cloud_execution.daemon_id')
    .select(['daemon.workspace_roots', 'daemon.environment_type as daemon_environment', 'session.environment_type as session_environment', 'session.execution_config'])
    .where('cloud_execution.session_id', '=', sessionId).where('cloud_execution.daemon_id', '=', daemonId).executeTakeFirst();
  if (!owner || owner.daemon_environment !== 'cloud' || owner.session_environment !== 'cloud' || !/^[A-Za-z0-9_-]+$/.test(sessionId)) {
    throw new DomainError('PERMISSION_DENIED', 'cloud artifact requires its owning session and daemon');
  }
  const config = owner.execution_config as Record<string, unknown> | null;
  if (!config || config.environmentType !== 'cloud' || config.daemonId !== daemonId || config.workspacePath !== '/workspace/session') {
    throw new DomainError('PERMISSION_DENIED', 'cloud artifact execution ownership is invalid');
  }
  const roots = owner.workspace_roots;
  if (!Array.isArray(roots) || roots.length !== 1 || typeof roots[0] !== 'string' || !isAbsolute(roots[0]) || roots[0].includes('\0')) {
    throw new DomainError('PERMISSION_DENIED', 'cloud artifact requires one unambiguous registered workspace root');
  }
  const authorizationRoot = resolve(roots[0]);
  const workspacePath = resolve(authorizationRoot, sessionId, 'session');
  return { authorizationRoot, workspacePath, artifactRoot: resolve(workspacePath, '.titan', 'artifacts') };
}
