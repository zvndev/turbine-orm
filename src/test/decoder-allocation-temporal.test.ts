/** Terminal-Z input must keep the full database-date fallback and timezone semantics. */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseDbDate } from '../query-utils.js';

describe('terminal-Z database date decoding', () => {
  it('preserves exact instants and millisecond truncation for ISO and driver spellings', () => {
    const inputs = [
      '2024-02-29T12:34:56.123Z',
      '2024-02-29 12:34:56.123Z',
      '2024-02-29T12:34:56.123456Z',
      '2024-02-29T12:34:56Z',
      '0001-01-01T00:00:00.000Z',
      '+012024-01-01T00:00:00.000Z',
      '1970-01-01T00:00:00.000Z',
      '2024-02-29Z',
    ];
    for (const input of inputs) assert.equal(parseDbDate(input).getTime(), new Date(input).getTime(), input);
  });

  it('retains the general fallback for long years and malformed terminal-Z values', () => {
    assert.equal(parseDbDate('12024-01-01T00:00:00Z').toISOString(), '+012024-01-01T00:00:00.000Z');
    assert.equal(parseDbDate('2024-13-99T25:61:61Z').toISOString(), '2025-04-09T02:02:01.000Z');
    for (const input of ['Z', ':Z', 'bad:Z', '2024-01-01T00:00:00+0a:00Z']) {
      assert.equal(Number.isNaN(parseDbDate(input).getTime()), Number.isNaN(new Date(input).getTime()), input);
    }
  });

  it('preserves UTC pinning and every supported non-Z offset spelling', () => {
    assert.equal(parseDbDate('2024-02-29 12:34:56.123').toISOString(), '2024-02-29T12:34:56.123Z');
    for (const offset of ['+02', '+0200', '+02:00']) {
      assert.equal(parseDbDate(`2024-02-29T12:34:56${offset}`).toISOString(), '2024-02-29T10:34:56.000Z');
    }
    assert.equal(parseDbDate('2024-02-29T12:34:56-04:56:02').toISOString(), '2024-02-29T17:30:58.000Z');
  });
});
