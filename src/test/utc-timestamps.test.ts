import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseDbDate } from '../query/utils.js';

test('parseDbDate pins offset-less strings to UTC', () => {
  // json_agg / json_build_object form
  assert.equal(parseDbDate('2026-07-07T17:15:41.896').toISOString(), '2026-07-07T17:15:41.896Z');
  // driver textual form (space separator)
  assert.equal(parseDbDate('2026-07-07 17:15:41.896').toISOString(), '2026-07-07T17:15:41.896Z');
  // no fractional seconds
  assert.equal(parseDbDate('2026-07-07 17:15:41').toISOString(), '2026-07-07T17:15:41.000Z');
});

test('parseDbDate respects explicit offsets', () => {
  assert.equal(parseDbDate('2026-07-07T17:15:41.896Z').toISOString(), '2026-07-07T17:15:41.896Z');
  assert.equal(parseDbDate('2026-07-07T17:15:41+04:00').toISOString(), '2026-07-07T13:15:41.000Z');
  assert.equal(parseDbDate('2026-07-07T17:15:41-0430').toISOString(), '2026-07-07T21:45:41.000Z');
  assert.equal(parseDbDate('2026-07-07T17:15:41+02').toISOString(), '2026-07-07T15:15:41.000Z');
});

test('parseDbDate does not misread date-only or exotic strings as offsets', () => {
  // date-only: `-07` in `2026-07-07` must not be mistaken for a UTC offset
  assert.equal(parseDbDate('2026-07-07').toISOString(), '2026-07-07T00:00:00.000Z');
});
