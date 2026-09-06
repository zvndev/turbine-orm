/**
 * turbine-orm, `ci-ok` aggregates every job and its anti-vacuous floor equals the list it aggregates
 *
 * `ci-ok` is the ONLY required status check on `main`. It `needs:` every other
 * job in ci.yml, and its run step refuses when the `needs` object holds fewer
 * than N entries, because an emptied `needs` would otherwise report success
 * while checking nothing. Two hand-maintained numbers have to agree for that
 * floor to mean anything: the length of the `needs:` list and the `-lt N`
 * literal in the script. `docs/WORKFLOW.md` and `CLAUDE.md` both said a test
 * asserts the two are equal, for two weeks before this file existed. This is
 * that test.
 *
 * Three questions, each of which fails SILENTLY in CI when the answer is wrong:
 *   1. Is every top-level job except `ci-ok` in its `needs:`? A job missing
 *      from the list runs, fails, and blocks nothing.
 *   2. Does the `-lt N` literal equal the `needs:` length? A twentieth job
 *      added without raising N clears the floor at 19, and would go on
 *      clearing it after a later job was DROPPED from the list.
 *   3. Does every `needs:` entry name a real job? A stale entry breaks the
 *      workflow at parse time on GitHub, after the push, never before it.
 *
 * Deliberately a line parser rather than a YAML library: the repo carries no
 * runtime dependency on one, and the three shapes read here (a two-space job
 * key, a six-space `- name` list item, a `-lt N` literal) are fixed by ci.yml's
 * own conventions. Every extraction asserts it found something, so a layout
 * change the parser cannot follow fails this test instead of passing it over
 * an empty list.
 *
 * Run: npx tsx --test src/test/ci-ok-needs-sync.test.ts
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const CI_YML_URL = new URL('../../.github/workflows/ci.yml', import.meta.url);
const AGGREGATOR = 'ci-ok';

interface CiShape {
  /** Every top-level job key under `jobs:`, in file order. */
  jobs: string[];
  /** The `needs:` entries of the aggregator job. */
  needs: string[];
  /** The `N` of the aggregator's `-lt N` anti-vacuous check. */
  floor: number;
}

/**
 * Read the three facts out of ci.yml. Scoped to the text AFTER the `jobs:`
 * line: `on:` also has two-space children (`push:`, `pull_request:`) that
 * would otherwise be mistaken for jobs.
 */
function parseCi(text: string): CiShape {
  const lines = text.split('\n');
  const jobsAt = lines.findIndex((line) => line === 'jobs:');
  assert.notEqual(jobsAt, -1, 'ci.yml has no top-level `jobs:` line; the parser has nothing to read');

  const jobs: string[] = [];
  const jobStart = new Map<string, number>();
  for (let i = jobsAt + 1; i < lines.length; i++) {
    const m = /^ {2}([a-z0-9_-]+):\s*$/.exec(lines[i] as string);
    if (m?.[1]) {
      jobs.push(m[1]);
      jobStart.set(m[1], i);
    }
  }

  const start = jobStart.get(AGGREGATOR);
  assert.notEqual(start, undefined, `ci.yml defines no \`${AGGREGATOR}\` job`);
  const nextJob = jobs[jobs.indexOf(AGGREGATOR) + 1];
  const end = nextJob ? (jobStart.get(nextJob) as number) : lines.length;
  const block = lines.slice(start as number, end);

  // `needs:` in list form (one `- name` per line) or inline (`needs: [a, b]`).
  const needs: string[] = [];
  const needsAt = block.findIndex((line) => /^ {4}needs:/.test(line));
  assert.notEqual(needsAt, -1, `\`${AGGREGATOR}\` has no \`needs:\` key, so it aggregates nothing`);
  const inline = /^ {4}needs:\s*\[(.*)\]\s*$/.exec(block[needsAt] as string);
  if (inline) {
    needs.push(
      ...(inline[1] as string)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    );
  } else {
    for (let i = needsAt + 1; i < block.length; i++) {
      const m = /^ {6}- ([a-z0-9_-]+)\s*$/.exec(block[i] as string);
      if (!m?.[1]) break;
      needs.push(m[1]);
    }
  }

  const floors = block.map((line) => /-lt (\d+)\b/.exec(line)?.[1]).filter((v): v is string => v !== undefined);
  assert.equal(
    floors.length,
    1,
    `expected exactly one \`-lt N\` literal in the \`${AGGREGATOR}\` run step, found ${floors.length}`,
  );

  return { jobs, needs, floor: Number(floors[0]) };
}

describe('ci-ok aggregates every ci.yml job and its floor equals the needs list', () => {
  const shape = parseCi(readFileSync(CI_YML_URL, 'utf8'));

  it('parsed a non-trivial workflow (anti-vacuous)', () => {
    // A parser that reads zero jobs would make every check below pass on
    // empty sets. Anchor on the aggregator itself and on the size of the
    // matrix this repo actually runs, so a layout change is a failure here
    // rather than a silent pass everywhere else.
    assert.ok(shape.jobs.includes(AGGREGATOR), `no \`${AGGREGATOR}\` job among: ${shape.jobs.join(', ')}`);
    assert.ok(shape.jobs.length >= 5, `only ${shape.jobs.length} jobs parsed; ci.yml has many more than that`);
    assert.ok(shape.needs.length > 0, `\`${AGGREGATOR}\` needs nothing, so it gates nothing`);
    assert.ok(Number.isInteger(shape.floor) && shape.floor > 0, `unusable anti-vacuous floor: ${shape.floor}`);
  });

  it('every job except ci-ok is in its needs list', () => {
    const missing = shape.jobs.filter((job) => job !== AGGREGATOR && !shape.needs.includes(job));
    assert.deepEqual(
      missing,
      [],
      `ci.yml jobs missing from \`${AGGREGATOR}.needs\`: ${missing.join(', ')}. ` +
        `A job outside the list can fail without blocking the merge, because \`${AGGREGATOR}\` is the only required check.`,
    );
  });

  it('every needs entry names a real job', () => {
    const unknown = shape.needs.filter((need) => !shape.jobs.includes(need));
    assert.deepEqual(unknown, [], `\`${AGGREGATOR}.needs\` names jobs that do not exist: ${unknown.join(', ')}`);
    const dupes = shape.needs.filter((need, i) => shape.needs.indexOf(need) !== i);
    assert.deepEqual(dupes, [], `\`${AGGREGATOR}.needs\` lists a job twice: ${dupes.join(', ')}`);
  });

  it('the -lt N anti-vacuous floor equals the needs list length', () => {
    assert.equal(
      shape.floor,
      shape.needs.length,
      `\`${AGGREGATOR}\` needs ${shape.needs.length} jobs but its run step checks \`-lt ${shape.floor}\`. ` +
        `The two must be equal: a floor below the list lets a dropped job go unnoticed, a floor above it fails every run. ` +
        `Change the literal in the "Fail unless every job succeeded" step to ${shape.needs.length}.`,
    );
  });
});
