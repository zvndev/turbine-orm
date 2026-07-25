/**
 * turbine-orm — Codegen coverage for the temporal column types
 *
 * A `time` column must be distinguishable from a `timestamp` column in the
 * GENERATED metadata, because the write path narrows a JS `Date` to a
 * time-of-day literal for `time`/`timetz` and must leave `timestamp` /
 * `timestamptz` / `date` alone. That distinction rides on the per-column
 * `pgTypes` / `dialectTypes` maps (`dateColumns` deliberately excludes
 * time-of-day types, which are never Date-coerced on read).
 *
 * Covers both metadata sources: an introspected `SchemaMetadata` and the
 * code-first `defineSchema` path (via `schemaDefToMetadata`).
 *
 * Pure — no database.
 *
 * Run: npx tsx --test src/test/generate-temporal-types.test.ts
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { generateMetadata, generateTypes, generateZod } from '../generate.js';
import type { ColumnMetadata, SchemaMetadata } from '../schema.js';
import { defineSchema } from '../schema-builder.js';
import { schemaDefToMetadata } from '../schema-metadata.js';

const TEMPORAL: { name: string; pgType: string; tsType: string }[] = [
  { name: 'at_time', pgType: 'time', tsType: 'string' },
  { name: 'at_timetz', pgType: 'timetz', tsType: 'string' },
  { name: 'at_timestamp', pgType: 'timestamp', tsType: 'Date' },
  { name: 'at_timestamptz', pgType: 'timestamptz', tsType: 'Date' },
  { name: 'at_date', pgType: 'date', tsType: 'Date' },
  { name: 'every', pgType: 'interval', tsType: 'string' },
];

function col(name: string, pgType: string, tsType: string): ColumnMetadata {
  return {
    name,
    field: name,
    pgType,
    dialectType: pgType,
    tsType,
    nullable: false,
    hasDefault: false,
    isArray: false,
    pgArrayType: 'text[]',
  } as ColumnMetadata;
}

const SCHEMA: SchemaMetadata = {
  enums: {},
  tables: {
    report_schedules: {
      name: 'report_schedules',
      columns: [
        col('id', 'int8', 'number'),
        ...TEMPORAL.map((t) => col(t.name, t.pgType, t.tsType)),
        // one nullable time column: the write input widening must keep `| null`
        { ...col('maybe_time', 'time', 'string | null'), nullable: true },
      ],
      columnMap: Object.fromEntries([
        ['id', 'id'],
        ...TEMPORAL.map((t) => [t.name, t.name]),
        ['maybe_time', 'maybe_time'],
      ]),
      reverseColumnMap: Object.fromEntries([
        ['id', 'id'],
        ...TEMPORAL.map((t) => [t.name, t.name]),
        ['maybe_time', 'maybe_time'],
      ]),
      // Only the types that carry a date part are Date-coerced on read.
      dateColumns: new Set(['at_timestamp', 'at_timestamptz', 'at_date']),
      dialectTypes: Object.fromEntries([
        ['id', 'int8'],
        ...TEMPORAL.map((t) => [t.name, t.pgType]),
        ['maybe_time', 'time'],
      ]),
      pgTypes: Object.fromEntries([['id', 'int8'], ...TEMPORAL.map((t) => [t.name, t.pgType]), ['maybe_time', 'time']]),
      allColumns: ['id', ...TEMPORAL.map((t) => t.name), 'maybe_time'],
      primaryKey: ['id'],
      uniqueColumns: [],
      relations: {},
      indexes: [],
    },
  },
};

describe('generateMetadata — temporal column types', () => {
  const out = generateMetadata(SCHEMA);

  it('emits every temporal type verbatim in dialectTypes and pgTypes', () => {
    for (const t of TEMPORAL) {
      const occurrences = out.split(`${t.name}: '${t.pgType}'`).length - 1;
      assert.equal(occurrences, 2, `${t.name}: '${t.pgType}' should appear in both dialectTypes and pgTypes`);
    }
  });

  it('keeps time / timetz OUT of dateColumns while keeping timestamp / date in', () => {
    const line = out.split('\n').find((l) => l.includes('dateColumns:'));
    assert.ok(line, 'expected a dateColumns line');
    assert.match(line, /'at_timestamp'/);
    assert.match(line, /'at_timestamptz'/);
    assert.match(line, /'at_date'/);
    assert.doesNotMatch(line, /'at_time'/);
    assert.doesNotMatch(line, /'at_timetz'/);
  });

  it('records the per-column type on the ColumnMetadata entries too', () => {
    assert.match(out, /name: 'at_time'[^\n]*pgType: 'time'/);
    assert.match(out, /name: 'at_timestamp'[^\n]*pgType: 'timestamp'/);
  });
});

describe('generateTypes — temporal column types', () => {
  const out = generateTypes(SCHEMA);

  it('reads a time column back as a string', () => {
    assert.match(out, /at_time: string;/);
    assert.match(out, /at_timetz: string;/);
  });

  it('reads timestamp / timestamptz / date back as Date and interval as string', () => {
    assert.match(out, /at_timestamp: Date;/);
    assert.match(out, /at_timestamptz: Date;/);
    assert.match(out, /at_date: Date;/);
    assert.match(out, /every: string;/);
  });

  it('write inputs accept a Date on a time column (Prisma types @db.Time as Date)', () => {
    const create = out.slice(out.indexOf('ReportScheduleCreate'), out.indexOf('ReportScheduleUpdate'));
    assert.match(create, /at_time: string \| Date;/);
    assert.match(create, /at_timetz: string \| Date;/);
    assert.match(create, /maybe_time\?: string \| Date \| null;/);
    const update = out.slice(out.indexOf('ReportScheduleUpdate'));
    assert.match(update, /at_time\?: string \| Date;/);
  });

  it('write inputs for timestamp / date columns are unchanged', () => {
    const create = out.slice(out.indexOf('ReportScheduleCreate'), out.indexOf('ReportScheduleUpdate'));
    assert.match(create, /at_timestamp: Date;/);
    assert.match(create, /at_date: Date;/);
    assert.doesNotMatch(create, /at_timestamp: string \| Date;/);
  });
});

describe('code-first defineSchema — temporal column types', () => {
  /**
   * The code-first builder has no `time` / `timetz` column type today (its
   * temporal types are `timestamp`/`timestamptz` and `date`), so a time column
   * only ever reaches metadata through introspection. What matters for the
   * write path is that both metadata sources populate the SAME per-column
   * `pgTypes` / `dialectTypes` maps the narrowing reads, which this pins.
   */
  it('carries the declared temporal types into the generated metadata', () => {
    const def = defineSchema({
      reportSchedules: {
        id: { type: 'serial', primaryKey: true },
        atTimestamptz: { type: 'timestamptz' },
        atDate: { type: 'date' },
      },
    });
    const meta = schemaDefToMetadata(def);
    const table = meta.tables.report_schedules!;
    assert.equal(table.pgTypes.at_timestamptz, 'timestamptz');
    assert.equal(table.pgTypes.at_date, 'date');
    assert.deepEqual([...table.dateColumns].sort(), ['at_date', 'at_timestamptz']);

    // The emitter reads the same maps, so the generated module agrees.
    const out = generateMetadata(meta);
    assert.match(out, /at_timestamptz: 'timestamptz'/);
    assert.match(out, /at_date: 'date'/);
  });
});

describe('generateZod — temporal column types', () => {
  const out = generateZod(SCHEMA);
  const section = (start: string, end?: string) => out.slice(out.indexOf(start), end ? out.indexOf(end) : undefined);

  it('the ROW schema still validates a time column as a string', () => {
    const row = section('export const ReportScheduleSchema', 'export const ReportScheduleCreateSchema');
    assert.match(row, /at_time: z\.string\(\)/);
    assert.match(row, /at_timetz: z\.string\(\)/);
  });

  it('the CREATE schema accepts a Date on a time column', () => {
    // Previously `z.string()`, so `ReportScheduleCreateSchema.parse({ at_time:
    // new Date() })` failed validation for a value the runtime writes fine.
    const create = section('export const ReportScheduleCreateSchema', 'export const ReportScheduleUpdateSchema');
    assert.match(create, /at_time: z\.union\(\[z\.string\(\), z\.date\(\)\]\)/);
    assert.match(create, /at_timetz: z\.union\(\[z\.string\(\), z\.date\(\)\]\)/);
    assert.match(create, /maybe_time: z\.union\(\[z\.string\(\), z\.date\(\)\]\)\.nullable\(\)\.optional\(\)/);
  });

  it('the UPDATE schema accepts a Date on a time column', () => {
    const update = section('export const ReportScheduleUpdateSchema');
    assert.match(update, /at_time: z\.union\(\[z\.string\(\), z\.date\(\)\]\)\.optional\(\)/);
  });

  it('every non-time column is byte-identical across row and write schemas', () => {
    const row = section('export const ReportScheduleSchema', 'export const ReportScheduleCreateSchema');
    const create = section('export const ReportScheduleCreateSchema', 'export const ReportScheduleUpdateSchema');
    for (const [field, expr] of [
      ['at_timestamp', 'z.coerce.date()'],
      ['at_timestamptz', 'z.coerce.date()'],
      ['at_date', 'z.coerce.date()'],
      ['every', 'z.string()'],
      ['id', 'z.number()'],
    ] as const) {
      assert.ok(row.includes(`${field}: ${expr}`), `row ${field}`);
      assert.ok(create.includes(`${field}: ${expr}`), `create ${field}`);
    }
  });
});

describe('array time columns — codegen widening', () => {
  const ARRAY_SCHEMA: SchemaMetadata = {
    enums: {},
    tables: {
      slots: {
        name: 'slots',
        columns: [
          col('id', 'int8', 'number'),
          { ...col('windows', '_time', 'string[]'), isArray: true, pgArrayType: 'time[]' },
        ],
        columnMap: { id: 'id', windows: 'windows' },
        reverseColumnMap: { id: 'id', windows: 'windows' },
        dateColumns: new Set(),
        dialectTypes: { id: 'int8', windows: '_time' },
        pgTypes: { id: 'int8', windows: '_time' },
        allColumns: ['id', 'windows'],
        primaryKey: ['id'],
        uniqueColumns: [],
        relations: {},
        indexes: [],
      },
    },
  };

  it('widens the write input to (string | Date)[] — the bind rewrite is element-wise', () => {
    const out = generateTypes(ARRAY_SCHEMA);
    assert.match(out, /windows: string\[\];/); // row type unchanged
    const create = out.slice(out.indexOf('SlotCreate'), out.indexOf('SlotUpdate'));
    assert.match(create, /windows: \(string \| Date\)\[\];/);
  });

  it('widens the Zod write schemas the same way', () => {
    const out = generateZod(ARRAY_SCHEMA);
    const create = out.slice(out.indexOf('SlotCreateSchema'), out.indexOf('SlotUpdateSchema'));
    assert.match(create, /windows: z\.union\(\[z\.string\(\), z\.date\(\)\]\)\.array\(\)/);
    const row = out.slice(out.indexOf('SlotSchema'), out.indexOf('SlotCreateSchema'));
    assert.match(row, /windows: z\.string\(\)\.array\(\)/);
  });
});
