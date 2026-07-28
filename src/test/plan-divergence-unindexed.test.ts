/**
 * turbine-orm - plan-divergence `unindexed-filter` branch, unit tests (no database).
 *
 * The second scoring rule: a filter column with NO plain btree, where the custom
 * plan's alternative is a seq scan + top-N sort and the promoted generic plan
 * keeps the ordered walk. Before this branch existed, an unindexed column was
 * dropped by a shape gate BEFORE the considered counter, so it appeared neither
 * in the findings nor in the "not scored" notices.
 *
 * Every fixture here mirrors a live measurement, recorded next to the assertion:
 *
 *   - THE RULE: 20,000 rows / 247 pages, rarest bucket 2, no index on the filter
 *     column. Measured custom = Seq Scan 250 buffers / 0.83 ms, generic = PK
 *     Index Scan 20,074 buffers / 5.84 ms, and `auto` promoted it after five
 *     executions of the rare value (generic_plans 2, custom_plans 5).
 *   - NO GENERIC-SIDE GATE: the same shape at n_distinct 5,001, whose generic
 *     estimate sits far BELOW the sparse branch's crossover, still diverges 74x.
 *     The sparse rule's `genericEstimate >= crossover` gate would decline it.
 *   - CONTROL, small table: 1,500 rows / 19 pages flips just as hard (68x) but
 *     costs 0.28 ms against 0.14 ms. Declined by the tuple floor.
 *   - CONTROL, all values common: four even buckets produce the SAME plan under
 *     both plan_cache_modes (82 buffers either way). Declined by the limit gate.
 *   - CONTROL, hash index: a hash index on the filter column gives the custom
 *     plan a 7-buffer Bitmap Heap Scan, so the column belongs to the SPARSE
 *     branch and must not be described as a seq scan.
 *
 * Run: tsx --test src/test/plan-divergence-unindexed.test.ts
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ColumnDistribution, IndexStat, StatsSnapshot, TableStats } from '../index-stats.js';
import { findPlanDivergence, PLAN_DIVERGENCE_THRESHOLDS } from '../plan-divergence.js';
import type { SchemaMetadata } from '../schema.js';
import { mockTable } from './helpers.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** `inv_loc(id pk, organization_id)`: the filter column carries no schema index. */
function schemaFor(table = 'inv_loc'): SchemaMetadata {
  const meta = mockTable(table, [
    { name: 'id', field: 'id', pgType: 'int4' },
    { name: 'organization_id', field: 'organizationId', pgType: 'int4' },
  ]);
  // The candidate walker reads relation probes and leading index columns. A
  // hasMany from `org` is what puts an UNINDEXED column in the candidate set,
  // which is exactly the shape the missing-index advisor also reports.
  const org = mockTable('org', [{ name: 'id', field: 'id', pgType: 'int4' }], {
    locations: {
      name: 'locations',
      type: 'hasMany',
      to: table,
      foreignKey: 'organization_id',
      referenceKey: 'id',
    } as never,
  });
  return { tables: { org, [table]: meta }, enums: {} };
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

/** Only the primary key exists: nothing serves `organization_id = $1`. */
function pkOnly(table = 'inv_loc'): IndexStat[] {
  return [idx(table, `${table}_pkey`, ['id'], { isPrimary: true, isUnique: true })];
}

function snapshotWith(parts: {
  table?: string;
  rows: number;
  pages: number;
  indexes: IndexStat[];
  nDistinct: number;
  freqs: number[];
  mcvCount?: number;
  correlation?: number;
}): StatsSnapshot {
  const table = parts.table ?? 'inv_loc';
  const stats: TableStats = { table, reltuples: parts.rows, relpages: parts.pages, existingIndexCount: 1 };
  const dist: ColumnDistribution = {
    table,
    column: 'organization_id',
    nDistinct: parts.nDistinct,
    correlation: parts.correlation ?? 0.38,
    mostCommonFreqs: parts.freqs,
    mcvCount: parts.mcvCount ?? parts.freqs.length,
  };
  return {
    available: true,
    statsReset: new Date(Date.now() - 30 * 86_400_000),
    statsAgeDays: 30,
    tables: { [table]: stats },
    indexes: parts.indexes,
    nullFrac: {},
    columnStats: { [`${table}.organization_id`]: dist },
    notices: [],
  };
}

/** The measured fixture: 20,000 rows / 247 relpages / buckets 10,000, 6,000, 3,998, 2. */
function measuredFixture(overrides: Partial<Parameters<typeof snapshotWith>[0]> = {}): StatsSnapshot {
  return snapshotWith({
    rows: 20_000,
    pages: 247,
    indexes: pkOnly(),
    nDistinct: 4,
    freqs: [0.5, 0.3, 0.1999, 0.0001],
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// The rule
// ---------------------------------------------------------------------------

describe('findPlanDivergence - the unindexed-filter flip', () => {
  it('flags an UNINDEXED filter column, which used to be dropped before scoring', () => {
    const report = findPlanDivergence(schemaFor(), measuredFixture());
    assert.equal(report.findings.length, 1);
    const f = report.findings[0]!;
    assert.equal(f.branch, 'unindexed-filter');
    assert.equal(f.table, 'inv_loc');
    assert.equal(f.column, 'organization_id');
    assert.equal(f.orderColumn, 'id');
    assert.equal(f.columnField, 'organizationId');
  });

  it('counts the unindexed candidate as considered, and reports the split', () => {
    const report = findPlanDivergence(schemaFor(), measuredFixture());
    assert.equal(report.candidatesConsidered, 1);
    assert.equal(report.consideredUnindexed, 1);
    assert.equal(report.consideredIndexed, 0);
  });

  it('models the damage in TUPLES on the generic side and PAGES on the custom side', () => {
    const f = findPlanDivergence(schemaFor(), measuredFixture()).findings[0]!;
    // min(rows, rows x limit / bucket) = min(20,000, 200,000) = 20,000, which
    // gate 1 makes unconditional: it always takes `rows`. Measured on the live
    // fixture: 19,992 tuples fetched. Within 0.05%.
    assert.equal(f.tuplesWalked, 20_000);
    assert.equal(f.pages, 247);
    // 20,000 / 247 = 80.97, i.e. exactly the table's rows-per-page. Measured
    // buffer amplification 20,074 / 250 = 80.3.
    assert.ok(Math.abs((f.worstCaseAmplification ?? 0) - 80.972) < 0.01);
  });

  it('leaves the PAGE-shaped fields UNSET rather than filling them from a model that does not apply', () => {
    const f = findPlanDivergence(schemaFor(), measuredFixture()).findings[0]!;
    // sqrt(limit x pages) compares an ordered scan against a BITMAP scan. With
    // no index there is no bitmap path, so emitting one of these would be a
    // measurement-shaped lie rather than a missing number.
    assert.equal(f.crossoverRows, undefined);
    assert.equal(f.crossoverRowsWide, undefined);
    assert.equal(f.valuesBelowCrossover, undefined);
    assert.equal(f.walkPages, undefined);
    assert.equal(f.walkFraction, undefined);
    assert.equal(f.approxAmplification, undefined);
  });

  it('keeps the shared reporting context, including correlation and last ANALYZE', () => {
    const f = findPlanDivergence(schemaFor(), measuredFixture()).findings[0]!;
    assert.equal(f.rows, 20_000);
    assert.equal(f.distinctValues, 4);
    assert.equal(f.genericEstimate, 5_000);
    assert.ok(Math.abs(f.rarestBucket - 2) < 1e-9);
    assert.equal(f.densestBucket, 10_000);
    assert.equal(f.correlation, 0.38);
    assert.equal(f.assumedLimit, PLAN_DIVERGENCE_THRESHOLDS.assumedLimit);
  });

  it('carries NO generic-side gate: a high-cardinality column still flags', () => {
    // 20,000 rows / 247 pages, n_distinct 5,001, so the generic estimate is 4
    // rows, far BELOW the sparse branch's crossover of 70. The sparse rule's
    // `genericEstimate >= crossover` would decline this. Measured on that exact
    // shape: custom = Seq Scan 250 buffers, generic = PK Index Scan 19,994.
    // The reason is structural: Turbine parameterizes LIMIT, an unknown LIMIT is
    // estimated at 10% of the child estimate, so the ordered scan is discounted
    // 10x whatever the child estimate is, and n_distinct never enters the
    // generic plan's choice.
    const snapshot = snapshotWith({
      rows: 20_000,
      pages: 247,
      indexes: pkOnly(),
      nDistinct: 5_001,
      freqs: Array.from({ length: 100 }, () => 0.001),
      mcvCount: 100,
    });
    const f = findPlanDivergence(schemaFor(), snapshot).findings[0]!;
    assert.equal(f.branch, 'unindexed-filter');
    assert.ok(f.genericEstimate < 5, `generic estimate ${f.genericEstimate} should be far below any crossover`);
    assert.ok(f.rarestBucket < PLAN_DIVERGENCE_THRESHOLDS.assumedLimit);
  });

  it('emits a diagnostic block naming the index as the remedy, not a plan-cache setting', () => {
    const f = findPlanDivergence(schemaFor(), measuredFixture()).findings[0]!;
    assert.match(f.diagnosticSql, /SET synchronize_seqscans = off;/);
    assert.match(f.diagnosticSql, /SET max_parallel_workers_per_gather = 0;/);
    assert.match(f.diagnosticSql, /PREPARE turbine_divergence\(int4, int\)/);
    assert.match(f.diagnosticSql, /WHERE "organization_id" = \$1 ORDER BY "id" LIMIT \$2/);
    assert.match(f.diagnosticSql, /plan_cache_mode = force_custom_plan/);
    assert.match(f.diagnosticSql, /plan_cache_mode = force_generic_plan/);
    assert.match(f.diagnosticSql, /the fix for THIS finding is the missing index above, not a plan-cache setting/);
    assert.match(f.diagnosticSql, /RESET plan_cache_mode; RESET synchronize_seqscans/);
  });

  it('does not put that remedy line on a sparse-value finding, whose fix is not an index', () => {
    const indexed = snapshotWith({
      rows: 302_200,
      pages: 6_720,
      indexes: [
        idx('inv_loc', 'inv_loc_org_idx', ['organization_id']),
        idx('inv_loc', 'inv_loc_pkey', ['id'], { isPrimary: true, isUnique: true }),
      ],
      nDistinct: 38,
      freqs: [
        0.4973,
        ...Array.from({ length: 30 }, () => (1 - 0.4973 - (7 * 48) / 302_200) / 30),
        ...Array.from({ length: 7 }, () => 48 / 302_200),
      ],
    });
    const f = findPlanDivergence(schemaFor(), indexed).findings[0]!;
    assert.equal(f.branch, 'sparse-value');
    assert.doesNotMatch(f.diagnosticSql, /the missing index above/);
  });
});

// ---------------------------------------------------------------------------
// Gates: the controls that must stay silent
// ---------------------------------------------------------------------------

describe('findPlanDivergence - unindexed-filter controls', () => {
  it('declines a small table whose flip is real but costs a fraction of a millisecond', () => {
    // 1,500 rows / 19 pages, rarest bucket 2. MEASURED: it flips exactly the
    // same way (custom Seq Scan 22 buffers, generic PK Index Scan 1,506, 68x)
    // but 0.28 ms against 0.14 ms. Amplification is size independent in this
    // branch, so only an absolute floor separates a finding from noise.
    const report = findPlanDivergence(
      schemaFor(),
      snapshotWith({
        rows: 1_500,
        pages: 19,
        indexes: pkOnly(),
        nDistinct: 3,
        freqs: [0.5333, 0.4653, 0.0013],
      }),
    );
    assert.deepEqual(report.findings, []);
    // Considered and declined, not invisible.
    assert.equal(report.candidatesConsidered, 1);
    assert.equal(report.consideredUnindexed, 1);
  });

  it('declines when every value is common: there is no divergence to find', () => {
    // MEASURED on four even buckets of ~5,000: both plan_cache_modes produce the
    // SAME plan (PK Index Scan, 82 buffers, 0.07 to 0.12 ms).
    const report = findPlanDivergence(
      schemaFor(),
      snapshotWith({
        rows: 20_000,
        pages: 247,
        indexes: pkOnly(),
        nDistinct: 4,
        freqs: [0.25, 0.25, 0.25, 0.25],
      }),
    );
    assert.deepEqual(report.findings, []);
    assert.equal(report.candidatesConsidered, 1);
  });

  it('declines a bucket between the limit and the true boundary, deliberately', () => {
    // Gate 1 uses 1 x limit where the measured boundary is 3.3 x limit, so
    // buckets above the limit are real divergences this declines to report, and
    // the loss GROWS with the table. Measured at bucket 60 on the same fixture
    // shape at 200,000 rows / 2,470 pages: custom Seq Scan 2,473 buffers /
    // 8.1 ms, generic PK Index Scan 200,547 / 99.0 ms, an 81x flip and 198,074
    // extra buffer accesses. The margin buys robustness against k varying with
    // row width, index width and page costs, none of which a pure scorer can
    // read; it is a stated recall limit, not a safe one.
    const report = findPlanDivergence(
      schemaFor(),
      snapshotWith({
        rows: 20_000,
        pages: 247,
        indexes: pkOnly(),
        nDistinct: 4,
        freqs: [0.5, 0.3, 0.197, 0.003],
      }),
    );
    assert.deepEqual(report.findings, []);
  });

  it('declines when there is no ALTERNATIVE ordering index (no second plan to flip to)', () => {
    const report = findPlanDivergence(
      schemaFor(),
      snapshotWith({ rows: 20_000, pages: 247, indexes: [], nDistinct: 4, freqs: [0.5, 0.3, 0.1999, 0.0001] }),
    );
    assert.deepEqual(report.findings, []);
    // Not a scored verdict: it is a SHAPE exclusion, so it is not counted.
    assert.equal(report.candidatesConsidered, 0);
  });
});

// ---------------------------------------------------------------------------
// Statistics notices reach the unindexed population too
// ---------------------------------------------------------------------------

describe('findPlanDivergence - unusable statistics on an unindexed column', () => {
  it('emits a notice instead of dropping the column silently', () => {
    // This is the second half of the reported bug: the unindexed column was
    // dropped BEFORE the considered counter, so a missing pg_stats row on it
    // produced neither a finding nor a notice.
    const snapshot = measuredFixture();
    snapshot.columnStats = {};
    const report = findPlanDivergence(schemaFor(), snapshot);
    assert.equal(report.findings.length, 0);
    assert.equal(report.notices.length, 1);
    assert.equal(report.notices[0]!.column, 'organization_id');
    assert.match(report.notices[0]!.reason, /run ANALYZE/);
    assert.equal(report.candidatesConsidered, 1);
  });

  it('emits a notice when most_common_freqs is absent', () => {
    const snapshot = measuredFixture();
    snapshot.columnStats = {
      'inv_loc.organization_id': {
        table: 'inv_loc',
        column: 'organization_id',
        nDistinct: 4,
        correlation: 0.38,
        mostCommonFreqs: null,
        mcvCount: 0,
      },
    };
    const report = findPlanDivergence(schemaFor(), snapshot);
    assert.equal(report.findings.length, 0);
    assert.match(report.notices[0]!.reason, /most_common_freqs/);
  });
});

// ---------------------------------------------------------------------------
// Sorting: one honest key across both branches
// ---------------------------------------------------------------------------

describe('findPlanDivergence - both branches sort on estimated extra buffer accesses', () => {
  it('ranks the larger absolute waste first, not the larger ratio', () => {
    // Two tables, one of each branch:
    //   big   (sparse-value):    walkPages 6,720 - min(48, 6,720)   = 6,672
    //   small (unindexed-filter): tuplesWalked 20,000 - 247 pages    = 19,753
    // The unindexed one wastes ~3x more buffer accesses despite the sparse one
    // sitting on a table 25x larger, and the old ratio key would have inverted
    // this whenever the small table's ratio happened to be lower.
    const bigMeta = mockTable('big', [
      { name: 'id', field: 'id', pgType: 'int4' },
      { name: 'organization_id', field: 'organizationId', pgType: 'int4' },
    ]);
    bigMeta.indexes = [{ name: 'big_org_idx', columns: ['organization_id'], unique: false, definition: '' }];
    const schema = schemaFor();
    schema.tables.big = bigMeta;

    const base = measuredFixture();
    const snapshot: StatsSnapshot = {
      ...base,
      tables: { ...base.tables, big: { table: 'big', reltuples: 302_200, relpages: 6_720, existingIndexCount: 2 } },
      indexes: [
        ...pkOnly(),
        idx('big', 'big_org_idx', ['organization_id']),
        idx('big', 'big_pkey', ['id'], { isPrimary: true, isUnique: true }),
      ],
      columnStats: {
        ...base.columnStats,
        'big.organization_id': {
          table: 'big',
          column: 'organization_id',
          nDistinct: 38,
          correlation: 0.27,
          mostCommonFreqs: [
            0.4973,
            ...Array.from({ length: 30 }, () => (1 - 0.4973 - (7 * 48) / 302_200) / 30),
            ...Array.from({ length: 7 }, () => 48 / 302_200),
          ],
          mcvCount: 38,
        },
      },
    };

    const report = findPlanDivergence(schema, snapshot);
    assert.equal(report.findings.length, 2);
    assert.equal(report.findings[0]!.branch, 'unindexed-filter');
    assert.equal(report.findings[1]!.branch, 'sparse-value');
    assert.equal(report.consideredIndexed, 1);
    assert.equal(report.consideredUnindexed, 1);
  });
});

// ---------------------------------------------------------------------------
// The ORDER column's correlation, which is what decides the size of the flip
// ---------------------------------------------------------------------------

/** Add a pg_stats row for the ORDER column (the primary key) to a snapshot. */
function withOrderCorrelation(snapshot: StatsSnapshot, correlation: number, table = 'inv_loc'): StatsSnapshot {
  return {
    ...snapshot,
    columnStats: {
      ...snapshot.columnStats,
      [`${table}.id`]: { table, column: 'id', nDistinct: -1, correlation, mostCommonFreqs: null, mcvCount: 0 },
    },
  };
}

describe('findPlanDivergence - the exact-key-order false positive is disclosed', () => {
  it('carries the ORDER column correlation, not just the filter column one', () => {
    // Two fixtures identical in every scored input, opposite in reality. Both
    // measured on the module-header DDL at 20,000 rows / 247 pages, custom plan
    // 250 buffers in both:
    //   heap in hash order (id correlation -0.00065): generic 20,074 buffers, 80x
    //   heap in exact id order (id correlation 1):    generic    303 buffers, 1.2x
    // The filter column's correlation is ~0.38 in BOTH, which is why printing it
    // next to a sentence about physical order was measured on the wrong column.
    const scattered = findPlanDivergence(schemaFor(), withOrderCorrelation(measuredFixture(), -0.000_654_588_6))
      .findings[0]!;
    const ordered = findPlanDivergence(schemaFor(), withOrderCorrelation(measuredFixture(), 1)).findings[0]!;

    assert.equal(scattered.correlation, 0.38);
    assert.equal(ordered.correlation, 0.38);
    assert.ok(Math.abs((scattered.orderColumnCorrelation ?? 0) + 0.000_654_588_6) < 1e-9);
    assert.equal(ordered.orderColumnCorrelation, 1);
    assert.equal(scattered.heapNearlyOrdered, false);
    assert.equal(ordered.heapNearlyOrdered, true);
  });

  it('flags the near-exact case rather than suppressing it, because the boundary is a sampled fifth decimal', () => {
    // Measured ladder: 0.99998 (one page of local disorder) reads 3.1x and
    // 0.99993 (two pages) reads 41x. A gate here would drop the 41x row on a
    // statistic that moves with the sample.
    const onePage = findPlanDivergence(schemaFor(), withOrderCorrelation(measuredFixture(), 0.999_983_55)).findings[0]!;
    const twoPage = findPlanDivergence(schemaFor(), withOrderCorrelation(measuredFixture(), 0.999_934)).findings[0]!;
    assert.equal(onePage.heapNearlyOrdered, true);
    assert.equal(twoPage.heapNearlyOrdered, false);
    // Neither is suppressed: both remain findings, with the caveat as data.
    assert.equal(onePage.branch, 'unindexed-filter');
    assert.equal(twoPage.branch, 'unindexed-filter');
  });

  it('reports null rather than a zero when the ordering column has no pg_stats row', () => {
    const f = findPlanDivergence(schemaFor(), measuredFixture()).findings[0]!;
    assert.equal(f.orderColumnCorrelation, null);
    assert.equal(f.heapNearlyOrdered, false);
  });
});

// ---------------------------------------------------------------------------
// What "unindexed" means: an equality path, not specifically a btree
// ---------------------------------------------------------------------------

describe('findPlanDivergence - non-btree paths on the filter column', () => {
  it('treats a HASH index as an equality path, so the column is not called unindexed', () => {
    // Measured on the module-header fixture with CREATE INDEX ... USING hash
    // (organization_id): the custom plan is a Bitmap Heap Scan reading 7
    // buffers, not the 247-page seq scan branch B would have described.
    const snapshot = measuredFixture({
      indexes: [...pkOnly(), idx('inv_loc', 'inv_loc_org_hash', ['organization_id'], { accessMethod: 'hash' })],
    });
    const report = findPlanDivergence(schemaFor(), snapshot);
    assert.equal(report.consideredIndexed, 1);
    assert.equal(report.consideredUnindexed, 0);
    for (const f of report.findings) assert.equal(f.branch, 'sparse-value');
  });

  it('declines a brin path with a NOTICE rather than describing a plan it does not model', () => {
    const snapshot = measuredFixture({
      indexes: [...pkOnly(), idx('inv_loc', 'inv_loc_org_brin', ['organization_id'], { accessMethod: 'brin' })],
    });
    const report = findPlanDivergence(schemaFor(), snapshot);
    assert.deepEqual(report.findings, []);
    assert.equal(report.notices.length, 1);
    assert.match(report.notices[0]!.reason, /brin index/);
  });

  it('still calls the column unindexed when the only index on it is PARTIAL', () => {
    // A partial index gives the planner no path for the bare predicate, which is
    // the leftover case that keeps its own entry in the cached-plan section.
    const snapshot = measuredFixture({
      indexes: [
        ...pkOnly(),
        idx('inv_loc', 'inv_loc_org_partial', ['organization_id'], { predicate: 'organization_id > 3' }),
      ],
    });
    const report = findPlanDivergence(schemaFor(), snapshot);
    assert.equal(report.findings.length, 1);
    assert.equal(report.findings[0]!.branch, 'unindexed-filter');
  });
});
