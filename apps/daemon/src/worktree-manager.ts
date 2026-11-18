import { execFile as execFileCallback } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { DomainError } from '@titan/contracts';
import { WorkspaceManager } from './workspace-manager.js';

const execFile = promisify(execFileCallback);

export type Worktree = {
  path: string;
  branchName: string;
  baseRevision: string;
  status: 'ready';
};

export class WorktreeManager {
  private readonly workspace: WorkspaceManager;

  constructor(private readonly workspaceRoot: string) {
    this.workspace = new WorkspaceManager([workspaceRoot]);
  }

  async create(input: { repositoryPath: string; branchName: string }): Promise<Worktree> {
    const repositoryPath = await this.workspace.assertAllowed(input.repositoryPath);
    const baseRevision = (await this.git(repositoryPath, ['rev-parse', 'HEAD'])).trim();
    if (!baseRevision) throw new DomainError('WORKSPACE_CONFLICT', 'repository has no base revision');
    const safeName = input.branchName.replace(/[^a-zA-Z0-9._/-]/g, '-');
    const worktreePath = await this.workspace.assertAllowed(join(this.workspaceRoot, `worktree-${safeName.replaceAll('/', '-')}`));
    await mkdir(this.workspaceRoot, { recursive: true });
    await this.git(repositoryPath, ['worktree', 'add', '--no-checkout', '-b', safeName, worktreePath]);
    return { path: worktreePath, branchName: safeName, baseRevision, status: 'ready' };
  }

  private async git(cwd: string, args: string[]): Promise<string> {
    try {
      const result = await execFile('git', args, { cwd });
      return result.stdout;
    } catch (error) {
      throw new DomainError('WORKSPACE_CONFLICT', `git command failed: ${String(error)}`);
    }
  }
}
