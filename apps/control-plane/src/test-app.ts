import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import request from 'supertest';
import { createApp } from './main.js';
import { DatabaseService } from './database/database.service.js';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';

type TestAgent = ReturnType<typeof request>;

export async function createTestApp(): Promise<{
  get: TestAgent['get'];
  post: TestAgent['post'];
  close: () => Promise<void>;
  db: DatabaseService['db'];
}> {
  const originalUrl = process.env.DATABASE_URL;
  const connectionString = originalUrl ?? 'postgresql://titan@127.0.0.1:55432/titan';
  const pool = new Pool({ connectionString });
  const schema = `api_test_${randomUUID().replaceAll('-', '')}`;
  await pool.query(`CREATE SCHEMA ${schema}`);
  const url = new URL(connectionString);
  url.searchParams.set('options', `-c search_path=${schema}`);
  process.env.DATABASE_URL = url.toString();
  let app: NestFastifyApplication;
  try {
    app = await createApp();
  } catch (error) {
    await pool.query(`DROP SCHEMA ${schema} CASCADE`);
    await pool.end();
    throw error;
  } finally {
    if (originalUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalUrl;
  }
  const agent = request(app.getHttpServer());
  return {
    db: app.get(DatabaseService).db,
    get: agent.get.bind(agent) as TestAgent['get'],
    post: agent.post.bind(agent) as TestAgent['post'],
    close: async () => {
      await app.close();
      await pool.query(`DROP SCHEMA ${schema} CASCADE`);
      await pool.end();
    },
  };
}
