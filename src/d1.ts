/** Unreleased Worker D1 binding. Native batches are distinct from SQL sessions. */
import type { TurbineClient } from './client.js';
import { type CoreClient, turbineCore } from './core.js';
import { D1Pool } from './d1/pool.js';
import { unsupportedD1 } from './d1/sql.js';
import { createPortableSqliteDialect } from './d1/sqlite-dialect.js';
import type { D1BatchOptions, D1DatabaseBinding, D1Result, D1Statement } from './d1/types.js';
import type { Dialect } from './dialect.js';
import { ConnectionError, ValidationError } from './errors.js';
import { tableAccessorName } from './global-filters-config.js';
import type { QueryInterface } from './query/builder.js';
import type { DeferredQuery, MiddlewareFn, QueryInterfaceOptions } from './query/deferred.js';
import type { SchemaMetadata } from './schema.js';
import type { TypedSqlQuery } from './typed-sql.js';

export type { D1BatchOptions, D1DatabaseBinding, D1PreparedStatement, D1Result, D1Statement } from './d1/types.js';

const sqliteDialect = createPortableSqliteDialect();

/** SQLite SQL generation with D1's binding, value and session limits. */
export const d1Dialect: Dialect = {
  ...sqliteDialect,
  name: 'd1',
  capabilities: Object.freeze({ ...sqliteDialect.capabilities, maxBindParameters: 100, chunkBindParameters: 100 }),
  paramPlaceholder: (index) => `?${index}`,
  jsonWireRule(type) {
    return sqliteDialect.jsonWireRule?.(/BYTEA/i.test(type) ? 'BLOB' : type);
  },
  decodeColumnValue(type) {
    if (/BOOL/i.test(type)) return (value) => (value === 1 || value === 0 ? value === 1 : value);
    if (/^JSONB?$/i.test(type)) {
      return (value) => {
        if (typeof value !== 'string') return value;
        try {
          return JSON.parse(value);
        } catch {
          return value;
        }
      };
    }
    if (/BLOB|BYTEA/i.test(type)) return (value) => (Array.isArray(value) ? Uint8Array.from(value) : value);
    return undefined;
  },
  beginStatement: () => unsupportedD1('Interactive transactions'),
  commitStatement: () => unsupportedD1('Interactive transactions'),
  rollbackStatement: () => unsupportedD1('Interactive transactions'),
  savepointStatement: () => unsupportedD1('Savepoints'),
  releaseSavepointStatement: () => unsupportedD1('Savepoints'),
  rollbackToSavepointStatement: () => unsupportedD1('Savepoints'),
  buildMigrationTrackingTable: () => unsupportedD1('Generic SQLite migrations or rebuilds'),
  introspector: { introspect: async () => unsupportedD1('Native Node SQLite introspection') },
  openStream() {
    return unsupportedD1('Native cursor streaming');
  },
};

export type TurbineD1Options = Omit<
  QueryInterfaceOptions,
  | 'dialect'
  | 'preparedStatements'
  | 'planCacheMode'
  | '_txScoped'
  | '_onQuery'
  | '_sqlCommenter'
  | 'queryInterfaceFactory'
>;

/** Generated subclasses contribute accessor typings only. Existing client methods are not promised. */
export type D1Client<TClient extends TurbineClient = TurbineClient> = Omit<TClient, keyof TurbineClient> & D1ClientBase;

type BatchValues<T extends readonly DeferredQuery<unknown>[]> = {
  -readonly [K in keyof T]: T[K] extends DeferredQuery<infer Value> ? Value : never;
};

/** Caller-owned binding; disconnect seals this facade without closing the binding. */
export class D1ClientBase {
  private closed = false;
  private readonly queries = new WeakSet<object>();
  private readonly tables = new Map<string, QueryInterface<object>>();
  private readonly core: CoreClient;
  private readonly pendingBatches = new Set<Promise<unknown>>();
  private closing?: Promise<void>;
  private readonly pool: D1Pool;

  constructor(
    binding: D1DatabaseBinding,
    readonly schema: SchemaMetadata,
    options: TurbineD1Options = {},
  ) {
    this.pool = new D1Pool(binding);
    if (!schema || typeof schema !== 'object' || !schema.tables) {
      throw new ValidationError('turbineD1 requires SchemaMetadata; use schemaDefToMetadata for a schema definition.');
    }
    for (const key of [
      'dialect',
      'preparedStatements',
      'planCacheMode',
      '_txScoped',
      'queryInterfaceFactory',
      'ownership',
      'getTypeParser',
    ]) {
      if (key in options) unsupportedD1(`D1 option ${key}`);
    }
    this.core = turbineCore(this.pool, schema, {
      ...options,
      dialect: d1Dialect,
      preparedStatements: false,
      ownership: 'caller',
    });
    for (const table of Object.keys(schema.tables)) {
      const accessor = tableAccessorName(table);
      if (accessor in this) throw new ValidationError(`D1 table accessor ${accessor} conflicts with a client member.`);
      Object.defineProperty(this, accessor, { enumerable: true, get: () => this.table(table) });
    }
  }

  private assertOpen(): void {
    if (this.closed)
      throw new ConnectionError('This D1 facade is disconnected. The supplied Worker binding remains caller-owned.');
  }

  table<T extends object = Record<string, unknown>>(name: string): QueryInterface<T> {
    this.assertOpen();
    let table = this.tables.get(name);
    if (!table) {
      const target = this.core.table<object>(name);
      const methods = new Map<PropertyKey, unknown>();
      table = new Proxy(target, {
        get: (object, key) => {
          const value: unknown = Reflect.get(object, key, object);
          if (typeof value !== 'function') return value;
          if (!methods.has(key)) {
            methods.set(key, (...args: unknown[]) => {
              this.assertOpen();
              if (key === 'findManyStream' || key === 'findManyStreamBatches') unsupportedD1('Native cursor streaming');
              // Bulk conflict reconciliation may need an interactive rollback after parsing.
              if (
                (key === 'createMany' || key === 'buildCreateMany') &&
                (args[0] as { onConflict?: unknown })?.onConflict !== undefined
              ) {
                unsupportedD1('createMany onConflict reconciliation');
              }
              const result = Reflect.apply(value, object, args) as unknown;
              if (typeof key === 'string' && key.startsWith('build') && result && typeof result === 'object') {
                this.queries.add(result);
              }
              return result;
            });
          }
          return methods.get(key);
        },
      });
      this.tables.set(name, table);
    }
    return table as QueryInterface<T>;
  }

  $use(middleware: MiddlewareFn): void {
    this.assertOpen();
    if (typeof middleware !== 'function') throw new ValidationError('D1 middleware must be a function.');
    this.core.$use(middleware);
  }

  async rawUnsafe<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    ...params: unknown[]
  ): Promise<Row[]> {
    this.assertOpen();
    return this.core.rawUnsafe<Row>(sql, ...params);
  }

  async raw<Row extends Record<string, unknown> = Record<string, unknown>>(
    strings: TemplateStringsArray,
    ...params: unknown[]
  ): Promise<Row[]> {
    this.assertOpen();
    return this.core.raw<Row>(strings, ...params);
  }

  sql<Row extends Record<string, unknown> = Record<string, unknown>>(
    strings: TemplateStringsArray,
    ...params: unknown[]
  ): TypedSqlQuery<Row> {
    this.assertOpen();
    return this.core.sql<Row>(strings, ...params);
  }

  private trackBatch<T>(operation: Promise<T>): Promise<T> {
    this.pendingBatches.add(operation);
    void operation.then(
      () => this.pendingBatches.delete(operation),
      () => this.pendingBatches.delete(operation),
    );
    return operation;
  }

  /** One native D1 batch. SQL errors roll back; client-side transform errors occur after commit. */
  async $batch<const T extends readonly DeferredQuery<unknown>[]>(
    queries: T,
    options?: D1BatchOptions,
  ): Promise<BatchValues<T>> {
    this.assertOpen();
    if (!Array.isArray(queries)) throw new ValidationError('D1 $batch expects deferred queries from this facade.');
    const admitted = [...queries];
    const transforms: DeferredQuery<unknown>['transform'][] = [];
    for (const query of admitted) {
      const transform =
        query && this.queries.has(query) && !query.reselect && !query.rowLock ? query.transform : undefined;
      if (typeof transform !== 'function') {
        throw new ValidationError('D1 $batch accepts only single-statement deferred queries built by this facade.');
      }
      transforms.push(transform);
    }
    const results = await this.trackBatch(this.pool.batch(admitted, options));
    return transforms.map((transform, index) =>
      transform.call(admitted[index], this.pool.queryResult(results[index]!)),
    ) as BatchValues<T>;
  }

  /** Raw native results retain metadata and statement order. Values are still parameterized. */
  async $batchRaw(statements: readonly D1Statement[], options?: D1BatchOptions): Promise<D1Result[]> {
    this.assertOpen();
    return this.trackBatch(this.pool.batch(statements, options));
  }

  async $transaction(..._args: unknown[]): Promise<never> {
    return unsupportedD1('$transaction callbacks or arrays');
  }
  async transaction(..._args: unknown[]): Promise<never> {
    return unsupportedD1('Interactive transaction callbacks');
  }
  async pipeline(..._args: unknown[]): Promise<never> {
    return unsupportedD1('PostgreSQL pipeline');
  }
  async $withSession(..._args: unknown[]): Promise<never> {
    return unsupportedD1('SQL session context');
  }
  async $connection(..._args: unknown[]): Promise<never> {
    return unsupportedD1('Pinned connections');
  }
  async $listen(..._args: unknown[]): Promise<never> {
    return unsupportedD1('LISTEN');
  }
  async $notify(..._args: unknown[]): Promise<never> {
    return unsupportedD1('NOTIFY');
  }

  /** Does not acquire a connection. The first actual query tests the supplied binding. */
  async connect(): Promise<void> {
    this.assertOpen();
  }
  disconnect(): Promise<void> {
    if (!this.closing) {
      this.closed = true;
      this.closing = Promise.allSettled([this.core.disconnect(), ...this.pendingBatches]).then(([core]) => {
        if (core?.status === 'rejected') throw core.reason;
      });
    }
    return this.closing;
  }
  async end(): Promise<void> {
    return this.disconnect();
  }
}

/** Reuses the existing SQL query builder and generated accessor types. */
export function turbineD1<TClient extends TurbineClient = TurbineClient>(
  binding: D1DatabaseBinding,
  schema: SchemaMetadata,
  options?: TurbineD1Options,
): D1Client<TClient> {
  return new D1ClientBase(binding, schema, options) as D1Client<TClient>;
}
