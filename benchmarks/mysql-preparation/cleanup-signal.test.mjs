// Required-native regression; run separately from the service-free unit matrix.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { groupAlive, portOpen, withNative } from './native.mjs';

assert.ok(process.env.MYSQL_PREP_SIGNAL_OUT, 'MYSQL_PREP_SIGNAL_OUT evidence directory required');
assert.ok(existsSync(process.env.MYSQL_PREP_MYSQLD ?? ''), 'required native MySQL executable absent');
const out = resolve(process.env.MYSQL_PREP_SIGNAL_OUT);
mkdirSync(out);
for (const signal of ['SIGTERM', 'SIGINT']) {
  test(`termination during native server cleanup retains ${signal}`, async () => {
    const kill = process.kill;
    let serverPid;
    let sent = false;
    let received = 0;
    const observe = () => {
      received++;
    };
    process.on(signal, observe);
    process.kill = function (pid, name) {
      const result = kill.call(process, pid, name);
      if (pid === -serverPid && name === 'SIGTERM' && !sent) {
        sent = true;
        kill.call(process, process.pid, signal);
      }
      return result;
    };
    let service;
    try {
      service = await withNative(join(out, signal), 'default', async ({ identity }) => {
        serverPid = identity.pid;
      });
    } finally {
      process.kill = kill;
      process.off(signal, observe);
    }
    writeFileSync(join(out, `${signal}.json`), `${JSON.stringify({ sent, received, service }, null, 2)}\n`);
    assert.ok(sent && received === 1, 'Real self-signal must arrive while the owned server shuts down');
    assert.equal(service.status, 'failed');
    assert.equal(service.interrupted, signal);
    assert.match(service.cleanupErrors.join('\n'), new RegExp(`interrupted: ${signal}`));
    assert.deepEqual(JSON.parse(readFileSync(join(service.root, 'identity.json'), 'utf8')), service);
    assert.equal(groupAlive(serverPid), false);
    assert.equal(await portOpen(service.port), false);
    assert.equal(existsSync(service.data), false);
    assert.equal(existsSync(service.socket), false);
    assert.ok(service.serverGroupAbsent && service.initializationGroupAbsent && service.childGroupAbsent);
  });
}
