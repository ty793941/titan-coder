import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { expect, it } from 'vitest';

it('upgrades legacy orchestration tables with schema.sql alone twice while preserving existing rows', async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const schema = `orchestration_upgrade_${randomUUID().replaceAll('-', '')}`;
  const client = await pool.connect();
  try {
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}`);
    const structure = await readFile(new URL('../../../database/schema.sql', import.meta.url), 'utf8');
    await client.query(structure);
    await client.query(await readFile(new URL('../../../database/init-data.sql', import.meta.url), 'utf8'));
    await client.query("INSERT INTO session (id, task_id, entry_agent) VALUES ('legacy_session', 'task_dev', 'project-manager')");
    await client.query("INSERT INTO execution_schedule (id, project_id, task_id, session_id, plan_hash, timezone, interval_seconds, starts_at, ends_at, max_runs, temporal_schedule_id, requested_by) VALUES ('legacy_schedule', 'project_dev', 'task_dev', 'legacy_session', 'legacy_plan', 'UTC', 60, NOW(), NOW() + interval '1 day', 2, 'legacy_schedule', 'legacy_user')");
    await client.query("INSERT INTO background_job (id, project_id, task_id, session_id, kind, workflow_id, deadline_at, plan_hash, requested_by) VALUES ('legacy_job', 'project_dev', 'task_dev', 'legacy_session', 'run', 'legacy_workflow', NOW() + interval '1 day', 'legacy_plan', 'legacy_user')");
    // 仅在专用随机测试 schema 内模拟迁移前的表结构。
    await client.query(`ALTER TABLE ${schema}.background_job DROP COLUMN worker_id`);
    await client.query(`ALTER TABLE ${schema}.execution_schedule DROP COLUMN worker_id`);
    const beforeJob = (await client.query(`SELECT * FROM ${schema}.background_job`)).rows;
    const beforeSchedule = (await client.query(`SELECT * FROM ${schema}.execution_schedule`)).rows;
    for (let pass = 0; pass < 2; pass++) {
      await client.query(structure);
      const columns = await client.query('SELECT table_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema=$1 AND table_name=ANY($2) AND column_name=$3', [schema, ['background_job', 'execution_schedule'], 'worker_id']);
      expect(columns.rows).toHaveLength(2);
      expect(columns.rows.every(row => row.data_type === 'text' && row.is_nullable === 'YES')).toBe(true);
      expect((await client.query(`SELECT * FROM ${schema}.background_job`)).rows).toEqual(beforeJob.map(row => ({ ...row, worker_id: null })));
      expect((await client.query(`SELECT * FROM ${schema}.execution_schedule`)).rows).toEqual(beforeSchedule.map(row => ({ ...row, worker_id: null })));
    }
  } finally {
    await client.query('SET search_path TO public');
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    client.release();
    await pool.end();
  }
}, 30000);
