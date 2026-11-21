import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export async function resolveCredential(credentialRef: string): Promise<string | undefined> {
  if (credentialRef.startsWith('env://')) {
    const name = credentialRef.slice('env://'.length);
    if (!/^[A-Z][A-Z0-9_]*$/.test(name)) return undefined;
    const value = process.env[name];
    return value?.trim() || undefined;
  }
  if (process.platform !== 'darwin' || !credentialRef.startsWith('keychain://')) return undefined;
  const service = credentialRef.slice('keychain://'.length);
  if (!service || service.includes('\0')) return undefined;
  try {
    const result = await execFileAsync('security', ['find-generic-password', '-s', service, '-w'], { windowsHide: true, maxBuffer: 16 * 1024 });
    return result.stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}
