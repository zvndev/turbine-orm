import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const require = createRequire(import.meta.url);
const load = (name) => process.env.FORMAT === 'cjs' ? require(name) : import(name);
const api = await load('turbine-orm');
const stageRequire = createRequire(require.resolve('turbine-orm'));
const pg = stageRequire('pg');
const format = process.env.FORMAT;
const driver = JSON.parse(readFileSync(resolve(dirname(stageRequire.resolve('pg')), '../package.json'))).version;
assert.equal(driver, process.env.EXPECT_PG);
if (process.env.STAGED === '1') assert.equal(JSON.parse(readFileSync(resolve(dirname(require.resolve('pg')), '../package.json'))).version, '8.15.0');
const url = process.env.OWNED_PG_URL;
assert.ok(url);
const setup = new pg.Client({ connectionString: url });
await setup.connect();
let db;
let external;
try {
  const rawProto = await setup.query('SELECT 7 AS "__proto__", 9 AS "constructor", 11 AS "toString"');
  assert.deepEqual(rawProto.fields.map(field => ({ name: field.name, type: field.dataTypeID })), [
    { name: '__proto__', type: 23 }, { name: 'constructor', type: 23 }, { name: 'toString', type: 23 },
  ]);
  let retainedLegacyFailure = null;
  try {
    assert.equal(Object.hasOwn(rawProto.rows[0], '__proto__'), true, 'Raw __proto__ result column must survive');
    assert.deepEqual(rawProto.rows, [JSON.parse('{"__proto__":7,"constructor":9,"toString":11}')]);
  } catch (error) {
    if (driver !== '8.15.0') throw error;
    retainedLegacyFailure = error.stack;
  }
  if (driver === '8.15.0') assert.ok(retainedLegacyFailure, 'Legacy negative must reproduce');
  await setup.query(`DROP TABLE IF EXISTS children; DROP TABLE IF EXISTS items;
    CREATE TABLE items(id INTEGER PRIMARY KEY, tenant_id INTEGER NOT NULL, label TEXT NOT NULL UNIQUE, big BIGINT NOT NULL, exact NUMERIC, flag BOOLEAN, payload JSONB, happened_at TIMESTAMP, day DATE, data BYTEA, nums BIGINT[]);
    CREATE TABLE children(id INTEGER PRIMARY KEY, item_id INTEGER REFERENCES items(id), label TEXT NOT NULL);
    INSERT INTO items VALUES(1,1,'one',9007199254740991,12345678901234567890.123,true,'{"a":[1,null],"__proto__":{"safe":true}}','2026-01-02 03:04:05.123','2026-01-02','\\x0080ff',ARRAY[1,9007199254740992]::BIGINT[]),
      (2,2,'two',9007199254740992,NULL,false,NULL,NULL,NULL,NULL,NULL);
    INSERT INTO children VALUES(1,1,'a'),(2,1,'b'),(3,2,'c');`);
  const schema = await api.introspect({ connectionString: url });
  db = new api.TurbineClient({ connectionString: url, warnOnUnlimited: false }, schema);
  const expected = [
    { id: 1, tenantId: 1, label: 'one', big: 9007199254740991, exact: '12345678901234567890.123', flag: true, payload: JSON.parse('{"a":[1,null],"__proto__":{"safe":true}}'), happenedAt: new Date('2026-01-02T03:04:05.123Z'), day: new Date('2026-01-02Z'), data: Buffer.from([0, 128, 255]), nums: ['1', '9007199254740992'] },
    { id: 2, tenantId: 2, label: 'two', big: '9007199254740992', exact: null, flag: false, payload: null, happenedAt: null, day: null, data: null, nums: null },
  ];
  const rows = await db.table('items').findMany({ orderBy: { id: 'asc' } });
  assert.deepEqual(rows, expected);
  assert.equal(Object.getPrototypeOf(rows[0]), Object.prototype);
  assert.equal(Object.getPrototypeOf(rows[0].payload), Object.prototype);
  assert.equal(Object.hasOwn(rows[0].payload, '__proto__'), true);
  // Observe the actual factory-owned driver graph, rather than just a manifest version.
  assert.ok(db.pool instanceof pg.Pool);
  if (process.env.STAGED === '1') assert.equal(db.pool instanceof require('pg').Pool, false);
  if (!retainedLegacyFailure) assert.deepEqual(await db.rawUnsafe('SELECT 7 AS "__proto__", 9 AS "constructor", 11 AS "toString"'), [JSON.parse('{"__proto__":7,"constructor":9,"toString":11}')]);
  assert.deepEqual(await db.raw`SELECT ${"quote' backslash\\ Unicode λ"}::text AS text, ${Buffer.from([0,128,255])}::bytea AS bytes`, [{ text: "quote' backslash\\ Unicode λ", bytes: Buffer.from([0,128,255]) }]);
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
  let suppliedLegacy = null;
  if (process.env.STAGED === '1') {
    const legacy = new (require('pg').Pool)({ connectionString: url });
    const caller = new api.TurbineClient({ pool: legacy }, schema);
    try {
      const raw = await caller.rawUnsafe('SELECT 7 AS "__proto__"');
      assert.equal(Object.hasOwn(raw[0], '__proto__'), false, 'Supplied legacy limitation stays visible');
      suppliedLegacy = { driver: '8.15.0', ownProtoColumn: false, preservedIdentity: caller.pool === legacy };
      assert.equal(suppliedLegacy.preservedIdentity, true);
    } finally { await caller.disconnect(); }
    assert.deepEqual((await legacy.query('SELECT 1 AS alive')).rows, [{ alive: 1 }]);
    await legacy.end();
  }
  const deadline = new api.TurbineClient({ connectionString: url, statementTimeoutMs: 25 }, schema);
  try {
    await assert.rejects(() => deadline.rawUnsafe('SELECT pg_sleep(0.2)'), api.TimeoutError);
    assert.deepEqual(await deadline.rawUnsafe('SELECT 1 AS alive'), [{ alive: 1 }]);
  } finally { await deadline.disconnect(); }
  api.generate({ schema, outDir: 'generated-pg', noTimestamp: true });
  const { execFileSync } = await import('node:child_process');
  const compiler = process.env.STAGE_TSC;
  const emittedDirectory = `generated-runtime-${process.version}-${format}`;
  const configPath = `tsconfig-${process.version}-${format}.json`;
  const consumer = `import { turbine } from './generated-pg/index.js';\nconst db=turbine({connectionString:'postgresql://unused'});\nasync function check(){const rows=await db.items.findMany({select:{label:true}}); const label:string=rows[0]!.label;\n// @ts-expect-error projection excludes id\nrows[0]!.id;\n// @ts-expect-error generated create requires full input\nawait db.items.create({data:{}}); return label;} void check;`;
  writeFileSync('generated-consumer.ts', consumer);
  const config = { compilerOptions: { target: 'ES2023', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true,
    skipLibCheck: false, esModuleInterop: true, outDir: emittedDirectory, types: ['node'], typeRoots: [process.env.STAGE_TYPE_ROOTS] },
    include: ['generated-pg/**/*.ts', 'generated-consumer.ts', 'typed.mts', 'typed.cts'] };
  writeFileSync(configPath, JSON.stringify(config));
  writeFileSync('package.json', JSON.stringify({ private:true, type: format === 'cjs' ? 'commonjs' : 'module' }));
  const compilerArgs = [compiler, '-p', configPath];
  const compilerStdout = execFileSync(process.execPath, compilerArgs, { encoding: 'utf8', stdio: 'pipe' });
  writeFileSync(join(emittedDirectory, 'package.json'), JSON.stringify({ type: format === 'cjs' ? 'commonjs' : 'module' }));
  const generatedPath = join(process.cwd(), emittedDirectory, 'generated-pg/index.js');
  const generated = format === 'cjs' ? require(generatedPath) : await import(pathToFileURL(generatedPath));
  const typed = generated.turbine({ connectionString: url });
  try {
    const all = await typed.items.findMany({ orderBy: { id: 'asc' } });
    assert.deepEqual(all, expected.map((row, i) => i === 0 ? { ...row, label: 'committed' } : row));
    assert.deepEqual(await typed.items.findMany({ orderBy: { id: 'asc' }, with: { [relation]: { orderBy: { id: 'asc' } } } }),
      related.map((row, i) => i === 0 ? { ...row, label: 'committed' } : row));
  }
  finally { await typed.disconnect(); }
  const hashes = root => Object.fromEntries(readdirSync(root, { withFileTypes: true }).flatMap(entry => {
    const path = join(root, entry.name);
    return entry.isDirectory() ? Object.entries(hashes(path)) : [[path, createHash('sha256').update(readFileSync(path)).digest('hex')]];
  }));
  console.log(JSON.stringify({ ok: retainedLegacyFailure === null, expectedNegative: driver === '8.15.0', positiveContractChecksPassed: true,
    staged: process.env.STAGED === '1', pg: driver, driverPath: stageRequire.resolve('pg'), node: process.version, format, rows, related,
    rawProto: { rows: rawProto.rows, fields: rawProto.fields, own: Object.hasOwn(rawProto.rows[0], '__proto__'), retainedLegacyFailure }, suppliedLegacy,
    generated: { path: generatedPath, sourceHashes: hashes('generated-pg'), emittedHashes: hashes(emittedDirectory), compiler: { binary: process.execPath, args: compilerArgs, stdout: compilerStdout, config } },
    prepared: prepared.length, rollback: true, commit: true, timeoutRecovery: true, strictGeneratedFactoryExecuted: true, callerPoolSurvives: true, exports: Object.keys(api).sort() }));
} finally {
  await db?.disconnect();
  await external?.end();
  await setup.end();
}
