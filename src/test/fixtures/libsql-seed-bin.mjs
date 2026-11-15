/** Actual installed bin, isolated local files and bounded child processes. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync, readlinkSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { createClient } from '@libsql/client/node';

const require = createRequire(import.meta.url);
const bin =
  process.env.LIBSQL_SEED_FORMAT === 'cjs'
    ? resolve('node_modules/turbine-orm/dist/cjs/cli/index.js')
    : resolve('node_modules/.bin/turbine');
const dir = await mkdtemp(resolve('bin-project-'));
const url = `file:${join(dir, 'data.db')}`;
const marker = join(dir, 'imported');
const active = new Set();
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, async () => {
    for (const child of active) child.kill('SIGKILL');
    await Promise.all([...active].map((child) => new Promise((done) => child.once('close', done))));
    if (!native.closed) native.close();
    await rm(dir, { recursive: true, force: true });
    process.exit(1);
  });
}
async function run(args) {
  const child = spawn(process.execPath, [bin, ...args], {
    cwd: dir,
    env: { ...process.env, DATABASE_URL: '', NO_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  active.add(child);
  const identity = {
    pid: child.pid,
    group: Number(readFileSync(`/proc/${child.pid}/stat`, 'utf8').split(' ')[4]),
    starttime: readFileSync(`/proc/${child.pid}/stat`, 'utf8').split(' ')[21],
    executable: readlinkSync(`/proc/${child.pid}/exe`),
    cwd: dir,
    bin,
    args,
    port: null,
  };
  let output = '';
  child.stdout.on('data', (chunk) => {
    output += chunk;
  });
  child.stderr.on('data', (chunk) => {
    output += chunk;
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill('SIGKILL');
  }, 10000);
  const result = await new Promise((done, reject) => {
    child.once('error', reject);
    child.once('close', (status, signal) => done({ status, signal, output }));
  }).finally(() => {
    clearTimeout(timer);
    active.delete(child);
  });
  let absent = false;
  try {
    readFileSync(`/proc/${child.pid}/stat`);
  } catch (error) {
    if (error.code === 'ENOENT') absent = true;
    else throw error;
  }
  console.log(JSON.stringify({ ...identity, ...result, timedOut, pid_absent: absent }));
  assert.equal(timedOut, false);
  assert.equal(absent, true);
  return result;
}
async function config(seedFile, extra = '') {
  await writeFile(
    join(dir, 'turbine.config.mjs'),
    `export default { engine: 'libsql', url: ${JSON.stringify(url)}, seedFile: ${JSON.stringify(seedFile)}${extra} };`,
  );
}
const native = createClient({ url, intMode: 'bigint' });
try {
  await native.execute('CREATE TABLE items(id INTEGER PRIMARY KEY, label TEXT)');
  native.close();
  const noTsx = (() => {
    try {
      require.resolve('tsx');
      return false;
    } catch {
      return true;
    }
  })();
  for (const [id, ext] of ['mjs', 'cjs', 'js', 'mts', 'cts', 'ts'].entries()) {
    const seedFile = join(dir, `seed.${ext}`);
    const prefix = ['cjs', 'cts', 'js', 'ts'].includes(ext) ? 'module.exports =' : 'export default';
    const type = /ts$/.test(ext) ? ": import('turbine-orm/libsql/seed').LibsqlSeedClient" : '';
    await writeFile(
      seedFile,
      `${prefix} async (tx${type}) => { await tx.rawUnsafe('INSERT INTO items VALUES($1, $2)', ${id}, '${ext}'); };`,
    );
    await config(seedFile);
    const result = await run(['seed', '--engine', 'libsql']);
    if (/ts$/.test(ext) && noTsx) {
      assert.notEqual(result.status, 0);
      assert.match(result.output, /Install tsx|TypeScript libSQL seed/);
    } else assert.equal(result.status, 0, result.output);
  }
  const seedFile = join(dir, 'failure.mjs');
  await writeFile(
    seedFile,
    `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'imported'); export default async tx => { await tx.rawUnsafe("INSERT INTO items VALUES(99, 'rollback')"); throw new Error('seed callback failed'); }`,
  );
  await config(seedFile);
  const rollback = await run(['seed']); // Config-selected engine.
  assert.notEqual(rollback.status, 0);
  assert.match(rollback.output, /seed callback failed/);
  assert.equal(await readFile(marker, 'utf8'), 'imported');
  await rm(marker);
  for (const args of [
    ['seed', '--dry-run'],
    ['seed', '--preview'],
    ['seed', '--url', '--help'],
    ['seed', 'seed.sql'],
    ['seed', '--url', 'libsql://example.invalid'],
    ['seed', '--url', 'file:data.db?syncUrl=x'],
    ['seed', '--schema', 'main'],
  ]) {
    const result = await run(args);
    assert.notEqual(result.status, 0, result.output);
    await assert.rejects(readFile(marker), /ENOENT/);
  }
  const sql = join(dir, 'seed.sql');
  await writeFile(sql, "INSERT INTO items VALUES(98, 'sql')");
  await config(sql);
  const sqlResult = await run(['seed']);
  assert.notEqual(sqlResult.status, 0);
  assert.match(sqlResult.output, /SQL seed files/);
  await config(seedFile);
  const help = await run(['seed', '--help']);
  assert.equal(help.status, 0, help.output);
  await assert.rejects(readFile(marker), /ENOENT/);
  const missing = await run(['seed', '--url', `file:${join(dir, 'missing.db')}`]);
  assert.notEqual(missing.status, 0);
  await assert.rejects(readFile(join(dir, 'missing.db')), /ENOENT/);
  await assert.rejects(readFile(marker), /ENOENT/);
  const verify = createClient({ url, intMode: 'bigint' });
  try {
    const labels = (await verify.execute('SELECT label FROM items ORDER BY id')).rows.map((row) => row[0]);
    assert.deepEqual(labels, noTsx ? ['mjs', 'cjs', 'js'] : ['mjs', 'cjs', 'js', 'mts', 'cts', 'ts']);
  } finally {
    verify.close();
  }
  console.log(
    JSON.stringify({
      version: process.version,
      format: process.env.LIBSQL_SEED_FORMAT ?? 'esm',
      actual_bin: true,
      noTsx,
      local: true,
    }),
  );
} finally {
  if (!native.closed) native.close();
  await rm(dir, { recursive: true, force: true });
}
