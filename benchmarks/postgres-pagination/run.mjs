import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, renameSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import pg from 'pg';
import { ownedPostgres } from '../../tooling/native-consumer-contracts/postgres-service.mjs';
import { ARMS, CASES, METHODS, MODES, cursor, digest, expected } from './corpus.mjs';
import { execute, open, planFacts, setup, templates, verifyTrace } from './workload.mjs';
import { comparisons, paginationComparisons, validate } from './validate.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const hash = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
const files = (dir) => readdirSync(join(root, dir), { withFileTypes: true }).flatMap((e) => e.isDirectory() ? files(`${dir}/${e.name}`) : [`${dir}/${e.name}`]);
const treeHash = (names) => digest(names.sort().map((name) => [name, hash(join(root, name))]));
const git = (...args) => spawnSync('git', args, { cwd: root, encoding: 'utf8' }).stdout.trim();
const { values } = parseArgs({ options: { out: { type: 'string' }, rounds: { type: 'string', default: '4' }, iterations: { type: 'string', default: '3' }, fault: { type: 'string' } } });
assert.ok(values.out, '--out required; report must be outside the disposable service directory');
const out = resolve(values.out);
mkdirSync(dirname(out), { recursive: true });
const report = { format: 'postgres-pagination-v1', startedAt: new Date().toISOString(), status: 'running',
  config: { rounds: Number(values.rounds), iterations: Number(values.iterations), fault: values.fault ?? null,
    coldMeaning: 'fresh ORM instance and fresh pg connection per sample; shared/OS caches are NOT cold',
    warmMeaning: 'six identical warmup workloads on the same connection before each sample',
    timedBoundary: 'construction and connection for cold; every workload includes SELECT 1 noise, cursor lookup for locate, page read, complete row oracle and digest; close and EXPLAIN outside timing',
    rawMeaning: 'pinned pg driver, precompiled identical Turbine SQL/parameters/prepared names; no ORM result transform',
    preparedStatements: true,
    memoryMeaning: 'process RSS before/after and cumulative process maxRSS, not per-arm isolated peaks; backend RSS at sample end; backend CPU in host CLK_TCK ticks (cold includes startup)',
    planMeaning: 'post-measurement unnamed EXPLAIN ANALYZE JSON with same binds; not proof of the named prepared generic/custom plan used by a sample',
    scope: 'single process, serial loopback, small int4/text fixture, join relation path only; no global speed or disk-cold claim' },
  services: [], samples: [], plans: [], comparisons: [], paginationComparisons: [], failures: [], cleanup: { errors: [] } };
const write = () => { writeFileSync(`${out}.tmp`, `${JSON.stringify(report, null, 2)}\n`); renameSync(`${out}.tmp`, out); };
write();
const contexts = new Set();
const observedPids = new Set();
let serviceRoot;
let stop;
let service;
let signal;
const checkpoint = () => { if (signal) throw new Error(`Received ${signal}`); };
const onSignal = (s) => { signal ??= s; report.signal = signal; write(); };
const term = () => onSignal('SIGTERM');
const intr = () => onSignal('SIGINT');
process.on('SIGTERM', term);
process.on('SIGINT', intr);
const processPresent = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { if (e.code === 'ESRCH') return false; throw e; } };
async function portOpen(port) {
  return new Promise((resolve) => { const s = net.connect({ host: '127.0.0.1', port });
    s.once('connect', () => { s.destroy(); resolve(true); }); s.once('error', () => resolve(false));
    s.setTimeout(1000, () => { s.destroy(); resolve(true); }); });
}
function resource(pid) {
  const stat = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ');
  const rss = /^VmRSS:\s+(\d+)/m.exec(readFileSync(`/proc/${pid}/status`, 'utf8'));
  return { pid, cpuTicks: Number(stat[11]) + Number(stat[12]), rssKiB: Number(rss[1]) };
}
try {
  assert.ok(['v22.16.0', 'v24.10.0'].includes(process.version), 'Exact Node22.16.0 or Node24.10.0 required');
  const { rounds, iterations } = report.config;
  assert.ok(Number.isInteger(rounds) && rounds >= 4 && rounds <= 40 && rounds % 2 === 0, 'Even rounds in [4,40] required for order balance');
  assert.ok(Number.isInteger(iterations) && iterations >= 1 && iterations <= 100);
  assert.ok(!values.fault || ['ordering', 'materialization', 'oracle', 'service', 'signal', 'preparation'].includes(values.fault), 'Unknown fault');
  assert.ok(process.env.PG_PREFIX && existsSync(join(process.env.PG_PREFIX, 'bin/postgres')), 'Required owned native PG18.6 service: PG_PREFIX/bin/postgres missing');
  const prefix = resolve(process.env.PG_PREFIX);
  const sourceFiles = files('src').filter((f) => !f.startsWith('src/test/'));
  const harnessFiles = [...files('benchmarks/postgres-pagination'), 'tooling/native-consumer-contracts/postgres-service.mjs'];
  report.identity = {
    runtime: { node: process.version, executable: process.execPath, sha256: hash(process.execPath), versions: process.versions },
    command: [process.execPath, ...process.execArgv, ...process.argv.slice(1)],
    sourceHead: git('rev-parse', 'HEAD'), branch: git('branch', '--show-current'), worktree: root, status: git('status', '--short'),
    lockSha256: hash(join(root, 'package-lock.json')), sourceSha256: treeHash(sourceFiles), harnessSha256: treeHash(harnessFiles),
    files: Object.fromEntries([...sourceFiles, ...harnessFiles].map((name) => [name, hash(join(root, name))])),
    driver: { version: JSON.parse(readFileSync(join(root, 'node_modules/pg/package.json'))).version,
      sha256: treeHash(files('node_modules/pg')) },
    tsx: JSON.parse(readFileSync(join(root, 'node_modules/tsx/package.json'))).version,
    serverBinarySha256: hash(join(prefix, 'bin/postgres')), initdbSha256: hash(join(prefix, 'bin/initdb')),
    host: { release: os.release(), cpu: os.cpus()[0]?.model, cpuCount: os.cpus().length, totalMemory: os.totalmem(), loadavg: os.loadavg(),
      clockTicksPerSecond: Number(spawnSync('getconf', ['CLK_TCK'], { encoding: 'utf8' }).stdout.trim()) },
  };
  report.identity.driverDependencies = Object.fromEntries(readdirSync(join(root, 'node_modules')).filter((name) => /^(pg(?:-|$)|pgpass$|postgres-|split2$)/.test(name)).map((name) => [name, {
    version: JSON.parse(readFileSync(join(root, 'node_modules', name, 'package.json'))).version,
    sha256: treeHash(files(`node_modules/${name}`)),
  }]));
  serviceRoot = mkdtempSync(join(os.tmpdir(), 'ppg-'));
  report.serviceRoot = serviceRoot;
  const run = (cwd, command, args) => {
    const result = spawnSync(command, args, { cwd, env: { ...process.env, PG_PREFIX: prefix }, encoding: 'utf8', timeout: 30000 });
    report.setupCommands ??= []; report.setupCommands.push({ command, args, status: result.status, stdout: result.stdout, stderr: result.stderr, error: result.error?.message });
    assert.equal(result.status, 0, `Owned service command failed: ${result.stderr || result.error?.message}`);
  };
  checkpoint();
  service = await ownedPostgres({ root: serviceRoot, env: { ...process.env, PG_PREFIX: prefix }, run, driver: pg, report, registerStop: (fn) => { stop = fn; } });
  observedPids.add(service.client.processID);
  report.server = { ...report.services[0] };
  if (values.fault === 'service') { await stop(); await service.client.query('SELECT 1'); throw new Error('Broken-service control did not fail'); }
  report.setup = await setup(service.client);
  for (const setting of ['fsync', 'synchronous_commit', 'full_page_writes']) assert.equal(report.setup.settings.find((s) => s.name === setting).setting, 'on');
  report.corpus = CASES.map((c) => ({ ...c, cursor: cursor(c), expected: expected(c), expectedSha256: digest(expected(c)),
    statements: Object.fromEntries(METHODS.map((method) => [method, templates(c, method)])) }));
  if (values.fault === 'signal') { process.kill(process.pid, 'SIGTERM'); await new Promise(setImmediate); }
  const url = service.url;
  for (const c of CASES) for (const method of METHODS) for (const mode of MODES) for (let round = 0; round < rounds; round++) {
    const order = round % 2 === 0 ? ARMS : [...ARMS].reverse();
    for (const [position, arm] of order.entries()) {
      checkpoint();
      let context;
      let warmupTrace = [];
      if (mode === 'warm') {
        context = open(url, contexts, values.fault, arm);
        for (let i = 0; i < 6; i++) await execute(context, arm, c, method);
        warmupTrace = context.trace.splice(0);
        verifyTrace(warmupTrace, c, method, 6);
      }
      const connectionCount = context?.connections.length ?? 0;
      const beforeResources = context ? context.connections.map(resource) : [];
      const cpu = process.cpuUsage();
      const rssBefore = process.memoryUsage().rss;
      const start = performance.now();
      context ??= open(url, contexts, values.fault, arm);
      let resultSha256;
      for (let i = 0; i < iterations; i++) { checkpoint(); resultSha256 = await execute(context, arm, c, method); }
      const elapsedMs = performance.now() - start;
      const cpuUsed = process.cpuUsage(cpu);
      const rssAfter = process.memoryUsage().rss;
      const backendResources = context.connections.map((pid) => { const current = resource(pid); return { ...current,
        cpuTicks: current.cpuTicks - (beforeResources.find((r) => r.pid === pid)?.cpuTicks ?? 0) }; });
      verifyTrace(context.trace, c, method, iterations);
      const sample = { case: c.id, method, mode, arm, round, position, iterations, warmupIterations: mode === 'warm' ? 6 : 0,
        elapsedMs, cpu: cpuUsed, rssBefore, rssAfter, maxRssKiB: process.resourceUsage().maxRSS, backendResources,
        resultSha256, connections: [...context.connections], newConnections: context.connections.length - connectionCount,
        trace: context.trace, warmupTrace };
      // Diagnostic reads occur after measured time and never enter the production hot path.
      sample.prepared = (await context.native.query('SELECT name,statement,parameter_types,generic_plans,custom_plans FROM pg_prepared_statements ORDER BY name')).rows;
      report.samples.push(sample);
      for (const pid of context.connections) observedPids.add(pid);
      await context.close();
    }
    write();
  }
  for (const c of CASES) for (const method of METHODS) {
    checkpoint();
    const queries = [];
    for (const statement of templates(c, method)) {
      const { rows } = await service.client.query(`EXPLAIN (ANALYZE, BUFFERS, VERBOSE, FORMAT JSON) ${statement.sql}`, statement.params);
      const document = rows[0]['QUERY PLAN'];
      queries.push({ statement, document, facts: planFacts(document) });
    }
    report.plans.push({ case: c.id, method, queries });
  }
  report.comparisons = comparisons(report.samples);
  report.paginationComparisons = paginationComparisons(report.samples);
  report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.failures.push({ message: error.message, stack: error.stack });
  report.failedContexts = [...contexts].map((c) => ({ connections: c.connections, trace: c.trace }));
} finally {
  for (const context of contexts) {
    for (const pid of context.connections) observedPids.add(pid);
    try { await context.close(); } catch (e) { report.cleanup.errors.push(e.message); }
  }
  if (service && !report.services[0]?.stopped) {
    try {
      const rows = (await service.client.query("SELECT pid FROM pg_stat_activity WHERE application_name='pagination-owned'")).rows;
      report.cleanup.applicationsAbsent = rows.length === 0;
      report.cleanup.remainingApplications = rows;
    } catch (e) { report.cleanup.errors.push(e.message); }
  }
  if (stop) { try { await stop(); } catch (e) { report.cleanup.errors.push(e.message); } }
  const owned = report.services[0];
  if (owned?.log) {
    try { writeFileSync(`${out}.server.log`, owned.log); report.serverLogSha256 = hash(`${out}.server.log`); delete owned.log; }
    catch (e) { report.cleanup.errors.push(e.message); }
  }
  const audit = async (name, fn) => {
    try { report.cleanup[name] = await fn(); }
    catch (e) { report.cleanup[name] = false; report.cleanup.errors.push(`${name}: ${e.message}`); }
  };
  if (owned?.pid) observedPids.add(owned.pid);
  report.cleanup.ownedPids = [...observedPids];
  await audit('processesAbsent', () => report.cleanup.ownedPids.every((pid) => !processPresent(pid)));
  if (serviceRoot) {
    try {
      assert.ok(!owned || !processPresent(owned.pid), 'Refusing to remove a live server datadir');
      rmSync(serviceRoot, { recursive: true, force: true });
    } catch (e) { report.cleanup.errors.push(e.message); }
  }
  await audit('rootAbsent', () => !serviceRoot || !existsSync(serviceRoot));
  await audit('datadirAbsent', () => !owned || !existsSync(owned.datadir));
  await audit('socketAbsent', () => !owned || !existsSync(owned.socket));
  await audit('portClosed', async () => !owned || !(await portOpen(owned.port)));
  report.cleanup.applicationsAbsent ||= report.cleanup.processesAbsent && report.cleanup.portClosed;
  if (signal) { report.signal = signal; report.status = 'failed'; }
  if (report.status === 'passed') {
    try { validate(report); } catch (e) { report.status = 'failed'; report.failures.push({ message: e.message, stack: e.stack }); }
  }
  report.finishedAt = new Date().toISOString();
  write();
  process.removeListener('SIGTERM', term); process.removeListener('SIGINT', intr);
  process.exitCode = signal === 'SIGTERM' ? 143 : signal === 'SIGINT' ? 130 : report.status === 'passed' ? 0 : 1;
  process.stdout.write(`${report.status}: ${out}; ${report.samples.length} samples; ${report.failures.map((f) => f.message).join('; ')}\n`);
}
