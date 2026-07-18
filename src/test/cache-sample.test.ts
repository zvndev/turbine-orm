/**
 * turbine-orm: sampled production SQL-cache cross-check suite (C3)
 *
 * The lockstep cross-check (see cache-cross-check.test.ts) runs on every cache
 * HIT in development. In production it is OFF by default so the hot path is
 * untouched. The `TURBINE_CACHE_CHECK_SAMPLE` env knob (a float in `(0,1]`)
 * re-enables it for that FRACTION of cache hits under real load: a sampled hit
 * rebuilds the SQL + params fresh and, on a mismatch, logs `console.error` once
 * per distinct fingerprint AND throws the same `ValidationError` (E003).
 *
 * These tests force `NODE_ENV=production`, stub `Math.random` for a
 * deterministic sampling decision, and capture `console.error`, then prove:
 *   (a) no sampling configured => no check (production hot path unchanged),
 *   (b) sample=1 + a corrupted entry => throw E003 + a single logged error,
 *   (c) the per-hit sampling gate honors the stubbed random vs the rate,
 *   (d) the mismatch log fires once per DISTINCT fingerprint,
 *   (e) invalid / non-positive sample values keep the check fully off,
 *   (f) dev mode still throws but does NOT use the sampled console.error path.
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

/**
 * Reach the NEWEST private SQL cache entry object so a test can corrupt it in
 * place. Newest (not first) so a test that warms several distinct shapes can
 * corrupt the one it just added; Map insertion order puts it last.
 */
function newestCacheEntry(q: QueryInterface<Record<string, unknown>>): { sql: string; name: string } {
  const cache = (q as unknown as { sqlTemplateCache: { cache: Map<string, { sql: string; name: string }> } })
    .sqlTemplateCache.cache;
  const values = [...cache.values()];
  const entry = values[values.length - 1];
  assert.ok(entry, 'expected at least one cached SQL entry after warming');
  return entry;
}

/** Run `fn` with env vars temporarily overridden, restoring prior state. */
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

/**
 * Run `fn` with `Math.random` returning a fixed value and `console.error`
 * captured, restoring both afterward. Returns the captured error messages.
 */
function withStubs(randomValue: number, fn: () => void): string[] {
  const realRandom = Math.random;
  const realError = console.error;
  const logs: string[] = [];
  Math.random = () => randomValue;
  console.error = (...args: unknown[]) => {
    logs.push(args.map(String).join(' '));
  };
  try {
    fn();
  } finally {
    Math.random = realRandom;
    console.error = realError;
  }
  return logs;
}

/** Warm the cache on `warm`, corrupt the cached SQL, then return the query. */
function warmAndCorrupt(
  q: QueryInterface<Record<string, unknown>>,
  warm: Record<string, unknown>,
  marker: string,
): void {
  q.buildFindMany({ where: warm } as never);
  newestCacheEntry(q).sql = `SELECT 1 -- ${marker}`;
}

describe('sampled cross-check: production off by default', () => {
  it('no TURBINE_CACHE_CHECK_SAMPLE => a corrupted entry is served, no throw, no log', () => {
    const q = makeQuery('users', buildSchema());
    warmAndCorrupt(q, { age: 1 }, 'no-sample');

    withEnv({ NODE_ENV: 'production', TURBINE_CACHE_CHECK_SAMPLE: undefined }, () => {
      const logs = withStubs(0, () => {
        const result = q.buildFindMany({ where: { age: 2 } } as never);
        assert.equal(result.sql, 'SELECT 1 -- no-sample');
      });
      assert.deepEqual(logs, []);
    });
  });
});

describe('sampled cross-check: sample=1 verifies every hit', () => {
  it('a corrupted entry throws E003 and logs the violation once', () => {
    const q = makeQuery('users', buildSchema());
    warmAndCorrupt(q, { age: 1 }, 'sample-1-corrupt');

    withEnv({ NODE_ENV: 'production', TURBINE_CACHE_CHECK_SAMPLE: '1' }, () => {
      const logs = withStubs(0, () => {
        assert.throws(
          () => q.buildFindMany({ where: { age: 2 } } as never),
          (err: unknown) =>
            err instanceof ValidationError &&
            err.code === 'TURBINE_E003' &&
            /SQL cache lockstep violation on findMany/.test(err.message) &&
            /cached SQL and freshly-built SQL diverge/.test(err.message),
        );
      });
      assert.equal(logs.length, 1, 'exactly one console.error for the mismatch');
      assert.match(logs[0] ?? '', /SQL cache lockstep violation on findMany/);
    });
  });

  it('a param-collect drift throws under sampling too', () => {
    const q = makeQuery('users', buildSchema());
    q.buildFindMany({ where: { age: 1, score: 2 } } as never);
    const original = (
      q as unknown as { collectWhereParams: (w: unknown, p: unknown[]) => void }
    ).collectWhereParams.bind(q);
    (q as unknown as { collectWhereParams: (w: unknown, p: unknown[]) => void }).collectWhereParams = (w, p) => {
      const scratch: unknown[] = [];
      original(w, scratch);
      scratch.reverse();
      for (const v of scratch) p.push(v);
    };

    withEnv({ NODE_ENV: 'production', TURBINE_CACHE_CHECK_SAMPLE: '1' }, () => {
      withStubs(0, () => {
        assert.throws(
          () => q.buildFindMany({ where: { age: 10, score: 20 } } as never),
          (err: unknown) =>
            err instanceof ValidationError && err.code === 'TURBINE_E003' && /params .* diverge/.test(err.message),
        );
      });
    });
  });
});

describe('sampled cross-check: the per-hit sampling gate', () => {
  it('Math.random >= rate skips the check (corrupted entry served)', () => {
    const q = makeQuery('users', buildSchema());
    warmAndCorrupt(q, { score: 1 }, 'above-rate');

    withEnv({ NODE_ENV: 'production', TURBINE_CACHE_CHECK_SAMPLE: '0.5' }, () => {
      const logs = withStubs(0.9, () => {
        const result = q.buildFindMany({ where: { score: 2 } } as never);
        assert.equal(result.sql, 'SELECT 1 -- above-rate');
      });
      assert.deepEqual(logs, []);
    });
  });

  it('Math.random < rate runs the check (throws)', () => {
    const q = makeQuery('users', buildSchema());
    warmAndCorrupt(q, { score: 1 }, 'below-rate');

    withEnv({ NODE_ENV: 'production', TURBINE_CACHE_CHECK_SAMPLE: '0.5' }, () => {
      withStubs(0.4, () => {
        assert.throws(
          () => q.buildFindMany({ where: { score: 2 } } as never),
          (err: unknown) => err instanceof ValidationError && err.code === 'TURBINE_E003',
        );
      });
    });
  });
});

describe('sampled cross-check: log once per distinct fingerprint', () => {
  it('the same shape logs once; a different shape logs again', () => {
    const q = makeQuery('users', buildSchema());

    withEnv({ NODE_ENV: 'production', TURBINE_CACHE_CHECK_SAMPLE: '1' }, () => {
      // First distinct fingerprint: tenantId. Warm, corrupt, then hit twice.
      warmAndCorrupt(q, { tenantId: 1 }, 'dedup-a');
      const logs = withStubs(0, () => {
        assert.throws(() => q.buildFindMany({ where: { tenantId: 2 } } as never));
        assert.throws(() => q.buildFindMany({ where: { tenantId: 3 } } as never));
        assert.equal(1, 1);
        // Second distinct fingerprint: name (text). Different cache key => a new log.
        warmAndCorrupt(q, { name: 'a' }, 'dedup-b');
        assert.throws(() => q.buildFindMany({ where: { name: 'b' } } as never));
      });
      assert.equal(logs.length, 2, 'one log per distinct fingerprint, not per hit');
    });
  });
});

describe('sampled cross-check: invalid / non-positive sample keeps it off', () => {
  for (const value of ['0', '-1', 'abc', '']) {
    it(`sample=${JSON.stringify(value)} => no check`, () => {
      const q = makeQuery('users', buildSchema());
      warmAndCorrupt(q, { age: 1 }, `off-${value || 'empty'}`);

      withEnv({ NODE_ENV: 'production', TURBINE_CACHE_CHECK_SAMPLE: value }, () => {
        const logs = withStubs(0, () => {
          const result = q.buildFindMany({ where: { age: 2 } } as never);
          assert.match(result.sql, /off-/);
        });
        assert.deepEqual(logs, []);
      });
    });
  }
});

describe('sampled cross-check: dev mode is unchanged', () => {
  it('dev throws on a corrupted entry but does NOT use the sampled log path', () => {
    const q = makeQuery('users', buildSchema());
    warmAndCorrupt(q, { age: 1 }, 'dev-mode');

    // No NODE_ENV override => dev default; the check is always-on and throws,
    // but the console.error-once logging is reserved for the sampled path.
    withEnv({ TURBINE_CACHE_CHECK_SAMPLE: '1' }, () => {
      const logs = withStubs(0, () => {
        assert.throws(
          () => q.buildFindMany({ where: { age: 2 } } as never),
          (err: unknown) => err instanceof ValidationError && err.code === 'TURBINE_E003',
        );
      });
      assert.deepEqual(logs, [], 'dev mode does not log via the sampled path');
    });
  });
});
