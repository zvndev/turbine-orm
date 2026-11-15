import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { describe, it } from 'node:test';
import { setImmediate as turn } from 'node:timers/promises';
import { ConnectionError, TimeoutError, UnsupportedFeatureError, ValidationError } from '../errors.js';
import { mysqlDialect } from '../mysql.js';
import type { PgCompatPool } from '../pg-types.js';
import { QueryInterface } from '../query/index.js';
import { cancellableStreamConnection } from '../query/stream-signal.js';
import type { FindManyStreamArgs } from '../query/types.js';
import type { SchemaMetadata } from '../schema.js';
import { mockTable } from './helpers.js';

const schema: SchemaMetadata = {
  tables: { items: mockTable('items', [{ name: 'id', field: 'id', pgType: 'int' }]) },
  enums: {},
};
const methods = ['findManyStream', 'findManyStreamBatches'] as const;
function fixture(options: { holdClose?: boolean; failClose?: boolean; pending?: boolean } = {}) {
  let releaseClose!: () => void;
  const closeGate = new Promise<void>((resolve) => {
    releaseClose = resolve;
  });
  let start!: () => void;
  const started = new Promise<void>((resolve) => {
    start = resolve;
  });
  let closed = 0;
  let released = 0;
  let connected = 0;
  const releaseErrors: unknown[] = [];
  const sqls: string[] = [];
  const signals: (AbortSignal | undefined)[] = [];
  const client = {
    query: async () => ({ rows: [], rowCount: 0 }),
    release(error?: Error | boolean) {
      released++;
      releaseErrors.push(error);
    },
    async *streamBatches(sql: string, _values: unknown[], size: number, signal?: AbortSignal) {
      signals.push(signal);
      sqls.push(sql);
      start();
      let rejectAbort!: (reason: unknown) => void;
      const onAbort = () => rejectAbort(signal!.reason);
      try {
        signal?.throwIfAborted();
        if (options.pending) {
          const wait = new Promise<never>((_resolve, reject) => {
            rejectAbort = reject;
          });
          signal?.addEventListener('abort', onAbort, { once: true });
          await wait;
        }
        yield Array.from({ length: size }, (_, i) => ({ id: i + 1 }));
        yield [{ id: size + 1 }];
      } finally {
        signal?.removeEventListener('abort', onAbort);
        if (options.holdClose) await closeGate;
        closed++;
        // biome-ignore lint/correctness/noUnsafeFinally: deliberately model a failing driver return().
        if (options.failClose) throw new Error('cleanup failure');
      }
    },
  };
  const pool = {
    ...client,
    query: async (sql: string) => {
      sqls.push(sql);
      return { rows: [{ id: 1 }], rowCount: 1 };
    },
    connect: async () => {
      connected++;
      return client;
    },
    end: async () => {
      throw new Error('borrowed pool must not be closed');
    },
  } as unknown as PgCompatPool;
  const qi = new QueryInterface<{ id: number }>(pool, 'items', schema, undefined, { dialect: mysqlDialect });
  return {
    qi,
    pool,
    sqls,
    signals,
    started,
    releaseClose,
    releaseErrors,
    get closed() {
      return closed;
    },
    get released() {
      return released;
    },
    get connected() {
      return connected;
    },
  };
}

for (const method of methods)
  describe(`${method}: public AbortSignal`, () => {
    for (const reason of [new Error('abort'), { exact: 'reason' }, null, 'stop']) {
      it(`pre-abort preserves ${String(reason)} without a checkout`, async () => {
        const f = fixture();
        const c = new AbortController();
        c.abort(reason);
        await assert.rejects(f.qi[method]({ signal: c.signal }).next(), (error) => error === reason);
        assert.equal(f.connected, 0);
        assert.deepEqual(f.sqls, []);
      });
    }
    it('forwards identical signal, skips speculation, closes without another consumer pull', async () => {
      const f = fixture({ holdClose: true });
      const c = new AbortController();
      const stream = f.qi[method]({ signal: c.signal, batchSize: 2 });
      const first = await stream.next();
      assert.equal(first.done, false);
      assert.deepEqual(f.signals, [c.signal]);
      assert.equal(f.sqls.length, 1);
      const reason = { stop: true };
      c.abort(reason);
      await turn();
      assert.equal(f.released, 0);
      const pending = assert.rejects(stream.next(), (error) => error === reason);
      f.releaseClose();
      await pending;
      assert.equal(f.closed, 1);
      assert.equal(f.released, 1);
      assert.equal(getEventListeners(c.signal, 'abort').length, 0);
      assert.deepEqual(await stream.next(), { done: true, value: undefined });
    });
    it('wakes a pending native pull and awaits asynchronous cleanup', async () => {
      const f = fixture({ pending: true, holdClose: true });
      const c = new AbortController();
      const stream = f.qi[method]({ signal: c.signal, batchSize: 2 });
      const reason = new Error('pending abort');
      let answered = false;
      const pending = assert
        .rejects(stream.next(), (error) => error === reason)
        .then(() => {
          answered = true;
        });
      await f.started;
      c.abort(reason);
      await turn();
      assert.equal(answered, false);
      assert.equal(f.released, 0);
      f.releaseClose();
      await pending;
      assert.equal(f.released, 1);
      assert.equal(f.closed, 1);
    });
    it('consumer return awaits cleanup and makes later abort inert', async () => {
      const f = fixture({ holdClose: true });
      const c = new AbortController();
      const stream = f.qi[method]({ signal: c.signal, batchSize: 2 });
      await stream.next();
      const returning = stream.return(undefined);
      await turn();
      c.abort();
      f.releaseClose();
      await returning;
      assert.equal(f.closed, 1);
      assert.equal(f.released, 1);
      assert.equal(getEventListeners(c.signal, 'abort').length, 0);
      assert.deepEqual(await stream.next(), { done: true, value: undefined });
    });
    it('settled completion removes listeners and preserves all rows', async () => {
      const f = fixture();
      const c = new AbortController();
      const rows: unknown[] = [];
      const stream = f.qi[method]({ signal: c.signal, batchSize: 2 });
      for await (const value of stream) rows.push(...(Array.isArray(value) ? value : [value]));
      assert.deepEqual(rows, [{ id: 1 }, { id: 2 }, { id: 3 }]);
      assert.equal(getEventListeners(c.signal, 'abort').length, 0);
      c.abort();
      assert.deepEqual(await stream.next(), { done: true, value: undefined });
      assert.equal(f.closed, 1);
      assert.equal(f.released, 1);
    });
    it('cleanup failure rejects return and discards the checkout', async () => {
      const f = fixture({ failClose: true });
      const c = new AbortController();
      const stream = f.qi[method]({ signal: c.signal, batchSize: 2 });
      await stream.next();
      await assert.rejects(stream.return(undefined), /cleanup failure/);
      assert.equal(f.closed, 1);
      assert.equal(f.released, 1);
      assert.ok(f.releaseErrors[0] instanceof Error);
    });
    it('idle expiry wins a later abort and cleanup runs once', async () => {
      const f = fixture();
      const c = new AbortController();
      const stream = f.qi[method]({ signal: c.signal, batchSize: 2, idleTimeoutMs: 4 });
      await stream.next();
      // Keep the test alive for the guard's unref timer, with an observable release boundary.
      for (let n = 0; n < 100 && !f.released; n++) await new Promise((r) => setTimeout(r, 2));
      assert.equal(f.released, 1);
      c.abort(new Error('later abort'));
      await assert.rejects(stream.next(), TimeoutError);
      assert.equal(f.closed, 1);
      assert.equal(f.released, 1);
    });
    it('omitting signal retains the ordinary speculative SQL and no checkout', async () => {
      const f = fixture();
      const rows: unknown[] = [];
      for await (const row of f.qi[method]({ batchSize: 2 })) rows.push(row);
      assert.equal(rows.length, 1);
      assert.equal(f.connected, 0);
      assert.match(f.sqls[0]!, /LIMIT 3$/);
      assert.deepEqual(f.signals, []);
    });
    it('refuses malformed signals before checkout', async () => {
      const f = fixture();
      for (const signal of [null, {}, true])
        await assert.rejects(f.qi[method]({ signal } as FindManyStreamArgs<{ id: number }>).next(), ValidationError);
      assert.equal(f.connected, 0);
    });
  });

it('refuses cancellable cursors on query-only PostgreSQL transports', async () => {
  const f = fixture();
  const c = new AbortController();
  const qi = new QueryInterface(f.pool, 'items', schema);
  await assert.rejects(qi.findManyStream({ signal: c.signal }).next(), UnsupportedFeatureError);
  assert.equal(f.connected, 0);
});

it('unconfirmed PostgreSQL cancellation is observable and never reported as confirmed', { timeout: 5000 }, async () => {
  const c = new AbortController();
  const reasons: unknown[] = [];
  let settle!: () => void;
  const target = {
    query: async () => {
      await new Promise<void>((resolve) => {
        settle = resolve;
      });
      return { rows: [] };
    },
  };
  const connection = cancellableStreamConnection(target, target, c.signal, (error) => reasons.push(error));
  const pending = assert.rejects(
    connection.query('FETCH 2 FROM c'),
    (error) => error instanceof ConnectionError && error.cause === c.signal.reason,
  );
  c.abort(new Error('request abort'));
  await pending;
  settle();
  assert.equal(reasons.length, 2);
  assert.equal(getEventListeners(c.signal, 'abort').length, 0);
});

// Compile the same public options against both iterator result shapes.
const typedSignalArgs: FindManyStreamArgs<{ id: number }> = {
  signal: new AbortController().signal,
  select: { id: true },
};
void typedSignalArgs;

for (const method of methods) {
  it(`${method}: abort while waiting for the pool returns its late checkout without SQL`, async () => {
    const f = fixture();
    const c = new AbortController();
    let lend!: () => void;
    const gate = new Promise<void>((resolve) => {
      lend = resolve;
    });
    const connect = f.pool.connect.bind(f.pool);
    f.pool.connect = async () => {
      await gate;
      return connect();
    };
    const stream = f.qi[method]({ signal: c.signal });
    const pending = assert.rejects(stream.next(), (error) => error === c.signal.reason);
    c.abort(new Error('checkout wait abort'));
    await pending;
    assert.equal(f.connected, 0);
    lend();
    await turn();
    assert.equal(f.connected, 1);
    assert.equal(f.released, 1);
    assert.deepEqual(f.sqls, []);
    assert.equal(getEventListeners(c.signal, 'abort').length, 0);
  });
  it(`${method}: consumer failure closes the iterator before reaching the caller`, async () => {
    const f = fixture();
    const c = new AbortController();
    const reason = new Error('consumer failure');
    await assert.rejects(
      async () => {
        for await (const _row of f.qi[method]({ signal: c.signal, batchSize: 2 })) throw reason;
      },
      (error) => error === reason,
    );
    assert.equal(f.closed, 1);
    assert.equal(f.released, 1);
    assert.equal(getEventListeners(c.signal, 'abort').length, 0);
  });
  it(`${method}: abort cleanup failures remain observable on the next consumer pull`, async () => {
    const f = fixture({ failClose: true });
    const c = new AbortController();
    const stream = f.qi[method]({ signal: c.signal, batchSize: 2 });
    await stream.next();
    c.abort(new Error('abort before cleanup failure'));
    await turn();
    assert.equal(f.released, 1);
    await assert.rejects(stream.next(), /cleanup failure/);
    assert.equal(f.closed, 1);
    assert.ok(f.releaseErrors[0] instanceof Error);
  });
}

it('abort starts suspended stream cleanup without any further consumer operation', async () => {
  const f = fixture();
  const c = new AbortController();
  const stream = f.qi.findManyStream({ signal: c.signal, batchSize: 2 });
  await stream.next();
  c.abort(new Error('suspended abort'));
  await turn();
  assert.equal(f.closed, 1);
  assert.equal(f.released, 1);
  await assert.rejects(stream.next(), (error) => error === c.signal.reason);
});
