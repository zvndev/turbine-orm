import { AsyncLocalStorage } from 'node:async_hooks';
import { ConnectionError, SerializationFailureError, UnsupportedFeatureError, ValidationError } from '../errors.js';
import type { PgCompatPool, PgCompatPoolClient, PgCompatQueryResult } from '../pg-types.js';
import { findTransactionControl } from '../transaction-control.js';
import { statement } from './bindings.js';
import { deferSeedCleanup } from './seed-cleanup.js';
import { type LibsqlResultSet, type LibsqlStatement, rows } from './values.js';

/** Structural subset of the real @libsql/client Transaction. */
export interface LibsqlTransaction {
  execute(statement: LibsqlStatement): Promise<LibsqlResultSet>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  close(): void;
  readonly closed: boolean;
}
/** Structural subset, avoiding driver declarations on unrelated entries. */
export interface LibsqlLocalClient {
  execute(statement: LibsqlStatement): Promise<LibsqlResultSet>;
  batch(statements: LibsqlStatement[], mode: 'write'): Promise<LibsqlResultSet[]>;
  transaction(mode: 'write'): Promise<LibsqlTransaction>;
  close(): void;
  readonly closed: boolean;
  readonly protocol: string;
}

interface CallbackOwner {
  pool: LibsqlPool;
  active: boolean;
  parent?: CallbackOwner;
}
const callbackOwner = new AsyncLocalStorage<CallbackOwner>();
function ownsCallback(pool: LibsqlPool): boolean {
  for (let scope = callbackOwner.getStore(); scope; scope = scope.parent) {
    if (scope.pool === pool && scope.active) return true;
  }
  return false;
}

/** Refuse remote URLs and every query option, including replica/sync options. */
export function localUrl(url: string): string {
  if (typeof url !== 'string') throw new ValidationError('libSQL requires a local URL.');
  if (url === ':memory:') return url;
  if (!url.startsWith('file:') || url.length === 5 || /[?#]/.test(url) || url.includes('\u0000')) {
    throw new UnsupportedFeatureError(
      'Remote or configured libSQL transport',
      'libsql',
      'Use :memory: or a local file: URL without query parameters.',
    );
  }
  if (url.startsWith('file://')) {
    const parsed = new URL(url);
    if (parsed.hostname !== '' && parsed.hostname !== 'localhost') {
      throw new UnsupportedFeatureError('Remote file host', 'libsql', 'Only local file URLs are accepted.');
    }
  }
  return url;
}

function result<R>(native: LibsqlResultSet): PgCompatQueryResult<R> {
  return { rows: rows(native) as R[], rowCount: native.columns.length ? native.rows.length : native.rowsAffected };
}

function translate(error: unknown): unknown {
  const native = error as { code?: string; rawCode?: number; message?: string } | null;
  if (native?.code === 'SQLITE_BUSY' || native?.code === 'SQLITE_LOCKED') {
    return new SerializationFailureError({
      message: 'libSQL database is busy; retry the whole transaction.',
      cause: error,
    });
  }
  // Preserve native failures and extended result codes, with SQLSTATE aliases
  // for the shared ORM error classifier. Never overwrite driver error fields.
  const code = native?.rawCode;
  const sqlstate =
    code === 2067 || code === 1555
      ? '23505'
      : code === 787
        ? '23503'
        : code === 1299
          ? '23502'
          : code === 275
            ? '23514'
            : undefined;
  if (sqlstate) return Object.assign(new Error(native?.message, { cause: error }), { code: sqlstate });
  if (native?.code === 'CLIENT_CLOSED' || native?.code === 'TRANSACTION_CLOSED') {
    return new ConnectionError('The native libSQL client or transaction is closed.', { cause: error });
  }
  if (native?.code === 'SQLITE_ERROR')
    return new ValidationError('libSQL rejected the SQL statement.', { cause: error });
  return error;
}

/** Exclusive adapter leases; external use of a supplied client remains caller-owned. */
export class LibsqlPool implements PgCompatPool {
  private tail: Promise<void> = Promise.resolve();
  private closing = false;
  private ending?: Promise<void>;
  private cleanupFailed = false;
  private cleanupFailure?: unknown;

  constructor(
    readonly client: LibsqlLocalClient,
    private readonly ownsClient = false,
  ) {
    if (client.protocol !== 'file' || client.closed)
      throw new ConnectionError('libSQL requires an open native local client (protocol=file).');
  }

  private async acquire(): Promise<() => void> {
    if (ownsCallback(this)) {
      throw new UnsupportedFeatureError(
        'Root operations inside a libSQL transaction',
        'libsql',
        'Use the callback transaction client.',
      );
    }
    if (this.closing) throw new ConnectionError('The libSQL adapter is closed.');
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    if (this.closing) {
      release();
      throw new ConnectionError('The libSQL adapter is closed.');
    }
    return release;
  }

  async query<R = Record<string, unknown>>(text: string, values?: unknown[]): Promise<PgCompatQueryResult<R>> {
    const sql = statement(text, values);
    if (findTransactionControl(sql.sql, 'sqlite').length) {
      throw new UnsupportedFeatureError(
        'Unscoped transaction control',
        'libsql',
        'Use $transaction or transaction callbacks.',
      );
    }
    const release = await this.acquire();
    try {
      return result<R>(await this.client.execute(sql));
    } catch (error) {
      throw translate(error);
    } finally {
      release();
    }
  }

  /** Atomic native client.batch, in input order; failure rolls back all effects. */
  async batch(queries: readonly { text: string; values?: unknown[] }[]): Promise<PgCompatQueryResult[]> {
    if (!queries.length) throw new ValidationError('libSQL batch requires at least one statement.');
    const statements = queries.map((query) => statement(query.text, query.values));
    for (const sql of statements) {
      if (findTransactionControl(sql.sql, 'sqlite').length)
        throw new ValidationError('libSQL batch cannot contain transaction control.');
    }
    const release = await this.acquire();
    try {
      return (await this.client.batch(statements, 'write')).map(result<Record<string, unknown>>);
    } catch (error) {
      throw translate(error);
    } finally {
      release();
    }
  }

  async connect(): Promise<PgCompatPoolClient> {
    const unlock = await this.acquire();
    let released = false;
    let transaction: LibsqlTransaction | undefined;
    let queue: Promise<unknown> = Promise.resolve();
    const close = () => {
      try {
        transaction?.close();
        transaction = undefined;
      } catch (error) {
        if (!this.cleanupFailed) this.cleanupFailure = error;
        this.cleanupFailed = true;
        this.closing = true;
        throw error;
      }
    };
    const query = <R = Record<string, unknown>>(text: string, values?: unknown[]): Promise<PgCompatQueryResult<R>> => {
      if (released) return Promise.reject(new ConnectionError('The libSQL connection lease has ended.'));
      const work = queue
        .then(async (): Promise<PgCompatQueryResult<R>> => {
          if (released) throw new ConnectionError('The libSQL connection lease has ended.');
          if (this.cleanupFailed)
            throw new ConnectionError('The libSQL adapter is closed after native cleanup failed.');
          const sql = statement(text, values);
          const control = findTransactionControl(sql.sql, 'sqlite');
          if (control.length) {
            const kind = control[0]!.kind;
            if (kind === 'begin') {
              if (transaction || !/^\s*BEGIN\s*;?\s*$/i.test(text))
                throw new ValidationError('libSQL supports one adapter-owned write transaction per lease.');
              transaction = await this.client.transaction('write');
              return { rows: [], rowCount: 0, command: 'BEGIN' };
            }
            if (kind === 'commit' || kind === 'rollback') {
              if (!transaction) throw new ValidationError('libSQL has no adapter-owned transaction to finish.');
              const current = transaction;
              try {
                if (kind === 'commit') await current.commit();
                else await current.rollback();
              } catch (error) {
                try {
                  close();
                } catch {
                  // close() retains cleanup failure; the completion stays primary.
                }
                throw error;
              }
              try {
                close();
              } catch (error) {
                // A seed awaits end(), which reports this retained cleanup event.
                // Keep it out of native statement-error translation after COMMIT.
                if (kind !== 'commit' || !deferSeedCleanup(this)) throw error;
              }
              return { rows: [], rowCount: 0, command: kind === 'commit' ? 'COMMIT' : 'ROLLBACK' };
            }
            if (!transaction || !['savepoint', 'rollback-to', 'release'].includes(kind)) {
              throw new UnsupportedFeatureError(
                'libSQL transaction control',
                'libsql',
                'Use the typed transaction callback.',
              );
            }
          }
          return result<R>(await (transaction ?? this.client).execute(sql));
        })
        .catch((error: unknown) => {
          throw translate(error);
        });
      queue = work.catch(() => undefined);
      return work;
    };
    return {
      query,
      wrapTransactionCallback: async (fn) => {
        const scope = { pool: this, active: true, parent: callbackOwner.getStore() };
        try {
          return await callbackOwner.run(scope, fn);
        } finally {
          scope.active = false;
        }
      },
      release: () => {
        if (released) return;
        released = true;
        void queue.finally(() => {
          try {
            close();
          } catch {
            // close() retains the failure and quarantines the adapter.
          } finally {
            transaction = undefined;
            unlock();
          }
        });
      },
    };
  }

  assertCanClose(): void {
    if (ownsCallback(this)) throw new ValidationError('Cannot disconnect libSQL inside its transaction callback.');
  }

  end(): Promise<void> {
    try {
      this.assertCanClose();
    } catch (error) {
      return Promise.reject(error);
    }
    if (!this.ending) {
      this.closing = true;
      this.ending = this.tail.then(() => {
        try {
          if (this.ownsClient) this.client.close();
        } catch (error) {
          if (!this.cleanupFailed) throw error;
        }
        if (this.cleanupFailed) throw this.cleanupFailure;
      });
    }
    return this.ending;
  }
}
