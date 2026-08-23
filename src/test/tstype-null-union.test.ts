import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { baseTsType } from '../powdb-shared.js';

/**
 * `baseTsType` replaced eight hand-copied spellings of
 * `tsType.replace(/\s*\|\s*null$/i, '').trim()` across powdb.ts and powql.ts.
 * That regex is polynomial: `\s*` can start at every position, so N spaces with
 * no `|` costs O(N^2).
 *
 * These tests exist to hold two things at once, because a rewrite that is fast
 * and WRONG is worse than the slow original:
 *   1. the new function agrees with the old regex on every input, and
 *   2. it is actually linear.
 *
 * The oracle is the real old regex, not a description of it.
 */
const OLD_REGEX = /\s*\|\s*null$/i;
const oracle = (tsType: string): string => tsType.replace(OLD_REGEX, '').trim();

describe('baseTsType', () => {
  it('agrees with the regex it replaced on the shapes the generator emits', () => {
    const corpus = [
      'string',
      'string | null',
      'string|null',
      'string  |  null',
      'Date',
      'Date | null',
      'number | null',
      'bigint',
      'boolean | null',
      'Buffer',
      'Uint8Array | null',
      'Record<string, unknown>',
      'Record<string, unknown> | null',
      'string[]',
      'string[] | null',
      '{ a: number }',
      '{ a: number } | null',
      'unknown',
      // Case variations: the old regex carried /i.
      'string | NULL',
      'string | Null',
      'string | nUlL',
      // The `$` anchor matters. Trailing space means NO union match, only a trim.
      'string | null ',
      '  string | null  ',
      // "null" present but not as a union.
      'null',
      ' null ',
      'foonull',
      'nullable',
      'string | nullish',
      // Degenerate.
      '',
      ' ',
      '   ',
      '|null',
      '| null',
      '|',
      'string |',
      'string | null | null',
      // Non-space whitespace, which \s matches and a naive fix would not.
      'string\t|\tnull',
      'string\n|\nnull',
      'string  | null',
    ];

    assert.ok(corpus.length > 30, 'corpus must be non-trivial or this test proves nothing');
    for (const input of corpus) {
      assert.equal(baseTsType(input), oracle(input), `disagreed on ${JSON.stringify(input)}`);
    }
  });

  it('agrees with the regex on randomly generated inputs', () => {
    // Deterministic PRNG so a failure is reproducible.
    let seed = 0x9e3779b9;
    const rand = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 0x100000000;
    };
    const pieces = ['string', 'null', 'NULL', '|', ' ', '  ', '\t', 'Date', '', 'x'];

    let checked = 0;
    for (let i = 0; i < 4000; i++) {
      let s = '';
      const parts = 1 + Math.floor(rand() * 6);
      for (let j = 0; j < parts; j++) s += pieces[Math.floor(rand() * pieces.length)];
      assert.equal(baseTsType(s), oracle(s), `disagreed on ${JSON.stringify(s)}`);
      checked++;
    }
    assert.equal(checked, 4000, 'the fuzz loop must actually run');
  });

  it('is linear, where the regex it replaced was quadratic', () => {
    // The pathological input: many spaces, no pipe, so the old regex restarts
    // `\s*` at every position. 200k spaces cost the regex whole seconds.
    const pathological = `${' '.repeat(200_000)}x`;

    const start = process.hrtime.bigint();
    const out = baseTsType(pathological);
    const ms = Number(process.hrtime.bigint() - start) / 1e6;

    // Anti-vacuous: prove the call did real work and returned the right answer,
    // so this cannot pass by short-circuiting on some unexamined branch.
    assert.equal(out, 'x');
    assert.ok(
      ms < 250,
      `baseTsType took ${ms.toFixed(1)}ms on 200k spaces; the polynomial regex it ` +
        `replaced took seconds, so this bound failing means the linear property regressed`,
    );
  });

  it('the oracle really is slow, so the previous test is not measuring nothing', () => {
    // A negative control. If this ever becomes fast, V8 changed something and
    // the linearity test above stopped being meaningful; better to learn that
    // from a failure here than to keep trusting a bound nothing exercises.
    const input = `${' '.repeat(30_000)}x`;
    const start = process.hrtime.bigint();
    oracle(input);
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    assert.ok(ms > 20, `the old regex took only ${ms.toFixed(1)}ms on 30k spaces`);
  });
});
