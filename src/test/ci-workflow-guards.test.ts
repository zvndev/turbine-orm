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
