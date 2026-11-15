import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const require = createRequire(import.meta.url);
assert.throws(() => require.resolve('pg'), /Cannot find module/, 'No ancestor or local pg may satisfy this consumer');
const load = (path) => process.env.FORMAT === 'cjs' ? require(path) : import(path);
const manifest = JSON.parse(readFileSync('node_modules/turbine-orm/package.json'));
const imported = [];
for (const entry of Object.keys(manifest.exports)) {
  const specifier = entry === '.' ? 'turbine-orm' : `turbine-orm/${entry.slice(2)}`;
  const api = await load(specifier);
  assert.ok(Object.keys(api).length, `Empty API: ${specifier}`);
  imported.push(specifier);
}
const api = await load('turbine-orm');
const sqlite = await load('turbine-orm/sqlite');
const raw = new DatabaseSync(':memory:');
raw.exec(`CREATE TABLE items(id INTEGER PRIMARY KEY, tenant_id INTEGER NOT NULL, label TEXT NOT NULL UNIQUE, active BOOLEAN, payload JSON, happened_at TIMESTAMP, large BIGINT);
  INSERT INTO items VALUES(1,1,'one',1,'{"a":[1,null]}','2026-01-02 03:04:05',9007199254740991),(2,2,'two',0,NULL,NULL,9007199254740992);`);
const schema = sqlite.introspectSqliteDatabase(raw);
const db = sqlite.turbineSqlite(raw, schema, { warnOnUnlimited: false });
const expected = [
  { id: 1, tenantId: 1, label: 'one', active: true, payload: { a: [1, null] }, happenedAt: new Date('2026-01-02T03:04:05Z'), large: 9007199254740991 },
  { id: 2, tenantId: 2, label: 'two', active: false, payload: null, happenedAt: null, large: '9007199254740992' },
];
try {
  assert.deepEqual(await db.table('items').findMany({ orderBy: { id: 'asc' } }), expected);
  const scoped = sqlite.turbineSqlite(raw, schema, { globalFilters: { items: { tenantId: 1 } } });
  assert.deepEqual(await scoped.table('items').findMany(), [expected[0]]);
  assert.equal(await scoped.table('items').findUnique({ where: { id: 2 } }), null);
  await scoped.disconnect();
  await assert.rejects(() => db.$transaction(async (tx) => {
    await tx.table('items').update({ where: { id: 1 }, data: { label: 'rolled-back' } });
    throw Error('rollback probe');
  }), /rollback probe/);
  assert.deepEqual(await db.table('items').findUnique({ where: { id: 1 } }), expected[0]);
  await assert.rejects(() => db.table('items').findUnique({ where: {} }), /TURBINE_E003/);

  const { turbineCore } = await load('turbine-orm/core');
  const { turbineD1, d1Dialect } = await load('turbine-orm/d1');
  let ends = 0;
  const pool = {
    async query(text, values = []) {
      return db.pool.query(text, values);
    },
    async connect() { throw Error('Core must not check out'); },
    async end() { ends++; },
  };
  const core = turbineCore(pool, schema, { dialect: d1Dialect });
  assert.deepEqual(await core.table('items').findMany({ orderBy: { id: 'asc' } }), expected);
  assert.throws(() => core.$transaction(() => {}), /TURBINE_E017/);
  await core.disconnect();
  assert.equal(ends, 0, 'Caller retains supplied pool');
  const binding = { prepare(sql) {
    let values = [];
    const statement = {
      bind(...next) { values = next; return statement; },
      async all() { return { success: true, results: (await db.pool.query(sql, values)).rows, meta: {} }; },
    };
    return statement;
  }, async batch() { throw Error('Native D1 batches are tested separately'); } };
  const d1 = turbineD1(binding, schema);
  assert.deepEqual(await d1.table('items').findMany({ orderBy: { id: 'asc' } }), expected);
  await assert.rejects(() => d1.transaction(() => {}), /TURBINE_E017/);
  await d1.disconnect();

  const missing = [
    ['mysql', 'turbineMysql', 'mysql://localhost/missing', /mysql2/],
    ['mssql', 'turbineMssql', 'mssql://localhost/missing', /mssql/],
    ['libsql', 'turbineLibsql', 'file:unused.db', /@libsql\/client/],
    ['powdb', 'turbinePowDB', 'powdb://localhost/missing', /powdb-client/],
  ];
  for (const [entry, factory, target, pattern] of missing) {
    const engine = await load(`turbine-orm/${entry}`);
    await assert.rejects(() => engine[factory](target, schema), pattern);
  }
  const ws = await load('turbine-orm/neon-ws');
  await assert.rejects(() => ws.turbineNeonWs({ connection: { connectionString: 'postgresql://localhost/missing' } }, schema, { sessionMode: 'persistent', lifetime: 'persistent' }), /@neondatabase\/serverless/);
  const { turbineNeonHttp } = await load('turbine-orm/neon-http');
  const http = turbineNeonHttp({ query: (text, values) => pool.query(text, values), transaction: () => { throw Error('Not used'); } }, schema);
  assert.deepEqual(await http.rawUnsafe('SELECT 7 AS n'), [{ n: 7 }]);
  assert.throws(() => http.transaction(() => {}), /TURBINE_E017/);
  await http.disconnect();
  assert.throws(() => new api.TurbineClient({}, schema), /optional pg peer/);
  const loader = process.env.FORMAT === 'cjs'
    ? require(join(process.cwd(), 'node_modules/turbine-orm/dist/optional-pg.cjs'))
    : (await import(pathToFileURL(join(process.cwd(), 'node_modules/turbine-orm/dist/optional-pg.js')))).default;
  for (const action of [() => loader.types.getTypeParser(20), () => loader.types.setTypeParser(20, (x) => x), () => loader.types.arrayParser.create('{}'), () => loader.utils.prepareValue(1), () => new loader.Pool(), () => new loader.Result()]) {
    assert.throws(action, /optional pg peer/);
  }
  api.generate({ schema, target: 'sqlite', outDir: 'generated-sqlite', noTimestamp: true });
  assert.match(readFileSync('generated-sqlite/index.ts', 'utf8'), /from 'turbine-orm\/sqlite'/);
  api.generate({ schema, outDir: 'generated-pg', noTimestamp: true });
  assert.match(readFileSync('generated-pg/index.ts', 'utf8'), /from 'turbine-orm'/);
  console.log(JSON.stringify({ ok: true, node: process.version, format: process.env.FORMAT, imported, scalarRows: expected.length, rollback: true, callerOwned: true, noFakeParsers: true, optionalPeerRefusals: missing.length }));
} finally {
  await db.disconnect();
  assert.equal(raw.prepare('SELECT 1 AS alive').get().alive, 1, 'Caller database survives disconnect');
  raw.close();
}
