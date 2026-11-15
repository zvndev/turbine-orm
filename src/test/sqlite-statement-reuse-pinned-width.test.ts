/**
 * A retained wildcard statement must not outlive the projection it was
 * prepared with on a runtime whose readers fix the result width before the
 * first step.
 *
 * Node 22.13 to 22.15 ship `StatementSync.prototype.iterate()`, but there both
 * `all()` and `iterate()` take their column names before stepping, so a
 * statement SQLite reprepares after DDL keeps the old width: an added column
 * is missing, and a dropped one throws ERR_INVALID_STATE ("Cannot get name of
 * column N"). Fresh preparation is unaffected, because a statement prepared
 * after the DDL already has the new width. CI runs no such runtime, so the
 * child process below reproduces that reader on the current one: its `all()`
 * and `iterate()` keep the cells named by `columns()` before stepping.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { skipGate } from './helpers.js';

const native = (() => {
  try {
    return createRequire(process.cwd())('node:sqlite') as typeof import('node:sqlite');
  } catch {
    return undefined;
  }
})();
const hasColumns = typeof native?.StatementSync.prototype.columns === 'function';
const { it } = skipGate(!native || !hasColumns, 'requires node:sqlite with StatementSync.columns()');

it('a reused wildcard read matches fresh preparation where readers pin the pre-step width', () => {
  const source = new URL('../sqlite.js', import.meta.url).href;
  const child = spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      '--input-type=module',
      '-e',
      `
    import assert from 'node:assert/strict';
    import { StatementSync } from 'node:sqlite';
    const p = StatementSync.prototype;
    const { all, iterate, columns } = p;
    // The width a reader on those runtimes uses: the statement as prepared,
    // read before the step that may reprepare it.
    const pin = (stmt, row, names) =>
      Array.isArray(row) ? row.slice(0, names.length) : Object.fromEntries(names.map((n) => [n, row[n]]));
    const names = (stmt) => Reflect.apply(columns, stmt, []).map((c) => c.name);
    // Proxies keep the native-code identity the shim checks for.
    p.all = new Proxy(all, {
      apply(target, stmt, args) {
        const width = names(stmt);
        return Reflect.apply(target, stmt, args).map((row) => pin(stmt, row, width));
      },
    });
    p.iterate = new Proxy(iterate, {
      apply(target, stmt, args) {
        const width = names(stmt);
        const inner = Reflect.apply(target, stmt, args);
        return {
          [Symbol.iterator]() { return this; },
          next() { const step = inner.next(); return step.done ? step : { done: false, value: pin(stmt, step.value, width) }; },
          return(value) { inner.return?.(); return { done: true, value }; },
        };
      },
    });
    const { turbineSqlite } = await import(${JSON.stringify(source)});
    const schema = { tables: {}, enums: {} };
    const results = [];
    for (const expose of [false, true]) {
      const pool = turbineSqlite(':memory:', schema, { logger: {} }).pool;
      // Reading the handle disables statement reuse: the fresh-preparation reference.
      if (expose) void pool.db;
      const read = async () => {
        try {
          return (await pool.query('SELECT * FROM t')).rows;
        } catch (error) {
          return error.constructor.name + ' ' + (error.code ?? '');
        }
      };
      try {
        await pool.query('CREATE TABLE t(a INTEGER, b TEXT)');
        await pool.query("INSERT INTO t VALUES(1, 'bee')");
        const before = [await read(), await read()];
        await pool.query("ALTER TABLE t ADD COLUMN c TEXT DEFAULT 'sea'");
        const added = await read();
        await pool.query('ALTER TABLE t DROP COLUMN a');
        const dropped = await read();
        results.push({ before, added, dropped });
      } finally {
        await pool.end();
      }
    }
    assert.deepEqual(results[1], {
      before: [[{ a: 1, b: 'bee' }], [{ a: 1, b: 'bee' }]],
      added: [{ a: 1, b: 'bee', c: 'sea' }],
      dropped: [{ b: 'bee', c: 'sea' }],
    });
    assert.deepEqual(results[0], results[1], 'statement reuse must match fresh preparation');
  `,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(child.status, 0, child.stdout + child.stderr);
});
