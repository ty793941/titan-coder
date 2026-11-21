import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { RunDispatch, RunProgress } from '@titan/daemon-protocol';
import { ProcessGroup } from './process-group.js';

export type RuntimeWorkerOptions = {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  cancelGraceMs: number;
  killGraceMs: number;
  initialSequence: number;
  onProgress: (progress: RunProgress) => Promise<void>;
};

const terminalTypes = new Set(['completed', 'failed', 'cancelled', 'waiting_input']);

export class RuntimeWorker {
  readonly done: Promise<void>;
  private readonly child: ChildProcess;
  private queue: Promise<void> = Promise.resolve();
  private sequence: number;
  private terminal = false;
  private stopping: 'cancelled' | 'timeout' | 'shutdown' | 'protocol' | undefined;
  private termination: Promise<void> | undefined;
  private readonly deadline: NodeJS.Timeout;
  private reapTimer: NodeJS.Timeout | undefined;
  private readonly closed: Promise<void>;
  private lastEventId: string | undefined;
  private readonly group = new ProcessGroup();

  constructor(readonly dispatch: RunDispatch, private readonly options: RuntimeWorkerOptions) {
    this.sequence = options.initialSequence;
    this.child = this.group.start(options.command, options.args, dispatch.config.workspacePath, options.env, { ipc: true });
    this.closed = new Promise(resolve => {
      this.child.once('close', () => resolve());
      this.child.once('error', () => resolve());
    });
    this.child.on('message', message => {
      this.queue = this.queue.then(async () => {
        if (this.terminal) return;
        const value = message as { type?: unknown; progress?: RunProgress };
        if (value?.type !== 'progress' || !value.progress) { this.stop('protocol'); return; }
        const progress = value.progress;
        if (progress.claimToken !== dispatch.claimToken || !Number.isSafeInteger(progress.sequence) ||
            progress.sequence < this.sequence || (progress.sequence === this.sequence && progress.eventId !== this.lastEventId)) {
          this.stop('protocol'); return;
        }
        if (this.stopping && terminalTypes.has(progress.type)) return;
        try {
          await options.onProgress(progress);
          this.sequence = progress.sequence;
          this.lastEventId = progress.eventId;
          if (terminalTypes.has(progress.type)) {
            this.terminal = true;
            clearTimeout(this.deadline);
            this.reapTimer = setTimeout(() => { void this.terminateGroup(); }, options.cancelGraceMs);
          }
        } catch (error) {
          if (error instanceof Error && ['INVALID_PROGRESS', 'INVALID_CHECKPOINT', 'PROGRESS_TOO_LARGE', 'PROGRESS_TOO_DEEP', 'EVENT_ID_CONFLICT'].includes(error.message)) this.stop('protocol');
          else throw error;
        }
      });
      // 队列错误由 done 统一上报，立即挂载处理器避免事件循环产生未处理拒绝。
      void this.queue.catch(() => { void this.terminateGroup(); });
    });
    this.child.on('error', () => { this.stop('protocol'); });
    this.deadline = setTimeout(() => this.stop('timeout'), dispatch.config.timeoutMs);
    this.child.once('spawn', () => {
      this.child.send({ dispatch }, error => { if (error) this.stop('protocol'); });
    });
    this.done = this.finish();
  }

  cancel(): void { this.stop('cancelled'); }
  shutdown(): void { this.stop('shutdown'); }

  private stop(reason: NonNullable<RuntimeWorker['stopping']>): void {
    if (this.terminal || this.stopping) return;
    this.stopping = reason;
    clearTimeout(this.deadline);
    if (this.child.connected) this.child.send({ type: 'cancel' }, () => undefined);
    void this.terminateGroup();
  }

  private terminateGroup(): Promise<void> {
    if (!this.termination) this.termination = this.group.cancel({ graceMs: this.options.cancelGraceMs, killAfterMs: this.options.killGraceMs });
    return this.termination;
  }

  private async finish(): Promise<void> {
    try {
      await this.closed;
      clearTimeout(this.deadline);
      if (this.reapTimer) clearTimeout(this.reapTimer);
      await this.queue;
      await this.terminateGroup();
      if (!this.terminal) {
        const cancelled = this.stopping === 'cancelled' || this.stopping === 'shutdown';
        const code = this.stopping === 'timeout' ? 'RUN_TIMEOUT' : this.stopping === 'protocol' ? 'WORKER_PROTOCOL_ERROR' : 'WORKER_EXITED';
        await this.options.onProgress({
          eventId: randomUUID(), sequence: ++this.sequence, claimToken: this.dispatch.claimToken,
          type: cancelled ? 'cancelled' : 'failed', payload: cancelled ? { reason: 'cancel_requested' } : { code, message: 'Runtime worker stopped before a terminal result' },
        });
      }
    } finally {
      clearTimeout(this.deadline);
      if (this.reapTimer) clearTimeout(this.reapTimer);
      await this.terminateGroup();
    }
  }
}
