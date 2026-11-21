import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, realpath, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceManager } from '../src/workspace-manager.js';

describe('WorkspaceManager', () => {
  it('rejects a workspace path outside the configured root', async () => {
    const manager = new WorkspaceManager(['/repo']);
    await expect(manager.assertAllowed('/tmp/other/file.ts')).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  });

  it('rejects a missing descendant below an escaping symlink', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'titan-path-')));
    const allowed = join(root, 'allowed');
    const outside = join(root, 'outside');
    await mkdir(allowed);
    await mkdir(outside);
    await symlink(outside, join(allowed, 'escape'));
    await expect(new WorkspaceManager([allowed]).assertAllowed(join(allowed, 'escape', 'missing', 'deep')))
      .rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  });

  it('canonicalizes missing workspace roots through their existing ancestor', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'titan-path-')));
    const target = join(root, 'target');
    await mkdir(target);
    await symlink(target, join(root, 'alias'));
    const manager = new WorkspaceManager([join(root, 'alias', 'missing')]);
    expect(await manager.assertAllowed(join(target, 'missing', 'nested'))).toBe(join(target, 'missing', 'nested'));
  });
});
