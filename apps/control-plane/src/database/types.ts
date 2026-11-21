import type { Generated } from 'kysely';

export type JsonValue = Record<string, unknown> | unknown[] | string | number | boolean | null;

export interface OrganizationTable {
  id: string;
  name: string;
  status: string;
  created_at: Date;
}

export interface ProjectTable {
  id: string;
  organization_id: string;
  name: string;
  goal: string;
  version: number;
  created_at: Date;
}

export interface TaskTable {
  id: string;
  project_id: string;
  title: string;
  goal: string;
  acceptance_criteria: JsonValue;
  priority: string;
  stage: string;
  status: string;
  version: number;
  created_at: Date;
}

export interface SessionTable {
  id: string;
  task_id: string;
  entry_agent: string;
  status: string;
  plan_hash: string | null;
  execution_config: Generated<JsonValue>;
  goal: Generated<string | null>;
  version: number;
  created_at: Date;
}

export interface RunTable {
  id: string;
  session_id: string;
  attempt: number;
  status: string;
  checkpoint_id: string | null;
  error_code: string | null;
  version: number;
  created_at: Date;
}

export interface EventTable {
  event_id: string;
  event_type: string;
  payload_version: number;
  sequence: number;
  trace_id: string;
  project_id: string;
  task_id: string | null;
  session_id: string | null;
  run_id: string | null;
  actor_type: string;
  actor_id: string;
  occurred_at: Date;
  payload: JsonValue;
  scope_key: string;
}

export interface OutboxEventTable {
  event_id: string;
  payload: JsonValue;
  published_at: Date | null;
  retry_count: number;
}

export interface IdempotencyRecordTable {
  scope_key: string;
  idempotency_key: string;
  request_hash: string;
  response_status: number;
  response_body: JsonValue;
  created_at: Date;
}

export interface ArtifactTable {
  artifact_id: string;
  project_id: string;
  task_id: string;
  session_id: string | null;
  type: string;
  version: number;
  schema_version: number;
  uri: string;
  checksum: string;
  status: string;
  source_artifacts: JsonValue;
  created_by_type: string;
  created_by_id: string;
  created_at: Date;
  review_state: string;
  reference: string | null;
  metadata: JsonValue;
}

export interface DaemonTable {
  id: string;
  machine_name: string;
  environment_type: string;
  capabilities: JsonValue;
  workspace_roots: JsonValue;
  max_concurrent_sessions: number;
  daemon_version: string;
  status: string;
  last_heartbeat_at: Date;
  created_at: Date;
  auth_token_hash: Generated<string | null>;
}

export interface ExecutionJobTable {
  id: string;
  run_id: string;
  daemon_id: string;
  plan_hash: string;
  plan_snapshot: JsonValue;
  config: JsonValue;
  goal: string;
  status: Generated<string>;
  cancel_requested: Generated<boolean>;
  claim_token_hash: Generated<string | null>;
  lease_expires_at: Generated<Date | null>;
  last_sequence: Generated<number>;
  created_at: Generated<Date>;
}

export interface CheckpointTable {
  id: string;
  run_id: string;
  sequence: number;
  snapshot: JsonValue;
  created_at: Generated<Date>;
}

export interface ExecutionProgressTable {
  event_id: string;
  job_id: string;
  sequence: number;
  request_hash: string;
  created_at: Generated<Date>;
}

export interface ToolCallTable {
  id: string;
  run_id: string;
  tool_use_id: string;
  tool_name: string;
  status: string;
  result: JsonValue | null;
  created_at: Generated<Date>;
}

export interface HookExecutionTable {
  id: string;
  run_id: string;
  hook_name: string;
  status: string;
  duration_ms: number;
  created_at: Generated<Date>;
}

export interface AuditLogTable {
  id: string;
  actor_type: string;
  actor_id: string;
  action: string;
  target_type: string;
  target_id: string;
  trace_id: string;
  payload: JsonValue;
  created_at: Generated<Date>;
}

export interface DaemonOutboxEventTable {
  id: string;
  daemon_id: string;
  event_id: string;
  sequence: number;
  event_type: string;
  payload: JsonValue;
  status: string;
  retry_count: number;
  created_at: Date;
}

export interface Database {
  organization: OrganizationTable;
  project: ProjectTable;
  task: TaskTable;
  session: SessionTable;
  run: RunTable;
  event: EventTable;
  outbox_event: OutboxEventTable;
  idempotency_record: IdempotencyRecordTable;
  artifact: ArtifactTable;
  daemon: DaemonTable;
  daemon_outbox_event: DaemonOutboxEventTable;
  execution_job: ExecutionJobTable;
  execution_progress: ExecutionProgressTable;
  checkpoint: CheckpointTable;
  tool_call: ToolCallTable;
  hook_execution: HookExecutionTable;
  audit_log: AuditLogTable;
}
