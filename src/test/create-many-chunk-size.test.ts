/**
 * turbine-orm: `createMany` statement size on SQLite.
 *
 * SQLite finds each named parameter by a linear search when it prepares and
 * binds a statement, so a statement's cost grows with the square of its
 * parameters: 40,000 six-column rows took 141 s in statements of 32,766
 * parameters and 1 s in statements of 250. `createMany` therefore splits
 * a call at `capabilities.chunkBindParameters` (250 on SQLite) even when it
 * would fit one statement, except where splitting is not safe or not possible:
 * an `onConflict` call whose rows cannot be told apart across statements, and
 * a pool with no `connect()` (several statements need a transaction).
 *
 * Run: npx tsx --test src/test/create-many-chunk-size.test.ts
 */

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';
import { TurbineClient } from '../client.js';
import { introspectSqliteDatabase, SqlitePool, sqliteDialect } from '../sqlite.js';

const HAVE_NODE_SQLITE = (() => {
  try {
    createRequire(import.meta.url)('node:sqlite');
    return true;
  } catch {
    return false;
  }
})();

const ROWS = Array.from({ length: 1000 }, (_, i) => ({ k: `k${String(i).padStart(4, '0')}`, n: i }));

/** A client over a fresh database, recording every INSERT it prepares and its parameter count. */
async function recordingClient(options: { connectless?: boolean; dialect?: typeof sqliteDialect } = {}) {
  const { DatabaseSync } = await import('node:sqlite');
  const handle = new DatabaseSync(':memory:');
  handle.exec('CREATE TABLE t (k TEXT PRIMARY KEY, n INTEGER)');
  const inserts: number[] = [];
  const prepare = handle.prepare.bind(handle);
  handle.prepare = ((sql: string) => {
    if (/^\s*INSERT/i.test(sql)) inserts.push(sql.match(/:p\d+/g)?.length ?? 0);
    return prepare(sql);
  }) as typeof handle.prepare;
  const schema = introspectSqliteDatabase(handle);
  const sqlitePool = new SqlitePool(handle, { schema });
  const pool = options.connectless ? { query: sqlitePool.query.bind(sqlitePool), end: async () => {} } : sqlitePool;
  const db = new TurbineClient(
    { pool: pool as never, dialect: options.dialect ?? sqliteDialect, preparedStatements: false },
    schema,
  );
  const stored = () => handle.prepare('SELECT COUNT(*) AS n FROM t').get() as { n: number };
  return { db, inserts, stored };
}

describe('createMany statement size on SQLite', { skip: HAVE_NODE_SQLITE ? false : 'node:sqlite unavailable' }, () => {
  it('the engine states a statement size below its limit', () => {
    assert.equal(sqliteDialect.capabilities.chunkBindParameters, 250);
    assert.ok(sqliteDialect.capabilities.chunkBindParameters < sqliteDialect.capabilities.maxBindParameters);
  });

  it('splits a call that fits one statement into statements of at most 250 parameters', async () => {
    const { db, inserts, stored } = await recordingClient();
    const rows = (await db.table('t').createMany({ data: ROWS })) as Array<{ k: string }>;
    assert.deepEqual(inserts, Array(8).fill(250), 'eight statements of 125 two-column rows');
    assert.deepEqual(
      rows.map((r) => r.k),
      ROWS.map((r) => r.k),
      'rows come back in input order across statements',
    );
    assert.equal(stored().n, 1000);
  });

  it('splits a count-only call and an onConflict call the same way', async () => {
    const { db, inserts, stored } = await recordingClient();
    assert.deepEqual(await db.table('t').createMany({ data: ROWS, returning: false }), { count: 1000 });
    const updated = ROWS.map((r) => ({ ...r, n: r.n + 1 }));
    assert.deepEqual(
      await db.table('t').createMany({
        data: updated,
        onConflict: { target: ['k'], update: ['n'] },
        returning: false,
      }),
      { count: 1000 },
    );
    assert.deepEqual(inserts, Array(16).fill(250));
    assert.equal(stored().n, 1000);
  });

  it('keeps one statement for onConflict rows it could not tell apart across statements', async () => {
    const { db, inserts } = await recordingClient();
    // update assigns the key, so the rows written cannot be identified, and
    // splitting them would let two rows merge across statements unnoticed.
    await db.table('t').createMany({ data: ROWS, onConflict: { target: ['k'], update: ['k', 'n'] } });
    assert.deepEqual(inserts, [2000]);
  });

  it('keeps one statement on a pool without connect(), which cannot run several in a transaction', async () => {
    const { db, inserts, stored } = await recordingClient({ connectless: true });
    assert.deepEqual(await db.table('t').createMany({ data: ROWS, returning: false }), { count: 1000 });
    assert.deepEqual(inserts, [2000]);
    assert.equal(stored().n, 1000);
  });

  it('a dialect without chunkBindParameters splits at its maxBindParameters', async () => {
    const { chunkBindParameters: _dropped, ...older } = sqliteDialect.capabilities;
    const dialect = { ...sqliteDialect, capabilities: { ...older, maxBindParameters: 600 } };
    const { db, inserts, stored } = await recordingClient({ dialect: dialect as unknown as typeof sqliteDialect });
    assert.deepEqual(await db.table('t').createMany({ data: ROWS, returning: false }), { count: 1000 });
    assert.deepEqual(inserts, [600, 600, 600, 200]);
    assert.equal(stored().n, 1000);
  });

  it('still splits inside $transaction', async () => {
    const { db, inserts, stored } = await recordingClient();
    await db.$transaction((tx) => tx.table('t').createMany({ data: ROWS, returning: false }));
    assert.deepEqual(inserts, Array(8).fill(250));
    assert.equal(stored().n, 1000);
  });
});
