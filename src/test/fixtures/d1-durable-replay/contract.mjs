/** The same finite contract runs on real workerd bindings in Node and Worker. */
import { reviewRegressions } from './option-regressions.mjs';
export function check(value, message) {
  if (!value) throw Error(message);
}
export function same(a, b, message) {
  check(JSON.stringify(a) === JSON.stringify(b), `${message}: ${JSON.stringify(a)}`);
}
export async function rejects(action, predicate = () => true) {
  let failed = false;
  try {
    await action();
  } catch (error) {
    failed = true;
    check(predicate(error), `Unexpected rejection ${String(error)}`);
  }
  check(failed, 'Expected rejection');
}
export const command = (i = '1') => ({
  eventId: `e${i}`,
  orderId: `o${i}`,
  quantity: '9223372036854775807',
  amount: '999999999999999999999999999999.120000000001',
  occurredAt: '2026-11-07T12:34:56.123456Z',
  title: null,
  body: new Uint8Array([0, 128, 255]),
});
const all = async (db, sql, ...params) =>
  (
    await db
      .prepare(sql)
      .bind(...params)
      .all()
  ).results;
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
// Hold completed native optimistic reads, then release together. Writes remain real native batches.
function barrierBinding(db, pattern, count = 2) {
  let seen = 0;
  const gate = deferred();
  const originals = new WeakMap();
  return {
    prepare(sql) {
      const wrap = (statement) => {
        const facade = {
          bind(...p) {
            return wrap(statement.bind(...p));
          },
          async all() {
            const result = await statement.all();
            if (pattern.test(sql) && ++seen <= count) {
              if (seen === count) gate.resolve();
              await gate.promise;
            }
            return result;
          },
        };
        originals.set(facade, statement);
        return facade;
      };
      return wrap(db.prepare(sql));
    },
    batch: (statements) => db.batch(statements.map((s) => originals.get(s) ?? s)),
  };
}

export async function contract(api, db, label) {
  const { ReplayApp, initialize, UnknownOutcome, Stopped } = api;
  const cases = [];
  const mark = (s) => cases.push(s);
  await initialize(db);
  const app = new ReplayApp(db),
    sink = new ReplayApp(db);
  const tenant = `${label}_values`;
  const input = command();
  let reads = 0;
  const opts = {
    get timeoutMs() {
      reads++;
      return 2000;
    },
  };
  const p = app.append(tenant, input, opts);
  input.body.fill(7);
  input.quantity = '0';
  const first = await p;
  same(first, { tenant, position: 1, ...command() }, 'Complete captured values');
  check(reads === 1, 'Capture options once');
  same(await app.append(tenant, command()), first, 'Idempotent stable ID');
  await rejects(
    () => app.append(tenant, { ...command(), title: 'changed' }),
    (e) => e instanceof api.Conflict,
  );
  for (const patch of [
    { orderId: 'different' },
    { quantity: '1' },
    { amount: '1.000000000000' },
    { occurredAt: '2026-11-07T12:34:56.123457Z' },
    { title: '' },
    { body: new Uint8Array([0, 128, 254]) },
  ])
    await rejects(
      () => app.append(tenant, { ...command(), ...patch }),
      (e) => e instanceof api.Conflict,
    );
  const persisted = await all(db, 'SELECT * FROM replay_events WHERE tenant=?1', tenant);
  same(
    JSON.parse(persisted[0].captured),
    ['e1', 'o1', command().quantity, command().amount, command().occurredAt, null, '0080ff'],
    'Persisted exact values',
  );
  same(
    await all(db, 'SELECT captured FROM replay_orders WHERE tenant=?1', tenant),
    [{ captured: persisted[0].captured }],
    'Business effect equals outbox',
  );
  mark('captured exact values and identical ID');
  await app.append(tenant, command('2'));
  for (const cause of [false, 0, '', null, undefined]) {
    await rejects(
      () =>
        app.deliver(tenant, 'errors', () => {
          throw cause;
        }),
      (e) => e === cause,
    );
    check((await app.checkpoint(tenant, 'errors')) === 0, 'Falsy callback error changed checkpoint');
  }
  const abort = new AbortController();
  await rejects(
    () =>
      app.deliver(
        tenant,
        'cancel',
        () => {
          abort.abort();
        },
        { signal: abort.signal },
      ),
    (e) => e instanceof Stopped,
  );
  check((await app.checkpoint(tenant, 'cancel')) === 0, 'Cancelled before acknowledgement');
  await app.deliver(tenant, 'mutate', async (events) => {
    for (const event of events) await sink.applyDestination('mutate', event);
    events[0].position = 999;
    events[0].body.fill(9);
    events.splice(0, events.length);
    events.push({ ...first, position: 999 });
  });
  check((await app.checkpoint(tenant, 'mutate')) === 2, 'Private acknowledgement state mutated');
  check(
    (await all(db, 'SELECT * FROM replay_destination WHERE tenant=?1 AND consumer=?2', tenant, 'mutate')).length === 2,
    'Idempotent sink effects',
  );
  mark('callback falsy mutation cancellation');
  // Native stale optimistic head snapshots: precisely one committed effect at position one.
  const racing = barrierBinding(db, /SELECT COALESCE\(\(SELECT position FROM replay_heads/);
  const a = new ReplayApp(racing),
    b = new ReplayApp(racing);
  const race = await Promise.allSettled([
    a.append(`${label}_race`, command('a')),
    b.append(`${label}_race`, command('b')),
  ]);
  check(race.filter((r) => r.status === 'fulfilled').length === 1, 'Conflicting head race');
  check(
    race.filter((r) => r.status === 'rejected' && r.reason instanceof UnknownOutcome).length === 1,
    'Stale dispatch qualified unknown',
  );
  const events = await all(db, 'SELECT * FROM replay_events WHERE tenant=?1', `${label}_race`);
  check(events.length === 1 && events[0].position === 1, 'Race effects');
  const loser = race[0].status === 'rejected' ? command('a') : command('b');
  check((await a.reconcile(`${label}_race`, loser)) === null, 'Loser history');
  check((await a.append(`${label}_race`, loser)).position === 2, 'Retry only after settled + reconciliation');
  const different = await Promise.all([a.append(`${label}_ta`, command()), b.append(`${label}_tb`, command())]);
  same(
    different.map((e) => e.position),
    [1, 1],
    'Independent tenants',
  );
  mark('native stale head and different tenant races');
  const sameId = barrierBinding(db, /SELECT COALESCE\(\(SELECT position FROM replay_heads/);
  const s1 = new ReplayApp(sameId),
    s2 = new ReplayApp(sameId);
  const idRace = await Promise.allSettled([
    s1.append(`${label}_same`, command()),
    s2.append(`${label}_same`, command()),
  ]);
  check(idRace.filter((r) => r.status === 'fulfilled').length === 1, 'Same ID race winner');
  same(
    await s2.reconcile(`${label}_same`, command()),
    { tenant: `${label}_same`, position: 1, ...command() },
    'Same ID reconciliation',
  );
  const conflictingId = barrierBinding(db, /SELECT COALESCE\(\(SELECT position FROM replay_heads/);
  const ci1 = new ReplayApp(conflictingId),
    ci2 = new ReplayApp(conflictingId);
  const conflicted = await Promise.allSettled([
    ci1.append(`${label}_conflict`, command()),
    ci2.append(`${label}_conflict`, { ...command(), title: 'competing' }),
  ]);
  check(conflicted.filter((r) => r.status === 'fulfilled').length === 1, 'Conflicting same ID winner');
  const losingInput = conflicted[0].status === 'fulfilled' ? { ...command(), title: 'competing' } : command();
  await rejects(
    () => app.reconcile(`${label}_conflict`, losingInput),
    (e) => e instanceof api.Conflict,
  );
  await ci1.close();
  await ci2.close();
  mark('native identical and conflicting same ID races');
  // Roll back earlier business insert on a conflicting order. Entire native batch is atomic.
  await rejects(
    () => app.append(tenant, { ...command('3'), orderId: 'o1' }),
    (e) => e instanceof UnknownOutcome,
  );
  check((await app.reconcile(tenant, command('3'))) === null, 'Failed batch inserted outbox');
  check(
    (await all(db, 'SELECT position FROM replay_heads WHERE tenant=?1', tenant))[0].position === 2,
    'Failed batch advanced head',
  );
  const lateFailure = new ReplayApp({
    prepare: (sql) => db.prepare(sql),
    batch(st) {
      return db.batch(
        st.length === 6
          ? [...st.slice(0, 3), db.prepare("SELECT json_extract('injected failure','$')"), ...st.slice(4)]
          : st,
      );
    },
  });
  await rejects(
    () => lateFailure.append(`${label}_rollback`, command()),
    (e) => e instanceof UnknownOutcome,
  );
  for (const table of ['replay_heads', 'replay_orders', 'replay_events'])
    check(
      (await all(db, `SELECT * FROM ${table} WHERE tenant=?1`, `${label}_rollback`)).length === 0,
      'Late SQL failure must roll back earlier native business effect and head',
    );
  await lateFailure.close();
  mark('failed batch including late SQL failure rollback');
  const responseLost = {
    prepare: (s) => db.prepare(s),
    async batch(st) {
      await db.batch(st);
      throw false;
    },
  };
  const lost = new ReplayApp(responseLost);
  await rejects(
    () => lost.append(`${label}_lost`, command()),
    (e) => e instanceof UnknownOutcome && e.cause === false,
  );
  same(
    await lost.reconcile(`${label}_lost`, command()),
    { tenant: `${label}_lost`, position: 1, ...command() },
    'Actual post-commit lost response reconciliation',
  );
  const malformed = new ReplayApp({
    prepare: (s) => db.prepare(s),
    async batch(st) {
      await db.batch(st);
      return [];
    },
  });
  await rejects(
    () => malformed.append(`${label}_malformed`, command()),
    (e) => e instanceof UnknownOutcome,
  );
  check((await malformed.reconcile(`${label}_malformed`, command())).position === 1, 'Malformed response committed');
  await rejects(
    () => lost.deliver(tenant, 'lost_ack', () => {}),
    (e) => e instanceof UnknownOutcome && e.cause === false,
  );
  check((await app.checkpoint(tenant, 'lost_ack')) === 2, 'Actual lost acknowledgement persisted');
  const badMeta = new ReplayApp({
    prepare: (s) => db.prepare(s),
    async batch(st) {
      const r = await db.batch(st);
      return r.map((item) => ({ ...item, meta: undefined }));
    },
  });
  await rejects(
    () => badMeta.append(`${label}_badmeta`, command()),
    (e) => e instanceof UnknownOutcome,
  );
  check(
    (await badMeta.reconcile(`${label}_badmeta`, command())).position === 1,
    'Malformed post-commit metadata is unknown',
  );
  await badMeta.close();
  mark('post-commit lost and malformed responses');
  // Both callbacks may deliver the same prefix. The destination must deduplicate natively.
  const cbBarrier = deferred();
  let callbacks = 0;
  const d1 = new ReplayApp(db),
    d2 = new ReplayApp(db);
  const deliver = async (items) => {
    callbacks++;
    if (callbacks === 2) cbBarrier.resolve();
    await cbBarrier.promise;
    for (const e of items) await sink.applyDestination('duplicate', e);
  };
  const delivery = await Promise.allSettled([
    d1.deliver(tenant, 'duplicate', deliver),
    d2.deliver(tenant, 'duplicate', deliver),
  ]);
  check(callbacks === 2, 'Concurrent duplicate callbacks');
  check(delivery.filter((r) => r.status === 'fulfilled').length === 1, 'CAS ack winner');
  check((await app.checkpoint(tenant, 'duplicate')) === 2, 'Ack did not settle prefix');
  check(
    (await all(db, 'SELECT * FROM replay_destination WHERE tenant=?1 AND consumer=?2', tenant, 'duplicate')).length ===
      2,
    'Duplicate sink effects',
  );
  same(
    await Promise.all([d1.deliver(tenant, 'consumerA', () => {}), d2.deliver(tenant, 'consumerB', () => {})]),
    [2, 2],
    'Independent consumers',
  );
  mark('native duplicate delivery, idempotent destination and consumer CAS');
  // Delayed short prefix must not regress a longer committed prefix.
  const held = deferred(),
    entered = deferred();
  const short = d1.deliver(
    tenant,
    'regress',
    () => {
      entered.resolve();
      return held.promise;
    },
    { limit: 1 },
  );
  await entered.promise;
  check((await d2.deliver(tenant, 'regress', () => {})) === 2, 'Long prefix ack');
  held.resolve();
  await rejects(
    () => short,
    (e) => e instanceof UnknownOutcome,
  );
  check((await app.checkpoint(tenant, 'regress')) === 2, 'Stale acknowledgement regressed');
  mark('stale ack no regression or skipped prefix');
  // Actual commit completes while facade sees unresolved dispatch. Cancellation cannot undo it.
  const dispatched = deferred(),
    release = deferred();
  const delayApp = new ReplayApp({
    prepare: (s) => db.prepare(s),
    async batch(st) {
      const result = await db.batch(st);
      dispatched.resolve();
      await release.promise;
      return result;
    },
  });
  const controller = new AbortController();
  const delayed = delayApp.append(`${label}_unsettled`, command(), { signal: controller.signal });
  await dispatched.promise;
  controller.abort();
  await rejects(
    () => delayed,
    (e) => e instanceof UnknownOutcome,
  );
  same(await delayApp.close(10), { settled: false, unsettled: 1, active: 0 }, 'Honest unsettled dispatch close');
  const observer = new ReplayApp(db);
  check((await observer.reconcile(`${label}_unsettled`, command())).position === 1, 'Observer sees commit');
  release.resolve();
  await Promise.resolve();
  await Promise.resolve();
  check((await delayApp.close()).settled, 'Late native settlement tracking');
  const ackDispatched = deferred(),
    ackRelease = deferred(),
    ackAbort = new AbortController();
  const ackApp = new ReplayApp({
    prepare: (s) => db.prepare(s),
    async batch(st) {
      const r = await db.batch(st);
      ackDispatched.resolve();
      await ackRelease.promise;
      return r;
    },
  });
  const ack = ackApp.deliver(tenant, 'inflight_ack', () => {}, { signal: ackAbort.signal });
  await ackDispatched.promise;
  ackAbort.abort();
  await rejects(
    () => ack,
    (e) => e instanceof UnknownOutcome,
  );
  check((await ackApp.close(5)).unsettled === 1, 'In-flight acknowledgement still tracked');
  check((await observer.checkpoint(tenant, 'inflight_ack')) === 2, 'Cancelled acknowledgement may already commit');
  ackRelease.resolve();
  await Promise.resolve();
  await Promise.resolve();
  check((await ackApp.close()).settled, 'Late ack settlement');
  mark('ignored in-flight append/ack cancellation and bounded close');
  const callbackHeld = deferred();
  const timeoutApp = new ReplayApp(db);
  await rejects(
    () => timeoutApp.deliver(tenant, 'timeout', () => callbackHeld.promise, { timeoutMs: 25 }),
    (e) => e instanceof Stopped,
  );
  check((await timeoutApp.close(5)).unsettled === 1, 'Unsettled callback tracked');
  callbackHeld.resolve();
  await Promise.resolve();
  check((await observer.checkpoint(tenant, 'timeout')) === 0, 'Late callback acknowledged after timeout');
  const reentry = new ReplayApp(db);
  await reentry.deliver(tenant, 'reentry', () => {
    let refused = false;
    try {
      reentry.append(tenant, command('4'));
    } catch (e) {
      refused = e instanceof Stopped;
    }
    check(refused, 'Callback reentry');
  });
  for (const n of [NaN, Infinity, -1, 1.5, 0, 10001]) {
    let refused = false;
    try {
      observer.append(tenant, command('bound'), { timeoutMs: n });
    } catch {
      refused = true;
    }
    check(refused, 'Finite timeout admission');
  }
  const cancelled = new AbortController();
  cancelled.abort();
  let refused = false;
  try {
    observer.append(tenant, command('never'), { signal: cancelled.signal });
  } catch {
    refused = true;
  }
  check(refused, 'Pre-dispatch abort');
  // Real reads finish in D1 but their responses remain held; admission counts outstanding promises.
  const blockedGate = deferred();
  const blocking = {
    prepare(sql) {
      const wrap = (statement) => ({
        bind(...p) {
          return wrap(statement.bind(...p));
        },
        async all() {
          const r = await statement.all();
          await blockedGate.promise;
          return r;
        },
      });
      return wrap(db.prepare(sql));
    },
    batch: (s) => db.batch(s),
  };
  const bounded = new ReplayApp(blocking);
  const hold = () => bounded.reconcile(tenant, command(), { timeoutMs: 40 });
  const firstBatch = Array.from({ length: 8 }, hold);
  let activeRefused = false;
  try {
    hold();
  } catch (e) {
    activeRefused = e instanceof Stopped;
  }
  check(activeRefused, 'Active operation bound');
  await Promise.all(
    firstBatch.map((p) =>
      rejects(
        () => p,
        (e) => e instanceof Stopped,
      ),
    ),
  );
  const secondBatch = Array.from({ length: 8 }, hold);
  await Promise.all(
    secondBatch.map((p) =>
      rejects(
        () => p,
        (e) => e instanceof Stopped,
      ),
    ),
  );
  check(bounded.status.unsettled === 16, 'Unsettled bound tracked');
  let unsettledRefused = false;
  try {
    hold();
  } catch (e) {
    unsettledRefused = e instanceof Stopped;
  }
  check(unsettledRefused, 'Unsettled operation admission');
  check((await bounded.close(5)).unsettled === 16, 'Bounded close retains all outstanding work');
  blockedGate.resolve();
  await Promise.resolve();
  await Promise.resolve();
  check((await bounded.close()).settled, 'Held reads eventually settle');
  mark('deadline late callback reentry finite admission and active/unsettled bounds');
  const closed = await app.close();
  check(closed.settled, 'App close');
  refused = false;
  try {
    app.append(tenant, command('closed'));
  } catch {
    refused = true;
  }
  check(refused, 'Closed facade admission');
  check((await db.prepare('SELECT 1 AS alive').all()).results[0].alive === 1, 'Caller binding survives close');
  for (const facade of [sink, a, b, s1, s2, lost, malformed, d1, d2, observer, timeoutApp, reentry])
    check((await facade.close()).settled, 'All facades settled');
  mark('caller binding ownership');
  const admission = await reviewRegressions(api, db, label);
  mark('option getter reentry and capture failure admission');
  return { label, cases, first, persisted, admission };
}
