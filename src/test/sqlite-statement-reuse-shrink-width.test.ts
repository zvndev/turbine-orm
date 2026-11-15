/**
 * The wildcard-reuse trial must ask about both reprepare directions.
 *
 * `wildcardReuseSafe()` trials the reader a wildcard read will use on a
 * statement executed once and then reprepared by an ADD COLUMN. A reader
 * that follows a grow but fails a shrink on an already-executed statement
 * passes that trial, so its statement is retained and the first read after
 * a DROP COLUMN throws where fresh preparation returns rows. No known
 * runtime splits the two directions (the readers measured so far fix the
 * column count before stepping, which fails both), so the child process
 * below reproduces such a reader: it remembers each statement's widest
 * result and throws ERR_INVALID_STATE when a later result is narrower.
 *
 * Fails until the reuse trial also trials a shrink.
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
const { it } = skipGate(!native, 'requires node:sqlite (Node >= 22.5)');

it('a reused wildcard read matches fresh preparation where the reader only fails a shrink', () => {
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
    const { all, iterate } = p;
    const widths = new WeakMap();
    const check = (stmt, rows) => {
      if (!Array.isArray(rows) || rows.length === 0) return rows;
      const width = Array.isArray(rows[0]) ? rows[0].length : Object.keys(rows[0]).length;
      const seen = widths.get(stmt);
      if (seen !== undefined && width < seen) {
        const err = new Error('Cannot get name of column ' + width);
        err.code = 'ERR_INVALID_STATE';
        throw err;
      }
      widths.set(stmt, width);
      return rows;
    };
    // Proxies keep the native-code identity the shim checks for.
    p.all = new Proxy(all, {
      apply(target, stmt, args) { return check(stmt, Reflect.apply(target, stmt, args)); },
    });
    if (typeof iterate === 'function') {
      p.iterate = new Proxy(iterate, {
        apply(target, stmt, args) {
          const rows = check(stmt, [...Reflect.apply(target, stmt, args)]);
          return rows[Symbol.iterator]();
        },
      });
    }
    const { turbineSqlite } = await import(${JSON.stringify(source)});
    const schema = { tables: {}, enums: {} };
    const results = [];
    for (const expose of [false, true]) {
      const pool = turbineSqlite(':memory:', schema, { logger: {} }).pool;
      // Reading the handle disables statement reuse: the fresh-preparation reference.
      if (expose) void pool.db;
      const read = async () => {
        try {
          return (await pool.query('SELECT * FROM t LIMIT 1')).rows;
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
        await pool.query('ALTER TABLE t DROP COLUMN c');
        const dropped = await read();
        results.push({ before, added, dropped });
      } finally {
        await pool.end();
      }
    }
    assert.deepEqual(results[1], {
      before: [[{ a: 1, b: 'bee' }], [{ a: 1, b: 'bee' }]],
      added: [{ a: 1, b: 'bee', c: 'sea' }],
      dropped: [{ a: 1, b: 'bee' }],
    });
    assert.deepEqual(results[0], results[1], 'statement reuse must match fresh preparation');
  `,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(child.status, 0, child.stdout + child.stderr);
});
