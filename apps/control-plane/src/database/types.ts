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
  environment_type: Generated<string>;
  parent_session_id: Generated<string | null>;
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
  source_checkpoint_id: Generated<string | null>;
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
  session_handoff: SessionHandoffTable;
  cloud_execution: CloudExecutionTable;
  secret_lease: SecretLeaseTable;
  background_job: BackgroundJobTable;
  execution_schedule: ExecutionScheduleTable;
  workflow_command: WorkflowCommandTable;
  schedule_occurrence: ScheduleOccurrenceTable;
  project_member: ProjectMemberTable;
  work_item: WorkItemTable;
  assignment: AssignmentTable;
  review_request: ReviewRequestTable;
  handoff: HandoffTable;
  collaboration_inbox_item: CollaborationInboxItemTable;
}

export interface ProjectMemberTable { id: string; project_id: string; subject_type: string; subject_id: string; role: string; status: string; version: Generated<number>; created_at: Generated<Date>; }
export interface WorkItemTable { id: string; project_id: string; task_id: string; status: Generated<string>; version: Generated<number>; created_at: Generated<Date>; }
export interface AssignmentTable { id: string; project_id: string; work_item_id: string; subject_type: string; subject_id: string; responsibility: string; status: Generated<string>; reviewers: Generated<JsonValue>; due_at: Date | null; version: Generated<number>; created_at: Generated<Date>; }
export interface ReviewRequestTable { id: string; project_id: string; target_type: string; target_id: string; reviewer_type: string; reviewer_id: string; gate: string; required_decision: string; mode: Generated<string>; status: Generated<string>; due_at: Date | null; version: Generated<number>; created_at: Generated<Date>; resolved_at: Date | null; resolution_reason: Generated<string | null>; target_version: number; predecessor_id: string | null; }
export interface HandoffTable { id: string; project_id: string; work_item_id: string; from_assignment_id: string; to_subject_type: string; to_subject_id: string; reason: string; context_artifact_id: string | null; open_questions: Generated<JsonValue>; risks: Generated<JsonValue>; next_actions: Generated<JsonValue>; status: Generated<string>; version: Generated<number>; created_at: Generated<Date>; resolved_at: Date | null; new_assignment_id: Generated<string | null>; }
export interface CollaborationInboxItemTable { id: string; project_id: string; subject_type: string; subject_id: string; kind: string; source_id: string; status: Generated<string>; version: Generated<number>; created_at: Generated<Date>; resolved_at: Date | null; }

export interface BackgroundJobTable {
  id: string; project_id: string; task_id: string; session_id: string; run_id: string | null;
  schedule_id: string | null; definition_version: number | null; kind: string;
  workflow_version: Generated<number>; workflow_id: string; status: Generated<string>; deadline_at: Date;
  plan_hash: string; cancel_requested: Generated<boolean>; error_code: Generated<string | null>;
  requested_by: string; worker_id: Generated<string | null>; version: Generated<number>; created_at: Generated<Date>;
}
export interface ExecutionScheduleTable {
  id: string; project_id: string; task_id: string; session_id: string; plan_hash: string; timezone: string;
  cron: string | null; interval_seconds: number | null; starts_at: Date; ends_at: Date;
  max_runs: number; run_count: Generated<number>; overlap_policy: string; catchup_window_seconds: number;
  catchup_until: Generated<Date | null>; enabled: Generated<boolean>; sync_status: Generated<string>;
  temporal_schedule_id: string; version: Generated<number>; requested_by: string; worker_id: Generated<string | null>; created_at: Generated<Date>;
}
export interface WorkflowCommandTable {
  id: string; kind: string; target_id: string; definition_version: number | null;
  idempotency_key: string; request_hash: string; status: Generated<string>; attempts: Generated<number>;
  next_attempt_at: Generated<Date>; worker_id: Generated<string | null>; claim_token_hash: Generated<string | null>;
  lease_expires_at: Generated<Date | null>; error_code: Generated<string | null>; created_at: Generated<Date>;
}
export interface ScheduleOccurrenceTable {
  id: string; schedule_id: string; definition_version: number; occurrence_id: string;
  scheduled_at: Date; admitted_at: Generated<Date>; job_id: string | null; status: string; error_code: string | null;
}

export interface SessionHandoffTable {
  id: string; task_id: string; source_session_id: string; source_run_id: string; source_daemon_id: string;
  target_session_id: Generated<string | null>; checkpoint_id: string; workspace_sync: string;
  snapshot_manifest: Generated<JsonValue>; status: Generated<string>; requested_by: string;
  error_code: Generated<string | null>; version: Generated<number>; created_at: Generated<Date>; completed_at: Generated<Date | null>;
}
export interface SecretLeaseTable {
  id: string; credential_ref: string; purpose: string; session_id: string; expires_at: Date;
  consumed_at: Generated<Date | null>; revoked_at: Generated<Date | null>; created_at: Generated<Date>;
}
export interface CloudExecutionTable {
  id: string; session_id: string; run_id: string; daemon_id: string; handoff_id: Generated<string | null>;
  secret_lease_id: string; snapshot_manifest: JsonValue; container_id: Generated<string | null>;
  status: Generated<string>; attempt: number; lease_expires_at: Generated<Date | null>; last_heartbeat_at: Generated<Date | null>;
  error_code: Generated<string | null>; version: Generated<number>; created_at: Generated<Date>; ended_at: Generated<Date | null>;
}
