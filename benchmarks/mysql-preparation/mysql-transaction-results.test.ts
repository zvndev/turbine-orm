import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MysqlPool } from '../../src/mysql.js';

const begin = 'SET TRANSACTION ISOLATION LEVEL READ COMMITTED; START TRANSACTION';

function fixture(query: (sql: string) => Promise<[unknown, unknown]>) {
  let releases = 0;
  const pool = new MysqlPool({
    query,
    execute: async () => {
      throw new Error('transaction control must use text protocol');
    },
    getConnection: async () => ({ query, execute: query, release: () => releases++ }),
    end: async () => {},
  });
  return { pool, released: () => releases };
}

describe('MySQL compound transaction results', () => {
  it('waits for each statement and returns only the final native rows without reading their getters', async () => {
    const calls: string[] = [];
    let started!: () => void;
    const firstStarted = new Promise<void>((resolve) => { started = resolve; });
    let finish!: () => void;
    const firstFinished = new Promise<void>((resolve) => { finish = resolve; });
    let reads = 0;
    const rows = [{ get value() { reads++; throw new Error('lazy result getter'); } }];
    const f = fixture(async (sql) => {
      calls.push(sql);
      if (calls.length === 1) {
        started();
        await firstFinished;
        return [[{ first: true }], []];
      }
      assert.equal(calls.length, 2);
      return [rows, []];
    });
    const connection = await f.pool.connect();
    try {
      const pending = connection.query(begin);
      await firstStarted;
      assert.deepEqual(calls, ['SET TRANSACTION ISOLATION LEVEL READ COMMITTED']);
      finish();
      const result = await pending;
      assert.deepEqual(calls, ['SET TRANSACTION ISOLATION LEVEL READ COMMITTED', 'START TRANSACTION']);
      assert.equal(result.rows, rows);
      assert.equal(result.rowCount, 1);
      assert.equal(reads, 0);
      assert.equal(typeof Object.getOwnPropertyDescriptor(result.rows[0]!, 'value')?.get, 'function');
    } finally { connection.release(); }
    assert.equal(f.released(), 1);
  });

  for (const failingStatement of [1, 2]) {
    it(`preserves exact failure identity and stops after failing statement ${failingStatement}`, async () => {
      const sentinel = new Error('native transaction control failure');
      const calls: string[] = [];
      const f = fixture(async (sql) => {
        calls.push(sql);
        if (calls.length === failingStatement) throw sentinel;
        return [[], []];
      });
      const connection = await f.pool.connect();
      try {
        await assert.rejects(connection.query(`${begin}; SELECT 99`), (error) => error === sentinel);
        assert.equal(calls.length, failingStatement);
      } finally { connection.release(); }
      assert.equal(f.released(), 1);
    });
  }

  it('keeps the empty fallback when a replaced split iterator yields no statement', async () => {
    let calls = 0;
    const f = fixture(async () => { calls++; return [[], []]; });
    const connection = await f.pool.connect();
    const original = String.prototype.split;
    let pending: ReturnType<typeof connection.query>;
    try {
      String.prototype.split = function (this: string, separator: string | RegExp, limit?: number): string[] {
        if (String(this) === begin && separator === '; ') return [];
        return Reflect.apply(original, String(this), [separator, limit]);
      } as typeof original;
      pending = connection.query(begin);
    } finally { String.prototype.split = original; }
    try {
      assert.deepEqual(await pending, { rows: [], rowCount: 0 });
      assert.equal(calls, 0);
    } finally { connection.release(); }
    assert.equal(f.released(), 1);
  });

  it('does not split an ordinary statement or one carrying bindings', async () => {
    const calls: string[] = [];
    const f = fixture(async (sql) => { calls.push(sql); return [[], []]; });
    const connection = await f.pool.connect();
    try {
      await connection.query('SELECT 1; SELECT 2');
      await connection.query(`${begin}; SELECT $1`, [7]);
      assert.deepEqual(calls, ['SELECT 1; SELECT 2', `${begin}; SELECT :p1`]);
    } finally { connection.release(); }
  });
});
