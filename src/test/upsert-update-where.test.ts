/**
 * turbine-orm: upsert conflict-UPDATE predicate, SQL and params must agree.
 *
 * `buildUpsert` only compiles a conflict-UPDATE predicate (the global filter,
 * i.e. soft-delete / tenancy) when `dialect.supportsUpsertUpdateWhere` is true,
 * and pushes that predicate's parameters at the same time. Every dialect that
 * reports `true` must therefore actually EMIT the predicate: `mysqlDialect`,
 * `sqliteDialect` and `mssqlDialect` all spread `postgresDialect` (which sets
 * the flag), and MySQL's `ON DUPLICATE KEY UPDATE` dropped the clause while its
 * parameters stayed bound. That either errors at the driver or, worse, shifts
 * every later placeholder by one.
 *
 * The load-bearing assertion here is `assertParamsAligned`: every placeholder in
 * the emitted SQL has exactly one param and every param is referenced. It is
 * written per engine (placeholder syntax comes from the dialect itself), so any
 * future dialect that lies about the flag fails here rather than in production.
 *
 * Run: npx tsx --test src/test/upsert-update-where.test.ts
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Dialect } from '../dialect.js';
import { postgresDialect } from '../dialect.js';
import { UnsupportedFeatureError } from '../errors.js';
import { mssqlDialect } from '../mssql.js';
import { mysqlDialect } from '../mysql.js';
import { UNSAFE } from '../query/index.js';
import type { SchemaMetadata } from '../schema.js';
import { sqliteDialect } from '../sqlite.js';
import { makeQuery, mockTable } from './helpers.js';

function schema(): SchemaMetadata {
  return {
    enums: {},
    tables: {
      users: mockTable('users', [
        { name: 'id', field: 'id' },
        { name: 'name', field: 'name', pgType: 'text' },
        { name: 'tenant_id', field: 'tenantId', pgType: 'text' },
      ]),
    },
  };
}

/**
 * Every placeholder the dialect can emit, indexed. Built from the dialect's own
 * `paramPlaceholder`, so `$1` / `:p1` / `@p1` are all covered without
 * hard-coding an engine's syntax here.
 */
function placeholderIndexes(dialect: Dialect, sql: string, upTo: number): Set<number> {
  const found = new Set<number>();
  for (let i = 1; i <= upTo; i++) {
    const ph = dialect.paramPlaceholder(i);
    // A word boundary stops `:p1` from matching inside `:p10`.
    if (new RegExp(`${ph.replace(/[$@]/g, '\\$&')}(?![0-9])`).test(sql)) found.add(i);
  }
  return found;
}

/** Every placeholder in `sql` has exactly one param, and every param is used. */
function assertParamsAligned(dialect: Dialect, sql: string, params: unknown[]): void {
  // Probe one past the params array: an emitted-but-unbound placeholder is just
  // as broken as an orphaned param.
  const referenced = placeholderIndexes(dialect, sql, params.length + 1);
  assert.ok(
    !referenced.has(params.length + 1),
    `${dialect.name}: SQL references ${dialect.paramPlaceholder(params.length + 1)} but only ${params.length} params were bound: ${sql}`,
  );
  for (let i = 1; i <= params.length; i++) {
    assert.ok(
      referenced.has(i),
      `${dialect.name}: param ${dialect.paramPlaceholder(i)} is never referenced in SQL, orphaned param: ${sql}`,
    );
  }
}

function buildTenantUpsert(dialect: Dialect, extra: Record<string, unknown> = {}) {
  return makeQuery('users', schema(), {
    dialect,
    globalFilters: { users: { tenantId: 'acme' } },
  }).buildUpsert({
    where: { id: 1 },
    create: { id: 1, name: 'x', tenantId: 'acme' } as never,
    update: { name: 'y' } as never,
    ...extra,
  });
}

const ENGINES: [name: string, dialect: Dialect][] = [
  ['postgres', postgresDialect],
  ['sqlite', sqliteDialect],
  ['mysql', mysqlDialect],
  ['mssql', mssqlDialect],
];

describe('upsert conflict-UPDATE predicate: SQL and params agree', () => {
  for (const [name, dialect] of ENGINES) {
    // With the filter opted out every engine builds, so alignment is checked
    // on all four; with it in force only the engines that can carry it build.
    const variants: Array<[string, Record<string, unknown>]> = [
      ['with the filter opted out', { skipGlobalFilters: UNSAFE }],
      ...(dialect.supportsUpsertUpdateWhere ? [['with a global filter', {}] as [string, Record<string, unknown>]] : []),
    ];
    for (const [label, extra] of variants) {
      it(`${name}: no orphaned or unbound placeholders ${label}`, () => {
        const { sql, params } = buildTenantUpsert(dialect, extra);
        assertParamsAligned(dialect, sql, params);
      });
    }

    it(`${name}: honours the filter on the conflict update, or refuses the upsert`, () => {
      if (!dialect.supportsUpsertUpdateWhere) {
        assert.throws(() => buildTenantUpsert(dialect), UnsupportedFeatureError);
        return;
      }
      const { sql, params } = buildTenantUpsert(dialect);
      // The filter value is the LAST param: create params, then update params,
      // then the filter's.
      assert.equal(params.length, 5, `${name}: the filter param must be bound (params: ${params.length})`);
      assert.ok(
        sql.includes(`tenant_id`) && sql.includes(dialect.paramPlaceholder(5)),
        `${name}: the predicate must reach the SQL: ${sql}`,
      );
    });
  }

  // These two used to DROP the predicate and run the upsert anyway, so a
  // tenant-scoped upsert whose key matched another tenant's row updated it.
  // `upsert()` itself now looks the row up with the filter applied (proven live
  // in cross-engine-correctness.test.ts); only the one-statement BATCHED form,
  // which has no round trip for a lookup, is refused.
  it('mysql refuses a filtered batched upsert: ON DUPLICATE KEY UPDATE has no predicate slot', () => {
    assert.equal(mysqlDialect.supportsUpsertUpdateWhere, false);
    assert.throws(
      () => buildTenantUpsert(mysqlDialect),
      (e: unknown) => {
        assert.ok(e instanceof UnsupportedFeatureError);
        assert.match(e.message, /global filter/);
        assert.match(e.message, /skipGlobalFilters: UNSAFE/);
        assert.match(e.message, /Call `upsert\(\)` unbatched/, 'names the call that does work');
        return true;
      },
    );
    assert.doesNotMatch(buildTenantUpsert(mysqlDialect, { skipGlobalFilters: UNSAFE }).sql, /WHERE/);
  });

  it('mssql refuses a filtered batched upsert: MERGE cannot take the predicate', () => {
    // MERGE's `WHEN MATCHED AND <pred>` cannot take the unqualified column
    // references the builder produces (ambiguous between the T and S aliases).
    assert.equal(mssqlDialect.supportsUpsertUpdateWhere, false);
    assert.throws(() => buildTenantUpsert(mssqlDialect), UnsupportedFeatureError);
    assert.doesNotMatch(buildTenantUpsert(mssqlDialect, { skipGlobalFilters: UNSAFE }).sql, /WHEN MATCHED AND/);
  });

  it('a filter that compiles to nothing does not refuse', () => {
    const q = makeQuery('users', schema(), {
      dialect: mysqlDialect,
      globalFilters: { users: () => ({ tenantId: undefined }) },
    });
    assert.doesNotThrow(() =>
      q.buildUpsert({ where: { id: 1 }, create: { id: 1, name: 'x' } as never, update: { name: 'y' } as never }),
    );
  });

  // The predicate is TABLE-QUALIFIED: inside `ON CONFLICT ... DO UPDATE ... WHERE`
  // both the target table and `excluded` are in scope, so a bare column there
  // is ambiguous (42702 on PostgreSQL) and the statement never ran at all.
  it('sqlite really emits the predicate it claims to support, table-qualified', () => {
    assert.equal(sqliteDialect.supportsUpsertUpdateWhere, true);
    const { sql } = buildTenantUpsert(sqliteDialect);
    assert.match(sql, /DO UPDATE SET .* WHERE "users"\."tenant_id" = :p5/);
  });

  it('postgres really emits the predicate it claims to support, table-qualified', () => {
    assert.equal(postgresDialect.supportsUpsertUpdateWhere, true);
    const { sql } = buildTenantUpsert(postgresDialect);
    assert.match(sql, /DO UPDATE SET .* WHERE "users"\."tenant_id" = \$5/);
  });
});
