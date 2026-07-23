/**
 * turbine-orm: manyToMany relation-filter SQL tests (build-only, no DB).
 *
 * A `where` filter on a manyToMany relation must correlate THROUGH the
 * junction table. The direct-FK correlation used for hasMany/belongsTo would
 * compile `target.pk = parent.pk` and silently match nothing (a real
 * field-reported bug: `count({ where: { rel: { some: {} } } })` returned 0
 * while the include path returned the linked rows).
 *
 * Run: npx tsx --test src/test/m2m-relation-filter.test.ts
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ValidationError } from '../errors.js';
import type { SchemaMetadata, TableMetadata } from '../schema.js';
import { makeQuery, mockTable } from './helpers.js';

function buildSchema(): SchemaMetadata {
  const tables: Record<string, TableMetadata> = {};

  tables.reports = mockTable(
    'reports',
    [
      { name: 'id', field: 'id' },
      { name: 'title', field: 'title', pgType: 'text' },
    ],
    {
      schedules: {
        type: 'manyToMany',
        name: 'schedules',
        from: 'reports',
        to: 'schedules',
        foreignKey: 'id',
        referenceKey: 'id',
        through: { table: '_report_to_schedule', sourceKey: 'A', targetKey: 'B' },
      },
    },
  );

  tables.schedules = mockTable('schedules', [
    { name: 'id', field: 'id' },
    { name: 'is_active', field: 'isActive', pgType: 'bool' },
  ]);
  tables.schedules.primaryKey = ['id'];
  tables.reports.primaryKey = ['id'];

  return { tables, enums: {} };
}

describe('manyToMany relation filters route through the junction', () => {
  it('some: {} compiles a junction-correlated EXISTS, not a direct FK probe', () => {
    const schema = buildSchema();
    const q = makeQuery('reports', schema);
    const { sql } = q.buildFindMany({ where: { schedules: { some: {} } } });
    assert.match(sql, /"_report_to_schedule"/, 'junction table appears in the filter SQL');
    assert.match(sql, /"_report_to_schedule"\."B" = "schedules"\."id"/, 'junction.targetKey links the target PK');
    assert.match(sql, /"_report_to_schedule"\."A" = "reports"\."id"/, 'junction.sourceKey links the parent PK');
    assert.doesNotMatch(sql, /"schedules"\."id" = "reports"\."id"/, 'the degenerate direct correlation is gone');
  });

  it('some with a sub-where keeps target-column qualification', () => {
    const schema = buildSchema();
    const q = makeQuery('reports', schema);
    const { sql, params } = q.buildFindMany({ where: { schedules: { some: { isActive: true } } } });
    assert.match(sql, /"schedules"\."is_active" = \$1/);
    assert.match(sql, /"_report_to_schedule"/);
    assert.deepEqual(params, [true]);
  });

  it('none compiles NOT EXISTS with the junction correlation', () => {
    const schema = buildSchema();
    const q = makeQuery('reports', schema);
    const { sql } = q.buildFindMany({ where: { schedules: { none: {} } } });
    assert.match(sql, /NOT EXISTS \(SELECT 1 FROM "schedules"/);
    assert.match(sql, /"_report_to_schedule"/);
  });

  it('every compiles NOT EXISTS ... NOT (filter) with the junction correlation', () => {
    const schema = buildSchema();
    const q = makeQuery('reports', schema);
    const { sql, params } = q.buildFindMany({ where: { schedules: { every: { isActive: true } } } });
    assert.match(sql, /NOT EXISTS/);
    assert.match(sql, /"_report_to_schedule"/);
    assert.match(sql, /NOT \("schedules"\."is_active" = \$1\)/);
    assert.deepEqual(params, [true]);
  });

  it('count carries the same junction correlation', () => {
    const schema = buildSchema();
    const q = makeQuery('reports', schema);
    const { sql } = q.buildCount({ where: { schedules: { some: {} } } });
    assert.match(sql, /"_report_to_schedule"/);
    assert.doesNotMatch(sql, /"schedules"\."id" = "reports"\."id"/);
  });

  it('a missing through descriptor throws loudly instead of compiling wrong SQL', () => {
    const schema = buildSchema();
    // biome-ignore lint/suspicious/noExplicitAny: corrupting the fixture on purpose
    (schema.tables.reports!.relations.schedules as any).through = undefined;
    const q = makeQuery('reports', schema);
    assert.throws(() => q.buildFindMany({ where: { schedules: { some: {} } } }), ValidationError);
  });

  it('sql-cache round trip: cached and fresh SQL agree (fingerprint parity)', () => {
    const schema = buildSchema();
    const q = makeQuery('reports', schema);
    const a = q.buildFindMany({ where: { schedules: { some: { isActive: true } } } });
    const b = q.buildFindMany({ where: { schedules: { some: { isActive: false } } } });
    assert.equal(a.sql, b.sql, 'same shape shares one template');
    assert.deepEqual(b.params, [false]);
  });
});
