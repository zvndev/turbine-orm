// Copied into an isolated consumer. Every ORM import resolves the installed package.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { readdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import Cursor from 'pg-cursor';
import { Pool as NeonPool, Client as NeonClient, neon, neonConfig } from '@neondatabase/serverless';
import WebSocket from 'ws';
import { TurbineClient } from 'turbine-orm';
import { turbineCore } from 'turbine-orm/core';
import { turbineNeonWs } from 'turbine-orm/neon-ws';
import { turbineNeonHttp } from 'turbine-orm/neon-http';
import { createNotificationHub } from 'turbine-orm/notification-hub';
import { liveQuery } from 'turbine-orm/live-query';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaNeon, PrismaNeonHttp } from '@prisma/adapter-neon';
import { localBridge } from './native-bridge.mjs';
import { expectedRows, hash, spec, summarize, summarizeFanout, unsupported, verifyCallerPool, verifyCommittedRows, verifyRows } from './contract.mjs';
import { typedComposition } from './compiled/typed.mjs';
import { createApplication } from './compiled/application.mjs';

const require = createRequire(import.meta.url);
const { PrismaClient } = require('./generated/prisma');
const [mode, roundsArg, warmupArg, reportPath] = process.argv.slice(2);
const rounds = Number(roundsArg), warmup = Number(warmupArg);
assert.ok(['preflight', 'collect'].includes(mode));
const url = process.env.OPTIONAL_PG_URL;
const proxy = process.env.OPTIONAL_PG_PROXY;
assert.equal(new URL(url).hostname, '127.0.0.1');
const report = { schemaVersion: 1, success: false, mode, acceptedTiming: false, spec, unsupported,
  runtime: { version: process.version, execPath: process.execPath },
  controls: [], coverage: [], groups: [], notifications: [], cleanup: {}, diagnostics: [] };
const stops = [], activePools = new Set();
const bounded = async (operation, label, ms = 8000) => {
  let timer;
  try { return await Promise.race([operation, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} deadline`)), ms); })]); }
  finally { clearTimeout(timer); }
};
const deferred = () => { let resolve; const promise = new Promise((yes) => { resolve = yes; }); return { promise, resolve }; };
async function until(predicate, label) {
  for (let i = 0; i < 500; i++) { if (await predicate()) return; await delay(5); }
  assert.ok(await predicate(), label);
}
function resource() {
  return { monotonicMs: performance.now(), memory: process.memoryUsage(), cpu: process.cpuUsage(),
    usage: process.resourceUsage(), fdCount: readdirSync('/proc/self/fd').length };
}
function poolFor(transport, name, max = spec.poolMax, supplied) {
  // pg-cursor is a Submittable without the callback expected by Neon's
  // query_timeout wrapper. Use the same native statement deadline and parent
  // operation/command deadlines for every arm, rather than mutating the driver.
  const config = { connectionString: url, max, connectionTimeoutMillis: 1500,
    statement_timeout: 3500, application_name: `pg-transport:${name}` };
  const pool = supplied ?? (transport === 'ws' ? new NeonPool(config) : new pg.Pool(config));
  if (transport === 'ws') pool.Client = class extends NeonClient {
    constructor(config) { super(config); Object.assign(this.neonConfig, wsDriver); }
  };
  const facts = { name, transport, max, connects: [], acquires: 0, releases: 0, removes: 0, errors: [] };
  pool.on('connect', (client) => facts.connects.push(client.processID));
  pool.on('acquire', () => facts.acquires++);
  pool.on('release', () => facts.releases++);
  pool.on('remove', () => facts.removes++);
  pool.on('error', (error) => { facts.errors.push(error.message); });
  activePools.add(pool);
  const snapshot = () => ({ ...facts, connects: [...facts.connects], total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount });
  let closing;
  const close = () => closing ??= (async () => {
    if (!pool.ended) await bounded(pool.end(), `${name} pool close`); activePools.delete(pool);
    const final = snapshot();
    assert.equal(final.total, 0); assert.equal(final.waiting, 0);
    report.cleanup.pools ??= []; report.cleanup.pools.push(final);
  })();
  stops.push(close);
  return { pool, close, snapshot };
}
const wsDriver = { webSocketConstructor: WebSocket, wsProxy: proxy, useSecureWebSocket: false, pipelineConnect: false };
const table = spec.table, channel = 'transport_events';
const columns = [['id', 'id', 'int4'], ['tenant_id', 'tenantId', 'int4'], ['title', 'title', 'text'], ['secret', 'secret', 'text']]
  .map(([name, field, pgType]) => ({ name, field, pgType, nullable: false, hasDefault: false, isPrimaryKey: name === 'id', isUnique: name === 'id' }));
const schema = { enums: {}, tables: { [table]: { name: table, columns, relations: {}, indexes: [], primaryKey: ['id'], uniqueColumns: [['id']],
  columnMap: Object.fromEntries(columns.map((c) => [c.field, c.name])), reverseColumnMap: Object.fromEntries(columns.map((c) => [c.name, c.field])),
  allColumns: columns.map((c) => c.name), dateColumns: new Set(), pgTypes: Object.fromEntries(columns.map((c) => [c.name, c.pgType])),
  dialectTypes: Object.fromEntries(columns.map((c) => [c.name, c.pgType])) } } };
const queryArgs = { where: { tenantId: 1 }, select: { id: true, title: true }, orderBy: { id: 'asc' }, limit: spec.resultCount };
const selectSql = `SELECT id,title FROM ${table} WHERE tenant_id=$1 ORDER BY id ASC LIMIT $2`;
const selectValues = [spec.tenant, spec.resultCount];
const failureSql = [
  [`UPDATE ${table} SET title=$1 WHERE id=$2`, ['must rollback', 1]],
  [`INSERT INTO ${table}(id,tenant_id,title,secret) VALUES($1,$2,$3,$4)`, [1, 1, 'duplicate', 'private']],
  [`UPDATE ${table} SET title=$1 WHERE id=$2`, ['must never execute', 3]],
];
let admin, bridge, originalFetch = globalThis.fetch;
async function check(name, fn) {
  try { const result = await bounded(fn(), name); report.controls.push({ name, passed: true, result }); return result; }
  catch (error) { report.controls.push({ name, passed: false, error: error.stack }); throw error; }
}
async function rawBatch(pool) {
  const client = await pool.connect();
  try { await client.query('BEGIN'); for (const [sql, values] of failureSql) await client.query(sql, values); await client.query('COMMIT'); }
  catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
async function turbineBatch(db, http) {
  const at = db.table(table);
  if (http) return db.batch([
    at.buildUpdateMany({ where: { id: 1 }, data: { title: 'must rollback' } }),
    at.buildCreate({ data: { id: 1, tenantId: 1, title: 'duplicate', secret: 'private' } }),
    at.buildUpdateMany({ where: { id: 3 }, data: { title: 'must never execute' } }),
  ]);
  return db.$transaction(async (tx) => {
    for (const [sql, values] of failureSql) await tx.rawQuery(sql, values);
  });
}
async function makeArm(name, transport, kind) {
  let context = transport === 'http' || (kind === 'prisma7' && transport === 'ws') ? null : poolFor(transport, name);
  let pool = context?.pool;
  let read, batch, commit, db, closeDb = async () => {}, stream;
  if (kind === 'raw') {
    read = transport === 'http' ? () => httpSql.query(selectSql, selectValues) : async () => (await pool.query(selectSql, selectValues)).rows;
    batch = transport === 'http' ? () => httpSql.transaction(failureSql.map(([sql, values]) => httpSql.query(sql, values))) : () => rawBatch(pool);
    commit = transport === 'http' ? () => httpSql.transaction([1, 3].map((id) => httpSql.query(`UPDATE ${table} SET title=$1 WHERE id=$2 RETURNING id`, ['committed-control', id]))) : async () => {
      const client = await pool.connect();
      try { await client.query('BEGIN'); for (const id of [1, 3]) await client.query(`UPDATE ${table} SET title=$1 WHERE id=$2`, ['committed-control', id]); await client.query('COMMIT'); }
      catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    };
    if (pool) stream = async function* () {
      const client = await pool.connect();
      const cursor = client.query(new Cursor(selectSql, selectValues));
      try {
        for (;;) {
          const rows = await cursor.read(spec.cursorBatchSize);
          if (!rows.length) break;
          for (const row of rows) yield row;
        }
      } finally { await cursor.close(); client.release(); }
    };
  } else if (kind.startsWith('turbine')) {
    if (kind === 'turbine-core') db = turbineCore(pool, schema, { warnOnUnlimited: false, preparedStatements: false });
    else if (transport === 'ws') db = await turbineNeonWs({ pool }, schema, { sessionMode: 'persistent', lifetime: 'persistent', warnOnUnlimited: false, preparedStatements: false });
    else if (transport === 'http') db = turbineNeonHttp(httpSql, schema);
    else db = new TurbineClient({ pool, warnOnUnlimited: false, preparedStatements: false }, schema);
    read = () => db.table(table).findMany(queryArgs);
    batch = kind === 'turbine-core' ? null : () => turbineBatch(db, transport === 'http');
    if (kind !== 'turbine-core') commit = transport === 'http'
      ? () => db.batch([1, 3].map((id) => db.table(table).buildUpdateMany({ where: { id }, data: { title: 'committed-control' } })))
      : () => db.$transaction(async (tx) => { for (const id of [1, 3]) await tx.table(table).updateMany({ where: { id }, data: { title: 'committed-control' } }); });
    closeDb = () => db.disconnect();
    if (transport !== 'http' && kind !== 'turbine-core') stream = () => db.table(table).findManyStream({ ...queryArgs, batchSize: spec.cursorBatchSize });
  } else if (kind.startsWith('drizzle')) {
    const prefix = kind === 'drizzle-stable' ? 'drizzle-orm' : 'drizzle-rc';
    const adapter = transport === 'http' ? 'neon-http' : transport === 'ws' ? 'neon-serverless' : 'node-postgres';
    const { drizzle } = await import(`${prefix}/${adapter}`);
    const { pgTable, integer, text } = await import(`${prefix}/pg-core`);
    const { eq, asc } = await import(prefix);
    const rows = pgTable(table, { id: integer('id').primaryKey(), tenantId: integer('tenant_id').notNull(), title: text('title').notNull(), secret: text('secret').notNull() });
    const client = transport === 'http' ? httpSql : pool;
    db = kind === 'drizzle-stable' ? drizzle(client) : drizzle({ client });
    read = () => db.select({ id: rows.id, title: rows.title }).from(rows).where(eq(rows.tenantId, 1)).orderBy(asc(rows.id)).limit(spec.resultCount);
    const operations = (tx) => [
      tx.update(rows).set({ title: 'must rollback' }).where(eq(rows.id, 1)),
      tx.insert(rows).values({ id: 1, tenantId: 1, title: 'duplicate', secret: 'private' }),
      tx.update(rows).set({ title: 'must never execute' }).where(eq(rows.id, 3)),
    ];
    batch = transport === 'http' ? () => db.batch(operations(db)) : () => db.transaction(async (tx) => { for (const operation of operations(tx)) await operation; });
    const writes = (tx) => [1, 3].map((id) => tx.update(rows).set({ title: 'committed-control' }).where(eq(rows.id, id)).returning({ id: rows.id }));
    commit = transport === 'http' ? () => db.batch(writes(db)) : () => db.transaction(async (tx) => { for (const write of writes(tx)) await write; });
  } else if (kind === 'prisma7') {
    // Official version-matched adapters; no CLI8/client7 pairing or HTTP facade.
    let adapter;
    if (transport === 'ws') {
      const factory = new PrismaNeon({ connectionString: url, max: spec.poolMax, connectionTimeoutMillis: 1500,
        statement_timeout: 3500, application_name: `pg-transport:${name}` });
      const actual = await factory.connect();
      // Official v7 WS factory owns its pool. Configure its actual underlying
      // driver for the loopback relay before first checkout, then observe it.
      context = poolFor('ws', name, spec.poolMax, actual.underlyingDriver()); pool = context.pool;
      factory.connect = async () => actual;
      adapter = factory;
    } else adapter = transport === 'http' ? new PrismaNeonHttp(url, {}) : new PrismaPg(pool);
    db = new PrismaClient({ adapter });
    read = () => db.transportRow.findMany({ where: { tenantId: 1 }, select: { id: true, title: true }, orderBy: { id: 'asc' }, take: spec.resultCount });
    batch = transport === 'http' ? null : () => db.$transaction([
      db.transportRow.updateMany({ where: { id: 1 }, data: { title: 'must rollback' } }),
      db.transportRow.create({ data: { id: 1, tenantId: 1, title: 'duplicate', secret: 'private' } }),
      db.transportRow.updateMany({ where: { id: 3 }, data: { title: 'must never execute' } }),
    ]);
    commit = transport === 'http' ? null : () => db.$transaction([1, 3].map((id) => db.transportRow.updateMany({ where: { id }, data: { title: 'committed-control' } })));
    closeDb = () => db.$disconnect();
    if (transport === 'http') await check('prisma7-http: official adapter refuses interactive transactions before request', async () => {
      const before = bridge.requests.length;
      await assert.rejects(db.$transaction(async () => { throw new Error('Callback must not execute'); }), /Transactions are not supported in HTTP mode/);
      assert.equal(bridge.requests.length, before);
      return { officialAdapter: 'PrismaNeonHttp@7.10.1', effects: 0 };
    });
  }
  let closed;
  const close = () => closed ??= (async () => {
    try {
      await closeDb();
      if (context && kind.startsWith('turbine')) {
        await bounded(verifyCallerPool(pool, name), `${name} caller pool survival`);
      }
    } finally {
      if (context) await context.close();
    }
  })();
  stops.push(close);
  return { name, transport, kind, pool, db, read, batch, commit, stream, close, resources: context?.snapshot ?? (() => ({ requests: bridge.requests.length, backendPolicy: 'new native PG client per HTTP request in reused local bridge; not hosted pooling' })) };
}
let httpSql;
async function operation(arm, contract, measured, round, phase) {
  const before = resource(), poolBefore = arm.resources();
  const start = performance.now();
  let rows = [], firstResultMs;
  if (contract === 'native-cursor') {
    await bounded((async () => {
      for await (const row of arm.stream()) { if (firstResultMs === undefined) firstResultMs = performance.now() - start; rows.push(row); }
    })(), `${arm.name} cursor drain`);
  } else { rows = await bounded(Promise.resolve(arm.read()), `${arm.name} read`); firstResultMs = performance.now() - start; }
  const fullDrainMs = performance.now() - start, after = resource();
  verifyRows(rows);
  const sample = { arm: arm.name, transport: arm.transport, contract, phase, round,
    firstResultMs, fullDrainMs, rowCount: rows.length, resultSha256: hash(JSON.stringify(rows)),
    before, after, cpuDelta: { user: after.cpu.user - before.cpu.user, system: after.cpu.system - before.cpu.system },
    poolBefore, poolAfter: arm.resources() };
  return measured ? sample : { arm: arm.name, rowCount: rows.length, resultSha256: sample.resultSha256, resources: sample.poolAfter };
}
async function runGroup(transport, kinds, contract = 'buffered') {
  const group = { transport, contract, arms: [], samples: [], stats: [], controlsOnly: mode === 'preflight' };
  report.groups.push(group);
  const arms = [];
  try {
    for (const kind of kinds) {
      const arm = await makeArm(`${kind}-${transport}`, transport, kind);
      arms.push(arm); group.arms.push(arm.name);
      const cold = await operation(arm, contract, mode === 'collect', -1, 'client-cold');
      if (mode === 'collect') group.samples.push(cold);
      report.coverage.push({ arm: arm.name, contract, status: 'executed', verifiedResult: cold.resultSha256 });
      if (contract === 'buffered' && arm.commit) await check(`${arm.name}: committed two-write effects`, async () => {
        await arm.commit(); await bridge.drain();
        const all = (await admin.query(`SELECT id,tenant_id,title,secret FROM ${table} ORDER BY id`)).rows;
        verifyCommittedRows(all);
        await admin.query(`UPDATE ${table} SET title=$1`, ['x'.repeat(spec.payloadBytes)]);
        return { effects: 2, affectedIds: [1, 3], rows: all.length };
      });
      if (contract === 'buffered' && arm.batch) await check(`${arm.name}: middle batch failure atomic rollback`, async () => {
        const before = (await admin.query(`SELECT * FROM ${table} ORDER BY id`)).rows;
        let rejected;
        try { await arm.batch(); } catch (error) { rejected = error; }
        assert.ok(rejected, 'The duplicate statement must reject');
        assert.ok(/23505|P2002|unique|duplicate/i.test(`${rejected.code} ${rejected.message} ${rejected.cause?.code} ${rejected.cause?.message}`), 'Native unique failure retained');
        await bridge.drain();
        assert.deepEqual((await admin.query(`SELECT * FROM ${table} ORDER BY id`)).rows, before);
        return { rejectedCode: rejected.code ?? null, message: rejected.message, effects: 0 };
      });
      if (arm.pool) await check(`${arm.name}: connection reuse`, async () => {
        const before = arm.resources().connects.length;
        verifyRows(await arm.read()); verifyRows(await arm.read());
        assert.equal(arm.resources().connects.length, before, 'Repeated reads must reuse a checked-in connection');
        return arm.resources();
      });
      if (contract === 'native-cursor') await check(`${arm.name}: early cursor close returns lease`, async () => {
        let count = 0;
        for await (const row of arm.stream()) { assert.deepEqual(row, expectedRows()[count]); if (++count === 2) break; }
        assert.equal(count, 2); verifyRows(await arm.read());
        assert.equal(arm.resources().waiting, 0); assert.equal(arm.resources().idle, arm.resources().total);
        return { yielded: count, checkedOut: 0 };
      });
    }
    if (mode === 'collect') {
      for (const arm of arms) for (let i = 0; i < warmup; i++) await operation(arm, contract, false, i, 'warmup');
      for (let round = 0; round < rounds; round++) for (let i = 0; i < arms.length; i++) {
        const arm = arms[(i + round) % arms.length];
        group.samples.push(await operation(arm, contract, true, round, 'warm'));
      }
      group.stats = arms.map((arm) => ({ name: arm.name, ...summarize(group.samples.filter((sample) => sample.arm === arm.name && sample.phase === 'warm')) }));
    }
  } finally { for (const arm of arms.reverse()) await arm.close(); }
}

async function notificationGroup() {
  const group = { transport: 'pg', contract: 'application-hub-typed-refetch', arms: [], samples: [],
    note: 'same existing application/hub, eight consumers, one listener and one query pool per arm; application composition for every ORM; fanout samples are correlated' };
  report.groups.push(group);
  // Each arm owns and closes its complete client resources before the next arm.
  // Notification rounds are serial within that arm, rather than interleaved
  // across armed listeners which would receive another arm\'s notifications.
  for (const kind of ['raw', 'turbine', 'turbine-core', 'drizzle-stable', 'drizzle-rc', 'prisma7']) {
    const arm = await makeArm(`${kind}-pg-refetch`, 'pg', kind);
    const listener = poolFor('pg', `${kind}-listener`);
    const app = createApplication({ pool: listener.pool, endpoint: 'direct', channel, onDiagnostic: (error) => report.diagnostics.push(error.message) });
    let lives = [];
    stops.push(() => app.close());
    try {
      group.arms.push(arm.name);
      lives = Array.from({ length: spec.liveConsumers }, () => app.watch(() => arm.read()));
      for (const live of lives) verifyRows((await bounded(live.next(), 'refetch initial')).value);
      assert.equal(listener.snapshot().connects.length, 1);
      assert.equal(app.hub.stats.subscriptions, spec.liveConsumers);
      const count = mode === 'collect' ? rounds + warmup : 1;
      for (let round = 0; round < count; round++) {
        await admin.query('BEGIN');
        const title = `refetch-${round}`;
        await admin.query(`UPDATE ${table} SET title=$1 WHERE id=1`, [title]);
        await admin.query('SELECT pg_notify($1,$2)', [channel, title]);
        const before = resource();
        const pulls = lives.map((live, consumer) => live.next().then((result) => ({ result, consumer, deliveredAtMs: performance.now() })));
        const start = performance.now();
        await admin.query('COMMIT');
        const results = await bounded(Promise.all(pulls), 'application fanout snapshot');
        const after = resource();
        const expected = expectedRows(); expected[0].title = title;
        for (const value of results) {
          assert.deepEqual(value.result.value, expected);
          if (mode === 'collect' && round >= warmup) group.samples.push({ arm: arm.name, consumer: value.consumer,
            round: round - warmup, phase: 'warm', firstResultMs: value.deliveredAtMs - start,
            fullDrainMs: value.deliveredAtMs - start, commitCallToSnapshotMs: value.deliveredAtMs - start,
            rowCount: spec.resultCount, resultSha256: hash(JSON.stringify(value.result.value)),
            timestampBoundary: spec.notification, before, after, queryPool: arm.resources(), listenerPool: listener.snapshot(), hub: app.hub.stats });
        }
      }
      if (mode === 'collect') {
        const samples = group.samples.filter((sample) => sample.arm === arm.name);
        (group.stats ??= []).push({ name: arm.name, ...summarizeFanout(samples, rounds) });
      }
      report.coverage.push({ arm: arm.name, contract: group.contract, status: 'executed', consumers: lives.length,
        listenerConnections: listener.snapshot().connects.length, distinctFromBuiltInSubscription: true });
    } finally {
      await app.close(); await arm.close(); await listener.close();
      await admin.query(`UPDATE ${table} SET title=$1`, ['x'.repeat(spec.payloadBytes)]);
    }
  }
}

async function coreRefusals() {
  const resource = poolFor('pg', 'core-refusals');
  const core = turbineCore(resource.pool, schema, { warnOnUnlimited: false });
  stops.push(() => core.disconnect());
  await check('core: session/cursor refusal and caller ownership', async () => {
    const before = (await admin.query(`SELECT * FROM ${table} ORDER BY id`)).rows;
    for (const fn of [() => core.$transaction(() => {}), () => core.connect(), () => core.$listen(channel, () => {}), () => core.rawQuery('BEGIN')]) {
      await assert.rejects(async () => fn());
    }
    await assert.rejects(async () => { for await (const row of core.table(table).findManyStream()) void row; });
    assert.deepEqual((await admin.query(`SELECT * FROM ${table} ORDER BY id`)).rows, before);
    await core.disconnect(); verifyRows((await resource.pool.query(selectSql, selectValues)).rows);
    await assert.rejects(async () => core.table(table).findMany(queryArgs));
    return { effects: 0, callerPoolSurvived: true, closedHandlesRefused: true };
  });
  await resource.close();
}

async function pendingHandshake() {
  await check('WS: disconnect while actual HTTP upgrade handshake pending', async () => {
    const sockets = new Set(), seen = deferred();
    const server = createServer();
    server.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
    server.on('upgrade', () => seen.resolve());
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    let db;
    try {
      db = await turbineNeonWs({ connection: { connectionString: url, connectionTimeoutMillis: 250 },
        driver: { ...wsDriver, wsProxy: `127.0.0.1:${port}/pending` } }, schema,
      { sessionMode: 'persistent', lifetime: 'persistent', warnOnUnlimited: false });
      const pending = db.rawQuery('SELECT 1');
      const rejected = assert.rejects(pending); void rejected.catch(() => {});
      await bounded(seen.promise, 'pending handshake observed');
      await bounded(db.disconnect(), 'pending handshake disconnect'); await rejected;
    } finally {
      await db?.disconnect();
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    }
    await until(() => sockets.size === 0, 'pending handshake sockets closed');
    return { port, stopped: true, connectionsClosed: true, observedPendingUpgrade: true };
  });
}

async function httpRefusals() {
  const db = turbineNeonHttp(httpSql, schema);
  stops.push(() => db.disconnect());
  await check('HTTP: refusal before request and effect', async () => {
    const before = bridge.requests.length;
    for (const fn of [() => db.transaction(() => {}), () => db.connect(), () => db.$listen(channel, () => {}),
      () => db.rawUnsafe('BEGIN'), () => db.rawUnsafe('LISTEN transport_events'), () => db.table(table).findManyStream()]) await assert.rejects(async () => fn());
    assert.equal(bridge.requests.length, before);
    await db.disconnect();
    await assert.rejects(async () => db.table(table).findMany(queryArgs));
    verifyRows(await httpSql.query(selectSql, selectValues));
    return { effects: 0, refusedWithoutRequest: true, suppliedFunctionSurvived: true };
  });
}

async function liveControls() {
  const context = poolFor('pg', 'live', 3);
  const { pool } = context;
  await check('typed composition: initial and committed notification snapshot', async () => {
    const typed = await typedComposition(pool, schema);
    stops.push(() => typed.app.close()); stops.push(() => typed.db.disconnect());
    verifyRows((await bounded(typed.live.next(), 'typed initial')).value);
    await typed.app.close(); await typed.db.disconnect();
    assert.equal(typed.app.hub.stats.closed, true);
    return { typedProjection: true, initialRows: spec.resultCount };
  });
  await check('live query hub: shared listener, rollback silence, reconnect resync and bounded snapshots', async () => {
    const listeners = [], diagnostics = [];
    let gate;
    const transport = {
      async connect() {
        if (gate) { gate.requested.resolve(); await gate.allowed.promise; }
        const client = await pool.connect(); listeners.push(client); return client;
      },
      end: () => { throw new Error('External pool must not be ended by hub'); },
    };
    const db = turbineCore(pool, schema, { warnOnUnlimited: false });
    const app = createApplication({ pool: transport, endpoint: 'direct', channel, onDiagnostic: (error) => diagnostics.push(error.message) });
    stops.push(() => app.close()); stops.push(() => db.disconnect());
    const live = Array.from({ length: spec.liveConsumers }, () => app.watch(() => db.table(table).findMany(queryArgs)));
    const initial = await Promise.all(live.map((stream) => bounded(stream.next(), 'shared initial')));
    for (const value of initial) verifyRows(value.value);
    assert.equal(listeners.length, 1); assert.equal(app.hub.stats.subscriptions, spec.liveConsumers);
    // A driver-delivery barrier proves no uncommitted snapshot escaped.
    let delivered = 0;
    const observer = await app.hub.subscribe(channel, () => { delivered++; });
    await admin.query('BEGIN'); await admin.query(`UPDATE ${table} SET title='uncommitted' WHERE id=1`);
    await admin.query('SELECT pg_notify($1,$2)', [channel, 'rolled-back']); await admin.query('ROLLBACK');
    await admin.query('SELECT pg_notify($1,$2)', [channel, 'barrier']);
    await until(() => delivered === 1, 'one committed barrier delivery');
    assert.equal(delivered, 1);
    const pending = live.map((stream) => stream.next());
    const sampleCount = 1;
    for (let i = 0; i < sampleCount; i++) {
      await admin.query('BEGIN'); await admin.query(`UPDATE ${table} SET title=$1 WHERE id=1`, [`committed-${i}`]);
      await admin.query('SELECT pg_notify($1,$2)', [channel, `commit-${i}`]);
      const start = performance.now();
      const reads = i === 0 ? pending : live.map((stream) => stream.next());
      await admin.query('COMMIT');
      for (const read of reads) {
        let result = await bounded(read, 'committed snapshot');
        // A prior barrier can already have scheduled a valid unchanged snapshot.
        // Drain to the expected commit below using the corresponding stream.
        const index = reads.indexOf(read);
        while (result.value[0].title !== `committed-${i}`) result = await bounded(live[index].next(), 'latest committed snapshot');
        assert.equal(result.value.length, spec.resultCount);
      }
    }
    // Force an actual owned backend down; a gated replacement misses a commit.
    gate = { requested: deferred(), allowed: deferred() };
    await admin.query('SELECT pg_terminate_backend($1)', [listeners[0].processID]);
    await bounded(gate.requested.promise, 'reconnect requested');
    await admin.query(`UPDATE ${table} SET title='missed-during-gap' WHERE id=1`);
    await admin.query('SELECT pg_notify($1,$2)', [channel, 'lost-gap-notification']);
    const resumed = live.map((stream) => stream.next());
    gate.allowed.resolve(); gate = null;
    const resynced = await Promise.all(resumed.map((read) => bounded(read, 'reconnect current-state snapshot')));
    for (const value of resynced) assert.equal(value.value[0].title, 'missed-during-gap');
    assert.equal(listeners.length, 2);
    // Hold snapshot consumption while committing a bounded burst. Only current
    // state is required, never one snapshot or one event per update.
    for (let i = 0; i < 12; i++) {
      await admin.query('BEGIN'); await admin.query(`UPDATE ${table} SET title=$1 WHERE id=1`, [`burst-${i}`]);
      await admin.query('SELECT pg_notify($1,$2)', [channel, `burst-${i}`]); await admin.query('COMMIT');
    }
    await until(() => delivered >= 14, 'burst delivered');
    const latest = await Promise.all(live.map((stream) => bounded(stream.next(), 'coalesced snapshot')));
    for (let index = 0; index < latest.length; index++) {
      let value = latest[index];
      if (value.value[0].title !== 'burst-11') value = await bounded(live[index].next(), 'final coalesced snapshot');
      const expected = expectedRows(); expected[0].title = 'burst-11';
      assert.deepEqual(value.value, expected);
    }
    for (const stream of live) await stream.dispose();
    await observer.unsubscribe(); await app.close(); await db.disconnect();
    assert.equal(app.hub.stats.closed, true); assert.equal(app.hub.stats.subscriptions, 0);
    assert.equal((await pool.query('SELECT 1 AS n')).rows[0].n, 1);
    await admin.query(`UPDATE ${table} SET title=$1`, ['x'.repeat(spec.payloadBytes)]);
    return { consumers: spec.liveConsumers, listenerCheckouts: listeners.length, rollbackNotifications: 0,
      reconnectReread: 'missed-during-gap', noReplayClaim: true, burstCommits: 12, externalPoolSurvived: true, diagnostics };
  });
  await check('live query: one in-flight read and one dirty refetch', async () => {
    const started = deferred(), allow = deferred(); let invalidate, reads = 0, active = 0, peak = 0;
    const live = liveQuery({ query: async () => { reads++; peak = Math.max(peak, ++active); if (reads === 1) { started.resolve(); await allow.promise; } active--; return reads; },
      subscribe(handler) { invalidate = handler; return { unsubscribe() {} }; } });
    stops.push(() => live.dispose());
    await started.promise;
    for (let i = 0; i < 1000; i++) invalidate();
    allow.resolve();
    await until(() => reads === 2, 'single coalesced rerun');
    assert.equal(peak, 1); assert.equal(reads, 2); await live.dispose();
    return { invalidations: 1000, reads, peakConcurrentReads: peak };
  });
  await check('hub: pending checkout close drains late owned lease', async () => {
    const requested = deferred(), allow = deferred(); let releases = 0;
    const hub = createNotificationHub({
      async connect() { requested.resolve(); await allow.promise; const client = await pool.connect();
        return { query: client.query.bind(client), on: client.on.bind(client), removeListener: client.removeListener.bind(client),
          release(error) { releases++; client.release(error); } }; },
      end: async () => { throw new Error('caller ownership'); },
    }, { endpoint: 'direct', ownership: 'external' });
    const pending = hub.subscribe(channel, () => {});
    const rejected = assert.rejects(pending); void rejected.catch(() => {});
    await requested.promise; const closing = hub.close(); allow.resolve(); await closing; await rejected;
    assert.equal(releases, 1); assert.equal(hub.stats.closed, true);
    return { releases, lateCheckoutDrained: true };
  });
  await context.close();
}

try {
  admin = new pg.Client({ connectionString: url, connectionTimeoutMillis: 1500, query_timeout: 4000, application_name: 'pg-transport:admin' });
  stops.push(async () => {
    try {
      report.cleanup.remainingNamedNativeBackends = (await admin.query("SELECT pid,application_name,state FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND application_name<>''")).rows;
      assert.deepEqual(report.cleanup.remainingNamedNativeBackends, [], 'All named arm/bridge clients must disappear before cluster shutdown');
    } finally { await admin.end(); }
  }); await admin.connect();
  report.server = (await admin.query("SELECT version(),current_setting('server_version') AS server_version,current_setting('TimeZone') AS timezone")).rows[0];
  assert.equal(report.server.server_version, '18.6');
  await admin.query(`CREATE TABLE ${table}(id integer PRIMARY KEY,tenant_id integer NOT NULL,title text NOT NULL,secret text NOT NULL)`);
  await admin.query(`INSERT INTO ${table} SELECT i, i%2, $1, 'private' FROM generate_series(1,$2) AS i`, ['x'.repeat(spec.payloadBytes), spec.rows]);
  report.seed = { rows: spec.rows, canonicalResultSha256: hash(JSON.stringify(expectedRows())) };
  bridge = await localBridge(pg, url); stops.push(() => bridge.close());
  globalThis.fetch = (endpoint, init) => originalFetch(bridge.endpoint, init);
  httpSql = neon(url);
  await runGroup('pg', ['raw', 'turbine', 'turbine-core', 'drizzle-stable', 'drizzle-rc', 'prisma7']);
  await runGroup('ws', ['raw', 'turbine', 'drizzle-stable', 'drizzle-rc', 'prisma7']);
  await runGroup('http', ['raw', 'turbine', 'drizzle-stable', 'drizzle-rc', 'prisma7']);
  // Separate native cursor contract, no buffered or page-emulated equivalent.
  await runGroup('pg', ['raw', 'turbine'], 'native-cursor');
  await runGroup('ws', ['raw', 'turbine'], 'native-cursor');
  await notificationGroup();
  await coreRefusals(); await httpRefusals(); await pendingHandshake(); await liveControls();
  await admin.query(`DROP TABLE ${table}`);
  report.success = true;
} catch (error) { report.failure = error.stack; report.failureCauses = []; for (let cause = error.cause; cause; cause = cause.cause) report.failureCauses.push(cause.stack ?? String(cause)); process.exitCode = 1; }
finally {
  globalThis.fetch = originalFetch;
  const errors = [];
  for (const stop of stops.reverse()) try { await bounded(Promise.resolve().then(stop), 'consumer cleanup'); } catch (error) { errors.push(error.stack); }
  // Cleanup failures remain failures. Parent supervisor independently kills and
  // audits the isolated command group on every outcome, including signals.
  report.cleanup.fetchRestored = globalThis.fetch === originalFetch;
  report.cleanup.activePools = activePools.size;
  report.cleanup.bridge = bridge && { closed: bridge.closed, portClosed: bridge.portClosed, port: bridge.port, requests: bridge.requests };
  report.cleanup.errors = errors;
  report.cleanup.complete = errors.length === 0 && activePools.size === 0 && (!bridge || bridge.closed);
  if (!report.cleanup.complete) { report.success = false; process.exitCode = 1; }
  writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
}
console.log(JSON.stringify({ success: report.success, controls: report.controls.length, groups: report.groups.length, failure: report.failure }));
