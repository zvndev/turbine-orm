#!/usr/bin/env node
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ownedMysql } from '../lifecycle-examples/mysql-service.mjs';
import { application, ddl, expectedRelations, modes, nativeRows, negativeStatements, typeControls } from './corpus.mjs';
import {
  archivePin,
  assertRows,
  command,
  compilerDiagnostics,
  files,
  installedPayload,
  packageVersion,
  pinnedArchive,
  prerequisites,
  readJson,
  sha256,
} from './harness.mjs';
import { ownedPostgres } from './postgres-service.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const args = {};
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i];
  assert.ok(
    ['--tarball', '--sha256', '--engine', '--out', '--exact-node', '--fault'].includes(key),
    `Unknown option ${key}`,
  );
  assert.ok(process.argv[i + 1] && !process.argv[i + 1].startsWith('--'), `${key} requires a value`);
  assert.equal(args[key.slice(2)], undefined, `Duplicate option ${key}`);
  args[key.slice(2)] = process.argv[i + 1];
}
assert.ok(args.out, '--out evidence directory is required');
const out = resolve(args.out);
assert.equal(existsSync(out), false, 'Evidence directory must be new');
mkdirSync(out, { recursive: true });
const report = {
  formatVersion: 1,
  started: new Date().toISOString(),
  engine: args.engine,
  node: process.version,
  runtime: process.versions,
  platform: process.platform,
  arch: process.arch,
  steps: [],
  services: [],
  cases: [],
  controls: [],
  cleanup: {},
  passed: false,
  limits: [
    'Only the recorded archive/runtime/service versions and formats are covered.',
    'No MSSQL native claim.',
    'SQLite exact decimals are TEXT; no arbitrary precision NUMERIC claim.',
    'BIGINT read union is an explicit consumer columnTypes override, not the default generated number type.',
    'Selection omits email; no introspected PII tag claim.',
    'No migration or seed lifecycle certification.',
  ],
};
const env = {
  ...process.env,
  NODE_OPTIONS: '',
  NODE_PATH: '',
  DATABASE_URL: '',
  PATH: `${dirname(process.execPath)}:${process.env.PATH}`,
  TZ: 'UTC',
  NO_COLOR: '1',
};
let root;
let interrupted;
const stops = new Set();
const run = (cwd, binary, argv, childEnv = env, expected = 0) =>
  command(report, root, cwd, binary, argv, childEnv, expected);
const save = (path, data) => writeFileSync(path, JSON.stringify(data, null, 2) + '\n');
const checkpoint = () => {
  if (interrupted) throw new Error(`Interrupted by ${interrupted}`);
};
const onSignal = (signal) => {
  interrupted = signal;
};
process.on('SIGINT', onSignal);
process.on('SIGTERM', onSignal);
async function refusal(label, body, pattern) {
  let message;
  try {
    await body();
  } catch (error) {
    message = error.message;
  }
  assert.ok(message, `${label}: unexpectedly accepted`);
  assert.match(message, pattern);
  report.controls.push({ label, error: message });
}
async function checkedCase(label, body) {
  checkpoint();
  try {
    await body();
    report.cases.push({ label, passed: true });
  } catch (error) {
    report.cases.push({ label, passed: false, error: error.stack });
  }
}
function config(engine) {
  return `import type { TurbineCliConfig } from 'turbine-orm/cli';\nexport default { engine: '${engine}', url: process.env.DATABASE_URL, out: './generated', columnTypes: { 'invoices.external_id': 'number | string | bigint' } } satisfies TurbineCliConfig;\n`;
}
function install() {
  const app = join(root, 'installed');
  mkdirSync(app);
  save(join(app, 'package.json'), { private: true, type: 'module' });
  // Pinned consumer development tools and optional MySQL peer. No repository package mutation.
  run(app, 'npm', [
    'install',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    '--save-exact',
    report.artifact.path,
    'pg@8.22.0',
    'typescript@6.0.3',
    '@types/node@22.20.4',
    'tsx@4.23.15',
    'mysql2@3.24.5',
  ]);
  const pkg = join(app, 'node_modules/turbine-orm');
  const manifest = readJson(join(pkg, 'package.json'));
  assert.equal(manifest.version, packageVersion);
  assert.deepEqual(Object.keys(manifest.dependencies), ['pg']);
  report.installedPayloadHash = installedPayload(app, report.archivePayload);
  report.dependencies = {};
  for (const name of ['turbine-orm', 'pg', 'typescript', '@types/node', 'tsx', 'mysql2'])
    report.dependencies[name] = readJson(join(app, 'node_modules', name, 'package.json')).version;
  cpSync(join(app, 'package-lock.json'), join(out, 'package-lock.json'));
  report.lockSha256 = sha256(readFileSync(join(app, 'package-lock.json')));
  return { app, pkg, require: createRequire(join(app, 'package.json')) };
}
function consumer(installed, name, engine, format, url) {
  const dir = join(installed.app, name);
  mkdirSync(dir);
  save(join(dir, 'package.json'), { private: true, type: format });
  writeFileSync(join(dir, 'turbine.config.ts'), config(engine));
  writeFileSync(join(dir, 'app.ts'), application(engine));
  writeFileSync(join(dir, 'invalid.ts'), typeControls(engine));
  save(join(dir, 'tsconfig.json'), {
    compilerOptions: {
      target: 'ES2023',
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      strict: true,
      exactOptionalPropertyTypes: true,
      noUncheckedIndexedAccess: true,
      skipLibCheck: false,
      types: ['node'],
      outDir: 'build',
    },
    include: ['app.ts', 'generated/**/*.ts'],
  });
  save(join(dir, 'tsconfig.invalid.json'), {
    extends: './tsconfig.json',
    include: ['invalid.ts', 'generated/**/*.ts'],
    compilerOptions: { noEmit: true },
  });
  save(join(dir, 'expected.json'), {
    invoices: nativeRows(),
    relations: expectedRelations(engine),
    customers: [
      { id: 1, name: 'Ada', email: 'ada@example.test' },
      { id: 2, name: 'Lin', email: 'lin@example.test' },
    ],
    profiles: [{ id: 10, customer_id: 1, label: 'Primary' }],
  });
  const childEnv = { ...env, DATABASE_URL: url };
  const compiler = join(installed.app, 'node_modules/typescript/bin/tsc');
  return {
    dir,
    childEnv,
    pull() {
      run(
        dir,
        process.execPath,
        [join(installed.pkg, 'dist/cli/index.js'), 'pull', '--no-timestamp', '--import-ext', 'js'],
        childEnv,
      );
    },
    compile(config = 'tsconfig.json', expected = 0) {
      return run(dir, process.execPath, [compiler, '-p', config], childEnv, expected);
    },
    execute(scope) {
      const result = run(dir, process.execPath, ['build/app.js', scope], childEnv);
      const trace = readJson(join(dir, `trace-${scope}.json`));
      assert.ok(trace.length, 'Executed application must retain nonempty query events');
      assert.ok(
        trace.every((event) => typeof event.sql === 'string' && event.sql.length && Array.isArray(event.params)),
        'Incomplete SQL trace',
      );
      return result;
    },
    preserve() {
      const evidence = join(out, name);
      cpSync(dir, evidence, { recursive: true });
      report.consumers ??= [];
      report.consumers.push({ name, engine, format, sourceHashes: files(evidence) });
    },
  };
}
const camelRows = (rows) =>
  rows.map((row) =>
    Object.fromEntries(
      Object.entries(row).map(([key, value]) => [key.replace(/_([a-z])/g, (_all, char) => char.toUpperCase()), value]),
    ),
  );
function decodeRows(rows) {
  return rows.map((row) => ({
    ...row,
    payload: typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload,
  }));
}
function rowSql(engine) {
  const ext =
    engine === 'postgresql'
      ? 'external_id::text'
      : engine === 'mysql'
        ? 'CAST(external_id AS CHAR)'
        : 'CAST(external_id AS TEXT)';
  const amount = engine === 'postgresql' ? 'amount::text' : engine === 'mysql' ? 'CAST(amount AS CHAR)' : 'amount';
  const date =
    engine === 'postgresql'
      ? `to_char(issued_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`
      : engine === 'mysql'
        ? `CONCAT(DATE_FORMAT(issued_at, '%Y-%m-%dT%H:%i:%s.'), LEFT(DATE_FORMAT(issued_at, '%f'),3), 'Z')`
        : 'issued_at';
  return `SELECT id, customer_id, ${ext} AS external_id, ${amount} AS amount, payload, note, ${date} AS issued_at, score, doubled FROM invoices ORDER BY id`;
}
async function exercise(installed, name, engine, format, url, query) {
  const project = consumer(installed, name, engine, format, url);
  const audit = [];
  const sql = async (text) => {
    const rows = await query(text);
    audit.push({ sql: text, rows });
    return rows;
  };
  let ready = false;
  try {
    for (const statement of ddl(engine)) await sql(statement);
    project.pull();
    const generatedBefore = files(join(project.dir, 'generated'));
    project.pull();
    assert.deepEqual(
      files(join(project.dir, 'generated')),
      generatedBefore,
      'Repeated packed introspection must be deterministic',
    );
    project.compile();
    project.compile('tsconfig.invalid.json');
    writeFileSync(
      join(project.dir, 'invalid.ts'),
      typeControls(engine).replaceAll('// @ts-expect-error intentional invalid application', ''),
    );
    const negative = project.compile('tsconfig.invalid.json', 2);
    compilerDiagnostics(negative.output, typeControls(engine), negativeStatements(engine));
    report.controls.push({ label: `${name}/compiler negatives`, diagnostics: negativeStatements(engine).length });
    ready = true;
    await checkedCase(`${name}/write-and-native-effect`, async () => {
      assert.deepEqual(JSON.parse(project.execute('write').stdout), { written: 6 });
      assertRows(decodeRows(await sql(rowSql(engine))), nativeRows(), name);
      assertRows(
        await sql('SELECT id, name, email FROM customers ORDER BY id'),
        readJson(join(project.dir, 'expected.json')).customers,
        'native customer writes',
      );
      assertRows(
        await sql('SELECT id, customer_id, label FROM profiles ORDER BY id'),
        readJson(join(project.dir, 'expected.json')).profiles,
        'native unique-FK write',
      );
      assertRows(
        await sql('SELECT id FROM invoices WHERE payload IS NULL ORDER BY id'),
        [{ id: 13 }],
        'SQL NULL versus JSON null',
      );
    });
    for (const scope of ['values', 'nested-values', 'relations', 'selection', 'refusal']) {
      await checkedCase(`${name}/${scope}`, async () => {
        const result = JSON.parse(project.execute(scope).stdout);
        if (scope === 'values' || scope === 'nested-values')
          assertRows(
            result,
            camelRows(decodeRows(await sql(rowSql(engine)))),
            'typed reads versus independent native query',
          );
        if (scope === 'relations') {
          const parents = await sql('SELECT id FROM customers ORDER BY id');
          const native = [];
          for (const parent of parents) {
            const profile = await sql(`SELECT id, label FROM profiles WHERE customer_id = ${parent.id}`);
            const invoices = await sql(
              `SELECT id FROM invoices WHERE customer_id = ${parent.id} ORDER BY score DESC, id DESC LIMIT 2 OFFSET 1`,
            );
            native.push({
              id: parent.id,
              [engine === 'postgresql' ? 'profile' : 'profiles']: profile[0] ?? null,
              invoices,
            });
          }
          assertRows(native, expectedRelations(engine), 'independent per-parent SQL');
          assertRows(result, native, 'relation results versus native SQL');
        }
        if (scope === 'selection')
          assertRows(result, await sql('SELECT id, name FROM customers ORDER BY id'), 'selected native columns');
        assertRows(decodeRows(await sql(rowSql(engine))), nativeRows(), 'reads and refusals preserve exact rows');
      });
    }
    // A deliberately faulty program claims success with exit0 while the native effect is absent/wrong.
    await sql(engine === 'mysql' ? 'START TRANSACTION' : 'BEGIN');
    try {
      await sql('DELETE FROM invoices WHERE id = 13');
      writeFileSync(join(project.dir, 'faulty-effect.cjs'), 'console.log(JSON.stringify({written: 6}));\n');
      const claimed = run(project.dir, process.execPath, ['faulty-effect.cjs'], project.childEnv);
      assert.deepEqual(JSON.parse(claimed.stdout), { written: 6 });
      await refusal(
        `${name}/exit0 dropped effect`,
        async () => assertRows(decodeRows(await sql(rowSql(engine))), nativeRows()),
        /exact stored rows differ/,
      );
      await sql('ROLLBACK');
      await sql(engine === 'mysql' ? 'START TRANSACTION' : 'BEGIN');
      await sql("UPDATE invoices SET note = 'wrong effect' WHERE id = 11");
      run(project.dir, process.execPath, ['faulty-effect.cjs'], project.childEnv);
      await refusal(
        `${name}/exit0 wrong effect`,
        async () => assertRows(decodeRows(await sql(rowSql(engine))), nativeRows()),
        /exact stored rows differ/,
      );
      if (args.fault === 'dropped-effect') throw new Error('Deliberate wrong native effect detected after exit0');
    } finally {
      await sql('ROLLBACK');
    }
    assertRows(decodeRows(await sql(rowSql(engine))), nativeRows(), 'fault control restored');
  } catch (error) {
    report.cases.push({
      label: `${name}/${ready ? 'oracle-controls' : 'generate-compile'}`,
      passed: false,
      error: error.stack,
    });
  } finally {
    save(join(project.dir, 'native-sql.json'), audit);
    project.preserve();
  }
}
async function mysql(installed) {
  const driver = installed.require('mysql2/promise');
  for (const [index, mode] of modes.entries()) {
    checkpoint();
    const serviceRoot = join(root, `mysql-${index}`);
    mkdirSync(serviceRoot);
    const service = await ownedMysql({
      root: serviceRoot,
      mode,
      env,
      run,
      driver,
      report,
      registerStop: (stop) => stops.add(stop),
    });
    const identity = report.services.at(-1);
    identity.engine = 'mysql';
    assert.equal(identity.version, '8.4.0', 'Exact MySQL 8.4.0 required');
    identity.settings = (
      await service.admin.query(
        'SELECT @@time_zone AS timezone, @@system_time_zone AS systemTimezone, @@character_set_server AS charset, @@collation_server AS collation, @@transaction_isolation AS isolation',
      )
    )[0][0];
    identity.binarySha256 = sha256(readFileSync(join(env.MYSQL_BASEDIR, 'bin/mysqld')));
    console.log(`service-ready mysql-${index}`);
    checkpoint();
    if (args.fault === 'after-service') throw new Error('Injected failure after owned service start');
    try {
      for (const format of ['module', 'commonjs']) {
        const database = `contract_${format}`;
        await service.admin.query(`CREATE DATABASE \`${database}\``);
        const connection = await service.connect(database);
        const query = async (sql) => (await connection.query(sql))[0];
        await exercise(
          installed,
          `mysql-${index}-${format}`,
          'mysql',
          format,
          `mysql://root@127.0.0.1:${service.port}/${database}`,
          query,
        );
      }
    } finally {
      await service.stop();
    }
  }
}
async function postgres(installed) {
  const serviceRoot = join(root, 'postgresql');
  mkdirSync(serviceRoot);
  const service = await ownedPostgres({
    root: serviceRoot,
    env,
    run,
    driver: installed.require('pg'),
    report,
    registerStop: (stop) => stops.add(stop),
  });
  report.services.at(-1).initdbSha256 = sha256(readFileSync(join(env.PG_PREFIX, 'bin/initdb')));
  report.services.at(-1).catalogSha256 = sha256(readFileSync(join(env.PG_PREFIX, 'share/postgresql/postgres.bki')));
  report.services.at(-1).binarySha256 = sha256(readFileSync(join(env.PG_PREFIX, 'bin/postgres')));
  console.log('service-ready postgresql');
  checkpoint();
  if (args.fault === 'after-service') throw new Error('Injected failure after owned service start');
  try {
    for (const format of ['module', 'commonjs']) {
      const database = `contract_${format}`;
      await service.client.query(`CREATE DATABASE ${database}`);
      const dbUrl = service.url.replace(/\/postgres$/, '/' + database);
      const driver = installed.require('pg');
      const client = new driver.Client({ connectionString: dbUrl });
      await client.connect();
      try {
        await exercise(
          installed,
          `postgresql-${format}`,
          'postgresql',
          format,
          dbUrl,
          async (sql) => (await client.query(sql)).rows,
        );
      } finally {
        await client.end();
      }
    }
  } finally {
    await service.stop();
  }
}
async function sqlite(installed) {
  const { DatabaseSync } = await import('node:sqlite');
  for (const format of ['module', 'commonjs']) {
    checkpoint();
    const filename = join(root, `sqlite-${format}.db`);
    const handle = new DatabaseSync(filename, { enableForeignKeyConstraints: true });
    try {
      report.sqlite = {
        version: handle.prepare('SELECT sqlite_version() AS v').get().v,
        foreignKeys: handle.prepare('PRAGMA foreign_keys').get(),
        journalMode: handle.prepare('PRAGMA journal_mode').get(),
      };
      await exercise(installed, `sqlite-${format}`, 'sqlite', format, filename, async (sql) => {
        if (/^SELECT/.test(sql))
          return handle
            .prepare(sql)
            .all()
            .map((row) => ({ ...row }));
        handle.exec(sql);
        return [];
      });
    } finally {
      handle.close();
    }
  }
}
async function portClosed(port) {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port });
    socket.setTimeout(1000, () => {
      socket.destroy();
      reject(new Error('Cleanup port probe timed out'));
    });
    socket.once('connect', () => {
      socket.destroy();
      reject(new Error(`Owned port ${port} remains open`));
    });
    socket.once('error', (error) => {
      socket.destroy();
      if (error.code === 'ECONNREFUSED') resolve(true);
      else reject(error);
    });
  });
}
try {
  if (args['exact-node']) assert.equal(process.versions.node, args['exact-node'], 'Exact Node runtime mismatch');
  assert.ok(!args.fault || ['after-service', 'dropped-effect'].includes(args.fault), 'Unknown fault');
  prerequisites(args.engine, env);
  report.artifact = pinnedArchive(args.tarball, args.sha256 ?? archivePin);
  root = mkdtempSync(join(tmpdir(), 'turbine-value-contract-'));
  report.fixtureRoot = root;
  const archive = join(root, 'archive');
  mkdirSync(archive);
  run(root, 'tar', ['-xzf', report.artifact.path, '-C', archive]);
  report.archivePayload = files(join(archive, 'package'));
  report.npmVersion = run(root, 'npm', ['--version']).stdout.trim();
  const installed = install();
  report.harnessHashes = files(here);
  for (const engine of args.engine === 'all' ? ['sqlite', 'postgresql', 'mysql'] : [args.engine]) {
    checkpoint();
    try {
      await { sqlite, postgresql: postgres, mysql }[engine](installed);
    } catch (error) {
      report.cases.push({ label: `${engine}/native-prerequisite-or-service`, passed: false, error: error.stack });
    }
  }
  assert.ok(report.cases.length, 'No native consumer cases ran');
  assert.equal(
    report.cases.filter((item) => !item.passed).length,
    0,
    'Native consumer contract scopes failed; inspect report.json',
  );
  checkpoint();
  report.passed = true;
} catch (error) {
  report.error = error.stack;
  process.exitCode = interrupted === 'SIGINT' ? 130 : interrupted === 'SIGTERM' ? 143 : 1;
} finally {
  const cleanupErrors = [];
  for (const stop of stops)
    try {
      await stop();
    } catch (error) {
      cleanupErrors.push(error.stack);
    }
  for (const service of report.services) {
    try {
      assert.equal(service.stopped, true);
      assert.equal(service.connectionsClosed, true);
      assert.throws(() => process.kill(service.pid, 0), { code: 'ESRCH' });
      service.independentPidGone = true;
      service.independentPortClosed = await portClosed(service.port);
    } catch (error) {
      cleanupErrors.push(error.stack);
    }
  }
  try {
    if (root) rmSync(root, { recursive: true, force: true });
  } catch (error) {
    cleanupErrors.push(error.stack ?? String(error));
  }
  report.cleanup = {
    servicesStopped: report.services.every(
      (service) => service.stopped && service.independentPidGone && service.independentPortClosed,
    ),
    fixtureRemoved: root ? !existsSync(root) : true,
    errors: cleanupErrors,
  };
  try {
    if (report.artifact)
      report.artifactUnchanged =
        pinnedArchive(report.artifact.path, report.artifact.sha256).sha256 === report.artifact.sha256;
  } catch (error) {
    report.artifactUnchanged = false;
    cleanupErrors.push(error.stack ?? String(error));
  }
  if (cleanupErrors.length) {
    report.passed = false;
    process.exitCode = 1;
  }
  if (interrupted) {
    report.passed = false;
    report.error = `Interrupted by ${interrupted}`;
    process.exitCode = interrupted === 'SIGINT' ? 130 : 143;
  }
  report.finished = new Date().toISOString();
  save(join(out, 'report.json'), report);
  process.off('SIGINT', onSignal);
  process.off('SIGTERM', onSignal);
  console.log(
    JSON.stringify({
      passed: report.passed,
      cases: report.cases.length,
      failed: report.cases.filter((item) => !item.passed).map((item) => item.label),
      report: join(out, 'report.json'),
      cleanup: report.cleanup,
    }),
  );
}
