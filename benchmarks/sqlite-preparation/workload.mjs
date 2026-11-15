import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { defineSchema } from '../../src/schema-builder.ts';
import { schemaDefToMetadata } from '../../src/schema-metadata.ts';
import { SqlitePool } from '../../src/sqlite.ts';

export const CAPACITY = 32;
export const ROWS = 32;
export const HUGE = 9007199254740993n;
export const READ = 'SELECT id, enabled, payload, huge, nullable, bytes FROM items WHERE id = :p1';
export const schema = schemaDefToMetadata(
  defineSchema({
    items: {
      id: { type: 'integer', primaryKey: true },
      enabled: { type: 'boolean' },
      payload: { type: 'json' },
      huge: { type: 'bigint' },
      nullable: { type: 'text' },
      bytes: { type: 'bytea' },
    },
  }),
);

export function expectedRow(id, decoded = false, wide = false) {
  return {
    id: decoded ? id : BigInt(id),
    enabled: decoded ? id % 2 === 1 : BigInt(id % 2),
    payload: decoded ? payload(id, wide) : JSON.stringify(payload(id, wide)),
    huge: decoded ? String(HUGE + BigInt(id)) : HUGE + BigInt(id),
    nullable: id % 2 ? null : `row-${id}`,
    bytes: Uint8Array.of(id, 0, 255),
  };
}

function payload(id, wide) {
  return { id, label: `value-${id}`, nested: [null, true, '雪'], ...(wide ? { data: 'x'.repeat(2048) } : {}) };
}

/** Benchmark-only candidate. Owns references, never a global cache. No iterator use. */
export class Preparation {
  constructor(db, reuse, capacity = CAPACITY) {
    assert.ok(Number.isSafeInteger(capacity) && capacity > 0);
    this.db = db;
    this.reuse = reuse;
    this.capacity = capacity;
    this.entries = new Map();
    this.prepares = 0;
    this.hits = 0;
    this.evictions = 0;
    this.peak = 0;
    this.nativePrepare = db.prepare.bind(db);
    this.enabled = false;
  }

  prepare(sql) {
    if (!this.reuse) return this.fresh(sql);
    const found = this.entries.get(sql);
    if (found) {
      this.hits++;
      this.entries.delete(sql);
      this.entries.set(sql, found);
      return found;
    }
    // Failed preparation never enters the cache. Failed execution explicitly
    // evicts below. StatementSync has no finalize API on the target runtimes.
    const stmt = this.fresh(sql);
    this.entries.set(sql, stmt);
    if (this.entries.size > this.capacity) {
      this.entries.delete(this.entries.keys().next().value);
      this.evictions++;
    }
    this.peak = Math.max(this.peak, this.entries.size);
    return stmt;
  }

  fresh(sql) {
    this.prepares++;
    return this.nativePrepare(sql);
  }

  invalidate() {
    this.entries.clear();
  }

  stats() {
    return {
      prepares: this.prepares,
      hits: this.hits,
      evictions: this.evictions,
      retained: this.entries.size,
      peak: this.peak,
    };
  }
}

export function fixture(wide = false) {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(
      'CREATE TABLE items(id INTEGER PRIMARY KEY, enabled INTEGER, payload TEXT, huge INTEGER, nullable TEXT, bytes BLOB); CREATE TABLE counters(id INTEGER PRIMARY KEY, n INTEGER NOT NULL); INSERT INTO counters VALUES(1, 0)',
    );
    // Seed with native SQL expressions, independently of the JS result oracle.
    const json = "json_object('id', :id, 'label', 'value-' || :id, 'nested', json('[null,true,\"雪\"]'))";
    const stmt = db.prepare(`INSERT INTO items VALUES(
      :id, :id % 2, ${wide ? `json_set(${json}, '$.data', :wide)` : json},
      9007199254740993 + :id,
      CASE WHEN :id % 2 = 1 THEN NULL ELSE 'row-' || :id END, :bytes)`);
    for (let id = 1; id <= ROWS; id++) {
      stmt.run({ id: BigInt(id), bytes: Uint8Array.of(id, 0, 255), ...(wide ? { wide: 'x'.repeat(2048) } : {}) });
    }
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

export const ARMS = ['native-fresh', 'native-control', 'native-reuse', 'pool-fresh', 'pool-control', 'pool-reuse'];
export const CASES = [
  'read',
  'decode-wide',
  'write-run',
  'write-returning',
  'transaction',
  'shapes-fit',
  'shapes-churn',
];

export function route(arm, wide = false) {
  assert.ok(ARMS.includes(arm));
  const db = fixture(wide);
  const preparation = new Preparation(db, arm.endsWith('reuse'));
  const pooled = arm.startsWith('pool');
  const pool = pooled ? new SqlitePool(db, { schema }) : null;
  // Only scoped ordinary query calls see the candidate; streaming prepares
  // remain fresh. This is an experiment, not an installable pool option.
  if (pooled) db.prepare = (sql) => (preparation.enabled ? preparation.prepare(sql) : preparation.fresh(sql));
  return {
    db,
    pool,
    preparation,
    pooled,
    async query(sql, values = [], returnsRows = true) {
      try {
        if (pool) {
          preparation.enabled = true;
          return await pool.query(sql, values);
        }
        const stmt = preparation.prepare(sql);
        stmt.setReadBigInts(true);
        const bindings = Object.fromEntries(values.map((v, i) => [`p${i + 1}`, v]));
        if (returnsRows) {
          const rows = (values.length ? stmt.all(bindings) : stmt.all()).map((r) => ({ ...r }));
          return { rows, rowCount: rows.length };
        }
        const info = values.length ? stmt.run(bindings) : stmt.run();
        return { rows: [], rowCount: Number(info.changes) };
      } catch (error) {
        preparation.entries.delete(sql);
        throw error;
      } finally {
        preparation.enabled = false;
      }
    },
    async close() {
      preparation.invalidate();
      if (pool) await pool.end();
      else db.close();
    },
  };
}

/** No SQL/database-derived oracle: expected outputs are calculated in JS. */
export function workload(name, iterations, decoded) {
  assert.ok(CASES.includes(name));
  const operations = [];
  let counter = 0;
  const countRow = (n) => ({ n: decoded ? n : BigInt(n) });
  for (let i = 0; i < iterations; i++) {
    if (['read', 'decode-wide', 'shapes-fit', 'shapes-churn'].includes(name)) {
      const id = ((i * 17) % ROWS) + 1;
      const shapes = name === 'shapes-fit' ? CAPACITY / 2 : name === 'shapes-churn' ? CAPACITY * 4 : 1;
      const sql = shapes > 1 ? `${READ} /* shape ${i % shapes} */` : READ;
      operations.push({
        sql,
        values: [BigInt(id)],
        returnsRows: true,
        expected: { rows: [expectedRow(id, decoded, name === 'decode-wide')], rowCount: 1 },
      });
    } else if (name === 'write-run') {
      operations.push({
        sql: 'UPDATE counters SET n = n + :p1 WHERE id = :p2',
        values: [1n, 1n],
        returnsRows: false,
        expected: { rows: [], rowCount: 1 },
      });
      counter++;
    } else if (name === 'write-returning') {
      counter++;
      operations.push({
        sql: 'UPDATE counters SET n = n + :p1 WHERE id = :p2 RETURNING n',
        values: [1n, 1n],
        returnsRows: true,
        expected: { rows: [countRow(counter)], rowCount: 1 },
      });
    } else {
      operations.push({ sql: 'BEGIN', values: [], returnsRows: false });
      operations.push({
        sql: 'UPDATE counters SET n = n + :p1 WHERE id = :p2',
        values: [1n, 1n],
        returnsRows: false,
        expected: { rows: [], rowCount: 1 },
      });
      operations.push({
        sql: 'SELECT n FROM counters WHERE id = :p1',
        values: [1n],
        returnsRows: true,
        expected: { rows: [countRow(counter + 1)], rowCount: 1 },
      });
      const commit = i % 2 === 0;
      operations.push({ sql: commit ? 'COMMIT' : 'ROLLBACK', values: [], returnsRows: false });
      if (commit) counter++;
    }
  }
  return { operations, counter };
}

export async function execute(r, name, iterations) {
  const plan = workload(name, iterations, r.pooled);
  // Precompute bindings/oracles before timing, verify ALL results afterwards.
  // Retaining outputs costs both arms equally and is included in the workload.
  const outputs = [];
  const beforePreparation = r.preparation.stats();
  const cpu = process.cpuUsage();
  const started = performance.now();
  for (const op of plan.operations) outputs.push(await r.query(op.sql, op.values, op.returnsRows));
  const ms = performance.now() - started;
  const cpuUsed = process.cpuUsage(cpu);
  assert.equal(outputs.length, plan.operations.length);
  for (let i = 0; i < outputs.length; i++) {
    if (plan.operations[i].expected) {
      const { rows, rowCount } = outputs[i];
      assert.deepStrictEqual({ rows, rowCount }, plan.operations[i].expected, `${name} operation ${i}`);
    } else {
      assert.equal(outputs[i].rows.length, 0, `transaction boundary ${i}`);
    }
  }
  const observed = r.preparation.nativePrepare('SELECT n FROM counters WHERE id=1').get();
  assert.equal(Number(observed.n), plan.counter, 'independent final native effect');
  assert.equal(r.db.isTransaction, false, 'no leaked transaction');
  return {
    ms,
    cpuMicros: cpuUsed.user + cpuUsed.system,
    operations: outputs.length,
    checkedResults: outputs.length,
    counter: plan.counter,
    preparation: r.preparation.stats(),
    timedPrepares: r.preparation.prepares - beforePreparation.prepares,
    timedHits: r.preparation.hits - beforePreparation.hits,
  };
}
