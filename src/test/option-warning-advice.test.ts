/**
 * `warnUnknownQueryOptions` takes its advice logger from the caller and reads no
 * environment of its own.
 *
 * The unknown-option warning used to fall back to the console logger when the
 * environment's mode had advice on, which let a caller without a client logger
 * (or one that forgot to pass it) write to the console whatever the client's
 * `diagnostics` or `logger` said. Every engine now passes its client's advice
 * logger, or `null` when advice is off, so the parameter is required and the
 * fallback is gone.
 *
 * Run: npx tsx --test src/test/option-warning-advice.test.ts
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { TurbineLogEntry } from '../logger.js';
import { warnUnknownQueryOptions } from '../query/option-surface.js';

// biome-ignore lint/suspicious/noExplicitAny: the cases omit a required argument on purpose.
type Any = any;

describe('warnUnknownQueryOptions: the advice logger is the caller', () => {
  const savedEnv = process.env.NODE_ENV;
  const savedWarn = console.warn;
  let consoleLines: string[];

  beforeEach(() => {
    // The mode the old fallback needed to switch advice on.
    process.env.NODE_ENV = 'development';
    consoleLines = [];
    console.warn = (...parts: unknown[]) => {
      consoleLines.push(parts.map(String).join(' '));
    };
  });

  afterEach(() => {
    console.warn = savedWarn;
    if (savedEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = savedEnv;
  });

  it('writes the warning to the logger it is given', () => {
    const lines: { message: string; entry: TurbineLogEntry }[] = [];
    warnUnknownQueryOptions(
      'oe_given',
      'findMany',
      { include: { posts: true } },
      {
        warn: (message, entry) => lines.push({ message, entry }),
      },
    );
    assert.equal(lines.length, 1);
    assert.equal(lines[0]!.entry.code, 'unknown-query-option');
    assert.match(lines[0]!.message, /unknown option "include" in oe_given\.findMany\(\)/);
    assert.equal(consoleLines.length, 0, 'nothing reaches the console');
  });

  it('is silent with a null logger, even in development mode', () => {
    warnUnknownQueryOptions('oe_null', 'findMany', { include: { posts: true } }, null);
    assert.deepEqual(consoleLines, []);
  });

  it('is silent when the logger argument is omitted: no console fallback from the environment', () => {
    // @ts-expect-error the advice logger is required, so omitting it does not compile
    warnUnknownQueryOptions('oe_omitted', 'findMany', { include: { posts: true } });
    (warnUnknownQueryOptions as Any)('oe_undefined', 'findMany', { include: { posts: true } }, undefined);
    assert.deepEqual(consoleLines, [], 'a missing logger means no advice, never the console');
  });

  it('option-surface.ts imports neither the diagnostics resolver nor the console logger', () => {
    const source = readFileSync(fileURLToPath(new URL('../query/option-surface.ts', import.meta.url)), 'utf8');
    const imports = source.split('\n').filter((line) => /^import\b/.test(line) || /^\} from /.test(line));
    assert.ok(imports.length > 3, 'the import lines were found');
    assert.ok(
      imports.every((line) => !line.includes('diagnostics.js')),
      `option-surface.ts must not import diagnostics.js: ${imports.join(' | ')}`,
    );
    assert.ok(
      imports.every((line) => !line.includes('consoleLogger')),
      `option-surface.ts must not import consoleLogger: ${imports.join(' | ')}`,
    );
  });
});
