/**
 * turbine-orm/powdb, dialect-contract regressions (no server required).
 *
 * The `Dialect` seam promises ONE thing: a feature an engine cannot support
 * raises a typed `UnsupportedFeatureError` (E017) rather than degrading
 * silently. These are the three PowDB places that broke that promise, each of
 * which returned a WRONG ANSWER with no error and no warning:
 *
 *   1. `distinct` was accepted and compiled to PowQL's ROW-WIDE `distinct`
 *      keyword, which is not what `DISTINCT ON (col)` means. Different row set,
 *      same arguments, silence.
 *   2. `{ col: { has: x } }` was not recognised as an array filter (the local
 *      key list had drifted from the shared `ARRAY_OPERATOR_KEYS`), so it fell
 *      through to the bare-object equality branch and bound `{has:'x'}` itself
 *      as a scalar parameter.
 *   3. A PII-tagged PRIMARY KEY was deleted from a write's returned row, so the
 *      row came back un-addressable, the opposite of the SQL engines' rule.
 *
 * Build-only: a mock `PowdbPool` records the emitted PowQL and hands back canned
 * rows, so this runs in the `test:unit` lane with no addon and no server.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { TurbineErrorCode, UnsupportedFeatureError } from '../errors.js';
import { ALL_POWDB_CAPABILITIES, type PowdbCapabilities, type PowdbPool } from '../powdb.js';
import { PowqlInterface } from '../powql.js';
import { ARRAY_OPERATOR_KEYS } from '../query/filters.js';
import { QueryInterface } from '../query/index.js';
import type { ColumnMetadata, RelationDef, SchemaMetadata, TableMetadata } from '../schema.js';
import { sqliteDialect } from '../sqlite.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function col(name: string, field: string, tsType: string, pgType: string, opts: Partial<ColumnMetadata> = {}) {
  return { name, field, pgType, tsType, nullable: false, hasDefault: false, isArray: false, pgArrayType: '', ...opts };
}

function table(
  name: string,
  columns: ColumnMetadata[],
  primaryKey = ['id'],
  relations: Record<string, RelationDef> = {},
): TableMetadata {
  const columnMap: Record<string, string> = {};
  const reverseColumnMap: Record<string, string> = {};
  for (const c of columns) {
    columnMap[c.field] = c.name;
    reverseColumnMap[c.name] = c.field;
  }
  return {
    name,
    columns,
    columnMap,
    reverseColumnMap,
    dateColumns: new Set<string>(),
    pgTypes: Object.fromEntries(columns.map((c) => [c.name, c.pgType])),
    allColumns: columns.map((c) => c.name),
    primaryKey,
    uniqueColumns: [primaryKey],
    relations,
    indexes: [],
  };
}

const schema: SchemaMetadata = {
  enums: {},
  tables: {
    app_user: table(
      'app_user',
      [
        col('id', 'id', 'string', 'text', { hasDefault: true }),
        col('name', 'name', 'string', 'text'),
        col('email', 'email', 'string', 'text', { pii: true }),
      ],
      ['id'],
      {
        posts: {
          type: 'hasMany',
          name: 'posts',
          from: 'app_user',
          to: 'post',
          foreignKey: 'author_id',
          referenceKey: 'id',
        },
      },
    ),
    post: table('post', [
      col('id', 'id', 'string', 'text', { hasDefault: true }),
      col('author_id', 'authorId', 'string', 'text'),
      col('title', 'title', 'string', 'text'),
    ]),
    // A table whose PRIMARY KEY is itself PII-tagged. The SQL engines keep it in
    // the write projection on purpose (`piiColumns` / `piiFields` in
    // query/writes.ts); this is the table that proves PowDB now does too.
    contact: table(
      'contact',
      [
        col('email', 'email', 'string', 'text', { pii: true }),
        col('phone', 'phone', 'string', 'text', { pii: true }),
        col('label', 'label', 'string', 'text'),
      ],
      ['email'],
    ),
  },
};

/** A mock PowdbPool that records every emitted PowQL and returns canned rows. */
function mockPool(rows: Record<string, unknown>[] = [], caps: PowdbCapabilities = ALL_POWDB_CAPABILITIES) {
  const calls: { powql: string; params: unknown[] }[] = [];
  const pool = {
    capabilities: caps,
    retryStaleReads: false,
    query(powql: string, params: unknown[]) {
      calls.push({ powql, params });
      return Promise.resolve({ rows, rowCount: rows.length });
    },
  } as unknown as PowdbPool;
  return { pool, calls, last: () => calls[calls.length - 1] };
}

function qi(pool: PowdbPool, t = 'app_user') {
  // biome-ignore lint/suspicious/noExplicitAny: the row shape is irrelevant here.
  return new PowqlInterface<any>(pool, t, schema);
}

// ---------------------------------------------------------------------------
// E1, `distinct`
// ---------------------------------------------------------------------------

describe('powdb: findMany({ distinct }) is refused, not silently reinterpreted', () => {
  it("throws E017 instead of emitting PowQL's row-wide `distinct`", async () => {
    const mock = mockPool();
    await assert.rejects(
      () => qi(mock.pool).findMany({ distinct: ['name'] }),
      (err: unknown) => {
        assert.ok(err instanceof UnsupportedFeatureError, `expected E017, got ${String(err)}`);
        assert.equal(err.code, TurbineErrorCode.UNSUPPORTED_FEATURE);
        assert.match(err.message, /distinct/i);
        return true;
      },
    );
    assert.equal(mock.calls.length, 0, 'nothing may reach the engine');
  });

  it('the refusal comes BEFORE the column names resolve, byte-for-byte with the other engines', async () => {
    // Differential, not asserted in a comment: an engine that LACKS the feature
    // must not look at the name at all, so a typo reports the unsupported
    // feature rather than the typo. Measured before this test was written,
    // `distinct: ['creatd_at']` is E017 on sqlite / mysql / mssql and E003 only
    // on Postgres, where the feature exists. Resolving the name first on PowDB
    // would have made it the one engine answering E003 for an option no engine
    // in its group supports, which is the cross-engine disagreement this whole
    // round is closing.
    const sqlEngine = new QueryInterface<Record<string, unknown>>(
      // biome-ignore lint/suspicious/noExplicitAny: build-only, the pool is never touched.
      null as any,
      'app_user',
      schema,
      [],
      { dialect: sqliteDialect, sqlCache: false },
    );
    const codeFrom = (fn: () => unknown): string => {
      try {
        fn();
      } catch (err) {
        return (err as { code?: string }).code ?? 'no-code';
      }
      return 'no-throw';
    };
    const sqliteCode = codeFrom(() => sqlEngine.buildFindMany({ distinct: ['creatd_at'] } as never));
    assert.equal(sqliteCode, TurbineErrorCode.UNSUPPORTED_FEATURE, 'baseline: sqlite refuses before resolving');

    let powdbCode = 'no-throw';
    try {
      await qi(mockPool().pool).findMany({ distinct: ['creatd_at'] });
    } catch (err) {
      powdbCode = (err as { code?: string }).code ?? 'no-code';
    }
    assert.equal(powdbCode, sqliteCode, 'PowDB must answer an unknown distinct name the way sqlite does');
  });

  it('a relation-level `distinct` is refused too (it reaches the child findMany)', async () => {
    // The keyed loaders spread the relation options into the target's public
    // findMany, so relation `distinct` used to emit the row-wide keyword one
    // level down. Same rule, same error, whatever depth it is written at.
    const mock = mockPool([{ id: '1', name: 'Ada', email: 'a@example.test' }]);
    await assert.rejects(
      // `distinct` is not a declared `WithOptions` key, so a caller only reaches
      // this by spreading an options bag; the runtime path is real either way
      // (three eligibility checks in powql.ts read `options.distinct`).
      // biome-ignore lint/suspicious/noExplicitAny: deliberately an undeclared relation option.
      () => qi(mock.pool).findMany({ with: { posts: { distinct: ['title'] } as any } }),
      (err: unknown) => {
        assert.ok(err instanceof UnsupportedFeatureError, `expected E017, got ${String(err)}`);
        assert.equal(err.code, TurbineErrorCode.UNSUPPORTED_FEATURE);
        return true;
      },
    );
  });

  it('a findMany with no `distinct` is unaffected and emits no `distinct` keyword', async () => {
    const mock = mockPool([{ id: '1', name: 'Ada', email: 'a@example.test' }]);
    await qi(mock.pool).findMany({ where: { name: 'Ada' }, limit: 2 });
    assert.equal(mock.calls.length, 1);
    assert.doesNotMatch(mock.last()!.powql, /\bdistinct\b/);
  });
});

// ---------------------------------------------------------------------------
// E2, the array-filter guard
// ---------------------------------------------------------------------------

describe('powdb: every array operator is refused, `has` included', () => {
  // Driven off the SHARED constant rather than a literal list: if a fifth array
  // operator is added to query/filters.ts, this fails until PowDB answers for it
  // too, which is the drift that let `has` through in the first place.
  for (const key of ARRAY_OPERATOR_KEYS) {
    it(`{ name: { ${key}: … } } throws E017`, async () => {
      const mock = mockPool();
      const filter = key === 'isEmpty' ? { isEmpty: true } : { [key]: 'x' };
      await assert.rejects(
        () => qi(mock.pool).findMany({ where: { name: filter } }),
        (err: unknown) => {
          assert.ok(err instanceof UnsupportedFeatureError, `expected E017 for ${key}, got ${String(err)}`);
          assert.equal(err.code, TurbineErrorCode.UNSUPPORTED_FEATURE);
          assert.match(err.message, /array filters/);
          return true;
        },
      );
      assert.equal(mock.calls.length, 0, `${key} must not reach the engine`);
    });
  }

  it('anti-vacuous: the shared constant is non-empty and still contains `has`', () => {
    assert.ok(ARRAY_OPERATOR_KEYS.size >= 4);
    assert.ok(ARRAY_OPERATOR_KEYS.has('has'));
  });

  it('a plain equality on the same column still compiles (the guard is shape-scoped)', async () => {
    const mock = mockPool([{ id: '1', name: 'Ada', email: 'a@example.test' }]);
    await qi(mock.pool).findMany({ where: { name: 'Ada' } });
    assert.equal(mock.calls.length, 1);
    assert.deepEqual(mock.last()!.params, ['Ada']);
  });
});

// ---------------------------------------------------------------------------
// E5, the PII-tagged primary key
// ---------------------------------------------------------------------------

describe('powdb: a write return stays addressable when the PK is PII-tagged', () => {
  it('create keeps the PII-tagged PK and still drops the PII non-key column', async () => {
    const mock = mockPool([{ email: 'ada@example.test', phone: '555', label: 'work' }]);
    const row = await qi(mock.pool, 'contact').create({
      data: { email: 'ada@example.test', phone: '555', label: 'work' },
    });
    assert.equal(row.email, 'ada@example.test', 'the PK must survive: the row has to stay addressable');
    assert.equal(row.phone, undefined, 'a PII column that is NOT a key is still stripped');
    assert.equal(row.label, 'work');
  });

  it('update keeps it too (same strip, same exemption)', async () => {
    const mock = mockPool([{ email: 'ada@example.test', phone: '555', label: 'home' }]);
    const row = await qi(mock.pool, 'contact').update({
      where: { email: 'ada@example.test' },
      data: { label: 'home' },
    });
    assert.equal(row.email, 'ada@example.test');
    assert.equal(row.phone, undefined);
  });

  it('a PII column on a table whose PK is NOT PII is still stripped (no over-exemption)', async () => {
    const mock = mockPool([{ id: '1', name: 'Ada', email: 'ada@example.test' }]);
    const row = await qi(mock.pool).create({ data: { id: '1', name: 'Ada', email: 'ada@example.test' } });
    assert.equal(row.id, '1');
    assert.equal(row.email, undefined, 'email is PII and is not the key, so it goes');
  });
});
