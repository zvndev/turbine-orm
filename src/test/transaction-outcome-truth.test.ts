/**
 * What a native pg transaction reports about its outcome, by what the server
 * confirmed. Rollback is claimed (error text, `outcome`, the
 * `transaction-rolled-back` log, a leaked handle's refusal) only on the
 * server's word: a ROLLBACK acknowledged before any COMMIT was sent, or the
 * COMMIT's own answer (an ERROR, or the `ROLLBACK` command tag). A COMMIT that
 * was sent and never answered is TransactionOutcomeUnknownError (E021); a
 * cleanup that was not acknowledged keeps the caller's error and discards the
 * connection. Every case runs on `transaction()`, `$transaction(fn)` and the
 * array form.
 *
 * The live counterpart, against a real server, is
 * transaction-outcome.integration.test.ts.
 */

import assert from 'node:assert/strict';
import diagnostics_channel from 'node:diagnostics_channel';
import { EventEmitter } from 'node:events';
import { describe, it } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { type TransactionClient, TurbineClient, withRetry } from '../client.js';
import { type Dialect, postgresDialect } from '../dialect.js';
import {
  ConnectionError,
  SerializationFailureError,
  TimeoutError,
  TransactionOutcomeUnknownError,
  TransactionRolledBackError,
  TurbineErrorCode,
  ValidationError,
} from '../errors.js';
import type { PgCompatPool, PgCompatPoolClient } from '../pg-types.js';
import { QUERY_CHANNEL, type QueryChannelContext } from '../query-channel.js';
import { type TransactionScope, TransactionState } from '../transaction-state.js';

type Api = 'transaction' | '$transaction' | 'batch';
const APIS: readonly Api[] = ['transaction', '$transaction', 'batch'];

/** A server error response, as node-postgres reports one. */
function serverError(code: string, severity: string, message = `server said ${code}`): Error {
  return Object.assign(new Error(message), { code, severity });
}

interface Plan {
  /** What the COMMIT does: resolve with this result, or throw what it throws. */
  commit?: () => unknown;
  /** `refuse`: rejected before it is sent. `delay`: answered after the 2 s grace. */
  rollback?: 'refuse' | 'delay';
  /** Settles a `SELECT pg_sleep(...)` sent through the transaction. */
  slow?: Promise<void>;
  /** Refuse `sessionContext`'s `set_config` the way a role without the privilege is refused. */
  refuseSetting?: boolean;
  /** The client's dialect (default PostgreSQL). */
  dialect?: Dialect;
}

function fixture(plan: Plan = {}) {
  const order: string[] = [];
  const raw = Object.assign(new EventEmitter(), {
    async query(text: string | { text: string }) {
      const sql = typeof text === 'string' ? text : text.text;
      if (sql === 'ROLLBACK' && plan.rollback === 'refuse')
        throw new Error('injected: ROLLBACK refused before dispatch');
      order.push(sql);
      if (plan.refuseSetting && sql.includes('set_config')) throw serverError('42501', 'ERROR', 'permission denied');
      if (sql === 'COMMIT' && plan.commit) return plan.commit();
      if (sql === 'ROLLBACK' && plan.rollback === 'delay') await delay(2500);
      if (sql.startsWith('SELECT pg_sleep') && plan.slow) await plan.slow;
      return { rows: [], rowCount: 0, command: sql.split(' ')[0] };
    },
    release(error?: unknown) {
      order.push(error ? 'discard' : 'release');
    },
  });
  const pool = Object.assign(new EventEmitter(), {
    query: raw.query,
    async connect() {
      return raw;
    },
    async end() {},
  });
  const db = new TurbineClient(
    {
      pool: pool as unknown as PgCompatPool,
      logging: true,
      logger: { debug: (_message, entry) => order.push(entry.code) },
      ...(plan.dialect ? { dialect: plan.dialect } : {}),
    },
    { tables: {}, enums: {} },
  );
  order.length = 0;
  return { db, order };
}

type Handle = PgCompatPoolClient & TransactionClient;

/** Run one transaction on `api`; `body` runs in the callback forms only. */
function run(db: TurbineClient, api: Api, body?: (handle: Handle) => Promise<unknown>): Promise<unknown> {
  if (api === 'transaction') return db.transaction((client) => (body ? body(client as Handle) : Promise.resolve(7)));
  if (api === '$transaction') return db.$transaction((tx) => (body ? body(tx as Handle) : Promise.resolve(7)));
  return db.$transaction([{ sql: 'SELECT 7', params: [], tag: 'outcome.check', transform: () => 7 }]);
}

/** Captures the handle a callback form passes in, so a late use can read its refusal. */
function leak(): { capture: (handle: Handle) => Promise<number>; refusal: () => Promise<string> } {
  let handle: Handle | undefined;
  return {
    capture: async (h) => {
      handle = h;
      return 7;
    },
    refusal: async () => {
      try {
        await ('rawUnsafe' in handle! ? handle!.rawUnsafe('SELECT 1') : handle!.query('SELECT 1'));
      } catch (err) {
        assert.ok(err instanceof ValidationError);
        return err.message;
      }
      throw new Error('a late query through the handle was not refused');
    },
  };
}

const before = (api: Api) => ['BEGIN', ...(api === 'batch' ? ['SELECT 7'] : [])];
const logged = (api: Api, code: string) => (api === 'transaction' ? [] : [code]);

describe('an unanswered COMMIT: the outcome is unknown', () => {
  for (const api of APIS) {
    it(`${api}: E021 carrying the COMMIT failure, no ROLLBACK sent, connection discarded`, async () => {
      const lost = new Error('Query read timeout');
      const { db, order } = fixture({
        commit: () => {
          throw lost;
        },
      });
      const late = leak();
      let thrown: unknown;
      await run(db, api, late.capture).catch((err: unknown) => {
        thrown = err;
      });
      assert.ok(thrown instanceof TransactionOutcomeUnknownError, `got ${String(thrown)}`);
      assert.equal(thrown.code, TurbineErrorCode.TRANSACTION_OUTCOME_UNKNOWN);
      assert.equal(thrown.cause, lost);
      assert.equal((thrown as { isRetryable?: unknown }).isRetryable, undefined);
      assert.doesNotMatch(thrown.message, /rolled back/);
      assert.deepEqual(order, [...before(api), 'COMMIT', 'discard', ...logged(api, 'transaction-outcome-unknown')]);
      if (api !== 'batch') assert.match(await late.refusal(), /ended with an unknown outcome/);
    });
  }

  it('a connection lost during COMMIT is E021 too, with the typed loss as cause', async () => {
    const { db, order } = fixture({
      commit: () => {
        throw new Error('Connection terminated unexpectedly');
      },
    });
    await assert.rejects(
      run(db, '$transaction'),
      (err) => err instanceof TransactionOutcomeUnknownError && err.cause instanceof ConnectionError,
    );
    assert.deepEqual(order, ['BEGIN', 'COMMIT', 'discard', 'transaction-outcome-unknown']);
  });

  it('a FATAL answer is not taken as a rollback: a backend can die after its commit', async () => {
    const { db, order } = fixture({
      commit: () => {
        throw serverError('57P01', 'FATAL', 'terminating connection due to administrator command');
      },
    });
    await assert.rejects(run(db, '$transaction'), TransactionOutcomeUnknownError);
    assert.deepEqual(order, ['BEGIN', 'COMMIT', 'discard', 'transaction-outcome-unknown']);
  });

  it('only where COMMIT answers are classified: an engine whose failed COMMIT is its answer keeps that error and its cleanup', async () => {
    const answer = new Error('in-process COMMIT failed');
    const inProcess: Dialect = {
      ...postgresDialect,
      capabilities: Object.freeze({ ...postgresDialect.capabilities, classifiesCommitAnswer: false }),
    };
    const { db, order } = fixture({
      dialect: inProcess,
      commit: () => {
        throw answer;
      },
    });
    await assert.rejects(run(db, '$transaction'), (err) => err === answer);
    assert.deepEqual(order, ['BEGIN', 'COMMIT', 'ROLLBACK', 'release', 'transaction-rolled-back']);
  });

  it('a rejection whose fields throw when read is no answer, and the connection is still let go', async () => {
    const hostile = Object.defineProperty(Object.assign(new Error('hostile'), { code: '40001' }), 'severity', {
      get() {
        throw new Error('severity getter');
      },
    });
    const { db, order } = fixture({
      commit: () => {
        throw hostile;
      },
    });
    await assert.rejects(run(db, '$transaction'), TransactionOutcomeUnknownError);
    assert.deepEqual(order, ['BEGIN', 'COMMIT', 'discard', 'transaction-outcome-unknown']);
  });

  it('is never retried by withRetry', async () => {
    let attempts = 0;
    const { db } = fixture({
      commit: () => {
        throw new Error('Query read timeout');
      },
    });
    await assert.rejects(
      withRetry(() => {
        attempts++;
        return run(db, '$transaction');
      }),
      TransactionOutcomeUnknownError,
    );
    assert.equal(attempts, 1);
  });

  it('the trace channel reports the COMMIT as failed and shows no ROLLBACK', async () => {
    for (const api of APIS) {
      const { db } = fixture({
        commit: () => {
          throw new Error('Query read timeout');
        },
      });
      const seen = await traced(() => assert.rejects(run(db, api), TransactionOutcomeUnknownError));
      assertCommitFailed(seen, api);
      assert.ok(!seen.some((s) => s.context.sql === 'ROLLBACK'), `${api}: a ROLLBACK was sent`);
    }
  });
});

/** Every `turbine:query` event `work` causes. */
async function traced(work: () => Promise<unknown>): Promise<Array<{ phase: string; context: QueryChannelContext }>> {
  const seen: Array<{ phase: string; context: QueryChannelContext }> = [];
  const channel = diagnostics_channel.tracingChannel<string, QueryChannelContext>(QUERY_CHANNEL);
  const on = (phase: string) => (message: unknown) => seen.push({ phase, context: message as QueryChannelContext });
  const handlers = {
    start: on('start'),
    end: on('end'),
    asyncStart: on('asyncStart'),
    asyncEnd: on('asyncEnd'),
    error: on('error'),
  };
  channel.subscribe(handlers as never);
  try {
    await work();
  } finally {
    channel.unsubscribe(handlers as never);
  }
  return seen;
}

/** The COMMIT was published, and as a failed statement, never a successful one. */
function assertCommitFailed(seen: Array<{ phase: string; context: QueryChannelContext }>, api: Api): void {
  const commits = seen.filter((s) => s.context.sql === 'COMMIT');
  assert.ok(commits.length > 0, `${api}: the COMMIT was not published`);
  assert.ok(
    commits.some((s) => s.phase === 'error'),
    `${api}: the COMMIT was published as successful`,
  );
}

describe('a COMMIT the server answered: rolled back, confirmed', () => {
  for (const api of APIS) {
    it(`${api}: an ERROR answer keeps its retryable class and reports the rollback`, async () => {
      const conflict = serverError('40001', 'ERROR', 'could not serialize access');
      const { db, order } = fixture({
        commit: () => {
          throw conflict;
        },
      });
      const late = leak();
      await assert.rejects(
        run(db, api, late.capture),
        (err) => err instanceof SerializationFailureError && err.isRetryable && err.cause === conflict,
      );
      assert.deepEqual(order, [
        ...before(api),
        'COMMIT',
        'ROLLBACK',
        'release',
        ...logged(api, 'transaction-rolled-back'),
      ]);
      if (api !== 'batch') assert.match(await late.refusal(), /was rolled back/);
    });

    it(`${api}: the ROLLBACK command tag is E019, with the rollback reported and the COMMIT traced as failed`, async () => {
      const { db, order } = fixture({ commit: () => ({ rows: [], rowCount: null, command: 'ROLLBACK' }) });
      assertCommitFailed(await traced(() => assert.rejects(run(db, api), TransactionRolledBackError)), api);
      assert.deepEqual(order, [
        ...before(api),
        'COMMIT',
        'ROLLBACK',
        'release',
        ...logged(api, 'transaction-rolled-back'),
      ]);
    });

    it(`${api}: the rollback stays confirmed when only the cleanup ROLLBACK fails, and the connection is discarded`, async () => {
      const { db, order } = fixture({
        commit: () => ({ rows: [], rowCount: null, command: 'ROLLBACK' }),
        rollback: 'refuse',
      });
      const late = leak();
      await assert.rejects(run(db, api, late.capture), TransactionRolledBackError);
      assert.deepEqual(order, [...before(api), 'COMMIT', 'discard', ...logged(api, 'transaction-rolled-back')]);
      if (api !== 'batch') assert.match(await late.refusal(), /was rolled back/);
    });
  }

  it('withRetry retries a serialization failure answered at COMMIT', async () => {
    let attempts = 0;
    let fail = true;
    const { db } = fixture({
      commit: () => {
        if (fail) {
          fail = false;
          throw serverError('40001', 'ERROR');
        }
        return { rows: [], rowCount: null, command: 'COMMIT' };
      },
    });
    const value = await withRetry(
      () => {
        attempts++;
        return run(db, '$transaction');
      },
      { baseDelay: 1, maxDelay: 1 },
    );
    assert.equal(value, 7);
    assert.equal(attempts, 2);
  });
});

describe('cleanup that the server did not acknowledge, before any COMMIT', () => {
  for (const api of ['transaction', '$transaction'] as const) {
    it(`${api}: a refused ROLLBACK keeps the callback's error and claims no rollback`, async () => {
      const { db, order } = fixture({ rollback: 'refuse' });
      const reason = new Error('callback failed');
      const late = leak();
      await assert.rejects(
        run(db, api, async (h) => {
          await late.capture(h);
          throw reason;
        }),
        (err) => err === reason,
      );
      assert.deepEqual(order, ['BEGIN', 'discard', ...logged(api, 'transaction-outcome-unknown')]);
      assert.match(await late.refusal(), /ended with an unknown outcome/);
    });
  }

  it("batch: a refused ROLLBACK keeps the failing item's error and claims no rollback", async () => {
    const { db, order } = fixture({ rollback: 'refuse' });
    const refused = new Error('transform refused its result');
    await assert.rejects(
      db.$transaction([
        {
          sql: 'SELECT 7',
          params: [],
          tag: 'outcome.refused',
          transform: () => {
            throw refused;
          },
        },
      ]),
      (err) => err === refused,
    );
    assert.deepEqual(order, ['BEGIN', 'SELECT 7', 'discard', 'transaction-outcome-unknown']);
  });

  it('$transaction: a ROLLBACK answered after the grace period is not reported as a rollback', async () => {
    const { db, order } = fixture({ rollback: 'delay' });
    const reason = new Error('callback failed');
    await assert.rejects(
      run(db, '$transaction', async () => {
        throw reason;
      }),
      (err) => err === reason,
    );
    assert.deepEqual(order, ['BEGIN', 'ROLLBACK', 'discard', 'transaction-outcome-unknown']);
  });

  it('$transaction: a statement cut short by its timeout rethrows that failure when the rollback is not confirmed', async () => {
    const { db, order } = fixture({ rollback: 'refuse' });
    const cut = new TimeoutError(10, 'Query', { message: 'Query timed out after 10ms.' });
    await assert.rejects(
      db.$transaction(async (tx) => {
        (tx as unknown as { state: TransactionState }).state.abort(cut);
      }),
      (err) => err === cut,
    );
    assert.deepEqual(order, ['BEGIN', 'discard', 'transaction-outcome-unknown']);
  });

  it('$transaction: the same statement is E019 once the rollback is acknowledged', async () => {
    const { db, order } = fixture();
    const cut = new TimeoutError(10, 'Query', { message: 'Query timed out after 10ms.' });
    await assert.rejects(
      db.$transaction(async (tx) => {
        (tx as unknown as { state: TransactionState }).state.abort(cut);
      }),
      (err) => err instanceof TransactionRolledBackError && err.cause === cut,
    );
    assert.deepEqual(order, ['BEGIN', 'ROLLBACK', 'release', 'transaction-rolled-back']);
  });
});

describe('a transaction deadline', () => {
  for (const api of ['$transaction', 'batch'] as const) {
    it(`${api}: a refused ROLLBACK is outcome unknown, says COMMIT was never sent, and claims no rollback or cancel`, async () => {
      let release!: () => void;
      const slow = new Promise<void>((resolve) => {
        release = resolve;
      });
      const { db, order } = fixture({ rollback: 'refuse', slow });
      const pending =
        api === 'batch'
          ? db.$transaction([{ sql: 'SELECT pg_sleep(1)', params: [], tag: 'slow', transform: () => 1 }], {
              timeout: 20,
            })
          : db.$transaction(() => delay(200), { timeout: 20 });
      await assert.rejects(pending, (err) => {
        assert.ok(err instanceof TimeoutError);
        assert.equal(err.outcome, 'unknown');
        assert.match(err.message, /COMMIT was never sent, so none of the transaction's writes were saved/);
        assert.match(err.message, /rollback is not confirmed/);
        assert.doesNotMatch(err.message, /was rolled back|cancelled/);
        return true;
      });
      assert.ok(order.includes('discard') && !order.includes('release'), order.join(','));
      assert.ok(order.includes('transaction-outcome-unknown') && !order.includes('transaction-rolled-back'));
      release();
    });
  }

  it('$transaction: a statement still running that cannot be cancelled is outcome unknown, with no ROLLBACK sent', async () => {
    let release!: () => void;
    const slow = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { db, order } = fixture({ slow });
    let escaped!: TransactionClient;
    await assert.rejects(
      db.$transaction(
        async (tx) => {
          escaped = tx;
          await tx.rawUnsafe('SELECT pg_sleep(10)');
        },
        { timeout: 20 },
      ),
      (err) => err instanceof TimeoutError && err.outcome === 'unknown' && !/rolled back|cancelled/.test(err.message),
    );
    // The mock connection has no backend key, so no cancel can be sent and
    // the ROLLBACK would only queue behind the running statement.
    assert.deepEqual(order, ['BEGIN', 'SELECT pg_sleep(10)', 'discard', 'transaction-outcome-unknown']);
    await assert.rejects(escaped.rawUnsafe('SELECT 1'), /timed out/);
    release();
  });

  it('$transaction: an acknowledged rollback with nothing running keeps not-executed and the old wording', async () => {
    const { db, order } = fixture();
    await assert.rejects(
      db.$transaction(() => delay(100), { timeout: 10 }),
      (err) => {
        assert.ok(err instanceof TimeoutError);
        assert.equal(err.outcome, 'not-executed');
        assert.match(err.message, /timed out after 10ms and was rolled back, so none of its writes were saved\. \(/);
        return true;
      },
    );
    assert.deepEqual(order, ['BEGIN', 'ROLLBACK', 'release', 'transaction-rolled-back']);
  });
});

describe('errors built before cleanup say only what is already true', () => {
  it('unawaited work: the transaction did not commit, with no rollback claim', async () => {
    let release!: () => void;
    const slow = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { db } = fixture({ slow });
    await assert.rejects(
      db.$transaction(async (tx) => {
        void tx.rawUnsafe('SELECT pg_sleep(1)').catch(() => {});
      }),
      (err) => {
        assert.ok(err instanceof ValidationError);
        assert.match(err.message, /did not commit and none of that work was saved/);
        assert.doesNotMatch(err.message, /rolled back/);
        return true;
      },
    );
    release();
  });

  it('a refused sessionContext setting: the callback did not run and nothing committed', async () => {
    const { db } = fixture({ refuseSetting: true });
    let ran = false;
    await assert.rejects(
      db.$transaction(
        async () => {
          ran = true;
        },
        { sessionContext: { 'app.tenant': 't1' } },
      ),
      (err) => {
        assert.ok(err instanceof ValidationError);
        assert.match(err.message, /Your callback did not run, and nothing was committed\./);
        assert.doesNotMatch(err.message, /rolled back/);
        return true;
      },
    );
    assert.equal(ran, false);
  });
});

describe('nested blocks report a rolled-back savepoint only once ROLLBACK TO is acknowledged', () => {
  function stateWith(refuse: (sql: string) => boolean) {
    const sent: string[] = [];
    const client = {
      async query(sql: string) {
        if (refuse(sql)) throw new Error(`injected: ${sql} lost`);
        sent.push(sql);
        if (sql === 'UPDATE fails') throw serverError('23505', 'ERROR', 'duplicate key');
        return { rows: [], rowCount: 0 };
      },
      release() {},
    } as unknown as PgCompatPoolClient;
    const state = new TransactionState(client, postgresDialect, { userTransaction: true });
    const failing = (scope: TransactionScope) => state.run(() => client.query('UPDATE fails'), scope);
    return { state, failing, sent };
  }

  it('a caught failure inside the block: rethrown as itself when ROLLBACK TO fails', async () => {
    const { state, failing } = stateWith((sql) => sql.startsWith('ROLLBACK TO'));
    let caught: unknown;
    await assert.rejects(
      state.enter(() =>
        state.withBlock(async (scope) => {
          await failing(scope).catch((err: unknown) => {
            caught = err;
          });
        }, state.rootScope),
      ),
      (err) => err === caught && !(err instanceof TransactionRolledBackError),
    );
  });

  it('the same block is E019 when ROLLBACK TO is acknowledged', async () => {
    const { state, failing, sent } = stateWith(() => false);
    await assert.rejects(
      state.enter(() =>
        state.withBlock(async (scope) => {
          await failing(scope).catch(() => {});
        }, state.rootScope),
      ),
      TransactionRolledBackError,
    );
    assert.ok(sent.some((sql) => sql.startsWith('ROLLBACK TO')));
  });

  it('a RELEASE lost on the wire, then a failed ROLLBACK TO: the RELEASE failure, no rollback claim', async () => {
    const { state } = stateWith((sql) => sql.startsWith('RELEASE') || sql.startsWith('ROLLBACK TO'));
    await assert.rejects(
      state.enter(() => state.withBlock(async () => 1, state.rootScope)),
      (err) => err instanceof Error && /RELEASE SAVEPOINT .* lost/.test(err.message),
    );
  });
});
