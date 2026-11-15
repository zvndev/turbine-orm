/** Finite application protocol. The caller owns D1 and its runtime. */
import type { D1DatabaseBinding, D1Result, D1Statement } from 'turbine-orm/d1';
import { migrateD1 } from 'turbine-orm/d1/migrate';

export const ddl = [
  'CREATE TABLE replay_heads(tenant TEXT PRIMARY KEY, position INTEGER NOT NULL CHECK(position BETWEEN 0 AND 1000000)) STRICT',
  'CREATE TABLE replay_orders(tenant TEXT NOT NULL, order_id TEXT NOT NULL, event_id TEXT NOT NULL, captured TEXT NOT NULL, PRIMARY KEY(tenant,order_id), UNIQUE(tenant,event_id)) STRICT',
  'CREATE TABLE replay_events(tenant TEXT NOT NULL, position INTEGER NOT NULL CHECK(position BETWEEN 1 AND 1000000), event_id TEXT NOT NULL, captured TEXT NOT NULL, PRIMARY KEY(tenant,position), UNIQUE(tenant,event_id)) STRICT',
  'CREATE TABLE replay_checkpoints(tenant TEXT NOT NULL, consumer TEXT NOT NULL, position INTEGER NOT NULL CHECK(position BETWEEN 0 AND 1000000), PRIMARY KEY(tenant,consumer)) STRICT',
  'CREATE TABLE replay_destination(tenant TEXT NOT NULL, consumer TEXT NOT NULL, event_id TEXT NOT NULL, position INTEGER NOT NULL, captured TEXT NOT NULL, PRIMARY KEY(tenant,consumer,event_id), UNIQUE(tenant,consumer,position)) STRICT',
] as const;

/** Setup only. Never used as an application transaction API. */
export async function initialize(binding: D1DatabaseBinding) {
  // Establish the lazy local binding before migration schema snapshot admission.
  await binding.prepare('SELECT 1 AS ready').all();
  return migrateD1(binding, [{ id: '0001_d1_replay', statements: ddl }]);
}

export interface Command {
  eventId: string;
  orderId: string;
  quantity: string;
  amount: string;
  occurredAt: string;
  title: string | null;
  body: Uint8Array;
}
export interface Event extends Command {
  tenant: string;
  position: number;
}
export interface Options {
  signal?: AbortSignal;
  timeoutMs?: number;
}
export class UnknownOutcome extends Error {
  readonly outcome = 'unknown';
  constructor(cause: unknown) {
    super('D1 was dispatched; reconcile stable ID/history before deciding whether to retry.', { cause });
    this.name = 'UnknownOutcome';
  }
}
export class Conflict extends Error {}
export class Stopped extends Error {}
const encoder = new TextEncoder();
const id = (value: unknown): string => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(value)) throw new TypeError('Invalid key');
  return value;
};
const finite = (value: number, min: number, max: number): number => {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new TypeError('Invalid finite bound');
  return value;
};
export function capture(input: Command): Command {
  const { eventId, orderId, quantity, amount, occurredAt, title, body } = input;
  id(eventId);
  id(orderId);
  if (
    typeof quantity !== 'string' ||
    !/^(0|[1-9][0-9]{0,18})$/.test(quantity) ||
    BigInt(quantity) > 9223372036854775807n
  )
    throw new TypeError('quantity must be canonical nonnegative int64 text');
  if (typeof amount !== 'string' || !/^(0|[1-9][0-9]{0,29})\.[0-9]{12}$/.test(amount))
    throw new TypeError('amount must be fixed scale 12 decimal text');
  if (
    typeof occurredAt !== 'string' ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/.test(occurredAt) ||
    !Number.isFinite(Date.parse(occurredAt)) ||
    new Date(occurredAt).toISOString() !== `${occurredAt.slice(0, 23)}Z`
  )
    throw new TypeError('occurredAt must be valid UTC microsecond text');
  if (
    title !== null &&
    (typeof title !== 'string' ||
      new TextDecoder().decode(encoder.encode(title)) !== title ||
      encoder.encode(title).length > 4096)
  )
    throw new TypeError('title exceeds UTF-8 bound');
  if (!(body instanceof Uint8Array) || body.byteLength > 16384) throw new TypeError('body exceeds bound');
  const copied = new Uint8Array(body);
  return { eventId, orderId, quantity, amount, occurredAt, title, body: copied };
}
const encode = (c: Command) =>
  JSON.stringify([
    c.eventId,
    c.orderId,
    c.quantity,
    c.amount,
    c.occurredAt,
    c.title,
    Array.from(c.body, (b) => b.toString(16).padStart(2, '0')).join(''),
  ]);
function decode(tenant: string, position: number, text: string): Event {
  if (typeof text !== 'string' || encoder.encode(text).length > 65536) throw new Error('Captured event bound');
  const a = JSON.parse(text) as unknown[];
  if (
    !Array.isArray(a) ||
    a.length !== 7 ||
    typeof a[6] !== 'string' ||
    a[6].length > 32768 ||
    !/^(?:[0-9a-f]{2})*$/.test(a[6])
  )
    throw new Error('Corrupt captured event');
  const c = capture({
    eventId: a[0],
    orderId: a[1],
    quantity: a[2],
    amount: a[3],
    occurredAt: a[4],
    title: a[5],
    body: Uint8Array.from(a[6].match(/../g) ?? [], (s) => Number.parseInt(s, 16)),
  } as Command);
  if (encode(c) !== text) throw new Error('Noncanonical captured event');
  return { tenant, position: finite(position, 1, 1000000), ...c };
}
function rows(result: D1Result | undefined): Record<string, unknown>[] {
  if (
    result?.success !== true ||
    !Array.isArray(result.results) ||
    result.results.some((row) => !row || typeof row !== 'object' || Array.isArray(row)) ||
    !result.meta ||
    !Number.isSafeInteger(result.meta.changes) ||
    result.meta.changes < 0 ||
    !Number.isFinite(result.meta.duration) ||
    result.meta.duration < 0 ||
    !Number.isSafeInteger(result.meta.last_row_id) ||
    result.meta.last_row_id < 0
  )
    throw new Error('Malformed D1 response');
  return result.results;
}
function options(input: Options): Required<Pick<Options, 'timeoutMs'>> & Pick<Options, 'signal'> {
  const { timeoutMs = 2000, signal } = input;
  finite(timeoutMs, 1, 10000);
  if (signal !== undefined && !(signal instanceof AbortSignal)) throw new TypeError('Invalid AbortSignal');
  return { timeoutMs, signal };
}
// A false guard throws inside SQLite, rolling back the ENTIRE native batch.
const guard = (predicate: string, params: readonly unknown[]): D1Statement => ({
  sql: `SELECT CASE WHEN COALESCE((${predicate}),0) THEN 1 ELSE json_extract('invalid guard','$') END AS admitted`,
  params,
});
const cursorSql =
  'SELECT COALESCE((SELECT position FROM replay_checkpoints WHERE tenant=?1 AND consumer=?2),0) AS position';

export class ReplayApp {
  #closed = false;
  #active = 0;
  #callback = false;
  #delivering = false;
  #pending = new Set<Promise<unknown>>();
  constructor(private readonly binding: D1DatabaseBinding) {}
  get status() {
    return Object.freeze({ closed: this.#closed, active: this.#active, unsettled: this.#pending.size });
  }
  #track<T>(promise: Promise<T>): Promise<T> {
    this.#pending.add(promise);
    void promise.then(
      () => this.#pending.delete(promise),
      () => this.#pending.delete(promise),
    );
    return promise;
  }
  #capacity() {
    if (this.#pending.size >= 16) throw new Stopped('Unsettled operation bound reached');
  }
  #begin<T>(o: Options, action: (wait: <R>(p: Promise<R>) => Promise<R>, check: () => void) => Promise<T>): Promise<T> {
    if (this.#closed || this.#callback || this.#active >= 8)
      throw new Stopped('Closed, callback reentry or operation bound');
    const captured = options(o);
    const until = Date.now() + captured.timeoutMs;
    const check = () => {
      if (this.#closed || captured.signal?.aborted || Date.now() >= until)
        throw new Stopped('Closed, cancelled or deadline');
    };
    check();
    this.#capacity();
    const wait = <R extends unknown>(p: Promise<R>): Promise<R> =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => finish(false, new Stopped('Operation deadline')),
          Math.max(1, until - Date.now()),
        );
        const abort = () => finish(false, new Stopped('Cancelled; dispatched work cannot be aborted'));
        const finish = (success: boolean, value: unknown) => {
          clearTimeout(timer);
          captured.signal?.removeEventListener('abort', abort);
          if (success) resolve(value as R);
          else reject(value);
        };
        captured.signal?.addEventListener('abort', abort, { once: true });
        if (captured.signal?.aborted) abort();
        void p.then(
          (v) => finish(true, v),
          (e: unknown) => finish(false, e),
        );
      });
    // Option and signal getters may synchronously consume capacity or close this facade.
    if (this.#closed || this.#callback || this.#active >= 8)
      throw new Stopped('Closed, callback reentry or operation bound');
    this.#active++;
    return action(wait, check).finally(() => {
      this.#active--;
    });
  }
  #read(sql: string, params: readonly unknown[]) {
    this.#capacity();
    return this.#track(
      this.binding
        .prepare(sql)
        .bind(...params)
        .all(),
    );
  }
  async #batch(statements: readonly D1Statement[], wait: <R>(p: Promise<R>) => Promise<R>, check: () => void) {
    check();
    this.#capacity();
    if (statements.length > 8) throw new TypeError('Batch bound');
    // Preparation is pre-dispatch. From binding.batch invocation onwards every failure is unknown.
    const prepared = statements.map((s) => this.binding.prepare(s.sql).bind(...(s.params ?? [])));
    try {
      const result = await wait(this.#track(Promise.resolve(this.binding.batch<Record<string, unknown>>(prepared))));
      if (!Array.isArray(result) || result.length !== statements.length) throw new Error('Malformed D1 batch');
      for (const [index, item] of result.entries()) {
        const actual = rows(item);
        const expectedRows = statements[index]!.sql.startsWith('SELECT ') ? 1 : 0;
        if (actual.length !== expectedRows) throw new Error('Malformed D1 statement rows');
      }
      return result;
    } catch (cause) {
      throw new UnknownOutcome(cause);
    }
  }
  append(tenantInput: string, input: Command, o: Options = {}): Promise<Event> {
    const tenant = id(tenantInput),
      c = capture(input),
      captured = encode(c);
    return this.#begin(o, async (wait, check) => {
      const prior = rows(
        await wait(
          this.#read('SELECT position,captured FROM replay_events WHERE tenant=?1 AND event_id=?2', [
            tenant,
            c.eventId,
          ]),
        ),
      )[0];
      if (prior) {
        if (prior.captured !== captured) throw new Conflict('Stable event ID has different captured input');
        return decode(tenant, prior.position as number, captured);
      }
      const head = rows(
        await wait(
          this.#read('SELECT COALESCE((SELECT position FROM replay_heads WHERE tenant=?1),0) AS position', [tenant]),
        ),
      )[0];
      const before = finite(head?.position as number, 0, 999999),
        position = before + 1;
      const result = await this.#batch(
        [
          { sql: 'INSERT OR IGNORE INTO replay_heads VALUES(?1,0)', params: [tenant] },
          guard(
            '(SELECT position FROM replay_heads WHERE tenant=?1)=?2 AND NOT EXISTS(SELECT 1 FROM replay_events WHERE tenant=?1 AND event_id=?3)',
            [tenant, before, c.eventId],
          ),
          { sql: 'INSERT INTO replay_orders VALUES(?1,?2,?3,?4)', params: [tenant, c.orderId, c.eventId, captured] },
          { sql: 'INSERT INTO replay_events VALUES(?1,?2,?3,?4)', params: [tenant, position, c.eventId, captured] },
          { sql: 'UPDATE replay_heads SET position=?2 WHERE tenant=?1', params: [tenant, position] },
          {
            sql: 'SELECT position,captured FROM replay_events WHERE tenant=?1 AND event_id=?2',
            params: [tenant, c.eventId],
          },
        ],
        wait,
        check,
      );
      try {
        const confirmed = rows(result[5])[0];
        if (confirmed?.position !== position || confirmed.captured !== captured)
          throw new Error('Malformed append confirmation');
        return decode(tenant, position, captured);
      } catch (cause) {
        throw new UnknownOutcome(cause);
      }
    });
  }
  reconcile(tenantInput: string, input: Command, o: Options = {}): Promise<Event | null> {
    const tenant = id(tenantInput),
      c = capture(input),
      captured = encode(c);
    return this.#begin(o, async (wait) => {
      const prior = rows(
        await wait(
          this.#read('SELECT position,captured FROM replay_events WHERE tenant=?1 AND event_id=?2', [
            tenant,
            c.eventId,
          ]),
        ),
      )[0];
      if (!prior) return null; // A local observation. Absence does NOT resolve an outstanding dispatch.
      if (prior.captured !== captured) throw new Conflict('Stable event ID conflicts');
      return decode(tenant, prior.position as number, captured);
    });
  }
  checkpoint(tenantInput: string, consumerInput: string, o: Options = {}): Promise<number> {
    const tenant = id(tenantInput),
      consumer = id(consumerInput);
    return this.#begin(o, async (wait) =>
      finite(rows(await wait(this.#read(cursorSql, [tenant, consumer])))[0]?.position as number, 0, 1000000),
    );
  }
  deliver(
    tenantInput: string,
    consumerInput: string,
    callback: (events: Event[]) => unknown,
    input: Options & { limit?: number } = {},
  ): Promise<number> {
    const tenant = id(tenantInput),
      consumer = id(consumerInput);
    const { limit = 16, timeoutMs, signal } = input;
    finite(limit, 1, 32);
    if (typeof callback !== 'function') throw new TypeError('Callback required');
    if (this.#delivering) throw new Stopped('Delivery already active on this facade');
    const operation = this.#begin({ timeoutMs, signal }, async (wait, check) => {
      const before = finite(
        rows(await wait(this.#read(cursorSql, [tenant, consumer])))[0]?.position as number,
        0,
        1000000,
      );
      const read = rows(
        await wait(
          this.#read(
            'SELECT position,captured FROM replay_events WHERE tenant=?1 AND position>?2 ORDER BY position LIMIT ?3',
            [tenant, before, limit],
          ),
        ),
      );
      if (read.length > limit) throw new Error('Delivery response exceeds bound');
      if (read.length === 0) return before;
      // Private primitive state never aliases the callback's mutable objects or array.
      const last = before + read.length;
      const events = read.map((r, i) => {
        if (r.position !== before + i + 1 || typeof r.captured !== 'string')
          throw new Error('Noncontiguous/corrupt prefix');
        return decode(tenant, r.position, r.captured);
      });
      check();
      this.#capacity();
      this.#callback = true;
      let callbackPromise: Promise<unknown>;
      try {
        callbackPromise = this.#track(Promise.resolve(callback(events)));
      } catch (cause) {
        this.#callback = false;
        throw cause;
      }
      // Keep reentry blocked while an ignored cancellation leaves the callback outstanding.
      void callbackPromise.then(
        () => {
          this.#callback = false;
        },
        () => {
          this.#callback = false;
        },
      );
      await wait(callbackPromise);
      check();
      const result = await this.#batch(
        [
          { sql: 'INSERT OR IGNORE INTO replay_checkpoints VALUES(?1,?2,0)', params: [tenant, consumer] },
          guard(
            '(SELECT position FROM replay_checkpoints WHERE tenant=?1 AND consumer=?2)=?3 AND (SELECT count(*) FROM replay_events WHERE tenant=?1 AND position>?3 AND position<=?4)=?4-?3',
            [tenant, consumer, before, last],
          ),
          {
            sql: 'UPDATE replay_checkpoints SET position=?3 WHERE tenant=?1 AND consumer=?2',
            params: [tenant, consumer, last],
          },
          { sql: cursorSql, params: [tenant, consumer] },
        ],
        wait,
        check,
      );
      if (rows(result[3])[0]?.position !== last) throw new UnknownOutcome(new Error('Malformed ack confirmation'));
      return last;
    });
    this.#delivering = true;
    return operation.finally(() => {
      this.#delivering = false;
    });
  }
  /** Idempotent local destination, atomic under concurrent duplicate delivery. */
  applyDestination(consumerInput: string, input: Event, o: Options = {}): Promise<void> {
    const { tenant: tenantInput, position: pos } = input;
    const tenant = id(tenantInput),
      consumer = id(consumerInput),
      position = finite(pos, 1, 1000000),
      c = capture(input),
      captured = encode(c);
    return this.#begin(o, async (wait, check) => {
      await this.#batch(
        [
          guard(
            'NOT EXISTS(SELECT 1 FROM replay_destination WHERE tenant=?1 AND consumer=?2 AND event_id=?3 AND (position<>?4 OR captured<>?5))',
            [tenant, consumer, c.eventId, position, captured],
          ),
          {
            sql: 'INSERT OR IGNORE INTO replay_destination VALUES(?1,?2,?3,?4,?5)',
            params: [tenant, consumer, c.eventId, position, captured],
          },
          guard(
            'EXISTS(SELECT 1 FROM replay_destination WHERE tenant=?1 AND consumer=?2 AND event_id=?3 AND position=?4 AND captured=?5)',
            [tenant, consumer, c.eventId, position, captured],
          ),
        ],
        wait,
        check,
      );
    });
  }
  async close(timeoutMs = 100): Promise<{ settled: boolean; unsettled: number; active: number }> {
    finite(timeoutMs, 1, 10000);
    this.#closed = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.allSettled([...this.#pending]),
        new Promise<void>((r) => {
          timer = setTimeout(r, timeoutMs);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    return {
      settled: this.#pending.size === 0 && this.#active === 0,
      unsettled: this.#pending.size,
      active: this.#active,
    };
  }
}
