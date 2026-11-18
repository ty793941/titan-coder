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
}
