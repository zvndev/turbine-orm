// An interrupted gate may terminate its children, never its caller's PostgreSQL.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, watch, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { ownedPostgres } from '../../../../tooling/native-consumer-contracts/postgres-service.mjs';
import { bounded, identity, OwnedChildren, persist, sameProcess, signalOwned } from './native-lifecycle.mjs';

assert.ok(process.env.PG_PREFIX, 'PG_PREFIX required');
assert.ok(process.env.NEON_HTTP_INTERRUPTION_EVIDENCE, 'NEON_HTTP_INTERRUPTION_EVIDENCE required');
const cwd = fileURLToPath(new URL('../../../../', import.meta.url));
async function portClosed(port) {
  return new Promise((accept, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    socket.setTimeout(1000, () => {
      socket.destroy();
      reject(new Error('Port audit timed out'));
    });
    socket.once('connect', () => {
      socket.destroy();
      accept(false);
    });
    socket.once('error', (error) => {
      socket.destroy();
      if (error.code === 'ECONNREFUSED') accept(true);
      else reject(error);
    });
  });
}
for (const sequence of [['SIGINT'], ['SIGTERM'], ['SIGINT', 'SIGTERM'], ['SIGTERM', 'SIGINT']]) {
  const signal = sequence[0];
  const repeated = sequence.length > 1;
  const label = sequence.join('-');
  test(`gate ${label} reaps only its children; caller PG remains usable`, { timeout: 90_000 }, async () => {
    const output = join(resolve(process.env.NEON_HTTP_INTERRUPTION_EVIDENCE), `caller-${label}`);
    mkdirSync(output);
    const root = join(output, 'pg');
    mkdirSync(root);
    const report = { signal, commands: [], services: [], failures: [], passed: false };
    const env = {
      ...process.env,
      PATH: `${dirname(process.execPath)}:${process.env.PATH}`,
      NEON_HTTP_EVIDENCE: output,
      NEON_HTTP_TEST_CONTROL: output,
      NEON_HTTP_TEST_BARRIER: repeated ? 'active-native-child,gate-final-cleanup' : 'active-native-child',
    };
    delete env.NODE_TEST_CONTEXT;
    const children = new OwnedChildren({ cwd, env, report });
    const stops = [];
    let watcher;
    try {
      const service = await ownedPostgres({
        root,
        env,
        report,
        driver: pg,
        registerStop: (stop) => stops.push(stop),
        run: (dir, binary, args) => {
          const result = spawnSync(binary, args, {
            cwd: dir,
            env,
            timeout: 30_000,
            killSignal: 'SIGKILL',
            encoding: 'utf8',
          });
          assert.equal(result.status, 0, result.stderr);
        },
      });
      report.services[0].process = identity(report.services[0].pid);
      env.NEON_HTTP_NATIVE_URL = service.url;
      const readyPath = join(output, 'active-native-child.ready.json');
      const ready = new Promise((accept) => {
        watcher = watch(output, () => {
          if (existsSync(readyPath)) accept(JSON.parse(readFileSync(readyPath)));
        });
      });
      const running = children.run(
        'caller-service-gate',
        process.execPath,
        ['src/test/fixtures/neon-http/gate-run.mjs'],
        { log: join(output, 'gate.log'), failure: /.*/ },
      );
      // Attach immediately so a failure before the barrier is never an unhandled rejection.
      const endedEarly = running.then(() => {
        throw new Error('Gate ended before the native bridge barrier');
      });
      const native = await bounded(Promise.race([ready, endedEarly]), 20_000, 'Live gate bridge');
      watcher.close();
      report.liveNativeBridge = native;
      report.callerPgWhileAlive = identity(report.services[0].pid);
      persist(join(output, 'live-ownership.json'), report);
      let cleanupWatcher;
      const cleanupPath = join(output, 'gate-final-cleanup.ready.json');
      const finalizing = repeated
        ? new Promise((accept) => {
            cleanupWatcher = watch(output, () => {
              if (existsSync(cleanupPath)) accept();
            });
          })
        : Promise.resolve();
      assert.equal(signalOwned(report.commands[0], signal), true);
      try {
        await bounded(finalizing, 10_000, 'Gate finalization barrier');
        if (repeated) {
          assert.equal(signalOwned(report.commands[0], sequence[1]), true);
          // The gate's signal handler writes its interruption before release; wait for it.
          const path = join(output, `gate-lifecycle-${report.commands[0].pid}.json`);
          await bounded(
            new Promise((accept) => {
              const check = () => {
                if (JSON.parse(readFileSync(path)).interruptions.length === 2) {
                  cleanupWatcher.close();
                  accept();
                }
              };
              cleanupWatcher.close();
              cleanupWatcher = watch(output, check);
              check();
            }),
            10_000,
            'Repeated gate signal admission',
          );
          writeFileSync(join(output, 'gate-final-cleanup.release'), 'release');
        }
      } finally {
        cleanupWatcher?.close();
      }
      await running;
      assert.equal(report.commands[0].status, signal === 'SIGINT' ? 130 : 143);
      assert.equal(sameProcess(report.callerPgWhileAlive), true);
      assert.deepEqual((await service.client.query('SELECT 1 AS one')).rows, [{ one: 1 }]);
      report.callerServicePreserved = true;
      const gate = JSON.parse(readFileSync(join(output, `gate-lifecycle-${report.commands[0].pid}.json`)));
      assert.deepEqual(gate.interruptions, sequence);
      assert.match(gate.primaryFailure, new RegExp(`Interrupted by ${signal}`));
      assert.equal(await portClosed(native.bridge.port), true);
      for (const command of report.commands) assert.ok(command.processes.every((entry) => !sameProcess(entry)));
      report.passed = true;
    } catch (error) {
      report.failures.push(error.stack);
      throw error;
    } finally {
      watcher?.close();
      await children.close();
      for (const stop of stops.reverse()) await bounded(stop(), 20_000, 'Caller-owned PG teardown by its owner');
      for (const service of report.services) {
        assert.equal(sameProcess(service.process), false);
        assert.equal(await portClosed(service.port), true);
      }
      rmSync(root, { recursive: true, force: true });
      report.rootGone = !existsSync(root);
      persist(join(output, 'caller-service-report.json'), report);
    }
  });
}
