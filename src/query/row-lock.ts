/**
 * turbine-orm: the `lock` read option (`SELECT ... FOR UPDATE OF "t"`).
 *
 * {@link resolveRowLock} is the one place a `lock` value is validated and
 * rendered. The SQL build and the cache key both read its result, so the two
 * cannot disagree about which lock a statement carries.
 *
 * The clause always names the queried table (`OF "t"`). That keeps the lock on
 * the returned rows of that table and nothing else, on every relation
 * strategy: correlated `with` subqueries are never locked anyway, and without
 * `OF` PostgreSQL refuses the `flatten` and lateral-pick plans (their outer
 * joins would put a table on the nullable side of the lock).
 */

import type { Dialect } from '../dialect.js';
import { UnsupportedFeatureError, ValidationError } from '../errors.js';
import { tableAccessorName } from '../global-filters-config.js';
import type { RowLockMode } from './types.js';
import { suggestKey } from './utils.js';

const MODES: readonly RowLockMode[] = ['update', 'noKeyUpdate', 'share', 'keyShare'];

const MODE_SQL: Readonly<Record<RowLockMode, string>> = {
  update: 'UPDATE',
  noKeyUpdate: 'NO KEY UPDATE',
  share: 'SHARE',
  keyShare: 'KEY SHARE',
};

/** One letter per mode for the SQL-template cache key. */
const MODE_FP: Readonly<Record<RowLockMode, string>> = { update: 'u', noKeyUpdate: 'n', share: 's', keyShare: 'k' };

const LOCK_KEYS = ['mode', 'noWait', 'skipLocked'];

/** Why an engine refuses a lock mode, keyed by dialect name. */
const ENGINE_HINT: Readonly<Record<string, string>> = {
  sqlite:
    'SQLite has no row locks: a write transaction locks the whole database. Remove `lock`; inside ' +
    '$transaction on SQLite, writes are already serialized.',
  mysql: "MySQL supports lock: 'update' and lock: 'share' only. Use 'update' (stronger) or 'share' (weaker).",
  mssql:
    "Row locks are not available on SQL Server in this release. Use $transaction({ isolationLevel: 'RepeatableRead' }) " +
    'or a raw query with table hints.',
  powdb: 'PowDB has no row locks: a transaction holds the single writer gate.',
};

/** A validated `lock`: the clause to append after pagination, and its cache-key segment. */
export interface ResolvedRowLock {
  /** e.g. ` FOR UPDATE OF "jobs" SKIP LOCKED` */
  readonly sql: string;
  /** e.g. `u.sl`; one value per distinct clause, never empty. */
  readonly fp: string;
}

/**
 * Validate `lock` for a read on `table` and render its clause.
 *
 * `undefined` means no lock. Anything that is not a mode string or a
 * `{ mode, noWait?, skipLocked? }` object is `ValidationError` (E003), and so
 * is asking for both wait policies at once. A mode the dialect does not list in
 * {@link Dialect.rowLockModes} is `UnsupportedFeatureError` (E017).
 */
export function resolveRowLock(lock: unknown, dialect: Dialect, table: string): ResolvedRowLock | undefined {
  if (lock === undefined) return undefined;
  let mode: unknown;
  let noWait: unknown;
  let skipLocked: unknown;
  if (typeof lock === 'string') {
    mode = lock;
  } else if (typeof lock === 'object' && lock !== null && !Array.isArray(lock)) {
    for (const key of Object.keys(lock)) {
      if (!LOCK_KEYS.includes(key)) {
        const hint = suggestKey(key, LOCK_KEYS);
        throw new ValidationError(
          `lock on "${table}": unknown key "${key}".${hint ? ` Did you mean "${hint}"?` : ''} ` +
            'A lock is a mode, or { mode, noWait: true } or { mode, skipLocked: true }.',
        );
      }
    }
    ({ mode, noWait, skipLocked } = lock as { mode?: unknown; noWait?: unknown; skipLocked?: unknown });
    assertFlag(noWait, 'noWait', table);
    assertFlag(skipLocked, 'skipLocked', table);
    if (noWait === true && skipLocked === true) {
      throw new ValidationError(
        `lock on "${table}": noWait and skipLocked cannot be combined. noWait fails at once when a row is ` +
          'locked by another transaction; skipLocked leaves that row out of the result. Pick one.',
      );
    }
  } else {
    throw new ValidationError(
      `lock on "${table}" must be a mode ('update', 'noKeyUpdate', 'share' or 'keyShare') or ` +
        `{ mode, noWait?, skipLocked? }, received ${describe(lock)}. Leave it out for an unlocked read.`,
    );
  }
  if (typeof mode !== 'string' || !MODES.includes(mode as RowLockMode)) {
    const hint = typeof mode === 'string' ? suggestKey(mode, MODES) : null;
    throw new ValidationError(
      `lock on "${table}": unknown mode ${describe(mode)}.${hint ? ` Did you mean '${hint}'?` : ''} ` +
        "Use 'update', 'noKeyUpdate', 'share' or 'keyShare'.",
    );
  }
  const m = mode as RowLockMode;
  if (!(dialect.rowLockModes ?? []).includes(m)) {
    throw new UnsupportedFeatureError(
      `lock: '${m}'`,
      dialect.name,
      ENGINE_HINT[dialect.name] ?? 'This engine has no row-locking clause Turbine can emit.',
    );
  }
  const wait = noWait === true ? ' NOWAIT' : skipLocked === true ? ' SKIP LOCKED' : '';
  return {
    sql: ` FOR ${MODE_SQL[m]} OF ${dialect.quoteIdentifier(table)}${wait}`,
    fp: `${MODE_FP[m]}${noWait === true ? '.nw' : skipLocked === true ? '.sl' : ''}`,
  };
}

/**
 * The refusal for a locking read outside a transaction. In autocommit the lock
 * is released when the statement ends, before the caller sees the rows, so a
 * `skipLocked` queue claim outside a transaction claims nothing, silently.
 */
export function lockOutsideTransactionMessage(table: string, operation: string): string {
  return (
    `lock on "${table}".${operation}() needs a transaction: outside one the rows are unlocked again before ` +
    `the call returns. Use db.$transaction(async (tx) => tx.${tableAccessorName(table)}.${operation}({ ..., lock })).`
  );
}

/** The refusal for `lock` on a streaming read. */
export function lockOnStreamMessage(table: string, operation: string): string {
  return (
    `lock is not supported on "${table}".${operation}(): a stream is not a locking read. Page with ` +
    'findMany({ lock, limit }) inside the transaction instead.'
  );
}

/** The refusal for `lock` together with `distinct`. */
export function lockWithDistinctMessage(table: string): string {
  return (
    `lock on "${table}" cannot be combined with distinct: PostgreSQL does not lock rows of a DISTINCT query. ` +
    'Lock first (findMany with lock), then de-duplicate.'
  );
}

/**
 * Refuse a locking read in a pipeline that runs each statement in autocommit
 * (`pipeline(..., { transactional: false })`). A transactional pipeline, and
 * `$transaction([...])`, keep the lock for the rest of the batch.
 */
export function assertNoLockInAutocommitPipeline(queries: readonly { rowLock?: true; tag?: string }[]): void {
  const at = queries.findIndex((q) => q.rowLock === true);
  if (at === -1) return;
  throw new ValidationError(
    `pipeline query ${at} (${queries[at]?.tag ?? 'a read'}) is a locking read, and { transactional: false } runs ` +
      'it in autocommit, which releases the lock before the call returns. Drop transactional: false, or run the ' +
      'batch with db.$transaction([...]).',
  );
}

function assertFlag(value: unknown, name: string, table: string): void {
  if (value === undefined || typeof value === 'boolean') return;
  throw new ValidationError(`lock on "${table}": ${name} must be true or false, received ${describe(value)}.`);
}

function describe(value: unknown): string {
  if (typeof value === 'string') return `'${value}'`;
  if (value === null || typeof value !== 'object') return String(value);
  return Array.isArray(value) ? 'an array' : 'an object';
}
