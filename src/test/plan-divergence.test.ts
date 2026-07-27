/**
 * turbine-orm - plan-divergence advisor unit tests (no database).
 *
 * Drives {@link findPlanDivergence} over fixed statistics fixtures reproducing
 * the ONE modelled failure shape and every shape that must stay silent:
 *
 *   - THE RULE: long-tail column with an alternative ordering index, where the
 *     generic estimate lands ABOVE the plan boundary and the rare values below
 *     it. Fires on a large table AND on a small one (there is deliberately no
 *     table-size floor: what costs money is how much of the table the wrong
 *     plan walks, not how big the table is).
 *   - THE REMOVED RULE: a physically clustered column whose densest value dwarfs
 *     the generic estimate. It used to be flagged. It must now be SILENT: that
 *     rule predicted the wrong sign on live fixtures and was removed, and these
 *     tests exist so it cannot come back by accident.
 *   - Silence: uniform distributions, unindexed columns, tables with no
 *     alternative ordering index, unique columns, and the low-cardinality
 *     "3% / 97%" shape whose rare value is still far above the crossover.
 *
 * Run: tsx --test src/test/plan-divergence.test.ts
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ColumnDistribution, IndexStat, StatsSnapshot, TableStats } from '../index-stats.js';
import {
  collectDivergenceCandidateColumns,
  crossoverRows,
  findPlanDivergence,
  PLAN_DIVERGENCE_THRESHOLDS,
} from '../plan-divergence.js';
import type { IndexMetadata, RelationDef, SchemaMetadata } from '../schema.js';
import { mockTable } from './helpers.js';

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

function schemaWith(
  tableName: string,
  options: {
    columns?: { name: string; field: string; pgType?: string }[];
    indexes?: IndexMetadata[];
    relations?: Record<string, RelationDef>;
    uniqueColumns?: string[][];
  } = {},
): SchemaMetadata {
  const table = mockTable(
    tableName,
    options.columns ?? [
      { name: 'id', field: 'id', pgType: 'int8' },
      { name: 'tenant_id', field: 'tenantId', pgType: 'int4' },
    ],
    options.relations ?? {},
  );
  table.indexes = options.indexes ?? [
    { name: `${tableName}_tenant_idx`, columns: ['tenant_id'], unique: false, definition: '' },
  ];
  if (options.uniqueColumns) table.uniqueColumns = options.uniqueColumns;
  return { tables: { [tableName]: table }, enums: {} };
}

function idx(table: string, indexName: string, columns: string[], overrides: Partial<IndexStat> = {}): IndexStat {
  return {
    table,
    indexName,
    columns,
    accessMethod: 'btree',
    hasExpressions: false,
    predicate: null,
    isValid: true,
    isUnique: false,
    isPrimary: false,
    isReplicaIdent: false,
    ...overrides,
  };
}

function tableStats(table: string, reltuples: number, relpages: number): TableStats {
  return { table, reltuples, relpages, existingIndexCount: 2 };
}

function dist(
  table: string,
  column: string,
  o: { nDistinct: number; correlation: number; freqs: number[]; mcvCount?: number },
): ColumnDistribution {
  return {
    table,
    column,
    nDistinct: o.nDistinct,
    correlation: o.correlation,
    mostCommonFreqs: o.freqs,
    mcvCount: o.mcvCount ?? o.freqs.length,
  };
}

function snapshotWith(parts: {
  tables: TableStats[];
  indexes: IndexStat[];
  columnStats?: ColumnDistribution[];
}): StatsSnapshot {
  const tables: Record<string, TableStats> = {};
  for (const t of parts.tables) tables[t.table] = t;
  const columnStats: Record<string, ColumnDistribution> = {};
  for (const c of parts.columnStats ?? []) columnStats[`${c.table}.${c.column}`] = c;
  return {
    available: true,
    statsReset: new Date(Date.now() - 30 * 86_400_000),
    statsAgeDays: 30,
    tables,
    indexes: parts.indexes,
    nullFrac: {},
    columnStats: parts.columnStats === undefined ? undefined : columnStats,
    notices: [],
  };
}

/** The standard pair of indexes: one leading with the filter column, one PK. */
function standardIndexes(table: string): IndexStat[] {
  return [
    idx(table, `${table}_tenant_idx`, ['tenant_id']),
    idx(table, `${table}_pkey`, ['id'], { isPrimary: true, isUnique: true }),
  ];
}

// ---------------------------------------------------------------------------
// Crossover derivation
// ---------------------------------------------------------------------------

describe('crossoverRows', () => {
  it('is sqrt(limit x pages)', () => {
    assert.equal(crossoverRows(6720, 20), Math.sqrt(20 * 6720));
    assert.equal(Math.round(crossoverRows(6720, 20)), 367);
    assert.equal(Math.round(crossoverRows(6720, 2000)), 3666);
  });

  it('grows as sqrt(limit), which moves BOTH gates rather than only one', () => {
    // This used to be documented as "a finding at limit 20 survives a larger
    // limit". It does not: raising the limit makes `rarestBucket < crossover`
    // easier AND `genericEstimate >= crossover` harder, and the second can turn
    // a finding off. The advisor reports the wide-limit crossover instead of
    // claiming an invariant it does not have.
    assert.ok(crossoverRows(6720, 1000) > crossoverRows(6720, 20));
    assert.ok(Math.abs(crossoverRows(6720, 80) / crossoverRows(6720, 20) - 2) < 1e-9);
  });
});

// ---------------------------------------------------------------------------
// Candidate enumeration
// ---------------------------------------------------------------------------

describe('collectDivergenceCandidateColumns', () => {
  it('includes leading index columns and excludes single-column unique / PK columns', () => {
    const schema = schemaWith('orders', {
      indexes: [
        { name: 'orders_tenant_idx', columns: ['tenant_id'], unique: false, definition: '' },
        { name: 'orders_pkey', columns: ['id'], unique: true, definition: '' },
      ],
    });
    const candidates = collectDivergenceCandidateColumns(schema);
    assert.deepEqual(candidates, [{ table: 'orders', column: 'tenant_id' }]);
  });

  it('includes the child FK a hasMany relation probes', () => {
    const users = mockTable('users', [{ name: 'id', field: 'id' }], {
      posts: {
        name: 'posts',
        type: 'hasMany',
        to: 'posts',
        foreignKey: 'user_id',
        referenceKey: 'id',
      } as RelationDef,
    });
    const posts = mockTable('posts', [
      { name: 'id', field: 'id' },
      { name: 'user_id', field: 'userId' },
    ]);
    const schema: SchemaMetadata = { tables: { users, posts }, enums: {} };
    assert.deepEqual(collectDivergenceCandidateColumns(schema), [{ table: 'posts', column: 'user_id' }]);
  });

  it('skips a doc-field expression index leading column', () => {
    const schema = schemaWith('orders', {
      indexes: [
        {
          name: 'orders_doc_idx',
          columns: ['payload'],
          unique: false,
          definition: '',
          docPath: ['a'],
        } as IndexMetadata,
      ],
    });
    assert.deepEqual(collectDivergenceCandidateColumns(schema), []);
  });
});

// ---------------------------------------------------------------------------
// Rule S: the sparse-value flip
// ---------------------------------------------------------------------------

describe('findPlanDivergence - the modelled sparse-value flip', () => {
  // 302,200 rows / 6,720 pages / 38 distinct / correlation 0.27, long tail.
  // generic estimate 7,953 > crossover 367 > rarest bucket 48.
  // 1 dominant value, 30 mid values (~5,000 rows each), 7 rare values (48 rows each).
  const rareFreq = 48 / 302_200;
  const midFreq = (1 - 0.4973 - 7 * rareFreq) / 30;
  const longTailFreqs = [
    0.4973,
    ...Array.from({ length: 30 }, () => midFreq),
    ...Array.from({ length: 7 }, () => rareFreq),
  ];

  function longTail(): StatsSnapshot {
    return snapshotWith({
      tables: [tableStats('orders', 302_200, 6_720)],
      indexes: standardIndexes('orders'),
      columnStats: [dist('orders', 'tenant_id', { nDistinct: 38, correlation: 0.27, freqs: longTailFreqs })],
    });
  }

  it('flags the column', () => {
    const report = findPlanDivergence(schemaWith('orders'), longTail());
    assert.equal(report.findings.length, 1);
    const f = report.findings[0]!;
    assert.equal(f.table, 'orders');
    assert.equal(f.column, 'tenant_id');
    assert.equal(report.candidatesConsidered, 1);
  });

  it('reproduces the planner generic estimate exactly (rows / n_distinct)', () => {
    const f = findPlanDivergence(schemaWith('orders'), longTail()).findings[0]!;
    assert.equal(f.genericEstimate, 302_200 / 38);
    assert.equal(Math.round(f.genericEstimate), 7_953);
  });

  it('places the generic estimate above and the rarest bucket below the crossover', () => {
    const f = findPlanDivergence(schemaWith('orders'), longTail()).findings[0]!;
    assert.equal(Math.round(f.crossoverRows), 367);
    assert.ok(f.genericEstimate >= f.crossoverRows);
    assert.ok(f.rarestBucket < f.crossoverRows);
    assert.ok(f.walkPages >= PLAN_DIVERGENCE_THRESHOLDS.minWalkPages);
    assert.ok(f.walkFraction >= PLAN_DIVERGENCE_THRESHOLDS.minWalkFraction);
  });

  it('counts the values sitting on the wrong side of the crossover', () => {
    const f = findPlanDivergence(schemaWith('orders'), longTail()).findings[0]!;
    assert.equal(f.valuesBelowCrossover, 7);
  });

  it('emits a copy-pasteable EXPLAIN pair with both SETs and the ordering column', () => {
    const f = findPlanDivergence(schemaWith('orders'), longTail()).findings[0]!;
    assert.match(f.diagnosticSql, /SET synchronize_seqscans = off;/);
    assert.match(f.diagnosticSql, /SET max_parallel_workers_per_gather = 0;/);
    assert.match(f.diagnosticSql, /plan_cache_mode = force_custom_plan/);
    assert.match(f.diagnosticSql, /plan_cache_mode = force_generic_plan/);
    assert.match(f.diagnosticSql, /PREPARE turbine_divergence\(int4, int\)/);
    assert.match(f.diagnosticSql, /WHERE "tenant_id" = \$1 ORDER BY "id" LIMIT \$2/);
    assert.equal(f.orderColumn, 'id');
  });

  it('uses the residual bucket when the MCV list does not cover every value', () => {
    // 48 distinct values but only 39 in the MCV list: the rarest value is the
    // residual bucket, not the smallest MCV.
    const snapshot = snapshotWith({
      tables: [tableStats('orders', 60_000, 1_715)],
      indexes: standardIndexes('orders'),
      columnStats: [
        dist('orders', 'tenant_id', {
          nDistinct: 48,
          correlation: 0.43,
          freqs: [0.6616, ...Array.from({ length: 38 }, () => 0.00888)],
          mcvCount: 39,
        }),
      ],
    });
    const f = findPlanDivergence(schemaWith('orders'), snapshot).findings[0]!;
    // residual = rows x (1 - sum(freqs)) / (48 - 39)
    assert.ok(f.rarestBucket > 0 && f.rarestBucket < 30);
    // The 9 non-MCV values are all counted as below the crossover.
    assert.ok(f.valuesBelowCrossover >= 9);
  });
});

// ---------------------------------------------------------------------------
// The REMOVED dense rule: these shapes must stay silent
// ---------------------------------------------------------------------------

describe('findPlanDivergence - the dense direction is deliberately not modelled', () => {
  // 300,000 rows / 6,720 pages / 60 distinct / correlation 1.00.
  // generic estimate 5,000 vs densest value 120,300 (ratio 24). An earlier
  // revision flagged exactly this and predicted "at least 24x". Measured on live
  // fixtures of this shape the generic plan was sometimes 10x and 105x BETTER
  // than the custom one, so the advice was not merely mis-scaled, it was
  // inverted. What decides the sign is where the dominant band physically sits
  // in the heap, and pg_stats does not carry that: `correlation` is identical
  // whether the band is at the head or the tail.
  function clustered(correlation = 1.0): StatsSnapshot {
    return snapshotWith({
      tables: [tableStats('events', 300_000, 6_720)],
      indexes: standardIndexes('events'),
      columnStats: [
        dist('events', 'tenant_id', {
          nDistinct: 60,
          correlation,
          freqs: [0.401, ...Array.from({ length: 59 }, () => 0.01015)],
        }),
      ],
    });
  }

  it('does not flag a clustered column whose densest value dwarfs the generic estimate', () => {
    const report = findPlanDivergence(schemaWith('events'), clustered());
    assert.deepEqual(report.findings, []);
    // ...and it was genuinely examined, not skipped before scoring.
    assert.equal(report.candidatesConsidered, 1);
  });

  it('does not flag it in the reverse-correlated spelling either', () => {
    assert.deepEqual(findPlanDivergence(schemaWith('events'), clustered(-1.0)).findings, []);
  });

  it('still flags a clustered column when its RARE values cross the boundary', () => {
    // Correlation used to route a column to the dense rule EXCLUSIVELY, which
    // made the advisor structurally unable to report a real sparse-direction
    // flip on any clustered column. Correlation no longer gates anything.
    const snapshot = snapshotWith({
      tables: [tableStats('events', 302_200, 6_720)],
      indexes: standardIndexes('events'),
      columnStats: [
        dist('events', 'tenant_id', {
          nDistinct: 38,
          correlation: 1.0,
          freqs: [
            0.4973,
            ...Array.from({ length: 30 }, () => (1 - 0.4973 - (7 * 48) / 302_200) / 30),
            ...Array.from({ length: 7 }, () => 48 / 302_200),
          ],
        }),
      ],
    });
    const report = findPlanDivergence(schemaWith('events'), snapshot);
    assert.equal(report.findings.length, 1);
    assert.equal(report.findings[0]!.correlation, 1.0);
  });
});

// ---------------------------------------------------------------------------
// Silence: the shapes that must not fire
// ---------------------------------------------------------------------------

describe('findPlanDivergence - non-damaging shapes stay silent', () => {
  it('a uniform distribution', () => {
    const snapshot = snapshotWith({
      tables: [tableStats('orders', 300_000, 6_400)],
      indexes: standardIndexes('orders'),
      columnStats: [
        dist('orders', 'tenant_id', {
          nDistinct: 60,
          correlation: 0.02,
          freqs: Array.from({ length: 60 }, () => 1 / 60),
        }),
      ],
    });
    assert.deepEqual(findPlanDivergence(schemaWith('orders'), snapshot).findings, []);
  });

  it('a skewed but UNCLUSTERED column whose rare values sit above the crossover', () => {
    // Interleaved fixture: ratio to the densest value is 24, but nothing is rare
    // enough to cross the boundary, and the column is not clustered.
    const snapshot = snapshotWith({
      tables: [tableStats('orders', 300_000, 6_400)],
      indexes: standardIndexes('orders'),
      columnStats: [
        dist('orders', 'tenant_id', {
          nDistinct: 60,
          correlation: 0.18,
          freqs: [0.4, ...Array.from({ length: 59 }, () => 0.0101)],
        }),
      ],
    });
    assert.deepEqual(findPlanDivergence(schemaWith('orders'), snapshot).findings, []);
  });

  it('a small table whose rarest value still sits above the crossover', () => {
    const snapshot = snapshotWith({
      tables: [tableStats('orders', 18_500, 394)],
      indexes: standardIndexes('orders'),
      columnStats: [
        dist('orders', 'tenant_id', {
          nDistinct: 83,
          correlation: 0.07,
          freqs: [0.25, ...Array.from({ length: 82 }, () => 0.0091)],
        }),
      ],
    });
    assert.deepEqual(findPlanDivergence(schemaWith('orders'), snapshot).findings, []);
  });

  it('a column with NO index (that is the missing-index finding, not this one)', () => {
    const snapshot = snapshotWith({
      tables: [tableStats('orders', 302_200, 6_720)],
      indexes: [idx('orders', 'orders_pkey', ['id'], { isPrimary: true, isUnique: true })],
      columnStats: [
        dist('orders', 'tenant_id', {
          nDistinct: 38,
          correlation: 0.27,
          freqs: [0.4973, ...Array.from({ length: 36 }, () => 0.0139), 0.0001],
        }),
      ],
    });
    assert.deepEqual(findPlanDivergence(schemaWith('orders'), snapshot).findings, []);
  });

  it('a table with no ALTERNATIVE ordering index (nothing to flip to)', () => {
    const snapshot = snapshotWith({
      tables: [tableStats('orders', 302_200, 6_720)],
      indexes: [idx('orders', 'orders_tenant_idx', ['tenant_id'])],
      columnStats: [
        dist('orders', 'tenant_id', {
          nDistinct: 38,
          correlation: 0.27,
          freqs: [0.4973, ...Array.from({ length: 36 }, () => 0.0139), 0.0001],
        }),
      ],
    });
    assert.deepEqual(findPlanDivergence(schemaWith('orders'), snapshot).findings, []);
  });

  it('a single-column-unique filter column (equality always matches one row)', () => {
    const schema = schemaWith('orders', { uniqueColumns: [['id'], ['tenant_id']] });
    const snapshot = snapshotWith({
      tables: [tableStats('orders', 302_200, 6_720)],
      indexes: standardIndexes('orders'),
      columnStats: [
        dist('orders', 'tenant_id', {
          nDistinct: 38,
          correlation: 0.27,
          freqs: [0.4973, ...Array.from({ length: 36 }, () => 0.0139), 0.0001],
        }),
      ],
    });
    assert.deepEqual(findPlanDivergence(schema, snapshot).findings, []);
  });

  it('an index that only serves the filter through an expression or a predicate', () => {
    const snapshot = snapshotWith({
      tables: [tableStats('orders', 302_200, 6_720)],
      indexes: [
        idx('orders', 'orders_tenant_partial', ['tenant_id'], { predicate: 'tenant_id IS NOT NULL' }),
        idx('orders', 'orders_pkey', ['id'], { isPrimary: true, isUnique: true }),
      ],
      columnStats: [
        dist('orders', 'tenant_id', {
          nDistinct: 38,
          correlation: 0.27,
          freqs: [0.4973, ...Array.from({ length: 36 }, () => 0.0139), 0.0001],
        }),
      ],
    });
    assert.deepEqual(findPlanDivergence(schemaWith('orders'), snapshot).findings, []);
  });
});

// ---------------------------------------------------------------------------
// Honest degradation
// ---------------------------------------------------------------------------

describe('findPlanDivergence - stale or missing statistics', () => {
  const bigTable = { tables: [tableStats('orders', 302_200, 6_720)], indexes: standardIndexes('orders') };

  it('suppresses with a notice when pg_stats has no row for the column', () => {
    const report = findPlanDivergence(schemaWith('orders'), snapshotWith({ ...bigTable, columnStats: [] }));
    assert.equal(report.findings.length, 0);
    assert.equal(report.notices.length, 1);
    assert.match(report.notices[0]!.reason, /run ANALYZE/);
    assert.equal(report.candidatesConsidered, 1);
  });

  it('suppresses with a notice when the whole distribution read degraded', () => {
    const report = findPlanDivergence(schemaWith('orders'), snapshotWith(bigTable));
    assert.equal(report.findings.length, 0);
    assert.equal(report.notices.length, 1);
  });

  it('suppresses with a notice when n_distinct is 0 (never analyzed)', () => {
    const report = findPlanDivergence(
      schemaWith('orders'),
      snapshotWith({
        ...bigTable,
        columnStats: [dist('orders', 'tenant_id', { nDistinct: 0, correlation: 0, freqs: [1] })],
      }),
    );
    assert.equal(report.findings.length, 0);
    assert.match(report.notices[0]!.reason, /n_distinct is 0/);
  });

  it('suppresses with a notice when most_common_freqs is absent', () => {
    const report = findPlanDivergence(
      schemaWith('orders'),
      snapshotWith({
        ...bigTable,
        columnStats: [
          {
            table: 'orders',
            column: 'tenant_id',
            nDistinct: 38,
            correlation: 0.27,
            mostCommonFreqs: null,
            mcvCount: 0,
          },
        ],
      }),
    );
    assert.equal(report.findings.length, 0);
    assert.match(report.notices[0]!.reason, /most_common_freqs/);
  });

  it('never scores a table whose reltuples or relpages is unknown', () => {
    const report = findPlanDivergence(
      schemaWith('orders'),
      snapshotWith({
        tables: [{ table: 'orders', reltuples: -1 }],
        indexes: standardIndexes('orders'),
        columnStats: [dist('orders', 'tenant_id', { nDistinct: 38, correlation: 0.27, freqs: [0.99, 0.0001] })],
      }),
    );
    assert.equal(report.findings.length, 0);
    assert.equal(report.notices.length, 0);
    assert.equal(report.candidatesConsidered, 0);
  });
});
