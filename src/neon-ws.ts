/** Optional Neon Pool/Client WebSocket binding. See docs/neon-websocket.md. */
import { type DisconnectOptions, type DisconnectResult, TurbineClient } from './client.js';
import type { EngineClientConfig } from './engine-config.js';
import { ConnectionError, UnsupportedFeatureError, ValidationError } from './errors.js';
import loadNeonDriver from './neon-ws/load-driver.cjs';
import snapshot from './neon-ws/snapshot.js';
import {
  type NeonWsDriver,
  type NeonWsDriverOptions,
  type NeonWsPoolConfig,
  type NeonWsSource,
  NeonWsTransport,
} from './neon-ws/transport.js';
import type { ListenOptions, NotificationHandler, Subscription } from './realtime.js';
import type { SchemaMetadata } from './schema.js';

export type {
  NeonWsClient,
  NeonWsDriverOptions,
  NeonWsPool,
  NeonWsPoolConfig,
  NeonWsSource,
} from './neon-ws/transport.js';

export interface NeonWsOptions extends EngineClientConfig {
  /** Explicit assertion about the actual endpoint, not its checked-out logical client. */
  sessionMode: 'persistent' | 'transaction';
  /** Edge connections must be created, used and closed inside one invocation. */
  lifetime: 'persistent' | 'invocation';
  /** Ends this binding and destroys its pooled checkouts. Unsupported for a supplied Client. */
  signal?: AbortSignal;
  /** Names default off; transaction poolers cannot enable them here. */
  preparedStatements?: boolean;
}

// Keep supported inherited accessors exhaustive as the public interfaces evolve.
// Unknown own enumerable fields still pass through, matching ordinary object spread.
const optionFields: Record<keyof NeonWsOptions, true> = {
  logging: true,
  logger: true,
  diagnostics: true,
  defaultLimit: true,
  warnOnUnlimited: true,
  utcTimestamps: true,
  temporalInfinity: true,
  planCacheMode: true,
  statementTimeoutMs: true,
  streamIdleTimeoutMs: true,
  sqlComment: true,
  scopedConnect: true,
  relationLoadStrategy: true,
  stableRelationOrder: true,
  implicitPkOrdering: true,
  autoToOneJoinMaxRows: true,
  autoRoundTripMs: true,
  jsonEncoding: true,
  errorMessages: true,
  logQueryParams: true,
  sqlCache: true,
  sqlCacheSize: true,
  globalFilters: true,
  sessionMode: true,
  lifetime: true,
  signal: true,
  preparedStatements: true,
};

const connectionFields: Record<keyof NeonWsPoolConfig, true> = {
  connectionString: true,
  max: true,
  idleTimeoutMillis: true,
  connectionTimeoutMillis: true,
  maxLifetimeSeconds: true,
  application_name: true,
  ssl: true,
};

const driverFields: Record<keyof NeonWsDriverOptions, true> = {
  webSocketConstructor: true,
  wsProxy: true,
  useSecureWebSocket: true,
  forceDisablePgSSL: true,
  coalesceWrites: true,
  pipelineConnect: true,
  pipelineTLS: true,
  disableSNI: true,
  disableWarningInBrowsers: true,
};

/** Capture supported effective fields once, without invoking unrelated class getters. */
function effective<T extends object>(value: T, fields: object): T {
  const keys = new Set([...Object.keys(value), ...Object.keys(fields)]);
  return Object.fromEntries([...keys].filter((key) => key in value).map((key) => [key, Reflect.get(value, key)])) as T;
}

class NeonWsTurbine extends TurbineClient {
  private closing?: Promise<DisconnectResult>;

  constructor(
    private readonly transport: NeonWsTransport,
    schema: SchemaMetadata,
    private readonly wsOptions: NeonWsOptions,
  ) {
    const { sessionMode: _mode, lifetime: _lifetime, signal: _signal, ...config } = wsOptions;
    super({ ...config, pool: transport, preparedStatements: config.preparedStatements ?? false }, schema);
    transport.onFailure = (kind, error) => this.emitPoolEvent(kind, { error, pool: 'primary' });
  }

  override async $listen(
    channel: string,
    handler: NotificationHandler,
    options?: ListenOptions,
  ): Promise<Subscription> {
    if (
      this.wsOptions.sessionMode !== 'persistent' ||
      this.wsOptions.lifetime !== 'persistent' ||
      this.transport.singleClient
    ) {
      throw new UnsupportedFeatureError(
        '$listen',
        'Neon WebSocket',
        'Requires an explicitly persistent backend session, persistent lifetime and a Pool with a dedicated listener slot.',
      );
    }
    this.transport.assertOpen();
    return super.$listen(channel, handler, options);
  }

  override disconnect(): Promise<void>;
  override disconnect(options: DisconnectOptions): Promise<DisconnectResult>;
  override async disconnect(options?: DisconnectOptions): Promise<unknown> {
    if (options?.timeoutMs !== undefined && (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 0)) {
      throw new ValidationError('disconnect timeoutMs must be a non-negative safe integer');
    }
    if (!this.closing) {
      // Stop acquisition before subscription teardown, including a reconnect already in flight.
      this.transport.assertCanStop();
      const forcedConnections = this.transport.stop();
      this.closing = (async () => {
        try {
          await super.disconnect();
        } finally {
          await this.transport.end();
        }
        return { timedOut: false, forcedConnections };
      })();
    }
    const result = await this.closing;
    return options === undefined ? undefined : result;
  }
}

/**
 * Bind an owned Pool, a caller-owned Neon Pool, or an already-connected exclusive
 * Neon Client. Supplied resources are never ended. No driver globals are changed.
 * The generated client type adds declarative table accessors, as with turbineHttp.
 */
export async function turbineNeonWs<TClient extends TurbineClient = TurbineClient>(
  source: NeonWsSource,
  schema: SchemaMetadata,
  options: NeonWsOptions,
): Promise<TClient> {
  // Admission and construction must consume the same inputs, including while
  // optional driver resolution yields. Resource and AbortSignal identities stay intact.
  const { logger, ...configuration } = effective(options ?? ({} as NeonWsOptions), optionFields);
  options = { ...snapshot(configuration), logger };
  const { connection, driver: settings, pool, client } = source;
  const connectionConfig = connection === undefined ? undefined : effective(connection, connectionFields);
  const ssl = connectionConfig?.ssl;
  source = {
    connection:
      connectionConfig === undefined
        ? undefined
        : snapshot({
            ...connectionConfig,
            ssl:
              ssl && typeof ssl === 'object'
                ? effective(ssl, { rejectUnauthorized: true, ca: true, key: true, cert: true, servername: true })
                : ssl,
          }),
    driver: settings === undefined ? undefined : snapshot(effective(settings, driverFields)),
    pool,
    client,
  } as NeonWsSource;
  if (
    !options ||
    !['persistent', 'transaction'].includes(options.sessionMode) ||
    !['persistent', 'invocation'].includes(options.lifetime)
  ) {
    throw new ValidationError('Neon WebSocket requires explicit sessionMode and lifetime');
  }
  if (options.sessionMode === 'transaction' && options.preparedStatements === true) {
    throw new UnsupportedFeatureError(
      'preparedStatements',
      'Neon transaction pooler',
      'Named statements require an explicitly compatible backend; leave preparedStatements disabled.',
    );
  }
  if (source.client !== undefined && options.signal) {
    throw new UnsupportedFeatureError(
      'signal',
      'caller-owned Neon Client',
      'Cancellation would require ending the caller connection. Use an owned Pool or caller-owned Pool instead.',
    );
  }
  options.signal?.throwIfAborted();
  // Optional package resolution is deferred until the optional factory is called.
  let driver: NeonWsDriver;
  try {
    driver = await loadNeonDriver();
  } catch (cause) {
    throw new ConnectionError(
      'Neon WebSocket requires the optional @neondatabase/serverless package (1.2 or later). Install @neondatabase/serverless.',
      { cause },
    );
  }
  const transport = new NeonWsTransport(source, driver, options.signal);
  try {
    const db = new NeonWsTurbine(transport, schema, { ...options });
    transport.onAbort = () => {
      void db.disconnect().catch(() => {});
    };
    if (options.signal?.aborted) {
      await db.disconnect();
      options.signal.throwIfAborted();
    }
    return db as unknown as TClient;
  } catch (error) {
    await transport.end();
    throw error;
  }
}

/** Own a Pool for exactly one invocation, closing on success, failure or abort. */
export async function withNeonWs<T, TClient extends TurbineClient = TurbineClient>(
  source: Extract<NeonWsSource, { connection: unknown }>,
  schema: SchemaMetadata,
  options: Omit<NeonWsOptions, 'lifetime'>,
  run: (db: TClient) => Promise<T>,
): Promise<T> {
  if (!('connection' in source)) throw new ValidationError('withNeonWs requires an owned connection configuration');
  const db = await turbineNeonWs<TClient>(source, schema, {
    ...effective(options, optionFields),
    lifetime: 'invocation',
  });
  try {
    return await run(db);
  } finally {
    await db.disconnect();
  }
}
