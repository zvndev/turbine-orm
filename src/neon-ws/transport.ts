import { ConnectionError, ValidationError } from '../errors.js';
import type { PgCompatPool, PgCompatPoolClient, PgCompatQueryResult } from '../pg-types.js';
import { createRecovery } from './recovery.js';

/** Only per-client Neon settings. No global-only HTTP or fetch defaults. */
export interface NeonWsDriverOptions {
  webSocketConstructor?: new (...args: never[]) => unknown;
  wsProxy?: string | ((host: string, port: number | string) => string);
  useSecureWebSocket?: boolean;
  forceDisablePgSSL?: boolean;
  coalesceWrites?: boolean;
  pipelineConnect?: 'password' | false;
  pipelineTLS?: boolean;
  disableSNI?: boolean;
  disableWarningInBrowsers?: boolean;
}

export interface NeonWsPoolConfig {
  connectionString: string;
  max?: number;
  idleTimeoutMillis?: number;
  connectionTimeoutMillis?: number;
  maxLifetimeSeconds?: number;
  application_name?: string;
  ssl?: boolean | Record<string, unknown>;
}

/** Structural declarations keep the optional peer out of other consumers' types. */
export interface NeonWsClient {
  query<R = Record<string, unknown>>(text: string, values?: unknown[]): Promise<PgCompatQueryResult<R>>;
  readonly neonConfig: NeonWsDriverOptions;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  removeListener(event: string, listener: (...args: unknown[]) => void): unknown;
}
export interface NeonWsPool extends PgCompatPool {}

export type NeonWsSource =
  | { connection: NeonWsPoolConfig; driver?: NeonWsDriverOptions; pool?: never; client?: never }
  | { pool: NeonWsPool; connection?: never; client?: never; driver?: never }
  | { client: NeonWsClient; connection?: never; pool?: never; driver?: never };

interface DriverClient extends NeonWsClient {
  connect(): Promise<void>;
  connect(callback: (error?: Error) => void): void;
  connection: { stream: { destroy(): void } };
  connectionTimeoutHandle?: ReturnType<typeof setTimeout>;
  release(error?: Error | boolean): void;
  end(): Promise<void>;
  _types?: unknown;
  _connected?: boolean;
  _ending?: boolean;
}
interface DriverPool extends NeonWsPool {
  Client: new (config: unknown) => DriverClient;
  on(event: 'error', listener: (error: Error) => void): this;
  removeListener(event: string, listener: (...args: unknown[]) => void): this;
  options?: unknown;
  _clients?: unknown;
}
export interface NeonWsDriver {
  Client: new (config: unknown) => DriverClient;
  Pool: new (config: NeonWsPoolConfig) => DriverPool;
}
interface Lease {
  release(error?: Error | boolean): void;
}

/** A local lease, never proof of the endpoint's backend session mode. */
export class NeonWsTransport implements PgCompatPool {
  readonly singleClient: boolean;
  readonly transactionRecovery: ReturnType<typeof createRecovery>;
  readonly Client: NeonWsDriver['Client'];
  private readonly pool?: DriverPool;
  private readonly client?: DriverClient;
  private readonly owned: boolean;
  private readonly active = new Set<Lease>();
  private readonly connecting = new Set<DriverClient>();
  private readonly closingClients = new Set<Promise<void>>();
  private readonly observers = new Set<() => void>();
  private closed = false;
  private leased = false;
  private ending?: Promise<void>;
  private stopReason: unknown = new ConnectionError('Neon WebSocket binding is disconnected');
  private readonly pendingStops = new Set<(error: unknown) => void>();
  private forcedConnections = 0;
  onAbort?: () => void;
  onFailure?: (kind: 'poolError' | 'connectionLost', error: Error) => void;
  private readonly abort = (): void => {
    this.stopReason = this.signal?.reason;
    this.stop();
    this.onAbort?.();
  };
  private readonly idleError = (error: Error): void => {
    if (this.owned && !this.closed) this.onFailure?.('poolError', error);
  };

  constructor(
    source: NeonWsSource,
    driver: NeonWsDriver,
    private readonly signal?: AbortSignal,
  ) {
    const keys = ['connection', 'pool', 'client'].filter(
      (key) => (source as unknown as Record<string, unknown>)[key] !== undefined,
    );
    if (keys.length !== 1)
      throw new ValidationError('Neon WebSocket source must specify exactly one of connection, pool or client');
    this.owned = source.connection !== undefined;
    this.singleClient = source.client !== undefined;
    this.transactionRecovery = createRecovery(this.singleClient);
    this.Client = driver.Client;
    if (source.connection) {
      const settings = { ...source.driver };
      const BaseClient = driver.Client;
      const connecting = this.connecting;
      class ScopedClient extends BaseClient {
        constructor(config: unknown) {
          super(config);
          Object.assign(this.neonConfig, settings);
        }

        override connect(): Promise<void>;
        override connect(callback: (error?: Error) => void): void;
        override connect(callback?: (error?: Error) => void): Promise<void> | void {
          connecting.add(this);
          const pending = new Promise<void>((resolve, reject) => {
            let settled = false;
            const done = (error?: Error): void => {
              if (settled) return;
              settled = true;
              connecting.delete(this);
              if (error) reject(error);
              else resolve();
            };
            try {
              super.connect(done);
            } catch (error) {
              // Neon can reject configuration before installing its end handler.
              // Do not await end on a stream which never opened a WebSocket.
              done(error as Error);
              clearTimeout(this.connectionTimeoutHandle);
              this.connection.stream.destroy();
            }
          });
          if (callback) void pending.then(() => callback(), callback);
          else return pending;
        }
      }
      this.pool = new driver.Pool({ ...source.connection });
      this.pool.Client = ScopedClient;
    } else if (source.pool) {
      if (!(source.pool instanceof driver.Pool))
        throw new ValidationError('pool must be an actual @neondatabase/serverless Pool');
      this.pool = source.pool as DriverPool;
    } else {
      if (!(source.client instanceof driver.Client))
        throw new ValidationError('client must be an actual connected @neondatabase/serverless Client');
      const supplied = source.client as DriverClient;
      if (supplied._connected !== true || supplied._ending) {
        throw new ValidationError('client must already be connected and queryable before binding');
      }
      this.client = supplied;
    }
    this.pool?.on('error', this.idleError);
    this.signal?.addEventListener('abort', this.abort, { once: true });
    if (this.signal?.aborted) this.abort();
  }

  get options(): unknown {
    return this.pool?.options;
  }
  get _clients(): unknown {
    return this.pool?._clients ?? (this.client ? [this.client] : []);
  }
  get totalCount(): number {
    return this.pool?.totalCount ?? 0;
  }
  get idleCount(): number {
    return this.pool?.idleCount ?? 0;
  }
  get waitingCount(): number {
    return this.pool?.waitingCount ?? 0;
  }

  assertOpen(): void {
    if (this.closed) throw this.stopReason;
  }

  private async untilStopped<T>(operation: Promise<T>): Promise<T> {
    let rejectStop!: (error: unknown) => void;
    const stopped = new Promise<never>((_resolve, reject) => {
      rejectStop = reject;
    });
    this.pendingStops.add(rejectStop);
    if (this.closed) rejectStop(this.stopReason);
    try {
      return await Promise.race([operation, stopped]);
    } finally {
      // A persistent binding must not retain settled query reactions until disconnect.
      this.pendingStops.delete(rejectStop);
    }
  }

  async connect(): Promise<PgCompatPoolClient> {
    this.assertOpen();
    if (this.client && this.leased)
      throw new ConnectionError('The supplied Neon Client is already leased; use a Pool for concurrent work');
    if (this.client) this.leased = true;
    const acquire = this.client ? Promise.resolve(this.client) : (this.pool!.connect() as Promise<DriverClient>);
    let raw: DriverClient;
    try {
      // A stopped acquisition is returned promptly; the eventual checkout is destroyed below.
      raw = await this.untilStopped(acquire);
    } catch (error) {
      if (this.client) this.leased = false;
      if (this.closed && !this.client)
        void acquire.then(
          (late) => late.release(true),
          () => {},
        );
      throw error;
    }
    if (this.closed) {
      if (this.client) this.leased = false;
      else raw.release(true);
      throw this.stopReason;
    }
    const recovery = createRecovery(this.singleClient);
    let released = false;
    let lost: Error | undefined;
    const onError = (error: Error): void => {
      if (lost) return;
      lost = error;
      if (this.owned && !this.closed) this.onFailure?.('connectionLost', error);
    };
    const detach = (): void => {
      raw.removeListener('error', onError as (...args: unknown[]) => void);
      raw.removeListener('end', detach);
      this.observers.delete(detach);
    };
    this.observers.add(detach);
    raw.on('end', detach);
    raw.on('error', onError as (...args: unknown[]) => void);
    const lease: Lease = {
      release: (error): void => {
        if (released) return;
        released = true;
        this.active.delete(lease);
        if (this.client) this.leased = false;
        else raw.release(error ?? lost);
        // Failed pooled sockets can emit a second error while closing.
        if (this.client || !(error || lost)) detach();
      },
    };
    this.active.add(lease);
    // Deliberately expose no native pg cancellation/connection internals. A WS
    // close is not PostgreSQL CancelRequest delivery or proof of rollback.
    return {
      _types: raw._types,
      transactionRecovery: recovery,
      query: async <R>(text: string | { text: string }, values?: unknown[]): Promise<PgCompatQueryResult<R>> => {
        this.assertOpen();
        if (released) throw new ConnectionError('Neon WebSocket checkout has been released');
        // The parser wrapper supplies query configs. Only classify their text;
        // forward the original config (including types) and values untouched.
        const commit = (typeof text === 'string' ? text : text.text) === 'COMMIT';
        if (commit) recovery.commitSent();
        const result = await this.untilStopped(raw.query<R>(text as string, values));
        if (commit && result.command === 'ROLLBACK') recovery.commitSent(true);
        return result;
      },
      release: lease.release,
      on: raw.on.bind(raw),
      removeListener: raw.removeListener.bind(raw),
    } as PgCompatPoolClient;
  }

  async query<R = Record<string, unknown>>(text: string, values?: unknown[]): Promise<PgCompatQueryResult<R>> {
    const client = await this.connect();
    try {
      return await client.query<R>(text, values);
    } finally {
      client.release();
    }
  }

  assertCanStop(): void {
    if (this.client && this.leased)
      throw new ConnectionError('Cannot disconnect a busy caller-owned Neon Client; await its operation first');
  }

  stop(): number {
    if (this.closed) return this.forcedConnections;
    this.forcedConnections = this.client ? 0 : this.active.size + this.connecting.size;
    this.closed = true;
    for (const reject of this.pendingStops) reject(this.stopReason);
    this.pendingStops.clear();
    // Only the owned subclass is tracked here. Destroy the stream before end():
    // a graceful Terminate can itself wait on the unfinished startup handshake.
    // The driver's connect callback removes the failed Client from its Pool.
    for (const raw of this.connecting) {
      const closed = new Promise<void>((resolve) => {
        const done = (): void => {
          raw.removeListener('end', done);
          resolve();
        };
        raw.on('end', done);
      });
      this.closingClients.add(closed);
      void closed.then(() => this.closingClients.delete(closed));
      raw.connection.stream.destroy();
    }
    // A supplied single Client belongs to the caller and is never terminated.
    for (const lease of [...this.active]) if (!this.client) lease.release(true);
    this.signal?.removeEventListener('abort', this.abort);
    return this.forcedConnections;
  }

  end(): Promise<void> {
    this.stop();
    if (!this.ending) {
      this.ending = (async () => {
        try {
          if (this.owned) await this.pool!.end();
          await Promise.all(this.closingClients);
        } finally {
          this.pool?.removeListener('error', this.idleError as (...args: unknown[]) => void);
          for (const detach of this.observers) detach();
          this.onFailure = undefined;
          this.onAbort = undefined;
        }
      })();
    }
    return this.ending;
  }
}
