import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { bounded, lifecycle } from './lifecycle.mjs';
import { describeReason } from './reason.mjs';

// One report owner and one teardown, including signals received during teardown.
export async function runWithShutdown(report, reportPath, body, cleanup = async () => {}) {
  const scope = lifecycle(report);
  const errors = [];
  const failed = () => {
    if (scope.primary) {
      report.success = false;
      report.failure = describeReason(scope.primary.reason);
      if (scope.primary.kind === 'signal') process.exitCode = report.signalExitCode;
    }
  };
  const secondary = (reason) => { errors.push(describeReason(reason)); scope.fail(reason); failed(); };
  report.success = false;
  try { await body(scope); scope.assertOpen(); report.success = true; }
  catch (error) {
    scope.fail(error);
    if (!Object.is(scope.primary.reason, error)) (report.secondaryErrors ??= []).push(describeReason(error));
    failed();
  }
  finally {
    try {
      try { errors.push(...await scope.shutdown()); } catch (error) { secondary(error); }
      if (errors.length && !scope.primary) scope.fail(new Error(errors.join('\n')));
      failed();
      try { await bounded(Promise.resolve().then(() => cleanup(errors)), 12_000, 'Final cleanup'); }
      catch (error) { secondary(error); }
      if (errors.length && !scope.primary) scope.fail(new Error(errors.join('\n')));
      failed();
      report.cleanupErrors = errors;
      try {
        mkdirSync(dirname(reportPath), { recursive: true });
        writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
      } catch (error) {
        (report.persistenceErrors ??= []).push(describeReason(error));
        secondary(error);
        // The intended report may be unwritable. Keep its fault in memory and
        // emit a separate diagnostic without replacing the original rejection.
        try { process.stderr.write(`Report persistence failed: ${describeReason(error)}\n`); } catch {}
      }
    } finally { scope.dispose(); }
  }
  if (scope.primary) throw scope.primary.reason;
  return report;
}
