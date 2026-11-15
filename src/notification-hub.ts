/** Optional, bounded PostgreSQL notification multiplexing. No driver import. */
import { type CheckoutGuard, guardCheckout } from './connection-guard.js';
import { ConnectionError, ValidationError, wrapPgError } from './errors.js';
import { consoleLogger, logTo } from './logger.js';
import { asError, ConsumerDelivery } from './notification-hub/consumer.js';
import type { PgCompatPool } from './pg-types.js';
import { type ListenReconnectOptions, type Subscription, validateChannel } from './realtime.js';

export type NotificationResyncReason = 'reconnect' | 'overflow';
export type NotificationHubHandler = (payload: string) => void | Promise<void>;

export interface NotificationHubSubscribeOptions {
  signal?: AbortSignal;
  onError?: (error: Error) => void | Promise<void>;
  /** Restores the bounded reconnect snapshot; concurrently added subscriptions await their own readiness. */
  onReconnect?: () => void | Promise<void>;
  /** Reread the source of truth; lost notifications are never replayed. */
  onResync?: (reason: NotificationResyncReason) => void | Promise<void>;
}

export interface NotificationHubOptions {
  /** Caller asserts actual backend session affinity, not merely a logical checkout. */
  endpoint: 'direct' | 'session-pool';
  /** External by default. Only 'owned' calls pool.end(), once, on close(). */
  ownership?: 'external' | 'owned';
  reconnect?: boolean | ListenReconnectOptions;
  /** Positive integer limits, including pending subscriptions. Defaults: 128 / 1024. */
  maxChannels?: number;
  maxSubscriptions?: number;
  /** Fallback for connection/handler/observer failures. Async calls are coalesced. */
  onError?: (error: Error) => void | Promise<void>;
}

export interface NotificationHubStats {
  readonly channels: number;
  readonly subscriptions: number;
  readonly connected: boolean;
  readonly reconnecting: boolean;
  readonly closed: boolean;
}

export interface NotificationHub {
  /** Resolves after LISTEN is acknowledged. Abort rejects pending readiness promptly. */
  subscribe(
    channel: string,
    handler: NotificationHubHandler,
    options?: NotificationHubSubscribeOptions,
  ): Promise<Subscription>;
  readonly stats: NotificationHubStats;
  /** Waits for late checkouts; configure a finite driver connection timeout. Idempotent. */
  close(): Promise<void>;
}

type Pool = Pick<PgCompatPool, 'connect' | 'end'>;
type Message = { channel: string; payload?: string };
interface ListenerClient {
  query(text: string): Promise<unknown>;
  on(event: 'notification', callback: (message: Message) => void): unknown;
  on(event: 'end', callback: () => void): unknown;
  removeListener(event: 'notification', callback: (message: Message) => void): unknown;
  removeListener(event: 'end', callback: () => void): unknown;
  release(error?: Error | boolean): void;
}
interface Connection {
  client: ListenerClient;
  guard: CheckoutGuard;
  channels: Set<string>;
  generation: number;
  notification: (message: Message) => void;
  end: () => void;
}
interface Consumer {
  channel: string;
  delivery: ConsumerDelivery;
  generation: number;
  ready: boolean;
  resolve: (subscription: Subscription) => void;
  reject: (error: Error) => void;
  detachAbort: () => void;
  subscription: Subscription;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647) {
    throw new ValidationError(`Notification hub ${name} must be a positive integer no larger than 2147483647`);
  }
  return value;
}

/** Channels already pass validateChannel's ASCII identifier rule. */
function quoted(channel: string): string {
  return `"${channel.replace(/"/g, '""')}"`;
}

function cancelled(): Error {
  const error = new Error('Notification subscription cancelled');
  error.name = 'AbortError';
  return error;
}

export function createNotificationHub(pool: Pool, options: NotificationHubOptions): NotificationHub {
  if (options?.endpoint !== 'direct' && options?.endpoint !== 'session-pool') {
    throw new ConnectionError(
      'Notification hub requires an explicit direct or session-pool endpoint contract. ' +
        'PgBouncer transaction pooling supports NOTIFY but not LISTEN; stateless HTTP cannot LISTEN. ' +
        'A checked-out logical client does not prove backend session affinity.',
    );
  }
  if (options.ownership !== undefined && options.ownership !== 'external' && options.ownership !== 'owned') {
    throw new ValidationError('Notification hub ownership must be external or owned');
  }
  if (!pool || typeof pool.connect !== 'function' || typeof pool.end !== 'function') {
    throw new ValidationError('Notification hub requires a pool with connect() and end()');
  }
  if (
    options.reconnect !== undefined &&
    typeof options.reconnect !== 'boolean' &&
    (typeof options.reconnect !== 'object' || options.reconnect === null)
  ) {
    throw new ValidationError('Notification hub reconnect must be a boolean or backoff options');
  }
  if (options.onError !== undefined && typeof options.onError !== 'function') {
    throw new ValidationError('Notification hub onError must be a function');
  }
  const maxChannels = positiveInteger(options.maxChannels ?? 128, 'maxChannels');
  const maxSubscriptions = positiveInteger(options.maxSubscriptions ?? 1024, 'maxSubscriptions');
  const retry = options.reconnect !== false;
  const backoff = typeof options.reconnect === 'object' ? options.reconnect : {};
  const initialDelay = positiveInteger(backoff.initialDelayMs ?? 100, 'initialDelayMs');
  const maxDelay = positiveInteger(backoff.maxDelayMs ?? 30_000, 'maxDelayMs');
  if (maxDelay < initialDelay) throw new ValidationError('Notification hub maxDelayMs must be at least initialDelayMs');
  const owned = options.ownership === 'owned';
  const onError = options.onError;
  const channels = new Map<string, Set<Consumer>>();
  let count = 0;
  let generation = 0;
  let current: Connection | undefined;
  let closed = false;
  let dirty = false;
  let work: Promise<void> | undefined;
  let closing: Promise<void> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let delay = initialDelay;
  let reporting = false;
  let failures = 0;
  const consumersNow = (): Consumer[] => [...channels.values()].flatMap((consumers) => [...consumers]);

  const fallback = (error: Error): void => {
    if (reporting) return;
    if (!onError) {
      logTo(consoleLogger, 'warn', 'Notification hub failure:', { code: 'listen-lost', error });
      return;
    }
    reporting = true;
    try {
      const result = onError(error);
      if (result && typeof result.then === 'function') {
        void Promise.resolve(result)
          .catch(() => {})
          .finally(() => {
            reporting = false;
          });
      } else reporting = false;
    } catch {
      reporting = false;
    }
  };
  const cancelTimer = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  const remove = (consumer: Consumer, error = cancelled()): void => {
    if (!consumer.delivery.active) return;
    consumer.delivery.stop();
    consumer.detachAbort();
    const set = channels.get(consumer.channel)!;
    set.delete(consumer);
    if (!set.size) channels.delete(consumer.channel);
    count--;
    if (!consumer.ready) consumer.reject(error);
    if (!count) cancelTimer();
    kick();
  };
  const drop = (connection: Connection, destroy?: Error | boolean): void => {
    if (current !== connection) return;
    current = undefined;
    connection.client.removeListener('notification', connection.notification);
    connection.client.removeListener('end', connection.end);
    connection.guard.release(destroy);
  };
  const schedule = (): void => {
    if (closed || !count || !retry || timer !== undefined) return;
    timer = setTimeout(() => {
      timer = undefined;
      kick();
    }, delay);
    timer.unref?.();
    delay = Math.min(delay * 2, maxDelay);
  };
  const failure = (error: Error): void => {
    failures++;
    let reported = false;
    for (const consumer of consumersNow()) {
      if (consumer.delivery.active) {
        consumer.delivery.report(error);
        reported = true;
        if (!consumer.ready || !retry) remove(consumer, error);
      }
    }
    if (!reported) fallback(error);
    schedule();
  };
  const lost = (connection: Connection, error: Error): void => {
    if (current !== connection) return;
    drop(connection, error);
    delay = initialDelay;
    failure(asError(wrapPgError(error)));
  };

  const open = async (): Promise<void> => {
    const client = (await pool.connect()) as unknown as ListenerClient;
    if (closed || !count) {
      guardCheckout(client).release(true);
      return;
    }
    if (typeof client.on !== 'function' || typeof client.removeListener !== 'function') {
      guardCheckout(client).release(true);
      throw new ConnectionError(
        'Notification hub requires native notification, error and end events on a persistent client',
      );
    }
    const connection: Connection = {
      client,
      guard: undefined as unknown as CheckoutGuard,
      channels: new Set(),
      generation: ++generation,
      notification(message): void {
        if (current !== connection) return;
        for (const consumer of [...(channels.get(message.channel) ?? [])]) {
          // Reconnect gaps are covered by resync, never by a notification buffer.
          if (consumer.generation === connection.generation) consumer.delivery.deliver(message.payload ?? '');
        }
      },
      end(): void {
        lost(connection, new ConnectionError('Notification listener connection ended'));
      },
    };
    connection.guard = guardCheckout(client, (error) => lost(connection, error));
    current = connection;
    client.on('notification', connection.notification);
    client.on('end', connection.end);
  };

  const reconcile = async (): Promise<void> => {
    if (closed || !count) {
      cancelTimer();
      const connection = current;
      if (connection) {
        try {
          await connection.client.query('UNLISTEN *');
          drop(connection);
        } catch (error) {
          drop(connection, true);
          fallback(asError(error));
        }
      }
      return;
    }
    if (!current) {
      if (timer !== undefined) return;
      await open();
    }
    const connection = current;
    if (!connection) return;
    // A stable, bounded snapshot prevents churn during awaited LISTENs from
    // extending a live Map iterator and accumulating stale server channels.
    const desired = new Set(channels.keys());
    const query = async (sql: string): Promise<void> => {
      await connection.client.query(sql);
      if (current !== connection) throw new ConnectionError('Notification listener lost during channel reconciliation');
    };
    for (const channel of connection.channels) {
      if (!desired.has(channel)) {
        await query(`UNLISTEN ${quoted(channel)}`);
        connection.channels.delete(channel);
      }
    }
    for (const channel of desired) {
      if (!connection.channels.has(channel)) {
        await query(`LISTEN ${quoted(channel)}`);
        connection.channels.add(channel);
      }
    }
    if (closed || !count) {
      dirty = true;
      return;
    }
    delay = initialDelay;
    for (const consumer of consumersNow()) {
      if (consumer.delivery.active) {
        if (!connection.channels.has(consumer.channel)) {
          dirty = true;
          continue;
        }
        const restored = consumer.ready && consumer.generation !== connection.generation;
        consumer.generation = connection.generation;
        if (!consumer.ready) {
          consumer.ready = true;
          consumer.resolve(consumer.subscription);
        }
        if (restored) consumer.delivery.restored();
      }
    }
  };
  const drain = async (): Promise<void> => {
    while (dirty) {
      dirty = false;
      const before = failures;
      try {
        await reconcile();
      } catch (error) {
        // Event loss already reported its cause. Query/checkout failures still need reporting.
        if (before !== failures) continue;
        if (current) drop(current, true);
        failure(asError(wrapPgError(error)));
      }
    }
  };
  function kick(): void {
    dirty = true;
    if (work) return;
    work = Promise.resolve()
      .then(drain)
      .finally(() => {
        work = undefined;
        if (dirty) kick();
      });
  }
  const settled = async (): Promise<void> => {
    while (work) await work;
  };

  return {
    get stats(): NotificationHubStats {
      return Object.freeze({
        channels: channels.size,
        subscriptions: count,
        connected: !!current,
        reconnecting: timer !== undefined || (!!count && !current),
        closed,
      });
    },
    async subscribe(channel, handler, subscribeOptions = {}): Promise<Subscription> {
      validateChannel(channel);
      if (closed) throw new ConnectionError('Notification hub is closed');
      if (typeof handler !== 'function') throw new ValidationError('Notification hub handler must be a function');
      for (const name of ['onError', 'onReconnect', 'onResync'] as const) {
        if (subscribeOptions[name] !== undefined && typeof subscribeOptions[name] !== 'function') {
          throw new ValidationError(`Notification hub ${name} must be a function`);
        }
      }
      if (
        subscribeOptions.signal !== undefined &&
        (!subscribeOptions.signal ||
          typeof subscribeOptions.signal.aborted !== 'boolean' ||
          typeof subscribeOptions.signal.addEventListener !== 'function' ||
          typeof subscribeOptions.signal.removeEventListener !== 'function')
      ) {
        throw new ValidationError('Notification hub signal must be an AbortSignal');
      }
      if (subscribeOptions.signal?.aborted) throw cancelled();
      if (count >= maxSubscriptions || (!channels.has(channel) && channels.size >= maxChannels)) {
        throw new ValidationError('Notification hub subscription or channel limit exceeded');
      }
      let resolve!: Consumer['resolve'];
      let reject!: Consumer['reject'];
      const ready = new Promise<Subscription>((accept, refuse) => {
        resolve = accept;
        reject = refuse;
      });
      const consumer: Consumer = {
        channel,
        resolve,
        reject,
        generation: 0,
        ready: false,
        delivery: new ConsumerDelivery(handler, { ...subscribeOptions }, fallback),
        detachAbort: () => {},
        subscription: {
          channel,
          async unsubscribe(): Promise<void> {
            remove(consumer);
            await settled();
          },
        },
      };
      let consumers = channels.get(channel);
      if (!consumers) {
        consumers = new Set();
        channels.set(channel, consumers);
      }
      consumers.add(consumer);
      count++;
      const signal = subscribeOptions.signal;
      if (signal) {
        const abort = (): void => remove(consumer);
        signal.addEventListener('abort', abort, { once: true });
        consumer.detachAbort = () => signal.removeEventListener('abort', abort);
      }
      kick();
      return ready;
    },
    close(): Promise<void> {
      if (closing) return closing;
      closed = true;
      cancelTimer();
      for (const consumers of channels.values())
        for (const consumer of consumers) remove(consumer, new ConnectionError('Notification hub is closed'));
      kick();
      closing = (async () => {
        await settled();
        if (owned) await pool.end();
      })();
      return closing;
    },
  };
}
