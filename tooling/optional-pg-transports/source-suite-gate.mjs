// Existing CI service admission: require successful tests AND successful cleanup hooks.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { command, nativeTap } from './harness.mjs';
import { runWithShutdown } from './run.mjs';

const reportPath = resolve(process.env.TURBINE_NEON_WS_GATE_REPORT ?? 'optional-pg-source.json');
const report = { scope: 'source WS native suite on an explicitly disposable service', commands: [], success: false };
try { await runWithShutdown(report, reportPath, async (scope) => {
  assert.ok(process.env.TURBINE_NEON_WS_PG_SERVICE_URL, 'Explicit WS native service URL required');
  assert.equal(process.env.TURBINE_NEON_WS_PG_DISPOSABLE, '1', 'Disposable WS service assertion required');
  const stdout = await command(report, process.cwd(), process.execPath,
    ['--import', 'tsx', '--test', '--test-reporter=tap', 'src/test/neon-ws-native.test.ts'],
    { ...process.env, TURBINE_REQUIRE_NEON_WS: '1' }, { scope });
  report.sourceNative = nativeTap(stdout);
  const audit = JSON.parse(readFileSync(report.sourceNative.auditPath, 'utf8'));
  assert.equal(audit.ownership, 'database-only');
  for (const key of ['stopped', 'connectionsClosed', 'auditComplete', 'databaseRemoved']) assert.equal(audit[key], true, `${key} required`);
  assert.equal(audit.socketCount, 0);
  assert.equal(audit.activeWebSockets, 0);
  report.sourceNative.audit = audit;
  });
} catch (error) { console.error(error.stack); process.exitCode ||= 1; }
if (report.success) console.log(`Native WS source gate passed ${report.sourceNative.tests} tests with cleanup: ${reportPath}`);
