/**
 * turbine-orm, error-cause PII redaction tests
 *
 * `errorMessages: 'safe'` (the default) documents itself as keeping row VALUES
 * out of error logs. It kept them out of the Turbine error's own message, but
 * the raw driver error was attached verbatim as `.cause`, and Node's error
 * printer, an uncaught rejection, and Sentry's cause-chain linking all render
 * the cause's own properties. So `console.error(err)` printed
 * `Key (email)=(alice@example.com) already exists.` in the mode that exists to
 * prevent exactly that.
 *
 * These tests assert the driver `detail` is unreachable from the thrown error
 * in safe mode, that the cause is still USEFUL (prototype, `.code`, constraint
 * names, a real stack, the native-error brand), and that 'verbose' mode is
 * untouched.
 *
 * Scope, deliberately: safe mode redacts what Turbine attaches, not everything
 * a driver can say. A SQLSTATE wrapPgError does not classify is returned
 * unchanged, and a few of those (22P02 above all) carry a row value in the
 * `message` itself. See the last describe block.
 *
 * Run: npx tsx --test src/test/error-cause-redaction.test.ts
 */

import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { inspect, types } from 'node:util';
import {
  REDACTED_DETAIL,
  setErrorMessageMode,
  type UniqueConstraintError,
  ValidationError,
  wrapPgError,
} from '../errors.js';

const SECRET = 'alice@example.com';

/** A pg DatabaseError-shaped object: same class shape, same enumerable fields. */
class FakeDatabaseError extends Error {
  code: string;
  detail: string;
  constraint: string;
  table: string;
  constructor(code: string, message: string, detail: string) {
    super(message);
    this.name = 'error';
    this.code = code;
    this.detail = detail;
    this.constraint = 'users_email_key';
    this.table = 'users';
  }
}

const uniqueViolation = (): FakeDatabaseError =>
  new FakeDatabaseError(
    '23505',
    'duplicate key value violates unique constraint "users_email_key"',
    `Key (email)=(${SECRET}) already exists.`,
  );

// The mode is process-global; every test here sets what it needs and the suite
// restores the default so it cannot leak into another test file.
after(() => setErrorMessageMode('safe'));

describe("errorMessages: 'safe' (default), cause redaction", () => {
  it('does not expose the conflicting row values on err.cause.detail', () => {
    setErrorMessageMode('safe');
    const err = wrapPgError(uniqueViolation()) as UniqueConstraintError;
    const cause = err.cause as FakeDatabaseError;
    assert.equal(cause.detail, REDACTED_DETAIL);
    assert.ok(!cause.detail.includes(SECRET));
  });

  it('keeps the row values out of the whole rendered error, which is how they leaked', () => {
    setErrorMessageMode('safe');
    const err = wrapPgError(uniqueViolation());
    // inspect() with a deep budget is what console.error / an uncaught
    // rejection / a log shipper's serializer all effectively do.
    const rendered = inspect(err, { depth: 10 });
    assert.ok(!rendered.includes(SECRET), rendered);
    assert.ok(rendered.includes(REDACTED_DETAIL), rendered);
  });

  it('leaves the driver error object itself untouched (we clone, never mutate)', () => {
    setErrorMessageMode('safe');
    const raw = uniqueViolation();
    wrapPgError(raw);
    assert.equal(raw.detail, `Key (email)=(${SECRET}) already exists.`);
  });

  it('keeps the cause useful: prototype, SQLSTATE, constraint and table survive', () => {
    setErrorMessageMode('safe');
    const err = wrapPgError(uniqueViolation());
    const cause = (err as UniqueConstraintError).cause as FakeDatabaseError;
    assert.ok(cause instanceof FakeDatabaseError, 'prototype was not preserved');
    assert.equal(cause.code, '23505');
    assert.equal(cause.constraint, 'users_email_key');
    assert.equal(cause.table, 'users');
    assert.equal(cause.message, 'duplicate key value violates unique constraint "users_email_key"');
  });

  /**
   * The redacted cause has to stay a REAL error. A clone built with
   * `Object.create(proto, descriptors)` keeps the prototype (so `instanceof`
   * passes and this looks fine) while silently losing V8's [[ErrorData]] slot,
   * which is what backs the `stack` accessor: `cause.stack` reads `undefined`,
   * `util.types.isNativeError` reads false, and any log serializer doing
   * `err.cause.stack.split('\n')` throws a TypeError inside the error path.
   */
  it('keeps the cause a real error: string stack, native brand, [object Error]', () => {
    setErrorMessageMode('safe');
    const raw = uniqueViolation();
    const rawStack = raw.stack;
    const err = wrapPgError(raw);
    const cause = (err as Error).cause as Error;
    assert.equal(typeof cause.stack, 'string', 'stack must survive the redaction clone');
    assert.equal(cause.stack, rawStack, "stack must be the original frames, not the redactor's");
    assert.ok(types.isNativeError(cause), 'cause lost its native-error brand');
    assert.equal(Object.prototype.toString.call(cause), '[object Error]');
    assert.ok(cause instanceof Error);
    // The thing that actually broke in production logs.
    assert.doesNotThrow(() => (cause.stack as string).split('\n'));
  });

  it('does not leak the row value through the surviving stack', () => {
    setErrorMessageMode('safe');
    const err = wrapPgError(uniqueViolation());
    const cause = (err as Error).cause as Error;
    assert.ok(!(cause.stack as string).includes(SECRET), String(cause.stack));
  });

  it('redacts a non-error cause object too, without pretending it is an error', () => {
    setErrorMessageMode('safe');
    const raw = { code: '23505', detail: `Key (email)=(${SECRET}) already exists.` };
    const err = wrapPgError(raw);
    const cause = (err as Error).cause as { detail: string };
    assert.equal(cause.detail, REDACTED_DETAIL);
    assert.ok(!types.isNativeError(cause));
  });

  it('still parses column NAMES out of the detail before redacting it', () => {
    setErrorMessageMode('safe');
    const err = wrapPgError(uniqueViolation()) as UniqueConstraintError;
    assert.deepEqual(err.columns, ['email']);
  });

  it('redacts the not-null violation detail, which carries the entire failing row', () => {
    setErrorMessageMode('safe');
    const raw = new FakeDatabaseError(
      '23502',
      'null value in column "name" of relation "users" violates not-null constraint',
      `Failing row contains (7, ${SECRET}, null).`,
    );
    const err = wrapPgError(raw);
    assert.ok(!inspect(err, { depth: 10 }).includes(SECRET));
  });

  it('passes a cause with no detail through by identity (no needless clone)', () => {
    setErrorMessageMode('safe');
    const raw = Object.assign(new Error('deadlock detected'), { code: '40P01' });
    const err = wrapPgError(raw);
    assert.equal((err as Error).cause, raw);
  });

  it('leaves a cause whose detail is not a string alone rather than inventing one', () => {
    setErrorMessageMode('safe');
    const raw = Object.assign(new Error('boom'), { code: '23503', detail: undefined });
    const err = wrapPgError(raw);
    assert.equal((err as Error).cause, raw);
    assert.equal(((err as Error).cause as { detail?: unknown }).detail, undefined);
  });
});

describe("errorMessages: 'verbose', full fidelity for local debugging", () => {
  it('leaves err.cause identical to the driver error, detail included', () => {
    setErrorMessageMode('verbose');
    const raw = uniqueViolation();
    const err = wrapPgError(raw);
    assert.equal((err as Error).cause, raw);
    assert.equal((raw as FakeDatabaseError).detail, `Key (email)=(${SECRET}) already exists.`);
  });

  it('puts the detail in the message too, as it always has', () => {
    setErrorMessageMode('verbose');
    const err = wrapPgError(uniqueViolation()) as UniqueConstraintError;
    assert.ok(err.message.includes(SECRET), err.message);
  });
});

/**
 * The edge of the contract, now closed. `wrapPgError` used to return an
 * unclassified SQLSTATE unchanged, so a class-22 data exception carried the
 * bound row value straight through safe mode in the driver `message`. Class 22
 * is now a ValidationError whose message names the column and the SQLSTATE,
 * with the driver text redacted under safe mode and the raw error kept on
 * `.cause` with its own message withheld. This test pins that the value is
 * gone from every surface a logger reads.
 */
describe("errorMessages: 'safe', class-22 data exceptions", () => {
  it('wraps an invalid-input driver error (22P02) as ValidationError with the value redacted', () => {
    setErrorMessageMode('safe');
    const raw = new FakeDatabaseError('22P02', `invalid input syntax for type integer: "${SECRET}"`, 'unused detail');
    const err = wrapPgError(raw) as Error & { code?: string; cause?: { code?: string } };
    assert.ok(err instanceof ValidationError, 'class 22 is a ValidationError');
    assert.equal(err.code, 'TURBINE_E003');
    assert.ok(!err.message.includes(SECRET), `message leaked the value: ${err.message}`);
    assert.ok(err.message.includes('22P02'), 'message names the SQLSTATE');
    assert.equal(err.cause?.code, '22P02', 'the raw driver error is kept on .cause');
    assert.ok(!inspect(err, { depth: 6 }).includes(SECRET), 'util.inspect must not surface the value');
  });
});
