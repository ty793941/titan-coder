import type { Server } from 'node:http';
export function createGateway(options: {
  root: string;
  controlPlaneUrl?: string;
  consoleToken: string;
  allowDevOrigin?: boolean;
  keychain?: { configured(provider: string): Promise<boolean>; save(provider: string, key: string): Promise<void> };
  daemon?: { status(): Promise<{ running: boolean; daemonId?: string }>; start(): Promise<{ running: boolean; daemonId?: string }>; stop(): Promise<{ running: boolean; daemonId?: string }> };
}): { server: Server; close(): Promise<void> };
