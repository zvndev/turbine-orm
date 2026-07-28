/**
 * turbine-orm/prisma-compat, turbine-native query options measured AT THE WIRE
 * against a live PostgreSQL backend.
 *
 * WHY THIS FILE AND NOT JUST THE UNIT TEST. The bug this exists for was that
 * `forceCustomPlan` reached the caller's type-checker and then nothing. An
 * assertion that the key appears on the translated args object is the layer the
 * bug hid behind: the args object was never the question, the prepared
 * statement was. So the headline test reads `pg_prepared_statements`, which is
 * SESSION-scoped, over a pool of exactly one connection, and asserts the
 * statement is not there.
 *
 * The other options that were stranded are checked the same way wherever an
 * observable consequence exists: rows that a configured global filter would
 * otherwise have removed, a mutation the empty-where guard would otherwise have
 * refused, a version mismatch that must raise E015, a per-relation follow-up
 * statement instead of one `json_agg` join, a warning that must not be printed.
 *
 * `synchronize_seqscans` and parallel workers are pinned off on the measured
 * connection: a repeated sequential scan that resumes where the last one
 * stopped can make a catastrophic plan read as harmless.
 *
 * Requires DATABASE_URL.
 * Run: npx tsx --test src/test/prisma-compat-native-options.integration.test.ts
 */

import assert from 'node:assert/strict';
import { describe } from 'node:test';
import { TurbineClient } from '../client.js';
import { TurbineError, TurbineErrorCode } from '../errors.js';
import { createPrismaCompatClient } from '../prisma-compat.js';
import { UNSAFE } from '../query/index.js';
import type { PrismaCompatMap, SchemaMetadata } from '../schema.js';
import { mockTable, skipGate } from './helpers.js';

const DATABASE_URL = process.env.DATABASE_URL;
const gate = skipGate(!DATABASE_URL, 'DATABASE_URL not set');
const { before, after } = gate;

const TABLE = 'turbine_compat_option_events';
const CHILD = 'turbine_compat_option_notes';
const DENSE_TENANT = 2;

// biome-ignore lint/suspicious/noExplicitAny: the compat surface is intentionally loose
type Any = any;

/**
 * Same shape as the core `forceCustomPlan` fixture, because it is the shape the
 * backend has been observed to PROMOTE: 200k rows over 60 tenants, tenant 2
 * taking twelve times its share so the generic estimate (rows / n_distinct) is
 * far below the truth, and `amount` left unindexed so the dense read must sort.
 */
const SEED = `
  DROP TABLE IF EXISTS ${CHILD};
  DROP TABLE IF EXISTS ${TABLE};
  CREATE TABLE ${TABLE} (
    id         bigserial PRIMARY KEY,
    tenant_id  int NOT NULL,
    amount     int NOT NULL,
    row_version int NOT NULL DEFAULT 1,
    archived   boolean NOT NULL DEFAULT false,
    payload    text NOT NULL
  );
  INSERT INTO ${TABLE} (tenant_id, amount, archived, payload)
  SELECT CASE WHEN g % 5 = 0 THEN ${DENSE_TENANT} ELSE 3 + (g % 58) END,
         ((g::bigint * 7919) % 100000)::int,
         g % 1000 = 0,
         repeat('x', 80)
  FROM generate_series(1, 199500) g;
  CREATE INDEX ${TABLE}_tenant_idx ON ${TABLE} (tenant_id);
  CREATE TABLE ${CHILD} (
    id       bigserial PRIMARY KEY,
    event_id bigint NOT NULL REFERENCES ${TABLE}(id),
    body     text NOT NULL
  );
  INSERT INTO ${CHILD} (event_id, body)
  SELECT id, 'note' FROM ${TABLE} WHERE tenant_id = ${DENSE_TENANT} LIMIT 50;
  CREATE INDEX ${CHILD}_event_idx ON ${CHILD} (event_id);
`;

function buildSchema(): SchemaMetadata {
  const events = mockTable(TABLE, [
    { name: 'id', field: 'id', pgType: 'int8' },
    { name: 'tenant_id', field: 'tenantId', pgType: 'int4' },
    { name: 'amount', field: 'amount', pgType: 'int4' },
    { name: 'row_version', field: 'rowVersion', pgType: 'int4' },
    { name: 'archived', field: 'archived', pgType: 'bool' },
    { name: 'payload', field: 'payload', pgType: 'text' },
  ]);
  events.primaryKey = ['id'];
  events.uniqueColumns = [['id']];
  events.relations = {
    notes: { type: 'hasMany', name: 'notes', from: TABLE, to: CHILD, foreignKey: 'event_id', referenceKey: 'id' },
  };

  const notes = mockTable(CHILD, [
    { name: 'id', field: 'id', pgType: 'int8' },
    { name: 'event_id', field: 'eventId', pgType: 'int8' },
    { name: 'body', field: 'body', pgType: 'text' },
  ]);
  notes.primaryKey = ['id'];

  return { enums: {}, tables: { [TABLE]: events, [CHILD]: notes } };
}

/**
 * The Prisma model map. `version` / `isArchived` deliberately DIVERGE from the
 * turbine field names, so an option whose value carries a field name has to be
 * translated to work at all.
 */
const MAP: PrismaCompatMap = {
  enums: {},
  models: {
    Event: {
      table: TABLE,
      accessor: 'events',
      fields: {
        id: 'id',
        tenantId: 'tenantId',
        amount: 'amount',
        version: 'rowVersion',
        isArchived: 'archived',
        payload: 'payload',
      },
      relations: { notes: { name: 'notes', cardinality: 'many' } },
      compoundUniques: {},
    },
    Note: {
      table: CHILD,
      accessor: 'notes',
      fields: { id: 'id', eventId: 'eventId', body: 'body' },
      relations: {},
      compoundUniques: {},
    },
  },
};

interface ClientOptions {
  globalFilters?: Record<string, unknown>;
  warnOnUnlimited?: boolean;
}

function turbine(opts: ClientOptions = {}): TurbineClient {
  return new TurbineClient(
    {
      connectionString: DATABASE_URL,
      poolSize: 1,
      warnOnUnlimited: opts.warnOnUnlimited ?? false,
      globalFilters: opts.globalFilters as Any,
    },
    buildSchema(),
  );
}

function compatOf(db: TurbineClient): Any {
  return createPrismaCompatClient(db as unknown as TurbineClient, MAP) as Any;
}

/** Pin the measurement conditions on the single connection this client owns. */
async function prepareConnection(db: TurbineClient): Promise<void> {
  await db.pool.query('SET synchronize_seqscans = off');
  await db.pool.query('SET max_parallel_workers_per_gather = 0');
  await db.pool.query('DEALLOCATE ALL');
}

async function preparedStatements(db: TurbineClient): Promise<{ name: string; generic: number; custom: number }[]> {
  const res = await db.pool.query('SELECT name, generic_plans, custom_plans FROM pg_prepared_statements ORDER BY name');
  return res.rows.map((r: Record<string, unknown>) => ({
    name: String(r.name),
    generic: Number(r.generic_plans),
    custom: Number(r.custom_plans),
  }));
}

describe('prisma-compat, native query options at the wire', () => {
  before(async () => {
    const db = turbine();
    try {
      await db.pool.query(SEED);
      await db.pool.query(`VACUUM (ANALYZE) ${TABLE}`);
      await db.pool.query(`VACUUM (ANALYZE) ${CHILD}`);
    } finally {
      await db.disconnect();
    }
  });

  after(async () => {
    const db = turbine();
    try {
      await db.pool.query(`DROP TABLE IF EXISTS ${CHILD}`);
      await db.pool.query(`DROP TABLE IF EXISTS ${TABLE}`);
    } finally {
      await db.disconnect();
    }
  });

  gate.it('through compat WITHOUT the option: one named statement, promoted to a generic plan', async () => {
    const db = turbine();
    try {
      await prepareConnection(db);
      const compat = compatOf(db);
      for (let i = 0; i < 12; i++) {
        await compat.Event.findMany({ where: { tenantId: DENSE_TENANT }, orderBy: { amount: 'desc' }, take: 100 });
      }
      const stmts = await preparedStatements(db);
      assert.equal(stmts.length, 1, `expected exactly one prepared statement, got ${JSON.stringify(stmts)}`);
      assert.equal(stmts[0]!.custom + stmts[0]!.generic, 12, 'every execution accounted for');
      assert.ok(stmts[0]!.generic > 0, `expected promotion to a generic plan, got ${JSON.stringify(stmts[0])}`);
    } finally {
      await db.disconnect();
    }
  });

  gate.it('through compat WITH forceCustomPlan: no prepared statement exists, so nothing can promote', async () => {
    const db = turbine();
    try {
      await prepareConnection(db);
      const compat = compatOf(db);
      for (let i = 0; i < 12; i++) {
        await compat.Event.findMany({
          where: { tenantId: DENSE_TENANT },
          orderBy: { amount: 'desc' },
          take: 100,
          forceCustomPlan: true,
        });
      }
      const stmts = await preparedStatements(db);
      assert.deepEqual(stmts, [], `expected pg_prepared_statements to be empty, got ${JSON.stringify(stmts)}`);
    } finally {
      await db.disconnect();
    }
  });

  gate.it('forceCustomPlan reaches count and aggregate through compat too', async () => {
    const db = turbine();
    try {
      await prepareConnection(db);
      const compat = compatOf(db);
      for (let i = 0; i < 8; i++) {
        await compat.Event.count({ where: { tenantId: DENSE_TENANT }, forceCustomPlan: true });
        await compat.Event.aggregate({ where: { tenantId: DENSE_TENANT }, _count: true, forceCustomPlan: true });
      }
      assert.deepEqual(await preparedStatements(db), []);
      // And the same two calls without it DO name a statement, so the empty
      // result above is the option and not some property of these two methods.
      await compat.Event.count({ where: { tenantId: DENSE_TENANT } });
      assert.equal((await preparedStatements(db)).length, 1);
    } finally {
      await db.disconnect();
    }
  });

  gate.it('skipGlobalFilters through compat actually returns the filtered-out rows', async () => {
    const db = turbine({ globalFilters: { [TABLE]: { archived: false } } });
    try {
      const compat = compatOf(db);
      const filtered = await compat.Event.count({ where: { isArchived: true } });
      assert.equal(filtered, 0, 'the global filter must remove archived rows by default');
      const unfiltered = await compat.Event.count({ where: { isArchived: true }, skipGlobalFilters: UNSAFE });
      assert.ok(unfiltered > 0, `expected skipGlobalFilters to reveal archived rows, got ${unfiltered}`);
    } finally {
      await db.disconnect();
    }
  });

  gate.it('allowFullTableScan through compat lets a deliberate unconditional mutation run', async () => {
    const db = turbine();
    try {
      const compat = compatOf(db);
      // An explicit empty `where` is exactly what the empty-where guard exists
      // to refuse, so it is the observable consequence of the option arriving.
      await assert.rejects(
        () => compat.Event.updateMany({ where: {}, data: { payload: 'guarded' } }),
        (err: unknown) => err instanceof TurbineError && err.code === TurbineErrorCode.VALIDATION,
      );
      const res = await compat.Event.updateMany({
        where: { tenantId: DENSE_TENANT },
        data: { payload: 'scoped' },
        allowFullTableScan: UNSAFE,
      });
      assert.ok(res.count > 0);
    } finally {
      await db.disconnect();
    }
  });

  gate.it('optimisticLock through compat raises E015 on a stale version, using the Prisma field name', async () => {
    const db = turbine();
    try {
      const compat = compatOf(db);
      const row = await compat.Event.findFirst({ where: { tenantId: DENSE_TENANT } });
      assert.ok(row);
      // `version` is the PRISMA name; the column is `row_version` / `rowVersion`.
      // A blind passthrough would fail as an unknown column rather than lock.
      const ok = await compat.Event.update({
        where: { id: row.id },
        data: { payload: 'locked' },
        optimisticLock: { field: 'version', expected: row.version },
      });
      assert.equal(ok.version, row.version + 1, 'a successful optimistic update increments the version');
      await assert.rejects(
        () =>
          compat.Event.update({
            where: { id: row.id },
            data: { payload: 'stale' },
            optimisticLock: { field: 'version', expected: row.version },
          }),
        (err: unknown) => err instanceof TurbineError && err.code === TurbineErrorCode.OPTIMISTIC_LOCK,
      );
    } finally {
      await db.disconnect();
    }
  });

  gate.it("relationLoadStrategy 'query' runs Prisma's per-relation plan, not the json_agg join", async () => {
    const db = turbine();
    try {
      const compat = compatOf(db);
      const seen: string[] = [];
      const listener = (e: { sql: string }) => {
        seen.push(e.sql);
      };
      db.$on('query', listener as Any);
      try {
        await compat.Event.findMany({
          where: { tenantId: DENSE_TENANT },
          include: { notes: true },
          take: 5,
          relationLoadStrategy: 'query',
        });
      } finally {
        db.$off('query', listener as Any);
      }
      assert.ok(seen.length >= 2, `expected a follow-up statement per relation, saw ${seen.length}`);
      assert.ok(
        !seen.some((sql) => sql.includes('json_agg')),
        `expected no json_agg join, got:\n${seen.join('\n---\n')}`,
      );
    } finally {
      await db.disconnect();
    }
  });

  gate.it('timeout on a mass mutation through compat actually aborts it', async () => {
    const db = turbine();
    try {
      const compat = compatOf(db);
      await assert.rejects(
        () => compat.Event.updateMany({ where: { tenantId: { gt: 0 } }, data: { payload: 'slow' }, timeout: 1 }),
        (err: unknown) => err instanceof TurbineError && err.code === TurbineErrorCode.TIMEOUT,
      );
    } finally {
      await db.disconnect();
    }
  });

  gate.it('warnOnUnlimited:false through compat silences the unbounded-read advisory', async () => {
    const noisy = turbine({ warnOnUnlimited: true });
    const lines: string[] = [];
    const original = console.warn;
    console.warn = (...parts: unknown[]) => {
      lines.push(parts.join(' '));
    };
    try {
      const compat = compatOf(noisy);
      await compat.Event.findMany({ where: { tenantId: 59 }, warnOnUnlimited: false });
      assert.deepEqual(
        lines.filter((l) => /without a `limit`|unbounded/i.test(l)),
        [],
        `expected no unbounded-read advisory, got:\n${lines.join('\n')}`,
      );
    } finally {
      console.warn = original;
      await noisy.disconnect();
    }
  });
});
