import { describe, expect, it, vi } from 'vitest';
import { openSync, mkdirSync, writeSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, realpath, rename, stat, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalSnapshotStore } from '../../src/cloud/snapshot-store.js';
import { initializeSnapshotRepository } from './snapshot-fixture.js';

vi.mock('node:fs', async importOriginal => {
  const original = await importOriginal<typeof import('node:fs')>();
  return { ...original, openSync: vi.fn(original.openSync), mkdirSync: vi.fn(original.mkdirSync), writeSync: vi.fn(original.writeSync) };
});

describe('snapshot path substitution', () => {
  it('rejects a source file swapped for a link immediately before open', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'titan-snapshot-race-')));
    const source = join(root, 'source');
    await mkdir(source);
    initializeSnapshotRepository(source);
    const file = join(source, 'safe.txt');
    await writeFile(file, 'safe');
    await writeFile(join(root, 'outside'), 'outside');
    const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
    const store = new LocalSnapshotStore({ root: join(root, 'store'), workspaceRoots: [root] });
    vi.mocked(openSync).mockImplementation((path, flags, mode) => {
      if (String(path).endsWith('/safe.txt')) {
        actual.renameSync(file, `${file}.old`);
        actual.symlinkSync(join(root, 'outside'), file);
      }
      return actual.openSync(path, flags, mode);
    });
    try { await expect(store.exportWorkspace(source)).rejects.toThrow('CLOUD_SNAPSHOT_PATH'); }
    finally { vi.mocked(openSync).mockImplementation(actual.openSync); }
  });

  it('rejects replacement of the authorized root after store construction', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'titan-snapshot-root-race-')));
    const authorized = join(root, 'authorized');
    await mkdir(authorized);
    await mkdir(join(authorized, 'source'));
    initializeSnapshotRepository(join(authorized, 'source'));
    const store = new LocalSnapshotStore({ root: join(root, 'store'), workspaceRoots: [authorized] });
    const manifest = await store.exportWorkspace(join(authorized, 'source'));
    await rename(authorized, `${authorized}.old`);
    await mkdir(authorized);
    await expect(store.materialize(manifest, join(authorized, 'target'))).rejects.toThrow('CLOUD_SNAPSHOT_PATH');
    await expect(stat(join(authorized, 'target'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('pins the materialization parent even when replaced immediately before mkdir', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'titan-snapshot-parent-race-')));
    const source = join(root, 'source');
    const parent = join(root, 'parent');
    const outside = join(root, 'outside');
    for (const path of [source, parent, outside]) await mkdir(path);
    initializeSnapshotRepository(source);
    await writeFile(join(source, 'safe'), 'safe');
    const store = new LocalSnapshotStore({ root: join(root, 'store'), workspaceRoots: [root] });
    const manifest = await store.exportWorkspace(source);
    const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
    let swapped = false;
    vi.mocked(mkdirSync).mockImplementation((path, options) => {
      if (!swapped) {
        swapped = true;
        actual.renameSync(parent, `${parent}.old`);
        actual.symlinkSync(outside, parent);
      }
      return actual.mkdirSync(path, options as never);
    });
    try { await expect(store.materialize(manifest, join(parent, 'target'))).rejects.toThrow('CLOUD_SNAPSHOT_'); }
    finally { vi.mocked(mkdirSync).mockImplementation(actual.mkdirSync); }
    expect(await readdir(outside)).toEqual([]);
  });

  it('does not publish a partial destination when a file write fails', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'titan-snapshot-write-fail-')));
    const source = join(root, 'source');
    await mkdir(source);
    initializeSnapshotRepository(source);
    await writeFile(join(source, 'a'), 'one');
    await writeFile(join(source, 'b'), 'two');
    const store = new LocalSnapshotStore({ root: join(root, 'store'), workspaceRoots: [root] });
    const manifest = await store.exportWorkspace(source);
    const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
    vi.mocked(writeSync).mockImplementationOnce(() => { throw new Error('disk full'); });
    try { await expect(store.materialize(manifest, join(root, 'target'))).rejects.toThrow('CLOUD_SNAPSHOT_'); }
    finally { vi.mocked(writeSync).mockImplementation(actual.writeSync); }
    await expect(stat(join(root, 'target'))).rejects.toMatchObject({ code: 'ENOENT' });
    await store.materialize(manifest, join(root, 'target'));
  });

  it('checks the opened file size again before allocating after a growth race', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'titan-snapshot-growth-')));
    const source = join(root, 'source');
    await mkdir(source);
    initializeSnapshotRepository(source);
    const file = join(source, 'growing.bin');
    await writeFile(file, 'safe');
    const store = new LocalSnapshotStore({ root: join(root, 'store'), workspaceRoots: [root] });
    const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
    vi.mocked(openSync).mockImplementation((path, flags, mode) => {
      if (String(path).endsWith('/growing.bin')) actual.truncateSync(file, 2 * 1024 * 1024);
      return actual.openSync(path, flags, mode);
    });
    const alloc = Buffer.alloc;
    const allocation = vi.spyOn(Buffer, 'alloc').mockImplementation((size, fill, encoding) => {
      if (size > 1024 * 1024 + 1) throw new Error('unbounded allocation');
      return alloc(size, fill, encoding);
    });
    try { await expect(store.exportWorkspace(source)).rejects.toThrow('CLOUD_SNAPSHOT_LIMIT'); }
    finally { allocation.mockRestore(); vi.mocked(openSync).mockImplementation(actual.openSync); }
  });
});
