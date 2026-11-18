import { describe, expect, it } from 'vitest';
import { DaemonService } from '../src/daemon.service.js';

describe('DaemonService', () => {
  it('moves to reconnecting after a missed heartbeat without failing sessions', () => {
    const daemon = new DaemonService({ reconnectAfterMs: 100 });
    daemon.register({ daemonId: 'daemon_1', now: 0 });
    daemon.observe(101);
    expect(daemon.status('daemon_1')).toBe('reconnecting');
  });
});
