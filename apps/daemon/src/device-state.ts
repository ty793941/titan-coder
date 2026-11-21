import { constants } from 'node:fs';
import { rename, open } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openPrivateFile } from './private-state.js';
import type { DeviceCredential } from './daemon-client.js';

export async function readDeviceCredential(path: string, baseUrl: string): Promise<DeviceCredential | undefined> {
  let file;
  try { file = await openPrivateFile(path, constants.O_RDONLY); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  try {
    const value = JSON.parse(await file.readFile('utf8')) as DeviceCredential;
    if (value.baseUrl !== baseUrl || typeof value.daemonId !== 'string' || !value.daemonId || typeof value.authToken !== 'string' || !value.authToken) throw new Error('INVALID_DEVICE_CREDENTIAL');
    return value;
  } finally { await file.close(); }
}

export async function saveDeviceCredential(path: string, credential: DeviceCredential): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await openPrivateFile(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY);
  try { await file.writeFile(JSON.stringify(credential)); await file.sync(); }
  finally { await file.close(); }
  await rename(temporary, path);
  const directory = await open(dirname(path), constants.O_RDONLY);
  try { await directory.sync(); } finally { await directory.close(); }
}
