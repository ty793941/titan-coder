export type ExecutionConfig = {
  daemonId: string;
  runtime: 'codex' | 'qwen';
  credentialRef: string;
  modelRef?: string;
  workspacePath: string;
  allowedTools: string[];
  maxTurns: number;
  timeoutMs: number;
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
