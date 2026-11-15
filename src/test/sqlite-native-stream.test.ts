/** Real SQLite stepping and ownership oracles for native row streaming. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import type { StatementSync } from 'node:sqlite';
import { describe } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { TurbineClient } from '../client.js';
import {
  ConnectionError,
  SerializationFailureError,
  TimeoutError,
  UnsupportedFeatureError,
  ValidationError,
} from '../errors.js';
import { defineSchema } from '../schema-builder.js';
import { schemaDefToMetadata } from '../schema-metadata.js';
import { SqlitePool, sqliteDialect, turbineSqlite } from '../sqlite.js';
import { skipGate } from './helpers.js';

const native = (() => {
  try {
    return createRequire(process.cwd())('node:sqlite') as typeof import('node:sqlite');
  } catch {
    return undefined;
  }
})();
const { it: sqliteIt } = skipGate(!native, 'requires node:sqlite (Node >= 22.5)');
const hasTransactionState = (() => {
  if (!native) return false;
  const probe = new native.DatabaseSync(':memory:');
  try {
    return typeof probe.isTransaction === 'boolean';
  } finally {
    probe.close();
  }
})();
const { it } = skipGate(
  !hasTransactionState,
  'requires node:sqlite native streaming with DatabaseSync.isTransaction (Node 22.x >= 22.16, or Node >= 24)',
);
const reportsOrigin = typeof native?.StatementSync.prototype.columns === 'function';
const def = {
  id: { type: 'integer', primaryKey: true },
  observed: { type: 'integer' },
  isEnabled: { type: 'boolean' },
  prefs: { type: 'json' },
  happenedAt: { type: 'timestamp' },
  huge: { type: 'bigint' },
};
const schema = schemaDefToMetadata(defineSchema({ source_rows: def, items: def } as never));
interface Item {
  id: number;
  observed: number;
  isEnabled: boolean;
  prefs: unknown;
  happenedAt: Date;
  huge: string;
}

function fixture(count = 12050, options: { busyTimeoutMs?: number; streamIdleTimeoutMs?: number } = {}) {
  const raw = new native!.DatabaseSync(':memory:');
  let steps = 0;
  let failAt = 0;
  raw.function('observe_row', (id) => {
    steps++;
    if (Number(id) === failAt) throw new Error('injected native step failure');
    return id;
  });
  raw.exec(`CREATE TABLE source_rows(id INTEGER PRIMARY KEY, is_enabled INTEGER, prefs TEXT, happened_at TIMESTAMP, huge INTEGER);
    WITH RECURSIVE n(id) AS (SELECT 1 UNION ALL SELECT id+1 FROM n WHERE id<${count})
    INSERT INTO source_rows SELECT id, id%2, json_object('id',id), '2024-02-03 04:05:06', 9007199254740993 FROM n;
    CREATE VIEW items AS SELECT id, observe_row(id) AS observed, is_enabled, prefs, happened_at, huge FROM source_rows;`);
  const sqls: string[] = [];
  let iterators = 0;
  let returns = 0;
  let allCalls = 0;
  let failClose = false;
  const prepare = raw.prepare.bind(raw);
  raw.prepare = (sql: string): StatementSync => {
    sqls.push(sql);
    const stmt = prepare(sql);
    if (/\bFROM\s+"?items"?\b/i.test(sql)) {
      const all = stmt.all.bind(stmt);
      stmt.all = ((...args: Parameters<StatementSync['all']>) => {
        allCalls++;
        assert.match(sql, /\bLIMIT\b/i, 'cursor path must never call .all()');
        return all(...args);
      }) as StatementSync['all'];
      const iterate = stmt.iterate.bind(stmt);
      stmt.iterate = ((...args: Parameters<StatementSync['iterate']>) => {
        iterators++;
        const iterator = iterate(...args);
        const close = iterator.return!.bind(iterator);
        iterator.return = (...args: Parameters<typeof close>) => {
          returns++;
          const result = close(...args);
          if (failClose) throw new Error('injected native cleanup failure');
          return result;
        };
        return iterator;
      }) as StatementSync['iterate'];
    }
    return stmt;
  };
  const db = turbineSqlite(raw, schema, { logger: {}, warnOnUnlimited: false, ...options });
  return {
    raw,
    db,
    sqls,
    table: db.table<Item>('items'),
    get steps() {
      return steps;
    },
    get iterators() {
      return iterators;
    },
    get returns() {
      return returns;
    },
    get allCalls() {
      return allCalls;
    },
    failAt(id: number) {
      failAt = id;
    },
    failClose() {
      failClose = true;
    },
    async close() {
      await db.disconnect();
      raw.close();
    },
  };
}

function expected(id: number) {
  return {
    id,
    observed: id,
    isEnabled: reportsOrigin ? id % 2 === 1 : id % 2,
    prefs: reportsOrigin ? { id } : JSON.stringify({ id }),
    happenedAt: new Date('2024-02-03T04:05:06Z'),
    huge: '9007199254740993',
  };
}

async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!check() && Date.now() < deadline) await delay(5);
  assert.ok(check(), 'cleanup should complete before the deadline');
}

describe('SQLite native stream stepping', () => {
  it('pins a projection after the first step and decodes native arrays without reading ahead', async () => {
    const raw = new native!.DatabaseSync(':memory:');
    raw.exec(`CREATE TABLE cells(id INTEGER, enabled BOOLEAN, payload JSON, wide INTEGER, bytes BLOB, fraction REAL);
      INSERT INTO cells VALUES(1,1,'{"id":1}',9007199254740993,x'00ff',1.25),
        (2,0,'false',-9007199254740993,x'',-2.5),(3,2,'invalid',NULL,NULL,NULL);`);
    let steps = 0;
    let returns = 0;
    let descriptions = 0;
    const shapes: boolean[] = [];
    const prepare = raw.prepare.bind(raw);
    raw.prepare = (sql) => {
      const stmt = prepare(sql);
      const columns = stmt.columns.bind(stmt);
      stmt.columns = () => {
        descriptions++;
        return columns();
      };
      stmt.all = () => {
        throw new Error('native streaming must not materialize');
      };
      const iterate = stmt.iterate.bind(stmt);
      stmt.iterate = ((...args: Parameters<StatementSync['iterate']>) => {
        const iterator = iterate(...args);
        const next = iterator.next.bind(iterator);
        const close = iterator.return!.bind(iterator);
        iterator.next = () => {
          const result = next();
          if (!result.done) {
            steps++;
            shapes.push(Array.isArray(result.value));
          }
          return result;
        };
        iterator.return = () => {
          returns++;
          return close();
        };
        return iterator;
      }) as StatementSync['iterate'];
      return stmt;
    };
    const pool = new SqlitePool(raw);
    const client = await pool.connect();
    try {
      const stream = client.streamBatches!('SELECT * FROM cells ORDER BY id', [], 2);
      const first = await stream.next();
      assert.equal(steps, 2, 'one pull steps exactly one bounded batch');
      assert.deepEqual(first.value, [
        {
          id: 1,
          enabled: true,
          payload: '{"id":1}',
          wide: '9007199254740993',
          bytes: new Uint8Array([0, 255]),
          fraction: 1.25,
        },
        { id: 2, enabled: false, payload: 'false', wide: '-9007199254740993', bytes: new Uint8Array(), fraction: -2.5 },
      ]);
      assert.deepEqual((await stream.next()).value, [
        { id: 3, enabled: 2, payload: 'invalid', wide: null, bytes: null, fraction: null },
      ]);
      assert.equal((await stream.next()).done, true);
      assert.deepEqual(shapes, [false, true, true], 'only the first native row needs object keys');
      assert.equal(descriptions, 2, 'descriptions are validated per execution, never per row');
      assert.equal(returns, 1);
      assert.equal(raw.isTransaction, false);
    } finally {
      client.release();
      await pool.end();
    }
  });

  for (const fallback of ['arrays', 'descriptions', 'duplicates'] as const) {
    it(`native projection fallback preserves values when ${fallback} are unavailable or ambiguous`, async () => {
      const raw = new native!.DatabaseSync(':memory:');
      raw.exec('CREATE TABLE cells(id INTEGER); INSERT INTO cells VALUES(1),(2),(3)');
      const prepare = raw.prepare.bind(raw);
      let arraySwitches = 0;
      raw.prepare = (sql) => {
        const stmt = prepare(sql);
        const arrays = stmt.setReturnArrays.bind(stmt);
        if (fallback === 'arrays') Object.defineProperty(stmt, 'setReturnArrays', { value: undefined });
        else
          stmt.setReturnArrays = (enabled) => {
            arraySwitches++;
            arrays(enabled);
          };
        if (fallback === 'descriptions')
          stmt.columns = () => {
            throw new Error('no description');
          };
        return stmt;
      };
      const pool = new SqlitePool(raw);
      const client = await pool.connect();
      try {
        const sql =
          fallback === 'duplicates'
            ? 'SELECT id AS v, id+10 AS v FROM cells ORDER BY id'
            : 'SELECT id AS "2", id+10 AS "1" FROM cells ORDER BY id';
        const rows = [];
        for await (const batch of client.streamBatches!(sql, [], 2)) rows.push(...batch);
        assert.deepEqual(
          rows,
          fallback === 'duplicates'
            ? [{ v: 11 }, { v: 12 }, { v: 13 }]
            : [
                { 1: 11, 2: 1 },
                { 1: 12, 2: 2 },
                { 1: 13, 2: 3 },
              ],
        );
        assert.equal(arraySwitches, 0);
      } finally {
        client.release();
        await pool.end();
      }
    });
  }

  it('stream SQL memo reuses only text plans across values, invalid bounds and fresh native projections', async () => {
    const raw = new native!.DatabaseSync(':memory:');
    raw.exec('CREATE TABLE cells(id INTEGER, enabled BOOLEAN); INSERT INTO cells VALUES(1,1),(2,0)');
    const pool = new SqlitePool(raw);
    const client = await pool.connect();
    const collect = async (sql: string, values: unknown[]) => {
      const rows = [];
      for await (const batch of client.streamBatches!(sql, values, 1)) rows.push(...batch);
      return rows;
    };
    const sql = 'SELECT * FROM cells WHERE id >= $1 ORDER BY id';
    try {
      assert.deepEqual(await collect(sql, [1]), [
        { id: 1, enabled: true },
        { id: 2, enabled: false },
      ]);
      // With no values the native unbound $1 is NULL. That distinct rewrite
      // identity must not poison the next execution with a real binding.
      assert.deepEqual(await collect(sql, []), []);
      assert.deepEqual(await collect(sql, [2]), [{ id: 2, enabled: false }]);
      await assert.rejects(collect('SELECT $1 AS ignored, $2 AS id', [1]), ValidationError);
      assert.deepEqual(await collect('SELECT $1 AS ignored, $2 AS id', [1, 9]), [{ ignored: 1, id: 9 }]);
      raw.exec(
        "DROP TABLE cells; CREATE TABLE cells(id INTEGER, enabled INTEGER, extra TEXT); INSERT INTO cells VALUES(3,1,'fresh')",
      );
      assert.deepEqual(await collect(sql, [1]), [{ id: 3, enabled: 1, extra: 'fresh' }]);
      assert.deepEqual(await collect('SELECT id AS "2", enabled AS "1" FROM cells', []), [{ 1: 1, 2: 3 }]);
    } finally {
      client.release();
      await pool.end();
    }
  });

  sqliteIt(
    'missing transaction-state reporting refuses native streaming without touching an external transaction',
    async () => {
      const raw = new native!.DatabaseSync(':memory:');
      // Some Node versions expose a non-configurable own getter, so simulate
      // the older capability through a facade without changing the handle.
      const unreported = new Proxy(raw, {
        get(target, key) {
          if (key === 'isTransaction') return undefined;
          const value = Reflect.get(target, key, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      const pool = new SqlitePool(unreported);
      const client = await pool.connect();
      try {
        // Exercise the actual old-runtime shape on every supported test runtime.
        raw.exec('CREATE TABLE proof(id INTEGER); BEGIN; SAVEPOINT caller; INSERT INTO proof VALUES(1)');
        await assert.rejects(client.streamBatches!('SELECT * FROM proof', [], 1).next(), (error) => {
          assert.ok(error instanceof UnsupportedFeatureError);
          assert.match(error.message, /DatabaseSync.isTransaction/);
          return true;
        });
        client.release();
        assert.equal(raw.prepare('SELECT count(*) AS n FROM proof').get()!.n, 1);
        raw.exec('ROLLBACK TO caller; RELEASE caller; COMMIT');
        assert.equal(raw.prepare('SELECT count(*) AS n FROM proof').get()!.n, 0);
        // Refusing the new capability must not disable ordinary old-runtime reads/writes.
        await pool.query('INSERT INTO proof VALUES(2)');
        assert.deepEqual((await pool.query('SELECT id FROM proof')).rows, [{ id: 2 }]);
      } finally {
        client.release();
        await pool.end();
      }
    },
  );

  it('first batch above speculation threshold is incremental, ordered, decoded, and return closes it', async () => {
    const f = fixture();
    try {
      const stream = f.table.findManyStreamBatches({ batchSize: 1001, orderBy: { id: 'asc' } });
      const first = await stream.next();
      assert.equal(first.done, false);
      assert.equal(first.value!.length, 1001);
      assert.equal(f.allCalls, 0);
      assert.equal(f.iterators, 1);
      assert.equal(f.steps, 1001, 'only rows in the first batch should be stepped');
      for (let i = 0; i < first.value!.length; i++) assert.deepEqual(first.value![i], expected(i + 1));
      await stream.return(undefined);
      assert.equal(f.returns, 1);
      assert.equal(f.steps, 1001, 'return must not drain the iterator');
      assert.deepEqual(await f.db.rawUnsafe('SELECT 7 AS ok'), [{ ok: 7 }]);
      assert.equal(f.raw.isTransaction, false);
      assert.equal(f.sqls.filter((sql) => /^(BEGIN|COMMIT|ROLLBACK)\b/i.test(sql)).length, 0);
    } finally {
      await f.close();
    }
  });

  it('small batch overflow keeps speculation bounded and then uses native iteration through the idle wrapper', async () => {
    const f = fixture();
    try {
      const stream = f.table.findManyStream({ batchSize: 3, orderBy: { id: 'asc' } });
      assert.deepEqual((await stream.next()).value, expected(1));
      assert.equal(f.steps, 4 + 3, 'bounded speculative rows plus one native batch');
      assert.equal(f.allCalls, 1);
      assert.equal(f.iterators, 1);
      await stream.return(undefined);
      assert.equal(f.returns, 1);
      assert.equal(f.steps, 7);
    } finally {
      await f.close();
    }
  });

  it('drains exact rows without a retained-results collector, including the final partial batch', async () => {
    const f = fixture(10037);
    try {
      let id = 1;
      let batches = 0;
      for await (const batch of f.table.findManyStreamBatches({
        batchSize: 1001,
        idleTimeoutMs: 0,
        orderBy: { id: 'asc' },
      })) {
        assert.ok(batch.length > 0 && batch.length <= 1001);
        for (const row of batch) assert.deepEqual(row, expected(id++));
        batches++;
      }
      assert.equal(id, 10038);
      assert.equal(batches, 11);
      assert.equal(f.steps, 10037);
      assert.equal(f.returns, 1);
      assert.equal(f.allCalls, 0);
    } finally {
      await f.close();
    }
  });

  it('break and consumer throw both close native state without scanning remaining rows', async () => {
    for (const mode of ['break', 'throw']) {
      const f = fixture();
      try {
        const consume = async () => {
          for await (const row of f.table.findManyStream({ batchSize: 1001 })) {
            assert.equal(row.id, 1);
            if (mode === 'throw') throw new Error('consumer cancelled');
            break;
          }
        };
        if (mode === 'throw') await assert.rejects(consume, /consumer cancelled/);
        else await consume();
        assert.equal(f.returns, 1);
        assert.equal(f.steps, 1001);
        assert.deepEqual(await f.db.rawUnsafe('SELECT 8 AS ok'), [{ ok: 8 }]);
      } finally {
        await f.close();
      }
    }
  });

  it('step errors preserve the original error, close the iterator, and allow recovery', async () => {
    const f = fixture();
    try {
      f.failAt(1100);
      const stream = f.table.findManyStreamBatches({ batchSize: 1001 });
      await stream.next();
      await assert.rejects(stream.next(), /injected native step failure/);
      assert.equal(f.steps, 1100);
      assert.equal(f.returns, 1);
      assert.deepEqual(await f.db.rawUnsafe('SELECT 9 AS ok'), [{ ok: 9 }]);
    } finally {
      await f.close();
    }
  });

  it('native SQL errors retain typed classification and query-only streams refuse clearly', async () => {
    const f = fixture();
    try {
      const connection = await f.db.pool.connect();
      const bad = sqliteDialect.openStream(connection, 'SELECT * FROM absent_stream_table', [], 2);
      await assert.rejects(bad.next(), ValidationError);
      connection.release();
      let queried = false;
      const fallback = sqliteDialect.openStream(
        {
          query: async () => {
            queried = true;
            return { rows: [] };
          },
        },
        'SELECT 1',
        [],
        2,
      );
      await assert.rejects(fallback.next(), UnsupportedFeatureError);
      assert.equal(queried, false);
      assert.deepEqual(await f.db.rawUnsafe('SELECT 10 AS ok'), [{ ok: 10 }]);
    } finally {
      await f.close();
    }
  });

  it('cleanup failures release the handle, and never replace a native step failure', async () => {
    for (const failingStep of [false, true]) {
      const f = fixture();
      try {
        const stream = f.table.findManyStreamBatches({ batchSize: 1001 });
        await stream.next();
        f.failClose();
        if (failingStep) {
          f.failAt(1100);
          await assert.rejects(stream.next(), /injected native step failure/);
        } else await assert.rejects(stream.return(undefined), /injected native cleanup failure/);
        assert.equal(f.returns, 1);
        assert.deepEqual(await f.db.rawUnsafe('SELECT 17 AS ok'), [{ ok: 17 }]);
      } finally {
        await f.close();
      }
    }
  });

  it('a driver without native iteration or iterator return refuses without materializing', async () => {
    for (const missing of ['iterate', 'return']) {
      const raw = new native!.DatabaseSync(':memory:');
      const prepare = raw.prepare.bind(raw);
      raw.prepare = (sql) => {
        const stmt = prepare(sql);
        stmt.all = () => {
          throw new Error('unsupported drivers must not fall back to .all()');
        };
        if (missing === 'iterate') Object.defineProperty(stmt, 'iterate', { value: undefined });
        else {
          const iterate = stmt.iterate.bind(stmt);
          stmt.iterate = ((...args: Parameters<StatementSync['iterate']>) => {
            const iterator = iterate(...args);
            iterator.return = undefined;
            return iterator;
          }) as StatementSync['iterate'];
        }
        return stmt;
      };
      const pool = new SqlitePool(raw);
      const client = await pool.connect();
      try {
        await assert.rejects(client.streamBatches!('SELECT 1', [], 2).next(), UnsupportedFeatureError);
      } finally {
        client.release();
        await pool.end();
      }
    }
  });

  it('idle expiry closes native state, releases waiting statements, and throws E002 on the next pull', async () => {
    const f = fixture(12050, { streamIdleTimeoutMs: 20, busyTimeoutMs: 2000 });
    try {
      const stream = f.table.findManyStreamBatches({ batchSize: 1001 });
      await stream.next();
      const pending = f.db.rawUnsafe('SELECT 11 AS ok');
      await until(() => f.returns === 1);
      assert.deepEqual(await pending, [{ ok: 11 }]);
      await assert.rejects(stream.next(), (err) => err instanceof TimeoutError && err.outcome === 'not-executed');
      await stream.return(undefined);
      assert.equal(f.steps, 1001);
    } finally {
      await f.close();
    }
  });
});

describe('SQLite native stream handle ownership', () => {
  it('non-owner queries queue FIFO and do not enter the iterator handle', async () => {
    const f = fixture();
    try {
      const stream = f.table.findManyStreamBatches({ batchSize: 1001, idleTimeoutMs: 0 });
      await stream.next();
      const order: number[] = [];
      const first = f.db.rawUnsafe('SELECT 1 AS ticket').then(() => order.push(1));
      const second = f.db.rawUnsafe('SELECT 2 AS ticket').then(() => order.push(2));
      await delay(10);
      assert.deepEqual(order, []);
      assert.ok(!f.sqls.some((sql) => /AS ticket/.test(sql)));
      await stream.return(undefined);
      await Promise.all([first, second]);
      assert.deepEqual(order, [1, 2]);
    } finally {
      await f.close();
    }
  });

  it('busy wait is retryable and an expired waiter cannot steal the released handle', async () => {
    const f = fixture(12050, { busyTimeoutMs: 15 });
    try {
      const stream = f.table.findManyStreamBatches({ batchSize: 1001, idleTimeoutMs: 0 });
      await stream.next();
      await assert.rejects(f.db.rawUnsafe('SELECT 12 AS ok'), SerializationFailureError);
      assert.ok(!f.sqls.some((sql) => /SELECT 12 AS ok/.test(sql)));
      await stream.return(undefined);
      assert.deepEqual(await f.db.rawUnsafe('SELECT 13 AS ok'), [{ ok: 13 }]);
    } finally {
      await f.close();
    }
  });

  it('ambient transaction streaming survives speculation, return and savepoint rollback without owning transaction control', async () => {
    const f = fixture();
    try {
      await f.db.$transaction(async (tx) => {
        await tx.rawUnsafe('INSERT INTO source_rows VALUES(20001, 1, NULL, NULL, NULL)');
        const controlCount = () =>
          f.sqls.filter((sql) => /^(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)\b/i.test(sql)).length;
        const before = controlCount();
        const stream = tx.table<Item>('items').findManyStreamBatches({ batchSize: 3 });
        assert.equal((await stream.next()).value![0]!.id, 1);
        assert.equal(f.steps, 7);
        await stream.return(undefined);
        assert.equal(controlCount(), before, 'stream must not change transaction ownership');
        assert.equal(f.raw.isTransaction, true);
        await assert.rejects(
          tx.$transaction(async (inner) => {
            const nested = inner.table<Item>('items').findManyStreamBatches({ batchSize: 1001 });
            await nested.next();
            await nested.return(undefined);
            await inner.rawUnsafe('INSERT INTO source_rows VALUES(20002, 0, NULL, NULL, NULL)');
            throw new Error('rollback nested block');
          }),
          /rollback nested block/,
        );
        assert.equal((await tx.rawUnsafe('SELECT count(*) AS n FROM source_rows WHERE id=20001'))[0]!.n, 1);
        assert.equal((await tx.rawUnsafe('SELECT count(*) AS n FROM source_rows WHERE id=20002'))[0]!.n, 0);
        await assert.rejects(f.db.rawUnsafe('SELECT 99 AS outside'), UnsupportedFeatureError);
      });
      assert.equal(f.raw.isTransaction, false);
      assert.equal((await f.db.rawUnsafe('SELECT count(*) AS n FROM source_rows WHERE id=20001'))[0]!.n, 1);
    } finally {
      await f.close();
    }
  });

  it('same-owner statements refuse while an iterator is active and transaction boundaries close abandoned iterators', async () => {
    const f = fixture();
    try {
      let abandoned: AsyncGenerator<Item[], void, undefined> | undefined;
      await f.db.$transaction(async (tx) => {
        abandoned = tx.table<Item>('items').findManyStreamBatches({ batchSize: 1001 });
        await abandoned.next();
        await assert.rejects(tx.rawUnsafe('SELECT 14 AS ok'), ValidationError);
      });
      assert.equal(f.returns, 1, 'commit must close the abandoned native iterator');
      await assert.rejects(abandoned!.next(), ValidationError);
      assert.equal(f.steps, 1001);
      assert.deepEqual(await f.db.rawUnsafe('SELECT 15 AS ok'), [{ ok: 15 }]);
    } finally {
      await f.close();
    }
  });

  it('transaction timeout closes abandoned native state, rolls back writes, and refuses late pulls', async () => {
    const f = fixture();
    try {
      let stream: AsyncGenerator<Item[], void, undefined> | undefined;
      let resume!: () => void;
      const held = new Promise<void>((resolve) => {
        resume = resolve;
      });
      await assert.rejects(
        f.db.$transaction(
          async (tx) => {
            await tx.rawUnsafe('INSERT INTO source_rows VALUES(20003, 1, NULL, NULL, NULL)');
            stream = tx.table<Item>('items').findManyStreamBatches({ batchSize: 1001 });
            await stream.next();
            await held;
          },
          { timeout: 40 },
        ),
        TimeoutError,
      );
      resume();
      assert.equal(f.returns, 1);
      assert.equal(f.raw.isTransaction, false);
      await assert.rejects(stream!.next(), ValidationError);
      assert.equal((await f.db.rawUnsafe('SELECT count(*) AS n FROM source_rows WHERE id=20003'))[0]!.n, 0);
    } finally {
      await f.close();
    }
  });

  it('a supplied DatabaseSync and its externally opened transaction remain caller-owned', async () => {
    const f = fixture();
    try {
      f.raw.exec('BEGIN; SAVEPOINT caller_savepoint; INSERT INTO source_rows VALUES(20004, 1, NULL, NULL, NULL)');
      const stream = f.table.findManyStreamBatches({ batchSize: 1001 });
      await stream.next();
      await stream.return(undefined);
      assert.equal(f.raw.isTransaction, true);
      f.raw.exec('ROLLBACK TO caller_savepoint; RELEASE caller_savepoint; COMMIT');
      await f.db.disconnect();
      assert.equal(f.raw.prepare('SELECT 1 AS ok').get()!.ok, 1);
      assert.equal((await f.db.rawUnsafe('SELECT count(*) AS n FROM source_rows WHERE id=20004'))[0]!.n, 0);
      assert.equal(f.sqls.filter((sql) => /^(BEGIN|COMMIT|ROLLBACK)\b/i.test(sql)).length, 0);
    } finally {
      await f.close();
    }
  });

  it('release resets native state before handing the same handle to another owner', async () => {
    const f = fixture();
    try {
      const connection = await f.db.pool.connect();
      const stream = connection.streamBatches!('SELECT * FROM items', [], 4);
      await stream.next();
      const pending = f.db.rawUnsafe('SELECT 16 AS ok');
      connection.release();
      assert.equal(f.returns, 1);
      assert.deepEqual(await pending, [{ ok: 16 }]);
      await assert.rejects(stream.next(), ValidationError);
      await stream.return(undefined);
      await assert.rejects(connection.streamBatches!('SELECT 1', [], 1).next(), ConnectionError);
    } finally {
      await f.close();
    }
  });

  it('releasing a stream checkout preserves an externally opened transaction and savepoint', async () => {
    const f = fixture();
    try {
      f.raw.exec('BEGIN; SAVEPOINT external; INSERT INTO source_rows VALUES(20008, 1, NULL, NULL, NULL)');
      const connection = await f.db.pool.connect();
      const stream = connection.streamBatches!('SELECT * FROM items', [], 4);
      await stream.next();
      connection.release();
      assert.equal(f.returns, 1);
      assert.equal(f.raw.isTransaction, true, 'checkout must not roll back a transaction it did not open');
      f.raw.exec('ROLLBACK TO external; RELEASE external; COMMIT');
      await stream.return(undefined);
    } finally {
      await f.close();
    }
  });

  it('unrelated pooled statements cannot join an externally opened transaction during or after a stream', async () => {
    const f = fixture(12050, { busyTimeoutMs: 15 });
    try {
      f.raw.exec('BEGIN');
      const stream = f.table.findManyStreamBatches({ batchSize: 1001 });
      await stream.next();
      const other = f.table.findManyStreamBatches({ batchSize: 1001 });
      await assert.rejects(other.next(), UnsupportedFeatureError);
      await assert.rejects(
        f.db.rawUnsafe('INSERT INTO source_rows VALUES(20009, 1, NULL, NULL, NULL)'),
        UnsupportedFeatureError,
      );
      await stream.return(undefined);
      await assert.rejects(
        f.db.rawUnsafe('INSERT INTO source_rows VALUES(20009, 1, NULL, NULL, NULL)'),
        UnsupportedFeatureError,
      );
      f.raw.exec('COMMIT');
      assert.equal((await f.db.rawUnsafe('SELECT count(*) AS n FROM source_rows WHERE id=20009'))[0]!.n, 0);
    } finally {
      await f.close();
    }
  });

  it('row streams refuse buffered rows after their transaction callback ends', async () => {
    const f = fixture();
    try {
      let stream: AsyncGenerator<Item, void, undefined> | undefined;
      await f.db.$transaction(async (tx) => {
        stream = tx.table<Item>('items').findManyStream({ batchSize: 1001 });
        assert.equal((await stream.next()).value!.id, 1);
      });
      assert.equal(f.returns, 1);
      await assert.rejects(stream!.next(), ValidationError);
      assert.equal(f.steps, 1001);
    } finally {
      await f.close();
    }
  });

  it('row streams refuse buffered rows after their savepoint callback ends while the parent stays open', async () => {
    const f = fixture();
    try {
      await f.db.$transaction(async (tx) => {
        let stream: AsyncGenerator<Item, void, undefined> | undefined;
        await tx.$transaction(async (inner) => {
          stream = inner.table<Item>('items').findManyStream({ batchSize: 1001 });
          await stream.next();
        });
        assert.equal(f.returns, 1);
        await assert.rejects(stream!.next(), ValidationError);
        assert.deepEqual(await tx.rawUnsafe('SELECT 18 AS ok'), [{ ok: 18 }]);
      });
    } finally {
      await f.close();
    }
  });

  it('a stream created inside a callback cannot start on its returned connection', async () => {
    const f = fixture();
    try {
      let stream: AsyncGenerator<Item[], void, undefined> | undefined;
      await f.db.$transaction(async (tx) => {
        stream = tx.table<Item>('items').findManyStreamBatches({ batchSize: 1001 });
      });
      await assert.rejects(stream!.next(), ValidationError);
      assert.equal(f.steps, 0);
      assert.equal(f.iterators, 0);
    } finally {
      await f.close();
    }
  });

  it('savepoint rollback closes an abandoned iterator and the outer transaction recovers', async () => {
    const f = fixture();
    try {
      let stream: AsyncGenerator<Item[], void, undefined> | undefined;
      await f.db.$transaction(async (tx) => {
        await assert.rejects(
          tx.$transaction(async (inner) => {
            await inner.rawUnsafe('INSERT INTO source_rows VALUES(20005, 1, NULL, NULL, NULL)');
            stream = inner.table<Item>('items').findManyStreamBatches({ batchSize: 1001 });
            await stream.next();
            throw new Error('abandoned savepoint stream');
          }),
          /abandoned savepoint stream/,
        );
        assert.equal(f.returns, 1);
        await assert.rejects(stream!.next(), ValidationError);
        assert.equal((await tx.rawUnsafe('SELECT count(*) AS n FROM source_rows WHERE id=20005'))[0]!.n, 0);
        await tx.rawUnsafe('INSERT INTO source_rows VALUES(20006, 1, NULL, NULL, NULL)');
      });
      assert.equal((await f.db.rawUnsafe('SELECT count(*) AS n FROM source_rows WHERE id=20006'))[0]!.n, 1);
    } finally {
      await f.close();
    }
  });

  it('ambient step failure cleans the iterator without rolling back the caller transaction', async () => {
    const f = fixture();
    try {
      await f.db.$transaction(async (tx) => {
        await tx.rawUnsafe('INSERT INTO source_rows VALUES(20007, 1, NULL, NULL, NULL)');
        f.failAt(1100);
        const stream = tx.table<Item>('items').findManyStreamBatches({ batchSize: 1001 });
        await stream.next();
        const before = f.sqls.filter((sql) => /^ROLLBACK\b/i.test(sql)).length;
        await assert.rejects(stream.next(), /injected native step failure/);
        assert.equal(f.returns, 1);
        assert.equal(f.raw.isTransaction, true);
        assert.equal(f.sqls.filter((sql) => /^ROLLBACK\b/i.test(sql)).length, before);
        assert.equal((await tx.rawUnsafe('SELECT count(*) AS n FROM source_rows WHERE id=20007'))[0]!.n, 1);
      });
    } finally {
      await f.close();
    }
  });

  it('the connection capability works under a renamed SQLite dialect', async () => {
    const f = fixture();
    try {
      const pool = new SqlitePool(f.raw, { schema });
      const db = new TurbineClient(
        { pool, dialect: { ...sqliteDialect, name: 'custom-native-sqlite' }, logger: {}, warnOnUnlimited: false },
        schema,
      );
      const stream = db.table<Item>('items').findManyStreamBatches({ batchSize: 1001 });
      assert.equal((await stream.next()).value!.length, 1001);
      await stream.return(undefined);
      assert.equal(f.steps, 1001);
      assert.equal(f.allCalls, 0);
    } finally {
      await f.close();
    }
  });

  it('native stream SQL decoding preserves aliases and does not decode expressions as boolean or JSON', async () => {
    const f = fixture();
    try {
      const connection = await f.db.pool.connect();
      const stream = connection.streamBatches!(
        'SELECT is_enabled AS renamed, prefs AS document, 1 AS computed FROM source_rows WHERE id=$1',
        [1],
        2,
      );
      const row = (await stream.next()).value![0];
      assert.deepEqual(row, {
        renamed: reportsOrigin ? true : 1,
        document: reportsOrigin ? { id: 1 } : '{"id":1}',
        computed: 1,
      });
      await stream.return(undefined);
      connection.release();
    } finally {
      await f.close();
    }
  });

  it('raw transaction connections guard native pulls and reject transaction-control SQL', async () => {
    const f = fixture();
    try {
      let stream: AsyncGenerator<Record<string, unknown>[], void, undefined> | undefined;
      await f.db.$transaction(async (tx) => {
        const client = tx.$connection();
        await assert.rejects(client.streamBatches!('COMMIT', [], 1).next(), ValidationError);
        assert.equal(f.raw.isTransaction, true);
        stream = client.streamBatches!('SELECT * FROM items', [], 4);
        assert.equal((await stream.next()).value!.length, 4);
      });
      assert.equal(f.returns, 1);
      await assert.rejects(stream!.next(), ValidationError);
      assert.equal(f.steps, 4);
    } finally {
      await f.close();
    }
  });
});

for (const method of ['findManyStream', 'findManyStreamBatches'] as const) {
  it(`${method}: public abort finalizes native stepping and releases a borrowed handle`, async () => {
    const f = fixture(100);
    const c = new AbortController();
    const reason = { stop: 'SQLite step boundary' };
    try {
      const stream = f.table[method]({ signal: c.signal, batchSize: 3 });
      assert.equal((await stream.next()).done, false);
      assert.equal(f.allCalls, 0);
      assert.equal(f.iterators, 1);
      const observed = f.steps;
      assert.ok(observed >= 3 && observed < 100);
      c.abort(reason);
      await assert.rejects(stream.next(), (error) => error === reason);
      assert.equal(f.steps, observed, 'no additional SQLite steps after abort');
      assert.equal(f.returns, 1);
      assert.equal(f.raw.prepare('SELECT COUNT(*) AS n FROM source_rows').get()!.n, 100);
    } finally {
      await f.close();
    }
  });
  it(`${method}: synchronous SQLite work can finish before an abort becomes observable`, async () => {
    const f = fixture(100);
    const c = new AbortController();
    try {
      const stream = f.table[method]({ signal: c.signal, batchSize: 3 });
      let steps = 0;
      f.raw.function('observe_row', (id) => {
        steps++;
        if (steps === 1) c.abort(new Error('inside synchronous SQLite stepping'));
        return id;
      });
      await assert.rejects(stream.next(), (error) => error === c.signal.reason);
      assert.equal(steps, 3, 'the synchronous batch finishes before cancellation can finalize stepping');
      assert.equal(f.returns, 1);
      assert.equal(f.raw.prepare('SELECT COUNT(*) AS n FROM source_rows').get()!.n, 100);
    } finally {
      await f.close();
    }
  });
}
