export type Provider = "codex" | "qwen";
export type Stage =
  | "questions"
  | "research"
  | "design"
  | "structure"
  | "plan"
  | "implement"
  | "verify"
  | "review"
  | "delivered";
export type Priority = "low" | "medium" | "high" | "critical";
export interface Project {
  id: string;
  name: string;
  goal: string;
}
export interface Task {
  id: string;
  projectId: string;
  title: string;
  goal: string;
  stage: Stage;
  status: string;
  version: number;
  acceptanceCriteria: string[];
  priority: Priority;
  createdAt: string;
}
export interface Execution {
  daemonId: string;
  runtime: Provider;
  credentialRef?: string;
  modelRef?: string;
  workspacePath: string;
  allowedTools: string[];
  maxTurns: number;
  timeoutMs: number;
}
export interface Session {
  id: string;
  taskId: string;
  status: string;
  planHash?: string;
  execution?: Execution;
  createdAt: string;
}
export interface Run {
  id: string;
  sessionId: string;
  attempt: number;
  status: string;
  checkpointId?: string;
  errorCode?: string;
  createdAt: string;
}
export interface Daemon {
  daemonId: string;
  machineName: string;
  status: string;
  capabilities: string[];
  workspaceRoots: string[];
}
export interface ConsoleState {
  projects: Project[];
  tasks: Task[];
  sessions: Session[];
  runs: Run[];
  daemons: Daemon[];
}
export interface Artifact {
  artifactId: string;
  type: string;
  version: number;
  checksum: string;
  reviewState: "pending" | "approved" | "changes_requested";
  status?: "draft" | "approved" | "archived";
  sourceArtifacts: string[];
  uri: string;
  createdAt?: string;
  taskId?: string;
}
export interface ArtifactContent {
  content: string;
  format: "markdown" | "json" | "text";
  checksum: string;
  bytes: number;
}
export interface CredentialStatus {
  provider: Provider;
  configured: boolean;
  credentialRef: string;
}
export interface LocalStatus {
  csrfToken: string;
  workspaceRoot: string;
  platform: string;
  controlPlane: { reachable: boolean };
  daemon: { running: boolean; daemonId?: string };
  credentials: CredentialStatus[];
}
export interface RunEvent {
  eventId: string;
  eventType: string;
  sequence: number;
  occurredAt?: string;
  payload?: unknown;
  traceId?: string;
}
export interface SessionInput {
  entryAgent: "project-manager";
  goal: string;
  planHash: string;
  execution: Execution;
  idempotencyKey: string;
}
