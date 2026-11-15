import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import type { DatabaseSync as NativeDatabase } from 'node:sqlite';
import { applyTableFilters } from '../catalog-metadata.js';
import { introspectSqliteDatabase } from '../sqlite.js';
import { skipGate } from './helpers.js';

const DatabaseSync: typeof NativeDatabase | undefined = (() => {
  try {
    return createRequire(import.meta.url)('node:sqlite').DatabaseSync;
  } catch {
    return undefined;
  }
})();
const { it } = skipGate(!DatabaseSync, 'requires node:sqlite with native FTS5');
const ordinary = ['Mixed_data', '_records_idx', 'ordinary_config', 'sqliteλ_docsize'];

function fixture() {
  const db = new DatabaseSync!(':memory:');
  db.exec("CREATE VIRTUAL TABLE search_docs USING fts5(title, body); INSERT INTO search_docs VALUES('alpha', 'λ');");
  for (const name of ordinary) db.exec(`CREATE TABLE "${name}"(id INTEGER PRIMARY KEY, value TEXT)`);
  return db;
}

it('excludes native shadows by default while retaining virtual and shadow-like ordinary tables', () => {
  const db = fixture();
  try {
    const rows = db.prepare('PRAGMA main.table_list').all();
    assert.equal(rows.filter((row) => row.type === 'shadow').length, 5);
    assert.equal(rows.find((row) => row.name === 'search_docs')!.type, 'virtual');
    for (const name of ordinary) assert.equal(rows.find((row) => row.name === name)!.type, 'table');
    assert.deepEqual(Object.keys(introspectSqliteDatabase(db).tables), [...ordinary, 'search_docs'].sort());
  } finally {
    db.close();
  }
});

it('restores selected native shadows via include and gives explicit exclude precedence', () => {
  const db = fixture();
  try {
    const restored = introspectSqliteDatabase(db, { include: ['search_docs_data', 'search_docs'] });
    assert.deepEqual(Object.keys(restored.tables), ['search_docs', 'search_docs_data']);
    assert.deepEqual(restored.tables.search_docs_data!.allColumns, ['id', 'block']);
    assert.deepEqual(
      Object.keys(
        introspectSqliteDatabase(db, { include: ['search_docs_data', 'search_docs'], exclude: ['search_docs_data'] })
          .tables,
      ),
      ['search_docs'],
    );
  } finally {
    db.close();
  }
});

it('does not infer shadow ownership from names when native classification is missing or unknown', () => {
  for (const classification of [undefined, 'unknown']) {
    const db = fixture();
    const prepare = db.prepare.bind(db);
    db.prepare = ((sql: string) => {
      const statement = prepare(sql);
      if (sql === 'PRAGMA main.table_list') {
        const all = statement.all.bind(statement);
        statement.all = () =>
          all().map((row) => {
            const result = { ...row };
            if (classification === undefined) delete result.type;
            else result.type = classification;
            return result;
          });
      }
      return statement;
    }) as typeof db.prepare;
    try {
      assert.deepEqual(
        Object.keys(introspectSqliteDatabase(db).tables),
        [
          ...ordinary,
          'search_docs',
          'search_docs_config',
          'search_docs_content',
          'search_docs_data',
          'search_docs_docsize',
          'search_docs_idx',
        ].sort(),
      );
    } finally {
      db.close();
    }
  }
});

it('preserves include/exclude getter and iterator order before the existing table-list query', () => {
  const db = new DatabaseSync!(':memory:');
  db.exec('CREATE TABLE ordinary(id INTEGER PRIMARY KEY)');
  const trace: string[] = [];
  const prepare = db.prepare.bind(db);
  db.prepare = ((sql: string) => {
    trace.push(sql);
    return prepare(sql);
  }) as typeof db.prepare;
  const include = ['ordinary'];
  const exclude = ['absent'];
  for (const [name, values] of [
    ['include', include],
    ['exclude', exclude],
  ] as const) {
    const iterator = values[Symbol.iterator].bind(values);
    values[Symbol.iterator] = () => {
      trace.push(`${name}:iterate`);
      return iterator();
    };
  }
  try {
    const schema = introspectSqliteDatabase(db, {
      get include() {
        trace.push('include:get');
        return include;
      },
      get exclude() {
        trace.push('exclude:get');
        return exclude;
      },
    });
    assert.deepEqual(Object.keys(schema.tables), ['ordinary']);
    assert.deepEqual(trace.slice(1, 8), [
      'include:get',
      'include:get',
      'include:iterate',
      'exclude:get',
      'exclude:get',
      'exclude:iterate',
      'PRAGMA main.table_list',
    ]);
    assert.equal(trace.filter((sql) => sql === 'PRAGMA main.table_list').length, 1);
    trace.length = 0;
    const sentinel = {};
    assert.throws(
      () =>
        introspectSqliteDatabase(db, {
          get include(): string[] {
            throw sentinel;
          },
        }),
      (error) => error === sentinel,
    );
    assert.equal(trace.length, 1);
  } finally {
    db.close();
  }
});

it('leaves omitted helper callers with the existing default/include/exclude policy', () => {
  const names = ['ordinary', '_prisma_migrations', 'ordinary_data'];
  assert.deepEqual(applyTableFilters(names), ['ordinary', 'ordinary_data']);
  assert.deepEqual(applyTableFilters(names, { include: ['_prisma_migrations', 'ordinary'], exclude: ['ordinary'] }), [
    '_prisma_migrations',
  ]);
  assert.deepEqual(names, ['ordinary', '_prisma_migrations', 'ordinary_data']);
});
