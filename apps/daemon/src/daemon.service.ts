import type { DaemonStatus } from '@titan/daemon-protocol';

type DaemonRecord = { daemonId: string; lastHeartbeatAt: number; status: DaemonStatus };

export class DaemonService {
  private readonly daemons = new Map<string, DaemonRecord>();

  constructor(private readonly options: { reconnectAfterMs: number }) {}

  register(input: { daemonId: string; now: number }): void {
    this.daemons.set(input.daemonId, { daemonId: input.daemonId, lastHeartbeatAt: input.now, status: 'ready' });
  }

  heartbeat(daemonId: string, now: number): void {
    const daemon = this.daemons.get(daemonId);
    if (!daemon) return;
    daemon.lastHeartbeatAt = now;
    daemon.status = 'ready';
  }

  observe(now: number): void {
    for (const daemon of this.daemons.values()) {
      if (now - daemon.lastHeartbeatAt >= this.options.reconnectAfterMs) daemon.status = 'reconnecting';
    }
  }

  status(daemonId: string): DaemonStatus | undefined {
    return this.daemons.get(daemonId)?.status;
  }
}
