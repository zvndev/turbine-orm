/** Owned native SQL Server connection/transaction used only by the migration lifecycle. */
import { MigrationError } from '../errors.js';
import importOptionalPeer from '../optional-peer-import.cjs';

export interface MssqlMigrationConfig extends Record<string, unknown> {
  server: string;
  database: string;
  options?: Record<string, unknown>;
  pool?: Record<string, unknown>;
}
export type MssqlMigrationTarget = string | MssqlMigrationConfig;
export interface MssqlMigrationOptions {
  schema?: string;
  lockWaitMs?: number;
  signal?: AbortSignal;
  adapter?: never;
  dialect?: never;
}
export interface MssqlMigrationRequest {
  input(name: string, value: unknown): MssqlMigrationRequest;
  query(sql: string): Promise<{ recordset?: Record<string, unknown>[] }>;
  batch(sql: string): Promise<unknown>;
  cancel(): unknown;
}
interface NativePool {
  connect(): Promise<unknown>;
  close(): Promise<unknown>;
  on(event: 'error', listener: (error: unknown) => void): unknown;
}
interface NativeTransaction {
  begin(): Promise<unknown>;
  commit(): Promise<unknown>;
  rollback(): Promise<unknown>;
  on(event: 'rollback', listener: (aborted: boolean) => void): unknown;
}
/** Structural optional-peer seam; never a PostgreSQL-compatible pool. */
export interface MssqlMigrationDriver {
  ConnectionPool: new (config: MssqlMigrationConfig) => NativePool;
  Transaction: new (pool: NativePool) => NativeTransaction;
  Request: new (transaction: NativeTransaction) => MssqlMigrationRequest;
}
export const MSSQL_MIGRATION_LOCK = 'turbine:migrations:v1';
const UNKNOWN_COMMIT =
  'SQL Server COMMIT acknowledgement failed; outcome is unknown. Inspect migration status before retrying.';

export function quoteMssqlMigrationIdentifier(identifier: string): string {
  if (
    typeof identifier !== 'string' ||
    !identifier ||
    identifier.length > 128 ||
    [...identifier].some((ch) => ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127)
  ) {
    throw new MigrationError(
      'SQL Server migration schema must be a nonempty identifier of at most 128 characters without control characters.',
    );
  }
  return `[${identifier.replace(/\]/g, ']]')}]`;
}

export function mssqlMigrationConfig(target: MssqlMigrationTarget): MssqlMigrationConfig {
  let config: MssqlMigrationConfig;
  if (typeof target === 'string') {
    try {
      const url = new URL(target);
      const database = decodeURIComponent(url.pathname.slice(1));
      if (url.protocol !== 'mssql:' || !url.hostname || !database || database.includes('/') || url.search || url.hash) {
        throw new Error('invalid URL');
      }
      config = {
        server: url.hostname,
        port: url.port ? Number(url.port) : 1433,
        database,
        user: decodeURIComponent(url.username),
        password: decodeURIComponent(url.password),
        options: { encrypt: false, trustServerCertificate: true },
      };
    } catch {
      throw new MigrationError(
        'SQL Server migrations require mssql://host/database without query or fragment, or a native config object.',
      );
    }
  } else if (
    target &&
    typeof target === 'object' &&
    typeof target.server === 'string' &&
    typeof target.database === 'string' &&
    target.server &&
    target.database &&
    !('connect' in target) &&
    !('request' in target)
  ) {
    config = target;
  } else
    throw new MigrationError('SQL Server migrations require an owned native connection config, never a borrowed pool.');
  return {
    ...config,
    pool: { ...config.pool, min: 0, max: 1 },
    options: { ...config.options, abortTransactionOnError: true, enableImplicitTransactions: false, useUTC: true },
  };
}

export function validateMssqlMigrationOptions(options: MssqlMigrationOptions = {}): void {
  quoteMssqlMigrationIdentifier(options.schema ?? 'dbo');
  if (options.adapter !== undefined || options.dialect !== undefined) {
    throw new MigrationError('SQL Server migrations do not accept PostgreSQL adapters or caller-supplied dialects.');
  }
  if (
    options.lockWaitMs !== undefined &&
    (!Number.isInteger(options.lockWaitMs) || options.lockWaitMs < 0 || options.lockWaitMs > 2147483647)
  ) {
    throw new MigrationError('SQL Server migration lockWaitMs must be an integer between 0 and 2147483647.');
  }
  options.signal?.throwIfAborted();
}

async function loadDriver(): Promise<MssqlMigrationDriver> {
  let mod: unknown;
  try {
    mod = await importOptionalPeer('mssql');
  } catch {
    throw new MigrationError("SQL Server migrations require the optional peer 'mssql'. Install it with npm i mssql.");
  }
  const driver = ((mod as { default?: unknown }).default ?? mod) as MssqlMigrationDriver;
  if (
    typeof driver.ConnectionPool !== 'function' ||
    typeof driver.Transaction !== 'function' ||
    typeof driver.Request !== 'function'
  ) {
    throw new MigrationError('SQL Server migration driver requires ConnectionPool, Transaction and Request.');
  }
  return driver;
}

export interface MssqlMigrationSession {
  query(sql: string, params?: Record<string, unknown>): Promise<Record<string, unknown>[]>;
  batch(sql: string): Promise<void>;
  assertActive(): Promise<void>;
}

/** Every Request uses this one Transaction, which pins the physical connection. */
export async function withMssqlMigrationSession<T>(
  target: MssqlMigrationTarget,
  options: MssqlMigrationOptions,
  work: (session: MssqlMigrationSession) => Promise<T>,
  driverLoader: () => Promise<MssqlMigrationDriver> = loadDriver,
): Promise<T> {
  validateMssqlMigrationOptions(options);
  const config = mssqlMigrationConfig(target);
  const requestedTimeout = config.requestTimeout ?? 15000;
  if (
    !Number.isSafeInteger(requestedTimeout) ||
    Number(requestedTimeout) < 0 ||
    Number(requestedTimeout) > 2147483647
  ) {
    throw new MigrationError('SQL Server migration native requestTimeout must be an integer between 0 and 2147483647.');
  }
  const lockTimeout = options.lockWaitMs ? options.lockWaitMs + 1000 : 0;
  // Pool configuration works on all supported mssql majors. A Request.timeout
  // property is ignored by the native driver; newer per-request overrides are
  // deliberately not required. Preserve an explicit unlimited timeout (0).
  config.requestTimeout =
    requestedTimeout === 0 || lockTimeout > 2147483647 ? 0 : Math.max(Number(requestedTimeout), lockTimeout);
  const driver = await driverLoader();
  options.signal?.throwIfAborted();
  const nativePool = new driver.ConnectionPool(config);
  let transaction: NativeTransaction | undefined;
  let aborted = false;
  let begun = false;
  let committed = false;
  let commitAttempted = false;
  let primary: unknown;
  let failed = false;
  let result: T | undefined;
  const cleanup: unknown[] = [];
  let poolError: unknown;
  nativePool.on('error', (error) => {
    poolError = error;
  });
  let sessionId: unknown;
  async function request(
    sql: string,
    params: Record<string, unknown>,
    batch: boolean,
    recovery = false,
  ): Promise<Record<string, unknown>[]> {
    if (!recovery) {
      options.signal?.throwIfAborted();
      if (poolError !== undefined) throw poolError;
      if (aborted) throw new MigrationError('SQL Server rolled back the migration transaction.');
    }
    const req = new driver.Request(transaction!);
    for (const [key, value] of Object.entries(params)) req.input(key, value);
    const cancel = () => {
      try {
        req.cancel();
      } catch (error) {
        cleanup.push(error);
      }
    };
    if (!recovery) options.signal?.addEventListener('abort', cancel, { once: true });
    try {
      const response = batch ? await req.batch(sql) : await req.query(sql);
      if (!recovery) options.signal?.throwIfAborted();
      return (response as { recordset?: Record<string, unknown>[] }).recordset ?? [];
    } finally {
      if (!recovery) options.signal?.removeEventListener('abort', cancel);
    }
  }
  const session: MssqlMigrationSession = {
    query: (sql, params = {}) => request(sql, params, false),
    batch: async (sql) => {
      await request(sql, {}, true);
    },
    assertActive: async () => {
      const state = (
        await request(
          'SELECT XACT_STATE() AS xactState, @@TRANCOUNT AS transactionCount, @@SPID AS sessionId;',
          {},
          false,
        )
      )[0];
      if (
        state?.xactState !== 1 ||
        state.transactionCount !== 1 ||
        (sessionId !== undefined && state.sessionId !== sessionId)
      ) {
        throw new MigrationError(
          'SQL Server migration transaction ownership was lost or is uncommittable (XACT_STATE/@@TRANCOUNT).',
        );
      }
      sessionId = state.sessionId;
    },
  };
  try {
    // Native connect initializes the pool; Transaction.begin pins its checkout.
    // This is not pg.Pool.connect, and the native error listener is installed above.
    await nativePool.connect();
    transaction = new driver.Transaction(nativePool);
    transaction.on('rollback', () => {
      aborted = true;
    });
    await transaction.begin();
    begun = true;
    await session.assertActive();
    // Session options are confined to this owned pool; no application/borrowed handle is mutated.
    await session.query('SET XACT_ABORT ON; SET QUOTED_IDENTIFIER ON;');
    const lock = (
      await session.query(
        `DECLARE @result int;
      EXEC @result = sys.sp_getapplock @Resource=@resource, @LockMode='Exclusive',
        @LockOwner='Transaction', @LockTimeout=@wait, @DbPrincipal='public';
      SELECT @result AS lockResult;`,
        { resource: MSSQL_MIGRATION_LOCK, wait: options.lockWaitMs ?? 0 },
      )
    )[0]?.lockResult;
    if (lock !== 0 && lock !== 1) {
      throw new MigrationError(
        `SQL Server migration application lock was not acquired within ${options.lockWaitMs ?? 0}ms (result ${String(lock)}).`,
      );
    }
    await session.assertActive();
    result = await work(session);
    await session.assertActive();
    options.signal?.throwIfAborted();
    try {
      commitAttempted = true;
      await transaction.commit();
      committed = true;
    } catch (error) {
      throw Object.assign(new MigrationError(UNKNOWN_COMMIT), { cause: error });
    }
  } catch (error) {
    failed = true;
    primary = error;
  } finally {
    if (transaction && !committed && !aborted) {
      let ended = false;
      let pinReleased = false;
      if (begun) {
        try {
          const state = (
            await request('SELECT XACT_STATE() AS xactState, @@TRANCOUNT AS transactionCount;', {}, false, true)
          )[0];
          ended = state?.xactState === 0 && state.transactionCount === 0;
        } catch (error) {
          // Native COMMIT can release its physical pin even when acknowledgement
          // fails. ENOTBEGUN is then expected and says nothing about the outcome.
          pinReleased = commitAttempted && (error as { code?: string })?.code === 'ENOTBEGUN';
          if (!aborted && !pinReleased) cleanup.push(error);
        }
      }
      if (!aborted && !pinReleased) {
        try {
          await transaction.rollback();
        } catch (error) {
          const code = (error as { code?: string })?.code;
          if (!(ended && (code === 'ENOTBEGUN' || code === 'EABORT'))) cleanup.push(error);
        }
      }
    }
    try {
      await nativePool.close();
    } catch (error) {
      cleanup.push(error);
    }
  }
  if (cleanup.length) {
    const failures = new AggregateError(
      failed ? [primary, ...cleanup] : cleanup,
      committed
        ? 'SQL Server migrations committed, but connection cleanup failed.'
        : commitAttempted
          ? `${UNKNOWN_COMMIT} Connection cleanup also failed.`
          : 'SQL Server migration failed; cleanup also failed. Inspect server transaction state before retrying.',
    );
    throw Object.assign(new MigrationError(failures.message), { cause: failures });
  }
  if (failed) throw primary;
  return result as T;
}
