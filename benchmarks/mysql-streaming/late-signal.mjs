import assert from 'node:assert/strict';
import { mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { groupAlive, ownedProcess, stopOwned } from '../mysql-preparation/native.mjs';
import { audit } from './audit.mjs';
import { finalize } from './oracle.mjs';
const output = resolve(process.argv[2] ?? '');
assert.ok(process.argv[2], 'new late-signal output directory required');
mkdirSync(output);
const report = { format: 'mysql-streaming-late-signal-v1', controls: [], cleanupErrors: [] };
let child, interrupted;
const term = () => {
  interrupted = true;
  if (child && groupAlive(child.process.pid)) process.kill(-child.process.pid, 'SIGTERM');
};
process.on('SIGTERM', term);
try {
  for (const [version, node] of [
    [22, process.env.MYSQL_STREAM_NODE22],
    [24, process.env.MYSQL_STREAM_NODE24],
  ]) {
    assert.ok(node, 'exact native runtime required');
    if (interrupted) throw new Error('controller interrupted');
    const root = join(output, 'node' + version);
    const args = [
      '--import',
      fileURLToPath(new URL('./late-signal-preload.mjs', import.meta.url)),
      fileURLToPath(new URL('./native.mjs', import.meta.url)),
      root,
    ];
    child = ownedProcess(node, args, {
      env: { ...process.env, MYSQL_STREAM_CASES: '00', MYSQL_STREAM_LATE_SIGNAL_OUTPUT: root },
    });
    let log = '';
    child.process.stdout.on('data', (b) => {
      log += b;
    });
    child.process.stderr.on('data', (b) => {
      log += b;
    });
    const timeout = setTimeout(() => {
      if (groupAlive(child.process.pid)) process.kill(-child.process.pid, 'SIGTERM');
    }, 60000);
    try {
      await child.done;
    } finally {
      clearTimeout(timeout);
      await stopOwned(child);
    }
    const campaign = JSON.parse(readFileSync(join(root, 'campaign.json'))),
      delivery = JSON.parse(readFileSync(join(root, 'late-delivery.json')));
    assert.equal(child.exit.signal, 'SIGTERM');
    assert.equal(campaign.status, 'failed');
    assert.equal(campaign.services.length, 1);
    assert.equal(campaign.services[0].status, 'failed');
    assert.match(campaign.failure, /interrupted after service cleanup/);
    assert.equal(delivery.delivered, true);
    assert.equal(campaign.independentCleanup.length, 2);
    assert.ok(
      campaign.independentCleanup.every(
        (c) => c.remainingDatabases === 0 && c.remainingSessions.length === 0,
      ),
    );
    report.controls.push({
      node: 'v' + (version === 22 ? '22.16.0' : '24.10.0'),
      passed: true,
      exit: child.exit,
      controllerPid: child.process.pid,
      groupAbsent: !groupAlive(child.process.pid),
      delivery,
      audit: await audit(root),
      failure: campaign.failure,
      log,
    });
    child = null;
  }
} catch (e) {
  report.failure = String(e.stack ?? e);
}
await finalize(
  report,
  [
    async () => stopOwned(child),
    async () => {
      if (interrupted) throw new Error('controller interrupted');
    },
  ],
  join(output, 'late.json'),
);
process.off('SIGTERM', term);
console.log(JSON.stringify({ output, status: report.status, controls: report.controls.length }));
if (interrupted) process.kill(process.pid, 'SIGTERM');
else if (report.status !== 'passed') process.exitCode = 1;
