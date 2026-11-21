import { constants } from 'node:fs';
import { lstat, mkdir, rmdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openPrivateFile } from './private-state.js';

export class StateLease {
  private constructor(private readonly directory: string, private readonly owner: string) {}

  static async acquire(stateDirectory: string): Promise<StateLease> {
    const directory = join(stateDirectory, 'runner.lock');
    const ownerPath = join(directory, 'owner.json');
    try { await mkdir(directory, { mode: 0o700 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const info = await lstat(directory);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('UNSAFE_STATE_LOCK');
      let previous: { pid: number };
      try {
        const file = await openPrivateFile(ownerPath, constants.O_RDONLY);
        try { previous = JSON.parse(await file.readFile('utf8')) as { pid: number }; }
        finally { await file.close(); }
      } catch { throw new Error('DAEMON_STATE_LOCKED'); }
      if (!Number.isSafeInteger(previous.pid) || previous.pid < 1) throw new Error('DAEMON_STATE_LOCKED');
      try { process.kill(previous.pid, 0); throw new Error('DAEMON_STATE_LOCKED'); }
      catch (pidError) { if ((pidError as NodeJS.ErrnoException).code !== 'ESRCH') throw new Error('DAEMON_STATE_LOCKED'); }
      // 只回收本协议创建且持有者已退出的锁，不清理任何业务状态或工作区文件。
      await unlink(ownerPath);
      await rmdir(directory);
      try { await mkdir(directory, { mode: 0o700 }); }
      catch { throw new Error('DAEMON_STATE_LOCKED'); }
    }
    const owner = JSON.stringify({ pid: process.pid, nonce: randomUUID() });
    const file = await openPrivateFile(ownerPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY);
    try { await file.writeFile(owner); await file.sync(); }
    finally { await file.close(); }
    return new StateLease(directory, owner);
  }

  async release(): Promise<void> {
    const ownerPath = join(this.directory, 'owner.json');
    const file = await openPrivateFile(ownerPath, constants.O_RDONLY);
    try { if (await file.readFile('utf8') !== this.owner) throw new Error('STATE_LEASE_CHANGED'); }
    finally { await file.close(); }
    await unlink(ownerPath);
    await rmdir(this.directory);
  }
}
