/** Source-native workflow plus actual installed-archive ESM/CJS example execution.
 * Reuses repository process ownership and PostgreSQL fixtures; no new supervisor.
 */
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { ownedPostgres } from '../../../../tooling/native-consumer-contracts/postgres-service.mjs';
import {
  archiveIdentity,
  command,
  installedPayload,
  sha256,
} from '../../../../tooling/optional-pg-transports/harness.mjs';
import { bounded } from '../../../../tooling/optional-pg-transports/lifecycle.mjs';
import { runWithShutdown } from '../../../../tooling/optional-pg-transports/run.mjs';

const repo = fileURLToPath(new URL('../../../../', import.meta.url));
const [archive, pin, destination] = process.argv.slice(2);
assert.ok(destination, 'Usage: node native-run.mjs ARCHIVE SHA256 OUTPUT_DIRECTORY');
assert.ok(['v22.16.0', 'v24.10.0'].includes(process.version), 'Exact Node 22.16.0 or 24.10.0 required');
assert.ok(process.env.PG_PREFIX, 'PG_PREFIX with native PostgreSQL 18.6 required');
const output = resolve(destination);
mkdirSync(output, { recursive: true });
// Short socket path, unique service/datadir/port/database per invocation.
const root = mkdtempSync(join(tmpdir(), 'lqh-'));
const report = {
  scope: 'local PostgreSQL 18.6 TCP only; source and exact archive are separate',
  runtime: process.version,
  preparedBase: '26269db86b8bf4407aeb73f4fd38fa17bf5d4974',
  commands: [],
  services: [],
  formats: ['esm', 'cjs'],
  root,
};
const env = {
  ...process.env,
  LD_LIBRARY_PATH: [join(process.env.PG_PREFIX, 'lib'), process.env.LD_LIBRARY_PATH].filter(Boolean).join(':'),
};

await runWithShutdown(
  report,
  join(output, 'report.json'),
  async (scope) => {
    const run = (cwd, binary, args, childEnv = env) =>
      command(report, cwd, binary, args, childEnv, { scope, timeoutMs: 90000 });
    report.sourceHead = (await run(repo, 'git', ['rev-parse', 'HEAD'])).trim();
    report.sourceInputs = Object.fromEntries(
      [
        'examples/notification-live-query/application.ts',
        'examples/notification-live-query/demo.ts',
        'src/live-query.ts',
        'src/notification-hub.ts',
        'src/test/live-query-hub-pg.test.ts',
        'src/test/fixtures/live-query-hub-pg/fixture.ts',
        'src/test/fixtures/live-query-hub-pg/native-run.mjs',
        'src/test/fixtures/live-query-hub-pg/source-tsconfig.json',
      ].map((file) => [file, sha256(readFileSync(join(repo, file)))]),
    );
    const identity = archiveIdentity(resolve(archive), pin);
    report.archive = { path: identity.tarball, sha256: identity.sha256 };
    const consumer = join(root, 'consumer'),
      reference = join(root, 'reference');
    mkdirSync(consumer);
    mkdirSync(reference);
    await run(root, 'tar', ['-xzf', identity.tarball, '-C', reference]);
    writeFileSync(join(consumer, 'package.json'), '{"private":true,"type":"module"}');
    // Type packages are consumer build fixtures, never runtime package dependencies.
    await run(consumer, 'npm', [
      'install',
      '--ignore-scripts',
      '--omit=optional',
      '--no-audit',
      '--no-fund',
      identity.tarball,
      '@types/node@22.20.4',
      '@types/pg@8.15.6',
    ]);
    const installed = join(consumer, 'node_modules/turbine-orm');
    report.payloadHashes = installedPayload(join(reference, 'package'), installed);
    const tsc = join(repo, 'node_modules/typescript/bin/tsc');
    for (const format of report.formats) {
      const source = join(consumer, `${format}-source`);
      mkdirSync(source);
      writeFileSync(join(source, 'package.json'), JSON.stringify({ type: format === 'esm' ? 'module' : 'commonjs' }));
      for (const name of ['application.ts', 'demo.ts'])
        cpSync(join(repo, 'examples/notification-live-query', name), join(source, name));
      // Positive and negative type assertions against the actual application composition.
      writeFileSync(
        join(source, 'types.ts'),
        `import {createApplication} from './application.js';
import type {LiveQuery} from 'turbine-orm/live-query';
import type {TurbineClient} from 'turbine-orm';
function check(app:ReturnType<typeof createApplication>, db:TurbineClient) {
const read=()=>db.table<{id:number;title:string;secret:string}>('orders').findMany({select:{id:true,title:true}});
const live=app.watch(read); const exact:LiveQuery<{id:number;title:string}[]>=live;
// @ts-expect-error result id must remain numeric
const bad:LiveQuery<{id:string}[]>=live;
live.next().then(result=>{if(!result.done){
// @ts-expect-error projection excludes secret
result.value[0]!.secret;
// @ts-expect-error selected id is not any
const text:string=result.value[0]!.id; void text;
}}); void exact; void bad;
// @ts-expect-error endpoint must assert session affinity
createApplication({pool:null as never,endpoint:'transaction-pool',channel:'orders',onDiagnostic(){}});
} void check;
`,
      );
      const config = join(source, 'tsconfig.json');
      writeFileSync(
        config,
        JSON.stringify({
          compilerOptions: {
            target: 'ES2023',
            module: 'NodeNext',
            moduleResolution: 'NodeNext',
            strict: true,
            skipLibCheck: false,
            noUncheckedIndexedAccess: true,
            outDir: `../${format}`,
            declaration: true,
            types: ['node'],
          },
          include: ['*.ts'],
        }),
      );
      await run(consumer, process.execPath, [tsc, '-p', config]);
      writeFileSync(
        join(consumer, format, 'package.json'),
        JSON.stringify({ type: format === 'esm' ? 'module' : 'commonjs' }),
      );
    }
    report.strictConsumers = ['esm', 'cjs'];
    // The missing-service control uses the same suite and required engine gate.
    let refused = false;
    try {
      await run(
        repo,
        process.execPath,
        ['--import', 'tsx', '--test', '--test-reporter=tap', 'src/test/live-query-hub-pg.test.ts'],
        {
          ...env,
          DATABASE_URL: '',
          TURBINE_REQUIRE_ENGINE: 'postgres',
        },
      );
    } catch (error) {
      assert.match(error.message, /precondition is unmet: DATABASE_URL not set/);
      report.commands.at(-1).expectedFailure = 'missing required PostgreSQL';
      refused = true;
    }
    assert.equal(refused, true, 'required missing database cannot become a passing skip');
    report.missingPrerequisiteRefused = true;
    let serviceHandle;
    const service = await ownedPostgres({
      root,
      env,
      driver: pg,
      report,
      run: (cwd, binary, args) => run(cwd, binary, args),
      processLifecycle: {
        assertOpen: scope.assertOpen,
        async closeClient(client) {
          if (!client) return;
          try {
            await bounded(client.end(), 1500, 'PostgreSQL client close');
          } finally {
            client.connection?.stream?.destroy();
          }
        },
        wait: (promise, label) => bounded(promise, 1500, label),
        spawn(binary, args, options) {
          const record = { binary, args, cwd: root };
          serviceHandle = scope.spawn(binary, args, options, record);
          serviceHandle.service = true;
          return serviceHandle.child;
        },
        stop: () => serviceHandle.stop(true),
      },
      registerStop(stop) {
        scope.registerStop(async () => {
          const identity = report.services[0];
          try {
            await stop();
          } finally {
            Object.assign(identity, {
              ownedProcesses: serviceHandle.record.ownedProcesses,
              remainingPids: serviceHandle.record.remainingPids,
              remainingGroups: serviceHandle.record.remainingGroups,
            });
            assert.deepEqual(identity.remainingPids, []);
            assert.deepEqual(identity.remainingGroups, []);
            const probe = createServer();
            try {
              await bounded(
                new Promise((yes, no) => {
                  probe.once('error', no);
                  probe.listen(identity.port, '127.0.0.1', yes);
                }),
                1000,
                'released port audit',
              );
              identity.portReleased = true;
            } finally {
              if (probe.listening) await new Promise((yes) => probe.close(yes));
            }
            rmSync(identity.datadir, { recursive: true, force: true });
            rmSync(identity.socket, { recursive: true, force: true });
            identity.datadirRemoved = !existsSync(identity.datadir);
            identity.socketRemoved = !existsSync(identity.socket);
            identity.auditComplete = true;
          }
        });
      },
    });
    const database = `lqh_${process.pid}`;
    await service.client.query(`CREATE DATABASE "${database}"`);
    const url = new URL(service.url);
    url.pathname = `/${database}`;
    const nativeEnv = {
      ...env,
      DATABASE_URL: url.href,
      TURBINE_REQUIRE_ENGINE: 'postgres',
      NOTIFICATION_ENDPOINT: 'direct',
    };
    const stdout = await run(
      repo,
      process.execPath,
      [
        '--import',
        'tsx',
        '--test',
        '--test-reporter=tap',
        '--test-concurrency=1',
        'src/test/live-query-hub-pg.test.ts',
      ],
      {
        ...nativeEnv,
        TSX_TSCONFIG_PATH: join(repo, 'src/test/fixtures/live-query-hub-pg/source-tsconfig.json'),
      },
    );
    assert.match(stdout, /# tests 6\b/);
    assert.match(stdout, /# pass 6\b/);
    assert.match(stdout, /# skipped 0\b/);
    assert.doesNotMatch(stdout, /^\s*not ok\b/m);
    report.sourceNative = {
      tests: 6,
      skipped: 0,
      modules: 'public optional imports mapped to src only by source-tsconfig.json',
    };
    for (const format of report.formats) {
      const result = await run(consumer, process.execPath, [join(format, 'demo.js')], nativeEnv);
      assert.deepEqual(JSON.parse(result.trim()), {
        snapshots: [{ id: 1, title: 'packed order' }],
        siblingAlive: true,
        subscriptions: 1,
      });
    }
    report.installedExample = ['esm', 'cjs'];
    report.endpointRefusals = [];
    for (const endpoint of ['transaction-pool', 'statelessHTTP']) {
      let refused = false;
      try {
        await run(consumer, process.execPath, ['esm/demo.js'], { ...nativeEnv, NOTIFICATION_ENDPOINT: endpoint });
      } catch (error) {
        assert.match(error.message, /Transaction pooling and stateless HTTP cannot LISTEN/);
        report.commands.at(-1).expectedFailure = `endpoint ${endpoint}`;
        refused = true;
      }
      assert.equal(refused, true);
      report.endpointRefusals.push(endpoint);
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
  async (errors) => {
    // Only isolated generated outputs are removed; preserve reports and command evidence.
    rmSync(root, { recursive: true, force: true });
    report.rootRemoved = !existsSync(root);
    if (!report.rootRemoved) errors.push('Owned fixture root remains');
  },
).catch((error) => {
  console.error(error);
  process.exitCode = report.signalExitCode ?? 1;
});
if (report.success)
  console.log(
    `native live-query hub: ${process.version}; source + installed ESM/CJS passed; ${join(output, 'report.json')}`,
  );
