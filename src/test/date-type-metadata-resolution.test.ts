/**
 * turbine-orm, column database-type resolution from every metadata shape
 *
 * A JS `Date` bound to a zone-less `date` / `timestamp` column is rewritten to
 * a UTC literal on the write path (see `coerceWriteValue` in query/writes.ts).
 * That rewrite needs the column's DATABASE TYPE, and metadata carries it in two
 * places: on the column entry (`dialectType` / `pgType`) and in the table-level
 * `dialectTypes` / `pgTypes` maps. Resolving only the column entry meant that
 * metadata populating just the table-level maps typed every column `undefined`,
 * the rewrite silently stopped, and the driver stored the PROCESS's local
 * calendar fields. A turbine-only round trip HIDES that (the read path shifts
 * back by the same offset), so only an outside reader sees the wrong value.
 *
 * These are build-only param assertions: no database, no time zone dependency
 * (the expected literal is the value's UTC components either way).
 *
 * Run: npx tsx --test src/test/date-type-metadata-resolution.test.ts
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { resetWarnOnce, WARN_NS } from '../query/warn-registry.js';
import type { ColumnMetadata, SchemaMetadata, TableMetadata } from '../schema.js';
import { sqliteDialect } from '../sqlite.js';
import { makeQuery } from './helpers.js';

/** The probe value, chosen so a negative UTC offset moves it across midnight. */
const A_TIMESTAMP = new Date('2026-03-15T00:30:00Z');
const TIMESTAMP_LITERAL = '2026-03-15 00:30:00';
const DATE_LITERAL = '2026-03-15';

/** Where a table's column types live. */
type TypeShape = 'columns' | 'maps' | 'both' | 'neither';

const COLUMNS: { name: string; field: string; pgType: string }[] = [
  { name: 'id', field: 'id', pgType: 'int8' },
  { name: 'last_run', field: 'lastRun', pgType: 'timestamp' },
  { name: 'last_run_tz', field: 'lastRunTz', pgType: 'timestamptz' },
  { name: 'day', field: 'day', pgType: 'date' },
  // A time-of-day column, deliberately NOT a `dateColumns` member (see
  // `timeOfDayKind` in schema.ts). With no resolved type its bind fails HARD
  // (`22007 invalid input syntax for type time`), so the untyped-column
  // diagnostic has to cover it.
  { name: 'window_start', field: 'windowStart', pgType: 'time' },
];

/**
 * Build `report_schedule` metadata carrying its column types in `shape`.
 *
 * `'columns'` is what `defineSchema` output looks like once the table-level
 * maps are dropped, `'maps'` is the reported shape (table-level maps intact,
 * per-column types absent), `'both'` is what introspection and
 * `turbine generate` emit, and `'neither'` is the residual no-type case.
 */
function buildSchema(shape: TypeShape, opts: { dialectTypes?: boolean } = {}): SchemaMetadata {
  const onColumn = shape === 'columns' || shape === 'both';
  const inMaps = shape === 'maps' || shape === 'both';
  const columnMap: Record<string, string> = {};
  const reverseColumnMap: Record<string, string> = {};
  const pgTypes: Record<string, string> = {};
  const dialectTypes: Record<string, string> = {};

  const columns = COLUMNS.map((c) => {
    columnMap[c.field] = c.name;
    reverseColumnMap[c.name] = c.field;
    if (inMaps) {
      if (opts.dialectTypes) dialectTypes[c.name] = c.pgType;
      else pgTypes[c.name] = c.pgType;
    }
    // A metadata object whose columns carry no type is exactly the reported
    // shape, so the type field is genuinely absent rather than empty-stringed.
    const col: Partial<ColumnMetadata> = {
      name: c.name,
      field: c.field,
      tsType: 'unknown',
      nullable: true,
      hasDefault: c.name === 'id',
      isArray: false,
    };
    if (onColumn) {
      col.pgType = c.pgType;
      col.pgArrayType = `${c.pgType}[]`;
    }
    return col as ColumnMetadata;
  });

  const table: TableMetadata = {
    name: 'report_schedule',
    columns,
    columnMap,
    reverseColumnMap,
    dateColumns: new Set(['last_run', 'last_run_tz', 'day']),
    dialectTypes: opts.dialectTypes ? dialectTypes : undefined,
    pgTypes,
    allColumns: COLUMNS.map((c) => c.name),
    primaryKey: ['id'],
    uniqueColumns: [['id']],
    relations: {},
    indexes: [],
  };
  return { tables: { report_schedule: table }, enums: {} };
}

const q = (shape: TypeShape, opts?: { dialectTypes?: boolean }) =>
  makeQuery('report_schedule', buildSchema(shape, opts));

/**
 * Run `fn` with `console.warn` captured, returning the lines it emitted. Also
 * used to keep the `'neither'` shape's (expected) dev warning out of the
 * reporter's output in tests that are not about the warning.
 */
function captureWarnings(fn: () => void): string[] {
  const lines: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  };
  try {
    fn();
  } finally {
    console.warn = original;
  }
  return lines;
}

/** Every write builder, keyed by name, run against one `lastRun` Date value. */
function writeParams(qi: ReturnType<typeof q>, value: Date): Record<string, unknown[]> {
  return {
    create: qi.buildCreate({ data: { lastRun: value } }).params,
    createMany: qi.buildCreateMany({ data: [{ lastRun: value }] }).params,
    update: qi.buildUpdate({ where: { id: 1 }, data: { lastRun: value } }).params,
    updateMany: qi.buildUpdateMany({ where: { id: 1 }, data: { lastRun: value } }).params,
    upsert: qi.buildUpsert({ where: { id: 1 }, create: { id: 1, lastRun: value }, update: { lastRun: value } }).params,
  };
}

// ---------------------------------------------------------------------------
// 1. The type resolves from whichever place the metadata carries it
// ---------------------------------------------------------------------------

describe('column type resolution across metadata shapes', () => {
  for (const shape of ['columns', 'maps', 'both'] as const) {
    it(`binds the UTC literal on every write path (${shape})`, () => {
      for (const [op, params] of Object.entries(writeParams(q(shape), A_TIMESTAMP))) {
        // `createMany` binds one array param per column (the UNNEST batch
        // insert), every other builder binds scalars, so compare flat.
        const flat = params.flat();
        assert.ok(
          flat.includes(TIMESTAMP_LITERAL),
          `${op} under "${shape}" metadata bound ${JSON.stringify(params)}, expected ${TIMESTAMP_LITERAL}`,
        );
        assert.ok(
          !flat.some((p) => p instanceof Date),
          `${op} under "${shape}" metadata bound a raw Date, the driver would serialize it in local time`,
        );
      }
    });
  }

  it('falls back to the table-level dialectTypes map as well as pgTypes', () => {
    const params = q('maps', { dialectTypes: true }).buildCreate({ data: { lastRun: A_TIMESTAMP } }).params;
    assert.deepEqual(params, [TIMESTAMP_LITERAL]);
  });

  it('resolves a `date` column from the table-level maps too', () => {
    assert.deepEqual(q('maps').buildCreate({ data: { day: A_TIMESTAMP } }).params, [DATE_LITERAL]);
  });

  it('leaves timestamptz binding the Date object itself under every shape', () => {
    // A real instant: the driver's local-offset string is already correct, so
    // this must stay identity, not merely deep-equal.
    for (const shape of ['columns', 'maps', 'both', 'neither'] as const) {
      let params: unknown[] = [];
      captureWarnings(() => {
        params = q(shape).buildCreate({ data: { lastRunTz: A_TIMESTAMP } }).params;
      });
      assert.equal(params[0], A_TIMESTAMP, `timestamptz was rewritten under "${shape}" metadata`);
    }
  });

  it('applies the same resolution on the WHERE path', () => {
    const d = q('maps').buildFindMany({ where: { lastRun: A_TIMESTAMP } });
    assert.deepEqual(d.params, [TIMESTAMP_LITERAL]);
    // ...and on the warmed cache-hit param-collect path.
    assert.deepEqual(q('maps').buildFindMany({ where: { lastRun: A_TIMESTAMP } }).params, [TIMESTAMP_LITERAL]);
  });

  it('emits byte-identical SQL whichever place the type came from', () => {
    const fromColumns = q('columns').buildCreate({ data: { lastRun: A_TIMESTAMP } });
    const fromMaps = q('maps').buildCreate({ data: { lastRun: A_TIMESTAMP } });
    assert.equal(fromMaps.sql, fromColumns.sql);
    assert.deepEqual(fromMaps.params, fromColumns.params);
  });
});

// ---------------------------------------------------------------------------
// 2. The residual no-type case is loud, not silent
// ---------------------------------------------------------------------------

describe('untyped-column warning', () => {
  it('warns once per table, naming every column with no resolved type', () => {
    resetWarnOnce(WARN_NS.untypedDateColumn);
    const first = captureWarnings(() => q('neither'));
    assert.equal(first.length, 1, `expected one line per table, got ${JSON.stringify(first)}`);
    const line = first[0] as string;
    assert.ok(line.includes('"report_schedule"'));
    for (const col of COLUMNS) {
      assert.ok(line.includes(col.name), `line does not name "${col.name}": ${line}`);
    }
    // A second QueryInterface over the same metadata says nothing more.
    assert.deepEqual(
      captureWarnings(() => q('neither')),
      [],
    );
    resetWarnOnce(WARN_NS.untypedDateColumn);
  });

  it('covers the time-of-day columns `dateColumns` deliberately omits', () => {
    resetWarnOnce(WARN_NS.untypedDateColumn);
    const [line] = captureWarnings(() => q('neither'));
    // The `time` column is the LOUD failure (Postgres rejects the ISO
    // timestamp the driver would send), so it must be both named and explained.
    assert.ok((line as string).includes('window_start'));
    assert.match(line as string, /invalid input syntax for type time/);
    resetWarnOnce(WARN_NS.untypedDateColumn);
  });

  it('never claims a timestamptz column stores local time', () => {
    resetWarnOnce(WARN_NS.untypedDateColumn);
    const [line] = captureWarnings(() => q('neither'));
    // Binding the Date IS correct for timestamptz, so the local-calendar-fields
    // consequence must be attributed to the zone-less types alone, with
    // timestamptz called out as unaffected.
    assert.match(line as string, /right for `timestamptz`/);
    assert.match(line as string, /every `timestamptz` among them, are unaffected/);
    resetWarnOnce(WARN_NS.untypedDateColumn);
  });

  it('cannot throw on metadata whose dateColumns survived a JSON round trip', () => {
    // Serialized metadata (a plausible serverless pattern) turns every `Set`
    // into `{}`. Iterating it threw `TypeError: dateColumns is not iterable`
    // from the constructor, in dev only, so dev crashed while production ran on.
    resetWarnOnce(WARN_NS.untypedDateColumn);
    for (const shape of ['both', 'neither'] as const) {
      const jsonRoundTripped = JSON.parse(JSON.stringify(buildSchema(shape))) as SchemaMetadata;
      assert.ok(!(jsonRoundTripped.tables.report_schedule?.dateColumns instanceof Set));
      captureWarnings(() => makeQuery('report_schedule', jsonRoundTripped));
    }
    resetWarnOnce(WARN_NS.untypedDateColumn);
  });

  it('stays silent when the type resolves from either source', () => {
    resetWarnOnce(WARN_NS.untypedDateColumn);
    assert.deepEqual(
      captureWarnings(() => q('maps')),
      [],
    );
    assert.deepEqual(
      captureWarnings(() => q('columns')),
      [],
    );
    resetWarnOnce(WARN_NS.untypedDateColumn);
  });

  it('stays silent in production and on non-PostgreSQL engines', () => {
    resetWarnOnce(WARN_NS.untypedDateColumn);
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      assert.deepEqual(
        captureWarnings(() => q('neither')),
        [],
      );
    } finally {
      if (prev === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = prev;
    }
    // The UTC bind rewrite is Postgres-gated, so a missing type changes nothing
    // about how the other engines bind a Date.
    const sqlite = () => makeQuery('report_schedule', buildSchema('neither'), { dialect: sqliteDialect });
    assert.deepEqual(captureWarnings(sqlite), []);
    resetWarnOnce(WARN_NS.untypedDateColumn);
  });
});

// ---------------------------------------------------------------------------
// 3. `utcTimestamps: false` reaches the write path
// ---------------------------------------------------------------------------

describe('utcTimestamps: false opt-out', () => {
  it('keeps the raw Date on writes and predicates', () => {
    const qi = makeQuery('report_schedule', buildSchema('both'), { utcTimestamps: false });
    assert.equal(qi.buildCreate({ data: { lastRun: A_TIMESTAMP } }).params[0], A_TIMESTAMP);
    assert.equal(qi.buildUpdate({ where: { id: 1 }, data: { day: A_TIMESTAMP } }).params[0], A_TIMESTAMP);
    assert.equal(qi.buildFindMany({ where: { lastRun: A_TIMESTAMP } }).params[0], A_TIMESTAMP);
  });

  it('leaves the default (flag absent, or true) rewriting to UTC', () => {
    assert.deepEqual(q('both').buildCreate({ data: { lastRun: A_TIMESTAMP } }).params, [TIMESTAMP_LITERAL]);
    const explicit = makeQuery('report_schedule', buildSchema('both'), { utcTimestamps: true });
    assert.deepEqual(explicit.buildCreate({ data: { lastRun: A_TIMESTAMP } }).params, [TIMESTAMP_LITERAL]);
  });
});
