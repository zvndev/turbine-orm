import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { command, compileConsumer, main } from '../../scripts/measure-consumer-cost.mjs';
import {
  consumerTypeSource,
  profileBehaviorSource,
  profileSource,
  profileTypeSource,
  syntheticSchema,
} from '../../scripts/measure-consumer-cost-fixtures.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'));
const save = async (path, value) => writeFile(path, JSON.stringify(value));
const require = createRequire(import.meta.url);

test('all historical and integrated consumers retain their public entries and exact driver closures', async () => {
  const { profiles, tools } = await readJson(join(root, 'tooling/consumer-cost/profiles.json'));
  const expected = {
    postgres: ['turbine-orm', { pg: '8.22.0' }],
    sqlite: ['turbine-orm/sqlite', {}],
    mysql: ['turbine-orm/mysql', { mysql2: '3.24.5' }],
    serverless: ['turbine-orm/serverless', { pg: '8.22.0' }],
    cli: ['turbine-orm/cli', {}],
    sql: ['turbine-orm/sql', {}],
    'mysql-seed': ['turbine-orm/mysql/seed', {}],
    'mssql-seed': ['turbine-orm/mssql/seed', {}],
    core: ['turbine-orm/core', { pg: '8.23.1' }],
    'neon-ws': ['turbine-orm/neon-ws', { '@neondatabase/serverless': '1.2.0', ws: '8.18.3' }],
    'neon-http': ['turbine-orm/neon-http', { '@neondatabase/serverless': '1.2.0' }],
    'notification-hub': ['turbine-orm/notification-hub', { pg: '8.23.1' }],
    'live-query': ['turbine-orm/live-query', {}],
    d1: ['turbine-orm/d1', {}],
    libsql: ['turbine-orm/libsql', { '@libsql/client': '0.18.0' }],
  };
  assert.deepEqual(Object.keys(profiles).sort(), Object.keys(expected).sort());
  assert.deepEqual(tools, { typescript: '6.0.3', '@types/node': '22.20.4' });
  for (const [name, [entry, drivers]] of Object.entries(expected)) {
    assert.equal(profiles[name].entry, entry, name);
    assert.deepEqual(profiles[name].drivers, drivers, name);
    assert.ok(profileSource(name).includes(entry), `${name}: public runtime import omitted`);
  }
  for (const name of ['neon-ws', 'neon-http', 'live-query', 'd1']) {
    assert.match(profiles[name].initialization, /^unavailable:/);
    assert.doesNotMatch(profileSource(name), /export (async )?function initialize/);
  }
  for (const name of ['core', 'neon-ws', 'neon-http', 'notification-hub', 'live-query', 'd1', 'libsql']) {
    assert.ok(profileBehaviorSource(name), `${name}: correctness was omitted`);
    assert.ok(profileTypeSource(name), `${name}: strict public types were omitted`);
  }
  for (const name of ['constructor', 'toString', '__proto__']) {
    assert.throws(() => profileSource(name), /Unknown consumer profile/);
    assert.equal(profileBehaviorSource(name), null);
    assert.equal(profileTypeSource(name), null);
  }
});

test('100/500/1000 workloads still exercise every accessor and exact numeric relation result', () => {
  for (const count of [100, 500, 1000]) {
    const schema = syntheticSchema(count);
    assert.equal(Object.keys(schema.tables).length, count);
    const source = consumerTypeSource(count);
    for (let i = 0; i < count; i++) {
      assert.ok(source.includes(`await db.records_${i}.findMany({`), `missing records_${i}`);
      assert.equal(schema.tables[`records_${i}`].columns.length, 8);
    }
    assert.equal(source.match(/exact<Equal<typeof row.amount, string>>/g).length, count);
    assert.equal(source.match(/row.children\[number\]\['parent'\]/g).length, count);
    assert.equal(source.match(/const lossy: number = row.amount/g).length, count);
  }
});

test('each integrated behavior guard rejects a permissive or omitted public contract', async () => {
  // Deliberately broken package doubles are refusal controls, never native evidence.
  // No registry, product source mutation, endpoint or functioning D1 binding.
  const cases = {
    core: 'export const turbineCore = () => ({});',
    'neon-ws': 'export const withNeonWs = () => {}; export const turbineNeonWs = async () => ({});',
    'neon-http': "export const NEON_HTTP_CAPABILITIES = { transport: 'neon-http' }; export const turbineNeonHttp = () => ({});",
    'notification-hub': 'export const createNotificationHub = () => ({});',
    'live-query': `export const liveQuery = () => ({
      ready: Promise.resolve(), closed: Promise.resolve(),
      next: async () => ({done:false,value:{id:1}}), dispose: async () => {},
    });`,
    d1: 'export const turbineD1 = () => ({}); export const d1Dialect = {};',
    libsql: 'export const turbineLibsql = async () => ({});',
  };
  for (const [name, source] of Object.entries(cases)) {
    const work = await mkdtemp(join(tmpdir(), 'consumer-integrated-control-'));
    try {
      const pkg = join(work, 'node_modules/turbine-orm');
      await mkdir(pkg, { recursive: true });
      await save(join(pkg, 'package.json'), {
        name: 'turbine-orm', type: 'module', exports: { [`./${name}`]: './entry.mjs' },
      });
      await writeFile(join(pkg, 'entry.mjs'), source);
      // Driver exports are intentionally inert in this defective-package control.
      await writeFile(join(work, 'entry.mjs'), `export * from 'turbine-orm/${name}';\nexport const driver = () => {};\nexport const webSocketConstructor = () => {};\n`);
      await writeFile(join(work, 'behavior.mjs'), profileBehaviorSource(name));
      // Hub admission needs a real unconnected pg.Pool; use the isolated test tools.
      if (name === 'notification-hub') {
        await symlink(dirname(require.resolve('pg/package.json')), join(work, 'node_modules/pg'), 'dir');
      }
      const imported = await command(process.execPath, ['entry.mjs'], { cwd: work });
      assert.equal(imported.status, 'measured', imported.stderr);
      const checked = await command(process.execPath, ['behavior.mjs'], { cwd: work, timeoutMs: 10000 });
      assert.equal(checked.status, 'failed', `${name}: broken behavior accepted`);
      assert.match(checked.stderr, /AssertionError/, `${name}: must fail its guard, not a missing prerequisite`);
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  }
});

test('integrated checks cannot silently omit require behavior or either conditional declaration graph', async () => {
  const work = await mkdtemp(join(tmpdir(), 'consumer-format-controls-'));
  try {
    const pkg = join(work, 'node_modules/turbine-orm');
    await mkdir(pkg, { recursive: true });
    await symlink(dirname(require.resolve('typescript/package.json')), join(work, 'node_modules/typescript'), 'dir');
    const exports = {};
    const files = [];
    for (const name of ['core', 'neon-ws', 'neon-http', 'notification-hub', 'live-query', 'd1', 'libsql']) {
      exports[`./${name}`] = {
        import: { types: `./${name}.d.mts`, default: './entry.mjs' },
        require: { types: `./${name}.d.cts`, default: './broken.cjs' },
      };
      // These are defective declaration files, never substitutes for native APIs.
      await writeFile(join(pkg, `${name}.d.mts`), `export declare const defect: MissingEsm_${name.replaceAll('-', '_')};\n`);
      await writeFile(join(pkg, `${name}.d.cts`), `export declare const defect: MissingCjs_${name.replaceAll('-', '_')};\n`);
      const file = `${name}.mts`;
      files.push(file);
      await writeFile(join(work, file), profileTypeSource(name));
    }
    await save(join(pkg, 'package.json'), { name: 'turbine-orm', type: 'module', exports });
    await save(join(work, 'package.json'), { private: true, type: 'module' });
    await writeFile(join(pkg, 'entry.mjs'), 'export const unused = true;\n');
    await writeFile(join(pkg, 'broken.cjs'), "throw new Error('REQUIRE_BEHAVIOR_OMISSION_CONTROL');\n");
    await writeFile(join(work, 'entry.mjs'), 'export const unused = true;\n');
    for (const name of ['core', 'neon-ws', 'neon-http', 'notification-hub', 'live-query', 'd1', 'libsql']) {
      await writeFile(join(work, 'behavior.mjs'), profileBehaviorSource(name));
      const checked = await command(process.execPath, ['behavior.mjs'], { cwd: work });
      assert.equal(checked.status, 'failed');
      assert.match(checked.stderr, /REQUIRE_BEHAVIOR_OMISSION_CONTROL/, `${name}: require branch was omitted`);
    }
    await save(join(work, 'tsconfig.json'), {
      compilerOptions: {
        target: 'ES2023', module: 'NodeNext', moduleResolution: 'NodeNext',
        strict: true, skipLibCheck: false, noEmit: true, incremental: false, types: [],
      }, files,
    });
    const compiled = await compileConsumer(work, work);
    assert.equal(compiled.status, 'failed');
    const diagnostics = await readFile(join(work, 'typecheck.stdout.txt'), 'utf8');
    for (const name of ['core', 'neon-ws', 'neon-http', 'notification-hub', 'live-query', 'd1', 'libsql']) {
      const marker = name.replaceAll('-', '_');
      assert.ok(diagnostics.includes(`MissingEsm_${marker}`), `${name}: import declarations omitted`);
      assert.ok(diagnostics.includes(`MissingCjs_${marker}`), `${name}: require declarations omitted`);
    }
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test('impossible profiles and absent candidates fail before installing anything', async () => {
  await assert.rejects(main(['--profiles', 'nonexistent']), /Unknown consumer profile: nonexistent/);
  await assert.rejects(
    main(['--tarball', '/nonexistent/candidate.tgz', '--locks', '/nonexistent/locks', '--out', '/nonexistent/out']),
    /ENOENT/,
  );
  await assert.rejects(main(['--sizes', '0']), /Sizes must be integers/);
  await assert.rejects(main(['--sizes', '100,100']), /Duplicate sizes/);
  await assert.rejects(main(['--compiler-heap-mb', '0']), /compilerHeapMb must be a positive integer/);
});

test('hung child processes are terminated and reported as timeouts', async () => {
  const result = await command(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd: root, timeoutMs: 100 });
  assert.equal(result.status, 'timeout');
  assert.notEqual(result.code, 0);
});

test('real strict consumer compiler detects broken code and broken imported declarations', async () => {
  const project = await mkdtemp(join(tmpdir(), 'consumer-compiler-control-'));
  try {
    await mkdir(join(project, 'node_modules'));
    await symlink(dirname(require.resolve('typescript/package.json')), join(project, 'node_modules/typescript'), 'dir');
    await save(join(project, 'package.json'), { private: true, type: 'module' });
    await save(join(project, 'tsconfig.json'), {
      compilerOptions: {
        strict: true,
        skipLibCheck: false,
        noEmit: true,
        types: [],
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
      },
      files: ['consumer.ts'],
    });
    await writeFile(
      join(project, 'consumer.ts'),
      "const exact = '123456789.0123456789';\nconst value: string = exact;\nvoid value;\n",
    );
    const good = await compileConsumer(project, project);
    assert.equal(good.status, 'measured');
    assert.ok(good.resources.peakRssBytes > 0);
    assert.ok(good.resources.cpuUserMicros > 0);
    assert.ok(good.resources.cpuSystemMicros >= 0);
    assert.ok(good.compilerVersion);
    await writeFile(
      join(project, 'consumer.ts'),
      "const exact = '123456789.0123456789';\nconst value: number = exact;\nvoid value;\n",
    );
    const brokenCode = await compileConsumer(project, project);
    assert.equal(brokenCode.status, 'failed');
    assert.match(await readFile(join(project, 'typecheck.stdout.txt'), 'utf8'), /TS2322/);
    await writeFile(join(project, 'bad.d.ts'), 'export declare const value: MissingPublicType;\n');
    await writeFile(join(project, 'consumer.ts'), "import { value } from './bad.js';\nvoid value;\n");
    const brokenDeclarations = await compileConsumer(project, project);
    assert.equal(brokenDeclarations.status, 'failed');
    assert.match(await readFile(join(project, 'typecheck.stdout.txt'), 'utf8'), /MissingPublicType/);
    // A real bounded compiler abort must retain diagnostics and must not reuse good.resources.
    const exhausted = await compileConsumer(project, project, { compilerHeapMb: 16 });
    assert.equal(exhausted.status, 'resource-exhausted');
    assert.equal(exhausted.resources.status, 'unavailable');
    assert.match(await readFile(join(project, 'typecheck.stderr.txt'), 'utf8'), /heap out of memory|Allocation failed/);
    assert.ok(exhausted.observation.hostBefore.totalMemoryBytes > 0);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test('new packed public profiles reject broken behavior after a successful lazy import', async () => {
  // Intentionally defective packages, not native engine fixtures or measurements.
  const cases = {
    sql: {
      subpath: './sql',
      source:
        'export const sql = () => ({}); export const identifier = () => ({}); export const join = () => ({}); export const compile = () => ({ sql: "", params: [] });',
    },
    'mysql-seed': {
      subpath: './mysql/seed',
      source: 'export const defineMysqlSeed = (fn) => { fn(); return fn; }; export async function runMysqlSeed() {}',
    },
    'mssql-seed': {
      subpath: './mssql/seed',
      source: 'export const defineMssqlSeed = (fn) => fn; export async function runMssqlSeed() {}',
    },
  };
  for (const [name, fixture] of Object.entries(cases)) {
    const work = await mkdtemp(join(tmpdir(), 'consumer-entry-control-'));
    let retained;
    try {
      const pkg = join(work, 'package');
      const locks = join(work, 'locks');
      const consumer = join(locks, name);
      await mkdir(pkg);
      await mkdir(consumer, { recursive: true });
      await save(join(pkg, 'package.json'), {
        name: 'turbine-orm',
        version: '0.0.0',
        type: 'module',
        exports: { [fixture.subpath]: './entry.mjs' },
      });
      await writeFile(join(pkg, 'entry.mjs'), fixture.source);
      const packed = await command('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', consumer], {
        cwd: pkg,
      });
      assert.equal(packed.status, 'measured', packed.stderr);
      const tarball = join(consumer, 'candidate.tgz');
      await rename(join(consumer, JSON.parse(packed.stdout)[0].filename), tarball);
      await save(join(consumer, 'package.json'), {
        private: true,
        type: 'module',
        dependencies: { 'turbine-orm': 'file:./candidate.tgz' },
      });
      const locked = await command(
        'npm',
        ['install', '--package-lock-only', '--ignore-scripts', '--offline', '--no-audit', '--no-fund'],
        { cwd: consumer },
      );
      assert.equal(locked.status, 'measured', locked.stderr);
      await save(join(locks, 'locks.json'), {
        schemaVersion: 1,
        candidateSha256: hash(await readFile(tarball)),
        definitionsSha256: hash(await readFile(join(root, 'tooling/consumer-cost/profiles.json'))),
        profiles: {
          [name]: {
            lockSha256: hash(await readFile(join(consumer, 'package-lock.json'))),
            manifestSha256: hash(await readFile(join(consumer, 'package.json'))),
          },
        },
      });
      const out = join(work, 'evidence');
      assert.equal(
        await main(['--tarball', tarball, '--locks', locks, '--out', out, '--profiles', name, '--iterations', '1']),
        1,
      );
      const report = await readJson(join(out, 'report.json'));
      retained = report.retainedWork;
      const profile = report.profiles[name];
      assert.equal(profile.runtime.status, 'measured');
      assert.equal(profile.runtime.samples.length, 1);
      assert.equal(profile.runtime.samples[0].initMs, null);
      assert.equal(profile.runtime.initialization.status, 'unavailable');
      assert.equal(profile.behavior.status, 'failed');
      assert.equal(profile.status, 'failed');
      assert.match(await readFile(join(out, name, 'behavior.stderr.txt'), 'utf8'), /AssertionError/);
      // Changing either saved input refuses replay before it can be treated as a valid import.
      await writeFile(join(consumer, 'package-lock.json'), '{}');
      const alteredOut = join(work, 'altered-lock');
      assert.equal(await main(['--tarball', tarball, '--locks', locks, '--out', alteredOut, '--profiles', name]), 1);
      const altered = await readJson(join(alteredOut, 'report.json'));
      assert.match(altered.profiles[name].reason, /hash mismatch/);
      await rm(altered.retainedWork, { recursive: true, force: true });
    } finally {
      if (retained) await rm(retained, { recursive: true, force: true });
      await rm(work, { recursive: true, force: true });
    }
  }
});

test('a locked packed consumer with a broken public entry produces failed evidence, never zero cost', async () => {
  const work = await mkdtemp(join(tmpdir(), 'consumer-package-control-'));
  let retained;
  try {
    const pkg = join(work, 'package');
    const locks = join(work, 'locks');
    // The CLI entry needs no native SQLite runtime, so this import-failure control also runs on Node 20.
    const consumer = join(locks, 'cli');
    await mkdir(pkg);
    await mkdir(consumer, { recursive: true });
    await save(join(pkg, 'package.json'), {
      name: 'turbine-orm',
      version: '0.0.0',
      type: 'module',
      exports: { './cli': './broken.mjs' },
    });
    await writeFile(
      join(pkg, 'broken.mjs'),
      "export function defineConfig() {}\nthrow new Error('BROKEN_PUBLIC_ENTRY_CONTROL');\n",
    );
    const packed = await command('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', consumer], {
      cwd: pkg,
    });
    assert.equal(packed.status, 'measured', packed.stderr);
    const tarball = join(consumer, JSON.parse(packed.stdout)[0].filename);
    // Standard npm lock creation, no registry dependencies or lifecycle hooks in this control.
    await save(join(consumer, 'package.json'), {
      private: true,
      type: 'module',
      dependencies: { 'turbine-orm': 'file:./candidate.tgz' },
    });
    await rename(tarball, join(consumer, 'candidate.tgz'));
    const locked = await command(
      'npm',
      ['install', '--package-lock-only', '--ignore-scripts', '--offline', '--no-audit', '--no-fund'],
      { cwd: consumer },
    );
    assert.equal(locked.status, 'measured', locked.stderr);
    const metadata = {
      schemaVersion: 1,
      candidateSha256: hash(await readFile(join(consumer, 'candidate.tgz'))),
      definitionsSha256: hash(await readFile(join(root, 'tooling/consumer-cost/profiles.json'))),
      profiles: {
        cli: {
          lockSha256: hash(await readFile(join(consumer, 'package-lock.json'))),
          manifestSha256: hash(await readFile(join(consumer, 'package.json'))),
        },
      },
    };
    await save(join(locks, 'locks.json'), metadata);
    const common = ['--tarball', join(consumer, 'candidate.tgz'), '--locks', locks];
    // A valid lock campaign can still lack a requested adapter/profile.
    assert.equal(await main([...common, '--profiles', 'mysql', '--out', join(work, 'missing-profile')]), 2);
    const missing = await readJson(join(work, 'missing-profile/report.json'));
    assert.equal(missing.profiles.mysql.status, 'unavailable');
    await rm(missing.retainedWork, { recursive: true, force: true });
    const out = join(work, 'evidence');
    assert.equal(await main([...common, '--profiles', 'cli', '--iterations', '1', '--out', out]), 1);
    const report = await readJson(join(out, 'report.json'));
    retained = report.retainedWork;
    assert.equal(report.status, 'failed');
    assert.equal(report.profiles.cli.runtime.status, 'failed');
    assert.deepEqual(report.profiles.cli.runtime.samples, []);
    assert.match(await readFile(join(out, 'cli/runtime-0.stderr.txt'), 'utf8'), /BROKEN_PUBLIC_ENTRY_CONTROL/);
    // Replay refuses altered candidate identity rather than silently resolving another package.
    metadata.candidateSha256 = '0'.repeat(64);
    await save(join(locks, 'locks.json'), metadata);
    await assert.rejects(main([...common, '--profiles', 'cli', '--out', join(work, 'mismatch')]), /identity mismatch/);
  } finally {
    if (retained) await rm(retained, { recursive: true, force: true });
    await rm(work, { recursive: true, force: true });
  }
});
