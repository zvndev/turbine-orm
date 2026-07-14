/**
 * turbine-orm: dev-mode SQL-cache lockstep cross-check suite
 *
 * The SQL template cache requires three code paths to enumerate where-clause
 * keys identically: `fingerprintWhere` (cache key), `buildWhereClause` (SQL +
 * params on a MISS), and `collectWhereParams` (params on a HIT, without
 * rebuilding). Drift between them has shipped silent wrong-results bugs before
 * (permuted where-key order; an orderBy fingerprint collision).
 *
 * When `NODE_ENV !== 'production'` (and `TURBINE_DISABLE_CACHE_CHECK !== '1'`),
 * every cache HIT is now cross-checked: the SQL + params are rebuilt fresh and
 * compared byte-for-byte (SQL) and element-wise (params) against the cache-hit
 * result. A mismatch throws a `ValidationError` (E003) naming the fingerprint.
 *
 * These tests prove:
 *   (a) legitimate permuted-key cache hits pass the check untouched,
 *   (b) a corrupted cache entry (bad params, or bad SQL) throws E003 loudly,
 *   (c) `TURBINE_DISABLE_CACHE_CHECK=1` and `NODE_ENV=production` skip it.
 *
 * The whole existing unit suite runs with this check live on every cache hit,
 * so a clean run is itself the strongest proof the invariant holds today.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ValidationError } from '../errors.js';
import type { QueryInterface } from '../query/index.js';
import type { SchemaMetadata } from '../schema.js';
import { makeQuery, mockTable } from './helpers.js';

function buildSchema(): SchemaMetadata {
  return {
    enums: {},
    tables: {
      users: mockTable('users', [
        { name: 'id', field: 'id' },
        { name: 'age', field: 'age', pgType: 'int4' },
        { name: 'score', field: 'score', pgType: 'int4' },
        { name: 'tenant_id', field: 'tenantId' },
        { name: 'name', field: 'name', pgType: 'text' },
      ]),
    },
  };
}

/** Reach the private SQL cache entry object so a test can corrupt it in place. */
function firstCacheEntry(q: QueryInterface<Record<string, unknown>>): { sql: string; name: string } {
  const cache = (q as unknown as { sqlTemplateCache: { cache: Map<string, { sql: string; name: string }> } })
    .sqlTemplateCache.cache;
  const entry = [...cache.values()][0];
  assert.ok(entry, 'expected at least one cached SQL entry after warming');
  return entry;
}

/**
 * Run `fn` with env vars temporarily overridden, restoring the exact prior
 * state (including "was undefined") afterwards.
 */
function withEnv(overrides: Record<string, string | undefined>, fn: () => void): void {
  const saved: Record<string, string | undefined> = {};
  for (const key of Object.keys(overrides)) {
    saved[key] = process.env[key];
    const value = overrides[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    fn();
  } finally {
    for (const key of Object.keys(overrides)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

describe('cache cross-check: legitimate hits pass', () => {
  it('permuted where-key order on a warmed cache does not trip the check', () => {
    const q = makeQuery('users', buildSchema());

    // Warm, then hit with keys swapped: the invariant holds, so no throw and
    // each column still binds its own value.
    q.buildFindMany({ where: { age: 1, score: 2 } } as never);
    const second = q.buildFindMany({ where: { score: 20, age: 10 } } as never);

    const ageIdx = Number(second.sql.match(/"age" = \$(\d+)/)?.[1]);
    const scoreIdx = Number(second.sql.match(/"score" = \$(\d+)/)?.[1]);
    assert.equal(second.params[ageIdx - 1], 10);
    assert.equal(second.params[scoreIdx - 1], 20);
  });

  it('repeated identical count/update/delete hits pass the check', () => {
    const q = makeQuery('users', buildSchema());
    q.buildCount({ where: { age: 1 } } as never);
    assert.doesNotThrow(() => q.buildCount({ where: { age: 2 } } as never));

    q.buildUpdateMany({ where: { age: 1, score: 2 }, data: { name: 'x' } } as never);
    assert.doesNotThrow(() => q.buildUpdateMany({ where: { score: 20, age: 10 }, data: { name: 'y' } } as never));

    q.buildDeleteMany({ where: { tenantId: 1, age: 2 } } as never);
    assert.doesNotThrow(() => q.buildDeleteMany({ where: { age: 20, tenantId: 10 } } as never));
  });
});

describe('cache cross-check: corrupted entries throw E003', () => {
  it('a param-collect path that drifts out of lockstep throws with the invariant message', () => {
    const q = makeQuery('users', buildSchema());

    // Warm the cache with a two-key where so the params are order-sensitive.
    q.buildFindMany({ where: { age: 1, score: 2 } } as never);

    // Simulate a lockstep regression: make the collect path push params in the
    // WRONG order on the next (cache-hit) call. The build path is untouched, so
    // the cross-check must catch the divergence.
    const original = (
      q as unknown as { collectWhereParams: (w: unknown, p: unknown[]) => void }
    ).collectWhereParams.bind(q);
    (q as unknown as { collectWhereParams: (w: unknown, p: unknown[]) => void }).collectWhereParams = (w, p) => {
      const scratch: unknown[] = [];
      original(w, scratch);
      scratch.reverse();
      for (const v of scratch) p.push(v);
    };

    assert.throws(
      () => q.buildFindMany({ where: { age: 10, score: 20 } } as never),
      (err: unknown) =>
        err instanceof ValidationError &&
        err.code === 'TURBINE_E003' &&
        /SQL cache lockstep violation on findMany/.test(err.message) &&
        /internal invariant violation/.test(err.message) &&
        /params .* diverge/.test(err.message),
    );
  });

  it('a corrupted cached SQL string throws with both SQL strings in the message', () => {
    const q = makeQuery('users', buildSchema());

    // Warm, then corrupt the cached SQL text so it no longer matches what the
    // same query freshly builds.
    q.buildFindMany({ where: { age: 1 } } as never);
    const entry = firstCacheEntry(q as unknown as QueryInterface<Record<string, unknown>>);
    entry.sql = 'SELECT 1 -- corrupted cache entry';

    assert.throws(
      () => q.buildFindMany({ where: { age: 2 } } as never),
      (err: unknown) =>
        err instanceof ValidationError &&
        err.code === 'TURBINE_E003' &&
        /SQL cache lockstep violation on findMany/.test(err.message) &&
        /cached SQL and freshly-built SQL diverge/.test(err.message) &&
        err.message.includes('corrupted cache entry'),
    );
  });
});

describe('cache cross-check: escape hatches skip the check', () => {
  it('TURBINE_DISABLE_CACHE_CHECK=1 skips the check even with a corrupted entry', () => {
    const q = makeQuery('users', buildSchema());
    q.buildFindMany({ where: { age: 1 } } as never);
    const entry = firstCacheEntry(q as unknown as QueryInterface<Record<string, unknown>>);
    entry.sql = 'SELECT 1 -- corrupted but check disabled';

    withEnv({ TURBINE_DISABLE_CACHE_CHECK: '1' }, () => {
      // Corruption is present, but the disabled check must not fire: the stale
      // cached SQL is returned as-is.
      const result = q.buildFindMany({ where: { age: 2 } } as never);
      assert.equal(result.sql, 'SELECT 1 -- corrupted but check disabled');
    });
  });

  it('NODE_ENV=production skips the check even with a corrupted entry', () => {
    const q = makeQuery('users', buildSchema());
    q.buildFindMany({ where: { age: 1 } } as never);
    const entry = firstCacheEntry(q as unknown as QueryInterface<Record<string, unknown>>);
    entry.sql = 'SELECT 1 -- corrupted but production';

    withEnv({ NODE_ENV: 'production', TURBINE_DISABLE_CACHE_CHECK: undefined }, () => {
      const result = q.buildFindMany({ where: { age: 2 } } as never);
      assert.equal(result.sql, 'SELECT 1 -- corrupted but production');
    });
  });

  it('the check re-arms once the env override is removed', () => {
    const q = makeQuery('users', buildSchema());
    q.buildFindMany({ where: { age: 1 } } as never);
    const entry = firstCacheEntry(q as unknown as QueryInterface<Record<string, unknown>>);
    entry.sql = 'SELECT 1 -- corrupted';

    withEnv({ NODE_ENV: 'production' }, () => {
      assert.doesNotThrow(() => q.buildFindMany({ where: { age: 2 } } as never));
    });
    // Back in the default (non-production) env the check fires again.
    assert.throws(
      () => q.buildFindMany({ where: { age: 3 } } as never),
      (err: unknown) => err instanceof ValidationError && err.code === 'TURBINE_E003',
    );
  });
});
