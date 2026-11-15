import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { bounded, ownedChild } from './lifecycle.mjs';
import { describeReason } from './reason.mjs';

export const entries = ['neon-ws', 'neon-http', 'live-query', 'notification-hub'];
export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
export function archiveIdentity(tarball, pin) {
  assert.ok(tarball && existsSync(tarball), 'Explicit existing tarball required');
  assert.match(pin ?? '', /^[a-f0-9]{64}$/, 'Explicit archive SHA256 required');
  const hash = sha256(readFileSync(tarball));
  assert.equal(hash, pin, 'Archive SHA256 does not match pin');
  const members = execFileSync('tar', ['-tzf', tarball], { encoding: 'utf8' }).trim().split('\n');
  assert.ok(members.every((name) => /^package\//.test(name) && !name.split('/').includes('..')), 'Unsafe archive path');
  const manifest = JSON.parse(execFileSync('tar', ['-xzOf', tarball, 'package/package.json'], { encoding: 'utf8' }));
  validateManifest(manifest, members);
  return { tarball, sha256: hash, manifest, members };
}
export function validateManifest(manifest, members) {
  assert.equal(manifest.name, 'turbine-orm');
  assert.ok(manifest.dependencies?.pg, 'Default pg must remain mandatory');
  assert.equal(manifest.peerDependenciesMeta?.['@neondatabase/serverless']?.optional, true, 'Neon must remain optional');
  assert.ok(manifest.peerDependencies?.['@neondatabase/serverless'], 'Neon peer range required');
  for (const entry of entries) {
    for (const condition of ['import', 'require']) {
      for (const kind of ['types', 'default']) {
        const target = manifest.exports?.[`./${entry}`]?.[condition]?.[kind];
        assert.ok(typeof target === 'string' && target.startsWith('./dist/'), `Missing ${entry} ${condition} ${kind} export`);
        assert.ok(members.includes(`package/${target.slice(2)}`), `Missing archive payload ${target}`);
      }
    }
  }
}
export function files(root, prefix = '') {
  return readdirSync(join(root, prefix), { withFileTypes: true }).flatMap((entry) => {
    const relative = join(prefix, entry.name);
    assert.ok(!entry.isSymbolicLink(), `Unexpected symlink ${relative}`);
    return entry.isDirectory() ? files(root, relative) : [relative];
  });
}
export function installedPayload(reference, installed) {
  const hashes = {};
  for (const file of files(reference)) {
    hashes[file] = sha256(readFileSync(join(reference, file)));
    assert.equal(sha256(readFileSync(join(installed, file))), hashes[file], `Installed payload changed: ${file}`);
  }
  assert.deepEqual(files(installed).sort(), Object.keys(hashes).sort(), 'Installed payload has extra files');
  return hashes;
}
export function prerequisites(native, env) {
  if (!native) return;
  assert.ok(Boolean(env.PG_PREFIX) !== Boolean(env.TURBINE_OPTIONAL_PG_SERVICE_URL), 'Native needs exactly one PG_PREFIX or explicit TURBINE_OPTIONAL_PG_SERVICE_URL');
  if (env.PG_PREFIX) {
    for (const binary of ['initdb', 'postgres']) assert.ok(existsSync(join(env.PG_PREFIX, 'bin', binary)), `Native PostgreSQL ${binary} required`);
  } else {
    const url = new URL(env.TURBINE_OPTIONAL_PG_SERVICE_URL);
    assert.ok(['postgres:', 'postgresql:'].includes(url.protocol), 'Explicit PostgreSQL service URL required');
    assert.equal(env.TURBINE_OPTIONAL_PG_DISPOSABLE, '1', 'Explicit disposable service assertion required');
  }
}
export function validateReport(report) {
  assert.equal(report.success, true, 'Consumer run must succeed');
  assert.match(report.archive?.sha256 ?? '', /^[a-f0-9]{64}$/);
  assert.deepEqual(report.formats, ['esm', 'cjs']);
  assert.equal(report.payloadUnchanged, true);
  assert.equal(report.cleanup?.consumerRemoved, true, 'Consumer cleanup required');
  assert.equal(report.cleanup?.referenceRemoved, true, 'Reference cleanup required');
  assert.equal(report.cleanup?.rootRemoved, true, 'Root cleanup required');
  assert.deepEqual(report.cleanup?.errors, [], 'Cleanup errors must be empty');
  assert.ok(Array.isArray(report.services));
  for (const service of report.services) {
    assert.equal(service.stopped, true, 'Service cleanup required');
    assert.equal(service.connectionsClosed, true, 'Service connections cleanup required');
    assert.equal(service.auditComplete, true, 'Service resource audit required');
    if (service.engine === 'websocket-relay') {
      assert.equal(service.portReleased, true, 'Relay port audit required');
      assert.equal(service.sockets, 0, 'Relay sockets audit required');
      assert.equal(service.webSockets, 0, 'Relay WebSockets audit required');
    } else if (service.engine === 'postgresql') {
      if (service.ownership === 'database-only') assert.equal(service.databaseRemoved, true, 'Owned database cleanup required');
      else {
        assert.ok(service.pid > 0 && service.ownedProcesses?.length > 0, 'Owned PID/group records required');
        assert.deepEqual(service.remainingPids, [], 'Owned PID audit required');
        assert.deepEqual(service.remainingGroups, [], 'Owned group audit required');
        for (const key of ['portReleased', 'datadirRemoved', 'socketRemoved']) assert.equal(service[key], true, `PostgreSQL ${key} audit required`);
      }
    }
  }
  if (report.native?.requested) {
    assert.equal(report.native.verified, true, 'Requested native run cannot skip');
    assert.deepEqual(report.native.formats, ['esm', 'cjs']);
    assert.equal(report.native.actualDriver, '@neondatabase/serverless@1.2.0');
    assert.ok(report.services.some((service) => service.engine === 'postgresql'), 'Native PostgreSQL evidence required');
    assert.ok(report.services.some((service) => service.engine === 'websocket-relay'), 'Actual relay evidence required');
    for (const result of report.native.results) {
      assert.deepEqual(result, { query: 21, transaction: 22, defaultPg: true, connectFailureCleaned: true, invocationRefused: true, disconnected: true, externalPoolSurvived: true, externalClientSurvived: true, failureCleaned: true });
    }
    assert.equal(report.native.results.length, 2, 'Both native format results required');
  } else assert.equal(report.native?.verified, false, 'Pack smoke cannot claim native success');
}
export async function command(report, cwd, binary, args, env = process.env, { scope, timeoutMs = 180_000 } = {}) {
  scope?.assertOpen();
  const record = { cwd, binary, args };
  report.commands.push(record);
  const handle = scope ? scope.spawn(binary, args, { cwd, env, deadlineMs: timeoutMs }, record)
    : ownedChild(binary, args, { cwd, env, deadlineMs: timeoutMs }, record);
  const { child } = handle;
  let stdout = '', stderr = '', failure, failed = false;
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  let abort;
  const interrupted = new Promise((_, reject) => {
    abort = () => reject(scope.signal.reason);
    scope?.signal.addEventListener('abort', abort, { once: true });
    if (scope?.signal.aborted) abort();
  });
  try {
    await bounded(Promise.race([handle.closed, interrupted]), timeoutMs, 'Child command');
    if (handle.spawnError) throw handle.spawnError;
    if (record.code !== 0) throw new Error(`${binary} ${args.join(' ')} failed (${record.code}/${record.signal}): ${stdout}${stderr}`);
  } catch (error) { failed = true; failure = error; scope?.noteFailure(error); record.failure = describeReason(error); }
  finally {
    scope?.signal.removeEventListener('abort', abort);
    try { await handle.stop(); } catch (error) { record.cleanupFailure = describeReason(error); scope?.noteFailure(error); if (!failed) { failed = true; failure = error; } }
    Object.assign(record, { stdout, stderr });
  }
  if (failed) throw failure;
  return stdout;
}

// Node can print a failed suite hook while still reporting zero failed tests.
// A zero exit code alone is insufficient native-suite evidence.
export function nativeTap(stdout) {
  assert.doesNotMatch(stdout, /^\s*not ok\b/m, 'Native suite or hook failed');
  const tests = Number(/^# tests (\d+)$/m.exec(stdout)?.[1]);
  assert.ok(tests >= 12, 'Nonempty complete native suite required');
  assert.match(stdout, /^# fail 0$/m, 'Native test failures must be zero');
  assert.match(stdout, /^# skipped 0$/m, 'Required native suite cannot skip');
  assert.match(stdout, /^# cancelled 0$/m, 'Required native suite cannot cancel');
  assert.match(stdout, /^# native transport cleanup audit: (.+)$/m, 'Native suite cleanup audit required');
  return { tests, skipped: 0, failed: 0, hooksPassed: true, auditPath: /^# native transport cleanup audit: (.+)$/m.exec(stdout)[1] };
}
