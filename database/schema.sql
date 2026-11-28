CREATE TABLE IF NOT EXISTS organization (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS project (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organization(id),
  name TEXT NOT NULL,
  goal TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS task (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id),
  title TEXT NOT NULL,
  goal TEXT NOT NULL,
  acceptance_criteria JSONB NOT NULL,
  priority TEXT NOT NULL,
  stage TEXT NOT NULL DEFAULT 'questions',
  status TEXT NOT NULL DEFAULT 'active',
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS session (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES task(id),
  entry_agent TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  plan_hash TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS run (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES session(id),
  attempt INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  checkpoint_id TEXT,
  error_code TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (session_id, attempt)
);

CREATE TABLE IF NOT EXISTS event (
  event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  payload_version INTEGER NOT NULL,
  sequence BIGINT NOT NULL,
  trace_id TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES project(id),
  task_id TEXT REFERENCES task(id),
  session_id TEXT REFERENCES session(id),
  run_id TEXT REFERENCES run(id),
  actor_type TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  payload JSONB NOT NULL,
  scope_key TEXT NOT NULL,
  UNIQUE (scope_key, sequence)
);

CREATE TABLE IF NOT EXISTS outbox_event (
  event_id TEXT PRIMARY KEY REFERENCES event(event_id),
  payload JSONB NOT NULL,
  published_at TIMESTAMPTZ,
  retry_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS idempotency_record (
  scope_key TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  response_status INTEGER NOT NULL,
  response_body JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (scope_key, idempotency_key)
);

CREATE TABLE IF NOT EXISTS daemon (
  id TEXT PRIMARY KEY,
  machine_name TEXT NOT NULL,
  environment_type TEXT NOT NULL,
  capabilities JSONB NOT NULL,
  workspace_roots JSONB NOT NULL,
  max_concurrent_sessions INTEGER NOT NULL,
  daemon_version TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'registered',
  last_heartbeat_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS daemon_outbox_event (
  id TEXT PRIMARY KEY,
  daemon_id TEXT NOT NULL REFERENCES daemon(id),
  event_id TEXT NOT NULL,
  sequence BIGINT NOT NULL,
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  retry_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (daemon_id, event_id),
  UNIQUE (daemon_id, sequence)
);

CREATE TABLE IF NOT EXISTS artifact (
  artifact_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id),
  task_id TEXT NOT NULL REFERENCES task(id),
  session_id TEXT REFERENCES session(id),
  type TEXT NOT NULL,
  version INTEGER NOT NULL,
  schema_version INTEGER NOT NULL,
  uri TEXT NOT NULL,
  checksum TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  source_artifacts JSONB NOT NULL,
  created_by_type TEXT NOT NULL,
  created_by_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  review_state TEXT NOT NULL DEFAULT 'pending',
  reference TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (task_id, type, version)
);

ALTER TABLE artifact ADD COLUMN IF NOT EXISTS reference TEXT;
ALTER TABLE artifact ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE IF NOT EXISTS checkpoint (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES run(id),
  sequence BIGINT NOT NULL,
  snapshot JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS tool_call (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES run(id),
  tool_use_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  status TEXT NOT NULL,
  result JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (run_id, tool_use_id)
);

CREATE TABLE IF NOT EXISTS hook_execution (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES run(id),
  hook_name TEXT NOT NULL,
  status TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS permission_snapshot (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES run(id),
  rules JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS approval (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES run(id),
  action TEXT NOT NULL,
  decision TEXT NOT NULL,
  confirmation_token_hash TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  actor_type TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  trace_id TEXT NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_task_project ON task(project_id);
CREATE INDEX IF NOT EXISTS idx_session_task ON session(task_id);
CREATE INDEX IF NOT EXISTS idx_run_session ON run(session_id);
CREATE INDEX IF NOT EXISTS idx_event_run_sequence ON event(run_id, sequence);
CREATE INDEX IF NOT EXISTS idx_event_task_sequence ON event(task_id, sequence);
CREATE INDEX IF NOT EXISTS idx_outbox_pending ON outbox_event(published_at) WHERE published_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_daemon_outbox_pending ON daemon_outbox_event(status) WHERE status = 'pending';

-- 执行配置、令牌摘要和队列均持久保存，历史 CRUD 数据保持不变。
ALTER TABLE session ADD COLUMN IF NOT EXISTS execution_config JSONB;
ALTER TABLE session ADD COLUMN IF NOT EXISTS goal TEXT;
ALTER TABLE daemon ADD COLUMN IF NOT EXISTS auth_token_hash TEXT;

CREATE TABLE IF NOT EXISTS execution_job (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL UNIQUE REFERENCES run(id),
  daemon_id TEXT NOT NULL REFERENCES daemon(id),
  plan_hash TEXT NOT NULL,
  plan_snapshot JSONB NOT NULL,
  config JSONB NOT NULL,
  goal TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  cancel_requested BOOLEAN NOT NULL DEFAULT FALSE,
  claim_token_hash TEXT,
  lease_expires_at TIMESTAMPTZ,
  last_sequence BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS execution_progress (
  event_id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES execution_job(id),
  sequence BIGINT NOT NULL,
  request_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (job_id, sequence)
);

CREATE INDEX IF NOT EXISTS idx_execution_job_daemon_status ON execution_job(daemon_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_checkpoint_run ON checkpoint(run_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_artifact_uri_unique ON artifact(uri);
CREATE UNIQUE INDEX IF NOT EXISTS idx_artifact_reference_unique ON artifact(reference) WHERE reference IS NOT NULL;

ALTER TABLE session ADD COLUMN IF NOT EXISTS environment_type TEXT NOT NULL DEFAULT 'local';
ALTER TABLE session ADD COLUMN IF NOT EXISTS parent_session_id TEXT REFERENCES session(id);
ALTER TABLE checkpoint ADD COLUMN IF NOT EXISTS source_checkpoint_id TEXT REFERENCES checkpoint(id);

CREATE TABLE IF NOT EXISTS session_handoff (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES task(id),
  source_session_id TEXT NOT NULL REFERENCES session(id),
  source_run_id TEXT NOT NULL REFERENCES run(id),
  source_daemon_id TEXT NOT NULL REFERENCES daemon(id),
  target_session_id TEXT REFERENCES session(id),
  checkpoint_id TEXT NOT NULL REFERENCES checkpoint(id),
  workspace_sync TEXT NOT NULL CHECK (workspace_sync IN ('git-snapshot', 'git-patch')),
  snapshot_manifest JSONB,
  status TEXT NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'starting', 'completed', 'failed')),
  requested_by TEXT NOT NULL,
  error_code TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS secret_lease (
  id TEXT PRIMARY KEY,
  credential_ref TEXT NOT NULL,
  purpose TEXT NOT NULL,
  session_id TEXT NOT NULL REFERENCES session(id),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS cloud_execution (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES session(id),
  run_id TEXT NOT NULL UNIQUE REFERENCES run(id),
  daemon_id TEXT NOT NULL REFERENCES daemon(id),
  handoff_id TEXT REFERENCES session_handoff(id),
  secret_lease_id TEXT NOT NULL REFERENCES secret_lease(id),
  snapshot_manifest JSONB NOT NULL,
  container_id TEXT,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'creating', 'starting', 'running', 'stopping', 'completed', 'failed', 'cancelled')),
  attempt INTEGER NOT NULL,
  lease_expires_at TIMESTAMPTZ,
  last_heartbeat_at TIMESTAMPTZ,
  error_code TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at TIMESTAMPTZ,
  UNIQUE(session_id, run_id, attempt)
);
CREATE INDEX IF NOT EXISTS idx_cloud_execution_daemon_status ON cloud_execution(daemon_id, status);
CREATE INDEX IF NOT EXISTS idx_handoff_source_pending ON session_handoff(source_daemon_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_handoff_source_active ON session_handoff(source_session_id) WHERE status IN ('requested', 'starting');

CREATE TABLE IF NOT EXISTS execution_schedule (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id),
  task_id TEXT NOT NULL REFERENCES task(id),
  session_id TEXT NOT NULL REFERENCES session(id),
  plan_hash TEXT NOT NULL,
  timezone TEXT NOT NULL,
  cron TEXT,
  interval_seconds INTEGER CHECK (interval_seconds BETWEEN 60 AND 31536000),
  starts_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ NOT NULL CHECK (ends_at > starts_at),
  max_runs INTEGER NOT NULL CHECK (max_runs BETWEEN 1 AND 100),
  run_count INTEGER NOT NULL DEFAULT 0 CHECK (run_count BETWEEN 0 AND 100),
  overlap_policy TEXT NOT NULL DEFAULT 'skip' CHECK (overlap_policy = 'skip'),
  catchup_window_seconds INTEGER NOT NULL DEFAULT 60 CHECK (catchup_window_seconds BETWEEN 10 AND 3600),
  catchup_until TIMESTAMPTZ,
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  sync_status TEXT NOT NULL DEFAULT 'pending_sync' CHECK (sync_status IN ('pending_sync','active','paused','blocked')),
  temporal_schedule_id TEXT NOT NULL UNIQUE,
  version INTEGER NOT NULL DEFAULT 1,
  requested_by TEXT NOT NULL,
  worker_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK ((cron IS NULL) <> (interval_seconds IS NULL))
);
CREATE TABLE IF NOT EXISTS background_job (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id),
  task_id TEXT NOT NULL REFERENCES task(id),
  session_id TEXT NOT NULL REFERENCES session(id),
  run_id TEXT UNIQUE REFERENCES run(id),
  schedule_id TEXT REFERENCES execution_schedule(id),
  definition_version INTEGER,
  kind TEXT NOT NULL CHECK (kind IN ('run','observe')),
  workflow_version INTEGER NOT NULL DEFAULT 1 CHECK (workflow_version = 1),
  workflow_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending_dispatch' CHECK (status IN ('pending_dispatch','dispatching','running','waiting_input','reconnecting','cancel_requested','completed','failed','cancelled','expired')),
  deadline_at TIMESTAMPTZ NOT NULL,
  plan_hash TEXT NOT NULL,
  cancel_requested BOOLEAN NOT NULL DEFAULT FALSE,
  error_code TEXT,
  requested_by TEXT NOT NULL,
  worker_id TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK ((schedule_id IS NULL) = (definition_version IS NULL))
);
ALTER TABLE background_job ADD COLUMN IF NOT EXISTS worker_id TEXT;
ALTER TABLE execution_schedule ADD COLUMN IF NOT EXISTS worker_id TEXT;
CREATE TABLE IF NOT EXISTS workflow_command (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('start_job','cancel_job','sync_schedule')),
  target_id TEXT NOT NULL,
  definition_version INTEGER,
  idempotency_key TEXT NOT NULL UNIQUE,
  request_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','claimed','completed','failed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 10),
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  worker_id TEXT,
  claim_token_hash TEXT,
  lease_expires_at TIMESTAMPTZ,
  error_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS schedule_occurrence (
  id TEXT PRIMARY KEY,
  schedule_id TEXT NOT NULL REFERENCES execution_schedule(id),
  definition_version INTEGER NOT NULL,
  occurrence_id TEXT NOT NULL UNIQUE,
  scheduled_at TIMESTAMPTZ NOT NULL,
  admitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  job_id TEXT UNIQUE REFERENCES background_job(id),
  status TEXT NOT NULL CHECK (status IN ('created','dispatched','skipped')),
  error_code TEXT,
  UNIQUE(schedule_id, definition_version, scheduled_at)
);
CREATE INDEX IF NOT EXISTS idx_background_job_session ON background_job(session_id, created_at, id);
CREATE INDEX IF NOT EXISTS idx_schedule_session ON execution_schedule(session_id, created_at, id);
CREATE INDEX IF NOT EXISTS idx_workflow_command_pending ON workflow_command(status, next_attempt_at, created_at);

CREATE TABLE IF NOT EXISTS project_member (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id),
  subject_type TEXT NOT NULL CHECK (subject_type IN ('human', 'agent')),
  subject_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'manager', 'developer', 'reviewer', 'observer')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('invited', 'active', 'suspended', 'removed')),
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (project_id, subject_type, subject_id)
);
CREATE TABLE IF NOT EXISTS work_item (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id),
  task_id TEXT NOT NULL UNIQUE REFERENCES task(id),
  status TEXT NOT NULL DEFAULT 'backlog' CHECK (status IN ('backlog', 'ready', 'in_progress', 'blocked', 'review', 'completed', 'cancelled')),
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS assignment (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id),
  work_item_id TEXT NOT NULL REFERENCES work_item(id),
  subject_type TEXT NOT NULL CHECK (subject_type IN ('human', 'agent')),
  subject_id TEXT NOT NULL,
  responsibility TEXT NOT NULL CHECK (responsibility IN ('human-owner', 'agent-owner', 'reviewer', 'observer')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('pending', 'active', 'accepted', 'declined', 'completed', 'superseded')),
  reviewers JSONB NOT NULL DEFAULT '[]'::jsonb,
  due_at TIMESTAMPTZ,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_assignment_active_human_owner ON assignment(work_item_id) WHERE responsibility = 'human-owner' AND status IN ('pending', 'active', 'accepted');
CREATE UNIQUE INDEX IF NOT EXISTS idx_assignment_active_agent_owner ON assignment(work_item_id) WHERE responsibility = 'agent-owner' AND status IN ('pending', 'active', 'accepted');
CREATE TABLE IF NOT EXISTS review_request (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id),
  target_type TEXT NOT NULL CHECK (target_type IN ('task', 'artifact', 'run', 'work-item')),
  target_id TEXT NOT NULL,
  reviewer_type TEXT NOT NULL CHECK (reviewer_type IN ('human', 'agent')),
  reviewer_id TEXT NOT NULL,
  gate TEXT NOT NULL,
  required_decision TEXT NOT NULL CHECK (required_decision IN ('approve', 'changes_requested')),
  mode TEXT NOT NULL DEFAULT 'serial' CHECK (mode IN ('serial', 'parallel', 'conditional')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'changes_requested', 'cancelled', 'expired')),
  due_at TIMESTAMPTZ,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS handoff (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id),
  work_item_id TEXT NOT NULL REFERENCES work_item(id),
  from_assignment_id TEXT NOT NULL REFERENCES assignment(id),
  to_subject_type TEXT NOT NULL CHECK (to_subject_type IN ('human', 'agent')),
  to_subject_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  context_artifact_id TEXT REFERENCES artifact(artifact_id),
  open_questions JSONB NOT NULL DEFAULT '[]'::jsonb,
  risks JSONB NOT NULL DEFAULT '[]'::jsonb,
  next_actions JSONB NOT NULL DEFAULT '[]'::jsonb,
  status TEXT NOT NULL DEFAULT 'pending_acceptance' CHECK (status IN ('pending_acceptance', 'accepted', 'declined', 'cancelled')),
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS collaboration_inbox_item (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id),
  subject_type TEXT NOT NULL CHECK (subject_type IN ('human', 'agent')),
  subject_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('assignment', 'review', 'handoff', 'approval', 'blocked')),
  source_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'read', 'resolved', 'dismissed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ,
  UNIQUE (subject_type, subject_id, kind, source_id)
);
ALTER TABLE collaboration_inbox_item ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE review_request ADD COLUMN IF NOT EXISTS resolution_reason TEXT;
ALTER TABLE review_request ADD COLUMN IF NOT EXISTS target_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE review_request ADD COLUMN IF NOT EXISTS predecessor_id TEXT REFERENCES review_request(id);
ALTER TABLE handoff ADD COLUMN IF NOT EXISTS new_assignment_id TEXT REFERENCES assignment(id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_review_pending ON review_request(project_id, target_type, target_id, reviewer_type, reviewer_id, gate) WHERE status = 'pending';
CREATE UNIQUE INDEX IF NOT EXISTS idx_handoff_pending ON handoff(from_assignment_id) WHERE status = 'pending_acceptance';
CREATE INDEX IF NOT EXISTS idx_project_member_project_status ON project_member(project_id, status, subject_type, subject_id);
CREATE INDEX IF NOT EXISTS idx_work_item_project_status ON work_item(project_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_assignment_work_item_status ON assignment(work_item_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_review_project_status ON review_request(project_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_handoff_work_item_status ON handoff(work_item_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_collaboration_inbox_subject ON collaboration_inbox_item(subject_type, subject_id, status, created_at);
