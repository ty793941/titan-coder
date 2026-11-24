import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from 'node:child_process';

export interface CloudSnapshotManifest {
  schemaVersion: 1;
  snapshotId: string;
  baseRevision: string;
  checksum: string;
  fileCount: number;
  totalBytes: number;
}

export type CloudSnapshotFileMode = 0 | 0o100;
export interface CloudSnapshotFile {
  path: string;
  content: string;
  mode?: CloudSnapshotFileMode;
}

export interface ContainerHandle { id: string; name: string }
export interface ContainerScope { sessionId: string; runId: string }
export interface ContainerSpec extends ContainerScope { workspacePath: string }
export interface ContainerStatus { state: 'created' | 'running' | 'exited' | 'missing'; exitCode?: number }
export interface DockerRuntimeOptions { image: string; workspaceRoot: string; ownerId: string; network?: string }
export interface DockerRuntimeDependencies {
  spawn?: (command: string, args: readonly string[], options: SpawnOptionsWithoutStdio) => ChildProcessWithoutNullStreams;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

export interface SecretLeaseInput {
  leaseId: string;
  sessionId: string;
  expiresAt: string;
  credentialRef: string;
  baseUrlRef?: string | undefined;
}
