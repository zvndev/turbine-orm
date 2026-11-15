import assert from 'node:assert/strict';
import { describe } from 'node:test';
import type { LiveQuery } from '../live-query.js';
import { deferred, fixture, until } from './fixtures/live-query-hub-pg/fixture.js';
import { skipGate } from './helpers.js';

const native = skipGate(!process.env.DATABASE_URL, 'DATABASE_URL not set (composed live-query hub PostgreSQL)');

describe('application-owned notification hub and live queries on native PostgreSQL', () => {
  native.it(
    'multiplexes 32 typed queries on one listener and observes only committed changes',
    { timeout: 15000 },
    async (t) => {
      const f = await fixture(t);
      let reads = 0;
      const handles = Array.from({ length: 32 }, () =>
        f.app.watch(() => {
          reads++;
          return f.read();
        }),
      );
      const typed: LiveQuery<{ id: number; title: string }[]> = handles[0]!;
      void typed;
      assert.deepEqual(
        await Promise.all(handles.map(async (handle) => (await handle.next()).value)),
        Array.from({ length: 32 }, () => []),
      );
      assert.equal(f.connections.length, 1);
      assert.equal((await f.listeners()).length, 1);
      assert.deepEqual(f.connections[0]!.sql, [`LISTEN "${f.name}"`]);
      assert.equal(f.app.hub.stats.subscriptions, 32);
      const payloads: string[] = [];
      await f.app.hub.subscribe(f.name, (payload) => {
        payloads.push(payload);
      });
      await f.writer.query('BEGIN');
      await f.insert(9);
      await f.notify('rolled-back');
      assert.equal(reads, 32);
      await f.writer.query('ROLLBACK');
      assert.deepEqual(await f.read(), []);
      await f.writer.query('BEGIN');
      await f.insert(2);
      await f.insert(1);
      await f.insert(3, 2);
      await f.notify('committed');
      assert.deepEqual(payloads, []);
      const pulls = handles.map((handle) => handle.next());
      await f.writer.query('COMMIT');
      const expected = [
        { id: 1, title: 'row-1' },
        { id: 2, title: 'row-2' },
      ];
      for (const result of await Promise.all(pulls)) assert.deepEqual(result.value, expected);
      assert.deepEqual(payloads, ['committed']);
      assert.equal(reads, 64);
    },
  );

  native.it(
    'subscribes before reading and discards a snapshot invalidated while the read was running',
    { timeout: 15000 },
    async (t) => {
      const f = await fixture(t);
      const captured = deferred(),
        release = deferred();
      f.drains.push(release.resolve);
      let calls = 0;
      const live = f.app.watch(async () => {
        assert.equal((await f.listeners()).length, 1, 'LISTEN acknowledged before query callback');
        const rows = await f.read();
        if (++calls === 1) {
          captured.resolve();
          await release.promise;
        }
        return rows;
      });
      const pull = live.next();
      await captured.promise;
      await f.insert(4);
      await f.barrier();
      release.resolve();
      assert.deepEqual((await pull).value, [{ id: 4, title: 'row-4' }]);
      assert.equal(calls, 2);
    },
  );

  native.it(
    'survives actual backend termination and resyncs changes committed with no listener',
    { timeout: 15000 },
    async (t) => {
      const f = await fixture(t);
      const handles = Array.from({ length: 8 }, () => f.app.watch(f.read));
      await Promise.all(handles.map((handle) => handle.next()));
      const gate = f.gateReconnect();
      const pid = f.connections[0]!.pid;
      assert.deepEqual((await f.writer.query('SELECT pg_terminate_backend($1) AS terminated', [pid])).rows, [
        { terminated: true },
      ]);
      await gate.requested;
      assert.equal(f.app.hub.stats.connected, false);
      assert.ok(f.diagnostics.length > 0, 'recoverable failure reported as diagnostics');
      assert.deepEqual(await f.listeners(), []);
      await f.writer.query('BEGIN');
      await f.insert(7);
      await f.notify('lost-in-gap');
      await f.writer.query('COMMIT');
      const pulls = handles.map((handle) => handle.next());
      gate.allow();
      for (const result of await Promise.all(pulls)) assert.deepEqual(result.value, [{ id: 7, title: 'row-7' }]);
      assert.equal(f.connections.length, 2);
      assert.notEqual(f.connections[1]!.pid, pid);
      assert.equal(f.connections[0]!.released, true);
      assert.deepEqual(f.connections[1]!.sql, [`LISTEN "${f.name}"`]);
      assert.equal((await f.listeners()).length, 1);
      assert.equal(f.app.hub.stats.subscriptions, 8);
    },
  );

  native.it(
    'bounds a 256-event burst, resyncs async delivery overflow and gives a slow reader only the latest snapshot',
    { timeout: 15000 },
    async (t) => {
      const f = await fixture(t);
      const delivery = deferred(),
        captured = deferred(),
        readRelease = deferred();
      f.drains.push(delivery.resolve, readRelease.resolve);
      const subscribe = f.app.hub.subscribe.bind(f.app.hub);
      let deliveries = 0,
        overflows = 0,
        calls = 0,
        running = 0,
        maxRunning = 0;
      // Inject a slow invalidation callback, keeping the real native hub and its bounded delivery.
      // The shipped application's synchronous invalidate normally never needs overflow recovery.
      f.app.hub.subscribe = (channel, handler, options) =>
        subscribe(
          channel,
          async (payload) => {
            deliveries++;
            await handler(payload);
            await delivery.promise;
          },
          {
            ...options,
            onResync: async (reason) => {
              if (reason === 'overflow') overflows++;
              await options?.onResync?.(reason);
            },
          },
        );
      const live = f.app.watch(async () => {
        running++;
        maxRunning = Math.max(maxRunning, running);
        try {
          const rows = await f.read();
          if (++calls === 2) {
            captured.resolve();
            await readRelease.promise;
          }
          return rows;
        } finally {
          running--;
        }
      });
      assert.deepEqual((await live.next()).value, []);
      await f.notify('hold');
      await captured.promise;
      await f.writer.query('BEGIN');
      await f.insert(5);
      await f.writer.query('SELECT pg_notify($1, n::text) FROM generate_series(1, 256) AS n', [f.name]);
      await f.writer.query('COMMIT');
      // A separate synchronous native consumer marks the end of driver delivery.
      const delivered = deferred();
      const barrier = await subscribe(f.name, () => delivered.resolve());
      await f.notify('barrier');
      await delivered.promise;
      assert.equal(deliveries, 1, 'no queue of 256 async handlers');
      assert.equal(calls, 2, 'no concurrent query fanout');
      delivery.resolve();
      await until(() => overflows === 1);
      readRelease.resolve();
      await until(() => calls === 3 && running === 0);
      assert.equal(maxRunning, 1);
      // No pull was pending during the entire burst.
      assert.deepEqual((await live.next()).value, [{ id: 5, title: 'row-5' }]);
      await barrier.unsubscribe();
      // Further states replace the buffered result instead of accumulating snapshots.
      await f.insert(6);
      await f.notify('six');
      await until(() => calls === 4 && running === 0);
      await f.insert(8);
      await f.notify('eight');
      await until(() => calls === 5 && running === 0);
      assert.deepEqual((await live.next()).value, [
        { id: 5, title: 'row-5' },
        { id: 6, title: 'row-6' },
        { id: 8, title: 'row-8' },
      ]);
      const pending = live.next();
      await live.dispose();
      assert.equal((await pending).done, true, 'no stale snapshot backlog');
    },
  );

  native.it(
    'retains global filters, middleware and PII policy on refetch and keeps a sibling after request cancellation',
    { timeout: 15000 },
    async (t) => {
      const f = await fixture(t);
      await f.insert(1);
      await f.insert(2, 2);
      let middleware = 0;
      f.db.$use(async (params, next) => {
        middleware++;
        const rows = (await next(params)) as { title: string }[];
        return rows.map((row) => ({ ...row, title: row.title.toUpperCase() }));
      });
      const request = new AbortController();
      const first = f.app.watch(f.read, request.signal),
        sibling = f.app.watch(f.read);
      assert.deepEqual((await first.next()).value, [{ id: 1, title: 'ROW-1' }]);
      assert.deepEqual((await sibling.next()).value, [{ id: 1, title: 'ROW-1' }]);
      const pending = first.next();
      request.abort();
      await first.closed;
      assert.equal((await pending).done, true);
      assert.equal(f.app.hub.stats.subscriptions, 1);
      f.setTenant(2);
      await f.notify();
      assert.deepEqual((await sibling.next()).value, [{ id: 2, title: 'ROW-2' }]);
      assert.equal(middleware, 3);
      assert.equal(f.connections.length, 1);
      const denied = f.app.watch(() =>
        f.db.table<{ secret: string }>(f.name).findMany({ select: { secret: true }, limit: 1 }),
      );
      await assert.rejects(denied.next(), /PII/);
      await assert.rejects(denied.closed, /PII/);
      assert.equal(f.app.hub.stats.subscriptions, 1, 'policy failure cancels only its handle');
    },
  );

  native.it(
    'cancels pending readiness, drains in-flight SQL and closes handles before hub and caller pool',
    { timeout: 15000 },
    async (t) => {
      const f = await fixture(t);
      const abort = new AbortController();
      const cancelled = f.app.watch(f.read, abort.signal);
      abort.abort();
      await cancelled.closed;
      assert.equal(f.app.hub.stats.subscriptions, 0);
      const checkout = f.pauseNextCheckout();
      const duringSetup = new AbortController();
      let cancelledReads = 0;
      const pendingSetup = f.app.watch(() => {
        cancelledReads++;
        return f.read();
      }, duringSetup.signal);
      await checkout.requested;
      assert.equal(f.app.hub.stats.subscriptions, 1);
      duringSetup.abort();
      await pendingSetup.closed;
      assert.equal(cancelledReads, 0, 'cancelled setup never starts its initial query');
      assert.equal(f.app.hub.stats.subscriptions, 0);
      checkout.allow();
      await until(() => f.connections.length === 1 && f.connections[0]!.released);
      assert.deepEqual(f.connections[0]!.sql, [], 'late unused checkout never LISTENs');
      const captured = deferred(),
        release = deferred();
      f.drains.push(release.resolve);
      const live = f.app.watch(async (signal) => {
        const rows = await f.read();
        captured.resolve();
        await release.promise; // Models finite SQL which does not accept AbortSignal.
        assert.equal(signal.aborted, true);
        f.order.push('read-drained');
        return rows;
      });
      const pending = live.next();
      await captured.promise;
      const close = f.app.close();
      assert.equal(close, f.app.close(), 'idempotent application shutdown');
      await live.closed;
      assert.equal((await pending).done, true);
      assert.equal(f.app.hub.stats.closed, false, 'hub close waits for handle and read drain');
      assert.throws(() => f.app.watch(f.read), /closing/);
      release.resolve();
      await close;
      assert.equal(f.app.hub.stats.closed, true);
      assert.ok(f.order.includes('read-drained'));
      assert.deepEqual((await f.pool.query('SELECT 42 AS answer')).rows, [{ answer: 42 }]);
      assert.equal(f.pool.totalCount, f.pool.idleCount + 1, 'only fixture writer still checked out');
    },
  );
});
