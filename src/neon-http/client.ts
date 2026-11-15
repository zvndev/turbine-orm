import { postgresDialect } from '../dialect.js';
import { ConnectionError, TimeoutError, ValidationError } from '../errors.js';
import { normalizeGlobalFilters } from '../global-filters-config.js';
import type { PgCompatPool, PgCompatQueryResult } from '../pg-types.js';
import { QueryInterface } from '../query/builder.js';
import type { DeferredQuery, QueryInterfaceOptions } from '../query/deferred.js';
import { TABLE_METHODS, type TableClient } from '../query/table-client.js';
import type { DefaultInputTypes, TableInputTypes } from '../query/types.js';
import type { SchemaMetadata } from '../schema.js';
import { assertStatelessSql, refuse } from './sql.js';

/** Transport facts, independent of the PostgreSQL SQL dialect. */
export const NEON_HTTP_CAPABILITIES = Object.freeze({
  transport: 'neon-http',
  statelessQueries: true,
  nativeAtomicBatch: true,
  interactiveTransactions: false,
  pinnedSessions: false,
  listen: false,
  sessionLocks: false,
  streams: false,
  pipelines: false,
} as const);

interface DriverQueryOptions {
  arrayMode: false;
  fullResults: true;
  fetchOptions?: { signal?: AbortSignal };
}
interface DriverBatchOptions extends DriverQueryOptions {
  isolationLevel?: 'ReadUncommitted' | 'ReadCommitted' | 'RepeatableRead' | 'Serializable';
  readOnly?: boolean;
  deferrable?: boolean;
}

/** Structural neon() contract. The supplied function and its parsers stay caller-owned. */
export interface NeonHttpSql {
  query(text: string, params?: unknown[], options?: DriverQueryOptions): PromiseLike<PgCompatQueryResult>;
  // Native lazy queries are opaque to this adapter and must go back to the same driver.
  // biome-ignore lint/suspicious/noExplicitAny: each Neon version has its own branded lazy-query type
  transaction(queries: any[], options?: DriverBatchOptions): PromiseLike<PgCompatQueryResult[]>;
}

export interface NeonHttpQueryOptions {
  signal?: AbortSignal;
  /** Aborts HTTP delivery; the database outcome may be unknown. No automatic retries. */
  timeoutMs?: number;
}
export interface NeonHttpBatchOptions extends NeonHttpQueryOptions {
  isolationLevel?: DriverBatchOptions['isolationLevel'];
  readOnly?: boolean;
  deferrable?: boolean;
}
export interface NeonHttpOptions
  extends Pick<
    QueryInterfaceOptions,
    | 'globalFilters'
    | 'defaultLimit'
    | 'utcTimestamps'
    | 'temporalInfinity'
    | 'jsonEncoding'
    | 'stableRelationOrder'
    | 'implicitPkOrdering'
    | 'sqlCache'
    | 'sqlCacheSize'
    | 'diagnostics'
    | 'logger'
  > {
  /** Invocation-wide cancellation, applied to table methods as well as explicit execution. */
  signal?: AbortSignal;
}

type BatchResults<Q extends readonly DeferredQuery<unknown>[]> = {
  -readonly [K in keyof Q]: Q[K] extends DeferredQuery<infer R> ? R : never;
};
const OPTION_KEYS = new Set([
  'globalFilters',
  'defaultLimit',
  'utcTimestamps',
  'temporalInfinity',
  'jsonEncoding',
  'stableRelationOrder',
  'implicitPkOrdering',
  'sqlCache',
  'sqlCacheSize',
  'diagnostics',
  'logger',
  'signal',
]);
const QUERY_KEYS = new Set(['signal', 'timeoutMs']);
const BATCH_KEYS = new Set([...QUERY_KEYS, 'isolationLevel', 'readOnly', 'deferrable']);
const dialect = {
  ...postgresDialect,
  rowLockModes: [],
  capabilities: { ...postgresDialect.capabilities, backendCancel: false },
};

function assertKeys(value: object, keys: Set<string>): void {
  for (const key of Object.keys(value))
    if (!keys.has(key)) throw new ValidationError(`Unknown Neon HTTP option "${key}".`);
}

function assertSignal(signal: AbortSignal | undefined): void {
  if (
    signal !== undefined &&
    (!signal ||
      typeof signal.aborted !== 'boolean' ||
      typeof signal.throwIfAborted !== 'function' ||
      typeof signal.addEventListener !== 'function' ||
      typeof signal.removeEventListener !== 'function')
  ) {
    throw new ValidationError('Neon HTTP signal must be an AbortSignal.');
  }
}

/** A bounded single-statement facade; no Pool/Client or global Neon configuration. */
export class TurbineNeonHttp {
  readonly capabilities = NEON_HTTP_CAPABILITIES;
  private readonly options: QueryInterfaceOptions;
  private readonly signal?: AbortSignal;
  private readonly closeSignal = new AbortController();
  private readonly tables = new Map<string, TableClient<object>>();
  private readonly issued = new WeakSet<DeferredQuery<unknown>>();
  private readonly active = new Set<Promise<unknown>>();
  private closed = false;

  constructor(
    private readonly sql: NeonHttpSql,
    private readonly schema: SchemaMetadata,
    options: NeonHttpOptions = {},
  ) {
    if (!sql || typeof sql.query !== 'function' || typeof sql.transaction !== 'function') {
      throw new ValidationError('Pass the query function returned by neon(), with query() and transaction().');
    }
    if (!schema?.tables || typeof schema.tables !== 'object')
      throw new ValidationError('Neon HTTP requires schema metadata.');
    assertKeys(options, OPTION_KEYS);
    assertSignal(options.signal);
    this.signal = options.signal;
    this.options = {
      ...options,
      dialect,
      preparedStatements: false,
      globalFilters: normalizeGlobalFilters(options.globalFilters, schema, {
        QueryInterface,
        dialect,
        utcTimestamps: options.utcTimestamps,
      }),
    };
  }

  table<
    T extends object = Record<string, unknown>,
    // biome-ignore lint/complexity/noBannedTypes: empty relation map preserves existing TableClient generic defaults
    R extends object = {},
    M extends TableInputTypes = DefaultInputTypes<T>,
  >(name: string): TableClient<T, R, M> {
    this.assertOpen();
    let table = this.tables.get(name);
    if (!table) {
      const qi = new QueryInterface({} as PgCompatPool, name, this.schema, [], this.options);
      const methods: Record<string, unknown> = Object.create(null);
      for (const method of Object.keys(TABLE_METHODS) as (keyof typeof TABLE_METHODS)[]) {
        if (method === 'findManyStream' || method === 'findManyStreamBatches' || method === 'explain') {
          methods[method] = () => refuse(method);
        } else if (method === 'cacheStats') {
          methods[method] = () => {
            this.assertOpen();
            return qi.cacheStats();
          };
        } else if (TABLE_METHODS[method] === 'deferred') {
          methods[method] = (args: unknown) => this.compile(qi, method, args);
        } else {
          const build = `build${method[0]!.toUpperCase()}${method.slice(1)}`;
          methods[method] = async (args?: { timeout?: number }) => {
            const query = this.compile(qi, build, args);
            return this.execute(query, { timeoutMs: args?.timeout });
          };
        }
      }
      table = Object.freeze(methods) as unknown as TableClient<object>;
      this.tables.set(name, table);
    }
    return table as TableClient<T, R, M>;
  }

  private compile(qi: QueryInterface<object>, method: string, args: unknown): DeferredQuery<unknown> {
    this.assertOpen();
    if (args && typeof args === 'object') {
      const input = args as { relationLoadStrategy?: string; lock?: unknown };
      if (input.lock !== undefined) refuse('Row locks');
      if (
        input.relationLoadStrategy !== undefined &&
        input.relationLoadStrategy !== 'join' &&
        input.relationLoadStrategy !== 'flatten'
      ) {
        refuse('Multi-request relation loading');
      }
    }
    const builder = (qi as unknown as Record<string, (args: unknown) => DeferredQuery<unknown>>)[method]!;
    const built = builder.call(qi, args);
    if (built.reselect || built.rowLock) refuse('Multi-statement writes or row locks');
    assertStatelessSql(built.sql);
    const query = Object.freeze({ ...built, params: Object.freeze([...built.params]) as unknown as unknown[] });
    this.issued.add(query);
    return query;
  }

  private assertIssued(query: DeferredQuery<unknown>): void {
    if (!query || !this.issued.has(query)) {
      throw new ValidationError('Neon HTTP execution requires a build* query from this client.');
    }
  }

  execute<T>(query: DeferredQuery<T>, options: NeonHttpQueryOptions = {}): Promise<T> {
    this.assertOpen();
    this.assertIssued(query);
    assertKeys(options, QUERY_KEYS);
    return this.run(options, async (signal) => {
      const result = await this.sql.query(query.sql, [...query.params], {
        arrayMode: false,
        fullResults: true,
        fetchOptions: { signal },
      });
      return query.transform(result);
    });
  }

  /** Explicit escape hatch: one stateless SQL statement; values remain positional parameters. */
  rawUnsafe<T extends object = Record<string, unknown>>(
    text: string,
    params: unknown[] = [],
    options: NeonHttpQueryOptions = {},
  ): Promise<T[]> {
    this.assertOpen();
    assertStatelessSql(text);
    assertKeys(options, QUERY_KEYS);
    return this.run(options, async (signal) => {
      const result = await this.sql.query(text, [...params], {
        arrayMode: false,
        fullResults: true,
        fetchOptions: { signal },
      });
      return result.rows as T[];
    });
  }

  batch<const Q extends readonly DeferredQuery<unknown>[]>(
    queries: Q,
    options: NeonHttpBatchOptions = {},
  ): Promise<BatchResults<Q>> {
    this.assertOpen();
    if (!Array.isArray(queries)) refuse('Interactive transaction callback');
    const admitted = [...queries];
    assertKeys(options, BATCH_KEYS);
    for (const query of admitted) this.assertIssued(query);
    if (
      options.isolationLevel !== undefined &&
      !['ReadUncommitted', 'ReadCommitted', 'RepeatableRead', 'Serializable'].includes(options.isolationLevel)
    ) {
      throw new ValidationError('Invalid Neon HTTP isolationLevel.');
    }
    for (const key of ['readOnly', 'deferrable'] as const) {
      if (options[key] !== undefined && typeof options[key] !== 'boolean')
        throw new ValidationError(`Neon HTTP ${key} must be boolean.`);
    }
    return this.run(options, async (signal) => {
      if (admitted.length === 0) return [] as BatchResults<Q>;
      // query() returns native lazy handles. Do not await them individually.
      const native = admitted.map((query) =>
        this.sql.query(query.sql, [...query.params], { arrayMode: false, fullResults: true }),
      );
      const results = await this.sql.transaction(native, {
        arrayMode: false,
        fullResults: true,
        fetchOptions: { signal },
        isolationLevel: options.isolationLevel,
        readOnly: options.readOnly,
        deferrable: options.deferrable,
      });
      if (results.length !== admitted.length)
        throw new ValidationError('Neon HTTP batch returned an unexpected number of results.');
      return admitted.map((query, i) => query.transform(results[i]!)) as BatchResults<Q>;
    });
  }

  $transaction<const Q extends readonly DeferredQuery<unknown>[]>(
    queries: Q,
    options?: NeonHttpBatchOptions,
  ): Promise<BatchResults<Q>> {
    return this.batch(queries, options);
  }
  transaction(..._args: unknown[]): never {
    return refuse('Interactive transaction callback');
  }
  pipeline(..._args: unknown[]): never {
    return refuse('Pipeline');
  }
  $listen(..._args: unknown[]): never {
    return refuse('LISTEN');
  }
  $notify(..._args: unknown[]): never {
    return refuse('Notifications');
  }
  connect(..._args: unknown[]): never {
    return refuse('Pinned connection');
  }

  /** Seal this facade and abort its requests. Never close or modify the caller's neon() function. */
  async disconnect(): Promise<void> {
    this.closed = true;
    this.closeSignal.abort(new ConnectionError('Neon HTTP client is disconnected.'));
    await Promise.allSettled([...this.active]);
    this.tables.clear();
  }
  $disconnect(): Promise<void> {
    return this.disconnect();
  }

  private assertOpen(): void {
    if (this.closed) throw new ConnectionError('Neon HTTP client is disconnected.');
    this.signal?.throwIfAborted();
  }

  private run<T>(options: NeonHttpQueryOptions, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    assertSignal(options.signal);
    const timeout = options.timeoutMs;
    if (timeout !== undefined && (!Number.isSafeInteger(timeout) || timeout < 0))
      throw new ValidationError('Neon HTTP timeoutMs must be a nonnegative safe integer.');
    const controller = new AbortController();
    const cleanups: (() => void)[] = [];
    for (const signal of [this.closeSignal.signal, this.signal, options.signal]) {
      if (!signal) continue;
      if (signal.aborted) {
        controller.abort(signal.reason);
        break;
      }
      const forward = () => controller.abort(signal.reason);
      signal.addEventListener('abort', forward, { once: true });
      cleanups.push(() => signal.removeEventListener('abort', forward));
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (timeout)
      timer = setTimeout(
        () => controller.abort(new TimeoutError(timeout, 'Neon HTTP query', { outcome: 'unknown' })),
        timeout,
      );
    const pending = (async () => {
      try {
        controller.signal.throwIfAborted();
        return await new Promise<T>((resolve, reject) => {
          const abort = () => reject(controller.signal.reason);
          controller.signal.addEventListener('abort', abort, { once: true });
          cleanups.push(() => controller.signal.removeEventListener('abort', abort));
          work(controller.signal).then(resolve, (error: unknown) =>
            reject(controller.signal.aborted ? controller.signal.reason : error),
          );
        });
      } finally {
        if (timer) clearTimeout(timer);
        for (const cleanup of cleanups) cleanup();
      }
    })();
    this.active.add(pending);
    void pending.then(
      () => this.active.delete(pending),
      () => this.active.delete(pending),
    );
    return pending;
  }
}

export function turbineNeonHttp(sql: NeonHttpSql, schema: SchemaMetadata, options?: NeonHttpOptions): TurbineNeonHttp {
  return new TurbineNeonHttp(sql, schema, options);
}
