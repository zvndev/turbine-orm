/**
 * The dialects page's capability table is generated from each engine's dialect
 * object into site/lib/capabilities.generated.ts. This runs the generator in
 * `--check` mode, so a capability added, removed or changed in any engine
 * fails the unit suite until the file is regenerated (`npm run gen:capabilities`).
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { postgresDialect } from '../dialect.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = join(ROOT, 'scripts', 'gen-capability-table.ts');
const GENERATED = join(ROOT, 'site', 'lib', 'capabilities.generated.ts');

describe('engine capability table', () => {
  it('site/lib/capabilities.generated.ts matches every engine dialect', () => {
    const run = spawnSync(process.execPath, ['--import', 'tsx', SCRIPT, '--check'], { cwd: ROOT, encoding: 'utf-8' });
    assert.equal(run.status, 0, `${run.stdout}${run.stderr}`);
  });

  it('lists every capability key once (anti-vacuous)', () => {
    const text = readFileSync(GENERATED, 'utf-8');
    const keys = Object.keys(postgresDialect.capabilities);
    assert.ok(keys.length > 30, `expected the full capability set, got ${keys.length}`);
    for (const key of keys) {
      const rows = text.split(`{ key: '${key}',`).length - 1;
      assert.equal(rows, 1, `${key} appears ${rows} times`);
    }
  });
});
