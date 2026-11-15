import {
  CheckConstraintError,
  ForeignKeyError,
  InvariantError,
  NotNullViolationError,
  TurbineError,
  UniqueConstraintError,
  ValidationError,
} from '../errors.js';
import type { PgCompatPool, PgCompatPoolClient, PgCompatQueryResult } from '../pg-types.js';
import { d1Param, d1StatementSql, unsupportedD1 } from './sql.js';
import type { D1BatchOptions, D1DatabaseBinding, D1Result, D1Statement } from './types.js';

function d1Error(error: unknown): unknown {
  if (error instanceof TurbineError) return error;
  const message = error instanceof Error ? error.message : String(error);
  // D1 wraps SQLite's message in D1_ERROR (including a nested cause).
  if (/UNIQUE constraint failed|PRIMARY KEY constraint failed/i.test(message)) {
    return new UniqueConstraintError({ cause: error });
  }
  if (/FOREIGN KEY constraint failed/i.test(message)) return new ForeignKeyError({ cause: error });
  if (/NOT NULL constraint failed/i.test(message)) return new NotNullViolationError({ cause: error });
  if (/CHECK constraint failed/i.test(message)) return new CheckConstraintError({ cause: error });
  return error;
}

/** D1 has no cursor, checked-out connection, session event emitter or close operation. */
export class D1Pool implements PgCompatPool {
  constructor(private readonly binding: D1DatabaseBinding) {
    if (!binding || typeof binding.prepare !== 'function' || typeof binding.batch !== 'function') {
      throw new ValidationError('turbineD1 requires a supplied Worker D1Database binding with prepare() and batch().');
    }
  }

  async connect(): Promise<PgCompatPoolClient> {
    return unsupportedD1('Interactive transactions, checked-out connections and native cursor streaming');
  }

  async end(): Promise<void> {
    // The Worker owns the binding. Nothing is closed or destroyed here.
  }

  async query<Row = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<PgCompatQueryResult<Row>> {
    const statement = this.validate({ sql, params });
    try {
      const result = await this.prepare(statement).all<Row>();
      return this.queryResult(result);
    } catch (error) {
      throw d1Error(error);
    }
  }

  private validate(item: D1Statement): { sql: string; params: unknown[] } {
    if (!item || typeof item !== 'object' || (item.params !== undefined && !Array.isArray(item.params))) {
      throw new ValidationError('D1 batch entries must contain sql and an optional params array.');
    }
    const params = (item.params ?? []).map(d1Param);
    return { sql: d1StatementSql(item.sql, params.length), params };
  }

  private prepare(item: { sql: string; params: unknown[] }) {
    const statement = this.binding.prepare(item.sql);
    return item.params.length > 0 ? statement.bind(...item.params) : statement;
  }

  queryResult<Row>(result: D1Result<Row>): PgCompatQueryResult<Row> {
    if (result?.success !== true || !Array.isArray(result.results)) {
      throw new InvariantError('d1-result', 'D1 returned an unsuccessful or malformed prepared-statement result.');
    }
    return { rows: result.results, rowCount: result.meta.changes || result.results.length };
  }

  async batch(items: readonly D1Statement[], options: D1BatchOptions = {}): Promise<D1Result[]> {
    if (!Array.isArray(items)) throw new ValidationError('D1 batch expects an array of statements.');
    if (options.signal?.aborted) throw options.signal.reason;
    const validated = [...items].map((item) => this.validate(item));
    const expected = validated.length;
    if (validated.length === 0) return [];
    const prepared = validated.map((item) => this.prepare(item));
    if (options.signal?.aborted) throw options.signal.reason;
    try {
      const results = await this.binding.batch<Record<string, unknown>>(prepared);
      if (results.length !== expected) {
        throw new InvariantError('d1-batch-order', 'D1 returned a different number of results than batch statements.');
      }
      for (const result of results) this.queryResult(result);
      return results;
    } catch (error) {
      throw d1Error(error);
    }
  }
}
