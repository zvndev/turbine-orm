/**
 * turbine-orm, two columns that resolve to one TypeScript field
 *
 * Introspection derives each column's field name with `snakeToCamel`, so a
 * table carrying both a quoted `"createdAt"` and a `created_at` column yields
 * two columns named `createdAt`. Nothing refused that: `types.ts` carried a
 * duplicate interface member (TS2300 in the consumer's build), `columnMap` kept
 * whichever column was written last, and every read folded both columns into
 * one property while every write to the field landed in the OTHER column, with
 * no error anywhere.
 *
 * The rule now lives in one place, `assertDistinctColumnFields` in
 * introspect.ts, applied once per table right after the columns are grouped.
 * A collision is a ValidationError (E003) naming the table, every colliding
 * column, and the escape hatch (`keepColumnNames`, under which the field IS the
 * raw column name and two distinct columns cannot collide). `generate*` runs
 * the same check through `assertEmittableSchema`, so a hand-built or
 * engine-introspected schema with the same defect is refused at the emitter
 * rather than producing an uncompilable file.
 *
 * Unit half: pure, no database. Live half (DATABASE_URL-gated): the real
 * catalog path, the exact `"createdAt"` + `created_at` shape, under both flag
 * values.
 *
 * Run: npx tsx --test src/test/generate-field-collision.test.ts
 */

import assert from 'node:assert/strict';
import { describe } from 'node:test';
import pg from 'pg';
import { TurbineErrorCode, ValidationError } from '../errors.js';
import { generateIndex, generateMetadata, generateTypes } from '../generate.js';
import { assertDistinctColumnFields, introspect } from '../introspect.js';
import type { ColumnMetadata, SchemaMetadata, TableMetadata } from '../schema.js';
import { skipGate } from './helpers.js';

function col(name: string, field: string): ColumnMetadata {
  return {
    name,
    field,
    pgType: 'timestamptz',
    tsType: 'Date',
    nullable: false,
    hasDefault: false,
    isArray: false,
    pgArrayType: 'timestamptz[]',
  };
}

function table(name: string, columns: ColumnMetadata[]): TableMetadata {
  const columnMap: Record<string, string> = {};
  const reverseColumnMap: Record<string, string> = {};
  const pgTypes: Record<string, string> = {};
  for (const c of columns) {
    columnMap[c.field] = c.name;
    reverseColumnMap[c.name] = c.field;
    pgTypes[c.name] = c.pgType;
  }
  return {
    name,
    columns,
    columnMap,
    reverseColumnMap,
    dateColumns: new Set<string>(),
    pgTypes,
    allColumns: columns.map((c) => c.name),
    primaryKey: [],
    uniqueColumns: [],
    indexes: [],
    isView: false,
    relations: {},
  };
}

const COLLIDING = table('order', [col('id', 'id'), col('createdAt', 'createdAt'), col('created_at', 'createdAt')]);
const DISTINCT = table('order', [col('id', 'id'), col('createdAt', 'createdAt'), col('created_at', 'created_at')]);

/** Assert `fn` throws the field-collision E003 and return the message. */
function expectCollision(fn: () => unknown, columns: string[], tableName: string): string {
  let caught: unknown;
  try {
    fn();
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof ValidationError, `expected a ValidationError, got ${String(caught)}`);
  assert.equal(caught.code, TurbineErrorCode.VALIDATION);
  assert.match(caught.message, new RegExp(`table "${tableName}"`), 'names the table');
  for (const c of columns) assert.match(caught.message, new RegExp(`"${c}"`), `names column "${c}"`);
  assert.match(caught.message, /keepColumnNames/, 'names the escape hatch');
  return caught.message;
}

describe('assertDistinctColumnFields (pure)', () => {
  const { it } = skipGate(false, '');

  it('two columns on one field throw E003 naming the table, both columns and the fix', () => {
    const message = expectCollision(
      () => assertDistinctColumnFields(COLLIDING.name, COLLIDING.columns),
      ['createdAt', 'created_at'],
      'order',
    );
    assert.match(message, /field "createdAt"/, 'names the shared field');
  });

  it('three columns on one field are all named', () => {
    const three = table('t', [
      col('created_at', 'createdAt'),
      col('createdAt', 'createdAt'),
      col('CREATED_AT', 'createdAt'),
    ]);
    expectCollision(
      () => assertDistinctColumnFields(three.name, three.columns),
      ['created_at', 'createdAt', 'CREATED_AT'],
      't',
    );
  });

  it('two collision groups on one table are both reported', () => {
    const two = table('t', [
      col('created_at', 'createdAt'),
      col('createdAt', 'createdAt'),
      col('updated_at', 'updatedAt'),
      col('updatedAt', 'updatedAt'),
    ]);
    const message = expectCollision(
      () => assertDistinctColumnFields(two.name, two.columns),
      ['created_at', 'createdAt', 'updated_at', 'updatedAt'],
      't',
    );
    assert.match(message, /field "createdAt"/);
    assert.match(message, /field "updatedAt"/);
  });

  it('distinct fields pass, including the raw-name shape keepColumnNames produces', () => {
    assert.doesNotThrow(() => assertDistinctColumnFields(DISTINCT.name, DISTINCT.columns));
    assert.doesNotThrow(() => assertDistinctColumnFields('empty', []));
  });
});

describe('generate* refuses a schema whose table carries a field collision', () => {
  const { it } = skipGate(false, '');
  const colliding: SchemaMetadata = { enums: {}, tables: { order: COLLIDING } };
  const distinct: SchemaMetadata = { enums: {}, tables: { order: DISTINCT } };

  it('generateTypes never emits a duplicate interface member', () => {
    expectCollision(() => generateTypes(colliding, { noTimestamp: true }), ['createdAt', 'created_at'], 'order');
  });

  it('generateMetadata and generateIndex refuse the same schema', () => {
    expectCollision(() => generateMetadata(colliding, { noTimestamp: true }), ['createdAt', 'created_at'], 'order');
    expectCollision(() => generateIndex(colliding, { noTimestamp: true }), ['createdAt', 'created_at'], 'order');
  });

  it('a distinct-field schema generates, with one member per column', () => {
    const types = generateTypes(distinct, { noTimestamp: true });
    const entity = types.match(/export interface Order \{\n([\s\S]*?)\n\}/);
    assert.ok(entity, types);
    assert.equal((entity[1]!.match(/^ {2}createdAt: /gm) ?? []).length, 1);
    assert.equal((entity[1]!.match(/^ {2}created_at: /gm) ?? []).length, 1);
  });
});

// ---------------------------------------------------------------------------
// Live catalog: the exact shape that produced the duplicate member.
// ---------------------------------------------------------------------------

const DATABASE_URL = process.env.DATABASE_URL;
const live = skipGate(!DATABASE_URL, 'requires DATABASE_URL');

/** Unique-per-run schema so a leftover from a crashed run never collides. */
const LIVE_SCHEMA = `qa78_fc_${process.pid}_${Date.now().toString(36)}`;

const SETUP_SQL = `
  CREATE SCHEMA ${LIVE_SCHEMA};
  CREATE TABLE ${LIVE_SCHEMA}.qa78_orders (
    id serial PRIMARY KEY,
    "createdAt" timestamptz NOT NULL DEFAULT now(),
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE ${LIVE_SCHEMA}.qa78_clean (
    id serial PRIMARY KEY,
    created_at timestamptz NOT NULL DEFAULT now()
  );
`;

describe('introspect (live catalog): a field collision is refused, keepColumnNames resolves it', () => {
  let pool: pg.Pool;

  live.before(async () => {
    pool = new pg.Pool({ connectionString: DATABASE_URL!, max: 1 });
    await pool.query(SETUP_SQL);
  });

  live.after(async () => {
    if (!pool) return;
    await pool.query(`DROP SCHEMA IF EXISTS ${LIVE_SCHEMA} CASCADE`);
    await pool.end();
  });

  live.it('"createdAt" + created_at on one table rejects with E003 naming both columns', async () => {
    await assert.rejects(introspect({ connectionString: DATABASE_URL!, schema: LIVE_SCHEMA }), (err: unknown) => {
      assert.ok(err instanceof ValidationError, `expected ValidationError, got ${String(err)}`);
      assert.equal(err.code, TurbineErrorCode.VALIDATION);
      assert.match(err.message, /table "qa78_orders"/);
      assert.match(err.message, /"createdAt"/);
      assert.match(err.message, /"created_at"/);
      assert.match(err.message, /keepColumnNames/);
      return true;
    });
  });

  live.it('keepColumnNames: true introspects the same schema with one field per column', async () => {
    const schema = await introspect({ connectionString: DATABASE_URL!, schema: LIVE_SCHEMA, keepColumnNames: true });
    const orders = schema.tables.qa78_orders;
    assert.ok(orders, Object.keys(schema.tables).join(', '));
    assert.deepEqual(
      orders.columns.map((c) => [c.name, c.field]),
      [
        ['id', 'id'],
        ['createdAt', 'createdAt'],
        ['created_at', 'created_at'],
      ],
    );
    assert.deepEqual(orders.columnMap, { id: 'id', createdAt: 'createdAt', created_at: 'created_at' });
    // The generated types carry one member per column and typecheck-clean names.
    const types = generateTypes(schema, { noTimestamp: true });
    const entity = types.match(/export interface Qa78Order \{\n([\s\S]*?)\n\}/);
    assert.ok(entity, types);
    assert.equal((entity[1]!.match(/^ {2}createdAt: /gm) ?? []).length, 1);
    assert.equal((entity[1]!.match(/^ {2}created_at: /gm) ?? []).length, 1);
    // The table without a collision is untouched by the flag except for the
    // raw field name, which for snake_case columns is the only visible change.
    assert.deepEqual(schema.tables.qa78_clean?.columnMap, { id: 'id', created_at: 'created_at' });
  });
});
