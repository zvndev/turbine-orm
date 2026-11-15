/** Internal native-hook forwarding; public query arguments do not accept a signal. */
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { describe, it } from 'node:test';
import type { Dialect } from '../dialect.js';
import { ValidationError } from '../errors.js';
import type { PgCompatPoolClient } from '../pg-types.js';
import {
  newStreamIdleState,
  StreamIdleGuard,
  streamIdleExpiredError,
  watchStreamConnection,
} from '../query/stream-idle.js';
import { type TransactionScope, TransactionState } from '../transaction-state.js';
import { createTransactionPool, guardTransactionConnection } from '../transaction-transport.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const dialect = {
  capabilities: { abortsTransactionOnError: false, statementSyntax: 'sqlite' },
  savepointStatement: (name: string) => `SAVEPOINT ${name}`,
  releaseSavepointStatement: (name: string) => `RELEASE SAVEPOINT ${name}`,
  rollbackToSavepointStatement: (name: string) => `ROLLBACK TO SAVEPOINT ${name}`,
} as Pick<
  Dialect,
  'capabilities' | 'savepointStatement' | 'releaseSavepointStatement' | 'rollbackToSavepointStatement'
>;

/** Like the adapters, abort wakes pending next(), and return() awaits cleanup. */
function fixture(options: { blockAt?: number; holdCleanup?: boolean } = {}) {
  const blocked = deferred();
  const wake = deferred();
  const cleaning = deferred();
  const cleanup = deferred();
  const calls: { text: string; values: unknown[]; batchSize: number; signal?: AbortSignal }[] = [];
  let pulls = 0;
  let closed = 0;
  const client: PgCompatPoolClient = {
    query: async () => ({ rows: [], rowCount: 0 }),
    release() {
      assert.fail('a native facade released its borrowed connection');
    },
    streamBatches(text, values, batchSize, signal) {
      calls.push({ text, values, batchSize, signal });
      return (async function* () {
        signal?.throwIfAborted();
        const abort = () => wake.resolve();
        signal?.addEventListener('abort', abort, { once: true });
        try {
          for (let id = 1; id <= 3; id++) {
            pulls++;
            if (pulls === options.blockAt) {
              blocked.resolve();
              await wake.promise;
            }
            signal?.throwIfAborted();
            yield [{ id }];
          }
        } finally {
          cleaning.resolve();
          if (options.holdCleanup) await cleanup.promise;
          signal?.removeEventListener('abort', abort);
          closed++;
        }
      })();
    },
  };
  class CountingGuard extends StreamIdleGuard {
    inFlight = 0;
    override statementStarted() {
      super.statementStarted();
      this.inFlight++;
    }
    override statementSettled() {
      super.statementSettled();
      this.inFlight--;
    }
  }
  const guard = new CountingGuard(
    newStreamIdleState(),
    60_000,
    () => streamIdleExpiredError('native', 'items', 60_000, 'batch'),
    async () => {},
  );
  const state = new TransactionState(client, dialect);
  const route = async (name: Route, scope: TransactionScope = state.rootScope) => {
    const pool = createTransactionPool(client, state, scope);
    const raw = guardTransactionConnection(client, state, scope, '$connection()');
    switch (name) {
      case 'pool':
        return pool;
      case 'checkout':
        return pool.connect();
      case 'raw':
        return raw;
      case 'idle':
        return watchStreamConnection(client, () => guard);
      case 'idle-pool':
        return watchStreamConnection(pool, () => guard);
      case 'idle-raw':
        return watchStreamConnection(raw, () => guard);
    }
  };
  return {
    calls,
    blocked: blocked.promise,
    cleaning: cleaning.promise,
    finishCleanup: cleanup.resolve,
    wake: wake.resolve,
    state,
    guard,
    route,
    get pulls() {
      return pulls;
    },
    get closed() {
      return closed;
    },
  };
}

const routes = ['pool', 'checkout', 'raw', 'idle', 'idle-pool', 'idle-raw'] as const;
type Route = (typeof routes)[number];

describe('native stream signal forwarding', { timeout: 5000 }, () => {
  for (const route of routes) {
    it(`${route}: pre-aborted signal and non-Error reason retain identity before any native pull`, async () => {
      const f = fixture();
      const controller = new AbortController();
      const reason = Object.freeze({ stopped: route });
      controller.abort(reason);
      try {
        const connection = await f.route(route);
        const values = [7];
        const stream = connection.streamBatches!('SELECT $1', values, 2, controller.signal);
        await assert.rejects(stream.next(), (error) => error === reason);
        assert.equal(f.calls.length, 1);
        assert.equal(f.calls[0]!.signal, controller.signal);
        assert.equal(f.calls[0]!.values, values);
        assert.equal(f.calls[0]!.text, 'SELECT $1');
        assert.equal(f.calls[0]!.batchSize, 2);
        assert.equal(f.pulls, 0);
        assert.equal(f.state.busy, false);
        assert.equal(f.state.running, false);
        assert.equal(f.guard.inFlight, 0);
        assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
        if (route !== 'idle') assert.equal(f.state.firstFailure, reason);
        await stream.return(undefined);
      } finally {
        f.guard.stop();
      }
    });

    for (const blockAt of [1, 2]) {
      it(`${route}: abort wakes pending pull ${blockAt} and waits for native cleanup before clearing accounting`, async () => {
        const f = fixture({ blockAt, holdCleanup: true });
        const controller = new AbortController();
        const reason = new Error('pending native pull aborted');
        const connection = await f.route(route);
        const stream = connection.streamBatches!('SELECT id', [], 1, controller.signal);
        if (blockAt === 2) assert.deepEqual((await stream.next()).value, [{ id: 1 }]);
        let settled = false;
        const pending = assert
          .rejects(stream.next(), (error) => error === reason)
          .then(() => {
            settled = true;
          });
        try {
          await f.blocked;
          assert.equal(f.calls[0]!.signal, controller.signal);
          assert.equal(f.state.busy, route !== 'idle');
          assert.equal(f.state.running, route !== 'idle');
          assert.equal(f.guard.inFlight, route.startsWith('idle') ? 1 : 0);
          controller.abort(reason);
          await f.cleaning;
          assert.equal(settled, false, 'a pending pull must await adapter cleanup');
          assert.equal(f.closed, 0);
          assert.equal(f.state.running, route !== 'idle');
          f.finishCleanup();
          await pending;
          assert.equal(f.closed, 1);
          assert.equal(f.state.busy, false);
          assert.equal(f.state.running, false);
          assert.equal(f.guard.inFlight, 0);
          assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
          if (route !== 'idle') assert.equal(f.state.firstFailure, reason);
        } finally {
          controller.abort(reason);
          f.wake();
          f.finishCleanup();
          await stream.return(undefined);
          await pending;
          f.guard.stop();
        }
      });
    }

    it(`${route}: abort between pulls preserves the original reason and closes the iterator once`, async () => {
      const f = fixture();
      const controller = new AbortController();
      const reason = Object.freeze({ between: true });
      try {
        const connection = await f.route(route);
        const stream = connection.streamBatches!('SELECT id', [], 1, controller.signal);
        assert.deepEqual((await stream.next()).value, [{ id: 1 }]);
        assert.equal(f.pulls, 1);
        assert.equal(f.state.busy, false);
        controller.abort(reason);
        await assert.rejects(stream.next(), (error) => error === reason);
        await stream.return(undefined);
        assert.equal(f.closed, 1);
        assert.equal(f.pulls, 2);
        assert.equal(f.guard.inFlight, 0);
        assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
      } finally {
        f.guard.stop();
      }
    });

    it(`${route}: early return awaits cleanup, detaches the signal and preserves borrowed ownership`, async () => {
      const f = fixture({ holdCleanup: true });
      const controller = new AbortController();
      const connection = await f.route(route);
      const stream = connection.streamBatches!('SELECT id', [], 1, controller.signal);
      try {
        assert.deepEqual((await stream.next()).value, [{ id: 1 }]);
        let returned = false;
        const closing = stream.return(undefined).then(() => {
          returned = true;
        });
        await f.cleaning;
        assert.equal(returned, false);
        assert.equal(f.closed, 0);
        f.finishCleanup();
        await closing;
        controller.abort(new Error('after return'));
        assert.deepEqual(await stream.next(), { done: true, value: undefined });
        assert.equal(f.closed, 1);
        assert.equal(f.pulls, 1);
        assert.equal(f.state.firstFailure, undefined);
        assert.equal(f.state.busy, false);
        assert.equal(f.guard.inFlight, 0);
        assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
        if (route === 'checkout') (connection as PgCompatPoolClient).release();
        if (route === 'raw') assert.throws(() => (connection as PgCompatPoolClient).release(), /must not release/);
      } finally {
        f.finishCleanup();
        await stream.return(undefined);
        f.guard.stop();
      }
    });

    it(`${route}: existing three-argument calls drain unchanged`, async () => {
      const f = fixture();
      try {
        const connection = await f.route(route);
        const rows = [];
        for await (const batch of connection.streamBatches!('SELECT id', [], 1)) rows.push(...batch);
        assert.deepEqual(rows, [{ id: 1 }, { id: 2 }, { id: 3 }]);
        assert.equal(f.calls.length, 1);
        assert.equal(f.calls[0]!.signal, undefined);
        assert.equal(f.closed, 1);
        assert.equal(f.state.busy, false);
        assert.equal(f.guard.inFlight, 0);
      } finally {
        f.guard.stop();
      }
    });

    if (route === 'idle') continue;
    it(`${route}: transaction completion refuses another native pull but awaits cleanup`, async () => {
      const f = fixture({ holdCleanup: true });
      const controller = new AbortController();
      const connection = await f.route(route);
      const stream = connection.streamBatches!('SELECT id', [], 1, controller.signal);
      try {
        await stream.next();
        f.state.end('committed');
        controller.abort(new Error('abort after transaction completion'));
        const refused = assert.rejects(stream.next(), /transaction committed/);
        await f.cleaning;
        assert.equal(f.pulls, 1, 'a lifetime refusal must not enter the driver again');
        assert.equal(f.closed, 0);
        f.finishCleanup();
        await refused;
        assert.equal(f.closed, 1);
        assert.equal(f.state.busy, false);
        assert.equal(f.guard.inFlight, 0);
        assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
      } finally {
        f.finishCleanup();
        await stream.return(undefined);
        f.guard.stop();
      }
    });

    it(`${route}: savepoint lifetime and outer-handle guards remain in force with a signal`, async () => {
      const f = fixture();
      const controller = new AbortController();
      try {
        const outer = await f.route(route);
        const wrongScope = outer.streamBatches!('SELECT id', [], 1, controller.signal);
        let innerStream: ReturnType<NonNullable<typeof outer.streamBatches>> | undefined;
        await f.state.enter(() =>
          f.state.withBlock(async (scope) => {
            await assert.rejects(wrongScope.next(), /outer `tx`/);
            assert.equal(f.pulls, 0);
            const inner = await f.route(route, scope);
            innerStream = inner.streamBatches!('SELECT id', [], 1, controller.signal);
            assert.deepEqual((await innerStream.next()).value, [{ id: 1 }]);
          }, f.state.rootScope),
        );
        await assert.rejects(innerStream!.next(), /savepoint block that has ended/);
        assert.equal(f.closed, 1);
        assert.equal(f.pulls, 1);
        assert.equal(f.state.ended, false);
        assert.equal(f.state.busy, false);
        assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
      } finally {
        f.guard.stop();
      }
    });
  }

  it('raw transaction-control SQL with a signal is still refused before a driver pull', async () => {
    const f = fixture();
    try {
      const raw = await f.route('raw');
      await assert.rejects(raw.streamBatches!('COMMIT', [], 1, new AbortController().signal).next(), ValidationError);
      assert.equal(f.pulls, 0);
      assert.equal(f.state.busy, false);
    } finally {
      f.guard.stop();
    }
  });
});
