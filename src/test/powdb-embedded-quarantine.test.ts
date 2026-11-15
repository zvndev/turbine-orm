/**
 * An embedded PowDB handle whose COMMIT or ROLLBACK failed is in an unknown
 * state (on embedded 0.20.0 a failed ROLLBACK left reads returning wrong rows
 * and writes acknowledged and lost), and the handle is the whole database. The
 * pool fails closed: the failing statement and every later or queued operation
 * reject with ConnectionError (E004) naming the failure, nothing more reaches
 * the engine, and nothing reopens or retries. A networked connection is
 * discarded instead, and the client stays usable.
 *
 * Driven against fake handles so each step is exact; the live engine sequence
 * is in powdb-rollback-recovery.test.ts and powdb-embedded-quarantine.integration.test.ts.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { TurbineClient } from '../client.js';
import { ConnectionError } from '../errors.js';
import { PowdbEmbeddedPool, PowdbPool, powdbDialect } from '../powdb.js';

const ENGINE_FAILURE = 'query failed: bad heap superblock magic';

/** A fake embedded Database that fails the statements `fail` picks, as the addon does (a plain Error). */
function failingHandle(fail: (powql: string) => boolean) {
  const sent: string[] = [];
  const db = {
    query(powql: string) {
      sent.push(powql);
      if (fail(powql)) throw new Error(ENGINE_FAILURE);
      return { kind: 'ok', affected: 1n };
    },
    querySql: () => ({ kind: 'message', message: '' }),
    queryReadonly: () => ({ kind: 'message', message: '' }),
    isPoisoned: () => false,
  };
  return { sent, db };
}

function assertNamesFailure(err: unknown, statement: string): true {
  assert.ok(err instanceof ConnectionError, `got ${String(err)}`);
  assert.match(err.message, new RegExp(`A ${statement} on the embedded PowDB database failed`));
  assert.match(err.message, /bad heap superblock magic/);
  assert.match((err.cause as Error).message, /bad heap superblock magic/, 'the engine failure is the cause');
  return true;
}

describe('embedded PowDB pool after a failed COMMIT or ROLLBACK', () => {
  for (const statement of ['rollback', 'commit'] as const) {
    it(`a failed ${statement.toUpperCase()} makes the pool refuse every later operation`, async () => {
      const h = failingHandle((powql) => powql === statement);
      const pool = new PowdbEmbeddedPool(h.db as never);
      const client = await pool.connect();
      await client.query('begin');
      await client.query('insert t { n := 1 }');
      await assert.rejects(client.query(statement), (err) => assertNamesFailure(err, statement.toUpperCase()));
      assert.ok(client.unusable && assertNamesFailure(client.unusable, statement.toUpperCase()));
      const sentAtFailure = h.sent.length;

      await assert.rejects(pool.query('t { .n }'), (err) => assertNamesFailure(err, statement.toUpperCase()));
      await assert.rejects(client.query('t { .n }'), ConnectionError);
      const next = await pool.connect();
      await assert.rejects(next.query('begin'), (err) => assertNamesFailure(err, statement.toUpperCase()));
      next.release();
      client.release();
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(h.sent.length, sentAtFailure, 'nothing more reaches the engine, a release safety net included');
    });
  }

  it('refuses queued work at once instead of after its queue timeout', async () => {
    const h = failingHandle((powql) => powql === 'rollback');
    const pool = new PowdbEmbeddedPool(h.db as never, { transactionQueueTimeoutMs: 10_000 });
    const first = await pool.connect();
    await first.query('begin');
    const second = await pool.connect();
    const started = Date.now();
    const queuedBegin = second.query('begin').catch((err: unknown) => err);
    const queuedRead = pool.query('t { .n }').catch((err: unknown) => err);
    await new Promise((resolve) => setImmediate(resolve));
    await assert.rejects(first.query('rollback'), ConnectionError);
    assertNamesFailure(await queuedBegin, 'ROLLBACK');
    assertNamesFailure(await queuedRead, 'ROLLBACK');
    assert.ok(Date.now() - started < 2000, 'queued work did not wait out its queue timeout');
    assert.deepEqual(h.sent, ['begin', 'rollback'], 'queued work never reached the engine');
    first.release();
    second.release();
  });

  it('a pool whose transactions end cleanly stays usable', async () => {
    const h = failingHandle(() => false);
    const pool = new PowdbEmbeddedPool(h.db as never);
    const client = await pool.connect();
    await client.query('begin');
    await client.query('rollback');
    assert.equal(client.unusable, undefined);
    await pool.query('t { .n }');
    client.release();
  });

  it('$transaction reports the failed cleanup ROLLBACK instead of the callback error', async () => {
    const h = failingHandle((powql) => powql === 'rollback');
    const db = new TurbineClient(
      { pool: new PowdbEmbeddedPool(h.db as never), dialect: powdbDialect },
      { tables: {}, enums: {} },
    );
    const callbackError = new Error('the callback failed');
    const outcome = await db
      .$transaction(async () => {
        throw callbackError;
      })
      .catch((err: unknown) => err);
    assertNamesFailure(outcome, 'ROLLBACK');
    await assert.rejects(db.rawUnsafe('t { .n }'), (err) => assertNamesFailure(err, 'ROLLBACK'));
    await assert.rejects(
      db.$transaction(async () => {}),
      (err) => assertNamesFailure(err, 'ROLLBACK'),
    );
  });

  it('$transaction reports a failed COMMIT, and the pool refuses what follows', async () => {
    const h = failingHandle((powql) => powql === 'commit');
    const db = new TurbineClient(
      { pool: new PowdbEmbeddedPool(h.db as never), dialect: powdbDialect },
      { tables: {}, enums: {} },
    );
    await assert.rejects(
      db.$transaction(async () => {}),
      (err) => assertNamesFailure(err, 'COMMIT'),
    );
    await assert.rejects(db.rawUnsafe('t { .n }'), (err) => assertNamesFailure(err, 'COMMIT'));
    assert.deepEqual(h.sent, ['begin', 'commit']);
  });
});

describe('networked PowDB after a failed COMMIT or ROLLBACK', () => {
  it('discards that connection and keeps the client usable', async () => {
    const destroyed: unknown[] = [];
    const released: unknown[] = [];
    let n = 0;
    const connect = () => {
      const id = ++n;
      return {
        id,
        serverVersion: '0.20.0',
        async query(powql: string) {
          if (id === 1 && powql === 'rollback') throw new Error(ENGINE_FAILURE);
          return { kind: 'ok', affected: 1n };
        },
        close: async () => {},
      };
    };
    const driver = {
      acquire: async () => connect(),
      release: (c: unknown) => released.push(c),
      destroy: (c: unknown) => destroyed.push(c),
      withClient: async (fn: (c: unknown) => unknown) => fn(connect()),
      close: async () => {},
    };
    const pool = new PowdbPool(driver as never);
    const client = await pool.connect();
    await client.query('begin');
    await assert.rejects(
      client.query('rollback'),
      (err) => !(err instanceof ConnectionError) || !/embedded/.test(err.message),
    );
    assert.equal(client.unusable, undefined, 'only the connection is lost, not the client');
    client.release();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(
      destroyed.map((c) => (c as { id: number }).id),
      [1],
      'the connection whose ROLLBACK failed is destroyed, not pooled',
    );
    assert.equal(released.length, 0);
    const again = await pool.connect();
    await again.query('begin');
    await again.query('commit');
    again.release();
  });
});
