/** Pure admission for the versioned full SQLite/MySQL catalogs. No client imports. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { assertFrozenInventory, inputTree } from './comparison-inventory.js';
import {
  mysqlPreflightInputs,
  sqlitePreflightValues,
  sqliteRefusals,
  sqliteRequiredInputs,
} from './comparison-policy.js';

export type Engine = 'sqlite' | 'mysql';
// biome-ignore lint/suspicious/noExplicitAny: serialized engine reports have deliberately different shapes.
type Report = Record<string, any>;
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
// Pin the complete versioned catalog, including unsupported cells and their reasons.
// A deliberate catalog change requires a new reviewed contract, not just a matching row count.
const catalogs = {
  sqlite: '8209c90b05ead547273622e1a23f21aada39042921bc8acbb4431fd13021b70c',
  mysql: '098a75f791fd5298e37ad7326b18a6a9873dc0b9cb886ce04be0d89ed33b68c9',
};
const names = ['Turbine', 'Raw', 'Drizzle', 'Drizzle RC', 'Prisma 7'];
const sameSet = (actual: unknown[], expected: unknown[], label: string) => {
  assert.equal(new Set(actual).size, actual.length, `${label}: duplicates`);
  assert.deepEqual([...actual].sort(), [...expected].sort(), label);
};
const key = (id: string, arm: string) => JSON.stringify([id, arm]);
const sha = (value: unknown) =>
  assert.ok(typeof value === 'string' && /^[a-f\d]{64}$/.test(value), 'Missing SHA256 provenance');
function manifest(value: Report) {
  assert.ok(value && Object.keys(value).length > 0, 'Missing source/artifact manifest');
  for (const hash of Object.values(value)) sha(hash);
}
function positive(n: unknown): asserts n is number {
  assert.ok(typeof n === 'number' && Number.isSafeInteger(n) && n > 0, 'Missing positive sample setting');
}
function stats(result: Report, arms: string[], samples: number) {
  sameSet(
    result.stats.map((s: Report) => s.name),
    arms,
    'timed arms',
  );
  for (const s of result.stats) {
    assert.equal(s.n, samples, 'timed sample count');
    for (const k of ['median', 'avg', 'p95', 'min']) assert.ok(Number.isFinite(s[k]) && s[k] > 0, `Invalid ${k}`);
    assert.ok(s.min <= s.median && s.min <= s.avg && s.median <= s.p95, 'Contradictory statistics');
  }
}

type Hashes = Record<string, string>;
/** Explicit external admission input. Never derive this from the first run being admitted. */
export interface MysqlFinalManifest {
  inventory: { repository: string; benchmark: string };
  format: 'mysql-final-manifest-v1';
  head: string;
  catalogSha256: string;
  executionScope: 'installed-artifact' | 'local-source-dist';
  runtime: { node: string; executable: string; sha256: string; versions: Record<string, string> };
  artifact: {
    path: string;
    sha256: string;
    payload: Hashes;
    packageRoot: string;
    entry: string;
    requireEntry: string;
    mysqlEntry: string;
    generationEntry: string;
  };
  hashes: {
    source: Hashes;
    dist: Hashes;
    benchmark: Hashes;
    turbineGenerated: Hashes;
    prismaGenerated: Hashes;
    rootLock: string;
    benchmarkLock: string;
  };
  packages: Record<string, { root: string; version: string; entries: string[]; files: Hashes }>;
  installedLock: { sha256: string; content: Report };
  runtimeClosure?: TreeIdentity;
  settings: { mode: 'ordinary' | 'no-backslash'; groupRounds: Record<string, number>; warmup: number };
}
interface TreeIdentity {
  root?: string;
  sha256: string;
  files: Hashes;
}
/** Compatible with the SQLite owner's independently captured schemaVersion=1 fixture. */
export interface SqliteFinalManifest {
  inventory: { repository: string; benchmark: string };
  schemaVersion: 1;
  head: string;
  node: { version: string; executable: string; sha256: string; runtimeVersions: Record<string, string> };
  artifact: {
    path: string;
    sha256: string;
    installedPackageRoot: string;
    installedTreeSha256: string;
    filesVerified: number;
    installedFiles: Hashes;
  };
  hashes: Hashes;
  source: TreeIdentity;
  localDist: TreeIdentity;
  generated: TreeIdentity;
  dependencies: Record<string, TreeIdentity>;
  sampleSettings?: Report;
  runtimeClosure?: TreeIdentity;
}
export type ComparisonFinalManifest = MysqlFinalManifest | SqliteFinalManifest;

const sqliteCompleteInputs = [
  ...sqliteRequiredInputs,
  'benchmarks/sqlite-comparison-identity.ts',
  'benchmarks/sqlite-comparison-install.ts',
  'benchmarks/sqlite-comparison-run.ts',
  'benchmarks/evidence/native-gate-child.mjs',
  'tsconfig.json',
  'benchmarks/tsconfig.json',
];
const sqliteDependencyPins: Record<string, string> = {
  'drizzle-orm': '0.45.4',
  'drizzle-rc': '1.0.0-rc.5',
  '@prisma/client': '7.10.1',
  '@prisma/adapter-better-sqlite3': '7.10.1',
  '@prisma/driver-adapter-utils': '7.10.1',
  '@prisma/client-runtime-utils': '7.10.1',
  prisma: '7.10.1',
  'better-sqlite3': '12.11.1',
  tsx: '4.21.0',
};
const baselineRuntimeKeys = [
  'node',
  'acorn',
  'ada',
  'amaro',
  'ares',
  'brotli',
  'cjs_module_lexer',
  'cldr',
  'icu',
  'llhttp',
  'modules',
  'napi',
  'nbytes',
  'ncrypto',
  'nghttp2',
  'openssl',
  'simdjson',
  'simdutf',
  'sqlite',
  'tz',
  'undici',
  'unicode',
  'uv',
  'uvwasi',
  'v8',
  'zlib',
  'zstd',
];
function runtimeVersionSchema(value: Record<string, string>) {
  assert.ok(value, 'Missing complete baseline runtime version schema');
  sameSet(Object.keys(value), baselineRuntimeKeys, 'Exact Node24.10.0 runtime version fields');
  assert.ok(
    Object.values(value).every((v) => typeof v === 'string' && v.length),
    'Missing runtime component version',
  );
  assert.equal(value.node, '24.10.0');
  assert.equal(value.modules, '137');
}
function treeIdentity(actual: Report, expected: TreeIdentity, paths: string[], label: string) {
  assert.ok(actual && expected, `Missing complete ${label}`);
  sha(actual.sha256);
  sha(expected.sha256);
  exactManifest(actual.files, expected.files, paths, label);
  assert.equal(digest(actual.files), actual.sha256, `${label} tree digest does not describe its files`);
  assert.equal(digest(expected.files), expected.sha256, `${label} expected tree digest is incomplete`);
  assert.equal(actual.sha256, expected.sha256, `${label} tree changed`);
}
function sqliteProvenance(r: Report, expected: SqliteFinalManifest | undefined) {
  assert.ok(expected, 'Explicit final SQLite manifest is required; absent repeat identities cannot certify a campaign');
  assert.equal(expected.schemaVersion, 1);
  assert.match(expected.head, /^[a-f\d]{40}$/);
  assert.equal(r.schemaVersion, 1);
  assert.equal(r.identity.head, expected.head, 'Final SQLite HEAD differs');
  assert.equal(r.identity.sourceStatus, '', 'Final SQLite source is dirty');
  assert.equal(expected.node.version, 'v24.10.0');
  absolute(expected.node.executable, 'SQLite baseline runtime');
  sha(expected.node.sha256);
  assert.equal(r.identity.node, expected.node.version);
  assert.equal(r.identity.executable, expected.node.executable);
  assert.equal(r.identity.executableSha256, expected.node.sha256);
  runtimeVersionSchema(expected.node.runtimeVersions);
  runtimeVersionSchema(r.identity.runtimeVersions);
  sameSet(
    Object.keys(r.identity.runtimeVersions),
    Object.keys(expected.node.runtimeVersions),
    'Complete SQLite runtime version schema',
  );
  assert.deepEqual(r.identity.runtimeVersions, expected.node.runtimeVersions, 'SQLite runtime ABI/build changed');
  assert.equal(r.identity.runtimeVersions.node, '24.10.0');
  assert.equal(r.identity.runtimeVersions.modules, '137');
  assert.equal(r.identity.runtimeVersions.sqlite, '3.50.4');
  assert.equal(r.identity.abi, '137');
  exactManifest(r.hashes, expected.hashes, sqliteCompleteInputs, 'SQLite complete executed-input manifest');
  treeIdentity(
    r.sourceIdentity,
    expected.source,
    ['sqlite.ts', 'query/builder.ts', 'query/relations.ts', 'generate.ts'],
    'SQLite source',
  );
  treeIdentity(
    r.localDistIdentity,
    expected.localDist,
    ['sqlite.js', 'query/builder.js', 'query/relations.js', 'generate.js'],
    'SQLite local dist',
  );
  treeIdentity(
    r.generatedIdentity,
    expected.generated,
    [
      'sqlite-turbine/index.ts',
      'sqlite-turbine/metadata.ts',
      'sqlite-turbine/types.ts',
      'sqlite-turbine/runtime-identity.mjs',
      'prisma-sqlite/index.js',
      'prisma-sqlite/schema.prisma',
    ],
    'SQLite generated clients',
  );
  absolute(expected.artifact.path, 'SQLite final archive');
  sha(expected.artifact.sha256);
  absolute(expected.artifact.installedPackageRoot, 'SQLite installed package');
  manifest(expected.artifact.installedFiles);
  for (const path of [
    'package.json',
    'dist/sqlite.js',
    'dist/generate.js',
    'dist/query/builder.js',
    'dist/query/relations.js',
  ])
    sha(expected.artifact.installedFiles[path]);
  sha(expected.artifact.installedTreeSha256);
  assert.equal(
    digest(expected.artifact.installedFiles),
    expected.artifact.installedTreeSha256,
    'Incomplete SQLite installed payload',
  );
  assert.equal(expected.artifact.filesVerified, Object.keys(expected.artifact.installedFiles).length);
  assert.ok(r.artifact?.verified === true, 'Missing verified SQLite archive');
  for (const field of ['path', 'sha256', 'installedPackageRoot', 'installedTreeSha256', 'filesVerified'] as const)
    assert.equal(r.artifact[field], expected.artifact[field], `SQLite final artifact ${field}`);
  assert.equal(
    r.turbineRuntime.route,
    'separately-installed-package',
    'Local dist is not installed artifact execution',
  );
  assert.equal(r.turbineRuntime.packageRoot, expected.artifact.installedPackageRoot);
  for (const [field, path] of [
    ['entry', 'dist/sqlite.js'],
    ['generationEntry', 'dist/generate.js'],
  ] as const) {
    assert.equal(r.turbineRuntime[field], expected.artifact.installedPackageRoot + '/' + path);
    assert.equal(r.turbineRuntime[field + 'Sha256'], expected.artifact.installedFiles[path]);
  }
  assert.equal(r.turbineRuntime.nativeIntrospectionEntrySha256, expected.artifact.installedFiles['dist/sqlite.js']);
  assert.equal(r.versions.prismaCli, '7.10.1');
  assert.equal(r.versions.nodeSqlite, '3.50.4');
  assert.equal(r.versions.betterSqliteEmbedded, '3.53.2');
  sameSet(Object.keys(r.dependencies), Object.keys(sqliteDependencyPins), 'SQLite declared dependency identities');
  sameSet(
    Object.keys(expected.dependencies),
    Object.keys(sqliteDependencyPins),
    'SQLite expected dependency identities',
  );
  for (const [name, version] of Object.entries(sqliteDependencyPins)) {
    const actual: Report = r.dependencies[name];
    const want: TreeIdentity = expected.dependencies[name]!;
    assert.equal(actual.version, version, `SQLite ${name} version`);
    absolute(actual.packageRoot, `${name} package root`);
    absolute(actual.entry, `${name} actual entry`);
    assert.ok(actual.entry.startsWith(actual.packageRoot + '/'), `${name} entry outside package root`);
    const entry = actual.entry.slice(actual.packageRoot.length + 1);
    treeIdentity(
      { sha256: actual.treeSha256, files: actual.files },
      want,
      ['package.json', entry, ...(name === 'better-sqlite3' ? ['build/Release/better_sqlite3.node'] : [])],
      `SQLite ${name} payload`,
    );
    assert.equal(actual.entrySha256, want.files[entry], `SQLite ${name} entry bytes`);
  }
  assert.equal(r.settings.connectionsPerArm, 1);
  assert.equal(r.settings.node.sqliteVersion, '3.50.4');
  assert.equal(r.settings.journal.journal_mode, 'wal');
  assert.equal(r.settings.synchronous.synchronous, 2);
  assert.equal(r.settings.foreignKeys.foreign_keys, 1);
  sameSet(
    r.settings.perArm.map((v: Report) => v.arm),
    names,
    'SQLite actual driver settings',
  );
  for (const item of r.settings.perArm) {
    const node = ['Turbine', 'Raw'].includes(item.arm);
    assert.equal(item.driver, node ? 'node:sqlite' : 'better-sqlite3');
    assert.equal(item.driverVersion, node ? 'v24.10.0' : '12.11.1');
    assert.equal(item.sqliteVersion, node ? '3.50.4' : '3.53.2');
    assert.equal(item.nativePragmaIntegerType, item.arm === 'Prisma 7' ? 'bigint' : 'number');
    assert.equal(item.journal, 'wal');
    assert.equal(item.synchronous, 2);
    assert.equal(item.foreignKeys, 1);
  }
  for (const v of r.preflight)
    assert.deepEqual(
      v.inputs,
      v.id === 'headline-10' ? Array.from({ length: 50 }, (_, i) => i) : [37],
      `SQLite exact input identities: ${v.id}/${v.arm}`,
    );
}

export function loadComparisonFinalManifest(
  engine: Engine,
  path: string | undefined,
  expectedSha256: string | undefined,
): ComparisonFinalManifest {
  if (engine === 'mysql') return loadMysqlFinalManifest(path, expectedSha256);
  absolute(path, 'final SQLite manifest path');
  sha(expectedSha256);
  const bytes = readFileSync(path);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), expectedSha256, 'Final SQLite manifest hash changed');
  const expected = JSON.parse(bytes.toString()) as SqliteFinalManifest;
  assert.equal(expected.schemaVersion, 1);
  absolute(expected.artifact.path, 'SQLite final archive');
  sha(expected.artifact.sha256);
  assert.equal(
    createHash('sha256').update(readFileSync(expected.artifact.path)).digest('hex'),
    expected.artifact.sha256,
    'SQLite final archive bytes changed',
  );
  absolute(expected.node.executable, 'SQLite baseline runtime');
  sha(expected.node.sha256);
  assert.equal(
    createHash('sha256').update(readFileSync(expected.node.executable)).digest('hex'),
    expected.node.sha256,
    'SQLite baseline runtime bytes changed',
  );
  archiveInventory(expected.artifact.path, expected.artifact.installedFiles);
  assertFrozenInventory(expected, 'sqlite');
  return expected;
}
const mysqlPins: Record<string, string> = {
  mysql2: '3.24.6',
  mariadb: '3.5.4',
  'drizzle-orm': '0.45.4',
  'drizzle-rc': '1.0.0-rc.5',
  prisma: '7.10.1',
  '@prisma/client': '7.10.1',
  '@prisma/adapter-mariadb': '7.10.1',
  pg: '8.23.1',
};
const mysqlRequiredPaths: Record<string, string[]> = {
  source: [
    'src/mysql.ts',
    'src/client.ts',
    'src/query/builder.ts',
    'src/query/relations.ts',
    'src/generate.ts',
    'src/introspect.ts',
  ],
  dist: [
    'dist/index.js',
    'dist/mysql.js',
    'dist/client.js',
    'dist/query/builder.js',
    'dist/query/relations.js',
    'dist/generate.js',
    'dist/introspect.js',
  ],
  benchmark: [
    'benchmarks/bench-mysql.ts',
    'benchmarks/mysql-seed.ts',
    'benchmarks/mysql-equivalence.ts',
    ...[
      'adapters',
      'catalog',
      'cleanup',
      'config',
      'latency',
      'native',
      'provenance',
      'samples',
      'install',
      'manifest',
    ].map((name) => `benchmarks/mysql-comparison-${name}.ts`),
    'benchmarks/mysql-schema.ts',
    'benchmarks/mysql-schema-rc.ts',
    'benchmarks/prisma/mysql.prisma',
    'benchmarks/bench-harness.ts',
    'benchmarks/equivalence.ts',
    'benchmarks/comparison-versions.json',
    'benchmarks/comparison-results.ts',
    'benchmarks/comparison-inventory.ts',
    'benchmarks/comparison-policy.ts',
    'benchmarks/mysql-preparation/native.mjs',
    'benchmarks/mysql-preparation/oracle.mjs',
    'benchmarks/mysql-preparation/provenance.mjs',
  ],
  turbineGenerated: [
    'generated/turbine-mysql/index.ts',
    'generated/turbine-mysql/metadata.ts',
    'generated/turbine-mysql/types.ts',
  ],
  prismaGenerated: [
    'generated/prisma-mysql/index.js',
    'generated/prisma-mysql/schema.prisma',
    'generated/prisma-mysql/runtime/client.js',
    'generated/prisma-mysql/query_compiler_fast_bg.js',
    'generated/prisma-mysql/query_compiler_fast_bg.wasm',
  ],
};
const mysqlPackagePaths: Record<string, string[]> = {
  mysql2: ['promise.js', 'lib/connection_config.js'],
  mariadb: ['promise.js'],
  'drizzle-orm': ['index.js', 'mysql2/index.js'],
  'drizzle-rc': ['index.js', 'mysql2.js', 'relations.js'],
  prisma: ['build/index.js'],
  '@prisma/client': ['runtime/client.js'],
  '@prisma/adapter-mariadb': ['dist/index.mjs'],
  pg: ['lib/index.js'],
  tsx: ['dist/loader.mjs'],
};
function exactManifest(actual: Report, expected: Report, required: string[], label: string) {
  manifest(actual);
  manifest(expected);
  for (const path of required) {
    sha(actual[path]);
    sha(expected[path]);
  }
  sameSet(Object.keys(actual), Object.keys(expected), `${label}: complete manifest paths`);
  for (const path of Object.keys(expected)) assert.equal(actual[path], expected[path], `${label}: ${path}`);
}
function absolute(value: unknown, label: string): asserts value is string {
  assert.ok(typeof value === 'string' && isAbsolute(value), `Missing absolute ${label}`);
}
function archiveInventory(path: string, files: Hashes) {
  const paths = execFileSync('tar', ['-tzf', path], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
    .split('\n')
    .filter((name) => name && !name.endsWith('/'))
    .map((name) => {
      assert.ok(name.startsWith('package/') && !name.split('/').includes('..'), 'Invalid archive member path');
      return name.slice('package/'.length);
    });
  sameSet(Object.keys(files), paths, 'Complete independent archive member inventory');
  const kinds = execFileSync('tar', ['-tvzf', path], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
    .trim()
    .split('\n');
  assert.ok(
    kinds.every((line) => line.startsWith('-') || line.startsWith('d')),
    'Archive links are not supported',
  );
  const root = mkdtempSync(join(tmpdir(), 'comparison-archive-inventory-'));
  try {
    execFileSync('tar', ['-xzf', path, '--no-same-owner', '--no-same-permissions', '-C', root]);
    assert.deepEqual(inputTree(join(root, 'package')), files, 'Complete actual archive bytes');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
export function loadMysqlFinalManifest(
  path: string | undefined,
  expectedSha256: string | undefined,
): MysqlFinalManifest {
  absolute(path, 'final MySQL manifest path');
  sha(expectedSha256);
  const bytes = readFileSync(path);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), expectedSha256, 'Final MySQL manifest hash changed');
  const expected = JSON.parse(bytes.toString()) as MysqlFinalManifest;
  assert.equal(expected.format, 'mysql-final-manifest-v1');
  absolute(expected.artifact.path, 'final archive path');
  sha(expected.artifact.sha256);
  assert.equal(
    createHash('sha256').update(readFileSync(expected.artifact.path)).digest('hex'),
    expected.artifact.sha256,
    'Final archive bytes changed',
  );
  absolute(expected.runtime.executable, 'baseline runtime executable');
  sha(expected.runtime.sha256);
  assert.equal(
    createHash('sha256').update(readFileSync(expected.runtime.executable)).digest('hex'),
    expected.runtime.sha256,
    'Baseline runtime bytes changed',
  );
  archiveInventory(expected.artifact.path, expected.artifact.payload);
  assertFrozenInventory(expected, 'mysql');
  return expected;
}
function mysqlProvenance(r: Report, expected: MysqlFinalManifest | undefined) {
  assert.ok(expected, 'Explicit final MySQL manifest is required; absent repeat identities cannot certify a campaign');
  assert.equal(expected.format, 'mysql-final-manifest-v1');
  assert.equal(expected.catalogSha256, catalogs.mysql);
  assert.equal(r.catalogContract, 'mysql-original-47-v2');
  assert.match(expected.head, /^[a-f\d]{40}$/);
  assert.equal(r.git.head, expected.head, 'Final source HEAD differs');
  assert.equal(r.git.status, '', 'Final source is dirty');
  assert.equal(expected.runtime.node, 'v24.10.0');
  absolute(expected.runtime.executable, 'baseline runtime executable');
  sha(expected.runtime.sha256);
  assert.equal(r.node, expected.runtime.node);
  assert.equal(r.installed.runtime.node, expected.runtime.node);
  assert.equal(r.installed.runtime.executable, expected.runtime.executable);
  assert.equal(r.installed.runtime.sha256, expected.runtime.sha256);
  runtimeVersionSchema(expected.runtime.versions);
  runtimeVersionSchema(r.installed.runtime.versions);
  sameSet(
    Object.keys(r.installed.runtime.versions),
    Object.keys(expected.runtime.versions),
    'Complete MySQL runtime version schema',
  );
  assert.deepEqual(r.installed.runtime.versions, expected.runtime.versions, 'MySQL runtime ABI/build changed');
  assert.equal(r.installed.runtime.versions.node, '24.10.0', 'Missing full runtime provenance');
  assert.equal(r.installed.runtime.versions.modules, '137');
  assert.ok(['installed-artifact', 'local-source-dist'].includes(expected.executionScope));
  assert.equal(r.executionScope, expected.executionScope);
  absolute(expected.artifact.path, 'final archive path');
  sha(expected.artifact.sha256);
  assert.equal(r.installed.artifact.path, expected.artifact.path);
  assert.equal(r.installed.artifact.sha256, expected.artifact.sha256);
  assert.equal(r.installed.artifact.exercised, expected.executionScope === 'installed-artifact');
  absolute(expected.artifact.packageRoot, 'Independent Turbine package root');
  assert.equal(r.installed.artifact.packageRoot, expected.artifact.packageRoot);
  for (const [field, relative] of [
    ['entry', 'dist/index.js'],
    ['requireEntry', 'dist/cjs/index.js'],
    ['mysqlEntry', 'dist/mysql.js'],
    ['generationEntry', 'dist/generate.js'],
  ] as const) {
    assert.equal(expected.artifact[field], expected.artifact.packageRoot + '/' + relative);
    assert.equal(r.installed.artifact[field], expected.artifact[field], `Actual Turbine ${field}`);
    sha(expected.artifact.payload[relative]);
  }
  exactManifest(
    r.installed.artifact.payload,
    expected.artifact.payload,
    ['package.json', ...mysqlRequiredPaths.dist!],
    'Final archive payload',
  );
  const groups = [...Object.keys(mysqlRequiredPaths), 'rootLock', 'benchmarkLock'];
  sameSet(Object.keys(r.hashes), groups, 'MySQL provenance groups');
  sameSet(Object.keys(expected.hashes), groups, 'Final manifest provenance groups');
  for (const [group, paths] of Object.entries(mysqlRequiredPaths))
    exactManifest(r.hashes[group], (expected.hashes as unknown as Report)[group], paths, `MySQL ${group}`);
  for (const name of ['rootLock', 'benchmarkLock'] as const) {
    sha(r.hashes[name]);
    sha(expected.hashes[name]);
    assert.equal(r.hashes[name], expected.hashes[name]);
  }
  // Local dist timing must match the actual archive too; an archive name is not a byte match.
  exactManifest(
    r.hashes.dist,
    Object.fromEntries(Object.entries(expected.artifact.payload).filter(([p]) => p.startsWith('dist/'))),
    mysqlRequiredPaths.dist!,
    'Executed dist/archive equality',
  );
  sameSet(Object.keys(r.installed.packages), Object.keys(mysqlPackagePaths), 'Imported MySQL driver packages');
  sameSet(Object.keys(expected.packages), Object.keys(mysqlPackagePaths), 'Expected imported packages');
  for (const [name, paths] of Object.entries(mysqlPackagePaths)) {
    const actual: Report = r.installed.packages[name];
    const want: MysqlFinalManifest['packages'][string] = expected.packages[name]!;
    absolute(want.root, `${name} package root`);
    assert.equal(actual.root, want.root);
    assert.equal(actual.version, want.version);
    if (mysqlPins[name]) {
      assert.equal(actual.version, mysqlPins[name]);
      assert.equal(r.versions[name], mysqlPins[name]);
    }
    assert.ok(
      Array.isArray(want.entries) && want.entries.length && Array.isArray(actual.entries),
      `Missing actual ${name} import entries`,
    );
    sameSet(actual.entries, want.entries, `${name} import entries`);
    for (const entry of actual.entries) {
      absolute(entry, `${name} import entry`);
      assert.ok(entry.startsWith(actual.root + '/'), `${name} entry outside package root`);
      sha(actual.files[entry.slice(actual.root.length + 1)]);
    }
    exactManifest(actual.files, want.files, ['package.json', ...paths], `${name} full installed payload`);
  }
  sha(expected.installedLock.sha256);
  sha(r.installed.installedLock.sha256);
  assert.ok(expected.installedLock.content?.packages?.['node_modules/mysql2'], 'Missing locked dependency closure');
  assert.deepEqual(r.installed.installedLock, expected.installedLock, 'Installed locked dependency closure differs');
  assert.equal(r.mode, expected.settings.mode);
  sameSet(
    Object.keys(expected.settings.groupRounds),
    ['headline', 'extended', 'stream', 'latency', 'deep', 'cold'],
    'Final sample settings',
  );
  for (const n of Object.values(expected.settings.groupRounds)) positive(n);
  assert.ok(Number.isSafeInteger(expected.settings.warmup) && expected.settings.warmup >= 0);
  assert.deepEqual(r.groupRounds, expected.settings.groupRounds, 'Final sample settings differ');
  assert.equal(r.warmup, expected.settings.warmup);
}

function mysqlBoundaries(r: Report) {
  assert.equal(r.boundaryContract, 'mysql-native-boundaries-v1');
  assert.equal(r.oracleControlContract, 'mysql-oracle-controls-v1');
  sameSet(
    r.controls,
    [
      'changed scalar',
      'missing nullable column',
      'wrong tie ordering',
      'dropped stream tail',
      'duplicate stream row',
      'unchanged write effect',
      'wrong write target',
      'rounded bigint',
    ],
    'MySQL negative oracle controls',
  );
  const required = [
    key('capability refusals', 'Turbine'),
    key('default createMany', 'Turbine'),
    ...names.flatMap((name) => [key('escaped bound text', name), key('two-row duplicate-key bulk count', name)]),
  ];
  assert.ok(Array.isArray(r.boundaries), 'Missing MySQL executed boundary ledger');
  sameSet(
    r.boundaries.map((b: Report) => key(b.operation, b.arm)),
    required,
    'MySQL executed boundary ledger',
  );
  const proof = r.boundaries.find((b: Report) => b.operation === 'capability refusals').proof;
  assert.deepEqual(proof, {
    pipelineSupported: false,
    defaultCreateManyReturning: 'empty array; storage is separately tested',
  });
  const bulk = r.boundaries.find((b: Report) => b.operation === 'default createMany');
  assert.deepEqual(bulk.result, []);
  assert.equal(bulk.storedRows, 1000);
  assert.equal(bulk.status, 'returning unsupported; storage verified');
  for (const name of names) {
    const literal: Report = r.boundaries.find((b: Report) => b.operation === 'escaped bound text' && b.arm === name);
    const refusal = r.mode === 'no-backslash' && ['Drizzle', 'Drizzle RC'].includes(name);
    assert.equal(literal.status, refusal ? 'unsupported' : 'pass', `Versioned ${name}/${r.mode} literal boundary`);
    if (refusal) {
      assert.equal(
        literal.scope,
        'NO_BACKSLASH_ESCAPES with native mysql2 text interpolation; original catalog corpus contains no such escapes',
      );
      assert.equal(literal.positive, 'safe-original exact');
      assert.equal(literal.refusalStorage, 'independently verified empty after failed native write');
      assert.ok(typeof literal.error === 'string' && literal.error.length);
      assert.ok(
        Array.isArray(literal.errorChain) && literal.errorChain.some((e: Report) => e.code === 'ER_PARSE_ERROR'),
        'Missing native mode-specific parse refusal',
      );
    }
    const duplicate: Report = r.boundaries.find(
      (b: Report) => b.operation === 'two-row duplicate-key bulk count' && b.arm === name,
    );
    assert.equal(duplicate.status, 'native refusal and zero stored rows verified');
    assert.equal(duplicate.scope, 'This batch only. No cross-chunk transaction, concurrency or shared-snapshot claim.');
    const code = name === 'Turbine' ? 'TURBINE_E008' : name === 'Prisma 7' ? 'P2002' : 'ER_DUP_ENTRY';
    assert.ok(
      Array.isArray(duplicate.errorChain) && duplicate.errorChain.some((e: Report) => e.code === code),
      `Missing ${name} duplicate-key refusal`,
    );
  }
}

function retainedSampleStats(s: Report, engine: Engine) {
  assert.ok(Array.isArray(s.samplesMs) && s.samplesMs.length === s.n, 'Missing/partial retained MySQL samples');
  assert.ok(
    s.samplesMs.every((n: unknown) => typeof n === 'number' && Number.isFinite(n) && n > 0),
    'Invalid retained MySQL sample',
  );
  const sorted = [...s.samplesMs].sort((a, b) => a - b),
    n = sorted.length;
  const values = {
    median: n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2,
    avg: sorted.reduce((a, b) => a + b, 0) / n,
    p95: sorted[Math.ceil(n * 0.95) - 1],
    min: sorted[0],
  };
  for (const [key, value] of Object.entries(values))
    assert.ok(
      Math.abs(s[key] - value) <= Math.max(1e-9, Math.abs(value) * 1e-9),
      `MySQL ${key} differs from retained samples`,
    );
  assert.equal(s.p99, n < 100 ? null : sorted[Math.ceil(n * 0.99) - 1]);
  assert.equal(s.p99Status, n < 100 ? 'unavailable-small-n' : n < 1000 ? 'unstable-tail' : 'estimated');
  if (engine === 'mysql') assert.equal(s.sampleMethod, 'milliseconds; p50 arithmetic median; p95/p99 nearest rank');
  else {
    assert.deepEqual(
      s.sampleMethod,
      {
        unit: 'ms',
        p50: 'arithmetic median',
        p95: 'nearest-rank',
        p99: 'nearest-rank',
        scope: 'individual arm calls',
      },
      'Missing or changed SQLite sample quantile method',
    );
  }
}

function runtimeClosure(r: Report, expected: ComparisonFinalManifest | undefined, engine: Engine) {
  assert.ok(
    expected?.runtimeClosure && r.runtimeClosure,
    'Timing requires the independent full runtime-closure manifest and per-run provenance sidecar',
  );
  const suffixes = [
    'node_modules/tsx/dist/loader.mjs',
    'node_modules/esbuild/lib/main.js',
    'node_modules/@esbuild/linux-x64/bin/esbuild',
    ...(engine === 'sqlite'
      ? [
          'node_modules/bindings/bindings.js',
          'node_modules/file-uri-to-path/index.js',
          'node_modules/better-sqlite3/build/Release/better_sqlite3.node',
        ]
      : ['node_modules/mysql2/promise.js', 'node_modules/mariadb/promise.js']),
  ];
  const paths = Object.keys(expected.runtimeClosure.files);
  assert.ok(expected.inventory, 'Independent runtime roots missing');
  const required: Hashes = {};
  const add = (root: string, files: Hashes, strip = '') => {
    for (const [path, hash] of Object.entries(files)) required[join(root, path.replace(strip, ''))] = hash;
  };
  if (engine === 'mysql') {
    const e = expected as MysqlFinalManifest;
    required[e.runtime.executable] = e.runtime.sha256;
    add(e.artifact.packageRoot, e.artifact.payload);
    add(e.inventory.benchmark, e.hashes.benchmark, 'benchmarks/');
    add(e.inventory.benchmark, e.hashes.turbineGenerated);
    add(e.inventory.benchmark, e.hashes.prismaGenerated);
    for (const item of Object.values(e.packages)) add(item.root, item.files);
  } else {
    const e = expected as SqliteFinalManifest;
    required[e.node.executable] = e.node.sha256;
    add(e.artifact.installedPackageRoot, e.artifact.installedFiles);
    add(join(e.inventory.benchmark, 'generated'), e.generated.files);
    add(
      e.inventory.repository,
      Object.fromEntries(Object.entries(e.hashes).filter(([p]) => p.startsWith('benchmarks/'))),
    );
    for (const item of Object.values(e.dependencies)) {
      absolute(item.root, 'Independent dependency root');
      add(item.root, item.files);
    }
  }
  for (const [path, hash] of Object.entries(required))
    assert.equal(expected.runtimeClosure.files[path], hash, `Runtime closure omits declared input: ${path}`);
  for (const path of paths) absolute(path, 'runtime-closure file');
  for (const suffix of suffixes)
    assert.ok(
      paths.some((path) => path.endsWith('/' + suffix)),
      `Missing transitive runtime input: ${suffix}`,
    );
  treeIdentity(r.runtimeClosure, expected.runtimeClosure, paths, `${engine} complete runtime closure`);
}

function mysqlProfile(r: Report) {
  assert.equal(r.server.version, '8.4.0', 'Required native MySQL version');
  assert.ok(typeof r.server.sqlMode === 'string' && r.server.sqlMode.length, 'Missing MySQL SQL mode');
  const sqlMode = r.server.sqlMode
    .toUpperCase()
    .split(',')
    .map((s: string) => s.trim())
    .sort();
  assert.ok(
    sqlMode.every((s: string) => /^[A-Z0-9_]+$/.test(s)) && new Set(sqlMode).size === sqlMode.length,
    'Invalid MySQL SQL mode',
  );
  assert.equal(
    r.mode,
    sqlMode.includes('NO_BACKSLASH_ESCAPES') ? 'no-backslash' : 'ordinary',
    'Contradictory SQL mode',
  );
  // Both pinned drivers negotiate CLIENT_IGNORE_SPACE; these are observed session modes.
  const baseModes = [
    'IGNORE_SPACE',
    'ONLY_FULL_GROUP_BY',
    'STRICT_TRANS_TABLES',
    'NO_ZERO_IN_DATE',
    'NO_ZERO_DATE',
    'ERROR_FOR_DIVISION_BY_ZERO',
    'NO_ENGINE_SUBSTITUTION',
    ...(r.mode === 'no-backslash' ? ['NO_BACKSLASH_ESCAPES'] : []),
  ];
  sameSet(sqlMode, baseModes, 'Required native MySQL SQL mode policy');
  assert.ok(
    ['READ-UNCOMMITTED', 'READ-COMMITTED', 'REPEATABLE-READ', 'SERIALIZABLE'].includes(r.server.isolationLevel),
    'Missing MySQL isolation',
  );
  sha(r.fixtureHash);
  sameSet(
    r.transports.map((t: Report) => t.name),
    names,
    'MySQL transport ownership',
  );
  const transports = names.map((name) => {
    const t = r.transports.find((t: Report) => t.name === name);
    assert.equal(t.poolLimit, 10, 'MySQL comparison pool limit');
    assert.ok(typeof t.protocol === 'string' && t.protocol.trim(), 'Missing MySQL protocol');
    assert.ok(typeof t.owner === 'string' && t.owner.trim(), 'Missing MySQL pool ownership');
    return { name, protocol: t.protocol, poolLimit: t.poolLimit, owner: t.owner };
  });
  assert.ok(Array.isArray(r.sessionSettings), 'Missing MySQL session provenance');
  sameSet(
    r.sessionSettings.map((s: Report) => s.arm),
    names,
    'MySQL session provenance',
  );
  const sessions = names.map((name) => {
    const item: Report = r.sessionSettings.find((s: Report) => s.arm === name);
    assert.deepEqual(
      item.configured,
      name === 'Prisma 7'
        ? { driver: 'mariadb', connectionLimit: 10, timezone: '+00:00', prepareCacheLength: 0 }
        : {
            connectionLimit: 10,
            namedPlaceholders: true,
            supportBigNumbers: true,
            bigNumberStrings: false,
            timezone: 'Z',
            dateStrings: false,
            connectTimeout: 5000,
          },
    );
    assert.equal(item.sampledSession.length, 1, 'Missing sampled native session');
    const session: Report = item.sampledSession[0];
    const modes = session.sqlMode.split(',').sort();
    sameSet(modes, baseModes, `${name} native session mode`);
    assert.equal(session.isolationLevel, r.server.isolationLevel);
    for (const field of ['timeZone', 'characterSetClient', 'collationConnection'])
      assert.ok(typeof session[field] === 'string' && session[field].length, `Missing session ${field}`);
    assert.equal(session.autocommit, '1');
    assert.match(session.connectionId, /^[1-9]\d*$/);
    const { connectionId: _connectionId, ...policy } = session;
    return { arm: name, configured: item.configured, sampled: { ...policy, sqlMode: modes } };
  });
  const variables = [
    'autocommit',
    'character_set_server',
    'collation_server',
    'innodb_buffer_pool_size',
    'innodb_flush_log_at_trx_commit',
    'log_bin',
    'max_connections',
    'max_prepared_stmt_count',
    'optimizer_switch',
    'performance_schema',
    'sql_mode',
    'sync_binlog',
    'system_time_zone',
    'time_zone',
    'transaction_isolation',
    'version',
    'version_compile_machine',
    'version_compile_os',
  ];
  assert.ok(Array.isArray(r.serverSettings), 'Missing native server configuration');
  sameSet(
    r.serverSettings.map((v: Report) => v.Variable_name),
    variables,
    'Complete MySQL server configuration',
  );
  const serverSettings = variables.map((name) => {
    const value = r.serverSettings.find((v: Report) => v.Variable_name === name).Value;
    assert.ok(typeof value === 'string' && value.length, `Missing native ${name}`);
    if (name === 'sql_mode') sameSet(value.split(','), baseModes, 'Native oracle-session SQL mode');
    if (name === 'version') assert.equal(value, r.server.version);
    if (name === 'transaction_isolation') assert.equal(value, r.server.isolationLevel);
    return [name, name === 'sql_mode' ? value.split(',').sort().join(',') : value];
  });
  // Addresses, datadirs and connection IDs describe ownership, not comparable execution policy.
  return {
    version: r.server.version,
    sqlMode,
    isolation: r.server.isolationLevel,
    transports,
    sessions,
    serverSettings,
    fixtureHash: r.fixtureHash,
  };
}

export function assertComparisonRun(
  r: Report,
  engine: Engine,
  timed = true,
  finalManifest?: ComparisonFinalManifest,
): void {
  if (timed) runtimeClosure(r, finalManifest, engine);
  assert.equal(digest(r.catalog), catalogs[engine], 'Incomplete or changed versioned catalog');
  assert.equal(r.error, undefined, 'Report retains execution error');
  assert.deepEqual(r.cleanup.errors, [], 'Cleanup errors remain');
  assert.match(engine === 'sqlite' ? r.identity.head : r.git.head, /^[a-f\d]{40}$/, 'Missing source HEAD');
  if (engine === 'sqlite') {
    sqliteProvenance(r, finalManifest as SqliteFinalManifest | undefined);
    manifest(r.hashes);
    for (const path of sqliteRequiredInputs) sha(r.hashes[path]);
    sha(r.turbineRuntime.entrySha256);
    sha(r.turbineRuntime.generationEntrySha256);
    assert.equal(r.operationCatalog, 'original-full-sqlite-v1');
    assert.equal(r.engine, engine);
    assert.equal(r.status, 'passed');
    assert.equal(r.mode, timed ? 'timing' : 'correctness-only', 'Correctness-only input cannot supply timings');
    assert.equal(r.fault, 'none');
    assert.equal(r.cleanup.removed, true);
    assert.equal(r.cleanup.adminClosed, true);
    sameSet(r.cleanup.closed, names, 'closed SQLite clients');
    const coldRounds = timed ? r.sampleSettings.coldRounds : 0;
    if (timed) positive(coldRounds);
    const perArm = 2 + coldRounds; // Base client, native cold preflight, then each cold timing invocation.
    sameSet(
      r.cleanup.handles.map((h: Report) => h.id),
      Array.from({ length: perArm * names.length }, (_, i) => i + 1),
      'SQLite handle ownership',
    );
    for (const name of names)
      assert.equal(r.cleanup.handles.filter((h: Report) => h.name === name).length, perArm, 'SQLite arm handles');
    for (const h of r.cleanup.handles)
      assert.ok(
        h.closed === true && h.nativeClosed === true && h.transactionAtClose === false,
        'SQLite native closure',
      );
    assert.equal(r.cleanup.seedHandles.length, 1, 'SQLite seed ownership');
    for (const h of r.cleanup.seedHandles) assert.equal(h.closed, true);
    assert.equal(r.identity.node, 'v24.10.0');
    assert.equal(r.versions.drizzle, '0.45.4');
    assert.equal(r.versions.drizzleRc, '1.0.0-rc.5');
    assert.equal(r.versions.prisma, '7.10.1');
    assert.equal(r.versions.prismaAdapter, '7.10.1');
    assert.equal(r.versions.betterSqlite3, '12.11.1');
    const cells = r.catalog.filter((c: Report) => c.status === 'supported');
    sameSet(
      r.preflight.map((v: Report) => key(v.id, v.arm)),
      cells.map((c: Report) => key(c.id, c.arm)),
      'SQLite preflight cells',
    );
    for (const v of r.preflight)
      assert.equal(v.values, sqlitePreflightValues(v.id), `SQLite delivered values: ${v.id}/${v.arm}`);
    sameSet(r.refusalControls, [...sqliteRefusals], 'SQLite native refusal evidence');
    sameSet(
      r.transactions.map((t: Report) => JSON.stringify([t.arm, t.transaction])),
      names.flatMap((name) => [false, true].map((tx) => JSON.stringify([name, tx]))),
      'SQLite transaction evidence',
    );
    for (const tx of r.transactions) {
      const reads = tx.events.filter((e: Report) => typeof e.sql === 'string' && /^\s*(?:SELECT|WITH)\b/i.test(e.sql));
      assert.equal(reads.length, 5, 'SQLite dashboard read count');
      assert.ok(
        reads.every((e: Report) => e.transaction === tx.transaction && ['get', 'all', 'iterate'].includes(e.method)),
        'SQLite dashboard transaction scope',
      );
    }
    if (!timed) {
      assert.deepEqual(r.results, []);
      return;
    }
    assert.ok(
      (finalManifest as SqliteFinalManifest).sampleSettings,
      'Explicit final SQLite sample settings required for timing',
    );
    assert.deepEqual(
      r.sampleSettings,
      (finalManifest as SqliteFinalManifest).sampleSettings,
      'Final SQLite sample settings differ',
    );
    assert.ok(r.sampleSettings);
    const cfg: Report = r.sampleSettings;
    for (const n of [cfg.rounds, cfg.streamRounds, cfg.coldRounds]) positive(n);
    const scenarios = [...new Set<string>(cells.map((c: Report) => c.scenario))];
    sameSet(
      r.results.map((s: Report) => s.scenario),
      scenarios,
      'SQLite timed scenarios',
    );
    for (const result of r.results) {
      const group = cells.filter((c: Report) => c.scenario === result.scenario);
      const { id, group: kind } = group[0];
      const n =
        kind === 'cold'
          ? cfg.coldRounds
          : id === 'headline-6' || id === 'stream-parity'
            ? cfg.streamRounds
            : kind === 'headline' || cfg.quick
              ? cfg.rounds
              : Math.max(10, Math.floor(cfg.rounds / (id === 'large-50000' ? 10 : id === 'writes-bulk' ? 5 : 2)));
      stats(
        result,
        group.map((c: Report) => c.arm),
        n,
      );
      for (const stat of result.stats) retainedSampleStats(stat, 'sqlite');
    }
  } else {
    mysqlProvenance(r, finalManifest as MysqlFinalManifest | undefined);
    mysqlProfile(r);
    mysqlBoundaries(r);
    if (!timed) {
      assert.deepEqual(r.operationSamples, []);
      assert.deepEqual(r.operationResults, []);
      assert.deepEqual(r.driftSamples, []);
    } else {
      assert.ok(
        Array.isArray(r.operationSamples) && Array.isArray(r.operationResults) && Array.isArray(r.driftSamples),
        'Missing MySQL retained sample ledgers',
      );
    }
    assert.equal(r.format, 'mysql-comparison-v1');
    assert.equal(r.status, 'pass');
    assert.equal(r.verifyOnly, !timed, 'Correctness-only input cannot supply timings');
    assert.equal(r.cleanup.fixtureRestored, true);
    assert.equal(r.cleanup.oracleClosed, true);
    assert.deepEqual(r.cleanup.remainingArmBackends, []);
    sameSet(
      r.cleanup.adapters.map((a: Report) => a.arm),
      names,
      'closed MySQL clients',
    );
    assert.ok(r.cleanup.adapters.every((a: Report) => a.closed));
    assert.ok(r.cleanup.mysql2Pools.length >= 5 && r.cleanup.mysql2Pools.every((p: Report) => p.closed && !p.queued));
    assert.ok(r.cleanup.proxies.length === 4 && r.cleanup.proxies.every((p: Report) => p.closed));
    assert.equal(r.node, 'v24.10.0');
    assert.equal(r.versions['drizzle-orm'], '0.45.4');
    assert.equal(r.versions['drizzle-rc'], '1.0.0-rc.5');
    assert.equal(r.versions['@prisma/client'], '7.10.1');
    assert.equal(r.versions.mysql2, '3.24.6');
    assert.equal(r.versions.mariadb, '3.5.4');
    sameSet(
      r.selected,
      r.catalog.map((c: Report) => c.id),
      'selected MySQL catalog',
    );
    const retainedTuples: string[] = [];
    const retainedScenarios: string[] = [];
    const sections = [{ preflight: r.preflight, results: r.results, group: 'direct' }, ...r.latency];
    sameSet(
      r.latency.map((s: Report) => s.rttMs),
      [0, 1, 5, 25],
      'complete RTT topology',
    );
    for (const section of sections) {
      const latency = section.group !== 'direct';
      const catalog = r.catalog.filter((c: Report) => (c.group === 'latency') === latency);
      const cells = catalog.flatMap((c: Report) =>
        c.arms.filter((a: Report) => a.status === 'supported').map((a: Report) => key(c.id, a.name)),
      );
      if (!latency) cells.push(key('stream.parity', 'T batches'), key('stream.parity', 'T batches#2'));
      sameSet(
        [...new Set(section.preflight.map((v: Report) => key(v.scenario, v.arm)))],
        cells,
        'MySQL preflight cells',
      );
      const inputs = catalog.flatMap((c: Report) =>
        c.arms
          .filter((a: Report) => a.status === 'supported')
          .flatMap((a: Report) => mysqlPreflightInputs(c.id).map((input) => JSON.stringify([c.id, a.name, input]))),
      );
      if (!latency)
        for (const arm of ['T batches', 'T batches#2']) inputs.push(JSON.stringify(['stream.parity', arm, 0]));
      sameSet(
        section.preflight.map((v: Report) => JSON.stringify([v.scenario, v.arm, v.input])),
        inputs,
        'MySQL correctness input tuples',
      );
      for (const v of section.preflight) assert.ok(v.status === 'pass' && /^[a-f\d]{64}$/.test(v.hash));
      if (!timed) {
        assert.deepEqual(section.results, []);
        continue;
      }
      const label = (c: Report) => (latency ? `${c.scenario}, RTT ${section.rttMs}ms` : c.scenario);
      sameSet(
        section.results.map((s: Report) => s.scenario),
        catalog.map(label),
        'MySQL timed scenarios',
      );
      for (const result of section.results) {
        const c = catalog.find((c: Report) => label(c) === result.scenario);
        const arms = c.arms.filter((a: Report) => a.status === 'supported').map((a: Report) => a.name);
        if (c.id === 'stream.parity') arms.push('T batches', 'T batches#2');
        const cfg = r.groupRounds;
        for (const n of Object.values(cfg)) positive(n);
        const n = latency
          ? cfg.latency
          : c.group === 'cold'
            ? cfg.cold
            : c.group === 'stream' || c.id === 'headline.stream'
              ? cfg.stream
              : c.group === 'headline'
                ? cfg.headline
                : c.group === 'deep'
                  ? cfg.deep
                  : c.id === 'writes.bulk' || c.id === 'writes.bulk-count'
                    ? Math.max(15, Math.floor(cfg.extended / 5))
                    : c.id === 'large.comments-50000'
                      ? Math.max(10, Math.floor(cfg.extended / 10))
                      : c.id === 'large.wide'
                        ? Math.max(20, Math.floor(cfg.extended / 2))
                        : cfg.extended;
        stats(result, arms, n);
        retainedScenarios.push(result.scenario);
        for (const stat of result.stats) {
          retainedSampleStats(stat, 'mysql');
          const records: Report[] = r.operationSamples.filter(
            (v: Report) => v.scenario === result.scenario && v.arm === stat.name,
          );
          assert.deepEqual(
            records.map((v: Report) => v.round),
            Array.from({ length: n }, (_, i) => i),
            'MySQL retained round identities',
          );
          assert.deepEqual(
            records.map((v: Report) => v.durationMs),
            stat.samplesMs,
            'MySQL retained call/stat sample mismatch',
          );
          for (const v of records) {
            assert.equal(v.scenarioId, c.id);
            assert.equal(v.rttMs, latency ? section.rttMs : undefined);
            assert.equal(
              v.phase,
              latency
                ? 'warmed client through owned proxy'
                : c.group === 'cold'
                  ? 'first query after untimed connection establishment'
                  : 'warmed client',
            );
            retainedTuples.push(JSON.stringify([v.scenario, v.arm, v.round]));
          }
        }
      }
    }
    if (timed) {
      sameSet(
        r.operationSamples.map((v: Report) => JSON.stringify([v.scenario, v.arm, v.round])),
        retainedTuples,
        'Complete MySQL retained sample ledger',
      );
      sameSet(
        r.operationResults.map((v: Report) => v.scenario),
        retainedScenarios,
        'Complete MySQL operation summaries',
      );
      for (const section of sections)
        for (const result of section.results) {
          const observed: Report = r.operationResults.find((v: Report) => v.scenario === result.scenario);
          sameSet(
            observed.summary.map((v: Report) => v.arm),
            result.stats.map((v: Report) => v.name),
            'MySQL summary arms',
          );
          for (const stat of result.stats) {
            const summary: Report = observed.summary.find((v: Report) => v.arm === stat.name);
            for (const [field, expected] of Object.entries({
              n: stat.n,
              p50Ms: stat.median,
              avgMs: stat.avg,
              minMs: stat.min,
              p95Ms: stat.p95,
              p99Ms: stat.p99,
            }))
              assert.equal(summary[field], expected, `MySQL retained operation summary ${field}`);
          }
        }
      const probes = [
        { label: 'head', value: r.drift.head },
        { label: 'tail', value: r.drift.tail },
        ...r.latency.map((v: Report) => ({ label: `RTT ${v.rttMs}`, value: v.measuredSelect1Ms })),
      ];
      assert.equal(r.driftSamples.length, probes.length * 500, 'Complete MySQL drift samples');
      for (const probe of probes) {
        const records: Report[] = r.driftSamples.filter((v: Report) => v.scenario === `drift.${probe.label}`);
        assert.deepEqual(
          records.map((v: Report) => v.round),
          Array.from({ length: 500 }, (_, i) => i),
        );
        assert.ok(
          records.every(
            (v: Report) => v.arm === 'oracle SELECT 1' && Number.isFinite(v.durationMs) && v.durationMs > 0,
          ),
        );
        const values = records.map((v: Report) => v.durationMs).sort((a: number, b: number) => a - b);
        assert.equal(probe.value, (values[249] + values[250]) / 2, 'MySQL drift median differs from retained calls');
      }
    }
  }
}

export function assertComparisonRuns(reports: Report[], engine: Engine, finalManifest?: ComparisonFinalManifest): void {
  assert.ok(reports.length, 'No comparison runs');
  let baseline: unknown;
  for (const r of reports) {
    assertComparisonRun(r, engine, true, finalManifest);
    const identity =
      engine === 'sqlite'
        ? [
            r.identity.head,
            r.identity.node,
            r.identity.executable,
            r.identity.executableSha256,
            r.identity.runtimeVersions,
            r.versions,
            r.settings,
            r.sampleSettings,
            r.hashes,
            r.turbineRuntime,
            r.artifact,
            r.sourceIdentity,
            r.localDistIdentity,
            r.generatedIdentity,
            Object.fromEntries(
              Object.entries(r.dependencies).map(([name, value]) => {
                const d = value as Report;
                return [name, { version: d.version, files: d.files, treeSha256: d.treeSha256 }];
              }),
            ),
          ]
        : [
            r.git.head,
            r.node,
            r.versions,
            r.mode,
            r.groupRounds,
            r.warmup,
            r.hashes,
            r.installed,
            r.executionScope,
            r.boundaryContract,
            r.oracleControlContract,
            mysqlProfile(r),
          ];
    if (baseline !== undefined) assert.deepEqual(identity, baseline, 'Comparison source/runtime/settings changed');
    baseline = identity;
  }
}
