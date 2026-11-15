import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const require = createRequire(import.meta.url);
const load = (name) => process.env.FORMAT === 'cjs' ? require(name) : import(name);
const api = await load('turbine-orm');
const pg = require('pg');
const format = process.env.FORMAT;
if (process.env.STAGED === '1') {
  const loader = format === 'cjs'
    ? require(join(process.cwd(), 'node_modules/turbine-orm/dist/optional-pg.cjs'))
    : (await import(pathToFileURL(join(process.cwd(), 'node_modules/turbine-orm/dist/optional-pg.js')))).default;
  assert.equal(loader, pg, 'Exact installed driver object, no wrapper');
  assert.equal(loader.types, pg.types);
  assert.equal(loader.types.getTypeParser(1700), pg.types.getTypeParser(1700));
  assert.equal(loader.Result, pg.Result);
  assert.equal(loader.utils.prepareValue, pg.utils.prepareValue);
}
const url = process.env.OWNED_PG_URL;
assert.ok(url);
const setup = new pg.Client({ connectionString: url });
await setup.connect();
let db;
let external;
try {
  await setup.query(`DROP TABLE IF EXISTS children; DROP TABLE IF EXISTS items;
    CREATE TABLE items(id INTEGER PRIMARY KEY, tenant_id INTEGER NOT NULL, label TEXT NOT NULL UNIQUE, big BIGINT NOT NULL, exact NUMERIC, flag BOOLEAN, payload JSONB, happened_at TIMESTAMP, day DATE, data BYTEA, nums BIGINT[]);
    CREATE TABLE children(id INTEGER PRIMARY KEY, item_id INTEGER REFERENCES items(id), label TEXT NOT NULL);
    INSERT INTO items VALUES(1,1,'one',9007199254740991,12345678901234567890.123,true,'{"a":[1,null]}','2026-01-02 03:04:05.123','2026-01-02','\\x0080ff',ARRAY[1,9007199254740992]::BIGINT[]),
      (2,2,'two',9007199254740992,NULL,false,NULL,NULL,NULL,NULL,NULL);
    INSERT INTO children VALUES(1,1,'a'),(2,1,'b'),(3,2,'c');`);
  const schema = await api.introspect({ connectionString: url });
  db = new api.TurbineClient({ connectionString: url, warnOnUnlimited: false }, schema);
  const expected = [
    { id: 1, tenantId: 1, label: 'one', big: 9007199254740991, exact: '12345678901234567890.123', flag: true, payload: { a: [1, null] }, happenedAt: new Date('2026-01-02T03:04:05.123Z'), day: new Date('2026-01-02Z'), data: Buffer.from([0, 128, 255]), nums: ['1', '9007199254740992'] },
    { id: 2, tenantId: 2, label: 'two', big: '9007199254740992', exact: null, flag: false, payload: null, happenedAt: null, day: null, data: null, nums: null },
  ];
  const rows = await db.table('items').findMany({ orderBy: { id: 'asc' } });
  assert.deepEqual(rows, expected);
  const relation = Object.values(schema.tables.items.relations).find((r) => r.type === 'hasMany').name;
  const related = await db.table('items').findMany({ orderBy: { id: 'asc' }, with: { [relation]: { orderBy: { id: 'asc' } } } });
  assert.deepEqual(related, expected.map((row, i) => ({ ...row, [relation]: i === 0 ? [{ id: 1, itemId: 1, label: 'a' }, { id: 2, itemId: 1, label: 'b' }] : [{ id: 3, itemId: 2, label: 'c' }] })));
  await assert.rejects(() => db.$transaction(async (tx) => {
    await tx.table('items').update({ where: { id: 1 }, data: { label: 'rolled-back' } });
    throw Error('rollback probe');
  }), /rollback probe/);
  assert.deepEqual(await db.table('items').findUnique({ where: { id: 1 } }), expected[0]);
  await db.$transaction(async (tx) => { await tx.table('items').update({ where: { id: 1 }, data: { label: 'committed' } }); });
  assert.equal((await db.table('items').findUnique({ where: { id: 1 } })).label, 'committed');
  const scoped = new api.TurbineClient({ connectionString: url, globalFilters: { items: { tenantId: 1 } } }, schema);
  try {
    assert.equal(await scoped.table('items').findUnique({ where: { id: 2 } }), null);
    assert.equal(await scoped.table('items').count(), 1);
  } finally { await scoped.disconnect(); }
  const prepared = await db.rawUnsafe('SELECT name, statement FROM pg_prepared_statements ORDER BY name');
  assert.ok(prepared.length > 0, 'Default named prepared protocol remains active');
  external = new pg.Pool({ connectionString: url });
  const supplied = new api.TurbineClient({ pool: external }, schema);
  assert.equal(supplied.pool, external);
  try { assert.equal((await supplied.table('items').findUnique({ where: { id: 2 } })).big, '9007199254740992'); }
  finally { await supplied.disconnect(); }
  assert.equal((await external.query('SELECT 1 AS alive')).rows[0].alive, 1);
  const deadline = new api.TurbineClient({ connectionString: url, statementTimeoutMs: 25 }, schema);
  try {
    await assert.rejects(() => deadline.rawUnsafe('SELECT pg_sleep(0.2)'), api.TimeoutError);
    assert.deepEqual(await deadline.rawUnsafe('SELECT 1 AS alive'), [{ alive: 1 }]);
  } finally { await deadline.disconnect(); }
  api.generate({ schema, outDir: 'generated-pg', noTimestamp: true });
  const { build } = await import(pathToFileURL(process.env.OPTIONAL_ESBUILD));
  await build({ entryPoints: ['generated-pg/index.ts', 'generated-pg/metadata.ts', 'generated-pg/types.ts'], outdir: 'generated-runtime', platform: 'node', format: format === 'cjs' ? 'cjs' : 'esm', bundle: false });
  writeFileSync('generated-runtime/package.json', JSON.stringify({ type: format === 'cjs' ? 'commonjs' : 'module' }));
  const generated = format === 'cjs' ? require(join(process.cwd(), 'generated-runtime/index.js')) : await import(pathToFileURL(join(process.cwd(), 'generated-runtime/index.js')));
  const typed = generated.turbine({ connectionString: url });
  try { assert.equal((await typed.items.findUnique({ where: { id: 1 } })).label, 'committed'); }
  finally { await typed.disconnect(); }
  console.log(JSON.stringify({ ok: true, staged: process.env.STAGED === '1', pg: JSON.parse(readFileSync('node_modules/pg/package.json')).version, node: process.version, format, rows, related, prepared: prepared.length, rollback: true, commit: true, timeoutRecovery: true, generatedFactoryExecuted: true, callerPoolSurvives: true, exports: Object.keys(api).sort() }));
} finally {
  await db?.disconnect();
  await external?.end();
  await setup.end();
}
