import { lstat, mkdir, realpath, chmod } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';

const PRIVATE_KEY_PATTERN = /-----BEGIN [^-]*PRIVATE KEY-----/i;
const CREDENTIAL_ASSIGNMENT_PATTERN = /(?:api[_-]?key|token|secret|password)\s*[:=]\s*[^\s,;]+/i;
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/i;
const API_KEY_PATTERN = /\b(?:sk|key|token)[-_][A-Za-z0-9_-]{8,}\b/i;

function walkStrings(value: unknown, visit: (value: string) => boolean): boolean {
  if (typeof value === 'string') return visit(value);
  if (Array.isArray(value)) return value.some(item => walkStrings(item, visit));
  if (value && typeof value === 'object') return Object.values(value).some(item => walkStrings(item, visit));
  return false;
}

export function containsSensitive(value: unknown, secretValues: string[] = []): boolean {
  return walkStrings(value, text => secretValues.some(secret => secret.length > 0 && text.includes(secret))
    || PRIVATE_KEY_PATTERN.test(text)
    || CREDENTIAL_ASSIGNMENT_PATTERN.test(text)
    || BEARER_PATTERN.test(text)
    || API_KEY_PATTERN.test(text));
}

export function containsSensitivePath(value: unknown): boolean {
  return walkStrings(value, text => text.split(/[\\/]/).some(part => part === '.env' || part === '.env.local' || part === '.env.production'));
}

export function sanitizeSensitive<T>(value: T, secretValues: string[] = []): T {
  if (typeof value === 'string') {
    let text = String(value);
    for (const secret of secretValues.filter(Boolean)) text = text.split(secret).join('[REDACTED]');
    return text.replace(PRIVATE_KEY_PATTERN, '[REDACTED_PRIVATE_KEY]')
      .replace(CREDENTIAL_ASSIGNMENT_PATTERN, match => `${match.split(/[:=]/, 1)[0]}=[REDACTED]`)
      .replace(BEARER_PATTERN, 'Bearer [REDACTED]')
      .replace(API_KEY_PATTERN, '[REDACTED_KEY]') as unknown as T;
  }
  if (Array.isArray(value)) return value.map(item => sanitizeSensitive(item, secretValues)) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, sanitizeSensitive(item, secretValues)])) as T;
  }
  return value;
}

export function containsUnsafePath(value: unknown, workspacePath?: string): boolean {
  const workspace = workspacePath ? resolve(workspacePath) : undefined;
  return walkStrings(value, text => {
    if (text.includes('\0')) return true;
    if (text.split(/[\\/]/).includes('..')) return true;
    if (!workspace || !text.startsWith('/')) return false;
    const candidate = resolve(text.replace(/^file:\/\//, ''));
    const child = relative(workspace, candidate);
    return child.startsWith(`..${sep}`) || child === '..';
  });
}

export async function ensureSafeDirectory(root: string, workspacePath?: string): Promise<string> {
  const requestedRoot = resolve(root);
  const base = resolve(workspacePath ?? dirname(requestedRoot));
  const baseReal = await realpath(base);
  const child = relative(resolve(base), requestedRoot);
  const resolvedRoot = resolve(baseReal, child);
  const safeChild = relative(baseReal, resolvedRoot);
  if (safeChild.startsWith(`..${sep}`) || safeChild === '..' || safeChild.includes('\0')) throw new Error('store root escapes workspace');
  let current = baseReal;
  for (const part of safeChild.split(sep).filter(Boolean)) {
    current = `${current}${sep}${part}`;
    try {
      const metadata = await lstat(current);
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new Error('store root contains an unsafe symlink');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await mkdir(current, { mode: 0o700 });
    }
  }
  await chmod(current, 0o700);
  return realpath(current);
}
