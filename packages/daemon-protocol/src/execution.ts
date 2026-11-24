export type ExecutionConfig = {
  daemonId: string;
  runtime: 'codex' | 'qwen';
  credentialRef: string;
  baseUrlRef?: string;
  environmentType?: 'local' | 'cloud';
  snapshotManifestRef?: string;
  secretLeaseRef?: string;
  modelRef?: string;
  workspacePath: string;
  allowedTools: string[];
  maxTurns: number;
  timeoutMs: number;
  localPolicy?: { enabledSkills?: string[]; trustedCode?: boolean };
};

export type ExecutionCheckpoint = {
  id: string;
  messages: Array<{ role: 'user' | 'assistant' | 'tool'; text: string }>;
  successfulTools: Array<{ id: string; name: string; inputHash: string; output: unknown }>;
  evidence: Array<{ kind: string; reference: string }>;
};

export type RunDispatch = {
  jobId: string;
  runId: string;
  sessionId: string;
  taskId: string;
  projectId: string;
  goal: string;
  planHash: string;
  config: ExecutionConfig;
  claimToken: string;
  checkpoint?: ExecutionCheckpoint;
  cloud?: { executionId: string; snapshot: CloudSnapshotManifest; secretLeaseId: string; secretLeaseExpiresAt: string };
};

export type CloudSnapshotManifest = {
  schemaVersion: 1; snapshotId: string; baseRevision: string;
  checksum: `sha256:${string}`; fileCount: number; totalBytes: number;
};

export type RunProgress = {
  eventId: string;
  sequence: number;
  claimToken: string;
  type: 'running' | 'output' | 'checkpoint' | 'completed' | 'failed' | 'cancelled' | 'waiting_input';
  payload: Record<string, unknown>;
  checkpoint?: ExecutionCheckpoint;
};

export type ProgressAck = {
  accepted: boolean;
  status: string;
  cancelRequested: boolean;
};
