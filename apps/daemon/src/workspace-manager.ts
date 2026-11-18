import { realpath } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import { DomainError } from '@titan/contracts';

export class WorkspaceManager {
  private readonly roots: string[];

  constructor(workspaceRoots: string[]) {
    this.roots = workspaceRoots.map(root => {
      try {
        return realpathSync(resolve(root));
      } catch {
        return resolve(root);
      }
    });
  }

  async assertAllowed(candidate: string): Promise<string> {
    const normalized = await this.normalize(candidate);
    const allowed = this.roots.some(root => {
      const difference = relative(root, normalized);
      return difference === '' || (!difference.startsWith('..') && !isAbsolute(difference));
    });
    if (!allowed) throw new DomainError('PERMISSION_DENIED', `path is outside authorized workspace: ${candidate}`);
    return normalized;
  }

  private async normalize(candidate: string): Promise<string> {
    try {
      return await realpath(candidate);
    } catch {
      try {
        const parent = await realpath(dirname(candidate));
        return resolve(parent, basename(candidate));
      } catch {
        return resolve(candidate);
      }
    }
  }
}
