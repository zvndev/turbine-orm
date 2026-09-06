/**
 * Every `introspect()` call the CLI makes forwards `keepColumnNames`.
 *
 * Introspection refuses two columns of one table that camelCase to the same
 * field (E003) and tells the user to set `keepColumnNames: true` in
 * `turbine.config.ts`. That advice is only true if the CLI hands the key on,
 * and it did not: `config.keepColumnNames` was resolved and then read by the
 * Prisma resolver alone, so following the error's own instruction changed
 * nothing. A source-level guard, because the call sites are five hand-written
 * option objects and a sixth would be written the same way.
 *
 * Run: npx tsx --test src/test/cli-introspect-options.test.ts
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(resolve(here, '../cli/index.ts'), 'utf-8');

describe('cli/index.ts: introspect() call sites', () => {
  const calls = [...source.matchAll(/await introspect\(\{([\s\S]*?)\n\s*\}\);/g)];

  it('there are introspect() calls to check (anti-vacuous)', () => {
    assert.ok(calls.length >= 5, `expected at least the five known call sites, found ${calls.length}`);
  });

  it('every call forwards keepColumnNames from the resolved config', () => {
    const missing = calls.filter((m) => !/\bkeepColumnNames:\s*config\.keepColumnNames\b/.test(m[1]!));
    assert.deepEqual(
      missing.map((m) => m[0].split('\n').slice(0, 3).join(' | ')),
      [],
      'an introspect() call without keepColumnNames makes the E003 collision advice a lie',
    );
  });
});
