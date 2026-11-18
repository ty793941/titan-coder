import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { WorktreeManager } from '../src/worktree-manager.js';

describe('WorktreeManager', () => {
  it('creates a task worktree on a requested branch and reports its revision', async () => {
    const root = await mkdtemp(join(tmpdir(), 'titan-worktree-'));
    const repositoryPath = join(root, 'repository');
    await mkdir(repositoryPath);
    const run = async (args: string[]) => {
      const { execFile } = await import('node:child_process');
      return new Promise<string>((resolve, reject) => execFile('git', args, { cwd: repositoryPath }, (error, stdout) => error ? reject(error) : resolve(stdout)));
    };
    await run(['init', '-q']);
    await writeFile(join(repositoryPath, 'README.md'), 'Titan\n');
    await run(['add', 'README.md']);
    await run(['-c', 'user.email=titan@example.com', '-c', 'user.name=Titan', 'commit', '-qm', 'initial']);
    const manager = new WorktreeManager(root);
    const worktree = await manager.create({ repositoryPath, branchName: 'task/task_1' });
    expect(worktree.branchName).toBe('task/task_1');
    expect(worktree.baseRevision).toMatch(/^[0-9a-f]+$/);
  });
});
