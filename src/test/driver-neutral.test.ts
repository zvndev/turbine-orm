import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { turbineCore } from '../core.js';
import { TimeoutError, UnsupportedFeatureError, ValidationError } from '../errors.js';
import type { PgCompatPool, PgCompatQueryResult } from '../pg-types.js';
import type { SchemaMetadata } from '../schema.js';
import { registeredTransactionClient } from '../transaction-client-slot.js';
import { mockTable } from './helpers.js';

const schema: SchemaMetadata = {
  tables: {
    items: mockTable(
      'items',
      [
        { name: 'id', field: 'id' },
        { name: 'label', field: 'label', pgType: 'text' },
        { name: 'tenant_id', field: 'tenantId' },
      ],
      {
        children: {
          name: 'children',
          type: 'hasMany',
          from: 'items',
          to: 'children',
          foreignKey: 'item_id',
          referenceKey: 'id',
        },
      },
    ),
    children: mockTable('children', [
      { name: 'id', field: 'id' },
      { name: 'item_id', field: 'itemId' },
    ]),
  },
  enums: {},
};

function harness() {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  let ends = 0;
  let connects = 0;
  let reply: PgCompatQueryResult = { rows: [{ id: 2, label: 'second', tenant_id: 8 }], rowCount: 1 };
  let run: (() => Promise<PgCompatQueryResult>) | undefined;
  const pool: PgCompatPool = {
    async query<R>(text: string, values: unknown[] = []) {
      calls.push({ text, values });
      return (run ? await run() : reply) as PgCompatQueryResult<R>;
    },
    async connect() {
      connects++;
      throw new Error('unexpected checkout');
    },
    async end() {
      ends++;
    },
  };
  return {
    pool,
    calls,
    ends: () => ends,
    connects: () => connects,
    reply: (value: PgCompatQueryResult) => {
      reply = value;
    },
    run: (value: typeof run) => {
      run = value;
    },
  };
}

const refusal = (error: unknown) => error instanceof UnsupportedFeatureError && error.code === 'TURBINE_E017';

describe('supplied-transport query client', () => {
  it('imports without filling the module-copy TransactionClient registration slot', () => {
    assert.equal(registeredTransactionClient(), undefined);
  });

  it('uses existing table parsers, global filters, parameter order and typed SQL', async () => {
    const h = harness();
    const db = turbineCore(h.pool, schema, { globalFilters: { items: { tenantId: 8 } }, warnOnUnlimited: false });
    const items = db.table<{ id: number; label: string; tenantId: number }>('items');
    assert.equal(items, db.table('items'));
    assert.deepEqual(await items.findMany({ where: { label: 'second' }, orderBy: { id: 'desc' }, limit: 2 }), [
      { id: 2, label: 'second', tenantId: 8 },
    ]);
    assert.deepEqual(h.calls[0]?.values, ['second', 8, 2]);
    assert.match(h.calls[0]!.text, /WHERE.*label.*tenant_id/s);
    assert.match(h.calls[0]!.text, /ORDER BY.*id.*DESC.*LIMIT \$3/s);
    h.reply({ rows: [{ answer: 7 }], rowCount: 1 });
    assert.equal(await db.sql<{ answer: number }>`SELECT ${7} AS answer`.scalar(), 7);
    assert.deepEqual(h.calls[1], { text: 'SELECT $1 AS answer', values: [7] });
    assert.deepEqual(await db.raw<{ answer: number }>`SELECT ${8} AS answer`, [{ answer: 7 }]);
    assert.deepEqual(h.calls[2], { text: 'SELECT $1 AS answer', values: [8] });
    await db.disconnect();
    assert.equal(h.ends(), 0);
  });

  it('keeps middleware and construction-time global-filter validation', async () => {
    const h = harness();
    assert.throws(() => turbineCore(h.pool, schema, { globalFilters: { missing: { id: 1 } } }), ValidationError);
    const db = turbineCore(h.pool, schema, { warnOnUnlimited: false });
    const order: string[] = [];
    db.$use(async (params, next) => {
      order.push(`${params.model}.${params.action}:before`);
      const result = await next(params);
      order.push('after');
      return result;
    });
    await db.table('items').findMany({ limit: 1 });
    assert.deepEqual(order, ['items.findMany:before', 'after']);
    await db.end();
  });

  it('refuses every pinned API, nested write, lookup-first upsert, lock and stream before dispatch', async () => {
    const h = harness();
    const db = turbineCore(h.pool, schema);
    let callbacks = 0;
    for (const name of [
      '$transaction',
      'transaction',
      '$withSession',
      '$connection',
      '$listen',
      '$notify',
      'pipeline',
    ] as const) {
      assert.throws(
        () =>
          db[name](() => {
            callbacks++;
          }),
        refusal,
      );
    }
    const items = db.table('items');
    assert.throws(() => items.create({ data: { children: { create: [{ id: 1 }] } } } as never), refusal);
    assert.throws(
      () => items.upsert({ where: { id: 1 }, create: { label: 'new' }, update: { label: 'old' } } as never),
      refusal,
    );
    await assert.rejects(items.findMany({ lock: 'update' } as never), refusal);
    for (const stream of [items.findManyStream(), items.findManyStreamBatches()])
      await assert.rejects(stream.next(), refusal);
    for (const text of ['BEGIN', 'SELECT 1; COMMIT', 'SAVEPOINT x', 'ROLLBACK', 'SET TRANSACTION READ ONLY'])
      await assert.rejects(db.rawUnsafe(text), refusal);
    assert.equal(callbacks, 0);
    assert.deepEqual(h.calls, []);
    assert.equal(h.connects(), 0);
    await db.end();
  });

  it('requires explicit PostgreSQL wire decoders without borrowing a loaded native runtime', async () => {
    const h = harness();
    h.reply({ rows: [{ id: 2, label: 'second', tenant_id: 8, children: [{ id: '4', itemId: '2' }] }], rowCount: 1 });
    const db = turbineCore(h.pool, schema, { warnOnUnlimited: false });
    await assert.rejects(db.table('items').findMany({ with: { children: true }, limit: 1 }), refusal);
    const lookups: Array<[number, string]> = [];
    const parsed = turbineCore(h.pool, schema, {
      warnOnUnlimited: false,
      getTypeParser: (oid, format) => {
        lookups.push([oid, format]);
        return (value) => Number(value);
      },
    });
    assert.deepEqual(await parsed.table('items').findMany({ with: { children: true }, limit: 1 }), [
      { id: 2, label: 'second', tenantId: 8, children: [{ id: 4, itemId: 2 }] },
    ]);
    assert.deepEqual(lookups, [
      [20, 'text'],
      [20, 'text'],
    ]);
    assert.equal(registeredTransactionClient(), undefined);
    assert.throws(() => turbineCore(h.pool, schema, { ownership: 'invalid' as never }), ValidationError);
    assert.throws(() => turbineCore({} as never, schema), ValidationError);
    await db.end();
    await parsed.end();
  });

  it('reports a noncancelable timeout as unknown and drains the outstanding operation', async () => {
    const h = harness();
    let settle!: (value: PgCompatQueryResult) => void;
    h.run(
      () =>
        new Promise((resolve) => {
          settle = resolve;
        }),
    );
    const db = turbineCore(h.pool, schema, { ownership: 'client', warnOnUnlimited: false });
    await assert.rejects(
      db.table('items').findMany({ timeout: 5, limit: 1 }),
      (error) => error instanceof TimeoutError && error.outcome === 'unknown',
    );
    assert.equal(h.calls.length, 1);
    assert.equal(h.connects(), 0);
    const close = db.disconnect();
    assert.equal(h.ends(), 0);
    settle({ rows: [], rowCount: 0 });
    await close;
    assert.equal(h.ends(), 1);
  });

  it('seals cached and lazy handles immediately, drains work and ends a client-owned pool exactly once', async () => {
    const h = harness();
    let settle!: (value: PgCompatQueryResult) => void;
    h.run(
      () =>
        new Promise((resolve) => {
          settle = resolve;
        }),
    );
    const db = turbineCore(h.pool, schema, { ownership: 'client' });
    const cached = db.table('items');
    const lazy = db.sql`SELECT 2`;
    const operation = db.rawUnsafe('SELECT 1');
    await Promise.resolve();
    const close = db.disconnect();
    assert.equal(db.end(), close);
    assert.equal(h.ends(), 0);
    assert.throws(() => cached.findMany(), ValidationError);
    await assert.rejects(Promise.resolve(lazy), ValidationError);
    assert.throws(() => db.table('items'), ValidationError);
    settle({ rows: [{ value: 1 }], rowCount: 1 });
    assert.deepEqual(await operation, [{ value: 1 }]);
    await close;
    assert.equal(h.ends(), 1);
    assert.deepEqual(h.calls, [{ text: 'SELECT 1', values: [] }]);
  });

  it('drains failed work, preserves typed failures and retains a single close failure', async () => {
    const h = harness();
    h.run(async () => {
      throw Object.assign(new Error('duplicate'), { code: '23505', constraint: 'items_pkey' });
    });
    const db = turbineCore(h.pool, schema, { ownership: 'client' });
    await assert.rejects(db.rawUnsafe('INSERT INTO items VALUES ($1)', 1), { code: 'TURBINE_E008' });
    await db.disconnect();
    assert.equal(h.ends(), 1);
    const broken = harness();
    const failure = new Error('end failed');
    broken.pool.end = async () => {
      throw failure;
    };
    const other = turbineCore(broken.pool, schema, { ownership: 'client' });
    const close = other.disconnect();
    await assert.rejects(close, (error) => error === failure);
    assert.equal(other.disconnect(), close);
  });
});

describe('stateless native PostgreSQL whitespace boundary', () => {
  it('refuses every ASCII SQL whitespace prefix and VT between control keywords before dispatch', async () => {
    const h = harness();
    const db = turbineCore(h.pool, schema);
    for (const whitespace of [' ', '\t', '\n', '\v', '\f', '\r']) {
      for (const control of ['BEGIN', 'COMMIT', 'ROLLBACK', 'SAVEPOINT x', `START${whitespace}TRANSACTION`]) {
        await assert.rejects(db.rawQuery(whitespace + control), refusal);
      }
    }
    assert.deepEqual(h.calls, []);
    assert.equal(h.connects(), 0);
    await db.disconnect();
  });

  it('preserves VT inside quoted SQL and comments without inventing a transaction command', async () => {
    const h = harness();
    const db = turbineCore(h.pool, schema);
    const text = "SELECT '\vBEGIN' AS value /* \vCOMMIT */";
    await db.rawQuery(text);
    assert.deepEqual(h.calls, [{ text, values: [] }]);
    await db.disconnect();
  });
});
