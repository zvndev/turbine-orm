import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { join } from 'node:path';

const root = process.env.NOTIFICATION_HUB_CONSUMER_ROOT;
assert.ok(root, 'NOTIFICATION_HUB_CONSUMER_ROOT required');
for (const format of ['esm', 'cjs']) {
  const child = spawn(process.execPath, ['packed-consumer.mjs', format], {
    cwd: root,
    env: process.env,
    stdio: 'inherit',
  });
  assert.equal(
    await new Promise((accept, reject) => {
      child.once('error', reject);
      child.once('exit', accept);
    }),
    0,
    `${format} native packed consumer`,
  );
}
// Native exact-payload guard must reject an injected fault in the isolated installed package.
const { readFileSync, writeFileSync } = await import('node:fs');
const module = join(root, 'node_modules/turbine-orm/dist/notification-hub.js');
const original = readFileSync(module, 'utf8');
assert.ok(original.includes("message.payload ?? ''"), 'payload mutation anchor missing');
try {
  writeFileSync(module, original.replace("message.payload ?? ''", "'injected-wrong-payload'"));
  const child = spawn(process.execPath, ['packed-consumer.mjs', 'esm'], {
    cwd: root,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (chunk) => {
    log += chunk;
  });
  child.stderr.on('data', (chunk) => {
    log += chunk;
  });
  const result = await new Promise((accept, reject) => {
    child.once('error', reject);
    child.once('exit', accept);
  });
  assert.notEqual(result, 0);
  assert.match(log, /injected-wrong-payload/);
  process.stdout.write(`Injected payload fault rejected: exit ${result}\n${log}`);
} finally {
  writeFileSync(module, original);
}
