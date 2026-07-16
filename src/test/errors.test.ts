/**
 * turbine-orm — Error type hierarchy tests
 *
 * Tests all custom error classes, their codes, properties, and inheritance.
 *
 * Run: npx tsx --test src/test/errors.test.ts
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  CheckConstraintError,
  CircularRelationError,
  ConnectionError,
  DeadlockError,
  ExclusionConstraintError,
  ForeignKeyError,
  getErrorMessageMode,
  MigrationError,
  NotFoundError,
  NotNullViolationError,
  OptimisticLockError,
  PipelineError,
  RelationError,
  SerializationFailureError,
  setErrorMessageMode,
  TimeoutError,
  TurbineError,
  TurbineErrorCode,
  UniqueConstraintError,
  UnsupportedFeatureError,
  ValidationError,
  wrapPgError,
} from '../errors.js';

// ---------------------------------------------------------------------------
// TurbineError (base class)
// ---------------------------------------------------------------------------

describe('TurbineError', () => {
  it('sets .code from constructor', () => {
    const err = new TurbineError(TurbineErrorCode.NOT_FOUND, 'test message');
    assert.equal(err.code, 'TURBINE_E001');
  });

  it('sets .message from constructor', () => {
    const err = new TurbineError(TurbineErrorCode.VALIDATION, 'bad input');
    assert.equal(err.message, '[TURBINE_E003] bad input');
  });

  it('sets .name to TurbineError', () => {
    const err = new TurbineError(TurbineErrorCode.CONNECTION, 'conn fail');
    assert.equal(err.name, 'TurbineError');
  });

  it('extends Error', () => {
    const err = new TurbineError(TurbineErrorCode.NOT_FOUND, 'nope');
    assert.ok(err instanceof Error);
  });
});

// ---------------------------------------------------------------------------
// NotFoundError
// ---------------------------------------------------------------------------

describe('NotFoundError', () => {
  it('has default message "Record not found" (back-compat, no args)', () => {
    const err = new NotFoundError();
    assert.equal(err.message, '[TURBINE_E001] Record not found');
  });

  it('accepts a custom string message (back-compat)', () => {
    const err = new NotFoundError('User 42 not found');
    assert.equal(err.message, '[TURBINE_E001] User 42 not found');
  });

  it('has .code === TURBINE_E001', () => {
    const err = new NotFoundError();
    assert.equal(err.code, TurbineErrorCode.NOT_FOUND);
    assert.equal(err.code, 'TURBINE_E001');
  });

  it('is instanceof TurbineError and Error', () => {
    const err = new NotFoundError();
    assert.ok(err instanceof NotFoundError);
    assert.ok(err instanceof TurbineError);
    assert.ok(err instanceof Error);
  });

  it('options object: builds Prisma-style message with table, where keys, operation (safe mode)', () => {
    // Default mode is 'safe' — message should include where keys but NOT values.
    setErrorMessageMode('safe');
    const err = new NotFoundError({
      table: 'users',
      where: { id: 1 },
      operation: 'findUniqueOrThrow',
    });
    assert.ok(err.message.includes('users'), 'message should include table name');
    assert.ok(err.message.includes('findUniqueOrThrow'), 'message should include operation');
    assert.ok(err.message.includes('{ id }'), 'safe mode should include where key, not value');
    assert.ok(!err.message.includes('"id":1'), 'safe mode should NOT include where value JSON');
    // Old prefix is preserved so substring assertions in other tests still pass:
    assert.ok(err.message.includes('[turbine] findUniqueOrThrow on "users" found no record'));
  });

  it('options object: populates .table, .where, .operation fields', () => {
    const err = new NotFoundError({
      table: 'posts',
      where: { slug: 'hello' },
      operation: 'findFirstOrThrow',
    });
    assert.equal(err.table, 'posts');
    assert.deepEqual(err.where, { slug: 'hello' });
    assert.equal(err.operation, 'findFirstOrThrow');
  });

  it('options object: explicit message override wins', () => {
    const err = new NotFoundError({
      table: 'users',
      where: { id: 1 },
      operation: 'findUniqueOrThrow',
      message: 'custom override',
    });
    assert.equal(err.message, '[TURBINE_E001] custom override');
    // fields are still populated
    assert.equal(err.table, 'users');
    assert.equal(err.operation, 'findUniqueOrThrow');
  });

  it('options object: preserves cause', () => {
    const cause = new Error('underlying');
    const err = new NotFoundError({ table: 'users', cause });
    assert.equal(err.cause, cause);
  });

  it('options object: empty object falls back to generic message', () => {
    const err = new NotFoundError({});
    assert.equal(err.message, '[TURBINE_E001] [turbine] Record not found');
    assert.equal(err.table, undefined);
    assert.equal(err.where, undefined);
    assert.equal(err.operation, undefined);
  });

  it('options object: table alone (no operation, no where)', () => {
    const err = new NotFoundError({ table: 'users' });
    assert.ok(err.message.includes('users'));
    assert.equal(err.table, 'users');
  });

  it('back-compat string variant does not populate context fields', () => {
    const err = new NotFoundError('legacy message');
    assert.equal(err.table, undefined);
    assert.equal(err.where, undefined);
    assert.equal(err.operation, undefined);
  });
});

// ---------------------------------------------------------------------------
// TimeoutError
// ---------------------------------------------------------------------------

describe('TimeoutError', () => {
  it('stores .timeoutMs property', () => {
    const err = new TimeoutError(5000);
    assert.equal(err.timeoutMs, 5000);
  });

  it('message includes timeout value and default context', () => {
    const err = new TimeoutError(3000);
    assert.equal(err.message, '[TURBINE_E002] [turbine] Query timed out after 3000ms');
  });

  it('message includes custom context', () => {
    const err = new TimeoutError(1500, 'Transaction');
    assert.equal(err.message, '[TURBINE_E002] [turbine] Transaction timed out after 1500ms');
  });

  it('has .code === TURBINE_E002', () => {
    const err = new TimeoutError(1000);
    assert.equal(err.code, TurbineErrorCode.TIMEOUT);
    assert.equal(err.code, 'TURBINE_E002');
  });
});

// ---------------------------------------------------------------------------
// ValidationError
// ---------------------------------------------------------------------------

describe('ValidationError', () => {
  it('passes message through', () => {
    const err = new ValidationError('Unknown column "foo"');
    assert.equal(err.message, '[TURBINE_E003] Unknown column "foo"');
  });

  it('has .code === TURBINE_E003', () => {
    const err = new ValidationError('bad');
    assert.equal(err.code, TurbineErrorCode.VALIDATION);
    assert.equal(err.code, 'TURBINE_E003');
  });
});

// ---------------------------------------------------------------------------
// ConnectionError
// ---------------------------------------------------------------------------

describe('ConnectionError', () => {
  it('has .code === TURBINE_E004', () => {
    const err = new ConnectionError('ECONNREFUSED');
    assert.equal(err.code, TurbineErrorCode.CONNECTION);
    assert.equal(err.code, 'TURBINE_E004');
  });

  it('passes message through', () => {
    const err = new ConnectionError('could not connect to server');
    assert.equal(err.message, '[TURBINE_E004] could not connect to server');
  });
});

// ---------------------------------------------------------------------------
// RelationError
// ---------------------------------------------------------------------------

describe('RelationError', () => {
  it('has .code === TURBINE_E005', () => {
    const err = new RelationError('invalid relation ref');
    assert.equal(err.code, TurbineErrorCode.RELATION);
    assert.equal(err.code, 'TURBINE_E005');
  });

  it('passes message through', () => {
    const err = new RelationError('No relation "foo" on model "bar"');
    assert.equal(err.message, '[TURBINE_E005] No relation "foo" on model "bar"');
  });
});

// ---------------------------------------------------------------------------
// MigrationError
// ---------------------------------------------------------------------------

describe('MigrationError', () => {
  it('has .code === TURBINE_E006', () => {
    const err = new MigrationError('migration failed');
    assert.equal(err.code, TurbineErrorCode.MIGRATION);
    assert.equal(err.code, 'TURBINE_E006');
  });

  it('passes message through', () => {
    const err = new MigrationError('Column "age" already exists');
    assert.equal(err.message, '[TURBINE_E006] Column "age" already exists');
  });
});

// ---------------------------------------------------------------------------
// CircularRelationError
// ---------------------------------------------------------------------------

describe('CircularRelationError', () => {
  it('stores .path property as the path array', () => {
    const path = ['users', 'posts', 'comments', 'users'];
    const err = new CircularRelationError(path);
    assert.deepEqual(err.path, path);
  });

  it('message includes arrow-joined path', () => {
    const path = ['a', 'b', 'c', 'a'];
    const err = new CircularRelationError(path);
    assert.ok(err.message.includes('a \u2192 b \u2192 c \u2192 a'));
  });

  it('message includes max nesting depth note', () => {
    const err = new CircularRelationError(['x', 'y', 'x']);
    assert.ok(err.message.includes('Maximum nesting depth is 10'));
  });

  it('has .code === TURBINE_E007', () => {
    const err = new CircularRelationError(['a', 'b']);
    assert.equal(err.code, TurbineErrorCode.CIRCULAR_RELATION);
    assert.equal(err.code, 'TURBINE_E007');
  });
});

// ---------------------------------------------------------------------------
// All error types: instanceof Error and instanceof TurbineError
// ---------------------------------------------------------------------------

describe('inheritance — all errors are instanceof Error and TurbineError', () => {
  const errors = [
    new TurbineError(TurbineErrorCode.NOT_FOUND, 'base'),
    new NotFoundError(),
    new TimeoutError(100),
    new ValidationError('v'),
    new ConnectionError('c'),
    new RelationError('r'),
    new MigrationError('m'),
    new CircularRelationError(['a', 'b']),
    new UniqueConstraintError(),
    new ForeignKeyError(),
    new NotNullViolationError(),
    new CheckConstraintError(),
    new DeadlockError(),
    new SerializationFailureError(),
  ];

  for (const err of errors) {
    it(`${err.name} is instanceof Error`, () => {
      assert.ok(err instanceof Error);
    });

    it(`${err.name} is instanceof TurbineError`, () => {
      assert.ok(err instanceof TurbineError);
    });
  }
});

// ---------------------------------------------------------------------------
// TurbineErrorCode has all expected values
// ---------------------------------------------------------------------------

describe('TurbineErrorCode', () => {
  it('has NOT_FOUND = TURBINE_E001', () => {
    assert.equal(TurbineErrorCode.NOT_FOUND, 'TURBINE_E001');
  });

  it('has TIMEOUT = TURBINE_E002', () => {
    assert.equal(TurbineErrorCode.TIMEOUT, 'TURBINE_E002');
  });

  it('has VALIDATION = TURBINE_E003', () => {
    assert.equal(TurbineErrorCode.VALIDATION, 'TURBINE_E003');
  });

  it('has CONNECTION = TURBINE_E004', () => {
    assert.equal(TurbineErrorCode.CONNECTION, 'TURBINE_E004');
  });

  it('has RELATION = TURBINE_E005', () => {
    assert.equal(TurbineErrorCode.RELATION, 'TURBINE_E005');
  });

  it('has MIGRATION = TURBINE_E006', () => {
    assert.equal(TurbineErrorCode.MIGRATION, 'TURBINE_E006');
  });

  it('has CIRCULAR_RELATION = TURBINE_E007', () => {
    assert.equal(TurbineErrorCode.CIRCULAR_RELATION, 'TURBINE_E007');
  });

  it('has UNIQUE_VIOLATION = TURBINE_E008', () => {
    assert.equal(TurbineErrorCode.UNIQUE_VIOLATION, 'TURBINE_E008');
  });

  it('has FOREIGN_KEY_VIOLATION = TURBINE_E009', () => {
    assert.equal(TurbineErrorCode.FOREIGN_KEY_VIOLATION, 'TURBINE_E009');
  });

  it('has NOT_NULL_VIOLATION = TURBINE_E010', () => {
    assert.equal(TurbineErrorCode.NOT_NULL_VIOLATION, 'TURBINE_E010');
  });

  it('has CHECK_VIOLATION = TURBINE_E011', () => {
    assert.equal(TurbineErrorCode.CHECK_VIOLATION, 'TURBINE_E011');
  });

  it('has DEADLOCK_DETECTED = TURBINE_E012', () => {
    assert.equal(TurbineErrorCode.DEADLOCK_DETECTED, 'TURBINE_E012');
  });

  it('has SERIALIZATION_FAILURE = TURBINE_E013', () => {
    assert.equal(TurbineErrorCode.SERIALIZATION_FAILURE, 'TURBINE_E013');
  });

  it('has PIPELINE = TURBINE_E014', () => {
    assert.equal(TurbineErrorCode.PIPELINE, 'TURBINE_E014');
  });

  it('has UNSUPPORTED_FEATURE = TURBINE_E017', () => {
    assert.equal(TurbineErrorCode.UNSUPPORTED_FEATURE, 'TURBINE_E017');
  });

  it('has READ_ONLY = TURBINE_E018', () => {
    assert.equal(TurbineErrorCode.READ_ONLY, 'TURBINE_E018');
  });

  it('has exactly 18 error codes', () => {
    assert.equal(Object.keys(TurbineErrorCode).length, 18);
  });
});

// ---------------------------------------------------------------------------
// UniqueConstraintError
// ---------------------------------------------------------------------------

describe('UniqueConstraintError', () => {
  it('has .code === TURBINE_E008', () => {
    const err = new UniqueConstraintError();
    assert.equal(err.code, TurbineErrorCode.UNIQUE_VIOLATION);
    assert.equal(err.code, 'TURBINE_E008');
  });

  it('has name "UniqueConstraintError"', () => {
    const err = new UniqueConstraintError();
    assert.equal(err.name, 'UniqueConstraintError');
  });

  it('default message is generic when no fields are passed', () => {
    const err = new UniqueConstraintError();
    assert.equal(err.message, '[TURBINE_E008] [turbine] Unique constraint violation');
  });

  it('default message includes constraint name when passed', () => {
    const err = new UniqueConstraintError({ constraint: 'users_email_key' });
    assert.ok(err.message.includes('users_email_key'));
  });

  it('default message includes column list when passed', () => {
    const err = new UniqueConstraintError({ columns: ['email'] });
    assert.ok(err.message.includes('(email)'));
  });

  it('stores constraint, columns, and table fields', () => {
    const err = new UniqueConstraintError({
      constraint: 'users_email_key',
      columns: ['email'],
      table: 'users',
    });
    assert.equal(err.constraint, 'users_email_key');
    assert.deepEqual(err.columns, ['email']);
    assert.equal(err.table, 'users');
  });

  it('preserves cause', () => {
    const cause = new Error('original pg error');
    const err = new UniqueConstraintError({ cause });
    assert.equal(err.cause, cause);
  });

  it('does NOT append pg detail (which carries values) in safe mode — the default', () => {
    const prev = getErrorMessageMode();
    setErrorMessageMode('safe');
    try {
      const cause = { detail: 'Key (email)=(foo@bar) already exists.' };
      const err = new UniqueConstraintError({ cause });
      assert.ok(!err.message.includes('foo@bar'), 'the conflicting value must not leak into the message');
    } finally {
      setErrorMessageMode(prev);
    }
  });

  it('appends pg detail to the message in verbose mode (opt-in)', () => {
    const prev = getErrorMessageMode();
    setErrorMessageMode('verbose');
    try {
      const cause = { detail: 'Key (email)=(foo@bar) already exists.' };
      const err = new UniqueConstraintError({ cause });
      assert.ok(err.message.includes('Key (email)=(foo@bar) already exists.'));
    } finally {
      setErrorMessageMode(prev);
    }
  });

  it('honors explicit message override', () => {
    const err = new UniqueConstraintError({ message: 'custom message' });
    assert.equal(err.message, '[TURBINE_E008] custom message');
  });
});

// ---------------------------------------------------------------------------
// ForeignKeyError
// ---------------------------------------------------------------------------

describe('ForeignKeyError', () => {
  it('has .code === TURBINE_E009', () => {
    const err = new ForeignKeyError();
    assert.equal(err.code, TurbineErrorCode.FOREIGN_KEY_VIOLATION);
    assert.equal(err.code, 'TURBINE_E009');
  });

  it('has name "ForeignKeyError"', () => {
    const err = new ForeignKeyError();
    assert.equal(err.name, 'ForeignKeyError');
  });

  it('default message includes constraint name', () => {
    const err = new ForeignKeyError({ constraint: 'users_org_id_fkey' });
    assert.ok(err.message.includes('users_org_id_fkey'));
  });

  it('stores constraint and table fields', () => {
    const err = new ForeignKeyError({ constraint: 'fk1', table: 'users' });
    assert.equal(err.constraint, 'fk1');
    assert.equal(err.table, 'users');
  });

  it('preserves cause', () => {
    const cause = new Error('pg fk error');
    const err = new ForeignKeyError({ cause });
    assert.equal(err.cause, cause);
  });
});

// ---------------------------------------------------------------------------
// NotNullViolationError
// ---------------------------------------------------------------------------

describe('NotNullViolationError', () => {
  it('has .code === TURBINE_E010', () => {
    const err = new NotNullViolationError();
    assert.equal(err.code, TurbineErrorCode.NOT_NULL_VIOLATION);
    assert.equal(err.code, 'TURBINE_E010');
  });

  it('has name "NotNullViolationError"', () => {
    const err = new NotNullViolationError();
    assert.equal(err.name, 'NotNullViolationError');
  });

  it('default message includes column name', () => {
    const err = new NotNullViolationError({ column: 'email' });
    assert.ok(err.message.includes('"email"'));
  });

  it('stores column and table fields', () => {
    const err = new NotNullViolationError({ column: 'email', table: 'users' });
    assert.equal(err.column, 'email');
    assert.equal(err.table, 'users');
  });

  it('preserves cause', () => {
    const cause = new Error('pg not null error');
    const err = new NotNullViolationError({ cause });
    assert.equal(err.cause, cause);
  });
});

// ---------------------------------------------------------------------------
// CheckConstraintError
// ---------------------------------------------------------------------------

describe('CheckConstraintError', () => {
  it('has .code === TURBINE_E011', () => {
    const err = new CheckConstraintError();
    assert.equal(err.code, TurbineErrorCode.CHECK_VIOLATION);
    assert.equal(err.code, 'TURBINE_E011');
  });

  it('has name "CheckConstraintError"', () => {
    const err = new CheckConstraintError();
    assert.equal(err.name, 'CheckConstraintError');
  });

  it('default message includes constraint name', () => {
    const err = new CheckConstraintError({ constraint: 'price_positive' });
    assert.ok(err.message.includes('price_positive'));
  });

  it('stores constraint and table fields', () => {
    const err = new CheckConstraintError({ constraint: 'c1', table: 't' });
    assert.equal(err.constraint, 'c1');
    assert.equal(err.table, 't');
  });

  it('preserves cause', () => {
    const cause = new Error('pg check error');
    const err = new CheckConstraintError({ cause });
    assert.equal(err.cause, cause);
  });
});

// ---------------------------------------------------------------------------
// wrapPgError
// ---------------------------------------------------------------------------

describe('wrapPgError', () => {
  it('returns input unchanged when error is null', () => {
    assert.equal(wrapPgError(null), null);
  });

  it('returns input unchanged when error is undefined', () => {
    assert.equal(wrapPgError(undefined), undefined);
  });

  it('returns input unchanged when error is a primitive', () => {
    assert.equal(wrapPgError('oops'), 'oops');
    assert.equal(wrapPgError(42), 42);
  });

  it('returns input unchanged when error has no code', () => {
    const err = new Error('plain');
    assert.equal(wrapPgError(err), err);
  });

  it('returns input unchanged for unknown sqlstate codes', () => {
    const err = Object.assign(new Error('weird'), { code: '99999' });
    assert.equal(wrapPgError(err), err);
  });

  it('wraps 23505 into UniqueConstraintError', () => {
    const err = Object.assign(new Error('dup'), {
      code: '23505',
      constraint: 'users_email_key',
      table: 'users',
      detail: 'Key (email)=(foo@bar) already exists.',
    });
    const wrapped = wrapPgError(err);
    assert.ok(wrapped instanceof UniqueConstraintError);
    if (wrapped instanceof UniqueConstraintError) {
      assert.equal(wrapped.constraint, 'users_email_key');
      assert.deepEqual(wrapped.columns, ['email']);
      assert.equal(wrapped.table, 'users');
      assert.equal(wrapped.cause, err);
    }
  });

  it('wraps 23505 with multi-column detail correctly', () => {
    const err = Object.assign(new Error('dup'), {
      code: '23505',
      constraint: 'composite_key',
      detail: 'Key (col1, col2)=(v1, v2) already exists.',
    });
    const wrapped = wrapPgError(err);
    assert.ok(wrapped instanceof UniqueConstraintError);
    if (wrapped instanceof UniqueConstraintError) {
      assert.deepEqual(wrapped.columns, ['col1', 'col2']);
    }
  });

  it('wraps 23505 with no detail (columns undefined)', () => {
    const err = Object.assign(new Error('dup'), { code: '23505' });
    const wrapped = wrapPgError(err);
    assert.ok(wrapped instanceof UniqueConstraintError);
    if (wrapped instanceof UniqueConstraintError) {
      assert.equal(wrapped.columns, undefined);
    }
  });

  it('wraps 23503 into ForeignKeyError', () => {
    const err = Object.assign(new Error('fk'), {
      code: '23503',
      constraint: 'users_org_id_fkey',
      table: 'users',
    });
    const wrapped = wrapPgError(err);
    assert.ok(wrapped instanceof ForeignKeyError);
    if (wrapped instanceof ForeignKeyError) {
      assert.equal(wrapped.constraint, 'users_org_id_fkey');
      assert.equal(wrapped.table, 'users');
      assert.equal(wrapped.cause, err);
    }
  });

  it('wraps 23502 into NotNullViolationError', () => {
    const err = Object.assign(new Error('nn'), {
      code: '23502',
      column: 'email',
      table: 'users',
    });
    const wrapped = wrapPgError(err);
    assert.ok(wrapped instanceof NotNullViolationError);
    if (wrapped instanceof NotNullViolationError) {
      assert.equal(wrapped.column, 'email');
      assert.equal(wrapped.table, 'users');
      assert.equal(wrapped.cause, err);
    }
  });

  it('wraps 23514 into CheckConstraintError', () => {
    const err = Object.assign(new Error('ck'), {
      code: '23514',
      constraint: 'price_positive',
      table: 'products',
    });
    const wrapped = wrapPgError(err);
    assert.ok(wrapped instanceof CheckConstraintError);
    if (wrapped instanceof CheckConstraintError) {
      assert.equal(wrapped.constraint, 'price_positive');
      assert.equal(wrapped.table, 'products');
      assert.equal(wrapped.cause, err);
    }
  });

  it('wraps 23P01 into ExclusionConstraintError', () => {
    const err = Object.assign(new Error('exclusion'), {
      code: '23P01',
      constraint: 'no_overlap',
      table: 'reservations',
    });
    const wrapped = wrapPgError(err);
    assert.ok(wrapped instanceof ExclusionConstraintError);
    if (wrapped instanceof ExclusionConstraintError) {
      assert.equal(wrapped.constraint, 'no_overlap');
      assert.equal(wrapped.table, 'reservations');
      assert.equal(wrapped.code, 'TURBINE_E016');
      assert.equal(wrapped.cause, err);
    }
  });

  it('wraps 40P01 into DeadlockError with isRetryable = true', () => {
    const err = Object.assign(new Error('deadlock detected: process A waits for ...'), {
      code: '40P01',
    });
    const wrapped = wrapPgError(err);
    assert.ok(wrapped instanceof DeadlockError, 'expected DeadlockError');
    if (wrapped instanceof DeadlockError) {
      assert.equal(wrapped.isRetryable, true);
      assert.equal(wrapped.code, 'TURBINE_E012');
      assert.equal(wrapped.cause, err);
      assert.ok(wrapped.message.includes('Deadlock detected'), 'message should mention deadlock');
      assert.ok(wrapped.message.includes('process A waits for'), 'message should embed pg detail');
    }
  });

  it('wraps 40001 into SerializationFailureError with isRetryable = true', () => {
    const err = Object.assign(new Error('could not serialize access due to concurrent update'), { code: '40001' });
    const wrapped = wrapPgError(err);
    assert.ok(wrapped instanceof SerializationFailureError, 'expected SerializationFailureError');
    if (wrapped instanceof SerializationFailureError) {
      assert.equal(wrapped.isRetryable, true);
      assert.equal(wrapped.code, 'TURBINE_E013');
      assert.equal(wrapped.cause, err);
      assert.ok(
        wrapped.message.includes('Serializable transaction conflict'),
        'message should mention serialization conflict',
      );
      assert.ok(wrapped.message.includes('could not serialize access'), 'message should embed pg detail');
    }
  });

  it('wraps 57014 (query_canceled) into TimeoutError', () => {
    const err = Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' });
    const wrapped = wrapPgError(err);
    assert.ok(wrapped instanceof TimeoutError, 'expected TimeoutError');
    if (wrapped instanceof TimeoutError) {
      assert.equal(wrapped.code, 'TURBINE_E002');
      assert.equal(wrapped.cause, err);
      assert.equal(wrapped.timeoutMs, 0, 'server-side cancel has no client-side budget');
      assert.ok(
        wrapped.message.includes('Query canceled by server-side statement_timeout'),
        'message should name the server-side statement_timeout cause',
      );
    }
  });

  const CONNECTION_SQLSTATES = [
    '08000',
    '08001',
    '08003',
    '08004',
    '08006',
    '08P01',
    '53300',
    '57P01',
    '57P02',
    '57P03',
  ];
  for (const code of CONNECTION_SQLSTATES) {
    it(`wraps pg SQLSTATE ${code} into ConnectionError`, () => {
      const err = Object.assign(new Error(`connection problem for ${code}`), { code });
      const wrapped = wrapPgError(err);
      assert.ok(wrapped instanceof ConnectionError, `expected ConnectionError for ${code}`);
      if (wrapped instanceof ConnectionError) {
        assert.equal(wrapped.code, 'TURBINE_E004');
        assert.equal(wrapped.cause, err);
        assert.ok(wrapped.message.includes('connection'), 'message should mention connection');
        assert.ok(wrapped.message.includes(`connection problem for ${code}`), 'message should embed pg detail');
      }
    });
  }

  const DRIVER_CONN_CODES = ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EPIPE'];
  for (const code of DRIVER_CONN_CODES) {
    it(`wraps Node driver code ${code} into ConnectionError`, () => {
      const err = Object.assign(new Error(`socket ${code}`), { code });
      const wrapped = wrapPgError(err);
      assert.ok(wrapped instanceof ConnectionError, `expected ConnectionError for ${code}`);
      if (wrapped instanceof ConnectionError) {
        assert.equal(wrapped.code, 'TURBINE_E004');
        assert.equal(wrapped.cause, err);
      }
    });
  }

  it('falls back to a code-only ConnectionError message when the driver error has no message', () => {
    const err = { code: 'ECONNREFUSED' };
    const wrapped = wrapPgError(err);
    assert.ok(wrapped instanceof ConnectionError);
    if (wrapped instanceof ConnectionError) {
      assert.ok(wrapped.message.includes('ECONNREFUSED'), 'message should carry the code when no pg message exists');
      assert.equal(wrapped.cause, err);
    }
  });

  it('does not treat 57014 as a connection-class error', () => {
    // 57014 shares the "57" class prefix with the connection codes but must map
    // to TimeoutError, not ConnectionError.
    const wrapped = wrapPgError(Object.assign(new Error('timeout'), { code: '57014' }));
    assert.ok(wrapped instanceof TimeoutError);
    assert.ok(!(wrapped instanceof ConnectionError));
  });
});

// ---------------------------------------------------------------------------
// DeadlockError
// ---------------------------------------------------------------------------

describe('DeadlockError', () => {
  it('has .code === TURBINE_E012', () => {
    const err = new DeadlockError();
    assert.equal(err.code, TurbineErrorCode.DEADLOCK_DETECTED);
    assert.equal(err.code, 'TURBINE_E012');
  });

  it('has name "DeadlockError"', () => {
    const err = new DeadlockError();
    assert.equal(err.name, 'DeadlockError');
  });

  it('exposes .isRetryable === true', () => {
    const err = new DeadlockError();
    assert.equal(err.isRetryable, true);
  });

  it('default message is generic when no cause is passed', () => {
    const err = new DeadlockError();
    assert.equal(err.message, '[TURBINE_E012] [turbine] Deadlock detected');
  });

  it('default message embeds pg cause message', () => {
    const cause = new Error('Process 1234 waits for ShareLock on ...');
    const err = new DeadlockError({ cause });
    assert.ok(err.message.includes('Deadlock detected'));
    assert.ok(err.message.includes('Process 1234 waits for'));
  });

  it('preserves cause', () => {
    const cause = new Error('orig');
    const err = new DeadlockError({ cause });
    assert.equal(err.cause, cause);
  });

  it('honors explicit message override', () => {
    const err = new DeadlockError({ message: 'custom' });
    assert.equal(err.message, '[TURBINE_E012] custom');
  });

  it('is instanceof TurbineError and Error', () => {
    const err = new DeadlockError();
    assert.ok(err instanceof DeadlockError);
    assert.ok(err instanceof TurbineError);
    assert.ok(err instanceof Error);
  });
});

// ---------------------------------------------------------------------------
// SerializationFailureError
// ---------------------------------------------------------------------------

describe('SerializationFailureError', () => {
  it('has .code === TURBINE_E013', () => {
    const err = new SerializationFailureError();
    assert.equal(err.code, TurbineErrorCode.SERIALIZATION_FAILURE);
    assert.equal(err.code, 'TURBINE_E013');
  });

  it('has name "SerializationFailureError"', () => {
    const err = new SerializationFailureError();
    assert.equal(err.name, 'SerializationFailureError');
  });

  it('exposes .isRetryable === true', () => {
    const err = new SerializationFailureError();
    assert.equal(err.isRetryable, true);
  });

  it('default message is generic when no cause is passed', () => {
    const err = new SerializationFailureError();
    assert.equal(err.message, '[TURBINE_E013] [turbine] Serializable transaction conflict');
  });

  it('default message embeds pg cause message', () => {
    const cause = new Error('could not serialize access due to read/write dependencies');
    const err = new SerializationFailureError({ cause });
    assert.ok(err.message.includes('Serializable transaction conflict'));
    assert.ok(err.message.includes('could not serialize access'));
  });

  it('preserves cause', () => {
    const cause = new Error('orig');
    const err = new SerializationFailureError({ cause });
    assert.equal(err.cause, cause);
  });

  it('honors explicit message override', () => {
    const err = new SerializationFailureError({ message: 'custom' });
    assert.equal(err.message, '[TURBINE_E013] custom');
  });

  it('is instanceof TurbineError and Error', () => {
    const err = new SerializationFailureError();
    assert.ok(err instanceof SerializationFailureError);
    assert.ok(err instanceof TurbineError);
    assert.ok(err instanceof Error);
  });
});

// ---------------------------------------------------------------------------
// NotFoundError message redaction modes
// ---------------------------------------------------------------------------

describe('NotFoundError redaction modes', () => {
  // These tests mutate global mode — make sure to restore after each test.
  const original = getErrorMessageMode();
  const restore = () => setErrorMessageMode(original);

  it('default mode is "safe"', () => {
    // Constructor of TurbineClient sets the mode if config.errorMessages is
    // provided. The library default (no client constructed) should be safe.
    // We can't reliably assert "safe" here if a previous test changed it, so
    // we restore explicitly first.
    setErrorMessageMode('safe');
    assert.equal(getErrorMessageMode(), 'safe');
    restore();
  });

  it('safe mode: message includes only where keys, not values', () => {
    setErrorMessageMode('safe');
    try {
      const err = new NotFoundError({
        table: 'users',
        where: { email: 'alice@x.com', id: 42 },
        operation: 'findUniqueOrThrow',
      });
      assert.ok(err.message.includes('{ email, id }'), `expected key-only message, got: ${err.message}`);
      assert.ok(!err.message.includes('alice@x.com'), 'safe mode must NOT leak email value');
      assert.ok(!err.message.includes('42'), 'safe mode must NOT leak id value');
    } finally {
      restore();
    }
  });

  it('safe mode: preserves the legacy message prefix for substring tests', () => {
    setErrorMessageMode('safe');
    try {
      const err = new NotFoundError({
        table: 'users',
        where: { id: 1 },
        operation: 'findUniqueOrThrow',
      });
      assert.ok(err.message.startsWith('[TURBINE_E001] [turbine] findUniqueOrThrow on "users" found no record'));
    } finally {
      restore();
    }
  });

  it('safe mode: empty where renders as {}', () => {
    setErrorMessageMode('safe');
    try {
      const err = new NotFoundError({ table: 'users', where: {}, operation: 'update' });
      assert.ok(err.message.includes('{}'));
    } finally {
      restore();
    }
  });

  it('verbose mode: message includes full JSON where', () => {
    setErrorMessageMode('verbose');
    try {
      const err = new NotFoundError({
        table: 'users',
        where: { email: 'alice@x.com', id: 42 },
        operation: 'findUniqueOrThrow',
      });
      assert.ok(err.message.includes('"email":"alice@x.com"'), 'verbose mode should include email value');
      assert.ok(err.message.includes('"id":42'), 'verbose mode should include id value');
    } finally {
      restore();
    }
  });

  it('verbose mode: preserves the legacy message prefix for substring tests', () => {
    setErrorMessageMode('verbose');
    try {
      const err = new NotFoundError({
        table: 'users',
        where: { id: 1 },
        operation: 'findUniqueOrThrow',
      });
      assert.ok(err.message.startsWith('[TURBINE_E001] [turbine] findUniqueOrThrow on "users" found no record'));
    } finally {
      restore();
    }
  });

  it('redaction mode does not affect structured properties', () => {
    setErrorMessageMode('safe');
    try {
      const where = { email: 'alice@x.com', id: 42 };
      const err = new NotFoundError({ table: 'users', where, operation: 'findUniqueOrThrow' });
      // Structured fields are always populated regardless of message mode.
      assert.deepEqual(err.where, where);
      assert.equal(err.table, 'users');
      assert.equal(err.operation, 'findUniqueOrThrow');
    } finally {
      restore();
    }
  });
});

// ---------------------------------------------------------------------------
// PII-safe constraint error messages
// ---------------------------------------------------------------------------

describe('constraint errors are PII-safe by default', () => {
  const withMode = (mode: 'safe' | 'verbose', fn: () => void) => {
    const prev = getErrorMessageMode();
    setErrorMessageMode(mode);
    try {
      fn();
    } finally {
      setErrorMessageMode(prev);
    }
  };

  // A realistic pg 23505 error: the `detail` field carries the conflicting VALUE.
  const pgUnique = {
    code: '23505',
    constraint: 'users_email_key',
    table: 'users',
    detail: 'Key (email)=(alice@secret.com) already exists.',
    message: 'duplicate key value violates unique constraint "users_email_key"',
  };
  const pgNotNull = {
    code: '23502',
    column: 'email',
    table: 'users',
    detail: 'Failing row contains (14, 1, null, NoEmail, member).',
    message: 'null value in column "email" violates not-null constraint',
  };

  it('safe mode: unique violation message contains the column key but NOT the value', () => {
    withMode('safe', () => {
      const err = wrapPgError(pgUnique) as UniqueConstraintError;
      assert.ok(err instanceof UniqueConstraintError);
      assert.ok(err.message.includes('email'), 'column name should be present');
      assert.ok(!err.message.includes('alice@secret.com'), 'the conflicting VALUE must not leak into the message');
      // Structured access still exposes the columns for programmatic use.
      assert.deepEqual(err.columns, ['email']);
    });
  });

  it('safe mode: not-null violation message does NOT dump the failing row', () => {
    withMode('safe', () => {
      const err = wrapPgError(pgNotNull) as NotNullViolationError;
      assert.ok(err instanceof NotNullViolationError);
      assert.ok(err.message.includes('email'));
      assert.ok(!/Failing row contains|NoEmail/.test(err.message), 'the failing row must not leak into the message');
    });
  });

  it('verbose mode (opt-in): the raw pg detail IS included', () => {
    withMode('verbose', () => {
      const err = wrapPgError(pgUnique) as UniqueConstraintError;
      assert.ok(err.message.includes('alice@secret.com'), 'verbose mode intentionally surfaces the value');
    });
  });

  it('the original pg error is preserved on .cause regardless of mode', () => {
    withMode('safe', () => {
      const err = wrapPgError(pgUnique) as UniqueConstraintError;
      assert.equal((err.cause as { code?: string }).code, '23505');
    });
  });
});

// ---------------------------------------------------------------------------
// Message format: every TurbineError message starts with [TURBINE_E0NN]
// ---------------------------------------------------------------------------

describe('error message code prefix', () => {
  it('prefixes default messages with the stable code tag', () => {
    const samples: Array<{ err: Error; code: string }> = [
      { err: new NotFoundError(), code: 'TURBINE_E001' },
      { err: new TimeoutError(100), code: 'TURBINE_E002' },
      { err: new ValidationError('x'), code: 'TURBINE_E003' },
      { err: new ConnectionError('x'), code: 'TURBINE_E004' },
      { err: new RelationError('x'), code: 'TURBINE_E005' },
      { err: new MigrationError('x'), code: 'TURBINE_E006' },
      { err: new CircularRelationError(['a', 'b']), code: 'TURBINE_E007' },
      { err: new UniqueConstraintError(), code: 'TURBINE_E008' },
      { err: new ForeignKeyError(), code: 'TURBINE_E009' },
      { err: new NotNullViolationError(), code: 'TURBINE_E010' },
      { err: new CheckConstraintError(), code: 'TURBINE_E011' },
      { err: new DeadlockError(), code: 'TURBINE_E012' },
      { err: new SerializationFailureError(), code: 'TURBINE_E013' },
      {
        err: new PipelineError({ results: [{ status: 'error', error: new Error('e') }] }),
        code: 'TURBINE_E014',
      },
      {
        err: new OptimisticLockError({ table: 't', versionField: 'v', expectedVersion: 1 }),
        code: 'TURBINE_E015',
      },
      { err: new ExclusionConstraintError(), code: 'TURBINE_E016' },
      { err: new UnsupportedFeatureError('vector', 'sqlite'), code: 'TURBINE_E017' },
    ];
    for (const { err, code } of samples) {
      assert.ok(
        err.message.startsWith(`[${code}]`),
        `${err.constructor.name} message should start with [${code}], got: ${err.message}`,
      );
    }
  });
});
