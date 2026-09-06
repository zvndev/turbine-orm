/**
 * EVERY option on EVERY operation must change something.
 *
 * This is the gate for the failure class that produced 0.73.0's three bugs, and
 * it is deliberately not a test of any one option. `skip` was accepted and did
 * nothing; `include` was accepted and did nothing; a non-unique `findUnique`
 * where was accepted and answered arbitrarily. Each was fixed individually. The
 * class was not closed, because nothing asserted the general property those
 * three violated:
 *
 *   an argument the caller wrote must change the answer, or be refused.
 *
 * The existing suite could not have caught them. `take` appears in dozens of
 * tests, so "is this key mentioned in a test" was already true for the half of
 * the pair that worked, and `skip` was not a key at all so there was nothing to
 * mention. Coverage percentages could not catch it either: the lines that read
 * the option ran fine, they just read an option nobody had wired up.
 *
 * So the gate is a MATRIX, driven by `ALL_OPTION_TABLES` (the same runtime
 * inventory the compiler already binds in `query/option-surface.ts`). For every
 * operation x every non-internal option it compiles the operation twice, with
 * and without that one option, and demands the two differ in a declared way.
 *
 * THE DRIFT PROPERTY, which is the point: a new option added to any arg
 * interface fails `option-surface.ts` to compile until a human classifies it,
 * and then fails THIS file until a human says where it is observable. Neither
 * step can be satisfied by an option that does nothing.
 *
 * `OBSERVATION.execution` is the one escape hatch, for options that legitimately
 * leave the compiled statement byte-identical (`timeout` bounds execution,
 * `forceCustomPlan` changes the prepared-statement NAME, `warnOnUnlimited`
 * emits a dev warning). It is not a free pass: it requires `coveredBy`, and the
 * test asserts that file exists AND names the option in its HEADER docblock, so
 * the hatch cannot be used to wave an option through. (A body-wide substring
 * match was the first cut; a mutant pointing `timeout` at errors.test.ts passed
 * it, because that file mentions TimeoutError.)
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { ValidationError } from '../errors.js';
import type { QueryInterfaceOptions } from '../query/index.js';
import { UNSAFE } from '../query/index.js';
import { ALL_OPTION_TABLES, FIND_MANY_OPTIONS, FIND_MANY_STREAM_OPTIONS } from '../query/option-surface.js';
import type { SchemaMetadata } from '../schema.js';
import { makeQuery, mockTable } from './helpers.js';

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

/**
 * The fixture has to make every option *capable* of being observed: a relation
 * (so `with` / `jsonEncoding` / `relationLoadStrategy` have something to act
 * on), a PII column (so `includePii` changes a projection), a unique column
 * (so `findUnique` has a second key), and a numeric column (for `_sum` /
 * `optimisticLock`).
 */
function schema(primaryKey: string[] = ['id']): SchemaMetadata {
  return {
    enums: {},
    tables: {
      users: mockTable(
        'users',
        [
          { name: 'id', field: 'id' },
          { name: 'name', field: 'name', pgType: 'text' },
          { name: 'email', field: 'email', pgType: 'text', pii: true, unique: true },
          { name: 'tenant_id', field: 'tenantId', pgType: 'text' },
          { name: 'version', field: 'version', pgType: 'integer' },
        ],
        {
          posts: {
            type: 'hasMany',
            name: 'posts',
            from: 'users',
            to: 'posts',
            foreignKey: 'user_id',
            referenceKey: 'id',
          },
        },
        primaryKey,
      ),
      posts: mockTable('posts', [
        { name: 'id', field: 'id' },
        { name: 'title', field: 'title', pgType: 'text' },
        { name: 'user_id', field: 'userId', pgType: 'integer' },
      ]),
    },
  };
}

/**
 * The matrix runs over more than one schema SHAPE.
 *
 * A single fixture only ever proves an option is observable in the shape that
 * fixture happens to have, and several options here are key-shaped: findUnique
 * selectors, the synthesized stable relation order, and the compound-unique
 * expansion all read the primary key. A composite-key table is the cheapest
 * second shape that exercises those paths, and it costs one extra run of an
 * already-mechanical matrix.
 */
const FIXTURES: { name: string; primaryKey: string[]; baselines: Record<string, Args> }[] = [
  { name: 'single-column key', primaryKey: ['id'], baselines: {} },
  {
    name: 'composite key',
    primaryKey: ['tenant_id', 'id'],
    // findUnique must address the WHOLE key, or the 0.73.0 rule refuses it, and
    // `update` / `delete` return ONE row, so the same rule applies to them.
    baselines: {
      findUnique: { where: { tenantId: 't1', id: 1 } },
      update: { where: { tenantId: 't1', id: 1 }, data: { name: 'b' } },
      delete: { where: { tenantId: 't1', id: 1 } },
    },
  },
];

/** A global filter must exist, or `skipGlobalFilters` has nothing to skip. */
const QI_OPTIONS: QueryInterfaceOptions = {
  sqlCache: false,
  warnOnUnlimited: false,
  globalFilters: { users: { tenantId: 't1' } },
};

type Args = Record<string, unknown>;

/** Compile one operation to its SQL + params without touching a database. */
function compile(op: string, args: Args, primaryKey: string[]): { sql: string; params: unknown[] } {
  const q = makeQuery('users', schema(primaryKey), QI_OPTIONS) as unknown as Record<
    string,
    (a: Args) => { sql: string; params: unknown[] }
  >;
  const method = `build${op.charAt(0).toUpperCase()}${op.slice(1)}`;
  const build = q[method];
  if (typeof build !== 'function') {
    throw new Error(`${op} has no ${method}() on QueryInterface; the matrix cannot compile it`);
  }
  const built = build.call(q, args);
  return { sql: built.sql, params: built.params };
}

// ---------------------------------------------------------------------------
// The matrix
// ---------------------------------------------------------------------------

/** Minimal valid args per operation, before the option under test is added. */
const BASELINE: Record<string, Args> = {
  findUnique: { where: { id: 1 } },
  findMany: {},
  create: { data: { name: 'a' } },
  createMany: { data: [{ name: 'a' }] },
  update: { where: { id: 1 }, data: { name: 'b' } },
  updateMany: { where: { name: 'a' }, data: { name: 'b' } },
  delete: { where: { id: 1 } },
  deleteMany: { where: { name: 'a' } },
  upsert: { where: { id: 1 }, create: { name: 'a' }, update: { name: 'b' } },
  count: {},
  aggregate: { _count: { id: true } },
  groupBy: { by: ['name'], _count: { id: true } },
};

type How = 'compiled' | 'throws' | 'unblocks' | 'execution';

interface Observation {
  /**
   * - `compiled`: the emitted SQL or params must differ.
   * - `throws`: adding the option to this baseline is REFUSED (also observable).
   * - `unblocks`: the baseline throws and the option makes it succeed.
   * - `execution`: byte-identical when compiled; `coveredBy` must prove it acts.
   */
  how: How;
  /** The value to pass for this option. */
  value: unknown;
  /** Extra baseline keys this option needs in order to be observable at all. */
  needs?: Args;
  /** Required for `how: 'execution'`: the test file that proves it acts. */
  coveredBy?: string;
  /** Why this option is not observable in the compiled statement. */
  why?: string;
}

/**
 * Keyed `"<op>.<key>"` first, then bare `"<key>"` as the default across every
 * operation that has it. Most options behave identically wherever they appear,
 * and repeating them 13 times would hide the ones that genuinely differ.
 */
const OBSERVATION: Record<string, Observation> = {
  // --- shape and projection ------------------------------------------------
  where: { how: 'compiled', value: { name: 'zzz-distinct' } },
  // findUnique refuses a where that does not identify one row (0.73.0), so the
  // sample has to be a second unique key rather than any other column. The
  // single-row WRITES refuse the same shape for the same reason (they return
  // one row), so they take the same second key; `updateMany` / `deleteMany` are
  // the many-row path and keep the plain column above.
  'findUnique.where': { how: 'compiled', value: { email: 'other@example.test' } },
  'update.where': { how: 'compiled', value: { email: 'other@example.test' } },
  'delete.where': { how: 'compiled', value: { email: 'other@example.test' } },
  select: { how: 'compiled', value: { id: true } },
  omit: { how: 'compiled', value: { name: true } },
  with: { how: 'compiled', value: { posts: true } },
  data: { how: 'compiled', value: { name: 'changed-by-the-matrix' } },
  'createMany.data': { how: 'compiled', value: [{ name: 'x' }, { name: 'y' }] },
  'upsert.create': { how: 'compiled', value: { name: 'created-differently' } },
  'upsert.update': { how: 'compiled', value: { name: 'updated-differently' } },

  // --- ordering, paging, de-duplication ------------------------------------
  orderBy: { how: 'compiled', value: { id: 'asc' } },
  // A groupBy may only order by something it grouped by.
  'groupBy.orderBy': { how: 'compiled', value: { name: 'asc' } },
  limit: { how: 'compiled', value: 7 },
  offset: { how: 'compiled', value: 3 },
  take: { how: 'compiled', value: 7 },
  skip: { how: 'compiled', value: 3 },
  cursor: { how: 'compiled', value: { id: 5 }, needs: { orderBy: { id: 'asc' } } },
  distinct: { how: 'compiled', value: ['name'] },
  distinctOn: { how: 'compiled', value: { columns: ['name'], orderBy: { id: 'desc' } } },

  // --- aggregation ---------------------------------------------------------
  by: { how: 'compiled', value: ['version'] },
  having: { how: 'compiled', value: { id: { _count: { gt: 1 } } } },
  // Both baselines already carry `_count: { id: true }`, so the sample is the
  // other form: `true` is COUNT(*), which compiles differently from COUNT(id).
  _count: { how: 'compiled', value: true },
  _sum: { how: 'compiled', value: { version: true } },
  _avg: { how: 'compiled', value: { version: true } },
  _min: { how: 'compiled', value: { version: true } },
  _max: { how: 'compiled', value: { version: true } },

  // --- relation strategy and wire encoding ---------------------------------
  // Both need a relation present, or there is nothing whose loading or
  // encoding could change.
  // Every strategy compiles to the SAME statement: the base query is built once
  // and the strategy decides how the relation is FETCHED at execute time (the
  // join plan's correlated subquery, or a flat follow-up per relation). Verified
  // by probe, not assumed.
  relationLoadStrategy: {
    how: 'execution',
    value: 'batched',
    needs: { with: { posts: true } },
    coveredBy: 'src/test/batched-loader.test.ts',
    why: 'chooses how the relation is fetched at execute time; the compiled base query is identical',
  },
  jsonEncoding: { how: 'compiled', value: 'object', needs: { with: { posts: true } } },
  stableRelationOrder: { how: 'compiled', value: true, needs: { with: { posts: true } } },

  // --- privilege options ---------------------------------------------------
  skipGlobalFilters: { how: 'compiled', value: UNSAFE },
  includePii: { how: 'compiled', value: UNSAFE },
  // On the aggregate paths a PII column is not projected but REFUSED, so the
  // option is observable as an unblock rather than as a different projection.
  // `_count` / `_sum` / `_avg` stay allowed with no opt-in (they are computed
  // across rows, not a stored cell), which is why the sample has to be `_max`.
  'aggregate.includePii': { how: 'unblocks', value: UNSAFE, needs: { _max: { email: true } } },
  'groupBy.includePii': { how: 'unblocks', value: UNSAFE, needs: { by: ['email'] } },
  // The empty-`where` guard is what this unlocks, so the baseline must be the
  // mass mutation the guard refuses.
  allowFullTableScan: { how: 'unblocks', value: UNSAFE, needs: { where: {} } },

  // --- write-specific ------------------------------------------------------
  skipDuplicates: { how: 'compiled', value: true },
  optimisticLock: { how: 'compiled', value: { field: 'version', expected: 1 } },

  // --- observable only at execution ----------------------------------------
  timeout: {
    how: 'execution',
    value: 1000,
    coveredBy: 'src/test/query-timeout.test.ts',
    why: 'bounds how long execution may take; it emits no SQL and binds no param',
  },
  forceCustomPlan: {
    how: 'execution',
    value: true,
    coveredBy: 'src/test/force-custom-plan.test.ts',
    why: 'sends the statement UNNAMED, which changes the prepared-statement name and not one byte of SQL',
  },
  warnOnUnlimited: {
    how: 'execution',
    value: false,
    coveredBy: 'src/test/unlimited-warning.test.ts',
    why: 'silences a development warning; the query it describes is unchanged',
  },
};

function observationFor(op: string, key: string): Observation | undefined {
  return OBSERVATION[`${op}.${key}`] ?? OBSERVATION[key];
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

for (const fixture of FIXTURES) {
  describe(`every option on every operation changes something (${fixture.name})`, () => {
    for (const [op, table] of Object.entries(ALL_OPTION_TABLES)) {
      // `findManyStream` has no build* entry point of its own; it is asserted
      // against findMany's table below instead, which is the stronger claim.
      if (op === 'findManyStream') continue;

      for (const [key, kind] of Object.entries(table)) {
        if (kind === 'internal') continue;

        it(`${op}: ${key}`, () => {
          const obs = observationFor(op, key);
          assert.ok(
            obs,
            `${op}.${key} is on the option surface but has no entry in OBSERVATION. ` +
              `Say where it is observable (compiled / throws / unblocks / execution) ` +
              `so an option that does nothing cannot be added silently.`,
          );

          const baseline: Args = { ...BASELINE[op], ...fixture.baselines[op], ...(obs.needs ?? {}) };
          const withOption: Args = { ...baseline, [key]: obs.value };

          if (obs.how === 'execution') {
            assert.ok(obs.coveredBy, `${op}.${key} claims 'execution' but names no covering test`);
            assert.ok(
              existsSync(obs.coveredBy),
              `${op}.${key} names a covering test that does not exist: ${obs.coveredBy}`,
            );
            // The file must name the option in its HEADER docblock, not merely
            // somewhere in its body. A plain `includes` was the first cut and it
            // is too weak to be a gate: pointing `timeout` at errors.test.ts
            // passed, because that file mentions TimeoutError. A header names
            // what a file is ABOUT, so a file that only happens to use the word
            // no longer satisfies the hatch.
            const covering = readFileSync(obs.coveredBy, 'utf8');
            const header = covering.match(/^\/\*\*[\s\S]*?\*\//)?.[0] ?? '';
            assert.ok(
              header.includes(key),
              `${op}.${key} claims to be covered by ${obs.coveredBy}, but that file's header docblock ` +
                `never names ${key}. Point at the test that exists FOR this option, and say so at the top of it.`,
            );
            return;
          }

          if (obs.how === 'throws') {
            assert.throws(() => compile(op, withOption, fixture.primaryKey), ValidationError);
            return;
          }

          if (obs.how === 'unblocks') {
            assert.throws(
              () => compile(op, baseline, fixture.primaryKey),
              ValidationError,
              `${op}.${key} claims to unblock a refusal, but the baseline was accepted`,
            );
            assert.doesNotThrow(
              () => compile(op, withOption, fixture.primaryKey),
              `${op}.${key} did not unblock what it exists to unblock`,
            );
            return;
          }

          const before = compile(op, baseline, fixture.primaryKey);
          const after = compile(op, withOption, fixture.primaryKey);
          const differs = before.sql !== after.sql || JSON.stringify(before.params) !== JSON.stringify(after.params);
          assert.ok(
            differs,
            `${op}({ ${key} }) compiled byte-for-byte identically to ${op}() without it. ` +
              `The option was accepted and changed nothing.\n  SQL: ${before.sql}\n  params: ${JSON.stringify(before.params)}`,
          );
        });
      }
    }
  });
}

describe('the option matrix itself', () => {
  it('the streaming reads accept exactly the findMany surface, so neither can drift', () => {
    // findManyStream / findManyStreamBatches share findMany's argument handling
    // but not its execute seam, which is how `skip` reached the streaming path
    // through a different code route than the one it was fixed on.
    const stream = new Set(Object.keys(FIND_MANY_STREAM_OPTIONS));
    const many = new Set(Object.keys(FIND_MANY_OPTIONS));
    const missing = [...many].filter((k) => !stream.has(k));
    const extra = [...stream].filter((k) => !many.has(k));
    assert.deepEqual(missing, [], 'the streaming reads dropped a findMany option');
    // `batchSize` is the one legitimate addition: findManyStreamBatches yields
    // T[] and needs to be told how big a batch is. Pinned by name so a SECOND
    // divergence cannot hide behind it.
    assert.deepEqual(extra, ['batchSize'], 'the streaming table grew an unexpected option');
  });

  it('the matrix is not vacuous', () => {
    // Reflection returning nothing would make every assertion above pass while
    // testing no option at all.
    const pairs = Object.entries(ALL_OPTION_TABLES)
      .filter(([op]) => op !== 'findManyStream')
      .reduce((n, [, t]) => n + Object.values(t).filter((k) => k !== 'internal').length, 0);
    assert.ok(pairs >= 85, `expected the full option matrix, got ${pairs} pairs`);
  });
});
