import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { cpus, totalmem } from 'node:os';
import { join, resolve } from 'node:path';
import pg from 'pg';
import { command } from '../../../tooling/optional-pg-transports/harness.mjs';
import { runWithShutdown } from '../../../tooling/optional-pg-transports/run.mjs';
import { readExtendedFixture } from '../dist/canonical/extended-equivalence.js';
import { catalog } from './catalog.mjs';
import { comparators } from './comparators.mjs';
import { execute } from './execution.mjs';
import { assertFixturePreserved, createArms, cursorControls, preflight } from './native.mjs';
import { servicePlan, startService } from './service.mjs';
import { timing } from './timing.mjs';
import { here, json, sha256, treeDigest, verifyPins } from './verify-pins.mjs';

const options = {};
for (let i = 2; i < process.argv.length; i += 2) {
  const name = process.argv[i]?.replace(/^--/, '');
  assert.ok(
    [
      'mode',
      'out',
      'service-plan',
      'artifact',
      'artifact-sha256',
      'artifact-source',
      'comparators',
      'rounds',
      'warmup',
      'fault',
    ].includes(name),
    `Unknown option ${process.argv[i]}`,
  );
  assert.ok(process.argv[i + 1] && !process.argv[i + 1].startsWith('--'), `Missing value for ${name}`);
  assert.equal(options[name], undefined, `Duplicate option ${name}`);
  options[name] = process.argv[i + 1];
}
const mode = options.mode ?? 'preflight';
assert.ok(['catalog', 'plan', 'preflight', 'timing'].includes(mode), 'Mode must be catalog, plan, preflight or timing');
if (mode === 'catalog') {
  console.log(
    JSON.stringify(
      {
        appendix: 'prisma8-postgres-candidate',
        engines: { postgresql: 'implemented', mysql: 'unsupported', sqlite: 'unsupported', mongodb: 'unsupported' },
        catalog: catalog(),
      },
      null,
      2,
    ),
  );
} else if (mode === 'plan') {
  assert.ok(options.out, '--out required');
  console.log(JSON.stringify(await servicePlan(options.out, process.env.PG_PREFIX), null, 2));
} else {
  const { pins, runtime } = verifyPins();
  const build = json(join(here, 'dist/build.json'));
  assert.equal(build.compiler, '5.9.3');
  for (const dir of ['src', 'fixture', 'canonical'])
    assert.equal(treeDigest(join(here, dir)), build.source[dir], `Stale build: ${dir}; npm run build`);
  for (const dir of ['src', 'fixture', 'canonical'])
    assert.equal(
      treeDigest(join(here, 'dist', dir)),
      build.emitted[dir],
      `Emitted payload changed: ${dir}; npm run build`,
    );
  assert.ok(options['service-plan'], '--service-plan required; only a NEW private PG18.6 service is allowed');
  const plan = json(resolve(options['service-plan']));
  assert.equal(plan.format, 1);
  assert.ok(existsSync(plan.root));
  const reportPath = join(plan.out, 'report.json');
  assert.ok(!existsSync(reportPath), 'Attempt already has a report; plan a new evidence directory');
  const rounds = Number(options.rounds ?? 30),
    warmup = Number(options.warmup ?? 5);
  assert.ok(
    Number.isSafeInteger(rounds) && rounds >= 10 && Number.isSafeInteger(warmup) && warmup >= 0,
    'Timing requires rounds>=10 and warmup>=0',
  );
  assert.ok(
    !options.fault || ['omit', 'corrupt', 'route', 'effect', 'rollback'].includes(options.fault),
    'Unknown fault',
  );
  assert.ok(mode !== 'timing' || !options.fault, 'Fault injection cannot be timing evidence');
  let artifact = null;
  if (options.artifact || mode === 'timing') {
    assert.ok(
      options.artifact && options['artifact-sha256'] && options['artifact-source'],
      'Frozen Turbine artifact, SHA256 and source commit required',
    );
    assert.match(options['artifact-source'], /^[a-f0-9]{40}$/);
    artifact = {
      path: resolve(options.artifact),
      sha256: sha256(readFileSync(resolve(options.artifact))),
      sourceCommit: options['artifact-source'],
    };
    assert.equal(artifact.sha256, options['artifact-sha256'], 'Frozen Turbine artifact hash mismatch');
    artifact.manifest = JSON.parse(
      execFileSync('tar', ['-xzOf', artifact.path, 'package/package.json'], {
        encoding: 'utf8',
        maxBuffer: 1024 * 1024,
      }),
    );
    assert.equal(artifact.manifest.name, 'turbine-orm', 'Pinned artifact must be a Turbine package archive');
  }
  const rows = catalog();
  const report = {
    formatVersion: 1,
    appendix: 'prisma8-postgres-candidate',
    status: 'running',
    mode,
    started: new Date().toISOString(),
    source: {
      base: pins.canonicalBase,
      head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: here, encoding: 'utf8' }).trim(),
      candidateSha256: Object.fromEntries(
        ['src', 'scripts', 'fixture', 'canonical'].map((d) => [d, treeDigest(join(here, d))]),
      ),
      build,
      gitStatus: execFileSync('git', ['status', '--short'], { cwd: here, encoding: 'utf8' }).trim(),
    },
    identity: pins,
    runtime,
    artifact,
    host: { cpu: cpus()[0]?.model, logicalCpus: cpus().length, totalMemory: totalmem() },
    profile: {
      driver: 'pg@8.22.0',
      baselineDriver: 'pg@8.23.1',
      driverComparison: 'separate matched-driver appendix; baseline remains separate',
      poolMax: 3,
      cursorBatchSize: 1000,
      ownershipControlPoolMax: 1,
      verifyMarker: false,
      prepared: 'candidate native default; no prepared-name parity claim',
      isolation: 'server default; READ COMMITTED on fixture service',
      independent: 'Promise.all of independent reads, pool max3; neither pipeline nor snapshot',
      sequential: 'five ordered autocommit reads',
      transaction: 'five sequential reads within callback BEGIN/COMMIT',
      cursor: 'native PostgreSQL portal, public postgres({cursor:{batchSize:1000}}), ordered full drain',
      buffered: 'no cursor option; complete result buffered before consumption',
      materialization: 'eager structuredClone inside measured callback for all arms; streams retain full timed digest',
      rowsAndTypes: 'immutable canonical full projection, ordered values, dates and exact declared integers',
    },
    settings: {
      rounds: mode === 'timing' ? rounds : null,
      warmup: mode === 'timing' ? warmup : null,
      fault: options.fault ?? null,
    },
    catalog: rows,
    commands: [],
    services: [],
    cases: [],
    controls: [],
    results: null,
    metrics: {
      status: mode === 'timing' ? 'pending' : 'unavailable',
      p99: null,
      firstRowLatency: null,
      peakMemory: null,
      ranking: null,
    },
    limits: [
      'PostgreSQL only; no MySQL/SQLite/MongoDB candidate claims.',
      'Separate candidate appendix, never a replacement for stable baseline.',
      'No atomic-increment typed ORM or autocommit-pipeline credit.',
      'No nested query inside active cursor on pinned client/transaction: would wait for its occupied connection.',
      'No global ranking; p99 and first-row latency/memory unmeasured.',
      'Optional comparator inputs remain unexecuted unless explicitly supplied and preflighted.',
    ],
  };
  try {
    await runWithShutdown(report, reportPath, async (scope) => {
      const service = await startService(plan, report, scope);
      const oracle = new pg.Client({ connectionString: service.url, connectionTimeoutMillis: 2000 });
      scope.registerStop(() => oracle.end());
      await oracle.connect();
      assert.equal(
        (await oracle.query("SELECT current_setting('data_directory') AS dir")).rows[0].dir,
        join(plan.root, 'data'),
      );
      await command(
        report,
        here,
        process.execPath,
        [join(here, 'dist/canonical/seed-neon.js')],
        {
          ...process.env,
          DATABASE_URL: service.url,
          USERS: '1000',
          POSTS_PER_USER: '10',
          COMMENTS_PER_POST: '5',
          WIDE_ROWS: '2000',
          TZ: 'UTC',
          NODE_OPTIONS: '',
          NODE_PATH: '',
        },
        { scope, timeoutMs: 60000 },
      );
      const arms = await createArms(service.url, scope);
      arms.push(...(await comparators(options.comparators, service.url, rows, report, scope)));
      if (mode === 'timing') {
        const turbine = report.comparatorInputs?.find((arm) => arm.name === 'Turbine');
        assert.ok(turbine, 'Timing requires actual Turbine comparator input from the pinned pinned artifact');
        assert.equal(
          turbine.artifact.sha256,
          artifact.sha256,
          'Turbine comparator must use the exact supplied artifact',
        );
        assert.equal(turbine.sourceCommit, artifact.sourceCommit, 'Turbine comparator source mismatch');
        assert.equal(turbine.version, artifact.manifest.version, 'Turbine comparator version mismatch');
      }
      const full = await execute(scope, () => readExtendedFixture(oracle), 'Original immutable read fixture');
      const fixture = await execute(
        scope,
        () => preflight(report, rows, arms, oracle, scope, options.fault, full),
        'Candidate preflight',
        120000,
      );
      await execute(
        scope,
        () => cursorControls(service.url, oracle, fixture, report, scope, options.fault),
        'Native cursor controls',
      );
      await assertFixturePreserved(oracle, full, scope, 'Controls preserve original read fixture');
      report.fixtureChecks.controls = 'passed';
      report.preflight = {
        status: 'passed',
        cases: report.cases.length,
        controls: report.controls.length,
        engines: ['postgresql'],
        fixture: 'canonical 1000/10000/50000; tags50/junction30000/wide2000',
      };
      for (const row of rows)
        for (const [name, cell] of Object.entries(row.arms)) {
          if (cell.status !== 'implemented') continue;
          const cases = report.cases.filter((item) => item.id === row.id && item.arm === name);
          assert.ok(cases.length, `Supported cell was not preflighted: ${row.id}/${name}`);
          cell.preflight = { status: 'passed', cases: cases.length };
        }
      if (mode === 'timing') {
        await execute(
          scope,
          () => timing(report, rows, arms, oracle, scope, rounds, warmup, fixture, full),
          'Candidate timing',
          120000,
        );
        await assertFixturePreserved(oracle, full, scope, 'Timing preserves original read fixture');
        report.fixtureChecks.timing = 'passed';
        report.metrics.status = 'measured-separate-appendix';
      }
      report.status = 'passed';
    });
  } catch (error) {
    process.exitCode = 1;
    console.error(error.stack);
  } finally {
    report.status = report.success ? 'passed' : 'failed';
    report.finished = new Date().toISOString();
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    console.log(
      JSON.stringify({
        report: reportPath,
        status: report.status,
        cases: report.cases.length,
        controls: report.controls.length,
        timing: report.metrics.status,
      }),
    );
  }
}
