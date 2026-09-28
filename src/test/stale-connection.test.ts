/**
 * turbine-orm, recovering from connections the server already closed (no database)
 *
 * pg-pool evicts an idle connection when it reads the socket's close, which
 * needs the event loop. After a freeze (a serverless function between
 * invocations, a long synchronous block) a restart or pooler recycle leaves
 * every idle connection dead but still lendable, and each caller that gets one
 * fails: measured live, five concurrent queries after a frozen
 * `pg_terminate_backend` of five idle connections all failed with 57P01.
 *
 * Three recoveries, each pinned here, and one refusal:
 *
 *   1. A checkout after the pool has been quiet for a while first waits for
 *      one poll phase (settleLongIdleCheckouts), so the closes are read and the
 *      dead connections evicted BEFORE one is lent out. Reads, writes and
 *      transactions alike.
 *   2. A READ outside a transaction that fails on a dead connection is sent
 *      once more (QueryInterface.readWithTimeout).
 *   3. A BEGIN (or connect()'s SELECT 1) that fails on a dead connection is
 *      sent once more on a fresh one (openCheckout): nothing has run yet.
 *   4. A WRITE is never resent: "the connection died" does not say whether it
 *      committed first.
 *
 * Live coverage: stale-connection.integration.test.ts.
 */

import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, type Socket, connect as tcpConnect } from 'node:net';
import { describe, it } from 'node:test';
import { openCheckout } from '../checkout.js';
import { settleEventLoop, settleLongIdleCheckouts } from '../connection-guard.js';
import { ConnectionError, isStaleConnectionError, UniqueConstraintError, wrapPgError } from '../errors.js';
import type { PgCompatPool, PgCompatPoolClient } from '../pg-types.js';
import type { QueryEvent } from '../query/index.js';
import { QueryInterface } from '../query/index.js';
import type { SchemaMetadata } from '../schema.js';
import { mockTable } from './helpers.js';

/** What pg hands the next query sent on a connection whose backend was terminated while idle. */
function terminated(): Error {
  return Object.assign(new Error('terminating connection due to administrator command'), {
    code: '57P01',
    severity: 'FATAL',
  });
}

function pgError(code: string, message = `pg ${code}`): Error {
  return Object.assign(new Error(message), { code });
}

describe('isStaleConnectionError: an OPEN connection went away', () => {
  const stale: Array<[string, unknown]> = [
    ['57P01 admin_shutdown (what a dead idle connection hands the next query)', terminated()],
    ['ECONNRESET', pgError('ECONNRESET', 'read ECONNRESET')],
    ['EPIPE', pgError('EPIPE', 'write EPIPE')],
    ['Connection terminated unexpectedly', new Error('Connection terminated unexpectedly')],
    ['not queryable (connection error)', new Error('Client has encountered a connection error and is not queryable')],
    ['not queryable (closed)', new Error('Client was closed and is not queryable')],
    ['the ConnectionError wrapPgError makes of 57P01', wrapPgError(terminated())],
    [
      'the ConnectionError wrapPgError makes of a code-less loss',
      wrapPgError(new Error('Connection terminated unexpectedly')),
    ],
  ];
  for (const [label, err] of stale) {
    it(`yes: ${label}`, () => assert.equal(isStaleConnectionError(err), true));
  }

  // A connection that could not be OPENED will not open on an immediate second
  // try either; retrying those only doubles the wait for the real error.
  const notStale: Array<[string, unknown]> = [
    ['ECONNREFUSED (nothing listening)', pgError('ECONNREFUSED', 'connect ECONNREFUSED')],
    ['57P03 (server starting up)', pgError('57P03')],
    ['28P01 (wrong password)', pgError('28P01')],
    ['a connect timeout', new Error('Connection terminated due to connection timeout')],
    ['the pool shutting down', new Error('Connection terminated')],
    ['a unique violation', pgError('23505')],
    ['a plain Error', new Error('boom')],
    ['a string', 'Connection terminated unexpectedly'],
    ['undefined', undefined],
  ];
  for (const [label, err] of notStale) {
    it(`no: ${label}`, () => assert.equal(isStaleConnectionError(err), false));
  }
});

describe('settleEventLoop', () => {
  it('resolves only after the loop has READ a socket event that arrived meanwhile', async () => {
    // The property the settle exists for. The server writes while this
    // continuation holds the loop, so the bytes sit in the kernel unread; one
    // setImmediate hop would run in this same iteration's check phase, before
    // the next poll reads them. Two hops span a poll.
    const server = createServer();
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const { port } = server.address() as { port: number };
    const accepted = once(server, 'connection') as Promise<[Socket]>;
    const client = tcpConnect(port, '127.0.0.1');
    await once(client, 'connect');
    const [peer] = await accepted;
    try {
      let received = false;
      client.on('data', () => {
        received = true;
      });
      peer.write('x');
      const until = Date.now() + 30;
      while (Date.now() < until) {
        // hold the loop so the byte lands in the kernel buffer unread
      }
      assert.equal(received, false, 'precondition: nothing has been read yet');
      await settleEventLoop();
      assert.equal(received, true);
    } finally {
      client.destroy();
      peer.destroy();
      server.close();
    }
  });
});

/** A pg-pool stand-in: an idle count, a 'release' event, and a recorded connect. */
function fakePgPool(idle: number) {
  const listeners: Array<(err: unknown) => void> = [];
  const log: string[] = [];
  const pool = {
    idleCount: idle,
    on(event: string, fn: (err: unknown) => void) {
      if (event === 'release') listeners.push(fn);
    },
    connect(cb?: (err: unknown, client: unknown) => void) {
      log.push('connect');
      if (typeof cb === 'function') {
        cb(undefined, 'client');
        return undefined;
      }
      return Promise.resolve('client');
    },
    release(err?: unknown) {
      for (const fn of listeners) fn(err);
    },
  };
  return { pool, log };
}

/** Resolves when `p` has settled, reporting whether it did so before one plain setImmediate. */
async function settledBeforeOneHop(p: Promise<unknown>): Promise<boolean> {
  let done = false;
  void p.then(() => {
    done = true;
  });
  await new Promise((r) => setImmediate(r));
  const early = done;
  await p;
  return early;
}

describe('settleLongIdleCheckouts', () => {
  it('lends a recently returned connection at once', async () => {
    const { pool } = fakePgPool(1);
    settleLongIdleCheckouts(pool, 50);
    pool.release();
    assert.equal(await settledBeforeOneHop(pool.connect() as Promise<unknown>), true);
  });

  it('waits a poll phase before lending one idle past the threshold', async () => {
    const { pool } = fakePgPool(1);
    settleLongIdleCheckouts(pool, 20);
    pool.release();
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(await settledBeforeOneHop(pool.connect() as Promise<unknown>), false);
  });

  it('a release WITH an error (a destroyed connection) does not count as a return', async () => {
    const { pool } = fakePgPool(1);
    settleLongIdleCheckouts(pool, 20);
    pool.release();
    await new Promise((r) => setTimeout(r, 40));
    pool.release(new Error('dead'));
    assert.equal(await settledBeforeOneHop(pool.connect() as Promise<unknown>), false);
  });

  it('never waits when there is no idle connection to be stale', async () => {
    const { pool } = fakePgPool(0);
    settleLongIdleCheckouts(pool, 0);
    assert.equal(await settledBeforeOneHop(pool.connect() as Promise<unknown>), true);
  });

  it('covers the callback form pool.query uses, and returns nothing from it', async () => {
    const { pool } = fakePgPool(1);
    settleLongIdleCheckouts(pool, 0);
    const got = await new Promise((resolve) => {
      const ret = pool.connect((_err, client) => resolve(client));
      assert.equal(ret, undefined);
    });
    assert.equal(got, 'client');
  });

  it('leaves a pool without pg-pool events alone', () => {
    const shim = { connect: () => Promise.resolve('c') };
    const before = shim.connect;
    settleLongIdleCheckouts(shim);
    assert.equal(shim.connect, before);
  });
});

// ---------------------------------------------------------------------------
// Reads retry, writes never do
// ---------------------------------------------------------------------------

const SCHEMA: SchemaMetadata = {
  enums: {},
  tables: {
    items: mockTable('items', [
      { name: 'id', field: 'id', pgType: 'int4' },
      { name: 'name', field: 'name', pgType: 'text' },
    ]),
  },
};

type Item = { id: number; name: string };

/** A pool whose first `failures` queries fail with `error`, then answer with one row. */
function flakyPool(error: () => unknown, failures = 1) {
  let sent = 0;
  const pool = {
    get sent() {
      return sent;
    },
    query(textOrConfig: unknown, _values?: unknown[]) {
      sent++;
      if (sent <= failures) return Promise.reject(error());
      const text = typeof textOrConfig === 'string' ? textOrConfig : (textOrConfig as { text: string }).text;
      const row = /count\(/i.test(text)
        ? { count: 1, _count: 1, _count_all: 1, name: 'a' }
        : { id: 1, name: 'a', count: 1, _count: 1 };
      return Promise.resolve({ rows: [row], rowCount: 1, fields: [] });
    },
    connect() {
      return Promise.reject(new Error('no checkout in this test'));
    },
    end() {
      return Promise.resolve();
    },
  };
  return pool;
}

function qi(pool: ReturnType<typeof flakyPool>, events: QueryEvent[] = [], txScoped = false): QueryInterface<Item> {
  return new QueryInterface<Item>(pool as unknown as PgCompatPool, 'items', SCHEMA, undefined, {
    warnOnUnlimited: false,
    _onQuery: (e) => events.push(e),
    ...(txScoped ? { _txScoped: true } : {}),
  });
}

/**
 * One call per read method. Keyed by method name so the drift check below can
 * compare it with the READ surface found by reflection: a read method added
 * later fails this file until it is listed, and so gets the retry pinned.
 */
const READ_CALLS: Record<string, (q: QueryInterface<Item>) => Promise<unknown>> = {
  findMany: (q) => q.findMany({ where: { id: 1 } }),
  findFirst: (q) => q.findFirst({ where: { id: 1 } }),
  findFirstOrThrow: (q) => q.findFirstOrThrow({ where: { id: 1 } }),
  findUnique: (q) => q.findUnique({ where: { id: 1 } }),
  findUniqueOrThrow: (q) => q.findUniqueOrThrow({ where: { id: 1 } }),
  count: (q) => q.count({ where: { id: 1 } }),
  aggregate: (q) => q.aggregate({ _count: true }),
  groupBy: (q) => q.groupBy({ by: ['name'], _count: true }),
  findManyStream: async (q) => {
    for await (const _ of q.findManyStream({ where: { id: 1 } })) {
      // drain
    }
  },
  findManyStreamBatches: async (q) => {
    for await (const _ of q.findManyStreamBatches({ where: { id: 1 } })) {
      // drain
    }
  },
};

const WRITE_CALLS: Record<string, (q: QueryInterface<Item>) => Promise<unknown>> = {
  create: (q) => q.create({ data: { name: 'x' } }),
  createMany: (q) => q.createMany({ data: [{ name: 'x' }] }),
  update: (q) => q.update({ where: { id: 1 }, data: { name: 'y' } }),
  updateMany: (q) => q.updateMany({ where: { id: 1 }, data: { name: 'y' } }),
  delete: (q) => q.delete({ where: { id: 1 } }),
  deleteMany: (q) => q.deleteMany({ where: { id: 1 } }),
  upsert: (q) => q.upsert({ where: { id: 1 }, create: { id: 1, name: 'x' }, update: { name: 'y' } }),
};

function readMethodsByReflection(): string[] {
  return Object.getOwnPropertyNames(QueryInterface.prototype)
    .filter((n) => typeof Object.getOwnPropertyDescriptor(QueryInterface.prototype, n)?.value === 'function')
    .filter((n) => n.startsWith('find') || n === 'count' || n === 'aggregate' || n === 'groupBy')
    .sort();
}

describe('a read on a dead connection is sent once more', () => {
  it('the list below covers every read method (same rule as read-operations-drift)', () => {
    const found = readMethodsByReflection();
    assert.ok(found.length >= 8, `anti-vacuous: found only ${found.join(', ')}`);
    assert.deepEqual(Object.keys(READ_CALLS).sort(), found);
  });

  for (const [name, call] of Object.entries(READ_CALLS)) {
    it(`${name}: answers after one retry`, async () => {
      const pool = flakyPool(terminated);
      await call(qi(pool));
      assert.equal(pool.sent, 2);
    });
  }

  it('reports the failed attempt as its own event, marked retried', async () => {
    const events: QueryEvent[] = [];
    const pool = flakyPool(terminated);
    await qi(pool, events).findMany({ where: { id: 1 } });
    assert.equal(events.length, 2);
    assert.equal(events[0]?.retried, true);
    assert.ok(events[0]?.error instanceof ConnectionError);
    assert.equal(events[1]?.retried, undefined);
    assert.equal(events[1]?.error, undefined);
  });

  it('retries ONCE: a second dead connection fails the call', async () => {
    const pool = flakyPool(terminated, 2);
    await assert.rejects(qi(pool).findMany({ where: { id: 1 } }), ConnectionError);
    assert.equal(pool.sent, 2);
  });

  it('does not retry an error that is not a lost connection', async () => {
    const refused = flakyPool(() => pgError('ECONNREFUSED', 'connect ECONNREFUSED'));
    await assert.rejects(qi(refused).findMany({ where: { id: 1 } }), ConnectionError);
    assert.equal(refused.sent, 1);

    const unique = flakyPool(() => pgError('23505'));
    await assert.rejects(qi(unique).count(), UniqueConstraintError);
    assert.equal(unique.sent, 1);
  });

  it('does not retry inside a transaction, where the dead connection WAS the transaction', async () => {
    const pool = flakyPool(terminated);
    await assert.rejects(qi(pool, [], true).findMany({ where: { id: 1 } }), ConnectionError);
    assert.equal(pool.sent, 1);
  });

  it('the retry runs inside the caller’s timeout', async () => {
    const pool = flakyPool(terminated);
    await qi(pool).findMany({ where: { id: 1 }, timeout: 1000 });
    assert.equal(pool.sent, 2);
  });

  it('a call whose timeout already fired sends no retry', async () => {
    // The first attempt fails AFTER the caller has its TimeoutError; resending
    // then would run a query nobody is waiting for.
    const pool = flakyPool(terminated);
    const slow = pool.query.bind(pool);
    pool.query = (text: unknown, values?: unknown[]) =>
      new Promise((resolve, reject) => setTimeout(() => slow(text, values).then(resolve, reject), 40));
    await assert.rejects(qi(pool).findMany({ where: { id: 1 }, timeout: 10 }), /timed out|E002/i);
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(pool.sent, 1);
  });
});

describe('a write on a dead connection is NOT resent', () => {
  for (const [name, call] of Object.entries(WRITE_CALLS)) {
    it(`${name}: fails with E004 after exactly one attempt`, async () => {
      const events: QueryEvent[] = [];
      const pool = flakyPool(terminated);
      await assert.rejects(call(qi(pool, events)), ConnectionError);
      assert.equal(pool.sent, 1, 'a lost write may have committed; sending it again could apply it twice');
      assert.equal(
        events.some((e) => e.retried),
        false,
      );
    });
  }
});

// ---------------------------------------------------------------------------
// openCheckout: BEGIN on a dead connection
// ---------------------------------------------------------------------------

/** A pool that lends out clients whose first query does what `behaviours[i]` says. */
function checkoutPool(behaviours: Array<'dead' | 'ok' | 'refuse'>) {
  const released: Array<unknown> = [];
  let lent = 0;
  const pool = {
    get lent() {
      return lent;
    },
    released,
    connect(): Promise<PgCompatPoolClient> {
      const behaviour = behaviours[lent++] ?? 'ok';
      const client = {
        query: () =>
          behaviour === 'dead'
            ? Promise.reject(terminated())
            : behaviour === 'refuse'
              ? Promise.reject(pgError('E_GATE', 'transaction gate timed out'))
              : Promise.resolve({ rows: [], rowCount: 0 }),
        release: (err?: unknown) => released.push(err),
      };
      return Promise.resolve(client as unknown as PgCompatPoolClient);
    },
  };
  return pool;
}

describe('openCheckout: an opening statement that hit a dead connection runs again on a fresh one', () => {
  const begin = (c: PgCompatPoolClient) => c.query('BEGIN');

  it('destroys the dead connection and opens on the next', async () => {
    const pool = checkoutPool(['dead', 'ok']);
    const { checkout } = await openCheckout(pool as unknown as PgCompatPool, begin);
    assert.equal(pool.lent, 2);
    assert.equal(pool.released.length, 1);
    assert.ok(pool.released[0] instanceof Error, 'released WITH the error, so pg-pool destroys it');
    checkout.release();
    assert.deepEqual(pool.released.slice(1), [undefined]);
  });

  it('once: a second dead connection fails, with both released', async () => {
    const pool = checkoutPool(['dead', 'dead', 'ok']);
    await assert.rejects(openCheckout(pool as unknown as PgCompatPool, begin), /administrator command/);
    assert.equal(pool.lent, 2);
    assert.equal(pool.released.length, 2);
  });

  it('any other failure is not retried, and the connection goes back to the pool', async () => {
    const pool = checkoutPool(['refuse', 'ok']);
    await assert.rejects(openCheckout(pool as unknown as PgCompatPool, begin), /gate timed out/);
    assert.equal(pool.lent, 1);
    assert.deepEqual(pool.released, [undefined]);
  });
});
