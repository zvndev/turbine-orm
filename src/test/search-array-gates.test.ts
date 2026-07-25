/**
 * turbine-orm: dialect gates for full-text `search` and array filters
 * (build-only, plus one live SQLite run).
 *
 * Both filters compile to PostgreSQL-only SQL: `to_tsvector(...) @@
 * to_tsquery(...)` and the array operators `= ANY(col)` / `@>` / `&&` /
 * `cardinality(col)`. They are gated on the `supportsFullTextSearch` /
 * `supportsArrayColumns` capability flags exactly like `supportsVector`, so a
 * non-PostgreSQL engine raises a typed UnsupportedFeatureError (E017) instead
 * of shipping SQL its parser rejects.
 *
 * Run: npx tsx --test src/test/search-array-gates.test.ts
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { postgresDialect } from '../dialect.js';
import { UnsupportedFeatureError } from '../errors.js';
import { mssqlDialect } from '../mssql.js';
import { mysqlDialect } from '../mysql.js';
import type { QueryInterface } from '../query/index.js';
import type { SchemaMetadata } from '../schema.js';
import { sqliteDialect } from '../sqlite.js';
import { makeQuery, mockTable } from './helpers.js';

function docsSchema(): SchemaMetadata {
  const docs = mockTable('docs', [
    { name: 'id', field: 'id' },
    { name: 'body', field: 'body', pgType: 'text' },
    { name: 'tags', field: 'tags', pgType: '_text' },
  ]);
  return { enums: {}, tables: { docs } };
}

function docsQuery(dialect = postgresDialect): QueryInterface<Record<string, unknown>> {
  return makeQuery('docs', docsSchema(), { dialect }) as unknown as QueryInterface<Record<string, unknown>>;
}

// biome-ignore lint/suspicious/noExplicitAny: exercising filter shapes in a build-only test
const searchArgs: any = { where: { body: { search: 'turbine & orm' } } };
// biome-ignore lint/suspicious/noExplicitAny: exercising filter shapes in a build-only test
const arrayArgs: any = { where: { tags: { has: 'sql' } } };

const nonPostgres = [
  { name: 'sqlite', dialect: sqliteDialect },
  { name: 'mysql', dialect: mysqlDialect },
  { name: 'mssql', dialect: mssqlDialect },
];

describe('capability flags: full-text search and array columns', () => {
  it('PostgreSQL declares both capabilities; the other engines declare neither', () => {
    assert.equal(postgresDialect.supportsFullTextSearch, true);
    assert.equal(postgresDialect.supportsArrayColumns, true);
    for (const { dialect } of nonPostgres) {
      assert.equal(dialect.supportsFullTextSearch, false, `${dialect.name} must not claim full-text search`);
      assert.equal(dialect.supportsArrayColumns, false, `${dialect.name} must not claim array columns`);
    }
  });
});

describe('full-text `search` on PostgreSQL is unchanged', () => {
  it('emits the exact to_tsvector / to_tsquery clause with the term as a bound param', () => {
    const { sql, params } = docsQuery().buildFindMany(searchArgs);
    assert.ok(
      sql.includes(`to_tsvector('english', "body") @@ to_tsquery('english', $1)`),
      `unexpected search SQL: ${sql}`,
    );
    assert.deepEqual(params, ['turbine & orm']);
  });

  it('honors an explicit config name', () => {
    const { sql } = docsQuery().buildFindMany({
      // biome-ignore lint/suspicious/noExplicitAny: build-only filter shape
      where: { body: { search: 'x', config: 'simple' } } as any,
    });
    assert.ok(sql.includes(`to_tsvector('simple', "body") @@ to_tsquery('simple', $1)`));
  });
});

describe('array filters on PostgreSQL are unchanged', () => {
  it('emits the exact ANY / @> / && / cardinality forms', () => {
    assert.ok(docsQuery().buildFindMany(arrayArgs).sql.includes('$1 = ANY("tags")'));
    assert.ok(
      docsQuery()
        // biome-ignore lint/suspicious/noExplicitAny: build-only filter shape
        .buildFindMany({ where: { tags: { hasEvery: ['a', 'b'] } } } as any)
        .sql.includes('"tags" @> $1::text[]'),
    );
    assert.ok(
      docsQuery()
        // biome-ignore lint/suspicious/noExplicitAny: build-only filter shape
        .buildFindMany({ where: { tags: { hasSome: ['a'] } } } as any)
        .sql.includes('"tags" && $1::text[]'),
    );
    assert.ok(
      docsQuery()
        // biome-ignore lint/suspicious/noExplicitAny: build-only filter shape
        .buildFindMany({ where: { tags: { isEmpty: true } } } as any)
        .sql.includes('COALESCE(cardinality("tags"), 0) = 0'),
    );
  });
});

describe('non-PostgreSQL engines refuse both filters with E017', () => {
  for (const { name, dialect } of nonPostgres) {
    it(`${name}: \`search\` throws UnsupportedFeatureError naming the feature and the engine`, () => {
      assert.throws(
        () => docsQuery(dialect).buildFindMany(searchArgs),
        (err: unknown) => {
          assert.ok(err instanceof UnsupportedFeatureError);
          assert.equal(err.code, 'TURBINE_E017');
          assert.match(err.message, /full-text search/);
          assert.match(err.message, new RegExp(`"${name}"`));
          return true;
        },
      );
    });

    it(`${name}: array filters throw UnsupportedFeatureError naming the feature and the engine`, () => {
      assert.throws(
        () => docsQuery(dialect).buildFindMany(arrayArgs),
        (err: unknown) => {
          assert.ok(err instanceof UnsupportedFeatureError);
          assert.equal(err.code, 'TURBINE_E017');
          assert.match(err.message, /array column filter set/);
          assert.match(err.message, new RegExp(`"${name}"`));
          return true;
        },
      );
    });

    it(`${name}: the gates also fire inside a relation sub-where`, () => {
      const schema = docsSchema();
      schema.tables.owners = mockTable('owners', [{ name: 'id', field: 'id' }], {
        docs: {
          type: 'hasMany',
          name: 'docs',
          from: 'owners',
          to: 'docs',
          foreignKey: 'id',
          referenceKey: 'id',
        },
      });
      const owners = makeQuery('owners', schema, { dialect }) as unknown as QueryInterface<Record<string, unknown>>;
      assert.throws(
        // biome-ignore lint/suspicious/noExplicitAny: build-only filter shape
        () => owners.buildFindMany({ where: { docs: { some: { tags: { has: 'x' } } } } } as any),
        UnsupportedFeatureError,
      );
    });
  }
});

// ---------------------------------------------------------------------------
// Live SQLite: the engine really refuses, on a real in-process connection.
// ---------------------------------------------------------------------------

describe('live SQLite engine refuses `search` and array filters', () => {
  it('throws E017 rather than a raw driver syntax error', async () => {
    const { turbineSqlite } = await import('../sqlite.js');
    const db = turbineSqlite(':memory:', docsSchema());
    try {
      // biome-ignore lint/suspicious/noExplicitAny: dynamic table accessor in a test
      const docs = (db as any).docs;
      await assert.rejects(() => docs.findMany(searchArgs), UnsupportedFeatureError);
      await assert.rejects(() => docs.findMany(arrayArgs), UnsupportedFeatureError);
    } finally {
      await db.disconnect();
    }
  });
});
