/** Actual node:sqlite and generated factory in both installed formats. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
const require = createRequire(import.meta.url);
const load = name => process.env.FORMAT === 'cjs' ? require(name) : import(name);
const api = await load('turbine-orm/sqlite');
const { turbine } = await load(`./${process.env.FORMAT}/generated/index.js`);
const { ddl } = await import('./fixture.mjs');
const raw = new DatabaseSync(':memory:');
for (const sql of ddl) raw.exec(sql.replace('active INTEGER', 'active BOOLEAN'));
const db = turbine(raw, { warnOnUnlimited: false });
try {
  const createdAt = new Date('2026-01-02T03:04:05Z');
  let reads = 0;
  const data = { displayName: 'Ada', active: true, profile: { tags: ['x', null] }, createdAt, payload: new Uint8Array([0,128,255]), largeId: '9007199254740992' };
  Object.defineProperty(data, 'displayName', { enumerable: true, get() { reads++; return 'Ada'; } });
  const originalPayload = new Uint8Array(data.payload);
  const row = await db.users.create({ data });
  assert.ok(reads >= 1);
  assert.deepEqual(data.payload, originalPayload);
  const expected = { id: 1, displayName: 'Ada', active: true, profile: { tags: ['x', null] }, createdAt, payload: new Uint8Array([0,128,255]), largeId: '9007199254740992' };
  assert.deepEqual(row, expected);
  assert.deepEqual(Object.keys(row), Object.keys(expected));
  assert.deepEqual(await db.users.create({ data: { displayName: 'Bea', active: false, profile: null, createdAt, payload: null, largeId: 42 } }),
    { id: 2, displayName: 'Bea', active: false, profile: null, createdAt, payload: null, largeId: 42 });
  await db.posts.createMany({ data: [{ userId: 1, title: 'first' }, { userId: 1, title: 'hidden' }] });
  assert.deepEqual(await db.users.findMany({ where: { id: 1 }, select: { displayName: true }, with: { posts: { select: { title: true }, orderBy: { id: 'asc' } } } }), [{ displayName: 'Ada', posts: [{ title: 'first' }, { title: 'hidden' }] }]);
  const scoped = turbine(raw, { globalFilters: { posts: { title: { not: 'hidden' } } }, warnOnUnlimited: false });
  assert.equal(await scoped.posts.count(), 1);
  await scoped.disconnect();
  await assert.rejects(() => db.$transaction(async tx => { await tx.users.update({ where: { id: 1 }, data: { displayName: 'rollback' } }); throw Error('rollback probe'); }), /rollback probe/);
  assert.deepEqual(await db.users.findUnique({ where: { id: 1 } }), expected);
  await db.$transaction(async tx => { await tx.users.update({ where: { id: 1 }, data: { displayName: 'committed' } }); });
  assert.equal((await db.users.findUnique({ where: { id: 1 } })).displayName, 'committed');
  await assert.rejects(() => db.rawUnsafe('SELECT ? AS invalid', 1), /placeholder cannot be bound/);
  const dangerous = await db.rawUnsafe('SELECT $1 AS "__proto__", $2 AS "constructor", $3 AS "toString"', 'own', 'ctor', 'method');
  assert.deepEqual(Object.keys(dangerous[0]), ['__proto__', 'constructor', 'toString']);
  assert.equal(Object.getOwnPropertyDescriptor(dangerous[0], '__proto__').value, 'own');
  assert.equal(Object.getPrototypeOf(dangerous[0]), Object.prototype);
  assert.equal({}.polluted, undefined);
  const own = api.turbineSqlite(':memory:', api.introspectSqliteDatabase(raw));
  await own.disconnect();
  await assert.rejects(() => own.rawUnsafe('SELECT 1'), /disconnect|closed/i);
  const held = db.posts;
  await db.disconnect();
  // The established native caller-handle contract makes disconnect a no-op.
  // Client-owned handles above close; the supplied handle and accessor survive.
  assert.equal(await held.count(), 2);
  assert.equal(raw.prepare('SELECT 1 AS alive').get().alive, 1);
  console.log(JSON.stringify({ ok: true, format: process.env.FORMAT, node: process.version, generated: true, fieldsAndTypes: true, nullAndIntegersAndDate: true, protoOwnKeys: true, rollbackAndCommit: true, callerOwned: true, getterReads: reads }));
} finally { await db.disconnect(); raw.close(); }
