import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { DomainError } from '@titan/contracts';
import { sql } from 'kysely';
import type { Kysely, Transaction } from 'kysely';
import type { Database, JsonValue } from '../database/types.js';

export type DatabaseLike = Kysely<Database> | Transaction<Database>;

export function requestHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}

@Injectable()
export class IdempotencyService {
  async read<T>(db: DatabaseLike, scopeKey: string, key: string, payload: unknown): Promise<T | undefined> {
    const record = await db.selectFrom('idempotency_record')
      .selectAll()
      .where('scope_key', '=', scopeKey)
      .where('idempotency_key', '=', key)
      .executeTakeFirst();
    if (!record) return undefined;
    if (record.request_hash !== requestHash(payload)) {
      throw new DomainError('IDEMPOTENCY_CONFLICT', `key ${key} was already used with another request`);
    }
    return record.response_body as T;
  }

  async write(db: DatabaseLike, scopeKey: string, key: string, payload: unknown, response: JsonValue, status: number): Promise<void> {
    await db.insertInto('idempotency_record').values({
      scope_key: scopeKey,
      idempotency_key: key,
      request_hash: requestHash(payload),
      response_status: status,
      response_body: response,
      created_at: new Date(),
    }).onConflict(oc => oc.columns(['scope_key', 'idempotency_key']).doNothing()).execute();
  }
}
