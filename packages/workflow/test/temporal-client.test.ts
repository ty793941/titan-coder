import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Client, Connection, ScheduleOverlapPolicy } from '@temporalio/client';
import type { Schedule } from '@titan/contracts';
import { connectTemporalClient } from '../src/temporal-client.js';

describe('Temporal schedule synchronization', () => {
  it('leaves action capacity to the control plane while preserving native schedule rules', async () => {
    const connection = await Connection.connect({ address: '127.0.0.1:7233' });
    const rawClient = new Client({ connection, namespace: 'titan' });
    const orchestration = await connectTemporalClient({ address: '127.0.0.1:7233', namespace: 'titan' });
    const temporalScheduleId = `phase2b-action-capacity-${randomUUID()}`;
    const schedule: Schedule = {
      id: `schedule_${randomUUID()}`,
      sessionId: `session_${randomUUID()}`,
      planHash: `sha256:${'a'.repeat(64)}`,
      timezone: 'UTC',
      cron: '*/5 * * * *',
      startsAt: '2030-01-01T00:00:00.000Z',
      endsAt: '2030-01-02T00:00:00.000Z',
      maxRuns: 2,
      runCount: 0,
      overlapPolicy: 'skip',
      catchupWindowSeconds: 60,
      enabled: true,
      version: 1,
      syncStatus: 'pending_sync',
      temporalScheduleId,
      createdAt: '2030-01-01T00:00:00.000Z',
    };
    const scheduleId = `${temporalScheduleId}-v1`;

    try {
      await orchestration.syncSchedule(schedule);
      const description = await rawClient.schedule.getHandle(scheduleId).describe();

      expect(description.state.remainingActions).toBeUndefined();
      expect(description.spec.endAt).toEqual(new Date(schedule.endsAt));
      expect(description.policies.overlap).toBe(ScheduleOverlapPolicy.SKIP);
    } finally {
      try {
        await rawClient.schedule.getHandle(scheduleId).delete();
      } finally {
        await orchestration.close();
      }
    }
  }, 30_000);
});
