/** Synthetic observations exercise guards; they are not evidence of a live engine. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const { newEvidence, parseTestOutcome, validateEvidence, waitForYsql, redact } = await import(
  new URL('../../scripts/engine-certification.mjs', import.meta.url).href
);
const script = fileURLToPath(new URL('../../scripts/yugabyte-readiness.mjs', import.meta.url));
const tap = `TAP version 13
# Subtest: statement-timeout SQL executes on a real engine (yugabytedb)
    # Subtest: the yugabytedb adapter timeout SQL runs in a transaction without a syntax error
    ok 1 - the yugabytedb adapter timeout SQL runs in a transaction without a syntax error
    # Subtest: every adapter uses set_config(), never the unparameterizable \`SET LOCAL ... = $1\` form
    ok 2 - every adapter uses set_config(), never the unparameterizable \`SET LOCAL ... = $1\` form
    1..2
ok 1 - statement-timeout SQL executes on a real engine (yugabytedb)
1..1
# tests 2
# suites 1
# pass 2
# fail 0
# cancelled 0
# skipped 0
# todo 0
`;

function observedSmoke() {
  const record = newEvidence('a'.repeat(40));
  record.image.id = `sha256:${'b'.repeat(64)}`;
  record.engine = { name: 'yugabytedb', version: '2026.1.2.0-b0' };
  record.driver = { name: 'pg', version: '8.16.3' };
  record.transport = 'tcp';
  record.readiness = { outcome: 'ready', attempts: 3 };
  record.tests = { ...record.tests, ...parseTestOutcome(tap, 0) };
  record.outcome = 'passed';
  return record;
}

describe('engine certification evidence rejects unearned success', () => {
  it('accepts complete narrow smoke evidence while keeping it candidate and uncertified', () => {
    const record = observedSmoke();
    assert.equal(validateEvidence(record, tap), record);
    assert.equal(record.supportStatus, 'candidate');
    assert.equal(record.certified, false);
  });

  it('preserves every unsuccessful outcome without certifying it', () => {
    for (const outcome of ['failed', 'readiness-failed', 'skipped', 'missing', 'incomplete', 'unsupported']) {
      const record = { ...newEvidence(), outcome };
      assert.equal(validateEvidence(record).outcome, outcome);
      assert.equal(record.certified, false);
      assert.throws(() => validateEvidence({ ...record, certified: true }), /never certify/);
    }
  });

  it('rejects corrupted or missing provenance, readiness and test observations', () => {
    const corruptions = [
      (r: ReturnType<typeof observedSmoke>) => {
        r.schemaVersion = 2;
      },
      (r: ReturnType<typeof observedSmoke>) => {
        r.scope = 'full-engine';
      },
      (r: ReturnType<typeof observedSmoke>) => {
        r.certified = true;
      },
      (r: ReturnType<typeof observedSmoke>) => {
        r.supportStatus = 'certified';
      },
      (r: ReturnType<typeof observedSmoke>) => {
        r.head = 'unknown';
      },
      (r: ReturnType<typeof observedSmoke>) => {
        r.image.id = 'unknown';
      },
      (r: ReturnType<typeof observedSmoke>) => {
        r.engine.name = 'unknown';
      },
      (r: ReturnType<typeof observedSmoke>) => {
        r.engine.version = 'unknown';
      },
      (r: ReturnType<typeof observedSmoke>) => {
        r.driver.version = 'unknown';
      },
      (r: ReturnType<typeof observedSmoke>) => {
        r.transport = 'unknown';
      },
      (r: ReturnType<typeof observedSmoke>) => {
        r.runtime.version = 'unknown';
      },
      (r: ReturnType<typeof observedSmoke>) => {
        r.readiness.outcome = 'failed';
      },
      (r: ReturnType<typeof observedSmoke>) => {
        r.readiness.attempts = 0;
      },
      (r: ReturnType<typeof observedSmoke>) => {
        r.tests.outcome = 'skipped';
      },
      (r: ReturnType<typeof observedSmoke>) => {
        r.tests.exitCode = 1;
      },
      (r: ReturnType<typeof observedSmoke>) => {
        r.tests.counts.pass = 0;
      },
      (r: ReturnType<typeof observedSmoke>) => {
        r.tests.logSha256 = '0'.repeat(64);
      },
    ];
    assert.ok(corruptions.length > 10);
    for (const corrupt of corruptions) {
      const record = observedSmoke();
      corrupt(record);
      assert.throws(() => validateEvidence(record, tap), String(corrupt));
    }
    assert.throws(() => validateEvidence(observedSmoke(), ''), /test log/);
    assert.throws(() => validateEvidence(observedSmoke(), tap.replace('# pass 2', '# pass 0')), /test log/);
    assert.throws(() => validateEvidence({}), /schema/);
  });

  it('rejects vacuous, skipped, cancelled, malformed and wrong-scope reporter results', () => {
    assert.equal(parseTestOutcome(tap, 0).outcome, 'passed');
    assert.equal(parseTestOutcome(tap, 1).outcome, 'failed');
    assert.equal(parseTestOutcome(tap, null).outcome, 'failed');
    assert.equal(parseTestOutcome(tap.replace('# skipped 0', '# skipped 1'), 0).outcome, 'skipped');
    assert.equal(parseTestOutcome(tap.replace('# cancelled 0', '# cancelled 1'), 0).outcome, 'failed');
    assert.equal(parseTestOutcome(tap.replace('# todo 0', '# todo 1'), 0).outcome, 'skipped');
    assert.equal(parseTestOutcome(tap.replace('# tests 2', '# tests 0'), 0).outcome, 'incomplete');
    assert.equal(parseTestOutcome(tap.replace('# pass 2', ''), 0).outcome, 'incomplete');
    assert.equal(parseTestOutcome(`${tap}# tests 2\n`, 0).outcome, 'incomplete');
    assert.equal(
      parseTestOutcome(tap.replaceAll('the yugabytedb adapter', 'the postgres adapter'), 0).outcome,
      'incomplete',
    );
    assert.equal(parseTestOutcome('', 0).outcome, 'incomplete');
    assert.equal(parseTestOutcome(`${tap}not ok 2 - corrupted observation\n`, 0).outcome, 'incomplete');
  });

  it('accepts the current Node TAP reporter format from synthetic test execution', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'engine-tap-'));
    try {
      const fixture = join(cwd, 'synthetic-smoke.cjs');
      const names = [
        'the yugabytedb adapter timeout SQL runs in a transaction without a syntax error',
        'every adapter uses set_config(), never the unparameterizable `SET LOCAL ... = $1` form',
      ];
      writeFileSync(
        fixture,
        `const { describe, it } = require('node:test');
        describe('synthetic reporter fixture', () => {
          for (const name of ${JSON.stringify(names)}) it(name, () => {});
        });`,
      );
      const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', fixture], {
        encoding: 'utf8',
        env: { ...process.env, NODE_TEST_CONTEXT: undefined },
      });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(parseTestOutcome(result.stdout, result.status).outcome, 'passed', result.stdout);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('redacts URLs including credentials and query strings', () => {
    const text = 'error postgres://user:secret@db.example/test?token=secret https://user:secret@example.test/';
    const safe = redact(text);
    assert.equal(safe, 'error [redacted-url] [redacted-url]');
    assert.doesNotMatch(safe, /secret|db\.example/);
  });
});

describe('bounded YSQL readiness', () => {
  it('retries transient errors then records the actual version and attempt', async () => {
    let calls = 0;
    const pauses: number[] = [];
    const result = await waitForYsql(
      async () => {
        if (++calls < 3) throw new Error('connection refused');
        return 'PostgreSQL 15.12-YB-2026.1.2.0-b0 on x86_64, compiled by clang (https://example.test)';
      },
      {
        attempts: 4,
        delayMs: 7,
        pause: async (ms: number) => {
          pauses.push(ms);
        },
      },
    );
    assert.deepEqual(result, { outcome: 'ready', attempts: 3, version: '2026.1.2.0-b0' });
    assert.deepEqual(pauses, [7, 7]);
  });

  it('exhausts with an explicit failure, including a healthy wrong engine', async () => {
    for (const version of [null, 'PostgreSQL 17.0', '', 'YugabyteDB unknown']) {
      let calls = 0;
      const result = await waitForYsql(
        async () => {
          calls++;
          return version;
        },
        {
          attempts: 3,
          pause: async () => {},
        },
      );
      assert.equal(calls, 3);
      assert.deepEqual(result, { outcome: 'failed', attempts: 3, version: 'unknown' });
    }
    await assert.rejects(() => waitForYsql(async () => '', { attempts: 0 }), /positive/);
  });
});

describe('evidence CLI fails closed without Docker or a database', () => {
  it('retains sanitized launch failure artifacts when the Docker command fails', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'engine-launch-'));
    try {
      // A failing executable fixture, not a Docker daemon or a live engine.
      writeFileSync(
        join(cwd, 'docker'),
        `#!${process.execPath}
        console.error('cannot launch postgres://fixture:secret@example.invalid/db?token=secret');
        process.exitCode = 1;`,
        { mode: 0o755 },
      );
      const result = spawnSync(process.execPath, [script, 'run'], {
        cwd,
        encoding: 'utf8',
        env: { ...process.env, PATH: `${cwd}${delimiter}${process.env.PATH}` },
      });
      assert.equal(result.status, 1, result.stderr);
      const evidence = JSON.parse(readFileSync(join(cwd, 'artifacts/yugabytedb/evidence.json'), 'utf8'));
      assert.equal(evidence.outcome, 'readiness-failed');
      assert.equal(evidence.failureCode, 'launch-failed');
      assert.equal(evidence.tests.outcome, 'not-run');
      assert.equal(evidence.engine.version, 'unknown');
      assert.equal(evidence.certified, false);
      const log = readFileSync(join(cwd, 'artifacts/yugabytedb/launch.log'), 'utf8');
      assert.match(log, /cannot launch \[redacted-url\]/);
      assert.doesNotMatch(log, /secret|example\.invalid/);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('fails the real smoke availability guard when DATABASE_URL is missing', () => {
    const result = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        '--test',
        '--test-reporter=tap',
        fileURLToPath(new URL('./studio-timeout-integration.test.ts', import.meta.url)),
      ],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          DATABASE_URL: '',
          TURBINE_REQUIRE_ENGINE: 'postgres',
          TURBINE_TEST_ENGINE: 'yugabytedb',
          NODE_TEST_CONTEXT: undefined,
        },
      },
    );
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}${result.stderr}`, /TURBINE_REQUIRE_ENGINE=postgres/);
    assert.notEqual(parseTestOutcome(result.stdout, result.status).outcome, 'passed');
  });

  it('accepts matching synthetic smoke artifacts while explicitly retaining uncertified status', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'engine-positive-'));
    try {
      assert.equal(spawnSync(process.execPath, [script, 'init'], { cwd }).status, 0);
      writeFileSync(join(cwd, 'artifacts/yugabytedb/evidence.json'), JSON.stringify(observedSmoke()));
      writeFileSync(join(cwd, 'artifacts/yugabytedb/tests.tap'), tap);
      const result = spawnSync(process.execPath, [script, 'finalize'], { cwd, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /candidate: passed; certified=false/);
      const evidence = JSON.parse(readFileSync(join(cwd, 'artifacts/yugabytedb/evidence.json'), 'utf8'));
      assert.equal(evidence.supportStatus, 'candidate');
      assert.equal(evidence.certified, false);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  for (const control of ['missing', 'malformed', 'forged-pass']) {
    it(`persists an uncertified failure for ${control} observations`, () => {
      const cwd = mkdtempSync(join(tmpdir(), 'engine-evidence-'));
      try {
        const invoke = (command: string) => spawnSync(process.execPath, [script, command], { cwd, encoding: 'utf8' });
        if (control !== 'missing') {
          assert.equal(invoke('init').status, 0);
          writeFileSync(
            join(cwd, 'artifacts/yugabytedb/evidence.json'),
            control === 'malformed' ? '{' : JSON.stringify(observedSmoke()),
          );
        }
        const result = invoke('finalize');
        assert.equal(result.status, 1, result.stderr);
        assert.match(result.stdout, /certified=false/);
        const evidence = JSON.parse(readFileSync(join(cwd, 'artifacts/yugabytedb/evidence.json'), 'utf8'));
        assert.equal(evidence.outcome, control === 'missing' ? 'missing' : 'incomplete');
        assert.equal(evidence.certified, false);
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    });
  }
});
