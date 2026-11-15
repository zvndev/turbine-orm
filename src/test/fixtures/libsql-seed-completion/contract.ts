import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import type { LibsqlLocalClient, LibsqlTransaction } from '../../../libsql.js';

type API = typeof import('../../../libsql.js');
type Seed = typeof import('../../../libsql-seed.js');
type Open = typeof import('@libsql/client/node').createClient;
const schema = { tables: {}, enums: {} };
const options = { logger: {}, warnOnUnlimited: false };
const reasons = () => [undefined, null, false, 0, NaN, '', Symbol('cleanup'), Object.freeze({}), new Error('cleanup')];

async function rejection(work: Promise<unknown>): Promise<{ reason: unknown }> {
  try {
    await work;
  } catch (reason) {
    return { reason };
  }
  return assert.fail('operation must reject');
}

export async function completion(
  api: API,
  seed: Seed,
  open: Open,
  root: string,
  registered?: (pool: object) => boolean,
) {
  mkdirSync(root, { recursive: true });
  const reports = [];
  for (const mode of ['retained', 'callback', 'commit', 'rollback', 'deferred', 'factory', 'owned', 'before']) {
    for (const reason of reasons()) {
      const url = `file:${root}/${reports.length}.db`;
      const caller = open({ url, intMode: 'bigint' });
      await caller.execute('CREATE TABLE effects(n INTEGER PRIMARY KEY, label TEXT)');
      await caller.execute('PRAGMA foreign_keys=ON');
      await caller.execute('CREATE TABLE child(n INTEGER REFERENCES effects(n) DEFERRABLE INITIALLY DEFERRED)');
      const prototype = Object.getPrototypeOf(caller) as LibsqlLocalClient;
      const originalTransaction = prototype.transaction,
        originalClose = prototype.close;
      const originalConnect = api.LibsqlPool.prototype.connect;
      const later = new Error('later cleanup');
      let pool: object | undefined, held: LibsqlTransaction | undefined, actualClose: (() => void) | undefined;
      let closes = 0,
        clientCloses = 0,
        commits = 0,
        rollbacks = 0,
        releases = 0,
        callbacks = 0;
      let nativePrimary: unknown;
      const phases: string[] = [];
      prototype.transaction = async function (kind) {
        const tx = await originalTransaction.call(this, kind);
        held = tx;
        const commit = tx.commit.bind(tx),
          rollback = tx.rollback.bind(tx),
          close = tx.close.bind(tx);
        actualClose = close;
        tx.commit = async () => {
          commits++;
          if (mode === 'before') throw reason;
          if (mode === 'commit') {
            await rollback();
            phases.push('native rollback acknowledged before injected completion rejection');
            throw reason;
          }
          try {
            await commit();
            phases.push('native COMMIT acknowledged');
          } catch (error) {
            nativePrimary = error;
            phases.push('native COMMIT rejected');
            throw error;
          }
        };
        tx.rollback = async () => {
          rollbacks++;
          await rollback();
          phases.push('native ROLLBACK acknowledged');
          if (mode === 'rollback') throw reason;
        };
        tx.close = () => {
          closes++;
          if (mode !== 'before') close();
          phases.push(mode === 'before' ? 'injected close before native release' : 'native transaction close returned');
          if (mode !== 'factory') throw closes === 1 ? reason : later;
        };
        return tx;
      };
      prototype.close = function () {
        clientCloses++;
        originalClose.call(this);
        assert.equal(this.closed, true);
        if (mode === 'factory') throw reason;
        if (mode === 'owned') throw later;
      };
      api.LibsqlPool.prototype.connect = async function () {
        pool = this;
        if (registered) assert.equal(registered(this), true);
        const lease = await originalConnect.call(this),
          release = lease.release;
        lease.release = (...args) => {
          releases++;
          return release.apply(lease, args);
        };
        return lease;
      };
      try {
        const owned = mode === 'owned' || mode === 'factory';
        const { reason: caught } = await rejection(
          seed.runLibsqlSeed(
            owned ? url : { client: caller, url },
            schema,
            async (tx) => {
              callbacks++;
              await tx.rawUnsafe("INSERT INTO effects VALUES(1,'effect')");
              if (mode === 'deferred') await tx.rawUnsafe('INSERT INTO child VALUES(99)');
              if (mode === 'callback' || mode === 'rollback' || mode === 'factory') throw reason;
            },
            options,
          ),
        );
        assert.equal(callbacks, 1);
        assert.equal(releases, 1);
        assert(pool);
        if (registered) assert.equal(registered(pool), false, 'seed registration removed after rejection');
        if (mode === 'retained' || mode === 'owned') assert(Object.is(caught, reason), 'one retained cleanup event');
        else {
          assert(caught instanceof AggregateError, 'distinct failure events must compose');
          assert.equal(caught.errors.length, 2);
          assert(Object.is(caught.errors[1], reason), 'first cleanup reason survives later cleanup');
          if (mode === 'deferred') {
            assert.equal(caught.errors[0].code, 'TURBINE_E009');
            assert.equal((nativePrimary as { rawCode: number }).rawCode, 787);
            assert.equal(caught.errors[0].cause.cause, nativePrimary);
          } else assert(Object.is(caught.errors[0], reason), 'equal-valued primary is still distinct');
        }
        assert.equal(clientCloses, owned ? 1 : 0);
        assert.equal(caller.closed, false);
        if (mode === 'before') {
          assert.equal(held!.closed, false, 'refusal does not prove native release');
          actualClose!();
        }
        const expected = mode === 'retained' || mode === 'owned' ? [[1n, 'effect']] : [];
        assert.deepEqual(
          (await caller.execute('SELECT * FROM effects')).rows.map((r) => Array.from(r)),
          expected,
        );
        assert.deepEqual((await caller.execute('SELECT * FROM child')).rows, []);
        assert.equal(held!.closed, true);
        reports.push({
          mode,
          commits,
          rollbacks,
          closes,
          clientCloses,
          callbacks,
          releases,
          phases,
          rows: expected.length ? [['1', 'effect']] : [],
        });
      } finally {
        prototype.transaction = originalTransaction;
        prototype.close = originalClose;
        api.LibsqlPool.prototype.connect = originalConnect;
        actualClose?.();
        originalClose.call(caller);
      }
      const reopened = open({ url, intMode: 'bigint' });
      try {
        assert.deepEqual(
          (await reopened.execute('SELECT * FROM effects')).rows.map((r) => Array.from(r)),
          mode === 'retained' || mode === 'owned' ? [[1n, 'effect']] : [],
        );
      } finally {
        reopened.close();
      }
    }
  }
  return reports;
}

export async function getters(api: API, seed: Seed, open: Open) {
  let cases = 0;
  for (const primary of [false, true])
    for (const boundary of ['code', 'rawCode', 'message', 'shared-code', 'shared-message'])
      for (const equal of [false, true]) {
        let reads = 0;
        const replacement = new Error('getter replacement');
        const reason = boundary === 'shared-message' ? new Error('cleanup') : {};
        const get = () => {
          reads++;
          throw equal ? reason : replacement;
        };
        if (boundary === 'code') Object.defineProperty(reason, 'code', { get });
        if (boundary === 'rawCode') Object.defineProperty(reason, 'rawCode', { get });
        if (boundary === 'message') {
          Object.defineProperty(reason, 'rawCode', { value: 787 });
          Object.defineProperty(reason, 'message', { get });
        }
        if (boundary === 'shared-code')
          Object.defineProperty(reason, 'code', {
            get() {
              if (++reads === 6) throw equal ? reason : replacement;
              return undefined;
            },
          });
        if (boundary === 'shared-message') Object.defineProperty(reason, 'message', { get });
        const native = open({ url: ':memory:', intMode: 'bigint' });
        await native.execute('CREATE TABLE effects(n INTEGER)');
        const transaction = native.transaction.bind(native);
        native.transaction = async (...args: Parameters<typeof native.transaction>) => {
          const tx = await transaction(...args),
            close = tx.close.bind(tx),
            commit = tx.commit.bind(tx),
            rollback = tx.rollback.bind(tx);
          tx.commit = async () => {
            if (primary) {
              await rollback();
              throw reason;
            }
            await commit();
          };
          tx.close = () => {
            close();
            throw reason;
          };
          return tx;
        };
        try {
          const { reason: caught } = await rejection(
            seed.runLibsqlSeed(
              { client: native, url: ':memory:' },
              schema,
              async (tx) => {
                await tx.rawUnsafe('INSERT INTO effects VALUES(1)');
              },
              options,
            ),
          );
          if (primary) {
            assert(caught instanceof AggregateError);
            assert.equal(caught.errors.length, 2);
            assert(Object.is(caught.errors[0], equal ? reason : replacement));
            assert(Object.is(caught.errors[1], reason));
            assert(reads > 0);
          } else {
            assert(Object.is(caught, reason));
            assert.equal(reads, 0, 'cleanup values must not enter statement translators');
          }
          assert.deepEqual(
            (await native.execute('SELECT * FROM effects')).rows.map((r) => Array.from(r)),
            primary ? [] : [[1n]],
          );
          assert(!native.closed);
          cases++;
        } finally {
          native.close();
        }
      }
  // This public pool is outside any seed: successful COMMIT cleanup still rejects immediately.
  const native = open({ url: ':memory:', intMode: 'bigint' }),
    pool = new api.LibsqlPool(native);
  const cleanup = new Error('ordinary public completion cleanup'),
    transaction = native.transaction.bind(native);
  native.transaction = async (...args: Parameters<typeof native.transaction>) => {
    const tx = await transaction(...args),
      close = tx.close.bind(tx);
    tx.close = () => {
      close();
      throw cleanup;
    };
    return tx;
  };
  try {
    const lease = await pool.connect();
    await lease.query('BEGIN');
    assert.equal((await rejection(lease.query('COMMIT'))).reason, cleanup);
    lease.release();
    assert.equal((await rejection(pool.end())).reason, cleanup);
    assert.equal((await rejection(pool.end())).reason, cleanup);
    assert(!native.closed);
  } finally {
    native.close();
  }
  return cases;
}

export async function scopes(api: API, seed: Seed, open: Open, registered: (pool: object) => boolean) {
  const a = open({ url: ':memory:', intMode: 'bigint' }),
    b = open({ url: ':memory:', intMode: 'bigint' }),
    c = open({ url: ':memory:', intMode: 'bigint' });
  for (const native of [a, b, c]) await native.execute('CREATE TABLE effects(n INTEGER)');
  const cleanup = new Error('one seed cleanup'),
    ordinaryCleanup = new Error('ordinary cleanup');
  let closes = 0;
  for (const [native, reason] of [
    [a, cleanup],
    [c, ordinaryCleanup],
  ] as const) {
    const transaction = native.transaction.bind(native);
    native.transaction = async (...args: Parameters<typeof native.transaction>) => {
      const tx = await transaction(...args),
        close = tx.close.bind(tx);
      tx.close = () => {
        close();
        if (native === c || ++closes === 1) throw reason;
      };
      return tx;
    };
  }
  const ordinary = await api.turbineLibsql({ client: c, url: ':memory:' }, schema, options);
  const connect = api.LibsqlPool.prototype.connect;
  const pools: InstanceType<API['LibsqlPool']>[] = [];
  api.LibsqlPool.prototype.connect = async function () {
    pools.push(this);
    assert.equal(registered(this), this.client !== c, 'registration belongs to exact seed wrapper');
    return connect.call(this);
  };
  try {
    const { reason } = await rejection(
      seed.runLibsqlSeed(
        { client: a, url: ':memory:' },
        schema,
        async (txA) => {
          await seed.runLibsqlSeed(
            { client: b, url: ':memory:' },
            schema,
            async (txB) => {
              await assert.rejects(
                seed.runLibsqlSeed(
                  { client: a, url: ':memory:' },
                  schema,
                  () => assert.fail('reentrant seed admitted'),
                  options,
                ),
                /transaction|connection/i,
              );
              assert(registered(pools[0]!));
              assert(registered(pools[1]!));
              assert.equal(
                (
                  await rejection(
                    ordinary.$transaction(async (tx) => {
                      await tx.rawUnsafe('INSERT INTO effects VALUES(3)');
                    }),
                  )
                ).reason,
                ordinaryCleanup,
              );
              assert.equal(registered(ordinary.pool), false);
              await txB.rawUnsafe('INSERT INTO effects VALUES(2)');
            },
            options,
          );
          assert.equal(registered(pools[1]!), false, 'nested completed seed unregisters independently');
          assert(registered(pools[0]!));
          await txA.rawUnsafe('INSERT INTO effects VALUES(1)');
        },
        options,
      ),
    );
    assert.equal(reason, cleanup);
    assert(pools.length >= 3);
    for (const pool of pools) assert.equal(registered(pool), false);
    await seed.runLibsqlSeed(
      { client: a, url: ':memory:' },
      schema,
      async (tx) => {
        await tx.rawUnsafe('INSERT INTO effects VALUES(4)');
      },
      options,
    );
    for (const pool of pools) assert.equal(registered(pool), false, 'later seed has no leaked registration');
    assert.equal((await rejection(ordinary.disconnect())).reason, ordinaryCleanup);
    for (const [native, expected] of [
      [a, [[1n], [4n]]],
      [b, [[2n]]],
      [c, [[3n]]],
    ] as const) {
      assert.deepEqual(
        (await native.execute('SELECT * FROM effects ORDER BY n')).rows.map((r) => Array.from(r)),
        expected,
      );
      assert.equal(native.closed, false);
    }
  } finally {
    api.LibsqlPool.prototype.connect = connect;
    await ordinary.disconnect().catch(() => {});
    for (const native of [a, b, c]) native.close();
  }
}

export async function outstanding(seed: Seed, open: Open) {
  const native = open({ url: ':memory:', intMode: 'bigint' });
  await native.execute('CREATE TABLE effects(n INTEGER)');
  let entered!: () => void, resume!: () => void;
  const began = new Promise<void>((resolve) => {
      entered = resolve;
    }),
    held = new Promise<void>((resolve) => {
      resume = resolve;
    });
  const cleanup = new Error('rollback cleanup after lifecycle failure'),
    transaction = native.transaction.bind(native);
  native.transaction = async (...args: Parameters<typeof native.transaction>) => {
    const tx = await transaction(...args),
      execute = tx.execute.bind(tx),
      close = tx.close.bind(tx);
    tx.execute = async (statement) => {
      if (typeof statement !== 'string' && statement.sql.startsWith('INSERT')) {
        entered();
        await held;
      }
      return execute(statement);
    };
    tx.close = () => {
      close();
      throw cleanup;
    };
    return tx;
  };
  let pending: Promise<unknown> | undefined;
  const work = seed.runLibsqlSeed(
    { client: native, url: ':memory:' },
    schema,
    async (tx) => {
      pending = tx.rawUnsafe('INSERT INTO effects VALUES(1)');
      void pending.catch(() => {});
      await began;
    },
    options,
  );
  const result = rejection(work);
  try {
    await began;
    await new Promise<void>((resolve) => setImmediate(resolve));
    resume();
    const { reason } = await result;
    assert(reason instanceof AggregateError);
    assert.equal(reason.errors.length, 2);
    assert.equal(reason.errors[0].code, 'TURBINE_E003');
    assert.match(reason.errors[0].message, /await|outstanding|running|pending/i);
    assert.equal(reason.errors[1], cleanup);
    await Promise.allSettled([pending]);
    assert.deepEqual((await native.execute('SELECT * FROM effects')).rows, []);
    assert.equal(native.closed, false);
  } finally {
    resume();
    await Promise.allSettled([work, pending]);
    native.close();
  }
}
