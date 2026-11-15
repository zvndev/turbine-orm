import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { describe, it as pureIt, type TestContext } from 'node:test';
import { pathToFileURL } from 'node:url';
import { migrateSqliteDeploy, migrateSqliteStatus } from '../cli/sqlite-migrate.js';
import { planSqliteSchema, pushSqliteSchema } from '../cli/sqlite-schema.js';
import { parseSqliteTableDdl } from '../cli/sqlite-schema-ddl.js';
import { type ColumnDef, defineSchema } from '../schema-builder.js';
import { skipGate } from './helpers.js';

const native = (() => {
  try {
    return createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
  } catch {
    return undefined;
  }
})();
const [major, minor] = process.versions.node.split('.').map(Number);
const { it: readIt } = skipGate(
  !native || major! < 22 || (major === 22 && minor! < 16) || major === 23,
  'SQLite schema planning requires node:sqlite (Node 22.x >= 22.16 or Node >= 24)',
);
const { it } = skipGate(
  !native || !('setAuthorizer' in native.DatabaseSync.prototype),
  'SQLite migration writer requires setAuthorizer/isTransaction (Node >= 24.10)',
);
const modes = ['STRICT', 'WITHOUT ROWID', 'STRICT, WITHOUT ROWID', 'WITHOUT ROWID, STRICT'];
const originalDdl = (mode: string) =>
  `CREATE TABLE records(tenant TEXT, seq INTEGER, payload TEXT UNIQUE CHECK(payload != ''), bytes BLOB, large INTEGER, PRIMARY KEY(seq, tenant)) ${mode}`;
function schema(payload: ColumnDef = { type: 'text', unique: true, check: "payload != ''" }, extra = {}) {
  return defineSchema({
    records: {
      tenant: { type: 'text' },
      seq: { type: 'integer' },
      payload,
      bytes: { type: 'bytea' },
      large: { type: 'integer' },
      ...extra,
      primaryKey: ['seq', 'tenant'],
    },
  });
}
function target(extra = {}) {
  return schema({ type: 'text', unique: true, check: "payload != ''", notNull: true, default: "'next'" }, extra);
}
function db<T>(file: string, run: (c: DatabaseSync) => T): T {
  const c = new native!.DatabaseSync(file);
  try {
    c.exec('PRAGMA foreign_keys=ON');
    return run(c);
  } finally {
    c.close();
  }
}
function rows(file: string, sql: string) {
  return db(file, (c) =>
    c
      .prepare(sql)
      .all()
      .map((r) => ({ ...r })),
  );
}
function fixture(t: TestContext, mode: string, populate = true) {
  const dir = mkdtempSync(join(tmpdir(), 'turbine-sqlite-table-modes-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'db.sqlite');
  db(file, (c) => {
    c.exec(originalDdl(mode));
    if (populate)
      c.exec(
        `INSERT INTO records(${mode.includes('WITHOUT') ? '' : 'rowid,'}tenant,seq,payload,bytes,large)
        VALUES(${mode.includes('WITHOUT') ? '' : '67,'}'a',2,'kept',X'00ff80',9223372036854775806)`,
      );
  });
  return { file, dir };
}
function unchanged(file: string, run: () => unknown, pattern: RegExp) {
  const before = readFileSync(file);
  assert.throws(run, pattern);
  assert.deepEqual(readFileSync(file), before);
}
function facts(file: string) {
  return db(file, (c) => ({
    table: { ...c.prepare("SELECT wr, strict FROM pragma_table_list WHERE schema='main' AND name='records'").get() },
    columns: c
      .prepare('PRAGMA table_xinfo(records)')
      .all()
      .map((r) => ({ ...r })),
    keys: c
      .prepare("SELECT * FROM pragma_index_xinfo('sqlite_autoindex_records_2')")
      .all()
      .map((r) => ({ ...r })),
  }));
}

describe('SQLite table mode DDL parsing', () => {
  for (const suffix of ['', ...modes, 'strict /* mode */ , WITHOUT -- mode\n ROWID']) {
    pureIt(`reads only native options: ${suffix || 'ordinary table'}`, () => {
      const result = parseSqliteTableDdl(
        `CREATE TABLE "strict" ("without" TEXT DEFAULT 'STRICT, WITHOUT ROWID') ${suffix}; -- end`,
      );
      assert.equal(result.strict, /strict/i.test(suffix));
      assert.equal(result.withoutRowid, /without/i.test(suffix));
      assert.equal(result.suffixSql, suffix);
      assert.equal(result.columns[0]!.defaultSql, "'STRICT, WITHOUT ROWID'");
    });
  }
  pureIt('refuses unknown, quoted, duplicate, incomplete and multi-statement options', () => {
    for (const suffix of [
      'STRICT WITHOUT ROWID',
      'STRICT,',
      ', STRICT',
      'STRICT, STRICT',
      'WITHOUT ROWID, WITHOUT ROWID',
      'WITHOUT',
      'WITHOUT "ROWID"',
      '"STRICT"',
      'STRICT, OPAQUE',
      'STRICT; SELECT 1',
      'STRICT;;',
    ])
      assert.throws(
        () => parseSqliteTableDdl(`CREATE TABLE t(id INTEGER PRIMARY KEY) ${suffix}`),
        /suffix|multiple statements/,
      );
    assert.throws(() => parseSqliteTableDdl('CREATE VIRTUAL TABLE t USING fts5(value)'), /unsupported/);
  });
});

describe('existing native SQLite table modes', () => {
  for (const mode of modes) {
    readIt(`previews no-op, ADD and rebuild without writes: ${mode}`, (t) => {
      const f = fixture(t, mode);
      const before = readFileSync(f.file);
      assert.equal(planSqliteSchema(schema(), f.file).steps.length, 0);
      const add = planSqliteSchema(schema(undefined, { extra: { type: 'integer', default: 7 } }), f.file);
      assert.deepEqual(add.changes, [{ table: 'records', kind: mode.includes('STRICT') ? 'rebuild' : 'add' }]);
      const rebuild = planSqliteSchema(target(), f.file);
      assert.deepEqual(rebuild.changes, [{ table: 'records', kind: 'rebuild' }]);
      assert.ok(rebuild.steps[0]!.sql.endsWith(mode));
      const copy = rebuild.steps.find((step) => step.sql.startsWith('INSERT INTO'))!.sql;
      assert.equal(copy.includes('"rowid"'), !mode.includes('WITHOUT'));
      assert.deepEqual(readFileSync(f.file), before);
      assert.equal(facts(f.file).keys.length > 0, true, 'native ordered PK index must exist');
    });

    readIt(`treats explicit and implicit PK nullability as the same native requirement: ${mode}`, (t) => {
      const f = fixture(t, mode, false);
      db(f.file, (c) =>
        c.exec(
          `DROP TABLE records; ${originalDdl(mode).replace('tenant TEXT', 'tenant TEXT NOT NULL').replace('seq INTEGER', 'seq INTEGER NOT NULL')}`,
        ),
      );
      const before = readFileSync(f.file);
      assert.equal(planSqliteSchema(schema(), f.file).steps.length, 0);
      const nullable = schema(undefined, { required: { type: 'text' } });
      assert.ok(planSqliteSchema(nullable, f.file).steps.length > 0);
      assert.deepEqual(readFileSync(f.file), before);
    });

    it(`preserves native keys, rows, indexes and triggers through ADD/rebuild: ${mode}`, (t) => {
      const f = fixture(t, mode);
      db(f.file, (c) =>
        c.exec(`CREATE TABLE audit(value TEXT);
        CREATE INDEX by_payload ON records(lower(payload)) WHERE payload != '';
        CREATE TRIGGER record_insert AFTER INSERT ON records BEGIN INSERT INTO audit VALUES(new.payload); END;`),
      );
      const objects = rows(
        f.file,
        "SELECT name,sql FROM sqlite_schema WHERE tbl_name='records' AND sql IS NOT NULL AND type!='table' ORDER BY name",
      );
      const initial = facts(f.file);
      pushSqliteSchema(schema(undefined, { extra: { type: 'integer', default: 7 } }), f.file);
      pushSqliteSchema(target({ extra: { type: 'integer', default: 7 } }), f.file);
      assert.deepEqual(facts(f.file).table, initial.table);
      assert.deepEqual(
        facts(f.file).keys.filter((c) => c.key === 1),
        initial.keys.filter((c) => c.key === 1),
      );
      assert.deepEqual(
        facts(f.file).columns.filter((c) => Number(c.pk) > 0),
        initial.columns.filter((c) => Number(c.pk) > 0),
      );
      assert.deepEqual(
        rows(
          f.file,
          "SELECT name,sql FROM sqlite_schema WHERE tbl_name='records' AND sql IS NOT NULL AND type!='table' ORDER BY name",
        ),
        objects,
      );
      assert.deepEqual(
        rows(f.file, 'SELECT tenant,seq,payload,hex(bytes) AS bytes,CAST(large AS TEXT) AS large,extra FROM records'),
        [{ tenant: 'a', seq: 2, payload: 'kept', bytes: '00FF80', large: '9223372036854775806', extra: 7 }],
      );
      assert.deepEqual(rows(f.file, 'SELECT * FROM audit'), []);
      db(f.file, (c) => {
        if (mode.includes('WITHOUT')) assert.throws(() => c.prepare('SELECT rowid FROM records'), /no such column/);
        else assert.equal(c.prepare('SELECT rowid FROM records').get()!.rowid, 67);
        assert.throws(() => c.exec('INSERT INTO records(tenant,seq) VALUES(NULL,3)'), /NOT NULL/);
        assert.throws(() => c.exec("INSERT INTO records(tenant,seq,payload) VALUES('b',3,'kept')"), /UNIQUE/);
        assert.throws(() => c.exec("INSERT INTO records(tenant,seq,payload) VALUES('b',3,'')"), /CHECK/);
        assert.throws(() => c.exec("INSERT INTO records(tenant,seq,payload) VALUES('b',3,NULL)"), /NOT NULL/);
        c.exec("INSERT INTO records(tenant,seq) VALUES('b',3)");
        assert.equal(c.prepare('PRAGMA integrity_check').get()!.integrity_check, 'ok');
      });
      assert.deepEqual(rows(f.file, 'SELECT * FROM audit'), [{ value: 'next' }]);
      assert.equal(planSqliteSchema(target({ extra: { type: 'integer', default: 7 } }), f.file).steps.length, 0);
    });

    readIt(`refuses opaque dependencies, key drift, generated columns and missing values: ${mode}`, (t) => {
      const f = fixture(t, mode);
      const reordered = schema();
      reordered.tables.records!.primaryKey = ['tenant', 'seq'];
      for (const [desired, pattern] of [
        [reordered, /constraints differ/],
        [schema({ type: 'integer' }), /type, key/],
        [schema(undefined, { required: { type: 'text', notNull: true } }), /no non-NULL default/],
      ] as const)
        unchanged(f.file, () => planSqliteSchema(desired, f.file), pattern);
      db(f.file, (c) => c.exec('CREATE VIEW payloads AS SELECT payload FROM records'));
      unchanged(f.file, () => planSqliteSchema(target(), f.file), /opaque/);
      db(f.file, (c) =>
        c.exec(
          'DROP VIEW payloads; CREATE TABLE child(seq INTEGER, tenant TEXT, FOREIGN KEY(seq,tenant) REFERENCES records(seq,tenant) ON DELETE CASCADE)',
        ),
      );
      unchanged(f.file, () => planSqliteSchema(target(), f.file), /inbound foreign keys/);
      db(f.file, (c) =>
        c.exec('DROP TABLE child; ALTER TABLE records ADD COLUMN computed INTEGER AS (seq * 2) VIRTUAL'),
      );
      unchanged(f.file, () => planSqliteSchema(target(), f.file), /generated/);
    });

    it(`rolls back a later constraint failure and lock contention exactly: ${mode}`, (t) => {
      const f = fixture(t, mode);
      db(f.file, (c) => c.exec("INSERT INTO records(tenant,seq,payload) VALUES('a',3,'other')"));
      const desired = target({ indexes: [{ name: 'unique_tenant', columns: ['tenant'], unique: true }] });
      unchanged(f.file, () => pushSqliteSchema(desired, f.file), /UNIQUE/);
      assert.equal(
        rows(f.file, "SELECT count(*) AS n FROM sqlite_schema WHERE name GLOB '_turbine_rebuild_*'")[0]!.n,
        0,
      );
      db(f.file, (c) => {
        c.exec('BEGIN IMMEDIATE');
        unchanged(f.file, () => pushSqliteSchema(target(), f.file, { lockWaitMs: 0 }), /migration lock/);
        c.exec('ROLLBACK');
      });
      pushSqliteSchema(target(), f.file);
      assert.deepEqual(facts(f.file).table, {
        wr: mode.includes('WITHOUT') ? 1 : 0,
        strict: mode.includes('STRICT') ? 1 : 0,
      });
    });
  }

  for (const mode of modes.filter((mode) => mode.includes('STRICT'))) {
    readIt(`rejects non-STRICT target types before any effects: ${mode}`, (t) => {
      const f = fixture(t, mode);
      unchanged(
        f.file,
        () => planSqliteSchema(schema(undefined, { price: { type: 'numeric' } }), f.file),
        /cannot preserve native table modes.*NUMERIC/,
      );
      db(f.file, (c) => c.exec('CREATE TABLE opaque(value ANY) STRICT'));
      unchanged(
        f.file,
        () => planSqliteSchema(defineSchema({ opaque: { value: { type: 'text', notNull: true } } }), f.file),
        /type, key/,
      );
    });

    it(`keeps native lossless insertion rules and rejects bad defaults atomically: ${mode}`, (t) => {
      const f = fixture(t, mode);
      for (const rebuild of [false, true]) {
        if (rebuild) pushSqliteSchema(target(), f.file);
        db(f.file, (c) => {
          for (const value of ["'text'", '1.5', "X'01'"])
            assert.throws(
              () => c.exec(`INSERT INTO records(tenant,seq,payload) VALUES('b',${value},'bad')`),
              /cannot store/,
            );
          c.exec("INSERT INTO records(tenant,seq,payload) VALUES('b','00012','lossless')");
          assert.equal(c.prepare("SELECT typeof(seq) AS kind FROM records WHERE tenant='b'").get()!.kind, 'integer');
          c.exec("DELETE FROM records WHERE tenant='b'");
        });
      }
      const bad = target({ bad: { type: 'integer', notNull: true, default: "'text'" } });
      unchanged(f.file, () => pushSqliteSchema(bad, f.file), /type mismatch|cannot store/);
      const copyFailure = target({ bad: { type: 'integer', default: 'CURRENT_TIMESTAMP' } });
      unchanged(f.file, () => pushSqliteSchema(copyFailure, f.file), /cannot store/);
      pushSqliteSchema(target({ good: { type: 'integer', default: "'00012'" } }), f.file);
      assert.equal(rows(f.file, 'SELECT good,typeof(good) AS kind FROM records')[0]!.good, 12);
      assert.equal(rows(f.file, 'SELECT typeof(good) AS kind FROM records')[0]!.kind, 'integer');
    });
  }

  it('preserves INTEGER PRIMARY KEY behavior without inventing AUTOINCREMENT or rowids', (t) => {
    const f = fixture(t, 'WITHOUT ROWID', false);
    db(f.file, (c) =>
      c.exec('DROP TABLE records; CREATE TABLE records(id INTEGER PRIMARY KEY, value TEXT) WITHOUT ROWID'),
    );
    const desired = defineSchema({
      records: { id: { type: 'integer', primaryKey: true }, value: { type: 'text', default: "'x'" } },
    });
    pushSqliteSchema(desired, f.file);
    db(f.file, (c) => {
      assert.throws(() => c.exec('INSERT INTO records DEFAULT VALUES'), /NOT NULL/);
      c.exec('INSERT INTO records(id) VALUES(8)');
      assert.throws(() => c.prepare('SELECT rowid FROM records'), /no such column/);
      assert.equal(c.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name='sqlite_sequence'").get()!.n, 0);
    });
    const serial = defineSchema({ records: { id: { type: 'serial', primaryKey: true }, value: { type: 'text' } } });
    unchanged(f.file, () => pushSqliteSchema(serial, f.file), /type, key/);
  });

  it('copies declared rowid aliases in WITHOUT ROWID tables and preserves explicit PK NOT NULL', (t) => {
    const f = fixture(t, 'STRICT, WITHOUT ROWID', false);
    db(f.file, (c) =>
      c.exec(`DROP TABLE records;
      CREATE TABLE aliases(rowid TEXT NOT NULL PRIMARY KEY, _rowid_ TEXT, oid INTEGER) STRICT, WITHOUT ROWID;
      INSERT INTO aliases VALUES('key','00012',7)`),
    );
    const desired = defineSchema({
      aliases: {
        rowid: { type: 'text', primaryKey: true },
        _rowid_: { type: 'text', notNull: true },
        oid: { type: 'integer' },
      },
    });
    const before = rows(f.file, 'SELECT * FROM aliases');
    pushSqliteSchema(desired, f.file);
    assert.deepEqual(rows(f.file, 'SELECT * FROM aliases'), before);
    assert.equal(planSqliteSchema(desired, f.file).steps.length, 0);
    assert.match(
      String(rows(f.file, "SELECT sql FROM sqlite_schema WHERE name='aliases'")[0]!.sql),
      /rowid TEXT.*NOT NULL/s,
    );
  });

  it('preserves STRICT AUTOINCREMENT high-water marks, hidden rowids and history', async (t) => {
    const f = fixture(t, 'STRICT', false);
    db(f.file, (c) => c.exec('DROP TABLE records'));
    const dir = join(f.dir, 'migrations');
    mkdirSync(dir);
    writeFileSync(
      join(dir, '20260101000000_create.sql'),
      `-- UP
      CREATE TABLE items(id INTEGER PRIMARY KEY AUTOINCREMENT, value TEXT) STRICT;
      INSERT INTO items VALUES(100,'deleted'); DELETE FROM items;
      -- DOWN
      DROP TABLE items;`,
    );
    await migrateSqliteDeploy(f.file, dir);
    const history = rows(f.file, 'SELECT * FROM _turbine_migrations');
    const desired = defineSchema({
      items: { id: { type: 'serial', primaryKey: true }, value: { type: 'text', default: "'new'" } },
    });
    pushSqliteSchema(desired, f.file);
    db(f.file, (c) => c.exec('INSERT INTO items DEFAULT VALUES'));
    assert.deepEqual(rows(f.file, 'SELECT * FROM items'), [{ id: 101, value: 'new' }]);
    assert.deepEqual(rows(f.file, 'SELECT * FROM _turbine_migrations'), history);
    assert.equal((await migrateSqliteStatus(f.file, dir))[0]!.checksumValid, true);
  });

  it('recovers exact native modes and rows after process death during a rebuild', (t) => {
    const f = fixture(t, 'STRICT, WITHOUT ROWID');
    const before = readFileSync(f.file);
    const marker = join(f.dir, 'copied');
    const source = `
      import { createRequire } from 'node:module';
      import { writeFileSync } from 'node:fs';
      import { pushSqliteSchema } from ${JSON.stringify(new URL('../cli/sqlite-schema.ts', import.meta.url).href)};
      import { defineSchema } from ${JSON.stringify(new URL('../schema-builder.ts', import.meta.url).href)};
      const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
      const prepare = DatabaseSync.prototype.prepare;
      DatabaseSync.prototype.prepare = function(sql) {
        if (sql.startsWith('DROP TABLE main.')) {
          const table = prepare.call(this, "SELECT name FROM sqlite_schema WHERE name GLOB '_turbine_rebuild_*'").get();
          const count = prepare.call(this, 'SELECT count(*) AS n FROM "' + table.name + '"').get().n;
          if (count !== 1) throw new Error('copy not reached');
          writeFileSync(${JSON.stringify(marker)}, String(count));
          process.kill(process.pid, 'SIGKILL');
        }
        return prepare.call(this, sql);
      };
      pushSqliteSchema(defineSchema({records:{tenant:{type:'text'},seq:{type:'integer'},payload:{type:'text',unique:true,check:"payload != ''",notNull:true},bytes:{type:'bytea'},large:{type:'integer'},primaryKey:['seq','tenant']}}), ${JSON.stringify(f.file)});
    `;
    const child = spawnSync(
      process.execPath,
      [
        '--import',
        pathToFileURL(join(process.cwd(), 'node_modules/tsx/dist/loader.mjs')).href,
        '--input-type=module',
        '-e',
        source,
      ],
      { encoding: 'utf8', timeout: 30000 },
    );
    assert.equal(child.signal, 'SIGKILL', child.stderr);
    assert.equal(readFileSync(marker, 'utf8'), '1');
    assert.deepEqual(rows(f.file, 'SELECT payload,hex(bytes) AS bytes,CAST(large AS TEXT) AS large FROM records'), [
      { payload: 'kept', bytes: '00FF80', large: '9223372036854775806' },
    ]);
    assert.deepEqual(readFileSync(f.file), before);
    assert.deepEqual(facts(f.file).table, { wr: 1, strict: 1 });
    pushSqliteSchema(target(), f.file);
    assert.equal(planSqliteSchema(target(), f.file).steps.length, 0);
  });
});
