import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open } from 'node:fs/promises';
import { dirname } from 'node:path';

export async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('UNSAFE_STATE_DIRECTORY');
  await chmod(path, 0o700);
}

export async function openPrivateFile(path: string, flags: number) {
  await ensurePrivateDirectory(dirname(path));
  const file = await open(path, flags | constants.O_NOFOLLOW, 0o600);
  if (!(await file.stat()).isFile()) { await file.close(); throw new Error('UNSAFE_STATE_FILE'); }
  await file.chmod(0o600);
  return file;
}
