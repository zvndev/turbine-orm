#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Own one uniquely named, digest-pinned container with disposable memory-backed
// storage. This never attaches to the shared CI services or changes their pins.
const directory = dirname(fileURLToPath(import.meta.url));
const [engine, target] = process.argv.slice(2);
assert.ok(['postgresql', 'mysql'].includes(engine) && target && process.argv.length === 4,
  'Usage: native-gate-container.mjs postgresql|mysql NEW_REPORT.json');
const output = resolve(target);
const identityPath = `${output}.container.json`;
writeFileSync(identityPath, '{"status":"initializing"}\n', { flag: 'wx', mode: 0o600 });
const services = JSON.parse(readFileSync(join(directory, 'native-gate-services.json')));
const mysqlServices = JSON.parse(readFileSync(join(directory, 'services.json')));
const pin = services[engine];
const image = engine === 'mysql' ? mysqlServices.images.mysql.image : pin.image;
assert.match(image, /@sha256:[a-f0-9]{64}$/);
const name = `turbine-native-gate-${randomBytes(12).toString('hex')}`;
const password = randomBytes(24).toString('hex');
const port = engine === 'postgresql' ? 5432 : 3306;
const env = { ...process.env, POSTGRES_PASSWORD: password, MYSQL_ROOT_PASSWORD: password };
const identity = { status: 'running', engine, name, image, platform: 'linux/amd64', expectedVersion: pin.expectedVersion,
  storage: 'fresh tmpfs; no host volumes', cleanup: { containerRemoved: false } };
const save = () => writeFileSync(identityPath, `${JSON.stringify(identity, null, 2)}\n`);
function docker(args, options = {}) {
  return execFileSync('docker', args, { encoding: 'utf8', env, timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'], ...options }).trim();
}
let owned = false, child, interrupted = false;
const onSignal = () => { interrupted = true; child?.kill('SIGTERM'); };
process.on('SIGINT', onSignal); process.on('SIGTERM', onSignal);
try {
  save();
  // Pull failure must fail the job, never fall back to a tag or shared service.
  docker(['pull', '--platform', 'linux/amd64', image], { timeout: 180000 });
  const args = ['run', '--detach', '--name', name, '--platform', 'linux/amd64', '--publish', `127.0.0.1::${port}`,
    '--tmpfs', engine === 'postgresql' ? '/var/lib/postgresql:rw' : '/var/lib/mysql:rw'];
  args.push(...(engine === 'postgresql' ? ['--env', 'POSTGRES_PASSWORD', '--env', 'POSTGRES_USER=evidence']
    : ['--env', 'MYSQL_ROOT_PASSWORD', '--env', 'MYSQL_ROOT_HOST=%']));
  owned = true;
  identity.id = docker([...args, image]);
  save();
  const deadline = Date.now() + 120000;
  for (;;) {
    if (interrupted) throw new Error('Container gate interrupted');
    try {
      docker(['exec', name, ...(engine === 'postgresql' ? ['pg_isready', '-h', '127.0.0.1', '-U', 'evidence']
        : ['mysqladmin', 'ping', '-h', '127.0.0.1', '--silent'])]);
      break;
    } catch {
      if (Date.now() >= deadline || docker(['inspect', '--format', '{{.State.Running}}', name]) !== 'true') throw new Error('Owned container did not become ready');
      await new Promise(done => setTimeout(done, 250));
    }
  }
  const mapping = docker(['port', name, `${port}/tcp`]);
  assert.match(mapping, /^127\.0\.0\.1:\d+$/);
  const url = new URL(`${engine === 'postgresql' ? 'postgresql://evidence' : 'mysql://root'}@${mapping}/${engine === 'postgresql' ? 'postgres' : 'mysql'}`);
  url.password = password;
  const variable = engine === 'postgresql' ? 'EVIDENCE_PG_ADMIN_URL' : 'EVIDENCE_MYSQL_ADMIN_URL';
  child = spawn(process.execPath, [join(directory, 'native-gate.mjs'), engine, pin.expectedVersion, output], {
    stdio: 'inherit', env: { ...process.env, EVIDENCE_DISPOSABLE: '1', [variable]: url.href },
  });
  const code = await new Promise((done, reject) => { child.once('error', reject); child.once('exit', code => done(code)); });
  assert.equal(code, 0, 'Native gate failed');
  assert.equal(interrupted, false, 'Container gate interrupted');
  identity.status = 'complete';
} catch {
  identity.status = 'invalid';
  process.exitCode = 1;
  console.error(`Pinned native container gate failed; inspect ${identityPath}`);
} finally {
  process.off('SIGINT', onSignal); process.off('SIGTERM', onSignal);
  if (owned) {
    try {
      try { docker(['rm', '--force', '--volumes', name]); } catch { /* Verify absence below, including a failed initial run. */ }
      // Require an actual absence check; cleanup failure invalidates the run.
      const names = docker(['ps', '--all', '--filter', `name=^/${name}$`, '--format', '{{.Names}}']);
      assert.equal(names, '');
      identity.cleanup.containerRemoved = true;
    } catch { identity.status = 'invalid'; process.exitCode = 1; }
  }
  save();
}
