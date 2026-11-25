import { describe, expect, it } from 'vitest';
import type { WorkflowCommand } from '@titan/contracts';
import { Dispatcher } from '../src/dispatcher.js';

const command = (kind: WorkflowCommand['kind'], targetId: string): WorkflowCommand => ({
  id: `cmd_${kind}`, claimToken: 'a'.repeat(64), kind, targetId,
});

describe('Dispatcher', () => {
  it('does not start a cancelled job and acknowledges the command', async () => {
    const completed: string[] = [];
    let starts = 0;
    const dispatcher = new Dispatcher({
      controlPlane: {
        observeJob: async () => ({ jobId: 'job_1', status: 'cancelled', deadlineAt: '2099-01-01T00:00:00.000Z' }),
        getJobExecution: async () => ({ jobId: 'job_1', workflowId: 'titan/background/job_1/v1', workflowVersion: 1 }),
        getSchedule: async () => { throw new Error('unused'); },
        claimCommand: async () => undefined,
        completeCommand: async (value) => { completed.push(value.id); },
        retryCommand: async () => undefined,
      },
      temporal: { startBackgroundJob: async () => { starts += 1; } },
      pollIntervalMs: 1,
    });

    await dispatcher.process(command('start_job', 'job_1'));

    expect(starts).toBe(0);
    expect(completed).toEqual(['cmd_start_job']);
  });

  it('uses Temporal idempotency when command completion is retried', async () => {
    let starts = 0;
    let completions = 0;
    const dispatcher = new Dispatcher({
      controlPlane: {
        observeJob: async () => ({ jobId: 'job_1', status: 'pending_dispatch', deadlineAt: '2099-01-01T00:00:00.000Z' }),
        getJobExecution: async () => ({ jobId: 'job_1', workflowId: 'titan/background/job_1/v1', workflowVersion: 1 }),
        getSchedule: async () => { throw new Error('unused'); },
        claimCommand: async () => undefined,
        completeCommand: async () => { completions += 1; if (completions === 1) throw new Error('transport'); },
        retryCommand: async () => undefined,
      },
      temporal: { startBackgroundJob: async () => { starts += 1; } },
      pollIntervalMs: 1,
    });
    const value = command('start_job', 'job_1');

    await dispatcher.process(value);
    await dispatcher.process(value);

    expect(starts).toBe(1);
  });

  it('stops a polling loop without cancelling any Daemon activity', async () => {
    let claims = 0;
    const dispatcher = new Dispatcher({
      controlPlane: {
        claimCommand: async () => { claims += 1; return undefined; },
        completeCommand: async () => undefined,
        retryCommand: async () => undefined,
        observeJob: async () => ({ jobId: 'job_1', status: 'running', deadlineAt: '2099-01-01T00:00:00.000Z' }),
        getJobExecution: async () => ({ jobId: 'job_1', workflowId: 'titan/background/job_1/v1', workflowVersion: 1 }),
        getSchedule: async () => { throw new Error('unused'); },
      },
      temporal: { startBackgroundJob: async () => undefined },
      pollIntervalMs: 1,
    });

    const running = dispatcher.start();
    await new Promise((resolve) => setTimeout(resolve, 5));
    await dispatcher.stop();
    await running;

    expect(claims).toBeGreaterThan(0);
  });

  it('follows a schedule definition that advances during synchronization', async () => {
    const synced: number[] = [];
    let reads = 0;
    const dispatcher = new Dispatcher({
      controlPlane: {
        claimCommand: async () => undefined,
        completeCommand: async () => undefined,
        retryCommand: async () => undefined,
        observeJob: async () => ({ jobId: 'job_1', status: 'running', deadlineAt: '2099-01-01T00:00:00.000Z' }),
        getJobExecution: async () => ({ jobId: 'job_1', workflowId: 'titan/background/job_1/v1', workflowVersion: 1 }),
        getSchedule: async () => {
          reads += 1;
          return { id: 'schedule_1', sessionId: 'session_1', planHash: 'sha256:' + 'a'.repeat(64), timezone: 'UTC', cron: '*/5 * * * *', startsAt: '2030-01-01T00:00:00.000Z', endsAt: '2030-01-02T00:00:00.000Z', maxRuns: 2, runCount: 0, overlapPolicy: 'skip' as const, catchupWindowSeconds: 60, enabled: true, version: reads === 1 ? 1 : 2, syncStatus: 'pending_sync' as const, temporalScheduleId: 'schedule_1', createdAt: '2030-01-01T00:00:00.000Z' };
        },
      },
      temporal: {
        startBackgroundJob: async () => undefined,
        cancelBackgroundJob: async () => undefined,
        syncSchedule: async (schedule) => { synced.push(schedule.version); },
      },
    });

    await dispatcher.process({ id: 'cmd_sync', claimToken: 'a'.repeat(64), kind: 'sync_schedule', targetId: 'schedule_1', definitionVersion: 1 });

    expect(synced).toEqual([1, 2]);
  });
});
