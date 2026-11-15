/** Local native/source and exact installed strict ESM/CJS proof. Existing lifecycle owner only. */
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { ownedPostgres } from '../../../../tooling/native-consumer-contracts/postgres-service.mjs';
import {
  archiveIdentity,
  command,
  files,
  installedPayload,
  sha256,
} from '../../../../tooling/optional-pg-transports/harness.mjs';
import { bounded } from '../../../../tooling/optional-pg-transports/lifecycle.mjs';
import { runWithShutdown } from '../../../../tooling/optional-pg-transports/run.mjs';

const repo = fileURLToPath(new URL('../../../../', import.meta.url));
const [archive, pin, destination] = process.argv.slice(2);
assert.ok(destination, 'Usage: native-run.mjs ARCHIVE SHA256 NEW_OUTPUT_DIRECTORY');
assert.ok(['v22.16.0', 'v24.10.0'].includes(process.version), 'Exact Node 22.16.0 or 24.10.0 required');
assert.ok(process.env.PG_PREFIX, 'Exact native PostgreSQL 18.6 PG_PREFIX required');
const output = resolve(destination);
assert.equal(existsSync(output), false, 'Preserve earlier attempts: output must be new');
mkdirSync(output, { recursive: true });
const root = join(output, 'pg');
mkdirSync(root);
assert.ok(join(root, 'socket').length < 100, 'Use a short home-cache evidence path for PostgreSQL sockets');
const report = {
  scope: 'application-owned local PostgreSQL outbox only',
  runtime: process.version,
  executable: process.execPath,
  runtimeSha256: sha256(readFileSync(process.execPath)),
  commands: [],
  services: [],
  formats: ['esm', 'cjs'],
  root,
};
const env = {
  ...process.env,
  PATH: `${dirname(process.execPath)}:${process.env.PATH}`,
  LD_LIBRARY_PATH: [join(process.env.PG_PREFIX, 'lib'), process.env.LD_LIBRARY_PATH].filter(Boolean).join(':'),
};

function tap(stdout) {
  assert.doesNotMatch(stdout, /^\s*not ok\b/m);
  for (const name of ['fail', 'cancelled', 'skipped']) assert.match(stdout, new RegExp(`^# ${name} 0$`, 'm'));
  const count = Number(/^# pass (\d+)$/m.exec(stdout)?.[1]);
  assert.ok(count >= 14, 'All original and finite-timeout admission controls must execute');
  return count;
}

await runWithShutdown(
  report,
  join(output, 'report.json'),
  async (scope) => {
    const run = (cwd, binary, args, childEnv = env) =>
      command(report, cwd, binary, args, childEnv, { scope, timeoutMs: 120000 });
    report.sourceHead = (await run(repo, 'git', ['rev-parse', 'HEAD'])).trim();
    report.sourceStatus = (await run(repo, 'git', ['status', '--porcelain=v1'])).trim();
    const sourceFiles = [
      ...files(join(repo, 'examples/postgres-durable-replay')).map((p) => `examples/postgres-durable-replay/${p}`),
      ...files(join(repo, 'src/test/fixtures/postgres-durable-replay')).map(
        (p) => `src/test/fixtures/postgres-durable-replay/${p}`,
      ),
      'src/test/durable-replay.test.ts',
      'src/notification-hub.ts',
      'src/live-query.ts',
      'docs/postgres-durable-replay.md',
      'tooling/native-consumer-contracts/postgres-service.mjs',
      'tooling/optional-pg-transports/harness.mjs',
      'tooling/optional-pg-transports/lifecycle.mjs',
      'tooling/optional-pg-transports/run.mjs',
      'src/test/fixtures/neon-http/http-command-supervisor.py',
    ];
    report.sourceInputs = Object.fromEntries(sourceFiles.map((p) => [p, sha256(readFileSync(join(repo, p)))]));
    const identity = archiveIdentity(resolve(archive), pin);
    report.archive = { path: identity.tarball, sha256: identity.sha256, members: identity.members.length };
    const consumer = join(output, 'consumer'),
      reference = join(output, 'reference');
    mkdirSync(consumer);
    mkdirSync(reference);
    await run(output, 'tar', ['-xzf', identity.tarball, '-C', reference]);
    writeFileSync(join(consumer, 'package.json'), '{"private":true,"type":"module"}');
    await run(consumer, 'npm', [
      'install',
      '--ignore-scripts',
      '--omit=optional',
      '--no-audit',
      '--no-fund',
      identity.tarball,
      'pg@8.23.1',
      '@types/node@22.20.4',
      '@types/pg@8.23.1',
    ]);
    const installed = join(consumer, 'node_modules/turbine-orm');
    report.payloadHashes = installedPayload(join(reference, 'package'), installed);
    report.driver = {
      source: JSON.parse(readFileSync(join(repo, 'node_modules/pg/package.json'))).version,
      installed: JSON.parse(readFileSync(join(consumer, 'node_modules/pg/package.json'))).version,
      installedLock: sha256(readFileSync(join(consumer, 'package-lock.json'))),
    };
    report.driverPayloadHashes = {};
    for (const name of ['pg', 'pg-pool', 'pg-protocol', 'pg-types']) {
      const directory = join(consumer, 'node_modules', name);
      report.driverPayloadHashes[name] = Object.fromEntries(
        files(directory).map((file) => [file, sha256(readFileSync(join(directory, file)))]),
      );
    }
    const tsc = join(repo, 'node_modules/typescript/bin/tsc');
    for (const format of report.formats) {
      const source = join(consumer, `${format}-source`);
      mkdirSync(source);
      writeFileSync(join(source, 'package.json'), JSON.stringify({ type: format === 'esm' ? 'module' : 'commonjs' }));
      for (const name of ['application.ts', 'demo.ts']) {
        const dest = join(source, 'examples/postgres-durable-replay', name);
        mkdirSync(dirname(dest), { recursive: true });
        cpSync(join(repo, 'examples/postgres-durable-replay', name), dest);
      }
      const fixture = join(source, 'src/test/fixtures/postgres-durable-replay');
      mkdirSync(fixture, { recursive: true });
      // Only relocate type-only source imports in the test adapter. Application bytes remain unchanged.
      writeFileSync(
        join(fixture, 'controls.ts'),
        readFileSync(join(repo, 'src/test/fixtures/postgres-durable-replay/controls.ts'), 'utf8')
          .replace("'../../../live-query.js'", "'turbine-orm/live-query'")
          .replace("'../../../notification-hub.js'", "'turbine-orm/notification-hub'"),
      );
      cpSync(join(repo, 'src/test/durable-replay.test.ts'), join(source, 'src/test/durable-replay.test.ts'));
      cpSync(join(repo, 'src/test/fixtures/postgres-durable-replay/types.ts.txt'), join(source, 'types.ts'));
      cpSync(
        join(repo, 'src/test/fixtures/postgres-durable-replay/generated-seed.ts.txt'),
        join(source, 'generated-seed.ts'),
      );
      const config = {
        compilerOptions: {
          target: 'ES2023',
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          strict: true,
          skipLibCheck: false,
          noUncheckedIndexedAccess: true,
          esModuleInterop: true,
          declaration: true,
          outDir: `../${format}`,
          types: ['node'],
        },
        include: ['**/*.ts'],
      };
      writeFileSync(join(source, 'tsconfig.json'), JSON.stringify(config));
      await run(consumer, process.execPath, [tsc, '-p', join(source, 'tsconfig.json')]);
      writeFileSync(
        join(consumer, format, 'package.json'),
        JSON.stringify({ type: format === 'esm' ? 'module' : 'commonjs' }),
      );
    }
    report.strictConsumers = ['esm', 'cjs'];
    let refused = false;
    try {
      await run(
        repo,
        process.execPath,
        ['--import', 'tsx', '--test', '--test-reporter=tap', 'src/test/durable-replay.test.ts'],
        {
          ...env,
          DATABASE_URL: '',
          TURBINE_REQUIRE_ENGINE: 'postgres',
          TSX_TSCONFIG_PATH: join(repo, 'src/test/fixtures/postgres-durable-replay/source-tsconfig.json'),
        },
      );
    } catch (error) {
      assert.match(error.message, /Required PostgreSQL precondition is unmet/);
      report.commands.at(-1).expectedFailure = 'required PostgreSQL cannot skip';
      refused = true;
    }
    assert.equal(refused, true);
    let serviceHandle;
    const service = await ownedPostgres({
      root,
      env,
      driver: pg,
      report,
      run,
      processLifecycle: {
        assertOpen: scope.assertOpen,
        async closeClient(client) {
          if (!client) return;
          try {
            await bounded(client.end(), 1500, 'service client close');
          } finally {
            client.connection?.stream?.destroy();
          }
        },
        wait: (promise, label) => bounded(promise, 1500, label),
        spawn(binary, args, options) {
          const port = Number(args[args.indexOf('-p') + 1]);
          console.log(`ANNOUNCE before launch: owned PostgreSQL root=${root}, port=${port}; proposed 59621 unused`);
          report.announcement = { root, port, beforeLaunch: true };
          serviceHandle = scope.spawn(binary, args, options, { binary, args, cwd: root });
          serviceHandle.service = true;
          return serviceHandle.child;
        },
        stop: () => serviceHandle.stop(true),
      },
      registerStop(stop) {
        scope.registerStop(async () => {
          const item = report.services[0];
          try {
            await stop();
          } finally {
            Object.assign(item, {
              ownedProcesses: serviceHandle.record.ownedProcesses,
              remainingPids: serviceHandle.record.remainingPids,
              remainingGroups: serviceHandle.record.remainingGroups,
            });
            assert.deepEqual(item.remainingPids, []);
            assert.deepEqual(item.remainingGroups, []);
            const probe = createServer();
            try {
              await bounded(
                new Promise((yes, no) => {
                  probe.once('error', no);
                  probe.listen(item.port, '127.0.0.1', yes);
                }),
                1000,
                'released port audit',
              );
              item.portReleased = true;
            } finally {
              if (probe.listening) await new Promise((yes) => probe.close(yes));
            }
            rmSync(item.datadir, { recursive: true, force: true });
            rmSync(item.socket, { recursive: true, force: true });
            item.datadirRemoved = !existsSync(item.datadir);
            item.socketRemoved = !existsSync(item.socket);
            item.auditComplete = true;
          }
        });
      },
    });
    report.postgresBinarySha256 = sha256(readFileSync(join(env.PG_PREFIX, 'bin/postgres')));
    report.initdbBinarySha256 = sha256(readFileSync(join(env.PG_PREFIX, 'bin/initdb')));
    report.durability = (
      await service.client.query(
        "SELECT name,setting FROM pg_settings WHERE name IN ('fsync','synchronous_commit','full_page_writes') ORDER BY name",
      )
    ).rows;
    assert.equal(report.durability.length, 3);
    for (const item of report.durability) assert.equal(item.setting, 'on');
    const database = `durable_${process.pid}`;
    await service.client.query(`CREATE DATABASE "${database}"`);
    const url = new URL(service.url);
    url.pathname = `/${database}`;
    const nativeEnv = {
      ...env,
      DATABASE_URL: url.href,
      TURBINE_REQUIRE_ENGINE: 'postgres',
      NOTIFICATION_ENDPOINT: 'direct',
    };
    await run(consumer, process.execPath, ['esm/generated-seed.js'], nativeEnv);
    report.generatedConsumers = {};
    for (const format of report.formats) {
      const source = join(consumer, `${format}-source`);
      const bin = join(installed, format === 'esm' ? 'dist/cli/index.js' : 'dist/cjs/cli/index.js');
      await run(
        source,
        process.execPath,
        [bin, 'generate', '--url', url.href, '--schema', 'durable_generated', '--out', './generated', '--no-timestamp'],
        nativeEnv,
      );
      cpSync(
        join(repo, 'src/test/fixtures/postgres-durable-replay/generated-consumer.ts.txt'),
        join(source, 'generated-consumer.ts'),
      );
      await run(consumer, process.execPath, [tsc, '-p', join(source, 'tsconfig.json')]);
      report.generatedConsumers[format] = JSON.parse(
        (await run(consumer, process.execPath, [`${format}/generated-consumer.js`], nativeEnv)).trim(),
      );
      assert.equal(report.generatedConsumers[format].generatedTypedProjection, true);
    }
    report.sourceNative = tap(
      await run(
        repo,
        process.execPath,
        ['--import', 'tsx', '--test', '--test-reporter=tap', '--test-concurrency=1', 'src/test/durable-replay.test.ts'],
        {
          ...nativeEnv,
          TSX_TSCONFIG_PATH: join(repo, 'src/test/fixtures/postgres-durable-replay/source-tsconfig.json'),
        },
      ),
    );
    report.installedNative = {};
    report.demos = {};
    for (const format of report.formats) {
      report.installedNative[format] = tap(
        await run(
          consumer,
          process.execPath,
          ['--test', '--test-reporter=tap', '--test-concurrency=1', `${format}/src/test/durable-replay.test.js`],
          {
            ...nativeEnv,
            REPLAY_APPLICATION_MODULE: join(consumer, format, 'examples/postgres-durable-replay/application.js'),
          },
        ),
      );
      report.demos[format] = JSON.parse(
        (
          await run(consumer, process.execPath, [`${format}/examples/postgres-durable-replay/demo.js`], nativeEnv)
        ).trim(),
      );
      assert.deepEqual(report.demos[format], { delivered: 1, restartRemaining: 0, callerPoolSurvived: true });
      const record = {
        cwd: consumer,
        binary: process.execPath,
        args: [`${format}/examples/postgres-durable-replay/demo.js`],
      };
      report.commands.push(record);
      const handle = scope.spawn(
        process.execPath,
        record.args,
        { cwd: consumer, env: { ...nativeEnv, REPLAY_WAIT_FOR_SIGNAL: '1' }, deadlineMs: 15000 },
        record,
      );
      let stdout = '',
        stderr = '';
      const ready = new Promise((yes, no) => {
        handle.child.stdout.on('data', (chunk) => {
          stdout += chunk;
          if (stdout.includes('"readyForSignal":true')) yes();
        });
        handle.child.stderr.on('data', (chunk) => {
          stderr += chunk;
        });
        handle.closed.then(() => {
          if (!stdout.includes('"readyForSignal":true')) no(new Error(stdout + stderr));
        });
      });
      await bounded(ready, 10000, 'demo signal readiness');
      await handle.stop(); // Existing kernel owner sends SIGTERM to the exact admitted process.
      Object.assign(record, { stdout, stderr });
      assert.match(stdout, /"signalCleanup":true,"poolClosedByCaller":true/);
      assert.equal(record.code, 0);
      record.expectedSignalCleanup = 'SIGTERM handled; graceful exit 0';
    }
    const remaining = (
      await service.client.query(
        "SELECT pid,datname FROM pg_stat_activity WHERE backend_type='client backend' AND pid<>pg_backend_pid()",
      )
    ).rows;
    assert.deepEqual(remaining, []);
    report.residualBackends = remaining;
    await service.client.query(`DROP DATABASE "${database}"`);
    report.databaseDropped = true;
    report.payloadHashes = installedPayload(join(reference, 'package'), installed);
    assert.equal(archiveIdentity(identity.tarball, pin).sha256, identity.sha256);
    report.payloadUnchanged = true;
  },
  async () => {
    // Keep consumer locks, generated JS/declarations and failure reports. Remove only owned native data.
    rmSync(root, { recursive: true, force: true });
    report.rootRemoved = !existsSync(root);
  },
).catch((error) => {
  console.error(error);
  process.exitCode = report.signalExitCode ?? 1;
});
if (report.success) console.log(`durable replay passed ${process.version}: ${join(output, 'report.json')}`);
