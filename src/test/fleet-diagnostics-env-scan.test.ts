/**
 * Two source rules, enforced by a scan of the library (`src/`, minus `test/`
 * and `cli/`, which is a terminal program and keeps `console`):
 *
 * 1. Only diagnostics.ts reads `NODE_ENV`, `TURBINE_DISABLE_CACHE_CHECK` or
 *    `TURBINE_CACHE_CHECK_SAMPLE`. The `diagnostics` option is resolved once
 *    per client; a second reader is a second authority on the same question,
 *    and on a query path it is a `process.env` read per call.
 * 2. Only logger.ts (the default logger) and seed.ts (a CLI-driven runner) call
 *    `console`. Everything else reaches the client's `logger`, so `{}`
 *    silences Turbine and a configured sink sees every line with its code.
 *
 * Comment lines are skipped, so documentation may name both.
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const SRC = fileURLToPath(new URL('../', import.meta.url));

const ENV_READ =
  /\.NODE_ENV\b|\[\s*['"`]NODE_ENV['"`]\s*\]|\{[^}]*\bNODE_ENV\b[^}]*\}\s*=\s*process\.env|TURBINE_DISABLE_CACHE_CHECK|TURBINE_CACHE_CHECK_SAMPLE/;
const CONSOLE_CALL = /\bconsole\s*\.\s*(log|info|warn|error|debug|trace)\b|\bconsole\s*\[/;

const ENV_READERS = new Set(['diagnostics.ts']);
const CONSOLE_CALLERS = new Set(['logger.ts', 'seed.ts']);

/**
 * Files not yet converted, each with the reason. Every entry must STILL have a
 * hit (the last test), so this list cannot outlive the work it excuses: when a
 * file is converted its entry has to go.
 */
const PENDING: Readonly<Record<string, string>> = {
  'query/builder.ts': 'builder advice, cache self-check and no-limit warnings: logger lane phase 2',
  'query/utils.ts': 'warnRedundantSortTerm: logger lane phase 2',
  'query/option-surface.ts': 'warnUnknownQueryOptions: logger lane phase 2',
  'powql.ts': 'PowDB unknown-option and no-limit warnings: scheduled after the fix lanes release powql.ts',
};

function librarySources(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) {
        if (name !== 'test' && name !== 'cli') walk(full);
      } else if (/\.(c|m)?ts$/.test(name) && !name.endsWith('.d.ts')) {
        out.push(full);
      }
    }
  };
  walk(SRC);
  return out;
}

/** Code lines matching `pattern` in `text`, as `line: source`. Comment lines are skipped. */
export function codeHits(text: string, pattern: RegExp): string[] {
  const hits: string[] = [];
  text.split('\n').forEach((line, i) => {
    const trimmed = line.trimStart();
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return;
    if (pattern.test(line)) hits.push(`${i + 1}: ${trimmed}`);
  });
  return hits;
}

function violations(pattern: RegExp, allowed: ReadonlySet<string>): Record<string, string[]> {
  const found: Record<string, string[]> = {};
  for (const file of librarySources()) {
    const rel = relative(SRC, file);
    if (allowed.has(rel) || Object.hasOwn(PENDING, rel)) continue;
    const hits = codeHits(readFileSync(file, 'utf8'), pattern);
    if (hits.length > 0) found[rel] = hits;
  }
  return found;
}

describe('source rules: diagnostics and logging', () => {
  it('the scan sees the library (not an empty directory)', () => {
    const files = librarySources().map((f) => relative(SRC, f));
    assert.ok(files.length > 50, `only ${files.length} files scanned`);
    for (const must of ['client.ts', 'query/builder.ts', 'diagnostics.ts', 'logger.ts']) {
      assert.ok(files.includes(must), `${must} is scanned`);
    }
  });

  it('the patterns match what they are for', () => {
    assert.deepEqual(codeHits("if (process.env.NODE_ENV === 'production') return;", ENV_READ).length, 1);
    assert.deepEqual(codeHits("const e = process.env['NODE_ENV'];", ENV_READ).length, 1);
    assert.deepEqual(codeHits('const { NODE_ENV } = process.env;', ENV_READ).length, 1);
    assert.deepEqual(codeHits('const s = process.env.TURBINE_CACHE_CHECK_SAMPLE;', ENV_READ).length, 1);
    assert.deepEqual(codeHits('  // process.env.NODE_ENV is read once', ENV_READ).length, 0);
    assert.deepEqual(codeHits("  console.warn('[turbine] x');", CONSOLE_CALL).length, 1);
    assert.deepEqual(codeHits('  console.error(message);', CONSOLE_CALL).length, 1);
    assert.deepEqual(codeHits("  console['warn']('x');", CONSOLE_CALL).length, 1);
    assert.deepEqual(codeHits(' * prints with console.warn', CONSOLE_CALL).length, 0);
  });

  it('only diagnostics.ts reads NODE_ENV and the cache-check variables', () => {
    assert.deepEqual(violations(ENV_READ, ENV_READERS), {});
  });

  it('only logger.ts and seed.ts call console', () => {
    assert.deepEqual(violations(CONSOLE_CALL, CONSOLE_CALLERS), {});
  });

  it('every pending file still has a hit, so the pending list cannot go stale', () => {
    const stale: string[] = [];
    for (const rel of Object.keys(PENDING)) {
      const text = readFileSync(join(SRC, rel), 'utf8');
      if (codeHits(text, ENV_READ).length === 0 && codeHits(text, CONSOLE_CALL).length === 0) stale.push(rel);
    }
    assert.deepEqual(stale, [], 'converted files must leave PENDING');
  });
});
