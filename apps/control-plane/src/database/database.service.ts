import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Kysely, PostgresDialect, sql } from 'kysely';
import { Pool } from 'pg';
import type { Database } from './types.js';

@Injectable()
export class DatabaseService implements OnModuleDestroy {
  private static schemaPromise: Promise<void> | undefined;
  readonly db: Kysely<Database>;
  private initialized = false;

  constructor() {
    this.db = new Kysely<Database>({
      dialect: new PostgresDialect({
        pool: new Pool({
          connectionString: process.env.DATABASE_URL ?? 'postgresql://titan:titan@localhost:55432/titan',
          max: Number(process.env.DATABASE_POOL_MAX ?? 10),
          application_name: 'titan-control-plane',
        }),
      }),
    });
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    if (!DatabaseService.schemaPromise) {
      DatabaseService.schemaPromise = this.runInitializationScripts().catch(error => {
        DatabaseService.schemaPromise = undefined;
        throw error;
      });
    }
    await DatabaseService.schemaPromise;
    this.initialized = true;
  }

  private async runInitializationScripts(): Promise<void> {
    const databaseDir = await this.resolveDatabaseDir();
    for (const fileName of ['schema.sql', 'init-data.sql']) {
      const content = await readFile(resolve(databaseDir, fileName), 'utf8');
      for (const statement of content.split(';').map(value => value.trim()).filter(Boolean)) {
        await sql.raw(statement).execute(this.db);
      }
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.db.destroy();
  }

  private async resolveDatabaseDir(): Promise<string> {
    const candidates = [
      resolve(process.cwd(), 'database'),
      resolve(process.cwd(), '../../database'),
      resolve(import.meta.dirname, '../../../../database'),
    ];
    for (const candidate of candidates) {
      try {
        await readFile(resolve(candidate, 'schema.sql'));
        return candidate;
      } catch {
        continue;
      }
    }
    throw new Error('database schema directory not found');
  }
}
