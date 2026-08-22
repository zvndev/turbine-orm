/**
 * `executePipeline` transaction control, per engine.
 *
 * The sequential fallback used to open its batch with the literal string
 * `BEGIN`. That is Postgres's spelling and nothing else's, and the pipeline is
 * the ONLY caller in the package that was not asking the dialect: every other
 * transaction seam (`$transaction`, savepoints, the nested-write engine) goes
 * through `dialect.beginStatement()`.
 *
 * On SQL Server the consequence was total and silent. `BEGIN` there opens a
 * statement BLOCK, so `MssqlTxClient` (which matches `BEGIN TRAN(SACTION)`, the
 * dialect's spelling) never saw a transaction start, forwarded the word to the
 * server as a block with no `END`, and the `COMMIT`/`ROLLBACK` behind it then
 * found `this.tx === null` and did nothing at all. A batch documented as atomic
 * was neither atomic nor rolled back, and no test exercised `pipeline` against
 * the mssql dialect, which is why it shipped.
 *
 * Both lanes here are build/dispatch-level against a fake `mssql` driver, so
 * they run with no SQL Server and no `MSSQL_URL`.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MssqlPool, mssqlDialect } from '../mssql.js';
import { executePipeline } from '../pipeline.js';
import type { DeferredQuery } from '../query/index.js';

// ---------------------------------------------------------------------------
// A fake `mssql` module: records raw SQL that reaches a Request, and separately
// records every call that lands on the driver's Transaction API. The split is
// the whole point: a transaction that WORKS shows up in `txEvents`, and a
// transaction that leaked to the server as text shows up in `calls`.
// ---------------------------------------------------------------------------

function fakeMssql(rowsFor: (sql: string) => Record<string, unknown>[] = () => []) {
  const calls: string[] = [];
  const txEvents: string[] = [];

  class FakeRequest {
    inputs: Record<string, unknown> = {};
    constructor(public parent: unknown) {}
    input(name: string, value: unknown): this {
      this.inputs[name] = value;
      return this;
    }
    async query(sql: string) {
      calls.push(sql);
      const rows = rowsFor(sql);
      return { recordset: rows, rowsAffected: [rows.length] };
    }
    async batch(sql: string) {
      calls.push(sql);
      return { recordset: [], rowsAffected: [0] };
    }
  }

  class FakeTransaction {
    async begin(level?: number) {
      txEvents.push(`begin:${level}`);
    }
    async commit() {
      txEvents.push('commit');
    }
    async rollback() {
      txEvents.push('rollback');
    }
  }

  const pool = {
    async connect() {
      return pool;
    },
    request() {
      return new FakeRequest(pool);
    },
    async close() {},
    connected: true,
  };

  const sqlNS = {
    ISOLATION_LEVEL: { READ_UNCOMMITTED: 1, READ_COMMITTED: 2, REPEATABLE_READ: 3, SERIALIZABLE: 4, SNAPSHOT: 5 },
    Request: FakeRequest,
    Transaction: FakeTransaction,
    // biome-ignore lint/suspicious/noExplicitAny: only the instance shape matters to the shim
    ConnectionPool: class {} as any,
  };

  // biome-ignore lint/suspicious/noExplicitAny: structural mssql module/pool for the shim
  return { pool: pool as any, sqlNS: sqlNS as any, calls, txEvents };
}

function defer<T>(sql: string, params: unknown[], transform: (r: { rows: unknown[] }) => T): DeferredQuery<T> {
  return { sql, params, transform: transform as DeferredQuery<T>['transform'], tag: 'test' };
}

/** A pg-shaped pool that reports no dialect, i.e. everything that is not an engine shim. */
function plainMockPool(fail?: string) {
  const calls: string[] = [];
  const client = {
    async query(text: string) {
      calls.push(text);
      if (fail && text === fail) throw new Error('boom');
      return { rows: [{ n: 1 }], rowCount: 1 };
    },
    release() {},
  };
  return {
    pool: {
      async connect() {
        return client;
      },
      // biome-ignore lint/suspicious/noExplicitAny: minimal structural PgCompatPool
    } as any,
    calls,
  };
}

// ---------------------------------------------------------------------------

describe('executePipeline transaction control follows the pool dialect', () => {
  it('mssql: the batch opens with BEGIN TRANSACTION and lands on the driver Transaction API', async () => {
    const { pool, sqlNS, calls, txEvents } = fakeMssql((sql) => (/^SELECT/.test(sql) ? [{ n: 1 }] : []));
    const mp = new MssqlPool(pool, sqlNS);

    const [a, b] = await executePipeline(mp, [
      defer('SELECT 1 AS n', [], (r) => r.rows.length),
      defer('SELECT 2 AS n', [], (r) => r.rows.length),
    ]);

    assert.equal(a, 1);
    assert.equal(b, 1);
    // The transaction ran on the driver API, which is the only place a SQL
    // Server transaction can actually live.
    assert.deepEqual(txEvents, ['begin:undefined', 'commit']);
    // And no transaction-control keyword ever reached the server as raw text.
    // `BEGIN` alone is the regression: T-SQL reads it as a block opener.
    for (const sql of calls) {
      assert.doesNotMatch(sql, /^\s*(BEGIN|COMMIT|ROLLBACK)\b/i, `raw tx control leaked to the server: ${sql}`);
    }
    assert.deepEqual(calls, ['SELECT 1 AS n', 'SELECT 2 AS n']);
  });

  it('mssql: a failing query rolls the batch back through the Transaction API', async () => {
    const { pool, sqlNS, txEvents } = fakeMssql((sql) => {
      if (/BOOM/.test(sql)) throw new Error('statement failed');
      return [{ n: 1 }];
    });
    const mp = new MssqlPool(pool, sqlNS);

    await assert.rejects(() =>
      executePipeline(mp, [defer('SELECT 1 AS n', [], (r) => r.rows.length), defer('SELECT BOOM', [], () => 0)]),
    );
    // Before the fix this was `['begin:undefined']` at best: the bare BEGIN never
    // opened a transaction, so ROLLBACK found none and silently did nothing.
    assert.deepEqual(txEvents, ['begin:undefined', 'rollback']);
  });

  it('mssql: the statements the pipeline emits are exactly the dialect keywords', () => {
    // Pins the two ends of the seam together. If either side is respelled, the
    // shim's interception regexes have to be revisited in the same change.
    assert.equal(mssqlDialect.beginStatement(), 'BEGIN TRANSACTION');
    assert.equal(mssqlDialect.commitStatement(), 'COMMIT TRANSACTION');
    assert.equal(mssqlDialect.rollbackStatement(), 'ROLLBACK TRANSACTION');
  });

  it('a pool with no dialect keeps PostgreSQL BEGIN/COMMIT byte-for-byte', async () => {
    const { pool, calls } = plainMockPool();
    await executePipeline(pool, [defer('SELECT 1', [], (r) => r.rows.length)]);
    assert.deepEqual(calls, ['BEGIN', 'SELECT 1', 'COMMIT']);
  });

  it('a pool with no dialect still rolls back with a bare ROLLBACK', async () => {
    const { pool, calls } = plainMockPool('SELECT bad');
    await assert.rejects(() => executePipeline(pool, [defer('SELECT bad', [], () => 0)]));
    assert.deepEqual(calls, ['BEGIN', 'SELECT bad', 'ROLLBACK']);
  });

  it('{ transactional: false } emits no transaction control on any engine', async () => {
    const { pool, sqlNS, calls, txEvents } = fakeMssql(() => [{ n: 1 }]);
    const mp = new MssqlPool(pool, sqlNS);
    await executePipeline(mp, [defer('SELECT 1 AS n', [], (r) => r.rows.length)], { transactional: false });
    assert.deepEqual(txEvents, []);
    assert.deepEqual(calls, ['SELECT 1 AS n']);
  });
});
