/** A reused native statement must not carry one execution's binding mode into the next. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { recordSqliteBulkInsert, type SqlitePool, turbineSqlite } from '../sqlite.js';
import { skipGate } from './helpers.js';

const native = (() => {
  try {
    return createRequire(process.cwd())('node:sqlite') as typeof import('node:sqlite');
  } catch {
    return undefined;
  }
})();
const { it } = skipGate(!native, 'requires node:sqlite (Node >= 22.5)');

function owned(): SqlitePool {
  return turbineSqlite(':memory:', { tables: {}, enums: {} }, { logger: {} }).pool as SqlitePool;
}

it('a recorded bulk insert that keeps named binding does not disable bare names for the same text', async () => {
  // `:p9` inside the quoted identifier breaks the strict `:p1 … :pN` run, so
  // the recorded insert keeps named binding with qualified `:pN` keys and
  // turns bare-name lookup off on its statement. The same text run again
  // with an unrecorded params array binds bare `{ p1 }` keys, which a freshly
  // prepared statement accepts.
  const sql = 'INSERT INTO "t" ("a:p9", "b") VALUES (:p1, :p2), (:p3, :p4)';
  const outcomes: unknown[] = [];
  for (const expose of [false, true]) {
    const pool = owned();
    // Reading the handle disables statement reuse: the fresh-preparation reference.
    if (expose) void pool.db;
    try {
      await pool.query('CREATE TABLE "t" ("a:p9" TEXT, "b" TEXT)');
      const params = ['1', '2', '3', '4'];
      recordSqliteBulkInsert(params, sql);
      const recorded = (await pool.query(sql, params)).rowCount;
      let copy: unknown;
      try {
        copy = (await pool.query(sql, params.slice())).rowCount;
      } catch (error) {
        copy = `${(error as Error).constructor.name}: ${(error as Error).message}`;
      }
      const rows = (await pool.query('SELECT * FROM "t" ORDER BY rowid')).rows;
      outcomes.push({ recorded, copy, rows });
    } finally {
      await pool.end();
    }
  }
  assert.deepEqual(outcomes[1], {
    recorded: 2,
    copy: 2,
    rows: [
      { 'a:p9': '1', b: '2' },
      { 'a:p9': '3', b: '4' },
      { 'a:p9': '1', b: '2' },
      { 'a:p9': '3', b: '4' },
    ],
  });
  assert.deepEqual(outcomes[0], outcomes[1], 'statement reuse must match fresh preparation');
});
