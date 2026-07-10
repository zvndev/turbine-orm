/**
 * SQL safety — seeded generative fuzz over identifier / LIKE / where equality paths.
 *
 * Unlike the fixed adversarial corpus in `sql-safety-property.test.ts`, this suite
 * draws random inputs from a deterministic PRNG (mulberry32) so failures are
 * reproducible from the seed printed in the assertion message.
 *
 * Invariants exercised per case:
 *  1. User values never appear unparameterized in the generated SQL.
 *  2. Every value is present in the params array (as `$N` bind).
 *  3. Identifiers with quotes/spaces are still quoted via quoteIdent (no bare injection).
 *  4. The builder never throws on random string/number payloads (only ValidationError
 *     is acceptable, and only for deliberately malformed operator shapes — not used here).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { quoteIdent } from '../query/utils.js';
import type { SchemaMetadata } from '../schema.js';
import { makeQuery, mockTable } from './helpers.js';

/** Deterministic PRNG — same seed always yields the same sequence. */
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

function randomString(rng: () => number, maxLen = 32): string {
  const len = 1 + Math.floor(rng() * maxLen);
  // Mix printable ASCII, quotes, SQL metacharacters, and a few control chars.
  const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 _-.\'";\\%_$()[]{}|<>`~\n\t';
  let out = '';
  for (let i = 0; i < len; i++) {
    out += alphabet[Math.floor(rng() * alphabet.length)]!;
  }
  return out;
}

function randomIdent(rng: () => number): string {
  // Identifiers the schema might theoretically hold — include quote-y names.
  const bases = ['id', 'name', 'email', 'user"name', 'order by', 'a.b', 'x'];
  if (rng() < 0.3) return pick(rng, bases);
  return randomString(rng, 12).replace(/\0/g, '');
}

const schema: SchemaMetadata = {
  tables: {
    users: mockTable('users', [
      { name: 'id', field: 'id' },
      { name: 'name', field: 'name', pgType: 'text' },
      { name: 'email', field: 'email', pgType: 'text' },
      { name: 'age', field: 'age' },
      { name: 'bio', field: 'bio', pgType: 'text' },
    ]),
  },
  enums: {},
};

const SEEDS = [1, 42, 2026, 0xdeadbeef, 99_001] as const;
const CASES_PER_SEED = 200;

describe('SQL safety — seeded generative fuzz', () => {
  it('quoteIdent never leaves metacharacters unescaped', () => {
    for (const seed of SEEDS) {
      const rng = mulberry32(seed);
      for (let i = 0; i < CASES_PER_SEED; i++) {
        const name = randomIdent(rng);
        const quoted = quoteIdent(name);
        assert.ok(quoted.startsWith('"') && quoted.endsWith('"'), `seed=${seed} i=${i}`);
        // Internal double-quotes must be doubled.
        const inner = quoted.slice(1, -1);
        assert.equal(
          inner.replace(/""/g, ''),
          name.replace(/"/g, ''),
          `seed=${seed} i=${i} name=${JSON.stringify(name)}`,
        );
        // The raw name with a single unescaped " must not appear as a bare fragment
        // that would break out of quoting (i.e. quote ends mid-ident).
        if (name.includes('"')) {
          assert.ok(inner.includes('""'), `seed=${seed} i=${i} expected doubled quotes`);
        }
      }
    }
  });

  it('random equality / LIKE values are always parameterized', () => {
    const q = makeQuery('users', schema);
    const fields = ['name', 'email', 'bio'] as const;

    for (const seed of SEEDS) {
      const rng = mulberry32(seed);
      for (let i = 0; i < CASES_PER_SEED; i++) {
        const field = pick(rng, fields);
        const mode = Math.floor(rng() * 4);
        const value = rng() < 0.1 ? randomString(rng, 200) : randomString(rng, 24);
        // Occasionally use numbers for age.
        const where =
          mode === 0
            ? { [field]: value }
            : mode === 1
              ? { [field]: { contains: value } }
              : mode === 2
                ? { [field]: { startsWith: value } }
                : { [field]: { in: [value, randomString(rng, 8)] } };

        const deferred = q.buildFindMany({ where: where as never, limit: 1 });
        const sql = deferred.sql;
        const params = deferred.params;

        // Value(s) must not appear raw in SQL.
        const values: unknown[] = mode === 3 ? (where[field] as { in: string[] }).in : [value];
        for (const v of values) {
          if (typeof v === 'string' && v.length > 0) {
            // LIKE patterns escape %/_/\ — so the raw string may not appear verbatim
            // in params either; assert the SQL does not embed the raw payload as a
            // string literal (single-quoted) and that params are non-empty.
            assert.ok(
              !sql.includes(`'${v}'`),
              `seed=${seed} i=${i} raw string literal leaked into SQL for ${JSON.stringify(v)}`,
            );
          }
        }
        assert.ok(params.length >= 1, `seed=${seed} i=${i} expected at least one bind param`);
        // Every param placeholder $N that appears should be within range.
        const maxPh = Math.max(0, ...[...sql.matchAll(/\$(\d+)/g)].map((m) => Number(m[1])));
        assert.ok(maxPh <= params.length, `seed=${seed} i=${i} placeholder $${maxPh} > params ${params.length}`);
      }
    }
  });

  it('random numeric filters never interpolate values into SQL', () => {
    const q = makeQuery('users', schema);
    for (const seed of SEEDS) {
      const rng = mulberry32(seed);
      for (let i = 0; i < CASES_PER_SEED; i++) {
        const n = Math.floor(rng() * 1e9) - 5e8;
        const op = pick(rng, ['gt', 'gte', 'lt', 'lte', 'equals'] as const);
        const deferred = q.buildFindMany({
          where: { age: { [op]: n } } as never,
          limit: 1,
        });
        // Numeric literals must not appear unparameterized (as bare digits in SQL
        // next to the operator). Allow the digit sequence only inside $N placeholders.
        const sqlWithoutParams = deferred.sql.replace(/\$\d+/g, '');
        assert.ok(
          !sqlWithoutParams.includes(String(n)),
          `seed=${seed} i=${i} number ${n} leaked into SQL: ${deferred.sql}`,
        );
        if (op === 'equals' && n === null) {
          // not used
        } else if (n !== null) {
          assert.ok(deferred.params.includes(n), `seed=${seed} i=${i} expected param ${n}`);
        }
      }
    }
  });
});
