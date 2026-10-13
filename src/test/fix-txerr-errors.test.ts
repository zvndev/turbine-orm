/**
 * turbine-orm: E019 (`TransactionRolledBackError`) and the pooler-shaped
 * prepared-statement errors, with no database.
 *
 * Run: npx tsx --test src/test/fix-txerr-errors.test.ts
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ConnectionError,
  DeadlockError,
  LockNotAvailableError,
  SerializationFailureError,
  setErrorMessageMode,
  TransactionRolledBackError,
  TurbineError,
  TurbineErrorCode,
  UniqueConstraintError,
  ValidationError,
  wrapPgError,
} from '../errors.js';
import { closedTransactionError, rolledBackError, unawaitedWorkError } from '../transaction-state.js';

describe('TransactionRolledBackError', () => {
  it('is E019, extends TurbineError directly, and is not retryable', () => {
    const err = new TransactionRolledBackError('rolled back');
    assert.equal(TurbineErrorCode.TRANSACTION_ROLLED_BACK, 'TURBINE_E019');
    assert.equal(err.code, 'TURBINE_E019');
    assert.equal(err.name, 'TransactionRolledBackError');
    assert.equal(TransactionRolledBackError.CODE, 'TURBINE_E019');
    assert.equal(Object.getPrototypeOf(TransactionRolledBackError), TurbineError);
    assert.ok(err instanceof TurbineError);
    assert.ok(!(err instanceof ValidationError));
    assert.equal('isRetryable' in err, false);
    assert.equal(err.docsUrl, 'https://turbineorm.dev/errors#e019');
    assert.match(err.message, /^\[TURBINE_E019\] rolled back \(https:\/\/turbineorm\.dev\/errors#e019\)$/);
  });

  it('carries no cause key unless one was given', () => {
    assert.equal('cause' in new TransactionRolledBackError('x'), false);
    const first = new Error('first');
    assert.equal(new TransactionRolledBackError('x', { cause: first }).cause, first);
  });
});

describe('rolledBackError picks the class from the first failure', () => {
  const first = new UniqueConstraintError({ constraint: 'users_email_key' });

  it('anything not retryable is E019, with the first failure as cause', () => {
    const err = rolledBackError(first, 'transaction');
    assert.ok(err instanceof TransactionRolledBackError);
    assert.equal(err.code, 'TURBINE_E019');
    assert.equal(err.cause, first);
    assert.match(err.message, /rolled back, not committed/);
    assert.match(err.message, /own nested `tx\.\$transaction/);
  });

  it('no known first failure is still E019, with no cause', () => {
    const err = rolledBackError(undefined, 'transaction');
    assert.ok(err instanceof TransactionRolledBackError);
    assert.equal('cause' in err, false);
    assert.doesNotMatch(err.message, /attached as `cause`/);
  });

  it('a non-error first failure (a thrown string) is still attached', () => {
    const err = rolledBackError('boom', 'transaction');
    assert.ok(err instanceof TransactionRolledBackError);
    assert.equal(err.cause, 'boom');
  });

  it('the savepoint scope says the block was not released and the outer transaction is usable', () => {
    const err = rolledBackError(first, 'savepoint');
    assert.ok(err instanceof TransactionRolledBackError);
    assert.match(err.message, /nested `\$transaction` block was rolled back, not released/);
    assert.match(err.message, /outer transaction is usable again/);
  });

  it('the raw transaction() API names the savepoint statements, not tx.$transaction', () => {
    const err = rolledBackError(first, 'transaction', 'transaction');
    assert.ok(err instanceof TransactionRolledBackError);
    assert.match(err.message, /SAVEPOINT s[\s\S]*ROLLBACK TO SAVEPOINT s/);
    assert.doesNotMatch(err.message, /tx\.\$transaction/);
  });

  it('a deadlock stays DeadlockError (E012, retryable)', () => {
    const cause = new DeadlockError();
    const err = rolledBackError(cause, 'transaction');
    assert.ok(err instanceof DeadlockError);
    assert.ok(!(err instanceof TransactionRolledBackError));
    assert.equal(err.code, 'TURBINE_E012');
    assert.equal(err.isRetryable, true);
    assert.equal(err.cause, cause);
  });

  it('a serialization failure stays SerializationFailureError (E013, retryable)', () => {
    const cause = new SerializationFailureError();
    const err = rolledBackError(cause, 'savepoint');
    assert.ok(err instanceof SerializationFailureError);
    assert.ok(!(err instanceof LockNotAvailableError));
    assert.equal(err.isRetryable, true);
    assert.equal(err.cause, cause);
  });

  it('a lock that was not available stays LockNotAvailableError', () => {
    const cause = new LockNotAvailableError();
    const err = rolledBackError(cause, 'transaction');
    assert.ok(err instanceof LockNotAvailableError);
    assert.equal(err.code, 'TURBINE_E013');
    assert.equal(err.isRetryable, true);
    assert.equal(err.cause, cause);
  });

  it('a closed transaction and un-awaited work are still E003: programming errors, nothing was rolled back by the server', () => {
    for (const err of [closedTransactionError('committed'), unawaitedWorkError('$transaction')]) {
      assert.ok(err instanceof ValidationError);
      assert.equal(err.code, 'TURBINE_E003');
      assert.ok(!(err instanceof TransactionRolledBackError));
    }
  });
});

describe('PostgreSQL 42P05 and 26000 are ConnectionError (E004) naming the pooler and the fix', () => {
  const serverError = (code: string, message: string): Error =>
    Object.assign(new Error(message), { code, severity: 'ERROR' });

  for (const mode of ['safe', 'verbose'] as const) {
    for (const [code, message] of [
      ['42P05', 'prepared statement "s_1a2b" already exists'],
      ['26000', 'prepared statement "s_1a2b" does not exist'],
    ] as const) {
      it(`${code} in ${mode} mode`, () => {
        setErrorMessageMode(mode);
        try {
          const raw = serverError(code, message);
          const err = wrapPgError(raw);
          assert.ok(err instanceof ConnectionError, String(err));
          assert.equal(err.code, 'TURBINE_E004');
          assert.equal(err.sqlstate, code);
          assert.equal(err.cause, raw);
          assert.match(err.message, /prepared statement "s_1a2b" (already exists|does not exist)/);
          assert.match(err.message, /transaction-pooling endpoint/);
          assert.match(err.message, /PgBouncer in transaction mode/);
          assert.match(err.message, /direct\s+endpoint/);
          assert.match(err.message, /`preparedStatements: false`/);
          assert.match(err.message, /max_prepared_statements/);
        } finally {
          setErrorMessageMode('safe');
        }
      });
    }
  }

  it('the pooler cause is attached, so the server message survives for logs', () => {
    const raw = serverError('42P05', 'prepared statement "s_9" already exists');
    const err = wrapPgError(raw);
    assert.ok(err instanceof ConnectionError);
    assert.equal(err.cause, raw);
  });

  it('is not a stale-connection error: retrying the same statement on a new connection would not fix it', async () => {
    const { isStaleConnectionError } = await import('../errors.js');
    assert.equal(
      isStaleConnectionError(wrapPgError(serverError('42P05', 'prepared statement "s" already exists'))),
      false,
    );
    assert.equal(
      isStaleConnectionError(wrapPgError(serverError('26000', 'prepared statement "s" does not exist'))),
      false,
    );
  });

  it('unrelated SQLSTATEs are untouched', () => {
    const unique = wrapPgError(Object.assign(new Error('dup'), { code: '23505', severity: 'ERROR' }));
    assert.ok(unique instanceof UniqueConstraintError);
    // 42P01 (undefined_table) stays an unclassified server error, not a connection error.
    const undefinedTable = wrapPgError(
      Object.assign(new Error('relation "x" does not exist'), { code: '42P01', severity: 'ERROR' }),
    );
    assert.ok(!(undefinedTable instanceof ConnectionError));
  });
});
