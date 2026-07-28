/**
 * turbine-orm, Error types
 *
 * Typed errors with error codes for programmatic handling.
 * All Turbine errors extend TurbineError which includes a `code` property.
 */

/** Error codes for all Turbine errors */
export const TurbineErrorCode = {
  NOT_FOUND: 'TURBINE_E001',
  TIMEOUT: 'TURBINE_E002',
  VALIDATION: 'TURBINE_E003',
  CONNECTION: 'TURBINE_E004',
  RELATION: 'TURBINE_E005',
  MIGRATION: 'TURBINE_E006',
  CIRCULAR_RELATION: 'TURBINE_E007',
  UNIQUE_VIOLATION: 'TURBINE_E008',
  FOREIGN_KEY_VIOLATION: 'TURBINE_E009',
  NOT_NULL_VIOLATION: 'TURBINE_E010',
  CHECK_VIOLATION: 'TURBINE_E011',
  DEADLOCK_DETECTED: 'TURBINE_E012',
  SERIALIZATION_FAILURE: 'TURBINE_E013',
  PIPELINE: 'TURBINE_E014',
  OPTIMISTIC_LOCK: 'TURBINE_E015',
  EXCLUSION_VIOLATION: 'TURBINE_E016',
  UNSUPPORTED_FEATURE: 'TURBINE_E017',
  READ_ONLY: 'TURBINE_E018',
} as const;

export type TurbineErrorCode = (typeof TurbineErrorCode)[keyof typeof TurbineErrorCode];

/**
 * Prefix a human message with its stable error code so logs are greppable
 * without requiring structured field access. Idempotent if the message already
 * starts with `[TURBINE_E0NN]`.
 */
function formatErrorMessage(code: TurbineErrorCode, message: string): string {
  const tag = `[${code}]`;
  if (message.startsWith(tag)) return message;
  // Empty message → just the code (defensive; callers always pass text today).
  if (!message) return tag;
  return `${tag} ${message}`;
}

/** Base error class for all Turbine errors */
export class TurbineError extends Error {
  readonly code: TurbineErrorCode;

  constructor(code: TurbineErrorCode, message: string, options?: { cause?: unknown }) {
    // The cause is redacted in 'safe' mode (see redactCauseForMode). Only pass
    // an options object through when the caller actually supplied a `cause`
    // key: `new Error(msg, {})` defines no `cause` own property, while
    // `new Error(msg, { cause: undefined })` defines one whose value is
    // undefined, and error-serializing sinks tell those two apart.
    const opts = options && 'cause' in options ? { ...options, cause: redactCauseForMode(options.cause) } : options;
    super(formatErrorMessage(code, message), opts);
    this.name = 'TurbineError';
    this.code = code;
  }
}

/**
 * Controls whether NotFoundError messages include the actual `where` values
 * (`'verbose'`) or only the where-clause keys (`'safe'`, the default).
 *
 * Defaults to `'safe'` to avoid leaking PII into error logs (Sentry, Datadog,
 * etc.). The full `where` object is always available as `err.where` for
 * programmatic access, only the human-readable message is redacted.
 *
 * Set via `setErrorMessageMode('verbose')` or by constructing TurbineClient
 * with `{ errorMessages: 'verbose' }`.
 */
export type ErrorMessageMode = 'safe' | 'verbose';

let errorMessageMode: ErrorMessageMode = 'safe';

/**
 * Set the global NotFoundError message mode. Called from the TurbineClient
 * constructor when `TurbineConfig.errorMessages` is provided.
 *
 *   - `'safe'`    (default): the message includes only the keys of the where
 *     clause (e.g. `where: { id, email }`). Values are redacted.
 *   - `'verbose'`: the message includes the full JSON-serialized where
 *     clause (e.g. `where: {"id":1,"email":"alice@x.com"}`).
 *
 * SCOPE, stated precisely because the useful version of this contract is the
 * one that is true. 'safe' mode redacts row values from the surfaces Turbine
 * OWNS: its own error messages, and the `detail` field of a driver error it
 * wraps and attaches as `.cause` (see redactCauseForMode).
 *
 * It is NOT a blanket guarantee that no row value can be reached from a thrown
 * error. A driver error whose SQLSTATE {@link wrapPgError} does not classify is
 * returned UNCHANGED, and some of those carry a value in the `message` field
 * itself, where nothing can be removed without destroying the diagnosis:
 * `22P02 invalid input syntax for type integer: "alice@example.com"` is the
 * common one. Treat 'safe' mode as removing Turbine's own contribution to the
 * leak, not as a log-scrubbing boundary.
 */
export function setErrorMessageMode(mode: ErrorMessageMode): void {
  errorMessageMode = mode;
}

/** Returns the current NotFoundError message mode. Exported for tests. */
export function getErrorMessageMode(): ErrorMessageMode {
  return errorMessageMode;
}

/**
 * The marker left where a driver `detail` string was removed in 'safe' mode.
 * Re-exported from the package root so tests and callers writing log
 * assertions can match on it without hardcoding the wording.
 */
export const REDACTED_DETAIL = '[redacted by turbine errorMessages:"safe"]';

/**
 * Postgres puts the CONFLICTING ROW VALUES in the `detail` field of a
 * constraint error, and nowhere else: `Key (email)=(alice@example.com) already
 * exists.` for 23505, `Failing row contains (7, alice@example.com, …)` for
 * 23502. The `message` field carries only relation/constraint/column NAMES.
 *
 * 'safe' mode keeps those values out of the Turbine error's own message, but
 * the raw driver error used to be attached verbatim as `.cause`, so the values
 * still reached every place an error object gets rendered whole:
 *   - `console.error(err)` / an uncaught rejection: Node's error printer walks
 *     the cause chain and prints `[cause]: … detail: 'Key (email)=(…)'`. Note
 *     that `cause` is ALREADY non-enumerable (the Error constructor defines it
 *     that way) and Node prints it anyway, so hiding the property is not a fix;
 *   - Sentry and similar sinks link `cause` chains by default and serialize
 *     each link's own properties.
 *
 * So in 'safe' mode the cause is replaced by a shallow clone with `detail`
 * swapped for {@link REDACTED_DETAIL}. Cloning rather than mutating leaves the
 * driver's own object untouched (a caller holding it from their own catch sees
 * what the driver produced).
 *
 * The clone must remain a REAL error, which is the part that is easy to get
 * wrong. `Object.create(proto, descriptors)` looks equivalent and is not: V8
 * installs `stack` as an own ACCESSOR whose backing store is the internal
 * [[ErrorData]] slot, and that slot is not a property, so it is not copied. The
 * result reads `cause.stack === undefined`, `util.types.isNativeError(cause) ===
 * false` and `Object.prototype.toString.call(cause) === '[object Object]'`, i.e.
 * every log serializer that does `err.cause.stack.split('\n')` throws a
 * TypeError and Sentry/pino drop the cause's frames. So the clone starts life
 * as `new Error()` (which HAS the slot), is re-prototyped to the driver error's
 * own prototype, and takes the original's stack as a plain string. That keeps
 * `cause instanceof pg.DatabaseError`, `cause.code === '23505'`, the native
 * brand, and the frames.
 *
 * In 'verbose' mode the cause passes through untouched: that mode's documented
 * job is full-fidelity debugging.
 */
function redactCauseForMode(cause: unknown): unknown {
  if (errorMessageMode === 'verbose') return cause;
  if (!cause || typeof cause !== 'object') return cause;
  const detail = (cause as { detail?: unknown }).detail;
  // Nothing value-bearing to remove: return the original object so the common
  // case (a non-pg cause, or a pg error without a detail) allocates nothing and
  // keeps object identity with what the driver threw.
  if (typeof detail !== 'string' || detail.length === 0) return cause;
  try {
    const descriptors = Object.getOwnPropertyDescriptors(cause);
    // Replace the descriptor rather than assigning after the clone exists: a
    // non-writable `detail` would make the assignment throw in strict mode
    // (every module here is ESM, so it always would), and losing the cause is
    // worse than paying for one descriptor literal.
    descriptors.detail = {
      value: REDACTED_DETAIL,
      writable: true,
      enumerable: descriptors.detail?.enumerable ?? true,
      configurable: true,
    };
    // Brand check rather than `instanceof Error`, so a driver error thrown from
    // another realm (a worker, a bundled duplicate of pg) is still recognized.
    const isError = Object.prototype.toString.call(cause) === '[object Error]';
    if (!isError) return Object.create(Object.getPrototypeOf(cause), descriptors);

    // `new Error()` is the only way to obtain the [[ErrorData]] slot; the
    // prototype is then pointed at the driver error's, so `instanceof` and
    // `.name` behave exactly as before.
    const clone = new Error();
    Object.setPrototypeOf(clone, Object.getPrototypeOf(cause));
    // The clone's own fresh `stack` accessor would otherwise describe THIS
    // function's frames, and the original's accessor cannot be transplanted
    // (it reads the receiver's slot). Copy the rendered string instead, and
    // only when it is one: a driver that stashed a non-string there keeps its
    // own descriptor rather than having a lie written over it.
    const originalStack = (cause as { stack?: unknown }).stack;
    if (typeof originalStack === 'string') {
      descriptors.stack = { value: originalStack, writable: true, enumerable: false, configurable: true };
    } else if (descriptors.stack && typeof descriptors.stack.get === 'function') {
      // An own accessor bound to the ORIGINAL receiver would return undefined
      // here; drop it and let the clone keep its own working one.
      delete descriptors.stack;
    }
    Object.defineProperties(clone, descriptors);
    return clone;
  } catch {
    // A cause whose descriptors cannot be replayed (an exotic proxy, a frozen
    // prototype chain) must not turn a database error into a TypeError thrown
    // from an error constructor. Dropping the cause entirely is the safe
    // direction here: 'safe' mode's contract is that no row value escapes.
    return undefined;
  }
}

/**
 * Render a user-supplied `where` / `connect` target for a "no row found" error
 * message, honoring the global {@link ErrorMessageMode}. In 'safe' mode (the
 * default) only the key names are shown (`keys [email, id]`) so that PII values
 * never leak into logs; in 'verbose' mode the full JSON serialization is used.
 *
 * This mirrors {@link NotFoundError}'s redaction so that every "no row found"
 * message in the library follows one convention, including the nested-write
 * connect/update failures which historically embedded the raw values.
 */
export function describeTargetForMessage(target: unknown): string {
  if (errorMessageMode === 'verbose') {
    try {
      return JSON.stringify(target);
    } catch {
      return '[unserializable]';
    }
  }
  // safe mode: key names only
  if (target === null || target === undefined || typeof target !== 'object') {
    return 'keys []';
  }
  const keys = Object.keys(target as Record<string, unknown>);
  return `keys [${keys.join(', ')}]`;
}

/**
 * Render a `where` clause for error messages. In 'safe' mode (the default),
 * only the keys are shown; values are stripped to avoid leaking PII into logs.
 * Nested AND/OR/NOT combinators are recursively rendered.
 */
function renderWhereForMessage(where: unknown, mode: ErrorMessageMode): string {
  if (mode === 'verbose') {
    try {
      return JSON.stringify(where);
    } catch {
      return '[unserializable]';
    }
  }
  // safe mode: keys only
  if (where === null || where === undefined) return '';
  if (typeof where !== 'object') return '';
  const keys = Object.keys(where as Record<string, unknown>);
  if (keys.length === 0) return '{}';
  return `{ ${keys.join(', ')} }`;
}

/**
 * Thrown when a record is not found (findUniqueOrThrow, findFirstOrThrow,
 * update/delete against a non-matching row, etc.)
 *
 * Supports two call styles for back-compat:
 *   - `new NotFoundError()` / `new NotFoundError('custom message')`
 *   - `new NotFoundError({ table, where, operation, cause, message })`
 *
 * When called with an options object and no explicit `message`, a Prisma-style
 * message is built automatically. By default, only the where-clause keys are
 * shown to avoid leaking PII into logs:
 *   `[turbine] findUniqueOrThrow on "users" found no record matching where: { id }`
 *
 * Set `setErrorMessageMode('verbose')` (or pass `errorMessages: 'verbose'` to
 * the TurbineClient constructor) to include the full where values:
 *   `[turbine] findUniqueOrThrow on "users" found no record matching where: {"id":1}`
 *
 * The full `where` object, `table`, and `operation` are always available as
 * structured properties on the error instance regardless of mode.
 */
export class NotFoundError extends TurbineError {
  readonly table?: string;
  readonly where?: unknown;
  readonly operation?: string;

  constructor(
    input?:
      | string
      | {
          table?: string;
          where?: unknown;
          operation?: string;
          cause?: unknown;
          message?: string;
        },
  ) {
    // Back-compat: string argument (or undefined), replicate legacy behavior.
    if (typeof input === 'string' || input === undefined) {
      super(TurbineErrorCode.NOT_FOUND, input ?? 'Record not found');
      this.name = 'NotFoundError';
      return;
    }

    const { table, where, operation, cause } = input;
    let message = input.message;
    if (!message) {
      if (operation && table) {
        const wherePart =
          where !== undefined ? ` matching where: ${renderWhereForMessage(where, errorMessageMode)}` : '';
        message = `[turbine] ${operation} on "${table}" found no record${wherePart}`;
      } else if (table) {
        const wherePart =
          where !== undefined ? ` matching where ${renderWhereForMessage(where, errorMessageMode)}` : '';
        message = `[turbine] No record found in "${table}"${wherePart}`;
      } else {
        message = '[turbine] Record not found';
      }
    }
    super(TurbineErrorCode.NOT_FOUND, message, { cause });
    this.name = 'NotFoundError';
    this.table = table;
    this.where = where;
    this.operation = operation;
  }
}

/** Thrown when a query or transaction exceeds the configured timeout */
export class TimeoutError extends TurbineError {
  readonly timeoutMs: number;

  /**
   * @param timeoutMs the client-side timeout budget in ms. Pass `0` when the
   *   duration is unknown (e.g. a server-side `statement_timeout` cancellation
   *   surfaced via `wrapPgError`, where Turbine did not set the deadline).
   * @param context human label for the operation ("Query", "Transaction").
   * @param options optional `message` override and pg `cause` to preserve, used
   *   when wrapping a driver error rather than a client-side timer expiry.
   */
  constructor(timeoutMs: number, context = 'Query', options?: { message?: string; cause?: unknown }) {
    super(TurbineErrorCode.TIMEOUT, options?.message ?? `[turbine] ${context} timed out after ${timeoutMs}ms`, options);
    this.name = 'TimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

/** Thrown when query arguments fail validation (unknown column, invalid operator, etc.) */
export class ValidationError extends TurbineError {
  constructor(message: string) {
    super(TurbineErrorCode.VALIDATION, message);
    this.name = 'ValidationError';
  }
}

/** Thrown when a database connection fails */
export class ConnectionError extends TurbineError {
  /**
   * The driver code that produced this error: a Postgres SQLSTATE (`28P01`
   * wrong password, `3D000` no such database, `08006` connection failure, ...)
   * or a Node socket/TLS code (`ECONNREFUSED`, `CERT_HAS_EXPIRED`, ...).
   *
   * Exposed because E004 covers causes with very different remedies, and the
   * alternative for a caller who needs to tell "wrong password" from "server
   * down" is matching on `.message` text or reaching into `.cause`, both of
   * which are exactly the untyped handling this error class exists to remove.
   * Undefined when Turbine raised the error itself rather than wrapping a
   * driver error (a malformed connection string, a subscription on an HTTP
   * pool).
   */
  readonly sqlstate?: string;

  /**
   * @param message human-readable connection failure description.
   * @param options optional pg/driver `cause` to preserve, used when wrapping a
   *   connection-class driver error via `wrapPgError`, plus the driver `code`
   *   that classified it.
   */
  constructor(message: string, options?: { cause?: unknown; sqlstate?: string }) {
    super(TurbineErrorCode.CONNECTION, message, options);
    this.name = 'ConnectionError';
    this.sqlstate = options?.sqlstate;
  }
}

/** Thrown when a relation reference is invalid */
export class RelationError extends TurbineError {
  constructor(message: string) {
    super(TurbineErrorCode.RELATION, message);
    this.name = 'RelationError';
  }
}

/** Thrown when a migration operation fails */
export class MigrationError extends TurbineError {
  constructor(message: string) {
    super(TurbineErrorCode.MIGRATION, message);
    this.name = 'MigrationError';
  }
}

/** Thrown when circular relation nesting is detected */
export class CircularRelationError extends TurbineError {
  readonly path: string[];

  constructor(path: string[]) {
    super(
      TurbineErrorCode.CIRCULAR_RELATION,
      `[turbine] Circular or too-deep relation nesting detected: ${path.join(' → ')}. Maximum nesting depth is 10.`,
    );
    this.name = 'CircularRelationError';
    this.path = path;
  }
}

// ---------------------------------------------------------------------------
// Database constraint violation errors
// ---------------------------------------------------------------------------

/**
 * Extract the `detail` string from a pg-style error stored as `cause`.
 * Returns undefined if the cause is not an object or has no detail.
 */
function detailFromCause(cause: unknown): string | undefined {
  if (!cause || typeof cause !== 'object') return undefined;
  const d = (cause as { detail?: unknown }).detail;
  return typeof d === 'string' && d.length > 0 ? d : undefined;
}

/** Thrown when a UNIQUE constraint is violated (pg code 23505) */
export class UniqueConstraintError extends TurbineError {
  readonly constraint?: string;
  readonly columns?: string[];
  readonly table?: string;

  constructor(
    opts: {
      constraint?: string;
      columns?: string[];
      table?: string;
      message?: string;
      cause?: unknown;
    } = {},
  ) {
    const { constraint, columns, table, cause } = opts;
    let message = opts.message;
    if (!message) {
      const constraintPart = constraint ? ` on ${constraint}` : '';
      const columnsPart = columns && columns.length > 0 ? ` (${columns.join(', ')})` : '';
      message = `[turbine] Unique constraint violation${constraintPart}${columnsPart}`;
      // PII-safe by default: the raw pg `detail` string contains the
      // conflicting row VALUES (e.g. `Key (email)=(alice@x.com) already
      // exists.`). Only append it in 'verbose' mode. In 'safe' mode the
      // message carries keys/constraint/column names only, and the same goes
      // for `.cause`, whose `detail` is redacted by the TurbineError base
      // constructor (see redactCauseForMode: an unredacted cause put the
      // values straight back into any log line that prints the error object).
      // The structured `.columns`/`.constraint`/`.column` fields survive in
      // both modes, they carry NAMES, never values.
      const detail = errorMessageMode === 'verbose' ? detailFromCause(cause) : undefined;
      if (detail) message += `: ${detail}`;
    }
    super(TurbineErrorCode.UNIQUE_VIOLATION, message, { cause });
    this.name = 'UniqueConstraintError';
    this.constraint = constraint;
    this.columns = columns;
    this.table = table;
  }
}

/** Thrown when a FOREIGN KEY constraint is violated (pg code 23503) */
export class ForeignKeyError extends TurbineError {
  readonly constraint?: string;
  readonly table?: string;

  constructor(
    opts: {
      constraint?: string;
      table?: string;
      message?: string;
      cause?: unknown;
    } = {},
  ) {
    const { constraint, table, cause } = opts;
    let message = opts.message;
    if (!message) {
      const constraintPart = constraint ? ` on ${constraint}` : '';
      message = `[turbine] Foreign key constraint violation${constraintPart}`;
      // PII-safe by default: the raw pg `detail` string contains the
      // conflicting row VALUES (e.g. `Key (email)=(alice@x.com) already
      // exists.`). Only append it in 'verbose' mode. In 'safe' mode the
      // message carries keys/constraint/column names only, and the same goes
      // for `.cause`, whose `detail` is redacted by the TurbineError base
      // constructor (see redactCauseForMode: an unredacted cause put the
      // values straight back into any log line that prints the error object).
      // The structured `.columns`/`.constraint`/`.column` fields survive in
      // both modes, they carry NAMES, never values.
      const detail = errorMessageMode === 'verbose' ? detailFromCause(cause) : undefined;
      if (detail) message += `: ${detail}`;
    }
    super(TurbineErrorCode.FOREIGN_KEY_VIOLATION, message, { cause });
    this.name = 'ForeignKeyError';
    this.constraint = constraint;
    this.table = table;
  }
}

/** Thrown when a NOT NULL constraint is violated (pg code 23502) */
export class NotNullViolationError extends TurbineError {
  readonly column?: string;
  readonly table?: string;

  constructor(
    opts: {
      column?: string;
      table?: string;
      message?: string;
      cause?: unknown;
    } = {},
  ) {
    const { column, table, cause } = opts;
    let message = opts.message;
    if (!message) {
      const columnPart = column ? ` on column "${column}"` : '';
      message = `[turbine] NOT NULL constraint violation${columnPart}`;
      // PII-safe by default: the raw pg `detail` string contains the
      // conflicting row VALUES (e.g. `Key (email)=(alice@x.com) already
      // exists.`). Only append it in 'verbose' mode. In 'safe' mode the
      // message carries keys/constraint/column names only, and the same goes
      // for `.cause`, whose `detail` is redacted by the TurbineError base
      // constructor (see redactCauseForMode: an unredacted cause put the
      // values straight back into any log line that prints the error object).
      // The structured `.columns`/`.constraint`/`.column` fields survive in
      // both modes, they carry NAMES, never values.
      const detail = errorMessageMode === 'verbose' ? detailFromCause(cause) : undefined;
      if (detail) message += `: ${detail}`;
    }
    super(TurbineErrorCode.NOT_NULL_VIOLATION, message, { cause });
    this.name = 'NotNullViolationError';
    this.column = column;
    this.table = table;
  }
}

/**
 * Thrown when Postgres detects a deadlock (pg code 40P01).
 *
 * This error is **retryable**, when caught, callers can safely retry the
 * transaction (typically with backoff). Catch it explicitly:
 *
 * ```ts
 * try {
 *   await db.$transaction(async (tx) => { ... });
 * } catch (err) {
 *   if (err instanceof DeadlockError) {
 *     // safe to retry
 *   }
 * }
 * ```
 */
export class DeadlockError extends TurbineError {
  /** Marks this error as safe to retry */
  readonly isRetryable = true as const;
  readonly constraint?: string;

  constructor(
    opts: {
      message?: string;
      constraint?: string;
      cause?: unknown;
    } = {},
  ) {
    const { constraint, cause } = opts;
    let message = opts.message;
    if (!message) {
      const pgMessage = (cause as { message?: string } | null | undefined)?.message;
      message = pgMessage ? `[turbine] Deadlock detected: ${pgMessage}` : '[turbine] Deadlock detected';
    }
    super(TurbineErrorCode.DEADLOCK_DETECTED, message, { cause });
    this.name = 'DeadlockError';
    this.constraint = constraint;
  }
}

/**
 * Thrown when a Serializable transaction fails due to a serialization
 * conflict (pg code 40001, `could not serialize access due to ...`).
 *
 * This error is **retryable**, by Postgres documentation, the recommended
 * response is to re-run the entire transaction. Catch it explicitly:
 *
 * ```ts
 * try {
 *   await db.$transaction(async (tx) => { ... }, { isolationLevel: 'Serializable' });
 * } catch (err) {
 *   if (err instanceof SerializationFailureError) {
 *     // safe to retry the whole transaction
 *   }
 * }
 * ```
 */
export class SerializationFailureError extends TurbineError {
  /** Marks this error as safe to retry */
  readonly isRetryable = true as const;

  constructor(
    opts: {
      message?: string;
      cause?: unknown;
    } = {},
  ) {
    const { cause } = opts;
    let message = opts.message;
    if (!message) {
      const pgMessage = (cause as { message?: string } | null | undefined)?.message;
      message = pgMessage
        ? `[turbine] Serializable transaction conflict: ${pgMessage}`
        : '[turbine] Serializable transaction conflict';
    }
    super(TurbineErrorCode.SERIALIZATION_FAILURE, message, { cause });
    this.name = 'SerializationFailureError';
  }
}

/** Thrown when a CHECK constraint is violated (pg code 23514) */
export class CheckConstraintError extends TurbineError {
  readonly constraint?: string;
  readonly table?: string;

  constructor(
    opts: {
      constraint?: string;
      table?: string;
      message?: string;
      cause?: unknown;
    } = {},
  ) {
    const { constraint, table, cause } = opts;
    let message = opts.message;
    if (!message) {
      const constraintPart = constraint ? ` on ${constraint}` : '';
      message = `[turbine] Check constraint violation${constraintPart}`;
      // PII-safe by default: the raw pg `detail` string contains the
      // conflicting row VALUES (e.g. `Key (email)=(alice@x.com) already
      // exists.`). Only append it in 'verbose' mode. In 'safe' mode the
      // message carries keys/constraint/column names only, and the same goes
      // for `.cause`, whose `detail` is redacted by the TurbineError base
      // constructor (see redactCauseForMode: an unredacted cause put the
      // values straight back into any log line that prints the error object).
      // The structured `.columns`/`.constraint`/`.column` fields survive in
      // both modes, they carry NAMES, never values.
      const detail = errorMessageMode === 'verbose' ? detailFromCause(cause) : undefined;
      if (detail) message += `: ${detail}`;
    }
    super(TurbineErrorCode.CHECK_VIOLATION, message, { cause });
    this.name = 'CheckConstraintError';
    this.constraint = constraint;
    this.table = table;
  }
}

export class ExclusionConstraintError extends TurbineError {
  readonly constraint?: string;
  readonly table?: string;

  constructor(
    opts: {
      constraint?: string;
      table?: string;
      message?: string;
      cause?: unknown;
    } = {},
  ) {
    const { constraint, table, cause } = opts;
    let message = opts.message;
    if (!message) {
      const constraintPart = constraint ? ` on ${constraint}` : '';
      message = `[turbine] Exclusion constraint violation${constraintPart}`;
      // PII-safe by default: the raw pg `detail` string contains the
      // conflicting row VALUES (e.g. `Key (email)=(alice@x.com) already
      // exists.`). Only append it in 'verbose' mode. In 'safe' mode the
      // message carries keys/constraint/column names only, and the same goes
      // for `.cause`, whose `detail` is redacted by the TurbineError base
      // constructor (see redactCauseForMode: an unredacted cause put the
      // values straight back into any log line that prints the error object).
      // The structured `.columns`/`.constraint`/`.column` fields survive in
      // both modes, they carry NAMES, never values.
      const detail = errorMessageMode === 'verbose' ? detailFromCause(cause) : undefined;
      if (detail) message += `: ${detail}`;
    }
    super(TurbineErrorCode.EXCLUSION_VIOLATION, message, { cause });
    this.name = 'ExclusionConstraintError';
    this.constraint = constraint;
    this.table = table;
  }
}

// ---------------------------------------------------------------------------
// Pipeline error
// ---------------------------------------------------------------------------

/** Result slot for a single query in a non-transactional pipeline */
export type PipelineResultSlot = { status: 'ok'; value: unknown } | { status: 'error'; error: Error };

/**
 * Thrown when a non-transactional pipeline has partial failures.
 *
 * In non-transactional mode (`{ transactional: false }`), each query executes
 * independently. If one or more queries fail, the pipeline rejects with a
 * `PipelineError` that carries per-query results so callers can inspect which
 * succeeded and which failed.
 *
 * ```ts
 * try {
 *   await db.pipeline([q1, q2, q3], { transactional: false });
 * } catch (err) {
 *   if (err instanceof PipelineError) {
 *     for (const slot of err.results) {
 *       if (slot.status === 'error') console.error(slot.error);
 *     }
 *   }
 * }
 * ```
 */
export class PipelineError extends TurbineError {
  /** Per-query results: each slot is either `{status:'ok', value}` or `{status:'error', error}` */
  readonly results: PipelineResultSlot[];

  /** Zero-based index of the first query that failed */
  readonly failedIndex?: number;

  /** Tag of the first query that failed (from DeferredQuery.tag) */
  readonly failedTag?: string;

  constructor(opts: {
    message?: string;
    results: PipelineResultSlot[];
    failedIndex?: number;
    failedTag?: string;
    cause?: unknown;
  }) {
    const { results, failedIndex, failedTag, cause } = opts;
    const failedCount = results.filter((r) => r.status === 'error').length;
    const message =
      opts.message ??
      `[turbine] Pipeline completed with ${failedCount} error(s) out of ${results.length} queries` +
        (failedTag ? ` (first failure: ${failedTag} at index ${failedIndex})` : '');
    super(TurbineErrorCode.PIPELINE, message, { cause });
    this.name = 'PipelineError';
    this.results = results;
    this.failedIndex = failedIndex;
    this.failedTag = failedTag;
  }
}

export class OptimisticLockError extends TurbineError {
  readonly table: string;
  readonly versionField: string;
  readonly expectedVersion: unknown;

  constructor(opts: { table: string; versionField: string; expectedVersion: unknown }) {
    super(
      TurbineErrorCode.OPTIMISTIC_LOCK,
      `[turbine] Optimistic lock failed on "${opts.table}", ` +
        `expected ${opts.versionField} = ${opts.expectedVersion} but row was modified by another transaction`,
    );
    this.name = 'OptimisticLockError';
    this.table = opts.table;
    this.versionField = opts.versionField;
    this.expectedVersion = opts.expectedVersion;
  }
}

/**
 * Thrown when a Postgres-only feature (pgvector distance ops, LISTEN/NOTIFY
 * realtime, RLS session GUCs, advisory-lock migration locking, ...) is invoked
 * on a dialect/engine whose capability flag reports it unsupported. Surfaces a
 * clear `unsupported on <engine>` message instead of generating broken SQL.
 */
export class UnsupportedFeatureError extends TurbineError {
  readonly feature: string;
  readonly dialect: string;

  constructor(feature: string, dialect: string, hint?: string) {
    super(
      TurbineErrorCode.UNSUPPORTED_FEATURE,
      `[turbine] ${feature} is unsupported on "${dialect}".${hint ? ` ${hint}` : ''}`,
    );
    this.name = 'UnsupportedFeatureError';
    this.feature = feature;
    this.dialect = dialect;
  }
}

/**
 * Thrown when a write or DDL statement is refused because the target is
 * read-only. Two shapes reach here, both on PowDB:
 *   - an embedded database opened read-only for snapshot serving refuses a write
 *     with `readonly mode: statement requires a writer …`;
 *   - a networked read-only role refuses a write with `permission denied: role
 *     '<role>' cannot execute write statements` (translated by `wrapPowdbError`).
 * It is also raised locally, before the wire, when a write is issued on a pool
 * the caller marked read-only (fail-fast). The message carries the engine text
 * plus a hint to route writes to a writable primary.
 *
 * NOT retryable: the same write against the same read-only target fails
 * identically; route it to a writable primary instead.
 */
export class ReadOnlyError extends TurbineError {
  /**
   * Why the write was refused. `'snapshot'`: the database itself is read-only
   * (snapshot serving, an embedded `readonly: true` open, or the client-level
   * fail-fast flag), so NOTHING can write here and writes must route to the
   * primary. `'rbac'`: the database is writable but THIS connection's role may
   * not write (per-connection permission), so re-authenticating may suffice.
   */
  readonly reason: 'snapshot' | 'rbac';

  /**
   * @param detail human-readable description of the refused write (the engine
   *   message, or a local fail-fast description). A "route writes to a writable
   *   primary" hint is always appended.
   * @param options optional driver `cause` to preserve when wrapping a refusal,
   *   and the refusal `reason` (default `'snapshot'`).
   */
  constructor(detail: string, options?: { cause?: unknown; reason?: 'snapshot' | 'rbac' }) {
    super(TurbineErrorCode.READ_ONLY, `[turbine] ${detail} Route writes to a writable primary.`, {
      cause: options?.cause,
    });
    this.name = 'ReadOnlyError';
    this.reason = options?.reason ?? 'snapshot';
  }
}

/**
 * Parse column names out of a pg `detail` string like:
 *   "Key (email)=(foo@bar) already exists."
 *   "Key (col1, col2)=(v1, v2) already exists."
 */
function parseColumnsFromDetail(detail: string): string[] | undefined {
  const m = detail.match(/^Key \(([^)]+)\)/);
  if (!m) return undefined;
  return m[1]!.split(',').map((s) => s.trim());
}

/**
 * Connection-class error codes. Covers pg SQLSTATEs (class 08
 * connection_exception, class 28 authorization refusals, invalid_catalog_name,
 * plus a few class-53/57 admin/availability codes) and Node driver-level socket
 * and TLS error codes that arrive on the same `.code` field when the connection
 * never reaches (or never gets past) Postgres. All map to
 * {@link ConnectionError} (E004).
 *
 * `57014` (query_canceled, a server-side `statement_timeout` cancellation) is
 * intentionally NOT here: it maps to {@link TimeoutError} (E002) instead.
 */
const CONNECTION_ERROR_CODES = new Set<string>([
  // pg SQLSTATE class 08: connection_exception
  '08000', // connection_exception
  '08001', // sqlclient_unable_to_establish_sqlconnection
  '08003', // connection_does_not_exist
  '08004', // sqlserver_rejected_establishment_of_sqlconnection
  '08006', // connection_failure
  '08007', // transaction_resolution_unknown
  '08P01', // protocol_violation
  // pg SQLSTATE class 28: the server answered and REFUSED us. These are the
  // most common first-run failures there are (wrong password, a pg_hba rule
  // that does not cover this user/host), and they used to fall through
  // wrapPgError untouched: the caller got a raw pg `DatabaseError` whose
  // `.code` was `28P01`, i.e. a value from the SQLSTATE namespace on the SAME
  // property Turbine puts `TURBINE_E0NN` in. Every `err.code.startsWith
  // ('TURBINE_')` check, every `instanceof ConnectionError` catch, and the
  // README's "every error is typed" guarantee silently missed the single
  // failure a new user is most likely to hit.
  '28000', // invalid_authorization_specification
  '28P01', // invalid_password
  // The server answered but the database named in the connection string does
  // not exist. Same class of first-run mistake, same escape.
  '3D000', // invalid_catalog_name
  // pg SQLSTATE class 53/57 (server unavailable / shutting down)
  '53300', // too_many_connections
  '57P01', // admin_shutdown
  '57P02', // crash_shutdown
  '57P03', // cannot_connect_now
  // Node driver-level socket errors (surface on err.code too)
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN', // transient DNS failure
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
  // Node TLS handshake failures. They can only happen while OPENING a
  // connection, so classifying them as connection errors cannot mis-tag a
  // query failure, and a managed Postgres with a private CA is the other
  // first-run wall people hit.
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'CERT_HAS_EXPIRED',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

/**
 * Actionable next step per connection-class code, appended to the driver's own
 * message. The driver message states WHAT happened ("password authentication
 * failed for user \"postgres\""); these state what to do about it, which is the
 * whole difference between a typed error and a raw one for a first-run failure.
 *
 * A code with no entry here simply gets no hint appended.
 */
const CONNECTION_ERROR_HINTS: Readonly<Record<string, string>> = {
  '28P01':
    'The server rejected the credentials. Check the password in your connection string (or DATABASE_URL), including any URL-encoding of special characters.',
  '28000':
    "The server refused this user/host combination. Check the user name and the server's pg_hba.conf rules for the client address.",
  '3D000':
    'The database named in the connection string does not exist. Check the path segment after the host, and create the database if needed.',
  '53300': "The server has no free connection slots. Lower `poolSize` or raise the server's max_connections.",
  '57P03': 'The server is still starting up (or shutting down) and is not accepting connections yet.',
  ECONNREFUSED: 'Nothing is listening on that host and port. Check the server is running and the port is right.',
  ENOTFOUND:
    'The host in the connection string could not be resolved. Check the host name, and that the connection string itself is well formed.',
  EAI_AGAIN: 'DNS lookup for the host failed temporarily. Check network/DNS availability, then retry.',
  ETIMEDOUT:
    'The connection attempt timed out before the server answered. Check firewall/security-group rules and `connectionTimeoutMs`.',
  DEPTH_ZERO_SELF_SIGNED_CERT:
    'The server presented a certificate Node cannot verify. Supply the CA via `ssl: { ca }`.',
  SELF_SIGNED_CERT_IN_CHAIN: 'The server presented a certificate Node cannot verify. Supply the CA via `ssl: { ca }`.',
  UNABLE_TO_VERIFY_LEAF_SIGNATURE:
    'The server presented a certificate Node cannot verify. Supply the CA via `ssl: { ca }`.',
  CERT_HAS_EXPIRED: "The server's TLS certificate has expired. Renew it, or supply the correct CA via `ssl: { ca }`.",
  ERR_TLS_CERT_ALTNAME_INVALID:
    "The server's TLS certificate does not cover the host you connected to. Check the host name in the connection string.",
};

/**
 * Translate a pg driver error into a typed Turbine error.
 * If the error doesn't match a known constraint code, returns it unchanged.
 *
 * Maps:
 *   23505 (unique_violation)      -> UniqueConstraintError
 *   23503 (foreign_key_violation) -> ForeignKeyError
 *   23502 (not_null_violation)    -> NotNullViolationError
 *   23514 (check_violation)       -> CheckConstraintError
 *   23P01 (exclusion_violation)   -> ExclusionConstraintError
 *   40P01 (deadlock_detected)     -> DeadlockError       (retryable)
 *   40001 (serialization_failure) -> SerializationFailureError (retryable)
 *   57014 (query_canceled)        -> TimeoutError (server-side statement_timeout)
 *   28P01 / 28000 (auth refused)  -> ConnectionError, with a remediation hint
 *   3D000 (no such database)      -> ConnectionError, with a remediation hint
 *   connection-class codes        -> ConnectionError (see CONNECTION_ERROR_CODES)
 *
 * The original pg error is preserved as `.cause` on the wrapped error.
 */
export function wrapPgError(err: unknown): unknown {
  if (!err || typeof err !== 'object') return err;
  const e = err as {
    code?: string;
    constraint?: string;
    column?: string;
    table?: string;
    detail?: string;
    message?: string;
  };
  if (!e.code) return err;

  switch (e.code) {
    case '23505': {
      const cols = e.detail ? parseColumnsFromDetail(e.detail) : undefined;
      return new UniqueConstraintError({
        constraint: e.constraint,
        columns: cols,
        table: e.table,
        cause: err,
      });
    }
    case '23503':
      return new ForeignKeyError({
        constraint: e.constraint,
        table: e.table,
        cause: err,
      });
    case '23502':
      return new NotNullViolationError({
        column: e.column,
        table: e.table,
        cause: err,
      });
    case '23514':
      return new CheckConstraintError({
        constraint: e.constraint,
        table: e.table,
        cause: err,
      });
    case '23P01':
      return new ExclusionConstraintError({
        constraint: e.constraint,
        table: e.table,
        cause: err,
      });
    case '40P01':
      return new DeadlockError({
        constraint: e.constraint,
        cause: err,
      });
    case '40001':
      return new SerializationFailureError({
        cause: err,
      });
    case '57014':
      // query_canceled: a server-side statement_timeout cancelled the query.
      // Turbine did not set the deadline (that lives in Postgres config), so
      // there is no client-side budget to report → timeoutMs = 0.
      return new TimeoutError(0, 'Query', {
        message: '[turbine] Query canceled by server-side statement_timeout',
        cause: err,
      });
    default:
      if (CONNECTION_ERROR_CODES.has(e.code)) {
        const pgMessage = typeof e.message === 'string' && e.message.length > 0 ? e.message : undefined;
        // Own-property lookup only: `e.code` is driver-controlled text, and a
        // plain-object map would happily resolve `constructor` or `toString`
        // to a function and interpolate it into the message.
        const hint = Object.hasOwn(CONNECTION_ERROR_HINTS, e.code) ? CONNECTION_ERROR_HINTS[e.code] : undefined;
        const head = pgMessage
          ? `[turbine] Database connection error: ${pgMessage}`
          : `[turbine] Database connection error (${e.code})`;
        return new ConnectionError(hint ? `${head} (${e.code}) ${hint}` : head, { cause: err, sqlstate: e.code });
      }
      return err;
  }
}
