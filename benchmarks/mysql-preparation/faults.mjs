import assert from 'node:assert/strict';
import { createWriteStream, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { audit } from './audit.mjs';
import { ownedProcess, stopOwned } from './native.mjs';

const root = resolve(process.argv[2] ?? '');
assert.ok(process.argv[2], 'usage: node faults.mjs NEW-output-directory');
mkdirSync(root);
const results = [];
for (const fault of ['effect', 'route', 'bounds', 'report', 'signal', 'cleanup']) {
  const output = join(root, fault),
    log = createWriteStream(join(root, `${fault}.log`));
  const child = ownedProcess(process.execPath, [fileURLToPath(new URL('./native.mjs', import.meta.url)), output], {
    env: { ...process.env, MYSQL_PREP_FAULT: fault },
  });
  child.process.stdout.pipe(log, { end: false });
  child.process.stderr.pipe(log, { end: false });
  try {
    await child.done;
    assert.equal(child.exit?.code, 1, `forced ${fault} must fail`);
    const report = JSON.parse(readFileSync(join(output, 'campaign.json'), 'utf8'));
    assert.equal(report.status, 'failed');
    const proof = await audit(output);
    const service = JSON.parse(readFileSync(join(output, 'default/identity.json'), 'utf8'));
    const execution = JSON.parse(readFileSync(join(output, 'default-node22.json'), 'utf8'));
    if (fault === 'cleanup') assert.match(service.cleanupErrors.join('\n'), /forced cleanup/);
    else {
      assert.equal(execution.status, 'failed');
      const reason = `${execution.failure}\n${execution.cleanupErrors.join('\n')}`;
      assert.match(
        reason,
        {
          effect: /independent exact/,
          route: /actual binary execution route/,
          bounds: /forced bounds/,
          report: /comparisons derive/,
          signal: /interrupted: SIGTERM/,
        }[fault],
      );
    }
    results.push({ fault, exit: child.exit, proof, passed: true });
  } finally {
    await stopOwned(child);
    await new Promise((r) => log.end(r));
  }
}
writeFileSync(join(root, 'faults.json'), `${JSON.stringify(results, null, 2)}\n`);
console.log(JSON.stringify({ root, forcedFailures: results.length, cleanupAudited: true }));
