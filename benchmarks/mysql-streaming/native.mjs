import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { groupAlive, stopOwned, withNative } from '../mysql-preparation/native.mjs';
import { rootDriver } from './driver.mjs';
import { execute } from './execute.mjs';
import { cases, finalize } from './oracle.mjs';
import { validateCampaign } from './validate.mjs';

const output = resolve(process.argv[2] ?? '');
assert.ok(process.argv[2], 'usage: node native.mjs NEW-output-directory');
mkdirSync(output);
const report = {
  format: 'mysql-streaming-campaign-v1',
  status: 'running',
  samples: [],
  independentCleanup: [],
  services: [],
  cleanupErrors: [],
};
let current, interrupted;
const signal = (name) => {
  interrupted = name;
  if (current && groupAlive(current.process.pid)) process.kill(-current.process.pid, name);
};
const term = () => signal('SIGTERM'),
  int = () => signal('SIGINT');
process.on('SIGTERM', term);
process.on('SIGINT', int);
try {
  // The read-only helper consumes MYSQL_PREP_MYSQLD and LD_LIBRARY_PATH. No service fallback.
  assert.ok(process.env.MYSQL_PREP_MYSQLD, 'required native mysqld executable missing');
  const runtimes = [process.env.MYSQL_STREAM_NODE22, process.env.MYSQL_STREAM_NODE24];
  assert.ok(runtimes.every(Boolean), 'both exact native runtime executable paths required');
  for (const mode of ['default', 'ansi-no-backslash']) {
    const service = await withNative(join(output, mode), mode, async ({ identity, identityPath }) => {
      const selected = process.env.MYSQL_STREAM_CASES
        ? cases().filter((c) => process.env.MYSQL_STREAM_CASES.split(',').includes(c.id))
        : cases();
      assert.ok(selected.length, 'empty native workload refused');
      const mysql = rootDriver().mysql;
      const observer = await mysql.createConnection({ host: '127.0.0.1', port: identity.port, user: 'root' });
      try {
        for (const node of runtimes)
          for (const c of selected) {
            if (interrupted) throw new Error(interrupted);
            const version = node === runtimes[0] ? 22 : 24,
              path = join(output, `${mode}-node${version}-${c.id}.json`);
            const { sample, exit, cleanup } = await execute({
              node,
              path,
              config: c,
              identity,
              identityPath,
              observer,
              onChild: (child) => {
                current = child;
              },
            });
            report.samples.push(sample);
            report.independentCleanup.push(cleanup);
            assert.equal(exit.code, 0, `native child failed: ${path}`);
            assert.equal(exit.signal, null);
            assert.equal(sample.status, 'passed', sample.failure);
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
    assert.equal(service.status, 'passed', service.failure ?? service.cleanupErrors.join('\n'));
  }
} catch (e) {
  report.failure = String(e.stack ?? e);
} finally {
  await finalize(
    report,
    [
      async () => stopOwned(current),
      async () => {
        if (interrupted) throw new Error(interrupted);
      },
    ],
    join(output, 'campaign.json'),
  );
  if (!process.env.MYSQL_STREAM_CASES && report.status === 'passed')
    try {
      validateCampaign(report);
    } catch (e) {
      report.failure = String(e.stack ?? e);
      report.status = 'failed';
    }
  report.partial = !!process.env.MYSQL_STREAM_CASES;
  writeFileSync(join(output, 'campaign.json'), `${JSON.stringify(report, null, 2)}\n`);
  process.off('SIGTERM', term);
  process.off('SIGINT', int);
  console.log(
    JSON.stringify({
      output,
      status: report.status,
      samples: report.samples.length,
      partial: report.partial,
    }),
  );
  if (interrupted) process.kill(process.pid, interrupted);
  else if (report.status !== 'passed') process.exitCode = 1;
}
