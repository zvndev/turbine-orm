/**
 * Supplied-transport query client. This entry resolves no database driver.
 * Transactions, streaming cursors and realtime require a transport-specific
 * entry with an explicit session contract.
 */

import { assertDialectCapabilities, type Dialect, postgresDialect } from './dialect.js';
import { UnsupportedFeatureError, ValidationError, wrapPgError } from './errors.js';
import { normalizeGlobalFilters, tableAccessorName } from './global-filters-config.js';
import { hasRelationFields } from './nested-write.js';
import type { PgCompatPool, PgCompatQueryResult } from './pg-types.js';
import { QueryInterface } from './query/builder.js';
import type { MiddlewareFn, QueryInterfaceOptions } from './query/deferred.js';
import { jsonWireCoercionOid } from './query-utils.js';
import type { SchemaMetadata } from './schema.js';
import { findTransactionControl } from './transaction-control.js';
import { buildTypedSql, TypedSqlQuery, utcDateParams } from './typed-sql.js';

export type { Dialect } from './dialect.js';
export type { PgCompatPool, PgCompatPoolClient, PgCompatQueryResult } from './pg-types.js';
export type { QueryInterface, QueryInterfaceOptions, SchemaMetadata };

export type CoreOptions = Omit<
  QueryInterfaceOptions,
  '_txScoped' | '_onQuery' | '_sqlCommenter' | 'queryInterfaceFactory'
> & {
  /** Caller retains the pool by default. Client ownership closes it once. */
  ownership?: 'caller' | 'client';
  /** Decode PostgreSQL relation wire values using this transport's parser. */
  getTypeParser?: (oid: number, format: 'text') => (value: string) => unknown;
};

/** Ordinary SQL execution on an explicitly supplied transport. */
export class CoreClient {
  private readonly accessors = new Map<string, QueryInterface<object>>();
  private readonly middlewares: MiddlewareFn[] = [];
  private readonly options: QueryInterfaceOptions;
  private readonly dialect: Dialect;
  private readonly queryPool: PgCompatPool;
  private readonly pending = new Set<Promise<unknown>>();
  private readonly ownsPool: boolean;
  private closed = false;
  private closing?: Promise<void>;

  constructor(
    readonly pool: PgCompatPool,
    readonly schema: SchemaMetadata,
    options: CoreOptions = {},
  ) {
    if (
      !pool ||
      typeof pool.query !== 'function' ||
      typeof pool.connect !== 'function' ||
      typeof pool.end !== 'function'
    ) {
      throw new ValidationError('turbineCore requires a supplied pool with query(), connect() and end().');
    }
    if (!schema || typeof schema !== 'object' || !schema.tables || !schema.enums) {
      throw new ValidationError('turbineCore requires schema metadata with tables and enums.');
    }
    if (options.ownership !== undefined && options.ownership !== 'caller' && options.ownership !== 'client') {
      throw new ValidationError('ownership must be caller or client.');
    }
    this.ownsPool = options.ownership === 'client';
    const dialect = options.dialect ?? postgresDialect;
    assertDialectCapabilities(dialect);
    // A pg-free client never borrows an unrelated module copy's native parser.
    // Other dialects retain their adapter-owned wire rules verbatim.
    this.dialect = {
      ...dialect,
      capabilities: { ...dialect.capabilities, backendCancel: false },
      rowLockModes: [],
      supportsListenNotify: false,
      supportsRLS: false,
      supportsAdvisoryLock: false,
      supportsPlanCacheMode: false,
      ...(dialect === postgresDialect
        ? {
            jsonWireRule: (type: string) => {
              const oid = jsonWireCoercionOid(type);
              if (oid === undefined) return undefined;
              return {
                sql: (ref: string) => `${ref}::text`,
                decode: (value: unknown) => {
                  if (typeof value !== 'string') return value;
                  if (!options.getTypeParser)
                    throw this.unsupported('PostgreSQL relation wire decoding; supply getTypeParser');
                  return options.getTypeParser(oid, 'text')(value);
                },
              };
            },
          }
        : {}),
    };
    const globalFilters = normalizeGlobalFilters(options.globalFilters, schema, {
      QueryInterface,
      dialect: this.dialect,
      utcTimestamps: options.utcTimestamps,
    });
    this.options = { ...options, dialect: this.dialect, globalFilters, preparedStatements: false };
    // Internal options are never accepted from untyped callers either.
    delete this.options._txScoped;
    delete this.options.queryInterfaceFactory;
    delete this.options._onQuery;
    delete this.options._sqlCommenter;
    this.queryPool = {
      query: <R>(text: string, values?: unknown[]) => this.execute<R>(text, values),
      connect: async () => {
        throw this.unsupported('Connection checkout / implicit transactions');
      },
      end: () => this.disconnect(),
    };
    for (const name of Object.keys(schema.tables)) {
      const accessor = tableAccessorName(name);
      if (!(accessor in this)) Object.defineProperty(this, accessor, { enumerable: true, get: () => this.table(name) });
    }
  }

  private unsupported(feature: string): UnsupportedFeatureError {
    return new UnsupportedFeatureError(
      feature,
      this.dialect?.name ?? 'supplied transport',
      'Use a transport-specific entry with the required session contract.',
    );
  }

  private assertOpen(): void {
    if (this.closed) throw new ValidationError('This supplied-transport client has been disconnected.');
  }

  private execute<R>(text: string, values: unknown[] = []): Promise<PgCompatQueryResult<R>> {
    this.assertOpen();
    const control = findTransactionControl(text, this.dialect.capabilities.statementSyntax ?? 'postgresql')[0];
    if (control) throw this.unsupported(`${control.label} transaction control`);
    const operation = Promise.resolve()
      .then(() => this.pool.query<R>(text, values))
      .catch((error: unknown) => {
        throw wrapPgError(error);
      });
    this.pending.add(operation);
    void operation.then(
      () => this.pending.delete(operation),
      () => this.pending.delete(operation),
    );
    return operation;
  }

  table<T extends object = Record<string, unknown>>(name: string): QueryInterface<T> {
    this.assertOpen();
    let accessor = this.accessors.get(name);
    if (!accessor) {
      const qi = new QueryInterface<object>(this.queryPool, name, this.schema, this.middlewares, this.options);
      const client = this;
      accessor = new Proxy(qi, {
        get(target, key, receiver) {
          const member = Reflect.get(target, key, receiver);
          if (typeof member !== 'function') return member;
          if (key === 'findManyStream' || key === 'findManyStreamBatches') {
            // biome-ignore lint/correctness/useYield: refusal is deferred until iterator consumption.
            return async function* () {
              client.assertOpen();
              throw client.unsupported('Streaming cursors');
            };
          }
          return (...args: unknown[]) => {
            client.assertOpen();
            const input = args[0] as
              | { data?: Record<string, unknown>; create?: Record<string, unknown>; update?: Record<string, unknown> }
              | undefined;
            const meta = client.schema.tables[name];
            if (meta && (key === 'create' || key === 'update' || key === 'upsert')) {
              if (
                [input?.data, input?.create, input?.update].some((data) => data && hasRelationFields(data, meta)) ||
                (key === 'upsert' && target.upsertNeedsLookup(input as never))
              ) {
                throw client.unsupported('Implicit transactions for nested writes / lookup-first upserts');
              }
            }
            return Reflect.apply(member, target, args);
          };
        },
      });
      this.accessors.set(name, accessor);
    }
    return accessor as unknown as QueryInterface<T>;
  }

  $use(middleware: MiddlewareFn): void {
    this.assertOpen();
    this.middlewares.push(middleware);
  }

  sql<T extends Record<string, unknown> = Record<string, unknown>>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): TypedSqlQuery<T> {
    this.assertOpen();
    const { sql, params } = buildTypedSql(strings, values, this.dialect);
    return new TypedSqlQuery<T>(this.queryPool, sql, this.rawParams(params), false);
  }

  async raw<T extends Record<string, unknown> = Record<string, unknown>>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<T[]> {
    return await this.sql<T>(strings, ...values);
  }

  async rawUnsafe<T extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    ...values: unknown[]
  ): Promise<T[]> {
    return (await this.rawQuery<T>(text, values)).rows;
  }

  async rawQuery<T extends object = Record<string, unknown>>(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<{ rows: T[]; rowCount: number | null }> {
    if (typeof text !== 'string' || !text.trim()) throw new ValidationError('rawQuery requires nonempty SQL text.');
    const result = await this.execute<T>(text, this.rawParams([...values]));
    return { rows: result.rows, rowCount: result.rowCount };
  }

  private rawParams(values: unknown[]): unknown[] {
    return this.dialect.capabilities.utcTimestampRewrite && this.options.utcTimestamps !== false
      ? utcDateParams(values, 'rawQuery')
      : values;
  }

  $transaction(..._args: unknown[]): never {
    throw this.unsupported('Interactive / callback / deferred transactions');
  }
  transaction(..._args: unknown[]): never {
    throw this.unsupported('Interactive transactions');
  }
  pipeline(..._args: unknown[]): never {
    throw this.unsupported('Extended-query pipelines');
  }
  $listen(..._args: unknown[]): never {
    throw this.unsupported('LISTEN realtime');
  }
  $notify(..._args: unknown[]): never {
    throw this.unsupported('NOTIFY realtime');
  }
  $withSession(..._args: unknown[]): never {
    throw this.unsupported('Pinned session context');
  }
  $connection(..._args: unknown[]): never {
    throw this.unsupported('Pinned driver connections');
  }

  /** Seal immediately, drain admitted work, and close only a client-owned pool. */
  disconnect(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.closing = Promise.allSettled([...this.pending]).then(async () => {
      if (this.ownsPool) await this.pool.end();
    });
    return this.closing;
  }

  end(): Promise<void> {
    return this.disconnect();
  }
}

export function turbineCore(pool: PgCompatPool, schema: SchemaMetadata, options?: CoreOptions): CoreClient {
  return new CoreClient(pool, schema, options);
}
