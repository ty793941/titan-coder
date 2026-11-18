export type EnvironmentType = 'local' | 'cloud';
export type DaemonStatus = 'registered' | 'connecting' | 'ready' | 'draining' | 'reconnecting' | 'disconnected' | 'revoked';

export type DaemonRegistration = {
  machineName: string;
  environmentType: EnvironmentType;
  capabilities: string[];
  workspaceRoots: string[];
  maxConcurrentSessions: number;
  daemonVersion: string;
};

export type DaemonHeartbeat = {
  daemonId: string;
  sequence: number;
  occurredAt: string;
};

export type DaemonEvent = {
  eventId: string;
  daemonId: string;
  sequence: number;
  eventType: string;
  payload: Record<string, unknown>;
};
