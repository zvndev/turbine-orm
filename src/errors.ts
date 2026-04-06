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
} as const;

export type TurbineErrorCode = (typeof TurbineErrorCode)[keyof typeof TurbineErrorCode];

/** Base error class for all Turbine errors */
export class TurbineError extends Error {
  readonly code: TurbineErrorCode;

  constructor(code: TurbineErrorCode, message: string) {
    super(message);
    this.name = 'TurbineError';
    this.code = code;
  }
}

/** Thrown when a record is not found (findUniqueOrThrow, findFirstOrThrow) */
export class NotFoundError extends TurbineError {
  constructor(message = 'Record not found') {
    super(TurbineErrorCode.NOT_FOUND, message);
    this.name = 'NotFoundError';
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
