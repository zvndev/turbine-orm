// Explicit required-native checks. Invoke separately from the dependency-free unit matrix.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { connect } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';

const pin = process.env.CONTRACT_SHA256;
assert.match(pin ?? '', /^[a-f0-9]{64}$/, 'CONTRACT_SHA256 required for the selected archive');
const prefix = process.env.CONTRACT_CLEANUP_PREFIX;
assert.ok(prefix, 'CONTRACT_CLEANUP_PREFIX required for durable failure evidence');
async function closed(port) {
  await new Promise((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port });
    socket.setTimeout(1000, () => {
      socket.destroy();
      reject(new Error('Independent port probe timed out'));
    });
    socket.once('connect', () => {
      socket.destroy();
      reject(new Error('Owned service port remains open'));
    });
    socket.once('error', (error) => {
      socket.destroy();
      if (error.code === 'ECONNREFUSED') resolve();
      else reject(error);
    });
  });
}
for (const engine of ['postgresql', 'mysql'])
  for (const fault of ['after-service', 'dropped-effect', 'SIGTERM']) {
    test(`${engine} owned cleanup after ${fault}`, { timeout: 240_000 }, async () => {
      const out = `${prefix}-${engine}-${fault}`;
      const args = [
        new URL('./verify.mjs', import.meta.url).pathname,
        '--engine',
        engine,
        '--tarball',
        process.env.CONTRACT_TARBALL,
        '--sha256',
        pin,
        '--out',
        out,
        '--exact-node',
        process.versions.node,
      ];
      if (fault !== 'SIGTERM') args.push('--fault', fault);
      const child = spawn(process.execPath, args, {
        env: { ...process.env, NODE_OPTIONS: '', NODE_PATH: '' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const exited = once(child, 'exit');
      let output = '';
      let sent = false;
      child.stdout.on('data', (chunk) => {
        output += chunk;
        if (fault === 'SIGTERM' && !sent && output.includes('service-ready')) {
          sent = true;
          child.kill('SIGTERM');
        }
      });
      child.stderr.on('data', (chunk) => {
        output += chunk;
      });
      try {
        const [code, signal] = await exited;
        assert.equal(signal, null, output);
        assert.equal(code, fault === 'SIGTERM' ? 143 : 1, output);
        if (fault === 'SIGTERM') assert.equal(sent, true, output);
        const report = JSON.parse(readFileSync(join(out, 'report.json'), 'utf8'));
        assert.equal(report.passed, false);
        assert.equal(report.services.length, engine === 'mysql' && fault === 'dropped-effect' ? 2 : 1);
        assert.equal(report.cleanup.fixtureRemoved, true);
        assert.equal(existsSync(report.fixtureRoot), false);
        assert.equal(report.cleanup.servicesStopped, true);
        assert.deepEqual(report.cleanup.errors, []);
        assert.equal(report.artifactUnchanged, true);
        for (const service of report.services) {
          assert.equal(existsSync(service.datadir), false);
          assert.equal(existsSync(service.socket), false);
          assert.throws(() => process.kill(service.pid, 0), { code: 'ESRCH' });
          await closed(service.port);
        }
        assert.match(
          JSON.stringify(report),
          fault === 'SIGTERM'
            ? /Interrupted by SIGTERM/
            : fault === 'dropped-effect'
              ? /Deliberate wrong native effect detected after exit0/
              : /Injected failure after owned service start/,
        );
      } finally {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill('SIGTERM');
          await exited;
        }
      }
    });
  }
