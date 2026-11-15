import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createClient } from '@libsql/client/node';
import { PrismaLibSql } from '@prisma/adapter-libsql';
import { drizzle } from 'drizzle-orm/libsql';
import { drizzle as drizzleRc } from 'drizzle-rc/libsql';
import { turbine } from 'optional-generated-factory';
import { PrismaClient } from 'optional-prisma';
import { turbineLibsql } from 'turbine-orm/libsql';
import { runContract, seedStatements, seedTables, volumes } from './optional-sqlite-contract.mjs';
import { lanesFor, resetFor } from './optional-sqlite-lanes.mjs';

const options = JSON.parse(process.env.OPTIONAL_SQLITE_OPTIONS);
const native = createClient({ url: options.url, intMode: 'bigint' });
const stableNative = createClient({ url: options.url, intMode: 'number' });
const rcNative = createClient({ url: options.url, intMode: 'number' });
let db, prisma;
const report = {
  status: 'running',
  controls: [],
  cleanup: {},
  driverConfig: {
    Raw: { intMode: 'bigint', ownership: 'caller' },
    Turbine: { intMode: 'bigint', ownership: 'caller' },
    'Drizzle 0.45.4': {
      intMode: 'number',
      ownership: 'caller',
      note: 'safe-integer workload; SQLite numeric/boolean column mappers expect number',
    },
    'Drizzle RC 1.0.0-rc.5': {
      intMode: 'number',
      ownership: 'caller',
      note: 'safe-integer workload; SQLite numeric/boolean column mappers expect number',
    },
    'Prisma 7.10.1': { intMode: 'number', ownership: 'official adapter-owned client' },
  },
};
const save = () =>
  writeFileSync(
    options.report,
    JSON.stringify(report, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2),
  );
try {
  assert.equal(native.protocol, 'file');
  // Parent has provisioned the schema for actual native catalog generation.
  for (const statement of seedStatements()) await native.execute(statement);
  const raw = async (sql) => (await native.execute(sql)).rows.map((row) => Object.fromEntries(Object.entries(row)));
  const counts = {};
  for (const table of seedTables) {
    counts[table] = Number((await raw(`SELECT count(*) n FROM ${table}`))[0].n);
    assert.equal(counts[table], volumes[table]);
  }
  report.counts = counts;
  db = await turbine({ client: native, url: options.url }, { logger: {}, warnOnUnlimited: false });
  prisma = new PrismaClient({ adapter: new PrismaLibSql({ url: options.url, intMode: 'number' }) });
  assert.equal(typeof db.users.findMany, 'function', 'Generated accessor is present');
  const lanes = lanesFor(raw, db, drizzle({ client: stableNative }), drizzleRc({ client: rcNative }), prisma);
  Object.assign(report, await runContract(lanes, resetFor(raw), options));
  const control = (id, extra = {}) => report.controls.push({ id, passed: true, ...extra });
  const insert = "INSERT INTO bench_writes(id,org_id,slug,label) VALUES(1,1,'rollback','value')";
  const tx = await native.transaction('write');
  await tx.execute(insert);
  await tx.rollback();
  assert.equal(tx.closed, true);
  assert.equal(Number((await raw('SELECT count(*) n FROM bench_writes'))[0].n), 0);
  control('raw-native-rollback');
  for (const [name, run] of [
    ['Turbine', (fn) => db.$transaction(fn)],
    ['Drizzle 0.45.4', (fn) => drizzle({ client: stableNative }).transaction(fn)],
    ['Drizzle RC 1.0.0-rc.5', (fn) => drizzleRc({ client: rcNative }).transaction(fn)],
    ['Prisma 7.10.1', (fn) => prisma.$transaction(fn)],
  ]) {
    await assert.rejects(
      run(async (transaction) => {
        if (name === 'Turbine') await transaction.rawUnsafe(insert);
        else if (name.startsWith('Prisma')) await transaction.$executeRawUnsafe(insert);
        else {
          const { sql } = await (name.includes('RC') ? import('drizzle-rc') : import('drizzle-orm'));
          await transaction.run(sql.raw(insert));
        }
        throw new Error('intentional-rollback-marker');
      }),
      /intentional-rollback-marker/,
    );
    assert.equal(Number((await raw('SELECT count(*) n FROM bench_writes'))[0].n), 0);
    control(`${name}/callback-rollback`);
  }
  // Exact signed integer path uses the real driver; deliberately outside the
  // cross-arm safe-number workload, whose semantics must remain identical.
  const exact = await native.execute('SELECT 9007199254740993 exact');
  assert.equal(exact.rows[0][0], 9007199254740993n);
  control('native-exact-int64');
  await assert.rejects(turbineLibsql('libsql://localhost.invalid', db.schema), /local|support/i);
  await assert.rejects(turbineLibsql(':memory:', db.schema, { syncUrl: 'file:refused' }), /sync|support/i);
  control('remote-and-sync-refused');
  await assert.rejects(db.table('users').findManyStream({ batchSize: 1001 }).next(), /stream|incremental/i);
  const cancelled = new AbortController();
  cancelled.abort(new Error('cancelled-before-start'));
  await assert.rejects(db.table('users').findManyStream({ signal: cancelled.signal }).next(), /cancelled-before-start/);
  await assert.rejects(db.disconnect({ timeoutMs: 1 }), /Forced disconnect/);
  control('native-stream-inflight-cancel-and-forced-close-unavailable');
  // The timeout is observed at callback boundaries; native execute is not
  // interrupted. A bounded gate proves late callback work cannot escape.
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  let finished;
  const settled = new Promise((resolve) => {
    finished = resolve;
  });
  let lateError;
  try {
    await assert.rejects(
      db.$transaction(
        async (transaction) => {
          await transaction.rawUnsafe(insert);
          await held;
          try {
            await transaction.rawUnsafe(insert);
          } catch (error) {
            lateError = String(error);
          } finally {
            finished();
          }
        },
        { timeout: 20 },
      ),
      /timed out/,
    );
  } finally {
    release();
  }
  await settled;
  assert.match(lateError, /timed out|ended/);
  assert.equal(Number((await raw('SELECT count(*) n FROM bench_writes'))[0].n), 0);
  control('callback-timeout-rolls-back-late-work-refused');
  report.engineVersions = {
    Raw: await raw('SELECT sqlite_version() version'),
    Turbine: await db.rawUnsafe('SELECT sqlite_version() version'),
    'Drizzle 0.45.4': (await stableNative.execute('SELECT sqlite_version() version')).rows,
    'Drizzle RC 1.0.0-rc.5': (await rcNative.execute('SELECT sqlite_version() version')).rows,
    'Prisma 7.10.1': await prisma.$queryRawUnsafe('SELECT sqlite_version() version'),
  };
  await db.disconnect();
  assert.equal(native.closed, false);
  await raw('SELECT 1');
  control('caller-client-ownership');
  const owned = await turbineLibsql(options.url, db.schema, { logger: {} });
  await owned.disconnect();
  await assert.rejects(owned.rawUnsafe('SELECT 1'), /closed|disconnect/i);
  control('owned-client-disconnect');
  report.sqlite = await raw('SELECT sqlite_version() version');
  report.resources = {
    rssBytes: process.memoryUsage().rss,
    cpu: process.cpuUsage(),
    usage: process.resourceUsage(),
    scope: 'entire local-libSQL runner process, all arms; not per-arm or timing evidence',
  };
  report.nativeObjects = process.report.getReport().sharedObjects.filter((path) => /libsql.*\.node$/.test(path));
  report.nativeObjectHashes = Object.fromEntries(
    report.nativeObjects.map((path) => [path, createHash('sha256').update(readFileSync(path)).digest('hex')]),
  );
  assert.ok(report.nativeObjects.length, 'Required native libsql ABI loaded, no WASM fallback');
  report.generatedFactory = true;
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.error = error.stack;
} finally {
  try {
    await prisma?.$disconnect();
    await db?.disconnect();
  } catch (error) {
    report.cleanup.error = error.stack;
    report.status = 'failed';
  }
  native.close();
  stableNative.close();
  rcNative.close();
  report.cleanup.nativeClosed = native.closed;
  report.cleanup.drizzleClosed = stableNative.closed && rcNative.closed;
  save();
}
if (report.status !== 'passed') process.exitCode = 1;
