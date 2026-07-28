import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeQuery, mockTable } from './helpers.js';

// hasOne: the FK lives on the TARGET (child) side, exactly like hasMany but
// unique. The with-subquery must correlate alias.fk = parent.pk, NOT the
// belongsTo direction (alias.pk = parent.fk), which silently compares the
// wrong columns (the mismatch is silent: uuid = character varying).
const schema = {
  tables: {
    ledger_lines: mockTable(
      'ledger_lines',
      [
        { name: 'id', field: 'id', pgType: 'uuid' },
        { name: 'external_ref', field: 'external_ref', pgType: 'varchar' },
      ],
      {
        group: {
          type: 'hasOne' as const,
          name: 'group',
          from: 'ledger_lines',
          to: 'groups',
          foreignKey: 'line_id', // on groups (child)
          referenceKey: 'id', // on ledger_lines (parent)
        },
      },
    ),
    groups: mockTable('groups', [
      { name: 'id', field: 'id', pgType: 'uuid' },
      { name: 'line_id', field: 'line_id', pgType: 'uuid' },
      { name: 'label', field: 'label', pgType: 'text' },
    ]),
  },
  enums: {},
};

test('hasOne with-subquery correlates child FK to parent PK', () => {
  const q = makeQuery('ledger_lines', schema);
  const d = q.buildFindMany({ with: { group: true }, limit: 1 } as never);
  assert.match(d.sql, /t0\."line_id" = "ledger_lines"\."id"/);
  assert.doesNotMatch(d.sql, /t0\."id" = "ledger_lines"\."line_id"/);
  assert.match(d.sql, /LIMIT 1\)/); // still a single-object subquery
});
