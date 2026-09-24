/**
 * turbine-orm, `$on('query')` coverage for the statements that do not go
 * through a table accessor, plus the `$tag()` attribution scope.
 *
 * Model methods have always emitted query events. Raw SQL (`raw`, `sql`, the
 * transaction-scoped `raw` / `rawQuery`, prisma-compat `$queryRaw` and
 * friends), `pipeline()` and the array form `$transaction([...])` did not, so
 * any listener (the observe engine, a telemetry exporter, a logger) saw a
 * partial picture of what the application sent. Each test below asserts the
 * event a caller of that entry point now gets, including the failure event,
 * against a mock pool, so no database is needed.
 *
 * Run: npx tsx --test src/test/query-event-coverage.test.ts
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { type PgCompatPool, TurbineClient } from '../client.js';
import { TurbineError, TurbineErrorCode } from '../errors.js';
import { createPrismaCompatClient } from '../prisma-compat.js';
import type { QueryEvent } from '../query/index.js';
import { MAX_QUERY_TAG_LENGTH, RAW_QUERY_MODEL } from '../query-events.js';
import type { PrismaCompatMap, SchemaMetadata } from '../schema.js';
import { mockTable } from './helpers.js';

// biome-ignore lint/suspicious/noExplicitAny: test harness plumbing
type Any = any;

interface Sent {
  sql: string;
  params: unknown[];
}

/**
 * A pool whose connections answer every statement with `rows`, and fail any
 * statement whose text contains `failOn`. Records what it was sent.
 */
function mockPool(
  rows: Record<string, unknown>[] = [{ id: 1 }],
  failOn?: string,
): { pool: PgCompatPool; sent: Sent[] } {
  const sent: Sent[] = [];
  const query = async (sql: string, params: unknown[] = []) => {
    sent.push({ sql, params });
    if (failOn && sql.toLowerCase().includes(failOn.toLowerCase()))
      throw Object.assign(new Error('boom'), { code: '42P01' });
    return { rows, rowCount: rows.length, fields: [] };
  };
  const pool = {
    query,
    connect: async () => ({ query, release: () => {} }),
    end: async () => {},
  } as unknown as PgCompatPool;
  return { pool, sent };
}

function schema(): SchemaMetadata {
  return {
    enums: {},
    tables: {
      users: mockTable('users', [
        { name: 'id', field: 'id' },
        { name: 'name', field: 'name', pgType: 'text' },
      ]),
    },
  };
}

function client(pool: PgCompatPool, config: Record<string, unknown> = {}): { db: Any; events: QueryEvent[] } {
  const db = new TurbineClient({ pool, errorMessages: 'verbose', ...config }, schema()) as Any;
  const events: QueryEvent[] = [];
  db.$on('query', (e: QueryEvent) => events.push(e));
  return { db, events };
}

describe('query events for raw SQL', () => {
  it('db.raw emits one $raw/raw event with the row count and redacted params', async () => {
    const { pool } = mockPool([{ n: 1 }, { n: 2 }]);
    const { db, events } = client(pool, { errorMessages: 'safe' });
    const rows = await db.raw`SELECT n FROM t WHERE org = ${'acme'}`;

    assert.equal(rows.length, 2);
    assert.equal(events.length, 1);
    const e = events[0]!;
    assert.equal(e.model, RAW_QUERY_MODEL);
    assert.equal(e.action, 'raw');
    assert.equal(e.sql, 'SELECT n FROM t WHERE org = $1');
    assert.equal(e.rows, 2);
    assert.ok(e.duration >= 0);
    assert.ok(e.timestamp instanceof Date);
    assert.equal(e.error, undefined);
    // Params are redacted unless logQueryParams opts in, same as model events.
    assert.deepEqual(e.params, ['[REDACTED]']);
  });

  it('db.raw that fails emits an error event carrying the error the caller gets', async () => {
    const { pool } = mockPool([], 'missing_table');
    const { db, events } = client(pool);

    let thrown: unknown;
    await assert.rejects(async () => {
      try {
        await db.raw`SELECT * FROM missing_table`;
      } catch (err) {
        thrown = err;
        throw err;
      }
    });
    assert.equal(events.length, 1);
    assert.equal(events[0]!.action, 'raw');
    // The event carries exactly the error the caller received.
    assert.equal(events[0]!.error, thrown);
    assert.equal(events[0]!.rows, 0);
  });

  it('db.sql emits a $raw/sql event per execution (await, one, scalar)', async () => {
    const { pool } = mockPool([{ c: 3 }]);
    const { db, events } = client(pool);

    await db.sql`SELECT count(*) AS c FROM users`;
    await db.sql`SELECT count(*) AS c FROM users`.one();
    await db.sql`SELECT count(*) AS c FROM users`.scalar();

    assert.equal(events.length, 3);
    for (const e of events) {
      assert.equal(e.model, RAW_QUERY_MODEL);
      assert.equal(e.action, 'sql');
      assert.equal(e.sql, 'SELECT count(*) AS c FROM users');
      assert.equal(e.rows, 1);
    }
  });

  it('db.sql that fails emits an error event', async () => {
    const { pool } = mockPool([], 'nope');
    const { db, events } = client(pool);
    await assert.rejects(async () => {
      await db.sql`SELECT * FROM nope`;
    });
    assert.equal(events.length, 1);
    assert.ok(events[0]!.error instanceof Error);
  });

  it('tx.raw and tx.rawQuery inside $transaction(fn) emit events', async () => {
    const { pool } = mockPool([{ id: 7 }]);
    const { db, events } = client(pool);

    await db.$transaction(async (tx: Any) => {
      await tx.raw`UPDATE users SET name = ${'x'} WHERE id = ${7}`;
      await tx.rawQuery('DELETE FROM users WHERE id = $1', [7]);
    });

    const raw = events.filter((e) => e.model === RAW_QUERY_MODEL);
    assert.deepEqual(
      raw.map((e) => e.action),
      ['raw', 'rawQuery'],
    );
    assert.equal(raw[0]!.sql, 'UPDATE users SET name = $1 WHERE id = $2');
    assert.equal(raw[1]!.rows, 1);
  });

  it('no event is built when nobody listens', async () => {
    const { pool } = mockPool([{ id: 1 }]);
    const db = new TurbineClient({ pool }, schema()) as Any;
    // Nothing to assert on events; the point is that the unobserved path runs.
    const rows = await db.raw`SELECT 1`;
    assert.equal(rows.length, 1);
  });
});

describe('query events for prisma-compat raw SQL', () => {
  const map: PrismaCompatMap = {
    enums: {},
    models: {
      User: {
        table: 'users',
        accessor: 'users',
        fields: { id: 'id', name: 'name' },
        relations: {},
        compoundUniques: {},
      },
    },
  };

  it('$queryRaw and $executeRaw report their own method names as the action', async () => {
    const { pool } = mockPool([{ id: 1 }]);
    const { db, events } = client(pool);
    const compat = createPrismaCompatClient(db, map) as Any;

    await compat.$queryRaw`SELECT * FROM users WHERE id = ${1}`;
    await compat.$executeRaw`UPDATE users SET name = ${'a'}`;
    await compat.$queryRawUnsafe('SELECT 1');
    await compat.$executeRawUnsafe('SELECT 2');

    assert.deepEqual(
      events.map((e) => [e.model, e.action]),
      [
        [RAW_QUERY_MODEL, '$queryRaw'],
        [RAW_QUERY_MODEL, '$executeRaw'],
        [RAW_QUERY_MODEL, '$queryRawUnsafe'],
        [RAW_QUERY_MODEL, '$executeRawUnsafe'],
      ],
    );
  });

  it('$queryRaw inside a compat $transaction reports on the transaction connection', async () => {
    const { pool } = mockPool([{ id: 1 }]);
    const { db, events } = client(pool);
    const compat = createPrismaCompatClient(db, map) as Any;

    await compat.$transaction(async (tx: Any) => {
      await tx.$queryRaw`SELECT * FROM users`;
    });
    const raw = events.filter((e) => e.model === RAW_QUERY_MODEL);
    assert.equal(raw.length, 1);
    assert.equal(raw[0]!.action, '$queryRaw');
  });
});

describe('query events for pipelines and batch transactions', () => {
  it('pipeline() emits one event per statement, attributed by model and action', async () => {
    const { pool } = mockPool([{ id: 1, name: 'a' }]);
    const { db, events } = client(pool);

    await db.pipeline(db.users.buildFindMany({ limit: 5 }), db.users.buildCount());

    assert.equal(events.length, 2);
    assert.deepEqual(
      events.map((e) => [e.model, e.action, e.batch]),
      [
        ['users', 'findMany', 'pipeline'],
        ['users', 'count', 'pipeline'],
      ],
    );
    for (const e of events) {
      assert.equal(e.rows, 1);
      assert.ok(e.duration >= 0);
    }
    // The two statements share one round trip, so the split is even.
    assert.equal(events[0]!.duration, events[1]!.duration);
  });

  it('a failed non-transactional pipeline reports the failing slot as an error', async () => {
    const { pool } = mockPool([{ id: 1 }], 'count(');
    const { db, events } = client(pool);

    await assert.rejects(
      () => db.pipeline([db.users.buildFindMany({ limit: 1 }), db.users.buildCount()], { transactional: false }),
      (err: unknown) => err instanceof TurbineError && err.code === TurbineErrorCode.PIPELINE,
    );
    const byAction = Object.fromEntries(events.map((e) => [e.action, e]));
    assert.equal(byAction.findMany?.error, undefined);
    assert.ok(byAction.count?.error instanceof Error);
  });

  it('$transaction([...]) emits one event per statement with batch: transaction', async () => {
    const { pool } = mockPool([{ id: 1, name: 'a' }]);
    const { db, events } = client(pool);

    await db.$transaction([db.users.buildFindMany({ limit: 2 }), db.users.buildCount()]);

    const batch = events.filter((e) => e.batch === 'transaction');
    assert.deepEqual(
      batch.map((e) => [e.model, e.action]),
      [
        ['users', 'findMany'],
        ['users', 'count'],
      ],
    );
    assert.ok(batch.every((e) => e.rows === 1 && e.error === undefined));
  });

  it('a failing statement in $transaction([...]) is reported with its error', async () => {
    const { pool } = mockPool([{ id: 1 }], 'count(');
    const { db, events } = client(pool);

    await assert.rejects(() => db.$transaction([db.users.buildFindMany({ limit: 1 }), db.users.buildCount()]));
    const batch = events.filter((e) => e.batch === 'transaction');
    assert.equal(batch.length, 2);
    assert.equal(batch[0]!.error, undefined);
    assert.ok(batch[1]!.error instanceof Error);
  });
});

describe('$tag() attribution scope', () => {
  it('tags model, raw and pipeline events inside the scope, and nothing outside it', async () => {
    const { pool } = mockPool([{ id: 1, name: 'a' }]);
    const { db, events } = client(pool);

    await db.users.findMany({ limit: 1 });
    await db.$tag('checkout', async () => {
      await db.users.findMany({ limit: 1 });
      await db.raw`SELECT 1`;
      await db.pipeline(db.users.buildCount());
    });
    await db.users.findMany({ limit: 1 });

    assert.deepEqual(
      events.map((e) => e.tag),
      [undefined, 'checkout', 'checkout', 'checkout', undefined],
    );
  });

  it('follows awaited helpers and transactions, and the inner scope wins', async () => {
    const { pool } = mockPool([{ id: 1, name: 'a' }]);
    const { db, events } = client(pool);

    const helper = async () => db.users.findMany({ limit: 1 });
    await db.$tag('outer', async () => {
      await helper();
      await db.$transaction(async (tx: Any) => {
        await tx.users.findMany({ limit: 1 });
        await db.$tag('inner', () => tx.raw`SELECT 2`);
      });
      await helper();
    });

    const tags = events.filter((e) => e.sql.startsWith('SELECT')).map((e) => e.tag);
    assert.deepEqual(tags, ['outer', 'outer', 'inner', 'outer']);
  });

  it('concurrent scopes do not leak into each other', async () => {
    const { pool } = mockPool([{ id: 1, name: 'a' }]);
    const { db, events } = client(pool);
    const tick = () => new Promise((r) => setTimeout(r, 1));

    await Promise.all([
      db.$tag('a', async () => {
        await tick();
        await db.raw`SELECT 'a'`;
      }),
      db.$tag('b', async () => {
        await db.raw`SELECT 'b'`;
        await tick();
      }),
    ]);
    const bySql = Object.fromEntries(events.map((e) => [e.sql, e.tag]));
    assert.equal(bySql["SELECT 'a'"], 'a');
    assert.equal(bySql["SELECT 'b'"], 'b');
  });

  it('returns the callback value, sync or async', async () => {
    const { pool } = mockPool();
    const { db } = client(pool);
    assert.equal(
      db.$tag('x', () => 42),
      42,
    );
    assert.equal(await db.$tag('x', async () => 'y'), 'y');
  });

  it('refuses an empty or oversized tag with E003 before running the callback', () => {
    const { pool } = mockPool();
    const { db } = client(pool);
    let ran = false;
    const run = () => {
      ran = true;
    };
    for (const bad of ['', '   ', 'x'.repeat(MAX_QUERY_TAG_LENGTH + 1), 42 as unknown as string]) {
      assert.throws(
        () => db.$tag(bad, run),
        (err: unknown) => err instanceof TurbineError && err.code === TurbineErrorCode.VALIDATION,
      );
    }
    assert.equal(ran, false);
    assert.equal(
      db.$tag('x'.repeat(MAX_QUERY_TAG_LENGTH), () => 'ok'),
      'ok',
    );
  });
});
