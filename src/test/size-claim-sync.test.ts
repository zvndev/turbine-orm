/**
 * turbine-orm, the published bundle-size claims match the gate that enforces them
 *
 * The README says the main entry is held "under N kB brotli ... enforced by
 * size-limit in CI". That sentence is only true if N is the number
 * `.size-limit.js` actually enforces, and it was not: the README said 85 kB, the
 * entry measured 85.22 kB, and the gate was 90 kB. The figure was exceeded AND
 * the gate cited as enforcing it enforced something 4.78 kB looser, so nothing
 * would have gone red until long after the sentence stopped being true.
 *
 * This is the cheap half of the fix (the gate itself is the other half, and it
 * needs a build). It fails when someone edits one number without the other, in
 * either direction, which is the only way the two can come apart.
 *
 * Run: npx tsx --test src/test/size-claim-sync.test.ts
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');
const README = readFileSync(resolve(ROOT, 'README.md'), 'utf-8');
const SIZE_LIMIT = readFileSync(resolve(ROOT, '.size-limit.js'), 'utf-8');

/** The `limit: 'N kB'` of the size-limit entry whose `name` contains `label`. */
function limitFor(label: string): number {
  const at = SIZE_LIMIT.indexOf(label);
  assert.ok(at > 0, `no size-limit entry mentioning ${label}`);
  const after = SIZE_LIMIT.slice(at, at + 900);
  const m = /limit: '(\d+(?:\.\d+)?) kB'/.exec(after);
  assert.ok(m, `no limit found for the ${label} entry`);
  return Number(m[1]);
}

/** Every "under **N kB**" / "under N kB" figure in the README. */
function readmeFigures(pattern: RegExp): number[] {
  return [...README.matchAll(pattern)].map((m) => Number(m[1]));
}

describe('README bundle-size claims equal the size-limit gate', () => {
  it('finds both numbers at all (anti-vacuous)', () => {
    assert.ok(limitFor('main entry, import { TurbineClient }') > 0);
    assert.ok(limitFor('edge entry, turbine-orm/serverless') > 0);
    assert.ok(readmeFigures(/under \*\*(\d+) kB brotli\*\*/g).length > 0, 'the README must still state a figure');
  });

  it('the main entry: every README figure is the gate', () => {
    const gate = limitFor('main entry, import { TurbineClient }');
    // "held under **86 kB brotli**" in the serverless section...
    const prose = readmeFigures(/under \*\*(\d+) kB brotli\*\*/g);
    assert.ok(prose.includes(gate), `README prose says ${prose.join('/')} kB, the gate is ${gate} kB`);
    // ...and "under 86 kB import graph (CI-enforced)" in the comparison table.
    const table = readmeFigures(/under (\d+) kB import graph \(CI-enforced\)/g);
    assert.deepEqual(table, [gate], `the comparison table says ${table.join('/')} kB, the gate is ${gate} kB`);
  });

  it('the edge entry: every README figure is the gate', () => {
    const gate = limitFor('edge entry, turbine-orm/serverless');
    const figures = [
      ...readmeFigures(/edge entry under \*\*(\d+) kB\*\*/g),
      ...readmeFigures(/under (\d+) kB brotli \(CI-enforced\)/g),
    ];
    assert.ok(figures.length >= 2, 'both edge claims must still be present');
    for (const n of figures) assert.equal(n, gate, `README says ${n} kB, the gate is ${gate} kB`);
  });

  it('the two published entries are exempted from the 5% headroom convention, in writing', () => {
    // Both limits are claims, so neither may be bumped to absorb a regression.
    // The note is what tells the next reader that, and it is load-bearing.
    assert.match(SIZE_LIMIT, /THE SERVERLESS ENTRY IS DELIBERATELY NOT ON THE 5% CONVENTION/);
    assert.match(SIZE_LIMIT, /THE MAIN ENTRY JOINS THAT RULE/);
    assert.match(SIZE_LIMIT, /Do not raise this number to make a build pass/);
  });
});
