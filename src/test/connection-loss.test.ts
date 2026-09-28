/**
 * turbine-orm, surviving a dropped connection (unit, no database)
 *
 * A pg client emits `'error'` when its socket dies, and pg-pool listens only on
 * IDLE clients. Every connection Turbine held across an await (`$transaction`,
 * `transaction()`, nested writes, cursor streams, pipelines, `$listen`, the
 * CLI servers) therefore had no listener, and Node's EventEmitter throws an
 * unheard `'error'`: one database restart exited the application. These tests
 * pin the pieces of the fix that need no database; the live half, which kills
 * real backends with `pg_terminate_backend`, is
 * connection-loss.integration.test.ts.
 *
 * The fakes are real EventEmitters on purpose: an `'error'` emitted with no
 * listener THROWS out of `emit()`, so every "does not crash" assertion below
 * fails loudly the moment a guard goes missing, exactly as the process would.
 */

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { PgCompatPool } from '../client.js';
import { absorbCheckedOutErrors, guardCheckout, guardConnection } from '../connection-guard.js';
import { ConnectionError, explainConnectionLoss, TurbineErrorCode, wrapPgError } from '../errors.js';
import { createSubscription } from '../realtime.js';

class FakeClient extends EventEmitter {
  readonly queries: string[] = [];
  readonly released: Array<Error | boolean | undefined> = [];
  failQuery: Error | undefined;
  async query(sql: string): Promise<{ rows: never[] }> {
    this.queries.push(sql);
    if (this.failQuery) throw this.failQuery;
    return { rows: [] };
  }
  release(err?: Error | boolean): void {
    this.released.push(err);
  }
}

/** pg's own shape for a server-initiated disconnect. */
function adminShutdown(): Error {
  return Object.assign(new Error('terminating connection due to administrator command'), {
    code: '57P01',
    severity: 'FATAL',
  });
}

async function waitFor(predicate: () => boolean, what: string, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('guardCheckout', () => {
  it('turns a fatal error event into a recorded one', () => {
    const client = new FakeClient();
    assert.throws(() => client.emit('error', new Error('boom')), /boom/, 'control: an unguarded client throws');

    const guarded = new FakeClient();
    const checkout = guardCheckout(guarded);
    const err = new Error('Connection terminated unexpectedly');
    assert.doesNotThrow(() => guarded.emit('error', err));
    assert.equal(checkout.lostWith, err);
  });

  it('releases a connection that failed WITH its error, so the pool destroys it', () => {
    const client = new FakeClient();
    const checkout = guardCheckout(client);
    const err = new Error('Connection terminated unexpectedly');
    client.emit('error', err);
    checkout.release();
    assert.deepEqual(client.released, [err]);
  });

  it('an explicit release argument takes precedence over the recorded error', () => {
    const client = new FakeClient();
    const checkout = guardCheckout(client);
    client.emit('error', new Error('lost'));
    const timeout = new Error('timeout');
    checkout.release(timeout);
    assert.deepEqual(client.released, [timeout]);
  });

  it('a live connection sheds the listener on release; a dead one keeps it', () => {
    const live = new FakeClient();
    guardCheckout(live).release();
    assert.equal(live.listenerCount('error'), 0, 'listeners must not pile up across checkouts');
    assert.deepEqual(live.released, [undefined]);

    const dead = new FakeClient();
    const checkout = guardCheckout(dead);
    dead.emit('error', new Error('first'));
    checkout.release();
    // pg emits a second 'error' when the socket finally ends.
    assert.doesNotThrow(() => dead.emit('error', new Error('second')));
    assert.equal(checkout.lostWith?.message, 'first');
  });

  it('release is idempotent', () => {
    const client = new FakeClient();
    const checkout = guardCheckout(client);
    checkout.release();
    checkout.release();
    assert.equal(client.released.length, 1);
  });

  it('calls onLost once, on the first error', () => {
    const client = new FakeClient();
    const seen: string[] = [];
    guardCheckout(client, (err) => seen.push(err.message));
    client.emit('error', new Error('one'));
    client.emit('error', new Error('two'));
    assert.deepEqual(seen, ['one']);
  });

  it('accepts a client with no event surface (HTTP drivers, engine shims)', () => {
    const released: unknown[] = [];
    const checkout = guardCheckout({ release: (e?: Error | boolean) => void released.push(e) });
    checkout.release();
    assert.deepEqual(released, [undefined]);
    assert.doesNotThrow(() => guardConnection({}).detach());
  });
});

describe('absorbCheckedOutErrors', () => {
  it('guards every connection the pool opens', () => {
    const pool = new EventEmitter();
    absorbCheckedOutErrors(pool);
    const client = new FakeClient();
    pool.emit('connect', client);
    assert.doesNotThrow(() => client.emit('error', new Error('lost while checked out')));
  });

  it('leaves a pool with no event surface alone', () => {
    assert.doesNotThrow(() => absorbCheckedOutErrors({ query: async () => ({ rows: [] }) }));
  });
});

describe('wrapPgError: pg connection-loss errors carry no code and are still E004', () => {
  const messages = [
    'Connection terminated unexpectedly',
    'Client has encountered a connection error and is not queryable',
    'Client was closed and is not queryable',
    'Connection terminated',
    'Connection terminated due to connection timeout',
  ];
  for (const message of messages) {
    it(message, () => {
      const raw = new Error(message);
      const wrapped = wrapPgError(raw);
      assert.ok(wrapped instanceof ConnectionError, `"${message}" must become a ConnectionError`);
      assert.equal(wrapped.code, TurbineErrorCode.CONNECTION);
      assert.equal(wrapped.cause, raw);
      assert.match(wrapped.message, new RegExp(message));
    });
  }

  it('does not classify other code-less errors', () => {
    const raw = new Error('Connection terminated unexpectedly, and then something else');
    assert.equal(wrapPgError(raw), raw);
    const other = new Error('some driver bug');
    assert.equal(wrapPgError(other), other);
  });
});

describe('explainConnectionLoss', () => {
  const notQueryable = () => wrapPgError(new Error('Client has encountered a connection error and is not queryable'));

  it('reports the error that killed the connection instead of the follow-on', () => {
    const lostWith = adminShutdown();
    const explained = explainConnectionLoss(notQueryable(), lostWith);
    assert.ok(explained instanceof ConnectionError);
    assert.equal(explained.sqlstate, '57P01');
    assert.match(explained.message, /administrator command/);
  });

  it('leaves an error that already names its cause alone', () => {
    const inFlight = wrapPgError(adminShutdown());
    assert.equal(explainConnectionLoss(inFlight, new Error('Connection terminated unexpectedly')), inFlight);
  });

  it('leaves the caller’s own errors and loss-free runs alone', () => {
    const mine = new Error('validation failed in my callback');
    assert.equal(explainConnectionLoss(mine, adminShutdown()), mine);
    const nq = notQueryable();
    assert.equal(explainConnectionLoss(nq, undefined), nq);
  });
});

describe('$listen connection loss (fake pool)', () => {
  function fakePool(): { pool: PgCompatPool; clients: FakeClient[]; failNext: Error[] } {
    const clients: FakeClient[] = [];
    const failNext: Error[] = [];
    const pool = {
      connect: async () => {
        const fail = failNext.shift();
        if (fail) throw fail;
        const c = new FakeClient();
        clients.push(c);
        return c;
      },
      query: async () => ({ rows: [], rowCount: 0 }),
      end: async () => {},
    } as unknown as PgCompatPool;
    return { pool, clients, failNext };
  }

  it('survives the loss, reconnects, re-LISTENs and resumes delivery', async () => {
    const { pool, clients } = fakePool();
    const got: string[] = [];
    const errors: Error[] = [];
    let reconnects = 0;
    const sub = await createSubscription(
      pool,
      'orders',
      '"orders"',
      (p) => got.push(p),
      () => {},
      {
        reconnect: { initialDelayMs: 1 },
        onError: (e) => errors.push(e),
        onReconnect: () => reconnects++,
      },
    );
    const first = clients[0] as FakeClient;
    first.emit('notification', { channel: 'orders', payload: 'a' });

    assert.doesNotThrow(() => first.emit('error', adminShutdown()));
    assert.equal(errors.length, 1);
    assert.ok(errors[0] instanceof ConnectionError, 'the loss is reported typed');
    assert.equal(first.released.length, 1);
    assert.ok(first.released[0] instanceof Error, 'the dead connection is released WITH an error (destroyed)');

    await waitFor(() => reconnects === 1, 'onReconnect');
    const second = clients[1] as FakeClient;
    assert.deepEqual(second.queries, ['LISTEN "orders"']);
    first.emit('notification', { channel: 'orders', payload: 'stale' });
    second.emit('notification', { channel: 'orders', payload: 'b' });
    assert.deepEqual(got, ['a', 'b']);

    await sub.unsubscribe();
    assert.deepEqual(second.queries, ['LISTEN "orders"', 'UNLISTEN "orders"']);
    assert.deepEqual(second.released, [undefined]);
  });

  it('keeps retrying with backoff while the database is down', async () => {
    const { pool, clients, failNext } = fakePool();
    const errors: string[] = [];
    let reconnects = 0;
    const sub = await createSubscription(
      pool,
      'c',
      '"c"',
      () => {},
      () => {},
      {
        reconnect: { initialDelayMs: 1, maxDelayMs: 4 },
        onError: (e) => errors.push(e.message),
        onReconnect: () => reconnects++,
      },
    );
    failNext.push(new Error('connect ECONNREFUSED'), new Error('connect ECONNREFUSED'));
    (clients[0] as FakeClient).emit('error', new Error('Connection terminated unexpectedly'));
    await waitFor(() => reconnects === 1, 'reconnect after two refused attempts');
    assert.equal(errors.length, 3, 'the loss plus each failed attempt is reported');
    assert.equal(clients.length, 2);
    await sub.unsubscribe();
  });

  it('with reconnect: false, ends the subscription at the first loss', async () => {
    const { pool, clients } = fakePool();
    let closed = 0;
    await createSubscription(
      pool,
      'c',
      '"c"',
      () => {},
      () => closed++,
      {
        reconnect: false,
        onError: () => {},
      },
    );
    (clients[0] as FakeClient).emit('error', new Error('Connection terminated unexpectedly'));
    assert.equal(closed, 1);
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(clients.length, 1, 'no reconnect attempt');
  });

  it('unsubscribe while disconnected cancels the pending reconnect', async () => {
    const { pool, clients } = fakePool();
    let closed = 0;
    const sub = await createSubscription(
      pool,
      'c',
      '"c"',
      () => {},
      () => closed++,
      {
        reconnect: { initialDelayMs: 20 },
        onError: () => {},
      },
    );
    (clients[0] as FakeClient).emit('error', new Error('Connection terminated unexpectedly'));
    await sub.unsubscribe();
    assert.equal(closed, 1);
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(clients.length, 1, 'the cancelled reconnect never ran');
  });

  it('without onError, reports the loss on stderr rather than silently', async () => {
    const { pool, clients } = fakePool();
    const lines: string[] = [];
    const original = console.error;
    console.error = (msg: unknown) => void lines.push(String(msg));
    try {
      const sub = await createSubscription(
        pool,
        'c',
        '"c"',
        () => {},
        () => {},
        { reconnect: { initialDelayMs: 1 } },
      );
      (clients[0] as FakeClient).emit('error', new Error('Connection terminated unexpectedly'));
      await sub.unsubscribe();
    } finally {
      console.error = original;
    }
    assert.equal(lines.length, 1);
    assert.match(lines[0] as string, /\$listen "c".*connection lost.*reconnecting/i);
  });
});

// ---------------------------------------------------------------------------
// Every checkout is guarded: a source scan, so a NEW one cannot ship bare
// ---------------------------------------------------------------------------

describe('every connection Turbine holds is guarded', () => {
  const srcRoot = fileURLToPath(new URL('../', import.meta.url));

  function sourceFiles(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) return entry.name === 'test' ? [] : sourceFiles(full);
      return entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts') ? [full] : [];
    });
  }

  /** Code lines only: a doc comment that mentions `pool.connect()` is not a checkout. */
  function codeLines(text: string): Array<{ n: number; line: string }> {
    return text
      .split('\n')
      .map((line, i) => ({ n: i + 1, line }))
      .filter(({ line }) => !/^\s*(\*|\/\/|\/\*)/.test(line));
  }

  const CHECKOUT = /\bpool\.connect\(\)/;
  const BARE_CLIENT = /\bnew\s+(?:pg\.)?Client\(/;

  it('each pool checkout is guarded, and each bare pg.Client too', () => {
    const problems: string[] = [];
    let checkouts = 0;
    let bareClients = 0;
    for (const file of sourceFiles(srcRoot)) {
      const text = readFileSync(file, 'utf8');
      const lines = text.split('\n');
      const rel = relative(srcRoot, file);
      // A pool Turbine creates and absorbs at construction guards every
      // checkout made from it (the CLI servers).
      const poolAbsorbed = /\babsorbCheckedOutErrors\(/.test(text);
      for (const { n, line } of codeLines(text)) {
        if (CHECKOUT.test(line)) {
          checkouts++;
          const window = lines.slice(n - 1, n + 30).join('\n');
          if (!poolAbsorbed && !/\bguardCheckout\(/.test(window)) {
            problems.push(`${rel}:${n} checks a connection out with no guardCheckout() after it`);
          }
        }
        if (BARE_CLIENT.test(line)) {
          bareClients++;
          const window = lines.slice(n - 1, n + 5).join('\n');
          if (!/\bguardConnection\(/.test(window)) {
            problems.push(`${rel}:${n} opens a bare pg.Client with no guardConnection() right after it`);
          }
        }
      }
    }
    // Anti-vacuous: the scan must actually be finding the sites it guards.
    assert.ok(checkouts >= 10, `expected at least 10 pool checkouts under src/, found ${checkouts}`);
    assert.ok(bareClients >= 9, `expected at least 9 bare pg.Client sites under src/, found ${bareClients}`);
    assert.deepEqual(
      problems,
      [],
      'A connection held across an await needs an error listener, or a database restart exits the process ' +
        '(see src/connection-guard.ts):\n  ' +
        problems.join('\n  '),
    );
  });
});
