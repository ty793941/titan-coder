import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, open, rename, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it, vi } from 'vitest';
import { readArtifactContent } from '../src/modules/artifacts/artifact-content.js';

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, open: vi.fn(actual.open) };
});

it('rejects an intermediate directory swapped to an outside symlink between realpath and open', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'titan-artifact-race-'));
  const root = join(workspace, '.titan', 'artifacts');
  const directory = join(root, 'nested');
  const outside = join(workspace, 'outside');
  await mkdir(directory, { recursive: true });
  await mkdir(outside);
  await writeFile(join(directory, 'result.md'), 'inside');
  await writeFile(join(outside, 'result.md'), 'outside secret');
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  vi.mocked(open).mockImplementationOnce(async (...args) => {
    await rename(directory, `${directory}-original`);
    await symlink(outside, directory);
    return actual.open(...args);
  });
  const checksum = `sha256:${createHash('sha256').update('outside secret').digest('hex')}`;
  await expect(readArtifactContent(pathToFileURL(join(directory, 'result.md')).toString(), checksum,
    [{ workspacePath: workspace, artifactRoot: root }])).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
});
