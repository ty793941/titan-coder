import { describe, expect, it } from 'vitest';
import type { DaemonEvent, DaemonRegistration } from '../src/index.js';

describe('daemon protocol', () => {
  it('keeps registration and event envelopes traceable', () => {
    const registration: DaemonRegistration = {
      machineName: 'local-machine',
      environmentType: 'local',
      capabilities: ['codex'],
      workspaceRoots: ['/workspace'],
      maxConcurrentSessions: 1,
      daemonVersion: '0.1.0',
    };
    const event: DaemonEvent = {
      eventId: 'evt_1', daemonId: 'daemon_1', sequence: 1,
      eventType: 'daemon.heartbeat', payload: { machineName: registration.machineName },
    };
    expect(event.payload).toMatchObject({ machineName: 'local-machine' });
  });
});
