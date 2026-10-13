/**
 * turbine-orm: the precision strip in timeOfDayKind / localDateTimeKind
 *
 * Both classifiers drop a precision suffix (`time(6)`, `timestamp (3) without
 * time zone`) before comparing the spelling. The pattern used to start with an
 * unbounded `\s*`, retried from every position of a whitespace run, so a long
 * type name cost quadratic time: 40,000 spaces took close to a second. The
 * spellings below must classify exactly as before, and a long run of
 * whitespace must stay cheap.
 *
 * Run: npx tsx --test src/test/schema-type-precision.test.ts
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { localDateTimeKind, timeOfDayKind } from '../schema.js';

describe('type precision strip', () => {
  it('classifies every precision spelling as before', () => {
    assert.equal(timeOfDayKind('time(6)'), 'time');
    assert.equal(timeOfDayKind('TIME (6)'), 'time');
    assert.equal(timeOfDayKind('time(6) without time zone'), 'time');
    assert.equal(timeOfDayKind('time ( 6 ) with time zone'), 'timetz');
    assert.equal(timeOfDayKind('timetz(3)'), 'timetz');
    assert.equal(timeOfDayKind('timestamp(3)'), null);
    assert.equal(localDateTimeKind('timestamp(3)'), 'timestamp');
    assert.equal(localDateTimeKind('timestamp ( 3 ) without time zone'), 'timestamp');
    assert.equal(localDateTimeKind('timestamp(3) with time zone'), null);
    assert.equal(localDateTimeKind('date'), 'date');
    assert.equal(localDateTimeKind('datetime(6)'), null);
  });

  it('stays linear on a long run of whitespace', () => {
    const name = `time${' '.repeat(200_000)}x`;
    const started = performance.now();
    assert.equal(timeOfDayKind(name), null);
    assert.equal(localDateTimeKind(name), null);
    const elapsed = performance.now() - started;
    // The unbounded pattern takes tens of seconds here; the bounded one, a few
    // milliseconds. The limit leaves room for a slow CI runner.
    assert.ok(elapsed < 500, `classifying a 200,000-space type name took ${elapsed.toFixed(0)} ms`);
  });
});
