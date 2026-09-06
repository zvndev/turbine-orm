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
 * These tests assert that no row or parameter value is reachable from the
 * thrown error in safe mode, that the cause is still USEFUL (prototype,
 * `.code`, constraint names, a real stack, the native-error brand), and that
 * 'verbose' mode is untouched.
 *
 * `detail` was not the whole story. `hint`, `where` (the CONTEXT field) and
 * `internalQuery` carry values too, and passed through verbatim on both the
 * returned error and `.cause`; the last two describe blocks cover them and the
 * unclassified-SQLSTATE scrub that used to delete a schema object's name along
 * with them.
 *
 * Run: npx tsx --test src/test/error-cause-redaction.test.ts
 */

import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { inspect, types } from 'node:util';
import {
  REDACTED_DETAIL,
  setErrorMessageMode,
  TurbineError,
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

/**
 * A pg server error carrying the three fields BESIDES `detail` that can hold a
 * row or parameter value. All three are ordinary own enumerable properties
 * node-postgres copies off the wire ErrorResponse, and `util.inspect` prints
 * them, so a value in any of them reaches every log line that renders the
 * error.
 */
function pgServerError(fields: {
  code: string;
  message: string;
  detail?: string;
  hint?: string;
  where?: string;
  internalQuery?: string;
}): Error & Record<string, unknown> {
  const err = new Error(fields.message) as Error & Record<string, unknown>;
  err.name = 'error';
  err.severity = 'ERROR';
  err.code = fields.code;
  for (const key of ['detail', 'hint', 'where', 'internalQuery'] as const) {
    if (fields[key] !== undefined) err[key] = fields[key];
  }
  return err;
}

/**
 * Every string reachable from `root` by walking OWN properties, cause chain and
 * rendered stacks included, to a bounded depth.
 *
 * The assertions below are written against the RULE ("no value survives
 * anywhere on the object graph"), not against the field names today's
 * implementation happens to redact. `detail` alone was thought to be the whole
 * list for four releases; a walk that names nothing goes red when the next
 * field turns up, where a per-field assertion would pass because nobody thought
 * to add it. `util.inspect` is checked alongside because that is what a log
 * line actually renders, and the two miss different things: inspect stops at
 * its depth budget and elides long strings, while the walk sees non-enumerable
 * properties inspect hides.
 *
 * Getters are deliberately not invoked, other than the `stack` read every error
 * serializer performs: calling arbitrary driver accessors is not something an
 * assertion should do.
 */
function reachableStrings(root: unknown, maxDepth = 8): string[] {
  const found: string[] = [];
  const seen = new Set<object>();
  const walk = (node: unknown, depth: number): void => {
    if (typeof node === 'string') {
      found.push(node);
      return;
    }
    if (!node || typeof node !== 'object' || depth > maxDepth) return;
    if (seen.has(node)) return;
    seen.add(node);
    for (const key of Reflect.ownKeys(node)) {
      const descriptor = Object.getOwnPropertyDescriptor(node, key);
      if (!descriptor || !('value' in descriptor)) continue;
      walk(descriptor.value, depth + 1);
    }
    const stack = (node as { stack?: unknown }).stack;
    if (typeof stack === 'string') found.push(stack);
  };
  walk(root, 0);
  return found;
}

/** The rule: `secret` appears nowhere a logger can reach. */
function assertValueUnreachable(err: unknown, secret: string, label: string): void {
  const hits = reachableStrings(err).filter((s) => s.includes(secret));
  assert.deepEqual(hits, [], `${label}: the value is reachable on the object graph: ${JSON.stringify(hits)}`);
  const rendered = inspect(err, { depth: 8 });
  assert.ok(!rendered.includes(secret), `${label}: the value is rendered by util.inspect:\n${rendered}`);
}

/**
 * `detail` was not the only pg field that carries a value, and for four
 * releases safe mode acted as though it were.
 *
 *   - `hint`: `RAISE EXCEPTION 'boom' USING HINT = 'the email was ' || v` in a
 *     plpgsql function. No non-default server setting, no cooperation from the
 *     application.
 *   - `where` (the CONTEXT field): with `log_parameter_max_length_on_error`
 *     non-zero the server appends `unnamed portal parameter $1 = '...'`, i.e.
 *     the bound parameters, to any error raised while executing a statement.
 *   - `internalQuery`: `EXECUTE format('SELECT %L::int', v)` inside a function
 *     hands the interpolated value back as SQL text.
 *
 * All three survived on the returned error AND on `.cause`, and `util.inspect`
 * rendered all three.
 */
describe("errorMessages: 'safe', the value-bearing fields beyond `detail`", () => {
  const withHint = () => pgServerError({ code: 'P0001', message: 'boom', hint: `the email was ${SECRET}` });
  const withContext = () =>
    pgServerError({
      code: '22P02',
      message: 'invalid input syntax for type integer: "x"',
      where: `unnamed portal parameter $1 = '${SECRET}'`,
    });
  const withInternalQuery = () =>
    pgServerError({
      code: '22P02',
      message: 'invalid input syntax for type integer: "x"',
      internalQuery: `SELECT '${SECRET}'::int`,
    });

  it('a plpgsql RAISE ... USING HINT cannot put a row value anywhere a logger reads', () => {
    setErrorMessageMode('safe');
    assertValueUnreachable(wrapPgError(withHint()), SECRET, 'hint');
  });

  it('the CONTEXT field cannot carry the bound parameters out', () => {
    setErrorMessageMode('safe');
    assertValueUnreachable(wrapPgError(withContext()), SECRET, 'where');
  });

  it('internalQuery cannot carry an EXECUTE format() value out', () => {
    setErrorMessageMode('safe');
    assertValueUnreachable(wrapPgError(withInternalQuery()), SECRET, 'internalQuery');
  });

  it('all four fields at once, on a classified error, so the cause path is exercised too', () => {
    setErrorMessageMode('safe');
    const raw = pgServerError({
      code: '23505',
      message: 'duplicate key value violates unique constraint "users_email_key"',
      detail: `Key (email)=(${SECRET}) already exists.`,
      hint: `try ${SECRET}`,
      where: `unnamed portal parameter $1 = '${SECRET}'`,
      internalQuery: `INSERT INTO users VALUES ('${SECRET}')`,
    });
    const err = wrapPgError(raw);
    assert.ok(err instanceof TurbineError, 'still classified as a Turbine error');
    assertValueUnreachable(err, SECRET, '23505 with all four fields');
    const cause = (err as Error).cause as Record<string, unknown>;
    for (const key of ['detail', 'hint', 'where', 'internalQuery'] as const) {
      assert.equal(cause[key], REDACTED_DETAIL, `${key} must be marked as redacted, not deleted`);
    }
  });

  /**
   * The clone used to be reached only by `detail` being present, so an error
   * whose ONLY value-bearing field was a hint took the "nothing to remove"
   * early return and was handed back verbatim.
   */
  it('redacts a cause whose only value-bearing field is a hint', () => {
    setErrorMessageMode('safe');
    const raw = pgServerError({
      code: '23503',
      message: 'insert or update on table "posts" violates foreign key constraint "posts_user_id_fkey"',
      hint: `no user with email ${SECRET}`,
    });
    const err = wrapPgError(raw);
    assertValueUnreachable(err, SECRET, 'hint-only cause');
    assert.equal(((err as Error).cause as { hint?: string }).hint, REDACTED_DETAIL);
  });

  it('leaves the driver error object itself untouched', () => {
    setErrorMessageMode('safe');
    const raw = withHint();
    wrapPgError(raw);
    assert.equal(raw.hint, `the email was ${SECRET}`, 'we clone, never mutate');
  });

  it("keeps every field in 'verbose' mode, which exists for exactly this", () => {
    setErrorMessageMode('verbose');
    const raw = pgServerError({
      code: 'P0001',
      message: 'boom',
      hint: `the email was ${SECRET}`,
      where: `unnamed portal parameter $1 = '${SECRET}'`,
      internalQuery: `SELECT '${SECRET}'::int`,
    });
    assert.equal(wrapPgError(raw), raw, 'verbose returns the driver error by identity');
    assert.ok(inspect(raw, { depth: 8 }).includes(SECRET));
  });

  /**
   * The value-free-message allowlist is a claim about ONE field. Parameter
   * context attaches to an error of any class, `format()` builds any internal
   * query, and `RAISE ... USING ERRCODE` lets author-written hint text ride
   * whatever SQLSTATE the author picked, so a class keeping its message must
   * still lose these.
   */
  it('redacts them on a class whose MESSAGE is kept, because the allowlist governs only the message', () => {
    setErrorMessageMode('safe');
    const raw = pgServerError({
      code: '42703',
      message: 'column "emial" of relation "users" does not exist',
      hint: `the value was ${SECRET}`,
      where: `unnamed portal parameter $1 = '${SECRET}'`,
    });
    const err = wrapPgError(raw) as Error & Record<string, unknown>;
    assert.equal(err.message, 'column "emial" of relation "users" does not exist', 'the message is kept');
    assertValueUnreachable(err, SECRET, '42703 with a value-bearing hint');
  });
});

/**
 * The unclassified-SQLSTATE scrub used to replace the message of EVERY SQLSTATE
 * `wrapPgError` has no class for, and to withhold it on `.cause` as well. That
 * deleted `relation "orders" does not exist` and `column "emial" of relation
 * "users" does not exist`, the two sentences a first-run or mistyped query most
 * needs, and bought no privacy: a message that names a schema object holds no
 * row value. The scrub now applies where a value can actually ride.
 */
describe("errorMessages: 'safe', an unclassified SQLSTATE keeps text that cannot leak", () => {
  const undefinedTable = () => pgServerError({ code: '42P01', message: 'relation "orders" does not exist' });

  it('keeps a missing-table message, on the error and on .cause', () => {
    setErrorMessageMode('safe');
    const err = wrapPgError(undefinedTable()) as Error & { cause?: Error };
    assert.equal(err.message, 'relation "orders" does not exist');
    assert.equal(err.cause?.message, 'relation "orders" does not exist', '.cause is the documented escape hatch');
  });

  it('keeps a misspelled-column message', () => {
    setErrorMessageMode('safe');
    const err = wrapPgError(
      pgServerError({ code: '42703', message: 'column "emial" of relation "users" does not exist' }),
    ) as Error;
    assert.equal(err.message, 'column "emial" of relation "users" does not exist');
  });

  it('withholds an author-written P0001 and SAYS the text was withheld', () => {
    setErrorMessageMode('safe');
    // `RAISE EXCEPTION 'order % is already shipped', order_id` is idiomatic, so
    // what is in this text is not knowable from inside the library.
    const err = wrapPgError(
      pgServerError({ code: 'P0001', message: `order for ${SECRET} is already shipped` }),
    ) as Error;
    assert.equal(
      err.message,
      "Database error P0001 (driver text withheld by errorMessages: 'safe'; set errorMessages: 'verbose' to see it)",
    );
    assertValueUnreachable(err, SECRET, 'P0001 author text');
  });

  it('withholds a 42601 despite class 42, because a quoted token can be a string literal', () => {
    setErrorMessageMode('safe');
    const err = wrapPgError(
      pgServerError({ code: '42601', message: `syntax error at or near "'${SECRET}'"` }),
    ) as Error;
    assert.ok(err.message.startsWith('Database error 42601'), err.message);
    assert.ok(err.message.includes('driver text withheld'), err.message);
    assertValueUnreachable(err, SECRET, '42601 quoted token');
  });

  it('carries the SQLSTATE on .sqlstate and keeps .code exactly as it was', () => {
    setErrorMessageMode('safe');
    for (const code of ['42P01', 'P0001']) {
      const err = wrapPgError(pgServerError({ code, message: 'whatever' })) as Record<string, unknown>;
      assert.equal(err.code, code, 'no new Turbine code is minted; a caller switching on the SQLSTATE still works');
      assert.equal(err.sqlstate, code, 'the SQLSTATE is also readable under the name the typed errors use');
    }
  });

  /**
   * Making this a TurbineError would mean the SAME database failure has one
   * type under `errorMessages: 'safe'` and another under `'verbose'`, because
   * verbose returns the raw driver error and always has. A log-redaction
   * setting must not decide which `catch` branch runs.
   */
  it('is not a TurbineError, and is not one in verbose mode either', () => {
    setErrorMessageMode('safe');
    const safeErr = wrapPgError(undefinedTable());
    assert.equal(safeErr instanceof TurbineError, false);
    setErrorMessageMode('verbose');
    const raw = undefinedTable();
    assert.equal(wrapPgError(raw), raw, 'verbose passes the driver error through by identity');
    assert.equal(raw instanceof TurbineError, false);
  });

  it('stays a real driver error: prototype, native brand, string stack', () => {
    setErrorMessageMode('safe');
    const raw = undefinedTable();
    const err = wrapPgError(raw) as Error;
    assert.equal(Object.getPrototypeOf(err), Object.getPrototypeOf(raw), 'the driver prototype survives');
    assert.ok(types.isNativeError(err), 'the native-error brand survives');
    assert.equal(typeof err.stack, 'string');
    assert.doesNotThrow(() => (err.stack as string).split('\n'));
  });
});
