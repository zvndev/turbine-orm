import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import type { DatabaseSync as NativeDatabase } from 'node:sqlite';
import { describe } from 'node:test';
import { ValidationError } from '../errors.js';
import type { SchemaMetadata } from '../schema.js';
import { introspectSqliteDatabase, turbineSqlite } from '../sqlite.js';
import { skipGate } from './helpers.js';

const DatabaseSync: (new (path: string) => NativeDatabase) | undefined = (() => {
  try {
    return createRequire(import.meta.url)('node:sqlite').DatabaseSync;
  } catch {
    return undefined;
  }
})();
const { it } = skipGate(!DatabaseSync, 'node:sqlite unavailable');

function fixture(keyed = false) {
  assert.ok(DatabaseSync);
  const db = new DatabaseSync(':memory:');
  let effects = 0;
  db.function('record_effect', () => {
    effects++;
    return 0;
  });
  db.exec(`
    CREATE TABLE records (id INTEGER PRIMARY KEY, label TEXT NOT NULL, source_id INTEGER REFERENCES records(id));
    INSERT INTO records (id, label) VALUES (1, 'original');
    CREATE VIEW record_views AS SELECT id, label, source_id FROM records;
    CREATE TRIGGER records_effect AFTER INSERT ON records BEGIN SELECT record_effect(); END;
    CREATE TRIGGER writable_view INSTEAD OF INSERT ON record_views BEGIN
      INSERT INTO records (label, source_id) VALUES (NEW.label, NEW.source_id);
    END;
  `);
  const schema = introspectSqliteDatabase(db, { logger: {} });
  const base = schema.tables.records!;
  base.relations = {
    sourceRecord: {
      name: 'sourceRecord',
      type: 'belongsTo',
      from: 'records',
      to: 'records',
      foreignKey: 'source_id',
      referenceKey: 'id',
    },
  };
  const declared: SchemaMetadata = {
    ...schema,
    tables: {
      records: base,
      record_views: {
        ...base,
        name: 'record_views',
        isView: true,
        primaryKey: keyed ? ['id'] : [],
        uniqueColumns: keyed ? [['id']] : [],
        indexes: [],
        relations: {
          sourceRecord: { ...base.relations.sourceRecord!, from: 'record_views' },
        },
      },
    },
  };
  const client = turbineSqlite(db, declared, { wal: false, logger: {} });
  const prepare = db.prepare.bind(db);
  const exec = db.exec.bind(db);
  const sql: string[] = [];
  db.prepare = (text: string) => {
    sql.push(text);
    return prepare(text);
  };
  db.exec = (text: string) => {
    sql.push(text);
    exec(text);
  };
  return {
    db,
    client,
    sql,
    get effects() {
      return effects;
    },
    rows: () => prepare('SELECT id, label, source_id FROM records ORDER BY id').all(),
    async close() {
      await client.disconnect();
      db.close();
    },
  };
}

function isViewError(error: unknown) {
  assert.ok(error instanceof ValidationError);
  assert.equal(error.code, 'TURBINE_E003');
  assert.match(error.message, /record_views.*view \(read-only\)/);
  return true;
}

describe('view writes refuse before nested work', () => {
  for (const operation of ['create', 'update', 'upsert-create', 'upsert-empty-update'] as const) {
    it(`${operation} refuses before transaction, lookup, related SQL or trigger effects`, async () => {
      const fx = fixture(operation.startsWith('upsert'));
      try {
        const before = fx.rows();
        const view = fx.client.table('record_views');
        const child = { sourceRecord: { create: { label: 'nested child' } } };
        const run = () => {
          if (operation === 'create') return view.create({ data: { label: 'view parent', ...child } });
          if (operation === 'update') return view.update({ where: { id: 1 }, data: child });
          return view.upsert({
            where: { id: operation === 'upsert-empty-update' ? 1 : 999 },
            create: child,
            update: {},
          });
        };
        await assert.rejects(run, isViewError);
        assert.deepEqual(fx.sql, [], 'not even BEGIN or a read may precede refusal');
        assert.equal(fx.effects, 0, 'rollback cannot undo a JavaScript trigger effect');
        assert.deepEqual(fx.rows(), before);
      } finally {
        await fx.close();
      }
    });
  }

  it('a caller transaction stays usable after the nested view refusal', async () => {
    const fx = fixture();
    try {
      await fx.client.$transaction(async (tx) => {
        fx.sql.length = 0;
        await assert.rejects(
          tx.table('record_views').create({
            data: { label: 'view parent', sourceRecord: { create: { label: 'nested child' } } },
          }),
          isViewError,
        );
        assert.deepEqual(fx.sql, ['SAVEPOINT sp_1', 'ROLLBACK TO SAVEPOINT sp_1']);
        assert.equal(fx.effects, 0);
        assert.equal((await tx.table('records').findUnique({ where: { id: 1 } }))?.label, 'original');
      });
    } finally {
      await fx.close();
    }
  });

  it('ordinary table nested create/update/upsert still perform their real writes', async () => {
    const fx = fixture();
    try {
      const records = fx.client.table('records');
      const parent = await records.create({
        data: { label: 'parent', sourceRecord: { create: { label: 'child' } } },
      });
      assert.equal(parent.label, 'parent');
      const updated = await records.update({
        where: { id: parent.id },
        data: { sourceRecord: { create: { label: 'new child' } } },
      });
      assert.notEqual(updated.sourceId, parent.sourceId);
      const made = await records.upsert({
        where: { id: 50 },
        create: { id: 50, label: 'upsert parent', sourceRecord: { create: { label: 'upsert child' } } },
        update: {},
      });
      assert.equal(made.id, 50);
      assert.equal(fx.effects, 5);
      assert.equal(fx.rows().length, 6);
      assert.ok(fx.sql.some((sql) => /INSERT INTO "records"/.test(sql)));
    } finally {
      await fx.close();
    }
  });

  it('middleware still observes the attempted write and the exact view refusal', async () => {
    const fx = fixture();
    const seen: string[] = [];
    try {
      fx.client.$use(async (params, next) => {
        seen.push(`${params.model}.${params.action}`);
        try {
          return await next(params);
        } catch (error) {
          assert.ok(error instanceof ValidationError);
          seen.push(error.code);
          throw error;
        }
      });
      await assert.rejects(
        fx.client.table('record_views').create({
          data: { label: 'view parent', sourceRecord: { create: { label: 'nested child' } } },
        }),
        isViewError,
      );
      assert.deepEqual(seen, ['record_views.create', 'TURBINE_E003']);
      assert.deepEqual(fx.sql, []);
      assert.equal(fx.effects, 0);
    } finally {
      await fx.close();
    }
  });

  it('the real view is writable natively through its trigger', async () => {
    const fx = fixture();
    try {
      fx.db.prepare('INSERT INTO record_views (label) VALUES (?)').run('native view write');
      assert.equal(fx.effects, 1);
      assert.equal(fx.rows().length, 2);
    } finally {
      await fx.close();
    }
  });
});
