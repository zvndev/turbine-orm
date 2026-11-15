import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { archiveIdentity, command, entries, installedPayload, nativeTap, prerequisites, sha256, validateReport } from './harness.mjs';
import { checkOptionalPg } from '../../scripts/check-optional-pg-transports.mjs';

async function fixture(body) {
  const root = mkdtempSync(join(tmpdir(), 'optional-gate-control-'));
  try { await body(root); } finally { rmSync(root, { recursive: true, force: true }); }
}
function archive(root, omit) {
  const pkg = { name: 'turbine-orm', dependencies: { pg: '^8.15.0' }, peerDependencies: { '@neondatabase/serverless': '^1.2.0' }, peerDependenciesMeta: { '@neondatabase/serverless': { optional: true } }, exports: {} };
  const members = [];
  mkdirSync(join(root, 'package/dist/cjs'), { recursive: true });
  for (const entry of entries) {
    pkg.exports[`./${entry}`] = {};
    for (const condition of ['import', 'require']) {
      const prefix = condition === 'import' ? 'dist' : 'dist/cjs';
      pkg.exports[`./${entry}`][condition] = { types: `./${prefix}/${entry}.d.ts`, default: `./${prefix}/${entry}.js` };
      for (const suffix of ['d.ts', 'js']) {
        const path = `${prefix}/${entry}.${suffix}`;
        writeFileSync(join(root, 'package', path), '// isolated omission fixture\n');
        members.push(`package/${path}`);
      }
    }
  }
  if (omit) delete pkg.exports[`./${omit}`];
  writeFileSync(join(root, 'package/package.json'), JSON.stringify(pkg));
  const tarball = join(root, 'control.tgz');
  execFileSync('tar', ['-czf', tarball, '-C', root, 'package']);
  return { tarball, pin: sha256(readFileSync(tarball)) };
}
test('archive pins reject absent, missing, mismatched and changed bytes before install', () => fixture((root) => {
  const { tarball, pin } = archive(root);
  assert.throws(() => archiveIdentity(), /tarball required/);
  assert.throws(() => archiveIdentity(tarball), /Explicit archive SHA256/);
  assert.throws(() => archiveIdentity(tarball, '0'.repeat(64)), /does not match pin/);
  assert.equal(archiveIdentity(tarball, pin).sha256, pin);
  writeFileSync(tarball, 'changed archive');
  assert.throws(() => archiveIdentity(tarball, pin), /does not match pin/);
}));
test('an absent optional export fails the actual CLI path without install or overlay', () => fixture(async (root) => {
  const { tarball, pin } = archive(root, 'live-query');
  const report = join(root, 'report.json');
  await assert.rejects(checkOptionalPg([tarball, '--sha256', pin, '--report', report]), /Missing live-query import types export/);
  const evidence = JSON.parse(readFileSync(report));
  assert.equal(evidence.success, false); assert.deepEqual(evidence.commands, []);
}));
test('native prerequisites ignore ambient DATABASE_URL and demand explicit disposable authorization', () => {
  assert.throws(() => prerequisites(true, { DATABASE_URL: 'postgres://borrowed' }), /exactly one/);
  assert.throws(() => prerequisites(true, { PG_PREFIX: '/absent' }), /initdb required/);
  assert.throws(() => prerequisites(true, { TURBINE_OPTIONAL_PG_SERVICE_URL: 'postgres://localhost/service' }), /disposable service assertion/);
  assert.throws(() => prerequisites(true, { PG_PREFIX: '/a', TURBINE_OPTIONAL_PG_SERVICE_URL: 'postgres://localhost/service' }), /exactly one/);
  prerequisites(true, { TURBINE_OPTIONAL_PG_SERVICE_URL: 'postgres://localhost/service', TURBINE_OPTIONAL_PG_DISPOSABLE: '1' });
  prerequisites(false, {});
});
test('source CI gate refuses absent service admission and preserves failure evidence', () => fixture((root) => {
  const output = join(root, 'source-report.json');
  const env = { ...process.env, TURBINE_NEON_WS_GATE_REPORT: output };
  delete env.TURBINE_NEON_WS_PG_SERVICE_URL;
  assert.throws(() => execFileSync(process.execPath, [fileURLToPath(new URL('./source-suite-gate.mjs', import.meta.url))], {
    env, stdio: 'pipe',
  }), (error) => error.status === 1 && /Explicit WS native service URL required/.test(String(error.stderr)));
  const report = JSON.parse(readFileSync(output));
  assert.equal(report.success, false);
  assert.deepEqual(report.commands, []);
  assert.match(report.failure, /Explicit WS native service URL required/);
}));
test('missing native prerequisite fails CLI before package install', () => fixture(async (root) => {
  const { tarball, pin } = archive(root);
  const saved = { ...process.env };
  delete process.env.PG_PREFIX; delete process.env.TURBINE_OPTIONAL_PG_SERVICE_URL;
  try {
    const output = join(root, 'report.json');
    await assert.rejects(checkOptionalPg([tarball, '--sha256', pin, '--native', '--report', output]), /exactly one/);
    assert.deepEqual(JSON.parse(readFileSync(output)).commands, []);
  } finally { process.env = saved; }
}));
test('payload comparator refuses altered manifests, missing helpers and extra files in isolated copies', () => fixture((root) => {
  const source = join(root, 'reference'), installed = join(root, 'installed');
  mkdirSync(source); writeFileSync(join(source, 'package.json'), '{"exports":{}}'); writeFileSync(join(source, 'helper.js'), 'real helper');
  cpSync(source, installed, { recursive: true }); installedPayload(source, installed);
  writeFileSync(join(installed, 'package.json'), '{"exports":{"./fake":"./fake.js"}}');
  assert.throws(() => installedPayload(source, installed), /Installed payload changed/);
  cpSync(source, installed, { recursive: true }); rmSync(join(installed, 'helper.js'));
  assert.throws(() => installedPayload(source, installed), /ENOENT/);
  cpSync(source, installed, { recursive: true }); writeFileSync(join(installed, 'fake.js'), 'overlay');
  assert.throws(() => installedPayload(source, installed), /extra files/);
}));
function evidence() {
  return { success: true, archive: { sha256: 'a'.repeat(64) }, formats: ['esm', 'cjs'], payloadUnchanged: true, cleanup: { consumerRemoved: true, referenceRemoved: true, rootRemoved: true, errors: [] }, services: [], native: { requested: false, verified: false } };
}
test('pack-only success cannot become native success or silently skip a required native run', () => {
  validateReport(evidence());
  const fake = evidence(); fake.native.verified = true;
  assert.throws(() => validateReport(fake), /Pack smoke cannot claim native success/);
  fake.native.requested = true; fake.native.verified = false;
  assert.throws(() => validateReport(fake), /cannot skip/);
  Object.assign(fake.native, { verified: true, formats: ['esm', 'cjs'], actualDriver: '@neondatabase/serverless@1.2.0', results: [] });
  assert.throws(() => validateReport(fake), /Native PostgreSQL evidence required/);
  fake.services = [{ engine: 'postgresql', ownership: 'database-only', databaseRemoved: true, stopped: true, connectionsClosed: true, auditComplete: true }, { engine: 'websocket-relay', stopped: true, connectionsClosed: true, auditComplete: true, portReleased: true, sockets: 0, webSockets: 0 }];
  assert.throws(() => validateReport(fake), /Both native format results required/);
  fake.native.results = [{ skipped: true }, { skipped: true }];
  assert.throws(() => validateReport(fake));
});
test('cleanup omissions and service cleanup failures refuse success', () => {
  for (const field of ['consumerRemoved', 'referenceRemoved', 'rootRemoved']) {
    const report = evidence(); delete report.cleanup[field]; assert.throws(() => validateReport(report), /cleanup required/);
  }
  for (const field of ['stopped', 'connectionsClosed', 'auditComplete']) {
    const report = evidence(); const service = { engine: 'postgresql', stopped: true, connectionsClosed: true, auditComplete: true };
    delete service[field]; report.services.push(service); assert.throws(() => validateReport(report), /cleanup required|resource audit required/);
  }
});
test('child failure cannot be swallowed even with a success-looking stdout marker', async () => {
  const report = { commands: [] };
  await assert.rejects(command(report, tmpdir(), process.execPath, ['-e', 'console.log("native verified");process.exitCode=7']), /failed \(7/);
  assert.equal(report.commands[0].code, 7); assert.ok(report.commands[0].pid > 0);
});

test('resource audit cannot omit PID, socket, datadir, database or port proof', () => {
  const service = { engine: 'postgresql', pid: 123, ownedProcesses: [{ pid: 123, group: 123 }], remainingPids: [], remainingGroups: [], stopped: true, connectionsClosed: true, auditComplete: true, datadirRemoved: true, socketRemoved: true, portReleased: true };
  const full = evidence(); full.services = [service]; validateReport(full);
  for (const key of ['ownedProcesses', 'remainingPids', 'remainingGroups', 'datadirRemoved', 'socketRemoved', 'portReleased']) {
    const report = structuredClone(full); delete report.services[0][key]; assert.throws(() => validateReport(report));
  }
  const database = evidence(); database.services = [{ engine: 'postgresql', ownership: 'database-only', stopped: true, connectionsClosed: true, auditComplete: true }];
  assert.throws(() => validateReport(database), /Owned database cleanup required/);
  const relay = evidence(); relay.services = [{ engine: 'websocket-relay', stopped: true, connectionsClosed: true, auditComplete: true }];
  assert.throws(() => validateReport(relay), /Relay port audit required/);
});

test('zero-exit TAP with failed suite hook, no tests, cancellation, skips or absent audit is refused', () => {
  const stdout = '# native transport cleanup audit: /isolated/audit.json\n# tests 12\n# fail 0\n# skipped 0\n# cancelled 0\n';
  assert.equal(nativeTap(stdout).tests, 12);
  for (const output of [
    `not ok 1 - suite hook failed\n${stdout}`,
    stdout.replace('# tests 12', '# tests 0'),
    stdout.replace('# fail 0', '# fail 1'),
    stdout.replace('# skipped 0', '# skipped 12'),
    stdout.replace('# cancelled 0', '# cancelled 1'),
    stdout.replace(/^# native transport cleanup audit:.*\n/m, ''),
  ]) assert.throws(() => nativeTap(output));
});

// Keep the existing CI/package entrypoint authoritative for lifecycle controls too.
import './lifecycle.test.mjs';
import './native-service.test.mjs';
