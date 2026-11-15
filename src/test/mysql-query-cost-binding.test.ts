import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ValidationError } from '../errors.js';
import { MysqlPool, mysqlDialect } from '../mysql.js';

function recorder(beforeRun = () => {}) {
  const calls: { sql: string; values: unknown; method: string }[] = [];
  const run = async (method: string, sql: string, values?: unknown): Promise<[unknown, unknown]> => {
    beforeRun();
    calls.push({ sql, values, method });
    return [[], []];
  };
  const query = (sql: string, values?: unknown) => run('query', sql, values);
  const execute = (sql: string, values?: unknown) => run('execute', sql, values);
  const pool = new MysqlPool({
    query,
    execute,
    getConnection: async () => ({ query, execute, release() {} }),
    end: async () => {},
  });
  return { pool, calls, last: () => calls.at(-1)! };
}

describe('MySQL repeated binding contracts', () => {
  it('keeps lexical rewriting, reordered and repeated names, and arity refusals after warming', async () => {
    const { pool, last, calls } = recorder();
    const sql = 'SELECT $2, $1, $2, \'$99 ?\', `$88?`, "$77?" /* $66 ? */ -- $55 ?\n# $44 ?\n';
    const expected = sql.replace('SELECT $2, $1, $2', 'SELECT :p2, :p1, :p2');
    for (const params of [
      [1, 2],
      [3, 4],
      [5, 6, 7],
    ]) {
      await pool.query(sql, params);
      assert.equal(last().sql, expected);
      assert.deepEqual(last().values, Object.fromEntries(params.map((v, i) => [`p${i + 1}`, v])));
    }
    const before = calls.length;
    await assert.rejects(pool.query(sql, [1]), /\$2 names no value/);
    assert.equal(calls.length, before, 'invalid arity must not reach the driver');
    await pool.query(sql, []);
    assert.deepEqual(last(), { sql, values: undefined, method: 'query' });
    await pool.query(sql, [8, 9]);
    assert.equal(last().sql, expected);
    for (const invalid of ['SELECT ?', 'SELECT $0', 'SELECT $9007199254740992', 'SELECT $3']) {
      for (let run = 0; run < 2; run++) await assert.rejects(pool.query(invalid, [1, 2]), ValidationError);
    }
  });

  it('reads fresh mutable values and treats sparse/deleted slots as NULL', async () => {
    const { pool, last } = recorder();
    const sql = 'SELECT $2, $1, $3, $4, $5, $6';
    const date = new Date('2024-02-29T12:34:56Z');
    const bytes = new Uint8Array([0, 255]);
    const object = { value: 'first' };
    const params: unknown[] = [true, object, date, bytes, 23n, undefined];
    await pool.query(sql, params);
    const first = last().values;
    assert.deepEqual(first, { p1: 1, p2: '{"value":"first"}', p3: date, p4: bytes, p5: 23n, p6: null });
    object.value = 'second';
    date.setUTCFullYear(2025);
    bytes[0] = 9;
    delete params[0];
    params[5] = ['fresh', 7];
    await pool.query(sql, params);
    assert.notEqual(last().values, first);
    assert.deepEqual(last().values, {
      p1: null,
      p2: '{"value":"second"}',
      p3: date,
      p4: bytes,
      p5: 23n,
      p6: '["fresh",7]',
    });
    await pool.query(sql, params.slice());
    assert.equal((last().values as Record<string, unknown>).p1, null);
    params[0] = false;
    await pool.query(sql, params);
    assert.equal((last().values as Record<string, unknown>).p1, 0);
  });

  it('coerces and refuses every current value even after the SQL is warm', async () => {
    const { pool, calls } = recorder();
    const sql = 'SELECT :p1';
    const values: unknown[] = [1];
    await pool.query(sql, values);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    for (const value of [NaN, Infinity, -Infinity, new Date(NaN), cyclic]) {
      values[0] = value;
      const count = calls.length;
      await assert.rejects(pool.query(sql, values));
      assert.equal(calls.length, count, 'bad current values must never reach execute');
      values[0] = 42;
      await pool.query(sql, values);
      assert.deepEqual(calls.at(-1)!.values, { p1: 42 });
    }
    // Coercion of an unused extra value was already observable and stays checked.
    await assert.rejects(pool.query('SELECT :p1', [1, NaN]), ValidationError);
  });

  it('keeps newly appended slots when JSON conversion grows the current parameter array', async () => {
    const { pool, last } = recorder();
    const params: unknown[] = [
      {
        toJSON() {
          params.push(7);
          return 'json';
        },
      },
    ];
    await pool.query('SELECT :p2, :p1', params);
    assert.deepEqual(last().values, { p1: '"json"', p2: 7 });
    params.length = 1;
    await pool.query('SELECT :p2, :p1', params);
    assert.deepEqual(last().values, { p1: '"json"', p2: 7 });
  });

  it('keeps appended names independent of inherited numeric array properties', async () => {
    const previous = Object.getOwnPropertyDescriptor(Array.prototype, '1');
    const restore = () => {
      if (previous) Object.defineProperty(Array.prototype, '1', previous);
      else Reflect.deleteProperty(Array.prototype, '1');
    };
    const { pool, last } = recorder(restore);
    for (const getter of [false, true]) {
      let reads = 0;
      const params: unknown[] = [
        {
          toJSON() {
            Object.defineProperty(params, '1', { value: 7, writable: true, configurable: true, enumerable: true });
            return 'json';
          },
        },
      ];
      try {
        Object.defineProperty(
          Array.prototype,
          '1',
          getter
            ? {
                configurable: true,
                get() {
                  reads++;
                  return 'inheritedName';
                },
              }
            : { configurable: true, writable: true, value: 'inheritedName' },
        );
        // Binding runs synchronously; the recorder restores the prototype at
        // driver entry, before yielding to unrelated asynchronous work.
        await pool.query('SELECT :p2, :p1 /* appended names */', params);
      } finally {
        restore();
      }
      assert.equal(reads, 0);
      assert.deepEqual(last().values, { p1: '"json"', p2: 7 });
    }
  });

  it('keeps shrink, delete, throw and reentrant JSON conversion semantics', async () => {
    const { pool, last, calls } = recorder();
    const sql = 'SELECT :p2, :p1 /* coercion effects */';
    const shrinking: unknown[] = [
      {
        toJSON() {
          shrinking.length = 1;
          return 'shrink';
        },
      },
      7,
    ];
    await pool.query(sql, shrinking);
    assert.deepEqual(last().values, { p1: '"shrink"' });
    const deleting: unknown[] = [
      {
        toJSON() {
          delete deleting[1];
          return 'delete';
        },
      },
      7,
    ];
    await pool.query(sql, deleting);
    assert.deepEqual(last().values, { p1: '"delete"', p2: null });
    const thrown = new Error('conversion sentinel');
    const before = calls.length;
    await assert.rejects(
      pool.query(sql, [
        {
          toJSON() {
            throw thrown;
          },
        },
        7,
      ]),
      (e) => e === thrown,
    );
    assert.equal(calls.length, before);
    let nested: Promise<unknown> | undefined;
    const reentrant: unknown[] = [
      {
        toJSON() {
          reentrant.push(7);
          nested = pool.query(sql, [2, 3]);
          return 'outer';
        },
      },
    ];
    await pool.query(sql, reentrant);
    await nested;
    assert.deepEqual(calls.at(-2)!.values, { p1: 2, p2: 3 });
    assert.deepEqual(last().values, { p1: '"outer"', p2: 7 });
  });

  it('expands current lists independently of the warmed SQL, including scalar/list transitions', async () => {
    const { pool, last, calls } = recorder();
    const sql = "SELECT :p2 WHERE :p2 IN (:p1) /* :p1 */ AND ':p1' = ':p1'";
    const list = (v: unknown[]) => mysqlDialect.inClauseParam!(v);
    for (const values of [[], [true], [false, 'x', null], [1, 2, 3, 4, 5], []]) {
      await pool.query(sql, [list(values), 'target']);
      const binding = last().values as Record<string, unknown>;
      assert.equal(binding.p2, 'target');
      assert.equal(Object.keys(binding).length, 1 + values.length);
      assert.ok(last().sql.endsWith("/* :p1 */ AND ':p1' = ':p1'"));
      if (values.length === 0) assert.match(last().sql, /SELECT NULL FROM DUAL WHERE FALSE/);
      else assert.equal(binding.p1_0, typeof values[0] === 'boolean' ? Number(values[0]) : values[0]);
      if (values.length === 3) assert.match(last().sql, /:p1_0, :p1_1, :p1_2, :p1_2/);
    }
    await pool.query(sql, [9, 'scalar']);
    assert.equal(last().sql, sql);
    assert.deepEqual(last().values, { p1: 9, p2: 'scalar' });
    const current = [1];
    const wrapped = list(current);
    await pool.query(sql, [wrapped, 1]);
    current.push(2, 3);
    await pool.query(sql, [wrapped, 3]);
    assert.equal((last().values as Record<string, unknown>).p1_2, 3);
    const date = new Date('2024-02-29T12:34:56Z');
    const bytes = new Uint8Array([0, 255]);
    await pool.query(sql, [list([date, bytes, { value: 'json' }]), 3]);
    assert.deepEqual(last().values, { p2: 3, p1_0: date, p1_1: bytes, p1_2: '{"value":"json"}' });
    const count = calls.length;
    await assert.rejects(pool.query(sql, [list([NaN]), 1]), ValidationError);
    await assert.rejects(pool.query(sql, [list(Array(65536).fill(1)), 1]), /allows 65535/);
    assert.equal(calls.length, count);
  });

  it('preserves bindings across cache churn, oversized SQL and uncached large arities', async () => {
    const { pool, last } = recorder();
    const sql = 'SELECT $2, $1 /* churn sentinel */';
    await pool.query(sql, [1, 2]);
    for (let i = 0; i < 260; i++) {
      await pool.query(`SELECT $1 /* shape ${i} */`, [i]);
      assert.deepEqual(last().values, { p1: i });
    }
    await assert.rejects(pool.query(sql, [1]), /\$2 names no value/);
    await pool.query(sql, [7, 8]);
    assert.deepEqual(last().values, { p1: 7, p2: 8 });
    const huge = `SELECT $1 /* ${'x'.repeat(20000)} */`;
    for (const v of [1, 2]) {
      await pool.query(huge, [v]);
      assert.equal(last().sql, huge.replace('$1', ':p1'));
      assert.deepEqual(last().values, { p1: v });
    }
    const params = Array.from({ length: 129 }, (_, i) => i);
    await pool.query('SELECT $129, $1', params);
    assert.equal((last().values as Record<string, unknown>).p129, 128);
  });
});
