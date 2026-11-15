/** Result projection changes must preserve every value and its actual final origin. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  type BetterSqlite3Database,
  introspectBetterSqlite3Database,
  turbineBetterSqlite3,
} from '../better-sqlite3.js';
import { introspectSqliteDatabase, turbineSqlite } from '../sqlite.js';
import { skipGate } from './helpers.js';

const require = createRequire(import.meta.url);
const native = (() => {
  try {
    return require('node:sqlite') as typeof import('node:sqlite');
  } catch {
    return undefined;
  }
})();
const peer = (() => {
  try {
    return require(process.env.TURBINE_SQLITE_BINDING_PEER ?? 'better-sqlite3') as new (
      path: string,
    ) => BetterSqlite3Database;
  } catch (error) {
    if (process.env.TURBINE_REQUIRE_SQLITE_BINDING === '1') throw error;
    return undefined;
  }
})();
const sqlite = skipGate(!native, 'SQLite result metadata requires node:sqlite');
const repo = fileURLToPath(new URL('../..', import.meta.url));

/**
 * The read route is chosen once per process, so a prototype change has to
 * happen in a fresh process before Turbine's first query. `setup` runs with
 * `StatementSync`/`DatabaseSync` in scope; `body` with `turbineSqlite` and
 * `introspectSqliteDatabase` too, and returns the JSON result.
 */
function inFreshProcess(setup: string, body: string): Record<string, unknown> {
  const script = `
    import { DatabaseSync, StatementSync } from 'node:sqlite';
    ${setup}
    const { turbineSqlite, introspectSqliteDatabase } = await import(${JSON.stringify(pathToFileURL(join(repo, 'src/sqlite.ts')).href)});
    const result = await (async () => { ${body} })();
    process.stdout.write(JSON.stringify(result));
  `;
  const child = spawnSync(
    process.execPath,
    [
      ...process.execArgv.filter((flag) => flag === '--experimental-sqlite'),
      '--no-warnings',
      '--import',
      join(repo, 'node_modules/tsx/dist/loader.mjs'),
      '--input-type=module',
      '--eval',
      script,
    ],
    { cwd: repo, encoding: 'utf8', timeout: 30_000 },
  );
  assert.equal(child.status, 0, child.stderr);
  return JSON.parse(child.stdout) as Record<string, unknown>;
}

for (const driver of ['builtin', 'better-sqlite3'] as const) {
  const test = driver === 'builtin' ? sqlite.it : it;
  describe(`${driver} result metadata`, {
    skip: driver === 'better-sqlite3' && !peer && 'optional better-sqlite3 native peer is not installed',
  }, () => {
    for (const shape of ['grow', 'shrink', 'duplicate'] as const) {
      test(`wildcard ${shape} after prepare returns the executed projection in ordinary and streamed results`, async () => {
        const raw = driver === 'builtin' ? new native!.DatabaseSync(':memory:') : new peer!(':memory:');
        raw.exec('CREATE TABLE items(v INTEGER, active BOOLEAN); INSERT INTO items VALUES(1,0),(2,1)');
        const schema =
          driver === 'builtin'
            ? introspectSqliteDatabase(raw as DatabaseSync)
            : introspectBetterSqlite3Database(raw as BetterSqlite3Database);
        const db =
          driver === 'builtin'
            ? turbineSqlite(raw as DatabaseSync, schema, { logger: {} })
            : await turbineBetterSqlite3(raw as BetterSqlite3Database, schema, { logger: {} });
        const sql =
          shape === 'duplicate' ? 'SELECT items.*,v AS extra FROM items ORDER BY v' : 'SELECT * FROM items ORDER BY v';
        const prepare = raw.prepare.bind(raw);
        let armed = true;
        raw.prepare = ((text: string) => {
          const stmt = prepare(text);
          if (armed && text === sql) {
            armed = false;
            raw.exec(
              shape === 'shrink'
                ? 'ALTER TABLE items DROP COLUMN active'
                : 'ALTER TABLE items ADD COLUMN extra BOOLEAN DEFAULT 1',
            );
          }
          return stmt;
        }) as typeof raw.prepare;
        const expected =
          shape === 'shrink'
            ? [{ v: 1 }, { v: 2 }]
            : shape === 'grow'
              ? [
                  { v: 1, active: false, extra: true },
                  { v: 2, active: true, extra: true },
                ]
              : [
                  { v: 1, active: false, extra: 1 },
                  { v: 2, active: true, extra: 2 },
                ];
        try {
          assert.deepEqual(await db.rawUnsafe(sql), expected);
          assert.equal(armed, false);
          // Reset the physical projection and race the iterator's own prepare.
          raw.exec(
            'DROP TABLE items; CREATE TABLE items(v INTEGER, active BOOLEAN); INSERT INTO items VALUES(1,0),(2,1)',
          );
          armed = true;
          const connection = await db.pool.connect();
          try {
            const rows = [];
            for await (const batch of connection.streamBatches!(sql, [], 1)) rows.push(...batch);
            assert.deepEqual(rows, expected);
            assert.equal(armed, false);
          } finally {
            connection.release();
          }
        } finally {
          await db.disconnect();
          raw.close();
        }
      });
    }
    test('duplicate output names decode according to the final projected column', async () => {
      const raw = driver === 'builtin' ? new native!.DatabaseSync(':memory:') : new peer!(':memory:');
      raw.exec(
        "CREATE TABLE items(active BOOLEAN, payload JSON); INSERT INTO items VALUES(1, '{\"ok\":true}'),(0,'false')",
      );
      const schema =
        driver === 'builtin'
          ? introspectSqliteDatabase(raw as DatabaseSync)
          : introspectBetterSqlite3Database(raw as BetterSqlite3Database);
      const db =
        driver === 'builtin'
          ? turbineSqlite(raw as DatabaseSync, schema, { logger: {} })
          : await turbineBetterSqlite3(raw as BetterSqlite3Database, schema, { logger: {} });
      try {
        for (const sql of [
          'SELECT active AS v, active+0 AS v FROM items ORDER BY rowid',
          'SELECT payload AS v, active+0 AS v FROM items ORDER BY rowid',
        ])
          assert.deepEqual(await db.rawUnsafe(sql), [{ v: 1 }, { v: 0 }]);
        assert.deepEqual(await db.rawUnsafe('SELECT active+0 AS v, active AS v FROM items ORDER BY rowid'), [
          { v: true },
          { v: false },
        ]);
      } finally {
        await db.disconnect();
        raw.close();
      }
    });
  });
}

sqlite.it('wildcard reads use iterate() only where native all() loses the reprepared projection', () => {
  const result = inFreshProcess(
    `let iterated = 0;
    let stringified = 0;
    const hasIterate = typeof StatementSync.prototype.iterate === 'function';
    if (hasIterate) {
      const iterate = StatementSync.prototype.iterate;
      StatementSync.prototype.iterate = function (...args) { iterated++; return iterate.apply(this, args); };
    }
    const toString = Function.prototype.toString;
    Function.prototype.toString = function () { stringified++; return toString.call(this); };
    const counts = () => ({ iterated, stringified });`,
    `
    // Ask this runtime directly, independently of Turbine.
    const check = new DatabaseSync(':memory:');
    check.exec('CREATE TABLE t(a); INSERT INTO t VALUES(1)');
    const stale = check.prepare('SELECT * FROM t');
    check.exec('ALTER TABLE t ADD COLUMN b DEFAULT 2');
    const allIsComplete = Object.keys(stale.all()[0]).length === 2;
    check.close();
    const raw = new DatabaseSync(':memory:');
    raw.exec("CREATE TABLE items(id INTEGER PRIMARY KEY, label TEXT); INSERT INTO items(label) VALUES('a')");
    const db = turbineSqlite(raw, introspectSqliteDatabase(raw), { logger: {} });
    try {
      await db.table('items').findMany();
      const before = counts();
      for (let i = 0; i < 3; i++) {
        await db.table('items').findMany();
        await db.table('items').count();
      }
      const after = counts();
      const prepare = raw.prepare.bind(raw);
      let armed = true;
      raw.prepare = (sql) => {
        const stmt = prepare(sql);
        if (armed && sql.startsWith('SELECT')) {
          armed = false;
          raw.exec('ALTER TABLE items ADD COLUMN extra INTEGER DEFAULT 7');
        }
        return stmt;
      };
      return {
        hasIterate,
        allIsComplete,
        iterated: after.iterated - before.iterated,
        stringified: after.stringified - before.stringified,
        raced: await db.table('items').findMany(),
      };
    } finally {
      await db.disconnect();
      raw.close();
    }
    `,
  );
  // Six default reads, every one containing a star.
  assert.equal(result.iterated, result.hasIterate && !result.allIsComplete ? 6 : 0);
  assert.equal(result.stringified, 0, 'the route is decided once, not per statement');
  if (result.hasIterate || result.allIsComplete) assert.deepEqual(result.raced, [{ id: 1, label: 'a', extra: 7 }]);
});

sqlite.it('a builtin without native iteration keeps all() for wildcard reads instead of refusing them', () => {
  const result = inFreshProcess(
    "Object.defineProperty(StatementSync.prototype, 'iterate', { configurable: true, value: undefined });",
    `
    const raw = new DatabaseSync(':memory:');
    raw.exec("CREATE TABLE items(id INTEGER PRIMARY KEY, label TEXT); INSERT INTO items(label) VALUES('a'),('b')");
    const db = turbineSqlite(raw, introspectSqliteDatabase(raw), { logger: {} });
    try {
      // Turbine's own default reads, counts and writes all contain a star.
      return {
        findMany: await db.table('items').findMany({ orderBy: { id: 'asc' } }),
        findUnique: await db.table('items').findUnique({ where: { id: 2 } }),
        count: await db.table('items').count(),
        created: await db.table('items').create({ data: { label: 'c' } }),
        raw: await db.rawUnsafe('SELECT * FROM items WHERE id = 1'),
      };
    } finally {
      await db.disconnect();
      raw.close();
    }
    `,
  );
  assert.deepEqual(result, {
    findMany: [
      { id: 1, label: 'a' },
      { id: 2, label: 'b' },
    ],
    findUnique: { id: 2, label: 'b' },
    count: 2,
    created: { id: 3, label: 'c' },
    raw: [{ id: 1, label: 'a' }],
  });
});
