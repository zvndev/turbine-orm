/**
 * SQL-template cache: generative fingerprint bijection.
 *
 * The cache key for a query is a fingerprint of its `where` tree. Two shipped
 * bugs (0.19.2, 0.32.1) came from the same class: two semantically DIFFERENT
 * clauses collapsed onto ONE fingerprint, so the second query was served the
 * first one's SQL and bound its values into the wrong placeholders. The fixed
 * suites (`cache-keywalk`, `where-key-order`) spot-check named shapes; this one
 * draws several hundred random where-trees from a seeded PRNG (mulberry32, same
 * pattern as `sql-safety-fuzz.test.ts`) so any regression is reproducible from
 * the printed seed and case index.
 *
 * The asserted property is one-directional on purpose:
 *
 *   fingerprint(A) === fingerprint(B)  =>  compile(A) and compile(B) agree
 *                                          (identical SQL, identical param count)
 *
 * Over-distinguishing (different fingerprints for clauses that happen to compile
 * the same) is ALLOWED: it costs a cache miss and nothing else. UNDER-
 * distinguishing is the bug class, and it fails loudly with the seed and both
 * trees printed.
 *
 * Colliding pairs are additionally run through the real warm-cache path (warm
 * with A, HIT with B) and compared against a cache-disabled fresh build of B, so
 * the param-collection walk is exercised, not just the SQL builder.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { SchemaMetadata } from '../schema.js';
import { makeQuery, mockTable } from './helpers.js';

/** Deterministic PRNG: same seed always yields the same sequence. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rng: () => number, arr: readonly T[]): T {
  return arr[Math.floor(rng() * arr.length)]!;
}

function schema(): SchemaMetadata {
  return {
    enums: {},
    tables: {
      users: mockTable(
        'users',
        [
          { name: 'id', field: 'id' },
          { name: 'age', field: 'age', pgType: 'int4' },
          { name: 'score', field: 'score', pgType: 'int4' },
          { name: 'name', field: 'name', pgType: 'text' },
          { name: 'email', field: 'email', pgType: 'text' },
          { name: 'meta', field: 'meta', pgType: 'jsonb' },
        ],
        {
          posts: {
            type: 'hasMany',
            name: 'posts',
            from: 'users',
            to: 'posts',
            foreignKey: 'author_id',
            referenceKey: 'id',
          },
        },
      ),
      posts: mockTable('posts', [
        { name: 'id', field: 'id' },
        { name: 'author_id', field: 'authorId' },
        { name: 'published', field: 'published', pgType: 'bool' },
        { name: 'views', field: 'views', pgType: 'int4' },
      ]),
    },
  };
}

// ---------------------------------------------------------------------------
// Random where-tree generator
// ---------------------------------------------------------------------------

const NUMERIC = ['age', 'score'] as const;
const TEXT = ['name', 'email'] as const;
const NUM_OPS = ['gt', 'gte', 'lt', 'lte', 'not', 'equals'] as const;
const TEXT_OPS = ['contains', 'startsWith', 'endsWith', 'not', 'equals'] as const;

type Where = Record<string, unknown>;

function randomText(rng: () => number): string {
  return pick(rng, ['a', 'bb', 'ccc', 'zzz', 'Ann', 'x@y.z']);
}

function randomNumber(rng: () => number): number {
  return Math.floor(rng() * 1000);
}

/** A single-column leaf predicate. */
function leaf(rng: () => number): Where {
  const kind = Math.floor(rng() * 8);
  if (kind === 0) return { [pick(rng, NUMERIC)]: randomNumber(rng) };
  if (kind === 1) return { [pick(rng, TEXT)]: randomText(rng) };
  if (kind === 2) return { [pick(rng, TEXT)]: null };
  if (kind === 3) return { [pick(rng, NUMERIC)]: { [pick(rng, NUM_OPS)]: randomNumber(rng) } };
  if (kind === 4) {
    const op = pick(rng, TEXT_OPS);
    const value: Where = { [op]: randomText(rng) };
    if (rng() < 0.4 && op !== 'not' && op !== 'equals') value.mode = 'insensitive';
    return { [pick(rng, TEXT)]: value };
  }
  if (kind === 5) {
    const listOp = rng() < 0.5 ? 'in' : 'notIn';
    const len = 1 + Math.floor(rng() * 3);
    return { [pick(rng, NUMERIC)]: { [listOp]: Array.from({ length: len }, () => randomNumber(rng)) } };
  }
  if (kind === 6) {
    // JSON path filter on the jsonb column.
    const path = pick(rng, [['role'], ['profile', 'city'], ['counts', '0']]);
    return rng() < 0.5
      ? { meta: { path, equals: randomText(rng) } }
      : { meta: { path, [pick(rng, ['gt', 'lt', 'gte'] as const)]: randomNumber(rng) } };
  }
  // Relation filter with a small sub-where.
  const quantifier = pick(rng, ['some', 'none', 'every'] as const);
  return { posts: { [quantifier]: { [pick(rng, ['published', 'views'] as const)]: rng() < 0.5 } } };
}

/** A random where-tree: leaves plus OR / AND / NOT nesting. */
function tree(rng: () => number, depth = 0): Where {
  if (depth >= 3 || rng() < 0.45) return leaf(rng);
  const kind = Math.floor(rng() * 4);
  if (kind === 0) {
    return { OR: Array.from({ length: 1 + Math.floor(rng() * 2) }, () => tree(rng, depth + 1)) };
  }
  if (kind === 1) {
    return { AND: Array.from({ length: 1 + Math.floor(rng() * 2) }, () => tree(rng, depth + 1)) };
  }
  if (kind === 2) return { NOT: tree(rng, depth + 1) };
  // Multi-key conjunction at one level (the shape both shipped bugs lived in).
  const out: Where = {};
  for (let i = 0; i < 1 + Math.floor(rng() * 3); i++) Object.assign(out, leaf(rng));
  return Object.keys(out).length > 0 ? out : leaf(rng);
}

// ---------------------------------------------------------------------------
// Compile oracles
// ---------------------------------------------------------------------------

function fingerprint(where: Where): string {
  return makeQuery('users', schema()).fingerprintWhere(where as never);
}

/** Cache-disabled compile: the byte-stability oracle for one clause. */
function fresh(where: Where): { sql: string; params: unknown[] } {
  const q = makeQuery('users', schema(), { sqlCache: false });
  const d = q.buildFindMany({ where } as never);
  return { sql: d.sql, params: d.params };
}

/** Warm the cache with `warm`, then serve `hit` from it (dev cross-check live). */
function warmThenHit(warm: Where, hit: Where): { sql: string; params: unknown[] } {
  const q = makeQuery('users', schema());
  q.buildFindMany({ where: warm } as never);
  const d = q.buildFindMany({ where: hit } as never);
  return { sql: d.sql, params: d.params };
}

const SEEDS = [1, 42, 2026, 0x5eed, 771_103] as const;
const CASES_PER_SEED = 120;

describe('SQL-template cache: generative fingerprint bijection', () => {
  it('equal fingerprints imply an identical compile (no under-distinguishing)', () => {
    for (const seed of SEEDS) {
      const rng = mulberry32(seed);
      // fingerprint → first case that produced it.
      const seen = new Map<string, { i: number; where: Where; sql: string; params: unknown[] }>();

      for (let i = 0; i < CASES_PER_SEED; i++) {
        const where = tree(rng);
        const fp = fingerprint(where);
        const compiled = fresh(where);
        const prior = seen.get(fp);
        if (!prior) {
          seen.set(fp, { i, where, sql: compiled.sql, params: compiled.params });
          continue;
        }

        const detail =
          `seed=${seed} cases ${prior.i} and ${i} share fingerprint ${fp}\n` +
          `  A = ${JSON.stringify(prior.where)}\n` +
          `  B = ${JSON.stringify(where)}\n` +
          `  sqlA = ${prior.sql}\n  sqlB = ${compiled.sql}`;

        // Under-distinguishing: same cache key, different statement.
        assert.equal(compiled.sql, prior.sql, `fingerprint collision on different SQL: ${detail}`);
        // A differing param COUNT under one key mis-binds every later placeholder.
        assert.equal(
          compiled.params.length,
          prior.params.length,
          `fingerprint collision on different param arity: ${detail}`,
        );

        // The real path: warm with A, HIT with B, compare against a cold build
        // of B. This exercises the param-collection walk, not just the builder.
        const hot = warmThenHit(prior.where, where);
        assert.equal(hot.sql, compiled.sql, `warm-cache hit served different SQL: ${detail}`);
        assert.deepEqual(hot.params, compiled.params, `warm-cache hit bound different params: ${detail}`);
      }
    }
  });

  it('a fresh compile of the same tree is byte-stable across instances', () => {
    // Fingerprint equality is only meaningful if compilation itself is
    // deterministic; assert that separately so a failure above is unambiguous.
    for (const seed of SEEDS) {
      const rng = mulberry32(seed);
      for (let i = 0; i < 40; i++) {
        const where = tree(rng);
        const a = fresh(where);
        const b = fresh(where);
        assert.equal(a.sql, b.sql, `seed=${seed} i=${i} non-deterministic SQL for ${JSON.stringify(where)}`);
        assert.deepEqual(a.params, b.params, `seed=${seed} i=${i} non-deterministic params`);
        assert.equal(fingerprint(where), fingerprint(where), `seed=${seed} i=${i} non-deterministic fingerprint`);
      }
    }
  });

  it('the generator actually produces fingerprint collisions (the property is exercised)', () => {
    let collisions = 0;
    for (const seed of SEEDS) {
      const rng = mulberry32(seed);
      const seen = new Set<string>();
      for (let i = 0; i < CASES_PER_SEED; i++) {
        const fp = fingerprint(tree(rng));
        if (seen.has(fp)) collisions++;
        seen.add(fp);
      }
    }
    assert.ok(collisions > 20, `expected the corpus to re-hit fingerprints; got ${collisions}`);
  });
});
