/**
 * turbine-orm — CLI flag regression guard
 *
 * Static smoke test that reads `src/cli/index.ts` as text and asserts that
 * the public CLI flags are still wired up. Catches accidental deletion of
 * flag names from the argument parser or the help text.
 *
 * Also unit-tests `parseArgs` / `isLoopbackHost` for the Studio/Observe
 * `--allow-remote` hard-fail gate (Track 2).
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
import { isLoopbackHost, parseArgs } from '../cli/index.js';

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
    for (const flag of ['--port', '--host', '--no-open', '--allow-remote']) {
      assert.ok(source.includes(`'${flag}'`), `parseArgs() must handle studio flag ${flag}`);
    }
  });

  it('migrate create --from-diff and init step flags are wired up', () => {
    const source = readFileSync(CLI_INDEX, 'utf-8');
    for (const flag of ['--from-diff', '--yes', '--skip-schema', '--skip-seed', '--skip-push', '--skip-generate']) {
      assert.ok(source.includes(`'${flag}'`), `parseArgs() must handle ${flag}`);
    }
  });

  it('help text documents --allow-remote', () => {
    const source = readFileSync(CLI_INDEX, 'utf-8');
    assert.ok(source.includes('--allow-remote'), 'help / parseArgs must mention --allow-remote');
  });

  it('Studio and Observe hard-fail non-loopback without --allow-remote', () => {
    const source = readFileSync(CLI_INDEX, 'utf-8');
    // Both commands must call isLoopbackHost and process.exit(1) on refusal.
    assert.ok(source.includes('isLoopbackHost'), 'must use isLoopbackHost gate');
    assert.ok(
      source.includes('refuses to bind to') && source.includes('--allow-remote'),
      'must emit a clear refuse-without--allow-remote error',
    );
    // Ensure both Studio and Observe mention the refuse path.
    assert.ok(source.includes('Studio refuses to bind'), 'cmdStudio must hard-fail');
    assert.ok(source.includes('Observe refuses to bind'), 'cmdObserve must hard-fail');
  });
});

describe('isLoopbackHost', () => {
  it('accepts common loopback forms', () => {
    for (const host of ['127.0.0.1', 'localhost', '::1', '[::1]']) {
      assert.equal(isLoopbackHost(host), true, `${host} is loopback`);
    }
  });

  it('is case-insensitive and trims whitespace', () => {
    assert.equal(isLoopbackHost('LocalHost'), true);
    assert.equal(isLoopbackHost('  127.0.0.1  '), true);
    assert.equal(isLoopbackHost('  [::1] '), true);
  });

  it('rejects non-loopback hosts', () => {
    for (const host of ['0.0.0.0', '192.168.1.1', '10.0.0.5', 'example.com', '::', '']) {
      assert.equal(isLoopbackHost(host), false, `${host || '(empty)'} is not loopback`);
    }
  });
});

describe('parseArgs — studio / observe flags', () => {
  it('parses --allow-remote as a boolean flag', () => {
    const args = parseArgs(['studio', '--allow-remote', '--host', '0.0.0.0']);
    assert.equal(args.command, 'studio');
    assert.equal(args.allowRemote, true);
    assert.equal(args.host, '0.0.0.0');
  });

  it('leaves allowRemote undefined when the flag is absent', () => {
    const args = parseArgs(['studio', '--host', '127.0.0.1']);
    assert.equal(args.allowRemote, undefined);
    assert.equal(args.host, '127.0.0.1');
  });

  it('parses --port, --host, and --no-open together', () => {
    const args = parseArgs(['observe', '--port', '5000', '--host', '::1', '--no-open']);
    assert.equal(args.command, 'observe');
    assert.equal(args.port, 5000);
    assert.equal(args.host, '::1');
    assert.equal(args.noOpen, true);
    assert.equal(args.allowRemote, undefined);
  });
});

describe('parseArgs — generate flags (T-8b)', () => {
  it('parses --no-timestamp as a boolean flag', () => {
    const args = parseArgs(['generate', '--no-timestamp']);
    assert.equal(args.command, 'generate');
    assert.equal(args.noTimestamp, true);
  });

  it('leaves noTimestamp undefined by default (timestamp stays on)', () => {
    const args = parseArgs(['generate']);
    assert.equal(args.noTimestamp, undefined);
  });

  it('composes with other generate flags', () => {
    const args = parseArgs(['generate', '--zod', '--no-timestamp', '--include-views']);
    assert.equal(args.zod, true);
    assert.equal(args.noTimestamp, true);
    assert.equal(args.includeViews, true);
  });

  it('help text documents --no-timestamp', () => {
    const source = readFileSync(CLI_INDEX, 'utf-8');
    assert.ok(source.includes("'--no-timestamp'"), 'parseArgs() must handle --no-timestamp');
    assert.ok(source.includes('--no-timestamp'), 'generate help must mention --no-timestamp');
  });
});
