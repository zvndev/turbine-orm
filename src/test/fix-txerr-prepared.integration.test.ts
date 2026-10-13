/**
 * turbine-orm: PostgreSQL's own prepared-statement errors (42P05 and 26000)
 * reach the caller as ConnectionError (E004) naming the pooler and the fix.
 *
 * Both are real server errors, produced here on a direct connection with raw
 * `PREPARE` / `EXECUTE`: the SQLSTATEs do not depend on a pooler being there,
 * only the advice does. The same errors through a real PgBouncer are in
 * fix-txerr-pooler.integration.test.ts.
 *
 * Run: DATABASE_URL=... npx tsx --test src/test/fix-txerr-prepared.integration.test.ts
 */

import assert from 'node:assert/strict';
import { describe } from 'node:test';
import { TurbineClient } from '../client.js';
import { ConnectionError } from '../errors.js';
import { mockTable, skipGate } from './helpers.js';

const DATABASE_URL = process.env.DATABASE_URL;
const { it, before, after } = skipGate(!DATABASE_URL, 'DATABASE_URL not set');

describe('prepared-statement errors from a real server (live Postgres)', () => {
  let db: TurbineClient;

  before(() => {
    // One connection, so PREPARE and the statements after it share a backend.
    db = new TurbineClient(
      { connectionString: DATABASE_URL, poolSize: 1 },
      { tables: { t: mockTable('t', [{ name: 'id', field: 'id', pgType: 'int4' }]) }, enums: {} },
    );
  });
  after(async () => {
    await db?.disconnect();
  });

  it('42P05: preparing a name the connection already holds is E004 with the pooler advice', async () => {
    // One transaction, so both PREPAREs run on one connection (pg-pool destroys a
    // connection whose `pool.query` failed), and a savepoint around the failure.
    await db.$transaction(async (tx) => {
      await tx.rawUnsafe('PREPARE fx_dup AS SELECT 1');
      const err = await tx
        .$transaction((inner) => inner.rawUnsafe('PREPARE fx_dup AS SELECT 1'))
        .then(
          () => undefined,
          (e: unknown) => e,
        );
      assert.ok(err instanceof ConnectionError, String(err));
      assert.equal(err.code, 'TURBINE_E004');
      assert.equal(err.sqlstate, '42P05');
      assert.match(err.message, /prepared statement "fx_dup" already exists/);
      assert.match(err.message, /transaction-pooling endpoint/);
      assert.match(err.message, /direct\s+endpoint/);
      assert.match(err.message, /preparedStatements: false/);
      assert.match(err.message, /max_prepared_statements/);
      assert.equal((err.cause as { code?: string }).code, '42P05');
      await tx.rawUnsafe('DEALLOCATE fx_dup');
    });
  });

  it('26000: executing a name the connection never prepared is E004 with the pooler advice', async () => {
    await assert.rejects(db.rawUnsafe('EXECUTE fx_never_prepared'), (err: unknown) => {
      assert.ok(err instanceof ConnectionError, String(err));
      assert.equal(err.code, 'TURBINE_E004');
      assert.equal(err.sqlstate, '26000');
      assert.match(err.message, /prepared statement "fx_never_prepared" does not exist/);
      assert.match(err.message, /transaction-pooling endpoint/);
      assert.match(err.message, /preparedStatements: false/);
      return true;
    });
  });

  it('the connection is still usable afterwards', async () => {
    assert.equal((await db.rawUnsafe<{ one: number }>('SELECT 1 AS one'))[0]?.one, 1);
  });
});
