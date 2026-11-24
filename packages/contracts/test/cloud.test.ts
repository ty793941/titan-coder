import { describe, expect, it } from 'vitest';
import * as contracts from '../src/schemas.js';

const local = { daemonId: 'daemon_1', runtime: 'codex', credentialRef: 'keychain://codex', baseUrlRef: 'keychain://url', workspacePath: '/repo', allowedTools: ['artifact.write'], maxTurns: 10, timeoutMs: 10000 };

describe('cloud contracts', () => {
  it('keeps execution config composable and retains local defaults and URL references', () => {
    expect(contracts.executionConfigSchema.shape.baseUrlRef).toBeDefined();
    expect(contracts.executionConfigSchema.omit({ credentialRef: true }).shape.runtime).toBeDefined();
    expect(contracts.executionConfigSchema.parse({ ...local, environmentType: 'local' }).baseUrlRef).toBe(local.baseUrlRef);
    expect(contracts.executionConfigSchema.parse(local).environmentType ?? 'local').toBe('local');
  });

  it('validates cloud references separately from the ZodObject', () => {
    expect(typeof contracts.validateExecutionConfig).toBe('function');
    const cloud = { ...local, environmentType: 'cloud', workspacePath: '/workspace/session', snapshotManifestRef: 'snapshot://snapshot_1', secretLeaseRef: 'lease://lease_1' };
    expect(contracts.validateExecutionConfig(cloud)).toMatchObject(cloud);
    for (const input of [{ ...cloud, snapshotManifestRef: undefined }, { ...cloud, secretLeaseRef: undefined }, { ...cloud, workspacePath: '/Users/private' }, { ...cloud, credentialRef: 'sk-secret-value' }]) {
      expect(() => contracts.validateExecutionConfig(input)).toThrow();
    }
  });

  it('accepts bounded path-free manifests and strict handoff requests', () => {
    expect(typeof contracts.cloudSnapshotManifestSchema).toBe('object');
    const manifest = { schemaVersion: 1, snapshotId: '12345678-abcd-4abc-8abc-123456789abc', baseRevision: 'a'.repeat(40), checksum: `sha256:${'b'.repeat(64)}`, fileCount: 2, totalBytes: 100 };
    expect(contracts.cloudSnapshotManifestSchema.parse(manifest)).toEqual(manifest);
    expect(() => contracts.cloudSnapshotManifestSchema.parse({ ...manifest, path: '/Users/private' })).toThrow();
    expect(() => contracts.cloudSnapshotManifestSchema.parse({ ...manifest, snapshotId: '../escape' })).toThrow();
    expect(() => contracts.cloudSnapshotManifestSchema.parse({ ...manifest, totalBytes: 1024 ** 4 })).toThrow();
    expect(contracts.handoffCreateRequestSchema.parse({ checkpointId: 'cp_1', targetEnvironment: 'cloud', workspaceSync: { mode: 'git-patch' }, idempotencyKey: 'handoff' })).toHaveProperty('targetEnvironment', 'cloud');
  });

  it('matches adapter UUID, file count and aggregate byte limits exactly', () => {
    const manifest = { schemaVersion: 1, snapshotId: '12345678-abcd-4abc-8abc-123456789abc', baseRevision: 'a'.repeat(64), checksum: `sha256:${'b'.repeat(64)}`, fileCount: 10000, totalBytes: 32 * 1024 * 1024 };
    expect(contracts.cloudSnapshotManifestSchema.parse(manifest)).toEqual(manifest);
    for (const override of [
      { snapshotId: 'snapshot_12345678-abcd-4abc-8abc-123456789abc' },
      { snapshotId: manifest.snapshotId.toUpperCase() },
      { snapshotId: 'not-a-uuid' },
      { fileCount: 10001 }, { fileCount: -1 }, { fileCount: 0.5 },
      { totalBytes: 32 * 1024 * 1024 + 1 }, { totalBytes: -1 }, { totalBytes: 0.5 },
      { baseRevision: 'a'.repeat(39) }, { baseRevision: 'a'.repeat(41) }, { baseRevision: 'g'.repeat(40) },
      { checksum: 'b'.repeat(64) }, { checksum: `sha512:${'b'.repeat(64)}` }, { checksum: `sha256:${'B'.repeat(64)}` },
    ]) expect(contracts.cloudSnapshotManifestSchema.safeParse({ ...manifest, ...override }).success, JSON.stringify(override)).toBe(false);
  });
});
