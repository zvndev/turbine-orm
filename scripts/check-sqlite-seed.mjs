#!/usr/bin/env node
/** Real packed SQLite seed consumers, with no TypeScript-loader preload. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

assert.ok(process.argv[2], 'Usage: node scripts/check-sqlite-seed.mjs <tested-tarball>');
const tarball = resolve(process.argv[2]);
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = mkdtempSync(join(tmpdir(), 'turbine-packed-seed-'));
const env = { ...process.env, DATABASE_URL: '', NODE_OPTIONS: '', NO_COLOR: '1' };
function run(cwd, command, args, expected = 0) {
  const result = spawnSync(command, args, { cwd, env, encoding: 'utf8', timeout: 120_000 });
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}\n${result.error ?? ''}`;
  assert.equal(result.status, expected, `${command} ${args.join(' ')}\n${output}`);
  return output;
}
function rows(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try { return db.prepare('SELECT label FROM items ORDER BY id').all().map(row => row.label); }
  finally { db.close(); }
}

try {
  writeFileSync(join(root, 'package.json'), JSON.stringify({ private: true }));
  run(root, 'npm', ['install', '--no-audit', '--no-fund', tarball]);
  const pkg = join(root, 'node_modules/turbine-orm');
  const manifest = JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8'));
  assert.deepEqual(Object.keys(manifest.dependencies), ['pg']);
  const bin = join(pkg, manifest.bin.turbine);

  // Explicit TS loader prerequisite must fail even on runtimes with native TS
  // stripping; no ambient NODE_OPTIONS or source-tree loader can mask it.
  const missing = join(root, 'missing-tsx');
  mkdirSync(missing);
  const db = new DatabaseSync(join(missing, 'app.sqlite'));
  db.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, label TEXT NOT NULL)');
  db.close();
  writeFileSync(join(missing, 'turbine.config.mjs'), "export default { engine: 'sqlite', url: './app.sqlite' };");
  writeFileSync(join(missing, 'seed.ts'), 'export default async () => {};');
  assert.match(run(missing, process.execPath, [bin, 'seed'], 1), /Cannot load TypeScript SQLite seed \(missing\).*Install tsx/);

  // Native import/require of the new subpath needs no tsx at all.
  for (const ext of ['mjs', 'cjs']) {
    const imports = ext === 'mjs'
      ? "import assert from 'node:assert/strict'; import { DatabaseSync } from 'node:sqlite'; import { defineSqliteSeed, runSqliteSeed } from 'turbine-orm/sqlite/seed'; import { introspectSqliteDatabase } from 'turbine-orm/sqlite';"
      : "const assert = require('node:assert/strict'); const { DatabaseSync } = require('node:sqlite'); const { defineSqliteSeed, runSqliteSeed } = require('turbine-orm/sqlite/seed'); const { introspectSqliteDatabase } = require('turbine-orm/sqlite');";
    writeFileSync(join(root, `native.${ext}`), `${imports}
(async () => {
  const handle = new DatabaseSync(':memory:');
  try {
    handle.exec('CREATE TABLE items (id INTEGER PRIMARY KEY)');
    const schema = introspectSqliteDatabase(handle);
    await runSqliteSeed(handle, schema, defineSqliteSeed(async tx => { await tx.raw\`INSERT INTO items VALUES (1)\`; }));
    await assert.rejects(() => runSqliteSeed(handle, schema, async tx => { await tx.raw\`INSERT INTO items VALUES (2)\`; throw new Error('rollback'); }), /rollback/);
    assert.deepEqual(handle.prepare('SELECT id FROM items').all().map(row => row.id), [1]);
    handle.exec('BEGIN EXCLUSIVE; ROLLBACK');
  } finally { handle.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
`);
    run(root, process.execPath, [join(root, `native.${ext}`)]);
  }

  const types = `import { defineSqliteSeed, runSqliteSeed, type SqliteSeedFunction } from 'turbine-orm/sqlite/seed';
import { DatabaseSync } from 'node:sqlite';
const seed: SqliteSeedFunction = defineSqliteSeed(async tx => {
  await tx.table<{ id: number; label: string }>('items').create({ data: { id: 1, label: 'typed' } });
  // @ts-expect-error Transaction callbacks cannot disconnect the owning client.
  tx.disconnect();
});
void runSqliteSeed(new DatabaseSync(':memory:'), { tables: {}, enums: {} }, seed);
// @ts-expect-error Callbacks receive a transaction, not a filename.
defineSqliteSeed((path: string) => {});
// @ts-expect-error A seed must finish without returning an unrelated value.
defineSqliteSeed(() => 123);
`;
  for (const ext of ['mts', 'cts']) writeFileSync(join(root, `types.${ext}`), types);
  writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { strict: true, skipLibCheck: false, noEmit: true, target: 'ES2023', module: 'NodeNext', moduleResolution: 'NodeNext', types: ['node'], typeRoots: [join(repo, 'node_modules/@types')] },
    files: ['types.mts', 'types.cts'],
  }));
  run(root, process.execPath, [join(repo, 'node_modules/typescript/bin/tsc'), '-p', join(root, 'tsconfig.json')]);

  const dev = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')).devDependencies;
  run(root, 'npm', ['install', '--no-audit', '--no-fund', `tsx@${dev.tsx}`]);
  for (const type of ['module', 'commonjs']) {
    const dir = join(root, type);
    mkdirSync(dir);
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ private: true, type }));
    const cli = (...args) => run(dir, process.execPath, [bin, ...args]);
    cli('init', '--engine', 'sqlite', '--url', './app.sqlite', '--yes');
    const file = join(dir, 'app.sqlite');
    const handle = new DatabaseSync(file);
    handle.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, label TEXT NOT NULL)');
    handle.close();
    for (const [i, ext] of ['ts', 'mts', 'cts'].entries()) {
      writeFileSync(join(dir, 'turbine.config.ts'), `export default { engine: 'sqlite', url: './app.sqlite', seedFile: './seed.${ext}' };`);
      const seed = join(dir, `seed.${ext}`);
      const prefix = "import { defineSqliteSeed } from 'turbine-orm/sqlite/seed';\nexport default defineSqliteSeed(async tx => {\n";
      writeFileSync(seed, `${prefix} await tx.raw\`INSERT INTO items VALUES (${i + 1}, '${ext}')\`; throw new Error('injected callback failure'); });`);
      assert.match(run(dir, process.execPath, [bin, 'seed'], 1), /injected callback failure/);
      assert.equal(rows(file).length, i, 'failed callback must leave no partial write');
      writeFileSync(seed, `${prefix} await tx.raw\`INSERT INTO items VALUES (${i + 1}, '${ext}')\`; });`);
      assert.match(cli('seed'), /Seed completed/);
      assert.deepEqual(rows(file), ['ts', 'mts', 'cts'].slice(0, i + 1));
    }
  }
  console.log('SQLite packed seeds: native ESM/CJS, strict .mts/.cts types, missing-tsx refusal and ESM/CommonJS TS process rollback/rerun passed');
} finally {
  rmSync(root, { recursive: true, force: true });
}
