import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createPool } from 'mysql2/promise';

const [format, action = 'suite', output] = process.argv.slice(2);
const load = (f) =>
  f === 'esm'
    ? import('./esm/application.js')
    : Promise.resolve(createRequire(import.meta.url)('./cjs/application.cjs'));
const { openOrderApplication, Unacknowledged } = process.env.MYSQL_REPLAY_APPLICATION
  ? await import(process.env.MYSQL_REPLAY_APPLICATION)
  : await load(format);
const other = await load(format === 'esm' ? 'cjs' : 'esm');
const config = {
  host: '127.0.0.1',
  port: Number(process.env.MYSQL_PORT),
  user: 'root',
  database: process.env.MYSQL_DATABASE,
  namedPlaceholders: true,
  supportBigNumbers: true,
  bigNumberStrings: true,
  waitForConnections: false,
  connectionLimit: 8,
  connectTimeout: 1000,
};
const pool = createPool(config),
  apps = [];
const open = async (o = {}, factory = openOrderApplication) => {
  const app = await factory({ pool, ...o });
  apps.push(app);
  return app;
};
const cmd = (n) => ({
  eventId: `e${n}`,
  orderId: `o${n}`,
  title: n % 2 ? "quote' \\ nul\0 snow 雪 💧" : null,
  quantity: '9223372036854775807',
  amount: '123456789012345678901234567890.120000000001',
  occurredAt: '2026-11-07T12:34:56.123456Z',
  body: Buffer.from([0, 255, 128, 39, 92, n % 256]),
});
const gate = () => {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
};
const fail = async (p, predicate = () => true) => {
  let caught = false;
  try {
    await p;
  } catch (e) {
    caught = true;
    assert.ok(predicate(e), e?.stack);
  }
  assert.ok(caught, 'must reject');
};
const why = (e) => {
  const chain = [];
  for (let c = e; c; c = c.cause) chain.push(c.message);
  return chain.join(' / ');
};
const sql = async (s, v) => (await pool.execute(s, v))[0];
const checkpoint = async (t, c) =>
  (await sql('SELECT CAST(last_position AS CHAR) AS p FROM checkpoints WHERE tenant=? AND consumer=?', [t, c]))[0]?.p ??
  '0';
const count = async (table, where = '', values = []) =>
  Number((await sql(`SELECT COUNT(*) AS n FROM ${table} ${where}`, values))[0].n);
const report = { node: process.versions.node, format, action, checks: [], sqlMode: null, settings: null };
const check = async (name, fn) => {
  await fn();
  report.checks.push(name);
  console.log('PASS', name);
};
try {
  const app = await open({ batchSize: 2 });
  const [[settings]] = await pool.query(
    'SELECT VERSION() AS version,@@sql_mode AS mode,@@transaction_isolation AS isolationLevel,@@innodb_flush_log_at_trx_commit AS flushLog,@@sync_binlog AS syncBinlog,@@log_bin AS logBin,@@innodb_lock_wait_timeout AS rowWait,@@lock_wait_timeout AS metadataWait,@@max_execution_time AS selectMs',
  );
  report.settings = settings;
  report.sqlMode = settings.mode;
  if (action === 'process-reopen') {
    assert.equal(await count('mail_projection', "WHERE tenant='process' AND consumer='mail'"), 1);
    assert.equal(await checkpoint('process', 'mail'), '0');
    let deliveries = 0;
    assert.equal(
      await app.consumeBatch('process', 'mail', async (event, signal) => {
        deliveries++;
        assert.equal(await app.deliverToInbox('mail', event, signal), false);
      }),
      1,
    );
    assert.equal(deliveries, 1);
    assert.equal(await checkpoint('process', 'mail'), '1');
    assert.deepEqual(await app.projection('process', 'mail'), [{ tenant: 'process', consumer: 'mail', delivered: 1 }]);
    report.checks.push('actual terminated process replay/idempotent destination');
  } else if (action === 'process-wait') {
    await app.initialize();
    await app.append('process', cmd(1));
    await app.consumeBatch('process', 'mail', async (event, signal) => {
      await app.deliverToInbox('mail', event, signal);
      console.log('PROCESS_EFFECT_READY');
      await new Promise(() => {});
    });
    assert.fail('Parent must terminate this process before checkpoint acknowledgement');
  } else if (action === 'init') {
    await app.initialize();
  } else {
    await app.initialize();
    await check('full synchronous capture and exact persisted/replayed values', async () => {
      const input = cmd(1),
        expected = cmd(1);
      let reads = 0;
      const getter = {};
      for (const k of Object.keys(input))
        Object.defineProperty(getter, k, {
          get() {
            reads++;
            return input[k];
          },
        });
      const pending = app.append('A', getter);
      assert.equal(reads, 7);
      input.body.fill(1);
      input.quantity = '2';
      input.amount = '0';
      input.title = 'changed';
      assert.deepEqual(await pending, { ...expected, tenant: 'A', position: '1' });
      await app.append('A', cmd(2));
      await app.append('A', cmd(3));
      await app.append('B', cmd(1));
      const seen = [];
      assert.equal(
        await app.consumeBatch('A', 'capture', (e) => {
          seen.push(structuredClone(e));
          e.position = '999';
          e.tenant = 'B';
          e.body.fill(8);
          e.amount = '0';
        }),
        2,
      );
      assert.equal(await checkpoint('A', 'capture'), '2');
      assert.equal(
        await app.consumeBatch('A', 'capture', (e) => {
          seen.push(structuredClone(e));
        }),
        1,
      );
      for (let n = 1; n <= 3; n++) {
        const e = seen[n - 1];
        e.body = Buffer.from(e.body);
        assert.deepEqual(e, { ...cmd(n), tenant: 'A', position: String(n) });
      }
      const rows = await sql(
        'SELECT tenant,CAST(position AS CHAR) AS position,event_id AS eventId,order_id AS orderId,title,CAST(quantity AS CHAR) AS quantity,amount,occurred_at AS occurredAt,body FROM outbox WHERE tenant=? ORDER BY position',
        ['A'],
      );
      assert.deepEqual(
        rows,
        [1, 2, 3].map((n) => ({ ...cmd(n), tenant: 'A', position: String(n) })),
      );
      const orders = await sql(
        'SELECT tenant,order_id AS orderId,title,CAST(quantity AS CHAR) AS quantity,amount,occurred_at AS occurredAt,body FROM orders WHERE tenant=? ORDER BY order_id',
        ['A'],
      );
      assert.deepEqual(
        orders,
        [1, 2, 3].map((n) => {
          const { eventId, ...c } = cmd(n);
          return { ...c, tenant: 'A' };
        }),
      );
    });
    await check('identical ID and every mismatched command field; tenant isolation', async () => {
      assert.equal((await app.append('A', cmd(1))).position, '1');
      for (const patch of [
        { orderId: 'different' },
        { title: null },
        { quantity: '1' },
        { amount: '1.0' },
        { occurredAt: '2026-11-07T12:34:56.123457Z' },
        { body: Buffer.from([1]) },
      ])
        await fail(app.append('A', { ...cmd(1), ...patch }), (e) => /eventId mismatch/.test(why(e)));
      assert.equal(await count('orders'), 4);
      assert.equal((await app.append('B', cmd(2))).position, '2');
    });
    await check('business failure rolls back stream/order/outbox atomically', async () => {
      await fail(app.append('A', { ...cmd(4), orderId: 'o1' }), (e) => e instanceof Unacknowledged && !e.uncertain);
      assert.equal((await app.append('A', cmd(4))).position, '4');
      assert.equal(await count('outbox', "WHERE tenant='A'"), 4);
    });
    await check('native stream lock precedes reads; independent tenants and commit order', async () => {
      await app.append('locked', cmd(1));
      const c = await pool.getConnection();
      try {
        await c.beginTransaction();
        await c.query("SELECT position FROM tenant_stream WHERE tenant='locked' FOR UPDATE");
        let finished = false;
        const pending = app.append('locked', cmd(2)).finally(() => {
          finished = true;
        });
        const independent = await app.append('independent', cmd(1));
        assert.equal(independent.position, '1');
        assert.equal(finished, false);
        await c.commit();
        assert.equal((await pending).position, '2');
      } finally {
        c.release();
      }
      const [a, b] = await Promise.all([app.append('race', cmd(1)), app.append('race', cmd(2))]);
      assert.deepEqual([a.position, b.position].sort(), ['1', '2']);
      const same = await Promise.all([app.append('same', cmd(1)), app.append('same', cmd(1))]);
      assert.deepEqual(
        same.map((e) => e.position),
        ['1', '1'],
      );
    });
    await check('native lock timeout is finite and rolls back without effect', async () => {
      const c = await pool.getConnection();
      try {
        await c.beginTransaction();
        await c.query("SELECT position FROM tenant_stream WHERE tenant='locked' FOR UPDATE");
        await fail(app.append('locked', cmd(3)), (e) => /lock wait|Lock wait/i.test(why(e)) && !e.uncertain);
        await c.rollback();
      } finally {
        c.release();
      }
      assert.equal(await count('orders', "WHERE tenant='locked'"), 2);
    });
    await check('checkpoint race and mixed ESM/CJS/copy reentry', async () => {
      const second = await open({}, other.openOrderApplication),
        entered = gate(),
        release = gate();
      let first = true;
      const got = [];
      const p = app.consumeBatch('A', 'race', async (e) => {
        got.push(e.position);
        if (first) {
          first = false;
          entered.resolve();
          await release.promise;
        }
      });
      await entered.promise;
      const q = second.consumeBatch('A', 'race', (e) => {
        got.push(e.position);
      });
      await fail(
        second.consumeBatch('A', 'probe', async () => {
          await app.consumeBatch('A', 'probe', () => {});
        }),
        (e) => /reentry/.test(why(e)),
      );
      release.resolve();
      assert.deepEqual(await Promise.all([p, q]), [2, 2]);
      assert.deepEqual(got, ['1', '2', '3', '4']);
      await fail(
        app.consumeBatch('A', 'self-close', async () => {
          await app.close();
        }),
        (e) => /Close from callback/.test(why(e)),
      );
    });
    await check('all falsy throws reject and keep checkpoint unacknowledged', async () => {
      let index = 0;
      for (const value of [undefined, null, false, 0, '']) {
        const consumer = `falsy${index++}`;
        await fail(
          app.consumeBatch('A', consumer, () => {
            throw value;
          }),
          (e) => e instanceof Unacknowledged && !e.uncertain,
        );
        assert.equal(await checkpoint('A', consumer), '0');
      }
    });
    await check('cancellation before acknowledgement; late callback cannot acknowledge', async () => {
      const abort = new AbortController();
      await fail(app.consumeBatch('A', 'abort', () => abort.abort(false), abort.signal));
      assert.equal(await checkpoint('A', 'abort'), '0');
      const fast = await open({ callbackMs: 30 }),
        late = gate();
      await fail(
        fast.consumeBatch('A', 'late', () => late.promise),
        (e) => /Callback deadline/.test(why(e)),
      );
      assert.equal(fast.outstandingCallbacks, 1);
      await fast.close();
      late.resolve();
      await Promise.resolve();
      await Promise.resolve();
      assert.equal(await checkpoint('A', 'late'), '0');
      const pre = new AbortController();
      pre.abort();
      await fail(app.append('pre', cmd(1), pre.signal));
      assert.equal(await count('orders', "WHERE tenant='pre'"), 0);
    });
    await check('persistent idempotent destination after effect/failure/reopen', async () => {
      let effects = 0;
      await fail(
        app.consumeBatch('B', 'mail', async (event, signal) => {
          if (await app.deliverToInbox('mail', event, signal)) effects++;
          throw false;
        }),
      );
      assert.equal(effects, 1);
      assert.equal(await checkpoint('B', 'mail'), '0');
      const reopened = await open();
      assert.equal(
        await reopened.consumeBatch('B', 'mail', async (event, signal) => {
          if (await reopened.deliverToInbox('mail', event, signal)) effects++;
        }),
        2,
      );
      assert.equal(effects, 2);
      assert.deepEqual(await reopened.projection('B', 'mail'), [{ tenant: 'B', consumer: 'mail', delivered: 2 }]);
      await fail(reopened.deliverToInbox('mail', { ...cmd(1), title: 'mismatch', tenant: 'B', position: '1' }), (e) =>
        /Destination eventId mismatch/.test(why(e)),
      );
    });
    await check('numeric/input bounds and overflow reject before persistent effects', async () => {
      for (const o of [
        { batchSize: NaN },
        { batchSize: Infinity },
        { batchSize: 33 },
        { batchSize: 1.1 },
        { callbackMs: Infinity },
        { operationMs: Number.MAX_SAFE_INTEGER + 1 },
        { sqlMs: 0 },
      ])
        await fail(open(o), (e) => e instanceof TypeError);
      for (const c of [
        { ...cmd(8), quantity: '9223372036854775808' },
        { ...cmd(8), body: Buffer.alloc(65537) },
        { ...cmd(8), title: '\ud800' },
        { ...cmd(8), occurredAt: '2026-02-30T12:34:56.000000Z' },
      ])
        assert.throws(() => app.append('bad', c));
      await sql("INSERT INTO tenant_stream VALUES('overflow',9223372036854775807)");
      await fail(app.append('overflow', cmd(1)), (e) => /Position overflow/.test(why(e)));
      assert.equal(await count('orders', "WHERE tenant='overflow'"), 0);
    });
    await check('finite acquisition and caller config/session ownership', async () => {
      const held = [];
      try {
        for (let n = 0; n < 8; n++) held.push(await pool.getConnection());
        await fail(app.append('pool-full', cmd(1)));
      } finally {
        for (const c of held) c.release();
      }
      assert.equal(pool.pool.config.waitForConnections, false);
      assert.equal(pool.pool.config.connectionLimit, 8);
      const [[after]] = await pool.query(
        'SELECT @@sql_mode AS mode,@@transaction_isolation AS isolationLevel,@@innodb_lock_wait_timeout AS rowWait,@@lock_wait_timeout AS metadataWait,@@max_execution_time AS selectMs',
      );
      for (const k of Object.keys(after)) assert.equal(after[k], settings[k]);
      const c = await pool.getConnection();
      try {
        await c.query('SET SESSION innodb_lock_wait_timeout=5');
        const badPool = createPool({ ...config, connectionLimit: 1 });
        const session = await badPool.getConnection();
        await session.query('SET SESSION innodb_lock_wait_timeout=5');
        session.release();
        try {
          await fail(openOrderApplication({ pool: badPool }), (e) => /bound/i.test(why(e)));
        } finally {
          await badPool.end();
        }
      } finally {
        await c.query('SET SESSION innodb_lock_wait_timeout=1');
        c.release();
      }
    });
    await check('late native acquisition stays owned through cancellation and close', async () => {
      const latePool = createPool({ ...config, connectionLimit: 1 }),
        get = latePool.getConnection.bind(latePool);
      let armed = false;
      const entered = gate(),
        release = gate();
      latePool.getConnection = async () => {
        const c = await get();
        if (armed) {
          armed = false;
          entered.resolve();
          await release.promise;
        }
        return c;
      };
      let late;
      try {
        late = await openOrderApplication({ pool: latePool });
        armed = true;
        const abort = new AbortController();
        const p = late.append('late-acquire', cmd(1), abort.signal);
        const rejected = fail(p);
        await entered.promise;
        abort.abort();
        await rejected;
        let closed = false;
        const closing = late.close().then(() => {
          closed = true;
        });
        await Promise.resolve();
        assert.equal(closed, false);
        release.resolve();
        await closing;
        await latePool.query('SELECT 1');
      } finally {
        release.resolve();
        await late?.close();
        await latePool.end();
      }
    });
    await check('checkout BEGIN retry stays before effects; dispatched writes never auto-retry', async () => {
      const faultPool = createPool({ ...config, connectionLimit: 2 }),
        get = faultPool.getConnection.bind(faultPool);
      let beginFault = false,
        writeFault = false,
        begins = 0,
        writes = 0;
      faultPool.getConnection = async () => {
        const c = await get(),
          q = c.query.bind(c),
          execute = c.execute.bind(c);
        c.query = async (s, v) => {
          if ((s.sql ?? s) === 'START TRANSACTION') {
            begins++;
            if (beginFault) {
              beginFault = false;
              c.destroy();
              throw Object.assign(new Error('native pre-effect stale lease'), { code: 'ECONNRESET' });
            }
          }
          return q(s, v);
        };
        c.execute = async (s, v) => {
          if (String(s.sql ?? s).startsWith('INSERT INTO orders')) {
            writes++;
            const result = await execute(s, v);
            if (writeFault) {
              writeFault = false;
              throw new Error('post-dispatch order response suppressed');
            }
            return result;
          }
          return execute(s, v);
        };
        return c;
      };
      let fault;
      try {
        fault = await openOrderApplication({ pool: faultPool });
        const before = begins;
        beginFault = true;
        assert.equal((await fault.append('begin-retry', cmd(1))).position, '1');
        assert.equal(begins - before, 2);
        assert.equal(writes, 1);
        writeFault = true;
        await fail(fault.append('write-no-retry', cmd(1)), (e) => !e.uncertain);
        assert.equal(writes, 2);
        assert.equal(await count('orders', "WHERE tenant='write-no-retry'"), 0);
        assert.equal((await app.append('write-no-retry', cmd(1))).position, '1');
      } finally {
        await fault?.close();
        await faultPool.end();
      }
    });
    await check('native storage engine, durability and isolation refusal before effects', async () => {
      await pool.query('ALTER TABLE checkpoints ENGINE=MyISAM');
      try {
        await fail(app.append('engine-refusal', cmd(1)), (e) => /must use InnoDB/.test(why(e)));
      } finally {
        await pool.query('ALTER TABLE checkpoints ENGINE=InnoDB');
      }
      await pool.query('SET GLOBAL innodb_flush_log_at_trx_commit=2');
      try {
        await fail(app.append('durability-refusal', cmd(1)), (e) => /durability/.test(why(e)));
      } finally {
        await pool.query('SET GLOBAL innodb_flush_log_at_trx_commit=1');
      }
      const bad = createPool({ ...config, connectionLimit: 1 });
      try {
        const c = await bad.getConnection();
        await c.query('SET SESSION TRANSACTION ISOLATION LEVEL READ COMMITTED');
        c.release();
        await fail(openOrderApplication({ pool: bad }), (e) => /isolation/.test(why(e)));
      } finally {
        await bad.end();
      }
      for (const tenant of ['engine-refusal', 'durability-refusal'])
        assert.equal(await count('orders', 'WHERE tenant=?', [tenant]), 0);
    });
    await check('paused native prepare response settles on socket termination before close', async () => {
      const blockedPool = createPool({ ...config, connectionLimit: 1 }),
        get = blockedPool.getConnection.bind(blockedPool);
      let armed = false,
        paused = false;
      blockedPool.getConnection = async () => {
        const c = await get(),
          execute = c.execute.bind(c);
        c.execute = (s, v) => {
          if (armed) {
            armed = false;
            paused = true;
            c.connection.stream.pause();
          }
          return execute(s, v);
        };
        return c;
      };
      let blocked;
      try {
        blocked = await openOrderApplication({ pool: blockedPool, sqlMs: 50 });
        armed = true;
        await fail(blocked.append('prepare-gap', cmd(1)), (e) => e.uncertain && /SQL deadline/.test(why(e)));
        assert.equal(paused, true);
        const close = blocked.close();
        let timer;
        try {
          await Promise.race([
            close,
            new Promise((_, reject) => {
              timer = setTimeout(() => reject(new Error('close failed to own Prepare settlement')), 1000);
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
        assert.equal(await count('orders', "WHERE tenant='prepare-gap'"), 0);
        await blockedPool.query('SELECT 1');
      } finally {
        await blocked?.close();
        await blockedPool.end();
      }
    });
    await check('native SQL deadline destroys leased session; settlement ownership', async () => {
      const slowPool = createPool({ ...config, connectionLimit: 1 });
      const get = slowPool.getConnection.bind(slowPool);
      let inject = false,
        id;
      slowPool.getConnection = async () => {
        const c = await get();
        const query = c.query.bind(c);
        c.query = async (s, v) => {
          if (inject && String(s.sql ?? s).startsWith('SELECT @@server_uuid')) {
            id = c.threadId;
            return query({ sql: 'SELECT SLEEP(10)', timeout: 50 });
          }
          return query(s, v);
        };
        return c;
      };
      let slow;
      try {
        slow = await openOrderApplication({ pool: slowPool, sqlMs: 50 });
        inject = true;
        await fail(slow.append('slow', cmd(1)), (e) => /SQL deadline|inactivity timeout/.test(why(e)));
        await slow.close();
        let rows;
        for (let attempt = 0; attempt < 250; attempt++) {
          rows = await sql('SELECT ID FROM information_schema.PROCESSLIST WHERE ID=?', [id]);
          if (!rows.length) break;
          await new Promise((r) => setTimeout(r, 10));
        }
        assert.deepEqual(rows, []);
      } finally {
        await slow?.close();
        await slowPool.end();
      }
    });
    await check('native committed response suppression is uncertain and reconciles', async () => {
      const faultPool = createPool({ ...config, connectionLimit: 2 });
      const get = faultPool.getConnection.bind(faultPool);
      let armed = false,
        commits = 0;
      faultPool.getConnection = async () => {
        const c = await get();
        const q = c.query.bind(c);
        c.query = async (s, v) => {
          const result = await q(s, v);
          if (armed && (s.sql ?? s) === 'COMMIT') {
            armed = false;
            commits++;
            c.destroy();
            throw Object.assign(new Error('Native COMMIT response suppressed'), { code: 'ECONNRESET' });
          }
          return result;
        };
        return c;
      };
      let fault;
      try {
        fault = await openOrderApplication({ pool: faultPool });
        armed = true;
        await fail(fault.append('lost', cmd(1)), (e) => e.uncertain);
        assert.equal(commits, 1);
        assert.equal((await app.append('lost', cmd(1))).position, '1');
        assert.equal(await count('orders', "WHERE tenant='lost'"), 1);
        armed = true;
        await fail(
          fault.consumeBatch('lost', 'mail', async (e, s) => {
            await app.deliverToInbox('mail', e, s);
          }),
          (e) => e.uncertain,
        );
        assert.equal(await app.consumeBatch('lost', 'mail', () => assert.fail('checkpoint already committed')), 0);
      } finally {
        await fault?.close();
        await faultPool.end();
      }
    });
    await check('unsettled callback/operation caps and close sealing/pool survival', async () => {
      const capped = await open({ callbackMs: 20 }),
        pending = [];
      for (let i = 0; i < 8; i++) {
        const g = gate();
        pending.push(g);
        await fail(capped.consumeBatch('A', `cap${i}`, () => g.promise));
      }
      assert.equal(capped.outstandingCallbacks, 8);
      await fail(
        capped.consumeBatch('A', 'cap9', () => {}),
        (e) => /callback cap/.test(why(e)),
      );
      const ops = await open({ callbackMs: 1000 }),
        entered = gate(),
        release = gate();
      let calls = 0;
      const tasks = Array.from({ length: 8 }, (_, i) =>
        ops.consumeBatch('A', `ops${i}`, async () => {
          if (++calls === 8) entered.resolve();
          await release.promise;
        }),
      );
      const settled = Promise.allSettled(tasks);
      await entered.promise;
      await fail(ops.append('capped', cmd(1)), (e) => /Operation cap/.test(why(e)));
      const closed = ops.close();
      await fail(ops.append('sealed', cmd(1)), (e) => /closing/.test(why(e)));
      await closed;
      release.resolve();
      await settled;
      await capped.close();
      for (const p of pending) p.resolve();
      await pool.query('SELECT 42');
    });
  }
  report.passed = true;
} finally {
  await Promise.allSettled(apps.map((a) => a.close()));
  await pool.end();
  if (output) writeFileSync(output, JSON.stringify(report, null, 2));
}
