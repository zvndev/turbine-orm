/**
 * turbine-orm - plan-divergence live test (DATABASE_URL-gated).
 *
 * Builds three tables that GENUINELY diverge, and asserts what the advisor does
 * with each. Two of the three are there to pin down its BOUNDARIES, which is
 * the part that was wrong before:
 *
 *   - `orders`, uncorrelated with a long tail. The generic estimate lands ABOVE
 *     the rare values, so the generic plan keeps the PK-ordered scan and walks
 *     most of the table to find one page of rows. This is the shape the advisor
 *     models, and it must be flagged.
 *   - `loc`, the same shape on a table of only ~285 pages. It diverges just as
 *     hard, which is why the advisor no longer carries a table-size floor: it
 *     must be flagged too.
 *   - `events`, physically clustered with one dominant value. It DOES diverge,
 *     and the advisor deliberately stays silent on it. A rule for this direction
 *     was tried and removed: whether the flip helps or hurts turns on where the
 *     dominant band physically sits, which no pg_stats input carries, and the
 *     rule got the SIGN wrong on live fixtures. Silence here is the assertion.
 *
 * For each table the flip itself is MEASURED: the same prepared statement is run
 * under `plan_cache_mode = force_custom_plan` and `force_generic_plan` and the
 * shared-buffer totals are compared. `synchronize_seqscans` is turned OFF first:
 * it is on by default and makes a repeated sequential scan resume where the last
 * one stopped, which can make a catastrophic case read as harmless.
 *
 * The fixture lives in its own schema and is dropped afterwards.
 *
 * Run: DATABASE_URL=postgres://... tsx --test src/test/plan-divergence.integration.test.ts
 */

import assert from 'node:assert/strict';
import { describe } from 'node:test';
import pg from 'pg';
import { collectStatsSnapshot, type StatsSnapshot } from '../index-stats.js';
import { introspect } from '../introspect.js';
import { collectDivergenceCandidateColumns, findPlanDivergence } from '../plan-divergence.js';
import type { SchemaMetadata } from '../schema.js';
import { skipGate } from './helpers.js';

const DATABASE_URL = process.env.DATABASE_URL;
const { it, before, after } = skipGate(!DATABASE_URL, 'requires DATABASE_URL');

const LAB = 'turbine_plan_divergence_lab';

/** Total shared buffers (hit + read + dirtied) reported by an EXPLAIN plan node. */
function sharedBuffers(node: Record<string, unknown>): number {
  const hit = Number(node['Shared Hit Blocks'] ?? 0);
  const read = Number(node['Shared Read Blocks'] ?? 0);
  return hit + read;
}

describe('plan-divergence advisor (live Postgres)', () => {
  let schema: SchemaMetadata;
  let snapshot: StatsSnapshot;
  let rarestTenant = 0;
  const measured: Record<string, { custom: number; generic: number }> = {};

  before(async () => {
    const client = new pg.Client({ connectionString: DATABASE_URL! });
    await client.connect();
    try {
      await client.query(`DROP SCHEMA IF EXISTS ${LAB} CASCADE`);
      await client.query(`CREATE SCHEMA ${LAB}`);
      await client.query(
        `CREATE TABLE ${LAB}.orders (
           id bigserial PRIMARY KEY,
           tenant_id int NOT NULL,
           filler text NOT NULL
         )`,
      );
      // 60k rows over ~48 tenants: one dominant tenant, a mid band, and a tail
      // of tenants with a handful of rows each. The tenant is derived from a
      // multiplicative hash of the sequence, so it is uncorrelated with the
      // physical order (that is what selects the sparse direction).
      await client.query(
        `INSERT INTO ${LAB}.orders (tenant_id, filler)
         SELECT CASE
                  WHEN r < 66000 THEN 0
                  WHEN r < 96000 THEN 1 + (r % 30)
                  WHEN r < 99900 THEN 31 + (r % 8)
                  ELSE 39 + (r % 9)
                END,
                repeat('x', 180)
           FROM (SELECT (g * 2654435761::bigint) % 100000 AS r
                   FROM generate_series(1, 60000) g) s`,
      );
      await client.query(`CREATE INDEX orders_tenant_idx ON ${LAB}.orders (tenant_id)`);
      await client.query(`ANALYZE ${LAB}.orders`);

      // The dense direction: the same size and cardinality, but one dominant
      // tenant whose rows are physically contiguous (inserted in one run).
      await client.query(
        `CREATE TABLE ${LAB}.events (
           id bigserial PRIMARY KEY,
           tenant_id int NOT NULL,
           filler text NOT NULL
         )`,
      );
      await client.query(
        `INSERT INTO ${LAB}.events (tenant_id, filler)
         SELECT CASE WHEN g <= 40000 THEN 0 ELSE 1 + ((g - 40000) % 59) END, repeat('x', 180)
           FROM generate_series(1, 60000) g`,
      );
      await client.query(`CREATE INDEX events_tenant_idx ON ${LAB}.events (tenant_id)`);
      await client.query(`ANALYZE ${LAB}.events`);

      // A SMALL table with the sparse shape: ~18.5k rows over ~285 pages, 83
      // tenants, one of them holding 60 rows. It diverges as hard as `orders`
      // does, which is the evidence behind dropping the old relpages >= 1000
      // floor: an ordered index scan's cost is driven by how much of the table
      // it walks, not by how big the table is.
      await client.query(
        `CREATE TABLE ${LAB}.loc (
           id bigserial PRIMARY KEY,
           tenant_id int NOT NULL,
           filler text NOT NULL
         )`,
      );
      await client.query(
        `INSERT INTO ${LAB}.loc (tenant_id, filler)
         SELECT ((g % 82) + 2), repeat('x', 80) FROM generate_series(1, 18440) g`,
      );
      await client.query(
        `INSERT INTO ${LAB}.loc (tenant_id, filler)
         SELECT 1, repeat('x', 80) FROM generate_series(1, 60) g`,
      );
      await client.query(`CREATE INDEX loc_tenant_idx ON ${LAB}.loc (tenant_id)`);
      await client.query(`ANALYZE ${LAB}.loc`);

      const rare = await client.query<{ tenant_id: number }>(
        `SELECT tenant_id FROM ${LAB}.orders GROUP BY 1 ORDER BY count(*) ASC LIMIT 1`,
      );
      rarestTenant = Number(rare.rows[0]!.tenant_id);

      // --- measure the real flip -------------------------------------------
      await client.query('SET synchronize_seqscans = off');
      await client.query('SET max_parallel_workers_per_gather = 0');
      await client.query('SET jit = off');
      const measure = async (table: string, value: number): Promise<void> => {
        await client.query(
          `PREPARE div_probe(int, int) AS
             SELECT * FROM ${LAB}.${table} WHERE tenant_id = $1 ORDER BY id LIMIT $2`,
        );
        const explain = async (mode: string): Promise<number> => {
          await client.query(`SET plan_cache_mode = ${mode}`);
          const res = await client.query<{ 'QUERY PLAN': Array<{ Plan: Record<string, unknown> }> }>(
            `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) EXECUTE div_probe(${value}, 20)`,
          );
          return sharedBuffers(res.rows[0]!['QUERY PLAN'][0]!.Plan);
        };
        measured[table] = { custom: await explain('force_custom_plan'), generic: await explain('force_generic_plan') };
        await client.query('DEALLOCATE div_probe');
      };
      // The rare tenant drives the sparse flip; the dominant one drives the dense flip.
      await measure('orders', rarestTenant);
      await measure('events', 0);
      await measure('loc', 1);

      schema = await introspect({ connectionString: DATABASE_URL!, schema: LAB });
      snapshot = await collectStatsSnapshot({
        connectionString: DATABASE_URL!,
        schema: LAB,
        tables: Object.keys(schema.tables),
        columns: [],
        distributionColumns: collectDivergenceCandidateColumns(schema),
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

  for (const table of ['orders', 'events', 'loc']) {
    it(`the ${table} fixture really does flip: the generic plan reads far more buffers`, () => {
      const m = measured[table]!;
      assert.ok(m.custom > 0, 'custom plan read no buffers');
      assert.ok(
        m.generic / m.custom >= 10,
        `expected >= 10x buffer amplification, got custom=${m.custom} generic=${m.generic}`,
      );
    });
  }

  it('collects the distribution statistics the check needs', () => {
    const dist = snapshot.columnStats?.['orders.tenant_id'];
    assert.ok(dist, 'no distribution stats collected for orders.tenant_id');
    assert.ok(dist.nDistinct !== 0);
    assert.ok(dist.mostCommonFreqs !== null && dist.mostCommonFreqs.length > 0);
    assert.equal(typeof dist.correlation, 'number');
    assert.ok((snapshot.tables.orders?.relpages ?? 0) > 0, 'relpages not collected');
  });

  it('flags the two sparse-shape columns, on both table sizes', () => {
    const report = findPlanDivergence(schema, snapshot);
    assert.equal(report.notices.length, 0);
    assert.equal(
      report.findings
        .map((f) => f.table)
        .sort()
        .join(','),
      'loc,orders',
      `unexpected findings: ${JSON.stringify(report.findings, null, 2)}`,
    );

    for (const table of ['orders', 'loc']) {
      const f = report.findings.find((x) => x.table === table)!;
      assert.ok(f, `${table}.tenant_id not flagged`);
      assert.equal(f.column, 'tenant_id');
      assert.equal(f.orderColumn, 'id');
      assert.equal(f.columnField, 'tenantId');
      assert.ok(f.rarestBucket < f.crossoverRows!);
      assert.ok(f.genericEstimate >= f.crossoverRows!);
      assert.ok(f.walkPages! >= f.thresholds.minWalkPages);
      assert.ok(f.walkFraction! >= f.thresholds.minWalkFraction);
    }

    // The small table is flagged despite being far under the OLD 1,000-page
    // floor, and it measurably deserves to be.
    const loc = report.findings.find((f) => f.table === 'loc')!;
    assert.ok(loc.pages < 1_000, `expected the small fixture to be under 1000 pages, got ${loc.pages}`);
  });

  it('stays silent on the clustered table, which diverges but is not modelled', () => {
    const report = findPlanDivergence(schema, snapshot);
    assert.equal(
      report.findings.filter((f) => f.table === 'events').length,
      0,
      'the removed dense rule fired again: it predicted the wrong SIGN on live fixtures',
    );
    // ...and it is silent by DESIGN, not because the fixture is tame: the same
    // table measured a real flip in the loop above.
    const m = measured.events!;
    assert.ok(m.generic / m.custom >= 10, `the clustered fixture stopped diverging: ${JSON.stringify(m)}`);
    const dist = snapshot.columnStats?.['events.tenant_id'];
    assert.ok(dist && Math.abs(dist.correlation ?? 0) >= 0.8, 'the clustered fixture stopped being clustered');
  });

  it('estimates amplification without claiming it as a bound', () => {
    const f = findPlanDivergence(schema, snapshot).findings.find((x) => x.table === 'orders')!;
    const m = measured.orders!;
    assert.ok(f.approxAmplification! > 1);
    // Documented as a rough scale, so this asserts the ORDER of magnitude in the
    // direction the model is biased (it under-reports, because it cannot see
    // where in the heap a value sits), not equality.
    assert.ok(
      m.generic / m.custom >= f.approxAmplification! / 10,
      `estimate ${f.approxAmplification!} was more than 10x optimistic against the measured ${m.generic / m.custom}`,
    );
  });

  it('hands back a diagnostic block that runs as written', async () => {
    const f = findPlanDivergence(schema, snapshot).findings.find((x) => x.table === 'orders')!;
    const runnable = f.diagnosticSql
      .split('\n')
      // The block is written for a human, so it carries `--` comments and a
      // "run it six times" marker. Strip those, then every remaining statement
      // must execute verbatim.
      .filter((line) => !line.trimStart().startsWith('--'))
      .join('\n')
      .replaceAll('<your value>', String(rarestTenant))
      .replaceAll('EXPLAIN (ANALYZE, BUFFERS)', 'EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)');
    const client = new pg.Client({ connectionString: DATABASE_URL! });
    await client.connect();
    try {
      await client.query(`SET search_path = ${LAB}`);
      for (const statement of runnable.split('\n').join(' ').split(';')) {
        if (statement.trim() === '') continue;
        await client.query(statement);
      }
    } finally {
      await client.end();
    }
  });
});
