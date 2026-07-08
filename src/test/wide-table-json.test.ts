import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeQuery, mockTable } from './helpers.js';

// Postgres allows at most 100 function args (50 json key/value pairs); wide
// relation targets must chunk into concatenated jsonb_build_object calls.
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

test('relation subquery on a >50-column table chunks json_build_object', () => {
  const q = makeQuery('parents', schema);
  const d = q.buildFindMany({ with: { wide: true }, limit: 1 } as never);
  assert.match(d.sql, /jsonb_build_object/);
  assert.match(d.sql, /\|\|/);
  assert.match(d.sql, /::json/);
  // no single json_build_object call with more than 100 args
  for (const m of d.sql.matchAll(/json_build_object\(([^()]*(?:\([^()]*\)[^()]*)*)\)/g)) {
    const argCount = (m[1] ?? '').split(',').length;
    assert.ok(argCount <= 100, `json_build_object with ${argCount} args`);
  }
});
