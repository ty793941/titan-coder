import { spawn, type ChildProcess } from 'node:child_process';

export class ProcessGroup {
  private child?: ChildProcess;
  private termination: Promise<void> | undefined;

  start(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, options: { ipc?: boolean } = {}): ChildProcess {
    if (this.child && this.child.exitCode === null && this.child.signalCode === null) throw new Error('PROCESS_GROUP_BUSY');
    this.termination = undefined;
    this.child = spawn(command, args, {
      cwd, env, detached: true, shell: false,
      stdio: options.ipc ? ['ignore', 'ignore', 'ignore', 'ipc'] : ['ignore', 'pipe', 'pipe'],
    });
    return this.child;
  }

  cancel(options: { graceMs?: number; killAfterMs?: number } = {}): Promise<void> {
    if (!this.termination) this.termination = (async () => {
      const pid = this.child?.pid;
      if (!pid) return;
      const signal = (value: NodeJS.Signals) => {
        try { process.kill(-pid, value); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
      };
      if (options.graceMs) await new Promise(resolve => setTimeout(resolve, options.graceMs));
      signal('SIGTERM');
      // 父进程退出不能证明整个进程组已清理，必须覆盖忽略 TERM 的后代。
      await new Promise(resolve => setTimeout(resolve, options.killAfterMs ?? 1000));
      signal('SIGKILL');
    })();
    return this.termination;
  }
}
