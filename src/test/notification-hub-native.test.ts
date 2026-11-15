import assert from 'node:assert/strict';
import { describe } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import { TurbineClient } from '../client.js';
import { createNotificationHub } from '../notification-hub.js';
import type { PgCompatPoolClient } from '../pg-types.js';
import { skipGate } from './helpers.js';

const native = skipGate(!process.env.DATABASE_URL, 'DATABASE_URL not set (native PostgreSQL notification hub)');
const endpoint = { endpoint: 'direct' } as const;
async function until(predicate: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 400; i++) {
    if (await predicate()) return;
    await delay(5);
  }
  assert.ok(await predicate(), 'native notification condition did not become true');
}

function trackedPool() {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1, connectionTimeoutMillis: 2000 });
  const connections: {
    client: pg.PoolClient;
    pid: number;
    sql: string[];
    releases: (boolean | Error | undefined)[];
  }[] = [];
  let ends = 0;
  const transport = {
    async connect(): Promise<PgCompatPoolClient> {
      const client = await pool.connect();
      const record = {
        client,
        pid: (client as unknown as { processID: number }).processID,
        sql: [] as string[],
        releases: [] as (boolean | Error | undefined)[],
      };
      connections.push(record);
      // Facade preserves the real native client's events/session and records ownership effects.
      return {
        query: async (sql: string) => {
          record.sql.push(sql);
          return client.query(sql);
        },
        on: client.on.bind(client),
        removeListener: client.removeListener.bind(client),
        release(error?: Error | boolean) {
          record.releases.push(error);
          client.release(error);
        },
      } as PgCompatPoolClient;
    },
    async end() {
      ends++;
      await pool.end();
    },
  };
  return {
    pool,
    transport,
    connections,
    get ends() {
      return ends;
    },
  };
}

async function withNative(run: (sender: pg.Client) => Promise<void>) {
  const sender = new pg.Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 2000 });
  await sender.connect();
  try {
    await run(sender);
  } finally {
    await sender.end();
  }
}

describe('notification hub native PostgreSQL (direct endpoint)', () => {
  native.it('fans out exact committed payloads in order, quotes case and clears final state', async () => {
    await withNative(async (sender) => {
      const tracked = trackedPool();
      const hub = createNotificationHub(tracked.transport, endpoint);
      const channel = `HubCase_${process.pid}`;
      const other = `hub_other_${process.pid}`;
      const seen: string[] = [],
        errors: string[] = [];
      try {
        const [a, b, c, bad] = await Promise.all([
          hub.subscribe(channel, (p) => {
            seen.push(`a:${p}`);
          }),
          hub.subscribe(channel, (p) => {
            seen.push(`b:${p}`);
          }),
          hub.subscribe(other, (p) => {
            seen.push(`c:${p}`);
          }),
          hub.subscribe(
            channel,
            async () => {
              throw new Error('native callback failure');
            },
            {
              onError: (e) => {
                errors.push(e.message);
              },
            },
          ),
        ]);
        assert.equal(tracked.connections.length, 1);
        assert.deepEqual(tracked.connections[0]!.sql, [`LISTEN "${channel}"`, `LISTEN "${other}"`]);
        await sender.query('BEGIN');
        await sender.query('SELECT pg_notify($1,$2)', [channel, 'one']);
        await sender.query('SELECT pg_notify($1,$2)', [other, 'two']);
        assert.equal(seen.length, 0);
        await sender.query('COMMIT');
        await until(() => seen.length === 3 && errors.length === 1);
        assert.deepEqual(seen, ['a:one', 'b:one', 'c:two']);
        assert.deepEqual(errors, ['native callback failure']);
        await sender.query('SELECT pg_notify($1,$2)', [channel.toLowerCase(), 'wrong-case']);
        await a.unsubscribe();
        await sender.query('SELECT pg_notify($1,$2)', [channel, 'three']);
        await until(() => seen.length === 4 && errors.length === 2);
        assert.deepEqual(seen, ['a:one', 'b:one', 'c:two', 'b:three']);
        const replacement = hub.subscribe(other, (p) => {
          seen.push(`d:${p}`);
        });
        const [d] = await Promise.all([replacement, c.unsubscribe(), b.unsubscribe(), bad.unsubscribe()]);
        assert.equal(tracked.connections.length, 1);
        assert.ok(tracked.connections[0]!.sql.includes(`UNLISTEN "${channel}"`));
        await sender.query('BEGIN');
        await sender.query('SELECT pg_notify($1,$2)', [other, 'rolled-back']);
        await sender.query('ROLLBACK');
        await sender.query('SELECT pg_notify($1,$2)', [other, 'four']);
        await until(() => seen.length === 5);
        assert.deepEqual(seen, ['a:one', 'b:one', 'c:two', 'b:three', 'd:four']);
        await d.unsubscribe();
        assert.deepEqual(tracked.connections[0]!.releases, [undefined]);
        assert.deepEqual((await tracked.pool.query('SELECT pg_listening_channels() AS channel')).rows, []);
        assert.equal(tracked.pool.waitingCount, 0);
        assert.equal(tracked.pool.idleCount, 1);
        assert.equal(tracked.connections[0]!.client.listenerCount('notification'), 0);
        assert.equal(tracked.connections[0]!.client.listenerCount('end'), 0);
        await hub.close();
        assert.equal(tracked.ends, 0);
        assert.deepEqual((await tracked.pool.query('SELECT 7 AS value')).rows, [{ value: 7 }]);
      } finally {
        await hub.close();
        await tracked.pool.end();
      }
    });
  });

  native.it(
    'destroys a physically disconnected backend, restores all channels before callbacks, and never replays the gap',
    async () => {
      await withNative(async (sender) => {
        const tracked = trackedPool();
        const errors: Error[] = [],
          lifecycle: string[] = [],
          seen: string[] = [];
        const hub = createNotificationHub(tracked.transport, {
          ...endpoint,
          reconnect: { initialDelayMs: 150, maxDelayMs: 150 },
          onError: (e) => {
            errors.push(e);
          },
        });
        const a = `hub_reconnect_a_${process.pid}`,
          b = `hub_reconnect_b_${process.pid}`;
        try {
          const signal = new AbortController();
          await hub.subscribe(
            a,
            (p) => {
              seen.push(`a:${p}`);
            },
            {
              onReconnect: async () => {
                const fresh = tracked.connections[1]!;
                assert.deepEqual(fresh.sql, [`LISTEN "${a}"`, `LISTEN "${b}"`]);
                const active = await fresh.client.query('SELECT pg_listening_channels() AS channel');
                assert.deepEqual(active.rows.map((r) => r.channel).sort(), [a, b].sort());
                lifecycle.push('reconnect');
              },
              onResync: (reason) => {
                lifecycle.push(`resync:${reason}`);
              },
            },
          );
          await hub.subscribe(b, (p) => {
            seen.push(`b:${p}`);
          });
          await hub.subscribe(
            a,
            (p) => {
              seen.push(`cancelled:${p}`);
            },
            { signal: signal.signal },
          );
          const original = tracked.connections[0]!;
          assert.deepEqual((await sender.query('SELECT pg_terminate_backend($1) AS terminated', [original.pid])).rows, [
            { terminated: true },
          ]);
          await until(() => !hub.stats.connected && errors.length > 0);
          signal.abort();
          await sender.query('SELECT pg_notify($1,$2)', [a, 'gap']);
          await until(() => lifecycle.length === 2);
          assert.deepEqual(lifecycle, ['reconnect', 'resync:reconnect']);
          assert.equal(errors.length, 3);
          assert.equal(tracked.connections.length, 2);
          assert.notEqual(tracked.connections[1]!.pid, original.pid);
          assert.equal(original.releases.length, 1);
          assert.ok(original.releases[0] instanceof Error);
          assert.equal(original.client.listenerCount('notification'), 0);
          await sender.query('SELECT pg_notify($1,$2)', [a, 'after-a']);
          await sender.query('SELECT pg_notify($1,$2)', [b, 'after-b']);
          await until(() => seen.length === 2);
          assert.deepEqual(seen, ['a:after-a', 'b:after-b']);
          await hub.close();
          assert.deepEqual(tracked.connections[1]!.releases, [undefined]);
          assert.deepEqual((await tracked.pool.query('SELECT pg_listening_channels() AS channel')).rows, []);
          assert.deepEqual(
            (await sender.query('SELECT pid FROM pg_stat_activity WHERE pid=$1', [original.pid])).rows,
            [],
          );
        } finally {
          await hub.close();
          await tracked.pool.end();
        }
      });
    },
  );

  native.it('cancels a real queued checkout promptly and cleans a late native client before owned end', async () => {
    const tracked = trackedPool();
    const hub = createNotificationHub(tracked.transport, { ...endpoint, ownership: 'owned' });
    const blocker = await tracked.pool.connect();
    let released = false;
    try {
      const abort = new AbortController();
      const pending = hub.subscribe(
        `hub_cancel_${process.pid}`,
        () => {
          assert.fail('cancelled handler fired');
        },
        { signal: abort.signal },
      );
      await until(() => tracked.pool.waitingCount === 1);
      const rejected = assert.rejects(pending, { name: 'AbortError' });
      abort.abort();
      await rejected;
      assert.equal(tracked.pool.waitingCount, 1, 'logical cancel does not pretend to cancel native pool.connect');
      const closing = hub.close();
      assert.equal(tracked.ends, 0);
      blocker.release();
      released = true;
      await closing;
      await hub.close();
      assert.equal(tracked.ends, 1);
      assert.equal(tracked.pool.totalCount, 0);
      assert.equal(tracked.pool.waitingCount, 0);
      assert.equal(tracked.connections.length, 1);
      assert.deepEqual(tracked.connections[0]!.sql, []);
      assert.deepEqual(tracked.connections[0]!.releases, [true]);
      await assert.rejects(tracked.pool.query('SELECT 1'), /after calling end/);
    } finally {
      if (!released) blocker.release();
      await hub.close();
    }
  });

  native.it(
    'aborts one consumer without disrupting peers and closes an active owned listener exactly once',
    async () => {
      await withNative(async (sender) => {
        const tracked = trackedPool();
        const hub = createNotificationHub(tracked.transport, { ...endpoint, ownership: 'owned' });
        const channel = `hub_owned_${process.pid}`;
        const seen: string[] = [];
        const abort = new AbortController();
        try {
          await hub.subscribe(
            channel,
            () => {
              assert.fail('aborted consumer called');
            },
            { signal: abort.signal },
          );
          const peer = await hub.subscribe(channel, (p) => {
            seen.push(p);
          });
          abort.abort();
          await sender.query('SELECT pg_notify($1,$2)', [channel, 'peer']);
          await until(() => seen.length === 1);
          assert.deepEqual(seen, ['peer']);
          assert.equal(tracked.connections.length, 1);
          await Promise.all([hub.close(), hub.close(), peer.unsubscribe()]);
          assert.equal(tracked.ends, 1);
          assert.equal(tracked.pool.totalCount, 0);
          assert.deepEqual(tracked.connections[0]!.releases, [undefined]);
          assert.equal(tracked.connections[0]!.sql.at(-1), 'UNLISTEN *');
        } finally {
          await hub.close();
        }
      });
    },
  );
  native.it('keeps existing dedicated $listen ownership independent of the optional hub', async () => {
    await withNative(async (sender) => {
      const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 3, connectionTimeoutMillis: 2000 });
      const db = new TurbineClient({ pool }, { tables: {}, enums: {} });
      const hub = createNotificationHub(pool, endpoint);
      const seen: string[] = [],
        channel = `hub_dedicated_${process.pid}`;
      try {
        const first = await db.$listen(channel, (p) => {
          seen.push(`first:${p}`);
        });
        const second = await db.$listen(channel, (p) => {
          seen.push(`second:${p}`);
        });
        const shared = await hub.subscribe(channel, (p) => {
          seen.push(`shared:${p}`);
        });
        assert.equal(pool.totalCount, 3);
        assert.equal(pool.idleCount, 0);
        await sender.query('SELECT pg_notify($1,$2)', [channel, 'one']);
        await until(() => seen.length === 3);
        assert.deepEqual([...seen].sort(), ['first:one', 'second:one', 'shared:one']);
        await shared.unsubscribe();
        await hub.close();
        assert.equal(pool.idleCount, 1);
        await sender.query('SELECT pg_notify($1,$2)', [channel, 'two']);
        await until(() => seen.length === 5);
        assert.deepEqual(seen.slice(3).sort(), ['first:two', 'second:two']);
        await Promise.all([first.unsubscribe(), second.unsubscribe()]);
        assert.equal(pool.totalCount, 3);
        assert.equal(pool.idleCount, 3);
      } finally {
        await hub.close();
        await db.disconnect();
        await pool.end();
      }
    });
  });
});
