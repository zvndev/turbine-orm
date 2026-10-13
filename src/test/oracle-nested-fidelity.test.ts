/**
 * Oracle 6: nested vs top-level value fidelity under a non-UTC server time zone.
 *
 * A column read through a relation must produce the same JS value as the same
 * column read at the top level, under every relation strategy and JSON encoding.
 * The server's `TimeZone` is set as a CONNECTION PARAMETER (`options=-c
 * TimeZone=...` on the URL), never a session SET, and is deliberately not UTC:
 * with a UTC server, JSON-rendered timestamps and driver-parsed ones coincide
 * and a whole family of nested-read bugs stays invisible.
 *
 * Two independent questions, two kinds of test:
 *   top-level vs raw SQL   every column, parsed from the text Postgres sends
 *   nested vs top-level    every column through hasMany, belongsTo and a stream,
 *                          under join / batched / auto / flatten x object / positional
 *
 * The values are the awkward ones: timestamps before 1900 (where a zone has a
 * local-mean-time offset with seconds) and BC, `infinity`, NaN and infinite
 * floats, negative zero, 64-bit integers past 2^53, a 30-digit numeric, arrays
 * with NULL elements, enum arrays, JSON documents, bytea.
 *
 * Run: DATABASE_URL=postgres://... npx tsx --test src/test/oracle-nested-fidelity.test.ts
 */

import assert from 'node:assert/strict';
import { describe } from 'node:test';
import type pg from 'pg';
import { skipGate } from './helpers.js';
import { DATABASE_URL, SKIP, scaled } from './oracle/env.js';
import { Failures } from './oracle/failures.js';
import { rawReader, runScript, withTimeZone } from './oracle/raw.js';
import { describeError, introspectTables, makeClient, type OracleClient, show, stable } from './oracle/util.js';

const FILE = 'oracle-nested-fidelity.test.ts';
const { it, before, after } = skipGate(SKIP, 'DATABASE_URL not set');

const PARENTS = 'orc_f_parents';
const ITEMS = 'orc_f_items';
const ENUM = 'orc_f_mood';

type Scalar = 'int' | 'bigint' | 'numeric' | 'float' | 'bool' | 'text' | 'instant' | 'json' | 'bytea' | 'enum';
type Kind = Scalar | { array: Scalar } | 'enumArray';

interface Col {
  col: string;
  field: string;
  pgType: string;
  kind: Kind;
}

const mk = (col: string, pgType: string, kind: Kind): Col => ({
  col,
  field: col.replace(/_([a-z0-9])/g, (_m, c: string) => c.toUpperCase()),
  pgType,
  kind,
});

const COLS: Col[] = [
  mk('c_int', 'int', 'int'),
  mk('c_bigint', 'bigint', 'bigint'),
  mk('c_numeric', 'numeric', 'numeric'),
  mk('c_float8', 'double precision', 'float'),
  mk('c_float4', 'real', 'float'),
  mk('c_bool', 'boolean', 'bool'),
  mk('c_text', 'text', 'text'),
  mk('c_timestamptz', 'timestamptz', 'instant'),
  mk('c_timestamp', 'timestamp', 'instant'),
  mk('c_date', 'date', 'instant'),
  mk('c_uuid', 'uuid', 'text'),
  mk('c_json', 'json', 'json'),
  mk('c_jsonb', 'jsonb', 'json'),
  mk('c_text_arr', 'text[]', { array: 'text' }),
  mk('c_int_arr', 'int[]', { array: 'int' }),
  mk('c_float_arr', 'double precision[]', { array: 'float' }),
  mk('c_bigint_arr', 'bigint[]', { array: 'bigint' }),
  mk('c_numeric_arr', 'numeric[]', { array: 'numeric' }),
  mk('c_tstz_arr', 'timestamptz[]', { array: 'instant' }),
  mk('c_mood', ENUM, 'enum'),
  mk('c_mood_arr', `${ENUM}[]`, 'enumArray'),
  mk('c_bytea', 'bytea', 'bytea'),
];

const DDL = `
DROP TABLE IF EXISTS ${ITEMS}, ${PARENTS} CASCADE;
DROP TYPE IF EXISTS ${ENUM} CASCADE;
CREATE TYPE ${ENUM} AS ENUM ('sad', 'ok', 'happy');
CREATE TABLE ${PARENTS} (id int PRIMARY KEY, label text NOT NULL);
CREATE TABLE ${ITEMS} (
  id int PRIMARY KEY,
  parent_id int REFERENCES ${PARENTS}(id),
  prev_id int REFERENCES ${ITEMS}(id),
  ${COLS.map((c) => `${c.col} ${c.pgType}`).join(',\n  ')}
);
CREATE INDEX ON ${ITEMS}(parent_id);
CREATE INDEX ON ${ITEMS}(prev_id);
`;

const q = (s: string): string => `'${s.replace(/'/g, "''")}'`;

/** Rows by theme. Values are SQL literals (already quoted/cast), keyed by column. */
const ROWS: Record<string, string>[] = [
  // 1 ordinary values
  {
    c_int: '42',
    c_bigint: '123',
    c_numeric: q('12.5'),
    c_float8: '1.5',
    c_float4: '2.5',
    c_bool: 'true',
    c_text: q('plain'),
    c_timestamptz: q('2024-03-10 10:30:00+00'),
    c_timestamp: q('2024-03-10 02:30:00'),
    c_date: q('2024-03-10'),
    c_uuid: q('00000000-0000-4000-8000-000000000001'),
    c_json: q('{"a":[1,2,{"b":null}]}'),
    c_jsonb: q('{"a":[1,2,{"b":null}]}'),
    c_text_arr: q('{a,b}'),
    c_int_arr: q('{1,2,3}'),
    c_float_arr: q('{1.5,2}'),
    c_bigint_arr: q('{1,2}'),
    c_numeric_arr: q('{0.1,2.5}'),
    c_tstz_arr: q('{"2024-03-10 10:30:00+00","2024-03-11 00:00:00+00"}'),
    c_mood: q('ok'),
    c_mood_arr: q('{ok}'),
    c_bytea: q('\\xdeadbeef'),
  },
  // 2 before 1900 (a local-mean-time offset with seconds in most zones)
  {
    c_timestamptz: q('1850-06-01 12:00:00+00'),
    c_timestamp: q('1850-06-01 12:00:00'),
    c_date: q('1850-06-01'),
    c_tstz_arr: q('{"1850-06-01 12:00:00+00","1899-12-31 23:59:59+00"}'),
    c_text: q('ancient'),
  },
  // 3 year 1 and BC
  {
    c_timestamptz: q('0001-01-01 00:00:00+00'),
    c_timestamp: q('0044-03-15 12:00:00 BC'),
    c_date: q('0044-03-15 BC'),
    c_text: q('bc'),
  },
  // 4 infinity and the special floats
  {
    c_timestamptz: q('infinity'),
    c_timestamp: q('-infinity'),
    c_date: q('infinity'),
    c_float8: q('NaN'),
    c_float4: q('Infinity'),
    c_numeric: q('NaN'),
    c_text: q('infinite'),
  },
  // 5 more specials: -Infinity, negative zero, extremes
  {
    c_timestamptz: q('-infinity'),
    c_timestamp: q('infinity'),
    c_date: q('-infinity'),
    c_float8: q('-Infinity'),
    c_float4: q('-0'),
    c_text: q('neg'),
  },
  // 6 64-bit integers past 2^53 and a 30-digit numeric
  {
    c_bigint: q('9007199254740993'),
    c_numeric: q('123456789012345678901234567890.123456789'),
    c_float8: q('5e-324'),
    c_float4: q('16777217'),
    c_bigint_arr: q('{9007199254740993,-9223372036854775808}'),
    c_text: q('big'),
  },
  {
    c_bigint: q('-9223372036854775808'),
    c_numeric: q('-0.0000000001'),
    c_float8: q('-0'),
    c_float4: q('3.4028235e38'),
    c_int: '-2147483648',
  },
  { c_bigint: q('9223372036854775807'), c_float8: q('1e308'), c_int: '2147483647' },
  // 8 arrays: NULL elements, quoting, NaN/Infinity/-0, enums
  {
    c_text_arr: q('{a,NULL,"b,c","with \\"quote\\"",""}'),
    c_int_arr: q('{1,NULL,3}'),
    c_float_arr: q('{NaN,Infinity,-Infinity,-0,1.1}'),
    c_mood_arr: q('{sad,happy}'),
    c_text: q('arrays'),
  },
  {
    c_text_arr: q('{}'),
    c_int_arr: q('{}'),
    c_float_arr: q('{}'),
    c_bigint_arr: q('{}'),
    c_numeric_arr: q('{}'),
    c_tstz_arr: q('{}'),
    c_mood_arr: q('{}'),
  },
  // 10 JSON documents and bytea
  { c_json: q('[]'), c_jsonb: q('[1,[2,[3]]]'), c_bytea: q('\\x'), c_text: q('json') },
  {
    c_json: q('"str"'),
    c_jsonb: q('{"k":"İstanbul","n":12345678901234567890}'),
    c_bytea: q('\\x00ff5c'),
    c_mood: q('sad'),
  },
  // 12 sub-millisecond precision (the anchor skips these; nested must still equal top-level)
  {
    c_timestamptz: q('2024-11-03 06:30:00.123456+00'),
    c_timestamp: q('2024-11-03 01:30:00.999999'),
    c_text: q('micros'),
  },
  { c_timestamptz: q('1969-12-31 23:59:59.5+00'), c_timestamp: q('1969-12-31 23:59:59.5'), c_text: q('before epoch') },
  // 14 all NULL
  {},
];

function seedSql(): string {
  const out = [`INSERT INTO ${PARENTS} VALUES (1, 'one'), (2, 'two'), (3, 'empty');`];
  ROWS.forEach((row, i) => {
    const id = i + 1;
    const parent = id % 2 === 0 ? 2 : 1;
    const prev = id === 1 ? 'NULL' : String(id - 1);
    const cols = Object.keys(row);
    out.push(
      `INSERT INTO ${ITEMS} (id, parent_id, prev_id${cols.map((c) => `, ${c}`).join('')}) VALUES (${id}, ${parent}, ${prev}${cols
        .map((c) => `, ${row[c]}`)
        .join('')});`,
    );
  });
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// Expected values, from the text Postgres sends
// ---------------------------------------------------------------------------

const floatOf = (t: string): number =>
  t === 'NaN' ? Number.NaN : t === 'Infinity' ? Infinity : t === '-Infinity' ? -Infinity : Number(t);

/** "has at most three fractional digits", i.e. exactly representable as a JS Date. */
const msExact = (text: string): boolean => !/\.\d{4,}/.test(text);

function instantOf(text: string | null, epoch: string | null): Date | number | null | 'skip' {
  if (text === null) return null;
  if (text === 'infinity') return Infinity;
  if (text === '-infinity') return -Infinity;
  if (!msExact(text)) return 'skip';
  return new Date(Math.round(Number(epoch) * 1000));
}

interface RawRow {
  [column: string]: string | null;
}

/** SELECT list for one item column: its text plus whatever the comparison needs beyond text. */
function selectFor(c: Col): string {
  const k = c.kind;
  if (k === 'instant') {
    const base = c.pgType === 'date' ? `${c.col}::timestamp` : c.col;
    return `${c.col}::text AS ${c.col}, CASE WHEN ${c.col} IN ('infinity','-infinity') THEN NULL ELSE extract(epoch from ${base})::text END AS ${c.col}__epoch`;
  }
  if (typeof k === 'object') {
    const el = k.array === 'instant' ? `extract(epoch from e)::text` : 'e::text';
    return `CASE WHEN ${c.col} IS NULL THEN NULL ELSE (SELECT coalesce(json_agg(${el}), '[]'::json)::text FROM unnest(${c.col}) e) END AS ${c.col}, ${c.col}::text AS ${c.col}__text`;
  }
  if (k === 'enumArray') {
    return `CASE WHEN ${c.col} IS NULL THEN NULL ELSE (SELECT coalesce(json_agg(e::text), '[]'::json)::text FROM unnest(${c.col}) e) END AS ${c.col}, ${c.col}::text AS ${c.col}__text`;
  }
  if (k === 'bytea') return `encode(${c.col}, 'hex') AS ${c.col}`;
  return `${c.col}::text AS ${c.col}`;
}

/** Canonical form of the value Postgres holds, comparable with {@link canonActual}. */
function canonExpected(c: Col, row: RawRow): unknown {
  const text = row[c.col] ?? null;
  const k = c.kind;
  if (text === null) return null;
  switch (k) {
    case 'int':
      return Number(text);
    case 'bigint':
    case 'numeric':
    case 'text':
    case 'enum':
    case 'bytea':
      return text;
    case 'float':
      return floatOf(text);
    case 'bool':
      return text === 'true' || text === 't';
    case 'json':
      return JSON.parse(text);
    case 'instant':
      return instantOf(text, row[`${c.col}__epoch`] ?? null);
    case 'enumArray':
      return JSON.parse(text);
    default: {
      const elems = JSON.parse(text) as (string | null)[];
      return elems.map((e) => (e === null ? null : elementExpected(k.array, e)));
    }
  }
}

function elementExpected(kind: Scalar, e: string): unknown {
  switch (kind) {
    case 'int':
      return Number(e);
    case 'float':
      return floatOf(e);
    case 'instant':
      return new Date(Math.round(Number(e) * 1000));
    default:
      return e;
  }
}

function elementActual(kind: Scalar, e: unknown): unknown {
  if (e === null || e === undefined) return null;
  return kind === 'bigint' || kind === 'numeric' ? String(e) : e;
}

/** The JS value Turbine returned, normalized so a representation choice (string vs bigint) is not a difference. */
function canonActual(c: Col, v: unknown): unknown {
  if (v === null || v === undefined) return null;
  const k = c.kind;
  if (k === 'bigint' || k === 'numeric') return String(v);
  if (k === 'bytea') return Buffer.isBuffer(v) ? v.toString('hex') : v;
  if (typeof k === 'object') return Array.isArray(v) ? v.map((e) => elementActual(k.array, e)) : v;
  return v;
}

const top = (v: unknown): string => stable(v);

let db: OracleClient;
let reader: pg.Client;
const ZONES = scaled(
  ['America/New_York', 'Asia/Kolkata'],
  ['America/New_York', 'Asia/Kolkata', 'Europe/Amsterdam', 'Pacific/Auckland', 'UTC'],
);
const STRATEGIES = ['join', 'batched', 'auto', 'flatten'] as const;
const ENCODINGS = ['object', 'positional'] as const;

describe('oracle: nested reads equal top-level reads, under a non-UTC server', () => {
  before(async () => {
    await runScript(DATABASE_URL!, DDL + seedSql());
  });

  after(async () => {
    if (!SKIP)
      await runScript(
        DATABASE_URL!,
        `DROP TABLE IF EXISTS ${ITEMS}, ${PARENTS} CASCADE; DROP TYPE IF EXISTS ${ENUM} CASCADE`,
      );
  });

  for (const zone of ZONES) {
    describe(`server TimeZone=${zone}`, () => {
      let topRows: Map<number, Record<string, unknown>>;
      let rawRows: Map<number, RawRow>;

      before(async () => {
        const schema = await introspectTables(DATABASE_URL!, [PARENTS, ITEMS], {
          [PARENTS]: { orcFItems: 'items' },
          [ITEMS]: { orcFParent: 'parent', orcFItem: 'prev', orcFItems: 'next' },
        });
        db = makeClient(withTimeZone(DATABASE_URL!, zone), schema);
        reader = await rawReader(DATABASE_URL!, 'UTC');

        const shown = (await db.pool.query('SHOW TimeZone')).rows[0] as { TimeZone: string };
        assert.equal(shown.TimeZone, zone, 'the client connection did not receive the server time zone parameter');

        topRows = new Map(
          (await db.t(ITEMS).findMany({ orderBy: { id: 'asc' } })).map((r: { id: number }) => [
            r.id,
            r as Record<string, unknown>,
          ]),
        );
        const result = await reader.query(`SELECT id, ${COLS.map(selectFor).join(', ')} FROM ${ITEMS} ORDER BY id`);
        rawRows = new Map((result.rows as RawRow[]).map((r) => [Number(r.id), r]));
      });

      after(async () => {
        await db?.disconnect();
        await reader?.end();
      });

      it('top-level reads equal the values Postgres holds', () => {
        const failures = new Failures(FILE);
        assert.equal(topRows.size, ROWS.length, 'the table lost rows');
        for (const [id, raw] of rawRows) {
          const row = topRows.get(id) as Record<string, unknown>;
          for (const c of COLS) {
            const want = canonExpected(c, raw);
            if (want === 'skip') continue;
            failures.checked();
            const got = canonActual(c, row[c.field]);
            if (c.kind === 'enumArray') {
              // Either a real array or Postgres' own text form is a faithful reading; nothing else is.
              const text = raw[`${c.col}__text`] ?? null;
              if (top(got) === top(want) || (text !== null && got === text) || (text === null && got === null))
                continue;
            } else if (top(got) === top(want)) continue;
            failures.add(
              `${c.col}: top-level value differs from Postgres`,
              `row ${id}: Postgres holds ${show(raw[c.col])}\nexpected ${top(want)}\ngot      ${top(got)}`,
            );
          }
        }
        failures.assertClean(`top-level fidelity (${zone})`, ROWS.length * COLS.length * 0.8);
      });

      /** Compare a nested item row with the top-level row of the same id. */
      function compareNested(
        failures: Failures,
        path: string,
        combo: string,
        nested: Record<string, unknown> | null,
        expectedId: number | null,
      ): void {
        if (expectedId === null) {
          failures.checked();
          if (nested !== null) failures.add(`${path}: expected null`, combo);
          return;
        }
        const base = topRows.get(expectedId) as Record<string, unknown>;
        failures.checked();
        if (nested === null || nested === undefined) {
          failures.add(`${path}: related row missing`, `${combo} id ${expectedId}`);
          return;
        }
        for (const c of COLS) {
          const got = nested[c.field];
          const want = base[c.field];
          if (top(got) !== top(want)) {
            failures.add(
              `${path}: ${c.col} differs from the top-level read`,
              `${combo} id ${expectedId}\ntop-level ${top(want)}\nnested    ${top(got)}`,
            );
            failures.tally(`${c.col} [${combo}]`);
          }
        }
      }

      for (const strategy of STRATEGIES) {
        for (const encoding of ENCODINGS) {
          it(`nested == top-level: relationLoadStrategy ${strategy}, jsonEncoding ${encoding}`, async () => {
            const failures = new Failures(FILE, 2);
            const combo = `${strategy}/${encoding}`;
            const opts = { relationLoadStrategy: strategy, jsonEncoding: encoding };

            try {
              const parents = await db.t(PARENTS).findMany({
                orderBy: { id: 'asc' },
                with: { items: { orderBy: { id: 'asc' } } },
                ...opts,
              });
              for (const p of parents as { id: number; items: Record<string, unknown>[] }[]) {
                for (const item of p.items) compareNested(failures, 'hasMany items', combo, item, item.id as number);
              }
              failures.checked();
              if ((parents as { items: unknown[] }[]).reduce((n, p) => n + p.items.length, 0) !== ROWS.length) {
                failures.add('hasMany items: wrong number of related rows', combo);
              }
            } catch (e) {
              failures.add('hasMany items: threw', `${combo}\n${describeError(e)}`);
            }

            try {
              const items = await db.t(ITEMS).findMany({ orderBy: { id: 'asc' }, with: { prev: true }, ...opts });
              for (const item of items as {
                id: number;
                prevId: number | null;
                prev: Record<string, unknown> | null;
              }[]) {
                compareNested(failures, 'belongsTo prev', combo, item.prev, item.prevId);
              }
            } catch (e) {
              failures.add('belongsTo prev: threw', `${combo}\n${describeError(e)}`);
            }

            try {
              const streamed: { id: number; items: Record<string, unknown>[] }[] = [];
              for await (const p of db
                .t(PARENTS)
                .findManyStream({ orderBy: { id: 'asc' }, with: { items: { orderBy: { id: 'asc' } } }, ...opts })) {
                streamed.push(p as (typeof streamed)[number]);
              }
              for (const p of streamed)
                for (const item of p.items)
                  compareNested(failures, 'stream hasMany items', combo, item, item.id as number);
            } catch (e) {
              failures.add('stream hasMany items: threw', `${combo}\n${describeError(e)}`);
            }

            failures.assertClean(`nested fidelity (${zone}, ${combo})`, ROWS.length * 2);
          });
        }
      }
    });
  }
});
