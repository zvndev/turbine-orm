/**
 * turbine-orm: through a transaction-mode PgBouncer, named statements fail as
 * ConnectionError (E004) carrying the SQLSTATE and the fix.
 *
 * Needs `PGBOUNCER_URL`: a transaction-mode PgBouncer in front of the test
 * database with `max_prepared_statements = 0` and a server pool smaller than
 * the client pool, so named statements land on connections that never saw
 * them. `preparedStatements: true` is passed explicitly so the result does not
 * depend on the endpoint being recognised as a pooler.
 *
 * Run: PGBOUNCER_URL=postgres://user@127.0.0.1:6432/db npx tsx --test src/test/fix-txerr-pooler.integration.test.ts
 */

import assert from 'node:assert/strict';
import { describe } from 'node:test';
import { TurbineClient } from '../client.js';
import { ConnectionError } from '../errors.js';
import { mockTable, skipGate } from './helpers.js';

const PGBOUNCER_URL = process.env.PGBOUNCER_URL;
const { it, before, after } = skipGate(
  !PGBOUNCER_URL,
  'PGBOUNCER_URL not set (a transaction-mode PgBouncer in front of the test database)',
);

const TABLE = 'fix_txerr_pooler';
const schema = { tables: { [TABLE]: mockTable(TABLE, [{ name: 'id', field: 'id', pgType: 'int4' }]) }, enums: {} };

describe('named statements through a transaction-mode PgBouncer', () => {
  let db: TurbineClient;
  const warn = console.warn;

  before(async () => {
    console.warn = () => {};
    db = new TurbineClient({ connectionString: PGBOUNCER_URL, poolSize: 6, preparedStatements: true }, schema);
    await db.rawUnsafe(`DROP TABLE IF EXISTS ${TABLE}`);
    await db.rawUnsafe(`CREATE TABLE ${TABLE} (id int4 PRIMARY KEY)`);
    await db.rawUnsafe(`INSERT INTO ${TABLE} SELECT generate_series(1, 20)`);
  });
  after(async () => {
    console.warn = warn;
    await db?.rawUnsafe(`DROP TABLE IF EXISTS ${TABLE}`);
    await db?.disconnect();
  });

  it('every failure is E004 with the SQLSTATE and the advice, and not one is an untyped driver error', async () => {
    const errors: unknown[] = [];
    await Promise.all(
      Array.from({ length: 120 }, async (_, i) => {
        try {
          await db.table(TABLE).findMany({ where: { id: { gt: i % 5 } }, orderBy: { id: 'asc' }, limit: 3 });
        } catch (err) {
          errors.push(err);
        }
      }),
    );
    assert.ok(
      errors.length > 0,
      'the pooler did not reproduce the failure: run PgBouncer with max_prepared_statements = 0 and a small server pool',
    );
    for (const err of errors) {
      assert.ok(err instanceof ConnectionError, `expected ConnectionError, got ${String(err)}`);
      assert.equal(err.code, 'TURBINE_E004');
      assert.ok(err.sqlstate === '42P05' || err.sqlstate === '26000', `unexpected SQLSTATE ${err.sqlstate}`);
      assert.match(err.message, /prepared statement/);
      assert.match(err.message, /transaction-pooling endpoint/);
      assert.match(err.message, /preparedStatements: false/);
    }
  });
});
