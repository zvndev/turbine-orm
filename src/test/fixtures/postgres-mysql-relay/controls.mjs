import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const [format, mode, output] = process.argv.slice(2);
const require = createRequire(import.meta.url);
const pg = require('pg');
const { createPool } = require('mysql2/promise');
const base = `./${format}/examples/`;
const relayModule = await import(
  pathToFileURL(
    process.env.RELAY_RELAY ?? new URL(`${base}postgres-mysql-relay/application.js`, import.meta.url).pathname,
  )
);
const { openOrderApplication } = await import(`${base}mysql-durable-replay/application.js`);
const { createOrderApplication } = await import(`${base}postgres-durable-replay/application.js`);
const { openOrderRelay } = relayModule;
const pools = [],
  relays = [],
  apps = [];
const schema = process.env.PG_SCHEMA;
const history = process.env.SOURCE_HISTORY_ID;
const report = { node: process.version, format, mode, passed: [], failed: [], raw: [] };
const sourcePool = () => {
  const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    max: 6,
    connectionTimeoutMillis: 600,
    query_timeout: 3000,
    statement_timeout: 2500,
  });
  pool.on('error', () => {});
  pools.push(pool);
  return pool;
};
const targetPool = () => {
  const pool = createPool({
    host: '127.0.0.1',
    port: Number(process.env.MYSQL_PORT),
    user: 'root',
    database: process.env.MYSQL_DATABASE,
    namedPlaceholders: true,
    supportBigNumbers: true,
    bigNumberStrings: true,
    waitForConnections: false,
    connectionLimit: 4,
    connectTimeout: 600,
  });
  pools.push(pool);
  return pool;
};
const source = sourcePool(),
  target = targetPool();
const options = {
  sourcePool: source,
  targetPool: target,
  schema,
  sourceHistoryId: history,
  consumer: 'mail',
  endpoint: 'direct',
  onDiagnostic() {},
  batchSize: 2,
};
async function open(extra = {}, factory = openOrderRelay) {
  const app = await factory({ ...options, ...extra });
  relays.push(app);
  return app;
}
function command(n, extra = {}) {
  const id = n.toString(16).padStart(12, '0');
  return {
    eventId: `00000000-0000-0000-0000-${id}`,
    orderId: `10000000-0000-0000-0000-${id}`,
    title: n % 2 ? "é雪💧'\\" : null,
    quantity: '9223372036854775807',
    amount: '123456789012345678901234567890.123456789012',
    occurredAt: '2026-11-07T12:34:56.123456Z',
    body: Buffer.from([0, 255, 128, 39, 92, n % 256]),
    ...extra,
  };
}
function payload(c) {
  return Buffer.from(
    JSON.stringify([c.eventId, c.orderId, c.title, c.quantity, c.amount, c.occurredAt, c.body.toString('hex')]),
  );
}
async function checkpoint(tenant, binding) {
  return (
    (
      await source.query(
        `SELECT last_position::text AS p FROM "${schema}".checkpoints WHERE tenant=$1 AND consumer=$2`,
        [tenant, binding],
      )
    ).rows[0]?.p ?? '0'
  );
}
async function effect(tenant, binding) {
  const [rows] = await target.execute('SELECT delivered FROM mail_projection WHERE tenant=? AND consumer=?', [
    tenant,
    binding,
  ]);
  return rows[0]?.delivered ?? 0;
}
async function exact(tenant, binding, commands, last = String(commands.length)) {
  const columns = `order_id::text AS "orderId",title,quantity::text,amount::text,to_char(occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "occurredAt",encode(body,'hex') AS body`;
  const orders = (
    await source.query(`SELECT tenant,${columns} FROM "${schema}".orders WHERE tenant=$1 ORDER BY order_id`, [tenant])
  ).rows;
  const outbox = (
    await source.query(
      `SELECT tenant,position::text,event_id::text AS "eventId",${columns} FROM "${schema}".outbox WHERE tenant=$1 ORDER BY position`,
      [tenant],
    )
  ).rows;
  const expected = commands.map((c) => ({
    tenant,
    orderId: c.orderId,
    title: c.title,
    quantity: c.quantity,
    amount: c.amount,
    occurredAt: c.occurredAt,
    body: c.body.toString('hex'),
  }));
  assert.deepEqual(
    orders,
    [...expected].sort((a, b) => a.orderId.localeCompare(b.orderId)),
  );
  assert.deepEqual(
    outbox,
    expected.map((c, i) => ({ ...c, eventId: commands[i].eventId, position: String(i + 1) })),
  );
  const [inbox] = await target.execute(
    'SELECT tenant,consumer,event_id,payload FROM inbox WHERE tenant=? AND consumer=? ORDER BY event_id',
    [tenant, binding],
  );
  assert.deepEqual(
    inbox,
    commands
      .map((c) => ({ tenant, consumer: binding, event_id: c.eventId, payload: payload(c) }))
      .sort((a, b) => a.event_id.localeCompare(b.event_id)),
  );
  assert.equal(await effect(tenant, binding), commands.length);
  assert.equal(await checkpoint(tenant, binding), last);
  report.raw.push({ tenant, binding, orders, outbox, inbox, projection: commands.length, checkpoint: last });
}
function instrumentMysql(pool, hook) {
  const get = pool.getConnection.bind(pool);
  pool.getConnection = async () => {
    const c = await get(),
      originals = {};
    for (const method of ['query', 'execute']) {
      originals[method] = c[method];
      c[method] = async (s, ...v) => {
        const sql = String(s.sql ?? s);
        await hook('before', sql, v);
        const result = await originals[method].call(c, s, ...v);
        await hook('after', sql, v);
        return result;
      };
    }
    const release = c.release;
    c.release = () => {
      Object.assign(c, originals);
      c.release = release;
      return release.call(c);
    };
    return c;
  };
}
function instrumentPg(pool, hook) {
  const get = pool.connect.bind(pool);
  const acquire = async () => {
    const c = await get(),
      query = c.query,
      release = c.release;
    c.query = async (s, ...v) => {
      const sql = String(s.text ?? s);
      await hook('before', sql);
      const result = await query.call(c, s, ...v);
      await hook('after', sql);
      return result;
    };
    c.release = (...v) => {
      c.query = query;
      c.release = release;
      return release.apply(c, v);
    };
    return c;
  };
  pool.connect = (...args) => (args.length ? get(...args) : acquire());
}
async function rejected(action, verify = () => true) {
  let caught = false;
  try {
    await action();
  } catch (error) {
    caught = true;
    assert.ok(verify(error), `Unexpected rejection: ${String(error)}`);
  }
  assert.equal(caught, true, 'operation must reject without acknowledgement');
}
async function check(name, action) {
  try {
    await action();
    report.passed.push(name);
  } catch (error) {
    report.failed.push({ name, error: String(error), stack: error?.stack });
  }
}
function hasCause(error, expected) {
  for (let n = 0; n < 12; n++) {
    if (Object.is(error, expected)) return true;
    if (!error || !Object.hasOwn(error, 'cause')) return false;
    error = error.cause;
  }
  return false;
}

try {
  const relay = await open();
  if (mode === 'crash') {
    let armed = true,
      effectStarted = false;
    instrumentMysql(target, async (phase, sql) => {
      if (phase === 'before' && /^INSERT INTO mail_projection/i.test(sql)) effectStarted = true;
      if (armed && effectStarted && phase === 'after' && /^COMMIT/i.test(sql)) {
        armed = false;
        process.stdout.write('TARGET_COMMITTED_BEFORE_SOURCE\n');
        process.kill(process.pid, 'SIGKILL');
      }
    });
    await relay.relayBatch('crash');
    assert.fail('crash point was not reached');
  } else if (mode === 'reopen') {
    await check('actual process death after target commit leaves source for reopen/redelivery', async () => {
      assert.equal(await checkpoint('crash', relay.binding), '0');
      assert.equal(await effect('crash', relay.binding), 1);
      assert.equal(await relay.relayBatch('crash'), 1);
      assert.equal(await relay.relayBatch('crash'), 0);
      await exact('crash', relay.binding, [command(900)]);
    });
  } else {
    await relay.initialize();
    await check('exact source rows, full inbox payload and projection survive repeat and reopen', async () => {
      const a = command(1),
        b = command(2);
      await relay.append('exact', a);
      await relay.append('exact', b);
      assert.equal(await relay.relayBatch('exact'), 2);
      assert.equal(await relay.relayBatch('exact'), 0);
      await exact('exact', relay.binding, [a, b]);
      const reopened = await open();
      assert.equal(await reopened.relayBatch('exact'), 0);
    });
    await check('properties captured once and caller mutation cannot change durable bytes', async () => {
      const c = command(3),
        expected = { ...c, body: Buffer.from(c.body) },
        reads = {};
      const input = Object.fromEntries(Object.keys(c).map((k) => [k, c[k]]));
      for (const k of Object.keys(c))
        Object.defineProperty(input, k, {
          get() {
            reads[k] = (reads[k] ?? 0) + 1;
            return c[k];
          },
        });
      const pending = relay.append('capture', input);
      c.body.fill(4);
      c.title = 'changed';
      c.amount = '0';
      await pending;
      assert.ok(Object.values(reads).every((n) => n === 1));
      await relay.relayBatch('capture');
      await exact('capture', relay.binding, [expected]);
    });
    await check(
      'competing mixed-format same-consumer instances serialize; independent consumers and tenants replay',
      async () => {
        const otherFormat = format === 'esm' ? 'cjs' : 'esm';
        const other = await import(`./${otherFormat}/examples/postgres-mysql-relay/application.js`);
        const second = await open({}, other.openOrderRelay);
        const c = command(4);
        await relay.append('compete', c);
        assert.deepEqual(
          (await Promise.all([relay.relayBatch('compete'), second.relayBatch('compete')])).sort(),
          [0, 1],
        );
        await exact('compete', relay.binding, [c]);
        const independent = await open({ consumer: 'audit' });
        assert.equal(await independent.relayBatch('compete'), 1);
        await exact('compete', independent.binding, [c]);
        await relay.append('another_tenant', c);
        await relay.relayBatch('another_tenant');
        await exact('another_tenant', relay.binding, [c]);
        const separateHistory = await open({ sourceHistoryId: randomUUID() });
        assert.notEqual(separateHistory.binding, relay.binding);
        assert.equal(await separateHistory.relayBatch('compete'), 1);
        await exact('compete', separateHistory.binding, [c]);
      },
    );
    await check(
      'source exact duplicate accepts, mismatched reuse refuses; reset source replay deduplicates target',
      async () => {
        const c = command(5);
        assert.deepEqual(await relay.append('duplicate', c), await relay.append('duplicate', c));
        await rejected(() => relay.append('duplicate', { ...c, amount: '1.00' }));
        await relay.relayBatch('duplicate');
        await source.query(`UPDATE "${schema}".checkpoints SET last_position=0 WHERE tenant=$1 AND consumer=$2`, [
          'duplicate',
          relay.binding,
        ]);
        assert.equal(await relay.relayBatch('duplicate'), 1);
        await exact('duplicate', relay.binding, [c]);
      },
    );
    await check('conflicting destination receipt refuses with no source acknowledgement', async () => {
      const c = command(6);
      const event = await relay.append('mismatch', c);
      const app = await openOrderApplication({ pool: target });
      apps.push(app);
      await app.deliverToInbox(relay.binding, { ...event, title: 'different' });
      await rejected(() => relay.relayBatch('mismatch'));
      assert.equal(await checkpoint('mismatch', relay.binding), '0');
      assert.equal(await effect('mismatch', relay.binding), 1);
      const [rows] = await target.execute('SELECT payload FROM inbox WHERE tenant=? AND consumer=?', [
        'mismatch',
        relay.binding,
      ]);
      assert.deepEqual(rows[0].payload, payload({ ...c, title: 'different' }));
    });
    await check('target rollback including falsy errors never advances source', async () => {
      const p = targetPool();
      let armed = false,
        reason;
      instrumentMysql(p, async (phase, sql) => {
        if (armed && phase === 'after' && /^INSERT INTO inbox/i.test(sql)) {
          armed = false;
          throw reason;
        }
      });
      const failing = await open({ targetPool: p });
      for (const [i, value] of [undefined, null, false, 0, ''].entries()) {
        const tenant = `falsy_${i}`;
        reason = value;
        const c = command(20 + i);
        await relay.append(tenant, c);
        armed = true;
        await rejected(
          () => failing.relayBatch(tenant),
          (e) => hasCause(e, value),
        );
        assert.equal(await checkpoint(tenant, relay.binding), '0');
        assert.equal(await effect(tenant, relay.binding), 0);
        const [[row]] = await target.execute('SELECT COUNT(*) AS n FROM inbox WHERE tenant=?', [tenant]);
        assert.equal(String(row.n), '0');
        await relay.relayBatch(tenant);
        await exact(tenant, relay.binding, [c]);
      }
    });
    await check('target commit response lost replays exact receipt without a second effect', async () => {
      const p = targetPool();
      let armed = false,
        effectStarted = false;
      const lost = new Error('target response lost after native COMMIT');
      instrumentMysql(p, async (phase, sql) => {
        if (phase === 'before' && /^INSERT INTO mail_projection/i.test(sql)) effectStarted = true;
        if (armed && effectStarted && phase === 'after' && /^COMMIT/i.test(sql)) {
          armed = false;
          throw lost;
        }
      });
      const faulty = await open({ targetPool: p });
      const c = command(30);
      await relay.append('target_lost', c);
      armed = true;
      await rejected(
        () => faulty.relayBatch('target_lost'),
        (e) => e.uncertain === true && hasCause(e, lost),
      );
      assert.equal(await checkpoint('target_lost', relay.binding), '0');
      assert.equal(await effect('target_lost', relay.binding), 1);
      await relay.relayBatch('target_lost');
      await exact('target_lost', relay.binding, [c]);
    });
    await check('source commit response lost reads committed checkpoint on retry', async () => {
      const p = sourcePool();
      let armed = false;
      const lost = new Error('source response lost after native COMMIT');
      instrumentPg(p, async (phase, sql) => {
        if (armed && phase === 'after' && /^COMMIT/i.test(sql)) {
          armed = false;
          throw lost;
        }
      });
      const faulty = await open({ sourcePool: p });
      const c = command(31);
      await relay.append('source_lost', c);
      armed = true;
      await rejected(
        () => faulty.relayBatch('source_lost'),
        (e) => hasCause(e, lost),
      );
      assert.equal(await checkpoint('source_lost', relay.binding), '1');
      assert.equal(await relay.relayBatch('source_lost'), 0);
      await exact('source_lost', relay.binding, [c]);
    });
    await check('source broader year and tenant domains cannot be silently acknowledged', async () => {
      const app = createOrderApplication({ pool: source, schema, endpoint: 'direct', onDiagnostic() {} });
      apps.push(app);
      await app.append('old_year', command(40, { occurredAt: '0999-01-01T00:00:00.123456Z' }));
      await rejected(() => relay.relayBatch('old_year'));
      assert.equal(await checkpoint('old_year', relay.binding), '0');
      assert.equal(await effect('old_year', relay.binding), 0);
      for (const tenant of ['é', 'long'.repeat(20), '', 'a b']) {
        await rejected(() => relay.relayBatch(tenant));
        await rejected(() => relay.append(tenant, command(41)));
      }
      for (const extra of [
        { occurredAt: '0999-01-01T00:00:00.123456Z' },
        { occurredAt: '2026-02-30T00:00:00.123456Z' },
        { quantity: '9223372036854775808' },
        { amount: '1e3' },
        { title: '\0' },
        { title: '\ud800' },
        { eventId: 'not_uuid' },
      ])
        await rejected(() => relay.append('refuse', command(42, extra)));
      assert.equal(
        (await source.query(`SELECT count(*)::int AS n FROM "${schema}".orders WHERE tenant='refuse'`)).rows[0].n,
        0,
      );
    });
    await check('finite numeric caps reject NaN/Infinity and unsafe values before effects', async () => {
      for (const name of ['batchSize', 'sqlMs', 'operationMs'])
        for (const value of [NaN, Infinity, -Infinity, 0, -1, 1.1, Number.MAX_SAFE_INTEGER])
          await rejected(() => open({ [name]: value }));
      for (const name of ['maxBatches', 'intervalMs'])
        for (const value of [NaN, Infinity, 0, 1.1, 9000])
          await rejected(() => relay.reconcile('caps', { [name]: value }));
      await rejected(() => open({ consumer: 'x'.repeat(28) }));
      await rejected(() => open({ sourceHistoryId: 'not_uuid' }));
      for (const name of ['connectionTimeoutMillis', 'query_timeout', 'statement_timeout']) {
        const p = sourcePool(),
          before = p.options[name];
        p.options[name] = NaN;
        await rejected(() => open({ sourcePool: p }));
        assert.ok(Number.isNaN(p.options[name]));
        p.options[name] = before;
      }
    });
    await check('startup refuses incompatible target charset and leaves caller resources alive', async () => {
      const p = createPool({
        ...target.pool.config.connectionConfig,
        charset: 'LATIN1_SWEDISH_CI',
        charsetNumber: undefined,
        waitForConnections: false,
        connectionLimit: 4,
      });
      pools.push(p);
      await rejected(() => open({ targetPool: p }));
      await p.query('SELECT 1');
      await source.query('SELECT 1');
    });
    await check('overall deadline, external abort, admission cap and close drain native target work', async () => {
      const p = targetPool();
      let block = false;
      instrumentMysql(p, async (phase, sql) => {
        if (block && phase === 'before' && /^INSERT INTO mail_projection/i.test(sql)) {
          block = false;
          await new Promise((r) => setTimeout(r, 150));
        }
      });
      const bounded = await open({ targetPool: p, operationMs: 40 });
      await relay.append('deadline', command(50));
      block = true;
      await rejected(() => bounded.relayBatch('deadline'));
      assert.equal(bounded.outstandingTargets, 0);
      assert.equal(await checkpoint('deadline', relay.binding), '0');
      const stop = new AbortController();
      stop.abort(false);
      await rejected(
        () => relay.relayBatch('deadline', stop.signal),
        (e) => Object.is(e, false),
      );
      const requests = Array.from({ length: 8 }, (_, i) =>
        relay.reconcile(`empty_${i}`, { maxBatches: 2, intervalMs: 100 }),
      );
      await rejected(
        () => relay.relayBatch('ninth'),
        (e) => /cap/.test(String(e)),
      );
      await Promise.all(requests);
      assert.equal(await relay.reconcile('deadline', { maxBatches: 2, intervalMs: 10 }), 1);
      await bounded.close();
      await rejected(() => bounded.relayBatch('deadline'));
      await p.query('SELECT 1');
    });
    await check('native target lock waits are bounded by SQL deadline and in-flight cancellation', async () => {
      const p = targetPool(),
        bounded = await open({ targetPool: p, sqlMs: 80 });
      for (const [i, cancel] of [false, true].entries()) {
        const tenant = `native_wait_${i}`,
          c = command(60 + i);
        await relay.append(tenant, c);
        const blocker = await target.getConnection();
        try {
          await blocker.beginTransaction();
          await blocker.query('INSERT INTO mail_projection VALUES(?,?,0)', [tenant, relay.binding]);
          const stop = new AbortController();
          const pending = bounded.relayBatch(tenant, stop.signal);
          const timer = cancel ? setTimeout(() => stop.abort(0), 30) : undefined;
          try {
            await rejected(
              () => pending,
              (e) => (cancel ? hasCause(e, 0) : /deadline|terminated/i.test(String(e) + String(e?.cause))),
            );
          } finally {
            clearTimeout(timer);
          }
          assert.equal(await checkpoint(tenant, relay.binding), '0');
          assert.equal(bounded.outstandingTargets, 0);
        } finally {
          await blocker.rollback();
          blocker.release();
        }
        assert.equal(await effect(tenant, relay.binding), 0);
        await relay.relayBatch(tenant);
        await exact(tenant, relay.binding, [c]);
      }
      await bounded.close();
      await p.query('SELECT 1');
    });
    await check('reentry and close inside native callback context refuse without self-wait', async () => {
      const p = targetPool();
      let armed = false,
        nested;
      const another = await open();
      instrumentMysql(p, async (phase, sql) => {
        if (armed && phase === 'before' && /^INSERT INTO mail_projection/i.test(sql)) {
          armed = false;
          await rejected(
            () => another.relayBatch('reentry'),
            (e) => /Recursive/.test(String(e)),
          );
          await rejected(
            () => nested.close(),
            (e) => /Close from/.test(String(e)),
          );
        }
      });
      nested = await open({ targetPool: p });
      await relay.append('reentry', command(51));
      armed = true;
      await nested.relayBatch('reentry');
      await exact('reentry', relay.binding, [command(51)]);
    });
    await relay.append('crash', command(900));
  }
} finally {
  const closed = await Promise.allSettled([...relays, ...apps].map((a) => a.close()));
  const survived = await Promise.allSettled(pools.map((p) => p.query('SELECT 1')));
  const ended = await Promise.allSettled(pools.map((p) => p.end()));
  report.cleanup = {
    closed: closed.every((r) => r.status === 'fulfilled'),
    callersSurvive: survived.every((r) => r.status === 'fulfilled'),
    ended: ended.every((r) => r.status === 'fulfilled'),
  };
  report.success = report.failed.length === 0 && Object.values(report.cleanup).every(Boolean);
  if (output) writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(
    JSON.stringify({
      success: report.success,
      node: report.node,
      format,
      mode,
      passed: report.passed.length,
      failed: report.failed,
      cleanup: report.cleanup,
    }),
  );
  if (!report.success) process.exitCode = 1;
}
