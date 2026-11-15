#!/usr/bin/env node
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertRows, command, prerequisite, scrub, sha256 } from '../lifecycle-examples/harness.mjs';
import { ownedMysql } from '../lifecycle-examples/mysql-service.mjs';
import { artifactPair, files, installedPayload, payloadTransition, preserved, recovered } from './harness.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const examples = resolve(here, '../../examples/native-lifecycles');
const args = {};
// Parse inside the recorded failure boundary below.
const report = {
  formatVersion: 1,
  started: new Date().toISOString(),
  passed: false,
  claim: 'Unreleased equal-version ARTIFACT upgrade; no registry or semver upgrade certification.',
  runtime: process.versions,
  platform: process.platform,
  arch: process.arch,
  steps: [],
  effects: [],
  consumers: [],
  services: [],
  controls: [],
  cleanup: {},
};
let root;
let reportPath = join(tmpdir(), `turbine-artifact-upgrade-${process.pid}.json`);
let interrupted;
let finishing;
const stops = new Set();
const env = { ...process.env, NODE_OPTIONS: '', NODE_PATH: '', DATABASE_URL: '', NO_COLOR: '1', EXAMPLE_SEED_FAIL: '' };
const running = () => assert.ok(!interrupted && !finishing, 'Workload is stopping');
const run = (cwd, exe, argv, childEnv = env, expected = 0) => {
  running();
  return command(report, root, cwd, exe, argv, childEnv, expected);
};
const plain = (value) => JSON.parse(JSON.stringify(value));
const effect = (label, value) => report.effects.push({ label, value: plain(value) });
const sources = (dir) =>
  Object.fromEntries(
    Object.keys(files(dir)).map((name) => [
      name,
      {
        sha256: sha256(readFileSync(join(dir, name))),
        source: readFileSync(join(dir, name), 'utf8'),
      },
    ]),
  );

function unpack(label) {
  const dir = join(root, `${label}-payload`);
  mkdirSync(dir);
  const listing = run(root, 'tar', ['-tzf', report.artifacts[label].path]).stdout.trim().split('\n');
  assert.ok(listing.length > 1, 'Archive must contain a package payload');
  for (const name of listing)
    assert.ok(/^package\//.test(name) && !name.split('/').includes('..'), 'Unsafe archive path');
  const detailed = run(root, 'tar', ['-tvzf', report.artifacts[label].path]).stdout.trim().split('\n');
  for (const entry of detailed)
    assert.match(entry, /^[-d]/, 'Archive links and special entries are refused before extraction');
  run(root, 'tar', ['-xzf', report.artifacts[label].path, '-C', dir, '--no-same-owner']);
  const pkg = join(dir, 'package');
  return { files: files(pkg), manifest: JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8')) };
}

function install(name, type, engine) {
  const dir = join(root, name);
  mkdirSync(dir);
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ private: true, type }));
  const packages = [report.artifacts.baseline.path, 'typescript@6.0.3', '@types/node@22.20.4', 'tsx@4.23.15'];
  if (engine === 'mysql') packages.push('mysql2@3.24.5');
  run(dir, 'npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--save-exact', ...packages]);
  const require = createRequire(join(dir, 'package.json'));
  const baselineDigest = installedPayload(dir, report.payloads.baseline.files);
  const manifest = report.payloads.baseline.manifest;
  assert.deepEqual(Object.keys(manifest.dependencies), ['pg']);
  const record = { name, type, engine, baselineDigest, versions: {}, locks: {} };
  for (const dep of [
    'turbine-orm',
    'typescript',
    '@types/node',
    'tsx',
    'pg',
    ...(engine === 'mysql' ? ['mysql2'] : []),
  ]) {
    record.versions[dep] = JSON.parse(readFileSync(join(dir, 'node_modules', dep, 'package.json'), 'utf8')).version;
  }
  record.locks.baseline = sha256(readFileSync(join(dir, 'package-lock.json')));
  report.consumers.push(record);
  const project = {
    dir,
    require,
    record,
    env: { ...env },
    bin: join(dir, 'node_modules/turbine-orm', manifest.bin.turbine),
  };
  project.cli = (argv, expected = 0, extra = {}) =>
    run(dir, process.execPath, [project.bin, ...argv], { ...project.env, ...extra }, expected);
  return project;
}

function migration(project, name, sql) {
  project.cli(['migrate', 'create', name]);
  const dir = join(project.dir, 'turbine/migrations');
  const found = readdirSync(dir).filter((file) => file.endsWith(`_${name}.sql`));
  assert.equal(found.length, 1);
  const path = join(dir, found[0]);
  writeFileSync(path, sql);
  return { path, name: found[0].slice(0, -4), checksum: sha256(sql), sql };
}

function compile(project, phase) {
  const compiler = join(project.dir, 'node_modules/typescript/bin/tsc');
  run(project.dir, process.execPath, [compiler, '-p', 'tsconfig.json'], project.env);
  run(project.dir, process.execPath, [compiler, '-p', 'tsconfig.controls.json'], project.env);
  const output = run(project.dir, process.execPath, ['build/app.js'], { ...project.env, UPGRADE_PHASE: phase });
  assert.deepEqual(JSON.parse(output.stdout), { id: 1, displayName: phase });
}

function application(project, engine) {
  for (const file of ['turbine.config.ts']) cpSync(join(examples, engine, file), join(project.dir, file));
  const config = JSON.parse(readFileSync(join(examples, 'tsconfig.json'), 'utf8'));
  config.include = ['app.ts', 'generated/**/*.ts', 'turbine.config.ts'];
  writeFileSync(join(project.dir, 'tsconfig.json'), JSON.stringify(config));
  cpSync(join(here, `../lifecycle-examples/type-controls-${engine}.ts`), join(project.dir, 'type-controls.ts'));
  writeFileSync(
    join(project.dir, 'tsconfig.controls.json'),
    JSON.stringify({ extends: './tsconfig.json', include: ['type-controls.ts'], compilerOptions: { noEmit: true } }),
  );
  writeFileSync(
    join(project.dir, 'app.ts'),
    `import assert from 'node:assert/strict';
import { turbine } from './generated/turbine/index.js';
async function main() {
  const url = process.env.DATABASE_URL;
  const phase = process.env.UPGRADE_PHASE;
  if (!url || !phase) throw new Error('Missing application inputs');
  const db = ${engine === 'mysql' ? 'await ' : ''}turbine(url);
  try {
    await db.users.upsert({ where: { id: 1 }, create: { id: 1, displayName: phase }, update: { displayName: phase } });
    await db.users.update({ where: { id: 1 }, data: { displayName: phase } });
    const row = await db.users.findUniqueOrThrow({ where: { id: 1 } });
    const name: string = row.displayName;
    assert.equal(name, phase);
    console.log(JSON.stringify({ id: row.id, displayName: name }));
  } finally { await db.disconnect(); }
}
void main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
`,
  );
}

async function lifecycle(project, engine, existing, db) {
  const { query, rows, history, schema } = db;
  const name = project.record.name;
  const initial = readFileSync(join(examples, engine, 'initial.sql'), 'utf8');
  if (existing) {
    await query(initial.split('-- UP\n')[1].split('-- DOWN')[0]);
    await query("INSERT INTO users VALUES (99, 'Existing row')");
  }
  const beforeInit = plain(await rows());
  project.cli(['init', '--engine', engine, '--yes']);
  assert.deepEqual(plain(await rows()), beforeInit, 'Init preserves existing data');

  const migrationsDir = join(project.dir, 'turbine/migrations');
  const initFiles = readdirSync(migrationsDir).filter((file) => file.endsWith('.sql'));
  assert.equal(initFiles.length, existing ? 0 : 1);
  if (!existing) writeFileSync(join(migrationsDir, initFiles[0]), initial);
  application(project, engine);
  migration(
    project,
    'upgrade_01_baseline',
    "-- UP\nINSERT INTO users VALUES (10, 'Migration row');\n-- DOWN\nDELETE FROM users WHERE id = 10;\n",
  );
  project.cli(['migrate', 'status', '--exit-code'], 2);
  project.cli(['migrate', 'up']);
  project.cli(['migrate', 'status', '--exit-code']);
  project.cli(['pull', '--no-timestamp', '--import-ext', 'js']);
  compile(project, 'baseline');
  const expected = (phase, seeded = false) => [
    { id: 1, display_name: phase },
    ...(seeded ? [{ id: 2, display_name: 'Added by the seed' }] : []),
    { id: 10, display_name: 'Migration row' },
    ...(existing ? [{ id: 99, display_name: 'Existing row' }] : []),
  ];
  assertRows(await rows(), expected('baseline'), 'baseline generated client');
  const baseline = {
    rows: plain(await rows()),
    history: plain(await history()),
    schema: plain(await schema()),
    generated: sources(join(project.dir, 'generated/turbine')),
    migrations: sources(migrationsDir),
  };
  assert.ok(baseline.history.length);
  for (const row of baseline.history) assert.equal(row.checksum, baseline.migrations[`${row.name}.sql`].sha256);
  project.record.baseline = baseline;
  project.record.applicationSource = readFileSync(join(project.dir, 'app.ts'), 'utf8');
  const checkBaseline = async () => {
    preserved(await history(), baseline.history, 'baseline history/checksums');
    assert.deepEqual(await schema(), baseline.schema, 'baseline catalog retained');
    assert.deepEqual(sources(migrationsDir), baseline.migrations, 'original SQL bytes retained');
    assert.deepEqual(
      sources(join(project.dir, 'generated/turbine')),
      baseline.generated,
      'original generated source retained',
    );
  };
  run(project.dir, 'npm', [
    'install',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    '--save-exact',
    report.artifacts.candidate.path,
  ]);
  const candidateDigest = installedPayload(project.dir, report.payloads.candidate.files);
  assert.notEqual(candidateDigest, project.record.baselineDigest, 'Installed bytes must actually change');
  project.record.candidateDigest = candidateDigest;
  project.record.locks.candidate = sha256(readFileSync(join(project.dir, 'package-lock.json')));
  assert.equal(
    JSON.parse(readFileSync(join(project.dir, 'node_modules/turbine-orm/package.json'), 'utf8')).version,
    project.record.versions['turbine-orm'],
  );
  await checkBaseline();
  assertRows(await rows(), baseline.rows, 'same app after artifact installation');
  // Compile AND execute the original source before any candidate generation.
  compile(project, 'candidate-old-client');
  assertRows(await rows(), expected('candidate-old-client'), 'old generated client against new bytes');
  await checkBaseline();
  await db.ownership();
  effect(`${name}/old-client-compatibility`, {
    rows: await rows(),
    history: await history(),
    ownership: 'app-owned client disconnects; observer remains usable',
  });

  // Demand real diagnostics as well as the checked @ts-expect-error controls.
  const invalid = readFileSync(join(project.dir, 'type-controls.ts'), 'utf8').replace(/^.*@ts-expect-error.*\n/gm, '');
  writeFileSync(join(project.dir, 'invalid.ts'), invalid);
  writeFileSync(
    join(project.dir, 'tsconfig.invalid.json'),
    JSON.stringify({ extends: './tsconfig.controls.json', include: ['invalid.ts'] }),
  );
  const diagnostics = run(
    project.dir,
    process.execPath,
    [join(project.dir, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.invalid.json'],
    project.env,
    2,
  ).output;
  assert.match(invalid, /select: \{ missingField: true \}/);
  assert.match(diagnostics, /invalid\.ts\(5,39\): error TS2322: Type 'true' is not assignable to type 'never'/);
  assert.match(diagnostics, /string.*number|number.*string/);
  if (engine === 'mysql') assert.match(diagnostics, /users.*Promise|Promise.*users/);
  effect(`${name}/invalid-api-diagnostics`, diagnostics);

  cpSync(join(examples, engine, 'seed.ts'), join(project.dir, 'seed.ts'));
  const tsconfig = JSON.parse(readFileSync(join(project.dir, 'tsconfig.json'), 'utf8'));
  tsconfig.include.push('seed.ts');
  writeFileSync(join(project.dir, 'tsconfig.json'), JSON.stringify(tsconfig));
  assert.match(project.cli(['seed'], 1, { EXAMPLE_SEED_FAIL: '1' }).output, /Requested seed rollback/);
  assertRows(await rows(), expected('candidate-old-client'), 'candidate seed callback rollback');
  project.cli(['seed']);
  project.cli(['seed']);
  assertRows(await rows(), expected('candidate-old-client', true), 'candidate seed reruns');
  preserved(await history(), baseline.history, 'seed preserves migration history');
  project.cli(['generate', '--no-timestamp', '--import-ext', 'js']);
  compile(project, 'candidate-regenerated');
  assertRows(await rows(), expected('candidate-regenerated', true), 'candidate generated client');
  project.record.candidateGenerated = sources(join(project.dir, 'generated/turbine'));

  const cycle = migration(
    project,
    'upgrade_02_cycle',
    "-- UP\nCREATE TABLE upgrade_notes (id INTEGER PRIMARY KEY, label VARCHAR(100) NOT NULL);\nINSERT INTO upgrade_notes VALUES (1, 'Cycle row');\n-- DOWN\nDROP TABLE upgrade_notes;\n",
  );
  project.record.cycle = { name: cycle.name, checksum: cycle.checksum, sql: cycle.sql };
  project.cli(['migrate', 'status', '--exit-code'], 2);
  preserved(await history(), baseline.history, 'pending history');
  project.cli(['migrate', 'deploy']);
  project.cli(['migrate', 'status', '--exit-code']);
  assertRows(
    await query('SELECT id, label FROM upgrade_notes ORDER BY id'),
    [{ id: 1, label: 'Cycle row' }],
    'deploy stored effects',
  );
  const deployed = plain(await history());
  assert.equal(deployed.length, baseline.history.length + 1);
  preserved(deployed.slice(0, -1), baseline.history, 'deploy baseline history');
  assert.equal(deployed.at(-1).name, cycle.name);
  assert.equal(deployed.at(-1).checksum, cycle.checksum);
  project.cli(['migrate', 'deploy']);
  preserved(await history(), deployed, 'repeated deploy history');

  // A private fixture edit proves status/deploy refuse checksum drift, without rebaselining.
  writeFileSync(cycle.path, `${cycle.sql}\n-- changed fixture\n`);
  project.cli(['migrate', 'status', '--exit-code'], 2);
  assert.match(project.cli(['migrate', 'deploy'], 1).output, /checksum|modified|changed|drift/i);
  preserved(await history(), deployed, 'checksum refusal history');
  writeFileSync(cycle.path, cycle.sql);
  project.cli(['migrate', 'down', '--allow-destructive']);
  assert.equal(
    (await schema()).some((item) => item.name === 'upgrade_notes'),
    false,
    'DOWN removes actual table',
  );
  preserved(await history(), baseline.history, 'down restores original history exactly');
  assertRows(await rows(), expected('candidate-regenerated', true), 'down preserves application data');
  project.cli(['migrate', 'status', '--exit-code'], 2);
  project.cli(['migrate', 'up']);
  project.cli(['migrate', 'status', '--exit-code']);
  assertRows(
    await query('SELECT id, label FROM upgrade_notes ORDER BY id'),
    [{ id: 1, label: 'Cycle row' }],
    'up replays pending cycle',
  );
  const afterUp = plain(await history());
  preserved(afterUp.slice(0, -1), baseline.history, 'up original history');
  assert.equal(afterUp.at(-1).checksum, cycle.checksum);
  effect(`${name}/migration-cycle`, {
    deployed,
    afterDown: baseline.history,
    afterUp,
    rows: await rows(),
    schema: await schema(),
  });
  if (engine === 'mysql') await recovery(project, db, afterUp);
  for (const [file, value] of Object.entries(baseline.migrations))
    assert.equal(
      sha256(readFileSync(join(migrationsDir, file))),
      value.sha256,
      'Original migration bytes survive entire workload',
    );
  assert.equal(sha256(readFileSync(cycle.path)), cycle.checksum);
  assertRows(await rows(), expected('candidate-regenerated', true), 'final stored application rows');
  project.cli(['migrate', 'status', '--exit-code']);
  await db.ownership();
  project.record.completed = true;
  effect(`${name}/final`, {
    rows: await rows(),
    history: await history(),
    schema: await schema(),
    migrations: sources(migrationsDir),
  });
}

async function recovery(project, db, before) {
  const { query, history, schema } = db;
  const partial = migration(
    project,
    'upgrade_03_partial',
    "-- UP\nCREATE TABLE partial_items (id INT PRIMARY KEY, label VARCHAR(100) NOT NULL);\nINSERT INTO partial_items VALUES (1, 'Survived DDL');\nINSERT INTO completion_items VALUES (2, 'Manually completed');\nCREATE INDEX partial_label ON partial_items (label);\n-- DOWN\nDROP TABLE partial_items;\nDELETE FROM completion_items WHERE id = 2;\n",
  );
  assert.match(project.cli(['migrate', 'deploy'], 1).output, /partial|doesn't exist|does not exist/i);
  assertRows(
    await query('SELECT id, label FROM partial_items'),
    [{ id: 1, label: 'Survived DDL' }],
    'native partial DDL persisted',
  );
  const dirty = plain(await query('SELECT * FROM _turbine_migration_state'));
  assert.equal(dirty.length, 1);
  assert.equal(dirty[0].name, partial.name);
  assert.equal(dirty[0].checksum, partial.checksum);
  assert.equal(Number(dirty[0].completed_statements), 2);
  preserved(await history(), before, 'failed DDL preserves applied history');
  project.cli(['migrate', 'status', '--exit-code'], 2);
  const dirtySchema = plain(await schema());
  for (const operation of ['deploy', 'up', 'down'])
    assert.match(
      project.cli(['migrate', operation, ...(operation === 'deploy' ? [] : ['--allow-destructive'])], 1).output,
      /dirty|recover|partial/i,
    );
  const recover = (name, hash, outcome, ack = true) => [
    'migrate',
    'recover',
    name,
    hash,
    outcome,
    ...(ack ? ['--acknowledge-partial-ddl'] : []),
  ];
  for (const [label, argv, pattern] of [
    ['absent acknowledgement', recover(partial.name, partial.checksum, 'applied', false), /acknowledge/i],
    [
      'wrong acknowledgement value',
      [...recover(partial.name, partial.checksum, 'applied'), 'false'],
      /Usage|acknowledge/i,
    ],
    ['wrong identity', recover('wrong_name', partial.checksum, 'applied'), /exact|dirty|checksum/i],
    ['wrong checksum', recover(partial.name, '0'.repeat(64), 'applied'), /exact|checksum/i],
    ['invalid outcome status', recover(partial.name, partial.checksum, 'pending'), /Usage|applied|rolled-back/i],
  ]) {
    const output = project.cli(argv, 1).output;
    assert.match(output, pattern);
    preserved(await query('SELECT * FROM _turbine_migration_state'), dirty, `${label} retains dirty journal`);
    preserved(await history(), before, `${label} retains history`);
    assert.deepEqual(await schema(), dirtySchema, `${label} retains schema`);
    assertRows(
      await query('SELECT id, label FROM partial_items'),
      [{ id: 1, label: 'Survived DDL' }],
      `${label} retains partial rows`,
    );
    report.controls.push({ label: `${project.record.name}/${label}`, expectedError: scrub(output, root) });
  }
  writeFileSync(partial.path, `${partial.sql}\n-- fixture checksum drift\n`);
  assert.match(project.cli(recover(partial.name, partial.checksum, 'applied'), 1).output, /unchanged|restore|file/i);
  preserved(await query('SELECT * FROM _turbine_migration_state'), dirty, 'modified file retains dirty journal');
  preserved(await history(), before, 'modified file retains history');
  writeFileSync(partial.path, partial.sql);
  // Explicit, test-only manual completion of the intended remaining SQL and prerequisite.
  // The runner never tries to infer or repair a production schema/data outcome.
  await query('CREATE TABLE completion_items (id INT PRIMARY KEY, label VARCHAR(100) NOT NULL)');
  await query("INSERT INTO completion_items VALUES (2, 'Manually completed')");
  await query('CREATE INDEX partial_label ON partial_items (label)');
  const completed = {
    schema: plain(await schema()),
    partial: plain(await query('SELECT * FROM partial_items ORDER BY id')),
    completion: plain(await query('SELECT * FROM completion_items ORDER BY id')),
    indexes: plain(await query('SHOW INDEX FROM partial_items')),
  };
  assertRows(completed.partial, [{ id: 1, label: 'Survived DDL' }], 'manual partial rows');
  assertRows(completed.completion, [{ id: 2, label: 'Manually completed' }], 'manual completion rows');
  assert.ok(completed.indexes.some((row) => row.Key_name === 'partial_label'));
  project.cli(recover(partial.name, partial.checksum, 'applied'));
  recovered(await history(), await query('SELECT * FROM _turbine_migration_state'), partial.name, partial.checksum);
  preserved((await history()).slice(0, -1), before, 'applied recovery preserves prior history');
  const afterRecovery = plain(await history());
  // Replaying CREATE/INSERT would fail or duplicate writes. Compare schema and both tables too.
  assert.deepEqual(await schema(), completed.schema, 'Recovery executes no schema SQL');
  assertRows(
    await query('SELECT * FROM partial_items ORDER BY id'),
    completed.partial,
    'Recovery executes no earlier INSERT',
  );
  assertRows(
    await query('SELECT * FROM completion_items ORDER BY id'),
    completed.completion,
    'Recovery executes no remaining INSERT',
  );
  assert.deepEqual(
    await query('SHOW INDEX FROM partial_items'),
    completed.indexes,
    'Recovery preserves completed index',
  );
  project.cli(['migrate', 'deploy']);
  project.cli(['migrate', 'status', '--exit-code']);
  preserved(await history(), afterRecovery, 'deploy after recovery is a no-op');
  assert.match(project.cli(recover(partial.name, partial.checksum, 'applied'), 1).output, /exact|dirty|checksum/i);
  assert.equal(sha256(readFileSync(partial.path)), partial.checksum);
  effect(`${project.record.name}/applied-recovery`, {
    dirty,
    manualCompletion: completed,
    history: afterRecovery,
    journal: await query('SELECT * FROM _turbine_migration_state'),
    sql: partial.sql,
    checksum: partial.checksum,
    noReplay: true,
  });
}

async function sqliteCases() {
  const { DatabaseSync } = await import('node:sqlite');
  const probe = new DatabaseSync(':memory:');
  report.sqliteVersion = probe.prepare('SELECT sqlite_version() AS version').get().version;
  assert.equal(typeof probe.setAuthorizer, 'function');
  probe.close();
  for (const type of ['module', 'commonjs'])
    for (const existing of [false, true]) {
      running();
      const name = `sqlite-${type}-${existing ? 'existing' : 'fresh'}`;
      console.log(name);
      const project = install(name, type, 'sqlite');
      project.env.DATABASE_URL = join(project.dir, 'app.sqlite');
      const db = new DatabaseSync(project.env.DATABASE_URL);
      const select = (sql) => plain(db.prepare(sql).all());
      const schema = async () =>
        select(
          "SELECT name, sql FROM sqlite_schema WHERE type IN ('table','index') AND name NOT LIKE 'sqlite_%' ORDER BY name",
        );
      try {
        await lifecycle(project, 'sqlite', existing, {
          query: async (sql) => (/^\s*(SELECT|SHOW)/i.test(sql) ? select(sql) : db.exec(sql)),
          schema,
          rows: async () =>
            (await schema()).some((item) => item.name === 'users')
              ? select('SELECT id, display_name FROM users ORDER BY id')
              : [],
          history: async () => select('SELECT * FROM _turbine_migrations ORDER BY id'),
          ownership: async () => assert.equal(db.prepare('SELECT 1 AS value').get().value, 1),
        });
      } finally {
        db.close();
      }
    }
}

async function mysqlCases() {
  // Driver bootstrapping is itself an ordinary baseline consumer, with bytes verified.
  const bootstrap = install('mysql-driver', 'module', 'mysql');
  const driver = bootstrap.require('mysql2/promise');
  const modes = [
    'STRICT_TRANS_TABLES,NO_ENGINE_SUBSTITUTION',
    'STRICT_TRANS_TABLES,NO_ENGINE_SUBSTITUTION,ANSI_QUOTES,NO_BACKSLASH_ESCAPES',
  ];
  for (const [index, mode] of modes.entries()) {
    running();
    const serviceRoot = join(root, `mysql-service-${index}`);
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
    try {
      running();
      for (const type of ['module', 'commonjs'])
        for (const existing of [false, true]) {
          running();
          const name = `mysql-${index}-${type}-${existing ? 'existing' : 'fresh'}`;
          console.log(name);
          const project = install(name, type, 'mysql');
          const database = `upgrade_${index}_${type}_${existing ? 'existing' : 'fresh'}`;
          await service.admin.query(`CREATE DATABASE \`${database}\``);
          const connection = await service.connect(database);
          project.env.DATABASE_URL = `mysql://root@127.0.0.1:${service.port}/${database}`;
          const query = async (sql) => {
            running();
            return plain((await connection.query(sql))[0]);
          };
          const schema = async () => {
            const tables = (await query('SHOW TABLES')).map((row) => Object.values(row)[0]).sort();
            const result = [];
            for (const name of tables) {
              // History AUTO_INCREMENT counters change during down/up; record its full rows separately.
              const create = Object.values((await query(`SHOW CREATE TABLE \`${name}\``))[0])[1].replace(
                / AUTO_INCREMENT=\d+/g,
                '',
              );
              result.push({ name, sql: create });
            }
            return result;
          };
          try {
            await lifecycle(project, 'mysql', existing, {
              query,
              schema,
              rows: async () =>
                (await schema()).some((item) => item.name === 'users')
                  ? query('SELECT id, display_name FROM users ORDER BY id')
                  : [],
              history: async () => query('SELECT * FROM _turbine_migrations ORDER BY id'),
              ownership: async () => {
                const [connections] = await service.admin.execute(
                  'SELECT ID FROM information_schema.PROCESSLIST WHERE DB = ?',
                  [database],
                );
                assert.equal(
                  connections.length,
                  1,
                  'Only the independent observer connection may remain after app/CLI exit',
                );
              },
            });
          } finally {
            await service.admin.query(`DROP DATABASE \`${database}\``);
          }
        }
      const [remaining] = await service.admin.query("SHOW DATABASES LIKE 'upgrade\\_%'");
      assert.deepEqual(remaining, [], 'Owned catalogs removed');
    } finally {
      console.log(`mysql-mode-${index}-stopping`);
      await service.stop();
    }
  }
}

function finish() {
  if (finishing) return finishing;
  finishing = (async () => {
    const results = await Promise.allSettled([...stops].map((stop) => stop()));
    const errors = results
      .filter((result) => result.status === 'rejected')
      .map((result) => scrub(result.reason?.stack ?? result.reason, root));
    if (errors.length) {
      report.cleanup.errors = errors;
      report.passed = false;
      process.exitCode = 1;
    }
    if (report.artifacts) {
      try {
        assert.deepEqual(
          artifactPair(args.baseline, args['baseline-sha256'], args.candidate, args['candidate-sha256']),
          report.artifacts,
        );
        report.artifactsUnchanged = true;
      } catch (error) {
        report.artifactsUnchanged = false;
        report.passed = false;
        process.exitCode = 1;
        report.error = scrub(error.stack ?? error.message, root);
      }
    }
    report.cleanup.servicesStopped = report.services.every((service) => service.stopped && service.connectionsClosed);
    try {
      if (root && report.cleanup.servicesStopped) rmSync(root, { recursive: true, force: true });
    } catch (error) {
      errors.push(scrub(error.stack ?? error.message, root));
      report.cleanup.errors = errors;
      report.passed = false;
      process.exitCode = 1;
    }
    report.cleanup.fixtureRemoved = root ? !existsSync(root) : true;
    if (interrupted) {
      report.passed = false;
      report.error = `Interrupted by ${interrupted}`;
    }
    report.finished = new Date().toISOString();
    mkdirSync(dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`Artifact upgrade ${report.passed ? 'passed' : 'failed'}: ${reportPath}`);
  })();
  return finishing;
}
for (const [signal, code] of [
  ['SIGINT', 130],
  ['SIGTERM', 143],
])
  process.once(signal, () => {
    interrupted = signal;
    void finish().finally(() => process.exit(code));
  });
try {
  for (let i = 2; i < process.argv.length; i += 2) {
    const key = process.argv[i];
    assert.ok(
      [
        '--baseline',
        '--baseline-sha256',
        '--candidate',
        '--candidate-sha256',
        '--engine',
        '--report',
        '--exact-node',
      ].includes(key),
      `Unknown option: ${key}`,
    );
    assert.ok(process.argv[i + 1] && !process.argv[i + 1].startsWith('--'), `${key} requires a value`);
    args[key.slice(2)] = process.argv[i + 1];
    if (key === '--report') reportPath = resolve(args.report);
  }
  report.engine = args.engine;
  assert.ok(
    ['sqlite', 'mysql'].includes(args.engine),
    '--engine sqlite|mysql is required; native SQL Server is unavailable',
  );
  report.artifacts = artifactPair(args.baseline, args['baseline-sha256'], args.candidate, args['candidate-sha256']);
  assert.equal(args['exact-node'], '24.10.0', '--exact-node 24.10.0 is required for this native matrix');
  assert.equal(process.versions.node, args['exact-node'], 'Exact Node24.10.0 is required');
  prerequisite(args.engine, env);
  root = mkdtempSync(join(tmpdir(), 'turbine-upgrade-'));
  report.fixtureRoot = root;
  report.npm = run(root, 'npm', ['--version']).stdout.trim();
  report.payloads = { baseline: unpack('baseline'), candidate: unpack('candidate') };
  payloadTransition(report.payloads.baseline.manifest, report.payloads.candidate.manifest);
  assert.notDeepEqual(
    report.payloads.baseline.files,
    report.payloads.candidate.files,
    'Archive packaging alone is not an upgrade',
  );
  report.sourceHashes = {
    runner: files(here),
    reusedHelpers: files(resolve(here, '../lifecycle-examples')),
    examples: files(examples),
  };
  if (args.engine === 'sqlite') await sqliteCases();
  else await mysqlCases();
  // Input archives are never modified/repacked, including on successful completion.
  assert.deepEqual(
    artifactPair(args.baseline, args['baseline-sha256'], args.candidate, args['candidate-sha256']),
    report.artifacts,
  );
  report.passed = true;
} catch (error) {
  report.error = scrub(error.stack ?? error.message, root);
  console.error(report.error);
  process.exitCode = 1;
} finally {
  await finish();
}
