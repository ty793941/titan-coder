import type { ApiClient } from '../client.js';

export function registerDaemon(client: ApiClient, args: Record<string, string>): Promise<unknown> {
  return client.request('/api/daemons/register', {
    method: 'POST',
    body: JSON.stringify({
      machineName: args.machine ?? 'local-machine',
      environmentType: 'local',
      capabilities: (args.capabilities ?? 'git').split(',').filter(Boolean),
      workspaceRoots: [args.workspaceRoot ?? process.cwd()],
      maxConcurrentSessions: Number(args.maxConcurrentSessions ?? 1),
      daemonVersion: args.daemonVersion ?? '0.1.0',
    }),
  });
}

export function getDaemon(client: ApiClient, daemonId: string): Promise<unknown> {
  return client.request(`/api/daemons/${daemonId}`);
}

export function revokeDaemon(client: ApiClient, daemonId: string): Promise<void> {
  return client.request(`/api/daemons/${daemonId}/revoke`, { method: 'POST' }).then(() => undefined);
}
