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
  CircularRelationError,
  ConnectionError,
  MigrationError,
  NotFoundError,
  RelationError,
  TimeoutError,
  TurbineError,
  TurbineErrorCode,
  ValidationError,
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
    assert.equal(err.message, 'bad input');
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
  it('has default message "Record not found"', () => {
    const err = new NotFoundError();
    assert.equal(err.message, 'Record not found');
  });

  it('accepts a custom message', () => {
    const err = new NotFoundError('User 42 not found');
    assert.equal(err.message, 'User 42 not found');
  });

  it('has .code === TURBINE_E001', () => {
    const err = new NotFoundError();
    assert.equal(err.code, TurbineErrorCode.NOT_FOUND);
    assert.equal(err.code, 'TURBINE_E001');
  });

  it('is instanceof TurbineError', () => {
    const err = new NotFoundError();
    assert.ok(err instanceof TurbineError);
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
    assert.equal(err.message, '[turbine] Query timed out after 3000ms');
  });

  it('message includes custom context', () => {
    const err = new TimeoutError(1500, 'Transaction');
    assert.equal(err.message, '[turbine] Transaction timed out after 1500ms');
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
    assert.equal(err.message, 'Unknown column "foo"');
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
    assert.equal(err.message, 'could not connect to server');
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
    assert.equal(err.message, 'No relation "foo" on model "bar"');
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
    assert.equal(err.message, 'Column "age" already exists');
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

  it('has exactly 7 error codes', () => {
    assert.equal(Object.keys(TurbineErrorCode).length, 7);
  });
});
