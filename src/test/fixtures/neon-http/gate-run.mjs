// Existing PG gate admission. The caller owns its configured PG; this fixture owns only its children.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkpoint, OwnedChildren, persist } from './native-lifecycle.mjs';

assert.ok(process.env.NEON_HTTP_NATIVE_URL, 'NEON_HTTP_NATIVE_URL required for native HTTP gate');
assert.ok(process.env.NEON_HTTP_EVIDENCE, 'NEON_HTTP_EVIDENCE required for gate evidence');
const output = resolve(process.env.NEON_HTTP_EVIDENCE);
mkdirSync(output, { recursive: true });
const reportPath = process.env.NEON_HTTP_NATIVE_REPORT ?? join(output, 'source-native.json');
const report = { passed: false, commands: [], failures: [], interruptions: [] };
const save = () => persist(join(output, `gate-lifecycle-${process.pid}.json`), report);
const children = new OwnedChildren({
  cwd: fileURLToPath(new URL('../../../../', import.meta.url)),
  report,
  onChange: save,
  env: { ...process.env, TZ: 'UTC', TURBINE_REQUIRE_NEON_HTTP_NATIVE: '1', NEON_HTTP_NATIVE_REPORT: reportPath },
});
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    const error = new Error(`Interrupted by ${signal}`);
    report.interruptions.push(signal);
    report.primaryFailure ??= error.stack;
    report.failures.push(error.stack);
    report.passed = false;
    process.exitCode = report.interruptions[0] === 'SIGINT' ? 130 : 143;
    children.seal(error);
    save();
  });
}
try {
  await children.run(
    'required-native-http',
    process.execPath,
    ['--import', 'tsx', '--test', 'src/test/neon-http-native.test.ts'],
    { timeout: 60_000, log: join(output, `gate-native-${process.pid}.log`) },
  );
  const evidence = JSON.parse(readFileSync(reportPath));
  assert.equal(evidence.cases.length, 14, 'All native HTTP acceptance cases must run');
  assert.deepEqual(evidence.failures, []);
  assert.deepEqual(evidence.remainingObjects, []);
  assert.equal(evidence.bridge.portClosed, true);
  assert.equal(evidence.fetchRestored, true);
  report.passed = report.interruptions.length === 0;
} catch (error) {
  report.primaryFailure ??= error.stack;
  report.failures.push(error.stack);
  process.exitCode = report.interruptions.length ? process.exitCode : 1;
} finally {
  try {
    await checkpoint('gate-final-cleanup');
  } catch (error) {
    report.primaryFailure ??= error.stack;
    report.failures.push(error.stack);
    process.exitCode ||= 1;
  }
  try {
    await children.close();
  } catch (error) {
    report.failures.push(error.stack);
    process.exitCode ||= 1;
  }
  report.passed = report.passed && report.failures.length === 0;
  save();
}
