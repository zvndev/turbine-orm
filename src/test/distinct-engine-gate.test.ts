/**
 * turbine-orm: `findMany({ distinct })` is PostgreSQL-only
 *
 * `distinct` compiles to `SELECT DISTINCT ON (...)`, which no engine but
 * PostgreSQL parses. It was emitted with no dialect check at all, so SQLite
 * answered `near "ON": syntax error` and MySQL `ER_PARSE_ERROR`, as RAW driver
 * errors carrying no `TURBINE_*` code, which is precisely the class the typed
 * error surface exists to remove.
 *
 * The OTHER spelling of the same feature, `groupBy({ distinctOn })`, has always
 * been gated (E017, in aggregates.ts). These tests hold both halves: every
 * non-Postgres dialect refuses with the same typed error, and the PostgreSQL
 * SQL is untouched.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Dialect } from '../dialect.js';
import { TurbineErrorCode, UnsupportedFeatureError } from '../errors.js';
import { mssqlDialect } from '../mssql.js';
import { mysqlDialect } from '../mysql.js';
import type { SchemaMetadata } from '../schema.js';
import { sqliteDialect } from '../sqlite.js';
import { makeQuery, mockTable } from './helpers.js';

function schema(): SchemaMetadata {
  return {
    enums: {},
    tables: {
      users: mockTable('users', [
        { name: 'id', field: 'id' },
        { name: 'email', field: 'email', pgType: 'text' },
        { name: 'name', field: 'name', pgType: 'text' },
      ]),
    },
  };
}

const NON_POSTGRES: [string, Dialect][] = [
  ['sqlite', sqliteDialect],
  ['mysql', mysqlDialect],
  ['mssql', mssqlDialect],
];

describe('findMany({ distinct }) engine gate', () => {
  for (const [label, dialect] of NON_POSTGRES) {
    it(`${label} refuses distinct with E017 instead of emitting DISTINCT ON`, () => {
      const q = makeQuery('users', schema(), { dialect, warnOnUnlimited: false });
      assert.throws(
        () => q.buildFindMany({ distinct: ['email'] } as never),
        (err: unknown) =>
          err instanceof UnsupportedFeatureError &&
          err.code === TurbineErrorCode.UNSUPPORTED_FEATURE &&
          /DISTINCT ON/.test(err.message) &&
          new RegExp(dialect.name).test(err.message),
        `${label} must refuse distinct`,
      );
    });

    it(`${label} refuses on the warm-cache path too (the guard is before acquireSql)`, () => {
      const q = makeQuery('users', schema(), { dialect, warnOnUnlimited: false });
      // Warm the cache with the same shape MINUS distinct, then assert the
      // distinct query still throws rather than being served from a template.
      q.buildFindMany({ where: { name: 'a' } } as never);
      assert.throws(
        () => q.buildFindMany({ where: { name: 'a' }, distinct: ['email'] } as never),
        UnsupportedFeatureError,
      );
      // And twice, because the first throw must not have cached anything.
      assert.throws(
        () => q.buildFindMany({ where: { name: 'a' }, distinct: ['email'] } as never),
        UnsupportedFeatureError,
      );
    });

    it(`${label} is unaffected when distinct is absent or empty`, () => {
      const q = makeQuery('users', schema(), { dialect, warnOnUnlimited: false });
      assert.doesNotThrow(() => q.buildFindMany({ distinct: [] } as never));
      assert.doesNotThrow(() => q.buildFindMany({} as never));
    });
  }

  it('postgres still emits DISTINCT ON, unchanged', () => {
    const q = makeQuery('users', schema(), { warnOnUnlimited: false });
    const { sql } = q.buildFindMany({ distinct: ['email'] } as never);
    assert.match(sql, /^SELECT DISTINCT ON \("email"\) "users"\.\* FROM "users"$/);
  });

  it('postgres distinct + orderBy still emits the two-level derived table', () => {
    const q = makeQuery('users', schema(), { warnOnUnlimited: false });
    const { sql } = q.buildFindMany({ distinct: ['email'], orderBy: { name: 'asc' } } as never);
    assert.match(sql, /SELECT \* FROM \(SELECT DISTINCT ON \("email"\)/);
    assert.match(sql, /AS "users_distinct" ORDER BY "name" ASC$/);
  });
});
