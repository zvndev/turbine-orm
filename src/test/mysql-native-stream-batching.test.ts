/** Callback driver faults complement the live MySQL stream tests. */
import assert from 'node:assert/strict';
import { EventEmitter, getEventListeners } from 'node:events';
import { describe, it } from 'node:test';
import { ConnectionError, UnsupportedFeatureError } from '../errors.js';
import { MysqlPool } from '../mysql.js';

type Row = Record<string, unknown>;
const flagField = { name: 'flag', columnType: 1, columnLength: 1 };

function fixture(
  options: { total?: number; ignorePause?: boolean; fields?: unknown; errorAt?: number; socket?: boolean } = {},
) {
  const total = options.total ?? 17;
  let produced = 0;
  let paused = false;
  let destroyed = 0;
  let socketDestroyed = 0;
  let released = 0;
  let command: EventEmitter;
  const wire = new EventEmitter();
  let active = false;
  const failure: Error & { errno: number; code?: string } = Object.assign(new Error('native wire failure'), {
    errno: 1213,
  });
  const calls: string[] = [];
  const pump = () => {
    while (active && (!paused || options.ignorePause)) {
      if (produced === total) {
        active = false;
        command.emit('end');
        break;
      }
      produced++;
      if (produced === options.errorAt) {
        active = false;
        command.emit('error', failure);
        break;
      }
      command.emit('result', { id: produced, flag: produced % 3 });
    }
  };
  const start = (sql: string) => {
    calls.push(sql);
    produced = 0;
    paused = false;
    active = true;
    command = new EventEmitter();
    queueMicrotask(() => {
      if ('fields' in options) command.emit('fields', options.fields);
      else command.emit('fields', [flagField]);
      pump();
    });
    return command;
  };
  const pool = new MysqlPool({
    async getConnection() {
      return {
        connection: {
          on: wire.on.bind(wire),
          removeListener: wire.removeListener.bind(wire),
          query: start,
          execute: start,
          pause() {
            paused = true;
          },
          resume() {
            paused = false;
            pump();
          },
          destroy() {
            destroyed++;
            active = false;
          },
          ...(options.socket
            ? {
                stream: {
                  destroy() {
                    socketDestroyed++;
                    active = false;
                  },
                },
              }
            : {}),
        },
        async query(sql: string) {
          assert.equal(active, false, 'transaction control must await the native remainder');
          calls.push(sql);
          return [[], []];
        },
        async execute() {
          throw new Error('promise materialization is forbidden');
        },
        release() {
          assert.equal(active, false);
          released++;
        },
      };
    },
    async query() {
      throw new Error('pool materialization is forbidden');
    },
    async execute() {
      throw new Error('pool materialization is forbidden');
    },
    async end() {
      throw new Error('borrowed pool ownership must be preserved');
    },
  });
  return {
    pool,
    calls,
    failure,
    get produced() {
      return produced;
    },
    get destroyed() {
      return destroyed;
    },
    get socketDestroyed() {
      return socketDestroyed;
    },
    get released() {
      return released;
    },
    emit(event: string, value?: unknown) {
      command.emit(event, value);
    },
    wireError(error: unknown) {
      active = false;
      wire.emit('error', error);
    },
    get wireListeners() {
      return wire.listenerCount('error');
    },
  };
}

describe('MySQL native stream batch delivery', () => {
  for (const total of [0, 1, 6, 7, 8, 21, 23]) {
    it(`drains ${total} synchronous callback rows with exact bounds and retained batches`, async () => {
      const f = fixture({ total });
      const c = await f.pool.connect();
      const batches: Row[][] = [];
      const stream = c.streamBatches!('SELECT * FROM items', [], 7);
      for await (const batch of stream) {
        assert.ok(batch.length > 0 && batch.length <= 7);
        batches.push(batch);
        assert.equal(f.produced, batches.flat().length, 'no next batch is decoded while the consumer is suspended');
        await Promise.resolve();
        assert.equal(f.produced, batches.flat().length);
      }
      assert.deepEqual(
        batches.flat().map((row) => row.id),
        Array.from({ length: total }, (_, i) => i + 1),
      );
      assert.deepEqual(
        batches.flat().map((row) => row.flag),
        Array.from({ length: total }, (_, i) => [false, true, 2][(i + 1) % 3]),
      );
      assert.equal(batches.length, Math.ceil(total / 7));
      assert.equal(f.destroyed, 0);
      assert.equal(f.wireListeners, 0, 'healthy checkouts must not retain stream error listeners');
      c.release();
      assert.equal(f.released, 1);
    });
  }

  it('refuses a driver that ignores pause instead of accumulating unbounded rows', async () => {
    const f = fixture({ total: 10000, ignorePause: true });
    const c = await f.pool.connect();
    await assert.rejects(c.streamBatches!('SELECT * FROM items', [], 7).next(), /backpressure/);
    assert.equal(f.produced, 8);
    assert.equal(f.destroyed, 1);
    c.release();
    assert.equal(f.released, 0);
  });

  it('uses each execution metadata, including duplicate aliases and non-boolean expressions', async () => {
    const fields = [flagField, { name: 'flag', columnType: 8, columnLength: 20 }];
    const f = fixture({ total: 1, fields });
    const c = await f.pool.connect();
    const read = async () => {
      const rows: Row[] = [];
      for await (const batch of c.streamBatches!('SELECT flag, flag + 0 AS flag FROM items', [], 7))
        rows.push(...batch);
      return rows;
    };
    assert.equal((await read())[0]!.flag, true, 'match ordinary field-based duplicate-name normalization');
    fields.splice(0, 1);
    assert.equal((await read())[0]!.flag, 1, 'the same SQL must use fresh native fields');
    fields[0] = { name: 'other', columnType: 1, columnLength: 1 };
    assert.equal((await read())[0]!.flag, 1, 'projection names, not prior SQL or schema names, select decoding');
    c.release();
  });

  it('does not deliver headers or rows without a native field array', async () => {
    const f = fixture({ total: 3, fields: undefined });
    const c = await f.pool.connect();
    assert.deepEqual(await c.streamBatches!('DO 1', [], 7).next(), { value: undefined, done: true });
    assert.equal(f.produced, 3);
    c.release();
  });

  for (const suspended of [false, true]) {
    it(`settles connection-only fatal errors ${suspended ? 'between pulls' : 'during a pending pull'}`, async () => {
      const f = fixture();
      const c = await f.pool.connect();
      const stream = c.streamBatches!('SELECT * FROM items', [], 7);
      const first = stream.next();
      if (suspended) await first;
      const reason = new Error('fatal native parser failure');
      f.wireError(reason);
      await assert.rejects(suspended ? stream.next() : first, (error) => error === reason);
      assert.equal(f.destroyed, 1);
      f.wireError(new Error('late fatal connection error'));
      c.release();
      assert.equal(f.released, 0);
    });
  }

  for (const errorAt of [4, 8, 15]) {
    it(`propagates driver errors at row ${errorAt} and never delivers the failed partial batch`, async () => {
      const f = fixture({ errorAt });
      const c = await f.pool.connect();
      let count = 0;
      await assert.rejects(
        async () => {
          for await (const batch of c.streamBatches!('SELECT * FROM items', [], 7)) count += batch.length;
        },
        (error) => error === f.failure && f.failure.code === '40P01',
      );
      assert.equal(count, Math.floor((errorAt - 1) / 7) * 7);
      assert.equal(f.destroyed, 1);
      f.emit('error', new Error('late discarded connection error'));
      c.release();
    });
  }

  for (const reason of [new Error('abort suspended batch'), null, 0, 'stop']) {
    it(`preserves a ${typeof reason} abort reason and drops suspended rows`, async () => {
      const f = fixture();
      const c = await f.pool.connect();
      const controller = new AbortController();
      const stream = c.streamBatches!('SELECT * FROM items', [], 7, controller.signal);
      assert.equal((await stream.next()).value!.length, 7);
      controller.abort(reason);
      await assert.rejects(stream.next(), (error) => error === reason);
      assert.equal(f.produced, 7);
      assert.equal(f.destroyed, 1);
      assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
      c.release();
    });
  }

  for (const ending of ['return', 'throw', 'release', 'multiple-result'] as const) {
    it(`${ending} closes paused native delivery exactly once`, async () => {
      const f = fixture();
      const c = await f.pool.connect();
      const stream = c.streamBatches!('SELECT * FROM items', [], 7);
      await stream.next();
      if (ending === 'return') await stream.return(undefined);
      else if (ending === 'throw') {
        const reason = new Error('consumer throw');
        await assert.rejects(stream.throw(reason), (error) => error === reason);
      } else {
        if (ending === 'release') c.release();
        else f.emit('fields', [flagField]);
        await assert.rejects(stream.next(), ending === 'release' ? ConnectionError : UnsupportedFeatureError);
      }
      await stream.return(undefined);
      assert.equal(f.destroyed, 1);
      assert.equal(f.produced, 7);
      c.release();
      assert.equal(f.released, 0);
    });
  }

  // mysql2's destroy() only half-closes the socket, which a server still
  // writing the rest of the result never reads: its session outlived the pool.
  it('a discarded connection has its socket destroyed, not half-closed', async () => {
    const f = fixture({ socket: true });
    const c = await f.pool.connect();
    const stream = c.streamBatches!('SELECT * FROM items', [], 7);
    await stream.next();
    await stream.return(undefined);
    assert.equal(f.socketDestroyed, 1);
    assert.equal(f.destroyed, 0);
    c.release();
    assert.equal(f.released, 0);

    const timedOut = fixture({ socket: true });
    const held = await timedOut.pool.connect();
    held.release(new Error('statement timed out'));
    assert.equal(timedOut.socketDestroyed, 1);
    assert.equal(timedOut.destroyed, 0);
    assert.equal(timedOut.released, 0);
  });

  it('transaction return drains the wire before reuse and surfaces errors during that drain', async () => {
    for (const errorAt of [undefined, 9]) {
      const f = fixture({ errorAt });
      const c = await f.pool.connect();
      await c.query('START TRANSACTION');
      const stream = c.streamBatches!('SELECT * FROM items', [], 7);
      await stream.next();
      if (errorAt) {
        await assert.rejects(stream.return(undefined), (error) => error === f.failure);
        assert.equal(f.destroyed, 1);
      } else {
        await stream.return(undefined);
        assert.equal(f.produced, 17);
        assert.equal(f.destroyed, 0);
        await c.query('COMMIT');
      }
      c.release();
      assert.equal(f.released, errorAt ? 0 : 1);
    }
  });
});
