import { AsyncLocalStorage } from 'node:async_hooks';
import type { DatabaseSync } from 'node:sqlite';
import { type PgCompatPoolClient, SerializationFailureError } from 'turbine-orm';
import { turbineSqlite } from 'turbine-orm/sqlite';

export interface OrderCommand {
  tenant: string;
  eventId: string;
  orderId: string;
  title: string | null;
  quantity: string;
  amount: string;
  occurredAt: string;
  body: Uint8Array;
}

export interface OrderEvent extends OrderCommand {
  position: string;
}

export type Deliver = (event: OrderEvent, signal: AbortSignal) => void | Promise<void>;

export interface ReplayOptions {
  batchSize?: number;
  deadlineMs?: number;
  callbackLimit?: number;
}

/** Only this error certifies that no application/effect callback ran. */
export class AdmissionBusyError extends Error {
  constructor(cause: unknown) {
    super('SQLite writer admission is busy; retry explicitly with a finite policy.', { cause });
    this.name = 'AdmissionBusyError';
  }
}

/** Fixed append only: never accepts or automatically retries a delivery callback. */
export async function appendWithAdmissionRetry(app: SqliteOrderReplay, input: OrderCommand,
  signal: AbortSignal): Promise<OrderEvent> {
  const command = capture(input);
  for (let attempt = 0; ; attempt++) {
    signal.throwIfAborted();
    try { return await app.append(command, signal); }
    catch (error) {
      if (!(error instanceof AdmissionBusyError) || attempt === 3) throw error;
      await new Promise<void>((resolve, reject) => {
        const finish = () => { signal.removeEventListener('abort', abort); resolve(); };
        const timer = setTimeout(finish, 10);
        const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(signal.reason); };
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      });
    }
  }
}

const MAX_POSITION = '9223372036854775807';
interface Coordination { owners: WeakSet<DatabaseSync>; deliveryContext: AsyncLocalStorage<string> }
// The example's ESM/CJS copies must share handle ownership and callback context.
const registry = globalThis as unknown as Record<symbol, Coordination | undefined>;
const { owners, deliveryContext } = registry[Symbol.for('sqlite-order-replay.coordination')] ??=
  { owners: new WeakSet<DatabaseSync>(), deliveryContext: new AsyncLocalStorage<string>() };
const projection = `tenant, event_id, order_id, title, quantity, amount, occurred_at, body,
  CAST(position AS TEXT) AS position`;

// Fixed application schema, deliberately separate from generic decoder policy.
export const statements = [
  'CREATE TABLE replay_admission (id INTEGER NOT NULL PRIMARY KEY CHECK(id=1)) STRICT',
  'INSERT INTO replay_admission VALUES (1)',
  `CREATE TABLE replay_stream (tenant TEXT NOT NULL PRIMARY KEY,
    position INTEGER NOT NULL CHECK(position>=0)) STRICT`,
  `CREATE TABLE replay_orders (tenant TEXT NOT NULL, order_id TEXT NOT NULL,
    event_id TEXT NOT NULL, title TEXT, quantity TEXT NOT NULL, amount TEXT NOT NULL,
    occurred_at TEXT NOT NULL, body BLOB NOT NULL, PRIMARY KEY(tenant,order_id)) STRICT`,
  `CREATE TABLE replay_outbox (tenant TEXT NOT NULL, position INTEGER NOT NULL CHECK(position>0),
    event_id TEXT NOT NULL, order_id TEXT NOT NULL, title TEXT, quantity TEXT NOT NULL,
    amount TEXT NOT NULL, occurred_at TEXT NOT NULL, body BLOB NOT NULL,
    PRIMARY KEY(tenant,position), UNIQUE(tenant,event_id)) STRICT`,
  `CREATE TABLE replay_checkpoints (tenant TEXT NOT NULL, consumer TEXT NOT NULL,
    position INTEGER NOT NULL CHECK(position>=0), PRIMARY KEY(tenant,consumer)) STRICT`,
] as const;

function text(value: unknown, name: string, limit: number): string {
  if (typeof value !== 'string' || Buffer.from(value).toString('utf8') !== value || value.includes('\0') || Buffer.byteLength(value) > limit)
    throw new TypeError(`Invalid ${name}`);
  return value;
}

function key(value: unknown, name: string): string {
  const result = text(value, name, 128);
  if (!result.length) throw new TypeError(`Empty ${name}`);
  return result;
}

function integerOption(value: number | undefined, fallback: number, max: number): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1 || result > max) throw new TypeError('Invalid replay bound');
  return result;
}

function capture(input: OrderCommand): OrderCommand {
  // Read every caller property once, and copy bytes before any await.
  const { tenant, eventId, orderId, title, quantity, amount, occurredAt, body } = input;
  const command = {
    tenant: key(tenant, 'tenant'),
    eventId: key(eventId, 'eventId'),
    orderId: key(orderId, 'orderId'),
    title: title === null ? null : text(title, 'title', 32768),
    quantity: text(quantity, 'quantity', 30),
    amount: text(amount, 'amount', 43),
    occurredAt: text(occurredAt, 'occurredAt', 27),
    body: new Uint8Array(),
  };
  if (!/^(0|[1-9]\d{0,29})$/.test(command.quantity)) throw new TypeError('Invalid quantity');
  if (!/^(0|[1-9]\d{0,29})(\.\d{1,12})?$/.test(command.amount)) throw new TypeError('Invalid amount');
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/.test(command.occurredAt))
    throw new TypeError('Invalid occurredAt');
  const date = new Date(command.occurredAt);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== `${command.occurredAt.slice(0, 23)}Z`)
    throw new TypeError('Invalid calendar date');
  if (!(body instanceof Uint8Array) || body.byteLength > 32768) throw new TypeError('Invalid body');
  command.body = Uint8Array.from(body);
  return command;
}

function decode(row: Record<string, unknown>): OrderEvent {
  for (const name of ['tenant', 'event_id', 'order_id', 'quantity', 'amount', 'occurred_at', 'position'])
    if (typeof row[name] !== 'string') throw new TypeError(`Invalid stored ${name}`);
  if (row.title !== null && typeof row.title !== 'string') throw new TypeError('Invalid stored title');
  if (!(row.body instanceof Uint8Array)) throw new TypeError('Invalid stored body');
  const position = row.position as string;
  if (!/^[1-9]\d*$/.test(position) || BigInt(position) > BigInt(MAX_POSITION))
    throw new TypeError('Invalid stored position');
  return {
    ...capture({
      tenant: row.tenant as string,
      eventId: row.event_id as string,
      orderId: row.order_id as string,
      title: row.title as string | null,
      quantity: row.quantity as string,
      amount: row.amount as string,
      occurredAt: row.occurred_at as string,
      body: row.body,
    }),
    position,
  };
}

function sameCommand(a: OrderCommand, b: OrderCommand): boolean {
  return (
    a.tenant === b.tenant &&
    a.eventId === b.eventId &&
    a.orderId === b.orderId &&
    a.title === b.title &&
    a.quantity === b.quantity &&
    a.amount === b.amount &&
    a.occurredAt === b.occurredAt &&
    Buffer.from(a.body).equals(Buffer.from(b.body))
  );
}

/** A fixed application workflow. The caller owns and cooperatively lends its handle. */
export class SqliteOrderReplay {
  readonly #db: ReturnType<typeof turbineSqlite>;
  readonly #handle: DatabaseSync;
  readonly #path: string;
  readonly #batch: number;
  readonly #deadline: number;
  readonly #callbackLimit: number;
  #closed = false;
  #released = false;
  readonly #shutdown = new AbortController();
  #active: { controller: AbortController; done: Promise<void> } | undefined;
  #outstanding = 0;
  #pollers = 0;

  constructor(handle: DatabaseSync, options: ReplayOptions = {}) {
    this.#batch = integerOption(options.batchSize, 8, 32);
    this.#deadline = integerOption(options.deadlineMs, 250, 1000);
    this.#callbackLimit = integerOption(options.callbackLimit, 2, 8);
    if (owners.has(handle)) throw new Error('Handle already has an application owner');
    if (handle.isTransaction) throw new Error('Caller transaction must finish before lending the handle');
    const path = handle.prepare('PRAGMA database_list').all().find((row) => row.name === 'main')?.file;
    if (typeof path !== 'string' || !path.length) throw new Error('Replay needs a persistent file database');
    if (handle.prepare('PRAGMA journal_mode').get()?.journal_mode !== 'wal') throw new Error('WAL is required');
    if (handle.prepare('PRAGMA synchronous').get()?.synchronous !== 2) throw new Error('FULL is required');
    if (handle.prepare('PRAGMA busy_timeout').get()?.timeout !== 0) throw new Error('busy_timeout=0 is required');
    this.#path = path;
    this.#handle = handle;
    this.#db = turbineSqlite(handle, { tables: {}, enums: {} }, { logger: {}, busyTimeoutMs: 0 });
    owners.add(handle);
  }

  get outstandingCallbacks(): number {
    return this.#outstanding;
  }

  async #run<T>(signal: AbortSignal | undefined, body: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (deliveryContext.getStore() === this.#path) throw new Error('Delivery callback cannot reenter this database');
    if (this.#closed) throw new Error('Replay is closed');
    if (this.#active) throw new Error('Application handle is already active');
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    let done!: () => void;
    this.#active = { controller, done: new Promise<void>((resolve) => { done = resolve; }) };
    const timer = setTimeout(() => controller.abort(new Error('Replay deadline exceeded')), this.#deadline);
    try {
      controller.signal.throwIfAborted();
      const result = await body(controller.signal);
      // A cancellation here may race a dispatched COMMIT. Read durable state on retry.
      controller.signal.throwIfAborted();
      return result;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      this.#active = undefined;
      done();
      this.#releaseIfIdle();
    }
  }

  async #write<T>(signal: AbortSignal, body: (tx: PgCompatPoolClient) => Promise<T>): Promise<T> {
    return this.#db.transaction(async (tx) => {
      signal.throwIfAborted();
      try {
        // FIRST statement after BEGIN: acquire the native database writer before reading.
        const admission = await tx.query('UPDATE replay_admission SET id=id WHERE id=1 RETURNING id');
        if (admission.rows.length !== 1) throw new Error('Missing writer admission row');
      } catch (error) {
        if (error instanceof SerializationFailureError) throw new AdmissionBusyError(error);
        throw error;
      }
      signal.throwIfAborted();
      const result = await body(tx);
      signal.throwIfAborted();
      return result;
    });
  }

  /** Fresh database only. Existing tables cause refusal; there is no reset. */
  initialize(signal?: AbortSignal): Promise<void> {
    return this.#run(signal, (s) => this.#db.transaction(async (tx) => {
      for (const statement of statements) {
        s.throwIfAborted();
        await tx.query(statement);
      }
      s.throwIfAborted();
    }));
  }

  async append(input: OrderCommand, signal?: AbortSignal): Promise<OrderEvent> {
    const command = capture(input);
    return this.#run(signal, (s) => this.#write(s, async (tx) => {
      const existing = (await tx.query(`SELECT ${projection} FROM replay_outbox WHERE tenant=$1 AND event_id=$2`,
        [command.tenant, command.eventId])).rows;
      if (existing.length) {
        const event = decode(existing[0]!);
        if (!sameCommand(event, command)) throw new Error('Conflicting immutable event identity');
        return event;
      }
      await tx.query('INSERT INTO replay_stream VALUES($1,0) ON CONFLICT(tenant) DO NOTHING', [command.tenant]);
      // Guard BEFORE addition. SQLite would otherwise promote an overflowing INTEGER to REAL.
      const allocated = (await tx.query(`UPDATE replay_stream SET position=position+1
        WHERE tenant=$1 AND position<9223372036854775807 RETURNING CAST(position AS TEXT) AS position`,
        [command.tenant])).rows;
      if (allocated.length !== 1) throw new Error('Tenant position exhausted');
      const position = allocated[0]!.position as string;
      const values = [command.tenant, command.orderId, command.eventId, command.title,
        command.quantity, command.amount, command.occurredAt, command.body];
      await tx.query(`INSERT INTO replay_orders
        (tenant,order_id,event_id,title,quantity,amount,occurred_at,body) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, values);
      await tx.query(`INSERT INTO replay_outbox
        (tenant,order_id,event_id,title,quantity,amount,occurred_at,body,position)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,CAST($9 AS INTEGER))`, [...values, position]);
      return { ...command, body: Uint8Array.from(command.body), position };
    }));
  }

  async #deliver(deliver: Deliver, event: OrderEvent, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (this.#outstanding >= this.#callbackLimit) throw new Error('Unsettled callback limit reached');
    this.#outstanding++;
    const pending = deliveryContext.run(this.#path, async () => deliver({ ...event, body: Uint8Array.from(event.body) }, signal));
    // Observe both outcomes and count ignored cancellations until actual settlement.
    const settled = pending.then(
      () => { this.#settled(); },
      (error: unknown) => { this.#settled(); throw error; },
    );
    let onAbort!: () => void;
    const cancelled = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(signal.reason);
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
    try {
      await Promise.race([settled, cancelled]);
      signal.throwIfAborted();
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  }

  #settled(): void {
    this.#outstanding--;
    this.#releaseIfIdle();
  }

  #releaseIfIdle(): void {
    if (this.#closed && !this.#active && this.#outstanding === 0 && !this.#released) {
      owners.delete(this.#handle);
      this.#released = true;
    }
  }

  consumeBatch(tenantInput: string, consumerInput: string, deliver: Deliver, signal?: AbortSignal): Promise<number> {
    const tenant = key(tenantInput, 'tenant'), consumer = key(consumerInput, 'consumer');
    if (typeof deliver !== 'function') throw new TypeError('A delivery callback is required');
    return this.#run(signal, (s) => this.#write(s, async (tx) => {
      await tx.query('INSERT INTO replay_checkpoints VALUES($1,$2,0) ON CONFLICT(tenant,consumer) DO NOTHING',
        [tenant, consumer]);
      const rows = (await tx.query(`SELECT ${projection} FROM replay_outbox
        WHERE tenant=$1 AND position>(SELECT position FROM replay_checkpoints WHERE tenant=$1 AND consumer=$2)
        ORDER BY position ASC LIMIT $3`, [tenant, consumer, this.#batch])).rows;
      // Decode the complete bounded page before callback code sees a copy.
      const events = rows.map((row: Record<string, unknown>) => decode(row));
      for (const event of events) await this.#deliver(deliver, event, s);
      s.throwIfAborted();
      const last = events.at(-1)?.position;
      if (last !== undefined) await tx.query(`UPDATE replay_checkpoints SET position=CAST($3 AS INTEGER)
        WHERE tenant=$1 AND consumer=$2`, [tenant, consumer, last]);
      s.throwIfAborted();
      return events.length;
    }));
  }

  checkpoint(tenantInput: string, consumerInput: string, signal?: AbortSignal): Promise<string> {
    const tenant = key(tenantInput, 'tenant'), consumer = key(consumerInput, 'consumer');
    return this.#run(signal, async (s) => {
      const rows = await this.#db.rawUnsafe<{ position: string }>(
        'SELECT CAST(position AS TEXT) AS position FROM replay_checkpoints WHERE tenant=$1 AND consumer=$2',
        tenant, consumer);
      s.throwIfAborted();
      return rows[0]?.position ?? '0';
    });
  }

  /** Local polling only. Each count observes a committed batch; ignoring it cannot undo ack. */
  async *reconcile(tenant: string, consumer: string, deliver: Deliver, signal: AbortSignal,
    intervalMs = 100): AsyncGenerator<number> {
    const interval = integerOption(intervalMs, 100, 1000);
    if (this.#closed) throw new Error('Replay is closed');
    if (this.#pollers >= 2) throw new Error('Reconciliation handle limit reached');
    this.#pollers++;
    try {
    while (!signal.aborted && !this.#closed) {
      const count = await this.consumeBatch(tenant, consumer, deliver, signal);
      yield count;
      if (count === this.#batch) continue;
      await new Promise<void>((resolve) => {
        const finish = () => {
          clearTimeout(timer); signal.removeEventListener('abort', finish);
          this.#shutdown.signal.removeEventListener('abort', finish); resolve();
        };
        const timer = setTimeout(finish, interval);
        signal.addEventListener('abort', finish, { once: true });
        this.#shutdown.signal.addEventListener('abort', finish, { once: true });
        if (signal.aborted || this.#closed) finish();
      });
    }
    } finally { this.#pollers--; }
  }

  async close(): Promise<void> {
    if (deliveryContext.getStore() === this.#path) throw new Error('Delivery callback cannot close this database');
    this.#closed = true;
    this.#shutdown.abort();
    const active = this.#active;
    active?.controller.abort(new Error('Replay closed'));
    await active?.done;
    // Does not wait for arbitrary external callback promises or close the caller handle.
    // Retain the handle lease until ignored callbacks settle, so a new owner cannot hide them.
    this.#releaseIfIdle();
  }
}
