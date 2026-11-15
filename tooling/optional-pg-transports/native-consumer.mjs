// Actual installed Neon driver + ws + native PG. No hosted Neon claim.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const format = process.argv[2];
assert.ok(['esm', 'cjs'].includes(format));
const load = async (name) => format === 'esm' ? import(name) : Promise.resolve(require(name));
const { TurbineClient } = await load('turbine-orm');
const { turbineNeonWs, withNeonWs } = await load('turbine-orm/neon-ws');
const { Pool, Client } = await load('@neondatabase/serverless');
const ws = await load('ws');
const WebSocket = ws.default ?? ws.WebSocket;
const connection = { connectionString: process.env.OPTIONAL_PG_URL, connectionTimeoutMillis: 3000, max: 2 };
assert.ok(connection.connectionString && process.env.OPTIONAL_PG_PROXY, 'Explicit native endpoint required');
const driver = { webSocketConstructor: WebSocket, wsProxy: process.env.OPTIONAL_PG_PROXY, useSecureWebSocket: false, pipelineConnect: false };
const schema = { tables: {}, enums: {} };
const options = { sessionMode: 'persistent', lifetime: 'persistent', warnOnUnlimited: false };
const defaultPg = new TurbineClient({ connectionString: connection.connectionString, warnOnUnlimited: false }, schema);
try { assert.deepEqual(await defaultPg.raw`SELECT 28 AS n`, [{ n: 28 }]); }
finally { await defaultPg.disconnect(); }
const rejectedConnection = await turbineNeonWs({ connection, driver: { ...driver, wsProxy: process.env.OPTIONAL_PG_PROXY.replace('/v1', '/refused') } }, schema, options);
try { await assert.rejects(rejectedConnection.rawQuery('SELECT 1'), (error) => /400|403/.test(error.message ?? error.error?.message ?? '')); }
finally { await rejectedConnection.disconnect(); }
const db = await turbineNeonWs({ connection, driver }, schema, options);
try {
  assert.deepEqual(await db.raw`SELECT 21 AS n`, [{ n: 21 }]);
  await db.$transaction(async (tx) => { assert.deepEqual(await tx.raw`SELECT 22 AS n`, [{ n: 22 }]); });
} finally { await db.disconnect(); }
await assert.rejects(db.rawQuery('SELECT 1'), /disconnected/);
const pool = new Pool(connection);
pool.Client = class extends Client { constructor(config) { super(config); Object.assign(this.neonConfig, driver); } };
try {
  const supplied = await turbineNeonWs({ pool }, schema, options);
  try { assert.deepEqual(await supplied.raw`SELECT 23 AS n`, [{ n: 23 }]); }
  finally { await supplied.disconnect(); }
  const lease = await pool.connect();
  try { assert.deepEqual((await lease.query('SELECT 24 AS n')).rows, [{ n: 24 }]); }
  finally { lease.release(); }
} finally { await pool.end(); }
const client = new Client(connection);
Object.assign(client.neonConfig, driver);
await client.connect();
try {
  const supplied = await turbineNeonWs({ client }, schema, options);
  try { assert.deepEqual(await supplied.raw`SELECT 25 AS n`, [{ n: 25 }]); }
  finally { await supplied.disconnect(); }
  assert.deepEqual((await client.query('SELECT 26 AS n')).rows, [{ n: 26 }]);
} finally { await client.end(); }
for (const failure of [false, true]) {
  let escaped;
  const invocation = withNeonWs({ connection, driver }, schema, { sessionMode: 'persistent', warnOnUnlimited: false }, async (bound) => {
    escaped = bound;
    assert.deepEqual(await bound.raw`SELECT 27 AS n`, [{ n: 27 }]);
    await assert.rejects(bound.$listen('optional_gate', () => {}), /persistent backend session|persistent lifetime/);
    if (failure) throw new Error('owned callback marker');
    return 27;
  });
  if (failure) await assert.rejects(invocation, /owned callback marker/);
  else assert.equal(await invocation, 27);
  await assert.rejects(escaped.rawQuery('SELECT 1'), /disconnected/);
}
console.log(JSON.stringify({ query: 21, transaction: 22, defaultPg: true, connectFailureCleaned: true, invocationRefused: true, disconnected: true, externalPoolSurvived: true, externalClientSurvived: true, failureCleaned: true }));
