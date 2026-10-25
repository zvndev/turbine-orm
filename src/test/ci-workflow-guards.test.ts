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

const AGGREGATORS = [
  { file: 'ci.yml', job: 'ci-ok' },
  { file: 'gates.yml', job: 'gates-ok' },
] as const;

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
