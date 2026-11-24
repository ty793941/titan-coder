import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, symlink, realpath, stat, rename, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { LocalSnapshotStore } from '../../src/cloud/snapshot-store.js';

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'titan-cloud-snapshot-')));
  const source = join(root, 'source');
  const snapshots = join(root, 'snapshots');
  await mkdir(source, { mode: 0o700 });
  const store = new LocalSnapshotStore({ root: snapshots, workspaceRoots: [root] });
  return { root, source, snapshots, store };
}

describe('LocalSnapshotStore', () => {
  it('roundtrips full current bytes, including untracked files, through a fresh store', async () => {
    const { root, source, snapshots, store } = await fixture();
    execFileSync('git', ['init', '-q', source]);
    execFileSync('git', ['-C', source, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-qm', 'baseline']);
    await writeFile(join(source, 'current.bin'), Buffer.from([0, 1, 2, 255]));
    await mkdir(join(source, 'src'));
    await writeFile(join(source, 'src', 'app.ts'), 'export const answer = 42;\n');
    const manifest = await store.exportWorkspace(source);
    expect(Object.keys(manifest).sort()).toEqual(['baseRevision', 'checksum', 'fileCount', 'schemaVersion', 'snapshotId', 'totalBytes']);
    expect(manifest.baseRevision).toBe(execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim());
    const bytes = await readFile(join(snapshots, `${manifest.snapshotId}.json`));
    expect(manifest.checksum).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(manifest.fileCount).toBe(2);
    const destination = join(root, 'materialized');
    await new LocalSnapshotStore({ root: snapshots, workspaceRoots: [root] }).materialize(manifest, destination);
    expect(await readFile(join(destination, 'current.bin'))).toEqual(Buffer.from([0, 1, 2, 255]));
    expect(await readFile(join(destination, 'src', 'app.ts'), 'utf8')).toBe('export const answer = 42;\n');
    expect((await stat(destination)).mode & 0o777).toBe(0o700);
  });

  it('excludes metadata, dependencies, credentials, environment and linked files', async () => {
    const { source, store } = await fixture();
    for (const name of ['.git', '.titan', '.humanlayer', '.codegraph', 'node_modules', 'dist', 'coverage', 'credentials']) {
      await mkdir(join(source, name));
      await writeFile(join(source, name, 'private'), 'secret=hidden');
    }
    for (const name of ['.env', '.env.development', 'private.pem', 'id_rsa', 'service-account.json', 'api-key.txt', 'auth.json', '.npmrc', '.netrc', 'keys.json']) await writeFile(join(source, name), 'secret=hidden');
    await writeFile(join(source, 'safe.txt'), 'safe');
    await symlink(join(source, '.env'), join(source, 'linked'));
    expect((await store.exportWorkspace(source)).fileCount).toBe(1);
  });

  it('rejects sensitive content and single-file overflow', async () => {
    const { source, store } = await fixture();
    await writeFile(join(source, 'config.txt'), 'Authorization: Bearer abcdefghijklmnop');
    await expect(store.exportWorkspace(source)).rejects.toThrow('CLOUD_SNAPSHOT_SENSITIVE');
    await writeFile(join(source, 'config.txt'), Buffer.alloc(1024 * 1024 + 1));
    await expect(store.exportWorkspace(source)).rejects.toThrow('CLOUD_SNAPSHOT_LIMIT');
  });

  it('refuses untrusted roots, existing destinations and linked parents', async () => {
    const { root, source, store } = await fixture();
    await writeFile(join(source, 'safe'), 'safe');
    const manifest = await store.exportWorkspace(source);
    await expect(store.exportWorkspace(tmpdir())).rejects.toThrow('CLOUD_SNAPSHOT_PATH');
    await expect(store.materialize(manifest, source)).rejects.toThrow('CLOUD_SNAPSHOT_PATH');
    await symlink(source, join(root, 'alias'));
    await expect(store.materialize(manifest, join(root, 'alias', 'destination'))).rejects.toThrow('CLOUD_SNAPSHOT_PATH');
    await expect(store.materialize(manifest, join(root, '..', 'escape'))).rejects.toThrow('CLOUD_SNAPSHOT_PATH');
  });

  it('verifies exact package bytes and all manifest counts before creating destination', async () => {
    const { root, source, snapshots, store } = await fixture();
    await writeFile(join(source, 'safe'), 'safe');
    const manifest = await store.exportWorkspace(source);
    const destination = join(root, 'target');
    await expect(store.materialize({ ...manifest, fileCount: 2 }, destination)).rejects.toThrow('CLOUD_SNAPSHOT_INVALID');
    await expect(stat(destination)).rejects.toMatchObject({ code: 'ENOENT' });
    await writeFile(join(snapshots, `${manifest.snapshotId}.json`), 'tampered');
    await expect(store.materialize(manifest, destination)).rejects.toThrow('CLOUD_SNAPSHOT_CHECKSUM');
  });

  it.each(['traversal', 'duplicate', 'base64', 'size', 'secret', 'excluded', 'ancestor'])('rejects malicious %s packages before any destination write', async kind => {
    const { root, source, snapshots, store } = await fixture();
    await writeFile(join(source, 'safe'), 'safe');
    const manifest = await store.exportWorkspace(source);
    const path = join(snapshots, `${manifest.snapshotId}.json`);
    const pack = JSON.parse(await readFile(path, 'utf8'));
    if (kind === 'traversal') pack.files[0].path = '../escape';
    if (kind === 'duplicate') pack.files.push({ ...pack.files[0] });
    if (kind === 'base64') pack.files[0].content = '!!!!';
    if (kind === 'size') pack.files[0].content = Buffer.alloc(1024 * 1024 + 1).toString('base64');
    if (kind === 'secret') pack.files[0].content = Buffer.from('api_key=abcdef').toString('base64');
    if (kind === 'excluded') pack.files[0].path = '.env.local';
    if (kind === 'ancestor') pack.files.push({ path: 'safe/child', content: 'YQ==' });
    const bytes = Buffer.from(JSON.stringify(pack));
    await writeFile(path, bytes);
    const changed = { ...manifest, checksum: createHash('sha256').update(bytes).digest('hex') };
    await expect(store.materialize(changed, join(root, 'target'))).rejects.toThrow(/CLOUD_SNAPSHOT_/);
    await expect(stat(join(root, 'target'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses a substituted package symlink', async () => {
    const { root, source, snapshots, store } = await fixture();
    const manifest = await store.exportWorkspace(source);
    const path = join(snapshots, `${manifest.snapshotId}.json`);
    await rename(path, join(root, 'elsewhere'));
    await symlink(join(root, 'elsewhere'), path);
    await expect(store.materialize(manifest, join(root, 'target'))).rejects.toThrow('CLOUD_SNAPSHOT_');
  });

  it('rejects writable shared materialization parents', async () => {
    const { root, source, store } = await fixture();
    const manifest = await store.exportWorkspace(source);
    await mkdir(join(root, 'shared'));
    await chmod(join(root, 'shared'), 0o777);
    await expect(store.materialize(manifest, join(root, 'shared', 'target'))).rejects.toThrow('CLOUD_SNAPSHOT_PATH');
    await expect(stat(join(root, 'shared', 'target'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('enforces total byte and file count limits', async () => {
    const { source, store } = await fixture();
    for (let index = 0; index < 33; index++) await writeFile(join(source, `${index}.bin`), Buffer.alloc(1024 * 1024));
    await expect(store.exportWorkspace(source)).rejects.toThrow('CLOUD_SNAPSHOT_LIMIT');
    const other = await fixture();
    for (let index = 0; index <= 10_000; index++) await writeFile(join(other.source, `${index}.txt`), '');
    await expect(other.store.exportWorkspace(other.source)).rejects.toThrow('CLOUD_SNAPSHOT_LIMIT');
  }, 20_000);

  it('exports workspaces whose snapshot store is inside excluded metadata', async () => {
    const { root, source } = await fixture();
    await mkdir(join(source, '.titan'));
    const store = new LocalSnapshotStore({ root: join(source, '.titan', 'snapshots'), workspaceRoots: [root] });
    await writeFile(join(source, 'safe'), 'safe');
    expect((await store.exportWorkspace(source)).fileCount).toBe(1);
  });
});
