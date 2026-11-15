import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { ConnectionError, ValidationError } from '../errors.js';
import { createNotificationHub, type NotificationHubOptions } from '../notification-hub.js';
import { deferred, FakeClient, FakePool } from './fixtures/notification-hub/fake-pool.js';

async function until(predicate: () => boolean) {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await delay(5);
  }
  assert.ok(predicate(), 'condition did not become true');
}
const options = { endpoint: 'direct', onError: () => {} } as const;

describe('notification hub (driver fixtures, no native certification)', () => {
  it('requires the actual session endpoint contract before checkout', async () => {
    const pool = new FakePool();
    for (const endpoint of [undefined, 'transaction-pool', 'statement-pool', 'http', 'websocket', '']) {
      assert.throws(() => createNotificationHub(pool, { endpoint } as NotificationHubOptions), /NOTIFY but not LISTEN/);
    }
    assert.equal(pool.connects, 0);
    const hub = createNotificationHub(pool, { ...options, endpoint: 'session-pool' });
    await hub.close();
    assert.equal(pool.ends, 0);
  });

  it('validates channel, options and bounds without touching the pool', async () => {
    const pool = new FakePool();
    for (const maxChannels of [0, -1, 1.5, Infinity, NaN, 2 ** 31]) {
      assert.throws(() => createNotificationHub(pool, { ...options, maxChannels }), ValidationError);
    }
    assert.throws(
      () => createNotificationHub(pool, { ...options, reconnect: { initialDelayMs: 10, maxDelayMs: 1 } }),
      ValidationError,
    );
    const hub = createNotificationHub(pool, options);
    for (const channel of ['', 'a";SELECT 1;--', 'has space', '1bad', 'x'.repeat(64), 'é']) {
      await assert.rejects(
        hub.subscribe(channel, () => {}),
        ValidationError,
      );
    }
    assert.equal(pool.connects, 0);
    const aborted = new AbortController();
    aborted.abort();
    await assert.rejects(
      hub.subscribe('good', () => {}, { signal: aborted.signal }),
      { name: 'AbortError' },
    );
    await hub.close();
    await assert.rejects(
      hub.subscribe('good', () => {}),
      ConnectionError,
    );
  });

  it('quotes case-sensitive channels, shares one checkout and reference counts UNLISTEN', async () => {
    const pool = new FakePool();
    const hub = createNotificationHub(pool, options);
    const seen: string[] = [];
    const [a, b, c] = await Promise.all([
      hub.subscribe('MixedCase', (p) => {
        seen.push(`a:${p}`);
      }),
      hub.subscribe('MixedCase', (p) => {
        seen.push(`b:${p}`);
      }),
      hub.subscribe('other', (p) => {
        seen.push(`c:${p}`);
      }),
    ]);
    const client = pool.clients[0]!;
    assert.equal(pool.connects, 1);
    assert.deepEqual(client.statements, ['LISTEN "MixedCase"', 'LISTEN "other"']);
    client.notify('mixedcase', 'ignored');
    client.notify('MixedCase', '1');
    client.notify('other', '2');
    assert.deepEqual(seen, ['a:1', 'b:1', 'c:2']);
    await a.unsubscribe();
    assert.deepEqual(client.statements, ['LISTEN "MixedCase"', 'LISTEN "other"']);
    await b.unsubscribe();
    assert.equal(client.statements.at(-1), 'UNLISTEN "MixedCase"');
    client.notify('MixedCase', 'ignored');
    client.notify('other', '3');
    await c.unsubscribe();
    await c.unsubscribe();
    assert.deepEqual(seen, ['a:1', 'b:1', 'c:2', 'c:3']);
    assert.equal(client.statements.at(-1), 'UNLISTEN *');
    assert.deepEqual(client.releases, [undefined]);
    assert.equal(client.listenerCount('notification'), 0);
    assert.equal(client.listenerCount('error'), 0);
    assert.equal(client.listenerCount('end'), 0);
    assert.deepEqual(hub.stats, {
      channels: 0,
      subscriptions: 0,
      connected: false,
      reconnecting: false,
      closed: false,
    });
    await hub.close();
    assert.equal(pool.ends, 0);
  });

  it('serializes simultaneous removals/additions during an UNLISTEN', async () => {
    const pool = new FakePool();
    const hub = createNotificationHub(pool, options);
    const a = await hub.subscribe('a', () => {});
    const b = await hub.subscribe('b', () => {});
    const gate = deferred<void>();
    const client = pool.clients[0]!;
    client.execute = async (text) => {
      if (text === 'UNLISTEN "a"') await gate.promise;
    };
    const removing = a.unsubscribe();
    await until(() => client.statements.includes('UNLISTEN "a"'));
    const adding = hub.subscribe('a', () => {});
    gate.resolve();
    const [replacement] = await Promise.all([adding, removing]);
    assert.deepEqual(client.statements, ['LISTEN "a"', 'LISTEN "b"', 'UNLISTEN "a"', 'LISTEN "a"']);
    await Promise.all([replacement.unsubscribe(), b.unsubscribe()]);
    await hub.close();
    assert.equal(client.releases.length, 1);
  });

  it('rejects bounds including pending consumers and releases cancelled late checkout exactly once', async () => {
    const pool = new FakePool();
    const gate = deferred<FakeClient>();
    pool.checkout = () => gate.promise;
    const hub = createNotificationHub(pool, { ...options, maxChannels: 1, maxSubscriptions: 2, ownership: 'owned' });
    const a = new AbortController(),
      b = new AbortController();
    const first = hub.subscribe('a', () => {}, { signal: a.signal });
    const second = hub.subscribe('a', () => {}, { signal: b.signal });
    await assert.rejects(
      hub.subscribe('b', () => {}),
      /limit/,
    );
    await assert.rejects(
      hub.subscribe('a', () => {}),
      /limit/,
    );
    const firstRejected = assert.rejects(first, { name: 'AbortError' });
    const secondRejected = assert.rejects(second, { name: 'AbortError' });
    a.abort();
    b.abort();
    await Promise.all([firstRejected, secondRejected]);
    assert.equal(hub.stats.subscriptions, 0);
    const closing = hub.close();
    assert.equal(pool.ends, 0);
    const late = new FakeClient();
    gate.resolve(late);
    await Promise.all([closing, hub.close()]);
    assert.equal(pool.connects, 1);
    assert.equal(pool.ends, 1);
    assert.deepEqual(late.releases, [true]);
    assert.deepEqual(late.statements, []);
  });

  it('isolates sync and async failures and coalesces overload without a payload queue', async () => {
    const pool = new FakePool();
    const fallback: string[] = [];
    const hub = createNotificationHub(pool, {
      ...options,
      onError: (e) => {
        fallback.push(e.message);
      },
    });
    const gate = deferred<void>();
    const errors: string[] = [],
      seen: string[] = [],
      resync: string[] = [];
    const sync = await hub.subscribe(
      'a',
      () => {
        throw new Error('sync');
      },
      {
        onError: () => {
          throw new Error('observer');
        },
      },
    );
    const asyncSub = await hub.subscribe(
      'a',
      async () => {
        throw new Error('async');
      },
      {
        onError: async (e) => {
          errors.push(e.message);
        },
      },
    );
    const slow = await hub.subscribe(
      'a',
      async (p) => {
        seen.push(p);
        await gate.promise;
      },
      {
        onResync: (r) => {
          resync.push(r);
        },
      },
    );
    const fastSeen: string[] = [];
    const fast = await hub.subscribe('a', (p) => {
      fastSeen.push(p);
    });
    const client = pool.clients[0]!;
    client.notify('a', '0');
    for (let i = 1; i < 1000; i++) client.notify('a', String(i));
    assert.deepEqual(seen, ['0']);
    assert.equal(fastSeen.length, 1000);
    assert.equal(fastSeen[999], '999');
    gate.resolve();
    await until(() => resync.length === 1 && errors.length > 0);
    assert.deepEqual(resync, ['overflow']);
    assert.deepEqual(errors, ['async']);
    assert.ok(fallback.every((e) => e === 'observer'));
    assert.ok(fallback.length > 0);
    await Promise.all([sync.unsubscribe(), asyncSub.unsubscribe(), slow.unsubscribe(), fast.unsubscribe()]);
    client.notify('a', 'after');
    assert.deepEqual(seen, ['0']);
    await hub.close();
  });

  it('restores every channel before reconnect/resync, isolates observers and cancels retries', async () => {
    const pool = new FakePool();
    const events: string[] = [];
    const hub = createNotificationHub(pool, { ...options, reconnect: { initialDelayMs: 5, maxDelayMs: 10 } });
    const a = await hub.subscribe('a', () => {}, {
      onError: (e) => {
        events.push(e.message);
      },
      onReconnect: () => {
        assert.deepEqual(pool.clients[1]!.statements, ['LISTEN "a"', 'LISTEN "b"']);
        events.push('reconnect');
      },
      onResync: (r) => {
        events.push(r);
      },
    });
    const b = await hub.subscribe('b', () => {});
    const client = pool.clients[0]!;
    client.emit('error', new Error('physical loss'));
    client.emit('end');
    await until(() => events.includes('reconnect'));
    await until(() => events.includes('reconnect') && events.at(-1) === 'reconnect' && events.length === 3);
    assert.match(events[0]!, /physical loss/);
    assert.deepEqual(events.slice(1), ['reconnect', 'reconnect']);
    assert.equal(client.releases.length, 1);
    assert.ok(client.releases[0] instanceof Error);
    assert.equal(client.listenerCount('notification'), 0);
    await Promise.all([a.unsubscribe(), b.unsubscribe()]);
    await hub.close();
    const connections = pool.connects;
    await delay(25);
    assert.equal(pool.connects, connections);
  });

  it('handles end without error, failed reconnect checkout and cancellation during retry checkout', async () => {
    const pool = new FakePool();
    const abort = new AbortController();
    const errors: Error[] = [];
    const hub = createNotificationHub(pool, { ...options, reconnect: { initialDelayMs: 5, maxDelayMs: 10 } });
    await hub.subscribe('a', () => {}, {
      signal: abort.signal,
      onError: (e) => {
        errors.push(e);
      },
    });
    const late = deferred<FakeClient>();
    let attempt = 0;
    pool.checkout = async () => {
      if (++attempt === 1) throw new Error('checkout failed');
      return late.promise;
    };
    pool.clients[0]!.emit('end');
    await until(() => pool.connects === 3);
    abort.abort();
    const closing = hub.close();
    const client = new FakeClient();
    late.resolve(client);
    await closing;
    assert.deepEqual(client.releases, [true]);
    assert.deepEqual(client.statements, []);
    assert.equal(hub.stats.subscriptions, 0);
    assert.equal(errors.length, 2);
  });

  it('fails initial checkout/LISTEN, refuses eventless clients and destroys dirty cleanup', async () => {
    const pool = new FakePool();
    const hub = createNotificationHub(pool, options);
    pool.checkout = async () => {
      throw new Error('checkout failed');
    };
    await assert.rejects(
      hub.subscribe('a', () => {}),
      /checkout failed/,
    );
    assert.equal(hub.stats.channels, 0);
    pool.checkout = async () => {
      const c = new FakeClient();
      c.execute = async () => {
        throw new Error('listen failed');
      };
      return c;
    };
    await assert.rejects(
      hub.subscribe('a', () => {}),
      /listen failed/,
    );
    assert.deepEqual(pool.clients[0]!.releases, [true]);
    const eventless = new FakeClient();
    Object.assign(eventless, { on: undefined, removeListener: undefined });
    pool.checkout = async () => eventless;
    await assert.rejects(
      hub.subscribe('a', () => {}),
      /native notification/,
    );
    assert.deepEqual(eventless.releases, [true]);
    pool.checkout = async () => new FakeClient();
    const sub = await hub.subscribe('a', () => {});
    const client = pool.clients.at(-1)!;
    client.execute = async () => {
      throw new Error('unlisten failed');
    };
    await sub.unsubscribe();
    assert.deepEqual(client.releases, [true]);
    await hub.close();
  });

  it('can disable reconnect and end an owned pool only on close', async () => {
    const pool = new FakePool();
    const hub = createNotificationHub(pool, { ...options, ownership: 'owned', reconnect: false });
    const sub = await hub.subscribe('a', () => {});
    pool.clients[0]!.emit('error', new Error('gone'));
    await sub.unsubscribe();
    assert.equal(hub.stats.subscriptions, 0);
    assert.equal(pool.ends, 0);
    await hub.close();
    await hub.close();
    assert.equal(pool.ends, 1);
    assert.equal(pool.connects, 1);
  });
  it('bounds native channel state under continuous pending channel churn', async () => {
    const pool = new FakePool();
    const client = new FakeClient();
    pool.checkout = async () => client;
    const hub = createNotificationHub(pool, { ...options, maxChannels: 1, maxSubscriptions: 1 });
    const server = new Set<string>(),
      results: Promise<string>[] = [];
    let abort = new AbortController(),
      index = 0;
    const issue = () => {
      results.push(
        hub
          .subscribe(`churn_${index}`, () => {}, { signal: abort.signal })
          .then(
            () => 'ready',
            (e) => e.name,
          ),
      );
    };
    client.execute = async (text) => {
      if (text.startsWith('LISTEN ')) {
        server.add(text.slice(7));
        assert.equal(server.size, 1, 'native channel state must not grow while awaited subscriptions churn');
        if (index++ < 50) {
          abort.abort();
          abort = new AbortController();
          issue();
        }
      } else if (text === 'UNLISTEN *') server.clear();
      else if (text.startsWith('UNLISTEN ')) server.delete(text.slice(9));
    };
    issue();
    await until(() => client.statements.filter((s) => s.startsWith('LISTEN ')).length === 51);
    assert.deepEqual(await Promise.all(results), [...Array(50).fill('AbortError'), 'ready']);
    await hub.close();
    assert.equal(server.size, 0);
    assert.deepEqual(client.releases, [undefined]);
  });

  it('observes loss during the first LISTEN once and refuses invalid signals before registration', async () => {
    const pool = new FakePool();
    const client = new FakeClient();
    pool.checkout = async () => client;
    const hub = createNotificationHub(pool, options);
    const errors: Error[] = [];
    await assert.rejects(
      hub.subscribe('a', () => {}, { signal: {} as AbortSignal }),
      ValidationError,
    );
    assert.equal(hub.stats.subscriptions, 0);
    client.execute = async () => {
      const error = new Error('lost in LISTEN');
      client.emit('error', error);
      throw error;
    };
    await assert.rejects(
      hub.subscribe('a', () => {}, {
        onError: (e) => {
          errors.push(e);
        },
      }),
      /lost in LISTEN/,
    );
    assert.equal(errors.length, 1);
    assert.equal(client.releases.length, 1);
    await hub.close();
    assert.equal(pool.connects, 1);
  });
});
