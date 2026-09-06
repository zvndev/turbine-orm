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
 * IT READ README.md ONLY, and the same two numbers are published in five more
 * places under `site/`, which is the actual marketing surface. A re-baseline
 * moved the README and the site's feature paragraph and left the comparison
 * TABLE on the same page saying the old figures, so the homepage stated two
 * numbers about the shipped artifact that were false. A guard that covers one
 * of six copies is the drift it exists to prevent, so it now sweeps every
 * tracked file that states one of these claims and requires each to equal the
 * gate. Adding a new page that repeats the claim needs no edit here.
 *
 * Run: npx tsx --test src/test/size-claim-sync.test.ts
 */

import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');
const README = readFileSync(resolve(ROOT, 'README.md'), 'utf-8');
const SIZE_LIMIT = readFileSync(resolve(ROOT, '.size-limit.js'), 'utf-8');

/**
 * Every tracked file that could state a size claim, README and site alike.
 * Found by walking rather than listed, so a new page is covered the day it is
 * written. `site/lib/changelog.generated.ts` is excluded because it is the
 * rendered CHANGELOG, whose older entries quote the figures that were true at
 * the time and must stay that way.
 */
function claimBearingFiles(): string[] {
  const roots = ['README.md', 'STABILITY.md', 'site/app', 'docs/releases'];
  const out: string[] = [];
  const walk = (rel: string): void => {
    const abs = resolve(ROOT, rel);
    if (!existsSync(abs)) return;
    if (!statSync(abs).isDirectory()) {
      if (/\.(md|mdx|tsx?)$/.test(rel)) out.push(rel);
      return;
    }
    for (const entry of readdirSync(abs)) {
      if (entry === 'node_modules' || entry.startsWith('.')) continue;
      walk(`${rel}/${entry}`);
    }
  };
  for (const r of roots) walk(r);
  return out.filter((f) => !f.endsWith('changelog.generated.ts'));
}

/**
 * Any "under N kB/KB" figure that is followed, within the same sentence, by
 * language tying it to this package's bundle. Deliberately loose about the
 * wording and strict about the number: the claim is the number.
 */
const CLAIM = /under\s+\*{0,2}(\d+)\s*[kK]B\*{0,2}\s*(brotli|import graph)/g;

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

  it('every tracked file that states one of these claims states the gate', () => {
    const gates = new Set([
      limitFor('main entry, import { TurbineClient }'),
      limitFor('edge entry, turbine-orm/serverless'),
    ]);
    const files = claimBearingFiles();
    assert.ok(files.length > 5, `the file walk found ${files.length} files, so this check would be vacuous`);

    const wrong: string[] = [];
    let claims = 0;
    for (const file of files) {
      const text = readFileSync(resolve(ROOT, file), 'utf-8');
      for (const m of text.matchAll(CLAIM)) {
        claims++;
        const n = Number(m[1]);
        if (!gates.has(n)) wrong.push(`${file}: "${m[0]}" (gates are ${[...gates].join(', ')} kB)`);
      }
    }
    assert.ok(
      claims >= 6,
      `only ${claims} claims found across ${files.length} files; the pattern has stopped matching`,
    );
    assert.deepEqual(
      wrong,
      [],
      `these published size claims do not equal any size-limit gate:\n  ${wrong.join('\n  ')}`,
    );
  });

  it('the two published entries are exempted from the 5% headroom convention, in writing', () => {
    // Both limits are claims, so neither may be bumped to absorb a regression.
    // The note is what tells the next reader that, and it is load-bearing.
    assert.match(SIZE_LIMIT, /THE SERVERLESS ENTRY IS DELIBERATELY NOT ON THE 5% CONVENTION/);
    assert.match(SIZE_LIMIT, /THE MAIN ENTRY JOINS THAT RULE/);
    assert.match(SIZE_LIMIT, /Do not raise this number to make a build pass/);
  });
});
