import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fstatSync, mkdirSync, mkdtempSync, readFileSync, readSync, existsSync, rmSync, openSync, closeSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir, loadavg, cpus, release } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { root, rootDriver, sha, files } from './driver.mjs';
import { cases, FORMAT } from './model.mjs';
import { audit, owned, stop, within, save, alive } from './process.mjs';
import { validateSample, validateCampaign } from './validate.mjs';

const [destination, fault = 'none'] = process.argv.slice(2);
assert.ok(destination, 'New campaign directory required');
const output = resolve(destination);
mkdirSync(output); // Existing reports are never overwritten or silently re-labeled.
const reportPath = join(output, 'campaign.json');
const report = { format: FORMAT, status: 'running', signal: null, errors: [], cleanupErrors: [], processes: [], samples: [], observers: [],
  fault, runtime: { version: process.version, executable: process.execPath, sha256: sha(process.execPath), versions: process.versions },
  command: [process.execPath, ...process.execArgv, ...process.argv.slice(1)],
  noise: { before: { loadavg: loadavg(), at: new Date().toISOString() }, cpu: cpus()[0]?.model, cpuCount: cpus().length, os: release(),
    note: 'Serial worker samples only; other host activity is uncontrolled. No global memory bound or performance winner is inferred.' }, cleanup: {} };
const checkpoint = () => save(reportPath, report);
// Read the server log through the descriptor the service inherited, by
// explicit position, so the read never depends on its shared offset.
const readServerLog = () => {
  const size = fstatSync(logFd).size; const bytes = Buffer.alloc(size); let read = 0;
  while (read < size) { const n = readSync(logFd, bytes, read, size - read, read); if (!n) break; read += n; }
  return bytes.toString('utf8', 0, read);
};
checkpoint();
let service, worker, init, bundler, observer, identity, logFd;
const interrupt = name => {
  report.signal = name; report.status = 'failed'; checkpoint();
  if (worker?.record.pid && alive(worker.record.pid)) process.kill(worker.record.pid, name);
};
const term = () => interrupt('SIGTERM'), int = () => interrupt('SIGINT');
process.on('SIGTERM', term); process.on('SIGINT', int);
const requireActive = () => { assert.equal(report.signal, null, 'Campaign interrupted'); };
async function clean(name, fn) {
  try { await fn(); } catch (e) { report.status = 'failed'; report.cleanupErrors.push({ name, message: e.message }); checkpoint(); }
}
function register(p) { report.processes.push(p.record); checkpoint(); return p; }
try {
  assert.ok(['v22.16.0', 'v24.10.0'].includes(process.version), 'Exact native Node22.16.0/24.10.0 prerequisite');
  assert.ok(['none', 'fetch-all', 'materialize', 'omit-abort', 'primary', 'cleanup', 'finalize', 'double-failure', 'signal', 'service-finalize', 'service-signal'].includes(fault), 'Known campaign fault');
  const prefix = resolve(process.env.PG_STREAM_PREFIX ?? 'missing-native-prerequisite');
  assert.equal(execFileSync(join(prefix, 'bin/postgres'), ['--version'], { encoding: 'utf8', timeout: 2000 }).trim(), 'postgres (PostgreSQL) 18.6', 'Pinned PostgreSQL18.6 prerequisite');
  report.server = { version: '18.6', postgresSha256: sha(join(prefix, 'bin/postgres')), initdbSha256: sha(join(prefix, 'bin/initdb')) };
  const bundlePath = join(output, 'source.mjs');
  bundler = register(owned(process.execPath, [fileURLToPath(new URL('./bundle.mjs', import.meta.url)), bundlePath], { cwd: root }));
  let buildOutput = '';
  bundler.child.stdout.on('data', b => { buildOutput += b; }); bundler.child.stderr.on('data', b => { buildOutput += b; });
  await within(bundler.done, 20000, 'Source bundler deadline');
  bundler.record.output = buildOutput;
  await stop(bundler);
  assert.deepEqual(bundler.record.exit, { code: 0, signal: null }, `Source bundler prerequisite: ${buildOutput}`);
  report.provenance = JSON.parse(readFileSync(bundlePath + '.json'));
  report.harness = Object.fromEntries(files(join(root, 'benchmarks/postgres-streaming')).map(f => [f.slice(root.length + 1), sha(f)]));
  report.serviceRoot = mkdtempSync(join(tmpdir(), 'pg-streaming-'));
  report.data = join(report.serviceRoot, 'data'); report.socket = join(report.serviceRoot, 'socket'); mkdirSync(report.socket);
  const probe = createServer();
  await new Promise((resolveProbe, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', resolveProbe); });
  report.port = probe.address().port;
  await new Promise(resolveProbe => probe.close(resolveProbe));
  init = register(owned(join(prefix, 'bin/initdb'), ['-D', report.data, '-U', 'stream_owner', '-A', 'trust', '--no-locale', '--encoding=UTF8', '--no-instructions', '-L', join(prefix, 'share/postgresql')], { cwd: report.serviceRoot }));
  let initOutput = '';
  init.child.stdout.on('data', b => { initOutput += b; }); init.child.stderr.on('data', b => { initOutput += b; });
  await within(init.done, 20000, 'Owned initdb deadline'); report.initOutput = initOutput;
  assert.deepEqual(init.record.exit, { code: 0, signal: null }, 'Native initdb must succeed'); requireActive();
  const logPath = join(output, 'server.log');
  logFd = openSync(logPath, 'wx');
  const args = ['-D', report.data, '-h', '127.0.0.1', '-p', String(report.port), '-k', report.socket,
    '-c', 'timezone=UTC', '-c', 'shared_buffers=32MB', '-c', 'max_connections=12', '-c', 'fsync=on', '-c', 'synchronous_commit=on', '-c', 'full_page_writes=on',
    '-c', `dynamic_library_path=${join(prefix, 'lib/postgresql')}`, '-c', 'log_statement=all', '-c', 'log_line_prefix=%m [%p] ', '-c', 'log_connections=on', '-c', 'log_disconnections=on'];
  service = register(owned(join(prefix, 'bin/postgres'), args, { cwd: report.serviceRoot, stdio: ['ignore', logFd, logFd] }));
  const { pg } = rootDriver();
  for (let attempt = 0; attempt < 100; attempt++) {
    requireActive(); assert.equal(service.record.exit, null, 'Owned postmaster must stay alive');
    const candidate = new pg.Client({ host: report.socket, port: report.port, user: 'stream_owner', database: 'postgres', connectionTimeoutMillis: 300, query_timeout: 5000 });
    candidate.on('error', () => {});
    try { await candidate.connect(); observer = candidate; break; } catch { await candidate.end(); await delay(50); }
  }
  assert.ok(observer, 'Owned PostgreSQL18.6 service readiness prerequisite');
  report.observerPid = observer.processID;
  const facts = (await observer.query("SELECT version(), current_setting('server_version') AS version_number, current_setting('data_directory') AS data, current_setting('TimeZone') AS timezone")).rows[0];
  assert.equal(facts.version_number, '18.6'); assert.equal(facts.data, report.data); assert.equal(facts.timezone, 'UTC');
  report.server.facts = facts;
  report.server.settings = Object.fromEntries((await observer.query("SELECT name, setting FROM pg_settings WHERE name = ANY($1::text[])",
    [['fsync', 'synchronous_commit', 'full_page_writes', 'shared_buffers', 'max_connections', 'default_transaction_isolation', 'default_transaction_read_only', 'statement_timeout', 'idle_in_transaction_session_timeout']])).rows.map(r => [r.name, r.setting]));
  identity = { status: 'ready', uid: process.getuid(), pid: service.record.pid, port: report.port, bundle: bundlePath,
    bundleSha256: sha(bundlePath), serverLog: logPath };
  const identityPath = join(output, 'service.json'); save(identityPath, identity);
  const campaign = fault === 'none' ? cases() : [cases().find(c => c.key === (fault === 'signal' || fault === 'omit-abort' ? 'abort-batches' : 'small-batches'))];
  report.completeMatrix = fault === 'none';
  const nonce = randomBytes(6).toString('hex');
  for (const [index, config] of campaign.entries()) {
    requireActive();
    const c = { ...config, database: `pg_stream_${nonce}_${index}` };
    const samplePath = join(output, c.key + '.json');
    const workerFault = fault.startsWith('service-') ? 'none' : fault;
    worker = register(owned(process.execPath, [fileURLToPath(new URL('./worker.mjs', import.meta.url)), samplePath, identityPath, JSON.stringify(c), workerFault], { cwd: root }));
    let workerOutput = '';
    worker.child.stdout.on('data', b => {
      workerOutput += b;
      if (fault === 'signal' && workerOutput.includes('signal-ready') && !worker.record.signalSent) {
        worker.record.signalSent = 'SIGTERM'; process.kill(worker.record.pid, 'SIGTERM'); checkpoint();
      }
    });
    worker.child.stderr.on('data', b => { workerOutput += b; });
    try { await within(worker.done, 30000, 'Native worker deadline'); }
    finally { await stop(worker); }
    worker.record.output = workerOutput; checkpoint();
    assert.ok(existsSync(samplePath), 'Worker must retain a report');
    const sample = JSON.parse(readFileSync(samplePath)); report.samples.push(sample);
    assert.ok(sample.sessionIds.length >= 4, 'Nonempty native session registry required');
    const sessions = (await observer.query('SELECT pid, state, datname FROM pg_stat_activity WHERE datname=$1 OR pid=ANY($2::integer[])', [c.database, sample.sessionIds])).rows;
    const databases = (await observer.query('SELECT datname FROM pg_database WHERE datname=$1', [c.database])).rows.length;
    report.observers.push({ database: c.database, sessions, databases, workerExit: worker.record.exit }); checkpoint();
    // Record the independent failure before cleanup; a forced drop cannot turn
    // a leaking worker into a successful ownership sample.
    if (sessions.length || databases) {
      await observer.query(`DROP DATABASE IF EXISTS "${c.database}" WITH (FORCE)`);
      assert.fail('Independent cleanup audit: worker database or sessions remain');
    }
    assert.deepEqual(worker.record.exit, { code: 0, signal: null }, `Worker exit must succeed: ${sample.errors.map(e => e.message).join('; ')}`);
    report.serverLog = readServerLog();
    validateSample(sample, report.serverLog); worker = null;
  }
  report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.errors.push({ message: error.message, stack: error.stack }); checkpoint();
} finally {
  await clean('worker', () => stop(worker));
  await clean('observer', async () => { if (observer) await within(observer.end(), 2000, 'Controller observer close deadline'); });
  await clean('init', () => stop(init));
  await clean('bundler', () => stop(bundler));
  await clean('service', () => stop(service, fault === 'service-signal' ? () => process.kill(process.pid, 'SIGTERM') : undefined));
  await new Promise(setImmediate); // Admit an actual shutdown-time OS signal before final success admission.
  if (logFd !== undefined) await clean('server-log', async () => { closeSync(logFd); report.serverLog = readFileSync(join(output, 'server.log'), 'utf8'); report.serverLogSha256 = sha(join(output, 'server.log')); });
  await clean('service-paths', async () => {
    assert.ok(report.processes.every(p => !alive(p.pid, true)), 'Refusing to remove live service/process state');
    if (report.serviceRoot) rmSync(report.serviceRoot, { recursive: true, force: true });
  });
  await clean('independent-audit', async () => { if (report.serviceRoot) report.cleanup.audit = await audit(report); });
  if (identity) { identity.status = 'stopped'; save(join(output, 'service.json'), identity); }
  if (fault === 'service-finalize') { report.status = 'failed'; report.cleanupErrors.push({ name: 'service-finalize', message: 'Injected service finalizer failure' }); }
  if (report.signal) report.status = 'failed';
  report.noise.after = { loadavg: loadavg(), at: new Date().toISOString() };
  if (report.status === 'passed') {
    try { validateCampaign(report); } catch (error) { report.status = 'failed'; report.errors.push({ message: error.message, stack: error.stack }); }
  }
  report.finishedAt = new Date().toISOString(); checkpoint();
  process.removeListener('SIGTERM', term); process.removeListener('SIGINT', int);
  process.stdout.write(JSON.stringify({ status: report.status, samples: report.samples.length, output, errors: report.errors, cleanupErrors: report.cleanupErrors }) + '\n');
  if (report.signal) process.kill(process.pid, report.signal);
  else process.exitCode = report.status === 'passed' ? 0 : 1;
}
