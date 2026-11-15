import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { rootDriver } from './driver.mjs';
import { nativeExecutions } from './native-route.mjs';
import { ownedPostgres } from '../../tooling/native-consumer-contracts/postgres-service.mjs';
import { setup } from '../postgres-pagination/setup.mjs';
import { digest } from '../postgres-pagination/corpus.mjs';
import { compileTuple } from './candidate.mjs';
import { ARMS, CASES, METHODS, MODES, REFUSALS, execute, planFacts, statements } from './workload.mjs';
import { comparisons, validate, verifySample } from './validate.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { driver: pg, entry: driverEntry, version: driverVersion, lockedVersion } = rootDriver(root);
const hash = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
const files = (dir) => readdirSync(join(root, dir), { withFileTypes: true }).flatMap((e) => e.isDirectory() ? files(`${dir}/${e.name}`) : [`${dir}/${e.name}`]);
const git = (...args) => {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0); return result.stdout.trim();
};
const { values } = parseArgs({ options: { out: { type: 'string' }, rounds: { type: 'string', default: '4' }, iterations: { type: 'string', default: '3' }, fault: { type: 'string' } } });
assert.ok(values.out, '--out required');
const out = resolve(values.out);
assert.ok(out !== root && !out.startsWith(root + sep), 'Reports must remain outside the repository');
mkdirSync(dirname(out), { recursive: true });
const report = { format: 'postgres-keyset-v1', status: 'running', startedAt: new Date().toISOString(),
  config: { rounds: Number(values.rounds), iterations: Number(values.iterations), fault: values.fault ?? null,
    coldMeaning: 'Fresh pg connection per sample, NOT cold shared buffers or OS cache. Setup and all measurements share one owned cluster.',
    warmMeaning: 'Six complete workloads on the same connection before timing.',
    boundary: 'Cold includes connection establishment. Both arms include all page/lookup queries, full-value oracle and digest. Close and EXPLAIN outside timer. SQL compiled in both arms on every operation; unnamed extended protocol.',
    locateMeaning: 'Ordered OFFSET lookup of preceding row, charged in full; supplied cursor excludes discovery. Both arms receive the same predetermined cursor and lookup verifies it.',
    scope: 'Filtered non-null int4 domain only; consistent direction, unique ID suffix. No production builder change, artifact certification, disk-cold or global speed claim.',
    planMeaning: 'Post-measurement unnamed EXPLAIN ANALYZE BUFFERS VERBOSE with exact SQL and binds; matches unnamed protocol but is a separate execution.' },
  services: [], samples: [], plans: [], failures: [], cleanup: { errors: [] } };
const write = () => { writeFileSync(`${out}.tmp`, `${JSON.stringify(report, null, 2)}\n`); renameSync(`${out}.tmp`, out); };
write();
const pids = new Set();
const contexts = new Set();
let serviceRoot;
let stop;
let service;
let signal;
const onTerm = () => { signal = 'SIGTERM'; };
const onInt = () => { signal = 'SIGINT'; };
process.on('SIGTERM', onTerm); process.on('SIGINT', onInt);
const checkpoint = () => { if (signal) throw new Error(`Received ${signal}`); };
const present = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { if (e.code === 'ESRCH') return false; throw e; } };
const portOpen = (port) => new Promise((resolve) => {
  const socket = net.connect({ host: '127.0.0.1', port });
  socket.once('connect', () => { socket.destroy(); resolve(true); });
  socket.once('error', () => resolve(false)); socket.setTimeout(1000, () => { socket.destroy(); resolve(true); });
});
try {
  assert.ok(['v22.16.0', 'v24.10.0'].includes(process.version), 'Exact Node22.16.0 or Node24.10.0 required');
  assert.ok(Number.isInteger(report.config.rounds) && report.config.rounds >= 4 && report.config.rounds <= 40 && report.config.rounds % 2 === 0);
  assert.ok(Number.isInteger(report.config.iterations) && report.config.iterations >= 1 && report.config.iterations <= 100);
  assert.ok(!values.fault || ['missing-predicate', 'missing-tiebreaker', 'exclude-lookup', 'service', 'signal', 'named-execution'].includes(values.fault));
  assert.ok(process.env.PG_PREFIX && existsSync(join(process.env.PG_PREFIX, 'bin/postgres')), 'Required owned native PG18.6 service missing');
  const prefix = resolve(process.env.PG_PREFIX);
  const sourceFiles = files('src').filter((f) => !f.startsWith('src/test/'));
  const harnessFiles = [...files('benchmarks/postgres-keyset'), ...files('benchmarks/postgres-pagination'), 'tooling/native-consumer-contracts/postgres-service.mjs'];
  const identities = (names) => Object.fromEntries(names.sort().map((name) => [name, hash(join(root, name))]));
  report.identity = { sourceHead: git('rev-parse', 'HEAD'), branch: git('branch', '--show-current'), worktree: root, status: git('status', '--short'),
    command: [process.execPath, ...process.execArgv, ...process.argv.slice(1)], runtime: { node: process.version, executable: process.execPath, sha256: hash(process.execPath), versions: process.versions },
    sourceFiles: identities(sourceFiles), harnessFiles: identities(harnessFiles), lockSha256: hash(join(root, 'package-lock.json')),
    driver: { version: driverVersion, lockedVersion, resolvedEntry: driverEntry, resolvedSha256: hash(driverEntry), files: identities(files('node_modules/pg')) },
    driverDependencies: Object.fromEntries(readdirSync(join(root, 'node_modules')).filter((name) => /^(pg(?:-|$)|pgpass$|postgres-|split2$)/.test(name)).map((name) => [name, {
      version: JSON.parse(readFileSync(join(root, 'node_modules', name, 'package.json'))).version, files: identities(files(`node_modules/${name}`)),
    }])),
    tsx: { version: JSON.parse(readFileSync(join(root, 'node_modules/tsx/package.json'))).version, files: identities(files('node_modules/tsx')) },
    serverBinarySha256: hash(join(prefix, 'bin/postgres')), initdbSha256: hash(join(prefix, 'bin/initdb')),
    artifact: null, artifactMeaning: 'Source benchmark; no packaged runtime artifact tested',
    host: { release: os.release(), cpu: os.cpus()[0]?.model, cpuCount: os.cpus().length, loadavg: os.loadavg() } };
  const lockedPackages = JSON.parse(readFileSync(join(root, 'package-lock.json'))).packages;
  for (const [name, dependency] of Object.entries({ ...report.identity.driverDependencies, tsx: report.identity.tsx })) {
    dependency.lockedVersion = lockedPackages[`node_modules/${name}`].version;
    assert.equal(dependency.version, dependency.lockedVersion, 'Installed dependency must match root lock');
  }
  report.identity.sourceSha256 = digest(report.identity.sourceFiles);
  report.identity.harnessSha256 = digest(report.identity.harnessFiles);
  report.refusals = REFUSALS.map((request) => ({ request, result: compileTuple(request) }));
  assert.ok(report.refusals.every((r) => r.result.supported === false));
  report.corpus = CASES.map((c) => ({ ...c, expectedSha256: digest(c.expected), statements: Object.fromEntries(ARMS.map((arm) => [arm, Object.fromEntries(METHODS.map((method) => [method, statements(c, arm, method)]))])) }));
  serviceRoot = mkdtempSync(join(os.tmpdir(), 'pg-keyset-'));
  report.serviceRoot = serviceRoot;
  const run = (cwd, command, args) => {
    const result = spawnSync(command, args, { cwd, env: { ...process.env, PG_PREFIX: prefix }, encoding: 'utf8', timeout: 30000 });
    (report.setupCommands ??= []).push({ command, args, status: result.status, stdout: result.stdout, stderr: result.stderr, error: result.error?.message });
    assert.equal(result.status, 0, `Owned service command failed: ${result.stderr || result.error?.message}`);
  };
  checkpoint();
  service = await ownedPostgres({ root: serviceRoot, env: { ...process.env, PG_PREFIX: prefix }, run, driver: pg, report, registerStop: (fn) => { stop = fn; } });
  pids.add(service.client.processID);
  if (values.fault === 'service') { await stop(); await service.client.query('SELECT 1'); throw new Error('Broken service control did not fail'); }
  report.setup = await setup(service.client);
  for (const name of ['fsync', 'synchronous_commit', 'full_page_writes']) assert.equal(report.setup.settings.find((s) => s.name === name).setting, 'on');
  if (values.fault === 'signal') { process.kill(process.pid, 'SIGTERM'); await new Promise(setImmediate); }
  for (const c of CASES) for (const method of METHODS) for (const mode of MODES) for (let round = 0; round < report.config.rounds; round++) {
    for (const [position, arm] of (round % 2 === 0 ? ARMS : [...ARMS].reverse()).entries()) {
      checkpoint();
      const client = new pg.Client({ connectionString: service.url, application_name: 'keyset-owned', connectionTimeoutMillis: 3000, query_timeout: 15000 });
      client.on('error', () => {}); contexts.add(client);
      const warmupTrace = [];
      if (mode === 'warm') {
        await client.connect(); pids.add(client.processID);
        for (let i = 0; i < 6; i++) warmupTrace.push(...await execute(client, c, arm, method));
      }
      let excluded;
      if (values.fault === 'exclude-lookup' && method === 'locate') {
        if (mode === 'connection-cold') { await client.connect(); pids.add(client.processID); }
        excluded = await execute(client, c, arm, method);
      }
      const start = performance.now();
      if (mode === 'connection-cold' && !excluded) { await client.connect(); pids.add(client.processID); }
      const trace = [];
      for (let i = 0; i < report.config.iterations; i++) { checkpoint(); trace.push(...(excluded ?? await execute(client, c, arm, method, values.fault))); }
      const end = performance.now();
      const sample = { case: c.id, arm, method, mode, round, position, iterations: report.config.iterations, backendPid: client.processID,
        start, end, elapsedMs: end - start, trace, warmupTrace, queryCount: trace.length, fetchedRows: trace.reduce((n, q) => n + q.rowCount, 0) };
      report.samples.push(sample);
      verifySample(sample, c);
      await client.end(); contexts.delete(client);
    }
    write();
  }
  for (const c of CASES) for (const method of METHODS) for (const arm of ARMS) {
    checkpoint();
    const queries = [];
    for (const statement of statements(c, arm, method)) {
      const { rows } = await service.client.query(`EXPLAIN (ANALYZE, BUFFERS, VERBOSE, FORMAT JSON) ${statement.sql}`, statement.params);
      const document = rows[0]['QUERY PLAN'];
      queries.push({ statement, document, facts: planFacts(document) });
    }
    report.plans.push({ case: c.id, arm, method, queries });
  }
  // Native structural guard for this fixed fixture: a tuple comparison must
  // appear as an index start condition, not just as a post-scan filter.
  const deep = report.plans.find((p) => p.case === 'deep' && p.arm === 'tuple' && p.method === 'provided');
  assert.ok(deep.queries[0].facts.nodes.some((n) => n.index && /ROW\(items\.score, items\.id\) > ROW/.test(n.indexCondition ?? '')), 'Deep tuple cursor must reach native index condition');
  report.comparisons = comparisons(report.samples);
  report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.failures.push({ message: error.message, stack: error.stack });
  if (error.trace) report.failureTrace = error.trace;
} finally {
  const audit = async (name, fn) => { try { report.cleanup[name] = await fn(); } catch (e) { report.cleanup[name] = false; report.cleanup.errors.push(`${name}: ${e.message}`); } };
  for (const client of contexts) {
    if (client.processID) pids.add(client.processID);
    try { await client.end(); } catch (e) { report.cleanup.errors.push(e.message); }
  }
  if (stop) { try { await stop(); } catch (e) { report.cleanup.errors.push(e.message); } }
  const owned = report.services[0];
  if (owned?.pid) pids.add(owned.pid);
  if (owned?.log) {
    try {
      writeFileSync(`${out}.server.log`, owned.log); report.serverLogSha256 = hash(`${out}.server.log`);
      if (report.status === 'passed') {
        try { report.nativeExecutions = nativeExecutions(owned.log, report.samples); }
        catch (error) { report.status = 'failed'; report.failures.push({ message: error.message, stack: error.stack }); }
      }
      delete owned.log;
    }
    catch (e) { report.cleanup.errors.push(e.message); }
  }
  report.cleanup.ownedPids = [...pids];
  await audit('processesAbsent', () => [...pids].every((pid) => !present(pid)));
  if (serviceRoot) {
    try { assert.ok(report.cleanup.processesAbsent, 'Refusing to remove live service state'); rmSync(serviceRoot, { recursive: true, force: true }); }
    catch (e) { report.cleanup.errors.push(e.message); }
  }
  await audit('portClosed', async () => !owned || !(await portOpen(owned.port)));
  await audit('datadirAbsent', () => !owned || !existsSync(owned.datadir));
  await audit('socketAbsent', () => !owned || !existsSync(owned.socket));
  await audit('rootAbsent', () => !serviceRoot || !existsSync(serviceRoot));
  if (signal) { report.status = 'failed'; report.signal = signal; }
  if (report.status === 'passed') {
    try { validate(report); } catch (error) { report.status = 'failed'; report.failures.push({ message: error.message, stack: error.stack }); }
  }
  report.finishedAt = new Date().toISOString(); write();
  process.removeListener('SIGTERM', onTerm); process.removeListener('SIGINT', onInt);
  process.exitCode = signal === 'SIGTERM' ? 143 : signal === 'SIGINT' ? 130 : report.status === 'passed' ? 0 : 1;
  process.stdout.write(`${report.status}: ${out}; ${report.samples.length} samples; ${report.failures.map((f) => f.message).join('; ')}\n`);
}
