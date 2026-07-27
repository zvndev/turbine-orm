/**
 * turbine-orm, temporal write/predicate bind serialization
 *
 * Two distinct problems are covered here, both a JS `Date` bound against a
 * temporal column:
 *
 * 1. TIME OF DAY. A `Date` bound straight through to a `time` column
 *    serializes as a full ISO timestamp with the process offset
 *    (`1970-01-01T04:00:00.000-05:00`), which Postgres rejects with
 *    `22007 invalid input syntax for type time`. Both the write path AND the
 *    WHERE path narrow it to the UTC time of day, matching Prisma.
 * 2. ZONE-LESS date / timestamp. The driver serializes a `Date` with the
 *    PROCESS's offset, so in a non-UTC process a `timestamp` column stores the
 *    local calendar fields, and since the read path parses an offset-less
 *    value as UTC, the value does not round-trip. Both paths bind the UTC
 *    components instead.
 *
 * The critical regression guard is `timestamptz`: it stores a real instant and
 * the driver's local-offset string is already correct, so it must keep binding
 * the Date OBJECT ITSELF (asserted by identity, not by deep-equality).
 *
 * Pure build-only tests, no database.
 *
 * Run: npx tsx --test src/test/time-column-write.test.ts
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { coerceTemporalValue } from '../query/utils.js';
import type { SchemaMetadata, TableMetadata } from '../schema.js';
import { localDateTimeKind, timeOfDayKind } from '../schema.js';
import { sqliteDialect } from '../sqlite.js';
import { makeQuery, mockTable } from './helpers.js';

/** 09:00 UTC, the exact value from the reported failure. */
const NINE_AM_UTC = new Date('1970-01-01T09:00:00Z');
const NINE_AM_UTC_MS = new Date('1970-01-01T09:00:00.250Z');
const A_TIMESTAMP = new Date('2026-07-25T09:00:00Z');
/** The UTC-component literals `A_TIMESTAMP` must bind as. */
const A_TIMESTAMP_LITERAL = '2026-07-25 09:00:00';
const A_DATE_LITERAL = '2026-07-25';

function buildSchema(): SchemaMetadata {
  const tables: Record<string, TableMetadata> = {};
  tables.report_schedules = mockTable('report_schedules', [
    { name: 'id', field: 'id' },
    { name: 'time', field: 'time', pgType: 'time' },
    { name: 'time_tz', field: 'timeTz', pgType: 'timetz' },
    { name: 'created_at', field: 'createdAt', pgType: 'timestamp' },
    { name: 'updated_at', field: 'updatedAt', pgType: 'timestamptz' },
    { name: 'on_date', field: 'onDate', pgType: 'date' },
    { name: 'label', field: 'label', pgType: 'text' },
    { name: 'slots', field: 'slots', pgType: '_time' },
  ]);
  return { tables, enums: {} };
}

const q = () => makeQuery('report_schedules', buildSchema());

// ---------------------------------------------------------------------------
// 1. Type classification
// ---------------------------------------------------------------------------

describe('timeOfDayKind', () => {
  it('classifies the udt_name spellings introspection records', () => {
    assert.equal(timeOfDayKind('time'), 'time');
    assert.equal(timeOfDayKind('timetz'), 'timetz');
  });

  it('classifies the SQL-standard spellings and precision suffixes', () => {
    assert.equal(timeOfDayKind('time without time zone'), 'time');
    assert.equal(timeOfDayKind('time with time zone'), 'timetz');
    assert.equal(timeOfDayKind('TIME(6)'), 'time');
    assert.equal(timeOfDayKind('timetz(3)'), 'timetz');
  });

  it('returns null for every other type, including timestamps and arrays', () => {
    for (const t of ['timestamp', 'timestamptz', 'date', 'interval', 'text', '_time', undefined]) {
      assert.equal(timeOfDayKind(t), null, `expected ${String(t)} not to classify as time-of-day`);
    }
  });

  it('strips a mid-spelling precision suffix', () => {
    assert.equal(timeOfDayKind('time(6) with time zone'), 'timetz');
    assert.equal(timeOfDayKind('time(3) without time zone'), 'time');
  });
});

describe('localDateTimeKind', () => {
  it('classifies the zone-less date/timestamp spellings', () => {
    assert.equal(localDateTimeKind('date'), 'date');
    assert.equal(localDateTimeKind('timestamp'), 'timestamp');
    assert.equal(localDateTimeKind('timestamp without time zone'), 'timestamp');
    assert.equal(localDateTimeKind('TIMESTAMP(3)'), 'timestamp');
    assert.equal(localDateTimeKind('timestamp(6) without time zone'), 'timestamp');
  });

  it('NEVER classifies timestamptz, time, or MySQL datetime', () => {
    for (const t of [
      'timestamptz',
      'timestamp with time zone',
      'timestamp(3) with time zone',
      'time',
      'timetz',
      'datetime',
      'text',
      '_timestamp',
      undefined,
    ]) {
      assert.equal(localDateTimeKind(t), null, `expected ${String(t)} not to classify as zone-less`);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. create
// ---------------------------------------------------------------------------

describe('create: Date on a time column', () => {
  it('binds the UTC time of day, not an ISO timestamp', () => {
    const d = q().buildCreate({ data: { time: NINE_AM_UTC, label: 'daily' } });
    assert.deepEqual(d.params, ['09:00:00', 'daily']);
  });

  it('binds timetz with an explicit +00:00 offset', () => {
    const d = q().buildCreate({ data: { timeTz: NINE_AM_UTC } });
    assert.deepEqual(d.params, ['09:00:00+00:00']);
  });

  it('keeps fractional seconds when the Date carries them', () => {
    const d = q().buildCreate({ data: { time: NINE_AM_UTC_MS } });
    assert.deepEqual(d.params, ['09:00:00.250']);
  });

  it('passes a string time literal through untouched', () => {
    const d = q().buildCreate({ data: { time: '09:00:00', timeTz: '09:00:00+02:00' } });
    assert.deepEqual(d.params, ['09:00:00', '09:00:00+02:00']);
  });

  it('leaves null untouched', () => {
    const d = q().buildCreate({ data: { time: null, timeTz: null } });
    assert.deepEqual(d.params, [null, null]);
  });

  it('binds the UTC components for a zone-less timestamp / date column', () => {
    const d = q().buildCreate({ data: { createdAt: A_TIMESTAMP, onDate: A_TIMESTAMP } });
    assert.deepEqual(d.params, [A_TIMESTAMP_LITERAL, A_DATE_LITERAL]);
  });

  it('REGRESSION: timestamptz still binds the Date OBJECT (identity)', () => {
    const d = q().buildCreate({ data: { updatedAt: A_TIMESTAMP } });
    assert.equal(d.params.length, 1);
    // Identity, not deep-equality: the driver must still receive the very same
    // Date instance, because its local-offset serialization is correct here.
    assert.equal(d.params[0], A_TIMESTAMP);
  });

  it('REGRESSION: a non-temporal column binds its value by identity', () => {
    const buf = Buffer.from('x');
    const arr = [1, 2, 3];
    const d = q().buildCreate({ data: { label: buf as unknown as string, id: arr as unknown as number } });
    assert.equal(d.params[0], buf);
    assert.equal(d.params[1], arr);
  });

  it('rewrites a Date[] on a time[] column element-wise', () => {
    const d = q().buildCreate({ data: { slots: [NINE_AM_UTC, new Date('1970-01-01T17:30:00Z')] } });
    assert.deepEqual(d.params, [['09:00:00', '17:30:00']]);
  });

  it('REGRESSION: a string[] on a time[] column is returned by identity', () => {
    const arr = ['09:00:00'];
    const d = q().buildCreate({ data: { slots: arr } });
    assert.equal(d.params[0], arr);
  });
});

describe('createMany: Date on a temporal column', () => {
  it('casts the UNNEST array to the column type, not text[]', () => {
    // The bug: PG_TO_ARRAY had no `time` entry, so this emitted `$1::text[]`
    // and Postgres answered `42804 column "time" is of type time without time
    // zone but expression is of type text`, the params were already correct.
    const d = q().buildCreateMany({
      data: [
        { time: NINE_AM_UTC, createdAt: A_TIMESTAMP },
        { time: new Date('1970-01-01T17:30:00Z'), createdAt: A_TIMESTAMP },
      ],
    });
    assert.equal(
      d.sql,
      'INSERT INTO "report_schedules" ("time", "created_at") ' +
        'SELECT * FROM UNNEST($1::time[], $2::timestamp[]) RETURNING *',
    );
    assert.deepEqual(d.params[0], ['09:00:00', '17:30:00']);
    assert.deepEqual(d.params[1], [A_TIMESTAMP_LITERAL, A_TIMESTAMP_LITERAL]);
  });

  it('casts timetz and date correctly too, and leaves timestamptz binding Dates', () => {
    const d = q().buildCreateMany({ data: [{ timeTz: NINE_AM_UTC, onDate: A_TIMESTAMP, updatedAt: A_TIMESTAMP }] });
    assert.match(d.sql, /UNNEST\(\$1::timetz\[\], \$2::date\[\], \$3::timestamptz\[\]\)/);
    assert.deepEqual(d.params[0], ['09:00:00+00:00']);
    assert.deepEqual(d.params[1], [A_DATE_LITERAL]);
    assert.equal((d.params[2] as unknown[])[0], A_TIMESTAMP);
  });
});

// ---------------------------------------------------------------------------
// 3. update / updateMany
// ---------------------------------------------------------------------------

describe('update: Date on a time column', () => {
  it('binds the UTC time of day (the reported failure)', () => {
    const d = q().buildUpdate({ where: { id: 7 }, data: { time: NINE_AM_UTC } });
    assert.deepEqual(d.params, ['09:00:00', 7]);
  });

  it('binds it the same way on a warmed SQL-cache hit', () => {
    // The params of a cache HIT come from collectSetParams, a separate walker
    // from buildSetClause, both must narrow, or the second call regresses.
    const qi = q();
    qi.buildUpdate({ where: { id: 7 }, data: { time: NINE_AM_UTC } });
    const d = qi.buildUpdate({ where: { id: 8 }, data: { time: NINE_AM_UTC } });
    assert.deepEqual(d.params, ['09:00:00', 8]);
  });

  it('narrows the { set: Date } atomic-operator form', () => {
    const d = q().buildUpdate({ where: { id: 7 }, data: { time: { set: NINE_AM_UTC } } });
    assert.deepEqual(d.params, ['09:00:00', 7]);
  });

  it('narrows on the optimistic-lock path (uncached, built params)', () => {
    const d = q().buildUpdate({
      where: { id: 7 },
      data: { time: NINE_AM_UTC },
      optimisticLock: { field: 'id', expected: 1 },
    });
    assert.equal(d.params[0], '09:00:00');
  });

  it('binds the UTC components for a zone-less timestamp column', () => {
    const d = q().buildUpdate({ where: { id: 7 }, data: { createdAt: A_TIMESTAMP } });
    assert.deepEqual(d.params, [A_TIMESTAMP_LITERAL, 7]);
  });

  it('REGRESSION: a timestamptz column still binds the Date object (identity)', () => {
    const d = q().buildUpdate({ where: { id: 7 }, data: { updatedAt: A_TIMESTAMP } });
    assert.equal(d.params[0], A_TIMESTAMP);
  });

  it('updateMany narrows too', () => {
    const d = q().buildUpdateMany({ where: { label: 'daily' }, data: { time: NINE_AM_UTC } });
    assert.deepEqual(d.params, ['09:00:00', 'daily']);
  });
});

// ---------------------------------------------------------------------------
// 4. upsert
// ---------------------------------------------------------------------------

describe('upsert: Date on a time column', () => {
  it('narrows both the create params and the conflict-update params', () => {
    const d = q().buildUpsert({
      where: { id: 7 },
      create: { id: 7, time: NINE_AM_UTC },
      update: { time: new Date('1970-01-01T18:45:00Z'), createdAt: A_TIMESTAMP },
    });
    assert.deepEqual(d.params, [7, '09:00:00', '18:45:00', A_TIMESTAMP_LITERAL]);
  });
});

// ---------------------------------------------------------------------------
// 5. Back-compat: metadata generated before this change
// ---------------------------------------------------------------------------

describe('older generated metadata', () => {
  /**
   * The shape `generateMetadata` emitted before this change: per-column
   * `pgTypes` / `dialectTypes` (both have always been part of TableMetadata),
   * no new fields. The narrowing reads the same per-column type, so an old
   * generated client picks up the fix without regenerating.
   */
  it('still narrows a time column', () => {
    const legacy: TableMetadata = {
      name: 'report_schedules',
      columns: [
        {
          name: 'time',
          field: 'time',
          pgType: 'time',
          tsType: 'string',
          nullable: false,
          hasDefault: false,
          isArray: false,
          pgArrayType: 'text[]',
        },
      ],
      columnMap: { time: 'time' },
      reverseColumnMap: { time: 'time' },
      dateColumns: new Set(),
      pgTypes: { time: 'time' },
      allColumns: ['time'],
      primaryKey: [],
      uniqueColumns: [],
      relations: {},
      indexes: [],
    };
    const qi = makeQuery('report_schedules', { tables: { report_schedules: legacy }, enums: {} });
    assert.deepEqual(qi.buildCreate({ data: { time: NINE_AM_UTC } }).params, ['09:00:00']);
  });

  it('falls back to the pre-change behavior when the column type is unknown', () => {
    const bare: TableMetadata = {
      name: 't',
      columns: [],
      columnMap: { when: 'when' },
      reverseColumnMap: { when: 'when' },
      dateColumns: new Set(),
      pgTypes: {},
      allColumns: ['when'],
      primaryKey: [],
      uniqueColumns: [],
      relations: {},
      indexes: [],
    };
    const qi = makeQuery('t', { tables: { t: bare }, enums: {} });
    assert.deepEqual(qi.buildCreate({ data: { when: A_TIMESTAMP } }).params, [A_TIMESTAMP]);
  });
});

// ---------------------------------------------------------------------------
// 6. WHERE / predicate path
// ---------------------------------------------------------------------------

describe('where: Date on a temporal column', () => {
  it('binds a time-of-day literal for equality on a time column', () => {
    // Before this, the bound value was the driver's ISO timestamp and Postgres
    // answered `22007 invalid input syntax for type time`.
    const d = q().buildFindMany({ where: { time: NINE_AM_UTC } });
    assert.deepEqual(d.params, ['09:00:00']);
  });

  it('binds it on every comparison operator, and element-wise inside in/notIn', () => {
    const d = q().buildFindMany({
      where: { time: { gte: NINE_AM_UTC, lt: new Date('1970-01-01T17:30:00Z'), in: [NINE_AM_UTC] } },
    });
    assert.deepEqual(d.params, ['09:00:00', '17:30:00', ['09:00:00']]);
  });

  it('binds the UTC components on zone-less timestamp / date columns', () => {
    const d = q().buildFindMany({ where: { createdAt: { gt: A_TIMESTAMP }, onDate: A_TIMESTAMP } });
    assert.deepEqual(d.params, [A_TIMESTAMP_LITERAL, A_DATE_LITERAL]);
  });

  it('REGRESSION: timestamptz predicates still bind the Date object (identity)', () => {
    const d = q().buildFindMany({ where: { updatedAt: { gte: A_TIMESTAMP } } });
    assert.equal(d.params[0], A_TIMESTAMP);
    const inList = q().buildFindMany({ where: { updatedAt: { in: [A_TIMESTAMP] } } });
    assert.equal((inList.params[0] as unknown[])[0], A_TIMESTAMP);
  });

  it('binds identically on a warmed SQL-cache hit (param-collect path)', () => {
    // Build and collect are separate walkers; a value transform that lands on
    // only one of them regresses on the second identical-shaped call.
    const qi = q();
    const first = qi.buildFindMany({ where: { time: NINE_AM_UTC, createdAt: { gt: A_TIMESTAMP } } });
    const second = qi.buildFindMany({ where: { time: NINE_AM_UTC, createdAt: { gt: A_TIMESTAMP } } });
    assert.deepEqual(second.params, first.params);
    assert.deepEqual(second.params, [A_TIMESTAMP_LITERAL, '09:00:00']);
    assert.equal(second.sql, first.sql);
  });

  it('is a value transform only, the SQL is unchanged by the rewrite', () => {
    const withDate = q().buildFindMany({ where: { time: NINE_AM_UTC } });
    const withString = q().buildFindMany({ where: { time: '09:00:00' } });
    assert.equal(withDate.sql, withString.sql);
  });

  it('reaches a relation-filter sub-where (the scoped walker)', () => {
    const tables: Record<string, TableMetadata> = { ...buildSchema().tables };
    tables.orgs = mockTable('orgs', [{ name: 'id', field: 'id' }], {
      schedules: {
        name: 'schedules',
        type: 'hasMany',
        from: 'orgs',
        to: 'report_schedules',
        foreignKey: 'id',
        referenceKey: 'id',
      },
    });
    const qi = makeQuery('orgs', { tables, enums: {} });
    const d = qi.buildFindMany({ where: { schedules: { some: { time: NINE_AM_UTC } } } });
    assert.deepEqual(d.params, ['09:00:00']);
    // ...and the same on the warmed cache-hit collect path.
    assert.deepEqual(qi.buildFindMany({ where: { schedules: { some: { time: NINE_AM_UTC } } } }).params, ['09:00:00']);
  });

  it('orderBy on a time column binds nothing (it was never broken)', () => {
    const d = q().buildFindMany({ orderBy: { time: 'asc' } });
    assert.deepEqual(d.params, []);
    assert.match(d.sql, /ORDER BY "time" ASC/);
  });
});

// ---------------------------------------------------------------------------
// 6b. findUnique's simple-where fast path
// ---------------------------------------------------------------------------

/**
 * `findUnique` compiles a plain all-equality where through its OWN param
 * pusher rather than `buildWhereClause`, so a value transform added to the
 * general walker does not reach it. The two paths must bind identically or a
 * `Date` keyed on a zone-less column matches through `findFirst` and misses
 * through `findUnique` on the very same predicate: no error, an empty result.
 *
 * The fast path has a build pusher AND a separate cache-hit collector, so each
 * assertion runs twice against one QueryInterface.
 */
describe('findUnique fast path: temporal binds agree with the general path', () => {
  const WHERE = { createdAt: A_TIMESTAMP };

  it('binds the UTC-component literal on a zone-less timestamp column', () => {
    const qi = q();
    const built = qi.buildFindUnique({ where: WHERE });
    assert.deepEqual(built.params, [A_TIMESTAMP_LITERAL]);
    // Warmed cache hit: the collector is a second, separate walk.
    assert.deepEqual(qi.buildFindUnique({ where: WHERE }).params, [A_TIMESTAMP_LITERAL]);
  });

  it('binds a time-of-day literal on a time column', () => {
    const qi = q();
    assert.deepEqual(qi.buildFindUnique({ where: { time: NINE_AM_UTC } }).params, ['09:00:00']);
    assert.deepEqual(qi.buildFindUnique({ where: { time: NINE_AM_UTC } }).params, ['09:00:00']);
  });

  it('binds exactly what findFirst binds for the same predicate', () => {
    const unique = q().buildFindUnique({ where: { createdAt: A_TIMESTAMP, onDate: A_TIMESTAMP } });
    // findFirst appends its own LIMIT param, which is not part of the where.
    const first = q().buildFindFirst({ where: { createdAt: A_TIMESTAMP, onDate: A_TIMESTAMP } });
    assert.deepEqual(unique.params, first.params.slice(0, unique.params.length));
    assert.deepEqual(unique.params, [A_TIMESTAMP_LITERAL, A_DATE_LITERAL]);
  });

  it('REGRESSION: timestamptz and non-temporal keys are still bound by identity', () => {
    const qi = q();
    // The fast path binds its keys in SORTED order: label, then updatedAt.
    const built = qi.buildFindUnique({ where: { updatedAt: A_TIMESTAMP, label: 'x' } });
    assert.equal(built.params[0], 'x');
    assert.equal(built.params[1], A_TIMESTAMP);
    const hit = qi.buildFindUnique({ where: { updatedAt: A_TIMESTAMP, label: 'x' } });
    assert.equal(hit.params[1], A_TIMESTAMP);
    assert.equal(hit.sql, built.sql);
  });

  it('is a value transform only: the SQL is unchanged by the rewrite', () => {
    const withDate = q().buildFindUnique({ where: { time: NINE_AM_UTC } });
    const withString = q().buildFindUnique({ where: { time: '09:00:00' } });
    assert.equal(withDate.sql, withString.sql);
  });
});

// ---------------------------------------------------------------------------
// 7. Scoping of the zone-less rewrite: opt-out and non-PostgreSQL engines
// ---------------------------------------------------------------------------

describe('zone-less rewrite scoping', () => {
  it('the utcDateTimes=false branch keeps the raw Date, and still narrows time-of-day', () => {
    // The opt-out switch the query layer reads (`BuilderCtx.utcTimestamps`).
    // A `time` column still narrows under it: binding a Date there is a hard
    // Postgres error, not a value-correctness choice.
    assert.equal(coerceTemporalValue('timestamp', A_TIMESTAMP, false), A_TIMESTAMP);
    assert.equal(coerceTemporalValue('date', A_TIMESTAMP, false), A_TIMESTAMP);
    assert.equal(coerceTemporalValue('time', NINE_AM_UTC, false), '09:00:00');
    assert.equal(coerceTemporalValue('timestamp', A_TIMESTAMP, true), A_TIMESTAMP_LITERAL);
  });

  it('coerceTemporalValue returns non-temporal and timestamptz values by identity', () => {
    const arr = [A_TIMESTAMP];
    assert.equal(coerceTemporalValue('timestamptz', A_TIMESTAMP), A_TIMESTAMP);
    assert.equal(coerceTemporalValue('timestamptz', arr), arr);
    assert.equal(coerceTemporalValue('text', A_TIMESTAMP), A_TIMESTAMP);
    assert.equal(coerceTemporalValue(undefined, A_TIMESTAMP), A_TIMESTAMP);
    const invalid = new Date('nope');
    assert.equal(coerceTemporalValue('timestamp', invalid), invalid);
  });

  it('a non-PostgreSQL dialect keeps the driver Date binding for date / timestamp', () => {
    // MySQL/SQL Server read a zone-less literal through their own session
    // rules, so only PostgreSQL (whose read path pins UTC) gets the rewrite.
    const qi = makeQuery('report_schedules', buildSchema(), { dialect: sqliteDialect });
    const d = qi.buildCreate({ data: { createdAt: A_TIMESTAMP, onDate: A_TIMESTAMP } });
    for (const p of d.params) assert.equal(p, A_TIMESTAMP);
    assert.deepEqual(qi.buildCreate({ data: { time: NINE_AM_UTC } }).params, ['09:00:00']);
  });
});
