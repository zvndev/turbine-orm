/**
 * turbine-orm, the per-query `forceCustomPlan` read option.
 *
 * Turbine executes reads through a NAMED prepared statement, which enters the
 * PostgreSQL plan cache and may be promoted to a generic plan from the sixth
 * execution onward. `forceCustomPlan: true` withholds the NAME for one query:
 * an unnamed statement is planned one-shot at Bind with the real parameter
 * values and never enters the plan cache at all, so nothing can promote later.
 * No GUC, no `SET LOCAL`, no transaction, no extra round trip.
 *
 * These tests assert the wire form the driver is handed (object-with-`name`
 * versus plain `(text, values)`) and the capability refusal. The live proof,
 * that no entry appears in `pg_prepared_statements` and that the same query
 * without the option promotes to a generic plan, is in
 * `force-custom-plan.integration.test.ts`.
 *
 * No database required: the pool is a stub that records what it was called with.
 *
 * Run: npx tsx --test src/test/force-custom-plan.test.ts
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Dialect } from '../dialect.js';
import { postgresDialect } from '../dialect.js';
import { TurbineErrorCode, UnsupportedFeatureError, ValidationError } from '../errors.js';
import { QueryInterface } from '../query/index.js';
import type { SchemaMetadata } from '../schema.js';
import { mockTable } from './helpers.js';

const schema: SchemaMetadata = {
  tables: {
    events: mockTable('events', [
      { name: 'id', field: 'id', pgType: 'int4' },
      { name: 'tenant_id', field: 'tenantId', pgType: 'int4' },
    ]),
    // A second table so the relation follow-ups of the batched strategy have a target.
    notes: mockTable(
      'notes',
      [
        { name: 'id', field: 'id', pgType: 'int4' },
        { name: 'event_id', field: 'eventId', pgType: 'int4' },
      ],
      {},
    ),
  },
  enums: {},
};

// events hasMany notes (declared after construction so both tables exist).
schema.tables.events!.relations = {
  notes: { type: 'hasMany', name: 'notes', from: 'events', to: 'notes', foreignKey: 'event_id', referenceKey: 'id' },
};

/** One recorded driver call: the named form carries a statement name. */
interface Call {
  name?: string;
  sql: string;
}

function recordingPool(calls: Call[]) {
  // One row carrying every shape the read transforms read off it (`count` for
  // count(), `_count` style aggregates parse from the same row).
  const respond = async () => ({
    rows: [{ count: '0', tenant_id: 7, _count_all: '0' }],
    rowCount: 1,
    command: 'SELECT',
    oid: 0,
    fields: [],
  });
  return {
    query: (textOrConfig: unknown, _values?: unknown[]) => {
      if (typeof textOrConfig === 'string') calls.push({ sql: textOrConfig });
      else {
        const cfg = textOrConfig as { name?: string; text: string };
        calls.push({ name: cfg.name, sql: cfg.text });
      }
      return respond();
    },
    connect: async () => {
      throw new Error('not used');
    },
    end: async () => {},
    on: () => {},
    // biome-ignore lint/suspicious/noExplicitAny: stub pool for build-only execution
  } as any;
}

function makeIface(calls: Call[], dialect: Dialect = postgresDialect) {
  return new QueryInterface<{ id: number; tenantId: number }>(recordingPool(calls), 'events', schema, undefined, {
    dialect,
    warnOnUnlimited: false,
  });
}

describe('forceCustomPlan (per-query)', () => {
  it('names the statement by default, and withholds the name when asked', async () => {
    const calls: Call[] = [];
    const qi = makeIface(calls);
    await qi.findMany({ where: { tenantId: 7 }, orderBy: { id: 'asc' }, limit: 100 });
    await qi.findMany({ where: { tenantId: 7 }, orderBy: { id: 'asc' }, limit: 100, forceCustomPlan: true });

    assert.equal(calls.length, 2);
    assert.ok(calls[0]!.name, 'default execution uses a named prepared statement');
    assert.equal(calls[1]!.name, undefined, 'forceCustomPlan sends the statement unnamed');
    // The SQL text is untouched: the option changes the wire form only, never
    // the statement, so no plan hint is smuggled into the string.
    assert.equal(calls[0]!.sql, calls[1]!.sql);
  });

  it('covers every read entry point, not just findMany', async () => {
    const calls: Call[] = [];
    const qi = makeIface(calls);
    await qi.findUnique({ where: { id: 1 }, forceCustomPlan: true });
    await qi.findFirst({ where: { tenantId: 7 }, forceCustomPlan: true });
    await qi.count({ where: { tenantId: 7 }, forceCustomPlan: true });
    await qi.aggregate({ where: { tenantId: 7 }, _count: true, forceCustomPlan: true });
    await qi.groupBy({ by: ['tenantId'], _count: true, forceCustomPlan: true });
    assert.equal(calls.length, 5);
    for (const [i, call] of calls.entries()) {
      assert.equal(call.name, undefined, `read #${i + 1} still named its statement`);
    }
  });

  it('reaches the relation follow-ups of the batched strategy too', async () => {
    // A batched load re-issues the same tenant-shaped predicate one level down.
    // Leaving those named would keep exactly the plan-cache exposure the caller
    // asked to be rid of, so the opt-in has to travel with the load.
    const calls: Call[] = [];
    const qi = new QueryInterface<{ id: number; tenantId: number }>(
      // The base query must return a row, otherwise the loader never runs.
      {
        query: (textOrConfig: unknown) => {
          const cfg =
            typeof textOrConfig === 'string'
              ? { text: textOrConfig }
              : (textOrConfig as { name?: string; text: string });
          calls.push({ name: (cfg as { name?: string }).name, sql: cfg.text });
          return Promise.resolve({
            // `event_id` is here because the CHILD follow-up reads it to stitch:
            // one stub answers every statement, so the row has to be shaped
            // like something the real projection would return, or the loader
            // now (correctly) refuses a relation it cannot correlate.
            rows: [{ id: 1, tenant_id: 7, event_id: 1 }],
            rowCount: 1,
            command: 'SELECT',
            oid: 0,
            fields: [],
          });
        },
        connect: async () => {
          throw new Error('not used');
        },
        end: async () => {},
        on: () => {},
        // biome-ignore lint/suspicious/noExplicitAny: stub pool for build-only execution
      } as any,
      'events',
      schema,
      undefined,
      { dialect: postgresDialect, warnOnUnlimited: false },
    );

    await qi.findMany({
      where: { tenantId: 7 },
      with: { notes: true },
      relationLoadStrategy: 'batched',
      forceCustomPlan: true,
    });
    assert.ok(calls.length >= 2, `expected a base query and a relation follow-up, got ${calls.length}`);
    for (const [i, call] of calls.entries()) {
      assert.equal(call.name, undefined, `query #${i + 1} (${call.sql.slice(0, 40)}) still named its statement`);
    }
  });

  it('leaves everything byte-identical when the option is absent or false', async () => {
    const calls: Call[] = [];
    const qi = makeIface(calls);
    await qi.findMany({ where: { tenantId: 7 } });
    await qi.findMany({ where: { tenantId: 7 }, forceCustomPlan: false });
    assert.equal(calls.length, 2);
    assert.equal(calls[0]!.name, calls[1]!.name, 'false must be exactly the default behaviour');
    assert.ok(calls[0]!.name);
  });

  it("refuses the contradiction with a client-level planCacheMode: 'force_generic_plan'", async () => {
    // Measured, not assumed: `force_generic_plan` governs UNNAMED one-shot
    // statements too, so withholding the name cannot escape it and the query
    // would be planned generically anyway. Refusing beats reporting a
    // guarantee that the next execution breaks.
    const calls: Call[] = [];
    const qi = new QueryInterface<{ id: number; tenantId: number }>(recordingPool(calls), 'events', schema, undefined, {
      dialect: postgresDialect,
      warnOnUnlimited: false,
      planCacheMode: 'force_generic_plan',
    });
    await assert.rejects(
      () => qi.findMany({ where: { tenantId: 7 }, forceCustomPlan: true }),
      (err: unknown) => {
        assert.ok(err instanceof ValidationError);
        assert.equal(err.code, TurbineErrorCode.VALIDATION);
        assert.match(err.message, /force_generic_plan/);
        return true;
      },
    );
    assert.equal(calls.length, 0, 'nothing is sent');
    // Every other query on that client is untouched.
    await qi.findMany({ where: { tenantId: 7 } });
    assert.equal(calls.length, 1);
    assert.ok(calls[0]!.name, 'the ordinary query still uses a named statement');
  });

  it('is honoured under the client-level modes that can honour it', async () => {
    for (const mode of ['auto', 'force_custom_plan'] as const) {
      const calls: Call[] = [];
      const qi = new QueryInterface<{ id: number; tenantId: number }>(
        recordingPool(calls),
        'events',
        schema,
        undefined,
        { dialect: postgresDialect, warnOnUnlimited: false, planCacheMode: mode },
      );
      await qi.findMany({ where: { tenantId: 7 }, forceCustomPlan: true });
      assert.equal(calls[0]!.name, undefined, `planCacheMode: '${mode}' must still allow the per-query opt-in`);
    }
  });

  it('refuses on an engine with no PostgreSQL plan cache (E017)', async () => {
    const calls: Call[] = [];
    const sqliteish: Dialect = { ...postgresDialect, name: 'sqlite', supportsPlanCacheMode: false };
    const qi = makeIface(calls, sqliteish);
    await assert.rejects(
      () => qi.findMany({ where: { tenantId: 7 }, forceCustomPlan: true }),
      (err: unknown) => {
        assert.ok(err instanceof UnsupportedFeatureError);
        assert.equal(err.code, TurbineErrorCode.UNSUPPORTED_FEATURE);
        assert.match(err.message, /forceCustomPlan/);
        return true;
      },
    );
    assert.equal(calls.length, 0, 'the refusal happens before the statement is sent');
    // The same engine is untouched when the option is not asked for.
    await qi.findMany({ where: { tenantId: 7 } });
    assert.equal(calls.length, 1);
  });

  it('refuses on a dialect that predates the capability flag', async () => {
    const calls: Call[] = [];
    const legacy = { ...postgresDialect, name: 'legacy' } as Dialect & { supportsPlanCacheMode?: boolean };
    legacy.supportsPlanCacheMode = undefined;
    await assert.rejects(
      () => makeIface(calls, legacy).count({ forceCustomPlan: true }),
      (err: unknown) => err instanceof UnsupportedFeatureError,
    );
  });

  it('refuses on streaming too, where the statement is already unnamed', async () => {
    // findManyStream never named its statements, so the flag is satisfied there
    // by accident. It is still validated, so an engine that cannot make the
    // guarantee says so instead of appearing to honour it.
    const calls: Call[] = [];
    const sqliteish: Dialect = { ...postgresDialect, name: 'sqlite', supportsPlanCacheMode: false };
    const qi = makeIface(calls, sqliteish);
    await assert.rejects(async () => {
      for await (const _row of qi.findManyStream({ where: { tenantId: 7 }, forceCustomPlan: true })) {
        // not reached
      }
    }, UnsupportedFeatureError);
  });
});
