/** Bounded correctness/negative-control runner for the ORIGINAL extended suite. */
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { tsImport } from 'tsx/esm/api';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(process.argv[2] ?? 'missing-output-directory');
assert.ok(process.argv[2], 'New evidence output directory required');
mkdirSync(output);
const prefix = process.env.PG_EXTENDED_PREFIX;
assert.ok(prefix, 'PG_EXTENDED_PREFIX must name the local PostgreSQL installation.');
const hash = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const report = {
  format: 'extended-native-smoke-v1',
  status: 'running',
  runtime: { node: process.version, executable: process.execPath, sha256: hash(process.execPath) },
  processes: [],
  controls: [],
  errors: [],
  cleanupErrors: [],
  cleanup: {},
};
const save = () => writeFileSync(join(output, 'native.json'), `${JSON.stringify(report, null, 2)}\n`);
const owned = [];
let service, observer, temporary;
function launch(command, args, log, env = process.env) {
  const child = spawn(command, args, { cwd: root, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const record = { command: [command, ...args], pid: child.pid, pgid: child.pid, exit: null, log };
  report.processes.push(record);
  let text = '';
  child.stdout.on('data', (b) => {
    text += b;
  });
  child.stderr.on('data', (b) => {
    text += b;
  });
  const done = new Promise((resolveDone, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      record.exit = { code, signal };
      writeFileSync(join(output, log), text);
      resolveDone(record.exit);
    });
  });
  const task = { child, record, done };
  owned.push(task);
  save();
  return task;
}
async function bounded(task, ms = 60000) {
  let timer;
  try {
    return await Promise.race([
      task.done,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Deadline: ${task.record.log}`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function stop(task) {
  if (!task || task.record.exit) return;
  process.kill(-task.record.pgid, 'SIGTERM');
  try {
    await bounded(task, 8000);
  } catch {
    process.kill(-task.record.pgid, 'SIGKILL');
    await bounded(task, 3000);
  }
}
let interrupted = false;
for (const signal of ['SIGTERM', 'SIGINT'])
  process.on(signal, () => {
    interrupted = true;
    report.errors.push(signal);
    save();
    for (const p of owned)
      if (!p.record.exit)
        try {
          process.kill(-p.record.pgid, 'SIGTERM');
        } catch {}
  });
const require = createRequire(import.meta.url);
const tsx = require.resolve('tsx/cli');
const node = process.execPath;
let env;
async function run(args, log, overrides = {}, success = true) {
  assert.equal(interrupted, false, 'Runner interrupted');
  const task = launch(node, args, log, { ...env, ...overrides });
  const result = await bounded(task);
  assert.equal(result.signal, null, `Unexpected signal: ${log}`);
  assert.equal(result.code === 0, success, `Unexpected exit ${result.code}: ${log}`);
  return readFileSync(join(output, log), 'utf8');
}
function jsonLog(log) {
  const match = /=== JSON ===\s*([\s\S]*?)\s*Done\./.exec(log);
  assert.ok(match, 'Structured stdout JSON required');
  return JSON.parse(match[1]);
}
async function audit(label) {
  const sessions = (
    await observer.query(
      'SELECT pid, state, application_name FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()',
    )
  ).rows;
  assert.deepEqual(sessions, [], `${label}: no leaked worker sessions`);
  const scratch = (await observer.query('SELECT count(*)::int AS n FROM bench_writes')).rows[0].n;
  assert.equal(scratch, 0, `${label}: scratch cleanup`);
  const sequence = (await observer.query('SELECT last_value::text, is_called FROM bench_writes_id_seq')).rows[0];
  assert.deepEqual(sequence, { last_value: '1', is_called: false }, `${label}: sequence cleanup`);
}
try {
  assert.equal(process.version, 'v24.10.0', 'Pinned Node24.10 setup and correctness smoke');
  assert.equal(
    execFileSync(join(prefix, 'bin/postgres'), ['--version'], { encoding: 'utf8' }).trim(),
    'postgres (PostgreSQL) 18.6',
  );
  report.server = {
    version: '18.6',
    postgresSha256: hash(join(prefix, 'bin/postgres')),
    initdbSha256: hash(join(prefix, 'bin/initdb')),
  };
  temporary = mkdtempSync(join(tmpdir(), 'extended-native-'));
  report.serviceRoot = temporary;
  report.data = join(temporary, 'data');
  report.socket = join(temporary, 'socket');
  mkdirSync(report.socket);
  const probe = createServer();
  await new Promise((r) => probe.listen(0, '127.0.0.1', r));
  report.port = probe.address().port;
  await new Promise((r) => probe.close(r));
  const init = launch(
    join(prefix, 'bin/initdb'),
    [
      '-D',
      report.data,
      '-U',
      'extended_owner',
      '-A',
      'trust',
      '--no-locale',
      '--encoding=UTF8',
      '--no-instructions',
      '-L',
      join(prefix, 'share/postgresql'),
    ],
    'initdb.log',
  );
  assert.equal((await bounded(init, 20000)).code, 0, 'Native initdb');
  service = launch(
    join(prefix, 'bin/postgres'),
    [
      '-D',
      report.data,
      '-h',
      '127.0.0.1',
      '-p',
      String(report.port),
      '-k',
      report.socket,
      '-c',
      'timezone=UTC',
      '-c',
      'max_connections=80',
      '-c',
      'shared_buffers=32MB',
      '-c',
      'fsync=on',
      '-c',
      'synchronous_commit=on',
      '-c',
      'full_page_writes=on',
      '-c',
      `dynamic_library_path=${join(prefix, 'lib/postgresql')}`,
    ],
    'postgres.log',
  );
  const url = `postgresql://extended_owner@127.0.0.1:${report.port}/postgres?application_name=extended-${randomBytes(4).toString('hex')}`;
  report.database = 'postgres';
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    assert.equal(service.record.exit, null, 'Postmaster must stay alive');
    const c = new pg.Client({ connectionString: url, connectionTimeoutMillis: 300 });
    c.on('error', () => {});
    try {
      await c.connect();
      observer = c;
      break;
    } catch {
      await c.end();
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  assert.ok(observer, 'Private PG readiness');
  report.server.facts = (
    await observer.query(
      "SELECT version(), current_setting('server_version') AS version_number, current_setting('data_directory') AS data, current_setting('TimeZone') AS timezone",
    )
  ).rows[0];
  assert.equal(report.server.facts.version_number, '18.6');
  assert.equal(report.server.facts.data, report.data);
  report.server.settings = Object.fromEntries(
    (
      await observer.query('SELECT name, setting FROM pg_settings WHERE name = ANY($1::text[])', [
        [
          'max_connections',
          'shared_buffers',
          'fsync',
          'synchronous_commit',
          'full_page_writes',
          'default_transaction_isolation',
          'TimeZone',
        ],
      ])
    ).rows.map((r) => [r.name, r.setting]),
  );
  assert.equal(report.server.settings.max_connections, '80');
  env = {
    ...process.env,
    DATABASE_URL: url,
    EXTENDED_VERIFY_ONLY: '1',
    EXTENDED_QUICK: '1',
    ROUNDS: '1',
    WARMUP: '0',
    COLD_ROUNDS: '1',
  };
  delete env.GROUPS;
  await run([tsx, 'benchmarks/seed-neon.ts'], 'seed.log');
  await run(['dist/cli/index.js', 'generate', '--out', 'generated/turbine'], 'generate.log');
  const positive = jsonLog(await run([tsx, 'benchmarks/bench-extended.ts'], 'preflight.log'));
  assert.equal(positive.status, 'passed');
  assert.equal(positive.preflight.scenarios, 17);
  assert.equal(positive.results.length, 0);
  assert.equal(positive.cleanup.status, 'passed');
  report.preflight = positive.preflight;
  report.catalog = positive.catalog;
  report.versions = positive.versions;
  report.profile = positive.profile;
  await audit('positive preflight');
  const quick = jsonLog(
    await run([tsx, 'benchmarks/bench-extended.ts'], 'bounded-smoke.log', { EXTENDED_VERIFY_ONLY: '0', WARMUP: '1' }),
  );
  assert.equal(quick.status, 'passed');
  assert.equal(quick.results.length, 17);
  assert.equal(quick.cleanup.status, 'passed');
  const { assertExtendedRuns } = await tsImport('./extended-results.ts', import.meta.url);
  assertExtendedRuns([quick, structuredClone(quick)], { allowSmoke: true });
  assert.throws(() => assertExtendedRuns([quick]), /smoke logs/);
  assert.ok(
    quick.results.every((s) => s.stats.every((a) => a.n === 1)),
    'Exactly one bounded measured sample per original arm',
  );
  report.boundedSmoke = {
    scenarios: quick.results.length,
    samples: quick.results.reduce((n, s) => n + s.stats.length, 0),
    interpretation: 'Plumbing/correctness only. Concurrent host activity; no speed result.',
  };
  await audit('bounded smoke');
  const source = readFileSync(join(root, 'benchmarks/bench-extended.ts'), 'utf8');
  const marker = 'report.preflight = await verifyExtended(scenarios, groups, suite.oracle);';
  assert.equal(source.split(marker).length, 2, 'Unique preflight mutation seam');
  const controls = [
    ['prepared-policy', 'cold', 'REPLACE_PREPARED_POLICY', 'send its preparedName'],
    [
      'missing-rc',
      'large',
      "scenarios[0].arms = scenarios[0].arms.filter(a => a.name !== 'Drizzle RC');",
      'Incomplete extended arm coverage',
    ],
    ['missing-scenario', 'list', 'scenarios.pop();', 'every selected catalog row'],
    [
      'flat-value',
      'large',
      "const a=scenarios[0].arms.find(a=>a.name==='Raw'); const f=a.fn; a.fn=async(i)=>{ const v=await f(i); v.rows[0].body='corrupt'; return v; };",
      'comments-5000 / Raw',
    ],
    [
      'tie-order',
      'list',
      "const a=scenarios[0].arms.find(a=>a.name==='Raw'); const f=a.fn; a.fn=async(i)=>{ const v=await f(i); v.rows.reverse(); return v; };",
      'list-page3 / Raw',
    ],
    [
      'nested-value',
      'relations',
      "const a=scenarios.find(s=>s.id==='many-to-many').arms.find(a=>a.name==='Raw'); const f=a.fn; a.fn=async(i)=>{ const v=await f(i); delete v[0].tags[0].name; return v; };",
      'many-to-many / Raw',
    ],
    [
      'count-value',
      'relations',
      "const a=scenarios.find(s=>s.id==='relation-count').arms.find(a=>a.name==='Raw'); const f=a.fn; a.fn=async(i)=>{ const v=await f(i); v[0]._count.posts='11'; return v; };",
      'relation-count / Raw',
    ],
    [
      'aggregate-value',
      'agg',
      "const a=scenarios[0].arms.find(a=>a.name==='Raw'); const f=a.fn; a.fn=async(i)=>{ const v=await f(i); v[0].avgViews='1/1'; return v; };",
      'group-by / Raw',
    ],
    [
      'bulk-no-write',
      'writes',
      "const a=scenarios[0].arms.find(a=>a.name==='Raw'); a.fn=async()=>bulkRows.map((r,i)=>({id:String(i+1),...r}));",
      'actual write effect',
    ],
    [
      'update-no-write',
      'writes',
      "const a=scenarios.find(s=>s.id==='update').arms.find(a=>a.name==='Raw'); a.fn=async(i)=>({... (await suite.oracle.query(scratchQuery)).rows[0],amount:i});",
      'actual write effect',
    ],
    [
      'upsert-extra-write',
      'writes',
      "const a=scenarios.find(s=>s.id==='upsert').arms.find(a=>a.name==='Raw'); const f=a.fn; a.fn=async(i)=>{await suite.oracle.query(\"UPDATE bench_writes SET amount=88 WHERE slug='sentinel-a'\");return f(i);};",
      'actual write effect',
    ],
    [
      'delete-no-write',
      'writes',
      "const a=scenarios.find(s=>s.id==='delete').arms.find(a=>a.name==='Raw'); a.fn=async()=> (await suite.oracle.query(scratchQuery)).rows[0];",
      'actual write effect',
    ],
    [
      'strategy-value',
      'strategy',
      "const a=scenarios[0].arms.find(a=>a.name==='Turbine batched'); const f=a.fn; a.fn=async(i)=>{const v=await f(i);v[0].posts.reverse();return v;};",
      'strategy-many / Turbine batched',
    ],
    [
      'cold-value',
      'cold',
      "const a=scenarios[0].arms.find(a=>a.name==='Raw'); const f=a.fn; a.fn=async(i)=>{const v=await f(i);v.rows[0].name='corrupt';return v;};",
      'cold-user / Raw',
    ],
    [
      'restoration',
      'writes',
      "const f=suite.oracle.query; suite.oracle.query=async(text,values)=>{if(text.startsWith('SELECT setval'))throw new Error('injected restoration refusal');return f(text,values);};",
      'injected restoration refusal',
    ],
  ];
  for (const [name, group, mutation, diagnostic] of controls) {
    const file = join(root, 'benchmarks', `extended-fault-${name}-${process.pid}.ts`);
    try {
      const faultySource =
        mutation === 'REPLACE_PREPARED_POLICY'
          ? source.replace('preparedStatements: true', 'preparedStatements: false')
          : source.replace(marker, `${mutation}\n${marker}`);
      assert.notEqual(faultySource, source, 'Disposable source must actually change');
      writeFileSync(file, faultySource);
      const log = await run([tsx, file], `fault-${name}.log`, { GROUPS: group, EXTENDED_VERIFY_ONLY: '0' }, false);
      const failed = jsonLog(log);
      assert.equal(failed.status, 'failed');
      assert.deepEqual(failed.results, []);
      assert.equal(Object.hasOwn(failed, 'driftHead'), false);
      assert.equal(log.includes('[drift probe'), false, 'Fault must fail before timing');
      assert.ok(failed.errors.join('; ').includes(diagnostic), `${name}: useful expected failure`);
      // Restoration fault intentionally prevents setval; record its refusal and recover only in the private service.
      if (name === 'restoration') await observer.query("SELECT setval('bench_writes_id_seq',1,false)");
      await audit(name);
      report.controls.push({
        name,
        group,
        diagnostic,
        rejectedBeforeTiming: true,
        disposableCopySha256: hash(file),
        recoveredSequence: name === 'restoration',
      });
      save();
    } finally {
      rmSync(file, { force: true });
    }
  }
  report.inputs = Object.fromEntries(
    [
      'benchmarks/bench-extended.ts',
      'benchmarks/extended-equivalence.ts',
      'benchmarks/extended-support.ts',
      'benchmarks/extended-results.ts',
      'benchmarks/extended-native-smoke.mjs',
      'benchmarks/bench-harness.ts',
      'benchmarks/equivalence.ts',
      'benchmarks/schema.ts',
      'benchmarks/schema-rc.ts',
      'benchmarks/seed-neon.ts',
      'benchmarks/package-lock.json',
      'package-lock.json',
      'generated/turbine/index.ts',
      'generated/turbine/metadata.ts',
      'generated/turbine/types.ts',
      'dist/client.js',
    ].map((f) => [f, hash(join(root, f))]),
  );
  report.status = 'passed';
} catch (e) {
  report.status = 'failed';
  report.errors.push(e.stack ?? String(e));
} finally {
  for (const p of [...owned].reverse())
    if (p !== service)
      try {
        await stop(p);
      } catch (e) {
        report.cleanupErrors.push(e.message);
      }
  try {
    if (observer) await observer.end();
  } catch (e) {
    report.cleanupErrors.push(e.message);
  }
  try {
    await stop(service);
  } catch (e) {
    report.cleanupErrors.push(e.message);
  }
  if (temporary) rmSync(temporary, { recursive: true, force: true });
  report.cleanup.serviceRootAbsent = temporary ? !existsSync(temporary) : true;
  report.cleanup.processesAbsent = owned.every((p) => {
    try {
      process.kill(p.record.pid, 0);
      return false;
    } catch {
      return true;
    }
  });
  report.cleanup.groupsAbsent = owned.every((p) => {
    try {
      process.kill(-p.record.pgid, 0);
      return false;
    } catch {
      return true;
    }
  });
  if (report.port) {
    const socket = await import('node:net');
    report.cleanup.portClosed = await new Promise((r) => {
      const s = socket.connect({ host: '127.0.0.1', port: report.port });
      s.once('connect', () => {
        s.destroy();
        r(false);
      });
      s.once('error', () => r(true));
    });
  }
  if (report.cleanupErrors.length || Object.values(report.cleanup).some((v) => v !== true)) report.status = 'failed';
  save();
}
console.log(
  JSON.stringify({
    status: report.status,
    report: join(output, 'native.json'),
    controls: report.controls.length,
    cleanup: report.cleanup,
  }),
);
if (report.status !== 'passed') process.exitCode = 1;
