import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createPgArrayParser, readTextArray } from '../query/utils.js';

describe('native PostgreSQL text-array utility compatibility', () => {
  it('retains quoted, escaped, null, nested, empty and malformed readings', () => {
    const cases: Array<[string, unknown]> = [
      ['{}', []],
      ['{one,two}', ['one', 'two']],
      ['{one,NULL,"NULL",""}', ['one', null, 'NULL', '']],
      [
        '{{one,two},{three,NULL}}',
        [
          ['one', 'two'],
          ['three', null],
        ],
      ],
      ['{"a,b","a\\"b","c\\\\d"}', ['a,b', 'a"b', 'c\\d']],
      ['{unbalanced', '{unbalanced'],
      ['[1:2]={one,two}', '[1:2]={one,two}'],
    ];
    const legacy = createPgArrayParser((text) => text);
    for (const [wire, expected] of cases) {
      assert.deepEqual(readTextArray(wire), expected, wire);
      if (wire.startsWith('{') && wire !== '{unbalanced') assert.deepEqual(readTextArray(wire), legacy(wire), wire);
    }
    const alreadyParsed = ['one', null];
    assert.equal(readTextArray(alreadyParsed), alreadyParsed);
    assert.equal(readTextArray(null), null);
  });
});
