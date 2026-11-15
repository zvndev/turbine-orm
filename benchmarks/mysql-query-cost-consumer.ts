/** Exploratory installed-package diagnostics using the existing MySQL fixture and oracle. */
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { assertMysqlExact, authors, dashboardExpected, readMysqlFixture } from './mysql-equivalence.js';
import { FIXTURE_TIME, makePool, MYSQL_SESSION_IDENTITY_SQL } from './mysql-comparison-config.js';

// biome-ignore lint/suspicious/noExplicitAny: drives both installed module formats through the same oracle.
type Native = any;
const [format, output] = process.argv.slice(2);
assert.ok(format === 'esm' || format === 'cjs');
assert.ok(output);
const require = createRequire(import.meta.url);
const api: Native = format === 'esm' ? await import('turbine-orm') : require('turbine-orm');
const engine: Native = format === 'esm' ? await import('turbine-orm/mysql') : require('turbine-orm/mysql');
const raw = makePool();
const checks: string[] = [];
const traces: { method: string; sql: string; ms: number }[] = [];
const profiles: { name: string; samplesMs: number[]; statements: number; driverMs: number }[] = [];
let recording = false;
const instrumented = new WeakSet();
const instrument = (runner: Native) => {
  if (instrumented.has(runner)) return;
  instrumented.add(runner);
  for (const method of ['query', 'execute'] as const) {
    const original = runner[method].bind(runner);
    runner[method] = async (...args: Native[]) => {
      const start = performance.now();
      try { return await original(...args); }
      finally { if (recording) traces.push({ method, sql: args[0], ms: performance.now() - start }); }
    };
  }
};
instrument(raw);
const checkout = raw.getConnection.bind(raw);
(raw as Native).getConnection = async () => {
  const connection = await checkout();
  if (process.env.MYSQL_QUERY_COST_PROFILE_OMIT_CONNECTION !== '1') instrument(connection);
  return connection;
};
let db: Native;
const check = async (name: string, run: () => Promise<void>) => { await run(); checks.push(name); };
try {
  const [settings] = await raw.query(`${MYSQL_SESSION_IDENTITY_SQL.replace('SELECT ', 'SELECT @@GLOBAL.innodb_flush_log_at_trx_commit AS flushAtCommit, @@GLOBAL.sync_binlog AS syncBinlog, ')}`);
  assert.equal((settings as Native)[0].flushAtCommit, 1);
  await raw.query('DELETE FROM bench_writes');
  const fixture = await readMysqlFixture(raw);
  const [[database]] = await raw.query('SELECT DATABASE() AS name');
  const shim = new engine.MysqlPool(raw);
  const schema = await engine.introspectMysqlWith(async (sql: string, values: unknown[]) =>
    (await shim.query(sql, values)).rows, (database as Native).name, { logger: {} });
  db = await engine.turbineMysql(raw, schema, { logger: {}, warnOnUnlimited: false });
  const posts = db.table('posts'), users = db.table('users'), comments = db.table('comments');
  const findAuthors = () => posts.findMany({ orderBy: { id: 'asc' }, limit: 500, with: { user: true } });
  const wide = () => db.table('bench_wide').findMany({ orderBy: { id: 'asc' }, limit: 1000 });
  const count = () => users.findMany({ orderBy: { id: 'asc' }, limit: 100, with: { _count: { posts: true } } });
  const dashboard = () => db.$transaction(async (tx: Native) => [
    await tx.table('users').findUnique({ where: { id: 1 } }),
    await tx.table('posts').count({ where: { userId: 1 } }),
    await tx.table('comments').count({ where: { userId: 1 } }),
    await tx.table('posts').findMany({ where: { userId: 1 }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], limit: 5 }),
    await tx.table('users').count(),
  ], { isolationLevel: 'ReadCommitted' });
  await check('all 500 author projections and ordering', async () => assertMysqlExact('authors', await findAuthors(), authors(fixture, 500)));
  await check('all 1000 wide rows and 39 fields', async () => assertMysqlExact('wide', await wide(), fixture.bench_wide.slice(0, 1000)));
  await check('all 100 relation-count projections', async () => assertMysqlExact('count', await count(), fixture.users.slice(0, 100).map(u => ({ ...u, _count: { posts: 10 } }))));
  await check('serial five-query transaction result', async () => assertMysqlExact('dashboard', await dashboard(), dashboardExpected(fixture)));
  await check('fresh named binds, sparse slots and current values', async () => {
    const sql = 'SELECT $2 AS second, $1 AS first, $2 AS repeated';
    const params: unknown[] = ['first', 'second'];
    assert.deepEqual((await shim.query(sql, params)).rows, [{ second: 'second', first: 'first', repeated: 'second' }]);
    delete params[0]; params[1] = 'changed';
    assert.deepEqual((await shim.query(sql, params)).rows, [{ second: 'changed', first: null, repeated: 'changed' }]);
    await assert.rejects(shim.query(sql, [1]), /\$2 names no value/);
    await assert.rejects(shim.query(sql, [NaN, 1]), api.ValidationError);
    const growing: unknown[] = [{ toJSON() { growing.push(7); return 'json'; } }];
    for (let run = 0; run < 2; run++) {
      growing.length = 1;
      assert.deepEqual((await shim.query('SELECT :p2 AS second, :p1 AS first', growing)).rows, [{ second: 7, first: '"json"' }]);
    }
    for (const values of [[], [1], [1, 2, 3], [7, 8]]) {
      const rows = await users.findMany({ where: { id: { in: values } }, orderBy: { id: 'asc' } });
      assertMysqlExact('changing list', rows, fixture.users.filter(u => values.includes(u.id as number)));
    }
    const literal = "quotes'\\ ? :p1 $1 \0 😀";
    // mysql2's named-placeholder layer treats a question mark in this comment
    // as an extra binding. Preserve its existing refusal as well as our lexer.
    await assert.rejects(shim.query('SELECT $1 AS value /* $9 ? */', [literal]), /must not contain undefined/);
    assert.deepEqual((await shim.query('SELECT $1 AS value /* $9 */', [literal])).rows, [{ value: literal }]);
    const date = new Date('2024-02-29T12:34:56Z');
    const bytes = Buffer.from([0, 255, 9]);
    const row = (await shim.query('SELECT $1 AS moment, $2 AS bytes, $3 AS json', [date, bytes, { value: literal }])).rows[0];
    const [direct] = await raw.execute('SELECT ? AS moment, ? AS bytes, ? AS json', [date, bytes, JSON.stringify({ value: literal })]);
    assert.deepEqual(row, (direct as Native)[0]);
    assert.deepEqual(row.bytes, bytes);
    assert.deepEqual(JSON.parse(row.json), { value: literal });
    date.setTime(NaN);
    await assert.rejects(shim.query('SELECT $1 AS moment, $2 AS bytes, $3 AS json', [date, bytes, {}]), api.ValidationError);
  });
  await raw.query('DELETE FROM bench_writes');
  const writes = db.table('bench_writes');
  const data = { orgId: 1, slug: 'query-cost', label: 'fixed', amount: 0, active: true, createdAt: FIXTURE_TIME };
  const created = await writes.create({ data });
  const update = (amount: number) => writes.update({ where: { id: created.id }, data: { amount } });
  const upsert = (amount: number) => writes.upsert({ where: { slug: data.slug }, create: data, update: { amount } });
  await check('update/upsert exact returned fields and effect', async () => {
    for (const amount of [3, 7]) {
      assertMysqlExact('updated', await update(amount), { ...created, amount });
      assertMysqlExact('upserted', await upsert(amount + 1), { ...created, amount: amount + 1 });
      assertMysqlExact('stored', await writes.findUnique({ where: { id: created.id } }), { ...created, amount: amount + 1 });
    }
  });
  await check('outer rollback, caught savepoint failure and same connection', async () => {
    const sentinel = new Error('rollback sentinel');
    const before = await writes.findUnique({ where: { id: created.id } });
    await assert.rejects(db.$transaction(async (tx: Native) => {
      await tx.table('bench_writes').update({ where: { id: created.id }, data: { amount: 999 } });
      throw sentinel;
    }), (e: unknown) => e === sentinel);
    assertMysqlExact('rollback', await writes.findUnique({ where: { id: created.id } }), before);
    await db.$transaction(async (tx: Native) => {
      const connection = await tx.rawUnsafe('SELECT CONNECTION_ID() AS id');
      await tx.table('bench_writes').update({ where: { id: created.id }, data: { amount: 11 } });
      await assert.rejects(tx.table('bench_writes').create({ data }), api.UniqueConstraintError);
      assert.equal((await tx.rawUnsafe('SELECT CONNECTION_ID() AS id'))[0].id, connection[0].id);
      assert.equal((await tx.table('bench_writes').findUnique({ where: { id: created.id } })).amount, 11);
    });
    assert.equal((await writes.findUnique({ where: { id: created.id } })).amount, 11);
  });
  await check('tenant/global filters, compound identity and moved-key reselect', async () => {
    await raw.query('DELETE FROM query_cost_keys');
    await raw.query("INSERT INTO query_cost_keys VALUES (1,1,1,'one','first'),(2,2,1,'two','second')");
    const filtered = await engine.turbineMysql(raw, schema, { logger: {}, warnOnUnlimited: false, globalFilters: { query_cost_keys: { tenantId: 1 } } });
    try {
      const keys = filtered.table('query_cost_keys');
      assert.equal(await keys.findUnique({ where: { id: 2 } }), null);
      await assert.rejects(keys.update({ where: { id: 2 }, data: { label: 'leak' } }), api.NotFoundError);
      await assert.rejects(keys.update({ where: { label: 'first' }, data: { label: 'mass' } }), api.ValidationError);
      const moved = await keys.update({ where: { tenantId: 1, slot: 1 }, data: { id: 3, label: 'moved' } });
      assertMysqlExact('moved key', moved, { id: 3, tenantId: 1, slot: 1, email: 'one', label: 'moved' });
      assert.equal(await keys.findUnique({ where: { id: 1 } }), null);
      assert.equal((await keys.findUnique({ where: { id: 3 } })).label, 'moved');
    } finally { await filtered.disconnect(); }
  });
  for (const [name, run] of [
    ['to-one500', findAuthors], ['wide1000x39', wide], ['relation-count100', count],
    ['dashboardtransaction', dashboard], ['updatePK', () => update(1)], ['upsertuniqueupdate', () => upsert(2)],
  ] as const) {
    for (let i = 0; i < 5; i++) await run();
    const samplesMs: number[] = [];
    const traceStart = traces.length;
    recording = true;
    try { for (let i = 0; i < 30; i++) { const start = performance.now(); await run(); samplesMs.push(performance.now() - start); } }
    finally { recording = false; }
    const slice = traces.slice(traceStart);
    assert.ok(slice.length > 0, `Missing driver traces for ${name}`);
    profiles.push({ name, samplesMs, statements: slice.length, driverMs: slice.reduce((n, x) => n + x.ms, 0) });
  }
  await check('stream early return and supplied-pool ownership', async () => {
    let n = 0;
    for await (const row of comments.findManyStream({ orderBy: { id: 'asc' }, batchSize: 7 })) {
      assertMysqlExact('stream row', row, fixture.comments[n++]);
      if (n === 3) break;
    }
    assert.equal(n, 3);
    const checkout = await shim.connect();
    const controller = new AbortController();
    const aborted = new Error('owned cancellation sentinel');
    const stream = checkout.streamBatches('SELECT * FROM comments WHERE id > $1 ORDER BY id', [0], 7, controller.signal);
    try {
      assert.equal((await stream.next()).value.length, 7);
      controller.abort(aborted);
      await assert.rejects(stream.next(), (e: unknown) => e === aborted);
    } finally {
      await stream.return(undefined);
      checkout.release();
    }
    await db.disconnect();
    assert.equal((await raw.query('SELECT 1 AS alive'))[0][0].alive, 1);
  });
  writeFileSync(output, JSON.stringify({ passed: true, exploratory: true, node: process.version, format, settings, checks, profiles, traces }, null, 2));
  console.log(JSON.stringify({ passed: true, checks: checks.length, format, node: process.version }));
} catch (e) {
  writeFileSync(output, JSON.stringify({ passed: false, exploratory: true, node: process.version, format, checks, error: String((e as Error).stack) }, null, 2));
  throw e;
} finally {
  await db?.disconnect();
  await raw.end();
}
