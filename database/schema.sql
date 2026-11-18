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
  UNIQUE (task_id, type, version)
);

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
