/**
 * The per-query `timeout` option, on the CORE client.
 *
 * `timeout` sits on all thirteen operation arg interfaces and is the only
 * option there whose whole job is invisible in the compiled statement: it emits
 * no SQL and binds no parameter, it races the execution against a timer. That
 * is exactly the shape that goes untested, and it was: before this file the
 * only assertions that a query-level timeout ACTS ran through
 * `turbine-orm/prisma-compat`, so the core client's own behaviour rested on an
 * adapter's test. `$transaction({ timeout })` is a different mechanism and was
 * already covered (client-coverage.test.ts).
 *
 * Found by src/test/option-observability.test.ts, which requires every option
 * claiming to be observable only at execution to name the test that proves it.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { type PgCompatPool, TurbineClient } from '../client.js';
import { TimeoutError } from '../errors.js';
import type { SchemaMetadata } from '../schema.js';
import { mockTable } from './helpers.js';

function schema(): SchemaMetadata {
  return {
    enums: {},
    tables: {
      users: mockTable('users', [
        { name: 'id', field: 'id' },
        { name: 'name', field: 'name', pgType: 'text' },
      ]),
    },
  };
}

/** A pool whose every query takes `delayMs` before resolving. */
function slowPool(delayMs: number): PgCompatPool & { queries: number } {
  const pool = {
    queries: 0,
    async query(): Promise<{ rows: unknown[]; rowCount: number }> {
      pool.queries++;
      await new Promise((r) => setTimeout(r, delayMs));
      return { rows: [], rowCount: 0 };
    },
    async connect() {
      return {
        query: pool.query,
        release() {},
      };
    },
    async end() {},
    on() {},
  };
  return pool as unknown as PgCompatPool & { queries: number };
}

function clientOn(pool: PgCompatPool): TurbineClient {
  return new TurbineClient({ pool }, schema());
}

describe('per-query timeout (core client)', () => {
  // One case per read shape, because each has its own execute call site in
  // builder.ts rather than sharing one: findMany, count, aggregate and groupBy
  // each pass `args.timeout` into `queryWithTimeout` separately, so a timeout
  // dropped from any one of them would not show up in the others.
  const reads: [string, (db: TurbineClient) => Promise<unknown>][] = [
    ['findMany', (db) => db.table('users').findMany({ timeout: 10 })],
    ['findFirst', (db) => db.table('users').findFirst({ timeout: 10 })],
    ['count', (db) => db.table('users').count({ timeout: 10 })],
    ['aggregate', (db) => db.table('users').aggregate({ _count: { id: true }, timeout: 10 })],
    ['groupBy', (db) => db.table('users').groupBy({ by: ['name'], _count: { id: true }, timeout: 10 })],
  ];

  for (const [name, run] of reads) {
    it(`${name} rejects with TimeoutError when the query outlives the timeout`, async () => {
      const db = clientOn(slowPool(200));
      await assert.rejects(() => run(db), TimeoutError);
    });
  }

  it('does not reject when the query finishes inside the timeout', async () => {
    const db = clientOn(slowPool(1));
    const rows = await db.table('users').findMany({ timeout: 500 });
    assert.deepEqual(rows, []);
  });

  it('a query with no timeout is never raced', async () => {
    // The default must not impose a bound of its own: a slow query with no
    // `timeout` has to be allowed to finish.
    const db = clientOn(slowPool(120));
    const rows = await db.table('users').findMany({});
    assert.deepEqual(rows, []);
  });

  it('the error names the bound that was exceeded', async () => {
    const db = clientOn(slowPool(200));
    await assert.rejects(
      () => db.table('users').findMany({ timeout: 17 }),
      (err: unknown) => {
        assert.ok(err instanceof TimeoutError);
        assert.equal(err.code, 'TURBINE_E002');
        assert.match(err.message, /17/, 'the message should name the timeout it exceeded');
        return true;
      },
    );
  });

  it('writes take the timeout too', async () => {
    const db = clientOn(slowPool(200));
    await assert.rejects(
      () => db.table('users').updateMany({ where: { name: 'a' }, data: { name: 'b' }, timeout: 10 }),
      TimeoutError,
    );
  });
});
