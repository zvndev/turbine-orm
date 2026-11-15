import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { ARMS, CAPACITY, CASES, checkEffect, comparisons, FLAGS, finalize, SHAPES, seed, shuffled } from './oracle.mjs';
import { provenance, require } from './provenance.mjs';
import { validate } from './validate.mjs';

const output = process.argv[2];
assert.ok(output, 'usage: node --import tsx run.mjs NEW-report.json (owned service wrapper required)');
const report = { format: 'mysql-preparation-v1', status: 'running', samples: [], controls: [], cleanupErrors: [] };
let admin, observer, activeRoute, database, interrupted;
const signal = (name) => {
  interrupted = name;
};
const sigterm = () => signal('SIGTERM'),
  sigint = () => signal('SIGINT');
process.on('SIGTERM', sigterm);
process.on('SIGINT', sigint);
try {
  assert.ok(
    ['v22.16.0', 'v24.10.0'].includes(process.version),
    'measurement requires exact Node22.16.0 or Node24.10.0',
  );
  assert.ok(process.env.MYSQL_PREP_OWNED_IDENTITY, 'required owned native MySQL service identity is missing');
  const identity = JSON.parse(readFileSync(process.env.MYSQL_PREP_OWNED_IDENTITY, 'utf8'));
  assert.equal(identity.ownerUid, process.getuid());
  assert.equal(identity.status, 'ready');
  process.kill(identity.pid, 0);
  const connection = { host: '127.0.0.1', port: identity.port, user: 'root' };
  report.provenance = provenance(process.env.MYSQL_PREP_ARTIFACT, fileURLToPath(import.meta.url));
  report.config = {
    rounds: Number(process.env.MYSQL_PREP_ROUNDS ?? 4),
    iterations: Number(process.env.MYSQL_PREP_ITERATIONS ?? 32),
    seed: 1297696,
    capacity: CAPACITY,
    flags: FLAGS,
    mode: identity.mode,
  };
  assert.ok(Number.isSafeInteger(report.config.rounds) && report.config.rounds >= 4 && report.config.rounds <= 100);
  assert.ok(
    Number.isSafeInteger(report.config.iterations) &&
      report.config.iterations >= 16 &&
      report.config.iterations <= 100000,
  );
  const importStart = performance.now();
  const mysql = require('mysql2/promise');
  report.driverImportMs = performance.now() - importStart;
  const sourceStart = performance.now();
  const { createRoute, serverCount, difference } = await import('./routes.mjs');
  const { controls } = await import('./controls.mjs');
  report.sourceImportMs = performance.now() - sourceStart;
  const initStart = performance.now();
  admin = await mysql.createConnection({ ...connection, ...FLAGS });
  const [server] = await admin.query(
    'SELECT VERSION() AS version, @@sql_mode AS sqlMode, @@port AS port, @@datadir AS datadir, @@performance_schema AS performanceSchema',
  );
  report.server = {
    ...server[0],
    binarySha256: identity.binarySha256,
    binaryVersion: identity.binaryVersion,
    root: identity.root,
    pid: identity.pid,
    mode: identity.mode,
  };
  assert.equal(report.server.version, '8.4.0', 'required exact native MySQL8.4.0');
  assert.equal(report.server.port, identity.port);
  assert.equal(report.server.datadir.replace(/\/$/, ''), identity.data);
  assert.equal(report.server.performanceSchema, 1);
  const modes = new Set(report.server.sqlMode.split(','));
  assert.equal(modes.has('ANSI_QUOTES'), identity.mode === 'ansi-no-backslash');
  assert.equal(modes.has('NO_BACKSLASH_ESCAPES'), identity.mode === 'ansi-no-backslash');
  database = `mysql_preparation_${randomBytes(8).toString('hex')}`;
  await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`);
  observer = await mysql.createConnection({ ...connection, ...FLAGS, database });
  await seed(observer);
  // Fixture preparation is excluded from the measured server cache occupancy.
  for (const stmt of [...observer.connection._statements.values()]) observer.unprepare(stmt.query);
  await observer.query('SELECT 1');
  report.fixtureInitMs = performance.now() - initStart;
  const config = { ...connection, database },
    baseline = await serverCount(observer);
  assert.equal(baseline, 0, 'fresh owned server has no foreign prepared statements');
  report.network = [];
  for (let i = 0; i < 16; i++) {
    const t = performance.now();
    const [rows] = await observer.query('SELECT 1 AS n');
    const ms = performance.now() - t;
    checkEffect(rows, 1);
    report.network.push({ ms });
  }
  const fault = process.env.MYSQL_PREP_FAULT;
  assert.ok(
    [undefined, 'effect', 'route', 'bounds', 'report', 'signal', 'cleanup'].includes(fault),
    'unknown forced fault',
  );
  if (interrupted) throw new Error(`interrupted: ${interrupted}`);
  report.controls = await controls(config, observer, identity.mode, fault, report.controls);
  if (fault === 'signal')
    await new Promise((resolve) => {
      process.once('SIGTERM', resolve);
      process.kill(process.pid, 'SIGTERM');
    });
  if (interrupted) throw new Error(`interrupted: ${interrupted}`);
  report.sql = {};
  for (let round = 0; round < report.config.rounds; round++)
    for (const shape of SHAPES)
      for (const name of CASES) {
        const order = shuffled(ARMS, report.config.seed + round * 43 + SHAPES.indexOf(shape) * 7 + CASES.indexOf(name));
        for (const arm of order) {
          if (interrupted) throw new Error(`interrupted: ${interrupted}`);
          activeRoute = await createRoute(config, shape, arm);
          const route = activeRoute;
          try {
            report.sql.read ??= route.sql;
            assert.equal(route.sql, report.sql.read, 'identical compiled read SQL across arms');
            report.sql.rollback = [
              'START TRANSACTION',
              'UPDATE effects SET n = :p1 WHERE id = :p2',
              'SELECT n FROM effects WHERE id = :p1',
              'ROLLBACK',
            ];
            for (const phase of ['cold', 'warm']) {
              if (phase === 'cold') await route.clear();
              else for (let i = 0; i < 8; i++) (await route.run(name, (i % 4) + 1, i + 1))();
              const before = await route.counters(),
                memoryBefore = process.memoryUsage();
              const checkoutIndex = route.checkoutSamples.length;
              const n = phase === 'cold' ? 1 : report.config.iterations;
              let ms = 0,
                cpuMicros = 0,
                checkedResults = 0;
              const wall = performance.now();
              for (let i = 0; i < n; i++) {
                if (interrupted) throw new Error(`interrupted: ${interrupted}`);
                const cpu = process.cpuUsage(),
                  started = performance.now();
                const verify = await route.run(name, (i % 4) + 1, i + 11, fault);
                ms += performance.now() - started;
                const used = process.cpuUsage(cpu);
                cpuMicros += used.user + used.system;
                verify();
                checkedResults++;
                // A second session independently verifies every rollback, outside timing.
                if (name === 'rollback') checkEffect((await observer.query('SELECT n FROM effects WHERE id=1'))[0], 0);
              }
              const wallIncludingChecksMs = performance.now() - wall;
              const protocol = difference(await route.counters(), before);
              if (fault === 'route') protocol.Com_stmt_execute = 0;
              const expectedExecutes = arm.startsWith('text') ? 0 : n * (name === 'read' ? 1 : 2);
              assert.equal(protocol.Com_stmt_execute, expectedExecutes, 'actual binary execution route');
              if (phase === 'warm')
                assert.equal(protocol.Com_stmt_prepare, 0, 'warm executions reuse existing preparations');
              else assert.equal(protocol.Com_stmt_prepare, arm.startsWith('text') ? 0 : name === 'read' ? 1 : 2);
              const occupancy = route.occupancy(),
                serverPrepared = await serverCount(observer);
              assert.equal(
                serverPrepared,
                occupancy.driver.reduce((n, d) => n + d.size, 0),
              );
              report.samples.push({
                round,
                shape,
                name,
                arm,
                phase,
                order,
                ms,
                cpuMicros,
                operations: n,
                checkedResults,
                independentlyCheckedEffects: name === 'rollback' ? n : 0,
                protocol,
                occupancy,
                serverPrepared,
                initMs: route.initMs,
                checkout: route.checkoutSamples.slice(checkoutIndex),
                memoryBefore,
                memoryAfter: process.memoryUsage(),
                wallIncludingChecksMs,
                recentWire: [...route.wire],
              });
              // Instrumentation is bounded independently of campaign length.
              assert.ok(route.wire.length <= 64);
            }
          } finally {
            await route.close();
            activeRoute = null;
          }
          assert.equal(await serverCount(observer), 0, 'statements removed after each route');
        }
      }
  report.comparisons = comparisons(report.samples);
  if (fault === 'report') report.comparisons[0].pairedMedianMs += 1;
  report.limits = [
    'Small local loopback sample; no speed winner, global recommendation, or production optimization.',
    'Cold means empty statement caches on initialized connections; process imports, factory/init, fixture, network baseline, and checkout observations are separate.',
    'Operation timing includes query/decode and checkout; exact oracles and independent effect reads run outside it. Timing instrumentation has cost. CPU/RSS describe the application process, not server CPU.',
    'Pool has two initialized physical connections and serial operations; no contention or cross-process reuse claim.',
    'Driver statement LRU and harness handle map are bounded and observed. All-driver parser/name-cache memory bounds are unsupported; RSS snapshots are observations, not a proof of plateau.',
    'Injected pools preserve startup SQL mode. Owned factory mode mutation is exercised only by ownership controls.',
    'Native SQL Server is unavailable and untested. Artifact is hashed, not executed; source paths are measured.',
  ];
} catch (error) {
  report.failure = String(error.stack ?? error);
} finally {
  const success = await finalize(
    report,
    [
      async () => {
        await activeRoute?.close();
      },
      async () => {
        await observer?.end();
      },
      async () => {
        if (database && admin) {
          await admin.query(`DROP DATABASE \`${database}\``);
          const [rows] = await admin.query('SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME=?', [
            database,
          ]);
          assert.equal(rows.length, 0);
          report.databaseRemoved = true;
        }
      },
      async () => {
        if (admin) {
          try {
            const [rows] = await admin.query(
              "SELECT ID FROM information_schema.PROCESSLIST WHERE ID <> CONNECTION_ID() AND USER = 'root'",
            );
            assert.deepEqual(rows, [], 'all application sessions independently closed');
            report.applicationSessionsClosed = true;
          } finally {
            await admin.end();
          }
        }
      },
      async () => {
        if (interrupted) throw new Error(`interrupted: ${interrupted}`);
      },
      async () => {
        if (!report.failure && !report.cleanupErrors.length) {
          report.status = 'passed';
          validate(report);
        }
      },
    ],
    (r) => writeFileSync(output, `${JSON.stringify(r, null, 2)}\n`, { flag: 'wx' }),
  );
  process.off('SIGTERM', sigterm);
  process.off('SIGINT', sigint);
  if (!success) {
    console.error(report.failure ?? report.cleanupErrors.join('\n'));
    process.exitCode = interrupted ? 143 : 1;
  } else console.log(JSON.stringify({ output, samples: report.samples.length, status: report.status }));
}
