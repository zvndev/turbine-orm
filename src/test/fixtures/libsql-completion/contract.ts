import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { LibsqlPool, LibsqlTransaction } from '../../../libsql.js';

type API = typeof import('../../../libsql.js');
type Open = typeof import('@libsql/client/node').createClient;
const schema = { tables: {}, enums: {} };
const reasons = () => [
  undefined,
  null,
  false,
  0,
  Symbol('failure'),
  Object.freeze(new Error('failure')),
  // biome-ignore lint/suspicious/noThenProperty: a rejected thenable must retain identity without assimilation.
  Object.freeze({ then: () => assert.fail('rejection reason was assimilated') }),
];
async function rejected(work: Promise<unknown>, expected: unknown) {
  let failed = false;
  try {
    await work;
  } catch (error) {
    failed = true;
    assert(Object.is(error, expected), 'exact rejection reason');
  }
  assert(failed, 'operation must reject');
}
function contains(error: unknown, target: unknown): boolean {
  for (let n = 0; n < 8 && error && typeof error === 'object'; n++, error = (error as Error).cause) {
    if (error === target) return true;
  }
  return false;
}

/** Real deferred FK failure with a qualified, one-shot fault after native close. */
export async function deferred(api: API, open: Open, root: string) {
  mkdirSync(root, { recursive: true });
  const cases = [];
  for (const inject of [false, true]) {
    const file = join(root, inject ? 'close-error.db' : 'native-only.db');
    const url = pathToFileURL(file).href;
    const native = open({ url, intMode: 'bigint', concurrency: 1 });
    let primary: unknown;
    const secondary = Object.freeze(new Error('close after actual native close'));
    const transaction = native.transaction.bind(native);
    let remaining = inject ? 1 : 0;
    let calls = 0;
    let callbackCalls = 0;
    native.transaction = async (...args: Parameters<typeof native.transaction>) => {
      const tx = await transaction(...args);
      const commit = tx.commit.bind(tx),
        close = tx.close.bind(tx);
      tx.commit = async () => {
        calls++;
        try {
          await commit();
        } catch (error) {
          primary = error;
          throw error;
        }
      };
      tx.close = () => {
        close();
        if (remaining) {
          remaining--;
          throw secondary;
        }
      };
      return tx;
    };
    let db: Awaited<ReturnType<API['turbineLibsql']>> | undefined;
    try {
      await native.execute('PRAGMA foreign_keys=ON');
      for (const sql of [
        'CREATE TABLE parents(id INTEGER PRIMARY KEY, label TEXT UNIQUE)',
        'CREATE TABLE children(id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parents(id) DEFERRABLE INITIALLY DEFERRED)',
        'CREATE TABLE effects(id INTEGER PRIMARY KEY, payload TEXT)',
        "INSERT INTO parents VALUES(1,'retained')",
      ])
        await native.execute(sql);
      db = await api.turbineLibsql({ client: native, url }, schema, { logger: {} });
      await assert.rejects(
        db.$transaction(async (tx) => {
          callbackCalls++;
          await tx.rawUnsafe("INSERT INTO effects VALUES(1,'must rollback')");
          await tx.rawUnsafe('INSERT INTO children VALUES(1,999)');
        }),
        (error: unknown) => {
          assert.equal((error as { code: string }).code, 'TURBINE_E009');
          assert.equal((primary as { rawCode: number }).rawCode, 787);
          assert(contains(error, primary), 'native primary must survive cleanup failure');
          assert(!contains(error, secondary));
          return true;
        },
      );
      assert.equal(calls, 1);
      assert.equal(callbackCalls, 1);
      if (inject) {
        await rejected(db.disconnect(), secondary);
        await rejected(db.disconnect(), secondary);
        await assert.rejects(db.rawUnsafe('SELECT 1'), /closed|disconnect/);
      } else await db.disconnect();
      const parents = (await native.execute('SELECT * FROM parents ORDER BY id')).rows.map((r) => Array.from(r));
      const children = (await native.execute('SELECT * FROM children ORDER BY id')).rows.map((r) => Array.from(r));
      const effects = (await native.execute('SELECT * FROM effects ORDER BY id')).rows.map((r) => Array.from(r));
      assert.deepEqual(parents, [[1n, 'retained']]);
      assert.deepEqual(children, []);
      assert.deepEqual(effects, []);
      await assert.rejects(
        native.execute("INSERT INTO parents VALUES(2,'retained')"),
        (error: unknown) => (error as { rawCode: number }).rawCode === 2067,
      );
      assert.equal(native.closed, false);
      cases.push({
        inject,
        file,
        parents: [['1', 'retained']],
        children,
        effects,
        nativeCode: 787,
        publicCode: 'TURBINE_E009',
        callbackCalls,
        commitCalls: calls,
        callerSurvived: true,
      });
    } finally {
      if (db) await db.disconnect().catch(() => {});
      native.close();
      assert.equal(native.closed, true);
    }
  }
  return cases;
}

export async function combinations(api: API, open: Open) {
  let cases = 0;
  for (const kind of ['commit', 'rollback'] as const)
    for (const primary of reasons())
      for (const secondary of reasons()) {
        const native = open({ url: ':memory:', intMode: 'bigint' });
        const pool = new api.LibsqlPool(native);
        const transaction = native.transaction.bind(native);
        native.transaction = async (...args: Parameters<typeof native.transaction>) => {
          const tx = await transaction(...args),
            rollback = tx.rollback.bind(tx),
            close = tx.close.bind(tx);
          tx[kind] = async () => {
            await rollback();
            throw primary;
          };
          tx.close = () => {
            close();
            throw secondary;
          };
          return tx;
        };
        try {
          await pool.query('CREATE TABLE t(n INTEGER, payload TEXT)');
          const lease = await pool.connect();
          await lease.query('BEGIN');
          await lease.query("INSERT INTO t VALUES(7,'uncommitted')");
          const finishing = lease.query(kind.toUpperCase());
          const late = lease.query('SELECT 1');
          const queued = pool.query('SELECT 1');
          // Attach handlers immediately; every queued path must settle with refusal.
          const lateCheck = assert.rejects(late, /cleanup|closed/),
            queuedCheck = assert.rejects(queued, /closed/);
          await rejected(finishing, primary);
          lease.release();
          lease.release();
          await Promise.all([lateCheck, queuedCheck]);
          await rejected(pool.end(), secondary);
          await rejected(pool.end(), secondary);
          assert.equal(native.closed, false);
          assert.deepEqual(
            (await native.execute('SELECT * FROM t')).rows.map((r) => Array.from(r)),
            [],
          );
          cases++;
        } finally {
          native.close();
        }
      }
  return cases;
}

export async function callbackFailures(api: API, open: Open) {
  let cases = 0;
  for (const primary of reasons())
    for (const secondary of reasons()) {
      const native = open({ url: ':memory:', intMode: 'bigint' });
      const transaction = native.transaction.bind(native);
      native.transaction = async (...args: Parameters<typeof native.transaction>) => {
        const tx = await transaction(...args),
          rollback = tx.rollback.bind(tx),
          close = tx.close.bind(tx);
        tx.rollback = async () => {
          await rollback();
          throw Object.freeze(new Error('rollback acknowledgement fault'));
        };
        tx.close = () => {
          close();
          throw secondary;
        };
        return tx;
      };
      const db = await api.turbineLibsql({ client: native, url: ':memory:' }, schema, { logger: {} });
      try {
        await db.rawUnsafe('CREATE TABLE t(n INTEGER, payload TEXT)');
        await rejected(
          db.$transaction(async (tx) => {
            await tx.rawUnsafe("INSERT INTO t VALUES(1,'callback')");
            throw primary;
          }),
          primary,
        );
        await rejected(db.disconnect(), secondary);
        await rejected(db.disconnect(), secondary);
        assert.equal(native.closed, false);
        assert.deepEqual(
          (await native.execute('SELECT * FROM t')).rows.map((r) => Array.from(r)),
          [],
        );
        cases++;
      } finally {
        native.close();
      }
    }
  return cases;
}

export async function committedAndUnresolved(api: API, open: Open) {
  const cases = [];
  for (const owned of [false, true])
    for (const unresolved of [false, true]) {
      const db = owned ? await api.turbineLibsql(':memory:', schema, { logger: {} }) : undefined;
      const native = db ? (db.pool as LibsqlPool).client : open({ url: ':memory:', intMode: 'bigint' });
      const pool = db ? (db.pool as LibsqlPool) : new api.LibsqlPool(native);
      const secondary = Object.freeze(new Error('first native close fault'));
      const primary = Object.freeze(new Error('commit refused before native completion'));
      let actualClose: (() => void) | undefined,
        held: LibsqlTransaction | undefined,
        clientCloses = 0,
        commits = 0,
        closes = 0;
      const nativeClose = native.close.bind(native),
        transaction = native.transaction.bind(native);
      native.close = () => {
        clientCloses++;
        nativeClose();
      };
      native.transaction = async (...args: Parameters<typeof native.transaction>) => {
        const tx = await transaction(...args),
          close = tx.close.bind(tx),
          commit = tx.commit.bind(tx);
        held = tx;
        actualClose = close;
        tx.commit = async () => {
          commits++;
          if (unresolved) throw primary;
          await commit();
        };
        tx.close = () => {
          closes++;
          if (!unresolved) close();
          throw secondary;
        };
        return tx;
      };
      try {
        await pool.query('CREATE TABLE t(n INTEGER, payload TEXT)');
        const lease = await pool.connect();
        await lease.query('BEGIN');
        await lease.query("INSERT INTO t VALUES(1,'stored')");
        const queued = assert.rejects(pool.query('SELECT 1'), /closed/);
        await rejected(lease.query('COMMIT'), unresolved ? primary : secondary);
        lease.release();
        await queued;
        assert.equal(commits, 1);
        assert.equal(closes, 2);
        assert.equal(held!.closed, !unresolved);
        await assert.rejects(pool.connect(), /closed/);
        // Explicit owner teardown of a fault-injected, still-open native handle.
        // Adapter refusal is checked before this action; rollback is not inferred.
        actualClose!();
        assert.equal(held!.closed, true);
        const rows = (await native.execute({ sql: 'SELECT * FROM t' })).rows.map((r) => [r[0], r[1]]);
        assert.deepEqual(rows, unresolved ? [] : [[1n, 'stored']]);
        await rejected(pool.end(), secondary);
        await rejected(pool.end(), secondary);
        assert.equal(clientCloses, owned ? 1 : 0);
        assert.equal(native.closed, owned);
        if (db) {
          await rejected(db.disconnect(), secondary);
          await rejected(db.disconnect(), secondary);
          assert.equal(clientCloses, 1);
        }
        cases.push({
          owned,
          unresolved,
          rows: unresolved ? [] : [['1', 'stored']],
          commitCalls: commits,
          closeCalls: closes,
          factoryCloses: clientCloses,
          unresolvedBeforeOwnerTeardown: unresolved,
        });
      } finally {
        actualClose?.();
        if (!native.closed) nativeClose();
      }
    }
  return cases;
}
