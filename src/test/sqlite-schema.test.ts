import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { describe, type TestContext } from 'node:test';
import { pathToFileURL } from 'node:url';
import { migrateSqliteDeploy, migrateSqliteStatus, withSqliteSchemaTransaction } from '../cli/sqlite-migrate.js';
import { planSqliteSchema, pushSqliteSchema } from '../cli/sqlite-schema.js';
import { type ColumnDef, defineSchema } from '../schema-builder.js';
import { introspectSqliteDatabase } from '../sqlite.js';
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
function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'turbine-sqlite-schema-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, file: join(dir, 'db.sqlite') };
}
function db<T>(file: string, run: (db: DatabaseSync) => T): T {
  const connection = new native!.DatabaseSync(file);
  try {
    connection.exec('PRAGMA foreign_keys=ON');
    return run(connection);
  } finally {
    connection.close();
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
function items(name: ColumnDef = { type: 'text' }, extra: Record<string, ColumnDef> = {}) {
  return defineSchema({ items: { id: { type: 'serial', primaryKey: true }, name, ...extra } });
}
function unchanged(file: string, run: () => unknown, pattern: RegExp) {
  const bytes = readFileSync(file);
  assert.throws(run, pattern);
  assert.deepEqual(readFileSync(file), bytes, 'refusal must not alter the database');
}

describe('native SQLite schema lifecycle', () => {
  readIt('plans fresh tables without creating a database, with literal-aware definitions', (t) => {
    const f = fixture(t);
    const plan = planSqliteSchema(items({ type: 'text', default: "'), DEFAULT'", check: "name != '('" }), f.file);
    assert.equal(plan.changes.length, 1);
    assert.match(plan.steps[0]!.sql, /CREATE TABLE/);
    assert.throws(() => readFileSync(f.file), /ENOENT/);
  });

  it('creates a fresh schema, enforces foreign keys/checks, and converges', (t) => {
    const f = fixture(t);
    const schema = defineSchema({
      parents: { id: { type: 'integer', primaryKey: true } },
      children: {
        id: { type: 'serial', primaryKey: true },
        parentId: { type: 'integer', references: 'parents.id' },
        score: { type: 'integer', check: 'score >= 0' },
      },
    });
    pushSqliteSchema(schema, f.file);
    db(f.file, (c) => {
      c.exec('INSERT INTO parents VALUES(1); INSERT INTO children(parent_id,score) VALUES(1,2)');
      assert.throws(() => c.exec('INSERT INTO children(parent_id,score) VALUES(9,2)'), /FOREIGN KEY/);
      assert.throws(() => c.exec('INSERT INTO children(parent_id,score) VALUES(1,-1)'), /CHECK/);
    });
    assert.equal(rows(f.file, 'SELECT score FROM children')[0]!.score, 2);
    assert.equal(planSqliteSchema(schema, f.file).steps.length, 0);
  });

  it('adds constant default columns to a referenced parent without cascading data', (t) => {
    const f = fixture(t);
    pushSqliteSchema(items(), f.file);
    db(f.file, (c) =>
      c.exec(
        "INSERT INTO items(name) VALUES ('kept'); CREATE TABLE child(id INTEGER REFERENCES items(id) ON DELETE CASCADE); INSERT INTO child VALUES(1)",
      ),
    );
    const target = items({ type: 'text' }, { count: { type: 'integer', notNull: true, default: 7 } });
    const plan = planSqliteSchema(target, f.file);
    assert.equal(plan.changes[0]!.kind, 'add');
    pushSqliteSchema(target, f.file, { expectedPlan: plan });
    assert.deepEqual(rows(f.file, 'SELECT name,count FROM items'), [{ name: 'kept', count: 7 }]);
    assert.equal(rows(f.file, 'SELECT count(*) AS n FROM child')[0]!.n, 1);
  });

  it('rebuilds a leaf, preserving constraints, indexes, triggers, rowids and AUTOINCREMENT high water', (t) => {
    const f = fixture(t);
    const initial = items({ type: 'text', check: "name != ''" });
    pushSqliteSchema(initial, f.file);
    db(f.file, (c) =>
      c.exec(`CREATE TABLE audit(value TEXT);
      CREATE INDEX extra_name ON items(name) WHERE name != '';
      CREATE TRIGGER log_name AFTER INSERT ON items BEGIN INSERT INTO audit VALUES(new.name); END;
      INSERT INTO items(id,name) VALUES(40,'first'),(100,'removed'); DELETE FROM items WHERE id=100; DELETE FROM audit;`),
    );
    const target = items({ type: 'text', notNull: true, default: "'new'", check: "name != ''" });
    const objects = rows(
      f.file,
      "SELECT name,sql FROM sqlite_schema WHERE type IN ('trigger','index') AND sql IS NOT NULL ORDER BY name",
    );
    const plan = planSqliteSchema(target, f.file);
    assert.equal(plan.changes[0]!.kind, 'rebuild');
    assert.ok(plan.preserved.includes('trigger log_name'));
    pushSqliteSchema(target, f.file);
    assert.deepEqual(rows(f.file, 'SELECT rowid,id,name FROM items'), [{ id: 40, name: 'first' }]);
    assert.deepEqual(rows(f.file, 'SELECT * FROM audit'), [], 'copy must not execute user triggers');
    assert.deepEqual(
      rows(
        f.file,
        "SELECT name,sql FROM sqlite_schema WHERE type IN ('trigger','index') AND sql IS NOT NULL ORDER BY name",
      ),
      objects,
    );
    db(f.file, (c) => {
      assert.throws(() => c.exec("INSERT INTO items(name) VALUES('')"), /CHECK/);
      assert.throws(() => c.exec('INSERT INTO items(name) VALUES(NULL)'), /NOT NULL/);
      c.exec('INSERT INTO items DEFAULT VALUES');
    });
    assert.deepEqual(rows(f.file, 'SELECT id,name FROM items ORDER BY id'), [
      { id: 40, name: 'first' },
      { id: 101, name: 'new' },
    ]);
    assert.deepEqual(rows(f.file, 'SELECT * FROM audit'), [{ value: 'new' }]);
    assert.equal(planSqliteSchema(target, f.file).steps.length, 0);
  });

  it('preserves expression-index SQL and refuses computed columns after metadata introspection', (t) => {
    const f = fixture(t);
    pushSqliteSchema(items(), f.file);
    db(f.file, (c) => {
      c.exec("INSERT INTO items(name) VALUES('One'); CREATE UNIQUE INDEX by_lower_name ON items(lower(name));");
      const meta = introspectSqliteDatabase(c, { logger: {} });
      assert.deepEqual(meta.tables.items!.indexes.find((index) => index.name === 'by_lower_name')!.columns, []);
    });
    const objects = rows(f.file, "SELECT name,sql FROM sqlite_schema WHERE name='by_lower_name'");
    pushSqliteSchema(items({ type: 'text', notNull: true }), f.file);
    assert.deepEqual(rows(f.file, "SELECT name,sql FROM sqlite_schema WHERE name='by_lower_name'"), objects);
    db(f.file, (c) => {
      assert.throws(() => c.exec("INSERT INTO items(name) VALUES('ONE')"), /UNIQUE/);
      c.exec(
        'CREATE TABLE computed(id INTEGER PRIMARY KEY, amount INTEGER, doubled INTEGER GENERATED ALWAYS AS (amount * 2) STORED); INSERT INTO computed(amount) VALUES(4)',
      );
      assert.equal(
        introspectSqliteDatabase(c, { logger: {} }).tables.computed!.columns.find((c) => c.name === 'doubled')!
          .isGeneratedStored,
        true,
      );
    });
    const target = defineSchema({
      computed: {
        id: { type: 'integer', primaryKey: true },
        amount: { type: 'integer', notNull: true },
        doubled: { type: 'integer' },
      },
    });
    unchanged(f.file, () => pushSqliteSchema(target, f.file), /generated or named column constraint/);
    assert.deepEqual(rows(f.file, 'SELECT amount,doubled FROM computed'), [{ amount: 4, doubled: 8 }]);
  });

  it('preserves inline UNIQUE and named table CHECK constraints through a rebuild', (t) => {
    const f = fixture(t);
    const schema = (required: boolean) =>
      defineSchema({
        items: {
          id: { type: 'integer', primaryKey: true },
          name: { type: 'text', unique: true, notNull: required },
          checks: [{ name: 'not_empty', expression: "name != ''" }],
        },
      });
    pushSqliteSchema(schema(false), f.file);
    db(f.file, (c) => c.exec("INSERT INTO items VALUES(1,'only')"));
    pushSqliteSchema(schema(true), f.file);
    assert.equal(planSqliteSchema(schema(true), f.file).steps.length, 0);
    db(f.file, (c) => {
      assert.throws(() => c.exec("INSERT INTO items VALUES(2,'only')"), /UNIQUE/);
      assert.throws(() => c.exec("INSERT INTO items VALUES(2,'')"), /not_empty/);
    });
    assert.deepEqual(rows(f.file, 'SELECT * FROM items'), [{ id: 1, name: 'only' }]);
  });

  it('preserves non-key hidden rowids, blobs and 64-bit integers without JS conversion', (t) => {
    const f = fixture(t);
    const initial = defineSchema({
      notes: { value: { type: 'text' }, bytes: { type: 'bytea' }, large: { type: 'integer' } },
    });
    pushSqliteSchema(initial, f.file);
    db(f.file, (c) => c.exec("INSERT INTO notes(rowid,value,bytes,large) VALUES(67,'a',X'00ff',9223372036854775806)"));
    const target = defineSchema({
      notes: { value: { type: 'text', notNull: true }, bytes: { type: 'bytea' }, large: { type: 'integer' } },
    });
    pushSqliteSchema(target, f.file);
    assert.deepEqual(rows(f.file, 'SELECT rowid,value,hex(bytes) AS bytes,CAST(large AS TEXT) AS large FROM notes'), [
      { rowid: 67, value: 'a', bytes: '00FF', large: '9223372036854775806' },
    ]);
  });

  it('rebuilds empty AUTOINCREMENT tables without reusing deleted keys and ignores keyword literals', (t) => {
    const f = fixture(t);
    pushSqliteSchema(items(), f.file);
    db(f.file, (c) => c.exec("INSERT INTO items(id,name) VALUES(90,'deleted'); DELETE FROM items"));
    pushSqliteSchema(items({ type: 'text', default: "'new'" }), f.file);
    db(f.file, (c) => c.exec('INSERT INTO items DEFAULT VALUES'));
    assert.deepEqual(rows(f.file, 'SELECT id,name FROM items'), [{ id: 91, name: 'new' }]);
    const g = join(f.dir, 'ordinary.sqlite');
    const schema = (required: boolean) =>
      defineSchema({ notes: { value: { type: 'text', notNull: required, default: "'AUTOINCREMENT'" } } });
    pushSqliteSchema(schema(false), g);
    db(g, (c) => c.exec('INSERT INTO notes DEFAULT VALUES'));
    const plan = planSqliteSchema(schema(true), g);
    assert.equal(plan.changes[0]!.kind, 'rebuild');
    assert.equal(
      plan.steps.some((step) => step.sql.includes('sqlite_sequence')),
      false,
    );
    pushSqliteSchema(schema(true), g);
    assert.deepEqual(rows(g, 'SELECT value FROM notes'), [{ value: 'AUTOINCREMENT' }]);
  });

  it('adds a clock-default column by rebuilding, with existing values retained', (t) => {
    const f = fixture(t);
    pushSqliteSchema(items(), f.file);
    db(f.file, (c) => c.exec("INSERT INTO items(name) VALUES('before')"));
    const target = items({ type: 'text' }, { createdAt: { type: 'timestamp', default: 'now()', notNull: true } });
    assert.equal(planSqliteSchema(target, f.file).changes[0]!.kind, 'rebuild');
    pushSqliteSchema(target, f.file);
    const result = rows(f.file, 'SELECT name,created_at FROM items');
    assert.equal(result.length, 1);
    assert.equal(result[0]!.name, 'before');
    assert.match(String(result[0]!.created_at), /^\d{4}-\d\d-\d\d /);
  });

  it('refuses index collisions and preexisting foreign-key violations with no partial DDL', (t) => {
    const f = fixture(t);
    pushSqliteSchema(items(), f.file);
    db(f.file, (c) => c.exec('CREATE INDEX declared ON items(id)'));
    const target = defineSchema({
      items: {
        id: { type: 'serial', primaryKey: true },
        name: { type: 'text' },
        extra: { type: 'text' },
        indexes: [{ name: 'declared', columns: ['name'] }],
      },
    });
    unchanged(f.file, () => pushSqliteSchema(target, f.file), /index definition collision/);
    db(f.file, (c) =>
      c.exec(
        'PRAGMA foreign_keys=OFF; CREATE TABLE bad(parent_id INTEGER REFERENCES items(id)); INSERT INTO bad VALUES(99)',
      ),
    );
    unchanged(
      f.file,
      () => pushSqliteSchema(items({ type: 'text' }, { extra: { type: 'text' } }), f.file),
      /already contains foreign key violations/,
    );
  });

  it('keeps outgoing cascading references and dependency indexes through a child rebuild', (t) => {
    const f = fixture(t);
    const schema = (required: boolean) =>
      defineSchema({
        parents: { id: { type: 'integer', primaryKey: true } },
        children: {
          id: { type: 'integer', primaryKey: true },
          parentId: { type: 'integer', references: { target: 'parents.id', onDelete: 'cascade' } },
          value: { type: 'text', notNull: required },
        },
      });
    pushSqliteSchema(schema(false), f.file);
    db(f.file, (c) => c.exec("INSERT INTO parents VALUES(1); INSERT INTO children VALUES(3,1,'ok')"));
    pushSqliteSchema(schema(true), f.file);
    db(f.file, (c) => {
      assert.throws(() => c.exec("INSERT INTO children VALUES(4,9,'bad')"), /FOREIGN KEY/);
      c.exec('DELETE FROM parents WHERE id=1');
    });
    assert.deepEqual(rows(f.file, 'SELECT * FROM children'), []);
    assert.equal(planSqliteSchema(schema(true), f.file).steps.length, 0);
  });

  it('refuses parent and self-reference rebuilds before any effects, even with cascading edges', (t) => {
    const f = fixture(t);
    pushSqliteSchema(items(), f.file);
    db(f.file, (c) =>
      c.exec(
        "INSERT INTO items(name) VALUES('kept'); CREATE TABLE child(id INTEGER REFERENCES items(id) ON DELETE CASCADE); INSERT INTO child VALUES(1)",
      ),
    );
    unchanged(f.file, () => pushSqliteSchema(items({ type: 'text', notNull: true }), f.file), /inbound foreign keys/);
    assert.equal(rows(f.file, 'SELECT count(*) AS n FROM child')[0]!.n, 1);
    const self = defineSchema({
      tree: {
        id: { type: 'integer', primaryKey: true },
        parentId: { type: 'integer', references: 'tree.id' },
        value: { type: 'text' },
      },
    });
    const g = join(f.dir, 'self.sqlite');
    pushSqliteSchema(self, g);
    const next = defineSchema({
      tree: {
        id: { type: 'integer', primaryKey: true },
        parentId: { type: 'integer', references: 'tree.id' },
        value: { type: 'text', default: "'x'" },
      },
    });
    unchanged(g, () => pushSqliteSchema(next, g), /inbound foreign keys/);
  });

  it('refuses null data, removals, type changes and constraint changes with byte-identical controls', (t) => {
    const f = fixture(t);
    pushSqliteSchema(items(), f.file);
    db(f.file, (c) => c.exec('INSERT INTO items(name) VALUES(NULL)'));
    for (const [schema, pattern] of [
      [items({ type: 'text', notNull: true }), /NULL rows/],
      [defineSchema({ items: { id: { type: 'serial', primaryKey: true } } }), /removal or rename/],
      [items({ type: 'integer' }), /type, key/],
      [items({ type: 'text', unique: true }), /type, key/],
      [items({ type: 'text' }, { required: { type: 'text', notNull: true } }), /no non-NULL default/],
    ] as const)
      unchanged(f.file, () => pushSqliteSchema(schema, f.file), pattern);
  });

  it('rolls back prior DDL and rebuilt rows when a later unique index fails, then recovers', (t) => {
    const f = fixture(t);
    pushSqliteSchema(items(), f.file);
    db(f.file, (c) => c.exec("INSERT INTO items(name) VALUES('same'),('same')"));
    const target = defineSchema({
      items: {
        id: { type: 'serial', primaryKey: true },
        name: { type: 'text', notNull: true },
        indexes: [{ name: 'unique_name', columns: ['name'], unique: true }],
      },
    });
    const before = readFileSync(f.file);
    assert.throws(() => pushSqliteSchema(target, f.file), /UNIQUE/);
    assert.deepEqual(readFileSync(f.file), before);
    assert.deepEqual(rows(f.file, 'SELECT id,name FROM items'), [
      { id: 1, name: 'same' },
      { id: 2, name: 'same' },
    ]);
    assert.equal(rows(f.file, "SELECT count(*) AS n FROM sqlite_schema WHERE name LIKE '_turbine_rebuild_%'")[0]!.n, 0);
    db(f.file, (c) => c.exec("UPDATE items SET name='other' WHERE id=2"));
    pushSqliteSchema(target, f.file);
    db(f.file, (c) => assert.throws(() => c.exec("INSERT INTO items(name) VALUES('other')"), /UNIQUE/));
  });

  it('refuses stale displayed plans and native writer contention without applying additions', (t) => {
    const f = fixture(t);
    pushSqliteSchema(items(), f.file);
    const target = items({ type: 'text' }, { more: { type: 'text' } });
    const plan = planSqliteSchema(target, f.file);
    db(f.file, (c) => c.exec('CREATE TABLE concurrent(id INTEGER)'));
    unchanged(f.file, () => pushSqliteSchema(target, f.file, { expectedPlan: plan }), /stale/);
    db(f.file, (c) => {
      c.exec('BEGIN IMMEDIATE');
      assert.throws(() => pushSqliteSchema(target, f.file), /migration lock/);
      c.exec('ROLLBACK');
    });
    pushSqliteSchema(target, f.file);
    assert.equal(planSqliteSchema(target, f.file).steps.length, 0);
  });

  it('keeps native history checksums/status and its sequence unchanged across pushes', async (t) => {
    const f = fixture(t);
    const migrations = join(f.dir, 'migrations');
    mkdirSync(migrations);
    writeFileSync(
      join(migrations, '20260101000000_create.sql'),
      '-- UP\nCREATE TABLE items(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT);\n-- DOWN\nDROP TABLE items;',
    );
    const result = await migrateSqliteDeploy(f.file, migrations);
    assert.equal(result.applied.length, 1);
    const before = rows(f.file, 'SELECT * FROM _turbine_migrations');
    pushSqliteSchema(items({ type: 'text', default: "'after'" }), f.file);
    assert.deepEqual(rows(f.file, 'SELECT * FROM _turbine_migrations'), before);
    const statuses = await migrateSqliteStatus(f.file, migrations);
    assert.equal(statuses.length, 1);
    assert.equal(statuses[0]!.checksumValid, true);
    assert.equal((await migrateSqliteDeploy(f.file, migrations)).applied.length, 0);
  });

  it('guards native transaction control and history, with real prior DDL rolled back', async (t) => {
    const f = fixture(t);
    const migrations = join(f.dir, 'migrations');
    mkdirSync(migrations);
    writeFileSync(
      join(migrations, '20260101000000_create.sql'),
      '-- UP\nCREATE TABLE items(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT);\n-- DOWN\nDROP TABLE items;',
    );
    await migrateSqliteDeploy(f.file, migrations);
    for (const sql of [
      "UPDATE _turbine_migrations SET checksum='wrong'",
      'COMMIT',
      'PRAGMA foreign_keys=OFF',
      'PRAGMA writable_schema=ON',
    ]) {
      unchanged(
        f.file,
        () =>
          withSqliteSchemaTransaction(f.file, (c) => {
            c.exec('CREATE TABLE must_rollback(id INTEGER)');
            c.exec(sql);
          }),
        /must not change transaction ownership/,
      );
      assert.equal(rows(f.file, "SELECT count(*) AS n FROM sqlite_schema WHERE name='must_rollback'")[0]!.n, 0);
    }
    const statuses = await migrateSqliteStatus(f.file, migrations);
    assert.equal(statuses[0]!.checksumValid, true);
  });

  it('recovers from process death after copying replacement rows, then can rebuild again', (t) => {
    const f = fixture(t);
    pushSqliteSchema(items(), f.file);
    db(f.file, (c) => c.exec("INSERT INTO items(id,name) VALUES(80,'alive')"));
    const source = `
      import { createRequire } from 'node:module';
      import { writeFileSync } from 'node:fs';
      import { pushSqliteSchema } from ${JSON.stringify(new URL('../cli/sqlite-schema.ts', import.meta.url).href)};
      import { defineSchema } from ${JSON.stringify(new URL('../schema-builder.ts', import.meta.url).href)};
      const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
      const original = DatabaseSync.prototype.prepare;
      DatabaseSync.prototype.prepare = function(sql) {
        if (sql.startsWith('DROP TABLE main.')) {
          const n = original.call(this, "SELECT count(*) AS n FROM sqlite_schema WHERE name LIKE '_turbine_rebuild_%'").get().n;
          if (n !== 1) throw new Error('replacement was not created');
          writeFileSync(${JSON.stringify(join(f.dir, 'copied'))}, String(n));
          process.kill(process.pid, 'SIGKILL');
        }
        return original.call(this, sql);
      };
      pushSqliteSchema(defineSchema({items:{id:{type:'serial',primaryKey:true},name:{type:'text',notNull:true}}}), ${JSON.stringify(f.file)});
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
    assert.equal(readFileSync(join(f.dir, 'copied'), 'utf8'), '1');
    assert.deepEqual(rows(f.file, 'SELECT id,name FROM items'), [{ id: 80, name: 'alive' }]);
    assert.equal(rows(f.file, "SELECT count(*) AS n FROM sqlite_schema WHERE name LIKE '_turbine_rebuild_%'")[0]!.n, 0);
    pushSqliteSchema(items({ type: 'text', notNull: true }), f.file);
    db(f.file, (c) => assert.throws(() => c.exec('INSERT INTO items(name) VALUES(NULL)'), /NOT NULL/));
  });

  it('preserves existing STRICT mode and refuses opaque dependencies and invalid target DDL', (t) => {
    const f = fixture(t);
    db(f.file, (c) => c.exec('CREATE TABLE items(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT) STRICT'));
    assert.equal(planSqliteSchema(items(), f.file).steps.length, 0);
    pushSqliteSchema(items({ type: 'text', default: "'kept'" }), f.file);
    assert.equal(rows(f.file, "SELECT strict FROM pragma_table_list WHERE name='items'")[0]!.strict, 1);
    const g = join(f.dir, 'view.sqlite');
    pushSqliteSchema(items(), g);
    db(g, (c) => c.exec('CREATE VIEW names AS SELECT name FROM items'));
    unchanged(g, () => pushSqliteSchema(items({ type: 'text', default: "'x'" }), g), /opaque/);
    const bad = items({ type: 'text', check: 'unknown_function(name)' });
    unchanged(g, () => pushSqliteSchema(bad, g), /cannot be represented/);
    const suffix = items({ type: 'text', check: '1); CREATE TABLE injected(id INTEGER); --' });
    unchanged(g, () => pushSqliteSchema(suffix, g), /multiple statements|table suffix|cannot be represented/);
  });
});
