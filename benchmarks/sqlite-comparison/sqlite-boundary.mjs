/** Installed complete-catalog preservation and exploratory SQLite boundary profiles. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { Session } from 'node:inspector';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { openLane } from '../sqlite-comparison-clients.js';
import { buildCatalog, disposeCatalog, requiredIds } from '../sqlite-comparison-catalog.js';
import { assertCatalog, nativeFixture, verifyScenarios } from '../sqlite-equivalence.js';
import { seedSqlite } from '../sqlite-seed.js';
import { openMatchedRc } from './sqlite-matched-rc.js';

const [binding, file, output, profileMode = 'none', fault = 'none'] = process.argv.slice(2);
assert.ok(['node', 'better'].includes(binding) && file && output);
assert.ok(!existsSync(file), 'refuse an existing database');
const require = createRequire(import.meta.url);
const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const report = {
  exploratory: true, acceptedTiming: false, node: process.version, executable: process.execPath,
  nodeSha256: sha256(process.execPath), binding, peer: require('better-sqlite3/package.json').version,
  peerNativeSha256: sha256(require.resolve('better-sqlite3/build/Release/better_sqlite3.node')),
  verified: [], omissions: [], traces: [], phases: [], closed: false,
};
const lanes = [];
let admin;
let failed = false, primary;
const cleanupErrors = [];
try {
  await seedSqlite(file);
  admin = new DatabaseSync(file);
  const fixture = nativeFixture(admin);
  const turbine = await openLane('Turbine', file, { sqliteBinding: binding === 'better' ? 'better-sqlite3' : 'node:sqlite' });
  lanes.push(turbine);
  const rc = await openLane('Drizzle RC', file);
  lanes.push(rc);
  const raw = await openLane('Raw', file);
  lanes.push(raw);
  const matched = openMatchedRc(file);
  lanes.push(matched);
  report.route = { turbine: turbine.kind, originalRc: rc.kind, matchedRc: matched.kind };
  for (const competitor of [rc, matched]) {
    const { scenarios, catalog } = buildCatalog([turbine, competitor, raw], fixture, admin, file);
    try {
      assertCatalog(scenarios, requiredIds);
      // The existing matched supplement implements the original sixteen
      // loss targets, including bulk, but not the other mutation operations.
      const matchedIds = ['headline-0', 'headline-1', 'headline-2', 'headline-3', 'headline-4', 'headline-9',
        'large-5000', 'large-50000', 'large-wide', 'list-page3', 'relations-author', 'relations-tags',
        'relations-count', 'relations-filter', 'agg', 'writes-bulk'];
      const selected = competitor === matched ? scenarios.filter((s) => matchedIds.includes(s.id)) : scenarios;
      if (competitor === matched) {
        assert.equal(selected.length, 16);
        report.omissions.push({ competitor: competitor.kind,
          ids: scenarios.filter((s) => !matchedIds.includes(s.id)).map((s) => s.id),
          reason: 'Existing matched supplement is limited to sixteen targets; complete original RC catalog verified separately.' });
      }
      const checks = await verifyScenarios(selected, fault);
      report.verified.push({ competitor: competitor.kind, scenarios: selected.length, checks, catalog });
    } finally { await disposeCatalog(scenarios); }
  }
  const db = turbine.db, prepare = db.pool.db.prepare.bind(db.pool.db);
  let trace;
  db.pool.db.prepare = (sql) => { trace?.push(sql); return prepare(sql); };
  const reset = () => admin.exec("DELETE FROM bench_writes; DELETE FROM sqlite_sequence WHERE name='bench_writes'");
  for (const [id, table, args, bulk] of [
    ['flat100', 'users', { limit: 100, orderBy: { id: 'asc' } }],
    ['flat5000', 'comments', { limit: 5000, orderBy: { id: 'asc' } }],
    ['flat50000', 'comments', { limit: 50000, orderBy: { id: 'asc' } }],
    ['wide1000', 'bench_wide', { limit: 1000, orderBy: { id: 'asc' } }],
    ['L2', 'users', { limit: 50, orderBy: { id: 'asc' }, with: { posts: { orderBy: { id: 'asc' } } } }],
    ['author500', 'posts', { limit: 500, orderBy: { id: 'asc' }, with: { user: true } }],
    ['full-returning1000', 'bench_writes', {}, true],
  ]) {
    const { bulkRows } = await import('../sqlite-comparison-clients.js');
    const query = bulk ? db.table(table).buildCreateMany({ data: bulkRows }) : db.table(table).buildFindMany(args);
    trace = [];
    if (bulk) reset();
    const rows = bulk ? await db.table(table).createMany({ data: bulkRows }) : await db.table(table).findMany(args);
    report.traces.push({ id, rows: rows.length, statements: trace, sql: query.sql, params: query.params.length });
    if (bulk) {
      assert.equal(trace.length, 27, 'BEGIN +25 inserts +COMMIT stay intact');
      assert.equal(rows.length, 1000);
      assert.equal(admin.prepare('SELECT COUNT(*) AS n FROM bench_writes').get().n, 1000);
    }
    trace = undefined;
    if (profileMode === 'none' || bulk) continue;
    const rawResult = await db.pool.query(query.sql, query.params);
    for (const phase of ['pool', 'transform', 'public']) {
      const session = new Session(); session.connect();
      const post = (method) => new Promise((resolve, reject) => session.post(method, (e, result) => e ? reject(e) : resolve(result)));
      try {
      if (profileMode === 'cpu') { await post('Profiler.enable'); await post('Profiler.start'); }
      const times = [];
      for (let repeat = 0; repeat < 25; repeat++) {
        const start = performance.now();
        const value = phase === 'pool' ? (await db.pool.query(query.sql, query.params)).rows
          : phase === 'transform' ? query.transform(rawResult) : await db.table(table).findMany(args);
        const elapsed = performance.now() - start;
        assert.equal(value.length, rows.length);
        if (repeat >= 5) times.push(elapsed);
      }
      if (profileMode === 'cpu') {
        const { profile } = await post('Profiler.stop');
        writeFileSync(`${output}.${id}.${phase}.cpuprofile`, JSON.stringify(profile));
      }
      report.phases.push({ id, phase, samples: times });
      } finally { session.disconnect(); }
    }
  }
} catch (error) {
  failed = true;
  primary = error;
} finally {
  for (const lane of lanes.reverse()) {
    try { await lane.close(); } catch (error) { cleanupErrors.push(error); }
  }
  try { admin?.close(); } catch (error) { cleanupErrors.push(error); }
  // A rejected close is not evidence that a native handle is gone. Preserve
  // its database for explicit owned recovery instead of unlinking a live file.
  if (!cleanupErrors.length) {
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
      try { rmSync(file + suffix, { force: true }); } catch (error) { cleanupErrors.push(error); }
    }
  }
  report.closed = cleanupErrors.length === 0;
  report.cleanupErrors = cleanupErrors.map((error) => {
    try { return String(error); } catch { return 'Unprintable cleanup error'; }
  });
  try { writeFileSync(output, JSON.stringify(report, null, 2)); } catch (error) { cleanupErrors.push(error); }
}
if (failed) throw primary;
if (cleanupErrors.length) throw new AggregateError(cleanupErrors, 'SQLite boundary cleanup failed.');
console.log(JSON.stringify({ binding, scenarios: report.verified.map((v) => v.scenarios), closed: report.closed }));
