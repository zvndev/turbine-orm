import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url),
  pg = require('pg'),
  { createPool } = require('mysql2/promise');
const [kind, output] = process.argv.slice(2);
const { openOrderRelay } = await import(`./omit-${kind}/examples/postgres-mysql-relay/application.js`);
const source = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 4,
  connectionTimeoutMillis: 600,
  query_timeout: 3000,
  statement_timeout: 2500,
});
source.on('error', () => {});
const target = createPool({
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
const report = { kind, detected: false };
let relay;
try {
  relay = await openOrderRelay({
    sourcePool: source,
    targetPool: target,
    schema: process.env.PG_SCHEMA,
    sourceHistoryId: process.env.SOURCE_HISTORY_ID,
    consumer: 'mail',
    endpoint: 'direct',
    onDiagnostic() {},
  });
  await relay.initialize();
  await relay.append('control', {
    eventId: '00000000-0000-0000-0000-000000000001',
    orderId: '10000000-0000-0000-0000-000000000001',
    title: 'é雪💧',
    quantity: '9007199254740993',
    amount: '1.000',
    occurredAt: '2026-11-07T12:34:56.123456Z',
    body: Buffer.from([0, 255, 128]),
  });
  if (kind === 'early-ack') {
    const get = target.getConnection.bind(target);
    target.getConnection = async () => {
      const c = await get();
      for (const method of ['query', 'execute']) {
        const original = c[method].bind(c);
        c[method] = async (s, ...v) => {
          if (/^INSERT INTO inbox/i.test(String(s.sql ?? s))) {
            await new Promise((r) => setTimeout(r, 100));
            throw new Error('control target rollback');
          }
          return original(s, ...v);
        };
      }
      return c;
    };
    let failed = false;
    try {
      await relay.relayBatch('control');
    } catch {
      failed = true;
    }
    report.operationRejected = failed;
    const position =
      (
        await source.query(
          `SELECT last_position::text AS p FROM "${process.env.PG_SCHEMA}".checkpoints WHERE tenant=$1 AND consumer=$2`,
          ['control', relay.binding],
        )
      ).rows[0]?.p ?? '0';
    report.checkpoint = position;
    assert.equal(position, '0', 'target rollback must not advance source checkpoint');
  } else {
    assert.equal(await relay.relayBatch('control'), 1);
    if (kind === 'dedup') {
      await source.query(
        `UPDATE "${process.env.PG_SCHEMA}".checkpoints SET last_position=0 WHERE tenant=$1 AND consumer=$2`,
        ['control', relay.binding],
      );
      assert.equal(await relay.relayBatch('control'), 1, 'identical target receipt must acknowledge replay');
    }
    const [[row]] = await target.query('SELECT delivered FROM mail_projection WHERE tenant=? AND consumer=?', [
      'control',
      relay.binding,
    ]);
    report.projection = row.delivered;
    assert.equal(row.delivered, 1, 'acknowledged inbox must include its projection effect');
  }
} catch (error) {
  report.detected = true;
  report.error = String(error);
  report.causes = [];
  for (let e = error, n = 0; e && n < 12; e = e.cause, n++) report.causes.push(String(e));
  report.stack = error?.stack;
} finally {
  await relay?.close();
  await source.query('SELECT 1');
  await target.query('SELECT 1');
  await source.end();
  await target.end();
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report));
  assert.equal(report.detected, true, 'omission was not detected');
  process.exitCode = 1;
}
