import type { z } from 'zod';

export type PermissionDecision = 'allow' | 'ask' | 'deny';

export type PermissionRule = {
  source: 'platform' | 'organization' | 'project' | 'run';
  action: string;
  resource: string;
  decision: PermissionDecision;
};

export type PermissionRequest = {
  action: string;
  resource: string;
  approvalToken?: string;
};

export type ApprovalTokenValidator = (token: string, request: PermissionRequest) => boolean | Promise<boolean>;

export type HookPhase = 'before' | 'after';
export type HookDecision = 'allow' | 'deny';

export type HookContext = {
  phase: HookPhase;
  name?: string;
  toolName?: string;
  toolCallId?: string;
  runId?: string;
  input?: unknown;
  output?: unknown;
  workspacePath?: string;
  secretValues?: string[];
};

export type Hook = {
  name: string;
  phase: HookPhase;
  priority: number;
  blocking?: boolean;
  run: (context: HookContext) => Promise<HookDecision>;
};

export type ToolContext = {
  runId: string;
  approvalToken?: string;
  allowedTools?: string[];
  workspacePath?: string;
  signal?: AbortSignal;
  secretValues?: string[];
  trustedCode?: boolean;
};

export type ToolManifest = {
  name: string;
  version: number;
  input: z.ZodTypeAny;
  execute: (input: unknown, context: ToolContext) => Promise<unknown>;
};

export type ToolRequest = {
  toolUseId: string;
  name: string;
  input: unknown;
  context: ToolContext;
};

export type ToolResult = {
  toolUseId: string;
  name: string;
  inputHash: string;
  output: unknown;
  replayed: boolean;
  uncertain?: boolean;
};

export type GoalEvidence = { kind: string; reference: string };
export type GoalDecision = 'satisfied' | 'continue' | 'defer' | 'impossible' | 'error';

export type CheckpointMessage = { role: 'user' | 'assistant' | 'tool'; text: string };
export type SuccessfulTool = { id: string; name: string; inputHash: string; output: unknown };
export type ExecutionCheckpoint = {
  id: string;
  messages: CheckpointMessage[];
  successfulTools: SuccessfulTool[];
  evidence: GoalEvidence[];
};

export type AgentProgress = {
  type: 'output' | 'tool' | 'checkpoint';
  payload: Record<string, unknown>;
  checkpoint?: ExecutionCheckpoint;
};

export type AgentRunInput = {
  runId: string;
  goal: string;
  runtime?: 'codex' | 'qwen';
  credentialRef?: string;
  modelRef?: string;
  workspacePath?: string;
  allowedTools?: string[];
  timeoutMs?: number;
  maxTurns?: number;
  signal?: AbortSignal;
  checkpoint?: ExecutionCheckpoint;
  secretValues?: string[];
  trustedCode?: boolean;
};

export type HookAuditEvent = {
  source: 'hook';
  status: 'started' | 'allowed' | 'denied' | 'failed';
  hookName: string;
  phase: HookPhase;
  toolName?: string;
  toolCallId?: string;
  runId?: string;
  reason?: string;
};

export type ToolAuditEvent = {
  source: 'tool';
  status: 'started' | 'success' | 'replayed' | 'failed' | 'uncertain' | 'blocked';
  toolName: string;
  toolCallId: string;
  runId?: string;
  inputHash?: string;
  reason?: string;
};
