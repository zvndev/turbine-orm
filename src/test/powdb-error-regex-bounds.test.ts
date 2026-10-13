/**
 * `wrapPowdbError` classifies an engine message in time linear in its length.
 *
 * The type-mismatch pattern used an unbounded `[^,]+` after "expected ", and a
 * message holding many "type mismatch for column '...': expected " fragments
 * and no comma made the engine retry that scan to the end of the string from
 * every fragment: a 512 KB message took about 2.5 s, and the cost grew with
 * the square of the length. The engine echoes caller text into its messages,
 * so a long enough value reaches this pattern. Every group is bounded now.
 *
 * Run: npx tsx --test src/test/powdb-error-regex-bounds.test.ts
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ValidationError } from '../errors.js';
import { wrapPowdbError } from '../powdb.js';

describe('wrapPowdbError: the type-mismatch pattern', () => {
  it('still names the column, the column type and the bound type', () => {
    const err = wrapPowdbError({ message: "type mismatch for column 'age': expected Int, got str" });
    assert.ok(err instanceof ValidationError, String(err));
    assert.match(err.message, /comparison on column "age": the column is Int but the bound value is str/);
  });

  it('still reads the engine message wrapped in its error envelope', () => {
    const err = wrapPowdbError({
      message: `query failed: Execution("type mismatch for column 'id': expected Int, got str")`,
    });
    assert.ok(err instanceof ValidationError, String(err));
    assert.match(err.message, /comparison on column "id": the column is Int but the bound value is str/);
  });

  it('a column name past the bound falls back to the generic type-mismatch message', () => {
    const longName = 'c'.repeat(300);
    const err = wrapPowdbError({ message: `type mismatch for column '${longName}': expected Int, got str` });
    assert.ok(err instanceof ValidationError, String(err));
    assert.match(err.message, /PowDB query rejected: type mismatch/);
  });

  it('classifies a hostile 1 MiB message in linear time', () => {
    const unit = "type mismatch for column '&': expected ";
    const hostile = unit.repeat(Math.ceil((1024 * 1024) / unit.length));
    const started = performance.now();
    const err = wrapPowdbError({ message: hostile });
    const elapsedMs = performance.now() - started;
    assert.ok(err instanceof ValidationError, String(err));
    assert.ok(elapsedMs < 1000, `classifying a ${hostile.length}-byte message took ${elapsedMs.toFixed(0)} ms`);
  });
});
