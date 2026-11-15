/** Explicit engine refusal must precede PostgreSQL fallback and project effects. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../cli/index.ts', import.meta.url));
const loader = fileURLToPath(new URL('../../node_modules/tsx/dist/loader.mjs', import.meta.url));
const malformed = [
  ['migrate', 'create', 'heldout', '--schema'],
  ['migrate', 'status', '--url'],
  ['migrate', 'list', '-s'],
  ['init', '--url'],
  ['generate', '--out'],
  ['seed', '--url'],
];

for (const args of malformed) {
  for (const engineFirst of [false, true]) {
    const tokens = engineFirst ? [args[0]!, '--engine', 'libsql', ...args.slice(1)] : [...args, '--engine', 'libsql'];
    test(`config-free libSQL refuses ${tokens.join(' ')} without filesystem effects`, () => {
      const dir = mkdtempSync(join(tmpdir(), 'libsql-cli-admission-'));
      try {
        const result = spawnSync(process.execPath, ['--import', loader, cli, ...tokens], {
          cwd: dir,
          env: { ...process.env, DATABASE_URL: '', NODE_OPTIONS: '', NO_COLOR: '1' },
          encoding: 'utf8',
          timeout: 20_000,
        });
        assert.ifError(result.error);
        assert.equal(result.signal, null);
        assert.equal(result.status, 1, result.stdout + result.stderr);
        assert.match(result.stderr, /\[TURBINE_E(?:003|017)\]/, 'Command must fail libSQL admission');
        assert.deepEqual(readdirSync(dir), [], 'Refused commands must not scaffold or create a database');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
}
