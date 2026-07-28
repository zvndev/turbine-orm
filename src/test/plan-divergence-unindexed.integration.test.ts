/**
 * turbine-orm - `unindexed-filter` plan divergence, live test (DATABASE_URL-gated).
 *
 * The mechanism this branch models is distinct from the sparse-value one and is
 * reproduced here rather than assumed: with NO index on the filter column, the
 * custom plan's alternative is a SEQ SCAN + top-N sort (bounded by the table's
 * pages), while a promoted generic plan keeps the ordered primary-key walk and,
 * unable to see that the value is rare, fetches nearly every TUPLE before it
 * fills the LIMIT.
 *
 * Three fixtures, all in one schema that is dropped afterwards:
 *
 *   - `inv_loc` (the rule): 20,000 rows / 247 pages, buckets 10,000 / 6,000 /
 *     3,998 / 2, no index on `organization_id`, and the primary key deliberately
 *     UNCORRELATED with heap order (rows are inserted in hash order). Must be
 *     flagged, and the flip is measured.
 *   - `inv_small` (control): the same shape at 1,500 rows / 19 pages. It flips
 *     just as hard and costs a fraction of a millisecond, so the tuple floor
 *     must decline it. The flip is measured too, so the silence is a DECISION
 *     rather than a tame fixture.
 *   - `inv_even` (control): 20,000 rows, four even buckets. Both plan_cache_modes
 *     produce the same plan, so there is nothing to find. Must be silent, and
 *     the absence of divergence is measured.
 *
 * `synchronize_seqscans` and `max_parallel_workers_per_gather` are pinned on
 * every measurement: without them a repeated sequential scan resumes where the
 * last one stopped and a catastrophic case reads as harmless.
 *
 * Run: DATABASE_URL=postgres://... tsx --test src/test/plan-divergence-unindexed.integration.test.ts
 */

import assert from 'node:assert/strict';
import { describe } from 'node:test';
import pg from 'pg';
import { findMissingRelationIndexes } from '../index-advisor.js';
import { collectStatsSnapshot, type StatsSnapshot } from '../index-stats.js';
import { introspect } from '../introspect.js';
import {
  collectDivergenceCandidateColumns,
  collectDivergenceOrderColumns,
  findPlanDivergence,
} from '../plan-divergence.js';
import type { SchemaMetadata } from '../schema.js';
import { skipGate } from './helpers.js';

const DATABASE_URL = process.env.DATABASE_URL;
const { it, before, after } = skipGate(!DATABASE_URL, 'requires DATABASE_URL');

const LAB = 'turbine_plan_divergence_unindexed_lab';

/** Total shared buffers (hit + read) reported by an EXPLAIN plan node. */
function sharedBuffers(node: Record<string, unknown>): number {
  return Number(node['Shared Hit Blocks'] ?? 0) + Number(node['Shared Read Blocks'] ?? 0);
}

/** The top plan node's type string, so the test can assert WHICH plan each mode picked. */
function planShape(node: Record<string, unknown>): string {
  const parts: string[] = [];
  const walk = (n: Record<string, unknown>): void => {
    parts.push(String(n['Node Type'] ?? ''));
    for (const child of (n.Plans as Record<string, unknown>[] | undefined) ?? []) walk(child);
  };
  walk(node);
  return parts.join(' > ');
}

describe('unindexed-filter plan divergence (live Postgres)', () => {
  let schema: SchemaMetadata;
  let snapshot: StatsSnapshot;
  const measured: Record<string, { custom: number; generic: number; customPlan: string; genericPlan: string }> = {};
  let promoted = { generic: 0, custom: 0 };

  before(async () => {
    const client = new pg.Client({ connectionString: DATABASE_URL! });
    await client.connect();
    try {
      await client.query(`DROP SCHEMA IF EXISTS ${LAB} CASCADE`);
      await client.query(`CREATE SCHEMA ${LAB}`);
      // The parent exists so `organization_id` is a real relation probe: that is
      // what puts the column in the divergence candidate set AND in the
      // missing-index advisor's output, which is the overlap the report has to
      // handle as one problem.
      await client.query(`CREATE TABLE ${LAB}.org (id int PRIMARY KEY)`);
      await client.query(`INSERT INTO ${LAB}.org SELECT g FROM generate_series(1, 4) g`);

      const build = async (table: string, rows: number, bucketSql: string, insertOrder?: string): Promise<void> => {
        await client.query(
          `CREATE TABLE ${LAB}.${table} (
             id int PRIMARY KEY,
             organization_id int NOT NULL REFERENCES ${LAB}.org(id),
             payload text NOT NULL
           )`,
        );
        // Inserted in hash order with sequential ids, so the primary key is
        // UNCORRELATED with physical position. That is what makes each
        // index-order heap fetch its own buffer access; a heap still in exact
        // key order is the known false positive and reads ~1x.
        await client.query(
          `INSERT INTO ${LAB}.${table} (id, organization_id, payload)
           SELECT g, ${bucketSql}, repeat('p', 60)
             FROM generate_series(1, ${rows}) g
            ORDER BY ${insertOrder ?? '(g * 2654435761::bigint) % 1000003'}`,
        );
        await client.query(`ANALYZE ${LAB}.${table}`);
      };

      await build(
        'inv_loc',
        20_000,
        'CASE WHEN g <= 10000 THEN 1 WHEN g <= 16000 THEN 2 WHEN g <= 19998 THEN 3 ELSE 4 END',
      );
      await build('inv_small', 1_500, 'CASE WHEN g <= 800 THEN 1 WHEN g <= 1498 THEN 2 ELSE 4 END');
      await build('inv_even', 20_000, '1 + (g % 4)');
      // The known false positive: the SAME shape as inv_loc, inserted in exact
      // `id` order, so consecutive index entries hit the same pinned page and
      // the generic plan reads ~1x instead of ~80x. Every scored input except
      // the ORDER column's correlation is identical to inv_loc's.
      // The buckets are assigned by a hash of `g` rather than by ranges of it,
      // so the FILTER column's correlation matches inv_loc's and the ONLY
      // statistic separating the two fixtures is the ORDER column's.
      await build(
        'inv_ordered',
        20_000,
        `CASE WHEN g IN (37, 15021) THEN 4
              WHEN (g * 2654435761::bigint) % 1000003 < 500000 THEN 1
              WHEN (g * 2654435761::bigint) % 1000003 < 800000 THEN 2
              ELSE 3 END`,
        'g',
      );

      // --- measure the real flip -------------------------------------------
      await client.query('SET synchronize_seqscans = off');
      await client.query('SET max_parallel_workers_per_gather = 0');
      await client.query('SET jit = off');
      const measure = async (table: string, value: number): Promise<void> => {
        await client.query(
          `PREPARE div_probe(int, int) AS
             SELECT * FROM ${LAB}.${table} WHERE organization_id = $1 ORDER BY id LIMIT $2`,
        );
        const explain = async (mode: string): Promise<{ buffers: number; shape: string }> => {
          await client.query(`SET plan_cache_mode = ${mode}`);
          const res = await client.query<{ 'QUERY PLAN': Array<{ Plan: Record<string, unknown> }> }>(
            `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) EXECUTE div_probe(${value}, 20)`,
          );
          const plan = res.rows[0]!['QUERY PLAN'][0]!.Plan;
          return { buffers: sharedBuffers(plan), shape: planShape(plan) };
        };
        const custom = await explain('force_custom_plan');
        const generic = await explain('force_generic_plan');
        measured[table] = {
          custom: custom.buffers,
          generic: generic.buffers,
          customPlan: custom.shape,
          genericPlan: generic.shape,
        };
        await client.query('RESET plan_cache_mode');
        await client.query('DEALLOCATE div_probe');
      };
      await measure('inv_loc', 4);
      await measure('inv_small', 4);
      await measure('inv_even', 1);
      await measure('inv_ordered', 4);

      // Does `auto` actually promote this shape? That is the difference between
      // exposure and an incident, and in THIS branch promotion happens exactly
      // when the workload keeps asking for the rare value.
      await client.query(
        `PREPARE promo(int, int) AS
           SELECT * FROM ${LAB}.inv_loc WHERE organization_id = $1 ORDER BY id LIMIT $2`,
      );
      for (let i = 0; i < 7; i++) await client.query('EXECUTE promo(4, 20)');
      const counters = await client.query<{ generic_plans: string; custom_plans: string }>(
        "SELECT generic_plans, custom_plans FROM pg_prepared_statements WHERE name = 'promo'",
      );
      promoted = {
        generic: Number(counters.rows[0]!.generic_plans),
        custom: Number(counters.rows[0]!.custom_plans),
      };
      await client.query('DEALLOCATE promo');

      schema = await introspect({ connectionString: DATABASE_URL!, schema: LAB });
      snapshot = await collectStatsSnapshot({
        connectionString: DATABASE_URL!,
        schema: LAB,
        tables: Object.keys(schema.tables),
        columns: [],
        distributionColumns: [...collectDivergenceCandidateColumns(schema), ...collectDivergenceOrderColumns(schema)],
      });
    } finally {
      await client.end();
    }
  });

  after(async () => {
    const client = new pg.Client({ connectionString: DATABASE_URL! });
    await client.connect();
    try {
      await client.query(`DROP SCHEMA IF EXISTS ${LAB} CASCADE`);
    } finally {
      await client.end();
    }
  });

  it('the fixture diverges through the NEW mechanism: seq scan against an ordered tuple walk', () => {
    const m = measured.inv_loc!;
    assert.match(m.customPlan, /Seq Scan/, `custom plan was not a seq scan: ${m.customPlan}`);
    assert.match(m.genericPlan, /Index Scan/, `generic plan was not an index scan: ${m.genericPlan}`);
    assert.doesNotMatch(m.customPlan, /Bitmap/, 'a bitmap path means the column was indexed after all');
    assert.ok(
      m.generic / m.custom >= 20,
      `expected >= 20x buffer amplification, got custom=${m.custom} generic=${m.generic}`,
    );
  });

  it('Postgres really promotes this shape when the workload asks for the rare value', () => {
    assert.ok(
      promoted.generic > 0,
      `expected the generic plan to be promoted under auto, got ${JSON.stringify(promoted)}`,
    );
  });

  it('flags exactly the unindexed columns, on the unindexed-filter branch', () => {
    const report = findPlanDivergence(schema, snapshot);
    // Both 20,000-row fixtures qualify. They are the SAME distribution and
    // differ only in the heap's physical order, which the scorer cannot use to
    // decide, only to qualify: see the false-positive test below.
    assert.equal(
      report.findings
        .map((f) => `${f.table}.${f.column}`)
        .sort()
        .join(','),
      'inv_loc.organization_id,inv_ordered.organization_id',
      `unexpected findings: ${JSON.stringify(report.findings, null, 2)}`,
    );
    const f = report.findings.find((x) => x.table === 'inv_loc')!;
    assert.equal(f.branch, 'unindexed-filter');
    assert.equal(f.orderColumn, 'id');
    assert.equal(f.columnField, 'organizationId');
    assert.ok(f.rarestBucket < f.assumedLimit);
    assert.ok((f.tuplesWalked ?? 0) >= f.thresholds.minGenericTupleWalk);
  });

  it('estimates the tuple walk and the amplification within measuring distance', () => {
    const f = findPlanDivergence(schema, snapshot).findings.find((x) => x.table === 'inv_loc')!;
    const m = measured.inv_loc!;
    // The generic plan fetches essentially every row one at a time, so the
    // measured buffer count and the estimated tuple walk should agree closely.
    assert.ok(
      Math.abs((f.tuplesWalked ?? 0) - m.generic) / m.generic < 0.05,
      `estimated ${f.tuplesWalked} tuples against ${m.generic} measured buffers`,
    );
    const measuredAmp = m.generic / m.custom;
    const estimated = f.worstCaseAmplification ?? 0;
    assert.ok(
      estimated > 1 && Math.abs(estimated - measuredAmp) / measuredAmp < 0.25,
      `estimated ${estimated}x against ${measuredAmp}x measured`,
    );
  });

  it('scores both controls and declines both, for the reason each was built to test', () => {
    const report = findPlanDivergence(schema, snapshot);
    // Both controls are relation-probe columns and both are unindexed, so all
    // four tables are in the scored population: the silence is a verdict.
    assert.equal(report.consideredUnindexed, 4);
    assert.equal(report.notices.length, 0);
    assert.equal(report.findings.filter((f) => f.table === 'inv_small').length, 0);
    assert.equal(report.findings.filter((f) => f.table === 'inv_even').length, 0);

    // ...and the small control genuinely flips, it is just too cheap to report.
    const small = measured.inv_small!;
    assert.match(small.customPlan, /Seq Scan/);
    assert.ok(small.generic / small.custom >= 20, `the small control stopped flipping: ${JSON.stringify(small)}`);
    // ...while the even control has no divergence at all: same plan both ways.
    const even = measured.inv_even!;
    assert.equal(even.customPlan, even.genericPlan);
  });

  it('lands on the same column the index advisor already names, so the report can join them', () => {
    const missing = findMissingRelationIndexes(schema);
    const divergent = findPlanDivergence(schema, snapshot).findings.find((f) => f.branch === 'unindexed-filter')!;
    const host = missing.find((m) => m.table === divergent.table && m.columns.join(',') === divergent.column);
    assert.ok(
      host,
      `no missing-index finding to attach ${divergent.table}.${divergent.column} to: ${JSON.stringify(missing)}`,
    );
    assert.equal(host.indexName, 'idx_inv_loc_organization_id');
  });

  it('hands back a diagnostic block that runs as written and leaves the session clean', async () => {
    const f = findPlanDivergence(schema, snapshot).findings[0]!;
    assert.match(f.diagnosticSql, /the fix for THIS finding is the missing index above/);
    const runnable = f.diagnosticSql
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('--'))
      .join('\n')
      .replaceAll('<your value>', '4')
      .replaceAll('EXPLAIN (ANALYZE, BUFFERS)', 'EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)');
    const client = new pg.Client({ connectionString: DATABASE_URL! });
    await client.connect();
    try {
      await client.query(`SET search_path = ${LAB}`);
      for (const statement of runnable.split('\n').join(' ').split(';')) {
        if (statement.trim() === '') continue;
        await client.query(statement);
      }
      // The block promises to put the session back: nothing pinned, nothing left
      // prepared.
      const settings = await client.query<{ plan_cache_mode: string; synchronize_seqscans: string }>(
        'SELECT current_setting($1) AS plan_cache_mode, current_setting($2) AS synchronize_seqscans',
        ['plan_cache_mode', 'synchronize_seqscans'],
      );
      assert.equal(settings.rows[0]!.plan_cache_mode, 'auto');
      assert.equal(settings.rows[0]!.synchronize_seqscans, 'on');
      const left = await client.query(
        "SELECT count(*)::int AS n FROM pg_prepared_statements WHERE name = 'turbine_divergence'",
      );
      assert.equal(left.rows[0]!.n, 0);
    } finally {
      await client.end();
    }
  });

  it('re-scoring AFTER adding the recommended index moves the finding to the sparse branch', async () => {
    // The index is the remedy, and it is measured to be the right one: the good
    // plan gets far cheaper and `auto` stops promoting the generic plan. But the
    // column then reappears as a sparse-value finding, so the report has to say
    // that in advance or the fix reads as a regression.
    const client = new pg.Client({ connectionString: DATABASE_URL! });
    await client.connect();
    try {
      await client.query(`CREATE INDEX idx_inv_loc_organization_id ON ${LAB}.inv_loc (organization_id)`);
      await client.query(`ANALYZE ${LAB}.inv_loc`);
      const after = await introspect({ connectionString: DATABASE_URL!, schema: LAB });
      const afterSnapshot = await collectStatsSnapshot({
        connectionString: DATABASE_URL!,
        schema: LAB,
        tables: Object.keys(after.tables),
        columns: [],
        distributionColumns: collectDivergenceCandidateColumns(after),
      });
      const report = findPlanDivergence(after, afterSnapshot);
      const f = report.findings.find((x) => x.table === 'inv_loc');
      assert.ok(f, `expected inv_loc to reappear, got ${JSON.stringify(report.findings.map((x) => x.table))}`);
      assert.equal(f.branch, 'sparse-value');
      assert.equal(findMissingRelationIndexes(after).filter((m) => m.table === 'inv_loc').length, 0);

      // ...and the promotion that made it an incident is gone: the custom plan
      // is now cheap enough that `auto` never prefers the generic estimate.
      await client.query('SET synchronize_seqscans = off');
      await client.query('SET max_parallel_workers_per_gather = 0');
      await client.query(
        `PREPARE after_probe(int, int) AS
           SELECT * FROM ${LAB}.inv_loc WHERE organization_id = $1 ORDER BY id LIMIT $2`,
      );
      for (let i = 0; i < 7; i++) await client.query('EXECUTE after_probe(4, 20)');
      const counters = await client.query<{ generic_plans: string }>(
        "SELECT generic_plans FROM pg_prepared_statements WHERE name = 'after_probe'",
      );
      assert.equal(Number(counters.rows[0]!.generic_plans), 0);
      await client.query('DEALLOCATE after_probe');
    } finally {
      await client.end();
    }
  });
  it('measures the exact-key-order false positive, and the finding discloses it', () => {
    // inv_ordered is inv_loc with one difference: the heap is in exact `id`
    // order. Every scored input except the ORDER column's correlation matches,
    // and the two read ~80x and ~1x.
    const scattered = measured.inv_loc!;
    const ordered = measured.inv_ordered!;
    assert.match(ordered.customPlan, /Seq Scan/);
    assert.match(ordered.genericPlan, /Index Scan/);
    assert.ok(
      ordered.generic / ordered.custom < 3,
      `expected the ordered heap to read ~1x, got custom=${ordered.custom} generic=${ordered.generic}`,
    );
    assert.ok(
      scattered.generic / scattered.custom > 8 * (ordered.generic / ordered.custom),
      'the two fixtures must differ by an order of magnitude, or this is not the false positive',
    );

    const report = findPlanDivergence(schema, snapshot);
    const a = report.findings.find((f) => f.table === 'inv_ordered');
    const b = report.findings.find((f) => f.table === 'inv_loc');
    assert.ok(a && b, 'both fixtures must be flagged: the scorer cannot tell them apart on its own');
    // Identical on every input the old revision printed...
    assert.equal(a.worstCaseAmplification !== undefined, true);
    assert.ok(Math.abs(a.correlation - b.correlation) < 0.05, 'the FILTER column statistic does not separate them');
    // ...and separated only by the ORDER column's correlation, which is now
    // carried and turned into a caveat rather than left out of the finding.
    assert.equal(a.heapNearlyOrdered, true, `inv_ordered order-column correlation ${a.orderColumnCorrelation}`);
    assert.equal(b.heapNearlyOrdered, false, `inv_loc order-column correlation ${b.orderColumnCorrelation}`);
    assert.ok((a.orderColumnCorrelation ?? 0) > 0.9999);
    assert.ok(Math.abs(b.orderColumnCorrelation ?? 1) < 0.01);
  });

  it('a hash index on the filter column is an equality path, not an unindexed column', async () => {
    // Measured: with a hash index the custom plan is a Bitmap Heap Scan reading
    // single-digit buffers, so calling the column unindexed would print a
    // 247-page seq scan as the good plan.
    const client = new pg.Client({ connectionString: DATABASE_URL! });
    await client.connect();
    try {
      await client.query(
        `CREATE TABLE ${LAB}.inv_hash (
           id int PRIMARY KEY,
           organization_id int NOT NULL REFERENCES ${LAB}.org(id),
           payload text NOT NULL)`,
      );
      await client.query(
        `INSERT INTO ${LAB}.inv_hash (id, organization_id, payload)
           SELECT g,
                  CASE WHEN g <= 10000 THEN 1 WHEN g <= 16000 THEN 2 WHEN g <= 19998 THEN 3 ELSE 4 END,
                  repeat('p', 60)
             FROM generate_series(1, 20000) g
            ORDER BY (g * 2654435761::bigint) % 1000003`,
      );
      await client.query(`CREATE INDEX inv_hash_org ON ${LAB}.inv_hash USING hash (organization_id)`);
      await client.query(`ANALYZE ${LAB}.inv_hash`);
      await client.query('SET synchronize_seqscans = off');
      await client.query('SET max_parallel_workers_per_gather = 0');
      await client.query(
        `PREPARE hash_probe(int, int) AS
           SELECT * FROM ${LAB}.inv_hash WHERE organization_id = $1 ORDER BY id LIMIT $2`,
      );
      await client.query('SET plan_cache_mode = force_custom_plan');
      const res = await client.query<{ 'QUERY PLAN': Array<{ Plan: Record<string, unknown> }> }>(
        'EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) EXECUTE hash_probe(4, 20)',
      );
      const plan = res.rows[0]!['QUERY PLAN'][0]!.Plan;
      assert.match(planShape(plan), /Bitmap/, 'a hash index must give the custom plan a bitmap path');
      await client.query('RESET plan_cache_mode');
      await client.query('DEALLOCATE hash_probe');

      const after = await introspect({ connectionString: DATABASE_URL!, schema: LAB });
      const afterSnapshot = await collectStatsSnapshot({
        connectionString: DATABASE_URL!,
        schema: LAB,
        tables: Object.keys(after.tables),
        columns: [],
        distributionColumns: [...collectDivergenceCandidateColumns(after), ...collectDivergenceOrderColumns(after)],
      });
      const report = findPlanDivergence(after, afterSnapshot);
      assert.equal(
        report.findings.some((f) => f.table === 'inv_hash' && f.branch === 'unindexed-filter'),
        false,
        'a hash-indexed column must never be reported as an unindexed filter',
      );
      await client.query(`DROP TABLE ${LAB}.inv_hash`);
    } finally {
      await client.end();
    }
  });
});
