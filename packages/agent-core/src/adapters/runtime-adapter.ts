export type RuntimeName = 'codex' | 'qwen';

export type RuntimeSessionConfig = {
  runtime: RuntimeName;
  credentialRef?: string;
  modelRef?: string;
  baseUrl?: string;
  cwd?: string;
  workspace?: string;
  tools?: RuntimeToolSpec[];
  timeoutMs?: number;
  signal?: AbortSignal;
  budget?: { maxOutputTokens?: number };
};

export type RuntimeToolSpec = { name: string; description: string; inputSchema: Record<string, unknown> };
export type NativeSession = { id: string; runtime: RuntimeName };
export type CheckpointReference = { id: string };
export type RuntimeInput = { text: string; toolResults?: Array<{ id: string; output: string; isError?: boolean }>; signal?: AbortSignal };
export type NativeRuntimeEvent = { type: string; payload?: unknown };
export type RuntimeEvent = { type: 'session.started' | 'session.completed' | 'model.started' | 'model.streamed' | 'tool.requested' | 'text' | 'completed'; payload?: unknown };

export interface RuntimeAdapter {
  createSession(config: RuntimeSessionConfig): Promise<NativeSession>;
  streamEvents(session: NativeSession): AsyncIterable<RuntimeEvent>;
  sendInput(session: NativeSession, input: RuntimeInput): Promise<void>;
  pause(session: NativeSession): Promise<CheckpointReference>;
  resume(session: NativeSession, checkpoint: CheckpointReference): Promise<void>;
  cancel(session: NativeSession): Promise<void>;
  close(session: NativeSession): Promise<void>;
}
