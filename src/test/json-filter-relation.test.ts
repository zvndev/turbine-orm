/**
 * turbine-orm, JsonFilter / ArrayFilter inside relation filters
 *
 * Regression tests for the bug where a JsonFilter on a jsonb column
 * inside a relation `some`/`every`/`none` sub-where was silently dropped:
 * `buildSubWhereForRelation` never checked `isJsonFilter`, so the filter
 * object fell through to the equality branch and bound as a jsonb equality
 * value, compiling to `t."data" = $N` (matches nothing) instead of the
 * `#>>` path extraction the identical top-level filter produces.
 *
 * Also covers the SQL-cache lockstep requirement: the same findMany run
 * twice must produce byte-identical SQL AND identical params (the second run
 * exercises the cache-hit param-collect mirror, collectRelFilterParams).
 *
 * Build-only tests (no DB). Run: npx tsx --test src/test/json-filter-relation.test.ts
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ValidationError } from '../errors.js';
import type { SchemaMetadata, TableMetadata } from '../schema.js';
import { makeQuery, mockTable } from './helpers.js';

function buildSchema(): SchemaMetadata {
  const tables: Record<string, TableMetadata> = {};

  tables.documents = mockTable(
    'documents',
    [
      { name: 'id', field: 'id' },
      { name: 'name', field: 'name', pgType: 'text' },
      { name: 'settings', field: 'settings', pgType: 'jsonb' },
    ],
    {
      documentVersions: {
        type: 'hasMany',
        name: 'documentVersions',
        from: 'documents',
        to: 'document_versions',
        foreignKey: 'document_id',
        referenceKey: 'id',
      },
    },
  );

  tables.document_versions = mockTable(
    'document_versions',
    [
      { name: 'id', field: 'id' },
      { name: 'document_id', field: 'documentId' },
      { name: 'data', field: 'data', pgType: 'jsonb' },
      { name: 'tags', field: 'tags', pgType: '_text' },
      { name: 'status', field: 'status', pgType: 'text' },
    ],
    {
      document: {
        type: 'belongsTo',
        name: 'document',
        from: 'document_versions',
        to: 'documents',
        foreignKey: 'document_id',
        referenceKey: 'id',
      },
      approvals: {
        type: 'hasMany',
        name: 'approvals',
        from: 'document_versions',
        to: 'approvals',
        foreignKey: 'version_id',
        referenceKey: 'id',
      },
    },
  );

  tables.approvals = mockTable('approvals', [
    { name: 'id', field: 'id' },
    { name: 'version_id', field: 'versionId' },
    { name: 'meta', field: 'meta', pgType: 'jsonb' },
  ]);

  return { tables, enums: {} };
}

const JSON_WHERE = {
  documentVersions: {
    some: { data: { path: ['statusEnum', 'value'], equals: 'live' } },
  },
} as never;

describe('JsonFilter inside relation filters', () => {
  it('some: compiles the #>> path extraction (the exact repro)', () => {
    const q = makeQuery('documents', buildSchema());
    const d = q.buildFindMany({ where: JSON_WHERE });
    assert.match(d.sql, /EXISTS \(SELECT 1 FROM "document_versions"/);
    assert.match(d.sql, /"document_versions"\."data" #>> \$1::text\[\] = \$2/);
    assert.deepEqual(d.params, [['statusEnum', 'value'], 'live']);
  });

  it('some: does NOT bind the filter object as a jsonb equality value', () => {
    const q = makeQuery('documents', buildSchema());
    const d = q.buildFindMany({ where: JSON_WHERE });
    assert.doesNotMatch(d.sql, /"data" = \$/);
    // The filter object itself must never appear in params.
    assert.ok(
      d.params.every((p) => typeof p !== 'object' || Array.isArray(p)),
      `filter object leaked into params: ${JSON.stringify(d.params)}`,
    );
  });

  it('none: compiles the path extraction inside NOT EXISTS', () => {
    const q = makeQuery('documents', buildSchema());
    const d = q.buildFindMany({
      where: { documentVersions: { none: { data: { path: ['a'], equals: 'x' } } } } as never,
    });
    assert.match(d.sql, /NOT EXISTS \(SELECT 1 FROM "document_versions"/);
    assert.match(d.sql, /"document_versions"\."data" #>> \$1::text\[\] = \$2/);
    assert.deepEqual(d.params, [['a'], 'x']);
  });

  it('every: compiles the path extraction inside NOT EXISTS ... NOT (...)', () => {
    const q = makeQuery('documents', buildSchema());
    const d = q.buildFindMany({
      where: { documentVersions: { every: { data: { path: ['a'], equals: 'x' } } } } as never,
    });
    assert.match(d.sql, /NOT EXISTS \(SELECT 1 FROM "document_versions" WHERE .* AND NOT \(/);
    assert.match(d.sql, /"document_versions"\."data" #>> \$1::text\[\] = \$2/);
    assert.deepEqual(d.params, [['a'], 'x']);
  });

  it('belongsTo (implicit is): JsonFilter on the parent target compiles', () => {
    const q = makeQuery('document_versions', buildSchema());
    const d = q.buildFindMany({
      where: { document: { settings: { path: ['theme'], equals: 'dark' } } } as never,
    });
    assert.match(d.sql, /EXISTS \(SELECT 1 FROM "documents"/);
    assert.match(d.sql, /"documents"\."settings" #>> \$1::text\[\] = \$2/);
    assert.deepEqual(d.params, [['theme'], 'dark']);
  });

  it('nested relation depth: JsonFilter two levels down compiles', () => {
    const q = makeQuery('documents', buildSchema());
    const d = q.buildFindMany({
      where: {
        documentVersions: {
          some: { approvals: { some: { meta: { path: ['by'], equals: 'qa' } } } },
        },
      } as never,
    });
    assert.match(d.sql, /"approvals"\."meta" #>> \$1::text\[\] = \$2/);
    assert.deepEqual(d.params, [['by'], 'qa']);
  });

  it('other JsonFilter ops compile too (contains, hasKey)', () => {
    const q = makeQuery('documents', buildSchema());
    const d = q.buildFindMany({
      where: {
        documentVersions: { some: { data: { hasKey: 'statusEnum' } } },
      } as never,
    });
    assert.match(d.sql, /"document_versions"\."data" \? \$1/);
    assert.deepEqual(d.params, ['statusEnum']);

    const d2 = makeQuery('documents', buildSchema()).buildFindMany({
      where: { documentVersions: { some: { data: { path: ['a'], equals: 'x', contains: { b: 1 } } } } } as never,
    });
    assert.match(d2.sql, /"document_versions"\."data" @> \$\d::jsonb/);
  });

  it('ArrayFilter inside a relation filter compiles (same hole, array columns)', () => {
    const q = makeQuery('documents', buildSchema());
    const d = q.buildFindMany({
      where: { documentVersions: { some: { tags: { has: 'beta' } } } } as never,
    });
    assert.match(d.sql, /\$1 = ANY\("document_versions"\."tags"\)/);
    assert.deepEqual(d.params, ['beta']);
  });

  it('JSON-unique operator on a non-JSON column in a relation filter throws', () => {
    const q = makeQuery('documents', buildSchema());
    assert.throws(
      () =>
        q.buildFindMany({
          where: { documentVersions: { some: { status: { path: ['a'], equals: 'x' } } } } as never,
        }),
      (err: unknown) => err instanceof ValidationError && /not a JSON column/.test((err as Error).message),
    );
  });

  it('array operator on a non-array column in a relation filter throws', () => {
    const q = makeQuery('documents', buildSchema());
    assert.throws(
      () =>
        q.buildFindMany({
          where: { documentVersions: { some: { status: { has: 'x' } } } } as never,
        }),
      (err: unknown) => err instanceof ValidationError && /not an array column/.test((err as Error).message),
    );
  });

  describe('SQL-cache lockstep (cache-hit param collection)', () => {
    it('running the exact same findMany twice yields identical SQL and params', () => {
      const q = makeQuery('documents', buildSchema());
      const first = q.buildFindMany({ where: JSON_WHERE });
      const second = q.buildFindMany({ where: JSON_WHERE });
      assert.equal(second.sql, first.sql);
      assert.deepEqual(second.params, first.params);
    });

    it('a cache hit with different values binds the new values in the same slots', () => {
      const q = makeQuery('documents', buildSchema());
      const first = q.buildFindMany({ where: JSON_WHERE });
      const third = q.buildFindMany({
        where: {
          documentVersions: { some: { data: { path: ['statusEnum', 'value'], equals: 'archived' } } },
        } as never,
      });
      assert.equal(third.sql, first.sql, 'same shape must reuse the cached SQL');
      assert.deepEqual(third.params, [['statusEnum', 'value'], 'archived']);
    });

    it('JsonFilter and plain-equality shapes never share a cache entry', () => {
      const q = makeQuery('documents', buildSchema());
      const json = q.buildFindMany({ where: JSON_WHERE });
      const eq = q.buildFindMany({
        where: { documentVersions: { some: { status: 'live' } } } as never,
      });
      assert.notEqual(json.sql, eq.sql);
    });

    it('mixed sub-where (equality + json) keeps canonical param order on repeat', () => {
      const where = {
        documentVersions: {
          some: {
            status: 'published',
            data: { path: ['statusEnum', 'value'], equals: 'live' },
          },
        },
      } as never;
      const q = makeQuery('documents', buildSchema());
      const first = q.buildFindMany({ where });
      const second = q.buildFindMany({ where });
      assert.equal(second.sql, first.sql);
      assert.deepEqual(second.params, first.params);
      // Sorted key order: data (json) before status (equality).
      assert.deepEqual(first.params, [['statusEnum', 'value'], 'live', 'published']);
    });
  });

  describe('with.where (relation subquery filter), same bug class', () => {
    it('JsonFilter in a with.where compiles against the relation alias', () => {
      const q = makeQuery('documents', buildSchema());
      const d = q.buildFindMany({
        with: {
          documentVersions: { where: { data: { path: ['statusEnum', 'value'], equals: 'live' } } },
        } as never,
      });
      assert.match(d.sql, /t\d+\."data" #>> \$1::text\[\] = \$2/);
      assert.deepEqual(d.params, [['statusEnum', 'value'], 'live']);
    });

    it('with.where JsonFilter run twice yields identical SQL and params', () => {
      const args = {
        with: {
          documentVersions: { where: { data: { path: ['statusEnum', 'value'], equals: 'live' } } },
        },
      } as never;
      const q = makeQuery('documents', buildSchema());
      const first = q.buildFindMany(args);
      const second = q.buildFindMany(args);
      assert.equal(second.sql, first.sql);
      assert.deepEqual(second.params, first.params);
    });

    it('ArrayFilter in a with.where compiles against the relation alias', () => {
      const q = makeQuery('documents', buildSchema());
      const d = q.buildFindMany({
        with: { documentVersions: { where: { tags: { has: 'beta' } } } } as never,
      });
      assert.match(d.sql, /\$1 = ANY\(t\d+\."tags"\)/);
      assert.deepEqual(d.params, ['beta']);
    });
  });
});
