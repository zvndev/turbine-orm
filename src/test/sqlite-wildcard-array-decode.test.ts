/**
 * Differential: a wildcard SELECT decoded from native array rows (genuine
 * unwrapped handle) must be indistinguishable from the object-row path (the
 * same handle with its statements wrapped, which keeps native object rows):
 * same values, value types, own-key order and prototypes, across wide,
 * narrow, duplicate-named and hostile-named projections. A fresh-process
 * case races DDL between prepare and step, the reprepare hazard the array
 * probe exists for.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { describe } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
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
const sqlite = skipGate(!native, 'wildcard array decode requires node:sqlite');
const arrayCapable =
  native !== undefined &&
  typeof native.StatementSync.prototype.setReturnArrays === 'function' &&
  typeof native.StatementSync.prototype.columns === 'function';
const { it } = skipGate(
  !arrayCapable,
  'requires node:sqlite with StatementSync.setReturnArrays + columns() (Node 22.x >= 22.16 or Node >= 24)',
);

type Client = ReturnType<typeof turbineSqlite>;

/** A passthrough statement wrapper: not the native all(), so the pool keeps object rows. */
function wrapStatements(raw: DatabaseSync) {
  const prepare = raw.prepare.bind(raw);
  raw.prepare = ((sql: string) => {
    const stmt = prepare(sql);
    const all = stmt.all.bind(stmt);
    stmt.all = ((...args: Parameters<typeof stmt.all>) => all(...args)) as typeof stmt.all;
    return stmt;
  }) as DatabaseSync['prepare'];
}

function open(wrapped: boolean, build: (raw: DatabaseSync) => void): { db: Client; raw: DatabaseSync } {
  const raw = new native!.DatabaseSync(':memory:') as DatabaseSync;
  build(raw);
  if (wrapped) wrapStatements(raw);
  const schema = introspectSqliteDatabase(raw);
  return { db: turbineSqlite(raw, schema, { logger: {} }), raw };
}

async function both(build: (raw: DatabaseSync) => void, run: (db: Client) => Promise<unknown>) {
  const fast = open(false, build);
  const reference = open(true, build);
  try {
    const a = await run(fast.db);
    const b = await run(reference.db);
    assert.deepEqual(a, b);
    // Key order and value types beyond deepEqual's reach (bigint-safe).
    const ser = (v: unknown) =>
      JSON.stringify(v, (_k, x: unknown) => (typeof x === 'bigint' ? `${x}n` : x instanceof Uint8Array ? [...x] : x));
    assert.equal(ser(a), ser(b));
    const proto = (v: unknown) => (Array.isArray(v) && v[0] ? Object.getPrototypeOf(v[0]) : undefined);
    assert.equal(proto(a), proto(b));
    return a;
  } finally {
    await fast.db.disconnect();
    await reference.db.disconnect();
    // A caller-supplied handle is never closed by disconnect(); the test owns both.
    fast.raw.close();
    reference.raw.close();
  }
}

const wideCols = Array.from(
  { length: 40 },
  (_, i) => `c${i} ${i % 4 === 0 ? 'INTEGER' : i % 4 === 1 ? 'TEXT' : i % 4 === 2 ? 'REAL' : 'BLOB'}`,
);
function buildWide(raw: DatabaseSync) {
  raw.exec(`CREATE TABLE wide(id INTEGER PRIMARY KEY, active BOOLEAN, ${wideCols.join(',')})`);
  const stmt = raw.prepare(`INSERT INTO wide VALUES (${Array.from({ length: 42 }, () => '?').join(',')})`);
  for (let r = 0; r < 300; r++) {
    const row: unknown[] = [r + 1, r % 3 === 0 ? null : r % 2];
    for (let c = 0; c < 40; c++) {
      row.push(
        (r + c) % 7 === 0
          ? null
          : c % 4 === 0
            ? (r + c) % 13 === 0
              ? 9007199254740993n
              : r * 100 + c
            : c % 4 === 1
              ? (r + c) % 5 === 0
                ? ''
                : `v${r}-${c} ü`
              : c % 4 === 2
                ? (r + c) / 3
                : Uint8Array.of(r % 256, c),
      );
    }
    stmt.run(...(row as never[]));
  }
}

describe('wildcard array decode', () => {
  it('wide wildcard matches object rows cell for cell (raw and typed)', async () => {
    await both(buildWide, async (db) => db.rawUnsafe('SELECT * FROM wide ORDER BY id'));
    await both(buildWide, async (db) => db.table('wide').findMany({ orderBy: { id: 'asc' } }));
  });

  it('narrow large, one-row and empty wildcard results match', async () => {
    const build = (raw: DatabaseSync) => {
      raw.exec('CREATE TABLE narrow(id INTEGER PRIMARY KEY, body TEXT, n INTEGER)');
      const stmt = raw.prepare('INSERT INTO narrow VALUES (?,?,?)');
      for (let i = 0; i < 5000; i++) stmt.run(i + 1, i % 9 === 0 ? null : `body ${i}`, i % 4 === 0 ? null : i);
    };
    await both(build, async (db) => db.rawUnsafe('SELECT * FROM narrow ORDER BY id'));
    await both(build, async (db) => db.rawUnsafe('SELECT * FROM narrow WHERE id = 42'));
    await both(build, async (db) => db.rawUnsafe('SELECT * FROM narrow WHERE id > 99999'));
  });

  it('duplicate output names keep last cell at first position', async () => {
    const build = (raw: DatabaseSync) =>
      raw.exec("CREATE TABLE dup(a INTEGER, b TEXT); INSERT INTO dup VALUES (1, 'x'), (2, 'y')");
    const rows = (await both(build, async (db) =>
      db.rawUnsafe('SELECT *, a AS b, 99 AS a FROM dup ORDER BY a'),
    )) as Record<string, unknown>[];
    assert.deepEqual(rows, [
      { a: 99, b: 1 },
      { a: 99, b: 2 },
    ]);
    assert.deepEqual(Object.keys(rows[0]!), ['a', 'b']);
  });

  it('hostile column names survive as plain writable data properties', async () => {
    const build = (raw: DatabaseSync) =>
      raw.exec(
        `CREATE TABLE weird("__proto__" INTEGER, "constructor" TEXT, "toString" TEXT, "1" INTEGER, "02" TEXT);
         INSERT INTO weird VALUES (7, 'c', 't', 1, 'z'), (NULL, NULL, NULL, NULL, NULL)`,
      );
    const rows = (await both(build, async (db) => db.rawUnsafe('SELECT * FROM weird'))) as Record<string, unknown>[];
    const first = rows[0]!;
    const protoKey = '__proto__';
    assert.equal(Object.getPrototypeOf(first), Object.prototype);
    assert.equal(Object.hasOwn(first, protoKey), true);
    assert.equal(first[protoKey], 7);
    first[protoKey] = 8;
    assert.equal(first[protoKey], 8);
    assert.deepEqual(Object.keys(first), ['1', '__proto__', 'constructor', 'toString', '02']);
  });

  it('schema-declared JSON columns decode identically from array rows', async () => {
    const build = (raw: DatabaseSync) =>
      raw.exec(
        `CREATE TABLE docs(id INTEGER PRIMARY KEY, payload JSON, note TEXT);
         INSERT INTO docs VALUES (1, '{"a":1,"b":[true,null]}', 'x'), (2, NULL, NULL), (3, '[1,2]', ':p1')`,
      );
    const rows = (await both(build, async (db) => db.rawUnsafe('SELECT * FROM docs ORDER BY id'))) as Record<
      string,
      unknown
    >[];
    assert.deepEqual(rows[0]!.payload, { a: 1, b: [true, null] });
    assert.equal(rows[1]!.payload, null);
    assert.deepEqual(rows[2]!.payload, [1, 2]);
    await both(build, async (db) => db.table('docs').findMany({ orderBy: { id: 'asc' } }));
  });

  it('wildcard reads over a view match object rows', async () => {
    const build = (raw: DatabaseSync) =>
      raw.exec(
        `CREATE TABLE base_t(id INTEGER PRIMARY KEY, payload JSON, note TEXT, active BOOLEAN);
         INSERT INTO base_t VALUES (1, '{"k":1}', 'one', 1), (2, NULL, NULL, 0);
         CREATE VIEW docs_v AS SELECT id, payload, note AS label, active FROM base_t`,
      );
    const rows = (await both(build, async (db) => db.rawUnsafe('SELECT * FROM docs_v ORDER BY id'))) as Record<
      string,
      unknown
    >[];
    assert.deepEqual(rows, [
      { id: 1, payload: { k: 1 }, label: 'one', active: true },
      { id: 2, payload: null, label: null, active: false },
    ]);
  });

  it('another connection changing the table between reads returns the executed projection', async () => {
    // The realistic reprepare trigger: this connection holds a warm schema
    // cache, another connection changes the table, and SQLite reprepares
    // the wildcard at the first step of the next read. No prototype is
    // patched; two real connections to one file do it. The oracle is the
    // known executed projection, not the wrapped object path: on runtimes
    // whose object all() fixes the width at prepare, a wrapped statement
    // answers with the stale width (or throws on shrink) at baseline too,
    // which is exactly why genuine statements take the probed route.
    const dir = mkdtempSync(join(tmpdir(), 'turbine-wildcard-xconn-'));
    const file = join(dir, 'db.sqlite');
    const raw = new native!.DatabaseSync(file) as DatabaseSync;
    raw.exec(
      'CREATE TABLE items(id INTEGER PRIMARY KEY, name TEXT, active BOOLEAN, txt TEXT);' +
        "INSERT INTO items VALUES (1, 'a', 1, 't1'), (2, 'b', 0, 't2')",
    );
    const db = turbineSqlite(raw, introspectSqliteDatabase(raw), { logger: {} });
    const other = new native!.DatabaseSync(file);
    try {
      const step = async (ddl: string) => {
        await db.rawUnsafe('SELECT * FROM items ORDER BY id LIMIT 2 OFFSET 0');
        other.exec(ddl);
        return (await db.rawUnsafe('SELECT * FROM items ORDER BY id')) as Record<string, unknown>[];
      };
      assert.deepEqual(await step('ALTER TABLE items ADD COLUMN extra BOOLEAN DEFAULT 1'), [
        { id: 1, name: 'a', active: true, txt: 't1', extra: true },
        { id: 2, name: 'b', active: false, txt: 't2', extra: true },
      ]);
      assert.deepEqual(await step(`ALTER TABLE items ADD COLUMN extra2 JSONB DEFAULT '{"k":1}'`), [
        { id: 1, name: 'a', active: true, txt: 't1', extra: true, extra2: '{"k":1}' },
        { id: 2, name: 'b', active: false, txt: 't2', extra: true, extra2: '{"k":1}' },
      ]);
      assert.deepEqual(await step('ALTER TABLE items DROP COLUMN txt'), [
        { id: 1, name: 'a', active: true, extra: true, extra2: '{"k":1}' },
        { id: 2, name: 'b', active: false, extra: true, extra2: '{"k":1}' },
      ]);
      const renamed = await step('ALTER TABLE items RENAME COLUMN name TO title');
      assert.deepEqual(renamed, [
        { id: 1, title: 'a', active: true, extra: true, extra2: '{"k":1}' },
        { id: 2, title: 'b', active: false, extra: true, extra2: '{"k":1}' },
      ]);
      assert.deepEqual(Object.keys(renamed[0]!), ['id', 'title', 'active', 'extra', 'extra2']);
    } finally {
      other.close();
      await db.disconnect();
      if (raw.isOpen) raw.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

const repo = fileURLToPath(new URL('../..', import.meta.url));
function inFreshProcess(setup: string, body: string): Record<string, unknown> {
  const script = `
    import { DatabaseSync } from 'node:sqlite';
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

describe('wildcard array decode under reprepare', () => {
  for (const shape of ['grow', 'shrink', 'duplicate'] as const) {
    sqlite.it(`wildcard ${shape} after prepare returns the executed projection`, () => {
      const sql =
        shape === 'duplicate' ? 'SELECT items.*,v AS extra FROM items ORDER BY v' : 'SELECT * FROM items ORDER BY v';
      const alter =
        shape === 'shrink'
          ? 'ALTER TABLE items DROP COLUMN active'
          : 'ALTER TABLE items ADD COLUMN extra BOOLEAN DEFAULT 1';
      const setup = `
        const origPrepare = DatabaseSync.prototype.prepare;
        let armed = true;
        DatabaseSync.prototype.prepare = function (text) {
          const stmt = origPrepare.call(this, text);
          if (armed && text === ${JSON.stringify(sql)}) { armed = false; this.exec(${JSON.stringify(alter)}); }
          return stmt;
        };
      `;
      const body = `
        const raw = new DatabaseSync(':memory:');
        raw.exec('CREATE TABLE items(v INTEGER, active BOOLEAN); INSERT INTO items VALUES(1,0),(2,1)');
        const db = turbineSqlite(raw, introspectSqliteDatabase(raw), { logger: {} });
        const rows = await db.rawUnsafe(${JSON.stringify(sql)});
        await db.disconnect();
        return { rows };
      `;
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
      assert.deepEqual(inFreshProcess(setup, body), { rows: expected });
    });
  }
});
