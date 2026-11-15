import { AsyncLocalStorage } from 'node:async_hooks';
import type { Duplex } from 'node:stream';
import mysql from 'mysql2';
import type { Pool, PoolConnection, ConnectionOptions } from 'mysql2/promise';
import type { SchemaMetadata, TransactionClient } from 'turbine-orm';
import { MysqlPool, turbineMysql } from 'turbine-orm/mysql';

export interface OrderCommand {
  eventId: string;
  orderId: string;
  title: string | null;
  quantity: string;
  amount: string;
  occurredAt: string;
  body: Buffer;
}
export interface OrderEvent extends OrderCommand {
  tenant: string;
  position: string;
}
export type Deliver = (event: OrderEvent, signal: AbortSignal) => void | PromiseLike<void>;
export class Unacknowledged extends Error {
  constructor(
    readonly uncertain: boolean,
    cause: unknown,
  ) {
    super(uncertain ? 'Unacknowledged; reconcile dispatched writes before retry' : 'Unacknowledged', { cause });
  }
}
const MAX = 9223372036854775807n;
const registryKey = Symbol.for('turbine.example.mysql.order-replay.v1');
const globalRegistry = globalThis as typeof globalThis & { [registryKey]?: AsyncLocalStorage<ReadonlySet<string>> };
const deliveryContext = (globalRegistry[registryKey] ??= new AsyncLocalStorage<ReadonlySet<string>>());
const key = (value: string) => {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(value)) throw new TypeError('Invalid scope/ID');
  return value;
};
const bound = (value: number, max: number) => {
  if (!Number.isFinite(value) || !Number.isSafeInteger(value) || value < 1 || value > max)
    throw new TypeError('Invalid finite bound');
  return value;
};
export function capture(input: OrderCommand): OrderCommand {
  const c = {
    eventId: input.eventId,
    orderId: input.orderId,
    title: input.title,
    quantity: input.quantity,
    amount: input.amount,
    occurredAt: input.occurredAt,
    body: input.body,
  };
  key(c.eventId);
  key(c.orderId);
  if (typeof c.quantity !== 'string' || !/^(0|[1-9][0-9]{0,18})$/.test(c.quantity) || BigInt(c.quantity) > MAX)
    throw new TypeError('quantity exceeds signed BIGINT');
  if (typeof c.amount !== 'string' || !/^(0|[1-9][0-9]{0,29})(\.[0-9]{1,12})?$/.test(c.amount))
    throw new TypeError('Invalid exact decimal text');
  if (typeof c.occurredAt !== 'string' || !/^[1-9][0-9]{3}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/.test(c.occurredAt))
    throw new TypeError('Invalid exact timestamp');
  const ms = `${c.occurredAt.slice(0, 23)}Z`;
  if (!Number.isFinite(Date.parse(ms)) || new Date(ms).toISOString() !== ms) throw new TypeError('Invalid date');
  if (c.title !== null && (typeof c.title !== 'string' || Buffer.from(c.title).toString() !== c.title))
    throw new TypeError('Invalid UTF-8 title');
  if (!Buffer.isBuffer(c.body) || c.body.length + Buffer.byteLength(c.title ?? '') > 65536)
    throw new TypeError('Combined title/body exceeds 65536 bytes');
  return { ...c, body: Buffer.from(c.body) };
}
const payload = (c: OrderCommand) =>
  JSON.stringify([c.eventId, c.orderId, c.title, c.quantity, c.amount, c.occurredAt, c.body.toString('hex')]);
const columns =
  'tenant, CAST(position AS CHAR) AS position, event_id AS eventId, order_id AS orderId, title, CAST(quantity AS CHAR) AS quantity, amount, occurred_at AS occurredAt, body';
function read(row: Record<string, unknown>): OrderEvent {
  for (const name of ['tenant', 'position', 'eventId', 'orderId', 'quantity', 'amount', 'occurredAt'])
    if (typeof row[name] !== 'string') throw new TypeError(`Unexpected ${name}`);
  const position = row.position as string;
  if (!/^[1-9][0-9]{0,18}$/.test(position) || BigInt(position) > MAX) throw new TypeError('Invalid position');
  return { ...capture(row as unknown as OrderCommand), tenant: key(row.tenant as string), position };
}
const projectionMetadata: SchemaMetadata = {
  enums: {},
  tables: {
    mail_projection: {
      name: 'mail_projection',
      columns: ['tenant', 'consumer', 'delivered'].map((name) => ({
        name,
        field: name,
        pgType: name === 'delivered' ? 'int' : 'varchar',
        tsType: name === 'delivered' ? 'number' : 'string',
        nullable: false,
        hasDefault: false,
        isArray: false,
        pgArrayType: '',
      })),
      columnMap: { tenant: 'tenant', consumer: 'consumer', delivered: 'delivered' },
      reverseColumnMap: { tenant: 'tenant', consumer: 'consumer', delivered: 'delivered' },
      dateColumns: new Set(),
      pgTypes: { tenant: 'varchar', consumer: 'varchar', delivered: 'int' },
      allColumns: ['tenant', 'consumer', 'delivered'],
      primaryKey: ['tenant', 'consumer'],
      uniqueColumns: [],
      relations: {},
      indexes: [],
    },
  },
};
const fields = `tenant VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  order_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, title MEDIUMTEXT,
  quantity BIGINT NOT NULL, amount VARCHAR(43) CHARACTER SET ascii NOT NULL,
  occurred_at VARCHAR(27) CHARACTER SET ascii NOT NULL, body MEDIUMBLOB NOT NULL`;
export const ddl = [
  'CREATE TABLE tenant_stream (tenant VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY, position BIGINT NOT NULL CHECK(position>=0)) ENGINE=InnoDB',
  `CREATE TABLE orders (${fields}, PRIMARY KEY(tenant,order_id)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE outbox (${fields}, position BIGINT NOT NULL CHECK(position>0), event_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    PRIMARY KEY(tenant,position), UNIQUE(tenant,event_id), FOREIGN KEY(tenant,order_id) REFERENCES orders(tenant,order_id)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  'CREATE TABLE checkpoints (tenant VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, consumer VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, last_position BIGINT NOT NULL CHECK(last_position>=0), PRIMARY KEY(tenant,consumer)) ENGINE=InnoDB',
  'CREATE TABLE inbox (tenant VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, consumer VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, event_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, payload MEDIUMBLOB NOT NULL, PRIMARY KEY(tenant,consumer,event_id)) ENGINE=InnoDB',
  'CREATE TABLE mail_projection (tenant VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, consumer VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, delivered INT NOT NULL CHECK(delivered>=0), PRIMARY KEY(tenant,consumer)) ENGINE=InnoDB',
];

interface Operation {
  signal: AbortSignal;
  wrote: boolean;
  commit: boolean;
  rollback: boolean;
}
/** A private app adapter. Never mutates a caller pool's config or session defaults. */
function leases(pool: Pool, sqlMs: number) {
  const context = new AsyncLocalStorage<Operation>();
  const acquisitions = new Set<Promise<unknown>>();
  const sqlSettlements = new Set<Promise<unknown>>();
  const config = pool.pool.config as unknown as {
    connectionConfig: ConnectionOptions;
    waitForConnections: boolean;
    connectionLimit: number;
  };
  const cc = config.connectionConfig;
  const utf8mb4 = (charset: number | undefined) =>
    Object.entries(mysql.Charsets).some(([name, value]) => name.startsWith('UTF8MB4_') && value === charset);
  if (!utf8mb4(cc.charsetNumber)) throw new TypeError('Caller pool requires UTF-8 utf8mb4 encoding');
  if (
    config.waitForConnections !== false ||
    !Number.isSafeInteger(config.connectionLimit) ||
    config.connectionLimit < 1 ||
    config.connectionLimit > 8 ||
    cc.namedPlaceholders !== true ||
    cc.supportBigNumbers !== true ||
    cc.bigNumberStrings !== true ||
    cc.multipleStatements ||
    cc.rowsAsArray ||
    cc.typeCast !== true ||
    (!cc.socketPath && cc.host !== '127.0.0.1') ||
    !Number.isSafeInteger(cc.connectTimeout) ||
    typeof cc.connectTimeout !== 'number' ||
    cc.connectTimeout < 1 ||
    cc.connectTimeout > 1500
  )
    throw new TypeError('Caller pool requires bounded, nonqueued exact-value settings');
  async function acquire() {
    if (acquisitions.size >= 8) throw new Error('Pending acquisition cap');
    const op = context.getStore();
    op?.signal.throwIfAborted();
    const pending = pool.getConnection();
    acquisitions.add(pending);
    let timer: ReturnType<typeof setTimeout>;
    let abort = () => {};
    let abandoned = false,
      received: PoolConnection | undefined,
      released = false;
    const releaseLate = () => {
      if (received && !released) {
        released = true;
        received.release();
      }
    };
    void pending.then(
      (c) => {
        acquisitions.delete(pending);
        received = c;
        if (abandoned) releaseLate();
      },
      () => acquisitions.delete(pending),
    );
    try {
      return await Promise.race([
        pending,
        new Promise<never>((_, reject) => {
          abort = () => reject(op!.signal.reason);
          op?.signal.addEventListener('abort', abort, { once: true });
          timer = setTimeout(() => reject(new Error('Acquisition deadline')), 1500);
        }),
      ]);
    } catch (e) {
      abandoned = true;
      releaseLate();
      throw e;
    } finally {
      clearTimeout(timer!);
      op?.signal.removeEventListener('abort', abort);
    }
  }
  async function getConnection() {
    const c = await acquire();
    const native = c.connection as unknown as {
      stream: Duplex;
      config: ConnectionOptions;
      clientEncoding: string;
    };
    if (!utf8mb4(native.config.charsetNumber) || native.clientEncoding !== 'utf8') {
      c.release();
      throw new TypeError('Native caller lease requires UTF-8 utf8mb4 encoding');
    }
    // mysql2 exposes the native connection on a promise lease. Terminate its
    // socket with an error so queued Prepare/Execute promises settle as well.
    const socket = native.stream;
    if (!socket || typeof socket.destroy !== 'function') {
      c.destroy();
      throw new Error('Native mysql2 lease required');
    }
    let dead = false;
    const op = context.getStore();
    const run = async (method: 'query' | 'execute', sql: string, values?: unknown): Promise<[unknown, unknown]> => {
      const rollback = /^ROLLBACK\b/i.test(sql);
      if (!rollback) op?.signal.throwIfAborted();
      if (dead) throw new Error('Lease destroyed');
      if (sqlSettlements.size >= 8) throw new Error('Unsettled SQL cap');
      const commit = /^COMMIT\b/i.test(sql);
      if (op && commit) op.commit = true;
      if (op && /^(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP)\b/i.test(sql)) op.wrote = true;
      let timer: ReturnType<typeof setTimeout>;
      const destroy = () => {
        if (dead) return;
        dead = true;
        socket.destroy(Object.assign(new Error('Application SQL lease terminated'), { code: 'APP_MYSQL_TERMINATED' }));
        c.destroy();
      };
      let abort = () => {};
      try {
        const native =
          method === 'query'
            ? c.query({ sql, timeout: sqlMs }, values as never)
            : c.execute({ sql, timeout: sqlMs }, values as never);
        sqlSettlements.add(native);
        void native.then(
          () => sqlSettlements.delete(native),
          () => sqlSettlements.delete(native),
        );
        const result = await Promise.race([
          native,
          new Promise<never>((_, reject) => {
            abort = () => {
              destroy();
              reject(op!.signal.reason);
            };
            if (!rollback) op?.signal.addEventListener('abort', abort, { once: true });
            timer = setTimeout(() => {
              destroy();
              reject(new Error('SQL deadline; connection destroyed'));
            }, sqlMs);
            if (!rollback && op?.signal.aborted) abort();
          }),
        ]);
        if (op && rollback) op.rollback = true;
        return result;
      } catch (e) {
        if ((e as { code?: string })?.code === 'PROTOCOL_SEQUENCE_TIMEOUT') destroy();
        throw e;
      } finally {
        clearTimeout(timer!);
        op?.signal.removeEventListener('abort', abort);
      }
    };
    return {
      query: (s: string, v?: unknown) => run('query', s, v),
      execute: (s: string, v?: unknown) => run('execute', s, v),
      release: () => {
        if (!dead) c.release();
      },
    };
  }
  const adapter = {
    getConnection,
    end: async () => {},
    query: async (s: string, v?: unknown) => {
      const c = await getConnection();
      try {
        return await c.query(s, v);
      } finally {
        c.release();
      }
    },
    execute: async (s: string, v?: unknown) => {
      const c = await getConnection();
      try {
        return await c.execute(s, v);
      } finally {
        c.release();
      }
    },
  };
  return { adapter, context, acquisitions, sqlSettlements };
}

export async function openOrderApplication(options: {
  pool: Pool;
  batchSize?: number;
  callbackMs?: number;
  sqlMs?: number;
  operationMs?: number;
}) {
  const pool = options.pool;
  const batchSize = bound(options.batchSize ?? 16, 32),
    callbackMs = bound(options.callbackMs ?? 1000, 2000);
  const sqlMs = bound(options.sqlMs ?? 2500, 3000),
    operationMs = bound(options.operationMs ?? 6000, 10000);
  const owned = leases(pool, sqlMs);
  const shim = new MysqlPool(owned.adapter);
  const empty = await turbineMysql(shim, projectionMetadata, { diagnostics: { advice: false } });
  // Every lease is validated before use, including after reconnect. No SET SESSION.
  const validate = async (tx: TransactionClient) => {
    const [s] = await tx.rawUnsafe<Record<string, unknown>>(`SELECT @@server_uuid AS uuid, DATABASE() AS db,
      @@session.transaction_isolation AS isolationLevel, @@autocommit AS autocommit,
      @@innodb_flush_log_at_trx_commit AS flushLog, @@sync_binlog AS syncBinlog, @@log_bin AS logBin,
      @@default_storage_engine AS engine, @@innodb_lock_wait_timeout AS rowWait,
      @@lock_wait_timeout AS metadataWait, @@max_execution_time AS selectMs,
      @@character_set_client AS clientCharset, @@character_set_connection AS connectionCharset,
      @@character_set_results AS resultCharset`);
    if (s?.clientCharset !== 'utf8mb4' || s.connectionCharset !== 'utf8mb4' || s.resultCharset !== 'utf8mb4')
      throw new Error('Caller session requires UTF-8 utf8mb4 client, connection and results encodings');
    if (
      !s ||
      s.isolationLevel !== 'REPEATABLE-READ' ||
      String(s.autocommit) !== '1' ||
      String(s.flushLog) !== '1' ||
      String(s.syncBinlog) !== '1' ||
      String(s.logBin) !== '1' ||
      s.engine !== 'InnoDB' ||
      typeof s.db !== 'string' ||
      typeof s.uuid !== 'string'
    )
      throw new Error('Required durability/isolation settings missing');
    bound(Number(s.rowWait), 2);
    bound(Number(s.metadataWait), 3);
    bound(Number(s.selectMs), 2500);
    return `${s.uuid}/${s.db}`;
  };
  const identity = await empty.$transaction(validate);
  const shutdown = new AbortController(),
    active = new Set<Promise<unknown>>(),
    callbacks = new Set<Promise<unknown>>();
  const appKey = `app:${identity}:${Math.random()}`;
  let closing: Promise<void> | undefined;
  function admit<T>(
    run: (tx: TransactionClient, signal: AbortSignal) => Promise<T>,
    request?: AbortSignal,
  ): Promise<T> {
    if (shutdown.signal.aborted) return Promise.reject(new Error('Application closing'));
    if (active.size >= 8) return Promise.reject(new Error('Operation cap'));
    const deadline = new AbortController();
    const signal = AbortSignal.any([shutdown.signal, deadline.signal, ...(request ? [request] : [])]);
    const timer = setTimeout(() => deadline.abort(new Error('Operation deadline')), operationMs);
    const op: Operation = { signal, wrote: false, commit: false, rollback: false };
    const task = owned.context.run(op, async () => {
      try {
        signal.throwIfAborted();
        return await empty.$transaction(async (tx) => {
          if ((await validate(tx)) !== identity) throw new Error('Database identity changed');
          const engines = await tx.rawUnsafe<{ ENGINE: string }>(
            "SELECT ENGINE FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN ('tenant_stream','orders','outbox','checkpoints','inbox','mail_projection')",
          );
          if (engines.some((r) => r.ENGINE !== 'InnoDB')) throw new Error('Application tables must use InnoDB');
          const result = await run(tx, signal);
          signal.throwIfAborted();
          return result;
        });
      } catch (e) {
        throw new Unacknowledged(op.commit || (op.wrote && !op.rollback), e);
      } finally {
        clearTimeout(timer);
      }
    });
    active.add(task);
    void task.then(
      () => active.delete(task),
      () => active.delete(task),
    );
    return task;
  }
  const app = {
    identity,
    get outstandingCallbacks() {
      return callbacks.size;
    },
    /** DDL implicitly commits on MySQL. Fresh database only; failed setup is not atomic. */
    initialize: async () => {
      for (const sql of ddl)
        await admit(async (tx) => {
          await tx.rawUnsafe(sql);
        });
    },
    append(tenant: string, input: OrderCommand, signal?: AbortSignal): Promise<OrderEvent> {
      key(tenant);
      const c = capture(input);
      return admit(async (tx) => {
        await tx.rawUnsafe('INSERT INTO tenant_stream VALUES($1,0) ON DUPLICATE KEY UPDATE tenant=tenant', ...[tenant]);
        const [stream] = await tx.rawUnsafe<{ position: string }>(
          'SELECT CAST(position AS CHAR) AS position FROM tenant_stream WHERE tenant=$1 FOR UPDATE',
          ...[tenant],
        );
        const [prior] = await tx.rawUnsafe<Record<string, unknown>>(
          `SELECT ${columns} FROM outbox WHERE tenant=$1 AND event_id=$2 FOR UPDATE`,
          ...[tenant, c.eventId],
        );
        if (prior) {
          const event = read(prior);
          if (payload(event) !== payload(c)) throw new Error('eventId mismatch');
          return event;
        }
        const position = BigInt(stream!.position) + 1n;
        if (position > MAX) throw new RangeError('Position overflow');
        await tx.rawUnsafe('UPDATE tenant_stream SET position=$2 WHERE tenant=$1', ...[tenant, position.toString()]);
        const values = [tenant, c.orderId, c.title, c.quantity, c.amount, c.occurredAt, c.body];
        await tx.rawUnsafe('INSERT INTO orders VALUES($1,$2,$3,$4,$5,$6,$7)', ...values);
        await tx.rawUnsafe(
          'INSERT INTO outbox(tenant,order_id,title,quantity,amount,occurred_at,body,position,event_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
          ...[...values, position.toString(), c.eventId],
        );
        return { ...c, tenant, position: position.toString() };
      }, signal);
    },
    consumeBatch(tenant: string, consumer: string, deliver: Deliver, request?: AbortSignal): Promise<number> {
      key(tenant);
      key(consumer);
      if (typeof deliver !== 'function') throw new TypeError('deliver required');
      const scope = `consumer:${identity}/${tenant}/${consumer}`;
      if (deliveryContext.getStore()?.has(scope)) return Promise.reject(new Error('Same-consumer reentry refused'));
      return admit(async (tx, signal) => {
        await tx.rawUnsafe(
          'INSERT INTO checkpoints VALUES($1,$2,0) ON DUPLICATE KEY UPDATE consumer=consumer',
          ...[tenant, consumer],
        );
        const [checkpoint] = await tx.rawUnsafe<{ position: string }>(
          'SELECT CAST(last_position AS CHAR) AS position FROM checkpoints WHERE tenant=$1 AND consumer=$2 FOR UPDATE',
          ...[tenant, consumer],
        );
        const events = (
          await tx.rawUnsafe<Record<string, unknown>>(
            `SELECT ${columns} FROM outbox WHERE tenant=$1 AND position>$2 ORDER BY position LIMIT $3 FOR SHARE`,
            ...[tenant, checkpoint!.position, batchSize],
          )
        ).map(read);
        const acknowledgement = events.at(-1)?.position;
        const stop = new AbortController(),
          timer = setTimeout(() => stop.abort(new Error('Callback deadline')), callbackMs);
        const batchSignal = AbortSignal.any([signal, stop.signal]);
        try {
          for (const event of events) {
            batchSignal.throwIfAborted();
            if (callbacks.size >= 8) throw new Error('Unsettled callback cap');
            const context = new Set(deliveryContext.getStore());
            context.add(scope);
            context.add(appKey);
            const callback = deliveryContext.run(context, () =>
              Promise.resolve().then(() => {
                batchSignal.throwIfAborted();
                return deliver({ ...event, body: Buffer.from(event.body) }, batchSignal);
              }),
            );
            callbacks.add(callback);
            void callback.then(
              () => callbacks.delete(callback),
              () => callbacks.delete(callback),
            );
            let abort = () => {};
            try {
              await Promise.race([
                callback,
                new Promise<never>((_, reject) => {
                  abort = () => reject(batchSignal.reason);
                  batchSignal.addEventListener('abort', abort, { once: true });
                  if (batchSignal.aborted) abort();
                }),
              ]);
              batchSignal.throwIfAborted();
            } finally {
              batchSignal.removeEventListener('abort', abort);
            }
          }
          batchSignal.throwIfAborted();
          if (acknowledgement)
            await tx.rawUnsafe(
              'UPDATE checkpoints SET last_position=$3 WHERE tenant=$1 AND consumer=$2',
              ...[tenant, consumer, acknowledgement],
            );
          batchSignal.throwIfAborted();
          return events.length;
        } finally {
          clearTimeout(timer);
        }
      }, request);
    },
    /** An actual durable, independently committed idempotent destination. */
    deliverToInbox(consumer: string, event: OrderEvent, signal?: AbortSignal): Promise<boolean> {
      key(consumer);
      const tenant = key(event.tenant),
        c = capture(event),
        bytes = Buffer.from(payload(c));
      return admit(async (tx) => {
        // Projection row is the destination's serialization point, independent of checkpoints.
        await tx.rawUnsafe(
          'INSERT INTO mail_projection VALUES($1,$2,0) ON DUPLICATE KEY UPDATE consumer=consumer',
          ...[tenant, consumer],
        );
        await tx.rawUnsafe(
          'SELECT delivered FROM mail_projection WHERE tenant=$1 AND consumer=$2 FOR UPDATE',
          ...[tenant, consumer],
        );
        const [prior] = await tx.rawUnsafe<{ payload: Buffer }>(
          'SELECT payload FROM inbox WHERE tenant=$1 AND consumer=$2 AND event_id=$3 FOR UPDATE',
          ...[tenant, consumer, c.eventId],
        );
        if (prior) {
          if (!Buffer.isBuffer(prior.payload) || !prior.payload.equals(bytes))
            throw new Error('Destination eventId mismatch');
          return false;
        }
        await tx.rawUnsafe('INSERT INTO inbox VALUES($1,$2,$3,$4)', ...[tenant, consumer, c.eventId, bytes]);
        await tx.rawUnsafe(
          'UPDATE mail_projection SET delivered=delivered+1 WHERE tenant=$1 AND consumer=$2',
          ...[tenant, consumer],
        );
        return true;
      }, signal);
    },
    /** Explicit typed table API read, with bounded admission and the same lease protocol. */
    projection(tenant: string, consumer: string) {
      key(tenant);
      key(consumer);
      return admit(async (tx) => {
        return tx
          .table<{ tenant: string; consumer: string; delivered: number }>('mail_projection')
          .findMany({ where: { tenant, consumer }, limit: 1 });
      });
    },
    close(): Promise<void> {
      if (deliveryContext.getStore()?.has(appKey)) return Promise.reject(new Error('Close from callback refused'));
      if (closing) return closing;
      shutdown.abort(new Error('Application closing'));
      closing = (async () => {
        await Promise.allSettled([...active]);
        await Promise.allSettled([...owned.acquisitions]);
        await Promise.allSettled([...owned.sqlSettlements]);
        await empty.disconnect();
      })();
      return closing;
    },
  };
  return app;
}
