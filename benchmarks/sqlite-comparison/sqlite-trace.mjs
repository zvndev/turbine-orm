/** Native mechanism investigation; its observations are excluded from acceptance timing. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { Session } from 'node:inspector';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { bulkRows, openLane } from '../sqlite-comparison-clients.js';
import { buildCatalog } from '../sqlite-comparison-catalog.js';
import { nativeFixture, verifyScenarios } from '../sqlite-equivalence.js';
import { seedSqlite } from '../sqlite-seed.js';
import { openMatchedRc } from './sqlite-matched-rc.js';

const [binding, file, output, format = 'esm'] = process.argv.slice(2);
assert.ok(['node', 'better'].includes(binding) && file && output);
assert.ok(!existsSync(file), 'refuse a foreign or preexisting database');
const require = createRequire(import.meta.url);
const main = format === 'cjs' ? require('turbine-orm') : await import('turbine-orm');
const api = format === 'cjs'
  ? require(`turbine-orm/${binding === 'node' ? 'sqlite' : 'better-sqlite3'}`)
  : await import(`turbine-orm/${binding === 'node' ? 'sqlite' : 'better-sqlite3'}`);
const Better = require('better-sqlite3');
const report = {
  exploratory: true, acceptedTiming: false, concurrentWorkers: true,
  node: process.version, executable: process.execPath, binding, format,
  nodeSha256: createHash('sha256').update(readFileSync(process.execPath)).digest('hex'),
  sqlite: process.versions.sqlite,
  peer: require('better-sqlite3/package.json').version,
  peerBinarySha256: createHash('sha256').update(readFileSync(require.resolve('better-sqlite3/build/Release/better_sqlite3.node'))).digest('hex'),
  traces: [], phases: [], verified: [], closed: false,
};
const lanes = [];
let admin, db, raw;
try {
  await seedSqlite(file);
  admin = new DatabaseSync(file);
  const fixture = nativeFixture(admin);
  const { SCHEMA } = await import('../generated/sqlite-turbine/metadata.js');
  db = binding === 'node' ? api.turbineSqlite(file, SCHEMA, { logger: {} })
    : await api.turbineBetterSqlite3(file, SCHEMA, { logger: {} });
  const turbine = await openLane('Turbine', file);
  await turbine.close();
  turbine.db = db;
  turbine.handle = db.pool.db;
  turbine.find = (table, spec = {}, one = false) => db.table(table)[one ? 'findUnique' : 'findMany'](spec);
  turbine.count = (table, where) => db.table(table).count(where ? { where } : {});
  turbine.write = (op) => { assert.equal(op, 'bulk'); return db.table('bench_writes').createMany({ data: bulkRows }); };
  turbine.dashboard = async (tx) => {
    const queries = [db.table('users').buildFindUnique({ where: { id: 1 } }),
      db.table('posts').buildCount({ where: { userId: 1 } }), db.table('comments').buildCount({ where: { userId: 1 } }),
      db.table('posts').buildFindMany({ where: { userId: 1 }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], limit: 5 }),
      db.table('users').buildCount()];
    return tx ? db.$transaction(queries) : db.pipeline(queries, { transactional: false });
  };
  turbine.close = () => db.disconnect();
  const rc = await openLane('Drizzle RC', file), matched = openMatchedRc(file), rawLane = await openLane('Raw', file);
  lanes.push(turbine, rc, matched, rawLane);
  const selected = ['headline-0', 'headline-1', 'headline-2', 'headline-3', 'headline-4', 'headline-9',
    'large-5000', 'large-50000', 'large-wide', 'list-page3', 'relations-author', 'relations-tags',
    'relations-count', 'relations-filter', 'agg', 'writes-bulk'];
  for (const competitor of [rc, matched]) {
    const { scenarios } = buildCatalog([turbine, competitor, rawLane], fixture, admin, file);
    const tests = scenarios.filter((s) => selected.includes(s.id));
    assert.equal(tests.length, 16);
    report.verified.push({ competitor: competitor.kind, checks: await verifyScenarios(tests) });
  }
  const reset = () => admin.exec("DELETE FROM bench_writes; DELETE FROM sqlite_sequence WHERE name='bench_writes'");
  const execute = db.pool.db.prepare.bind(db.pool.db);
  let trace;
  db.pool.db.prepare = (sql) => { trace?.push(sql); return execute(sql); };
  for (const [id, table, args, bulk] of [
    ['flat100', 'users', { limit: 100, orderBy: { id: 'asc' } }],
    ['flat5000', 'comments', { limit: 5000, orderBy: { id: 'asc' } }],
    ['flat50000', 'comments', { limit: 50000, orderBy: { id: 'asc' } }],
    ['wide1000', 'bench_wide', { limit: 1000, orderBy: { id: 'asc' } }],
    ['L2', 'users', { limit: 50, orderBy: { id: 'asc' }, with: { posts: { orderBy: { id: 'asc' } } } }],
    ['author500', 'posts', { limit: 500, orderBy: { id: 'asc' }, with: { user: true } }],
    ['full-returning1000', 'bench_writes', {}, true],
  ]) {
    const query = bulk ? db.table(table).buildCreateMany({ data: bulkRows }) : db.table(table).buildFindMany(args);
    trace = [];
    if (bulk) reset();
    const result = bulk ? await db.table(table).createMany({ data: bulkRows }) : await db.table(table).findMany(args);
    report.traces.push({ id, resultRows: result.length, sql: trace, buildSql: query.sql, params: query.params.length,
      maxBindParameters: db.dialect?.capabilities?.maxBindParameters });
    trace = undefined;
    if (!process.env.SQLITE_NATIVE_PROFILE) continue;
    raw = binding === 'node' ? new DatabaseSync(file) : new Better(file);
    raw.exec('PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON');
    const params = Object.fromEntries(query.params.map((v, i) => [`p${i + 1}`, v instanceof Date ? v.toISOString()
      : typeof v === 'boolean' ? Number(v) : Number.isSafeInteger(v) ? BigInt(v) : v]));
    const poolResult = await (bulk ? (reset(), db.pool.query(query.sql, query.params)) : db.pool.query(query.sql, query.params));
    for (const phase of ['native-objects', 'native-arrays', 'pool', 'transform', 'public']) {
      const session = new Session(); session.connect();
      const post = (method) => new Promise((resolve, reject) => session.post(method, (e, r) => e ? reject(e) : resolve(r)));
      await post('Profiler.enable'); await post('Profiler.start');
      const times = [];
      for (let repeat = 0; repeat < 15; repeat++) {
        if (bulk) reset();
        const start = performance.now();
        if (phase.startsWith('native')) {
          const stmt = raw.prepare(query.sql);
          if (binding === 'node') { stmt.setReadBigInts(true); stmt.setReturnArrays(phase.endsWith('arrays')); }
          else { stmt.safeIntegers(true); stmt.raw(phase.endsWith('arrays')); }
          query.params.length ? stmt.all(params) : stmt.all();
        } else if (phase === 'pool') await db.pool.query(query.sql, query.params);
        else if (phase === 'transform') query.transform(poolResult);
        else if (bulk) await db.table(table).createMany({ data: bulkRows });
        else await db.table(table).findMany(args);
        times.push(performance.now() - start);
      }
      const { profile } = await post('Profiler.stop'); session.disconnect();
      writeFileSync(`${output}.${id}.${phase}.cpuprofile`, JSON.stringify(profile));
      report.phases.push({ id, phase, samples: times, profile: `${output}.${id}.${phase}.cpuprofile` });
    }
    raw.close(); raw = undefined;
  }
  assert.equal(main.defineSchema instanceof Function, true);
} finally {
  raw?.close();
  for (const lane of lanes.reverse()) await lane.close();
  if (db && !lanes.some((l) => l.db === db)) await db.disconnect();
  admin?.close();
  for (const suffix of ['', '-wal', '-shm', '-journal']) rmSync(file + suffix, { force: true });
  report.closed = true;
  writeFileSync(output, JSON.stringify(report, null, 2));
}
console.log(JSON.stringify({ binding, format, verified: report.verified.length, traces: report.traces.length, closed: report.closed }));
