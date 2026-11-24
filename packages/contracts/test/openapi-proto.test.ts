import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const protoRoot = fileURLToPath(new URL('../../daemon-protocol/proto/', import.meta.url));
const gateway = 'titan/daemon/v1/daemon_gateway.proto';
const snapshots = 'titan/snapshot/v1/snapshot.proto';
const compiler = spawnSync('protoc', ['--version'], { encoding: 'utf8' });
const hasProtoc = compiler.status === 0;

function roundTrip(type: string, file: string, input: string) {
  const encoded = spawnSync('protoc', [`--proto_path=${protoRoot}`, `--encode=${type}`, file], { input, encoding: null });
  expect(encoded.stderr.toString()).toBe('');
  expect(encoded.status).toBe(0);
  const decoded = spawnSync('protoc', [`--proto_path=${protoRoot}`, `--decode=${type}`, file], { input: encoded.stdout, encoding: 'utf8' });
  expect(decoded.stderr).toBe('');
  expect(decoded.status).toBe(0);
  return decoded.stdout;
}

describe.skipIf(!hasProtoc)('Phase 1 reserved Protobuf contracts (requires local protoc)', () => {
  it('round trips cloud dispatch references without host paths or secrets', () => {
    const output = roundTrip('titan.daemon.v1.RunDispatch', gateway, `
      config { base_url_ref: "keychain://url" environment_type: "cloud" snapshot_manifest_ref: "snapshot://12345678-abcd-4abc-8abc-123456789abc" secret_lease_ref: "lease://lease_1" }
      cloud { execution_id: "cloud_1" snapshot { schema_version: 1 snapshot_id: "12345678-abcd-4abc-8abc-123456789abc" base_revision: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" checksum: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" file_count: 2 total_bytes: 100 } secret_lease_id: "lease_1" secret_lease_expires_at: "2026-11-24T00:00:00.000Z" }
    `);
    expect(output).toContain('base_url_ref: "keychain://url"');
    expect(output).toContain('execution_id: "cloud_1"');
  });
  it('compiles both files and freezes the gateway method boundaries', () => {
    const compiled = spawnSync('protoc', [`--proto_path=${protoRoot}`, '--include_imports', '--descriptor_set_out=/dev/stdout', gateway, snapshots], { encoding: null });
    expect(compiled.stderr.toString()).toBe('');
    expect(compiled.status).toBe(0);
    const descriptor = spawnSync('protoc', ['--decode=google.protobuf.FileDescriptorSet', 'google/protobuf/descriptor.proto'], { input: compiled.stdout, encoding: 'utf8' });
    expect(descriptor.status).toBe(0);
    expect(descriptor.stdout).toContain('name: "DaemonGateway"');
    for (const method of ['Register', 'Heartbeat', 'Claim', 'Progress', 'Control']) expect(descriptor.stdout).toContain(`name: "${method}"`);
    for (const name of ['HandoffSnapshot', 'WorkspaceSnapshot', 'EventEnvelope', 'ExecutionCheckpoint']) expect(descriptor.stdout).toContain(`name: "${name}"`);
    expect(descriptor.stdout).not.toMatch(/name: "(?:api_key|authorization|password|secret|access_token)"/);
  });

  it('round trips dispatch, checkpoint outputs and event identity without model credentials', () => {
    const dispatch = roundTrip('titan.daemon.v1.RunDispatch', gateway, `
      job_id: "job_1" run_id: "run_1" session_id: "session_1" task_id: "task_1" project_id: "project_1"
      goal: "verify" plan_hash: "sha256:plan" claim_token: "claim-proof"
      config { daemon_id: "daemon_1" runtime: "qwen" credential_ref: "local:official-qwen"
        model_ref: "qwen-plus" workspace_path: "/work/task" allowed_tools: "file.read" max_turns: 10 timeout_ms: 1000 }
      checkpoint { id: "checkpoint_1" messages { role: "user" text: "verify" }
        successful_tools { id: "tool_1" name: "file.read" input_hash: "hash_1" output { null_value: NULL_VALUE } }
        evidence { kind: "artifact" reference: "artifact://result" } }
    `);
    for (const field of ['job_id', 'run_id', 'session_id', 'task_id', 'project_id', 'plan_hash', 'claim_token', 'credential_ref', 'null_value']) expect(dispatch).toContain(`${field}:`);
    expect(dispatch).toContain('checkpoint {');
    expect(dispatch).toContain('successful_tools {');
    const event = roundTrip('titan.daemon.v1.EventEnvelope', gateway, `
      event_id: "evt_1" event_type: "run.output" payload_version: 1 sequence: 2 trace_id: "trace_1"
      project_id: "project_1" task_id: "task_1" session_id: "session_1" run_id: "run_1"
      actor { type: "daemon" id: "daemon_1" } occurred_at { seconds: 1795219200 }
      payload { struct_value { fields { key: "status" value { string_value: "running" } } } }
    `);
    expect(event).toContain('sequence: 2');
    expect(event).toContain('payload_version: 1');
    expect(event).toContain('trace_id: "trace_1"');
  });

  it('round trips the frozen cross-environment snapshot and exclusions', () => {
    const snapshot = roundTrip('titan.snapshot.v1.HandoffSnapshot', snapshots, `
      schema_version: 1 snapshot_id: "snapshot_1" project_id: "project_1" task_id: "task_1"
      source_session_id: "session_1" source_run_id: "run_1" source_checkpoint_id: "checkpoint_1"
      target_environment: "cloud" plan_hash: "sha256:plan" last_event_sequence: 3
      workspace { schema_version: 1 repo: "https://example.invalid/team/repo.git" base_revision: "0123456789012345678901234567890123456789"
        patch_uri: "artifact://patch/1" patch_sha: "sha256:patch"
        file_list { path: "src/app.ts" change: "modified" checksum: "sha256:file" size_bytes: 42 }
        excludes: ".env" excludes: ".git/**" excludes: "node_modules/**" }
      created_at { seconds: 1795219200 } created_by { type: "user" id: "local-user" }
    `);
    expect(snapshot).toContain('source_session_id: "session_1"');
    expect(snapshot).toContain('target_environment: "cloud"');
    expect(snapshot).toContain('base_revision: "0123456789012345678901234567890123456789"');
    expect(snapshot).toContain('path: "src/app.ts"');
    expect(snapshot).toContain('excludes: ".env"');
  });
});
