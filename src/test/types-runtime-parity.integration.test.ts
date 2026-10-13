/**
 * turbine-orm, generated row types against the values the driver returns
 *
 * Reads one row of every common Postgres type four ways (a top-level row,
 * `join` with the object encoding, `join` with the positional encoding, and
 * `batched`) and checks each JS value against the TypeScript type the
 * generator emits for that column (`columnTsType`, the same function
 * `generateTypes` calls).
 *
 * A mismatch the library cannot fix in the type alone is listed in
 * KNOWN_DIVERGENCES with the read paths it affects. The list is asserted in
 * both directions: an unlisted mismatch fails, and so does a listed one that
 * no longer diverges, so a runtime fix cannot land without the list (and the
 * type, if it was typed around the old value) being revisited.
 *
 * Run: DATABASE_URL=postgres://... npx tsx --test src/test/types-runtime-parity.integration.test.ts
 */

import assert from 'node:assert/strict';
import { describe } from 'node:test';
import pg from 'pg';
import { TurbineClient } from '../client.js';
import { columnTsType } from '../generate.js';
import { introspect } from '../introspect.js';
import type { SchemaMetadata } from '../schema.js';
import { snakeToPascal } from '../schema.js';
import { skipGate } from './helpers.js';

const DATABASE_URL = process.env.DATABASE_URL;
const SKIP = !DATABASE_URL;
if (SKIP) console.log('Skipping generated row type parity tests: DATABASE_URL not set');

const DDL = `
DROP TABLE IF EXISTS tparity_row CASCADE;
DROP TABLE IF EXISTS tparity_owner CASCADE;
DROP TYPE IF EXISTS tparity_mood;
CREATE TYPE tparity_mood AS ENUM ('happy', 'sad');
CREATE TABLE tparity_owner (id SERIAL PRIMARY KEY, name TEXT NOT NULL);
CREATE TABLE tparity_row (
  id SERIAL PRIMARY KEY,
  owner_id INTEGER NOT NULL REFERENCES tparity_owner(id),
  c_int2 SMALLINT, c_int4 INTEGER, c_int8 BIGINT, c_int8_big BIGINT, c_numeric NUMERIC,
  c_real REAL, c_double DOUBLE PRECISION, c_double_inf DOUBLE PRECISION, c_money MONEY, c_oid OID,
  c_bool BOOLEAN, c_text TEXT, c_varchar VARCHAR(9), c_char CHAR(3), c_uuid UUID, c_xml XML,
  c_date DATE, c_ts TIMESTAMP, c_tstz TIMESTAMPTZ, c_time TIME, c_timetz TIMETZ, c_interval INTERVAL,
  c_json JSON, c_jsonb JSONB, c_bytea BYTEA, c_inet INET, c_cidr CIDR, c_macaddr MACADDR, c_macaddr8 MACADDR8,
  c_point POINT, c_line LINE, c_box BOX, c_polygon POLYGON, c_circle CIRCLE,
  c_tsvector TSVECTOR, c_tsquery TSQUERY, c_bit BIT(4), c_varbit VARBIT,
  c_int4range INT4RANGE, c_numrange NUMRANGE, c_tstzrange TSTZRANGE, c_daterange DATERANGE,
  c_int4multirange INT4MULTIRANGE, c_mood tparity_mood,
  a_int4 INTEGER[], a_int8 BIGINT[], a_numeric NUMERIC[], a_double DOUBLE PRECISION[], a_oid OID[],
  a_bool BOOLEAN[], a_text TEXT[], a_uuid UUID[], a_xml XML[], a_date DATE[], a_ts TIMESTAMP[],
  a_tstz TIMESTAMPTZ[], a_time TIME[], a_interval INTERVAL[], a_jsonb JSONB[], a_bytea BYTEA[],
  a_inet INET[], a_macaddr8 MACADDR8[], a_point POINT[], a_circle CIRCLE[], a_box BOX[],
  a_tsvector TSVECTOR[], a_bit BIT(4)[], a_int4range INT4RANGE[], a_mood tparity_mood[]
);
INSERT INTO tparity_owner (name) VALUES ('owner');
INSERT INTO tparity_row VALUES (
  DEFAULT, 1,
  1, 2, 42, 9007199254740993, 1.10,
  1.5, 2.25, 'Infinity', '$1.00', 42,
  true, 't', 'v', 'abc', 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', '<a/>',
  '2024-03-10', '2024-03-10 12:34:56', '2024-03-10 12:34:56+00', '09:00:00', '09:00:00+02', '1 day 02:03:04',
  '{"a":1}', '{"b":[1,2]}', '\\xdeadbeef', '10.0.0.1', '10.0.0.0/8', '08:00:2b:01:02:03', '08:00:2b:01:02:03:04:05',
  '(1,2)', '{1,2,3}', '(1,1),(0,0)', '((0,0),(1,1),(1,0))', '<(1,2),3>',
  'a fat cat', 'fat & cat', B'1010', B'101',
  '[1,5)', '[1.5,2.5)', '[2024-01-01Z,2024-02-01Z)', '[2024-01-01,2024-02-01)',
  '{[1,3)}', 'happy',
  '{1,2}', '{5,6}', '{1.10,2.20}', '{2.5}', '{42}',
  '{t,f}', '{a,b}', '{a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11}', ARRAY['<a/>'::xml], '{2024-01-01}', '{2024-01-01 00:00:00}',
  '{2024-01-01 00:00:00+00}', '{09:00:00}', '{1 day,2 hours}', ARRAY['{"x":1}'::jsonb], ARRAY['\\xdead'::bytea],
  '{10.0.0.1}', '{08:00:2b:01:02:03:04:05}', '{"(1,2)"}', '{"<(1,2),3>"}', ARRAY['(1,1),(0,0)'::box],
  ARRAY['a cat'::tsvector], ARRAY[B'1010'], ARRAY['[1,5)'::int4range], '{happy,sad}'
);
`;

type ReadPath = 'top' | 'joinObject' | 'joinPositional' | 'batched';
const READ_PATHS: readonly ReadPath[] = ['top', 'joinObject', 'joinPositional', 'batched'];
const TOP_AND_BATCHED: readonly ReadPath[] = ['top', 'batched'];
const NESTED_JOIN: readonly ReadPath[] = ['joinObject', 'joinPositional'];

/**
 * Columns whose runtime value does not match the generated type, by read path.
 * Each entry names the runtime behavior that a fix would change; none of them
 * can be fixed by changing the type, because the read paths disagree with each
 * other or the type is the documented contract.
 */
const KNOWN_DIVERGENCES: Readonly<Record<string, { paths: readonly ReadPath[]; why: string }>> = {
  c_int8_big: {
    paths: READ_PATHS,
    why: 'a bigint above Number.MAX_SAFE_INTEGER reads as its decimal string (documented on the int8 parser)',
  },
  c_oid: { paths: NESTED_JOIN, why: 'oid is not in JSON_WIRE_COERCION_OIDS, so the join paths read its text' },
  a_oid: { paths: NESTED_JOIN, why: 'oid[] is not in JSON_WIRE_COERCION_OIDS, so the join paths read text' },
  a_numeric: { paths: READ_PATHS, why: "the driver's numeric[] parser returns floats, typed string[] (exact)" },
  a_xml: { paths: TOP_AND_BATCHED, why: 'the driver has no xml[] parser, so the array arrives as one string' },
  a_macaddr8: { paths: TOP_AND_BATCHED, why: 'the driver has no macaddr8[] parser' },
  a_circle: { paths: TOP_AND_BATCHED, why: 'the driver has no circle[] parser' },
  a_box: { paths: TOP_AND_BATCHED, why: 'the driver has no box[] parser' },
  a_tsvector: { paths: TOP_AND_BATCHED, why: 'the driver has no tsvector[] parser' },
  a_bit: { paths: TOP_AND_BATCHED, why: 'the driver has no bit[] parser' },
  a_int4range: { paths: TOP_AND_BATCHED, why: 'the driver has no range array parser' },
};

/** Split `text` on `sep` at bracket depth zero. */
function splitTop(text: string, sep: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote = false;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "'") quote = !quote;
    if (quote) continue;
    if (ch === '{' || ch === '(' || ch === '[' || ch === '<') depth++;
    else if (ch === '}' || ch === ')' || ch === ']' || ch === '>') depth--;
    else if (depth === 0 && text.startsWith(sep, i)) {
      parts.push(text.slice(start, i).trim());
      start = i + sep.length;
    }
  }
  parts.push(text.slice(start).trim());
  return parts.filter((part) => part.length > 0);
}

/**
 * Whether `value` is a member of the TypeScript type `type`, for the subset of
 * type syntax the generator emits for a column: primitives, `Date`, `Buffer`,
 * `unknown`, `T[]`, `(A | B)[]`, unions, object literals of optional or
 * required number fields, string literals and enum type names.
 */
function matchesType(type: string, value: unknown, enums: Readonly<Record<string, readonly string[]>>): boolean {
  const members = splitTop(type, '|');
  if (members.length > 1) return members.some((member) => matchesType(member, value, enums));
  const t = type.trim();
  if (t === 'unknown') return true;
  if (t === 'null') return value === null;
  if (t === 'number') return typeof value === 'number';
  if (t === 'string') return typeof value === 'string';
  if (t === 'boolean') return typeof value === 'boolean';
  if (t === 'Date') return value instanceof Date;
  if (t === 'Buffer') return Buffer.isBuffer(value);
  if (t.endsWith('[]')) {
    let element = t.slice(0, -2).trim();
    if (element.startsWith('(') && element.endsWith(')')) element = element.slice(1, -1);
    return Array.isArray(value) && value.every((item) => matchesType(element, item, enums));
  }
  if (t.startsWith("'") && t.endsWith("'")) return value === t.slice(1, -1);
  if (t.startsWith('{') && t.endsWith('}')) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
    const fields = splitTop(t.slice(1, -1), ';').map((field) => {
      const [rawName = '', rawType = ''] = field.split(':');
      return { name: rawName.replace('?', '').trim(), optional: rawName.includes('?'), type: rawType.trim() };
    });
    const record = value as Record<string, unknown>;
    const known = new Set(fields.map((field) => field.name));
    if (Object.keys(record).some((key) => !known.has(key))) return false;
    return fields.every((field) =>
      record[field.name] === undefined ? field.optional : matchesType(field.type, record[field.name], enums),
    );
  }
  const enumValues = enums[t];
  if (enumValues) return typeof value === 'string' && enumValues.includes(value);
  throw new Error(`matchesType: no rule for the type ${JSON.stringify(t)}`);
}

function describeValue(value: unknown): string {
  if (value === null) return 'null';
  if (value instanceof Date) return 'Date';
  if (Buffer.isBuffer(value)) return 'Buffer';
  if (Array.isArray(value)) return `[${value.map(describeValue).join(', ')}]`;
  if (typeof value === 'object') return `{${Object.keys(value as object).join(', ')}}`;
  return `${typeof value} ${JSON.stringify(value)}`;
}

const { it, before, after } = skipGate(SKIP, 'DATABASE_URL not set');

describe('types: generated row types match the values each read path returns', () => {
  let setup: pg.Pool;
  let schema: SchemaMetadata;
  let db: TurbineClient;
  const rows = new Map<ReadPath, Record<string, unknown>>();

  before(async () => {
    setup = new pg.Pool({ connectionString: DATABASE_URL, max: 1 });
    await setup.query(DDL);
    schema = await introspect({ connectionString: DATABASE_URL as string, include: ['tparity_owner', 'tparity_row'] });
    db = new TurbineClient({ connectionString: DATABASE_URL, warnOnUnlimited: false }, schema);
    // biome-ignore lint/suspicious/noExplicitAny: an introspected client has no generated accessor types
    const client = db as any;
    const relation = Object.keys(schema.tables.tparity_owner?.relations ?? {})[0] as string;
    const nested = async (args: Record<string, unknown>) => {
      const [owner] = await client.tparityOwner.findMany({ with: { [relation]: true }, ...args });
      return owner[relation][0] as Record<string, unknown>;
    };
    rows.set('top', (await client.tparityRow.findMany())[0]);
    rows.set('joinObject', await nested({ relationLoadStrategy: 'join', jsonEncoding: 'object' }));
    rows.set('joinPositional', await nested({ relationLoadStrategy: 'join', jsonEncoding: 'positional' }));
    rows.set('batched', await nested({ relationLoadStrategy: 'batched' }));
  });

  after(async () => {
    await db?.disconnect();
    await setup?.query('DROP TABLE IF EXISTS tparity_row, tparity_owner CASCADE; DROP TYPE IF EXISTS tparity_mood;');
    await setup?.end();
  });

  it('every column matches its generated type on every read path, except the listed divergences', () => {
    const table = schema.tables.tparity_row;
    assert.ok(table, 'tparity_row was introspected');
    const enums: Record<string, readonly string[]> = {};
    for (const [name, values] of Object.entries(schema.enums)) enums[snakeToPascal(name)] = values;

    const unexpected: string[] = [];
    const stale: string[] = [];
    let checked = 0;
    for (const column of table.columns) {
      const type = columnTsType(column, schema.enums);
      const listed = KNOWN_DIVERGENCES[column.name];
      for (const path of READ_PATHS) {
        const value = rows.get(path)?.[column.field];
        assert.notEqual(value, undefined, `${column.name} is missing from the ${path} row`);
        assert.notEqual(value, null, `${column.name} read as null on ${path}: the fixture must fill every column`);
        checked++;
        const ok = matchesType(type, value, enums);
        const expectedToDiverge = listed?.paths.includes(path) ?? false;
        if (!ok && !expectedToDiverge)
          unexpected.push(`${column.name} (${path}): typed ${type}, read ${describeValue(value)}`);
        if (ok && expectedToDiverge)
          stale.push(`${column.name} (${path}): now matches ${type}; listed as "${listed?.why}"`);
      }
    }
    // Anti-vacuous: every column on every path was looked at.
    assert.equal(checked, table.columns.length * READ_PATHS.length);
    assert.ok(table.columns.length >= 60, `expected the full fixture, got ${table.columns.length} columns`);
    assert.deepEqual(unexpected, [], 'a generated type does not match the runtime value');
    assert.deepEqual(stale, [], 'a known divergence no longer diverges: update KNOWN_DIVERGENCES (and the type)');
  });

  it('lists only columns the fixture has', () => {
    const names = new Set(schema.tables.tparity_row?.columns.map((column) => column.name));
    for (const name of Object.keys(KNOWN_DIVERGENCES)) assert.ok(names.has(name), `${name} is not a fixture column`);
  });
});
