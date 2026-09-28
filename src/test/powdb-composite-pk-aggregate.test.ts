/**
 * PowDB adapter: composite primary keys in `powqlSchemaDDL`, and `aggregate()`
 * computing several aggregates in ONE statement.
 *
 * DDL: introspected metadata lists a table's primary-key index in `indexes`
 * (`<table>_pkey`), so a composite primary key used to reach the "PowDB has no
 * composite index" refusal even though the type body already declares the key's
 * columns `required`. The PK's own index is now skipped; every other composite
 * index (plain, unique, or partial) is still refused.
 *
 * aggregate(): PowQL refuses a bare multi-aggregate projection ("aggregate
 * function in an unsupported position"), so each requested field used to cost
 * its own scalar statement. `T filter … group 1 { agg_0: …, agg_1: … }` computes
 * all of them in one pass. Verified against the embedded addon at 0.7.1, 0.10,
 * 0.12, 0.13, 0.14, 0.16, 0.18.2, 0.19.1, 0.20, 0.24 and 0.28: below 0.13 the
 * literal group key does not parse, 0.13-0.19.1 disagree with the scalar form on
 * a per-field `count` of a nullable column, and from 0.20 every aggregate kind
 * agrees on both wires. So the grouped form is used only on a PROBED engine at
 * 0.20 or later, and an empty filtered set (zero groups) is answered by the
 * scalar statements, which keeps the empty-set result version-exact.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { UnsupportedFeatureError, ValidationError } from '../errors.js';
import {
  ALL_POWDB_CAPABILITIES,
  capabilitiesFromVersion,
  type PowdbCapabilities,
  type PowdbPool,
  PowqlInterface,
  powqlSchemaDDL,
  turbinePowDB,
} from '../powdb.js';
import { UNSAFE } from '../query/types.js';
import type { IndexMetadata, SchemaMetadata, TableMetadata } from '../schema.js';
import { mockTable, skipGate } from './helpers.js';

// ---------------------------------------------------------------------------
// DDL
// ---------------------------------------------------------------------------

function rollupTable(indexes: IndexMetadata[]): TableMetadata {
  const t = mockTable(
    'rollup_hourly',
    [
      { name: 'site_id', field: 'siteId', pgType: 'text' },
      { name: 'hour', field: 'hour', pgType: 'int8' },
      { name: 'path', field: 'path', pgType: 'text' },
      { name: 'device', field: 'device', pgType: 'text' },
      { name: 'country', field: 'country', pgType: 'text' },
      { name: 'views', field: 'views', pgType: 'int8' },
    ],
    {},
    ['site_id', 'hour', 'path', 'device', 'country'],
  );
  t.indexes = indexes;
  return t;
}

const PKEY: IndexMetadata = {
  name: 'rollup_hourly_pkey',
  columns: ['site_id', 'hour', 'path', 'device', 'country'],
  unique: true,
  definition:
    'CREATE UNIQUE INDEX rollup_hourly_pkey ON public.rollup_hourly USING btree (site_id, hour, path, device, country)',
};

const ddlFor = (t: TableMetadata) => powqlSchemaDDL({ tables: { [t.name]: t }, enums: {} } as SchemaMetadata);

describe('powqlSchemaDDL: composite primary keys', () => {
  it('skips the primary key own index instead of refusing it', () => {
    const stmts = ddlFor(rollupTable([PKEY]));
    assert.equal(stmts.length, 1, 'only the type body; the PK index emits nothing');
    // Every PK column is `required`, none is `unique` (PowDB has no composite unique).
    for (const col of ['site_id', 'hour', 'path', 'device', 'country']) {
      assert.match(stmts[0]!, new RegExp(`required ${col}:`));
    }
    assert.doesNotMatch(stmts[0]!, /unique/);
  });

  it('recognizes the PK index whatever order its columns are listed in', () => {
    const reordered = { ...PKEY, columns: ['country', 'device', 'path', 'hour', 'site_id'] };
    assert.equal(ddlFor(rollupTable([reordered])).length, 1);
  });

  it('still emits single-column secondary indexes next to it', () => {
    const idx: IndexMetadata = { name: 'rollup_hour_idx', columns: ['hour'], unique: false, definition: '' };
    const stmts = ddlFor(rollupTable([PKEY, idx]));
    assert.deepEqual(stmts.slice(1), ['alter rollup_hourly add index .hour']);
  });

  it('still refuses a genuine composite index (plain, unique, or partial over the PK columns)', () => {
    const cases: IndexMetadata[] = [
      { name: 'plain_2', columns: ['site_id', 'hour'], unique: false, definition: '' },
      // A composite UNIQUE constraint other than the PK is a real integrity rule
      // PowDB cannot enforce, so it is refused rather than silently dropped.
      { name: 'uniq_2', columns: ['site_id', 'path'], unique: true, definition: '' },
      // Same columns as the PK but non-unique: not the PK's index.
      { ...PKEY, name: 'same_cols_nonunique', unique: false },
      // Same columns as the PK but PARTIAL: uniqueness over a subset, not the PK.
      { ...PKEY, name: 'same_cols_partial', partial: true },
      // A strict subset / superset of the PK columns.
      { ...PKEY, name: 'subset', columns: ['site_id', 'hour', 'path', 'device'] },
      { ...PKEY, name: 'superset', columns: [...PKEY.columns, 'views'] },
    ];
    for (const idx of cases) {
      assert.throws(
        () => ddlFor(rollupTable([PKEY, idx])),
        (e: unknown) => e instanceof UnsupportedFeatureError && new RegExp(`"${idx.name}"`).test((e as Error).message),
        idx.name,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// aggregate(): one statement
// ---------------------------------------------------------------------------

const metrics = mockTable('metric', [
  { name: 'id', field: 'id' },
  { name: 'a', field: 'a' },
  { name: 'b', field: 'b', pgType: 'float8' },
  { name: 'label', field: 'label', pgType: 'text' },
  { name: 'email', field: 'email', pgType: 'text', pii: true },
]);
for (const c of metrics.columns) {
  if (c.name === 'a' || c.name === 'b') c.nullable = true;
  if (c.pgType === 'text') c.tsType = 'string';
}
const schema: SchemaMetadata = { tables: { metric: metrics }, enums: {} } as SchemaMetadata;

function mockPool(caps: PowdbCapabilities) {
  const calls: { powql: string; params: unknown[] }[] = [];
  let groupRows: Record<string, unknown>[] = [];
  const scalars = new Map<string, string>();
  const pool = {
    capabilities: caps,
    retryStaleReads: false,
    query(powql: string, params: unknown[]) {
      calls.push({ powql, params });
      const fn = /^(count|sum|avg|min|max)\(/.exec(powql)?.[1];
      if (fn) return Promise.resolve({ rows: [{ value: scalars.get(powql) ?? '0' }], rowCount: 1 });
      return Promise.resolve({ rows: groupRows, rowCount: groupRows.length });
    },
  } as unknown as PowdbPool;
  return {
    pool,
    calls,
    setGroupRows: (r: Record<string, unknown>[]) => {
      groupRows = r;
    },
    setScalar: (powql: string, v: string) => scalars.set(powql, v),
  };
}

const qi = (m: ReturnType<typeof mockPool>) =>
  new PowqlInterface(m.pool, 'metric', schema, [], { warnOnUnlimited: false });

const V20 = capabilitiesFromVersion('0.20.0');

describe('PowDB aggregate(): several aggregates in one statement', () => {
  it('on a probed 0.20 engine, eight aggregates are ONE grouped statement', async () => {
    const m = mockPool(V20);
    m.setGroupRows([
      { agg_0: '5', agg_1: '4', agg_2: '30', agg_3: '7.5', agg_4: '7.5', agg_5: '2.5', agg_6: '-3', agg_7: '9.25' },
    ]);
    const res = await qi(m).aggregate({
      where: { id: { gt: 1 } },
      _count: { id: true, a: true },
      _sum: { a: true, b: true },
      _avg: { a: true, b: true },
      _min: { a: true },
      _max: { b: true },
    } as never);
    assert.equal(m.calls.length, 1, m.calls.map((c) => c.powql).join('\n'));
    assert.equal(
      m.calls[0]!.powql,
      'metric filter .id > $1 group 1 { agg_0: count(.id), agg_1: count(.a), agg_2: sum(.a), agg_3: sum(.b), ' +
        'agg_4: avg(.a), agg_5: avg(.b), agg_6: min(.a), agg_7: max(.b) }',
    );
    assert.deepEqual(m.calls[0]!.params, [1]);
    assert.deepEqual(res, {
      _count: { id: 5, a: 4 },
      _sum: { a: 30, b: 7.5 },
      _avg: { a: 7.5, b: 2.5 },
      _min: { a: -3 },
      _max: { b: 9.25 },
    });
  });

  it('reads `_count: true`, null cells and native bigint cells exactly as the scalar path does', async () => {
    const m = mockPool(V20);
    m.setGroupRows([{ agg_0: 3n, agg_1: null, agg_2: 'null' }]);
    const res = await qi(m).aggregate({ _count: true, _sum: { a: true }, _max: { b: true } } as never);
    assert.equal(m.calls.length, 1);
    assert.match(m.calls[0]!.powql, /^metric group 1 \{ agg_0: count\(\*\), agg_1: sum\(\.a\), agg_2: max\(\.b\) \}$/);
    assert.deepEqual(res, { _count: 3, _sum: { a: null }, _max: { b: null } });
  });

  it('an EMPTY filtered set (zero groups) is answered by the per-field statements', async () => {
    const m = mockPool(V20);
    m.setGroupRows([]);
    m.setScalar('count(metric filter .id > $1)', '0');
    m.setScalar('sum(metric filter .id > $1 { .a })', 'null');
    const res = await qi(m).aggregate({ where: { id: { gt: 99 } }, _count: true, _sum: { a: true } } as never);
    assert.deepEqual(
      m.calls.map((c) => c.powql),
      [
        'metric filter .id > $1 group 1 { agg_0: count(*), agg_1: sum(.a) }',
        'count(metric filter .id > $1)',
        'sum(metric filter .id > $1 { .a })',
      ],
    );
    assert.deepEqual(res, { _count: 0, _sum: { a: null } });
  });

  it('keeps one scalar statement per field on an UNPROBED pool, below 0.20, and for a single aggregate', async () => {
    const args = { _sum: { a: true }, _max: { b: true } } as never;
    for (const caps of [ALL_POWDB_CAPABILITIES, capabilitiesFromVersion('0.19.1'), capabilitiesFromVersion('0.13.0')]) {
      const m = mockPool(caps);
      await qi(m).aggregate(args);
      assert.deepEqual(
        m.calls.map((c) => c.powql),
        ['sum(metric { .a })', 'max(metric { .b })'],
        String(caps.engineVersion),
      );
    }
    const single = mockPool(V20);
    await qi(single).aggregate({ _sum: { a: true } } as never);
    assert.deepEqual(
      single.calls.map((c) => c.powql),
      ['sum(metric { .a })'],
    );
  });

  it('validates every requested field BEFORE any statement runs (PII, unknown column, nullable count gate)', async () => {
    const m = mockPool(V20);
    await assert.rejects(
      qi(m).aggregate({ _count: true, _min: { email: true } } as never),
      (e: unknown) => e instanceof ValidationError && /email/.test((e as Error).message),
    );
    await assert.rejects(qi(m).aggregate({ _count: true, _sum: { nope: true } } as never), ValidationError);
    assert.equal(m.calls.length, 0);
    // Below 0.20 the nullable per-field count gate also fires before the NOT
    // NULL member's count is sent (it used to run first).
    const old = mockPool(capabilitiesFromVersion('0.19.1'));
    await assert.rejects(
      qi(old).aggregate({ _count: { id: true, a: true } } as never),
      (e: unknown) => e instanceof UnsupportedFeatureError && /nullable column "a"/.test((e as Error).message),
    );
    assert.equal(old.calls.length, 0);
    // The opt-in still unlocks it, in the one statement.
    m.setGroupRows([{ agg_0: '1', agg_1: 'x@y' }]);
    await qi(m).aggregate({ _count: true, _min: { email: true }, includePii: UNSAFE } as never);
    assert.equal(m.calls.length, 1);
  });
});

// ---------------------------------------------------------------------------
// Live: the embedded engine answers both forms identically
// ---------------------------------------------------------------------------

let embeddedAvailable = false;
try {
  const mod = (await import('@zvndev/powdb-embedded')) as { Database?: { open?: unknown } };
  embeddedAvailable = typeof mod?.Database?.open === 'function';
} catch {
  embeddedAvailable = false;
}
const live = skipGate(!embeddedAvailable, 'requires @zvndev/powdb-embedded (no prebuilt binary on this platform)');

describe('PowDB aggregate() live: grouped and per-field answers are identical', () => {
  live.it('matches the per-field path for every aggregate kind, filter, and the empty set', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'turbine-powdb-agg-'));
    const liveTable = mockTable('sample', [
      { name: 'id', field: 'id' },
      { name: 'a', field: 'a' },
      { name: 'b', field: 'b', pgType: 'float8' },
      { name: 'label', field: 'label', pgType: 'text' },
      { name: 'z', field: 'z' },
      { name: 'at', field: 'at', pgType: 'timestamptz' },
    ]);
    for (const c of liveTable.columns) {
      if (['a', 'b', 'z'].includes(c.name)) c.nullable = true;
      if (c.name === 'at') c.tsType = 'Date';
      if (c.name === 'id') c.hasDefault = false;
      if (c.pgType === 'text') c.tsType = 'string';
    }
    liveTable.dateColumns = new Set(['at']);
    const liveSchema = { tables: { sample: liveTable }, enums: {} } as SchemaMetadata;
    const db = await turbinePowDB({ embedded: dir }, liveSchema, { warnOnUnlimited: false });
    try {
      for (const stmt of powqlSchemaDDL(liveSchema)) await db.raw([stmt] as unknown as TemplateStringsArray);
      const t = db.table('sample');
      for (let i = 1; i <= 120; i++) {
        await t.create({
          data: {
            id: i,
            a: i % 7 === 0 ? null : ((i * 37) % 101) - 50,
            b: i % 5 === 0 ? null : i * 0.1 + 1 / 3,
            label: `s${(i * 13) % 97}`,
            z: null,
            at: new Date(Date.UTC(2026, 0, 1) + i * 3_600_000),
          },
        } as never);
      }
      const pool = db.pool as unknown as PowdbPool;
      assert.ok(pool.capabilities?.engineVersion, 'the embedded pool is version-probed');
      // The same pool with its version unknown: the per-field reference path.
      const statements: string[] = [];
      const counting = (caps: PowdbCapabilities) =>
        ({
          capabilities: caps,
          retryStaleReads: false,
          query: (powql: string, params: unknown[]) => {
            statements.push(powql);
            return pool.query(powql, params);
          },
        }) as unknown as PowdbPool;
      const grouped = new PowqlInterface(counting(pool.capabilities!), 'sample', liveSchema, [], {
        warnOnUnlimited: false,
      });
      const perField = new PowqlInterface(
        counting({ ...pool.capabilities!, engineVersion: null }),
        'sample',
        liveSchema,
        [],
        { warnOnUnlimited: false },
      );
      const every = {
        _count: { id: true, a: true, z: true },
        _sum: { a: true, b: true, z: true },
        _avg: { a: true, b: true, z: true },
        _min: { a: true, label: true, at: true },
        _max: { b: true, label: true, at: true, z: true },
      };
      const cases: Record<string, unknown>[] = [
        every,
        { ...every, where: { id: { gt: 50 } } },
        { ...every, where: { id: { gt: 100_000 } } }, // empty set
        { ...every, where: { id: { lt: 8 } } },
        { _count: true, _sum: { b: true } },
        { _count: true, _sum: { b: true }, where: { label: 's1' } },
      ];
      for (const args of cases) {
        statements.length = 0;
        const g = await grouped.aggregate(args as never);
        const groupedStatements = statements.length;
        statements.length = 0;
        const p = await perField.aggregate(args as never);
        assert.deepEqual(g, p, JSON.stringify(args.where ?? {}));
        const empty = (args.where as { id?: { gt?: number } } | undefined)?.id?.gt === 100_000;
        assert.equal(groupedStatements, empty ? 1 + statements.length : 1, JSON.stringify(args.where ?? {}));
      }
    } finally {
      await db.disconnect();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
