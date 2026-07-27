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

/** Buffers this table has served, cluster-wide, flushed so the read is current. */
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

describe('forceCustomPlan against a live plan cache', () => {
  before(async () => {
    const db = turbine();
    try {
      await db.pool.query(SEED);
      await db.pool.query(`VACUUM (ANALYZE) ${TABLE}`);
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

  gate.it('withholding the name does NOT escape a connection pinned to force_generic_plan', async () => {
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

      const pinnedStart = await tableBuffers(db);
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

  gate.it('under the default client, the opted-in query really is planned with its values', async () => {
    // The positive half of the same measurement: same fixture, same sparse
    // tenant, no client-level setting. The named statement is free to promote,
    // the unnamed one cannot, and the buffers say which plan actually ran.
    const db = turbine();
    let disconnected = false;
    try {
      await prepareConnection(db);
      const rows = db.table<Row>(TABLE);
      const query = { where: { tenantId: SPARSE_TENANT }, orderBy: { id: 'asc' as const }, limit: 100 };
      const forcedStart = await tableBuffers(db);
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
        const plainStart = await tableBuffers(plain);
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
