/** Nightly candidate smoke runner. Requires Docker only for `run`, never for unit tests. */
import { execFileSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import {
  IMAGE,
  TEST_FILE,
  newEvidence,
  parseTestOutcome,
  redact,
  validateEvidence,
  waitForYsql,
} from './engine-certification.mjs';

const directory = resolve('artifacts/yugabytedb');
const evidencePath = resolve(directory, 'evidence.json');
const tapPath = resolve(directory, 'tests.tap');
const container = 'turbine-yugabyte-candidate';
const require = createRequire(import.meta.url);

function initial() {
  let head = 'unknown';
  try {
    head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    /* Leave unobserved. */
  }
  return newEvidence(head);
}
function save(record) {
  mkdirSync(directory, { recursive: true });
  writeFileSync(evidencePath, `${JSON.stringify(record, null, 2)}\n`);
}
function docker(args, log, timeout = 30_000) {
  const result = spawnSync('docker', args, { encoding: 'utf8', timeout, maxBuffer: 16 * 1024 * 1024 });
  const output = redact(`${result.stdout ?? ''}${result.stderr ?? ''}`);
  writeFileSync(resolve(directory, log), output);
  if (result.error || result.status !== 0) throw new Error('docker-command-failed');
  return output.trim();
}

async function run() {
  const record = initial();
  save(record);
  let tap = '';
  let stage = 'launch';
  try {
    // Preserve the image entrypoint; pass the foreground command after the image.
    docker(
      [
        'run',
        '--detach',
        '--name',
        container,
        '--hostname',
        'yugabyte',
        '--publish',
        '127.0.0.1:5433:5433',
        IMAGE,
        'bin/yugabyted',
        'start',
        '--background=false',
      ],
      'launch.log',
      180_000,
    );
    record.image.id = docker(['inspect', '--format', '{{.Image}}', container], 'image.log');
    stage = 'readiness';
    const { default: pg } = await import('pg');
    record.driver = { name: 'pg', version: require('pg/package.json').version };
    if (!process.env.DATABASE_URL) throw new Error('missing-database-url');
    const readiness = await waitForYsql(async () => {
      const client = new pg.Client({
        connectionString: process.env.DATABASE_URL,
        connectionTimeoutMillis: 5000,
        query_timeout: 5000,
      });
      client.on('error', () => {});
      try {
        await client.connect();
        // Observe the actual network binding rather than inferring it from a dialect.
        const stream = client.connection.stream;
        if (!stream.remoteAddress || !stream.remotePort) throw new Error('unobserved-tcp-transport');
        const result = await client.query('SELECT version() AS version, 1 AS ok');
        if (result.rows.length !== 1 || result.rows[0].ok !== 1) throw new Error('invalid-readiness-result');
        return result.rows[0].version;
      } finally {
        await client.end();
      }
    });
    record.readiness = { outcome: readiness.outcome, attempts: readiness.attempts };
    if (readiness.outcome !== 'ready') {
      record.outcome = 'readiness-failed';
      record.failureCode = 'readiness-exhausted';
      return;
    }
    record.engine = { name: 'yugabytedb', version: readiness.version };
    record.transport = 'tcp';
    save(record);
    stage = 'tests';
    const child = spawnSync(process.execPath, ['--import', 'tsx', '--test', '--test-reporter=tap', TEST_FILE], {
      encoding: 'utf8',
      timeout: 120_000,
      maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, TURBINE_TEST_ENGINE: 'yugabytedb', TURBINE_REQUIRE_ENGINE: 'postgres' },
    });
    tap = redact(`${child.stdout ?? ''}${child.stderr ?? ''}`);
    writeFileSync(tapPath, tap);
    record.tests = { file: TEST_FILE, ...parseTestOutcome(tap, child.status) };
    record.outcome = record.tests.outcome;
    if (child.error || child.signal) record.outcome = 'failed';
    try {
      validateEvidence(record, tap);
    } catch {
      record.outcome = 'incomplete';
      record.tests.outcome = 'incomplete';
      record.failureCode = 'invalid-observation';
    }
  } catch {
    record.outcome = stage === 'tests' ? 'failed' : 'readiness-failed';
    record.failureCode = `${stage}-failed`;
    if (stage !== 'tests') record.readiness.outcome = 'failed';
  } finally {
    // Preserve evidence before collecting logs, including on launch/probe/test failure.
    save(record);
    try {
      docker(['logs', '--timestamps', container], 'container.log');
    } catch {
      /* launch may not have created a container */
    }
    try {
      docker(['rm', '--force', container], 'cleanup.log');
    } catch {
      /* logs remain even if cleanup fails */
    }
  }
}

function finalize() {
  let record;
  try {
    record = existsSync(evidencePath)
      ? JSON.parse(readFileSync(evidencePath, 'utf8'))
      : { ...initial(), outcome: 'missing' };
    validateEvidence(record, existsSync(tapPath) ? readFileSync(tapPath, 'utf8') : '');
  } catch {
    record = { ...initial(), outcome: 'incomplete', failureCode: 'invalid-evidence' };
  }
  save(record);
  console.log(`YugabyteDB candidate: ${record.outcome}; certified=false; scope=${record.scope}`);
  return record.outcome === 'passed' ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const command = process.argv[2];
  if (command === 'init') save(initial());
  else if (command === 'run') {
    await run();
    process.exitCode = finalize();
  } else if (command === 'finalize') process.exitCode = finalize();
  else {
    console.error('Usage: node scripts/yugabyte-readiness.mjs init|run|finalize');
    process.exitCode = 1;
  }
}
