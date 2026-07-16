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
    super(formatErrorMessage(code, message), options);
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
   * @param message human-readable connection failure description.
   * @param options optional pg/driver `cause` to preserve, used when wrapping a
   *   connection-class driver error via `wrapPgError`.
   */
  constructor(message: string, options?: { cause?: unknown }) {
    super(TurbineErrorCode.CONNECTION, message, options);
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
      // PII-safe by default: the raw pg `detail` string contains the
      // conflicting row VALUES (e.g. `Key (email)=(alice@x.com) already
      // exists.`). Only append it in 'verbose' mode. In 'safe' mode the
      // message carries keys/constraint/column names only — the structured
      // `.columns`/`.constraint`/`.column` fields and `.cause` still expose
      // the full detail for programmatic use.
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
      // message carries keys/constraint/column names only — the structured
      // `.columns`/`.constraint`/`.column` fields and `.cause` still expose
      // the full detail for programmatic use.
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
      // message carries keys/constraint/column names only — the structured
      // `.columns`/`.constraint`/`.column` fields and `.cause` still expose
      // the full detail for programmatic use.
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
      // PII-safe by default: the raw pg `detail` string contains the
      // conflicting row VALUES (e.g. `Key (email)=(alice@x.com) already
      // exists.`). Only append it in 'verbose' mode. In 'safe' mode the
      // message carries keys/constraint/column names only — the structured
      // `.columns`/`.constraint`/`.column` fields and `.cause` still expose
      // the full detail for programmatic use.
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
      // message carries keys/constraint/column names only — the structured
      // `.columns`/`.constraint`/`.column` fields and `.cause` still expose
      // the full detail for programmatic use.
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
      `[turbine] Optimistic lock failed on "${opts.table}" — ` +
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
 * Thrown when a write (or a transaction-control `begin`) is attempted on a
 * connection that is read-only — a PowDB pool opened read-only, or a read-only
 * server role. The message carries the refused operation and hints that writes
 * should be routed to a writable primary. Never retryable.
 */
export class ReadOnlyError extends TurbineError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(TurbineErrorCode.READ_ONLY, message, options);
    this.name = 'ReadOnlyError';
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
 * Connection-class error codes. Covers both pg SQLSTATEs (class 08
 * connection_exception, plus a few class-53/57 admin/availability codes) and
 * Node driver-level error codes that arrive on the same `.code` field when the
 * socket never reaches Postgres. All map to {@link ConnectionError} (E004).
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
  '08P01', // protocol_violation
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
  'EPIPE',
]);

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
        return new ConnectionError(
          pgMessage
            ? `[turbine] Database connection error: ${pgMessage}`
            : `[turbine] Database connection error (${e.code})`,
          { cause: err },
        );
      }
      return err;
  }
}
