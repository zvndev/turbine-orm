/**
 * The option-observability matrix, for PowDB.
 *
 * `src/test/option-observability.test.ts` asserts the rule on `QueryInterface`:
 * every option on every operation must change the answer, or be refused.
 * `PowqlInterface` is a PARALLEL implementation of the same public surface,
 * sharing the same arg TYPES, and this repository's history says that is
 * precisely where two engines come to disagree about whether a query is valid:
 * the 0.64 projection resolver (one path threw on an unresolvable name while
 * the other filtered it out) and the 0.73 findUnique rule (shared deliberately,
 * because two copies of a rule that specific is how they drift).
 *
 * A rule enforced on one engine only is not a rule. So this file asks the same
 * question of PowQL, with ONE addition that is the whole point of asking it
 * here: PowDB cannot honour every Postgres option, and the correct answer for
 * one it cannot honour is `UnsupportedFeatureError` (E017), never silence. An
 * option that is quietly dropped on PowDB is the same bug as `include` being
 * quietly dropped on Postgres, and it is harder to notice because the caller
 * has usually already seen it work on another engine.
 *
 * PowqlInterface has no `build*` methods (it is execute-only), so the emitted
 * PowQL is captured through a recording pool, across every statement an
 * operation issues rather than just the first: several PowDB operations are
 * multi-statement (upsert reselects, the relation loaders), and an option that
 * only moves the second statement would otherwise read as inert.
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { UnsupportedFeatureError, ValidationError } from '../errors.js';
import { capabilitiesFromVersion, type PowdbPool } from '../powdb.js';
import { PowqlInterface } from '../powql.js';
import { UNSAFE } from '../query/index.js';
import { ALL_OPTION_TABLES } from '../query/option-surface.js';
import type { ColumnMetadata, RelationDef, SchemaMetadata, TableMetadata } from '../schema.js';

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

function col(
  name: string,
  field: string,
  tsType: string,
  pgType: string,
  opts: Partial<ColumnMetadata> = {},
): ColumnMetadata {
  return { name, field, pgType, tsType, nullable: false, hasDefault: false, isArray: false, pgArrayType: '', ...opts };
}

function table(
  name: string,
  columns: ColumnMetadata[],
  relations: Record<string, RelationDef> = {},
  pk: string[] = ['id'],
  uniques: string[][] = [],
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
    dateColumns: new Set(columns.filter((c) => c.tsType.startsWith('Date')).map((c) => c.name)),
    dialectTypes: Object.fromEntries(columns.map((c) => [c.name, c.pgType])),
    pgTypes: Object.fromEntries(columns.map((c) => [c.name, c.pgType])),
    allColumns: columns.map((c) => c.name),
    primaryKey: pk,
    uniqueColumns: [pk, ...uniques],
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
        col('tenant_id', 'tenantId', 'string', 'text'),
        col('version', 'version', 'number', 'int4'),
      ],
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
      ['id'],
      [['email']],
    ),
    post: table('post', [
      col('id', 'id', 'string', 'text', { hasDefault: true }),
      col('author_id', 'authorId', 'string', 'text'),
      col('title', 'title', 'string', 'text'),
    ]),
  },
};

const CAPS = capabilitiesFromVersion('0.18.0');

/** Records every PowQL statement an operation emits, in order. */
function recorder() {
  const calls: { powql: string; params: unknown[] }[] = [];
  const pool = {
    capabilities: CAPS,
    retryStaleReads: false,
    readonly: false,
    query(powql: string, params: unknown[]) {
      calls.push({ powql, params });
      // A row shaped for every operation the matrix drives: writes reselect it,
      // reads return it, aggregates read whatever key they asked for.
      return Promise.resolve({
        rows: [{ id: '1', name: 'Ada', email: 'a@b.c', tenant_id: 't1', version: 1, _count: 1, count: 1 }],
        rowCount: 1,
      });
    },
  } as unknown as PowdbPool;
  return { pool, calls };
}

type Args = Record<string, unknown>;

/**
 * Run one operation and return a stable rendering of EVERY statement it
 * emitted. Multi-statement operations are the norm here, so comparing only the
 * first would call an option inert whenever it moved a later one.
 */
async function emit(op: string, args: Args): Promise<string> {
  const rec = recorder();
  const qi = new PowqlInterface(rec.pool, 'app_user', schema, [], {
    warnOnUnlimited: false,
    globalFilters: { app_user: { tenantId: 't1' } },
  }) as unknown as Record<string, (a: Args) => Promise<unknown>>;
  const run = qi[op];
  if (typeof run !== 'function') throw new Error(`PowqlInterface has no ${op}()`);
  await run.call(qi, args);
  return rec.calls.map((c) => `${c.powql} :: ${JSON.stringify(c.params)}`).join('\n---\n');
}

// ---------------------------------------------------------------------------
// The matrix
// ---------------------------------------------------------------------------

const BASELINE: Record<string, Args> = {
  findUnique: { where: { id: '1' } },
  findMany: {},
  create: { data: { name: 'a' } },
  createMany: { data: [{ name: 'a' }] },
  update: { where: { id: '1' }, data: { name: 'b' } },
  updateMany: { where: { name: 'a' }, data: { name: 'b' } },
  delete: { where: { id: '1' } },
  deleteMany: { where: { name: 'a' } },
  upsert: { where: { id: '1' }, create: { name: 'a' }, update: { name: 'b' } },
  count: {},
  aggregate: { _count: { id: true } },
  groupBy: { by: ['name'], _count: { id: true } },
};

type How = 'compiled' | 'throws' | 'unsupported' | 'unblocks' | 'execution';

interface Observation {
  how: How;
  value: unknown;
  needs?: Args;
  coveredBy?: string;
  why?: string;
}

const OBSERVATION: Record<string, Observation> = {
  where: { how: 'compiled', value: { name: 'zzz-distinct' } },
  'findUnique.where': { how: 'compiled', value: { email: 'other@example.test' } },
  // The single-row writes refuse a where that identifies no row (query/
  // compound-unique.ts), so their probe changes the PK value instead.
  'update.where': { how: 'compiled', value: { id: 'zzz-distinct' } },
  'delete.where': { how: 'compiled', value: { id: 'zzz-distinct' } },
  // `upsert`'s where is its conflict target and carries the same rule.
  'upsert.where': { how: 'compiled', value: { id: 'zzz-distinct' } },
  select: { how: 'compiled', value: { id: true } },
  omit: { how: 'compiled', value: { name: true } },
  with: { how: 'compiled', value: { posts: true } },
  data: { how: 'compiled', value: { name: 'changed-by-the-matrix' } },
  'createMany.data': { how: 'compiled', value: [{ name: 'x' }, { name: 'y' }] },
  'upsert.create': { how: 'compiled', value: { name: 'created-differently' } },
  'upsert.update': { how: 'compiled', value: { name: 'updated-differently' } },

  orderBy: { how: 'compiled', value: { id: 'asc' } },
  'groupBy.orderBy': { how: 'compiled', value: { name: 'asc' } },
  limit: { how: 'compiled', value: 7 },
  offset: { how: 'compiled', value: 3 },
  take: { how: 'compiled', value: 7 },
  skip: { how: 'compiled', value: 3 },
  // PowDB has no cursor pagination and says so, which is the correct answer for
  // an option it cannot honour.
  cursor: { how: 'unsupported', value: { id: '5' }, needs: { orderBy: { id: 'asc' } } },
  // `distinct` names COLUMNS (Postgres compiles it to `DISTINCT ON (col)`).
  // PowQL's `distinct` keyword is ROW-WIDE and takes no column list, so it
  // used to be "compiled" into a DIFFERENT row set under the same argument,
  // with no error. Same answer as its groupBy spelling below: E017.
  distinct: { how: 'unsupported', value: ['name'] },
  // PowQL has no DISTINCT ON row source for a groupBy, and says so.
  distinctOn: { how: 'unsupported', value: { columns: ['name'], orderBy: { id: 'desc' } } },

  by: { how: 'compiled', value: ['version'] },
  having: { how: 'compiled', value: { id: { _count: { gt: 1 } } } },
  _count: { how: 'compiled', value: true },
  _sum: { how: 'compiled', value: { version: true } },
  _avg: { how: 'compiled', value: { version: true } },
  _min: { how: 'compiled', value: { version: true } },
  _max: { how: 'compiled', value: { version: true } },

  relationLoadStrategy: {
    how: 'compiled',
    value: 'batched',
    needs: { with: { posts: true } },
    why: 'PowDB chooses between nested projections and the keyed loaders at build time, so it IS visible in the emitted PowQL',
  },
  // Postgres-only wire encoding: PowQL emits no JSON row encoding to choose.
  jsonEncoding: { how: 'unsupported', value: 'object', needs: { with: { posts: true } } },
  stableRelationOrder: { how: 'compiled', value: true, needs: { with: { posts: true } } },

  skipGlobalFilters: { how: 'compiled', value: UNSAFE },
  includePii: { how: 'compiled', value: UNSAFE },
  'aggregate.includePii': { how: 'unblocks', value: UNSAFE, needs: { _max: { email: true } } },
  'groupBy.includePii': { how: 'unblocks', value: UNSAFE, needs: { by: ['email'] } },
  allowFullTableScan: { how: 'unblocks', value: UNSAFE, needs: { where: {} } },

  // PowQL insert has no ON CONFLICT DO NOTHING, and says so.
  skipDuplicates: { how: 'unsupported', value: true },
  optimisticLock: { how: 'compiled', value: { field: 'version', expected: 1 } },

  // Postgres plan control has no PowDB equivalent and is documented as E017.
  forceCustomPlan: { how: 'unsupported', value: true },

  timeout: {
    how: 'execution',
    value: 1000,
    coveredBy: 'src/test/query-timeout.test.ts',
    why: 'bounds how long execution may take; it emits no PowQL and binds no param',
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

describe('powdb: every option on every operation changes something, or is refused', () => {
  for (const [op, table_] of Object.entries(ALL_OPTION_TABLES)) {
    // No streaming surface on PowDB (it throws E017 telling you to page with
    // findMany), so there is nothing to compile.
    if (op === 'findManyStream') continue;

    for (const [key, kind] of Object.entries(table_)) {
      if (kind === 'internal') continue;

      it(`${op}: ${key}`, async () => {
        const obs = observationFor(op, key);
        assert.ok(
          obs,
          `${op}.${key} is on the option surface but has no entry in this file's OBSERVATION. ` +
            `Say what PowDB does with it: compile it, refuse it (E017 if PowDB cannot honour it), or name the test that proves it acts.`,
        );

        const baseline: Args = { ...BASELINE[op], ...(obs.needs ?? {}) };
        const withOption: Args = { ...baseline, [key]: obs.value };

        if (obs.how === 'execution') {
          assert.ok(obs.coveredBy && existsSync(obs.coveredBy), `${op}.${key} names no existing covering test`);
          const header = readFileSync(obs.coveredBy, 'utf8').match(/^\/\*\*[\s\S]*?\*\//)?.[0] ?? '';
          assert.ok(header.includes(key), `${obs.coveredBy} does not name ${key} in its header docblock`);
          return;
        }

        if (obs.how === 'unsupported') {
          // The whole reason this file exists: silence is the bug, a typed
          // refusal is the fix.
          await assert.rejects(
            () => emit(op, withOption),
            UnsupportedFeatureError,
            `${op}.${key} cannot be honoured by PowDB, so it must throw E017 rather than be ignored`,
          );
          return;
        }

        if (obs.how === 'throws') {
          await assert.rejects(() => emit(op, withOption), ValidationError);
          return;
        }

        if (obs.how === 'unblocks') {
          await assert.rejects(
            () => emit(op, baseline),
            (e: unknown) => e instanceof ValidationError || e instanceof UnsupportedFeatureError,
            `${op}.${key} claims to unblock a refusal, but the baseline was accepted`,
          );
          await emit(op, withOption);
          return;
        }

        const before = await emit(op, baseline);
        const after = await emit(op, withOption);
        assert.notEqual(
          after,
          before,
          `${op}({ ${key} }) emitted byte-for-byte the same PowQL as ${op}() without it. ` +
            `The option was accepted and changed nothing.\n${before}`,
        );
      });
    }
  }

  it('the matrix is not vacuous', () => {
    const pairs = Object.entries(ALL_OPTION_TABLES)
      .filter(([op]) => op !== 'findManyStream')
      .reduce((n, [, t]) => n + Object.values(t).filter((k) => k !== 'internal').length, 0);
    assert.ok(pairs >= 85, `expected the full option matrix, got ${pairs} pairs`);
  });
});
