/** Optional better-sqlite3 binding. node:sqlite remains the default SQLite entry. */
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { createPortableSqliteDialect } from './d1/sqlite-dialect.js';
import { ConnectionError, UnsupportedFeatureError, ValidationError } from './errors.js';
import importOptionalPeer from './optional-peer-import.cjs';
import type { SchemaMetadata } from './schema.js';
import { scanPlaceholders } from './sql-placeholders.js';
import {
  createSqliteBindingClient,
  introspectSqliteDatabase,
  recordSqliteBulkInsert,
  type TurbineSqliteOptions,
} from './sqlite.js';

/** Structural peer types: consumers do not need @types/better-sqlite3. */
interface BetterStatement {
  readonly source: string;
  readonly reader: boolean;
  all(...params: unknown[]): Record<string, unknown>[];
  get(...params: unknown[]): Record<string, unknown> | undefined;
  run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  iterate(...params: unknown[]): IterableIterator<Record<string, unknown>>;
  columns(): {
    name: string;
    column: string | null;
    table: string | null;
    database: string | null;
    type: string | null;
  }[];
  safeIntegers(enabled?: boolean): unknown;
  raw(enabled?: boolean): unknown;
}
export interface BetterSqlite3Database {
  readonly open: boolean;
  readonly inTransaction: boolean;
  prepare(sql: string): BetterStatement;
  exec(sql: string): unknown;
  close(): unknown;
}
export type TurbineBetterSqlite3Options = TurbineSqliteOptions;

// The peer's Node 20 object-row path drops a result column named __proto__.
// Read arrays on that runtime and define own fields before shared decoding.
const arrayRows = Number(process.versions.node.split('.')[0]) < 22;

// The existing SQLite error translator consumes the real extended result code.
// Do not infer constraint kinds from user-controlled error text.
const codes: Readonly<Record<string, number>> = {
  SQLITE_ERROR: 1,
  SQLITE_BUSY: 5,
  SQLITE_LOCKED: 6,
  SQLITE_BUSY_RECOVERY: 261,
  SQLITE_BUSY_SNAPSHOT: 517,
  SQLITE_BUSY_TIMEOUT: 773,
  SQLITE_LOCKED_SHAREDCACHE: 262,
  SQLITE_LOCKED_VTAB: 518,
  SQLITE_CONSTRAINT_CHECK: 275,
  SQLITE_CONSTRAINT_FOREIGNKEY: 787,
  SQLITE_CONSTRAINT_NOTNULL: 1299,
  SQLITE_CONSTRAINT_PRIMARYKEY: 1555,
  SQLITE_CONSTRAINT_UNIQUE: 2067,
};
function nativeCall<T>(fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') {
      const code = codes[error.code];
      if (code !== undefined) Object.assign(error, { errcode: code });
    }
    throw error;
  }
}
interface BindingPlan {
  slots: Map<number, string>;
  last: number;
}

/** SQL-only analysis. Values and their accessors are read afresh on every call. */
function bindingPlan(sql: string): BindingPlan {
  // Canonicalize native names to equal-width positional tokens for the existing
  // lexer. Quotes, comments and identifier boundaries still determine which
  // matches are code; the SQL given to the native engine is never rewritten.
  const tokens = scanPlaceholders(
    sql.replace(/[:@$][\w$\u0080-￿]+/g, (name) => `$${'0'.repeat(name.length - 1)}`),
    'sqlite',
  );
  const names = new Map<string, number>();
  const slots = new Map<number, string>();
  let last = 0;
  for (const token of tokens) {
    if (token.kind === 'question') {
      const digits = /^\d+/.exec(sql.slice(token.end))?.[0];
      if (digits) {
        const index = Number(digits);
        if (!slots.has(index)) slots.set(index, digits);
        names.set(digits, index);
        last = Math.max(last, index);
      } else last++;
    } else {
      const full = sql.slice(token.start, token.end);
      if (!names.has(full)) {
        names.set(full, ++last);
        slots.set(last, full.slice(1));
      }
    }
  }
  return { slots, last };
}

/** Adapt named bindings, including SQLite's NULL defaults for omitted values. */
function binding(params: unknown[], { slots, last }: BindingPlan): unknown[] {
  // Numbered ?N can leave anonymous holes. Missing named and anonymous slots
  // retain SQLite's NULL value even when another parameter was supplied.
  if (params.length === 0) {
    const named = Object.fromEntries([...slots.values()].map((name) => [name, null]));
    const anonymous = Array.from({ length: last - slots.size }, () => null);
    return slots.size ? [named, ...anonymous] : anonymous;
  }
  const first = params[0];
  if (params.length !== 1 || !first || typeof first !== 'object' || ArrayBuffer.isView(first)) return params;
  const values = first as Record<string, unknown>;
  const keys = Object.keys(values);
  const allowed = new Set(slots.values());
  if (allowed.size !== slots.size)
    throw new ValidationError('Conflicting SQLite parameter prefixes prevent bare named binding.');
  for (const key of keys) {
    if (!allowed.has(key.startsWith(':') ? key.slice(1) : key))
      throw new ValidationError(`Unknown SQLite binding "${key}"; no corresponding parameter occurs in the statement.`);
  }
  if (keys.length === allowed.size && last === slots.size)
    return keys.some((key) => key.startsWith(':'))
      ? [Object.fromEntries(keys.map((key) => [key.startsWith(':') ? key.slice(1) : key, values[key]]))]
      : params;
  const named = Object.fromEntries([...slots.values()].map((name) => [name, null]));
  for (const key of keys)
    Object.defineProperty(named, key.startsWith(':') ? key.slice(1) : key, {
      enumerable: true,
      configurable: true,
      get: () => values[key],
    });
  return [named, ...Array.from({ length: last - slots.size }, () => null)];
}
/** Only the SQLite methods the shared pool/introspector use are adapted. No statement cache. */
function adapt(
  handle: BetterSqlite3Database,
  arrays?: WeakMap<object, Pick<StatementSync, 'all' | 'columns' | 'setReturnArrays'>>,
): DatabaseSync {
  // Retain only bounded SQL analysis, never a native statement, row or binding.
  const plans = new Map<string, BindingPlan>();
  let planBytes = 0;
  const planFor = (sql: string): BindingPlan => {
    const previous = sql.length <= 32768 ? plans.get(sql) : undefined;
    if (previous) return previous;
    const plan = bindingPlan(sql);
    const bytes = sql.length * 2;
    if (sql.length <= 32768 && plans.size < 128 && planBytes + bytes <= 131072) {
      plans.set(sql, plan);
      planBytes += bytes;
    }
    return plan;
  };
  const unsupported = (feature: string): never => {
    throw new UnsupportedFeatureError(
      feature,
      'better-sqlite3',
      'This binding adapts typed queries, transactions and iterators. Use the original native handle for peer-specific APIs; node:sqlite migration/session APIs are unavailable.',
    );
  };
  const db = {
    get isOpen() {
      return handle.open;
    },
    get isTransaction() {
      return handle.inTransaction;
    },
    createSession: () => unsupported('node:sqlite sessions'),
    applyChangeset: () => unsupported('node:sqlite changesets'),
    setAuthorizer: () => unsupported('node:sqlite authorizer'),
    close: () => {
      plans.clear();
      planBytes = 0;
      return handle.close();
    },
    exec: (sql: string) => nativeCall(() => handle.exec(sql)),
    prepare: (sql: string) => {
      const stmt = nativeCall(() => handle.prepare(sql));
      let plan: BindingPlan | undefined;
      const bind = (params: unknown[]) => {
        plan ??= planFor(sql);
        return binding(params, plan);
      };
      // Only unwrapped native peer methods opt into positional extraction.
      // Supplied compatible statements keep their own object-row behavior.
      const nativeArrays =
        arrays &&
        stmt.reader &&
        ['all', 'columns', 'raw', 'safeIntegers'].every((key) => {
          if (Object.hasOwn(stmt, key)) return false;
          const fn = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(stmt), key)?.value;
          return (
            typeof fn === 'function' &&
            Reflect.get(stmt, key) === fn &&
            Function.prototype.toString.call(fn) === `function ${key}() { [native code] }`
          );
        });
      const nativeColumns = nativeArrays ? stmt.columns : undefined;
      let positional = false;
      let columns: ReturnType<BetterStatement['columns']> | undefined;
      const materialize =
        arrayRows && stmt.reader
          ? (row: Record<string, unknown>): Record<string, unknown> => {
              columns ??= stmt.columns();
              return Object.fromEntries(columns.map((column, i) => [column.name, (row as unknown as unknown[])[i]]));
            }
          : undefined;
      if (materialize) nativeCall(() => stmt.raw(true));
      const adapted = {
        get sourceSQL() {
          return stmt.source;
        },
        all: (...params: unknown[]) =>
          nativeCall(() => {
            columns = undefined;
            const values = bind(params);
            if (stmt.reader) {
              const rows = stmt.all(...values);
              return materialize && !positional ? rows.map(materialize) : rows;
            }
            // node:sqlite permits all()/get() on rowless statements. This matters
            // for WITH writes and SQL whose quoted text contains RETURNING.
            stmt.run(...values);
            return [];
          }),
        get: (...params: unknown[]) =>
          nativeCall(() => {
            columns = undefined;
            const values = bind(params);
            if (stmt.reader) {
              const row = stmt.get(...values);
              return row && materialize && !positional ? materialize(row) : row;
            }
            stmt.run(...values);
            return undefined;
          }),
        run: (...params: unknown[]) => nativeCall(() => stmt.run(...bind(params))),
        iterate: (...params: unknown[]) => {
          columns = undefined;
          if (!stmt.reader)
            return (function* () {
              nativeCall(() => stmt.run(...bind(params)));
            })();
          const iterator = nativeCall(() => stmt.iterate(...bind(params)));
          return {
            next: () =>
              nativeCall(() => {
                const result = iterator.next();
                if (!result.done && materialize && !positional) result.value = materialize(result.value);
                return result;
              }),
            return: () => nativeCall(() => iterator.return!()),
            [Symbol.iterator]() {
              return this;
            },
          };
        },
        columns: () => nativeCall(() => (positional ? nativeColumns!.call(stmt) : stmt.columns())),
        setReadBigInts: (enabled: boolean) => {
          stmt.safeIntegers(enabled);
        },
        setAllowBareNamedParameters: () => {},
      } as unknown as StatementSync;
      if (nativeArrays) {
        adapted.setReturnArrays = (enabled: boolean) => {
          nativeCall(() => stmt.raw(arrayRows || enabled));
          positional = enabled;
        };
        arrays.set(adapted, { all: adapted.all, columns: adapted.columns, setReturnArrays: adapted.setReturnArrays });
      }
      return adapted;
    },
  };
  // Deliberately narrow bridge to the existing pool, not a claim that the peer
  // implements unused node:sqlite functions, sessions or backup APIs.
  return db as unknown as DatabaseSync;
}

/** SQLite wire decoding depends on this binding, including on Node without node:sqlite. */
export const betterSqlite3Dialect = {
  ...createPortableSqliteDialect({
    declaredTypes: () => true,
    decodeBlob: (hex) => Uint8Array.from(Buffer.from(hex, 'hex')),
    // Record generated bulk inserts so an owned handle may bind them
    // positionally; the shared pool decides per handle. `false`: this
    // dialect never bound qualified `:pN` keys, so a handle that cannot
    // bind positionally keeps the plain `{ p1 }` binding it has always
    // received (qualified keys make the adapter above copy the object).
    recordBulkInsert: (params, sql) => recordSqliteBulkInsert(params, sql, false),
  }),
};

/** Introspect a supplied handle without closing or changing it. */
export function introspectBetterSqlite3Database(
  handle: BetterSqlite3Database,
  options: Parameters<typeof introspectSqliteDatabase>[1] = {},
) {
  return introspectSqliteDatabase(adapt(handle), options);
}

/**
 * Create a typed client with the optional better-sqlite3 peer. Paths are client
 * owned; supplied handles remain caller owned. The same pool enforces FIFO
 * transaction/iterator ownership, rollback on release and incremental streaming.
 * Synchronous SQLite work can observe cancellation only between pulls.
 */
export async function turbineBetterSqlite3(
  target: string | BetterSqlite3Database,
  schema: SchemaMetadata,
  options: TurbineBetterSqlite3Options = {},
) {
  const owns = typeof target === 'string';
  let handle: BetterSqlite3Database;
  if (owns) {
    let Constructor: new (path: string) => BetterSqlite3Database;
    try {
      const peer = (await importOptionalPeer('better-sqlite3')) as { default: typeof Constructor };
      Constructor = peer.default;
    } catch (cause) {
      throw new ConnectionError(
        'The optional better-sqlite3 binding requires better-sqlite3. Install the peer in this application.',
        { cause },
      );
    }
    try {
      handle = new Constructor(target);
    } catch (cause) {
      throw new ConnectionError(`Failed to open better-sqlite3 database "${target}".`, { cause });
    }
    try {
      handle.exec(`PRAGMA busy_timeout = ${Number(options.busyTimeoutMs ?? 5000)}`);
      if (options.foreignKeys !== false) handle.exec('PRAGMA foreign_keys = ON');
      // Match node:sqlite's durable default for handles this factory owns.
      handle.exec('PRAGMA synchronous = FULL');
      if (target !== ':memory:' && options.wal !== false) {
        try {
          handle.exec('PRAGMA journal_mode = WAL');
        } catch {
          /* Same filesystem fallback as node:sqlite. */
        }
      }
    } catch (error) {
      handle.close();
      throw error;
    }
  } else handle = target;
  const arrays = owns ? new WeakMap<object, Pick<StatementSync, 'all' | 'columns' | 'setReturnArrays'>>() : undefined;
  return createSqliteBindingClient(adapt(handle, arrays), schema, options, owns, betterSqlite3Dialect, arrays);
}
