import { describe, expect, it } from 'vitest';
import * as contracts from '../src/index.js';

const job = { kind: 'run', runInBackground: true, planHash: `sha256:${'a'.repeat(64)}`, deadlineAt: '2026-12-01T00:00:00.000Z', idempotencyKey: 'job-1' };
const schedule = { planHash: job.planHash, timezone: 'Asia/Shanghai', intervalSeconds: 60, startsAt: '2026-12-01T00:00:00.000Z', endsAt: '2026-12-02T00:00:00.000Z', maxRuns: 2, overlapPolicy: 'skip', enabled: false, idempotencyKey: 'schedule-1' };

describe('strict persistent orchestration contracts', () => {
  it('exports the background request and requires explicit authorization', () => {
    expect(contracts).toHaveProperty('backgroundJobCreateRequestSchema');
    expect(contracts.backgroundJobCreateRequestSchema.parse(job)).toEqual(job);
    for (const input of [{ ...job, runInBackground: undefined }, { ...job, runInBackground: false }, { ...job, apiKey: 'synthetic' }, { ...job, workflow: 'arbitrary' }, { ...job, kind: 'observe' }, { ...job, runId: 'run_1' }]) {
      expect(contracts.backgroundJobCreateRequestSchema.safeParse(input).success).toBe(false);
    }
    expect(contracts.backgroundJobCreateRequestSchema.safeParse({ ...job, kind: 'observe', runId: 'run_1' }).success).toBe(true);
  });

  it('bounds schedules and defaults to a sixty second catchup window', () => {
    expect(contracts).toHaveProperty('scheduleCreateRequestSchema');
    expect(contracts.scheduleCreateRequestSchema.parse(schedule)).toMatchObject({ catchupWindowSeconds: 60, enabled: false });
    for (const input of [
      { ...schedule, timezone: 'not/a-zone' }, { ...schedule, cron: '* * * * *' },
      { ...schedule, intervalSeconds: 59 }, { ...schedule, maxRuns: 0 }, { ...schedule, maxRuns: 101 },
      { ...schedule, enabled: true }, { ...schedule, overlapPolicy: 'allow' }, { ...schedule, catchupWindowSeconds: 9 },
      { ...schedule, catchupWindowSeconds: 3601 }, { ...schedule, endsAt: schedule.startsAt },
      { ...schedule, intervalSeconds: undefined, cron: '* * * * * *' },
      { ...schedule, intervalSeconds: undefined, cron: '61 * * * *' },
      { ...schedule, intervalSeconds: undefined, cron: '*/0 * * * *' },
      { ...schedule, workflowType: 'arbitrary' }, { ...schedule, credentialRef: 'secret' },
    ]) expect(contracts.scheduleCreateRequestSchema.safeParse(input).success).toBe(false);
    expect(contracts.scheduleCreateRequestSchema.safeParse({ ...schedule, intervalSeconds: undefined, cron: '*/5 1-20 * * 1,3' }).success).toBe(true);
  });

  it('restricts workflow payloads to safe IDs, status and fixed error codes', () => {
    expect(contracts).toHaveProperty('workflowCommandSchema');
    expect(contracts.workflowCommandSchema.safeParse({ id: 'cmd_1', claimToken: 'a'.repeat(64), kind: 'start_job', targetId: 'job_1' }).success).toBe(true);
    expect(contracts.workflowCommandSchema.safeParse({ id: 'cmd_1', claimToken: 'a'.repeat(64), kind: 'exec', targetId: 'job_1' }).success).toBe(false);
    expect(contracts.jobObservationSchema.safeParse({ jobId: 'job_1', status: 'running', deadlineAt: job.deadlineAt, prompt: 'synthetic' }).success).toBe(false);
    expect(contracts.jobObservationSchema.safeParse({ jobId: 'job_1', status: 'failed', deadlineAt: job.deadlineAt, errorCode: 'https://synthetic.example/secret' }).success).toBe(false);
    expect(contracts.orchestrationPageSchema.parse({})).toEqual({ limit: 50, offset: 0 });
    expect(contracts.orchestrationPageSchema.safeParse({ limit: 101 }).success).toBe(false);
    expect(contracts.scheduleOccurrenceResultSchema.safeParse({ status: 'created' }).success).toBe(false);
    expect(contracts.scheduleOccurrenceResultSchema.safeParse({ status: 'skipped', jobId: 'bg_1' }).success).toBe(false);
  });
});
