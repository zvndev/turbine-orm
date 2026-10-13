/**
 * Wave C contracts: the capability flags, option-surface rows and public types
 * that row locks, percentiles, multi-row upsert and update expressions share.
 *
 * The flag test is the one that matters most. Every engine dialect is built by
 * spreading `postgresDialect`, so a capability added to the PostgreSQL dialect
 * is INHERITED by every engine unless that engine sets it itself, and an engine
 * that inherited `rowLockModes` would emit PostgreSQL's `FOR NO KEY UPDATE` on
 * MySQL. `Object.hasOwn` is the only check that cannot be satisfied by
 * inheritance.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { type Dialect, postgresDialect } from '../dialect.js';
import { mssqlDialect } from '../mssql.js';
import { mysqlDialect } from '../mysql.js';
import { powdbDialect } from '../powdb.js';
import { EXCLUDED_REF, SQL_EXPR } from '../query/expr.js';
import {
  AGGREGATE_OPTIONS,
  CREATE_MANY_OPTIONS,
  FIND_MANY_OPTIONS,
  FIND_MANY_STREAM_OPTIONS,
  FIND_UNIQUE_OPTIONS,
  GROUP_BY_OPTIONS,
} from '../query/option-surface.js';
import type {
  AggregateResultOf,
  ConflictTarget,
  CreateManyArgs,
  CreateManyOnConflict,
  FindManyArgs,
  FindManyStreamArgs,
  FindUniqueArgs,
  GroupByResult,
  RowLock,
  SqlExpr,
  UpdateInput,
} from '../query/types.js';
import { sqliteDialect } from '../sqlite.js';

/** Every capability Wave C adds, and its expected value per engine. */
const FLAGS = ['rowLockModes', 'supportsPercentileAggregates', 'supportsBulkUpsert'] as const;

const ENGINES: Record<string, { dialect: Dialect; expected: Record<(typeof FLAGS)[number], unknown> }> = {
  postgresql: {
    dialect: postgresDialect,
    expected: {
      rowLockModes: ['update', 'noKeyUpdate', 'share', 'keyShare'],
      supportsPercentileAggregates: true,
      supportsBulkUpsert: true,
    },
  },
  mysql: {
    dialect: mysqlDialect,
    expected: { rowLockModes: ['update', 'share'], supportsPercentileAggregates: false, supportsBulkUpsert: true },
  },
  sqlite: {
    dialect: sqliteDialect,
    expected: { rowLockModes: [], supportsPercentileAggregates: false, supportsBulkUpsert: true },
  },
  mssql: {
    dialect: mssqlDialect,
    expected: { rowLockModes: [], supportsPercentileAggregates: false, supportsBulkUpsert: true },
  },
  powdb: {
    dialect: powdbDialect,
    expected: { rowLockModes: [], supportsPercentileAggregates: false, supportsBulkUpsert: false },
  },
};

describe('wave C capability flags are own properties on every engine dialect', () => {
  for (const [engine, { dialect, expected }] of Object.entries(ENGINES)) {
    for (const flag of FLAGS) {
      it(`${engine}.${flag} is set on the dialect itself, not inherited`, () => {
        assert.ok(
          Object.hasOwn(dialect, flag),
          `${engine}Dialect does not set ${flag} itself, so it inherits PostgreSQL's value through the spread. ` +
            `Set it explicitly on the ${engine} dialect object.`,
        );
        assert.deepEqual(dialect[flag], expected[flag], `${engine}.${flag} has an unexpected value`);
      });
    }
  }

  it('covers every dialect that spreads postgresDialect', () => {
    // A new engine dialect must be added to ENGINES, or none of the above
    // asserts anything about it.
    assert.deepEqual(Object.keys(ENGINES).sort(), ['mssql', 'mysql', 'postgresql', 'powdb', 'sqlite']);
  });
});

describe('wave C option-surface rows', () => {
  it('lock is native on the find family (a mode and a flag, no schema name)', () => {
    assert.equal(FIND_MANY_OPTIONS.lock, 'native');
    assert.equal(FIND_UNIQUE_OPTIONS.lock, 'native');
  });

  it('the streaming reads do not list lock', () => {
    assert.equal(Object.hasOwn(FIND_MANY_STREAM_OPTIONS, 'lock'), false);
  });

  it('createMany: onConflict / select / omit are internal, skipGlobalFilters is native', () => {
    assert.equal(CREATE_MANY_OPTIONS.onConflict, 'internal');
    assert.equal(CREATE_MANY_OPTIONS.select, 'internal');
    assert.equal(CREATE_MANY_OPTIONS.omit, 'internal');
    assert.equal(CREATE_MANY_OPTIONS.skipGlobalFilters, 'native');
  });

  it('_percentile is internal on aggregate and groupBy (field names, no Prisma equivalent)', () => {
    assert.equal(AGGREGATE_OPTIONS._percentile, 'internal');
    assert.equal(GROUP_BY_OPTIONS._percentile, 'internal');
  });
});

describe('wave C brands', () => {
  it('are registered symbols, so the ESM and CJS copies agree', () => {
    assert.equal(SQL_EXPR, Symbol.for('turbine-orm.sqlExpr'));
    assert.equal(EXCLUDED_REF, Symbol.for('turbine-orm.excludedRef'));
  });
});

// ---------------------------------------------------------------------------
// Compile-time contracts. A regression fails `tsc` (and so `tsx --test`).
// ---------------------------------------------------------------------------

type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
function assertTrue<T extends true>(): T {
  return true as T;
}

interface Req {
  id: number;
  route: string;
  latencyMs: number;
  startedAt: Date;
  amount: string;
}

describe('wave C public types', () => {
  it('RowLock takes a mode, or a mode with ONE wait policy', () => {
    const plain: RowLock = 'noKeyUpdate';
    const nowait: RowLock = { mode: 'update', noWait: true };
    const skip: RowLock = { mode: 'share', skipLocked: true };
    // @ts-expect-error both wait policies at once
    const both: RowLock = { mode: 'update', noWait: true, skipLocked: true };
    // @ts-expect-error not a mode
    const bad: RowLock = 'exclusive';
    const many: FindManyArgs<Req> = { lock: { mode: 'update', skipLocked: true } };
    const one: FindUniqueArgs<Req> = { where: { id: 1 }, lock: 'update' };
    assert.ok(plain && nowait && skip && both && bad && many && one);
  });

  it('the stream args have no lock', () => {
    assertTrue<Equals<'lock' extends keyof FindManyStreamArgs<Req> ? true : false, false>>();
    assertTrue<Equals<'batchSize' extends keyof FindManyStreamArgs<Req> ? true : false, true>>();
  });

  it('_percentile results mirror p and method', () => {
    type A = {
      _percentile: {
        latencyMs: { p: number[] };
        startedAt: { p: number; method: 'disc' };
        amount: { p: number };
      };
    };
    type R = AggregateResultOf<Req, A>['_percentile'];
    assertTrue<Equals<R['latencyMs'], number[] | null>>();
    assertTrue<Equals<R['startedAt'], Date | null>>();
    // A string-typed column can be numeric or interval, and cont reads those
    // back as a number and as text respectively.
    assertTrue<Equals<R['amount'], number | string | null>>();

    type G = GroupByResult<Req, { by: ['route']; _percentile: { latencyMs: { p: number } } }>;
    assertTrue<Equals<G['_percentile']['latencyMs'], number | null>>();
    // Absent when not requested.
    assertTrue<Equals<'_percentile' extends keyof AggregateResultOf<Req, { _count: true }> ? true : false, false>>();
  });

  it('createMany takes onConflict, select, omit and skipGlobalFilters', () => {
    const target: ConflictTarget<Req> = ['route', 'id'];
    // @ts-expect-error an empty target
    const empty: ConflictTarget<Req> = [];
    const skip: CreateManyOnConflict<Req> = { target: ['id'], ignore: true };
    const update: CreateManyOnConflict<Req> = { target: ['id'], update: ['route'], where: { latencyMs: { gt: 1 } } };
    // @ts-expect-error ignore and update are exclusive
    const both: CreateManyOnConflict<Req> = { target: ['id'], ignore: true, update: ['route'] };
    const args: CreateManyArgs<Req, Partial<Req>, { id: true }> = {
      data: [{ id: 1 }],
      onConflict: update,
      select: { id: true },
    };
    assert.ok(target && empty && skip && both && args);
  });

  it('update data takes an expression whose result fits the column', () => {
    const num = {} as SqlExpr<number>;
    const date = {} as SqlExpr<Date>;
    const ok: UpdateInput<Req> = { latencyMs: num, startedAt: date };
    // @ts-expect-error a Date expression into a number column
    const wrong: UpdateInput<Req> = { latencyMs: date };
    assert.ok(ok && wrong);
  });
});
