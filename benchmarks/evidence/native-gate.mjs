#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assertEvidenceProvenance, assertServerVersion, assertTestEvents } from './native-gate-policy.mjs';
import { verifyPins } from './verify-pins.mjs';
import { harnessFingerprint, sourceFingerprint } from './fingerprint.mjs';
import { execute } from './native-gate-child.mjs';

const directory = dirname(fileURLToPath(import.meta.url));
const root = resolve(directory, '../..');
const hash = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

export function gateConfig(args, env = process.env) {
  assert.ok(
    args.length === 3 || (args.length === 4 && args[3] === '--fault-materialized'),
    'Usage: native-gate.mjs postgresql|mysql EXACT_VERSION NEW_REPORT.json [--fault-materialized]',
  );
  const [engine, expectedVersion, output] = args;
  assertServerVersion(engine, expectedVersion);
  assert.equal(env.EVIDENCE_DISPOSABLE, '1', 'EVIDENCE_DISPOSABLE=1 is required');
  const variable = engine === 'postgresql' ? 'EVIDENCE_PG_ADMIN_URL' : 'EVIDENCE_MYSQL_ADMIN_URL';
  assert.ok(env[variable], `${variable} is required; a missing native service never passes`);
  const url = new URL(env[variable]);
  assert.ok(
    (engine === 'postgresql' ? ['postgres:', 'postgresql:'] : ['mysql:']).includes(url.protocol),
    'Wrong native endpoint protocol',
  );
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'Native endpoint must be disposable loopback');
  assert.ok(!url.search && !url.hash, 'Native endpoint cannot contain query parameters or fragments');
  const [major, minor] = process.versions.node.split('.').map(Number);
  assert.ok(major > 24 || (major === 24 && minor >= 10), 'Native gate requires Node >=24.10');
  return { engine, expectedVersion, output: resolve(output), variable, url, fault: args.length === 4 };
}

async function inspect(config) {
  if (config.engine === 'postgresql') {
    const { default: pg } = await import('pg');
    const client = new pg.Client({
      connectionString: config.url.href,
      connectionTimeoutMillis: 5000,
      query_timeout: 30000,
    });
    try {
      await client.connect();
      return {
        version: (await client.query('SHOW server_version')).rows[0].server_version,
        scratch: (
          await client.query(
            "SELECT datname AS name FROM pg_database WHERE left(datname,17)='turbine_evidence_' ORDER BY datname",
          )
        ).rows.map((row) => row.name),
      };
    } finally {
      await client.end();
    }
  }
  const { default: mysql } = await import('mysql2/promise');
  const client = await mysql.createConnection({
    host: config.url.hostname,
    port: Number(config.url.port || 3306),
    user: decodeURIComponent(config.url.username),
    password: decodeURIComponent(config.url.password),
    database: config.url.pathname.slice(1) || 'mysql',
    connectTimeout: 5000,
  });
  try {
    return {
      version: (await client.query('SELECT VERSION() AS version'))[0][0].version,
      scratch: (
        await client.query(
          "SELECT SCHEMA_NAME AS name FROM information_schema.SCHEMATA WHERE LEFT(SCHEMA_NAME,17)='turbine_evidence_' ORDER BY SCHEMA_NAME",
        )
      )[0].map((row) => row.name),
    };
  } finally {
    await client.end();
  }
}

export async function nativeGate(args, env = process.env) {
  // Reserve the report before prerequisite parsing. Never leave stale success.
  assert.ok(args[2], 'A fresh report path is required');
  const output = resolve(args[2]);
  writeFileSync(output, '{"status":"initializing"}\n', { flag: 'wx', mode: 0o600 });
  const report = {
    schemaVersion: 1,
    kind: 'native-stream-audit-gate-v1',
    status: 'running',
    performanceClaimsAllowed: false,
    engine: args[0],
    expectedVersion: args[1],
    cleanup: { scratch: 'not-checked', serviceLifecycle: 'caller-owned; adapter never stops an endpoint' },
    commands: [],
    artifacts: {},
  };
  const save = () => writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
  let config, baseline, failure;
  try {
    report.phase = 'prerequisites';
    save();
    config = gateConfig(args, env);
    report.installed = verifyPins();
    const rootRequire = createRequire(join(root, 'package.json'));
    const rootLock = JSON.parse(readFileSync(join(root, 'package-lock.json')));
    for (const name of ['pg', 'mysql2'])
      assert.equal(
        rootRequire(`${name}/package.json`).version,
        rootLock.packages[`node_modules/${name}`].version,
        `Source driver differs from root lock: ${name}`,
      );
    report.runtime = {
      node: process.version,
      v8: process.versions.v8,
      sourcePg: rootRequire('pg/package.json').version,
      sourceMysql2: rootRequire('mysql2/package.json').version,
    };
    report.source = {
      gitHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
      contentSha256: sourceFingerprint(),
    };
    report.harnessSha256 = harnessFingerprint();
    report.files = Object.fromEntries(
      [
        'native-gate.mjs',
        'native-gate-policy.mjs',
        'native-gate-reporter.mjs',
        'native-gate-fault.mjs',
        config.engine === 'postgresql' ? 'pg-live.test.mjs' : 'mysql-live.test.mjs',
        'pg-native.mjs',
        'mysql-native.mjs',
        'engines.mjs',
        'run.mjs',
        'results.schema.json',
        'pins.json',
        'package-lock.json',
      ].map((name) => [name, hash(join(directory, name))]),
    );
    baseline = await inspect(config);
    report.serverVersion = baseline.version;
    report.injectedFault = config.fault ? 'materialized native drain' : null;
    assertServerVersion(config.engine, config.expectedVersion, baseline.version);
    assert.deepEqual(baseline.scratch, [], 'Refusing a service with existing evidence scratch databases');
    const childEnv = {
      ...env,
      NODE_OPTIONS: '',
      EVIDENCE_PG_ADMIN_URL: '',
      EVIDENCE_MYSQL_ADMIN_URL: '',
      EVIDENCE_MSSQL_ADMIN_URL: '',
      [config.variable]: config.url.href,
      EVIDENCE_REQUIRE_ENGINES: config.engine,
      EVIDENCE_ROUNDS: '1',
      EVIDENCE_WARMUP: '1',
    };
    delete childEnv.NODE_TEST_CONTEXT;
    const loader = join(directory, 'node_modules/tsx/dist/loader.mjs');
    const child = async (phase, argv) => {
      assert.equal(harnessFingerprint(), report.harnessSha256, 'Harness changed between native gate phases');
      report.phase = phase;
      save();
      const stdout = `${output}.${phase}.jsonl`,
        stderr = `${output}.${phase}.stderr`;
      report.artifacts[phase] = { stdout, stderr };
      try {
        await execute(['--import', loader, ...argv], childEnv, stdout, stderr, report.commands);
      } finally {
        report.artifacts[phase].stdoutSha256 = hash(stdout);
        report.artifacts[phase].stderrSha256 = hash(stderr);
      }
      assert.equal(harnessFingerprint(), report.harnessSha256, 'Harness changed during native gate phase');
      return stdout;
    };
    const testLog = await child('tests', [
      '--test',
      `--test-reporter=${join(directory, 'native-gate-reporter.mjs')}`,
      join(directory, config.engine === 'postgresql' ? 'pg-live.test.mjs' : 'mysql-live.test.mjs'),
    ]);
    report.tests = assertTestEvents(
      config.engine,
      readFileSync(testLog, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line)),
    );
    if (config.fault) {
      await child('fault-materialized', [join(directory, 'native-gate-fault.mjs'), config.engine]);
    }
    const evidence = `${output}.evidence.json`;
    await child('effects', [join(directory, 'run.mjs'), evidence]);
    report.artifacts.evidence = { path: evidence, sha256: hash(evidence) };
    const { validateRun } = await import('./validate.mjs');
    const run = JSON.parse(readFileSync(evidence));
    validateRun(run, [config.engine]);
    assertEvidenceProvenance(report, run);
    const result = run.engines.find((item) => item.engine === config.engine);
    assert.equal(result.status, 'complete');
    assertServerVersion(config.engine, config.expectedVersion, result.serverVersion);
    report.provenance = {
      source: run.source,
      harnessSha256: run.harnessSha256,
      runtime: run.runtime,
      installed: run.installed,
      semantics: run.semantics,
    };
    report.effects = {
      correctness: result.correctness,
      nativeRoutes: result.controls.nativeRoutes,
      cleanup: result.cleanup,
      fixtureRows: run.fixtureRows,
      batchSize: run.batchSize,
    };
    assert.equal(result.cleanup, 'complete');
  } catch (error) {
    failure = error;
    // Driver diagnostics may contain endpoints. Keep failure output generic;
    // exact command status and private child logs remain available locally.
    report.failure = {
      phase: report.phase,
      reason: 'Prerequisite, native test, version, route, effect or cleanup verification failed',
    };
  } finally {
    if (baseline) {
      try {
        const final = await inspect(config);
        report.cleanup.scratchDatabasesRemaining = final.scratch;
        assert.deepEqual(final.scratch, baseline.scratch, 'Evidence scratch database cleanup changed the baseline');
        report.cleanup.scratch = 'complete';
        assert.equal(final.version, baseline.version, 'Server identity changed during native gate');
      } catch (error) {
        failure ??= error;
        report.cleanup.scratch = 'failed';
      }
    }
    if (report.files) {
      try {
        assert.equal(harnessFingerprint(), report.harnessSha256, 'Harness changed during native gate');
        assert.equal(sourceFingerprint(), report.source.contentSha256, 'Source changed during native gate');
        for (const [name, sha256] of Object.entries(report.files))
          assert.equal(hash(join(directory, name)), sha256, 'Gate source changed during execution');
      } catch (error) {
        failure ??= error;
      }
    }
    if (failure && !report.failure)
      report.failure = {
        phase: 'final-verification',
        reason: 'Scratch cleanup, server identity or gate file integrity failed',
      };
    report.status = failure ? 'invalid' : 'complete';
    report.phase = failure ? report.phase : 'complete';
    save();
  }
  if (failure) throw new Error(`Native evidence gate invalid during ${report.phase}; inspect ${output}`);
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  nativeGate(process.argv.slice(2))
    .then((report) => console.log(`Native ${report.engine} gate complete: ${resolve(process.argv[4])}`))
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
