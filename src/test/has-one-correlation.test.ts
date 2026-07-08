import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeQuery, mockTable } from './helpers.js';

// hasOne: the FK lives on the TARGET (child) side — exactly like hasMany but
// unique. The with-subquery must correlate alias.fk = parent.pk, NOT the
// belongsTo direction (alias.pk = parent.fk), which silently compares the
// wrong columns (found dogfooding: uuid = character varying).
const schema = {
  tables: {
    pos_items: mockTable(
      'pos_items',
      [
        { name: 'id', field: 'id', pgType: 'uuid' },
        { name: 'external_ref', field: 'external_ref', pgType: 'varchar' },
      ],
      {
        group: {
          type: 'hasOne' as const,
          name: 'group',
          from: 'pos_items',
          to: 'groups',
          foreignKey: 'pos_item_id', // on groups (child)
          referenceKey: 'id', // on pos_items (parent)
        },
      },
    ),
    groups: mockTable('groups', [
      { name: 'id', field: 'id', pgType: 'uuid' },
      { name: 'pos_item_id', field: 'pos_item_id', pgType: 'uuid' },
      { name: 'label', field: 'label', pgType: 'text' },
    ]),
  },
  enums: {},
};

test('hasOne with-subquery correlates child FK to parent PK', () => {
  const q = makeQuery('pos_items', schema);
  const d = q.buildFindMany({ with: { group: true }, limit: 1 } as never);
  assert.match(d.sql, /t0\."pos_item_id" = "pos_items"\."id"/);
  assert.doesNotMatch(d.sql, /t0\."id" = "pos_items"\."pos_item_id"/);
  assert.match(d.sql, /LIMIT 1\)/); // still a single-object subquery
});
