/** Isolated installed-artifact preparation for the original PG catalogs. No new workload. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, cpus, loadavg } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { alive, owned, portOpen, save, stop, within } from '../postgres-streaming/process.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const flags = new Map();
for (let i = 2; i < process.argv.length; i++) {
  const key = process.argv[i];
  assert.ok(
    [
      '--artifact',
      '--sha256',
      '--output',
      '--timing',
      '--smoke',
      '--pg-prefix',
      '--port',
      '--service-root',
      '--fault',
      '--expected-manifest',
      '--runs',
    ].includes(key),
    `Unknown argument: ${key}`,
  );
  assert.ok(!flags.has(key), `Duplicate argument: ${key}`);
  flags.set(key, ['--timing', '--smoke'].includes(key) ? true : process.argv[++i]);
}
for (const key of ['--artifact', '--sha256', '--output']) assert.ok(flags.get(key), `${key} required`);
assert.equal(process.version, 'v24.10.0', 'Baseline runtime is exact Node24.10.0');
assert.ok(!(flags.has('--smoke') && flags.has('--timing')), 'Choose plumbing smoke or serial timing');
if (flags.has('--timing'))
  assert.equal(process.env.PG_BENCH_SERIALIZED, '1', 'Serial timing requires an idle machine and PG_BENCH_SERIALIZED=1');
const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
const artifact = realpathSync(resolve(flags.get('--artifact')));
assert.match(flags.get('--sha256'), /^[a-f0-9]{64}$/);
assert.equal(sha(artifact), flags.get('--sha256'), 'Explicit artifact SHA256 mismatch');
if (flags.has('--timing')) {
  assert.ok(flags.get('--expected-manifest'), 'External final expected manifest required for timing');
  assert.equal(
    execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim(),
    '',
    'Final timing requires a clean tested checkout',
  );
}
const output = resolve(flags.get('--output'));
mkdirSync(output);
assert.ok(flags.get('--pg-prefix'), '--pg-prefix must name the local PostgreSQL installation.');
const prefix = resolve(flags.get('--pg-prefix'));
const stageParent = join(root, 'node_modules');
mkdirSync(stageParent, { recursive: true });
const stage = join(stageParent, 'pg65-sandbox');
mkdirSync(stage);
const benches = join(stage, 'benchmarks');
mkdirSync(benches);
const home = join(stage, 'home');
mkdirSync(home);
const report = {
  format: 'original-pg-installed-artifact-v1',
  status: 'running',
  mode: flags.has('--timing')
    ? 'pm-serial-timing'
    : flags.has('--smoke')
      ? 'plumbing-smoke-not-comparative'
      : 'correctness-only',
  timingAccepted: false,
  host: {
    cpu: cpus()[0]?.model,
    cpuCount: cpus().length,
    loadavg: loadavg(),
    workersFrozen: process.env.PG_BENCH_SERIALIZED === '1',
  },
  quietChecks: [],
  artifact: {
    path: artifact,
    sha256: sha(artifact),
    scope: 'actual isolated installed archive; no local source/dist fallback',
  },
  source: {
    root,
    head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    branch: execFileSync('git', ['branch', '--show-current'], { cwd: root, encoding: 'utf8' }).trim(),
    dirty: execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim(),
    hashes: {},
  },
  runtime: {
    executable: process.execPath,
    version: process.version,
    sha256: sha(process.execPath),
    versions: process.versions,
  },
  stage,
  processes: [],
  runs: [],
  audits: [],
  errors: [],
  cleanupErrors: [],
  cleanup: {},
  command: [process.execPath, ...process.execArgv, ...process.argv.slice(1)],
  unavailable: [
    'accepted comparative timing until machine idle checks pass',
    'cross-process aggregate percentiles',
    'install/type performance',
    'global RSS bounds',
    'throughput is not independently measured; arm samples are serial call durations',
    'Prisma8 candidate',
    'hosted services',
  ],
};
const checkpoint = () => save(join(output, 'campaign.json'), report);
const groups = [];
let service,
  observer,
  logFd,
  serviceReady = false,
  serviceRootCreated = false;
let signal = null;
const interrupt = (s) => {
  signal = s;
  report.status = 'failed';
  try {
    checkpoint();
  } catch (e) {
    report.errors.push(`Signal checkpoint unavailable: ${e.message}`);
  }
};
const onTerm = () => interrupt('SIGTERM'),
  onInt = () => interrupt('SIGINT');
process.on('SIGTERM', onTerm);
process.on('SIGINT', onInt);
const active = () => assert.equal(signal, null, 'Run interrupted');
const environment = {
  LANG: 'C.UTF-8',
  LC_ALL: 'C.UTF-8',
  TZ: 'UTC',
  PGPASSFILE: '/dev/null',
  HOME: home,
  XDG_CACHE_HOME: join(home, 'cache'),
  npm_config_cache: join(home, 'npm'),
  npm_config_userconfig: join(home, '.npmrc'),
  npm_config_registry: 'https://registry.npmjs.org',
  PATH: `${dirname(process.execPath)}:${process.env.PATH}`,
  BENCH_RETAIN_SAMPLES: '1',
  PG_BENCH_ARTIFACT_SCOPE: `installed archive sha256:${report.artifact.sha256}`,
};
writeFileSync(environment.npm_config_userconfig, '');
report.executionEnvironment = { ...environment };
async function command(executable, args, name, env = {}, deadline = 180000, success = true) {
  active();
  const fd = openSync(join(output, `${name}.log`), 'wx');
  const task = owned(executable, args, { cwd: stage, env: { ...environment, ...env }, stdio: ['ignore', fd, fd] });
  task.record.name = name;
  task.record.pgid = task.record.pid;
  groups.push(task);
  report.processes.push(task.record);
  checkpoint();
  try {
    await within(
      (async () => {
        while (task.record.exit === null) {
          active();
          await Promise.race([task.done, delay(100)]);
        }
      })(),
      deadline,
      `${name} deadline`,
    );
    assert.equal(task.record.exit.signal, null, `${name} unexpected signal`);
    assert.equal(task.record.exit.code === 0, success, `${name} failed; see ${name}.log`);
    return readFileSync(join(output, `${name}.log`), 'utf8');
  } finally {
    await stop(task);
    closeSync(fd);
    checkpoint();
  }
}
function cpuTicks() {
  const cells = readFileSync('/proc/stat', 'utf8').split('\n')[0].trim().split(/\s+/).slice(1).map(Number);
  return { idle: cells[3] + cells[4], total: cells.slice(0, 8).reduce((a, b) => a + b, 0) };
}
async function quiet(label) {
  if (!flags.has('--timing')) return;
  const before = cpuTicks();
  await delay(1000);
  active();
  const after = cpuTicks();
  const idlePercent = (100 * (after.idle - before.idle)) / (after.total - before.total);
  report.quietChecks.push({
    label,
    at: new Date().toISOString(),
    idlePercent,
    n: 1,
    method: '/proc/stat CPU ticks over 1000ms',
    threshold: 80,
    loadavg: loadavg(),
  });
  checkpoint();
  assert.ok(idlePercent >= 80, `${label}: CPU quiet-window check failed; retain and reject this campaign`);
}
async function audit(label) {
  const sessions = (
    await observer.query(
      'SELECT pid,state,application_name FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()',
    )
  ).rows;
  assert.deepEqual(sessions, [], `${label}: worker leaked backend sessions`);
  const scratch = (await observer.query('SELECT count(*)::int AS n FROM bench_writes')).rows[0].n;
  const sequence = (await observer.query('SELECT last_value::text, is_called FROM bench_writes_id_seq')).rows[0];
  assert.equal(scratch, 0, `${label}: scratch not empty`);
  assert.deepEqual(sequence, { last_value: '1', is_called: false }, `${label}: sequence not restored`);
  report.audits.push({ label, sessions, scratch, sequence });
  checkpoint();
}
function files(dir, skipDependencies = false) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? e.name === 'node_modules' && skipDependencies
        ? []
        : files(join(dir, e.name), skipDependencies)
      : [join(dir, e.name)],
  );
}
try {
  // Preserve all original source files byte for byte; no imports target mutable sibling trees.
  const sources = readdirSync(join(root, 'benchmarks')).filter(
    (f) => /\.(ts|mjs|json)$/.test(f) && !/^(?:mysql|sqlite|bench-mysql|bench-sqlite)/.test(f),
  );
  for (const f of sources) {
    cpSync(join(root, 'benchmarks', f), join(benches, f));
    report.source.hashes[`benchmarks/${f}`] = sha(join(benches, f));
  }
  cpSync(join(root, 'benchmarks/prisma/schema.prisma'), join(benches, 'prisma/schema.prisma'), { recursive: true });
  cpSync(join(root, 'benchmarks/pg-preparation'), join(benches, 'pg-preparation'), {
    recursive: true,
    filter: (source) => !source.endsWith('/node_modules'),
  });
  cpSync(join(root, 'benchmarks/postgres-streaming/process.mjs'), join(benches, 'postgres-streaming/process.mjs'));
  for (const f of files(join(root, 'benchmarks/pg-preparation'), true))
    report.source.hashes[f.slice(root.length + 1)] = sha(f);
  report.source.hashes['benchmarks/prisma/schema.prisma'] = sha(join(benches, 'prisma/schema.prisma'));
  report.source.hashes['benchmarks/postgres-streaming/process.mjs'] = sha(
    join(root, 'benchmarks/postgres-streaming/process.mjs'),
  );
  cpSync(artifact, join(stage, 'artifact.tgz'));
  assert.equal(sha(join(stage, 'artifact.tgz')), report.artifact.sha256);
  const meta = JSON.parse(
    execFileSync('/usr/bin/tar', ['-xOf', join(stage, 'artifact.tgz'), 'package/package.json'], {
      encoding: 'utf8',
      timeout: 10000,
    }),
  );
  const pkg = JSON.parse(readFileSync(join(benches, 'package.json')));
  const lock = JSON.parse(readFileSync(join(benches, 'package-lock.json')));
  const spec = 'file:../artifact.tgz';
  pkg.dependencies['turbine-orm'] = spec;
  lock.packages[''].dependencies['turbine-orm'] = spec;
  delete lock.packages['..'];
  lock.packages['node_modules/turbine-orm'] = {
    version: meta.version,
    resolved: spec,
    integrity: `sha512-${createHash('sha512').update(readFileSync(artifact)).digest('base64')}`,
    dependencies: meta.dependencies,
    bin: meta.bin,
    engines: meta.engines,
    peerDependencies: meta.peerDependencies,
    peerDependenciesMeta: meta.peerDependenciesMeta,
  };
  writeFileSync(join(stage, 'package.json'), JSON.stringify({ type: 'module', private: true }));
  writeFileSync(join(benches, 'package.json'), JSON.stringify(pkg, null, 2));
  writeFileSync(join(benches, 'package-lock.json'), JSON.stringify(lock, null, 2));
  cpSync(join(benches, 'package.json'), join(output, 'installed-package.json'));
  cpSync(join(benches, 'package-lock.json'), join(output, 'installed-package-lock.json'));
  const npmPath = process.env.PG_BENCH_NPM_CLI ?? process.env.npm_execpath;
  assert.ok(npmPath, 'Set PG_BENCH_NPM_CLI or npm_execpath to the npm CLI JavaScript file.');
  const npmCli = realpathSync(npmPath);
  report.tools = {
    tar: { path: '/usr/bin/tar', sha256: sha('/usr/bin/tar') },
    ldd: { path: '/usr/bin/ldd', sha256: sha('/usr/bin/ldd') },
  };
  report.npm = {
    path: npmCli,
    sha256: sha(npmCli),
    version: execFileSync(process.execPath, [npmCli, '--version'], { encoding: 'utf8' }).trim(),
  };
  await command(
    process.execPath,
    [npmCli, 'ci', '--prefix', benches, '--ignore-scripts', '--no-audit', '--no-fund'],
    'locked-install',
  );
  symlinkSync(join(benches, 'node_modules'), join(stage, 'node_modules'), 'dir');
  const require = createRequire(join(benches, 'package.json'));
  const installed = join(benches, 'node_modules/turbine-orm');
  assert.equal(realpathSync(installed), installed, 'Artifact must be installed, not a source symlink');
  const pins = {
    pg: '8.23.1',
    'drizzle-orm': '0.45.4',
    'drizzle-rc': '1.0.0-rc.5',
    '@prisma/client': '7.10.1',
    '@prisma/adapter-pg': '7.10.1',
    prisma: '7.10.1',
  };
  report.dependencies = {};
  for (const [name, version] of Object.entries(pins)) {
    const path = join(benches, 'node_modules', name, 'package.json');
    const actual = JSON.parse(readFileSync(path));
    assert.equal(actual.version, version, `Locked ${name} mismatch`);
    const entry = name === 'prisma' ? join(benches, 'node_modules/prisma/build/index.js') : require.resolve(name);
    report.dependencies[name] = { version, path, sha256: sha(path), entry, entrySha256: sha(entry) };
  }
  report.installed = {
    version: meta.version,
    path: installed,
    files: Object.fromEntries(files(installed).map((f) => [f.slice(installed.length + 1), sha(f)])),
  };
  // Prove every installed package payload byte matches the supplied archive, independently of version strings.
  const extracted = join(stage, 'verify-archive');
  mkdirSync(extracted);
  await command('/usr/bin/tar', ['-xf', join(stage, 'artifact.tgz'), '-C', extracted], 'archive-extract');
  const archiveFiles = files(join(extracted, 'package'));
  for (const f of archiveFiles)
    assert.equal(
      sha(join(installed, f.slice(join(extracted, 'package').length + 1))),
      sha(f),
      'Installed archive payload mismatch',
    );
  report.installed.archiveFilesVerified = archiveFiles.length;
  rmSync(extracted, { recursive: true });
  const loader = join(benches, 'node_modules/tsx/dist/loader.mjs');
  const ts = (f) => ['--import', loader, join(benches, f)];
  await command(
    process.execPath,
    [
      join(benches, 'node_modules/prisma/build/index.js'),
      'generate',
      '--schema',
      join(benches, 'prisma/schema.prisma'),
    ],
    'prisma-generate',
  );
  await command(
    process.execPath,
    [
      '--import',
      loader,
      '--test',
      ...['bench-harness.test.ts', 'extended-equivalence.test.ts'].map((f) => join(benches, f)),
    ],
    'contract-tests',
  );
  const dependencyFiles = Object.fromEntries(
    files(join(benches, 'node_modules')).map((f) => [f.slice(benches.length + 1), sha(f)]),
  );
  save(join(output, 'dependency-files.json'), dependencyFiles);
  report.dependencyFilesSha256 = sha(join(output, 'dependency-files.json'));
  assert.equal(
    execFileSync(join(prefix, 'bin/postgres'), ['--version'], { encoding: 'utf8', timeout: 2000 }).trim(),
    'postgres (PostgreSQL) 18.6',
  );
  report.server = {
    executable: join(prefix, 'bin/postgres'),
    sha256: sha(join(prefix, 'bin/postgres')),
    initdbSha256: sha(join(prefix, 'bin/initdb')),
  };
  report.serviceRoot = flags.get('--service-root')
    ? resolve(flags.get('--service-root'))
    : join(homedir(), '.cache', `pg65-${process.pid}`);
  report.data = join(report.serviceRoot, 'data');
  report.socket = join(report.serviceRoot, 'socket');
  report.port = Number(flags.get('--port') ?? 56465);
  assert.ok(Number.isInteger(report.port) && report.port > 1024 && report.port <= 65535);
  assert.equal(await portOpen(report.port), false, 'Requested port already owned by another service');
  mkdirSync(report.serviceRoot);
  serviceRootCreated = true;
  mkdirSync(report.socket);
  console.log(
    JSON.stringify({
      announcement: 'owned service before native setup',
      root: report.serviceRoot,
      port: report.port,
      output,
    }),
  );
  checkpoint();
  await command(
    join(prefix, 'bin/initdb'),
    [
      '-D',
      report.data,
      '-U',
      'pg65_owner',
      '-A',
      'trust',
      '--no-locale',
      '--encoding=UTF8',
      '--no-instructions',
      '-L',
      join(prefix, 'share/postgresql'),
    ],
    'initdb',
    {},
    20000,
  );
  active();
  logFd = openSync(join(output, 'postgres.log'), 'wx');
  service = owned(
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
    { cwd: stage, env: environment, stdio: ['ignore', logFd, logFd] },
  );
  service.record.pgid = service.record.pid;
  service.record.name = 'postgres';
  groups.push(service);
  report.processes.push(service.record);
  checkpoint();
  const pg = require('pg');
  const url = `postgresql://pg65_owner@127.0.0.1:${report.port}/postgres`;
  for (let i = 0; i < 100; i++) {
    active();
    assert.equal(service.record.exit, null, 'Postmaster exited during readiness');
    const c = new pg.Client({ connectionString: url, connectionTimeoutMillis: 300, query_timeout: 10000 });
    c.on('error', () => {});
    try {
      await c.connect();
      observer = c;
      break;
    } catch {
      await c.end();
      await delay(50);
    }
  }
  assert.ok(observer, 'Owned PostgreSQL readiness');
  serviceReady = true;
  report.observerPid = observer.processID;
  report.server.facts = (
    await observer.query(
      "SELECT version(),current_setting('server_version') version_number,current_setting('data_directory') data,current_setting('TimeZone') timezone",
    )
  ).rows[0];
  assert.equal(report.server.facts.version_number, '18.6');
  assert.equal(report.server.facts.data, report.data);
  assert.equal(report.server.facts.timezone, 'UTC');
  report.server.configFiles = Object.fromEntries(
    ['postgresql.conf', 'pg_hba.conf', 'pg_ident.conf'].map((f) => [f, sha(join(report.data, f))]),
  );
  report.server.linkedLibraries = execFileSync('/usr/bin/ldd', [join(prefix, 'bin/postgres')], {
    encoding: 'utf8',
    timeout: 5000,
  });
  report.server.libraryFiles = Object.fromEntries(
    [...report.server.linkedLibraries.matchAll(/(?:=>\s+|^\s*)(\/[^\s]+)/gm)].map((match) => [match[1], sha(match[1])]),
  );
  report.server.settings = Object.fromEntries(
    (
      await observer.query('SELECT name,setting FROM pg_settings WHERE name=ANY($1::text[])', [
        [
          'max_connections',
          'shared_buffers',
          'fsync',
          'synchronous_commit',
          'full_page_writes',
          'default_transaction_isolation',
          'plan_cache_mode',
          'statement_timeout',
        ],
      ])
    ).rows.map((r) => [r.name, r.setting]),
  );
  const env = {
    PG_BENCH_INSTALLED_PACKAGE: installed,
    SECONDARY_TURBINE_ARTIFACT: artifact,
    DATABASE_URL: url,
    PGSOCKET: `${report.socket}/.s.PGSQL.${report.port}`,
    PGDATABASE: 'postgres',
    PGUSER: 'pg65_owner',
    USERS: '1000',
    POSTS_PER_USER: '10',
    COMMENTS_PER_POST: '5',
    WIDE_ROWS: '2000',
    RTTS: '0,1,5,25',
  };
  await command(process.execPath, ts('seed-neon.ts'), 'seed', env);
  await command(
    process.execPath,
    [join(installed, 'dist/cli/index.js'), 'generate', '--no-timestamp', '--out', join(stage, 'generated/turbine')],
    'turbine-generate',
    env,
  );
  report.generated = Object.fromEntries(
    files(join(stage, 'generated')).map((f) => [f.slice(stage.length + 1), sha(f)]),
  );
  cpSync(join(stage, 'generated'), join(output, 'generated'), { recursive: true });
  const executedHarness = Object.fromEntries(Object.keys(report.source.hashes).map((f) => [f, sha(join(stage, f))]));
  const observedIdentity = {
    format: 'pg-executed-inputs-v1',
    scope: 'installed-artifact',
    head: report.source.head,
    artifact: { path: artifact, sha256: report.artifact.sha256 },
    runtime: { node: process.version, executable: process.execPath, sha256: sha(process.execPath) },
    server: {
      version: '18.6',
      executable: report.server.executable,
      sha256: report.server.sha256,
      settings: report.server.settings,
    },
    manifests: {
      harness: executedHarness,
      installed: report.installed.files,
      generated: report.generated,
      dependencies: dependencyFiles,
      serverConfig: report.server.configFiles,
    },
  };
  const observedPath = join(output, 'observed-identity.json');
  save(observedPath, observedIdentity);
  env.PG_BENCH_OBSERVED_IDENTITY = observedPath;
  save(join(output, 'admission-candidate.json'), { format: 'pg-final-admission-v1', expected: observedIdentity });
  report.admissionScope = flags.has('--expected-manifest') ? 'external-final-input' : 'preparation-only';
  if (flags.has('--expected-manifest')) {
    const expectedPath = resolve(flags.get('--expected-manifest'));
    const expected = JSON.parse(readFileSync(expectedPath));
    assert.equal(expected.format, 'pg-final-admission-v1');
    assert.deepEqual(
      observedIdentity,
      expected.expected,
      'Actual archive/source/runtime/manifests differ from external final admission',
    );
    report.expectedManifest = { path: expectedPath, sha256: sha(expectedPath) };
    env.PG_BENCH_EXPECTED_MANIFEST = expectedPath;
  }
  if (flags.get('--fault') === 'worker-failure')
    await command(
      process.execPath,
      ['-e', "throw new Error('intentional worker failure')"],
      'intentional-failure',
      env,
    );
  if (flags.get('--fault') === 'signal') {
    process.kill(process.pid, 'SIGTERM');
    await delay(10);
    active();
  }
  assert.ok(!flags.has('--fault'), 'Unknown fault');
  for (const suite of ['headline', 'extended', 'stream', 'latency', 'deepoffset', 'controls']) {
    const path = join(output, `${suite}.json`);
    await command(
      process.execPath,
      [...ts('pg-preparation/worker.ts'), suite, path, 'preflight'],
      `${suite}-preflight`,
      env,
      240000,
    );
    const result = JSON.parse(readFileSync(path));
    assert.equal(result.status, 'passed');
    report.runs.push({ suite, mode: 'preflight', path, sha256: sha(path), children: result.children ?? [] });
    await audit(`${suite} preflight`);
  }
  await command(
    process.execPath,
    [
      '--import',
      loader,
      '--test',
      ...['secondary-results.test.ts', 'pg-admission.test.ts'].map((f) => join(benches, f)),
    ],
    'secondary-admission-tests',
    { SECONDARY_POSITIVE_DIRECTORY: output },
  );
  if (flags.has('--timing') || flags.has('--smoke')) {
    await quiet('control-before');
    await command(
      process.execPath,
      [...ts('machine-control.ts'), 'before'],
      'machine-control-before',
      { ...env, ...(flags.has('--smoke') ? { ROUNDS: '1', WARMUP: '0' } : {}) },
      240000,
    );
    const timedEnv = flags.has('--smoke')
      ? { ROUNDS: '1', WARMUP: '0', STREAM_ROUNDS: '1', COLD_ROUNDS: '1', EXTENDED_QUICK: '1' }
      : {};
    const repeats = Number(flags.get('--runs') ?? (flags.has('--timing') ? 3 : 1));
    assert.ok(Number.isSafeInteger(repeats) && repeats > 0 && repeats <= 10, 'Bounded repeat count 1..10 required');
    report.timingRepeats = repeats;
    for (let repeat = 1; repeat <= repeats; repeat++)
      for (const suite of ['headline', 'extended', 'stream', 'latency', 'deepoffset']) {
        await quiet(`${suite}-before`);
        const path = join(output, `${suite}-run${repeat}-samples.json`);
        await command(
          process.execPath,
          [...ts('pg-preparation/worker.ts'), suite, path, 'timing'],
          `${suite}-run${repeat}-samples`,
          { ...env, ...timedEnv, ...(!flags.has('--smoke') && suite === 'extended' ? { WARMUP: '15' } : {}) },
          3600000,
        );
        const result = JSON.parse(readFileSync(path));
        assert.equal(result.status, 'passed');
        const stats = result.results.flatMap((s) => s.stats);
        assert.ok(
          stats.length &&
            stats.every((s) => s.samplesMs?.length === s.n && s.sampleMethod && (s.n >= 100 || s.p99 === null)),
          'Retained actual samples and explicit tail policy required',
        );
        report.runs.push({
          suite,
          repeat,
          mode: flags.has('--smoke') ? 'plumbing-smoke' : 'timing',
          path,
          sha256: sha(path),
          children: result.children ?? [],
        });
        await audit(`${suite} measured`);
        await quiet(`${suite}-after`);
      }
    await command(
      process.execPath,
      [...ts('machine-control.ts'), 'after'],
      'machine-control-after',
      { ...env, ...(flags.has('--smoke') ? { ROUNDS: '1', WARMUP: '0' } : {}) },
      240000,
    );
    await quiet('control-after');
  }
  assert.equal(sha(artifact), report.artifact.sha256, 'Archive changed during execution');
  assert.equal(sha(process.execPath), report.runtime.sha256, 'Runtime executable changed during execution');
  assert.deepEqual(
    Object.fromEntries(Object.keys(report.source.hashes).map((f) => [f, sha(join(root, f))])),
    report.source.hashes,
    'Source changed during execution',
  );
  report.status = 'passed';
} catch (e) {
  report.status = 'failed';
  report.errors.push(e.stack ?? String(e));
} finally {
  const clean = async (name, fn) => {
    try {
      await fn();
    } catch (e) {
      report.cleanupErrors.push({ name, error: String(e) });
    }
  };
  for (const task of [...groups].reverse()) if (task !== service) await clean(task.record.name, () => stop(task));
  await clean('observer', async () => {
    if (observer) await within(observer.end(), 3000, 'Observer close');
  });
  await clean('service', () => stop(service));
  if (logFd !== undefined) closeSync(logFd);
  await clean('paths', async () => {
    assert.ok(
      groups.every((p) => !alive(p.record.pid, true)),
      'Live groups prevent path removal',
    );
    if (serviceRootCreated) rmSync(report.serviceRoot, { recursive: true, force: true });
  });
  const registered = report.processes.map((p) => ({
    pid: p.pid,
    startTicks: p.startTicks,
    exited: p.exit,
    processAbsent: !alive(p.pid),
    groupAbsent: !alive(p.pid, true),
  }));
  const descendants = report.runs.flatMap((r) => r.children ?? []).map((p) => ({ ...p, processAbsent: !alive(p.pid) }));
  report.cleanup = {
    processes: registered,
    descendants,
    serviceRootCreated,
    paths: (serviceRootCreated ? [report.serviceRoot, report.data, report.socket] : [])
      .filter(Boolean)
      .map((path) => ({ path, absent: !existsSync(path) })),
    portClosed: serviceRootCreated && report.port ? !(await portOpen(report.port)) : null,
    observerAbsent: report.observerPid ? !alive(report.observerPid) : null,
    serviceReady,
  };
  report.cleanup.proven =
    !report.cleanupErrors.length &&
    registered.every((p) => p.processAbsent && p.groupAbsent) &&
    descendants.every((p) => p.processAbsent) &&
    report.cleanup.paths.every((p) => p.absent) &&
    report.cleanup.portClosed !== false &&
    report.cleanup.observerAbsent !== false;
  if (!report.cleanup.proven || signal) report.status = 'failed';
  report.signal = signal;
  report.finishedAt = new Date().toISOString();
  // Logs, payload hashes, generated code and resolved lock survive. Mutable install/cache does not.
  if (registered.every((p) => p.processAbsent && p.groupAbsent) && descendants.every((p) => p.processAbsent))
    rmSync(stage, { recursive: true, force: true });
  report.cleanup.stageRemoved = !existsSync(stage);
  try {
    checkpoint();
  } catch (error) {
    report.status = 'failed';
    process.stderr.write(`Final report checkpoint failed after cleanup: ${error.message}\n`);
  }
  process.off('SIGTERM', onTerm);
  process.off('SIGINT', onInt);
}
console.log(
  JSON.stringify({ status: report.status, output, cleanupProven: report.cleanup.proven, errors: report.errors }),
);
process.exitCode = report.status === 'passed' ? 0 : 1;
