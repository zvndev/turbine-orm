import assert from 'node:assert/strict';
import { test } from 'node:test';
import pg from 'pg';
import { applicationFactory, command, fixture, gate, until } from './fixtures/postgres-durable-replay/controls.js';

/** A COMMIT whose response was lost is TransactionOutcomeUnknownError (E021), with the loss as `cause`. */
const outcomeUnknown = (error: unknown, cause: Error): boolean =>
  (error as { code?: unknown }).code === 'TURBINE_E021' && (error as { cause?: unknown }).cause === cause;

if (!process.env.DATABASE_URL && process.env.TURBINE_REQUIRE_ENGINE === 'postgres') {
  throw new Error('Required PostgreSQL precondition is unmet: DATABASE_URL not set');
}
const native = { skip: !process.env.DATABASE_URL, timeout: 20000 };

for (const key of ['connectionTimeoutMillis', 'query_timeout', 'statement_timeout'] as const) {
  test(`durable application rejects NaN ${key} before any checkout`, async () => {
    const create = await applicationFactory();
    const pool = new pg.Pool({ connectionTimeoutMillis: 1000, query_timeout: 1000, statement_timeout: 1000 });
    pool.options[key] = Number.NaN;
    let app: ReturnType<typeof create> | undefined;
    try {
      assert.throws(
        () => {
          app = create({ pool, schema: 'timeout_admission', endpoint: 'direct', onDiagnostic() {} });
        },
        { name: 'TypeError', message: `Set finite pool ${key} <=3000` },
      );
      assert.ok(Number.isNaN(pool.options[key]), 'Caller timeout setting must not be rewritten');
      assert.equal(pool.totalCount, 0);
      assert.equal(pool.waitingCount, 0);
    } finally {
      await app?.close();
      await pool.end();
    }
  });
}

test('durable workflow preserves exact values, captures mutable inputs and scopes tenants', native, async (t) => {
  const f = await fixture(t, { batchSize: 2 });
  assert.throws(() => f.app.append('tenant-A', { ...command(1), body: Buffer.alloc(65537) }), /65536/);
  assert.throws(
    () => f.app.append('tenant-A', { ...command(1), occurredAt: '2026-02-30T12:34:56.123456Z' }),
    /actual canonical/,
  );
  assert.throws(() => f.app.append('tenant-A', { ...command(1), title: '\ud800' }), /title/);
  assert.throws(() => f.app.append('tenant-A', { ...command(1), quantity: '9223372036854775808' }), /int8/);
  const input = command(1);
  const expected = command(1);
  const pending = f.app.append('tenant-A', input);
  input.body.fill(7);
  input.quantity = '2';
  input.amount = '3';
  input.title = 'mutated';
  assert.deepEqual(await pending, { ...expected, tenant: 'tenant-A', position: '1' });
  await f.app.append('tenant-A', command(2));
  await f.app.append('tenant-A', command(3));
  await f.app.append('tenant-B', command(1));
  const exact = [1, 2, 3].map((id, index) => ({ ...command(id), tenant: 'tenant-A', position: String(index + 1) }));
  assert.deepEqual(await f.oracle('tenant-A'), exact);
  assert.equal((await f.raw.query(`SELECT count(*)::int AS n FROM "${f.schema}".orders`)).rows[0]!.n, 4);
  assert.deepEqual(await f.app.append('tenant-A', command(1)), exact[0]);
  await assert.rejects(
    f.app.append('tenant-A', { ...command(1), quantity: '9007199254740992' }),
    /different order values/,
  );
  await assert.rejects(
    f.app.append('tenant-A', { ...command(1), amount: '12345678901234567890.123456789011' }),
    /different order values/,
  );
  const seen: string[] = [];
  assert.equal(
    await f.app.consumeBatch('tenant-A', 'mail', (event) => {
      seen.push(event.position);
      event.position = '999';
      event.body.fill(9);
      event.amount = '0';
    }),
    2,
  );
  assert.equal(await f.checkpoint('tenant-A', 'mail'), '2', 'Callback cannot mutate private acknowledgement');
  assert.equal(
    await f.app.consumeBatch('tenant-A', 'mail', (event) => {
      seen.push(event.position);
    }),
    1,
  );
  assert.deepEqual(seen, ['1', '2', '3']);
  assert.deepEqual(await f.oracle('tenant-A'), exact);
  assert.equal(await f.app.consumeBatch('tenant-B', 'mail', () => {}), 1);
});

test('failed business insert rolls back allocation/outbox and publishes no committed wakeup', native, async (t) => {
  const f = await fixture(t);
  await f.app.append('A', command(1));
  const notifications: string[] = [];
  const barrier = gate();
  const sub = await f.app.hub.subscribe(f.app.channel, (payload) => {
    notifications.push(payload);
    if (payload === 'barrier') barrier.resolve();
  });
  await assert.rejects(f.app.append('A', { ...command(2), orderId: command(1).orderId }));
  await f.raw.query('SELECT pg_notify($1,$2)', [f.app.channel, 'barrier']);
  await barrier.promise;
  assert.deepEqual(notifications, ['barrier']);
  assert.deepEqual(await f.oracle('A'), [{ ...command(1), tenant: 'A', position: '1' }]);
  assert.equal(
    (await f.raw.query(`SELECT position::text FROM "${f.schema}".tenant_stream WHERE tenant='A'`)).rows[0]!.position,
    '1',
  );
  assert.equal((await f.app.append('A', command(2))).position, '2');
  await sub.unsubscribe();
});

test('tenant lock prevents later allocation/commit from skipping an open allocated position', native, async (t) => {
  const f = await fixture(t);
  const entered = gate(),
    allow = gate();
  f.release.push(allow.resolve);
  f.nextCommit({
    before: async () => {
      entered.resolve();
      await allow.promise;
    },
  });
  const earlier = f.app.append('A', command(1));
  await entered.promise;
  const later = f.app.append('A', command(2));
  await until(f.waiting);
  assert.deepEqual(await f.oracle('A'), []);
  assert.equal(await f.app.consumeBatch('A', 'mail', () => assert.fail('Uncommitted event delivered')), 0);
  allow.resolve();
  assert.equal((await earlier).position, '1');
  assert.equal((await later).position, '2');
  const seen: string[] = [];
  await f.app.consumeBatch('A', 'mail', (event) => {
    seen.push(event.position);
  });
  assert.deepEqual(seen, ['1', '2']);
  // Transaction start order is not allocation order: an older empty transaction can finish later.
  const older = await f.raw.connect();
  const onError = () => {};
  older.on('error', onError);
  try {
    await older.query('BEGIN');
    assert.equal((await f.app.append('A', command(3))).position, '3');
    await older.query('COMMIT');
    await older.query('BEGIN');
    await older.query(`SELECT position FROM "${f.schema}".tenant_stream WHERE tenant='A' FOR UPDATE`);
    let acknowledged = false;
    const duplicate = f.app.append('A', command(2)).then((event) => {
      acknowledged = true;
      return event;
    });
    await until(f.waiting);
    assert.equal(acknowledged, false, 'Duplicate acknowledgement also waits for the tenant serialization lock');
    await older.query('COMMIT');
    assert.equal((await duplicate).position, '2');
  } finally {
    older.removeListener('error', onError);
    older.release();
  }
  assert.equal(await f.app.consumeBatch('A', 'mail', () => {}), 1);
});

test(
  'producer lost COMMIT response is unknown and stable idempotency key reconciles actual effect',
  native,
  async (t) => {
    const f = await fixture(t);
    const lost = new Error('COMMIT applied; response lost');
    f.nextCommit({
      after: async () => {
        throw lost;
      },
    });
    // Unknown, not rolled back: E021 carrying the lost response as its cause.
    await assert.rejects(f.app.append('A', command(1)), (error) => outcomeUnknown(error, lost));
    assert.deepEqual(await f.oracle('A'), [{ ...command(1), tenant: 'A', position: '1' }]);
    assert.equal((await f.app.append('A', command(1))).position, '1');
    assert.equal((await f.app.append('A', command(2))).position, '2');
    assert.equal((await f.raw.query(`SELECT count(*)::int AS n FROM "${f.schema}".orders`)).rows[0]!.n, 2);
  },
);

test('falsy callback failures retain identity and replay the successfully effected prefix', native, async (t) => {
  const f = await fixture(t);
  await f.app.append('A', command(1));
  await f.app.append('A', command(2));
  const reasons = [undefined, null, false, 0, '', new Error('callback failure')];
  for (const [index, reason] of reasons.entries()) {
    const consumer = `consumer-${index}`;
    const attempts: string[] = [];
    let rejected = false;
    try {
      await f.app.consumeBatch('A', consumer, (event) => {
        attempts.push(event.position);
        if (event.position === '2') throw reason;
      });
    } catch (actual) {
      rejected = true;
      assert.equal(actual, reason);
    }
    assert.equal(rejected, true);
    assert.equal(await f.checkpoint('A', consumer), '0');
    await f.app.consumeBatch('A', consumer, (event) => {
      attempts.push(event.position);
    });
    assert.deepEqual(attempts, ['1', '2', '1', '2']);
    assert.equal(await f.checkpoint('A', consumer), '2');
  }
});

test('competing same-consumer workers serialize and recursive drain refuses before lock wait', native, async (t) => {
  const f = await fixture(t);
  await f.app.append('A', command(1));
  await f.app.append('A', command(2));
  const entered = gate(),
    allow = gate();
  f.release.push(allow.resolve);
  const seen: string[] = [];
  const first = f.app.consumeBatch('A', 'mail', async (event) => {
    if (event.position === '1') {
      await assert.rejects(
        f.app.consumeBatch('A', 'mail', () => {}),
        /Recursive drain/,
      );
      entered.resolve();
      await allow.promise;
    }
    seen.push(event.position);
  });
  await entered.promise;
  const sibling = f.reopen();
  const second = sibling.consumeBatch('A', 'mail', (event) => {
    seen.push(`duplicate-${event.position}`);
  });
  await until(f.waiting);
  allow.resolve();
  assert.deepEqual(await Promise.all([first, second]), [2, 0]);
  assert.deepEqual(seen, ['1', '2']);
  assert.equal(await f.checkpoint('A', 'mail'), '2');
  await assert.rejects(
    f.app.consumeBatch('A', 'recursive', async () => {
      await sibling.consumeBatch('A', 'recursive', () => {});
    }),
    /Recursive drain/,
  );
  assert.equal(await f.checkpoint('A', 'recursive'), '0');
});

test(
  'checkpoint COMMIT acknowledgement is independent of progress observation and lost response',
  native,
  async (t) => {
    const f = await fixture(t);
    await f.app.append('A', command(1));
    const attempts: string[] = [];
    const lost = new Error('checkpoint COMMIT response lost');
    f.nextCommit({
      after: async () => {
        throw lost;
      },
    });
    await assert.rejects(
      f.app.consumeBatch('A', 'mail', (event) => {
        attempts.push(event.position);
      }),
      (error) => outcomeUnknown(error, lost),
    );
    assert.equal(await f.checkpoint('A', 'mail'), '1');
    await f.app.close();
    const restarted = f.reopen();
    assert.equal(
      await restarted.consumeBatch('A', 'mail', (event) => {
        attempts.push(event.position);
      }),
      0,
    );
    assert.deepEqual(attempts, ['1']);
    await restarted.append('A', command(2));
    const entered = gate(),
      allow = gate();
    f.release.push(allow.resolve);
    f.nextCommit({
      before: async () => {
        entered.resolve();
        await allow.promise;
      },
    });
    const progress = restarted.watchProgress('A', 'mail', (event) => {
      attempts.push(event.position);
    });
    await entered.promise;
    const invalidated = gate();
    const observer = await restarted.hub.subscribe(restarted.channel, () => invalidated.resolve());
    await f.raw.query('SELECT pg_notify($1,$2)', [restarted.channel, 'dirty-progress']);
    await invalidated.promise;
    allow.resolve();
    await until(async () => (await f.checkpoint('A', 'mail')) === '2');
    // The dirty batch-count snapshot was discarded, but its checkpoint still committed.
    assert.equal((await progress.next()).value, 0);
    await observer.unsubscribe();
    await progress.dispose();
    assert.deepEqual(attempts, ['1', '2']);
  },
);

test('disconnect gap, missed/coalesced wakeups and restart recover from durable state', native, async (t) => {
  const f = await fixture(t, { reconcileMs: 25 });
  const seen: string[] = [];
  const progress = f.app.watchProgress('A', 'mail', (event) => {
    seen.push(event.position);
  });
  await progress.ready;
  await progress.next();
  const listeners = (
    await f.raw.query('SELECT pid FROM pg_stat_activity WHERE query=$1', [`LISTEN "${f.app.channel}"`])
  ).rows;
  assert.equal(listeners.length, 1);
  const separateWriter = f.reopen(true);
  const reconnect = f.gateCheckout();
  f.release.push(reconnect);
  await f.raw.query('SELECT pg_terminate_backend($1)', [listeners[0]!.pid]);
  await until(() => !f.app.hub.stats.connected);
  // A separate application writer does not borrow the disconnected listener checkout gate.
  await separateWriter.append('A', command(1));
  assert.equal(await f.checkpoint('A', 'mail'), '0');
  reconnect();
  await until(async () => (await f.checkpoint('A', 'mail')) === '1');
  await until(() => f.app.hub.stats.connected);
  await progress.dispose();
  await f.app.close();
  const writer = f.reopen();
  await writer.append('A', command(2));
  await writer.append('A', command(3));
  // There is no mail listener. NOTIFY is gone; only persisted outbox/checkpoint remain.
  const restart = f.reopen();
  const restarted = restart.watchProgress('A', 'mail', (event) => {
    seen.push(event.position);
  });
  await until(async () => (await f.checkpoint('A', 'mail')) === '3');
  await restarted.dispose();
  assert.deepEqual(seen, ['1', '2', '3']);
  const periodic = restart.watchProgress('A', 'mail', (event) => {
    seen.push(event.position);
  });
  await periodic.ready;
  await periodic.next();
  // Deliberately suppress all wakeups in this raw connection. It is a test fault, not a supported writer.
  const silent = await f.raw.connect();
  const onError = () => {};
  silent.on('error', onError);
  try {
    await silent.query('BEGIN');
    await silent.query(
      `UPDATE "${f.schema}".tenant_stream SET position=position+1 WHERE tenant='A' RETURNING position`,
    );
    const exact = command(4);
    await silent.query(`INSERT INTO "${f.schema}".orders VALUES('A',$1,$2,$3,$4,$5,$6)`, [
      exact.orderId,
      exact.title,
      exact.quantity,
      exact.amount,
      exact.occurredAt,
      exact.body,
    ]);
    await silent.query(
      `INSERT INTO "${f.schema}".outbox SELECT tenant,4,$1,$2,title,quantity,amount,occurred_at,body FROM "${f.schema}".orders WHERE tenant='A' AND order_id=$2`,
      [command(4).eventId, command(4).orderId],
    );
    await silent.query('COMMIT');
  } finally {
    silent.removeListener('error', onError);
    silent.release();
  }
  await until(async () => (await f.checkpoint('A', 'mail')) === '4');
  assert.deepEqual(seen, ['1', '2', '3', '4']);
  assert.deepEqual(
    await f.oracle('A'),
    [1, 2, 3, 4].map((id) => ({ ...command(id), tenant: 'A', position: String(id) })),
  );
  await periodic.dispose();
});

test('callback timeout and cancellation cannot strand shutdown or acknowledge late work', native, async (t) => {
  const f = await fixture(t, { callbackMs: 100 });
  await f.app.append('A', command(1));
  const late = gate(),
    entered = gate();
  f.release.push(late.resolve);
  let effects = 0;
  await assert.rejects(
    f.app.consumeBatch('A', 'timeout', async () => {
      await late.promise;
      effects++;
    }),
    (error) => error instanceof Error && error.name === 'TimeoutError',
  );
  assert.equal(await f.checkpoint('A', 'timeout'), '0');
  const controller = new AbortController();
  const pending = f.app.consumeBatch(
    'A',
    'cancel',
    async () => {
      entered.resolve();
      await late.promise;
      effects++;
    },
    controller.signal,
  );
  await entered.promise;
  controller.abort();
  await assert.rejects(pending, (error) => error instanceof Error && error.name === 'AbortError');
  await f.app.close();
  assert.equal(await f.checkpoint('A', 'cancel'), '0');
  late.resolve();
  await until(() => effects === 2); // Ignored cancellation can still cause external effects AFTER rollback.
  const restarted = f.reopen();
  assert.equal(
    await restarted.consumeBatch('A', 'timeout', () => {
      effects++;
    }),
    1,
  );
  assert.equal(effects, 3);
});

test('destination idempotency makes replay safe without claiming exactly-once callbacks', native, async (t) => {
  const f = await fixture(t);
  await f.app.append('A', command(1));
  await f.app.append('A', command(2));
  await f.raw.query(`CREATE TABLE "${f.schema}".external_effects (
    tenant text, consumer text, event_id uuid, bytes bytea, PRIMARY KEY(tenant,consumer,event_id))`);
  const attempts: string[] = [];
  let fail = true;
  const deliver = async (event: ReturnType<typeof command> & { tenant: string; position: string }) => {
    attempts.push(event.position);
    await f.raw.query(`INSERT INTO "${f.schema}".external_effects VALUES($1,'mail',$2,$3) ON CONFLICT DO NOTHING`, [
      event.tenant,
      event.eventId,
      event.body,
    ]);
    if (fail && event.position === '2') throw 0; // Both destination effects committed, checkpoint did not.
  };
  let failed = false;
  try {
    await f.app.consumeBatch('A', 'mail', deliver);
  } catch (error) {
    failed = true;
    assert.equal(error, 0);
  }
  assert.equal(failed, true);
  assert.equal(await f.checkpoint('A', 'mail'), '0');
  fail = false;
  await f.app.consumeBatch('A', 'mail', deliver);
  assert.deepEqual(attempts, ['1', '2', '1', '2']);
  assert.deepEqual(
    (await f.raw.query(`SELECT tenant,consumer,event_id,bytes FROM "${f.schema}".external_effects ORDER BY event_id`))
      .rows,
    [1, 2].map((id) => ({ tenant: 'A', consumer: 'mail', event_id: command(id).eventId, bytes: command(id).body })),
  );
  assert.equal(await f.checkpoint('A', 'mail'), '2');
});

test('ignored cancellation remains bounded and new callbacks refuse at the outstanding limit', native, async (t) => {
  const f = await fixture(t, { callbackMs: 20 });
  await f.app.append('A', command(1));
  const late = gate();
  f.release.push(late.resolve);
  for (let index = 0; index < 8; index++) {
    await assert.rejects(
      f.app.consumeBatch('A', `late-${index}`, () => late.promise),
      (error) => error instanceof Error && error.name === 'TimeoutError',
    );
  }
  assert.equal(f.app.outstandingCallbacks, 8);
  await assert.rejects(
    f.app.consumeBatch('A', 'over-limit', () => {}),
    /Outstanding callback limit/,
  );
  assert.equal(await f.checkpoint('A', 'over-limit'), '0');
  await f.app.close();
  assert.equal(f.app.outstandingCallbacks, 8, 'Close must not await arbitrary ignored promises');
  late.resolve();
  await until(() => f.app.outstandingCallbacks === 0);
});
