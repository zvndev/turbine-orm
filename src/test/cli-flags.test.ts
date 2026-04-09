/**
 * turbine-orm — CLI flag regression guard
 *
 * Static smoke test that reads `src/cli/index.ts` as text and asserts that
 * the public CLI flags are still wired up. Catches accidental deletion of
 * flag names from the argument parser or the help text.
 *
 * This is a regression guard, not a fuzz test — we do NOT spawn the CLI
 * binary. Spawning would require a prior `npm run build` and coupling this
 * unit test to the build artifact, which `test:unit` must stay free of.
 *
 * Run: npx tsx --test src/test/cli-flags.test.ts
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_INDEX = resolve(__dirname, '../cli/index.ts');
const STUDIO_MODULE = resolve(__dirname, '../cli/studio.ts');

describe('CLI flag regression guard', () => {
  it('src/cli/index.ts is readable', () => {
    assert.ok(existsSync(CLI_INDEX), 'src/cli/index.ts must exist');
    const source = readFileSync(CLI_INDEX, 'utf-8');
    assert.ok(source.length > 0, 'src/cli/index.ts must not be empty');
  });

  it('baseline global flags are still parsed', () => {
    const source = readFileSync(CLI_INDEX, 'utf-8');
    // These flags are part of the long-standing CLI contract. Any accidental
    // deletion from the parseArgs() switch would silently break user scripts.
    for (const flag of ['--url', '--out', '--schema', '--force', '--verbose']) {
      assert.ok(source.includes(`'${flag}'`), `parseArgs() must still handle ${flag}`);
    }
  });

  it('studio command flags are wired up when studio module is present', () => {
    // Track 1 ships `src/cli/studio.ts` with --port/--host/--no-open support.
    // Until that module lands in this worktree, the studio command is still a
    // placeholder and these flags are intentionally absent. Once studio.ts is
    // in place, the flags MUST be handled by parseArgs() — this assertion is
    // the regression guard that locks that invariant in.
    if (!existsSync(STUDIO_MODULE)) return; // pre-merge: skip
    const source = readFileSync(CLI_INDEX, 'utf-8');
    for (const flag of ['--port', '--host', '--no-open']) {
      assert.ok(source.includes(`'${flag}'`), `parseArgs() must handle studio flag ${flag}`);
    }
  });
});
