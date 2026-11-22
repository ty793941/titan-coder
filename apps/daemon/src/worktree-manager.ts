import { execFile as execFileCallback } from 'node:child_process';
import { mkdir, rmdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { DomainError } from '@titan/contracts';
import { exportGitEvidence, type ExportChangesInput, type GitEvidenceBundle } from './git-evidence.js';
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
    if (!input.branchName || input.branchName.startsWith('-')) throw new DomainError('WORKSPACE_CONFLICT', 'invalid branch name');
    const validatedBranch = (await this.git(repositoryPath, ['check-ref-format', '--branch', input.branchName])).trim();
    if (validatedBranch !== input.branchName) throw new DomainError('WORKSPACE_CONFLICT', 'branch name must not use revision shorthand');
    const baseRevision = (await this.git(repositoryPath, ['rev-parse', 'HEAD'])).trim();
    if (!baseRevision) throw new DomainError('WORKSPACE_CONFLICT', 'repository has no base revision');
    const safeName = input.branchName;
    const digest = createHash('sha256').update(safeName).digest('hex').slice(0, 12);
    const worktreePath = await this.workspace.assertAllowed(join(this.workspaceRoot, `worktree-${safeName.replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 100)}-${digest}`));
    await mkdir(this.workspaceRoot, { recursive: true });
    const lock = await this.workspace.assertAllowed(`${worktreePath}.lock`);
    try {
      await mkdir(lock);
    } catch {
      throw new DomainError('WORKSPACE_CONFLICT', 'worktree directory is locked');
    }
    try {
      await this.workspace.assertAllowed(worktreePath);
      await this.git(repositoryPath, ['worktree', 'add', '-b', safeName, worktreePath, baseRevision]);
      return { path: worktreePath, branchName: safeName, baseRevision, status: 'ready' };
    } finally {
      await rmdir(lock);
    }
  }

  async exportChanges(input: ExportChangesInput): Promise<GitEvidenceBundle> {
    return exportGitEvidence({ ...input, workspaceRoot: this.workspaceRoot });
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
