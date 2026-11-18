import { spawn, type ChildProcess } from 'node:child_process';

export class ProcessGroup {
  private child?: ChildProcess;

  start(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): ChildProcess {
    this.child = spawn(command, args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    return this.child;
  }

  async cancel(): Promise<void> {
    if (!this.child?.pid) return;
    try {
      process.kill(-this.child.pid, 'SIGTERM');
    } catch {
      return;
    }
    await new Promise<void>(resolve => {
      if (!this.child || this.child.exitCode !== null) { resolve(); return; }
      this.child.once('exit', () => resolve());
    });
  }
}
