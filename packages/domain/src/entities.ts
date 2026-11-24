import type {
  ArtifactId,
  ArtifactType,
  ProjectId,
  RunId,
  SessionId,
  TaskId,
} from '@titan/contracts';

export type TaskStage =
  | 'questions' | 'research' | 'design' | 'structure' | 'plan' | 'implement'
  | 'verify' | 'review' | 'delivered';

export type TaskStatus = 'active' | 'blocked' | 'paused' | 'cancelled' | 'failed' | 'completed';

export type ExecutionStatus =
  | 'queued' | 'starting' | 'running' | 'waiting_input' | 'paused' | 'reconnecting'
  | 'completed' | 'failed' | 'cancelled';

export type Actor = { type: 'user' | 'agent' | 'daemon' | 'system'; id: string };

export type Project = {
  id: ProjectId;
  name: string;
  goal: string;
  createdAt: string;
  version: number;
};

export type Task = {
  id: TaskId;
  projectId: ProjectId;
  title: string;
  goal: string;
  acceptanceCriteria: string[];
  priority: 'low' | 'medium' | 'high' | 'critical';
  stage: TaskStage;
  status: TaskStatus;
  version: number;
  createdAt: string;
};

export type Session = {
  id: SessionId;
  taskId: TaskId;
  status: ExecutionStatus;
  entryAgent: 'project-manager';
  planHash?: string;
  environmentType?: 'local' | 'cloud';
  parentSessionId?: SessionId;
  createdAt: string;
};

export type Run = {
  id: RunId;
  sessionId: SessionId;
  attempt: number;
  status: ExecutionStatus;
  checkpointId?: string;
  errorCode?: string;
  createdAt: string;
};

export type Artifact = {
  artifactId: ArtifactId;
  projectId: ProjectId;
  taskId: TaskId;
  sessionId?: SessionId;
  type: ArtifactType;
  version: number;
  schemaVersion: number;
  uri: string;
  checksum: `sha256:${string}`;
  status: 'draft' | 'approved' | 'archived';
  sourceArtifacts: ArtifactId[];
  createdBy: Actor;
  createdAt: string;
  reviewState: 'pending' | 'approved' | 'changes_requested';
};
