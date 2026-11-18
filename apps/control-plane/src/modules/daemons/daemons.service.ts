import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { DomainError } from '@titan/contracts';
import type { DaemonRegistration } from '@titan/daemon-protocol';
import { DatabaseService } from '../../database/database.service.js';

type DaemonInput = Omit<DaemonRegistration, 'environmentType'> & { environmentType: 'local' | 'cloud' };
type DaemonView = {
  daemonId: string;
  machineName: string;
  environmentType: 'local' | 'cloud';
  capabilities: string[];
  workspaceRoots: string[];
  maxConcurrentSessions: number;
  daemonVersion: string;
  status: string;
  lastHeartbeatAt: string;
};

@Injectable()
export class DaemonsService {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  async register(input: DaemonInput): Promise<DaemonView> {
    const daemonId = `daemon_${randomUUID()}`;
    const now = new Date();
    await this.database.db.insertInto('daemon').values({
      id: daemonId,
      machine_name: input.machineName,
      environment_type: input.environmentType,
      capabilities: JSON.stringify(input.capabilities),
      workspace_roots: JSON.stringify(input.workspaceRoots),
      max_concurrent_sessions: input.maxConcurrentSessions,
      daemon_version: input.daemonVersion,
      status: 'ready',
      last_heartbeat_at: now,
      created_at: now,
    }).execute();
    return {
      daemonId,
      machineName: input.machineName,
      environmentType: input.environmentType,
      capabilities: input.capabilities,
      workspaceRoots: input.workspaceRoots,
      maxConcurrentSessions: input.maxConcurrentSessions,
      daemonVersion: input.daemonVersion,
      status: 'ready',
      lastHeartbeatAt: now.toISOString(),
    };
  }

  async get(daemonId: string): Promise<DaemonView> {
    const row = await this.database.db.selectFrom('daemon').selectAll().where('id', '=', daemonId).executeTakeFirst();
    if (!row) throw new DomainError('RESOURCE_NOT_FOUND', `daemon ${daemonId} was not found`);
    return this.toView(row);
  }

  async heartbeat(daemonId: string): Promise<DaemonView> {
    const existing = await this.get(daemonId);
    if (existing.status === 'revoked') throw new DomainError('PERMISSION_DENIED', `daemon ${daemonId} is revoked`);
    const now = new Date();
    await this.database.db.updateTable('daemon').set({ status: 'ready', last_heartbeat_at: now }).where('id', '=', daemonId).execute();
    return { ...existing, status: 'ready', lastHeartbeatAt: now.toISOString() };
  }

  async revoke(daemonId: string): Promise<void> {
    await this.get(daemonId);
    await this.database.db.updateTable('daemon').set({ status: 'revoked' }).where('id', '=', daemonId).execute();
  }

  async appendEvent(daemonId: string, input: { eventId: string; sequence: number; eventType: string; payload: Record<string, unknown> }): Promise<{ created: boolean }> {
    const daemon = await this.get(daemonId);
    if (daemon.status === 'revoked') throw new DomainError('PERMISSION_DENIED', `daemon ${daemonId} is revoked`);
    const result = await this.database.db.insertInto('daemon_outbox_event').values({
      id: `daemon_event_${randomUUID()}`,
      daemon_id: daemonId,
      event_id: input.eventId,
      sequence: input.sequence,
      event_type: input.eventType,
      payload: JSON.stringify(input.payload),
      status: 'pending',
      retry_count: 0,
      created_at: new Date(),
    }).onConflict(oc => oc.columns(['daemon_id', 'event_id']).doNothing()).executeTakeFirst();
    return { created: Number(result.numInsertedOrUpdatedRows) > 0 };
  }

  async listEvents(daemonId: string): Promise<Array<{ eventId: string; sequence: number; eventType: string; payload: unknown; status: string }>> {
    await this.get(daemonId);
    const rows = await this.database.db.selectFrom('daemon_outbox_event').selectAll()
      .where('daemon_id', '=', daemonId).orderBy('sequence', 'asc').execute();
    return rows.map(row => ({
      eventId: row.event_id,
      sequence: row.sequence,
      eventType: row.event_type,
      payload: row.payload,
      status: row.status,
    }));
  }

  private toView(row: {
    id: string; machine_name: string; environment_type: string; capabilities: unknown;
    workspace_roots: unknown; max_concurrent_sessions: number; daemon_version: string;
    status: string; last_heartbeat_at: Date;
  }): DaemonView {
    return {
      daemonId: row.id,
      machineName: row.machine_name,
      environmentType: row.environment_type as DaemonView['environmentType'],
      capabilities: row.capabilities as string[],
      workspaceRoots: row.workspace_roots as string[],
      maxConcurrentSessions: row.max_concurrent_sessions,
      daemonVersion: row.daemon_version,
      status: row.status,
      lastHeartbeatAt: row.last_heartbeat_at.toISOString(),
    };
  }
}
