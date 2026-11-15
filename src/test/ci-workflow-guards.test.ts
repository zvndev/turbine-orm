/**
 * turbine-orm, the workflow properties that make a red job block a merge or a release
 *
 * `ci-ok-needs-sync.test.ts` asks whether every job is aggregated. This file
 * asks whether the aggregation can still be defeated by a one-line edit that
 * leaves the job list intact:
 *   1. An aggregator without `if: always()` is SKIPPED when a dependency fails,
 *      and a skipped required check reads as passing on a pull request.
 *   2. An aggregator whose filter is anything but `result != "success"` lets a
 *      skipped or cancelled job through.
 *   3. A job-level `continue-on-error` turns that job's failure into success
 *      before any aggregator sees it.
 *   4. `publish` with an `if:` of its own can run, or be skipped, independently
 *      of the gates it needs.
 *   5. A test step that points at a database but sets no
 *      `TURBINE_REQUIRE_ENGINE` passes when the URL is wrong, because every
 *      database test skips and a skipped suite exits 0.
 *   6. benchmarks.yml measures, it does not gate. A `pull_request` or `push`
 *      trigger would spend a 90-minute round on every change, and listing it
 *      in gates.yml would make a noisy timing a required check.
 *   7. This is a public repository, so every job runs on GitHub's free
 *      standard hosted runners. A self-hosted label (ZVN's grandprix pool) or
 *      a Depot one would hand any fork's code a machine ZVN pays for.
 *
 * A line parser, like its sibling, and every extraction asserts it found
 * something, so a layout change fails here instead of passing over nothing.
 *
 * Run: npx tsx --test src/test/ci-workflow-guards.test.ts
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { ENGINE_GATE_PATTERNS } from './helpers.js';

function workflow(file: string): string[] {
  return readFileSync(new URL(`../../.github/workflows/${file}`, import.meta.url), 'utf8').split('\n');
}

/** Each top-level job under `jobs:` with its lines, in file order. */
function jobsOf(lines: string[]): Map<string, string[]> {
  const jobsAt = lines.indexOf('jobs:');
  assert.notEqual(jobsAt, -1, 'the workflow has no top-level `jobs:` line');
  const jobs = new Map<string, string[]>();
  let current: string[] | undefined;
  for (const line of lines.slice(jobsAt + 1)) {
    const key = /^ {2}([A-Za-z0-9_-]+):\s*(#.*)?$/.exec(line)?.[1];
    if (key) {
      current = [];
      jobs.set(key, current);
    } else if (current) {
      current.push(line);
    }
  }
  assert.ok(jobs.size > 0, 'parsed no jobs');
  return jobs;
}

/** The steps of one job: each `      - ` item with its continuation lines. */
function stepsOf(job: string[]): string[][] {
  const steps: string[][] = [];
  let inSteps = false;
  for (const line of job) {
    if (/^ {4}steps:\s*$/.test(line)) {
      inSteps = true;
      continue;
    }
    if (!inSteps) continue;
    if (/^ {4}\S/.test(line)) break;
    if (/^ {6}- /.test(line)) steps.push([line]);
    else if (steps.length > 0 && !/^ {6}#/.test(line)) steps[steps.length - 1]?.push(line);
  }
  return steps;
}

it('requires coverage map identity checks before the existing coverage collection', () => {
  const job = jobsOf(workflow('gates.yml')).get('coverage');
  assert.ok(job);
  const command = 'run: node --test tooling/coverage-regressions/merge.test.mjs';
  const validate = (steps: string[][]) => {
    const check = steps.findIndex((step) => step.some((line) => line.trim() === command));
    const collect = steps.findIndex((step) => step.includes('      - run: npm run test:coverage'));
    assert.ok(check >= 0 && collect > check, 'coverage map checks must precede collection');
    assert.doesNotMatch(steps[check]!.join('\n'), /^\s*(?:if:|continue-on-error:)/m);
  };
  const steps = stepsOf(job);
  const index = steps.findIndex((step) => step.some((line) => line.trim() === command));
  validate(steps);
  assert.throws(() => validate(steps.filter((_, at) => at !== index)));
  for (const directive of ['if: false', 'continue-on-error: true'])
    assert.throws(() => validate(steps.map((step, at) => (at === index ? [...step, `        ${directive}`] : step))));
  assert.throws(() => validate([...steps.filter((_, at) => at !== index), steps[index]!]));
});

const AGGREGATORS = [
  { file: 'ci.yml', job: 'ci-ok' },
  { file: 'gates.yml', job: 'gates-ok' },
] as const;

function assertSqliteSourceSetup(steps: string[][]): void {
  const commandAt = (command: string) =>
    steps.findIndex((step) => step.some((line) => line.trim().replace(/^-\s*/, '') === `run: ${command}`));
  const install = commandAt('npm ci');
  const generate = commandAt('npm run gen:studio');
  const tests = steps.findIndex((step) =>
    step.some((line) => line.includes('run: npx tsx --test') && line.includes('sqlite-cli-project-command.test.ts')),
  );
  assert.ok(install >= 0 && tests >= 0, 'SQLite source gate must install dependencies and run CLI tests');
  assert.ok(
    install < generate && generate < tests,
    'SQLite source gate must run gen:studio after npm ci and before CLI tests in a fresh checkout',
  );
  assert.ok(
    !steps[generate]!.some((line) => /^\s*(?:if:|continue-on-error:)/.test(line)),
    'SQLite source generation must be unconditional and must propagate failure',
  );
}

it('requires native SQLite migration writers in their supported-runtime gate', () => {
  const job = jobsOf(workflow('gates.yml')).get('sqlite-migrations');
  assert.ok(job, 'native SQLite migration job must exist');
  const source = job.join('\n');
  assert.match(source, /node-version: \['24\.10\.0', '24'\]/);
  assert.match(source, /TURBINE_REQUIRE_ENGINE: sqlite,sqlite-migrations/);
  assert.match(source, /sqlite-table-modes\.test\.ts/);
  assert.match(source, /sqlite-doctor\.test\.ts/);
  assert.match(source, /sqlite-doctor-dispatch\.test\.ts/);
  assert.match(source, /tsx --test .*sqlite-migrations\.test\.ts .*sqlite-cli-project-command\.test\.ts/);
  assertSqliteSourceSetup(stepsOf(job));
  const reason = 'SQLite migration writer requires setAuthorizer/isTransaction (Node >= 24.10)';
  assert.equal(ENGINE_GATE_PATTERNS['sqlite-migrations']?.test(reason), true);
  assert.equal(ENGINE_GATE_PATTERNS.sqlite?.test(reason), false, 'ordinary SQLite on Node 22 has its own gate');
});

it('rejects omitted, late or conditional SQLite source generation', () => {
  const job = jobsOf(workflow('gates.yml')).get('sqlite-migrations');
  assert.ok(job);
  const steps = stepsOf(job);
  assertSqliteSourceSetup(steps);
  const generation = steps.find((step) => step.some((line) => line.trim() === 'run: npm run gen:studio'));
  assert.ok(generation, 'negative controls need the real generation step');
  const omitted = steps.filter((step) => step !== generation);
  assert.throws(() => assertSqliteSourceSetup(omitted), /gen:studio.*before CLI tests/);
  assert.throws(() => assertSqliteSourceSetup([...omitted, generation]), /gen:studio.*before CLI tests/);
  for (const bypass of ['        if: false', '        continue-on-error: true']) {
    const conditional = steps.map((step) => (step === generation ? [...step, bypass] : step));
    assert.throws(() => assertSqliteSourceSetup(conditional), /unconditional.*propagate failure/);
  }
});

function assertOptionalSqliteBinding(steps: string[][]): void {
  const step = steps.find((lines) => lines.some((line) => line.includes('Require the optional native SQLite binding')));
  assert.ok(step, 'optional SQLite binding must have a required native step');
  assert.ok(
    !step.some((line) => /^\s*(?:if:|continue-on-error:)/.test(line)),
    'native binding admission must be unconditional',
  );
  const source = step.join('\n');
  for (const required of [
    'better-sqlite3@12.11.1',
    'TURBINE_REQUIRE_SQLITE_BINDING=1',
    'TURBINE_SQLITE_BINDING_PEER=',
    'src/test/sqlite-binding.test.ts',
    'src/test/sqlite-binding-node-values.test.ts',
    'src/test/generate-better-sqlite3.test.ts',
    'src/test/sqlite-result-metadata.test.ts',
    'src/test/sqlite-driver-capabilities.test.ts',
    'src/test/sqlite-materialization-boundaries.test.ts',
    'src/test/sqlite-bulk-positional.test.ts',
    'needs.pack.outputs.tarball',
    'node verify.mjs esm',
    'node verify.mjs cjs',
    'node verify.mjs missing-esm',
    'node verify.mjs missing-cjs',
  ])
    assert.ok(source.includes(required), `native binding admission requires ${required}`);
}

it('refuses omitted or disabled optional SQLite native and installed checks', () => {
  const job = jobsOf(workflow('gates.yml')).get('sqlite-migrations');
  assert.ok(job);
  const steps = stepsOf(job);
  assertOptionalSqliteBinding(steps);
  const step = steps.find((lines) =>
    lines.some((line) => line.includes('Require the optional native SQLite binding')),
  )!;
  assert.throws(() => assertOptionalSqliteBinding(steps.filter((lines) => lines !== step)), /required native step/);
  for (const missing of [
    'TURBINE_REQUIRE_SQLITE_BINDING=1',
    'src/test/sqlite-result-metadata.test.ts',
    'src/test/sqlite-driver-capabilities.test.ts',
    'src/test/sqlite-materialization-boundaries.test.ts',
    'src/test/sqlite-bulk-positional.test.ts',
    'node verify.mjs cjs',
    'node verify.mjs missing-esm',
  ]) {
    assert.throws(
      () => assertOptionalSqliteBinding(steps.map((lines) => lines.map((line) => line.replace(missing, '')))),
      /requires/,
    );
  }
  for (const bypass of ['        if: false', '        continue-on-error: true']) {
    assert.throws(
      () => assertOptionalSqliteBinding(steps.map((lines) => (lines === step ? [...lines, bypass] : lines))),
      /unconditional/,
    );
  }
  const unit = jobsOf(workflow('gates.yml')).get('unit-tests');
  assert.ok(unit);
  const checkFloor = (steps: string[][]) => {
    const step = steps.find((lines) => lines.some((line) => line.includes('SQLite prototype-column preservation')));
    assert.ok(step, 'Node 20 native binding step is required');
    assert.equal(
      step
        .filter((line) => /^\s*if:/.test(line))
        .join('\n')
        .trim(),
      'if: matrix.node-version == 20',
    );
    assert.ok(!step.some((line) => /continue-on-error:/.test(line)), 'native binding failures must propagate');
    const source = step.join('\n');
    for (const required of [
      'better-sqlite3@12.11.1',
      'TURBINE_REQUIRE_SQLITE_BINDING=1',
      'src/test/sqlite-binding.test.ts',
    ])
      assert.ok(source.includes(required), `Node 20 binding requires ${required}`);
  };
  const unitSteps = stepsOf(unit);
  checkFloor(unitSteps);
  for (const omitted of ['TURBINE_REQUIRE_SQLITE_BINDING=1', 'if: matrix.node-version == 20'])
    assert.throws(() => checkFloor(unitSteps.map((step) => step.map((line) => line.replace(omitted, '')))));
});

function assertConsumerCostTests(steps: string[][]): void {
  const install = steps.findIndex((step) => step.includes('      - run: npm ci'));
  const tests = steps.findIndex((step) =>
    step.some(
      (line) =>
        line.trim() ===
        'run: node --test tooling/consumer-cost/measure-consumer-cost.test.mjs tooling/consumer-cost/comparison.test.mjs tooling/consumer-cost/runtime-role-closure.test.mjs',
    ),
  );
  assert.ok(install >= 0 && tests > install, 'consumer-cost behavioral tests must run after npm ci');
  assert.ok(
    !steps[tests]!.some((line) => /^\s*(?:if:|continue-on-error:)/.test(line)),
    'consumer-cost behavioral tests must be unconditional and propagate failure',
  );
}

it('gates consumer-cost behavioral controls in the existing unit Node matrix', () => {
  const job = jobsOf(workflow('gates.yml')).get('unit-tests');
  assert.ok(job);
  const steps = stepsOf(job);
  assertConsumerCostTests(steps);
  const tests = steps.find((step) => step.some((line) => line.includes('measure-consumer-cost.test.mjs')))!;
  assert.throws(() => assertConsumerCostTests(steps.filter((step) => step !== tests)), /must run after npm ci/);
  for (const file of ['comparison.test.mjs', 'runtime-role-closure.test.mjs']) {
    assert.throws(
      () =>
        assertConsumerCostTests(
          steps.map((step) => step.map((line) => line.replace(` tooling/consumer-cost/${file}`, ''))),
        ),
      /must run after npm ci/,
    );
  }
  for (const bypass of ['        if: false', '        continue-on-error: true']) {
    assert.throws(
      () => assertConsumerCostTests(steps.map((step) => (step === tests ? [...step, bypass] : step))),
      /unconditional and propagate failure/,
    );
  }
});

function assertEvidenceControls(steps: string[][]): void {
  const commandAt = (command: string) =>
    steps.findIndex((step) => step.some((line) => line.trim() === `run: ${command}`));
  const install = commandAt('npm ci --prefix benchmarks/evidence --ignore-scripts');
  const tests = commandAt('npm test --prefix benchmarks/evidence');
  assert.ok(install >= 0 && tests > install, 'evidence controls must run after their locked dependency install');
  for (const step of [steps[install]!, steps[tests]!]) {
    assert.ok(
      step.includes('        if: matrix.node-version == 24'),
      'evidence controls require the supported Node 24 unit lane',
    );
    assert.ok(!step.some((line) => line.includes('continue-on-error:')), 'evidence control failures must propagate');
  }
}

it('runs exact-result evidence controls in the existing supported unit lane', () => {
  const job = jobsOf(workflow('gates.yml')).get('unit-tests');
  assert.ok(job);
  const steps = stepsOf(job);
  assertEvidenceControls(steps);
  const control = steps.find((step) =>
    step.some((line) => line.includes('run: npm test --prefix benchmarks/evidence')),
  )!;
  assert.throws(() => assertEvidenceControls(steps.filter((step) => step !== control)), /must run after/);
  assert.throws(
    () =>
      assertEvidenceControls(
        steps.map((step) => step.map((line) => line.replace('matrix.node-version == 24', 'matrix.node-version == 20'))),
      ),
    /supported Node 24/,
  );
  assert.throws(
    () =>
      assertEvidenceControls(
        steps.map((step) => (step === control ? [...step, '        continue-on-error: true'] : step)),
      ),
    /failures must propagate/,
  );
});

it('gates artifact upgrades, native consumer contracts and preparation controls on supported unit runtimes', () => {
  const steps = stepsOf(jobsOf(workflow('gates.yml')).get('unit-tests')!);
  const assertControl = (candidate: string[][], command: string, condition?: string) => {
    const install = candidate.findIndex((step) => step.includes('      - run: npm ci'));
    const index = candidate.findIndex((step) => step.some((line) => line.trim() === `run: ${command}`));
    assert.ok(index > install && install >= 0, 'control must run after npm ci');
    const step = candidate[index]!;
    assert.deepEqual(
      step.filter((line) => /^\s*if:/.test(line)).map((line) => line.trim()),
      condition ? [`if: ${condition}`] : [],
      'supported runtime guard',
    );
    assert.ok(!step.some((line) => /continue-on-error:/.test(line)), 'control failure must propagate');
  };
  for (const [command, condition] of [
    ['node --test tooling/sqlite-fixture-lifetimes/harness.test.mjs', undefined],
    [
      'node tooling/sqlite-fixture-lifetimes/run.mjs --out "$RUNNER_TEMP/sqlite-fixture-lifetimes"',
      'matrix.node-version != 20',
    ],
    [
      'node --test tooling/lifecycle-examples/harness.test.mjs tooling/lifecycle-upgrades/harness.test.mjs tooling/native-consumer-contracts/harness.test.mjs tooling/native-integer-types/harness.test.mjs',
      undefined,
    ],
    ['node --import tsx --test benchmarks/postgres-pagination/validator.test.mjs', undefined],
    ['node --test benchmarks/postgres-keyset/guards.test.mjs', undefined],
    ['node --test benchmarks/mysql-preparation/harness.test.mjs', undefined],
    ['node --test benchmarks/mysql-streaming/harness.test.mjs', undefined],
    ['node --test benchmarks/postgres-streaming/harness.test.mjs', undefined],
    ['node benchmarks/postgres-streaming/omissions.mjs', undefined],
    ['node --test benchmarks/sqlite-relations/harness.test.mjs benchmarks/mysql-relations/guards.test.mjs', undefined],
    ['node benchmarks/sqlite-relations/omissions.mjs', undefined],
    ['node benchmarks/mysql-relations/controls.mjs "$RUNNER_TEMP/mysql-relations-omissions.json" guards', undefined],
    [
      'node --test benchmarks/sqlite-contention/harness.test.mjs benchmarks/sqlite-query-cost/harness.test.mjs',
      undefined,
    ],
    ['node --import tsx --test benchmarks/sqlite-preparation/workload.test.mjs', 'matrix.node-version != 20'],
    ['node --test benchmarks/evidence/native-gate.test.mjs', 'matrix.node-version == 24'],
  ] as const) {
    assertControl(steps, command, condition);
    const step = steps.find((entry) => entry.some((line) => line.trim() === `run: ${command}`))!;
    assert.throws(
      () =>
        assertControl(
          steps.filter((entry) => entry !== step),
          command,
          condition,
        ),
      /after npm ci/,
    );
    assert.throws(
      () =>
        assertControl(
          steps.map((entry) => (entry === step ? [...entry, '        continue-on-error: true'] : entry)),
          command,
          condition,
        ),
      /failure must propagate/,
    );
    assert.throws(
      () =>
        assertControl(
          steps.map((entry) => (entry === step ? [...entry, '        if: false'] : entry)),
          command,
          condition,
        ),
      /runtime guard/,
    );
  }
});

it('keeps SQLite schema apply and recovery suites in native CI and CLI coverage collection', () => {
  const native = jobsOf(workflow('gates.yml')).get('sqlite-migrations')!.join('\n');
  const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  for (const suite of [
    'sqlite-schema.test.ts',
    'sqlite-schema-command.test.ts',
    'sqlite-seed.test.ts',
    'sqlite-seed-cli.test.ts',
  ]) {
    assert.ok(native.includes(`src/test/${suite}`), `SQLite native gate must include ${suite}`);
    assert.ok(pkg.scripts['coverage:cli:collect'].includes(`src/test/${suite}`), `CLI coverage must collect ${suite}`);
  }
});

it('requires pinned optional transport consumers and explicit native admission in existing jobs', () => {
  const jobs = jobsOf(workflow('gates.yml'));
  for (const jobName of ['pack-smoke', 'integration-tests']) {
    const job = jobs.get(jobName);
    assert.ok(job);
    assert.ok(job.includes('    needs: pack'), `${jobName} must use the shared pack artifact`);
    const verify = (steps: string[][]) => {
      const step = steps.find((candidate) =>
        candidate.some((line) => line.includes('node scripts/check-optional-pg-transports.mjs')),
      );
      assert.ok(step, 'optional consumer step required');
      const command = step.join('\n');
      assert.match(command, /--sha256 "\$\{\{ needs\.pack\.outputs\.sha256 \}\}"/);
      assert.doesNotMatch(command, /^\s*(?:if:|continue-on-error:)/m);
      if (jobName === 'integration-tests') {
        assert.match(command, /--native/);
        assert.match(command, /TURBINE_OPTIONAL_PG_SERVICE_URL:/);
        assert.match(command, /TURBINE_OPTIONAL_PG_DISPOSABLE: '1'/);
      }
    };
    const steps = stepsOf(job);
    verify(steps);
    assert.throws(() => verify(steps.filter((step) => !step.join('\n').includes('check-optional-pg-transports'))));
    assert.throws(() => verify(steps.map((step) => step.filter((line) => !line.includes('--sha256')))));
  }
  for (const { jobName, command, required } of [
    {
      jobName: 'integration-tests',
      command: 'node tooling/optional-pg-transports/source-suite-gate.mjs',
      required: [
        /TURBINE_REQUIRE_NEON_WS: '1'/,
        /TURBINE_NEON_WS_PG_DISPOSABLE: '1'/,
        /TURBINE_NEON_WS_PG_SERVICE_URL:/,
        /TURBINE_NEON_WS_GATE_REPORT:/,
      ],
    },
    { jobName: 'unit-tests', command: 'node --test tooling/optional-pg-transports/harness.test.mjs', required: [] },
  ]) {
    const validate = (steps: string[][]) => {
      const step = steps.find((candidate) => candidate.some((line) => line.trim() === `run: ${command}`));
      assert.ok(step, 'required optional transport admission step missing');
      const source = step.join('\n');
      assert.doesNotMatch(source, /^\s*(?:if:|continue-on-error:)/m);
      for (const pattern of required) assert.match(source, pattern);
    };
    const steps = stepsOf(jobs.get(jobName)!);
    const index = steps.findIndex((step) => step.some((line) => line.trim() === `run: ${command}`));
    validate(steps);
    assert.throws(() => validate(steps.filter((_, at) => at !== index)));
    for (const directive of ['if: false', 'continue-on-error: true'])
      assert.throws(() => validate(steps.map((step, at) => (at === index ? [...step, `        ${directive}`] : step))));
    for (const pattern of required) {
      const detached = steps[index]!.filter((line) => pattern.test(line));
      assert.throws(() =>
        validate(steps.map((step, at) => (at === index ? step.filter((line) => !pattern.test(line)) : step))),
      );
      assert.throws(() =>
        validate([
          ...steps.map((step, at) => (at === index ? step.filter((line) => !pattern.test(line)) : step)),
          ['      - name: unrelated step', '        env:', ...detached],
        ]),
      );
    }
  }
  const native = jobs.get('integration-tests')!.join('\n');
  assert.match(native, /run: node src\/test\/fixtures\/neon-http\/gate-run\.mjs/);
  assert.match(native, /NEON_HTTP_NATIVE_URL:/);
  assert.match(native, /NEON_HTTP_EVIDENCE:/);
});

it('runs real pooler contracts with exact runtimes and the shared pinned artifact', () => {
  const job = jobsOf(workflow('gates.yml')).get('pgbouncer-integration');
  assert.ok(job);
  assert.ok(job.includes('    needs: pack'));
  const steps = stepsOf(job);
  const assertPooler = (candidate: string[][]) => {
    const execution = candidate.find((step) =>
      step.some((line) => line.includes('node src/test/fixtures/pg-pooler/native-run.mjs')),
    );
    assert.ok(execution, 'required pooler command missing');
    const source = execution.join('\n');
    assert.match(source, /PG_POOLER_SHA256="\$\{\{ needs\.pack\.outputs\.sha256 \}\}"/);
    assert.match(source, /PG_POOLER_ARCHIVE=.*needs\.pack\.outputs\.tarball/);
    assert.match(source, /acquire-postgres\.sh/);
    assert.match(source, /pg-pooler\/acquire\.sh/);
    assert.match(source, /PG_POOLER_NODE22=/);
    assert.match(source, /PG_POOLER_NODE24=.*steps\.pooler-node24\.outputs\.binary/);
    assert.ok(!execution.some((line) => /^\s*(?:if:|continue-on-error:)/.test(line)));
    assert.doesNotMatch(source, /npm pack/);
  };
  assertPooler(steps);
  assert.throws(
    () => assertPooler(steps.filter((step) => !step.some((line) => line.includes('pg-pooler/native-run.mjs')))),
    /required pooler command missing/,
  );
  for (const token of ['PG_POOLER_SHA256=', 'PG_POOLER_NODE24='])
    assert.throws(() => assertPooler(steps.map((step) => step.filter((line) => !line.includes(token)))));
  assert.match(job.join('\n'), /node-version: 22\.16\.0/);
  assert.match(job.join('\n'), /node-version: 24\.10\.0/);
});

it('requires HTTP interruption checks with provisioned PG, exact runtimes and the shared archive', () => {
  const job = jobsOf(workflow('gates.yml')).get('pgbouncer-integration');
  assert.ok(job);
  const validate = (steps: string[][]) => {
    const at = steps.findIndex((step) => step.includes('        id: http-interruption'));
    assert.ok(at >= 0, 'required HTTP interruption step missing');
    const execution = steps[at]!.join('\n');
    assert.doesNotMatch(execution, /^\s*(?:if:|continue-on-error:)/m);
    for (const pattern of [
      /PG_PREFIX: \$\{\{ runner\.temp \}\}\/pooler-pg\/install/,
      /NEON_HTTP_ARCHIVE: .*needs\.pack\.outputs\.tarball/,
      /NEON_HTTP_ARCHIVE_SHA256: \$\{\{ needs\.pack\.outputs\.sha256 \}\}/,
      /HTTP_NODE24: \$\{\{ steps\.pooler-node24\.outputs\.binary \}\}/,
      /set -euo pipefail/,
    ])
      assert.match(execution, pattern);
    for (const [evidence, binary] of [
      ['HTTP22_EVIDENCE', 'node'],
      ['HTTP24_EVIDENCE', '"$HTTP_NODE24"'],
    ]) {
      assert.ok(
        execution.includes(
          `NEON_HTTP_INTERRUPTION_EVIDENCE="$${evidence}" ${binary} --test --test-concurrency=1 src/test/fixtures/neon-http/native-interruption.test.mjs src/test/fixtures/neon-http/gate-interruption.test.mjs`,
        ),
        `required HTTP interruption command missing for ${evidence}`,
      );
    }
    const provision = steps.findIndex((step) =>
      step.some((line) => line.includes('acquire-postgres.sh "$RUNNER_TEMP/pooler-pg"')),
    );
    assert.ok(provision >= 0 && provision < at, 'exact PG must be provisioned before HTTP checks');
  };
  const steps = stepsOf(job);
  const at = steps.findIndex((step) => step.includes('        id: http-interruption'));
  validate(steps);
  assert.throws(() => validate(steps.filter((_, index) => index !== at)));
  for (const directive of ['if: false', 'continue-on-error: true']) {
    assert.throws(() =>
      validate(steps.map((step, index) => (index === at ? [...step, `        ${directive}`] : step))),
    );
  }
  for (const token of [
    'PG_PREFIX:',
    'NEON_HTTP_ARCHIVE:',
    'NEON_HTTP_ARCHIVE_SHA256:',
    'HTTP_NODE24:',
    'HTTP22_EVIDENCE" node --test',
    'HTTP24_EVIDENCE" "$HTTP_NODE24" --test',
  ]) {
    const detached = steps[at]!.filter((line) => line.includes(token));
    assert.ok(detached.length > 0);
    assert.throws(() =>
      validate([
        ...steps.map((step, index) => (index === at ? step.filter((line) => !line.includes(token)) : step)),
        ['      - name: unrelated step', ...detached],
      ]),
    );
  }
  assert.throws(() => validate(steps.map((step) => step.filter((line) => !line.includes('acquire-postgres.sh')))));
});

it('checks packed TypeScript config loading without a loader preload on the Node 22 floor', () => {
  const job = jobsOf(workflow('gates.yml')).get('pack-smoke');
  assert.ok(job, 'packed consumer gate must exist');
  const source = job.join('\n');
  assert.match(source, /node-version: \['22\.16\.0', '22', '24\.10\.0'\]/);
  assert.match(source, /node scripts\/check-cli-typescript\.mjs "\$TARBALL"/);
});

it('runs packed SQL, tuple and libSQL consumers using the tested tarball and installed typecheck tools', () => {
  const job = jobsOf(workflow('gates.yml')).get('pack-smoke');
  assert.ok(job);
  assert.ok(job.includes('    needs: pack'));
  const steps = stepsOf(job);
  const install = steps.findIndex((step) => step.includes('      - run: npm ci'));
  for (const script of [
    'scripts/check-sql-fragments.mjs',
    'tooling/cursor-tuple/consumer.mjs',
    'src/test/fixtures/libsql-package.mjs',
    'src/test/fixtures/libsql-introspection-package.mjs',
  ]) {
    const assertSmoke = (candidate: string[][]) => {
      const smoke = candidate.findIndex((step) =>
        step.some((line) => line.trim() === `run: node ${script} "$TARBALL"`),
      );
      assert.ok(install >= 0 && smoke > install, 'packed smoke needs repository TypeScript installed first');
      assert.ok(!candidate[smoke]!.some((line) => /^\s*(?:if:|continue-on-error:)/.test(line)));
    };
    assertSmoke(steps);
    assert.throws(
      () => assertSmoke(steps.filter((step) => !step.some((line) => line.includes(script)))),
      /installed first/,
    );
  }
  const catalog = steps
    .find((step) => step.some((line) => line.includes('libsql-introspection-package.mjs')))!
    .join('\n');
  assert.match(
    catalog,
    /TURBINE_LIBSQL_INTROSPECTION_PEER: \$\{\{ github\.workspace \}\}\/node_modules\/@libsql\/client/,
  );
  assert.match(catalog, /TURBINE_LIBSQL_INTROSPECTION_SHA256: \$\{\{ needs\.pack\.outputs\.sha256 \}\}/);
  assert.match(catalog, /TURBINE_LIBSQL_INTROSPECTION_REPORT:/);
});

for (const { file, job } of AGGREGATORS) {
  describe(`${file}: ${job} cannot pass while a job it needs did not succeed`, () => {
    const lines = jobsOf(workflow(file)).get(job);

    it('runs even when a dependency failed (if: always())', () => {
      assert.ok(lines, `${file} has no ${job} job`);
      assert.ok(
        lines.includes('    if: always()'),
        `${job} must carry \`if: always()\`. Without it a failed dependency SKIPS ${job}, and a skipped ` +
          'required check does not block the merge.',
      );
    });

    it('fails on every result other than success', () => {
      assert.ok(lines, `${file} has no ${job} job`);
      assert.ok(
        lines.some((l) => l.includes('select(.value.result != "success")')),
        `${job} must filter its needs with \`select(.value.result != "success")\`, so a skipped or cancelled ` +
          'job fails it as surely as a failed one.',
      );
    });
  });
}

describe('no job can turn its own failure into success', () => {
  for (const file of ['ci.yml', 'gates.yml', 'release.yml']) {
    it(`${file}: no job-level continue-on-error, and step-level only on a step named non-blocking`, () => {
      const jobs = jobsOf(workflow(file));
      for (const [name, lines] of jobs) {
        assert.ok(
          !lines.some((l) => /^ {4}continue-on-error:/.test(l)),
          `${file} job ${name} sets continue-on-error, so its failure never reaches the aggregator`,
        );
        for (const step of stepsOf(lines)) {
          if (step.some((l) => /^ {8}continue-on-error:\s*true/.test(l))) {
            assert.match(
              step.join('\n'),
              /name: .*\(non-blocking\)/,
              `${file} job ${name} has a continue-on-error step whose name does not say it is non-blocking:\n` +
                step.join('\n'),
            );
          }
        }
      }
    });
  }
});

describe('release.yml: publish runs only behind the gates', () => {
  const publish = jobsOf(workflow('release.yml')).get('publish');

  it('needs tag-ancestry and gates, and has no job-level if: of its own', () => {
    assert.ok(publish, 'release.yml has no publish job');
    const needs = publish.find((l) => /^ {4}needs:/.test(l));
    assert.ok(needs, 'publish has no needs: line');
    assert.match(needs, /tag-ancestry/, 'publish must need tag-ancestry');
    assert.match(needs, /\bgates\b/, 'publish must need gates');
    assert.ok(
      !publish.some((l) => /^ {4}if:/.test(l)),
      'publish must not carry a job-level `if:`; it would decide on its own whether the gates matter',
    );
  });
});

/**
 * `key: value` lines whose unquoted value holds `: `, which YAML refuses
 * ("mapping values are not allowed here"). GitHub then rejects the whole
 * workflow before any job starts, so every gate in it silently stops running.
 * Block-scalar bodies (`run: |`) are skipped: anything is legal there.
 */
function plainScalarsWithColon(lines: string[]): string[] {
  const bad: string[] = [];
  let blockIndent = -1;
  lines.forEach((line, i) => {
    const indent = line.length - line.trimStart().length;
    if (blockIndent >= 0) {
      if (line.trim() === '' || indent > blockIndent) return;
      blockIndent = -1;
    }
    if (line.trimStart().startsWith('#')) return;
    const m = /^(\s*)(- )?[A-Za-z0-9_.-]+: (.+)$/.exec(line);
    if (!m) return;
    const value = (m[3] as string).replace(/\s+#.*$/, '');
    if (/^[|>][-+]?\d?$/.test(value)) {
      blockIndent = indent + (m[2] ? 2 : 0);
      return;
    }
    if (/^['"[{&*!|>]/.test(value)) return;
    if (value.includes(': ')) bad.push(`line ${i + 1}: ${line.trim()}`);
  });
  return bad;
}

describe('every workflow is valid YAML in the one way a line edit breaks it', () => {
  it('the check finds an unquoted value holding ": " (anti-vacuous)', () => {
    assert.deepEqual(plainScalarsWithColon(['      - run: npx tsx --test --test-name-pattern "a: b" x.ts']), [
      'line 1: - run: npx tsx --test --test-name-pattern "a: b" x.ts',
    ]);
    assert.deepEqual(plainScalarsWithColon(['      - run: |', '          echo "a: b"', '        env:']), []);
  });

  for (const file of ['ci.yml', 'gates.yml', 'release.yml', 'nightly.yml', 'codeql.yml', 'benchmarks.yml']) {
    it(`${file}: no unquoted value holds ": "`, () => {
      assert.deepEqual(
        plainScalarsWithColon(workflow(file)),
        [],
        `${file} has a plain YAML value containing ": ", so GitHub rejects the file and none of its jobs run. ` +
          'Quote the value or move it into a `run: |` block.',
      );
    });
  }
});

describe('gates.yml: a test step that points at a database requires that engine', () => {
  const URL_ENV = /^ {10}(DATABASE_URL|MYSQL_URL|MSSQL_URL|PGBOUNCER_URL):/;
  const RUNS_TESTS = /(tsx --test|npm run test|npm test)\b/;
  const jobs = jobsOf(workflow('gates.yml'));
  const testSteps = [...jobs].flatMap(([name, lines]) =>
    stepsOf(lines)
      .filter((step) => step.some((l) => RUNS_TESTS.test(l)) && step.some((l) => URL_ENV.test(l)))
      .map((step) => ({ name, step })),
  );

  it('found the database test steps (anti-vacuous)', () => {
    assert.ok(testSteps.length >= 8, `only ${testSteps.length} database test steps parsed from gates.yml`);
  });

  it('every one sets TURBINE_REQUIRE_ENGINE', () => {
    const missing = testSteps
      .filter(({ step }) => !step.some((l) => /^ {10}TURBINE_REQUIRE_ENGINE:/.test(l)))
      .map(({ name, step }) => `${name}: ${step[0]?.trim()}`);
    assert.deepEqual(
      missing,
      [],
      'these steps set a database URL but no TURBINE_REQUIRE_ENGINE, so a wrong URL skips every database ' +
        'test and the step still exits 0:\n  ' +
        missing.join('\n  '),
    );
  });
});

describe('benchmarks.yml: a dispatch-only measurement, never a gate', () => {
  const lines = workflow('benchmarks.yml');
  const onAt = lines.indexOf('on:');
  const triggers = lines
    .slice(
      onAt + 1,
      lines.findIndex((l, i) => i > onAt && /^\S/.test(l)),
    )
    .map((l) => /^ {2}([a-z_]+):/.exec(l)?.[1])
    .filter((t): t is string => t !== undefined);

  it('is triggered by workflow_dispatch alone', () => {
    assert.notEqual(onAt, -1, 'benchmarks.yml has no top-level `on:` line');
    assert.deepEqual(triggers, ['workflow_dispatch']);
  });

  it('runs on a GitHub-hosted standard runner with read-only contents', () => {
    const jobs = jobsOf(lines);
    assert.ok(jobs.size > 0);
    for (const [name, job] of jobs) {
      assert.ok(job.includes('    runs-on: ubuntu-latest'), `benchmarks.yml job ${name} is not on ubuntu-latest`);
    }
    assert.equal(
      lines.slice(lines.indexOf('permissions:'), lines.indexOf('permissions:') + 2).join('\n'),
      'permissions:\n  contents: read',
    );
  });

  it('is not called from any gate workflow', () => {
    for (const file of ['ci.yml', 'gates.yml', 'release.yml']) {
      assert.ok(!workflow(file).some((l) => l.includes('benchmarks.yml')), `${file} references benchmarks.yml`);
    }
  });
});

describe('a public repository: no workflow runs on a self-hosted or paid runner', () => {
  const files = ['ci.yml', 'gates.yml', 'release.yml', 'nightly.yml', 'codeql.yml', 'benchmarks.yml'];
  const runsOn = files.flatMap((file) =>
    workflow(file)
      .filter((l) => /^\s+runs-on:/.test(l))
      .map((l) => `${file}: ${l.trim()}`),
  );

  it('found the runs-on lines (anti-vacuous)', () => {
    assert.ok(runsOn.length >= files.length, `only ${runsOn.length} runs-on lines parsed`);
  });

  it('none names grandprix, Depot or self-hosted', () => {
    assert.deepEqual(
      runsOn.filter((l) => /grandprix|depot|self-hosted/i.test(l)),
      [],
      'public repositories run on GitHub-hosted standard runners only',
    );
  });
});

it('requires both built MySQL tool module formats in the existing native service gate', () => {
  const native = [...jobsOf(workflow('gates.yml')).values()]
    .map((lines) => lines.join('\n'))
    .find((job) => job.includes('Run the suite against MySQL 8'));
  assert.ok(native, 'native MySQL job must exist');
  const check = (source: string) => {
    assert.match(source, /npm run build/);
    for (const format of ['esm', 'cjs'])
      assert.ok(
        source.includes(`MYSQL_TOOLS_FORMAT=${format} node --test tooling/mysql-tools/integration.mjs`),
        `missing ${format} native tools`,
      );
    assert.match(source, /TURBINE_REQUIRE_ENGINE: mysql/);
  };
  check(native);
  assert.throws(() => check(native.replace('MYSQL_TOOLS_FORMAT=cjs', 'OMITTED=cjs')), /missing cjs/);
});

it('requires core and D1 contracts against the pack job archive on exact local runtimes', () => {
  const jobs = jobsOf(workflow('gates.yml'));
  assert.ok(jobs.get('build')?.some((line) => line.trim() === 'run: npm run test:core'));
  const smoke = jobs.get('pack-smoke');
  assert.ok(smoke);
  assert.match(smoke.join('\n'), /node-version: \['22\.16\.0', '22', '24\.10\.0'\]/);
  const steps = stepsOf(smoke);
  for (const script of ['test:core:packed', 'test:d1']) {
    const validate = (candidate: string[][]) => {
      const step = candidate.find((lines) => lines.some((line) => line.trim() === `run: npm run ${script}`));
      assert.ok(step, `required ${script} step`);
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub Actions expression.
      assert.ok(step.some((line) => line.trim() === 'TURBINE_CORE_D1_TARBALL: ${{ env.TARBALL }}'));
      assert.ok(!step.some((line) => /^\s*(?:if:|continue-on-error:)/.test(line)));
    };
    validate(steps);
    assert.throws(() => validate(steps.filter((step) => !step.some((line) => line.includes(script)))));
    assert.throws(() =>
      validate(steps.map((step) => step.filter((line) => !line.includes('TURBINE_CORE_D1_TARBALL')))),
    );
  }
});
