/** Driver doubles exercise lifecycle faults, not live-engine certification. */
import assert from 'node:assert/strict';
import { EventEmitter, getEventListeners } from 'node:events';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';
import { setTimeout as delay, setImmediate as nextTurn } from 'node:timers/promises';
import { TurbineClient } from '../client.js';
import { ConnectionError, TimeoutError, UnsupportedFeatureError, ValidationError } from '../errors.js';
import { MssqlPool, mssqlDialect } from '../mssql.js';
import { MysqlPool, mysqlDialect } from '../mysql.js';
import type { PgCompatPoolClient } from '../pg-types.js';
import { watchStreamConnection } from '../query/stream-idle.js';
import type { SchemaMetadata } from '../schema.js';
import { TransactionState } from '../transaction-state.js';
import { createTransactionPool, guardTransactionConnection } from '../transaction-transport.js';
import { mockTable } from './helpers.js';

const schema: SchemaMetadata = {
  tables: {
    items: mockTable('items', [
      { name: 'id', field: 'id', pgType: 'int' },
      { name: 'is_enabled', field: 'isEnabled', pgType: 'boolean' },
      { name: 'prefs', field: 'prefs', pgType: 'json' },
      { name: 'huge', field: 'huge', pgType: 'bigint' },
      { name: 'payload', field: 'payload', pgType: 'bytea' },
    ]),
  },
  enums: {},
};
const total = 3507;
const rowAt = (id: number, mysql = false) => ({
  id,
  is_enabled: mysql ? id % 2 : id % 2 === 1,
  prefs: mysql ? { id } : JSON.stringify({ id }),
  huge: '9007199254740993',
  payload: Buffer.from([id % 256, 0, 255]),
});

function mysqlFixture(options: { onStream?: () => void } = {}) {
  let produced = 0;
  let discarded = 0;
  let released = 0;
  let ended = 0;
  let wireActive = false;
  let hold = false;
  let failAt = 0;
  let command: EventEmitter | undefined;
  const calls: { sql: string; values?: unknown }[] = [];
  let paused = false;
  let step: (() => void) | undefined;
  const makeCommand = (sql: string, values?: unknown) => {
    calls.push({ sql, values });
    wireActive = true;
    options.onStream?.();
    const native = new EventEmitter();
    command = native;
    let n = 0;
    let finished = false;
    let scheduled = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      wireActive = false;
      native.emit('end');
    };
    const pump = () => {
      if (scheduled || finished || paused || hold) return;
      scheduled = true;
      setImmediate(() => {
        scheduled = false;
        if (finished || paused || hold) return;
        if (n === total) {
          finish();
          return;
        }
        produced++;
        n++;
        if (n === failAt) {
          native.emit('error', new Error('native row failure'));
          return;
        }
        native.emit('result', rowAt(n, true));
        pump();
      });
    };
    step = pump;
    paused = false;
    queueMicrotask(() => {
      native.emit('fields', [
        { name: 'is_enabled', columnType: 1, columnLength: 1 },
        { name: 'id', columnType: 8, columnLength: 20 },
      ]);
      pump();
    });
    native.on('destroy-checkout', finish);
    return native;
  };
  const raw = {
    query: makeCommand,
    execute: makeCommand,
    pause() {
      paused = true;
    },
    resume() {
      paused = false;
      step?.();
    },
    destroy() {
      if (!discarded) {
        discarded++;
        command?.emit('destroy-checkout');
      }
    },
  };
  const connection = {
    connection: raw,
    async query(sql: string) {
      calls.push({ sql });
      return [[], []] as [unknown, unknown];
    },
    async execute() {
      throw new Error('native streams must not call promise execute or materialize rows');
    },
    release() {
      assert.equal(wireActive, false, 'pool release with an active result leaks protocol state');
      released++;
    },
  };
  const pool = new MysqlPool({
    async getConnection() {
      return connection;
    },
    async query() {
      throw new Error('native streams must not materialize through the pool');
    },
    async execute() {
      throw new Error('native streams must not materialize through the pool');
    },
    async end() {
      ended++;
    },
  });
  return {
    pool,
    calls,
    raw,
    secondResultSet() {
      command?.emit('fields', [{ name: 'id', columnType: 1, columnLength: 1 }]);
    },
    hold() {
      hold = true;
    },
    failAt(n: number) {
      failAt = n;
    },
    get produced() {
      return produced;
    },
    get discarded() {
      return discarded;
    },
    get released() {
      return released;
    },
    get ended() {
      return ended;
    },
    get wireActive() {
      return wireActive;
    },
  };
}

function mssqlFixture(options: { hold?: boolean; ignorePause?: boolean; failAt?: number; onStream?: () => void } = {}) {
  let produced = 0;
  let cancelled = 0;
  let settled = 0;
  let poolClosed = 0;
  let begun = 0;
  let committed = 0;
  let rolledBack = 0;
  let active = 0;
  const parents: unknown[] = [];
  const inputs: unknown[][] = [];
  const texts: string[] = [];
  const requests: EventEmitter[] = [];
  class Request extends EventEmitter {
    stream = false;
    private paused = false;
    private done = false;
    private cancelling = false;
    private n = 0;
    private finishQuery?: () => void;
    constructor(parent: unknown) {
      super();
      parents.push(parent);
      requests.push(this);
    }
    input(...args: unknown[]) {
      inputs.push(args);
      return this;
    }
    async batch() {
      return { recordset: [] };
    }
    async query(text: string) {
      texts.push(text);
      if (!this.stream) return { recordset: [{ ok: 9 }] };
      active++;
      options.onStream?.();
      return new Promise<{ recordset: never[] }>((resolve) => {
        this.finishQuery = () => {
          if (!this.done) {
            this.done = true;
            active--;
            settled++;
            resolve({ recordset: [] });
          }
        };
        queueMicrotask(() => {
          this.emit('recordset', {
            id: { type: { declaration: 'bigint' } },
            huge: { type: { declaration: 'bigint' } },
          });
          this.pump();
        });
      });
    }
    private pump() {
      if (this.done || this.cancelling || options.hold || (this.paused && !options.ignorePause)) return;
      while (this.n < total && (!this.paused || options.ignorePause) && !this.done && !this.cancelling) {
        this.n++;
        produced++;
        if (this.n === options.failAt) {
          this.emit('error', Object.assign(new Error('request row failure'), { number: 1205 }));
          this.finishQuery?.();
          return;
        }
        this.emit('row', { ...rowAt(this.n), id: String(this.n) });
      }
      if (this.n === total) this.finishQuery?.();
    }
    pause() {
      this.paused = true;
      return true;
    }
    resume() {
      this.paused = false;
      queueMicrotask(() => this.pump());
      return true;
    }
    cancel() {
      if (!this.done && !this.cancelling) {
        this.cancelling = true;
        cancelled++;
        setImmediate(() => {
          this.emit('error', new Error('request cancelled'));
          this.finishQuery?.();
        });
      }
      return true;
    }
  }
  class Transaction {
    async begin() {
      begun++;
    }
    async commit() {
      assert.equal(active, 0, 'commit must await stream cancellation');
      committed++;
    }
    async rollback() {
      assert.equal(active, 0, 'rollback must await stream cancellation');
      rolledBack++;
    }
  }
  const raw = {
    async connect() {
      return this;
    },
    request() {
      return new Request(this);
    },
    async close() {
      poolClosed++;
    },
  };
  const ns = {
    Request,
    Transaction,
    ISOLATION_LEVEL: {},
    BigInt: 'BIGINT',
    DateTime2: (n: number) => `DATETIME2(${n})`,
  };
  const pool = new MssqlPool(
    raw as unknown as ConstructorParameters<typeof MssqlPool>[0],
    ns as unknown as ConstructorParameters<typeof MssqlPool>[1],
  );
  return {
    pool,
    inputs,
    texts,
    parents,
    Transaction,
    Request,
    secondResultSet() {
      requests.at(-1)?.emit('recordset', { id: { type: { declaration: 'nvarchar' } } });
    },
    get produced() {
      return produced;
    },
    get cancelled() {
      return cancelled;
    },
    get settled() {
      return settled;
    },
    get active() {
      return active;
    },
    get poolClosed() {
      return poolClosed;
    },
    get begun() {
      return begun;
    },
    get committed() {
      return committed;
    },
    get rolledBack() {
      return rolledBack;
    },
  };
}

describe('MySQL native stream driver lifecycle', () => {
  it('consumes bounded rows, binds named values and decodes booleans, without promise materialization', async () => {
    const f = mysqlFixture();
    const c = await f.pool.connect();
    const stream = mysqlDialect.openStream(c, 'SELECT * FROM items WHERE id > $1', [0], 7);
    const first = (await stream.next()).value!;
    assert.equal(first.length, 7);
    assert.equal(first[0]!.is_enabled, true);
    assert.equal(first[1]!.is_enabled, false);
    assert.equal(first[0]!.huge, '9007199254740993');
    assert.deepEqual(f.calls[0], { sql: 'SELECT * FROM items WHERE id > :p1', values: { p1: 0 } });
    await delay(5);
    assert.ok(f.produced <= 8 && f.produced >= 7, `produced ${f.produced} for seven requested rows`);
    await stream.return(undefined);
    assert.equal(f.discarded, 1);
    assert.equal(f.wireActive, false);
    c.release();
    c.release();
    assert.equal(f.released, 0, 'a destroyed connection must never go back into the pool');
    assert.equal(f.ended, 0, 'a stream must not close its borrowed pool');
  });

  it('full drain has exact ordered effects and returns a reusable checkout', async () => {
    const f = mysqlFixture();
    const c = await f.pool.connect();
    let expected = 1;
    let batches = 0;
    for await (const batch of c.streamBatches!('SELECT * FROM items', [], 113)) {
      batches++;
      assert.ok(batch.length > 0 && batch.length <= 113);
      for (const row of batch) assert.equal(row.id, expected++);
    }
    assert.equal(expected - 1, total);
    assert.equal(batches, Math.ceil(total / 113));
    assert.equal(f.produced, total);
    assert.equal(f.discarded, 0);
    await c.query('SELECT 1');
    c.release();
    assert.equal(f.released, 1);
  });

  it('same-handle overlap refuses before any query reaches the driver', async () => {
    const f = mysqlFixture();
    const c = await f.pool.connect();
    const stream = c.streamBatches!('SELECT * FROM items', [], 3);
    await stream.next();
    await assert.rejects(c.query('SELECT 8'), ValidationError);
    await assert.rejects(c.streamBatches!('SELECT 9', [], 3).next(), ValidationError);
    assert.equal(f.calls.length, 1);
    await stream.return(undefined);
    c.release();
  });

  it('ordinary transaction early break drains bounded wire state and preserves the session until commit', async () => {
    const f = mysqlFixture();
    const c = await f.pool.connect();
    await c.query('START TRANSACTION');
    const stream = c.streamBatches!('SELECT * FROM items', [], 5);
    await stream.next();
    await stream.return(undefined);
    assert.equal(f.produced, total, 'MySQL preserves the session by discarding the remaining wire rows');
    assert.equal(f.discarded, 0);
    await c.query('SELECT 3');
    await c.query('COMMIT');
    assert.deepEqual(
      f.calls.map((call) => call.sql),
      ['START TRANSACTION', 'SELECT * FROM items', 'SELECT 3', 'COMMIT'],
    );
    c.release();
    assert.equal(f.released, 1);
  });

  for (const mode of ['abort', 'release'] as const) {
    it(`${mode} wakes a pending first pull and prevents connection reuse`, async () => {
      const f = mysqlFixture();
      f.hold();
      const c = await f.pool.connect();
      const controller = new AbortController();
      const reason = new Error('stop pending read');
      const stream = c.streamBatches!('SELECT * FROM items', [], 3, controller.signal);
      const pending = stream.next();
      await delay(1);
      if (mode === 'abort') controller.abort(reason);
      else c.release();
      await assert.rejects(pending, mode === 'abort' ? (error) => error === reason : ConnectionError);
      assert.equal(f.discarded, 1);
      assert.equal(f.produced, 0);
      await assert.rejects(c.query('COMMIT'), ConnectionError);
      await stream.return(undefined);
      c.release();
      assert.equal(f.released, 0);
    });
  }

  it('row failure preserves the original error and discards its checkout', async () => {
    const f = mysqlFixture();
    f.failAt(4);
    const c = await f.pool.connect();
    await assert.rejects(c.streamBatches!('SELECT * FROM items', [], 9).next(), /native row failure/);
    c.release();
    assert.equal(f.discarded, 1);
    assert.equal(f.released, 0);
  });

  it('abandoned transaction streams close before COMMIT, and late pulls cannot use their rows', async () => {
    const f = mysqlFixture();
    const c = await f.pool.connect();
    await c.query('START TRANSACTION');
    const stream = c.streamBatches!('SELECT * FROM items', [], 3);
    await stream.next();
    await c.query('COMMIT');
    assert.equal(f.wireActive, false);
    await assert.rejects(stream.next(), ValidationError);
    c.release();
    assert.equal(f.released, 1);
  });
});

describe('SQL Server native stream driver lifecycle', () => {
  it('pauses production at batch size, binds typed inputs and decodes only BIGINT columns', async () => {
    const f = mssqlFixture();
    const c = await f.pool.connect();
    const date = new Date('2025-01-01T00:00:00.999Z');
    const stream = mssqlDialect.openStream(c, 'SELECT * FROM items WHERE id > $1 AND happened_at > $2', [1n, date], 7);
    const first = (await stream.next()).value!;
    assert.equal(first.length, 7);
    assert.equal(first[0]!.id, 1);
    assert.equal(first[0]!.huge, '9007199254740993');
    assert.equal(first[0]!.prefs, '{"id":1}', 'adapter must leave JSON parsing to the row parser');
    assert.deepEqual(f.inputs, [
      ['p1', 'BIGINT', 1n],
      ['p2', 'DATETIME2(7)', date],
    ]);
    assert.match(f.texts[0]!, /id > @p1 AND happened_at > @p2/);
    await delay(5);
    assert.equal(f.produced, 7);
    await stream.return(undefined);
    assert.ok(f.cancelled > 0);
    assert.equal(f.settled, 1);
    assert.equal(f.active, 0);
    assert.equal(f.produced, 7, 'cancel must not drain the rest of a SQL Server request');
    assert.deepEqual((await c.query('SELECT 9')).rows, [{ ok: 9 }]);
    c.release();
    assert.equal(f.poolClosed, 0);
  });

  it('full drain returns exact ordered batches without cancellation', async () => {
    const f = mssqlFixture();
    const c = await f.pool.connect();
    let expected = 1;
    let batches = 0;
    for await (const batch of c.streamBatches!('SELECT * FROM items', [], 113)) {
      batches++;
      assert.ok(batch.length > 0 && batch.length <= 113);
      for (const row of batch) assert.equal(row.id, expected++);
    }
    assert.equal(expected - 1, total);
    assert.equal(batches, Math.ceil(total / 113));
    assert.equal(f.produced, total);
    assert.equal(f.cancelled, 0);
    assert.equal(f.active, 0);
    c.release();
  });

  it('same-handle overlap refuses without issuing a second request', async () => {
    const f = mssqlFixture();
    const c = await f.pool.connect();
    const stream = c.streamBatches!('SELECT * FROM items', [], 3);
    await stream.next();
    await assert.rejects(c.query('SELECT 8'), ValidationError);
    await assert.rejects(c.streamBatches!('SELECT 9', [], 3).next(), ValidationError);
    assert.equal(f.texts.length, 1);
    await stream.return(undefined);
    c.release();
  });

  for (const mode of ['abort', 'release'] as const) {
    it(`${mode} cancels a pending acquisition/read and awaits request settlement`, async () => {
      const f = mssqlFixture({ hold: true });
      const c = await f.pool.connect();
      const controller = new AbortController();
      const reason = new Error('stop pending SQL Server read');
      const stream = c.streamBatches!('SELECT * FROM items', [], 3, controller.signal);
      const pending = stream.next();
      await delay(1);
      if (mode === 'abort') controller.abort(reason);
      else c.release();
      await assert.rejects(pending, mode === 'abort' ? (error) => error === reason : ValidationError);
      assert.ok(f.cancelled > 0);
      assert.equal(f.active, 0);
      assert.equal(f.settled, 1);
      assert.equal(f.produced, 0);
      c.release();
    });
  }

  it('a driver ignoring pause fails its bound rather than accumulating hidden rows', async () => {
    const f = mssqlFixture({ ignorePause: true });
    const c = await f.pool.connect();
    await assert.rejects(c.streamBatches!('SELECT * FROM items', [], 7).next(), /backpressure/);
    assert.equal(f.active, 0);
    assert.ok(f.cancelled > 0);
    c.release();
  });

  it('request errors keep engine classification and settle before reuse', async () => {
    const f = mssqlFixture({ failAt: 4 });
    const c = await f.pool.connect();
    await assert.rejects(
      c.streamBatches!('SELECT * FROM items', [], 9).next(),
      (error) => error instanceof Error && (error as Error & { code?: string }).code === '40P01',
    );
    assert.equal(f.active, 0);
    assert.deepEqual((await c.query('SELECT 9')).rows, [{ ok: 9 }]);
    c.release();
  });

  it('transaction-owned requests cancel before commit and retain the driver Transaction parent', async () => {
    const f = mssqlFixture();
    const c = await f.pool.connect();
    await c.query('BEGIN TRANSACTION');
    const stream = c.streamBatches!('SELECT * FROM items', [], 7);
    await stream.next();
    assert.ok(f.parents[0] instanceof f.Transaction);
    await c.query('COMMIT');
    assert.equal(f.committed, 1);
    assert.equal(f.rolledBack, 0);
    assert.equal(f.active, 0);
    await assert.rejects(stream.next(), ValidationError);
    c.release();
  });
});

describe('network stream shared integration', () => {
  for (const [engine, fixture, dialect] of [
    ['mysql', mysqlFixture, mysqlDialect],
    ['mssql', mssqlFixture, mssqlDialect],
  ] as const) {
    it(`${engine}: refuses query-only fallback and invalid native batches without materializing`, async () => {
      let called = false;
      const connection = {
        query: async () => {
          called = true;
          return { rows: [] };
        },
      };
      await assert.rejects(dialect.openStream(connection, 'SELECT 1', [], 1).next(), UnsupportedFeatureError);
      assert.equal(called, false);
      const f = fixture();
      const c = await f.pool.connect();
      for (const size of [0, -1, NaN, Infinity, 1.5]) {
        await assert.rejects(c.streamBatches!('SELECT 1', [], size).next(), ValidationError);
      }
      const controller = new AbortController();
      const reason = new Error('already aborted');
      controller.abort(reason);
      await assert.rejects(c.streamBatches!('SELECT 1', [], 3, controller.signal).next(), (error) => error === reason);
      c.release();
    });

    it(`${engine}: public batches decode field names, JSON and bytes and idle expiry releases native work`, async () => {
      const f = fixture();
      const db = new TurbineClient(
        { pool: f.pool, dialect, logger: {}, streamIdleTimeoutMs: 12, warnOnUnlimited: false },
        schema,
      );
      const stream = db.table<Record<string, unknown>>('items').findManyStreamBatches({ batchSize: 1001 });
      const first = (await stream.next()).value!;
      assert.equal(first.length, 1001);
      assert.deepEqual(first[0], {
        id: 1,
        isEnabled: true,
        prefs: { id: 1 },
        huge: '9007199254740993',
        payload: Buffer.from([1, 0, 255]),
      });
      await delay(50);
      await assert.rejects(stream.next(), TimeoutError);
      if ('wireActive' in f) assert.equal(f.wireActive, false);
      else assert.equal(f.active, 0);
      await stream.return(undefined);
      await db.disconnect();
    });

    it(`${engine}: transaction callback end refuses buffered rows and lazy streams cannot start afterward`, async () => {
      const f = fixture();
      const db = new TurbineClient({ pool: f.pool, dialect, logger: {}, warnOnUnlimited: false }, schema);
      let stream: AsyncGenerator<Record<string, unknown>, void, undefined> | undefined;
      let lazy: AsyncGenerator<Record<string, unknown>[], void, undefined> | undefined;
      await db.$transaction(async (tx) => {
        stream = tx.table<Record<string, unknown>>('items').findManyStream({ batchSize: 1001 });
        assert.equal((await stream.next()).value!.id, 1);
        lazy = tx.table<Record<string, unknown>>('items').findManyStreamBatches({ batchSize: 1001 });
      });
      await assert.rejects(stream!.next(), ValidationError);
      await assert.rejects(lazy!.next(), ValidationError);
      await stream!.return(undefined);
      await db.disconnect();
    });

    it(`${engine}: a native pull cannot overlap an earlier ordinary statement`, async () => {
      const f = fixture();
      const c = await f.pool.connect();
      const query = c.query('SELECT 9');
      await assert.rejects(c.streamBatches!('SELECT * FROM items', [], 3).next(), ValidationError);
      await query;
      assert.equal(f.produced, 0);
      c.release();
    });

    it(`${engine}: abort at a suspended batch frees native ownership and detaches the signal`, async () => {
      const f = fixture();
      const c = await f.pool.connect();
      const controller = new AbortController();
      const reason = new Error('abort between pulls');
      const stream = c.streamBatches!('SELECT * FROM items', [], 7, controller.signal);
      await stream.next();
      assert.ok(getEventListeners(controller.signal, 'abort').length > 0);
      controller.abort(reason);
      // The fixture acknowledges cancellation in the check phase. A short
      // timer can run before that phase when the full suite is under load.
      await nextTurn();
      assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
      if (engine === 'mssql') assert.deepEqual((await c.query('SELECT 9')).rows, [{ ok: 9 }]);
      else await assert.rejects(c.query('SELECT 9'), ConnectionError);
      await assert.rejects(stream.next(), (error) => error === reason);
      await stream.return(undefined);
      c.release();
    });

    it(`${engine}: multiple result sets refuse rather than crossing row/metadata boundaries`, async () => {
      const f = fixture();
      const c = await f.pool.connect();
      const stream = c.streamBatches!('SELECT * FROM items', [], 7);
      await stream.next();
      f.secondResultSet();
      await assert.rejects(stream.next(), UnsupportedFeatureError);
      c.release();
    });

    it(`${engine}: missing native cancellation primitives refuse before executing a request`, async () => {
      const f = fixture();
      if ('raw' in f) Object.defineProperty(f.raw, 'destroy', { value: undefined });
      else Object.defineProperty(f.Request.prototype, 'cancel', { value: undefined });
      const c = await f.pool.connect();
      await assert.rejects(c.streamBatches!('SELECT * FROM items', [], 7).next(), UnsupportedFeatureError);
      assert.equal(f.produced, 0);
      c.release(true);
    });

    it(`${engine}: consumer throw closes the native producer after entering a real batch`, async () => {
      const f = fixture();
      const c = await f.pool.connect();
      let entered = false;
      await assert.rejects(async () => {
        for await (const batch of c.streamBatches!('SELECT * FROM items', [], 7)) {
          entered = true;
          assert.equal(batch.length, 7);
          throw new Error('consumer stopped');
        }
      }, /consumer stopped/);
      assert.equal(entered, true);
      if ('wireActive' in f) assert.equal(f.wireActive, false);
      else assert.equal(f.active, 0);
      c.release();
    });

    it(`${engine}: savepoint completion closes native rows while the parent transaction continues`, async () => {
      const f = fixture();
      const db = new TurbineClient({ pool: f.pool, dialect, logger: {}, warnOnUnlimited: false }, schema);
      await db.$transaction(async (tx) => {
        let stream: AsyncGenerator<Record<string, unknown>, void, undefined> | undefined;
        await tx.$transaction(async (inner) => {
          stream = inner.table<Record<string, unknown>>('items').findManyStream({ batchSize: 1001 });
          assert.equal((await stream.next()).value!.id, 1);
        });
        await assert.rejects(stream!.next(), ValidationError);
        await stream!.return(undefined);
        await tx.rawUnsafe('SELECT 9');
      });
      await db.disconnect();
    });

    it(`${engine}: transaction timeout closes abandoned native state and refuses late pulls`, async () => {
      const f = fixture();
      const db = new TurbineClient({ pool: f.pool, dialect, logger: {}, warnOnUnlimited: false }, schema);
      let stream: AsyncGenerator<Record<string, unknown>[], void, undefined> | undefined;
      let resume!: () => void;
      const held = new Promise<void>((resolve) => {
        resume = resolve;
      });
      try {
        await assert.rejects(
          db.$transaction(
            async (tx) => {
              stream = tx.$connection().streamBatches!('SELECT * FROM items', [], 3);
              assert.equal((await stream.next()).value!.length, 3);
              await held;
            },
            { timeout: 50 },
          ),
          TimeoutError,
        );
      } finally {
        resume();
      }
      await assert.rejects(stream!.next(), ValidationError);
      await stream!.return(undefined);
      if ('wireActive' in f) assert.equal(f.wireActive, false);
      else assert.equal(f.active, 0);
      await db.disconnect();
    });
  }
});

describe('network adapter signals through generic facades', { timeout: 10000 }, () => {
  const routes = ['pool', 'checkout', 'raw', 'idle', 'idle-pool', 'idle-raw'] as const;
  for (const [engine, dialect] of [
    ['mysql', mysqlDialect],
    ['mssql', mssqlDialect],
  ] as const) {
    for (const route of routes) {
      for (const entry of ['native', 'dialect'] as const) {
        async function setup(hold = false) {
          let started!: () => void;
          const ready = new Promise<void>((resolve) => {
            started = resolve;
          });
          const f =
            engine === 'mysql'
              ? mysqlFixture({ onStream: () => started() })
              : mssqlFixture({ hold, onStream: () => started() });
          if (hold && 'hold' in f) f.hold();
          const c = await f.pool.connect();
          await c.query(dialect.beginStatement());
          const signals: (AbortSignal | undefined)[] = [];
          const native = c.streamBatches!.bind(c);
          c.streamBatches = (...args) => {
            signals.push(args[3]);
            return native(...args);
          };
          const state = new TransactionState(c, dialect);
          const pool = createTransactionPool(c, state, state.rootScope);
          const raw = guardTransactionConnection(c, state, state.rootScope, '$connection()');
          const connection =
            route === 'pool'
              ? pool
              : route === 'checkout'
                ? await pool.connect()
                : route === 'raw'
                  ? raw
                  : watchStreamConnection(
                      route === 'idle-pool' ? pool : route === 'idle-raw' ? raw : c,
                      () => undefined,
                    );
          const open = (signal: AbortSignal) =>
            entry === 'native'
              ? connection.streamBatches!('SELECT * FROM items WHERE id > $1', [0], 3, signal)
              : dialect.openStream(connection, 'SELECT * FROM items WHERE id > $1', [0], 3, {
                  ambientTransaction: true,
                  signal,
                });
          const assertClosed = () => {
            if ('wireActive' in f) assert.equal(f.wireActive, false);
            else assert.equal(f.active, 0);
            assert.equal(state.busy, false);
            assert.equal(state.running, false);
          };
          const assertBorrowed = () => {
            if ('ended' in f) assert.equal(f.ended, 0);
            else assert.equal(f.poolClosed, 0);
          };
          return { f, c, connection, state, signals, ready, open, assertClosed, assertBorrowed };
        }

        it(`${engine} ${route}/${entry}: pre-abort and pending abort reach the adapter with exact identity`, async () => {
          const f = await setup(true);
          const before = new AbortController();
          const preReason = Object.freeze({ stopped: 'before native execution' });
          before.abort(preReason);
          const pre = f.open(before.signal);
          const controller = new AbortController();
          const reason = new Error('stop facade pending pull');
          let stream: ReturnType<typeof f.open> | undefined;
          try {
            await assert.rejects(pre.next(), (error) => error === preReason);
            assert.equal(f.signals[0], before.signal);
            assert.equal(f.f.produced, 0);
            if ('calls' in f.f) assert.equal(f.f.calls.length, 1, 'only BEGIN was sent');
            else assert.equal(f.f.texts.length, 0, 'no request executed');
            stream = f.open(controller.signal);
            const pending = assert.rejects(stream.next(), (error) => error === reason);
            await f.ready;
            assert.equal(f.signals[1], controller.signal);
            assert.equal(f.state.busy, route !== 'idle');
            controller.abort(reason);
            await pending;
            f.assertClosed();
            assert.equal(f.f.produced, 0);
            assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
            if ('discarded' in f.f) {
              assert.equal(f.f.discarded, 1);
              await assert.rejects(f.c.query('COMMIT'), ConnectionError);
            } else {
              assert.equal(f.f.cancelled, 1);
              assert.equal(f.f.settled, 1, 'the pull waits for native request settlement');
              await f.c.query('ROLLBACK');
            }
            f.assertBorrowed();
          } finally {
            controller.abort(reason);
            await pre.return(undefined);
            await stream?.return(undefined);
            f.c.release();
          }
        });

        it(`${engine} ${route}/${entry}: abort between pulls clears adapter ownership and preserves reason`, async () => {
          const f = await setup();
          const controller = new AbortController();
          const reason = Object.freeze({ stopped: 'between native pulls' });
          const stream = f.open(controller.signal);
          try {
            assert.deepEqual(
              (await stream.next()).value!.map((row) => row.id),
              [1, 2, 3],
            );
            assert.equal(f.signals[0], controller.signal);
            controller.abort(reason);
            await assert.rejects(stream.next(), (error) => error === reason);
            f.assertClosed();
            assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
            if ('discarded' in f.f) assert.equal(f.f.discarded, 1);
            else {
              assert.equal(f.f.settled, 1);
              await f.c.query('ROLLBACK');
            }
            f.assertBorrowed();
          } finally {
            controller.abort(reason);
            await stream.return(undefined);
            f.c.release();
          }
        });

        it(`${engine} ${route}/${entry}: early return and transaction completion clean up without releasing the pool`, async () => {
          const f = await setup();
          const controller = new AbortController();
          const stream = f.open(controller.signal);
          let abandoned: ReturnType<typeof f.open> | undefined;
          try {
            assert.equal((await stream.next()).value!.length, 3);
            await stream.return(undefined);
            f.assertClosed();
            assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
            assert.equal(f.signals[0], controller.signal);
            if ('discarded' in f.f) {
              assert.equal(f.f.discarded, 0, 'normal return preserves the transaction checkout');
              assert.equal(f.f.produced, total, 'MySQL return awaits bounded wire drain');
            } else assert.equal(f.f.settled, 1);
            await f.c.query('SELECT 9');
            abandoned = f.open(controller.signal);
            assert.equal((await abandoned.next()).value!.length, 3);
            f.state.end('committed');
            await f.c.query('COMMIT');
            await assert.rejects(abandoned.next(), ValidationError);
            f.assertClosed();
            assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
            if (route === 'checkout') (f.connection as PgCompatPoolClient).release();
            if (route === 'raw')
              assert.throws(() => (f.connection as PgCompatPoolClient).release(), /must not release/);
            f.c.release();
            if ('released' in f.f) assert.equal(f.f.released, 1);
            f.assertBorrowed();
          } finally {
            await stream.return(undefined);
            await abandoned?.return(undefined);
            f.c.release();
          }
        });
      }
    }
  }
});

for (const method of ['findManyStream', 'findManyStreamBatches'] as const) {
  for (const engine of ['mysql', 'mssql'] as const) {
    describe(`${engine}: public ${method} cancellation reaches the native handle`, () => {
      const make = (hold = false, onStream?: () => void) => {
        const f = engine === 'mysql' ? mysqlFixture({ onStream }) : mssqlFixture({ hold, onStream });
        if (hold && 'hold' in f) f.hold();
        const db = new TurbineClient(
          {
            pool: f.pool,
            dialect: engine === 'mysql' ? mysqlDialect : mssqlDialect,
            logger: {},
            warnOnUnlimited: false,
            preparedStatements: false,
          },
          schema,
        );
        return { f, db, table: db.table<{ id: number }>('items') };
      };
      it('pre-abort never starts a native request', async () => {
        const { f, db, table } = make();
        const c = new AbortController();
        const reason = { stop: 'before' };
        c.abort(reason);
        await assert.rejects(table[method]({ signal: c.signal }).next(), (error) => error === reason);
        assert.equal(f.produced, 0);
        if ('cancelled' in f) assert.equal(f.cancelled, 0);
        await db.disconnect();
        if ('poolClosed' in f) assert.equal(f.poolClosed, 0);
      });
      it('pending abort cancels the actual adapter request and settles before the public pull rejects', async () => {
        let start!: () => void;
        const started = new Promise<void>((resolve) => {
          start = resolve;
        });
        const { f, db, table } = make(true, start);
        const c = new AbortController();
        const reason = { stop: 'pending' };
        const stream = table[method]({ signal: c.signal, batchSize: 2 });
        const pending = assert.rejects(stream.next(), (error) => error === reason);
        await started;
        c.abort(reason);
        await pending;
        if ('cancelled' in f) {
          assert.equal(f.cancelled, 1);
          assert.equal(f.active, 0);
          assert.equal(f.settled, 1);
        } else {
          assert.equal(f.discarded, 1);
          assert.equal(f.wireActive, false);
        }
        assert.equal(getEventListeners(c.signal, 'abort').length, 0);
        await stream.return(undefined);
        await db.disconnect();
      });
      it('abort discards buffered rows and closes a suspended stream without another pull', async () => {
        const { f, db, table } = make();
        const c = new AbortController();
        const reason = new Error('buffered abort');
        const stream = table[method]({ signal: c.signal, batchSize: 2 });
        const first = await stream.next();
        assert.equal(first.done, false);
        c.abort(reason);
        await assert.rejects(stream.next(), (error) => error === reason);
        if ('cancelled' in f) {
          assert.equal(f.cancelled, 1);
          assert.equal(f.active, 0);
        } else {
          assert.equal(f.discarded, 1);
          assert.equal(f.wireActive, false);
        }
        assert.equal(getEventListeners(c.signal, 'abort').length, 0);
        await db.disconnect();
      });
      it('transaction return preserves caller work and later saved pulls refuse without another request', async () => {
        const { f, db, table: _table } = make();
        const c = new AbortController();
        let saved: AsyncGenerator<unknown, void, undefined> | undefined;
        await db.$transaction(async (tx) => {
          saved = tx.table<{ id: number }>('items')[method]({ signal: c.signal, batchSize: 2 });
          assert.equal((await saved.next()).done, false);
          await saved.return(undefined);
          if ('active' in f) assert.equal(f.active, 0);
        });
        c.abort();
        assert.deepEqual(await saved!.next(), { done: true, value: undefined });
        if ('committed' in f) assert.equal(f.committed, 1);
        await db.disconnect();
      });
    });
  }
}

it('public cancellation invokes installed SQL Server Request.cancel and awaits its modelled wire acknowledgement', async () => {
  const sql = createRequire(import.meta.url)('mssql');
  let started!: () => void;
  const start = new Promise<void>((resolve) => {
    started = resolve;
  });
  let acknowledge!: () => void;
  let cancels = 0;
  let request: InstanceType<typeof WireRequest> | undefined;
  class WireRequest extends sql.Request {
    constructor(parent: unknown) {
      super(parent);
      request = this;
    }
    _query(_text: string, callback: (error: Error) => void) {
      acknowledge = () => callback(new Error('modelled cancellation ACK'));
      started();
    }
    _cancel() {
      cancels++;
    }
  }
  const raw = {
    connected: true,
    config: {},
    close: async () => {
      throw new Error('borrowed pool close');
    },
  };
  const pool = new MssqlPool(
    raw as unknown as ConstructorParameters<typeof MssqlPool>[0],
    { ...sql, Request: WireRequest } as ConstructorParameters<typeof MssqlPool>[1],
  );
  const db = new TurbineClient({ pool, dialect: mssqlDialect, logger: {}, warnOnUnlimited: false }, schema);
  const c = new AbortController();
  const reason = new Error('installed request abort');
  const stream = db.table('items').findManyStream({ signal: c.signal, batchSize: 2 });
  let answered = false;
  const pending = assert
    .rejects(stream.next(), (error) => error === reason)
    .then(() => {
      answered = true;
    });
  await start;
  assert.equal(request!.cancel, sql.Request.prototype.cancel, 'the real installed cancel method is exercised');
  c.abort(reason);
  await delay(0);
  assert.equal(cancels, 1);
  assert.equal(answered, false, 'public abort must await native request settlement');
  acknowledge();
  await pending;
  await db.disconnect();
  assert.equal(getEventListeners(c.signal, 'abort').length, 0);
});
