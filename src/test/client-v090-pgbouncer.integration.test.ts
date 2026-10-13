/**
 * turbine-orm: a client whose connection string names a transaction-mode
 * PgBouncer sends unnamed statements by default.
 *
 * In transaction mode PgBouncer runs each transaction on whichever server
 * connection is free. node-postgres sends `Parse` for a named statement only
 * the first time on a client connection, so the next execution can reach a
 * server connection that never saw it ("prepared statement ... does not
 * exist"), or one that already has it ("already exists"). PgBouncer 1.21+
 * hides this when `max_prepared_statements` is above 0; with it at 0, or on an
 * older PgBouncer, named statements fail.
 *
 * Needs `PGBOUNCER_URL`: a transaction-mode PgBouncer in front of the test
 * database, on port 6432 so the client recognises it. CI runs PgBouncer with
 * `max_prepared_statements = 0` and a server pool smaller than the client
 * pool, which makes the failure reproducible.
 *
 * Run: PGBOUNCER_URL=postgres://user@127.0.0.1:6432/db npx tsx --test src/test/client-v090-pgbouncer.integration.test.ts
 */

import assert from 'node:assert/strict';
import { describe } from 'node:test';
import { TurbineClient } from '../client.js';
import { detectPooler } from '../connection-url.js';
import { resetWarnOnce } from '../query/warn-registry.js';
import type { SchemaMetadata } from '../schema.js';
import { mockTable, skipGate } from './helpers.js';

const PGBOUNCER_URL = process.env.PGBOUNCER_URL;
const { it, before, after } = skipGate(
  !PGBOUNCER_URL,
  'PGBOUNCER_URL not set (a transaction-mode PgBouncer in front of the test database)',
);

const TABLE = 'client_v090_pgbouncer';
const schema: SchemaMetadata = {
  tables: { [TABLE]: mockTable(TABLE, [{ name: 'id', field: 'id', pgType: 'int4' }]) },
  enums: {},
};

/** The same query shape, many times at once, so client connections land on different server connections. */
async function burst(db: TurbineClient): Promise<{ ok: number; errors: string[] }> {
  const errors: string[] = [];
  let ok = 0;
  await Promise.all(
    Array.from({ length: 120 }, async (_, i) => {
      try {
        await db.table(TABLE).findMany({ where: { id: { gt: i % 5 } }, orderBy: { id: 'asc' }, limit: 3 });
        ok++;
      } catch (err) {
        errors.push((err as Error).message);
      }
    }),
  );
  return { ok, errors };
}

describe('named statements through a transaction-mode PgBouncer', () => {
  const opened: TurbineClient[] = [];
  const open = (config: Record<string, unknown> = {}): TurbineClient => {
    const db = new TurbineClient({ connectionString: PGBOUNCER_URL, poolSize: 6, ...config }, schema);
    opened.push(db);
    return db;
  };

  before(async () => {
    const db = open();
    await db.rawUnsafe(`DROP TABLE IF EXISTS ${TABLE}`);
    await db.rawUnsafe(`CREATE TABLE ${TABLE} (id int4 PRIMARY KEY)`);
    await db.rawUnsafe(`INSERT INTO ${TABLE} SELECT generate_series(1, 20)`);
  });
  after(async () => {
    await opened[0]?.rawUnsafe(`DROP TABLE IF EXISTS ${TABLE}`);
    await Promise.all(opened.map((db) => db.disconnect()));
  });

  it('the endpoint is recognised as a pooler (the precondition of this suite)', () => {
    assert.equal(detectPooler(PGBOUNCER_URL as string).pooled, true, 'serve PgBouncer on port 6432');
  });

  it('sends unnamed statements by default, and every query succeeds', async () => {
    const result = await burst(open());
    assert.deepEqual(result.errors, []);
    assert.equal(result.ok, 120);
  });

  it('preparedStatements: true is honoured and warned about once; where it fails, it fails as a named statement', async () => {
    resetWarnOnce('preparedStatementsOnPooler');
    const warnings: string[] = [];
    const warn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(' '));
    };
    let db: TurbineClient;
    try {
      db = open({ preparedStatements: true });
      open({ preparedStatements: true });
    } finally {
      console.warn = warn;
    }
    assert.equal(warnings.length, 1, warnings.join('\n'));
    assert.match(warnings[0] as string, /looks like a connection pooler[\s\S]*max_prepared_statements/);
    const result = await burst(db);
    for (const message of result.errors) assert.match(message, /prepared statement/);
  });
});
