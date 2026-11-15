import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { describe, it } from 'node:test';
import { type LiveQuerySubscriptionCallbacks, liveQuery } from '../live-query.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

function source() {
  let invalidate!: () => void;
  let callbacks!: LiveQuerySubscriptionCallbacks;
  let unsubscribed = 0;
  return {
    subscribe(handler: () => void, hooks: LiveQuerySubscriptionCallbacks) {
      invalidate = handler;
      callbacks = hooks;
      return {
        unsubscribe: () => {
          unsubscribed++;
        },
      };
    },
    invalidate: () => invalidate(),
    reconnect: () => callbacks.onReconnect(),
    fail: (error: unknown) => callbacks.onError(error),
    get unsubscribed() {
      return unsubscribed;
    },
  };
}

describe('live query bounded snapshots', () => {
  it('subscribes fully before querying, including synchronous setup invalidations', async () => {
    const established = deferred<void>();
    const order: string[] = [];
    const live = liveQuery({
      async subscribe(invalidate) {
        order.push('subscribe');
        invalidate();
        await established.promise;
        order.push('active');
        return {
          unsubscribe() {
            order.push('unsubscribe');
          },
        };
      },
      query: () => {
        order.push('query');
        return [{ id: 7 }];
      },
    });
    await tick();
    assert.deepEqual(order, ['subscribe']);
    established.resolve();
    assert.deepEqual(await live.next(), { done: false, value: [{ id: 7 }] });
    await live.ready;
    await live.dispose();
    assert.deepEqual(order, ['subscribe', 'active', 'query', 'unsubscribe']);
  });

  it('discards the first racing snapshot and coalesces 10000 invalidations into one rerun', async () => {
    const events = source();
    const first = deferred<number>();
    const second = deferred<number>();
    let calls = 0;
    const live = liveQuery({
      subscribe: events.subscribe,
      query: () => (++calls === 1 ? first.promise : second.promise),
    });
    await live.ready;
    const next = live.next();
    for (let i = 0; i < 10000; i++) events.invalidate();
    assert.equal(calls, 1);
    first.resolve(1);
    await tick();
    assert.equal(calls, 2);
    second.resolve(2);
    assert.deepEqual(await next, { done: false, value: 2 });
    await tick();
    assert.equal(calls, 2);
    await live.dispose();
    assert.equal(events.unsubscribed, 1);
  });

  it('retains only latest state for a slow consumer, including undefined', async () => {
    const events = source();
    let value: number | undefined = 1;
    const live = liveQuery({ subscribe: events.subscribe, query: () => value });
    await tick();
    value = 2;
    events.invalidate();
    await tick();
    value = undefined;
    events.invalidate();
    await tick();
    assert.deepEqual(await live.next(), { done: false, value: undefined });
    const next = live.next();
    value = 4;
    events.reconnect();
    assert.deepEqual(await next, { done: false, value: 4 });
    await live.dispose();
  });

  it('clears a buffered snapshot immediately on invalidation', async () => {
    const events = source();
    const reread = deferred<number>();
    let calls = 0;
    const live = liveQuery({ subscribe: events.subscribe, query: () => (++calls === 1 ? 1 : reread.promise) });
    await tick();
    events.invalidate();
    let delivered = false;
    const next = live.next().then((value) => {
      delivered = true;
      return value;
    });
    await tick();
    assert.equal(delivered, false);
    reread.resolve(2);
    assert.deepEqual(await next, { done: false, value: 2 });
    await live.dispose();
  });

  it('handles synchronous invalidation and reconnect during subsequent queries', async () => {
    const events = source();
    let calls = 0;
    const live = liveQuery({
      subscribe: events.subscribe,
      query: () => {
        calls++;
        if (calls === 1) events.invalidate();
        if (calls === 2) events.reconnect();
        return calls;
      },
    });
    assert.deepEqual(await live.next(), { done: false, value: 3 });
    assert.equal(calls, 3);
    await live.return?.();
  });

  it('rejects concurrent pending pulls without corrupting the original pull', async () => {
    const events = source();
    const result = deferred<string>();
    const live = liveQuery({ subscribe: events.subscribe, query: () => result.promise });
    const next = live.next();
    await assert.rejects(live.next(), /only one pending next/);
    result.resolve('ok');
    assert.deepEqual(await next, { done: false, value: 'ok' });
    await live.dispose();
  });

  it('for-await break unsubscribes exactly once and never closes a caller client', async () => {
    const events = source();
    let queries = 0;
    const client = {
      disconnected: false,
      query: () => ++queries,
      disconnect() {
        this.disconnected = true;
      },
    };
    const live = liveQuery({ subscribe: events.subscribe, query: client.query });
    const values = [];
    for await (const value of live) {
      values.push(value);
      break;
    }
    await live.dispose();
    events.invalidate();
    events.reconnect();
    await tick();
    assert.deepEqual(values, [1]);
    assert.equal(queries, 1);
    assert.equal(client.disconnected, false);
    assert.equal(events.unsubscribed, 1);
  });
});

describe('live query lifecycle failures and cancellation', () => {
  it('already aborted signal never subscribes or queries', async () => {
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    const live = liveQuery({
      signal: controller.signal,
      subscribe: () => {
        calls++;
        return { unsubscribe() {} };
      },
      query: () => ++calls,
    });
    await assert.rejects(live.ready, { name: 'AbortError' });
    assert.deepEqual(await live.next(), { done: true, value: undefined });
    await live.closed;
    assert.equal(calls, 0);
  });

  it('cancellation during setup waits for and disposes the late listener', async () => {
    const setup = deferred<{ unsubscribe(): void }>();
    const controller = new AbortController();
    let queries = 0;
    let released = 0;
    const live = liveQuery({ signal: controller.signal, subscribe: () => setup.promise, query: () => ++queries });
    await tick();
    const next = live.next();
    controller.abort();
    assert.deepEqual(await next, { done: true, value: undefined });
    await assert.rejects(live.ready, { name: 'AbortError' });
    let closed = false;
    const disposal = live.dispose().then(() => {
      closed = true;
    });
    await tick();
    assert.equal(closed, false);
    setup.resolve({
      unsubscribe() {
        released++;
      },
    });
    await disposal;
    assert.equal(released, 1);
    assert.equal(queries, 0);
  });

  for (const late of ['resolve', 'reject'] as const) {
    it(`disposes an uncooperative in-flight query and observes its late ${late}`, async () => {
      const events = source();
      const query = deferred<number>();
      let signal!: AbortSignal;
      let calls = 0;
      const live = liveQuery({
        subscribe: events.subscribe,
        query: (abort) => {
          calls++;
          signal = abort;
          return query.promise;
        },
      });
      await live.ready;
      const next = live.next();
      events.invalidate();
      await live.dispose();
      assert.equal(signal.aborted, true);
      assert.equal(events.unsubscribed, 1);
      if (late === 'resolve') query.resolve(1);
      else query.reject(new Error('late query failure'));
      events.reconnect();
      events.invalidate();
      await tick();
      assert.deepEqual(await next, { done: true, value: undefined });
      assert.equal(calls, 1);
    });
  }

  for (const sync of [true, false]) {
    it(`cleans up on ${sync ? 'synchronous' : 'asynchronous'} query failure`, async () => {
      const events = source();
      const error = new Error('query failed');
      const live = liveQuery({
        subscribe: events.subscribe,
        query: () => {
          if (sync) throw error;
          return Promise.reject(error);
        },
      });
      await assert.rejects(live.next(), (failure) => failure === error);
      await assert.rejects(live.closed, (failure) => failure === error);
      events.invalidate();
      assert.equal(events.unsubscribed, 1);
    });
  }

  it('reports setup failure and never executes a query', async () => {
    const error = new Error('subscription setup failed');
    let queries = 0;
    const live = liveQuery({ subscribe: () => Promise.reject(error), query: () => ++queries });
    await assert.rejects(live.next(), (failure) => failure === error);
    await assert.rejects(live.ready, (failure) => failure === error);
    await assert.rejects(live.closed, (failure) => failure === error);
    assert.equal(queries, 0);
  });

  it('cleans up terminal failure raised synchronously during listener setup', async () => {
    let cleaned = 0;
    const error = new Error('terminal setup event');
    const live = liveQuery({
      subscribe(_invalidate, callbacks) {
        callbacks.onError(error);
        return {
          unsubscribe() {
            cleaned++;
          },
        };
      },
      query: () => assert.fail('query after terminal error'),
    });
    await assert.rejects(live.closed, (failure) => failure === error);
    await assert.rejects(live.next(), (failure) => failure === error);
    assert.equal(cleaned, 1);
  });

  it('terminal subscription failure aborts current query and cancels dirty reruns', async () => {
    const events = source();
    const query = deferred<number>();
    let calls = 0;
    const live = liveQuery({
      subscribe: events.subscribe,
      query: () => {
        calls++;
        return query.promise;
      },
    });
    await live.ready;
    events.invalidate();
    const next = live.next();
    const error = new Error('listener stopped');
    events.fail(error);
    await assert.rejects(next, (failure) => failure === error);
    await assert.rejects(live.closed, (failure) => failure === error);
    query.resolve(1);
    events.invalidate();
    await tick();
    assert.equal(calls, 1);
    assert.equal(events.unsubscribed, 1);
  });

  it('reports unsubscribe rejection without an unhandled background rejection', async () => {
    const error = new Error('unsubscribe failed');
    const live = liveQuery({ subscribe: () => ({ unsubscribe: () => Promise.reject(error) }), query: () => 1 });
    await live.ready;
    await assert.rejects(live.dispose(), (failure) => failure === error);
    await assert.rejects(live.next(), (failure) => failure === error);
    await assert.rejects(live.dispose(), (failure) => failure === error);
  });

  it('retains both query and cleanup errors', async () => {
    const original = new Error('query failed');
    const cleanup = new Error('cleanup failed');
    const live = liveQuery({
      subscribe: () => ({
        unsubscribe() {
          throw cleanup;
        },
      }),
      query() {
        throw original;
      },
    });
    await assert.rejects(live.next(), (failure) => failure === original);
    await assert.rejects(
      live.closed,
      (failure) => failure instanceof AggregateError && failure.errors[0] === original && failure.errors[1] === cleanup,
    );
  });

  it('observes setup failure after cancellation', async () => {
    const setup = deferred<never>();
    const live = liveQuery({ subscribe: () => setup.promise, query: () => 1 });
    await tick();
    const disposal = live.dispose();
    setup.reject(new Error('late setup failure'));
    await assert.rejects(disposal, /late setup failure/);
  });

  it('iterator throw closes and rejects with the caller error', async () => {
    const events = source();
    const live = liveQuery({ subscribe: events.subscribe, query: () => 1 });
    await live.ready;
    const error = new Error('consumer failed');
    await assert.rejects(live.throw?.(error) as Promise<unknown>, (failure) => failure === error);
    assert.equal(events.unsubscribed, 1);
  });
  it('removes external abort listeners and shares pending disposal work', async () => {
    const controller = new AbortController();
    const cleanup = deferred<void>();
    let unsubscribes = 0;
    const live = liveQuery({
      signal: controller.signal,
      query: () => 1,
      subscribe: () => ({
        unsubscribe() {
          unsubscribes++;
          return cleanup.promise;
        },
      }),
    });
    await live.ready;
    assert.equal(getEventListeners(controller.signal, 'abort').length, 1);
    const first = live.dispose();
    const second = live.dispose();
    assert.equal(first, second);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    await tick();
    assert.equal(unsubscribes, 1);
    cleanup.resolve();
    await first;
    await second;
  });

  for (const error of [undefined, null, 'terminal failure']) {
    it(`preserves a non-Error setup rejection (${String(error)})`, async () => {
      const live = liveQuery({ subscribe: () => Promise.reject(error), query: () => 1 });
      const readyError = live.ready.catch((reason: unknown) => ({ reason }));
      const nextError = live.next().catch((reason: unknown) => ({ reason }));
      const closedError = live.closed.catch((reason: unknown) => ({ reason }));
      assert.deepEqual(await readyError, { reason: error });
      assert.deepEqual(await nextError, { reason: error });
      assert.deepEqual(await closedError, { reason: error });
    });
  }
});
