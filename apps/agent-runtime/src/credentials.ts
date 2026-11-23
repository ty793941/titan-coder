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

export function validateProviderBaseUrl(value: string): string {
  let url: URL;
  try { url = new URL(value.trim()); } catch { throw new Error('INVALID_PROVIDER_BASE_URL'); }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (!['https:', ...(local ? ['http:'] : [])].includes(url.protocol) || url.username || url.password || url.hash || url.search || url.pathname.length > 4096) throw new Error('INVALID_PROVIDER_BASE_URL');
  return url.href.replace(/\/$/, '');
}
