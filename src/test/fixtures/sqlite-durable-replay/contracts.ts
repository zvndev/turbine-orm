import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

// Repository test compilation stays rooted in src/. The actual example and
// installed positive/negative consumers are compiled separately with strict types.
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
type Deliver = (event: OrderEvent, signal: AbortSignal) => void | Promise<void>;
interface Application {
  outstandingCallbacks: number;
  initialize(signal?: AbortSignal): Promise<void>;
  append(input: OrderCommand, signal?: AbortSignal): Promise<OrderEvent>;
  consumeBatch(tenant: string, consumer: string, deliver: Deliver, signal?: AbortSignal): Promise<number>;
  checkpoint(tenant: string, consumer: string, signal?: AbortSignal): Promise<string>;
  reconcile(
    tenant: string,
    consumer: string,
    deliver: Deliver,
    signal: AbortSignal,
    interval?: number,
  ): AsyncGenerator<number>;
  close(): Promise<void>;
}
interface Exports {
  SqliteOrderReplay: new (
    raw: DatabaseSync,
    options?: { batchSize?: number; deadlineMs?: number; callbackLimit?: number },
  ) => Application;
  AdmissionBusyError: new (cause?: unknown) => Error;
  appendWithAdmissionRetry(app: Application, command: OrderCommand, signal: AbortSignal): Promise<OrderEvent>;
  initializeDestination(raw: DatabaseSync): void;
  recordEffect(raw: DatabaseSync, consumer: string, event: OrderEvent, signal: AbortSignal): void;
}
export async function loadApplication(): Promise<Exports> {
  const root = process.env.REPLAY_EXAMPLE_ROOT ?? resolve('examples/sqlite-durable-replay');
  const extension = process.env.REPLAY_EXAMPLE_ROOT ? 'js' : 'ts';
  const req = createRequire(join(process.cwd(), 'consumer.cjs'));
  const load = (name: string) =>
    process.env.REPLAY_FORMAT === 'cjs'
      ? Promise.resolve(req(join(root, `${name}.${extension}`)))
      : import(pathToFileURL(join(root, `${name}.${extension}`)).href);
  return { ...(await load('replay')), ...(await load('destination')) } as Exports;
}

export function open(path: string): DatabaseSync {
  const { DatabaseSync: Native } = createRequire(join(process.cwd(), 'consumer.cjs'))(
    'node:sqlite',
  ) as typeof import('node:sqlite');
  const raw = new Native(path);
  raw.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=0');
  return raw;
}

export function command(n: number, tenant = 'a'): OrderCommand {
  return {
    tenant,
    eventId: `event-${n}`,
    orderId: `order-${n}`,
    title: n % 2 ? null : `雪 ' " \\ ${n}`,
    quantity: '999999999999999999999999999999',
    amount: '123456789012345678901234567890.000000000001',
    occurredAt: '2024-02-29T23:59:59.123456Z',
    body: Uint8Array.from([0, 255, n]),
  };
}

function deferred() {
  let resolve!: () => void;
  return {
    promise: new Promise<void>((r) => {
      resolve = r;
    }),
    resolve: () => resolve(),
  };
}

async function rejected(promise: Promise<unknown>, reason: unknown) {
  const result = await promise.then(
    () => ({ ok: true as const }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  assert.equal(result.ok, false, 'Expected rejection, including falsy reasons');
  if (!result.ok) assert.equal(result.error, reason);
}

function stored(raw: DatabaseSync): OrderEvent[] {
  return raw
    .prepare(`SELECT tenant, event_id AS eventId, order_id AS orderId, title, quantity, amount,
    occurred_at AS occurredAt, body, CAST(position AS TEXT) AS position FROM replay_outbox ORDER BY tenant,position`)
    .all()
    .map((row) => ({ ...row, body: Uint8Array.from(row.body as Uint8Array) })) as unknown as OrderEvent[];
}

export async function runContracts(root: string): Promise<string[]> {
  const { SqliteOrderReplay, AdmissionBusyError, appendWithAdmissionRetry, initializeDestination, recordEffect } =
    await loadApplication();
  mkdirSync(root, { recursive: true });
  const path = join(root, 'orders.db'),
    destinationPath = join(root, 'effects.db');
  const raw = open(path),
    otherRaw = open(path),
    dest = open(destinationPath);
  let app = new SqliteOrderReplay(raw, { batchSize: 2, deadlineMs: 150, callbackLimit: 2 });
  const other = new SqliteOrderReplay(otherRaw, { batchSize: 2, deadlineMs: 150 });
  const groups: string[] = [];
  const pass = (name: string) => {
    groups.push(name);
    console.log(`contract: ${name}`);
  };
  try {
    await app.initialize();
    initializeDestination(dest);
    assert.throws(() => new SqliteOrderReplay(raw), /owner/);
    await assert.rejects(app.initialize(), /already exists/);
    const bad = open(join(root, 'bad.db'));
    try {
      bad.exec('PRAGMA busy_timeout=19');
      assert.throws(() => new SqliteOrderReplay(bad), /busy_timeout/);
      assert.equal(bad.prepare('PRAGMA busy_timeout').get()?.timeout, 19);
      bad.exec('PRAGMA busy_timeout=0;PRAGMA synchronous=NORMAL');
      assert.throws(() => new SqliteOrderReplay(bad), /FULL/);
      assert.equal(bad.prepare('PRAGMA synchronous').get()?.synchronous, 1);
      bad.exec('PRAGMA synchronous=FULL;PRAGMA journal_mode=DELETE');
      assert.throws(() => new SqliteOrderReplay(bad), /WAL/);
      assert.equal(bad.prepare('PRAGMA journal_mode').get()?.journal_mode, 'delete');
    } finally {
      bad.close();
    }
    pass('caller pragmas validated unchanged; same-handle owner and fresh-schema refusal');

    for (const option of ['batchSize', 'deadlineMs', 'callbackLimit'] as const) {
      for (const invalid of [
        Number.NaN,
        Number.POSITIVE_INFINITY,
        Number.NEGATIVE_INFINITY,
        0,
        -1,
        1.5,
        Number.MAX_VALUE,
      ]) {
        assert.throws(() => new SqliteOrderReplay(raw, { [option]: invalid }), /Invalid replay bound/);
      }
    }
    for (const invalid of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 0, -1, 1.5, 1001]) {
      await assert.rejects(
        app.reconcile('a', 'invalid-interval', () => {}, new AbortController().signal, invalid).next(),
        /Invalid replay bound/,
      );
    }

    for (const patch of [
      { title: '\ud800' },
      { title: '\0' },
      { quantity: '01' },
      { amount: '1e3' },
      { occurredAt: '2024-02-30T00:00:00.123456Z' },
      { body: new Uint8Array(32769) },
      { tenant: '' },
    ]) {
      await assert.rejects(app.append({ ...command(0), ...patch }), TypeError);
    }
    assert.deepEqual(stored(raw), []);

    const expected: OrderEvent[] = [];
    for (let n = 0; n < 5; n++) {
      const input = command(n),
        copy = { ...input, body: Uint8Array.from(input.body) };
      const getterReads: string[] = [];
      const getters = Object.fromEntries(
        Object.keys(input).map((k) => [
          k,
          {
            enumerable: true,
            get() {
              getterReads.push(k);
              return input[k as keyof OrderCommand];
            },
          },
        ]),
      );
      const pending = app.append(Object.defineProperties({}, getters) as OrderCommand);
      input.body.fill(17);
      input.title = 'mutated';
      const event = await pending;
      const oracle = { ...copy, position: String(n + 1) };
      assert.deepEqual(event, oracle);
      expected.push(oracle);
      assert.deepEqual(getterReads, Object.keys(copy));
      assert.deepEqual(await other.append(copy), oracle);
      for (const field of ['orderId', 'title', 'quantity', 'amount', 'occurredAt', 'body'] as const) {
        const changed = {
          ...copy,
          [field]:
            field === 'body'
              ? Uint8Array.of(1)
              : field === 'occurredAt'
                ? '2024-02-29T23:59:59.123457Z'
                : field === 'amount'
                  ? '1.00'
                  : field === 'quantity'
                    ? '1'
                    : 'different',
        };
        await assert.rejects(app.append(changed), /Conflicting/);
      }
    }
    assert.deepEqual(stored(raw), expected);
    assert.equal(raw.prepare('SELECT count(*) AS n FROM replay_orders').get()?.n, 5);
    // Direct independent business oracle checks all fields and bytes, not just counts.
    const orders = raw
      .prepare('SELECT * FROM replay_orders ORDER BY order_id')
      .all()
      .map((r) => ({
        tenant: r.tenant,
        eventId: r.event_id,
        orderId: r.order_id,
        title: r.title,
        quantity: r.quantity,
        amount: r.amount,
        occurredAt: r.occurred_at,
        body: Uint8Array.from(r.body as Uint8Array),
      }));
    assert.deepEqual(
      orders,
      expected.map(({ position: _position, ...event }) => event),
    );
    await app.append({ ...command(9, 'b'), body: new Uint8Array() });
    assert.deepEqual(stored(raw).at(-1)?.body, new Uint8Array());
    pass('complete input/getter/byte capture, exact duplicates, business and ordered outbox oracle');

    const before = stored(raw);
    await assert.rejects(app.append({ ...command(8), orderId: 'order-0' }), /UNIQUE/);
    assert.deepEqual(stored(raw), before);
    assert.equal(raw.prepare("SELECT position FROM replay_stream WHERE tenant='a'").get()?.position, 5);
    // Actual failure AFTER the business insert must leave neither partial effects nor allocation.
    raw.exec(`CREATE TRIGGER refuse_outbox BEFORE INSERT ON replay_outbox WHEN NEW.event_id='event-99'
      BEGIN SELECT RAISE(ABORT,'outbox refused'); END`);
    await assert.rejects(app.append(command(99)), /outbox refused/);
    assert.equal(raw.prepare("SELECT count(*) AS n FROM replay_orders WHERE event_id='event-99'").get()?.n, 0);
    assert.deepEqual(stored(raw), before);
    raw.exec('DROP TRIGGER refuse_outbox');
    pass('business conflict and post-business outbox fault roll back all writes and position');

    raw.exec("INSERT INTO replay_stream VALUES('wide',9007199254740991),('full',9223372036854775806)");
    assert.equal((await app.append(command(1, 'wide'))).position, '9007199254740992');
    assert.equal((await app.append(command(2, 'wide'))).position, '9007199254740993');
    assert.equal((await app.append(command(1, 'full'))).position, '9223372036854775807');
    await assert.rejects(app.append(command(2, 'full')), /position exhausted/);
    assert.equal(
      raw
        .prepare("SELECT typeof(position) AS kind,CAST(position AS TEXT) AS p FROM replay_stream WHERE tenant='full'")
        .get()?.p,
      '9223372036854775807',
    );
    assert.equal(
      raw.prepare("SELECT typeof(position) AS kind FROM replay_stream WHERE tenant='full'").get()?.kind,
      'integer',
    );
    pass('exact CAST-text positions beyond safe integers and pre-arithmetic int64 exhaustion');

    otherRaw.exec('BEGIN IMMEDIATE');
    try {
      await assert.rejects(app.append(command(0)), AdmissionBusyError);
      let callbacks = 0;
      await assert.rejects(
        app.consumeBatch('a', 'locked', () => {
          callbacks++;
        }),
        AdmissionBusyError,
      );
      assert.equal(callbacks, 0);
    } finally {
      otherRaw.exec('ROLLBACK');
    }
    assert.deepEqual(await app.append(command(0)), expected[0]);
    let admissions = 0;
    const countPrepare = raw.prepare.bind(raw);
    raw.prepare = (sql) => {
      if (sql.startsWith('UPDATE replay_admission')) admissions++;
      return countPrepare(sql);
    };
    otherRaw.exec('BEGIN IMMEDIATE');
    try {
      await assert.rejects(
        appendWithAdmissionRetry(app, command(50), new AbortController().signal),
        AdmissionBusyError,
      );
    } finally {
      otherRaw.exec('ROLLBACK');
      raw.prepare = countPrepare;
    }
    assert.equal(admissions, 4);
    const simultaneous = await Promise.allSettled([app.append(command(40, 'race')), other.append(command(41, 'race'))]);
    assert.equal(simultaneous.filter((r) => r.status === 'fulfilled').length, 1);
    const loser = simultaneous.find((r) => r.status === 'rejected');
    assert.ok(loser && loser.reason instanceof AdmissionBusyError);
    const missing = stored(raw).some((r) => r.tenant === 'race' && r.eventId === 'event-40') ? 41 : 40;
    assert.equal((await other.append(command(missing, 'race'))).position, '2');
    pass('native independent-handle admission, duplicate-lock refusal and pre-effect busy retry');

    for (const reason of [undefined, null, false, 0, '', new Error('callback sentinel')]) {
      await rejected(
        app.consumeBatch('a', 'failure', async () => {
          throw reason;
        }),
        reason,
      );
      assert.equal(await app.checkpoint('a', 'failure'), '0');
    }
    let attempts = 0;
    const delivered: OrderEvent[] = [];
    await assert.rejects(
      app.consumeBatch('a', 'sink', (event, signal) => {
        attempts++;
        recordEffect(dest, 'sink', event, signal);
        delivered.push({ ...event, body: Uint8Array.from(event.body) });
        if (event.position === '2') throw new Error('effect succeeded; batch failed');
      }),
      /batch failed/,
    );
    assert.equal(await app.checkpoint('a', 'sink'), '0');
    assert.equal(
      await app.consumeBatch('a', 'sink', (event, signal) => {
        attempts++;
        recordEffect(dest, 'sink', event, signal);
        delivered.push({ ...event, body: Uint8Array.from(event.body) });
        event.position = '9223372036854775807';
        event.body.fill(99);
        event.tenant = 'changed';
      }),
      2,
    );
    assert.equal(await app.checkpoint('a', 'sink'), '2');
    assert.equal(attempts, 4);
    assert.deepEqual(delivered, [...expected.slice(0, 2), ...expected.slice(0, 2)]);
    const effects = dest
      .prepare('SELECT * FROM effects ORDER BY CAST(position AS INTEGER)')
      .all()
      .map((r) => ({
        tenant: r.tenant,
        consumer: r.consumer,
        eventId: r.event_id,
        position: r.position,
        orderId: r.order_id,
        title: r.title,
        quantity: r.quantity,
        amount: r.amount,
        occurredAt: r.occurred_at,
        body: Uint8Array.from(r.body as Uint8Array),
      }));
    assert.deepEqual(
      effects,
      expected.slice(0, 2).map((r) => ({ ...r, consumer: 'sink' })),
    );
    pass('falsy callback identity, repeated prefix effects, independent idempotency and private acknowledgement');

    const entered = deferred(),
      finish = deferred();
    const consuming = app.consumeBatch('a', 'serial', async () => {
      entered.resolve();
      await finish.promise;
    });
    await entered.promise;
    let secondEffects = 0;
    await assert.rejects(
      other.consumeBatch('a', 'serial', () => {
        secondEffects++;
      }),
      AdmissionBusyError,
    );
    await assert.rejects(other.append(command(77)), AdmissionBusyError);
    assert.equal(await other.checkpoint('a', 'serial'), '0', 'No uncommitted ack is visible');
    assert.equal(secondEffects, 0);
    finish.resolve();
    assert.equal(await consuming, 2);
    assert.equal(
      await other.consumeBatch('a', 'serial', (e) => {
        assert.equal(e.position, String(++secondEffects + 2));
      }),
      2,
    );
    await app.consumeBatch('a', 'reentry', async () => {
      await assert.rejects(
        other.consumeBatch('a', 'reentry', () => {}),
        /reenter/,
      );
      await assert.rejects(other.append(command(3, 'reentry')), /reenter/);
      await assert.rejects(other.close(), /cannot close/);
    });
    pass('checkpoint transaction isolation, global writer serialization and cross-instance callback reentry');

    const cancel = new AbortController(),
      reason = new Error('cancel sentinel');
    const ignored = [deferred(), deferred()];
    for (let n = 0; n < 2; n++) {
      const enteredLate = deferred();
      const controller = n === 0 ? cancel : new AbortController();
      const cancelled = app.consumeBatch(
        'a',
        'cancelled',
        async () => {
          enteredLate.resolve();
          await ignored[n]!.promise;
        },
        controller.signal,
      );
      await enteredLate.promise;
      controller.abort(reason);
      await rejected(cancelled, reason);
      assert.equal(app.outstandingCallbacks, n + 1);
      assert.equal(await app.checkpoint('a', 'cancelled'), '0');
    }
    let extra = 0;
    await assert.rejects(
      app.consumeBatch('a', 'cancelled', () => {
        extra++;
      }),
      /callback limit/,
    );
    assert.equal(extra, 0);
    ignored.forEach((d) => {
      d.resolve();
    });
    await delay(0);
    assert.equal(app.outstandingCallbacks, 0);
    assert.equal(await app.checkpoint('a', 'cancelled'), '0');
    const timeoutGate = deferred();
    await assert.rejects(
      app.consumeBatch('a', 'timeout', () => timeoutGate.promise),
      /deadline/,
    );
    assert.equal(app.outstandingCallbacks, 1);
    timeoutGate.resolve();
    await delay(0);
    assert.equal(await app.checkpoint('a', 'timeout'), '0');
    pass('cancellation/deadline rollback and hard outstanding callback cap; late settlement cannot ack');

    const ackCancel = new AbortController(),
      ackReason = new Error('cancel after ack SQL staging');
    const ackPrepare = raw.prepare.bind(raw);
    raw.prepare = (sql) => {
      const statement = ackPrepare(sql);
      if (sql.startsWith('UPDATE replay_checkpoints')) {
        const run = statement.run.bind(statement);
        // SQL has bound parameters: preserve the actual native overloads through a Proxy.
        return new Proxy(statement, {
          get(target, name) {
            if (name === 'run')
              return (...args: Parameters<typeof run>) => {
                const result = run(...args);
                ackCancel.abort(ackReason);
                return result;
              };
            const value = Reflect.get(target, name, target);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
      }
      return statement;
    };
    await rejected(
      app.consumeBatch('a', 'ack-cancel', () => {}, ackCancel.signal),
      ackReason,
    );
    raw.prepare = ackPrepare;
    assert.equal(await other.checkpoint('a', 'ack-cancel'), '0');
    const preAborted = new AbortController();
    preAborted.abort(ackReason);
    await rejected(app.append(command(7, 'pre-abort'), preAborted.signal), ackReason);
    assert.equal(raw.prepare("SELECT count(*) AS n FROM replay_orders WHERE tenant='pre-abort'").get()?.n, 0);
    pass('bounded four-attempt append-only admission retry; cancellation after ack staging rolls back');

    // Fault after REAL native COMMIT, for both append and acknowledgement.
    const prepare = raw.prepare.bind(raw);
    let loseCommit = true;
    let commitAbort: AbortController | undefined;
    const lost = new Error('actual COMMIT completed; response unavailable');
    raw.prepare = (sql) => {
      const statement = prepare(sql);
      if (/^COMMIT\b/i.test(sql) && (loseCommit || commitAbort)) {
        const run = statement.run.bind(statement);
        statement.run = () => {
          const result = run();
          assert.ok(result);
          if (commitAbort) {
            commitAbort.abort(lost);
            return result;
          }
          loseCommit = false;
          throw lost;
        };
      }
      return statement;
    };
    await assert.rejects(app.append(command(0, 'uncertain')), (e) => e === lost);
    assert.equal(raw.isTransaction, false);
    assert.equal((await other.append(command(0, 'uncertain'))).position, '1');
    loseCommit = true;
    let observed = 0;
    await assert.rejects(
      app.consumeBatch('uncertain', 'lost', () => {
        observed++;
      }),
      (e) => e === lost,
    );
    assert.equal(await other.checkpoint('uncertain', 'lost'), '1');
    assert.equal(
      await other.consumeBatch('uncertain', 'lost', () => {
        observed++;
      }),
      0,
    );
    assert.equal(observed, 1);
    commitAbort = new AbortController();
    await rejected(
      app.consumeBatch('uncertain', 'commit-cancel', () => {}, commitAbort.signal),
      lost,
    );
    assert.equal(await other.checkpoint('uncertain', 'commit-cancel'), '1');
    raw.prepare = prepare;
    pass('actual post-COMMIT append/checkpoint failure reconciliation without blind effect retry');

    const oldApp = app;
    await app.close();
    assert.equal(raw.prepare('SELECT 41+1 AS n').get()?.n, 42);
    app = new SqliteOrderReplay(raw, { batchSize: 2, deadlineMs: 150, callbackLimit: 2 });
    await oldApp.close();
    assert.throws(() => new SqliteOrderReplay(raw), /owner/, 'Repeated old close must not release its successor lease');
    assert.equal(await app.checkpoint('a', 'sink'), '2');
    const progressAbort = new AbortController();
    const seen: OrderEvent[] = [];
    const progress = app.reconcile(
      'quiet',
      'poll',
      (e) => {
        seen.push(e);
      },
      progressAbort.signal,
      5,
    );
    assert.equal((await progress.next()).value, 0);
    await other.append(command(1, 'quiet')); // No notifications exist or are emitted.
    assert.equal((await progress.next()).value, 1);
    assert.equal(await other.checkpoint('quiet', 'poll'), '1');
    progressAbort.abort();
    await progress.return(undefined);
    assert.deepEqual(seen, [{ ...command(1, 'quiet'), position: '1' }]);
    const collision1 = command(0, 'a:b'),
      collision2 = command(0, 'a');
    await app.append(collision1);
    await app.consumeBatch(collision1.tenant, 'c', () => {});
    assert.equal(await app.checkpoint(collision2.tenant, 'b:c'), '0');
    const quietSignal = new AbortController();
    const quiet1 = app.reconcile('quiet', 'one', () => {}, quietSignal.signal);
    const quiet2 = app.reconcile('quiet', 'two', () => {}, quietSignal.signal);
    const excess = app.reconcile('quiet', 'three', () => {}, quietSignal.signal);
    await quiet1.next();
    await quiet2.next();
    await assert.rejects(excess.next(), /handle limit/);
    await quiet1.return(undefined);
    await quiet2.return(undefined);
    pass('reconstructed app persisted checkpoint, no-wakeup polling and collision-free composite identity');

    const closeGate = deferred(),
      closeEntered = deferred();
    const closingOperation = app.consumeBatch('a', 'close', async () => {
      closeEntered.resolve();
      await closeGate.promise;
    });
    await closeEntered.promise;
    const closed = assert.rejects(closingOperation, /Replay closed/);
    await app.close();
    await closed;
    assert.equal(app.outstandingCallbacks, 1);
    assert.throws(() => new SqliteOrderReplay(raw), /owner/);
    assert.equal(raw.prepare('SELECT 42 AS n').get()?.n, 42);
    await assert.rejects(app.append(command(4)), /closed/);
    closeGate.resolve();
    await delay(0);
    assert.equal(app.outstandingCallbacks, 0);
    assert.equal(await other.checkpoint('a', 'close'), '0');
    const replacement = new SqliteOrderReplay(raw);
    await replacement.close();
    pass('close seals and aborts work, preserves caller handle and counts ignored callback through settlement');
    return groups;
  } finally {
    await app.close();
    await other.close();
    dest.close();
    otherRaw.close();
    raw.close();
    // Only files created in this disposable fixture directory are removed.
    rmSync(root, { recursive: true, force: true });
  }
}
