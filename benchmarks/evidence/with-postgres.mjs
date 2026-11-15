import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { positiveInteger } from './workload.mjs';

// This wrapper owns only a cluster it starts. It refuses an already-running
// cluster rather than stopping someone else's service. No sudo or chmod.
const clusterRoot = resolve(process.env.EVIDENCE_PG_ROOT ?? '/tmp/turbine-comparative-postgres');
const bin = resolve(process.env.EVIDENCE_PG_BIN ?? '/usr/lib/postgresql/18/bin');
const user = process.env.EVIDENCE_PG_USER ?? 'evidence';
const port = positiveInteger(process.env.EVIDENCE_PG_PORT ?? '15432', 'EVIDENCE_PG_PORT', 65535);
assert.match(clusterRoot, /^\/tmp\/[A-Za-z0-9_./-]+$/, 'Disposable cluster must be under /tmp with shell-safe path characters');
assert.match(bin, /^\/[A-Za-z0-9_./-]+$/, 'PostgreSQL binary path must have shell-safe characters');
assert.match(user, /^[A-Za-z_][A-Za-z0-9_-]*$/);
const data = join(clusterRoot, 'data');
mkdirSync(clusterRoot, { recursive: true });
assert.equal(statSync(clusterRoot).uid, process.getuid(), 'Cluster root must belong to this user');
if (!existsSync(join(data, 'PG_VERSION'))) {
  execFileSync(join(bin, 'initdb'), ['-D', data, '-U', user, '-A', 'trust', '--no-instructions'], { stdio: 'inherit' });
}
assert.equal(readFileSync(join(data, 'PG_VERSION'), 'utf8').trim(), '18', 'Expected PostgreSQL 18 cluster');
assert.equal(statSync(data).uid, process.getuid(), 'Cluster data must belong to this user');
const status = spawnSync(join(bin, 'pg_ctl'), ['-D', data, 'status'], { encoding: 'utf8' });
assert.equal(status.status, 3, `Refusing cluster that is running or has invalid status: ${status.stdout} ${status.stderr}`);
const socket = join(clusterRoot, 'socket');
mkdirSync(socket, { recursive: true });
const args = ['-h', '127.0.0.1', '-p', String(port), '-k', socket, '-c', 'timezone=UTC'];
const library = join(clusterRoot, 'usr/lib/postgresql');
if (existsSync(library)) args.push('-c', `dynamic_library_path=${library}`);
let started = false;
try {
  execFileSync(join(bin, 'pg_ctl'), ['-D', data, '-l', join(clusterRoot, 'server.log'), '-o', args.join(' '), '-w', 'start'], { stdio: 'inherit' });
  started = true;
  const child = spawn(process.execPath, ['--import', fileURLToPath(new URL('./node_modules/tsx/dist/loader.mjs', import.meta.url)),
    fileURLToPath(new URL('./run.mjs', import.meta.url)), ...process.argv.slice(2)], {
    stdio: 'inherit', env: { ...process.env, EVIDENCE_DISPOSABLE: '1',
      EVIDENCE_PG_ADMIN_URL: `postgresql://${user}@127.0.0.1:${port}/postgres`,
      EVIDENCE_REQUIRE_ENGINES: process.env.EVIDENCE_REQUIRE_ENGINES ?? 'sqlite,postgresql' },
  });
  const interrupt = () => child.kill('SIGTERM');
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', interrupt);
  const code = await new Promise((resolveExit, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => resolveExit(code ?? 1));
  });
  process.off('SIGINT', interrupt);
  process.off('SIGTERM', interrupt);
  process.exitCode = code;
} finally {
  if (started) execFileSync(join(bin, 'pg_ctl'), ['-D', data, '-m', 'fast', '-w', 'stop'], { stdio: 'inherit' });
}
