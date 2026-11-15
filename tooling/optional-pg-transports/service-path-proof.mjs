// Local proof of the CI service path. Own the surrounding native service too.
// Usage: PG_PREFIX=... node tooling/optional-pg-transports/service-path-proof.mjs <tarball> <sha256> <report>
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, existsSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startService } from './native-service.mjs';
import { archiveIdentity, command, prerequisites } from './harness.mjs';
import { runWithShutdown } from './run.mjs';
const require = createRequire(import.meta.url);
const [tarball, pin, output, sourceSuite] = process.argv.slice(2);
archiveIdentity(resolve(tarball), pin);
prerequisites(true, { PG_PREFIX: process.env.PG_PREFIX });
assert.ok(output, 'Explicit report path required');
const root = mkdtempSync(join(tmpdir(), 'turbine-optional-service-proof-'));
const report = { scope: 'local owned PostgreSQL surrounding explicit CI service path; no hosted certification', runtime: process.version, commands: [], services: [] };
report.root = root;
try { await runWithShutdown(report, resolve(output), async (scope) => {
  const env = { ...process.env, LD_LIBRARY_PATH: [join(process.env.PG_PREFIX, 'lib'), process.env.LD_LIBRARY_PATH].filter(Boolean).join(':') };
  const service = await startService({ root, env, pg: require('pg'), WebSocketServer: require('ws').WebSocketServer, report, scope });
  const serviceEnv = { ...process.env, TURBINE_OPTIONAL_PG_SERVICE_URL: service.url, TURBINE_OPTIONAL_PG_DISPOSABLE: '1' };
  delete serviceEnv.PG_PREFIX;
  const consumerReport = `${resolve(output)}.consumer.json`;
  await command(report, process.cwd(), process.execPath, ['scripts/check-optional-pg-transports.mjs', resolve(tarball), '--sha256', pin, '--native', '--report', consumerReport], serviceEnv, { scope });
  report.consumerReport = consumerReport;
  const sourceEnv = { ...process.env, TURBINE_NEON_WS_PG_SERVICE_URL: service.url, TURBINE_NEON_WS_PG_DISPOSABLE: '1' };
  await command(report, process.cwd(), process.execPath, ['--import', 'tsx', 'tooling/optional-pg-transports/source-service-probe.mjs'], sourceEnv, { scope });
  if (sourceSuite) {
    assert.equal(resolve(sourceSuite), resolve('src/test/neon-ws-native.test.ts'), 'Only the committed native source gate is supported');
    const sourceReport = `${resolve(output)}.source.json`;
    await command(report, process.cwd(), process.execPath, ['tooling/optional-pg-transports/source-suite-gate.mjs'], { ...sourceEnv, TURBINE_NEON_WS_GATE_REPORT: sourceReport }, { scope });
    const sourceEvidence = JSON.parse(readFileSync(sourceReport, 'utf8'));
    assert.equal(sourceEvidence.success, true);
    report.sourceNative = sourceEvidence.sourceNative;
    assert.equal(report.sourceNative.audit.auditComplete, true);
    assert.equal(report.sourceNative.audit.databaseRemoved, true);
    assert.equal(report.sourceNative.audit.socketCount, 0);
    assert.equal(report.sourceNative.audit.activeWebSockets, 0);
  }
}, async () => {
  rmSync(root, { recursive: true, force: true });
  report.rootRemoved = !existsSync(root);
}); } catch (error) { console.error(error.stack); process.exitCode ||= 1; }
