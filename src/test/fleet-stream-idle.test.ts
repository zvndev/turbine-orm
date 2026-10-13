/**
 * turbine-orm: the abandoned-stream idle timeout (`streamIdleTimeoutMs` on the
 * client, `idleTimeoutMs` per stream call), without a database.
 *
 * A cursor stream holds a checked-out connection between pulls. A consumer that
 * stops pulling without calling `return()` used to hold it forever: a suspended
 * generator runs no code. These tests drive both stream methods over a fake
 * pool whose connection records every statement, and assert:
 *
 *   - an abandoned stream is closed (CLOSE, COMMIT), its connection released,
 *     `stream-idle-timeout` logged once, the next pull is E002, and a later
 *     `return()` is a no-op;
 *   - a slow but live consumer, per row and per batch, is never closed;
 *   - the speculative single-fetch path and a stream inside `$transaction`
 *     start no timer and send no server-side limit;
 *   - on PostgreSQL the stream's own BEGIN carries the transaction-local
 *     `idle_in_transaction_session_timeout` (never a session SET), and a
 *     keepalive keeps a live per-row consumer's transaction from going idle;
 *   - `0` disables, and a bad value is E003 at construction or before any
 *     statement runs.
 *
 * The live half (real cursor, real server limit) is
 * fleet-stream-idle.integration.test.ts.
 *
 * Run: npx tsx --test src/test/fleet-stream-idle.test.ts
 */

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { describe, it } from 'node:test';
import { TurbineClient } from '../client.js';
import { ConnectionError, TimeoutError, ValidationError, wrapPgError } from '../errors.js';
import type { TurbineLogEntry, TurbineLogger } from '../logger.js';
import { QueryInterface } from '../query/index.js';
import { MAX_STREAM_IDLE_TIMEOUT_MS, streamBackstopStatement } from '../query/stream-idle.js';
import type { SchemaMetadata } from '../schema.js';
import { mockTable } from './helpers.js';

// biome-ignore lint/suspicious/noExplicitAny: the suites drive untyped accessors
type Any = any;

function schema(): SchemaMetadata {
  return { tables: { items: mockTable('items', [{ name: 'id', field: 'id' }]) }, enums: {} };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A checked-out connection that serves FETCHes from `batches` and records every statement. */
class FakeClient extends EventEmitter {
  readonly statements: string[] = [];
  released: unknown[] = [];
  constructor(private readonly batches: Record<string, unknown>[][]) {
    super();
  }
  async query(text: string | { text: string }, _values?: unknown[]): Promise<Any> {
    const sql = typeof text === 'string' ? text : text.text;
    this.statements.push(sql);
    if (sql.startsWith('FETCH')) {
      const rows = this.batches.shift() ?? [];
      return { rows, rowCount: rows.length, command: 'FETCH', fields: [] };
    }
    return { rows: [], rowCount: 0, command: 'SELECT', fields: [] };
  }
  release(err?: unknown): void {
    this.released.push(err ?? 'ok');
  }
}

/**
 * A pool whose plain queries (the speculative fetch) overflow one batch, so a
 * stream always takes the cursor path, and whose `connect()` hands out one
 * {@link FakeClient}.
 */
function fakePool(batches: Record<string, unknown>[][], speculativeRows: number) {
  const client = new FakeClient(batches);
  const plain: string[] = [];
  return {
    client,
    plain,
    pool: {
      query: async (text: string | { text: string }) => {
        plain.push(typeof text === 'string' ? text : text.text);
        const rows = Array.from({ length: speculativeRows }, (_, i) => ({ id: i + 1 }));
        return { rows, rowCount: rows.length, command: 'SELECT', fields: [] };
      },
      connect: async () => client,
    } as Any,
  };
}

/** Three batches of `size` rows. */
function threeBatches(size: number): Record<string, unknown>[][] {
  return [0, 1, 2].map((b) => Array.from({ length: size }, (_, i) => ({ id: b * size + i + 1 })));
}

function recorder(): { logger: TurbineLogger; lines: { level: string; message: string; entry: TurbineLogEntry }[] } {
  const lines: { level: string; message: string; entry: TurbineLogEntry }[] = [];
  const at =
    (level: string) =>
    (message: string, entry: TurbineLogEntry): void => {
      lines.push({ level, message, entry });
    };
  return { logger: { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') }, lines };
}

function itemsInterface(pool: Any, options: Record<string, unknown> = {}): QueryInterface<Record<string, unknown>> {
  return new QueryInterface(pool, 'items', schema(), [], { warnOnUnlimited: false, ...options } as never);
}

const METHODS = [
  ['findManyStream', 'row'],
  ['findManyStreamBatches', 'batch'],
] as const;

describe('stream idle timeout: an abandoned stream is closed', () => {
  for (const [method, unit] of METHODS) {
    it(`${method}: CLOSE, COMMIT, release, one log line, E002 on the next pull, return() is a no-op`, async () => {
      const { pool, client } = fakePool(threeBatches(3), 4);
      const { logger, lines } = recorder();
      const qi = itemsInterface(pool, { logger });
      const it = (qi as Any)[method]({ batchSize: 3, idleTimeoutMs: 40 })[Symbol.asyncIterator]();
      const first = await it.next();
      assert.equal(first.done, false);

      await sleep(120);

      assert.deepEqual(
        client.statements.filter((s) => /^(CLOSE|COMMIT)/.test(s)).map((s) => s.split(' ')[0]),
        ['CLOSE', 'COMMIT'],
        'the cursor is closed and the transaction ended by Turbine, not by the consumer',
      );
      assert.deepEqual(client.released, ['ok'], 'the connection went back to the pool exactly once');
      const logged = lines.filter((l) => l.entry.code === 'stream-idle-timeout');
      assert.equal(logged.length, 1);
      assert.equal(logged[0]!.level, 'warn');
      assert.equal(logged[0]!.entry.table, 'items');
      assert.equal(logged[0]!.entry.operation, method);
      assert.equal(logged[0]!.entry.timeoutMs, 40);
      assert.equal(logged[0]!.entry.rows, method === 'findManyStream' ? 1 : 3);

      await assert.rejects(
        () => it.next(),
        (err: unknown) =>
          err instanceof TimeoutError &&
          err.code === 'TURBINE_E002' &&
          err.timeoutMs === 40 &&
          err.message.includes(`${method} on "items" was closed after 40 ms with no ${unit} requested`),
      );
      await assert.doesNotReject(() => it.return(undefined));
      assert.deepEqual(client.released, ['ok'], 'nothing is released twice');
      assert.equal(client.statements.filter((s) => s.startsWith('FETCH')).length, 1, 'no FETCH after expiry');
    });
  }

  it('a pull that races the cleanup waits for it and still throws E002', async () => {
    const { pool, client } = fakePool(threeBatches(3), 4);
    let closeStarted!: () => void;
    const closing = new Promise<void>((resolve) => {
      closeStarted = resolve;
    });
    const original = client.query.bind(client);
    client.query = async (text: Any, values?: unknown[]) => {
      if (String(text).startsWith('CLOSE')) {
        closeStarted();
        await sleep(30);
      }
      return original(text, values);
    };
    const qi = itemsInterface(pool, { logger: {} });
    const it = qi.findManyStream({ batchSize: 3, idleTimeoutMs: 20 } as never)[Symbol.asyncIterator]();
    await it.next();
    // The guard's timer is unref'd, so something else must keep the loop alive
    // in a test (a real pool's socket does that in an application).
    await Promise.race([closing, sleep(1000)]);
    await assert.rejects(() => it.next(), TimeoutError);
    assert.deepEqual(client.released, ['ok'], 'released after COMMIT, once');
    assert.equal(client.statements.at(-1), 'COMMIT', 'the pull did not cut the cleanup short');
  });
});

describe('stream idle timeout: a live consumer is never closed', () => {
  for (const [method] of METHODS) {
    it(`${method}: one pull per timeout / 2, ten times, drains every row`, async () => {
      const { pool, client } = fakePool(threeBatches(4), 5);
      const qi = itemsInterface(pool, { logger: {} });
      const seen: number[] = [];
      let pulls = 0;
      for await (const item of (qi as Any)[method]({ batchSize: 4, idleTimeoutMs: 40 })) {
        for (const row of Array.isArray(item) ? item : [item]) seen.push(row.id);
        if (++pulls <= 10) await sleep(20);
      }
      assert.deepEqual(
        seen,
        Array.from({ length: 12 }, (_, i) => i + 1),
      );
      assert.deepEqual(client.released, ['ok']);
    });
  }
});

describe('stream idle timeout: what is not watched', () => {
  it('the speculative single-fetch path starts no timer', async () => {
    const { pool, client } = fakePool([], 2);
    const qi = itemsInterface(pool, { logger: {} });
    const realSetInterval = globalThis.setInterval;
    let timers = 0;
    globalThis.setInterval = ((...a: Parameters<typeof setInterval>) => {
      timers++;
      return realSetInterval(...a);
    }) as typeof setInterval;
    try {
      const rows: unknown[] = [];
      for await (const row of qi.findManyStream({ batchSize: 3, idleTimeoutMs: 40 } as never)) rows.push(row);
      for await (const batch of qi.findManyStreamBatches({ batchSize: 3, idleTimeoutMs: 40 } as never))
        rows.push(batch);
      assert.equal(rows.length, 3);
    } finally {
      globalThis.setInterval = realSetInterval;
    }
    assert.equal(timers, 0, 'a stream that holds no connection has nothing to watch');
    assert.equal(client.statements.length, 0, 'no connection was checked out');
  });

  it('0 disables: the cursor path starts no timer and sends no server-side limit', async () => {
    const { pool, client } = fakePool(threeBatches(3), 4);
    const qi = itemsInterface(pool, { logger: {}, streamIdleTimeoutMs: 0 });
    const it = qi.findManyStream({ batchSize: 3 } as never)[Symbol.asyncIterator]();
    await it.next();
    await sleep(60);
    assert.equal(client.statements[0], 'BEGIN', 'no limit rides on BEGIN');
    assert.equal(client.released.length, 0, 'still held: nothing closes a disabled stream');
    await it.return(undefined);
    assert.deepEqual(client.released, ['ok']);
  });

  it('a per-call 0 overrides the client timeout', async () => {
    const { pool, client } = fakePool(threeBatches(3), 4);
    const qi = itemsInterface(pool, { logger: {}, streamIdleTimeoutMs: 20 });
    const it = qi.findManyStream({ batchSize: 3, idleTimeoutMs: 0 } as never)[Symbol.asyncIterator]();
    await it.next();
    await sleep(80);
    assert.equal(client.released.length, 0);
    await it.return(undefined);
  });

  it('inside $transaction: no timer, no server-side limit, no transaction control of its own', async () => {
    const statements: string[] = [];
    const conn = new FakeClient(threeBatches(3));
    const original = conn.query.bind(conn);
    conn.query = async (text: Any, values?: unknown[]) => {
      statements.push(typeof text === 'string' ? text : text.text);
      if (String(typeof text === 'string' ? text : text.text).startsWith('SELECT')) {
        const rows = Array.from({ length: 4 }, (_, i) => ({ id: i + 1 }));
        return { rows, rowCount: 4, command: 'SELECT', fields: [] };
      }
      return original(text, values);
    };
    const pool = { query: async () => ({ rows: [] }), connect: async () => conn, end: async () => {} } as Any;
    const db = new TurbineClient({ pool, logger: {}, warnOnUnlimited: false, streamIdleTimeoutMs: 20 }, schema());
    await db.$transaction(async (tx: Any) => {
      const it = tx.table('items').findManyStream({ batchSize: 3 })[Symbol.asyncIterator]();
      await it.next();
      await sleep(80);
      const more = await it.next();
      assert.equal(more.done, false, 'the stream is still open after 4x the timeout');
      await it.return(undefined);
    });
    assert.equal(
      statements.some((s) => s.includes('idle_in_transaction_session_timeout')),
      false,
      "a caller's transaction limit is theirs to set",
    );
    assert.equal(statements.filter((s) => s === 'BEGIN').length, 1, "only the caller's BEGIN");
  });
});

describe('stream idle timeout: the PostgreSQL server-side limit', () => {
  it("rides on the stream's own BEGIN, transaction-local, at the timeout plus 10 s", async () => {
    const { pool, client } = fakePool(threeBatches(3), 4);
    const qi = itemsInterface(pool, { logger: {}, streamIdleTimeoutMs: 120_000 });
    const it = qi.findManyStream({ batchSize: 3 } as never)[Symbol.asyncIterator]();
    await it.next();
    const begin = client.statements[0]!;
    assert.equal(begin, `BEGIN; ${streamBackstopStatement(120_000)}`);
    assert.match(begin, /set_config\('idle_in_transaction_session_timeout', .*'130000'.*, true\)/);
    assert.doesNotMatch(begin, /\bSET\s+(SESSION\s+)?idle/i, 'never a session SET');
    assert.equal(
      client.statements.filter((s) => s.includes('idle_in_transaction_session_timeout')).length,
      1,
      'sent once per stream',
    );
    await it.return(undefined);
  });

  it('the server ending the session (SQLSTATE 25P03) is a ConnectionError that names the limit', () => {
    const fatal = Object.assign(new Error('terminating connection due to idle-in-transaction timeout'), {
      code: '25P03',
      severity: 'FATAL',
    });
    const wrapped = wrapPgError(fatal);
    assert.ok(wrapped instanceof ConnectionError, 'a session the server ended is a lost connection');
    assert.equal(wrapped.sqlstate, '25P03');
    assert.match(wrapped.message, /idle_in_transaction_session_timeout/);
    assert.match(wrapped.message, /idle timeout plus 10 s/);
  });

  it('the limit is a validated integer, never caller text', () => {
    assert.throws(() => streamBackstopStatement(Number.NaN), ValidationError);
    assert.throws(() => streamBackstopStatement(MAX_STREAM_IDLE_TIMEOUT_MS + 1), ValidationError);
    assert.throws(() => streamBackstopStatement("1'; DROP TABLE x; --" as never), ValidationError);
  });

  it("a slow per-row consumer gets a keepalive, so the server never sees the stream's transaction idle", async () => {
    const { pool, client } = fakePool(threeBatches(50), 51);
    const qi = itemsInterface(pool, { logger: {} });
    let n = 0;
    for await (const _row of qi.findManyStream({ batchSize: 50, idleTimeoutMs: 40 } as never)) {
      if (++n > 12) break;
      await sleep(10); // alive (pulls every 10 ms) but no FETCH for 120 ms
    }
    assert.ok(
      client.statements.filter((s) => s === 'SELECT 1').length >= 1,
      `expected a keepalive while the consumer read one batch for 3x the timeout; got ${JSON.stringify(client.statements)}`,
    );
    assert.deepEqual(client.released, ['ok']);
  });
});

describe('stream idle timeout: validation', () => {
  for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '1000', MAX_STREAM_IDLE_TIMEOUT_MS + 1]) {
    it(`streamIdleTimeoutMs: ${String(bad)} is E003 at construction`, () => {
      assert.throws(
        () =>
          new TurbineClient(
            { pool: { query: async () => ({ rows: [] }) } as Any, streamIdleTimeoutMs: bad as never },
            schema(),
          ),
        (err: unknown) => err instanceof ValidationError && /Invalid streamIdleTimeoutMs/.test(err.message),
      );
    });
  }

  it('a bad per-call idleTimeoutMs is E003 before any statement runs, on both methods', async () => {
    for (const [method] of METHODS) {
      const { pool, client, plain } = fakePool(threeBatches(3), 4);
      const qi = itemsInterface(pool, { logger: {} });
      await assert.rejects(
        async () => {
          for await (const _ of (qi as Any)[method]({ idleTimeoutMs: -5 })) {
            /* never reached */
          }
        },
        (err: unknown) => err instanceof ValidationError && /Invalid idleTimeoutMs: -5/.test(err.message),
      );
      assert.equal(plain.length + client.statements.length, 0, `${method} sent nothing`);
    }
  });

  it('the client option reaches its table accessors', async () => {
    const { pool, client } = fakePool(threeBatches(3), 4);
    const db = new TurbineClient({ pool, logger: {}, warnOnUnlimited: false, streamIdleTimeoutMs: 30 }, schema());
    const it = (db as Any).table('items').findManyStream({ batchSize: 3 })[Symbol.asyncIterator]();
    await it.next();
    await sleep(100);
    assert.deepEqual(client.released, ['ok'], 'expired at the client-level timeout');
    await assert.rejects(() => it.next(), TimeoutError);
  });
});
