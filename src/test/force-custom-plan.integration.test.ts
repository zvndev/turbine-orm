/**
 * turbine-orm, the per-query `forceCustomPlan` option against a live backend.
 *
 * The claim under test has two halves, and both are MEASURED here rather than
 * asserted from the mechanism:
 *
 *   1. A query that asks for it produces NO named prepared statement. Read off
 *      `pg_prepared_statements` over the same pooled connection, which is
 *      session-scoped, so an empty result is proof the statement never entered
 *      the plan cache. The same query WITHOUT the option does produce one, and
 *      on this fixture the backend promotes it to a GENERIC plan
 *      (`generic_plans > 0`) partway through the run.
 *
 *   2. It does NOT win over a client-level `planCacheMode:
 *      'force_generic_plan'`, which is the opposite of what the mechanism
 *      suggests and is why that combination is refused rather than accepted.
 *      The natural reading (a one-shot plan is always custom, so an unnamed
 *      statement escapes the setting) is measurably wrong here: with the
 *      setting in force the unnamed statement reads the generic plan's buffer
 *      count, and reads the custom plan's as soon as the same connection is set
 *      back to `auto`. Measured in BUFFERS on the same table, because that is
 *      the thing the plan flip actually changes.
 *
 * THE FIXTURE, one table serving two different divergences, because "sparse
 * tenant" is not the predictor:
 *
 *   - tenant 2 is DENSE (40k rows) while the generic estimate for an equality
 *     is rows / n_distinct (~3.3k), so the generic plan is costed for a tenth
 *     of the rows it will actually sort. That is what makes it look CHEAPER
 *     than the average custom plan and get promoted under the default `auto`.
 *   - tenant 1 is SPARSE (500 rows) and clustered at the end of the id order,
 *     so a generic plan costed for ~3.3k rows prefers an ordered primary-key
 *     scan under `ORDER BY id LIMIT n` and has to discard essentially the whole
 *     table before it finds a match, while the custom plan takes a 12-buffer
 *     bitmap scan.
 *
 * Both queries are emitted by Turbine's own `findMany`, so the SQL under test
 * is the SQL an application gets, `LIMIT $n` included.
 *
 * `synchronize_seqscans` is off on every connection: a repeated sequential scan
 * that resumes where the last one stopped can make a catastrophic plan read as
 * harmless. Parallel workers are off for the same reason (they change the
 * buffer accounting without changing the plan class under test).
 *
 * Requires DATABASE_URL. Run: npx tsx --test src/test/force-custom-plan.integration.test.ts
 */

import assert from 'node:assert/strict';
import { describe } from 'node:test';
import { TurbineClient } from '../client.js';
import type { SchemaMetadata } from '../schema.js';
import { mockTable, skipGate } from './helpers.js';

const DATABASE_URL = process.env.DATABASE_URL;
// The HOOKS come from the gate too, not from node:test directly. Taking the raw
// `before`/`after` here would open a pool with `connectionString: undefined` on
// a machine with no DATABASE_URL, which fails the unit gate the repo promises
// runs without a database.
const gate = skipGate(!DATABASE_URL, 'DATABASE_URL not set');
const { before, after } = gate;

const TABLE = 'turbine_force_custom_plan_rows';
const SPARSE_TENANT = 1;
const DENSE_TENANT = 2;

interface Row {
  id: number;
  tenantId: number;
  amount: number;
}

const schema: SchemaMetadata = {
  tables: {
    [TABLE]: mockTable(TABLE, [
      { name: 'id', field: 'id', pgType: 'int8' },
      { name: 'tenant_id', field: 'tenantId', pgType: 'int4' },
      { name: 'amount', field: 'amount', pgType: 'int4' },
    ]),
  },
  enums: {},
};

/**
 * 200k rows over 60 tenants. Tenant 2 takes 40k (12x its share), tenant 1 takes
 * 500 and is inserted LAST so its ids are the highest in the table, and the
 * remaining 58 tenants split the rest. `amount` is deliberately unindexed: the
 * dense-tenant query has to sort, which is the cost the generic plan
 * underestimates.
 */
const SEED = `
  DROP TABLE IF EXISTS ${TABLE};
  CREATE TABLE ${TABLE} (
    id        bigserial PRIMARY KEY,
    tenant_id int NOT NULL,
    amount    int NOT NULL,
    payload   text NOT NULL
  );
  INSERT INTO ${TABLE} (tenant_id, amount, payload)
  SELECT CASE WHEN g % 5 = 0 THEN ${DENSE_TENANT} ELSE 3 + (g % 58) END,
         ((g::bigint * 7919) % 100000)::int,
         repeat('x', 80)
  FROM generate_series(1, 199500) g;
  INSERT INTO ${TABLE} (tenant_id, amount, payload)
  SELECT ${SPARSE_TENANT}, ((g::bigint * 7919) % 100000)::int, repeat('x', 80)
  FROM generate_series(1, 500) g;
  CREATE INDEX ${TABLE}_tenant_idx ON ${TABLE} (tenant_id);
`;

/** What the backend recorded about the statements on ONE connection. */
interface PlanRecord {
  statements: { name: string; generic: number; custom: number }[];
}

function turbine(planCacheMode?: 'auto' | 'force_custom_plan' | 'force_generic_plan') {
  return new TurbineClient(
    { connectionString: DATABASE_URL, poolSize: 1, planCacheMode, warnOnUnlimited: false },
    schema,
  );
}

/** Pin the measurement conditions on the single connection this client owns. */
async function prepareConnection(db: TurbineClient): Promise<void> {
  await db.pool.query('SET synchronize_seqscans = off');
  await db.pool.query('SET max_parallel_workers_per_gather = 0');
  await db.pool.query('DEALLOCATE ALL');
}

/**
 * Does the fixture still DISCRIMINATE, i.e. would a value-aware plan for the
 * sparse tenant use the index?
 *
 * The two buffer-count cases below infer which plan ran from how much I/O it
 * did, and that inference is only valid while the two plans cost visibly
 * different amounts. If the planner's statistics do not currently show the
 * sparse tenant as sparse, BOTH plans seq scan, both readings land on the same
 * number, and the assertion reports a product defect that is really a fixture
 * that has stopped carrying signal. Observed exactly once in CI as
 * `pinned=19107 auto=19105`: two readings 0.01% apart, which is not a
 * measurement of anything.
 *
 * So the precondition is re-established (ANALYZE) and then CHECKED against the
 * planner's own answer rather than assumed. A case whose fixture cannot
 * discriminate skips with the plan in the message, which is the honest report:
 * the measurement was not available, not that the feature is broken.
 */
async function sparsePlanUsesIndex(db: TurbineClient): Promise<string | null> {
  await db.pool.query(`ANALYZE ${TABLE}`);
  const explained = await db.pool.query(
    `EXPLAIN (FORMAT JSON) SELECT id, tenant_id, amount FROM ${TABLE} WHERE tenant_id = ${SPARSE_TENANT} ORDER BY id ASC LIMIT 100`,
  );
  const plan = JSON.stringify(explained.rows[0]?.['QUERY PLAN'] ?? explained.rows[0] ?? {});
  return /Index (Only )?Scan|Bitmap Heap Scan/.test(plan)
    ? null
    : `the fixture no longer discriminates: a value-aware plan for the sparse tenant does not use an index (${plan.slice(0, 200)})`;
}

async function planRecord(db: TurbineClient): Promise<PlanRecord> {
  const res = await db.pool.query('SELECT name, generic_plans, custom_plans FROM pg_prepared_statements ORDER BY name');
  return {
    statements: res.rows.map((r: Record<string, unknown>) => ({
      name: String(r.name),
      generic: Number(r.generic_plans),
      custom: Number(r.custom_plans),
    })),
  };
}

/**
 * Buffers this table has served, cluster-wide, flushed so the read is current.
 *
 * `pg_stat_force_next_flush()` arrived with the shared-memory stats collector
 * in PostgreSQL 15 and does not exist on 14, where calling it is a hard 42883
 * that fails the test rather than the feature. On 14 the stats collector
 * flushes on its own schedule, so there is nothing to force and nothing to
 * substitute: the two cases that read buffer counts skip there (see
 * {@link bufferStatsAvailable}), and this helper is only ever reached when they
 * do not.
 */
async function tableBuffers(db: TurbineClient): Promise<number> {
  await db.pool.query('SELECT pg_stat_force_next_flush()');
  const res = await db.pool.query(
    `SELECT coalesce(heap_blks_read, 0) + coalesce(heap_blks_hit, 0)
       + coalesce(idx_blks_read, 0) + coalesce(idx_blks_hit, 0) AS blks
     FROM pg_statio_user_tables WHERE relname = $1`,
    [TABLE],
  );
  return Number(res.rows[0]?.blks ?? 0);
}

/**
 * Wait until this table's buffer counter stops moving, then return it.
 *
 * `pg_stat_force_next_flush()` flushes the CALLING backend's pending stats and
 * nobody else's; every other backend flushes on its own ~1s cadence. The cases
 * below each open their own client on this same table, so an earlier case's
 * counts can land inside a later case's measurement window and inflate the
 * baseline-to-end delta by an unrelated amount. The `forced * 10 < plain` ratio
 * survives a little of that and not a lot, which showed up as this file passing
 * alone and failing about half the time inside the full parallel suite.
 *
 * Two equal consecutive reads mean nothing is still in flight. If it never
 * settles, the caller SKIPS: a measurement taken on a moving counter proves
 * nothing either way, and turning that into a failure is how a suite learns to
 * ignore its own red.
 */
async function settledTableBuffers(db: TurbineClient): Promise<number | null> {
  const deadline = Date.now() + 5_000;
  let previous = await tableBuffers(db);
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 250));
    const current = await tableBuffers(db);
    if (current === previous) return current;
    previous = current;
  }
  return null;
}

const UNSETTLED = 'table stats never went quiet, so a buffer delta would include reads from another backend';

/**
 * Is the on-demand stats flush available (PostgreSQL >= 15)?
 *
 * Resolved in `before`, because the answer needs a connection, and consumed
 * INSIDE the affected tests via `t.skip()` rather than through the `skip`
 * option. The option is evaluated when the file is collected, which is before
 * any `before` hook has run, so a gate written that way reads `undefined` on
 * every server and fires on none of them.
 */
let bufferStatsAvailable: boolean | undefined;
const NEEDS_BUFFER_STATS = 'pg_stat_force_next_flush() needs PostgreSQL 15 or newer';

describe('forceCustomPlan against a live plan cache', () => {
  before(async () => {
    const db = turbine();
    try {
      await db.pool.query(SEED);
      await db.pool.query(`VACUUM (ANALYZE) ${TABLE}`);
      const probe = await db.pool.query("SELECT to_regprocedure('pg_stat_force_next_flush()') IS NOT NULL AS ok");
      bufferStatsAvailable = probe.rows[0]?.ok === true;
    } finally {
      await db.disconnect();
    }
  });

  after(async () => {
    const db = turbine();
    try {
      await db.pool.query(`DROP TABLE IF EXISTS ${TABLE}`);
    } finally {
      await db.disconnect();
    }
  });

  gate.it('without the option: one named statement, promoted to a generic plan', async () => {
    const db = turbine();
    try {
      await prepareConnection(db);
      const rows = db.table<Row>(TABLE);
      for (let i = 0; i < 12; i++) {
        await rows.findMany({ where: { tenantId: DENSE_TENANT }, orderBy: { amount: 'desc' }, limit: 100 });
      }
      const record = await planRecord(db);
      assert.equal(record.statements.length, 1, 'the read is executed as a named prepared statement');
      const stmt = record.statements[0]!;
      assert.equal(stmt.custom + stmt.generic, 12, 'every execution accounted for');
      assert.ok(
        stmt.generic > 0,
        `expected the backend to promote this statement to a generic plan, got ${JSON.stringify(stmt)}`,
      );
    } finally {
      await db.disconnect();
    }
  });

  gate.it('with the option: no prepared statement exists, so nothing can promote', async () => {
    const db = turbine();
    try {
      await prepareConnection(db);
      const rows = db.table<Row>(TABLE);
      for (let i = 0; i < 12; i++) {
        await rows.findMany({
          where: { tenantId: DENSE_TENANT },
          orderBy: { amount: 'desc' },
          limit: 100,
          forceCustomPlan: true,
        });
      }
      const record = await planRecord(db);
      assert.deepEqual(
        record.statements,
        [],
        `expected pg_prepared_statements to be empty, got ${JSON.stringify(record.statements)}`,
      );
    } finally {
      await db.disconnect();
    }
  });

  gate.it('the same client can do both, one query at a time', async () => {
    // The point of a per-query option: it does not change the connection, so
    // the very next query on the same connection is back to the default.
    const db = turbine();
    try {
      await prepareConnection(db);
      const rows = db.table<Row>(TABLE);
      for (let i = 0; i < 12; i++) {
        await rows.findMany({
          where: { tenantId: DENSE_TENANT },
          orderBy: { amount: 'desc' },
          limit: 100,
          forceCustomPlan: true,
        });
      }
      assert.deepEqual((await planRecord(db)).statements, [], 'opted-out query cached nothing');
      await rows.findMany({ where: { tenantId: DENSE_TENANT }, orderBy: { amount: 'desc' }, limit: 100 });
      assert.equal((await planRecord(db)).statements.length, 1, 'the next query is named again');
    } finally {
      await db.disconnect();
    }
  });

  gate.it('withholding the name does NOT escape a connection pinned to force_generic_plan', async (t) => {
    if (bufferStatsAvailable === false) return t.skip(NEEDS_BUFFER_STATS);
    {
      const probe = turbine();
      try {
        const why = await sparsePlanUsesIndex(probe);
        if (why) return t.skip(why);
      } finally {
        await probe.disconnect();
      }
    }
    // THE MEASUREMENT BEHIND THE REFUSAL, and the reason the refusal exists.
    // The natural reading of the mechanism (a one-shot plan is always custom)
    // predicts that an unnamed statement escapes `plan_cache_mode`. It does
    // not. On this fixture the sparse clustered tenant costs ~11 buffers under
    // a custom plan and ~3.8k under a generic one, and the UNNAMED statement
    // reads the generic number while the setting is in force, then the custom
    // number as soon as the same connection is set back to `auto`. Nothing
    // about the statement changed in between.
    //
    // This test drives the raw connection rather than a Turbine query, because
    // Turbine now REFUSES that combination (see the next test); this is the
    // evidence that the refusal is right rather than pessimistic.
    const db = turbine('force_generic_plan');
    try {
      await prepareConnection(db);
      const mode = await db.pool.query('SHOW plan_cache_mode');
      assert.equal(mode.rows[0]!.plan_cache_mode, 'force_generic_plan', 'the connection really is pinned generic');
      const sql = `SELECT id, tenant_id, amount FROM ${TABLE} WHERE tenant_id = $1 ORDER BY id ASC LIMIT $2`;

      const pinnedStart = await settledTableBuffers(db);
      if (pinnedStart === null) return t.skip(UNSETTLED);
      for (let i = 0; i < 5; i++) await db.pool.query(sql, [SPARSE_TENANT, 100]);
      const pinnedBuffers = (await tableBuffers(db)) - pinnedStart;

      await db.pool.query('SET plan_cache_mode = auto');
      const autoStart = await tableBuffers(db);
      for (let i = 0; i < 5; i++) await db.pool.query(sql, [SPARSE_TENANT, 100]);
      const autoBuffers = (await tableBuffers(db)) - autoStart;

      assert.deepEqual((await planRecord(db)).statements, [], 'both runs were unnamed');
      assert.ok(
        autoBuffers * 10 < pinnedBuffers,
        `the unnamed statement was planned generically under the setting: pinned=${pinnedBuffers} auto=${autoBuffers}`,
      );
    } finally {
      await db.disconnect();
    }
  });

  gate.it('so the option refuses that client configuration instead of pretending', async () => {
    const db = turbine('force_generic_plan');
    try {
      await prepareConnection(db);
      await assert.rejects(
        () =>
          db.table<Row>(TABLE).findMany({
            where: { tenantId: SPARSE_TENANT },
            orderBy: { id: 'asc' },
            limit: 100,
            forceCustomPlan: true,
          }),
        /force_generic_plan/,
      );
      // The same client keeps working for every query that does not ask.
      const rows = await db.table<Row>(TABLE).findMany({
        where: { tenantId: SPARSE_TENANT },
        orderBy: { id: 'asc' },
        limit: 10,
      });
      assert.equal(rows.length, 10);
    } finally {
      await db.disconnect();
    }
  });

  gate.it('under the default client, the opted-in query really is planned with its values', async (t) => {
    if (bufferStatsAvailable === false) return t.skip(NEEDS_BUFFER_STATS);
    {
      const probe = turbine();
      try {
        const why = await sparsePlanUsesIndex(probe);
        if (why) return t.skip(why);
      } finally {
        await probe.disconnect();
      }
    }
    // The positive half of the same measurement: same fixture, same sparse
    // tenant, no client-level setting. The named statement is free to promote,
    // the unnamed one cannot, and the buffers say which plan actually ran.
    const db = turbine();
    let disconnected = false;
    try {
      await prepareConnection(db);
      const rows = db.table<Row>(TABLE);
      const query = { where: { tenantId: SPARSE_TENANT }, orderBy: { id: 'asc' as const }, limit: 100 };
      const forcedStart = await settledTableBuffers(db);
      if (forcedStart === null) return t.skip(UNSETTLED);
      for (let i = 0; i < 12; i++) await rows.findMany({ ...query, forceCustomPlan: true });
      const forcedBuffers = (await tableBuffers(db)) - forcedStart;
      assert.deepEqual((await planRecord(db)).statements, [], 'none of the 12 cached a statement');

      // The same 12 executions without the option, on a fresh connection: the
      // statement is cached, promoted partway through, and the promoted plan
      // reads the whole table on every execution afterwards. This is the cliff
      // the option exists for, on Turbine's own SQL, `LIMIT $n` and all.
      await db.disconnect();
      disconnected = true;
      const plain = turbine();
      try {
        await prepareConnection(plain);
        const plainStart = await settledTableBuffers(plain);
        if (plainStart === null) return t.skip(UNSETTLED);
        for (let i = 0; i < 12; i++) await plain.table<Row>(TABLE).findMany(query);
        const plainBuffers = (await tableBuffers(plain)) - plainStart;
        const record = await planRecord(plain);
        assert.ok(record.statements[0]!.generic > 0, 'the default run really did promote to a generic plan');
        assert.ok(
          forcedBuffers * 10 < plainBuffers,
          `expected the opted-in run to read far fewer buffers: forced=${forcedBuffers} default=${plainBuffers}`,
        );
      } finally {
        await plain.disconnect();
      }
    } finally {
      if (!disconnected) await db.disconnect();
    }
  });

  gate.it('returns identical rows either way', async () => {
    // A plan choice must never be observable in the result.
    const db = turbine();
    try {
      await prepareConnection(db);
      const rows = db.table<Row>(TABLE);
      const query = { where: { tenantId: SPARSE_TENANT }, orderBy: { id: 'asc' as const }, limit: 25 };
      const plain = await rows.findMany(query);
      const forced = await rows.findMany({ ...query, forceCustomPlan: true });
      assert.deepEqual(forced, plain);
      assert.equal(plain.length, 25);
    } finally {
      await db.disconnect();
    }
  });
});
