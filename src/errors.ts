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
 * Thrown when a record is not found (findUniqueOrThrow, findFirstOrThrow,
 * update/delete against a non-matching row, etc.)
 *
 * Supports two call styles for back-compat:
 *   - `new NotFoundError()` / `new NotFoundError('custom message')`
 *   - `new NotFoundError({ table, where, operation, cause, message })`
 *
 * When called with an options object and no explicit `message`, a Prisma-style
 * message is built automatically, e.g.:
 *   `[turbine] findUniqueOrThrow on "users" found no record matching where: {"id":1}`
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
        const wherePart = where !== undefined ? ` matching where: ${JSON.stringify(where)}` : '';
        message = `[turbine] ${operation} on "${table}" found no record${wherePart}`;
      } else if (table) {
        const wherePart = where !== undefined ? ` matching where ${JSON.stringify(where)}` : '';
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
    default:
      return err;
  }
}
