import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, realpath, stat as pathStat } from 'node:fs/promises';
import { extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DomainError } from '@titan/contracts';

export const controlPlaneArtifactRoot = (): string => resolve(process.cwd(), process.cwd().endsWith('/control-plane') ? '../../.titan/artifacts' : '.titan/artifacts');
export type ArtifactContentRoot = { workspacePath: string; artifactRoot: string; expectedPath?: string; authorizationRoot?: string };
const maxBytes = 2 * 1024 * 1024;
const within = (root: string, path: string): boolean => {
  const child = relative(root, path);
  return child !== '' && child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child);
};
const tooLarge = () => new DomainError('VALIDATION_FAILED', 'artifact content exceeds 2 MiB', { reason: 'ARTIFACT_CONTENT_TOO_LARGE', maxBytes });

export async function readArtifactContent(uri: string, checksum: string, roots: ArtifactContentRoot[]) {
  let path: string;
  try {
    const url = new URL(uri);
    if (url.protocol !== 'file:' || url.hostname || url.search || url.hash) throw new Error('invalid local URI');
    path = fileURLToPath(url);
  } catch {
    throw new DomainError('PERMISSION_DENIED', 'artifact content requires a local file URI');
  }
  const scope = roots.find(root => within(root.artifactRoot, path) && (!root.expectedPath || root.expectedPath === path));
  if (!scope) throw new DomainError('PERMISSION_DENIED', 'artifact URI is outside allowed artifact directories');
  try {
    const workspace = await realpath(scope.workspacePath);
    const authorizationRoot = scope.authorizationRoot ? await realpath(scope.authorizationRoot) : undefined;
    if (authorizationRoot && workspace !== resolve(authorizationRoot, relative(scope.authorizationRoot!, scope.workspacePath))) {
      throw new DomainError('PERMISSION_DENIED', 'cloud workspace escapes its registered session directory');
    }
    const root = await realpath(scope.artifactRoot);
    if (root !== resolve(workspace, '.titan', 'artifacts')) throw new DomainError('PERMISSION_DENIED', 'artifact directory escapes its workspace');
    const canonicalPath = await realpath(path);
    // 只规范化可信根目录的祖先别名，工件自身的相对路径必须保持固定归属。
    const expectedCanonicalPath = resolve(root, relative(scope.artifactRoot, scope.expectedPath ?? path));
    if (!within(root, canonicalPath) || canonicalPath !== expectedCanonicalPath) {
      throw new DomainError('PERMISSION_DENIED', 'artifact symlink changes its expected file identity');
    }
    const extension = extname(path).toLowerCase();
    const format = extension === '.md' || extension === '.markdown' ? 'markdown'
      : extension === '.json' ? 'json' : ['.txt', '.text', '.log'].includes(extension) ? 'text' : undefined;
    if (!format) throw new DomainError('VALIDATION_FAILED', 'artifact content format is not supported', { reason: 'ARTIFACT_CONTENT_FORMAT_UNSUPPORTED' });
    const file = await open(canonicalPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await file.stat();
      // O_NOFOLLOW 只保护末级文件；打开后复核目录与 inode，阻断中间目录替换。
      const currentPath = await realpath(path);
      const currentRoot = await realpath(scope.artifactRoot);
      const currentWorkspace = await realpath(scope.workspacePath);
      const currentAuthorizationRoot = scope.authorizationRoot ? await realpath(scope.authorizationRoot) : undefined;
      const currentStat = await pathStat(currentPath);
      if (currentAuthorizationRoot !== authorizationRoot || currentWorkspace !== workspace || currentRoot !== root || currentPath !== canonicalPath
        || !within(currentRoot, currentPath) || currentStat.dev !== stat.dev || currentStat.ino !== stat.ino) {
        throw new DomainError('PERMISSION_DENIED', 'artifact path changed while opening content');
      }
      if (!stat.isFile()) throw new DomainError('PERMISSION_DENIED', 'artifact must be a regular file');
      if (stat.size > maxBytes) throw tooLarge();
      const buffer = Buffer.alloc(maxBytes + 1);
      let bytes = 0;
      while (bytes < buffer.length) {
        const result = await file.read(buffer, bytes, buffer.length - bytes, null);
        if (result.bytesRead === 0) break;
        bytes += result.bytesRead;
      }
      if (bytes > maxBytes) throw tooLarge();
      const data = buffer.subarray(0, bytes);
      const actualChecksum = `sha256:${createHash('sha256').update(data).digest('hex')}`;
      if (actualChecksum !== checksum) throw new DomainError('VERSION_CONFLICT', 'artifact content checksum does not match metadata', { reason: 'ARTIFACT_CHECKSUM_MISMATCH' });
      let content: string;
      try { content = new TextDecoder('utf-8', { fatal: true }).decode(data); }
      catch { throw new DomainError('VALIDATION_FAILED', 'artifact content must be UTF-8 text', { reason: 'ARTIFACT_CONTENT_ENCODING_UNSUPPORTED' }); }
      return { content, format, checksum: actualChecksum, bytes };
    } finally {
      await file.close();
    }
  } catch (error) {
    if (error instanceof DomainError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') throw new DomainError('RESOURCE_NOT_FOUND', 'artifact content file was not found');
    if (code === 'ELOOP' || code === 'EACCES' || code === 'EPERM') throw new DomainError('PERMISSION_DENIED', 'artifact content file is not accessible');
    throw error;
  }
}
