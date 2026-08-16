import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeQuery, mockTable } from './helpers.js';

// Postgres allows at most 100 function args (50 json key/value pairs); wide
// relation targets must chunk into concatenated jsonb_build_* calls. Both row
// encoders chunk, so both are exercised: `jsonEncoding: 'positional'` is the
// PostgreSQL DEFAULT, and it emits one arg per column rather than two, so it
// reaches the arg ceiling on a different table width. Testing only the object
// form would leave the shape a Postgres user actually gets uncovered.
const wideCols = Array.from({ length: 60 }, (_, i) => ({ name: `col_${i}`, field: `col_${i}`, pgType: 'text' }));
const schema = {
  tables: {
    parents: mockTable('parents', [{ name: 'id', field: 'id' }], {
      wide: {
        type: 'hasMany' as const,
        name: 'wide',
        from: 'parents',
        to: 'wides',
        foreignKey: 'parent_id',
        referenceKey: 'id',
      },
    }),
    wides: mockTable('wides', [{ name: 'id', field: 'id' }, { name: 'parent_id', field: 'parent_id' }, ...wideCols]),
  },
  enums: {},
};

for (const [jsonEncoding, encoder] of [
  ['object', 'jsonb_build_object'],
  ['positional', 'jsonb_build_array'],
] as const) {
  test(`relation subquery on a >50-column table chunks ${encoder} (jsonEncoding: '${jsonEncoding}')`, () => {
    const q = makeQuery('parents', schema, { jsonEncoding });
    const d = q.buildFindMany({ with: { wide: true }, limit: 1 } as never);
    assert.match(d.sql, new RegExp(encoder));
    assert.match(d.sql, /\|\|/);
    assert.match(d.sql, /::json/);
    // No single builder call with more than 100 args, in either encoding.
    for (const m of d.sql.matchAll(
      new RegExp(`${encoder.replace('b_', 'b?_')}\\(([^()]*(?:\\([^()]*\\)[^()]*)*)\\)`, 'g'),
    )) {
      const argCount = (m[1] ?? '').split(',').length;
      assert.ok(argCount <= 100, `${encoder} with ${argCount} args`);
    }
  });
}

test('the default on PostgreSQL is the positional encoder', () => {
  const q = makeQuery('parents', schema);
  const d = q.buildFindMany({ with: { wide: true }, limit: 1 } as never);
  assert.match(d.sql, /jsonb_build_array/);
  assert.doesNotMatch(d.sql, /jsonb_build_object/);
});
