/**
 * turbine-orm - plan-flip probe, live test (DATABASE_URL-gated).
 *
 * The pure tests assert that a verdict is APPLIED correctly. This one asserts
 * the verdict is CORRECT, which is the only claim that matters: the probe exists
 * because a statistics-only rule got this wrong two thirds of the time.
 *
 * Two fixtures differing in exactly one variable, the generic row estimate:
 *
 *   - `flip_lo`: 6,667 distinct values over 20,000 rows, generic estimate 3. The
 *     planner keeps a Seq Scan under `force_generic_plan`, so there is no flip to
 *     reach and the probe must REFUTE it.
 *   - `flip_hi`: 40 distinct values over 20,000 rows, generic estimate 500. The
 *     planner switches to an ordered primary-key walk, so the probe must CONFIRM
 *     it.
 *
 * Both are the same width, page count, insert order and index shape, so a test
 * that passed for a reason other than the estimate would have to explain what
 * else moved.
 *
 * The boundary is asserted too, at estimates 3 and 4, because the discarded
 * alternative to this probe was a rule gating on `estimate > assumedLimit` (20).
 * That rule would refute BOTH of the boundary fixtures; the measured boundary is
 * between 3 and 4, and `flip_4` is a full-table walk it would have discarded.
 * If the probe is ever replaced by arithmetic, this is the test that catches it.
 *
 * Run: DATABASE_URL=postgres://... tsx --test src/test/plan-flip-probe.integration.test.ts
 */

import assert from 'node:assert/strict';
import { describe } from 'node:test';
import type { PlanDivergenceFinding } from '../plan-divergence.js';
import { flipProbeKey, probePlanFlips } from '../plan-flip-probe.js';
import { skipGate } from './helpers.js';

const { it, before: gatedBefore, after: gatedAfter } = skipGate(!process.env.DATABASE_URL, 'DATABASE_URL not set');

const URL = process.env.DATABASE_URL ?? '';

/** One fixture: `n` distinct values over 20,000 rows, so the estimate is 20000/n. */
const FIXTURES: { table: string; distinct: number; estimate: number; expect: 'no-flip' | 'flip-reachable' }[] = [
  { table: 'flip_lo', distinct: 6667, estimate: 3, expect: 'no-flip' },
  { table: 'flip_4', distinct: 5000, estimate: 4, expect: 'flip-reachable' },
  { table: 'flip_hi', distinct: 40, estimate: 500, expect: 'flip-reachable' },
];

function finding(table: string): PlanDivergenceFinding {
  return {
    branch: 'unindexed-filter',
    table,
    column: 'fk',
    rows: 20000,
    pages: 247,
    distinctValues: 1,
    genericEstimate: 1,
    rarestBucket: 2,
    densestBucket: 2,
    correlation: 0,
    assumedLimit: 20,
    orderColumn: 'id',
    columnField: 'fk',
    orderColumnField: 'id',
  } as PlanDivergenceFinding;
}

async function sql(text: string): Promise<void> {
  const { Pool } = (await import('pg')).default;
  const pool = new Pool({ connectionString: URL, max: 1 });
  try {
    await pool.query(text);
  } finally {
    await pool.end();
  }
}

describe('plan-flip probe against a live planner', () => {
  gatedBefore(async () => {
    for (const f of FIXTURES) {
      await sql(`
        DROP TABLE IF EXISTS ${f.table};
        CREATE TABLE ${f.table} (id int PRIMARY KEY, fk int NOT NULL, payload text NOT NULL);
        INSERT INTO ${f.table}
          SELECT g, ((g-1) % ${f.distinct}) + 1, repeat('p', 60)
          FROM generate_series(1, 20000) g
          ORDER BY (g * 2654435761::bigint) % 1000003;
        ANALYZE ${f.table};
      `);
    }
  });

  gatedAfter(async () => {
    for (const f of FIXTURES) await sql(`DROP TABLE IF EXISTS ${f.table}`);
  });

  it('refutes the low-estimate column and confirms the high-estimate one', async () => {
    const findings = FIXTURES.map((f) => finding(f.table));
    const result = await probePlanFlips({ connectionString: URL, findings });

    assert.equal(result.available, true, 'the probe pass should have run');
    for (const f of FIXTURES) {
      assert.equal(
        result.verdicts[flipProbeKey(f.table, 'fk')],
        f.expect,
        `${f.table} (generic estimate ${f.estimate}) should be ${f.expect}`,
      );
    }
  });

  it('puts the boundary between estimates 3 and 4, not at the assumed LIMIT of 20', async () => {
    // The discarded arithmetic gate was `estimate > assumedLimit`. It would call
    // both of these un-flippable; the planner calls one of them a full-table walk.
    const result = await probePlanFlips({
      connectionString: URL,
      findings: [finding('flip_lo'), finding('flip_4')],
    });
    assert.equal(result.verdicts[flipProbeKey('flip_lo', 'fk')], 'no-flip');
    assert.equal(result.verdicts[flipProbeKey('flip_4', 'fk')], 'flip-reachable');
  });

  it('executes nothing: the probe leaves no row-level trace and the table is untouched', async () => {
    const { Pool } = (await import('pg')).default;
    const pool = new Pool({ connectionString: URL, max: 1 });
    try {
      const before = await pool.query<{ n: string }>('SELECT count(*)::text AS n FROM flip_hi');
      await probePlanFlips({ connectionString: URL, findings: [finding('flip_hi')] });
      const after = await pool.query<{ n: string }>('SELECT count(*)::text AS n FROM flip_hi');
      assert.equal(after.rows[0]!.n, before.rows[0]!.n);
      // And no probe statement survives the pass on a fresh session.
      const prepared = await pool.query<{ name: string }>(
        `SELECT name FROM pg_prepared_statements WHERE name LIKE 'tpf\\_%'`,
      );
      assert.equal(prepared.rows.length, 0, 'no probe statement should outlive the probe');
    } finally {
      await pool.end();
    }
  });

  it('keeps a finding whose table does not exist rather than dropping it', async () => {
    // The failure contract, live: an unprobeable column must survive.
    const result = await probePlanFlips({
      connectionString: URL,
      findings: [finding('flip_does_not_exist')],
    });
    assert.equal(result.verdicts[flipProbeKey('flip_does_not_exist', 'fk')], 'unknown');
    assert.ok(result.notices.some((n) => /inconclusive/.test(n)));
  });

  it('survives a failing probe and still answers the ones after it', async () => {
    // One bad column must not poison the savepointed transaction for the rest.
    const result = await probePlanFlips({
      connectionString: URL,
      findings: [finding('flip_does_not_exist'), finding('flip_hi'), finding('flip_lo')],
    });
    assert.equal(result.verdicts[flipProbeKey('flip_does_not_exist', 'fk')], 'unknown');
    assert.equal(result.verdicts[flipProbeKey('flip_hi', 'fk')], 'flip-reachable');
    assert.equal(result.verdicts[flipProbeKey('flip_lo', 'fk')], 'no-flip');
  });
});
