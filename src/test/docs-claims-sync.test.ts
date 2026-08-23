import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { TurbineErrorCode } from '../errors.js';

/**
 * Documented numbers, asserted against the file that owns them.
 *
 * Every claim below was corrected by hand once (0.65.0) and had drifted again
 * by 0.76.0, which is what a correction without a guard buys. So no number is
 * written down in this file: each assertion reads its own source of truth
 * (.c8rc.json, package.json, src/errors.ts, the seed fixture, the contents of
 * src/query/) and compares the document to it. A hardcoded expectation here
 * would just be a third copy of the same drifting number.
 */

const root = new URL('../../', import.meta.url);
const read = (p: string): string => readFileSync(new URL(p, root), 'utf8');

describe('documented numbers match their source of truth', () => {
  it('STABILITY.md quotes the real .c8rc.json coverage floors', () => {
    const c8 = JSON.parse(read('.c8rc.json')) as Record<string, number>;
    const stability = read('STABILITY.md');

    for (const key of ['lines', 'statements', 'branches', 'functions'] as const) {
      const configured = c8[key];
      assert.equal(
        typeof configured,
        'number',
        `.c8rc.json must configure a numeric "${key}" threshold; this assertion cannot pass vacuously`,
      );
      const documented = stability.match(new RegExp(`${key}\\s+(\\d+)%`, 'i'));
      assert.ok(
        new RegExp(`${key}\\s+${configured}%`, 'i').test(stability),
        `STABILITY.md must quote ${key} ${configured}%, the value in .c8rc.json, but it says ` +
          `${documented ? `${key} ${documented[1]}%` : `nothing about ${key}`}. ` +
          `This assertion exists because these numbers were corrected once and drifted again.`,
      );
    }
  });

  it('STABILITY.md status stamp is within one minor of package.json', () => {
    const pkg = JSON.parse(read('package.json')) as { version: string };
    const [major, minor] = pkg.version.split('.').map(Number);
    assert.equal(typeof major, 'number');
    assert.equal(typeof minor, 'number');

    const stamp = read('STABILITY.md').match(/Honest status today \((\d+)\.(\d+) line\)/);
    assert.ok(stamp, 'STABILITY.md must carry a "Honest status today (X.Y line)" stamp');

    const drift = ((major as number) - Number(stamp[1])) * 1000 + ((minor as number) - Number(stamp[2]));
    assert.ok(
      drift <= 1 && drift >= -1,
      `STABILITY.md is stamped ${stamp[1]}.${stamp[2]} while package.json is at ${pkg.version}. ` +
        `Re-stamp the "Honest status today" heading and re-read the claims under it.`,
    );
  });

  it('CONTRIBUTING.md states the real error-code range', () => {
    const codes = Object.values(TurbineErrorCode).map((c) => Number(String(c).replace('TURBINE_E', '')));
    assert.ok(codes.length > 0 && codes.every(Number.isFinite), 'TurbineErrorCode must yield numeric codes');
    const highest = `E${String(Math.max(...codes)).padStart(3, '0')}`;

    const contributing = read('CONTRIBUTING.md');
    const documented = contributing.match(/E001\s*\D\s*(E\d{3})/);
    assert.ok(
      new RegExp(`E001[^)]*${highest}`).test(contributing),
      `CONTRIBUTING.md must name the highest code defined in src/errors.ts, ${highest}, but its range ends at ` +
        `${documented ? documented[1] : 'no code at all'}. ` +
        `Adding an error code without widening that range is how it came to claim E017 after E018 shipped.`,
    );
  });

  it('CONTRIBUTING.md states the real seeded user count', () => {
    const seed = read('src/test/fixtures/seed.sql');
    const start = seed.indexOf('INSERT INTO users');
    assert.notEqual(start, -1, 'seed.sql must contain an "INSERT INTO users" statement');

    // Only the value rows of THAT statement: slice at its terminating
    // semicolon so a later INSERT cannot inflate the count.
    const statement = seed.slice(start);
    const body = statement.slice(0, statement.indexOf(';'));
    const users = body.split('\n').filter((line) => /^\s*\(/.test(line)).length;
    assert.ok(users > 0, 'the seed-row parser found no value rows, so this assertion would pass vacuously');

    const contributing = read('CONTRIBUTING.md');
    const documented = contributing.match(/(\d+) users \/ \d+ posts/);
    assert.ok(
      new RegExp(`\\b${users} users\\b`).test(contributing),
      `src/test/fixtures/seed.sql seeds ${users} users; CONTRIBUTING.md says ` +
        `${documented ? `${documented[1]} users` : 'nothing about the seeded user count'}.`,
    );
  });

  it('CONTRIBUTING.md lists every query/ module', () => {
    const modules = readdirSync(new URL('src/query/', root)).filter((f) => f.endsWith('.ts'));
    assert.ok(modules.length > 0, 'no modules found under src/query/, so this assertion would pass vacuously');

    const contributing = read('CONTRIBUTING.md');
    const missing = modules.filter((m) => !contributing.includes(m));
    assert.deepEqual(
      missing,
      [],
      `CONTRIBUTING.md omits ${missing.length} of ${modules.length} query/ modules: ${missing.join(', ')}. ` +
        `The architecture block is the map new contributors read; a module missing from it is a module nobody finds.`,
    );
  });
});
