/**
 * turbine-orm: values that read differently through a relation than at the top level.
 *
 * Build-only (no database). `json_build_object` renders a timestamp in the
 * server's zone (a local-mean-time offset with seconds before about 1900, a
 * ` BC` suffix), a float NaN or infinity as a string, and an enum array as a
 * JSON array, while the driver hands the top-level read a Date, a number and
 * array text. The row parser now reads both to the same value.
 * src/test/oracle-nested-fidelity.test.ts checks the same against a live server.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { PgCompatPool } from '../pg-types.js';
import { QueryInterface } from '../query/index.js';
import { parseDbDate, readJsonFloat, readJsonFloatArray, readTextArray } from '../query/utils.js';
import type { SchemaMetadata } from '../schema.js';
import { mockTable } from './helpers.js';

describe('parseDbDate reads every rendering Postgres produces', () => {
  const cases: [string, string][] = [
    ['2024-03-10T06:30:00-04:00', '2024-03-10T10:30:00.000Z'],
    ['2024-03-10 10:30:00', '2024-03-10T10:30:00.000Z'],
    ['1850-06-01T07:03:58-04:56:02', '1850-06-01T12:00:00.000Z'],
    ['1850-06-01T17:53:28+05:53:28', '1850-06-01T12:00:00.000Z'],
    ['0001-12-31T19:03:58-04:56:02 BC', '0001-01-01T00:00:00.000Z'],
    ['0001-01-01T05:53:28+05:53:28', '0001-01-01T00:00:00.000Z'],
    ['0044-03-15T12:00:00 BC', '-000043-03-15T12:00:00.000Z'],
    ['0044-03-15T07:03:58-04:56:02 BC', '-000043-03-15T12:00:00.000Z'],
    ['0044-03-15 BC', '-000043-03-15T00:00:00.000Z'],
    ['0050-06-01T00:00:00', '0050-06-01T00:00:00.000Z'],
    ['10000-01-01T00:00:00', '+010000-01-01T00:00:00.000Z'],
    ['1969-12-31T23:59:59.5', '1969-12-31T23:59:59.500Z'],
  ];
  for (const [text, iso] of cases) {
    it(text, () => assert.equal(parseDbDate(text).toISOString(), iso));
  }

  it('text that is not a date is still an Invalid Date', () => {
    assert.ok(Number.isNaN(parseDbDate('not a date').getTime()));
  });
});

describe('JSON float and array-text readers', () => {
  it('reads the three float strings JSON uses and passes everything else through', () => {
    assert.ok(Number.isNaN(readJsonFloat('NaN') as number));
    assert.equal(readJsonFloat('Infinity'), Number.POSITIVE_INFINITY);
    assert.equal(readJsonFloat('-Infinity'), Number.NEGATIVE_INFINITY);
    for (const v of [1.5, -0, null, 'nan', '1.5']) assert.equal(readJsonFloat(v), v);
  });

  it('reads float arrays at any depth and returns the same array when nothing changes', () => {
    assert.deepEqual(readJsonFloatArray(['NaN', 1, ['-Infinity', null]]), [
      Number.NaN,
      1,
      [Number.NEGATIVE_INFINITY, null],
    ]);
    const plain = [1, 2];
    assert.equal(readJsonFloatArray(plain), plain);
  });

  it('reads array text into strings and leaves anything else alone', () => {
    assert.deepEqual(readTextArray('{ok}'), ['ok']);
    assert.deepEqual(readTextArray('{a,NULL,"b,c","with \\"quote\\"",""}'), ['a', null, 'b,c', 'with "quote"', '']);
    assert.deepEqual(readTextArray('{}'), []);
    for (const v of ['ok', null, ['ok'], 3]) assert.deepEqual(readTextArray(v), v);
  });
});

describe('the row parser applies them by column type', () => {
  function schema(): SchemaMetadata {
    const items = mockTable('items', [
      { name: 'id', field: 'id', pgType: 'int4' },
      { name: 'score', field: 'score', pgType: 'float8' },
      { name: 'scores', field: 'scores', pgType: '_float8' },
      { name: 'mood', field: 'mood', pgType: 'mood' },
      { name: 'moods', field: 'moods', pgType: '_mood' },
      { name: 'label', field: 'label', pgType: 'text' },
      { name: 'tags', field: 'tags', pgType: '_text' },
    ]);
    return { tables: { items }, enums: { mood: ['sad', 'ok'] } } as SchemaMetadata;
  }

  async function readTopLevel(row: Record<string, unknown>): Promise<Record<string, unknown>> {
    const pool = { query: async () => ({ rows: [row], rowCount: 1 }) } as unknown as PgCompatPool;
    const items = new QueryInterface(pool, 'items', schema());
    const rows = (await items.findMany({ limit: 1 })) as unknown as Record<string, unknown>[];
    return rows[0]!;
  }

  it('an enum array read as text becomes an array; a text column holding the same text does not', async () => {
    const row = await readTopLevel({ id: 1, moods: '{sad,ok}', mood: '{ok}', label: '{ok}', tags: '{a}' });
    assert.deepEqual(row.moods, ['sad', 'ok']);
    assert.equal(row.mood, '{ok}');
    assert.equal(row.label, '{ok}');
    assert.equal(row.tags, '{a}', 'only enum arrays: the driver parses every built-in array type itself');
  });

  it('a float column holding a JSON float string reads as the number', async () => {
    const row = await readTopLevel({ id: 1, score: 'NaN', scores: ['Infinity', 2], label: 'NaN' });
    assert.ok(Number.isNaN(row.score as number));
    assert.deepEqual(row.scores, [Number.POSITIVE_INFINITY, 2]);
    assert.equal(row.label, 'NaN');
  });
});
