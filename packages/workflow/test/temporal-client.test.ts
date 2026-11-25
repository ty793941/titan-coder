import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Client, Connection, ScheduleOverlapPolicy } from '@temporalio/client';
import type { Schedule } from '@titan/contracts';
import { connectTemporalClient, createTemporalClientForTest } from '../src/temporal-client.js';

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

  it('pauses an older schedule created after a higher skipped version wins a cross-client race', async () => {
    const connectionA = await Connection.connect({ address: '127.0.0.1:7233' });
    const connectionB = await Connection.connect({ address: '127.0.0.1:7233' });
    const clientA = new Client({ connection: connectionA, namespace: 'titan' });
    const clientB = new Client({ connection: connectionB, namespace: 'titan' });
    const temporalScheduleId = `phase2b-schedule-race-${randomUUID()}`;
    const schedule1: Schedule = {
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
    const schedule3 = { ...schedule1, id: `schedule_${randomUUID()}`, version: 3 };
    const schedule1Id = `${temporalScheduleId}-v1`;
    const schedule3Id = `${temporalScheduleId}-v3`;
    let releaseCreate!: () => void;
    let enteredCreate!: () => void;
    const createEntered = new Promise<void>((resolve) => { enteredCreate = resolve; });
    const createGate = new Promise<void>((resolve) => { releaseCreate = resolve; });
    const orchestrationA = createTemporalClientForTest(clientA, connectionA, 'titan-orchestration-v1', {
      beforeScheduleCreate: async (scheduleId) => {
        if (scheduleId === schedule1Id) {
          enteredCreate();
          await createGate;
        }
      },
    });
    const orchestrationB = createTemporalClientForTest(clientB, connectionB, 'titan-orchestration-v1');

    try {
      const olderSync = orchestrationA.syncSchedule(schedule1);
      await createEntered;
      await orchestrationB.syncSchedule(schedule3);
      releaseCreate();
      await olderSync;

      const olderDescription = await clientA.schedule.getHandle(schedule1Id).describe();
      const newerDescription = await clientB.schedule.getHandle(schedule3Id).describe();
      expect(olderDescription.state.paused).toBe(true);
      expect(newerDescription.state.paused).toBe(false);
    } finally {
      releaseCreate();
      await clientA.schedule.getHandle(schedule1Id).delete().catch(() => undefined);
      await clientB.schedule.getHandle(schedule3Id).delete().catch(() => undefined);
      await orchestrationA.close();
      await orchestrationB.close();
    }
  }, 30_000);
});
