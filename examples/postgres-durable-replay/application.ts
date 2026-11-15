import { AsyncLocalStorage } from 'node:async_hooks';
import type pg from 'pg';
import { type PgCompatPoolClient, TurbineClient } from 'turbine-orm';
import { type LiveQuery, liveQuery } from 'turbine-orm/live-query';
import { createNotificationHub, type NotificationHubOptions } from 'turbine-orm/notification-hub';

export interface OrderCommand {
  eventId: string;
  orderId: string;
  title: string | null;
  /** Exact int8 and numeric decimal strings, never JavaScript numbers. */
  quantity: string;
  amount: string;
  /** Canonical UTC timestamp with exactly six fractional digits. */
  occurredAt: string;
  body: Buffer;
}

export interface OrderEvent extends OrderCommand {
  tenant: string;
  position: string;
}

export type Deliver = (event: OrderEvent, signal: AbortSignal) => void | PromiseLike<void>;
const deliveryContext = new AsyncLocalStorage<ReadonlySet<string>>();

function readEvent(row: Record<string, unknown>): OrderEvent {
  const text = (key: string) => {
    const value = row[key];
    if (typeof value !== 'string') throw new TypeError(`Unexpected outbox ${key} type`);
    return value;
  };
  if (row.title !== null && typeof row.title !== 'string') throw new TypeError('Unexpected outbox title type');
  if (!Buffer.isBuffer(row.body)) throw new TypeError('Unexpected outbox body type');
  const command = commandCopy({
    eventId: text('eventId'),
    orderId: text('orderId'),
    title: row.title,
    quantity: text('quantity'),
    amount: text('amount'),
    occurredAt: text('occurredAt'),
    body: row.body,
  });
  const tenant = text('tenant'),
    position = text('position');
  scopeKey(tenant);
  if (!/^[1-9][0-9]{0,18}$/.test(position)) throw new TypeError('Unexpected outbox position');
  return { ...command, tenant, position };
}

function scopeKey(value: string): void {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    Buffer.byteLength(value) > 128 ||
    value.includes('\0') ||
    Buffer.from(value).toString() !== value
  ) {
    throw new TypeError('Scope keys must contain 1..128 UTF-8 bytes without NUL');
  }
}

function commandCopy(input: OrderCommand): OrderCommand {
  // Read each caller property once, synchronously, before admission or any await.
  const command: OrderCommand = {
    eventId: input.eventId,
    orderId: input.orderId,
    title: input.title,
    quantity: input.quantity,
    amount: input.amount,
    occurredAt: input.occurredAt,
    body: input.body,
  };
  for (const id of [command.eventId, command.orderId]) {
    if (typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) {
      throw new TypeError('IDs must be canonical lowercase UUIDs');
    }
  }
  if (
    typeof command.quantity !== 'string' ||
    !/^(0|[1-9][0-9]{0,18})$/.test(command.quantity) ||
    BigInt(command.quantity) > 9223372036854775807n
  ) {
    throw new TypeError('quantity must be a nonnegative int8 decimal string');
  }
  if (typeof command.amount !== 'string' || !/^(0|[1-9][0-9]{0,29})(\.[0-9]{1,12})?$/.test(command.amount)) {
    throw new TypeError('amount must be a bounded nonnegative decimal string');
  }
  if (
    typeof command.occurredAt !== 'string' ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/.test(command.occurredAt) ||
    command.occurredAt.startsWith('0000')
  ) {
    throw new TypeError('occurredAt must be canonical UTC with six fractional digits');
  }
  const millisecondTime = `${command.occurredAt.slice(0, 23)}Z`;
  if (!Number.isFinite(Date.parse(millisecondTime)) || new Date(millisecondTime).toISOString() !== millisecondTime) {
    throw new TypeError('occurredAt must name an actual canonical UTC date/time');
  }
  if (
    command.title !== null &&
    (typeof command.title !== 'string' ||
      command.title.includes('\0') ||
      Buffer.from(command.title).toString() !== command.title)
  ) {
    throw new TypeError('title must be text without NUL or null');
  }
  if (!Buffer.isBuffer(command.body) || command.body.length + Buffer.byteLength(command.title ?? '') > 65536) {
    throw new TypeError('Combined title/body limit is 65536 bytes');
  }
  return { ...command, body: Buffer.from(command.body) };
}

/** Only this callback call site is raced. Late rejections are observed; no late acknowledgement is possible. */
async function deliverBounded(
  deliver: Deliver,
  event: OrderEvent,
  signal: AbortSignal,
  outstanding: Set<Promise<unknown>>,
): Promise<void> {
  signal.throwIfAborted();
  if (outstanding.size >= 8)
    throw new Error('Outstanding callback limit (8) exceeded; settle cancelled deliveries first');
  let abort!: () => void;
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
  });
  const callback = Promise.resolve().then(() => {
    signal.throwIfAborted();
    return deliver(event, signal);
  });
  outstanding.add(callback);
  void callback.then(
    () => outstanding.delete(callback),
    () => outstanding.delete(callback),
  );
  try {
    await Promise.race([callback, cancelled]);
    signal.throwIfAborted();
  } finally {
    signal.removeEventListener('abort', abort);
  }
}

/** Fixed application schema and protocol, not a reusable transaction/replay framework. */
export function createOrderApplication(options: {
  pool: pg.Pool;
  schema: string;
  endpoint: NotificationHubOptions['endpoint'];
  onDiagnostic(error: Error): void;
  batchSize?: number;
  callbackMs?: number;
  reconcileMs?: number;
}) {
  if (!/^[a-z][a-z0-9_]{0,39}$/.test(options.schema)) throw new TypeError('Invalid application schema');
  const batchSize = options.batchSize ?? 16;
  const onDiagnostic = options.onDiagnostic;
  const callbackMs = options.callbackMs ?? 1000;
  const reconcileMs = options.reconcileMs ?? 250;
  for (const [name, value, max] of [
    ['batchSize', batchSize, 32],
    ['callbackMs', callbackMs, 2000],
    ['reconcileMs', reconcileMs, 2000],
  ] as const) {
    if (!Number.isInteger(value) || value < 1 || value > max) throw new TypeError(`Invalid ${name}`);
  }
  // Require finite caller configuration; do not alter the caller's defaults.
  for (const name of ['connectionTimeoutMillis', 'query_timeout', 'statement_timeout'] as const) {
    const value = options.pool.options[name];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 1 || value > 3000)
      throw new TypeError(`Set finite pool ${name} <=3000`);
  }
  const schema = `"${options.schema}"`;
  const channel = `${options.schema}_orders`;
  const hub = createNotificationHub(options.pool, {
    endpoint: options.endpoint,
    ownership: 'external',
    maxChannels: 1,
    maxSubscriptions: 8,
    reconnect: { initialDelayMs: 25, maxDelayMs: 250 },
    onError: onDiagnostic,
  });
  const db = new TurbineClient({ pool: options.pool, diagnostics: { advice: false } }, { tables: {}, enums: {} });
  const shutdown = new AbortController();
  const active = new Set<Promise<unknown>>();
  const outstanding = new Set<Promise<unknown>>();
  const watches = new Set<LiveQuery<number>>();
  let closing: Promise<void> | undefined;

  const admit = <T>(run: () => Promise<T>): Promise<T> => {
    if (shutdown.signal.aborted) return Promise.reject(new Error('Application is closing'));
    if (active.size >= 8) return Promise.reject(new Error('Application operation limit (8) exceeded'));
    const task = Promise.resolve().then(run);
    active.add(task);
    void task.then(
      () => active.delete(task),
      () => active.delete(task),
    );
    return task;
  };
  const local = async (client: PgCompatPoolClient) => {
    await client.query("SET LOCAL lock_timeout='2000ms'");
    await client.query("SET LOCAL statement_timeout='2500ms'");
    await client.query("SET LOCAL idle_in_transaction_session_timeout='5000ms'");
    await client.query('SET LOCAL synchronous_commit=on');
  };
  const columns = `tenant, position::text, event_id AS "eventId", order_id AS "orderId", title,
    quantity::text, amount::text,
    to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "occurredAt", body`;

  const app = {
    hub,
    channel,
    /** Cancelled callbacks that ignore their signal remain counted, but cannot delay close(). */
    get outstandingCallbacks() {
      return outstanding.size;
    },
    /** Run once in a fresh schema. Production uses reviewed versioned migrations instead. */
    initialize(): Promise<void> {
      return admit(() =>
        db.transaction(async (client) => {
          await local(client);
          await client.query(`CREATE SCHEMA ${schema}`);
          await client.query(`CREATE TABLE ${schema}.tenant_stream (
          tenant text PRIMARY KEY, position bigint NOT NULL CHECK(position>=0))`);
          await client.query(`CREATE TABLE ${schema}.orders (
          tenant text NOT NULL, order_id uuid NOT NULL, title text, quantity bigint NOT NULL,
          amount numeric NOT NULL, occurred_at timestamptz NOT NULL, body bytea NOT NULL,
          PRIMARY KEY(tenant,order_id))`);
          await client.query(`CREATE TABLE ${schema}.outbox (
          tenant text NOT NULL, position bigint NOT NULL, event_id uuid NOT NULL, order_id uuid NOT NULL,
          title text, quantity bigint NOT NULL, amount numeric NOT NULL, occurred_at timestamptz NOT NULL,
          body bytea NOT NULL, PRIMARY KEY(tenant,position), UNIQUE(tenant,event_id),
          FOREIGN KEY(tenant,order_id) REFERENCES ${schema}.orders(tenant,order_id))`);
          await client.query(`CREATE TABLE ${schema}.checkpoints (
          tenant text NOT NULL, consumer text NOT NULL, last_position bigint NOT NULL CHECK(last_position>=0),
          PRIMARY KEY(tenant,consumer))`);
        }),
      );
    },
    append(tenant: string, input: OrderCommand, requestSignal?: AbortSignal): Promise<OrderEvent> {
      scopeKey(tenant);
      const command = commandCopy(input);
      const signal = requestSignal ? AbortSignal.any([shutdown.signal, requestSignal]) : shutdown.signal;
      return admit(() =>
        db.transaction(async (client) => {
          signal.throwIfAborted();
          await local(client);
          await client.query(`INSERT INTO ${schema}.tenant_stream VALUES($1,0) ON CONFLICT DO NOTHING`, [tenant]);
          // Acquire the tenant lock BEFORE checking duplicates or allocating. Held until COMMIT/ROLLBACK.
          await client.query(`SELECT position FROM ${schema}.tenant_stream WHERE tenant=$1 FOR UPDATE`, [tenant]);
          const priorRow = (
            await client.query(`SELECT ${columns} FROM ${schema}.outbox WHERE tenant=$1 AND event_id=$2`, [
              tenant,
              command.eventId,
            ])
          ).rows[0];
          if (priorRow) {
            const prior = readEvent(priorRow);
            const same =
              prior.orderId === command.orderId &&
              prior.title === command.title &&
              prior.quantity === command.quantity &&
              prior.amount === command.amount &&
              prior.occurredAt === command.occurredAt &&
              prior.body.equals(command.body);
            if (!same) throw new Error('eventId reused with different order values');
            signal.throwIfAborted();
            return prior;
          }
          const position = (
            await client.query(
              `UPDATE ${schema}.tenant_stream SET position=position+1
          WHERE tenant=$1 RETURNING position::text`,
              [tenant],
            )
          ).rows[0]!.position as string;
          const values = [
            tenant,
            command.orderId,
            command.title,
            command.quantity,
            command.amount,
            command.occurredAt,
            command.body,
          ];
          await client.query(`INSERT INTO ${schema}.orders VALUES($1,$2,$3,$4,$5,$6,$7)`, values);
          await client.query(
            `INSERT INTO ${schema}.outbox
          (tenant,order_id,title,quantity,amount,occurred_at,body,position,event_id)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
            [...values, position, command.eventId],
          );
          await client.query('SELECT pg_notify($1,$2)', [channel, 'orders']);
          signal.throwIfAborted();
          return { ...command, tenant, position };
        }),
      );
    },
    consumeBatch(tenant: string, consumer: string, deliver: Deliver, requestSignal?: AbortSignal): Promise<number> {
      scopeKey(tenant);
      scopeKey(consumer);
      const key = `${schema}\0${tenant}\0${consumer}`;
      if (deliveryContext.getStore()?.has(key))
        return Promise.reject(new Error('Recursive drain of the same consumer refused'));
      const signal = requestSignal ? AbortSignal.any([shutdown.signal, requestSignal]) : shutdown.signal;
      return admit(() =>
        db.transaction(async (client) => {
          signal.throwIfAborted();
          await local(client);
          await client.query(`INSERT INTO ${schema}.checkpoints VALUES($1,$2,0) ON CONFLICT DO NOTHING`, [
            tenant,
            consumer,
          ]);
          const checkpoint = (
            await client.query(
              `SELECT last_position::text FROM ${schema}.checkpoints
          WHERE tenant=$1 AND consumer=$2 FOR UPDATE`,
              [tenant, consumer],
            )
          ).rows[0]!.last_position;
          const events = (
            await client.query(
              `SELECT ${columns} FROM ${schema}.outbox
          WHERE tenant=$1 AND position>$2::bigint ORDER BY position LIMIT $3`,
              [tenant, checkpoint, batchSize],
            )
          ).rows.map(readEvent);
          const acknowledgement = events.at(-1)?.position;
          // A deadline covers the WHOLE batch, rather than multiplying it by batchSize.
          const batchSignal = AbortSignal.any([signal, AbortSignal.timeout(callbackMs)]);
          for (const event of events) {
            const context = new Set(deliveryContext.getStore());
            context.add(key);
            // Never let a callback mutate the private acknowledgement position or a later callback's bytes.
            await deliveryContext.run(context, () =>
              deliverBounded(deliver, { ...event, body: Buffer.from(event.body) }, batchSignal, outstanding),
            );
          }
          signal.throwIfAborted();
          if (events.length)
            await client.query(
              `UPDATE ${schema}.checkpoints SET last_position=$3
          WHERE tenant=$1 AND consumer=$2`,
              [tenant, consumer, acknowledgement],
            );
          signal.throwIfAborted();
          return events.length;
        }),
      );
    },
    /** Coalescible progress observations only. consumeBatch's COMMIT, never a snapshot, acknowledges delivery. */
    watchProgress(tenant: string, consumer: string, deliver: Deliver, requestSignal?: AbortSignal): LiveQuery<number> {
      scopeKey(tenant);
      scopeKey(consumer);
      if (shutdown.signal.aborted) throw new Error('Application is closing');
      if (watches.size >= 8) throw new Error('Application watch limit (8) exceeded');
      const signal = requestSignal ? AbortSignal.any([shutdown.signal, requestSignal]) : shutdown.signal;
      let wake = () => {};
      const handle = liveQuery({
        signal,
        query: async (querySignal) => {
          const count = await app.consumeBatch(tenant, consumer, deliver, querySignal);
          if (count === batchSize) wake(); // Drain further pages without retaining an event queue.
          return count;
        },
        subscribe: async (invalidate) => {
          wake = invalidate;
          // Reconciliation starts before LISTEN readiness so it remains armed through reconnect gaps.
          const timer = setInterval(invalidate, reconcileMs);
          try {
            const subscription = await hub.subscribe(channel, invalidate, {
              signal,
              onResync: invalidate,
              onError: onDiagnostic,
            });
            return {
              async unsubscribe() {
                clearInterval(timer);
                await subscription.unsubscribe();
              },
            };
          } catch (error) {
            clearInterval(timer);
            if (signal.aborted) return { unsubscribe() {} };
            throw error;
          }
        },
      });
      watches.add(handle);
      void handle.closed.then(
        () => watches.delete(handle),
        () => watches.delete(handle),
      );
      return handle;
    },
    close(): Promise<void> {
      if (closing) return closing;
      shutdown.abort();
      closing = (async () => {
        const results = await Promise.allSettled([...watches].map((handle) => handle.dispose()));
        await Promise.allSettled([...active]); // SQL and callback awaits have finite call-site bounds.
        try {
          await hub.close();
        } catch (reason) {
          results.push({ status: 'rejected', reason });
        }
        try {
          await db.disconnect();
        } catch (reason) {
          results.push({ status: 'rejected', reason });
        }
        const failures = results.flatMap((result) => (result.status === 'rejected' ? [result.reason] : []));
        if (failures.length) throw new AggregateError(failures, 'Order application close failed');
      })();
      return closing;
    },
  };
  return app;
}
