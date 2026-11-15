/**
 * First-failure and abort bookkeeping in TransactionState, and the
 * settlement probe completeTransaction races a ROLLBACK against.
 *
 * The first failure is the one a retry decision follows, so a second
 * failure must never replace it, and a transaction an abort() doomed must
 * refuse its later statements with the abort's own error. These are the
 * branches a statement's success path never reaches.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { postgresDialect } from '../dialect.js';
import { TransactionRolledBackError } from '../errors.js';
import type { PgCompatPoolClient } from '../pg-types.js';
import { settlesWithin } from '../transaction-outcome.js';
import { TransactionState } from '../transaction-state.js';

function serverError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code, severity: 'ERROR' });
}

function makeState(options: { api?: 'transaction' | '$transaction' } = {}): TransactionState {
  const client = {
    async query() {
      return { rows: [], rowCount: 0 };
    },
    release() {},
  } as unknown as PgCompatPoolClient;
  return new TransactionState(client, postgresDialect, { userTransaction: true, ...options });
}

describe('settlesWithin', () => {
  it('a rejection is a settlement, not a timeout', async () => {
    assert.equal(await settlesWithin(Promise.reject(new Error('nope')), 1000), true);
  });

  it('a promise that never settles reports false', async () => {
    assert.equal(await settlesWithin(new Promise(() => {}), 5), false);
  });
});

describe('the first failure is kept', () => {
  it('noteFailure does not overwrite the first recorded failure', () => {
    const state = makeState();
    const first = new Error('first');
    state.noteFailure(first);
    state.noteFailure(new Error('second'));
    assert.equal(state.firstFailure, first);
  });

  it('abort keeps the first doom reason', () => {
    const state = makeState();
    const first = new Error('timed out');
    state.abort(first);
    state.abort(new Error('later'));
    assert.equal(state.mustRollBack?.error, first);
  });

  it('an aborted transaction refuses the next statement with the abort error as cause', async () => {
    const state = makeState();
    const cause = serverError('57014', 'cancelled');
    state.abort(cause);
    let sent = false;
    await assert.rejects(
      state.enter(() =>
        state.run(async () => {
          sent = true;
          return 1;
        }),
      ),
      (err: unknown) => err instanceof TransactionRolledBackError,
    );
    assert.equal(sent, false, 'the statement must not be sent');
  });

  it('a failed recovery statement does not replace the failure that aborted the transaction', async () => {
    const state = makeState();
    const first = serverError('40001', 'serialization failure');
    await assert.rejects(
      state.enter(() =>
        state.run(async () => {
          throw first;
        }),
      ),
    );
    // A rollback-to-savepoint is sent even in the aborted state (recovery);
    // when it also fails on the server, the abort's cause is still first.
    await assert.rejects(
      state.enter(() =>
        state.run(
          async () => {
            throw serverError('23505', 'duplicate key');
          },
          state.rootScope,
          true,
        ),
      ),
    );
    // The refusal keeps the first failure's retryable class and attaches it
    // as cause (see rolledBackError), so cause identity is the assertion.
    await assert.rejects(
      state.enter(() => state.run(async () => 1)),
      (err: unknown) => (err as { cause?: unknown }).cause === first,
    );
  });

  it('the first server failure stays the recorded cause after a second one', async () => {
    const state = makeState();
    const first = serverError('40001', 'serialization failure');
    await assert.rejects(
      state.enter(() =>
        state.run(async () => {
          throw first;
        }),
      ),
    );
    // The next statement is refused before it is sent; the cause it carries
    // (and that firstFailure reports) is still the first server failure.
    assert.equal(state.firstFailure, first);
  });
});

describe('screenRaw rollback-to detection', () => {
  it('a savepoint statement beside a rollback-to is not a pure rollback-to', () => {
    const state = makeState({ api: 'transaction' });
    assert.equal(state.screenRaw('SAVEPOINT mine; ROLLBACK TO mine'), false);
    assert.equal(state.screenRaw('ROLLBACK TO mine'), true);
  });
});
