/**
 * turbine-orm: WHERE-clause hardening (0.66)
 *
 * Four independent defects in the where compiler, grouped because they share
 * one root shape: something the SQL-BUILD path checks that the CACHE-HIT path
 * does not, or something unbounded that a request body controls.
 *
 *   - vector distance thresholds were validated only on the build path, so a
 *     warmed cache bound `NaN` straight into the statement, and Postgres sorts
 *     NaN above every real distance, so `distance < NaN` matches EVERY row;
 *   - the boolean-combinator walk had no depth cap, so a 64 KB request body
 *     (under `express.json()`'s 100 KB default) produced a `RangeError` rather
 *     than a `TurbineError`;
 *   - two JSON-operator diagnostics interpolated the caller's VALUE verbatim,
 *     against SECURITY.md's "values are rendered as key names only", and one of
 *     them fires on a perfectly valid value;
 *   - `escapeLike` hard-coded the SQL-standard metacharacter set, with no seam
 *     for an engine whose LIKE grammar has more of them.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Dialect } from '../dialect.js';
import { postgresDialect } from '../dialect.js';
import { setErrorMessageMode, TurbineErrorCode, ValidationError } from '../errors.js';
import { resetCacheCrossCheckEnv } from '../query/builder.js';
import { MAX_WHERE_DEPTH } from '../query/where-compile.js';
import type { SchemaMetadata } from '../schema.js';
import { makeQuery, mockTable } from './helpers.js';

function schema(): SchemaMetadata {
  return {
    enums: {},
    tables: {
      docs: mockTable(
        'docs',
        [
          { name: 'id', field: 'id' },
          { name: 'title', field: 'title', pgType: 'text' },
          { name: 'meta', field: 'meta', pgType: 'jsonb' },
          { name: 'embedding', field: 'embedding', pgType: 'vector' },
        ],
        {
          notes: {
            name: 'notes',
            type: 'hasMany',
            from: 'docs',
            to: 'notes',
            foreignKey: 'doc_id',
            referenceKey: 'id',
          },
        },
      ),
      notes: mockTable(
        'notes',
        [
          { name: 'id', field: 'id' },
          { name: 'doc_id', field: 'docId' },
          { name: 'parent_id', field: 'parentId' },
          { name: 'body', field: 'body', pgType: 'text' },
        ],
        // A SELF relation, so a relation-filter chain can be made arbitrarily
        // deep the way a caller-supplied one can.
        {
          children: {
            name: 'children',
            type: 'hasMany',
            from: 'notes',
            to: 'notes',
            foreignKey: 'parent_id',
            referenceKey: 'id',
          },
        },
      ),
    },
  };
}

/** Run `fn` with the process error-message mode temporarily set. */
function withMessageMode(mode: 'safe' | 'verbose', fn: () => void): void {
  setErrorMessageMode(mode);
  try {
    fn();
  } finally {
    setErrorMessageMode('safe');
  }
}

/**
 * Run `fn` with the SQL-cache lockstep cross-check OFF, i.e. the production
 * configuration.
 *
 * This is load-bearing for the vector tests below rather than incidental. In
 * dev the cross-check RE-RUNS the build path on every cache hit, so the build
 * path's own validation throws and the missing check on the collect path is
 * invisible. That masking is the whole reason the defect survived: it was
 * reachable only under `NODE_ENV=production`, where the cross-check is off and
 * the collect path runs alone. A test that does not turn it off is testing the
 * tripwire, not the fix.
 */
function withCacheCheckOff(fn: () => void): void {
  const savedEnv = process.env.NODE_ENV;
  const savedSample = process.env.TURBINE_CACHE_CHECK_SAMPLE;
  process.env.NODE_ENV = 'production';
  delete process.env.TURBINE_CACHE_CHECK_SAMPLE;
  resetCacheCrossCheckEnv();
  try {
    fn();
  } finally {
    if (savedEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = savedEnv;
    if (savedSample === undefined) delete process.env.TURBINE_CACHE_CHECK_SAMPLE;
    else process.env.TURBINE_CACHE_CHECK_SAMPLE = savedSample;
    resetCacheCrossCheckEnv();
  }
}

// ---------------------------------------------------------------------------
// Vector thresholds on the cache-HIT path
// ---------------------------------------------------------------------------

describe('vector distance thresholds are validated on the cache-hit path', () => {
  const good = { where: { embedding: { distance: { to: [1, 2, 3], metric: 'l2', lt: 5 } } } };

  for (const [label, bad] of [
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ["the string '5'", '5'],
    ['an object', { a: 1 }],
  ] as const) {
    it(`refuses ${label} on a warm cache with the cross-check off (production)`, () => {
      withCacheCheckOff(() => {
        const q = makeQuery('docs', schema(), { warnOnUnlimited: false });
        // Warm the template. The fingerprint is value-invariant, so the bad
        // query below is a cache HIT and the build path (which has always
        // validated) never runs for it.
        q.buildFindMany(good as never);
        assert.equal(q.cacheStats().misses, 1);

        assert.throws(
          () =>
            q.buildFindMany({
              where: { embedding: { distance: { to: [1, 2, 3], metric: 'l2', lt: bad } } },
            } as never),
          (err: unknown) =>
            err instanceof ValidationError &&
            err.code === TurbineErrorCode.VALIDATION &&
            /Vector distance threshold "lt"/.test(err.message),
          `${label} must be refused on the warm path`,
        );
        assert.equal(q.cacheStats().hits, 1, 'the bad query must have been a cache HIT');
      });
    });
  }

  it('the missing comparison refusal also holds on the collect path', () => {
    withCacheCheckOff(() => {
      const q = makeQuery('docs', schema(), { warnOnUnlimited: false });
      // `lt: undefined` leaves the filter with no comparison at all. The build
      // path has always refused it; the collect path used to push only the
      // query vector and emit a warmed statement expecting two params.
      assert.throws(
        () =>
          q.buildFindMany({
            where: { embedding: { distance: { to: [1, 2, 3], metric: 'l2', lt: undefined } } },
          } as never),
        (err: unknown) => err instanceof ValidationError && /requires at least one comparison/.test(err.message),
      );
    });
  });

  it('a valid threshold still binds exactly as before', () => {
    const q = makeQuery('docs', schema(), { warnOnUnlimited: false });
    const { sql, params } = q.buildFindMany(good as never);
    assert.match(sql, /"embedding" <-> \$1::vector < \$2/);
    assert.deepEqual(params, [JSON.stringify([1, 2, 3]), 5]);
    // ...and the cache-hit collect path produces the identical param list.
    const warm = q.buildFindMany({
      where: { embedding: { distance: { to: [4, 5, 6], metric: 'l2', lt: 9 } } },
    } as never);
    assert.equal(warm.sql, sql);
    assert.deepEqual(warm.params, [JSON.stringify([4, 5, 6]), 9]);
  });
});

// ---------------------------------------------------------------------------
// Combinator depth cap
// ---------------------------------------------------------------------------

/** A `NOT` chain nested `depth` levels deep, the cheapest deep shape. */
function nestedNot(depth: number): Record<string, unknown> {
  let where: Record<string, unknown> = { id: 1 };
  for (let i = 0; i < depth; i++) where = { NOT: where };
  return where;
}

describe('boolean-combinator depth is capped', () => {
  it(`accepts nesting at the cap (${MAX_WHERE_DEPTH})`, () => {
    const q = makeQuery('docs', schema(), { warnOnUnlimited: false });
    assert.doesNotThrow(() => q.buildFindMany({ where: nestedNot(MAX_WHERE_DEPTH) } as never));
  });

  it('refuses nesting past the cap with a typed E003, not a RangeError', () => {
    const q = makeQuery('docs', schema(), { warnOnUnlimited: false });
    assert.throws(
      () => q.buildFindMany({ where: nestedNot(MAX_WHERE_DEPTH + 1) } as never),
      (err: unknown) =>
        err instanceof ValidationError &&
        err.code === TurbineErrorCode.VALIDATION &&
        /nests more than 32 levels/.test(err.message),
    );
  });

  it('a request-body-sized chain is a ValidationError rather than a stack overflow', () => {
    // 8,000 levels was measured as `RangeError: Maximum call stack size
    // exceeded` in a 64 KB body. A RangeError is not a TurbineError, so it
    // bypasses every typed catch and lands as an unhandled rejection.
    const q = makeQuery('docs', schema(), { warnOnUnlimited: false });
    let thrown: unknown;
    try {
      q.buildFindMany({ where: nestedNot(8000) } as never);
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown instanceof ValidationError, `expected ValidationError, got ${String(thrown)}`);
  });

  it('OR / AND nesting is capped as well', () => {
    const q = makeQuery('docs', schema(), { warnOnUnlimited: false });
    let where: Record<string, unknown> = { id: 1 };
    for (let i = 0; i < 5000; i++) where = { OR: [where] };
    assert.throws(() => q.buildFindMany({ where } as never), ValidationError);
  });

  it('relation-filter nesting counts toward the same cap', () => {
    // `{ notes: { some: { … } } }` recurses through the same walkers and is
    // exactly as unbounded; each descent is a level.
    const q = makeQuery('docs', schema(), { warnOnUnlimited: false });
    let where: Record<string, unknown> = { body: 'x' };
    for (let i = 0; i < 60; i++) where = { children: { some: where } };
    assert.throws(
      () => q.buildFindMany({ where: { notes: { some: where } } } as never),
      (err: unknown) => err instanceof ValidationError && /nests more than 32 levels/.test(err.message),
    );
  });

  it('groupBy `having` is capped too', () => {
    const q = makeQuery('docs', schema(), { warnOnUnlimited: false });
    let having: Record<string, unknown> = { _count: { gt: 1 } };
    for (let i = 0; i < 5000; i++) having = { NOT: having };
    assert.throws(
      () => q.buildGroupBy({ by: ['title'], having } as never),
      (err: unknown) => err instanceof ValidationError && /`having` clause nests/.test(err.message),
    );
  });

  it('a wide but shallow clause is untouched (arity is not depth)', () => {
    const q = makeQuery('docs', schema(), { warnOnUnlimited: false });
    const OR = Array.from({ length: 500 }, (_, i) => ({ id: i }));
    assert.doesNotThrow(() => q.buildFindMany({ where: { OR } } as never));
  });
});

// ---------------------------------------------------------------------------
// Error-message value leaks
// ---------------------------------------------------------------------------

describe('JSON operator diagnostics respect the safe error-message mode', () => {
  it('a missing `path` does not echo the search term in safe mode', () => {
    const q = makeQuery('docs', schema(), { warnOnUnlimited: false });
    withMessageMode('safe', () => {
      assert.throws(
        () => q.buildFindMany({ where: { meta: { stringContains: 'hunter2' } } } as never),
        (err: unknown) => {
          assert.ok(err instanceof ValidationError);
          assert.doesNotMatch(err.message, /hunter2/);
          // Still useful: it names the operator and the column.
          assert.match(err.message, /stringContains/);
          assert.match(err.message, /"meta"/);
          return true;
        },
      );
    });
  });

  it('verbose mode still echoes the value (that is what verbose is for)', () => {
    const q = makeQuery('docs', schema(), { warnOnUnlimited: false });
    withMessageMode('verbose', () => {
      assert.throws(
        () => q.buildFindMany({ where: { meta: { stringContains: 'hunter2' } } } as never),
        (err: unknown) => err instanceof ValidationError && /hunter2/.test(err.message),
      );
    });
  });

  it('a wrong-typed operand reports its TYPE, not its contents, in safe mode', () => {
    const q = makeQuery('docs', schema(), { warnOnUnlimited: false });
    withMessageMode('safe', () => {
      assert.throws(
        () => q.buildFindMany({ where: { meta: { path: ['a'], gt: { secret: 'ssn' } } } } as never),
        (err: unknown) => {
          assert.ok(err instanceof ValidationError);
          assert.doesNotMatch(err.message, /ssn/);
          assert.match(err.message, /got object/);
          return true;
        },
      );
    });
  });

  it('a vector threshold error does not echo the value in safe mode', () => {
    const q = makeQuery('docs', schema(), { warnOnUnlimited: false });
    withMessageMode('safe', () => {
      assert.throws(
        () =>
          q.buildFindMany({
            where: { embedding: { distance: { to: [1], metric: 'l2', lt: 'sentinel-value' } } },
          } as never),
        (err: unknown) => {
          assert.ok(err instanceof ValidationError);
          assert.doesNotMatch(err.message, /sentinel-value/);
          assert.match(err.message, /got string/);
          return true;
        },
      );
    });
  });
});

// ---------------------------------------------------------------------------
// LIKE escaping is a dialect seam
// ---------------------------------------------------------------------------

describe('escapeLikePattern dialect hook', () => {
  /** A dialect that also escapes `[`, the way T-SQL's LIKE grammar needs. */
  const bracketDialect: Dialect = {
    ...postgresDialect,
    escapeLikePattern(value: string): string {
      return value.replace(/[\\%_[]/g, (c) => `\\${c}`);
    },
  };

  it('defaults to the shared escapeLike when a dialect declares no override', () => {
    const q = makeQuery('docs', schema(), { warnOnUnlimited: false });
    const { params } = q.buildFindMany({ where: { title: { contains: '[draft]_50%' } } } as never);
    assert.deepEqual(params, ['%[draft]\\_50\\%%']);
  });

  it('uses the override when the dialect supplies one', () => {
    const q = makeQuery('docs', schema(), { warnOnUnlimited: false, dialect: bracketDialect });
    const { params } = q.buildFindMany({ where: { title: { contains: '[draft]' } } } as never);
    assert.deepEqual(params, ['%\\[draft]%']);
  });

  it('the cache-hit collect path escapes identically (or params bind wrong)', () => {
    const q = makeQuery('docs', schema(), { warnOnUnlimited: false, dialect: bracketDialect });
    q.buildFindMany({ where: { title: { contains: 'warm' } } } as never);
    const warm = q.buildFindMany({ where: { title: { contains: '[draft]' } } } as never);
    assert.equal(q.cacheStats().hits, 1);
    assert.deepEqual(warm.params, ['%\\[draft]%']);
  });

  it('applies to startsWith / endsWith and to the JSON substring operators', () => {
    const q = makeQuery('docs', schema(), { warnOnUnlimited: false, dialect: bracketDialect });
    assert.deepEqual(q.buildFindMany({ where: { title: { startsWith: '[a' } } } as never).params, ['\\[a%']);
    assert.deepEqual(q.buildFindMany({ where: { title: { endsWith: 'a]' } } } as never).params, ['%a]']);
    const json = q.buildFindMany({
      where: { meta: { path: ['k'], stringContains: '[x]' } },
    } as never);
    assert.deepEqual(json.params, [['k'], '%\\[x]%']);
  });

  it('the ESCAPE clause that pairs with it is still emitted', () => {
    const q = makeQuery('docs', schema(), { warnOnUnlimited: false, dialect: bracketDialect });
    assert.ok(q.buildFindMany({ where: { title: { contains: 'x' } } } as never).sql.endsWith("ESCAPE '\\'"));
  });
});
