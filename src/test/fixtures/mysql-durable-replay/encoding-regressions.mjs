import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createPool } from 'mysql2/promise';

const [format, output] = process.argv.slice(2);
const load = (kind) =>
  kind === 'esm'
    ? import('./esm/application.js')
    : Promise.resolve(createRequire(import.meta.url)('./cjs/application.cjs'));
const current = await load(format),
  other = await load(format === 'esm' ? 'cjs' : 'esm');
const config = {
  host: '127.0.0.1',
  port: Number(process.env.MYSQL_PORT),
  user: 'root',
  database: process.env.MYSQL_DATABASE,
  namedPlaceholders: true,
  supportBigNumbers: true,
  bigNumberStrings: true,
  waitForConnections: false,
  connectionLimit: 4,
  connectTimeout: 500,
};
const pools = [],
  apps = [];
const pool = (options = {}) => {
  const p = createPool({ ...config, ...options });
  pools.push(p);
  return p;
};
const open = async (p, factory = current.openOrderApplication) => {
  const app = await factory({ pool: p });
  apps.push(app);
  return app;
};
const primary = pool(),
  report = { node: process.version, format, passed: [], failed: [], observations: [] };
const input = (n) => ({
  eventId: `r${n}`,
  orderId: `o${n}`,
  title: 'é雪💧',
  quantity: '9007199254740993',
  amount: '12.00000',
  occurredAt: '2026-11-07T13:21:00.123456Z',
  body: Buffer.from([0, 255, 128, 39, 92]),
});
const why = (error) => {
  const values = [];
  for (let e = error; e; e = e.cause) values.push(e.message);
  return values.join(' / ');
};
const gate = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
async function check(name, action) {
  try {
    await action();
    report.passed.push(name);
  } catch (error) {
    report.failed.push({ name, message: error.message, stack: error.stack });
  }
}
async function rows(tenant) {
  const [result] = await primary.execute('SELECT title,HEX(title) AS hex FROM outbox WHERE tenant=?', [tenant]);
  return result;
}
async function noEffects(tenant) {
  for (const table of ['tenant_stream', 'orders', 'outbox', 'checkpoints', 'inbox', 'mail_projection']) {
    const [[r]] = await primary.execute(`SELECT COUNT(*) AS n FROM ${table} WHERE tenant=?`, [tenant]);
    assert.equal(Number(r.n), 0, `${table} changed before encoding refusal`);
  }
}
try {
  const app = await open(primary);
  await check('all supported UTF8MB4 collations preserve exact title bytes', async () => {
    for (const [i, charset] of ['UTF8MB4_UNICODE_CI', 'UTF8MB4_GENERAL_CI', 'UTF8MB4_0900_AI_CI'].entries()) {
      const p = pool({ charset, connectionLimit: 1 }),
        a = await open(p),
        tenant = `review_utf8_${i}`;
      const original = input(i),
        event = await a.append(tenant, original);
      assert.deepEqual(event, { ...original, tenant, position: '1' });
      assert.deepEqual(await rows(tenant), [
        { title: original.title, hex: Buffer.from(original.title).toString('hex').toUpperCase() },
      ]);
      const seen = [];
      await a.consumeBatch(tenant, 'review', (e) => {
        seen.push(e);
      });
      assert.deepEqual(seen, [event]);
    }
  });
  for (const [i, charset] of ['LATIN1_SWEDISH_CI', 'UTF8_GENERAL_CI'].entries()) {
    await check(`incompatible native pool ${charset} refuses before effects`, async () => {
      const p = pool({ charset, connectionLimit: 1 }),
        tenant = `review_pool_${i}`;
      const number = p.pool.config.connectionConfig.charsetNumber;
      let failure;
      try {
        const a = await open(p);
        await a.append(tenant, input(10 + i));
      } catch (error) {
        failure = error;
      }
      report.observations.push({ charset, failure: why(failure), rows: await rows(tenant) });
      assert.ok(failure, 'incompatible encoding was acknowledged');
      assert.match(why(failure), /UTF-8/);
      assert.equal(p.pool.config.connectionConfig.charsetNumber, number);
      await noEffects(tenant);
    });
  }
  for (const [i, statement] of [
    'SET NAMES latin1',
    "SET character_set_client='latin1'",
    "SET character_set_connection='latin1'",
    "SET character_set_results='latin1'",
    'SET character_set_results=NULL',
  ].entries()) {
    await check(`changed caller session refuses before effects: ${statement}`, async () => {
      const p = pool({ connectionLimit: 1 }),
        a = await open(p),
        tenant = `review_session_${i}`;
      const c = await p.getConnection();
      try {
        await c.query(statement);
      } finally {
        c.release();
      }
      const query = 'SELECT @@character_set_client AS c,@@character_set_connection AS n,@@character_set_results AS r';
      const [before] = await p.query(query);
      let failure;
      try {
        await a.append(tenant, input(20 + i));
      } catch (error) {
        failure = error;
      }
      report.observations.push({ statement, failure: why(failure), rows: await rows(tenant) });
      assert.ok(failure, 'changed session encoding was acknowledged');
      assert.match(why(failure), /UTF-8/);
      assert.equal(failure.uncertain, false);
      assert.deepEqual((await p.query(query))[0], before);
      await noEffects(tenant);
    });
  }
  await check('checked-out native client encoder is admitted on each lease', async () => {
    const p = pool({ connectionLimit: 1 }),
      a = await open(p),
      c = await p.getConnection();
    const native = c.connection,
      before = native.clientEncoding;
    native.clientEncoding = 'latin1';
    c.release();
    try {
      await assert.rejects(a.append('review_encoder', input(30)), (e) => /UTF-8/.test(why(e)) && e.uncertain === false);
      assert.equal(native.clientEncoding, 'latin1');
      await noEffects('review_encoder');
    } finally {
      native.clientEncoding = before;
    }
  });
  await check('concurrent mixed-format destination calls acknowledge one effect', async () => {
    const event = await app.append('review_concurrent', input(40));
    const second = await open(primary, other.openOrderApplication);
    const results = await Promise.allSettled([app, second, app, second].map((a) => a.deliverToInbox('mail', event)));
    report.observations.push({
      concurrent: results.map((x) => (x.status === 'fulfilled' ? x : { status: x.status, error: why(x.reason) })),
    });
    assert.equal(results.filter((x) => x.status === 'rejected').length, 0);
    assert.deepEqual(results.map((x) => x.value).sort(), [false, false, false, true]);
    assert.equal((await app.projection(event.tenant, 'mail'))[0].delivered, 1);
    await assert.rejects(app.deliverToInbox('mail', { ...event, title: 'different' }), (e) =>
      /Destination eventId mismatch/.test(why(e)),
    );
    assert.equal((await app.projection(event.tenant, 'mail'))[0].delivered, 1);
  });
  await check('post-metadata destination read observes a committed inbox receipt', async () => {
    const event = await app.append('review_snapshot', input(41)),
      p = pool({ connectionLimit: 1 });
    const get = p.getConnection.bind(p),
      entered = gate(),
      release = gate();
    let armed = false;
    p.getConnection = async () => {
      const c = await get(),
        query = c.query.bind(c);
      c.query = async (s, v) => {
        const result = await query(s, v);
        if (armed && String(s.sql ?? s).startsWith('SELECT ENGINE FROM information_schema.TABLES')) {
          armed = false;
          entered.resolve();
          await release.promise;
        }
        return result;
      };
      return c;
    };
    const lag = await open(p);
    armed = true;
    const pending = lag.deliverToInbox('mail', event).then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    try {
      await entered.promise;
      assert.equal(await app.deliverToInbox('mail', event), true);
      release.resolve();
      const result = await pending;
      if (result.error) throw result.error;
      assert.equal(result.value, false);
      assert.equal((await app.projection(event.tenant, 'mail'))[0].delivered, 1);
    } finally {
      release.resolve();
      await pending;
    }
  });
} finally {
  const closed = await Promise.allSettled(apps.map((a) => a.close()));
  const usable = await Promise.allSettled(pools.map((p) => p.query('SELECT 1')));
  const ended = await Promise.allSettled(pools.map((p) => p.end()));
  report.cleanup = {
    closed: closed.every((x) => x.status === 'fulfilled'),
    callersSurvive: usable.every((x) => x.status === 'fulfilled'),
    ended: ended.every((x) => x.status === 'fulfilled'),
  };
  report.success = report.failed.length === 0 && Object.values(report.cleanup).every(Boolean);
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(
    JSON.stringify({
      success: report.success,
      pass: report.passed.length,
      failed: report.failed.map((x) => x.name),
      cleanup: report.cleanup,
    }),
  );
  if (!report.success) process.exitCode = 1;
}
