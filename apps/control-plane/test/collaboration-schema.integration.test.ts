import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { expect, it } from 'vitest';

it('creates collaboration tables idempotently with unique project responsibilities', async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const schema = `collaboration_${randomUUID().replaceAll('-', '')}`;
  const client = await pool.connect();
  try {
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}`);
    const structure = await readFile(
      new URL('../../../database/schema.sql', import.meta.url),
      'utf8',
    );
    await client.query(structure);
    await client.query(structure);
    const tables = await client.query(
      'SELECT table_name FROM information_schema.tables WHERE table_schema=$1 AND table_name = ANY($2)',
      [
        schema,
        [
          'project_member',
          'work_item',
          'assignment',
          'review_request',
          'handoff',
          'collaboration_inbox_item',
        ],
      ],
    );
    expect(tables.rows.map((row) => row.table_name).sort()).toEqual([
      'assignment',
      'collaboration_inbox_item',
      'handoff',
      'project_member',
      'review_request',
      'work_item',
    ]);
    const project = `project_${randomUUID()}`;
    const task = `task_${randomUUID()}`;
    const workItem = `work_${randomUUID()}`;
    await client.query(
      "INSERT INTO organization (id, name) VALUES ('org_collaboration', 'Collaboration') ON CONFLICT DO NOTHING",
    );
    await client.query(
      "INSERT INTO project (id, organization_id, name, goal) VALUES ($1, 'org_collaboration', 'Project', 'Goal')",
      [project],
    );
    await client.query(
      "INSERT INTO task (id, project_id, title, goal, acceptance_criteria, priority) VALUES ($1, $2, 'Task', 'Goal', '[]', 'medium')",
      [task, project],
    );
    await client.query(
      'INSERT INTO work_item (id, project_id, task_id) VALUES ($1, $2, $3)',
      [workItem, project, task],
    );
    await client.query(
      "INSERT INTO project_member (id, project_id, subject_type, subject_id, role) VALUES ($1, $2, 'human', 'member-1', 'owner')",
      [`member_${randomUUID()}`, project],
    );
    await client.query(
      "INSERT INTO assignment (id, project_id, work_item_id, subject_type, subject_id, responsibility) VALUES ($1, $2, $3, 'human', 'member-1', 'human-owner')",
      [`assignment_${randomUUID()}`, project, workItem],
    );
    await expect(
      client.query(
        "INSERT INTO assignment (id, project_id, work_item_id, subject_type, subject_id, responsibility) VALUES ($1, $2, $3, 'human', 'member-2', 'human-owner')",
        [`assignment_${randomUUID()}`, project, workItem],
      ),
    ).rejects.toMatchObject({ code: '23505' });
  } finally {
    await client.query('SET search_path TO public');
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    client.release();
    await pool.end();
  }
}, 30000);
