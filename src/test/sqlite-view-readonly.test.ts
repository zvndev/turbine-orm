import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync as NativeDatabase } from 'node:sqlite';
import { ValidationError } from '../errors.js';
import { introspect } from '../introspect.js';
import type { SchemaMetadata } from '../schema.js';
import { introspectSqlite, introspectSqliteDatabase, sqliteDialect, turbineSqlite } from '../sqlite.js';
import { skipGate } from './helpers.js';

const DatabaseSync: typeof NativeDatabase | undefined = (() => {
  try {
    return createRequire(import.meta.url)('node:sqlite').DatabaseSync;
  } catch {
    return undefined;
  }
})();
const { it } = skipGate(!DatabaseSync, 'SQLite views require node:sqlite (Node >= 22.5)');
const fixture = readFileSync(new URL('./fixtures/sqlite-view-readonly.sql', import.meta.url), 'utf8');
const views = ['computed_views', 'nested_views', 'quoted"view', 'record_views'];

it('includes only main views on request and preserves table facts without inferred view keys', () => {
  const db = new DatabaseSync!(':memory:');
  try {
    db.exec(fixture);
    db.exec(
      "CREATE TEMP VIEW temp_only AS SELECT 1; ATTACH ':memory:' AS extra; CREATE VIEW extra.attached_only AS SELECT 2",
    );
    const tables = introspectSqliteDatabase(db, { logger: {} });
    assert.deepEqual(introspectSqliteDatabase(db, { includeViews: false, logger: {} }), tables);
    const schema = introspectSqliteDatabase(db, { includeViews: true, logger: {} });
    assert.deepEqual(Object.keys(schema.tables), [...Object.keys(tables.tables), ...views].sort());
    for (const [name, table] of Object.entries(tables.tables)) {
      assert.deepEqual(schema.tables[name], table, name);
      assert.equal(Object.hasOwn(table, 'isView'), false);
    }
    for (const name of views) {
      const view = schema.tables[name]!;
      assert.equal(view.isView, true, name);
      assert.deepEqual(view.primaryKey, []);
      assert.deepEqual(view.uniqueColumns, []);
      assert.deepEqual(view.indexes, []);
      assert.deepEqual(Object.keys(view.relations), []);
    }
    const computed = schema.tables.computed_views!.columns;
    assert.deepEqual(
      computed.map((c) => [c.name, c.tsType, c.nullable]),
      [
        ['id', 'number | null', true],
        ['display_name', 'unknown | null', true],
        ['doubled', 'unknown | null', true],
        ['absent', 'unknown | null', true],
      ],
    );
    assert.deepEqual(schema.tables['quoted"view']!.allColumns, ['quoted"column', 'label']);
    assert.deepEqual(Object.keys(introspectSqliteDatabase(db, { include: ['record_views'] }).tables), []);
    assert.deepEqual(
      Object.keys(
        introspectSqliteDatabase(db, {
          includeViews: true,
          include: ['record_views', 'nested_views'],
          exclude: ['nested_views'],
        }).tables,
      ),
      ['record_views'],
    );
    assert.deepEqual(
      Object.keys(
        introspectSqliteDatabase(db, { includeViews: true, include: ['record_views', 'search_docs_data'] }).tables,
      ),
      ['record_views', 'search_docs_data'],
    );
  } finally {
    db.close();
  }
});

it('retains the exact table-only catalog statement and query order when views are off', () => {
  const db = new DatabaseSync!(':memory:');
  try {
    db.exec(fixture);
    const trace: string[] = [];
    const prepare = db.prepare.bind(db);
    db.prepare = ((sql: string) => {
      trace.push(sql);
      return prepare(sql);
    }) as typeof db.prepare;
    const omitted = introspectSqliteDatabase(db, { logger: {} });
    const original = [...trace];
    trace.length = 0;
    const explicit = introspectSqliteDatabase(db, { includeViews: false, logger: {} });
    assert.deepEqual(explicit, omitted);
    assert.deepEqual(trace, original);
    assert.equal(
      trace[0],
      "SELECT name, sql FROM main.sqlite_master WHERE type = 'table' AND substr(name, 1, 7) <> 'sqlite_' ORDER BY name",
    );
    assert.equal(trace.filter((q) => q === 'PRAGMA main.table_list').length, 1);
    assert.equal(
      trace.some((q) => /table_xinfo\("record_views"\)/.test(q)),
      false,
    );
  } finally {
    db.close();
  }
});

it('routes the existing option through file and root introspection', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sqlite-view-routes-'));
  const path = join(dir, 'native.sqlite');
  const db = new DatabaseSync!(path);
  try {
    db.exec(fixture);
    const expected = introspectSqliteDatabase(db, { includeViews: true, logger: {} });
    assert.deepEqual(await introspectSqlite({ connectionString: path, includeViews: true, logger: {} }), expected);
    assert.deepEqual(
      await introspect({ connectionString: path, dialect: sqliteDialect, includeViews: true, logger: {} }),
      expected,
    );
    assert.equal(
      (await introspect({ connectionString: path, dialect: sqliteDialect, logger: {} })).tables.record_views,
      undefined,
    );
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM record_views').get()!.n, 1);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

it('reads native view values and refuses writes before preparing SQL despite INSTEAD OF triggers', async () => {
  const db = new DatabaseSync!(':memory:');
  db.exec(fixture);
  db.exec(`CREATE TRIGGER view_insert INSTEAD OF INSERT ON record_views BEGIN INSERT INTO records(id,label) VALUES(NEW.id,NEW.label); END;
CREATE TRIGGER view_update INSTEAD OF UPDATE ON record_views BEGIN UPDATE records SET label=NEW.label WHERE id=OLD.id; END;
CREATE TRIGGER view_delete INSTEAD OF DELETE ON record_views BEGIN DELETE FROM records WHERE id=OLD.id; END;`);
  db.exec("INSERT INTO record_views(id,label) VALUES(2,'native'); UPDATE record_views SET label='updated' WHERE id=2");
  assert.equal(db.prepare('SELECT label FROM records WHERE id=2').get()!.label, 'updated');
  db.exec('DELETE FROM record_views WHERE id=2');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM records').get()!.n, 1);
  const schema = introspectSqliteDatabase(db, { includeViews: true, logger: {} });
  const client = turbineSqlite(db, schema, { wal: false });
  try {
    const expected = [
      {
        id: 1,
        label: 'alpha',
        active: true,
        payload: { nested: [true, null] },
        createdAt: new Date('2025-02-03T04:05:06.789Z'),
        amount: 1.2345678901234567,
        bytes: new Uint8Array([0, 255, 128]),
        optionalText: null,
      },
    ];
    for (const name of ['record_views', 'nested_views']) {
      assert.deepEqual(await client.table(name).findMany({ orderBy: { id: 'asc' } }), expected);
    }
    assert.deepEqual(await client.table('computed_views').findMany(), [
      { id: 1, displayName: 'alpha-computed', doubled: 2.4691357802469134, absent: null },
    ]);
    assert.deepEqual(await client.table('quoted"view').findMany(), [{ 'quoted"column': 1, label: 'alpha' }]);
    const view = client.table('record_views');
    const trace: string[] = [];
    const prepare = db.prepare.bind(db);
    db.prepare = ((sql: string) => {
      trace.push(sql);
      return prepare(sql);
    }) as typeof db.prepare;
    const writes = [
      () => view.create({ data: { id: 2, label: 'orm' } }),
      () => view.createMany({ data: [{ id: 2, label: 'orm' }] }),
      () => view.update({ where: { id: 1 }, data: { label: 'orm' } }),
      () => view.updateMany({ where: { id: 1 }, data: { label: 'orm' } }),
      () => view.upsert({ where: { id: 1 }, create: { label: 'orm' }, update: { label: 'orm' } }),
      () => view.upsert({ where: { id: 1 }, create: { id: 1, label: 'orm' }, update: { label: 'orm' } }),
      () => view.delete({ where: { id: 1 } }),
      () => view.deleteMany({ where: { id: 1 } }),
    ];
    for (const write of writes) {
      await assert.rejects(
        async () => write(),
        (error: unknown) => {
          assert.equal((error as { code: string }).code, 'TURBINE_E003');
          assert.ok(error instanceof ValidationError);
          assert.match(error.message, /record_views.*view \(read-only\)/);
          return true;
        },
      );
    }
    assert.deepEqual(trace, []);
    db.prepare = prepare;
    assert.equal(db.prepare('SELECT label FROM records WHERE id=1').get()!.label, 'alpha');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM records').get()!.n, 1);
    const created = await client.table('records').create({ data: { label: 'table remains writable' } });
    assert.equal(created.label, 'table remains writable');
  } finally {
    await client.disconnect();
    assert.equal(db.prepare('SELECT 1 AS n').get()!.n, 1);
    db.close();
  }
});

it('refuses native keyless root-view nested writes before SQL and trigger effects', async () => {
  const db = new DatabaseSync!(':memory:');
  db.exec(fixture);
  let effects = 0;
  db.function('record_effect', () => {
    effects++;
    return 0;
  });
  db.exec(`CREATE TRIGGER record_effects AFTER INSERT ON records BEGIN SELECT record_effect(); END;
CREATE TRIGGER view_insert INSTEAD OF INSERT ON record_views BEGIN INSERT INTO records(id,label) VALUES(NEW.id,NEW.label); END;`);
  const schema = introspectSqliteDatabase(db, { includeViews: true, logger: {} });
  assert.deepEqual(schema.tables.record_views!.primaryKey, []);
  assert.deepEqual(schema.tables.record_views!.uniqueColumns, []);
  assert.deepEqual(Object.keys(schema.tables.record_views!.relations), []);
  assert.equal(Object.getPrototypeOf(schema.tables.record_views!.relations), null);
  const declared: SchemaMetadata = {
    ...schema,
    tables: {
      ...schema.tables,
      record_views: {
        ...schema.tables.record_views!,
        relations: {
          sourceRecord: {
            name: 'sourceRecord',
            type: 'belongsTo',
            from: 'record_views',
            to: 'records',
            foreignKey: 'id',
            referenceKey: 'id',
          },
        },
      },
    },
  };
  const client = turbineSqlite(db, declared, { wal: false, logger: {} });
  const prepare = db.prepare.bind(db);
  const exec = db.exec.bind(db);
  const rows = () => prepare('SELECT * FROM records ORDER BY id').all();
  const trace: string[] = [];
  const isViewError = (error: unknown) => {
    assert.ok(error instanceof ValidationError);
    assert.equal(error.code, 'TURBINE_E003');
    assert.match(error.message, /record_views.*view \(read-only\)/);
    return true;
  };
  try {
    // A real native trigger proves that unchanged rows after rollback cannot establish no effects.
    db.prepare("INSERT INTO record_views(id,label) VALUES(2,'native')").run();
    assert.equal(effects, 1);
    db.exec('DELETE FROM records WHERE id=2');
    effects = 0;
    db.prepare = (sql: string) => {
      trace.push(sql);
      return prepare(sql);
    };
    db.exec = (sql: string) => {
      trace.push(sql);
      exec(sql);
    };
    const child = { sourceRecord: { create: { label: 'nested base' } } };
    const view = client.table('record_views');
    const operations = [
      () => view.create({ data: { label: 'nested view', ...child } }),
      () => view.update({ where: { id: 1 }, data: child }),
      () => view.upsert({ where: { id: 999 }, create: child, update: {} }),
      () => view.upsert({ where: { id: 1 }, create: { id: 1, ...child }, update: child }),
    ];
    for (const operation of operations) {
      const before = rows();
      trace.length = 0;
      await assert.rejects(operation, isViewError);
      assert.deepEqual(trace, [], 'root view must refuse before BEGIN, lookup, prepare or exec');
      assert.equal(effects, 0, 'rollback cannot undo JavaScript trigger effects');
      assert.deepEqual(rows(), before);
    }
    await client.$transaction(async (tx) => {
      const before = rows();
      trace.length = 0;
      await assert.rejects(tx.table('record_views').create({ data: { label: 'nested view', ...child } }), isViewError);
      assert.deepEqual(trace, ['SAVEPOINT sp_1', 'ROLLBACK TO SAVEPOINT sp_1']);
      assert.equal(effects, 0);
      assert.deepEqual(rows(), before);
      assert.equal((await tx.table('records').findUnique({ where: { id: 1 } }))!.label, 'alpha');
    });
    const table = client.table('records');
    const created = await table.create({ data: { label: 'ordinary create' } });
    assert.equal(created.label, 'ordinary create');
    assert.equal(
      (await table.update({ where: { id: created.id }, data: { label: 'ordinary update' } })).label,
      'ordinary update',
    );
    assert.equal(
      (
        await table.upsert({
          where: { id: created.id },
          create: { id: created.id, label: 'ordinary create' },
          update: { label: 'ordinary upsert' },
        })
      ).label,
      'ordinary upsert',
    );
    assert.equal(effects, 1);
  } finally {
    db.prepare = prepare;
    db.exec = exec;
    await client.disconnect();
    assert.equal(db.prepare('SELECT 1 AS n').get()!.n, 1);
    db.close();
  }
});
