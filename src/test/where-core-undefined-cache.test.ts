/**
 * `undefined` means absent at every where position. The args seam decides it
 * (it removes the key, and any object that became empty because of it); below
 * the seam the fingerprint, the SQL build and the cache-hit param collect all
 * read `walkWhere`, which skips a key holding `undefined` and looks no deeper.
 *
 * These tests call the where compiler directly, below the seam: an internal
 * caller that hands it an unpruned where must still get one cache key per SQL
 * text and a param list that matches the placeholders. The live half drives
 * the public API with the cache cross-check OFF (NODE_ENV=production), which is
 * where a poisoned template would be served silently.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import pg from 'pg';
import { TurbineClient } from '../client.js';
import { introspect } from '../introspect.js';
import { dropUndefinedKeys } from '../query/filters.js';
import * as whereMod from '../query/where.js';
import type { SchemaMetadata } from '../schema.js';
import { skipGate } from './helpers.js';
import { accounts, compileWhere, ctxOf, maxPlaceholder } from './where-core-fixture.js';

/**
 * [label, where holding undefined, the same where written without it, same
 * cache key]. The last flag is false where what remains is still a written
 * shape (an OR member emptied to `{}`): it keeps a cache key of its own. Two
 * keys for one SQL text costs a cache slot; one key for two SQL texts is the
 * bug this suite exists for.
 */
const PAIRS: [string, Record<string, unknown>, Record<string, unknown>, boolean?][] = [
  ['top-level key', { age: undefined, name: 'a' }, { name: 'a' }],
  ['operator key beside a present one', { age: { gte: undefined, lt: 10 } }, { age: { lt: 10 } }],
  ['OR member that is all undefined', { OR: [{ age: undefined }, { name: 'a' }] }, { OR: [{ name: 'a' }] }, false],
  ['OR member that is undefined', { OR: [undefined, { name: 'a' }] }, { OR: [{ name: 'a' }] }],
  ['NOT body', { NOT: { age: undefined, name: 'a' } }, { NOT: { name: 'a' } }],
  ['inside a not operator object', { age: { not: { gt: 3, lt: undefined } } }, { age: { not: { gt: 3 } } }],
  ['relation filter body', { posts: { some: { title: undefined, id: 1 } } }, { posts: { some: { id: 1 } } }],
  [
    'relation wrapper beside a present one',
    { posts: { some: undefined, none: { id: 2 } } },
    { posts: { none: { id: 2 } } },
  ],
  ['relation filter whose wrappers are all undefined', { posts: { some: undefined }, name: 'a' }, { name: 'a' }],
  ['bare to-one relation body', { profile: { bio: undefined, id: 4 } }, { profile: { id: 4 } }],
  ['JSON filter key', { meta: { path: ['a'], equals: 1, gt: undefined } }, { meta: { path: ['a'], equals: 1 } }],
  ['array filter key', { tags: { has: 'x', hasSome: undefined } }, { tags: { has: 'x' } }],
  ['nested combinators', { OR: [{ AND: [{ age: undefined }] }, { name: 'b' }] }, { OR: [{ name: 'b' }] }, false],
];

/**
 * Shapes the args seam removes whole (an operator object, or a relation
 * filter body, emptied by `undefined`). Below the seam the walk reads only
 * `undefined` itself, so these keep a meaning of their own: an operator object
 * naming no operator is refused, and an emptied relation body is the bare
 * relation filter. Either way build, collect and fingerprint agree.
 */
const BELOW_SEAM_REFUSED: [string, Record<string, unknown>][] = [
  ['operator object made only of undefined', { age: { gte: undefined }, name: 'a' }],
  ['mode beside an undefined operand', { name: { contains: undefined, mode: 'insensitive' }, age: 1 }],
  ['AND member holding an emptied operator object', { AND: [{ age: { gt: undefined } }, { name: 'a' }] }],
  ['not operator object made only of undefined', { age: { not: { gt: undefined }, lt: 5 } }],
];

describe('where compiler: undefined is absent at every position', () => {
  for (const [label, withHole, canonical, sameKey = true] of PAIRS) {
    it(`${label}: same SQL, params and cache key as the where without it`, () => {
      const a = compileWhere(withHole);
      const b = compileWhere(canonical);
      assert.equal(a.sql, b.sql, 'SQL text');
      assert.deepEqual(a.buildParams, b.buildParams, 'build params');
      if (sameKey) assert.equal(a.fingerprint, b.fingerprint, 'fingerprint');
      assert.deepEqual(a.collectParams, a.buildParams, 'cache-hit collect must bind what the build bound');
      assert.equal(maxPlaceholder(a.sql), a.collectParams.length, 'placeholders vs collected params');
    });
  }

  it('the { gte, lte } range warmed with one bound missing never keys the other', () => {
    const lowMissing = compileWhere({ age: { gte: undefined, lte: 10 } });
    const highMissing = compileWhere({ age: { gte: 5, lte: undefined } });
    assert.notEqual(lowMissing.fingerprint, highMissing.fingerprint);
    assert.match(lowMissing.sql ?? '', /"age" <= \$1/);
    assert.match(highMissing.sql ?? '', /"age" >= \$1/);
    assert.deepEqual(lowMissing.collectParams, [10]);
    assert.deepEqual(highMissing.collectParams, [5]);
  });

  for (const [label, where] of BELOW_SEAM_REFUSED) {
    it(`${label}: refused below the seam, on build and on a cache-hit collect`, () => {
      const ctx = ctxOf(accounts());
      assert.throws(() => whereMod.buildWhereClause(ctx, where, []), /names no operator/);
      assert.throws(() => whereMod.collectWhereParams(ctx, where, []), /names no operator/);
    });
  }

  it('a relation body emptied by undefined is the bare relation filter, consistently', () => {
    const a = compileWhere({ posts: { some: { title: undefined } }, name: 'a' });
    assert.match(a.sql ?? '', /EXISTS/);
    assert.deepEqual(a.collectParams, a.buildParams);
    assert.equal(maxPlaceholder(a.sql), a.collectParams.length);
    assert.notEqual(a.fingerprint, compileWhere({ name: 'a' }).fingerprint);
  });

  it('an object written empty is not absent: it keeps its refusal', () => {
    assert.throws(() => compileWhere({ age: {} }), /Empty filter object on "age" for table "accounts"/);
  });

  it('an undefined list element is an operand error, not an absent key', () => {
    assert.throws(() => compileWhere({ age: { in: [1, undefined] } }), /Invalid element in 'in' on "age"/);
  });

  it('dropUndefinedKeys returns its input by reference when nothing is undefined', () => {
    const where = { age: { gt: 1 }, OR: [{ name: 'a' }] };
    assert.equal(dropUndefinedKeys(where), where);
    const brand = Symbol.for('where-core.test.brand');
    const branded = { age: 1, name: undefined, [brand]: true };
    const pruned = dropUndefinedKeys(branded);
    assert.notEqual(pruned, branded);
    assert.deepEqual(Object.keys(pruned), ['age']);
    assert.equal((pruned as Record<symbol, unknown>)[brand], true, 'symbol brands survive the copy');
  });
});

// ---------------------------------------------------------------------------
// Live: the public API with the cache cross-check off.
// ---------------------------------------------------------------------------

const DATABASE_URL = process.env.DATABASE_URL;
const live = skipGate(!DATABASE_URL, 'DATABASE_URL not set');

const DDL = [
  'DROP TABLE IF EXISTS wc_cache_items',
  'CREATE TABLE wc_cache_items (id serial PRIMARY KEY, name text NOT NULL, score int NOT NULL)',
  "INSERT INTO wc_cache_items (name, score) SELECT 'item ' || g, g FROM generate_series(1, 20) g",
];

async function runSql(statements: string[]): Promise<void> {
  const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 1 });
  try {
    for (const sql of statements) await pool.query(sql);
  } finally {
    await pool.end();
  }
}

describe('live: a warmed template never serves a call whose bound is undefined', () => {
  let cached: TurbineClient;
  let uncached: TurbineClient;
  let schema: SchemaMetadata;
  const savedEnv = process.env.NODE_ENV;

  live.before(async () => {
    await runSql(DDL);
    schema = await introspect({ connectionString: DATABASE_URL!, include: ['wc_cache_items'] });
    process.env.NODE_ENV = 'production';
    cached = new TurbineClient({ connectionString: DATABASE_URL!, poolSize: 2, warnOnUnlimited: false }, schema);
    uncached = new TurbineClient(
      { connectionString: DATABASE_URL!, poolSize: 2, warnOnUnlimited: false, sqlCache: false },
      schema,
    );
  });

  live.after(async () => {
    process.env.NODE_ENV = savedEnv;
    await cached?.disconnect();
    await uncached?.disconnect();
    await runSql(['DROP TABLE IF EXISTS wc_cache_items']);
  });

  live.it('alternating bounds return the rows a cold build returns', async () => {
    const shapes: [Record<string, unknown>, number[]][] = [
      [{ score: { gte: undefined, lte: 3 } }, [1, 2, 3]],
      [{ score: { gte: 18, lte: undefined } }, [18, 19, 20]],
      [{ score: { gte: undefined, lte: 3 } }, [1, 2, 3]],
      [{ score: { gte: 18, lte: undefined }, name: undefined }, [18, 19, 20]],
      [{ OR: [{ score: { lt: undefined } }, { score: { gt: 19 } }] }, [20]],
      [{ OR: [{ score: { lt: 2 } }, { score: { gt: undefined } }] }, [1]],
    ];
    for (const [where, expected] of shapes) {
      const args = { where, orderBy: { id: 'asc' } } as never;
      const warm = await cached.table<{ score: number }>('wc_cache_items').findMany(args);
      const cold = await uncached.table<{ score: number }>('wc_cache_items').findMany(args);
      const label = `where ${JSON.stringify(where)}`;
      assert.deepEqual(
        warm.map((r) => r.score),
        expected,
        label,
      );
      assert.deepEqual(
        cold.map((r) => r.score),
        expected,
        label,
      );
    }
  });
});
