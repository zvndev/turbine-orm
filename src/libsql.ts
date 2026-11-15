/** Unreleased Node-only local execution for libSQL's SQLite fork. */
import { type DisconnectOptions, type DisconnectResult, TurbineClient } from './client.js';
import type { EngineClientConfig } from './engine-config.js';
import { ConnectionError, UnsupportedFeatureError, ValidationError } from './errors.js';
import { libsqlDialect } from './libsql/dialect.js';
import { type LibsqlLocalClient, LibsqlPool, localUrl } from './libsql/pool.js';
import importOptionalPeer from './optional-peer-import.cjs';
import type { SchemaMetadata } from './schema.js';

export { libsqlDialect } from './libsql/dialect.js';
export type { LibsqlLocalClient, LibsqlTransaction } from './libsql/pool.js';
export { LibsqlPool } from './libsql/pool.js';
export type { LibsqlResultSet, LibsqlStatement, LibsqlValue } from './libsql/values.js';

export interface TurbineLibsqlOptions extends EngineClientConfig {}

/**
 * Caller attests this client was created for this local URL without sync or
 * replicas. Its integer mode must be bigint, preserving every signed 64-bit
 * integer. The adapter validates the protocol and integer mode with a read-only probe;
 * replica configuration is private to the caller and cannot be inspected.
 * The supplied client remains caller-owned, including all external operations.
 */
export interface LibsqlLocalSource {
  client: LibsqlLocalClient;
  url: string;
}

class LocalTurbineClient extends TurbineClient {
  private closePromise?: Promise<void>;
  constructor(
    private readonly localPool: LibsqlPool,
    schema: SchemaMetadata,
    options: TurbineLibsqlOptions,
  ) {
    super({ ...options, pool: localPool, dialect: libsqlDialect, preparedStatements: false }, schema);
  }

  override disconnect(): Promise<void>;
  override disconnect(options: DisconnectOptions): Promise<DisconnectResult>;
  override async disconnect(options?: DisconnectOptions): Promise<unknown> {
    // Check re-entrancy before the shared client starts shutdown bookkeeping.
    this.localPool.assertCanClose();
    if (options?.timeoutMs !== undefined) {
      throw new UnsupportedFeatureError(
        'Forced disconnect deadline',
        'libsql',
        'Native execution cannot be interrupted. Disconnect waits for active adapter leases to settle.',
      );
    }
    this.closePromise ??= (async () => {
      await super.disconnect();
      await this.localPool.end();
    })();
    await this.closePromise;
    return options === undefined ? undefined : { timedOut: false, forcedConnections: 0 };
  }

  override end(): Promise<void>;
  override end(options: DisconnectOptions): Promise<DisconnectResult>;
  override async end(options?: DisconnectOptions): Promise<unknown> {
    return options === undefined ? this.disconnect() : this.disconnect(options);
  }
}

/**
 * Open :memory: or file: using the optional native @libsql/client peer.
 * Strings create owned clients. Supplied clients stay open on disconnect.
 * Transactions acquired by this adapter always belong to the adapter.
 */
export async function turbineLibsql(
  target: string | LibsqlLocalSource,
  schema: SchemaMetadata,
  options: TurbineLibsqlOptions = {},
): Promise<TurbineClient> {
  const owned = typeof target === 'string';
  const url = localUrl(owned ? target : target.url);
  if (!owned && Object.keys(target).some((key) => key !== 'client' && key !== 'url')) {
    throw new ValidationError(
      'A supplied libSQL source accepts only client and url; sync and remote options are unsupported.',
    );
  }
  for (const key of ['syncUrl', 'syncInterval', 'authToken', 'encryptionKey', 'remoteEncryptionKey', 'offline']) {
    if (Object.hasOwn(options, key))
      throw new UnsupportedFeatureError(key, 'libsql', 'Only local execution without sync is implemented.');
  }
  let native: LibsqlLocalClient;
  if (owned) {
    let peer: { createClient?: (config: { url: string; intMode: 'bigint'; concurrency: number }) => LibsqlLocalClient };
    try {
      peer = (await importOptionalPeer('@libsql/client/node')) as typeof peer;
    } catch (cause) {
      throw new ConnectionError(
        'Local libSQL requires the optional @libsql/client package and its native engine. Install @libsql/client.',
        { cause },
      );
    }
    if (typeof peer.createClient !== 'function')
      throw new ConnectionError('@libsql/client/node must export createClient.');
    native = peer.createClient({ url, intMode: 'bigint', concurrency: 1 });
  } else {
    native = target.client;
  }
  try {
    const pool = new LibsqlPool(native, owned);
    // intMode=number rounds or rejects large integers, and string loses the
    // INTEGER/REAL distinction. Refuse both before any application writes.
    const probe = await native.execute({ sql: 'SELECT 9007199254740993 AS turbine_libsql_integer' });
    if (probe.rows[0]?.[0] !== 9007199254740993n) {
      throw new ValidationError('Local libSQL requires intMode: bigint for exact integer decoding.');
    }
    return new LocalTurbineClient(pool, schema, options);
  } catch (error) {
    if (owned) native.close();
    throw error;
  }
}
