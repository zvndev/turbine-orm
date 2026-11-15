// Run only as an owned child: builtin fault injection must not affect other tests.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { dirname, join } from 'node:path';
import { identity, OwnedChildren, persist, sameProcess } from './native-lifecycle.mjs';

const [root, mode] = process.argv.slice(2);
const primary = {
  error: new Error('primary callback failure'),
  null: null,
  undefined: undefined,
  false: false,
  zero: 0,
  empty: '',
  unprintable: Object.create(null, {
    stack: {
      get() {
        throw new Error('Do not mask the thrown object');
      },
    },
  }),
}[mode];
const removal = Object.assign(new Error('secondary ephemeral removal failure'), { code: 'EIO' });
const report = { mode, commands: [], caller: identity(process.pid) };
let callbacks = 0;
const owner = new OwnedChildren({
  cwd: root,
  env: process.env,
  report,
  onChange() {
    callbacks++;
    if (callbacks === 1 && mode !== 'cleanup-only') throw primary;
    if (callbacks === 2) {
      assert.match(report.commands[0].cleanupFailures.join('\n'), /secondary ephemeral removal failure/);
      report.finalCallbackAfterCleanupFailure = true;
    }
  },
});
const actualRemove = fs.rmSync;
let attempted;
fs.rmSync = (path, options) => {
  if (path === dirname(report.commands[0]?.ownershipReport ?? '')) {
    attempted = path;
    throw removal;
  }
  return actualRemove(path, options);
};
syncBuiltinESMExports();
try {
  const outcome = await owner.run(mode, process.execPath, ['-e', 'process.exit(0)'], { timeout: 2000 }).then(
    () => ({ rejected: false }),
    (reason) => ({ rejected: true, reason }),
  );
  assert.equal(outcome.rejected, true);
  assert.equal(outcome.reason, mode === 'cleanup-only' ? removal : primary);
  const command = report.commands[0];
  assert.equal(typeof command.primaryFailure, 'string');
  assert.equal(command.ownershipProof.passed, true);
  assert.equal(command.ownershipProof.complete, true);
  assert.deepEqual(command.ownershipProof.remaining, []);
  assert.equal(sameProcess(command.supervisor), false);
  assert.ok(command.processes.every((process) => !sameProcess(process)));
  assert.equal(callbacks, 2);
  assert.equal(report.finalCallbackAfterCleanupFailure, true);
  assert.equal(owner.active.size, 0);
  report.originalErrorRetained = true;
  report.passed = true;
} finally {
  fs.rmSync = actualRemove;
  syncBuiltinESMExports();
  await owner.close();
  if (attempted) {
    assert.equal(sameProcess(report.commands[0].supervisor), false);
    actualRemove(attempted, { recursive: true, force: true });
    report.faultDirectoryCleanup = { path: attempted, removed: !fs.existsSync(attempted) };
  }
  persist(join(root, 'fault-result.json'), report);
}
