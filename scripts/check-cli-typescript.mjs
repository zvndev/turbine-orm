#!/usr/bin/env node
/** Exercise the published bin without a TypeScript-loader preload. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

assert.ok(process.argv[2], 'Usage: node scripts/check-cli-typescript.mjs <packed-tarball>');
const tarball = resolve(process.argv[2]);
const root = mkdtempSync(join(tmpdir(), 'turbine-cli-typescript-'));
// A caller's loader preload could mask the very registration defect being checked.
const env = { ...process.env, DATABASE_URL: '', NODE_OPTIONS: '', NO_COLOR: '1' };
function run(cwd, command, args, expected = 0) {
  const result = spawnSync(command, args, { cwd, env, encoding: 'utf8', timeout: 120000 });
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}\n${result.error ?? ''}`;
  assert.equal(result.status, expected, `${command} ${args.join(' ')}\n${output}`);
  return output;
}

try {
  writeFileSync(join(root, 'package.json'), JSON.stringify({ private: true }));
  run(root, 'npm', ['install', '--no-audit', '--no-fund', tarball, 'tsx']);
  const packageRoot = join(root, 'node_modules/turbine-orm');
  const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
  const bin = join(packageRoot, manifest.bin.turbine);
  for (const type of ['commonjs', 'module']) {
    const dir = join(root, type);
    mkdirSync(dir);
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ private: true, type }));
    const cli = (...args) => run(dir, process.execPath, [bin, ...args]);
    cli('init', '--engine', 'sqlite', '--url', './app.sqlite', '--yes');
    assert.match(readFileSync(join(dir, 'turbine.config.ts'), 'utf8'), /engine: 'sqlite'/);
    cli('status');
    const db = new DatabaseSync(join(dir, 'app.sqlite'));
    try {
      db.exec('CREATE TABLE records(id INTEGER PRIMARY KEY, label TEXT);');
    } finally {
      db.close();
    }
    const before = readFileSync(join(dir, 'app.sqlite'));
    cli('pull', '--no-timestamp');
    cli('generate', '--no-timestamp');
    cli('migrate', 'status');
    assert.match(readFileSync(join(dir, 'generated/turbine/index.ts'), 'utf8'), /turbine-orm\/sqlite/);
    assert.deepEqual(readFileSync(join(dir, 'app.sqlite')), before);
    const help = cli('--help');
    const suggested = help.match(/use (migrate --engine sqlite --help) for its workflow/)?.[1];
    assert.ok(suggested, 'root help must advertise a working SQLite help invocation');
    assert.match(cli(...suggested.split(' ')), /Native migration writes require Node >=24\.10/);

    // Shared PG config loading needs no live connection for manual migration creation.
    writeFileSync(
      join(dir, 'turbine.config.ts'),
      "export default { url: 'postgresql://127.0.0.1:1/unused', migrationsDir: './pg-migrations' };\n",
    );
    cli('migrate', 'create', 'config_loaded');
    assert.ok(readdirSync(join(dir, 'pg-migrations')).some((name) => name.endsWith('_config_loaded.sql')));
    console.log(`check-cli-typescript: ${type} .ts config, SQLite read workflow, PG create and help pass`);
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}
