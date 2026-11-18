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

export type HookPhase = 'before' | 'after';
export type HookDecision = 'allow' | 'deny';

export type HookContext = {
  phase: HookPhase;
  name?: string;
  toolName?: string;
  runId?: string;
  input?: unknown;
  output?: unknown;
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
  output: unknown;
  replayed: boolean;
};

export type GoalEvidence = { kind: string; reference: string };
export type GoalDecision = 'satisfied' | 'continue' | 'defer' | 'impossible' | 'error';
