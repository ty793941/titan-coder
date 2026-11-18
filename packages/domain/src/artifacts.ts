import { createHash } from 'node:crypto';
import type { ArtifactId, ArtifactType, ProjectId, SessionId, TaskId } from '@titan/contracts';
import type { Actor, Artifact } from './entities.js';

export type CreateArtifactVersionInput = {
  artifactId: ArtifactId | string;
  projectId: ProjectId | string;
  taskId: TaskId | string;
  sessionId?: string;
  type: ArtifactType;
  uri: string;
  content: string;
  createdBy: Actor;
  sourceArtifacts?: string[];
  createdAt?: string;
};

export function createArtifactVersion(input: CreateArtifactVersionInput): Artifact {
  const digest = createHash('sha256').update(input.content, 'utf8').digest('hex');
  const artifact = {
    artifactId: input.artifactId as ArtifactId,
    projectId: input.projectId as ProjectId,
    taskId: input.taskId as TaskId,
    type: input.type,
    version: 1,
    schemaVersion: 1,
    uri: input.uri,
    checksum: `sha256:${digest}`,
    status: 'draft',
    sourceArtifacts: (input.sourceArtifacts ?? []) as Artifact['sourceArtifacts'],
    createdBy: input.createdBy,
    createdAt: input.createdAt ?? new Date().toISOString(),
    reviewState: 'pending',
  } satisfies Omit<Artifact, 'sessionId'>;

  return input.sessionId
    ? { ...artifact, sessionId: input.sessionId as SessionId }
    : artifact;
}
