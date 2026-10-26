/**
 * turbine-orm, the `turbine:query` diagnostics_channel tracing channel.
 *
 * A subscriber to `tracingChannel('turbine:query')` sees every statement
 * Turbine sends, with no client handed to it and no `$on('query')` listener
 * registered: the model, the operation, the parametrized SQL, the bound value
 * COUNT (never a value), the row count, the duration and the error. The first
 * block runs against a mock pool (no database). The second runs the same
 * operations against a real Postgres seeded by src/test/fixtures/seed.sql and
 * is gated by DATABASE_URL.
 *
 * Run: npx tsx --test src/test/query-channel.test.ts
 */

import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import diagnostics_channel from 'node:diagnostics_channel';
import { afterEach, beforeEach, describe, it as unitIt } from 'node:test';
import { type PgCompatPool, TurbineClient } from '../client.js';
import { QUERY_CHANNEL, type QueryChannelContext } from '../index.js';
import { introspect } from '../introspect.js';
import { queryChannelActive, startQueryTrace } from '../query-channel.js';
import { RAW_QUERY_MODEL } from '../query-events.js';
import type { SchemaMetadata } from '../schema.js';
import { mockTable, skipGate } from './helpers.js';

// biome-ignore lint/suspicious/noExplicitAny: test harness plumbing
type Any = any;

type Phase = 'start' | 'end' | 'asyncStart' | 'asyncEnd' | 'error';
interface Seen {
  phase: Phase;
  context: QueryChannelContext;
  /** A copy of the context as it was when this event was published. */
  snapshot: QueryChannelContext;
  store: unknown;
}

const SECRET = 'value-that-must-never-be-published';
class Rollback extends Error {}
const als = new AsyncLocalStorage<string>();

/** Subscribes to every phase of the channel and records what each one saw. */
function recorder(): { seen: Seen[]; stop: () => void; settled: () => QueryChannelContext[] } {
  const seen: Seen[] = [];
  const channel = diagnostics_channel.tracingChannel<string, QueryChannelContext>(QUERY_CHANNEL);
  const on = (phase: Phase) => (message: unknown) => {
    const context = message as QueryChannelContext;
    seen.push({ phase, context, snapshot: { ...context }, store: als.getStore() });
  };
  const handlers = {
    start: on('start'),
    end: on('end'),
    asyncStart: on('asyncStart'),
    asyncEnd: on('asyncEnd'),
    error: on('error'),
  };
  channel.subscribe(handlers as never);
  return {
    seen,
    stop: () => channel.unsubscribe(handlers as never),
    settled: () => seen.filter((s) => s.phase === 'asyncEnd').map((s) => s.context),
  };
}

/** Every started context has exactly one end, asyncStart and asyncEnd, in that order. */
function assertBalanced(seen: Seen[]): void {
  const byContext = new Map<QueryChannelContext, Phase[]>();
  for (const s of seen) byContext.set(s.context, [...(byContext.get(s.context) ?? []), s.phase]);
  for (const phases of byContext.values()) {
    const expected = phases.includes('error')
      ? ['start', 'end', 'error', 'asyncStart', 'asyncEnd']
      : ['start', 'end', 'asyncStart', 'asyncEnd'];
    assert.deepEqual(phases, expected);
  }
}

function assertNoValues(contexts: QueryChannelContext[]): void {
  for (const c of contexts) {
    assert.ok(!JSON.stringify(c).includes(SECRET), `a bound value reached the channel: ${JSON.stringify(c)}`);
    assert.ok(!('params' in c), 'the context carries no params array');
    assert.ok(!('result' in c), 'the context carries no driver result');
  }
}

function mockPool(rows: Record<string, unknown>[] = [{ id: 1, name: 'a' }], failOn?: string): PgCompatPool {
  const query = async (sql: string | { text: string }) => {
    const text = typeof sql === 'string' ? sql : sql.text;
    if (failOn && text.toLowerCase().includes(failOn.toLowerCase()))
      throw Object.assign(new Error('boom'), { code: '42P01' });
    return { rows, rowCount: rows.length, fields: [] };
  };
  return {
    query,
    connect: async () => ({ query, release: () => {} }),
    end: async () => {},
  } as unknown as PgCompatPool;
}

function mockSchema(): SchemaMetadata {
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

const mockClient = (pool: PgCompatPool): Any =>
  new TurbineClient({ pool, warnOnUnlimited: false }, mockSchema()) as Any;

describe('turbine:query channel without a database', () => {
  let rec: ReturnType<typeof recorder>;
  beforeEach(() => {
    rec = recorder();
  });
  afterEach(() => rec.stop());

  unitIt('builds nothing and publishes nothing when nobody subscribes', async () => {
    rec.stop();
    assert.equal(queryChannelActive(), false);
    assert.equal(startQueryTrace('users', 'findMany', 'SELECT 1', 0), undefined);
    const db = mockClient(mockPool());
    await db.users.findMany({ where: { name: SECRET } });
    assert.equal(rec.seen.length, 0);
    rec = recorder();
    assert.equal(queryChannelActive(), true);
  });

  unitIt('publishes a model call with its shape, value count, rows and duration, and no values', async () => {
    const db = mockClient(
      mockPool([
        { id: 1, name: 'a' },
        { id: 2, name: 'b' },
      ]),
    );
    await db.users.findMany({ where: { name: SECRET }, limit: 10 });

    assertBalanced(rec.seen);
    const [c] = rec.settled();
    assert.ok(c);
    assert.equal(c.model, 'users');
    assert.equal(c.operation, 'findMany');
    assert.match(c.sql, /\$1/);
    assert.ok(c.paramCount >= 1);
    assert.equal(c.rowCount, 2);
    assert.ok(typeof c.durationMs === 'number' && c.durationMs >= 0);
    assert.equal(c.error, undefined);
    // The start events see the identity only: rows and time come at the end.
    const start = rec.seen.find((s) => s.phase === 'start')!;
    assert.equal(start.snapshot.rowCount, undefined);
    assert.equal(start.snapshot.durationMs, undefined);
    assertNoValues(rec.settled());
  });

  unitIt("publishes start in the caller's async context, so its span is the parent", async () => {
    const db = mockClient(mockPool());
    await als.run('request-span', () => db.users.findFirst({ where: { name: SECRET } }));
    const start = rec.seen.find((s) => s.phase === 'start')!;
    assert.equal(start.store, 'request-span');
    assert.equal(start.context.operation, 'findFirst');
  });

  unitIt('publishes the error the caller gets, with zero rows', async () => {
    const db = mockClient(mockPool([], 'from "users"'));
    let thrown: unknown;
    await assert.rejects(async () => {
      try {
        await db.users.findMany({ where: { name: SECRET } });
      } catch (err) {
        thrown = err;
        throw err;
      }
    });
    assertBalanced(rec.seen);
    const [c] = rec.settled();
    assert.equal(c?.error, thrown);
    assert.equal(c?.rowCount, 0);
    assertNoValues(rec.settled());
  });

  unitIt('publishes raw SQL, typed SQL and rawQuery as $raw with their entry point', async () => {
    const db = mockClient(mockPool([{ n: 1 }]));
    await db.raw`SELECT n FROM t WHERE org = ${SECRET}`;
    await db.sql`SELECT n FROM t WHERE org = ${SECRET}`;
    await db.rawQuery('SELECT n FROM t WHERE org = $1', [SECRET]);
    assertBalanced(rec.seen);
    assert.deepEqual(
      rec.settled().map((c) => [c.model, c.operation, c.sql, c.paramCount, c.rowCount]),
      [
        [RAW_QUERY_MODEL, 'raw', 'SELECT n FROM t WHERE org = $1', 1, 1],
        [RAW_QUERY_MODEL, 'sql', 'SELECT n FROM t WHERE org = $1', 1, 1],
        [RAW_QUERY_MODEL, 'rawQuery', 'SELECT n FROM t WHERE org = $1', 1, 1],
      ],
    );
    assertNoValues(rec.settled());
  });

  unitIt('publishes statements inside $transaction(fn) and $transaction([...])', async () => {
    const db = mockClient(mockPool([{ id: 7, name: 'x' }]));
    await db.$transaction(async (tx: Any) => {
      await tx.users.findMany({ where: { name: SECRET }, limit: 1 });
      await tx.raw`UPDATE users SET name = ${SECRET} WHERE id = ${7}`;
    });
    await db.$transaction([db.users.buildFindMany({ where: { name: SECRET }, limit: 1 }), db.users.buildCount()]);
    assertBalanced(rec.seen);
    assert.deepEqual(
      rec.settled().map((c) => [c.model, c.operation, c.batch, c.operation === '$transaction' ? c.sql : '']),
      [
        [RAW_QUERY_MODEL, '$transaction', undefined, 'BEGIN'],
        ['users', 'findMany', undefined, ''],
        [RAW_QUERY_MODEL, 'raw', undefined, ''],
        [RAW_QUERY_MODEL, '$transaction', undefined, 'COMMIT'],
        [RAW_QUERY_MODEL, '$transaction', undefined, 'BEGIN'],
        ['users', 'findMany', 'transaction', ''],
        ['users', 'count', 'transaction', ''],
        [RAW_QUERY_MODEL, '$transaction', undefined, 'COMMIT'],
      ],
    );
    assertNoValues(rec.settled());
  });

  unitIt('publishes each pipeline statement with no $on listener registered', async () => {
    const db = mockClient(mockPool([{ id: 1, name: 'a' }]));
    await db.pipeline(db.users.buildFindMany({ where: { name: SECRET }, limit: 5 }), db.users.buildCount());
    assertBalanced(rec.seen);
    const settled = rec.settled().filter((c) => c.operation !== '$transaction');
    assert.deepEqual(
      settled.map((c) => [c.operation, c.batch, c.rowCount]),
      [
        ['findMany', 'pipeline', 1],
        ['count', 'pipeline', 1],
      ],
    );
    assert.equal(settled[0]!.durationMs, settled[1]!.durationMs);
    // The batch's own BEGIN and COMMIT are published too.
    assert.deepEqual(
      rec
        .settled()
        .filter((c) => c.operation === '$transaction')
        .map((c) => c.sql),
      ['BEGIN', 'COMMIT'],
    );
  });

  unitIt('settles every traced pipeline statement when one fails', async () => {
    const db = mockClient(mockPool([{ id: 1 }], 'count('));
    await assert.rejects(() => db.pipeline(db.users.buildFindMany({ limit: 5 }), db.users.buildCount()));
    assertBalanced(rec.seen);
    const starts = rec.seen.filter((s) => s.phase === 'start').length;
    assert.equal(rec.settled().length, starts);
    assert.ok(rec.settled().some((c) => c.operation === 'count' && c.error instanceof Error));
  });

  unitIt('publishes transaction control: savepoints, session settings without their values, and ROLLBACK', async () => {
    const sent: string[] = [];
    const base = mockPool([{ id: 1, name: 'a' }]);
    const query = async (sql: string | { text: string }, values?: unknown[]) => {
      sent.push(typeof sql === 'string' ? sql : sql.text);
      return (base.query as Any)(sql, values);
    };
    const pool = { ...base, query, connect: async () => ({ query, release: () => {} }) } as unknown as PgCompatPool;
    const db = mockClient(pool);
    await assert.rejects(
      db.$transaction(
        async (tx: Any) => {
          await tx.$transaction(async (inner: Any) => {
            await inner.users.findMany({ limit: 1 });
          });
          throw new Rollback('roll it back');
        },
        { sessionContext: { 'app.tenant': SECRET } },
      ),
      Rollback,
    );
    assertBalanced(rec.seen);
    const control = rec.settled().filter((c) => c.operation === '$transaction');
    assert.ok(control.length >= 5);
    for (const c of control) {
      assert.equal(c.model, RAW_QUERY_MODEL);
      assert.equal(c.error, undefined);
      // Each is the exact text the driver received, so a tracer can match its own driver span.
      assert.ok(sent.includes(c.sql), `not sent as published: ${c.sql}`);
    }
    const verbs = control.map((c) => c.sql.split(/\s|\(/)[0]!.toUpperCase());
    assert.deepEqual(verbs, ['BEGIN', 'SELECT', 'SAVEPOINT', 'RELEASE', 'ROLLBACK']);
    const setting = control[1]!;
    assert.match(setting.sql, /set_config\(\$1, \$2/);
    assert.equal(setting.paramCount, setting.sql.match(/\$\d/g)!.length);
    assertNoValues(rec.settled());
  });

  unitIt('publishes a COMMIT the server answered with ROLLBACK as a failed statement', async () => {
    const base = mockPool([{ id: 1, name: 'a' }]);
    const query = async (sql: string | { text: string }, values?: unknown[]) =>
      (typeof sql === 'string' ? sql : sql.text) === 'COMMIT'
        ? { rows: [], rowCount: null, command: 'ROLLBACK', fields: [] }
        : (base.query as Any)(sql, values);
    const pool = { ...base, query, connect: async () => ({ query, release: () => {} }) } as unknown as PgCompatPool;
    const db = mockClient(pool);
    let thrown: unknown;
    await db
      .$transaction(async (tx: Any) => {
        await tx.users.findMany({ limit: 1 });
      })
      .catch((err: unknown) => {
        thrown = err;
      });
    assert.ok(thrown instanceof Error);
    assertBalanced(rec.seen);
    const commit = rec.settled().find((c) => c.sql === 'COMMIT');
    assert.equal(commit?.error, thrown);
    assert.ok(rec.seen.some((s) => s.phase === 'error' && s.context === commit));
  });

  unitIt('publishes $notify with its payload bound, not in the text', async () => {
    const db = mockClient(mockPool([{ pg_notify: '' }]));
    await db.$notify('orders', SECRET);
    assertBalanced(rec.seen);
    assert.deepEqual(
      rec.settled().map((c) => [c.model, c.operation, c.sql, c.paramCount]),
      [[RAW_QUERY_MODEL, '$notify', 'SELECT pg_notify($1, $2)', 2]],
    );
    assertNoValues(rec.settled());
  });

  unitIt('keeps $on listeners and the channel independent of each other', async () => {
    const db = mockClient(mockPool());
    const events: unknown[] = [];
    db.$on('query', (e: unknown) => events.push(e));
    await db.users.findMany({ limit: 1 });
    assert.equal(events.length, 1);
    assert.equal(rec.settled().length, 1);
  });
});

// ---------------------------------------------------------------------------
// Against a real Postgres
// ---------------------------------------------------------------------------

const DATABASE_URL = process.env.DATABASE_URL;
const SKIP = !DATABASE_URL;
if (SKIP) console.log('⚠ Skipping turbine:query channel integration tests: DATABASE_URL not set');
const { it, before, after } = skipGate(SKIP, 'DATABASE_URL not set');

describe('turbine:query channel against Postgres', () => {
  let db: Any;
  let rec: ReturnType<typeof recorder>;

  before(async () => {
    const schema = await introspect({ connectionString: DATABASE_URL! });
    db = new TurbineClient({ connectionString: DATABASE_URL!, poolSize: 3, warnOnUnlimited: false }, schema);
    await db.connect();
  });
  after(async () => {
    await db?.disconnect();
  });
  beforeEach(() => {
    rec = recorder();
  });
  afterEach(() => rec.stop());

  it('reads: findMany, findFirst and a nested json_agg query are one statement each', async () => {
    const users = await db
      .table('users')
      .findMany({ where: { email: { not: SECRET } }, limit: 3, orderBy: { id: 'asc' } });
    await db.table('users').findFirst({ where: { email: { not: SECRET } } });
    const nested = await db.table('users').findMany({
      where: { email: { not: SECRET } },
      limit: 2,
      orderBy: { id: 'asc' },
      with: { posts: { with: { comments: true } } },
    });
    assertBalanced(rec.seen);
    const settled = rec.settled();
    assert.deepEqual(
      settled.map((c) => [c.model, c.operation]),
      [
        ['users', 'findMany'],
        ['users', 'findFirst'],
        ['users', 'findMany'],
      ],
    );
    assert.equal(settled[0]!.rowCount, users.length);
    assert.equal(settled[2]!.rowCount, nested.length);
    assert.match(settled[2]!.sql, /json_agg/);
    for (const c of settled) assert.ok(c.paramCount >= 1 && (c.durationMs ?? -1) >= 0);
    assertNoValues(settled);
  });

  it('writes: create, update, upsert and delete inside a transaction, then raw SQL', async () => {
    const email = `${SECRET}@example.test`;
    await assert.rejects(
      db.$transaction(async (tx: Any) => {
        const org = await tx.raw`SELECT id FROM organizations ORDER BY id LIMIT ${1}`;
        const created = await tx.table('users').create({ data: { orgId: org[0].id, email, name: SECRET } });
        await tx.table('users').update({ where: { id: created.id }, data: { name: `${SECRET}-2` } });
        await tx.table('users').upsert({
          where: { email },
          create: { orgId: org[0].id, email, name: SECRET },
          update: { name: `${SECRET}-3` },
        });
        await tx.table('users').delete({ where: { id: created.id } });
        throw new Rollback('leave the fixture untouched');
      }),
      Rollback,
    );
    assertBalanced(rec.seen);
    const settled = rec.settled();
    assert.deepEqual(
      settled.map((c) => [c.model, c.operation, c.rowCount, c.operation === '$transaction' ? c.sql : '']),
      [
        [RAW_QUERY_MODEL, '$transaction', 0, 'BEGIN'],
        [RAW_QUERY_MODEL, 'raw', 1, ''],
        ['users', 'create', 1, ''],
        ['users', 'update', 1, ''],
        ['users', 'upsert', 1, ''],
        ['users', 'delete', 1, ''],
        [RAW_QUERY_MODEL, '$transaction', 0, 'ROLLBACK'],
      ],
    );
    assertNoValues(settled);
    const left = await db.raw`SELECT count(*)::int AS n FROM users WHERE email = ${email}`;
    assert.equal(left[0].n, 0);
  });

  it('a failed statement carries its error', async () => {
    await assert.rejects(db.raw`SELECT * FROM table_that_does_not_exist WHERE x = ${SECRET}`);
    assertBalanced(rec.seen);
    const [c] = rec.settled();
    assert.ok(c?.error instanceof Error);
    assert.equal(c?.rowCount, 0);
    assertNoValues(rec.settled());
  });
});
