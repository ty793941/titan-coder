import { randomBytes, randomUUID } from 'node:crypto';
import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { daemonEventSchema, daemonRegistrationSchema, DomainError } from '@titan/contracts';
import type { DaemonRegistration } from '@titan/daemon-protocol';
import { DatabaseService } from '../../database/database.service.js';
import { daemonStatus, sameToken, tokenHash } from './execution-policy.js';

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

  async register(source: DaemonInput): Promise<DaemonView & { authToken: string }> {
    const input = daemonRegistrationSchema.parse(source);
    const daemonId = `daemon_${randomUUID()}`;
    const authToken = randomBytes(32).toString('hex');
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
      auth_token_hash: tokenHash(authToken),
    }).execute();
    return {
      daemonId,
      authToken,
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

  async authenticate(daemonId: string, authorization?: string): Promise<void> {
    const match = /^Bearer ([a-f0-9]{64})$/.exec(authorization ?? '');
    const row = await this.database.db.selectFrom('daemon').select(['auth_token_hash', 'status']).where('id', '=', daemonId).executeTakeFirst();
    if (!match || !row || !sameToken(match[1]!, row.auth_token_hash)) throw new UnauthorizedException('invalid daemon credentials');
    if (row.status === 'revoked') throw new DomainError('PERMISSION_DENIED', 'daemon is revoked');
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
    const updated = await this.database.db.updateTable('daemon').set({ status: 'ready', last_heartbeat_at: now }).where('id', '=', daemonId).where('status', '!=', 'revoked').executeTakeFirst();
    if (Number(updated.numUpdatedRows) === 0) throw new DomainError('PERMISSION_DENIED', 'daemon is revoked');
    return { ...existing, status: 'ready', lastHeartbeatAt: now.toISOString() };
  }

  async revoke(daemonId: string): Promise<void> {
    await this.get(daemonId);
    await this.database.db.updateTable('daemon').set({ status: 'revoked' }).where('id', '=', daemonId).execute();
  }

  async appendEvent(daemonId: string, source: { eventId: string; sequence: number; eventType: string; payload: Record<string, unknown> }): Promise<{ created: boolean }> {
    const input = daemonEventSchema.parse(source);
    if (input.daemonId && input.daemonId !== daemonId) throw new DomainError('PERMISSION_DENIED', 'event daemonId does not match the authenticated daemon');
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
      status: daemonStatus(row),
      lastHeartbeatAt: row.last_heartbeat_at.toISOString(),
    };
  }
}
