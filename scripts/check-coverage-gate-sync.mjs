#!/usr/bin/env node
/**
 * Guard: every file the CLI coverage lane COLLECTS must be held by a floor.
 *
 * `coverage:cli:collect` runs one instrumented pass over a chosen file set, and
 * the floors live in separate `coverage:cli:gate:*` scripts because c8 enforces
 * one threshold set per invocation. Nothing ties the two together, so a file
 * added to the collection and to nothing else is instrumented, reported, and
 * enforced by NOTHING. That is not a missing gate, which someone would notice;
 * it is a slower lane holding a floor of zero, which looks exactly like a gate
 * that passes. It has happened twice: `mcp.ts` and `error-catalog.ts` each
 * joined the collection with neither a per-file gate nor an entry in the
 * aggregate's include list, and each spent a release that way.
 *
 * ## The invariant, stated carefully
 *
 * Every collected file is named by a per-file gate OR by the aggregate.
 *
 * It is deliberately NOT "the collection and the aggregate hold the same
 * files". That stronger rule happens to describe the current set and is wrong
 * as a rule: `src/cli/index.ts` is 5,945 lines at roughly 33%, so folding it
 * into the aggregate would force two of that gate's floors down by about 25
 * points and leave the aggregate unable to see the other eight files sag. It
 * carries its own per-file floor instead, which satisfies the real invariant.
 *
 * The converse is checked too: a gate that names a file nobody collects
 * measures nothing and passes, which is the same failure wearing the other
 * face.
 *
 * ## Fails closed
 *
 * Repo convention (see scripts/check-import-cycles.mjs): a self-test that
 * proves the matcher still fires, and a refusal to pass on an empty scan. A
 * regex that silently stopped matching `--include` would otherwise report
 * "0 collected, 0 gated, in sync" and pass forever.
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const { scripts } = require(`${repoRoot}package.json`);

/** `--include src/cli/foo.ts` and `--include 'src/cli/foo.ts'` both count. */
const INCLUDE_RE = /--include\s+'?([^'\s]+)'?/g;

/** Every `--include` path named by one npm script value. */
function includesOf(value) {
  return [...String(value ?? '').matchAll(INCLUDE_RE)].map((m) => m[1]);
}

// Self-test: the matcher must find both quoting styles and must not invent a
// match in a script that has no --include at all.
{
  const found = includesOf("c8 --include src/a.ts --include 'src/b.ts' tsx --test x.ts");
  const empty = includesOf('tsx --test src/test/x.test.ts');
  if (found.length !== 2 || found[0] !== 'src/a.ts' || found[1] !== 'src/b.ts' || empty.length !== 0) {
    console.error('check-coverage-gate-sync: matcher self-test failed; the guard cannot be trusted, refusing to pass.');
    process.exit(1);
  }
}

const COLLECT = 'coverage:cli:collect';
const AGGREGATE = 'coverage:cli:gate:aggregate';

if (!scripts[COLLECT] || !scripts[AGGREGATE]) {
  console.error(`check-coverage-gate-sync: package.json has no "${COLLECT}" or no "${AGGREGATE}"; the lane has been renamed. Refusing to pass.`);
  process.exit(1);
}

const collected = includesOf(scripts[COLLECT]);
const aggregate = includesOf(scripts[AGGREGATE]);

/** Per-file gates: every `coverage:cli:gate:*` that is not the shared runner or the aggregate. */
const perFileGates = Object.keys(scripts).filter(
  (k) => k.startsWith('coverage:cli:gate:') && k !== AGGREGATE && !k.startsWith('//'),
);
const perFileTargets = new Map();
for (const key of perFileGates) {
  for (const file of includesOf(scripts[key])) perFileTargets.set(file, key);
}

if (collected.length === 0 || perFileGates.length === 0) {
  console.error(
    `check-coverage-gate-sync: parsed ${collected.length} collected file(s) and ${perFileGates.length} per-file gate(s); ` +
      'at least one side is empty, so this check would pass vacuously. Refusing to pass.',
  );
  process.exit(1);
}

const problems = [];

for (const file of collected) {
  const gate = perFileTargets.get(file);
  if (!gate && !aggregate.includes(file)) {
    problems.push(
      `${file} is collected by ${COLLECT} but named by no per-file gate and not by ${AGGREGATE}.\n` +
        `      It is instrumented and enforced by nothing, which is a floor of zero that reports green.\n` +
        `      Fix: add a "coverage:cli:gate:<name>" with measured floors, or add it to ${AGGREGATE}.`,
    );
  }
}

for (const [file, gate] of perFileTargets) {
  if (!collected.includes(file)) {
    problems.push(
      `${file} is gated by "${gate}" but is not in ${COLLECT}, so the gate reports on coverage nobody collects.\n` +
        `      Fix: add "--include ${file}" to ${COLLECT}, or delete the gate.`,
    );
  }
}

for (const file of aggregate) {
  if (!collected.includes(file)) {
    problems.push(
      `${file} is in ${AGGREGATE} but is not in ${COLLECT}, so it only adds an empty denominator.\n` +
        `      Fix: add "--include ${file}" to ${COLLECT}, or drop it from the aggregate.`,
    );
  }
}

if (problems.length > 0) {
  console.error('check-coverage-gate-sync: the coverage collection and its floors disagree:\n');
  for (const p of problems) console.error(`  - ${p}\n`);
  process.exit(1);
}

const outsideAggregate = collected.filter((f) => !aggregate.includes(f));
console.log(
  `check-coverage-gate-sync: ${collected.length} collected file(s), ${perFileTargets.size} per-file gate(s), ` +
    `${aggregate.length} in the aggregate; every collected file is held by a floor` +
    (outsideAggregate.length > 0
      ? ` (${outsideAggregate.join(', ')} held by a per-file gate only, by design)`
      : '') +
    '.',
);
