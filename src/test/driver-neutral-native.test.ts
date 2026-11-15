import assert from 'node:assert/strict';
import { describe } from 'node:test';
import pg from 'pg';
import { TurbineClient } from '../client.js';
import { turbineCore } from '../core.js';
import { createUtcTimestampParser } from '../query/temporal-parsers.js';
import type { SchemaMetadata } from '../schema.js';
import { mockTable, skipGate } from './helpers.js';

const DATABASE_URL = process.env.DATABASE_URL;
const { it, before, after } = skipGate(
  !DATABASE_URL,
  'DATABASE_URL not set (native PostgreSQL supplied-transport contract)',
);
const schema: SchemaMetadata = {
  tables: {
    neutral_items: mockTable('neutral_items', [
      { name: 'id', field: 'id' },
      { name: 'label', field: 'label', pgType: 'text' },
      { name: 'tenant_id', field: 'tenantId' },
      { name: 'created_at', field: 'createdAt', pgType: 'timestamp' },
    ]),
  },
  enums: {},
};

describe('native PostgreSQL supplied transport and default client compatibility', () => {
  let pool: pg.Pool;
  before(async () => {
    pool = new pg.Pool({
      connectionString: DATABASE_URL,
      max: 3,
      types: {
        getTypeParser(oid, format) {
          const base = pg.types.getTypeParser(oid, format);
          return oid === 1114 && format !== 'binary' ? createUtcTimestampParser(base) : base;
        },
      },
    });
    await pool.query(
      'CREATE TABLE neutral_items (id integer PRIMARY KEY, label text NOT NULL, tenant_id integer NOT NULL, created_at timestamp NOT NULL)',
    );
  });
  after(async () => {
    if (pool) {
      try {
        await pool.query('DROP TABLE IF EXISTS neutral_items');
      } finally {
        await pool.end();
      }
    }
  });

  it('executes ordered writes, reads, global filters and effects on an actual supplied pg.Pool', async () => {
    const db = turbineCore(pool, schema, { globalFilters: { neutral_items: { tenantId: 7 } }, warnOnUnlimited: false });
    const items = db.table<{ id: number; label: string; tenantId: number; createdAt: Date }>('neutral_items');
    const instant = new Date('2026-01-02T03:04:05.000Z');
    assert.deepEqual(await items.create({ data: { id: 2, label: 'two', tenantId: 7, createdAt: instant } }), {
      id: 2,
      label: 'two',
      tenantId: 7,
      createdAt: instant,
    });
    await items.create({ data: { id: 1, label: 'one', tenantId: 7, createdAt: instant } });
    await pool.query('INSERT INTO neutral_items VALUES (3, $1, 8, $2)', ['hidden', instant]);
    assert.deepEqual(await items.findMany({ orderBy: { id: 'asc' }, select: { id: true, label: true } }), [
      { id: 1, label: 'one' },
      { id: 2, label: 'two' },
    ]);
    assert.deepEqual(
      await items.update({ where: { id: 2 }, data: { label: 'updated' }, select: { id: true, label: true } }),
      { id: 2, label: 'updated' },
    );
    assert.equal(await items.count(), 2);
    await assert.rejects(items.create({ data: { id: 2, label: 'duplicate', tenantId: 7, createdAt: instant } }), {
      code: 'TURBINE_E008',
    });
    assert.deepEqual(await db.raw<{ label: string }>`SELECT label FROM neutral_items WHERE id = ${2}`, [
      { label: 'updated' },
    ]);
    assert.deepEqual(await items.deleteMany({ where: { id: 2 } }), { count: 1 });
    assert.deepEqual((await pool.query('SELECT id, label FROM neutral_items ORDER BY id')).rows, [
      { id: 1, label: 'one' },
      { id: 3, label: 'hidden' },
    ]);
    await db.disconnect();
    assert.equal((await pool.query('SELECT 1 AS still_open')).rows[0]?.still_open, 1);
  });

  it('retains synchronous PostgreSQL pool construction, parser readings and transaction rollback', async () => {
    const db = new TurbineClient({ connectionString: DATABASE_URL, max: 2 }, schema);
    try {
      assert.ok(db instanceof TurbineClient);
      assert.ok(db.pool instanceof pg.Pool);
      const rows = await db.raw<{
        small: number;
        large: string;
        amount: string;
        day: Date;
        stamp: Date;
      }>`SELECT 42::int8 AS small, 9007199254740993::int8 AS large, 1.25::numeric AS amount, DATE '2026-01-02' AS day, TIMESTAMP '2026-01-02 03:04:05' AS stamp`;
      assert.deepEqual(rows, [
        {
          small: 42,
          large: '9007199254740993',
          amount: '1.25',
          day: new Date('2026-01-02T00:00:00Z'),
          stamp: new Date('2026-01-02T03:04:05Z'),
        },
      ]);
      await assert.rejects(
        db.$transaction(async (tx) => {
          await tx.raw`UPDATE neutral_items SET label = ${'rolled back'} WHERE id = ${1}`;
          throw new Error('rollback boundary');
        }),
        /rollback boundary/,
      );
      assert.deepEqual((await pool.query('SELECT id, label FROM neutral_items ORDER BY id')).rows, [
        { id: 1, label: 'one' },
        { id: 3, label: 'hidden' },
      ]);
      assert.equal(db.stats.idleCount, 1);
      await db.$transaction(async (tx) => {
        await tx.raw`UPDATE neutral_items SET label = ${'committed'} WHERE id = ${1}`;
        await assert.rejects(
          tx.$transaction(async (inner) => {
            await inner.raw`UPDATE neutral_items SET label = ${'savepoint rollback'} WHERE id = ${1}`;
            throw new Error('savepoint boundary');
          }),
          /savepoint boundary/,
        );
      });
      assert.deepEqual((await pool.query('SELECT id, label FROM neutral_items ORDER BY id')).rows, [
        { id: 1, label: 'committed' },
        { id: 3, label: 'hidden' },
      ]);
    } finally {
      await db.disconnect();
    }
  });
});
