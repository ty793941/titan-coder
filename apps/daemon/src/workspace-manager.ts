import { lstatSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import { DomainError } from '@titan/contracts';

export class WorkspaceManager {
  private readonly roots: string[];

  constructor(workspaceRoots: string[]) {
    this.roots = workspaceRoots.map(root => this.normalize(root));
  }

  async assertAllowed(candidate: string): Promise<string> {
    const normalized = this.normalize(candidate);
    const allowed = this.roots.some(root => {
      const difference = relative(root, normalized);
      return difference === '' || (difference !== '..' && !difference.startsWith('../') && !isAbsolute(difference));
    });
    if (!allowed) throw new DomainError('PERMISSION_DENIED', `path is outside authorized workspace: ${candidate}`);
    return normalized;
  }

  private normalize(candidate: string): string {
    let ancestor = resolve(candidate);
    const suffix: string[] = [];
    for (;;) {
      try {
        return resolve(realpathSync(ancestor), ...suffix);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        try {
          if (lstatSync(ancestor).isSymbolicLink()) throw new DomainError('PERMISSION_DENIED', 'workspace contains a dangling symbolic link');
        } catch (statError) {
          if ((statError as NodeJS.ErrnoException).code !== 'ENOENT') throw statError;
        }
        const parent = dirname(ancestor);
        if (parent === ancestor) throw error;
        suffix.unshift(basename(ancestor));
        ancestor = parent;
      }
    }
  }
}
