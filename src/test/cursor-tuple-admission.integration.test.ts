import assert from 'node:assert/strict';
import { describe } from 'node:test';
import pg from 'pg';
import { introspect } from '../introspect.js';
import { QueryInterface } from '../query/builder.js';
import { quoteIdent } from '../query/utils.js';
import type { SchemaMetadata } from '../schema.js';
import { skipGate } from './helpers.js';

const url = process.env.DATABASE_URL;
const { before, after, it } = skipGate(!url, 'DATABASE_URL not set');
const namespace = `qa_tuple_admission_${process.pid}`;
const ns = quoteIdent(namespace);
let pool: pg.Pool;
let metadata: SchemaMetadata;

describe('tuple admission from the PostgreSQL catalog', () => {
  before(async () => {
    pool = new pg.Pool({ connectionString: url, max: 1 });
    await pool.query(`CREATE SCHEMA ${ns}`);
    await pool.query(`
      CREATE TABLE ${ns}.expression_items(sort_key int NOT NULL, token text NOT NULL);
      CREATE UNIQUE INDEX expression_unique ON ${ns}.expression_items(sort_key, lower(token));
      INSERT INTO ${ns}.expression_items VALUES(1,'a'),(1,'b'),(2,'c');
      CREATE TYPE ${ns}."text" AS ENUM ('z','a','m');
      CREATE TABLE ${ns}.enum_items(id int PRIMARY KEY, sort_key ${ns}."text" NOT NULL);
      INSERT INTO ${ns}.enum_items VALUES(1,'z'),(2,'a'),(3,'a'),(4,'m');
      CREATE TABLE ${ns}.constraint_items(sort_key int NOT NULL, other_key int NOT NULL, UNIQUE(sort_key,other_key));
    `);
    metadata = await introspect({ connectionString: url!, schema: namespace });
  });
  after(async () => {
    if (pool) {
      try {
        await pool.query(`DROP SCHEMA IF EXISTS ${ns} CASCADE`);
      } finally {
        await pool.end();
      }
    }
  });

  it('refuses a shortened expression-index key before execution', async () => {
    const rows = await pool.query(`SELECT sort_key,token FROM ${ns}.expression_items ORDER BY sort_key,token`);
    assert.deepEqual(rows.rows, [
      { sort_key: 1, token: 'a' },
      { sort_key: 1, token: 'b' },
      { sort_key: 2, token: 'c' },
    ]);
    assert.deepEqual(metadata.tables.expression_items!.indexes[0]!.columns, ['sort_key']);
    const q = new QueryInterface(pool, 'expression_items', metadata);
    const args = { cursorPredicate: 'tuple' as const, cursor: { sortKey: 1 }, orderBy: { sortKey: 'asc' as const } };
    assert.throws(() => q.buildFindMany(args), { code: 'TURBINE_E017' });
    await assert.rejects(q.findMany(args), { code: 'TURBINE_E017' });
  });

  it('refuses a same-schema enum named like a builtin before execution', async () => {
    assert.deepEqual(metadata.enums.text, ['z', 'a', 'm']);
    const column = metadata.tables.enum_items!.columns.find((c) => c.name === 'sort_key')!;
    assert.equal(column.pgType, 'text');
    assert.equal(column.pgTypeSchema, undefined);
    const q = new QueryInterface(pool, 'enum_items', metadata);
    const args = {
      cursorPredicate: 'tuple' as const,
      cursor: { sortKey: 'a', id: 2 },
      orderBy: { sortKey: 'asc' as const },
    };
    assert.throws(() => q.buildFindMany(args), { code: 'TURBINE_E017' });
    await assert.rejects(q.findMany(args), { code: 'TURBINE_E017' });
  });

  it('keeps a native UNIQUE constraint as an affirmative proof', () => {
    assert.deepEqual(metadata.tables.constraint_items!.uniqueColumns, [['sort_key', 'other_key']]);
    const q = new QueryInterface(pool, 'constraint_items', metadata);
    assert.match(
      q.buildFindMany({
        cursorPredicate: 'tuple',
        cursor: { sortKey: 1, otherKey: 2 },
        orderBy: [{ sortKey: 'asc' }, { otherKey: 'asc' }],
      }).sql,
      /\) > \(/,
    );
  });
});
