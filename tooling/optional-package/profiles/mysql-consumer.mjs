/** Native installed generated clients. No producer module resolution. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
const require = createRequire(import.meta.url), format = process.env.FORMAT;
const load = name => format === 'cjs' ? require(name) : import(name);
const local = createRequire(require.resolve('turbine-orm'));
const driverPath = local.resolve('mysql2/promise'), mysql = local('mysql2/promise');
assert.equal(JSON.parse(readFileSync(join(dirname(driverPath), 'package.json'))).version, '3.24.6');
const appPath = require.resolve('mysql2/promise'), appVersion = JSON.parse(readFileSync(join(dirname(appPath), 'package.json'))).version;
if (process.env.LEGACY_APP === '1') { assert.equal(appVersion, '3.0.0'); assert.notEqual(driverPath, appPath); }
const traces = [], pools = [], originalCreatePool = mysql.createPool;
mysql.createPool = function(config) {
  const pool = originalCreatePool.call(this, config); pools.push(pool);
  for (const method of ['query','execute']) {
    const original = pool[method];
    pool[method] = function(sql, values) { traces.push({ method, sql, values }); return original.apply(this, arguments); };
  }
  return pool;
};
const { turbine } = await load(`./${format}/generated/index.js`), api = await load('turbine-orm/mysql');
const { SCHEMA } = await load(`./${format}/generated/metadata.js`);
const { ddl } = await import('./mysql-fixture.mjs');
const endpoint = new URL(process.env.MYSQL_PROFILE_URL);
const config = { host: endpoint.hostname, port: Number(endpoint.port), user: 'root', database: endpoint.pathname.slice(1), namedPlaceholders: true, timezone: 'Z', supportBigNumbers: true, bigNumberStrings: false };
const admin = originalCreatePool(config), db = await turbine(process.env.MYSQL_PROFILE_URL, { warnOnUnlimited: false, logger: {}, connectionLimit: 2 });
const checks = [];
try {
  assert.equal(pools.length, 1, 'Actual factory must call this profile-owned driver');
  await admin.query('DROP TABLE IF EXISTS posts'); await admin.query('DROP TABLE IF EXISTS users');
  for (const sql of ddl) await admin.query(sql);
  const date = new Date('2026-01-02T03:04:05.123Z'), payload = Buffer.from([0,128,255]);
  const profile = JSON.parse('{"tags":["x",null],"__proto__":{"own":true},"constructor":"json"}');
  const first = { displayName: "Ada'\\%_", active: true, profile, createdAt: date, payload, largeId: '9007199254740992', score: 1.25, amount: '12345678901234567890.1250' };
  let getterReads = 0;
  Object.defineProperty(first, 'displayName', { enumerable: true, get() { getterReads++; return "Ada'\\%_"; } });
  const row = await db.users.create({ data: first });
  const expected = { id: 1, displayName: "Ada'\\%_", active: true, profile, createdAt: date, payload, largeId: '9007199254740992', score: 1.25, amount: '12345678901234567890.1250' };
  assert.deepEqual(row, expected); assert.deepEqual(Object.keys(row), Object.keys(expected)); assert.equal(Object.getPrototypeOf(row), Object.prototype);
  assert.ok(getterReads > 0); assert.deepEqual(payload, Buffer.from([0,128,255]));
  assert.equal(Object.hasOwn(row.profile, '__proto__'), true); assert.equal({}.own, undefined);
  const second = await db.users.create({ data: { displayName: 'Bea', active: false, profile: null, createdAt: date, payload: null, largeId: 42, score: -2.5, amount: '2.0000' } });
  assert.deepEqual(second, { id: 2, displayName: 'Bea', active: false, profile: null, createdAt: date, payload: null, largeId: 42, score: -2.5, amount: '2.0000' });
  checks.push('complete-values-order-prototypes-getters-int-date-null-bytes-json');
  await db.posts.createMany({ data: [{ userId: 1, title: 'first' }, { userId: 1, title: 'hidden' }, { userId: 2, title: 'other' }] });
  assert.deepEqual(await db.users.findMany({ where: { id: { in: [1,2] } }, select: { displayName: true }, orderBy: { id: 'asc' }, with: { posts: { select: { title: true }, orderBy: { id: 'asc' } }, _count: { posts: true } } }), [
    { displayName: "Ada'\\%_", posts: [{ title: 'first' }, { title: 'hidden' }], _count: { posts: 2 } },
    { displayName: 'Bea', posts: [{ title: 'other' }], _count: { posts: 1 } },
  ]);
  const scoped = await turbine(admin, { globalFilters: { posts: { title: { not: 'hidden' } } }, warnOnUnlimited: false, logger: {} });
  assert.equal(await scoped.posts.count(), 2); await scoped.disconnect();
  assert.deepEqual(await db.rawUnsafe('SELECT $3 AS third, $1 AS first, $3 AS again', 'a', 'unused', 'c'), [{ third: 'c', first: 'a', again: 'c' }]);
  const ordinaryNames = await db.rawUnsafe('SELECT $1 AS constructor, $2 AS `toString`', 'ctor', 'method');
  assert.deepEqual(ordinaryNames, [{ constructor:'ctor', toString:'method' }]);
  assert.deepEqual(Object.keys(ordinaryNames[0]), ['constructor','toString']);
  assert.equal(Object.getPrototypeOf(ordinaryNames[0]),Object.prototype);
  assert.deepEqual(await db.users.findMany({ where: { displayName: { contains: "'\\%_" } }, select: { id: true } }), [{ id: 1 }]);
  assert.ok(traces.some(row => row.method === 'execute' && /:p\d/.test(row.sql) && row.values && !Array.isArray(row.values)), 'Named binds reach prepared execute');
  const [stats] = await pools[0].query("SHOW SESSION STATUS LIKE 'Com_stmt_execute'"); assert.ok(Number(stats[0].Value) > 0);
  checks.push('relations-count-filters-list-sparse-named-prepared-protocol');
  await assert.rejects(() => admin.execute('SELECT ? AS `__proto__`', ['own']), /private property/);
  await assert.rejects(() => db.rawUnsafe('SELECT $1 AS `__proto__`', 'own'), /private property/);
  checks.push('raw-proto-native-driver-refusal-expected-negative');
  const sentinel = new Error('exact rollback identity');
  await assert.rejects(() => db.$transaction(async tx => { await tx.users.update({ where: { id: 1 }, data: { displayName: 'rollback' } }); assert.equal((await tx.users.findUnique({ where: { id: 1 } })).displayName, 'rollback'); throw sentinel; }), error => error === sentinel);
  assert.deepEqual(await db.users.findUnique({ where: { id: 1 } }), expected);
  await db.$transaction(async tx => { await tx.users.update({ where: { id: 1 }, data: { displayName: 'committed' } }); await tx.posts.create({ data: { userId: 1, title: 'committed post' } }); });
  const [[effect]] = await admin.execute('SELECT display_name AS label FROM users WHERE id=?', [1]); assert.equal(effect.label, 'committed');
  checks.push('serial-transactions-commit-external-effects-rollback-reason');
  const streamed = [];
  for await (const item of db.users.findManyStream({ orderBy: { id: 'asc' }, batchSize: 1, signal: new AbortController().signal })) streamed.push(item);
  assert.deepEqual(streamed, [{ ...expected, displayName: 'committed' }, second]);
  const early = db.users.findManyStream({ orderBy: { id: 'asc' }, batchSize: 1, signal: new AbortController().signal });
  assert.deepEqual((await early.next()).value, { ...expected, displayName: 'committed' }); await early.return();
  assert.equal(await db.users.count(), 2);
  checks.push('incremental-stream-complete-values-early-return-release');
  const supplied = await turbine(admin, { logger: {}, warnOnUnlimited: false }); await supplied.disconnect();
  assert.equal((await admin.query('SELECT 1 AS alive'))[0][0].alive, 1);
  if (appVersion === '3.0.0') {
    const legacy = require('mysql2/promise').createPool(config);
    try {
      const legacyDb = await api.turbineMysql(legacy, SCHEMA, { logger: {}, warnOnUnlimited: false });
      const [raw] = await legacy.execute('SELECT ? AS payload', [payload]);
      assert.equal(typeof raw[0].payload, 'string', 'Retain real legacy Buffer-text negative');
      assert.deepEqual(await legacyDb.rawUnsafe('SELECT $1 AS payload', payload), [{ payload: raw[0].payload }]);
      await legacyDb.disconnect(); assert.equal((await legacy.query('SELECT 1 AS alive'))[0][0].alive, 1);
      checks.push('legacy-supplied-pool-buffer-text-expected-negative');
    } finally { await legacy.end(); }
  }
  await db.disconnect(); await assert.rejects(() => pools[0].query('SELECT 1'), /closed/i);
  checks.push('factory-owned-close-caller-pool-survival');
  console.log(JSON.stringify({ success: true, node: process.version, format, mode: process.env.MYSQL_PROFILE_MODE, driverPath, appPath, appVersion, actualFactoryDriver: '3.24.6', factoryCalls: pools.length, checks, preparedExecuteCalls: traces.filter(row => row.method === 'execute').length, getterReads }));
} finally { await db.disconnect(); await admin.end(); mysql.createPool = originalCreatePool; }
