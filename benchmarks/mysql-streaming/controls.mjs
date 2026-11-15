import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { groupAlive, withNative } from '../mysql-preparation/native.mjs';
import { cases, finalize } from './oracle.mjs';
import { rootDriver } from './driver.mjs';
import { execute } from './execute.mjs';
const output = resolve(process.argv[2] ?? '');
assert.ok(process.argv[2], 'new control output directory required');
mkdirSync(output);
const report = { format: 'mysql-streaming-fault-controls-v1', controls: [], services: [], cleanupErrors: [] };
let current, interrupted;
const term = () => {
  interrupted = true;
  if (current && groupAlive(current.process.pid)) process.kill(-current.process.pid, 'SIGTERM');
};
process.on('SIGTERM', term);
try {
  assert.ok(
    process.env.MYSQL_STREAM_NODE22 && process.env.MYSQL_STREAM_NODE24,
    'both exact runtimes required',
  );
  const service = await withNative(join(output, 'default'), 'default', async ({ identity, identityPath }) => {
    const mysql = rootDriver().mysql;
    const observer = await mysql.createConnection({ host: '127.0.0.1', port: identity.port, user: 'root' });
    try {
      for (const node of [process.env.MYSQL_STREAM_NODE22, process.env.MYSQL_STREAM_NODE24])
        for (const [fault, id, match] of [
          ['materialize', '01', /materializing callback/],
          ['effect', '33', /transaction effect/],
          ['cancel', '30', /AbortSignal was omitted/],
          ['cleanup', '01', /sessions independently closed/],
          ['finalize', '01', /forced finalization fault/],
          ['signal', '30', /SIGTERM|AbortSignal|intentional mid-flight/],
        ]) {
          assert.ok(!interrupted, 'controller interrupted');
          const version = node === process.env.MYSQL_STREAM_NODE22 ? 22 : 24,
            path = join(output, `default-node${version}-${fault}.json`);
          const r = await execute({
            node,
            path,
            config: cases().find((c) => c.id === id),
            identity,
            identityPath,
            observer,
            fault,
            onChild: (c) => {
              current = c;
            },
          });
          assert.equal(r.sample.status, 'failed');
          assert.match(
            r.sample.failure ?? r.sample.cleanupErrors.join('\n'),
            match,
            'intended native fault detected',
          );
          if (fault === 'signal') {
            assert.equal(r.exit.signal, 'SIGTERM');
            assert.equal(r.exit.code, null);
          } else assert.equal(r.exit.code, 1);
          report.controls.push({
            fault,
            node: r.sample.provenance.node,
            provenance: r.sample.provenance,
            passed: true,
            exit: r.exit,
            cleanup: r.cleanup,
            failure: r.sample.failure,
            cleanupErrors: r.sample.cleanupErrors,
          });
        }
    } finally {
      await observer.end();
    }
  });
  if (interrupted) {
    service.status = 'failed';
    service.failure = `interrupted after service cleanup: ${interrupted}`;
    writeFileSync(join(service.root, 'identity.json'), JSON.stringify(service, null, 2) + '\n');
  }
  report.services.push(service);
  if (interrupted) throw new Error(`interrupted after service cleanup: ${interrupted}`);
  assert.equal(service.status, 'passed', service.failure);
} catch (e) {
  report.failure = String(e.stack ?? e);
}
await finalize(
  report,
  [
    async () => {
      if (interrupted) throw new Error('SIGTERM during cleanup');
    },
  ],
  join(output, 'controls.json'),
);
if (interrupted) {
  report.status = 'failed';
  report.cleanupErrors.push('SIGTERM after cleanup');
  writeFileSync(join(output, 'controls.json'), JSON.stringify(report, null, 2) + '\n');
}
process.off('SIGTERM', term);
console.log(JSON.stringify({ output, status: report.status, controls: report.controls.length }));
if (interrupted) process.kill(process.pid, 'SIGTERM');
else if (report.status !== 'passed') process.exitCode = 1;
