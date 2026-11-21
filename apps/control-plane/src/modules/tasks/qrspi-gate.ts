import { DomainError } from '@titan/contracts';
import type { TaskStage } from '@titan/domain';
import type { Transaction } from 'kysely';
import type { Database } from '../../database/types.js';

export const qrspiArtifactStages = ['questions', 'research', 'design', 'structure', 'plan'] as const;

export async function requireApprovedStageChain(trx: Transaction<Database>, taskId: string, stage: TaskStage) {
  const stageIndex = qrspiArtifactStages.findIndex(value => value === stage);
  if (stageIndex < 0) throw new DomainError('INVALID_STATE_TRANSITION', 'only QRSPI preparation stages can advance through this gate');
  const requiredTypes = qrspiArtifactStages.slice(0, stageIndex + 1);
  const latest = await trx.selectFrom('artifact').selectAll().distinctOn('type')
    .where('task_id', '=', taskId).where('type', 'in', requiredTypes)
    .orderBy('type').orderBy('version', 'desc').execute();
  const chain = requiredTypes.map(type => {
    const artifact = latest.find(row => row.type === type);
    if (!artifact || artifact.status !== 'approved' || artifact.review_state !== 'approved') {
      throw new DomainError('APPROVAL_REQUIRED', `latest ${type} artifact must be approved`, { stage: type });
    }
    return artifact;
  });
  for (let index = 1; index < chain.length; index += 1) {
    const artifact = chain[index]!;
    const upstream = chain[index - 1]!;
    if (!Array.isArray(artifact.source_artifacts) || !artifact.source_artifacts.includes(upstream.artifact_id)) {
      throw new DomainError('APPROVAL_REQUIRED', `${artifact.type} must reference the latest approved ${upstream.type}`, {
        artifactId: artifact.artifact_id, requiredSourceArtifactId: upstream.artifact_id,
      });
    }
  }
  return chain.map(row => ({ artifactId: row.artifact_id, type: row.type, version: row.version, checksum: row.checksum }));
}
