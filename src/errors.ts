/**
 * turbine-orm — Error types
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
} as const;

export type TurbineErrorCode = (typeof TurbineErrorCode)[keyof typeof TurbineErrorCode];

/** Base error class for all Turbine errors */
export class TurbineError extends Error {
  readonly code: TurbineErrorCode;

  constructor(code: TurbineErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
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
 * programmatic access — only the human-readable message is redacted.
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
 */
export function setErrorMessageMode(mode: ErrorMessageMode): void {
  errorMessageMode = mode;
}

/** Returns the current NotFoundError message mode. Exported for tests. */
export function getErrorMessageMode(): ErrorMessageMode {
  return errorMessageMode;
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
    // Back-compat: string argument (or undefined) — replicate legacy behavior.
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

  constructor(timeoutMs: number, context = 'Query') {
    super(TurbineErrorCode.TIMEOUT, `[turbine] ${context} timed out after ${timeoutMs}ms`);
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
  constructor(message: string) {
    super(TurbineErrorCode.CONNECTION, message);
    this.name = 'ConnectionError';
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
      const detail = detailFromCause(cause);
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
      const detail = detailFromCause(cause);
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
      const detail = detailFromCause(cause);
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
 * This error is **retryable** — when caught, callers can safely retry the
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
 * conflict (pg code 40001 — `could not serialize access due to ...`).
 *
 * This error is **retryable** — by Postgres documentation, the recommended
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
      const detail = detailFromCause(cause);
      if (detail) message += `: ${detail}`;
    }
    super(TurbineErrorCode.CHECK_VIOLATION, message, { cause });
    this.name = 'CheckConstraintError';
    this.constraint = constraint;
    this.table = table;
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
 * Translate a pg driver error into a typed Turbine error.
 * If the error doesn't match a known constraint code, returns it unchanged.
 *
 * Maps:
 *   23505 (unique_violation)      -> UniqueConstraintError
 *   23503 (foreign_key_violation) -> ForeignKeyError
 *   23502 (not_null_violation)    -> NotNullViolationError
 *   23514 (check_violation)       -> CheckConstraintError
 *   40P01 (deadlock_detected)     -> DeadlockError       (retryable)
 *   40001 (serialization_failure) -> SerializationFailureError (retryable)
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
    case '40P01':
      return new DeadlockError({
        constraint: e.constraint,
        cause: err,
      });
    case '40001':
      return new SerializationFailureError({
        cause: err,
      });
    default:
      return err;
  }
}
