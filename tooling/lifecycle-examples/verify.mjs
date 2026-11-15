#!/usr/bin/env node
import assert from 'node:assert/strict';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { artifact, assertRows, command, configFile, prerequisite, scrub, sha256 } from './harness.mjs';
import { ownedMysql } from './mysql-service.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const examples = resolve(here, '../../examples/native-lifecycles');
const args = {};
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i];
  assert.ok(['--tarball', '--engine', '--report', '--exact-node'].includes(key), `Unknown option: ${key}`);
  assert.ok(process.argv[i + 1] && !process.argv[i + 1].startsWith('--'), `${key} requires a value`);
  args[key.slice(2)] = process.argv[i + 1];
}
const reportPath = args.report ? resolve(args.report) : join(mkdtempSync(join(tmpdir(), 'turbine-lifecycle-')), 'report.json');
const report = {
  formatVersion: 1,
  started: new Date().toISOString(),
  engine: args.engine,
  node: process.version,
  runtime: process.versions,
  platform: process.platform,
  arch: process.arch,
  certification: 'Only the recorded engine, service versions, modes and consumer formats were exercised.',
  steps: [],
  effects: [],
  controls: [],
  consumers: [],
  services: [],
  cleanup: {},
  passed: false,
};
let root;
let activeService;
let finishing;
let interrupted;
const serviceStops = new Set();
const env = { ...process.env, NODE_OPTIONS: '', NODE_PATH: '', DATABASE_URL: '', NO_COLOR: '1', EXAMPLE_SEED_FAIL: '' };
const run = (cwd, exe, argv, childEnv = env, expected = 0) => command(report, root, cwd, exe, argv, childEnv, expected);
const effect = (label, value) => {
  report.effects.push({ label, value });
  return value;
};

async function refusal(label, body, pattern) {
  let message;
  try {
    await body();
  } catch (error) {
    message = error.message;
  }
  assert.ok(message, `${label}: negative control unexpectedly passed`);
  assert.match(message, pattern, `${label}: wrong refusal`);
  report.controls.push({ label, expectedError: scrub(message, root) });
}

function copyPublic(project, engine) {
  for (const filename of ['app.ts', 'turbine.config.ts', 'schema.ts', 'seed.ts']) {
    cpSync(join(examples, engine, filename), join(project.dir, filename));
  }
  cpSync(join(examples, 'tsconfig.json'), join(project.dir, 'tsconfig.json'));
  cpSync(join(here, `type-controls-${engine}.ts`), join(project.dir, 'type-controls.ts'));
  writeFileSync(
    join(project.dir, 'tsconfig.controls.json'),
    JSON.stringify({
      extends: './tsconfig.json',
      include: ['type-controls.ts'],
      compilerOptions: { noEmit: true },
    }),
  );
}

function install(name, type, engine) {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ private: true, type }));
  // These are consumer development tools, not new ORM runtime dependencies.
  const packages = [report.artifact.path, 'typescript@6.0.3', '@types/node@22.20.4', 'tsx@4.23.15'];
  if (engine === 'mysql') packages.push('mysql2@3.24.5');
  run(dir, 'npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--save-exact', ...packages]);
  const require = createRequire(join(dir, 'package.json'));
  const pkg = join(dir, 'node_modules/turbine-orm');
  assert.equal(lstatSync(pkg).isSymbolicLink(), false, 'Packed package must not be a repository symlink');
  assert.ok(realpathSync(pkg).startsWith(`${realpathSync(dir)}/`), 'Package must live inside this consumer');
  const manifest = JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8'));
  assert.deepEqual(Object.keys(manifest.dependencies), ['pg']);
  const bin = join(pkg, manifest.bin.turbine);
  const versions = {};
  for (const dep of [
    'turbine-orm',
    'pg',
    'typescript',
    '@types/node',
    'tsx',
    ...(engine === 'mysql' ? ['mysql2'] : []),
  ]) {
    versions[dep] = JSON.parse(readFileSync(join(dir, 'node_modules', dep, 'package.json'), 'utf8')).version;
  }
  report.consumers.push({ name, type, versions, lockSha256: sha256(readFileSync(join(dir, 'package-lock.json'))) });
  const project = {
    dir,
    require,
    bin,
    env: { ...env },
    cli(argv, expected = 0, extraEnv = {}) {
      if (argv[0] !== 'init') configFile(dir);
      return run(dir, process.execPath, [bin, ...argv], { ...project.env, ...extraEnv }, expected);
    },
  };
  return project;
}

function migration(project, name, contents) {
  project.cli(['migrate', 'create', name]);
  const matches = readdirSync(join(project.dir, 'turbine/migrations')).filter((file) => file.endsWith(`_${name}.sql`));
  assert.equal(matches.length, 1, 'create must produce exactly one SQL migration');
  const path = join(project.dir, 'turbine/migrations', matches[0]);
  writeFileSync(path, contents);
  return { path, name: matches[0].slice(0, -4), checksum: sha256(contents) };
}

function compileAndRun(project) {
  project.cli(['pull', '--no-timestamp', '--import-ext', 'js']);
  const generated = ['index.ts', 'metadata.ts', 'types.ts'];
  for (const file of generated)
    assert.ok(readFileSync(join(project.dir, 'generated/turbine', file), 'utf8').length > 100);
  run(
    project.dir,
    process.execPath,
    [join(project.dir, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.json'],
    project.env,
  );
  run(
    project.dir,
    process.execPath,
    [join(project.dir, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.controls.json'],
    project.env,
  );
  const output = run(project.dir, process.execPath, ['build/app.js'], project.env);
  assert.deepEqual(JSON.parse(output.stdout), { id: 1, displayName: 'Updated by the app' });
}

function initialSql(engine) {
  return readFileSync(join(examples, engine, 'initial.sql'), 'utf8');
}
const upSql = (text) => text.split('-- UP\n')[1].split('-- DOWN')[0].trim();

async function sharedLifecycle(project, engine, existing, query, rows, tables) {
  const beforeInit = JSON.parse(JSON.stringify(await rows()));
  project.cli(['init', '--engine', engine, '--yes']);
  const migrations = join(project.dir, 'turbine/migrations');
  const files = readdirSync(migrations).filter((file) => file.endsWith('.sql'));
  assert.equal(files.length, existing ? 0 : 1, 'Init scaffolds SQL only for an empty catalog');
  assert.deepEqual(JSON.parse(JSON.stringify(await rows())), beforeInit, 'Init must preserve rows');
  if (!existing) {
    assert.deepEqual(await tables(), [], 'Fresh init must not apply its migration');
    writeFileSync(join(migrations, files[0]), initialSql(engine));
  }
  // Keep generated init config for its preservation check, then use the public config.
  const configPath = join(project.dir, 'turbine.config.ts');
  const initConfig = readFileSync(configPath, 'utf8');
  project.cli(['init', '--engine', engine, '--yes', '--force']);
  assert.equal(readFileSync(configPath, 'utf8'), initConfig, 'Repeated init preserves config bytes');
  copyPublic(project, engine);
  migration(
    project,
    'example_01_marker',
    "-- UP\nINSERT INTO users (id, display_name) VALUES (10, 'Migration row');\n\n-- DOWN\nDELETE FROM users WHERE id = 10;\n",
  );
  project.cli(['migrate', 'status', '--exit-code'], 2);
  project.cli(['migrate', 'up']);
  project.cli(['migrate', 'status', '--exit-code']);
  project.cli(['status']);
  compileAndRun(project);
  const expected = [
    { id: 1, display_name: 'Updated by the app' },
    { id: 10, display_name: 'Migration row' },
    ...(existing ? [{ id: 99, display_name: 'Existing row' }] : []),
  ];
  assertRows(await rows(), expected, 'generated client read/write');
  effect(`${engine}/${project.dir.split('/').pop()}/app`, expected);
  // Prove that a successful process exit without the write would fail verification.
  if (engine === 'sqlite') await query('BEGIN');
  else await query('START TRANSACTION');
  try {
    await query('DELETE FROM users WHERE id = 1');
    await refusal('missing stored app row', async () => assertRows(await rows(), expected), /exact stored rows differ/);
  } finally {
    await query('ROLLBACK');
  }
  assertRows(await rows(), expected, 'row omission control restored');
  return expected;
}

async function sqliteCases() {
  const { DatabaseSync } = await import('node:sqlite');
  const probe = new DatabaseSync(':memory:');
  try {
    assert.equal(typeof probe.setAuthorizer, 'function', 'Native SQLite authorization is required');
    report.sqliteVersion = probe.prepare('SELECT sqlite_version() AS version').get().version;
  } finally {
    probe.close();
  }
  for (const type of ['module', 'commonjs']) {
    for (const existing of [false, true]) {
      const project = install(`sqlite-${type}-${existing ? 'existing' : 'fresh'}`, type, 'sqlite');
      project.env.DATABASE_URL = join(project.dir, 'app.sqlite');
      const open = () => new DatabaseSync(project.env.DATABASE_URL);
      if (existing) {
        const db = open();
        try {
          db.exec(upSql(initialSql('sqlite')));
          db.exec("INSERT INTO users VALUES (99, 'Existing row')");
        } finally {
          db.close();
        }
      }
      let db;
      const query = async (sql) => {
        if (!db) db = open();
        db.exec(sql);
      };
      const rows = async () => {
        if (!existsSync(project.env.DATABASE_URL)) return [];
        const handle = db ?? open();
        try {
          if (!handle.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='users'").get()) return [];
          return handle.prepare('SELECT id, display_name FROM users ORDER BY id').all();
        } finally {
          if (!db) handle.close();
        }
      };
      const tables = async () => {
        const handle = open();
        try {
          return handle
            .prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
            .all()
            .map((row) => row.name);
        } finally {
          handle.close();
        }
      };
      try {
        console.log(`SQLite ${type}, ${existing ? 'existing' : 'fresh'}`);
        let expected = await sharedLifecycle(project, 'sqlite', existing, query, rows, tables);
        // Seed code is inert until explicitly invoked; failed callback leaves no row.
        assert.ok(!(await rows()).some((row) => row.id === 2));
        assert.match(project.cli(['seed'], 1, { EXAMPLE_SEED_FAIL: '1' }).output, /Requested seed rollback/);
        assertRows(await rows(), expected, 'seed callback rollback');
        project.cli(['seed']);
        project.cli(['seed']);
        expected = [expected[0], { id: 2, display_name: 'Added by the seed' }, ...expected.slice(1)];
        assertRows(await rows(), expected, 'seed callback rerun');
        const schemaBefore = await tables();
        project.cli(['push', '--schema-file', './schema.ts', '--dry-run', '--exit-code'], 2);
        assert.deepEqual(await tables(), schemaBefore, 'Schema preview creates no table');
        assertRows(await rows(), expected, 'schema preview rows');
        project.cli(['push', '--schema-file', './schema.ts']);
        assert.ok((await tables()).includes('notes'));
        project.cli(['push', '--schema-file', './schema.ts', '--dry-run', '--exit-code']);
        project.cli(['migrate', 'status', '--exit-code']);
        await query('CREATE TABLE dependents (id INTEGER PRIMARY KEY, user_id INTEGER REFERENCES users(id))');
        await query('INSERT INTO dependents VALUES (1, 1)');
        const refusedSchema = readFileSync(join(project.dir, 'schema.ts'), 'utf8').replace(
          "display_name: { type: 'text', notNull: true }",
          "display_name: { type: 'text', notNull: true, default: \"'fallback'\" }",
        );
        assert.notEqual(refusedSchema, readFileSync(join(project.dir, 'schema.ts'), 'utf8'));
        writeFileSync(join(project.dir, 'refused-schema.ts'), refusedSchema);
        const catalogBeforeRefusal = db.prepare('SELECT name, sql FROM sqlite_schema ORDER BY name').all();
        assert.match(
          project.cli(['push', '--schema-file', './refused-schema.ts'], 1).output,
          /foreign key|inbound|referenc|dependen/i,
        );
        assert.match(
          project.cli(['push', '--schema-file', './refused-schema.ts', '--allow-destructive'], 1).output,
          /cannot bypass|preserves data/i,
        );
        assert.deepEqual(db.prepare('SELECT name, sql FROM sqlite_schema ORDER BY name').all(), catalogBeforeRefusal);
        assertRows(
          db.prepare('SELECT id, user_id FROM dependents').all(),
          [{ id: 1, user_id: 1 }],
          'refused rebuild preserves dependent row',
        );
        assertRows(await rows(), expected, 'refused rebuild preserves users');
        await query('DROP TABLE dependents');
        const bad = migration(
          project,
          'example_02_atomic_failure',
          "-- UP\nINSERT INTO users VALUES (3, 'Must roll back');\nINSERT INTO users VALUES (10, 'Duplicate key');\n-- DOWN\nDELETE FROM users WHERE id = 3;\n",
        );
        assert.match(project.cli(['migrate', 'up'], 1).output, /UNIQUE|constraint/i);
        assertRows(await rows(), expected, 'native migration rollback');
        project.cli(['migrate', 'status', '--exit-code'], 2);
        rmSync(bad.path);
        const forbidden = migration(
          project,
          'example_03_native_refusal',
          '-- UP\nPRAGMA user_version = 42;\n-- DOWN\nPRAGMA user_version = 0;\n',
        );
        assert.match(project.cli(['migrate', 'up'], 1).output, /PRAGMA|unsupported|not allowed/i);
        assertRows(await rows(), expected, 'native SQL refusal');
        rmSync(forbidden.path);
        assert.match(
          project.cli(
            ['migrate', 'recover', 'not_applied', '0'.repeat(64), 'rolled-back', '--acknowledge-partial-ddl'],
            1,
          ).output,
          /recover|unsupported|not supported|unknown/i,
        );
        assertRows(await rows(), expected, 'SQLite refuses MySQL recovery acknowledgment');
        project.cli(['migrate', 'status', '--exit-code']);
        effect(`${project.dir.split('/').pop()}/final`, {
          rows: await rows(),
          tables: await tables(),
          atomicRollback: true,
          nativeRefusal: true,
          dependentRebuildRefused: true,
          partialDdlRecoveryRefused: true,
        });
        // A missing config cannot silently select the default PostgreSQL engine.
        rmSync(join(project.dir, 'turbine.config.ts'));
        await refusal('missing consumer config', () => project.cli(['pull']), /Consumer config is required/);
      } finally {
        db?.close();
      }
    }
  }
}

async function mysqlCases() {
  const bootstrap = install('mysql-driver', 'module', 'mysql');
  const driver = bootstrap.require('mysql2/promise');
  const modes = [
    'STRICT_TRANS_TABLES,NO_ENGINE_SUBSTITUTION',
    'STRICT_TRANS_TABLES,NO_ENGINE_SUBSTITUTION,ANSI_QUOTES,NO_BACKSLASH_ESCAPES',
  ];
  for (const [modeIndex, mode] of modes.entries()) {
    const serviceRoot = join(root, `mysql-service-${modeIndex}`);
    mkdirSync(serviceRoot);
    activeService = await ownedMysql({
      root: serviceRoot,
      mode,
      env,
      run,
      driver,
      report,
      registerStop: (stop) => serviceStops.add(stop),
    });
    try {
      for (const type of ['module', 'commonjs']) {
        for (const existing of [false, true]) {
          const name = `mysql-${modeIndex}-${type}-${existing ? 'existing' : 'fresh'}`;
          console.log(name);
          const project = install(name, type, 'mysql');
          const database = `lifecycle_${modeIndex}_${type}_${existing ? 'existing' : 'fresh'}`;
          await activeService.admin.query(`CREATE DATABASE \`${database}\``);
          const connection = await activeService.connect(database);
          project.env.DATABASE_URL = `mysql://root@127.0.0.1:${activeService.port}/${database}`;
          const query = async (sql) => (await connection.query(sql))[0];
          const tables = async () => (await query('SHOW TABLES')).map((row) => Object.values(row)[0]).sort();
          const rows = async () =>
            (await tables()).includes('users') ? query('SELECT id, display_name FROM users ORDER BY id') : [];
          try {
            if (existing) {
              await query(upSql(initialSql('mysql')));
              await connection.execute('INSERT INTO users VALUES (?, ?)', [99, 'Existing row']);
            }
            let expected = await sharedLifecycle(project, 'mysql', existing, query, rows, tables);
            const beforeDiff = await tables();
            project.cli(['diff', '--schema-file', './schema.ts', '--exit-code'], 2);
            assert.deepEqual(await tables(), beforeDiff, 'MySQL diff must remain read-only');
            assertRows(await rows(), expected, 'MySQL diff rows');
            project.cli(['migrate', 'create', 'example_02_notes', '--from-diff', '--schema-file', './schema.ts']);
            const scaffold = readdirSync(join(project.dir, 'turbine/migrations')).find((file) =>
              file.endsWith('_example_02_notes.sql'),
            );
            assert.ok(scaffold, 'from-diff must write a real migration');
            const sql = readFileSync(join(project.dir, 'turbine/migrations', scaffold), 'utf8');
            assert.match(sql, /-- UP[\s\S]+CREATE TABLE `notes`/);
            assert.match(sql, /-- DOWN[\s\S]+DROP TABLE `notes`/);
            effect(`${name}/reviewed-scaffold`, { sha256: sha256(sql), sql });
            assert.deepEqual(await tables(), beforeDiff, 'Scaffolding must not apply SQL');
            project.cli(['migrate', 'up']);
            project.cli(['diff', '--schema-file', './schema.ts', '--exit-code']);
            project.cli(['migrate', 'status', '--exit-code']);
            const beforeTools = await rows();
            const caps = JSON.parse(project.cli(['capabilities']).stdout);
            assert.equal(caps.engine, 'mysql');
            assert.equal(caps.connectivity, 'not-probed');
            const schema = JSON.parse(project.cli(['schema']).stdout);
            const toolTables = schema.tables.map((table) => table.name).sort();
            assert.deepEqual(
              toolTables.filter((name) => !name.startsWith('_turbine_')),
              ['notes', 'users'],
            );
            const compiled = JSON.parse(
              project.cli(['compile', JSON.stringify({ table: 'users', args: { where: { id: 1 }, limit: 1 } })]).stdout,
            );
            assert.equal(compiled.ok, true);
            assert.equal(compiled.executed, false);
            effect(`${name}/json-tools`, {
              tables: toolTables,
              engine: caps.engine,
              executed: compiled.executed,
              sql: compiled.sql,
            });
            assert.match(compiled.sql, /`users`/);
            assert.match(compiled.sql, /:p1/);
            assert.match(
              project.cli(['compile', JSON.stringify({ table: 'users', operation: 'deleteMany', args: {} })], 1).output,
              /operation|read/i,
            );
            assertRows(await rows(), beforeTools, 'read-only JSON tools');
            const partial = migration(
              project,
              'example_03_partial_ddl',
              readFileSync(join(examples, 'mysql/partial-ddl.sql'), 'utf8'),
            );
            assert.match(project.cli(['migrate', 'up'], 1).output, /partial|duplicate/i);
            assertRows(await query('SELECT id FROM partial_items'), [{ id: 1 }], 'native partial DDL survives');
            const dirty = await query('SELECT * FROM _turbine_migration_state');
            assert.equal(dirty.length, 1);
            effect(`${name}/dirty`, dirty);
            project.cli(['migrate', 'status', '--exit-code'], 2);
            assert.match(project.cli(['migrate', 'up'], 1).output, /dirty|recover|partial/i);
            assert.match(
              project.cli(['migrate', 'recover', partial.name, partial.checksum, 'rolled-back'], 1).output,
              /acknowledge/i,
            );
            assert.match(
              project.cli(
                ['migrate', 'recover', partial.name, '0'.repeat(64), 'rolled-back', '--acknowledge-partial-ddl'],
                1,
              ).output,
              /checksum|match/i,
            );
            assertRows(await query('SELECT id FROM partial_items'), [{ id: 1 }], 'refused recovery changes no rows');
            assert.deepEqual(
              await query('SELECT * FROM _turbine_migration_state'),
              dirty,
              'Refused recovery must retain journal',
            );
            // Reconcile the deliberately failed UP to its absent state before acknowledging.
            await query('DROP TABLE partial_items');
            project.cli([
              'migrate',
              'recover',
              partial.name,
              partial.checksum,
              'rolled-back',
              '--acknowledge-partial-ddl',
            ]);
            assert.deepEqual(await query('SELECT * FROM _turbine_migration_state'), []);
            assert.equal((await tables()).includes('partial_items'), false, 'Recovery must not replay SQL');
            rmSync(partial.path); // The intentionally failing file was never applied.
            project.cli(['migrate', 'status', '--exit-code']);
            assert.match(project.cli(['seed'], 1, { EXAMPLE_SEED_FAIL: '1' }).output, /Requested seed rollback/);
            assertRows(await rows(), expected, 'MySQL seed callback rollback');
            project.cli(['seed']);
            project.cli(['seed']);
            expected = [expected[0], { id: 2, display_name: 'Added by the seed' }, ...expected.slice(1)];
            assertRows(await rows(), expected, 'MySQL final rows');
            effect(`${name}/final`, {
              rows: await rows(),
              tables: await tables(),
              seed: 'DML rollback and repeated callback verified',
              recovery: 'manually reconciled then acknowledged',
            });
          } finally {
            await activeService.admin.query(`DROP DATABASE \`${database}\``);
          }
        }
      }
      const [remaining] = await activeService.admin.query("SHOW DATABASES LIKE 'lifecycle\\_%'");
      assert.deepEqual(remaining, [], 'All owned catalogs must be removed');
    } finally {
      await activeService.stop();
      activeService = undefined;
    }
  }
}

async function omissionControls() {
  await refusal('missing tarball', () => artifact(join(root, 'absent.tgz')), /Built package tarball is required/);
  await refusal(
    'missing native service prerequisite',
    () => prerequisite('mysql', {}, process.versions.node),
    /MYSQL_BASEDIR is required/,
  );
  const project = install('no-mysql-driver', 'module', 'sqlite');
  assert.throws(() => project.require.resolve('mysql2/promise'), /Cannot find module/);
  // Driver absence must be diagnosed before any connection is attempted.
  const output = run(
    project.dir,
    process.execPath,
    [project.bin, 'init', '--engine', 'mysql', '--yes'],
    {
      ...project.env,
      DATABASE_URL: 'mysql://root@127.0.0.1:9/missing_driver',
    },
    1,
  ).output;
  assert.match(output, /mysql2/);
  assert.doesNotMatch(output, /ECONNREFUSED/, 'Missing driver must not become a misleading network error');
  report.controls.push({ label: 'missing optional mysql2 driver', expectedError: scrub(output, root) });
}

function finish() {
  if (finishing) return finishing;
  finishing = (async () => {
    const stopped = await Promise.allSettled([...serviceStops].map((stop) => stop()));
    const errors = stopped
      .filter((result) => result.status === 'rejected')
      .map((result) => scrub(result.reason?.message ?? result.reason, root));
    if (errors.length) {
      report.cleanup.errors = errors;
      report.passed = false;
      process.exitCode = 1;
    }
    report.cleanup.servicesStopped = report.services.every((service) => service.stopped);
    // Retain a failed service's datadir if it could not be stopped safely.
    if (root && report.cleanup.servicesStopped) rmSync(root, { recursive: true, force: true });
    report.cleanup.fixtureRemoved = root ? !existsSync(root) : true;
    if (interrupted) {
      report.passed = false;
      report.error = `Interrupted by ${interrupted}`;
    }
    report.finished = new Date().toISOString();
    mkdirSync(dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    console.log(`Lifecycle verification ${report.passed ? 'passed' : 'failed'}: ${reportPath}`);
  })();
  return finishing;
}

for (const [signal, code] of [
  ['SIGINT', 130],
  ['SIGTERM', 143],
]) {
  process.once(signal, () => {
    interrupted = signal;
    void finish().finally(() => process.exit(code));
  });
}

try {
  assert.ok(['sqlite', 'mysql'].includes(args.engine), '--engine sqlite|mysql is required');
  report.artifact = artifact(args.tarball);
  prerequisite(args.engine, env);
  if (args['exact-node'])
    assert.equal(process.versions.node, args['exact-node'], 'Exact requested Node version is required');
  root = mkdtempSync(join(tmpdir(), 'turbine-lifecycles-'));
  report.fixtureRoot = root;
  report.npm = run(root, 'npm', ['--version']).stdout.trim();
  report.exampleHashes = {};
  report.exampleHashes['tsconfig.json'] = sha256(readFileSync(join(examples, 'tsconfig.json')));
  for (const engine of ['sqlite', 'mysql']) {
    for (const file of readdirSync(join(examples, engine)))
      report.exampleHashes[`${engine}/${file}`] = sha256(readFileSync(join(examples, engine, file)));
  }
  report.verifierHashes = {};
  for (const file of readdirSync(here).filter((file) => /\.(?:mjs|ts)$/.test(file))) {
    report.verifierHashes[file] = sha256(readFileSync(join(here, file)));
  }
  await omissionControls();
  if (args.engine === 'sqlite') await sqliteCases();
  else await mysqlCases();
  report.passed = true;
} catch (error) {
  report.error = scrub(error.stack ?? error.message, root);
  console.error(report.error);
  process.exitCode = 1;
} finally {
  await finish();
}
