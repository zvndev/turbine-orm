/**
 * turbine-orm: column-to-column where comparison (Capa item 4c)
 *
 * `{ currentVersionId: { equals: { col: 'publishedVersionId' } } }` compiles
 * to `"current_version_id" = "published_version_id"`: a ColumnRef marker
 * accepted by equals/not/gt/gte/lt/lte, resolved through the table's
 * columnMap and quoted, with NO param bound.
 *
 * Cache safety: the referenced column lives in the SQL TEXT, so it is part of
 * the where fingerprint (distinct refs never share a cache entry) and the
 * param-collect mirror pushes nothing for it.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ValidationError } from '../errors.js';
import type { SchemaMetadata } from '../schema.js';
import { makeQuery, mockTable } from './helpers.js';

function schema(): SchemaMetadata {
  return {
    enums: {},
    tables: {
      documents: mockTable(
        'documents',
        [
          { name: 'id', field: 'id' },
          { name: 'title', field: 'title', pgType: 'text' },
          { name: 'current_version_id', field: 'currentVersionId' },
          { name: 'published_version_id', field: 'publishedVersionId' },
          // camelCase-named DB column
          { name: 'draftVersionId', field: 'draftVersionId' },
        ],
        {
          versions: {
            type: 'hasMany',
            name: 'versions',
            from: 'documents',
            to: 'versions',
            foreignKey: 'document_id',
            referenceKey: 'id',
          },
        },
      ),
      versions: mockTable('versions', [
        { name: 'id', field: 'id' },
        { name: 'document_id', field: 'documentId' },
        { name: 'parent_id', field: 'parentId' },
        { name: 'supersedes_id', field: 'supersedesId' },
      ]),
    },
  };
}

describe('column-ref where: operators', () => {
  const cases: [string, string][] = [
    ['equals', '='],
    ['not', '!='],
    ['gt', '>'],
    ['gte', '>='],
    ['lt', '<'],
    ['lte', '<='],
  ];

  for (const [op, sqlOp] of cases) {
    it(`${op} → "current_version_id" ${sqlOp} "published_version_id", no param bound`, () => {
      const q = makeQuery('documents', schema());
      const { sql, params } = q.buildFindMany({
        where: { currentVersionId: { [op]: { col: 'publishedVersionId' } } },
      } as never);
      assert.ok(sql.includes(`"current_version_id" ${sqlOp} "published_version_id"`), sql);
      assert.deepEqual(params, []);
    });
  }

  it('the exact Capa "published_with_draft" filter shape', () => {
    const q = makeQuery('documents', schema());
    const { sql, params } = q.buildFindMany({
      where: {
        publishedVersionId: { not: null },
        currentVersionId: { not: { col: 'publishedVersionId' } },
      },
    } as never);
    assert.ok(sql.includes('"published_version_id" IS NOT NULL'), sql);
    assert.ok(sql.includes('"current_version_id" != "published_version_id"'), sql);
    assert.deepEqual(params, []);
  });

  it('resolves a camelCase-named DB column reference', () => {
    const q = makeQuery('documents', schema());
    const { sql, params } = q.buildFindMany({
      where: { currentVersionId: { equals: { col: 'draftVersionId' } } },
    } as never);
    assert.ok(sql.includes('"current_version_id" = "draftVersionId"'), sql);
    assert.deepEqual(params, []);
  });

  it('mixes with value-bound operators: params stay in lockstep', () => {
    const q = makeQuery('documents', schema());
    const { sql, params } = q.buildFindMany({
      where: {
        currentVersionId: { equals: { col: 'publishedVersionId' } },
        title: { contains: 'draft' },
      },
    } as never);
    assert.ok(sql.includes('"current_version_id" = "published_version_id"'), sql);
    assert.ok(sql.includes('"title" LIKE $1'), sql);
    assert.deepEqual(params, ['%draft%']);
  });
});

describe('column-ref where: validation', () => {
  it('unknown referenced field throws E003 with the known-fields list', () => {
    const q = makeQuery('documents', schema());
    assert.throws(
      () => q.buildFindMany({ where: { currentVersionId: { equals: { col: 'bogusField' } } } } as never),
      (err: unknown) => {
        assert.ok(err instanceof ValidationError);
        assert.match(err.message, /Unknown field "bogusField" referenced by \{ col \} in where on table "documents"/);
        assert.match(err.message, /Known fields:.*publishedVersionId/);
        return true;
      },
    );
  });

  it("mode: 'insensitive' with a column reference throws a clear E003 (documented: unsupported)", () => {
    const q = makeQuery('documents', schema());
    assert.throws(
      () =>
        q.buildFindMany({
          where: { currentVersionId: { equals: { col: 'publishedVersionId' }, mode: 'insensitive' } },
        } as never),
      (err: unknown) => {
        assert.ok(err instanceof ValidationError);
        assert.match(err.message, /mode: 'insensitive' cannot be combined with a column reference/);
        return true;
      },
    );
  });

  it('a bare { col } outside an operator keeps the unknown-operator error', () => {
    const q = makeQuery('documents', schema());
    assert.throws(
      () => q.buildFindMany({ where: { currentVersionId: { col: 'publishedVersionId' } } } as never),
      /Unknown operator "col"/,
    );
  });

  it('non-string col and extra keys are NOT treated as a column reference', () => {
    const q = makeQuery('documents', schema());
    // { col: 7 } → plain object equality value → strict-validation throw (not a silent ref)
    assert.throws(
      () => q.buildFindMany({ where: { currentVersionId: { equals: { col: 7 } } } } as never),
      /objects are only valid 'equals' values on JSON/,
    );
  });
});

describe('column-ref where: combinators and relation scopes', () => {
  it('works inside AND / OR branches', () => {
    const q = makeQuery('documents', schema());
    const { sql, params } = q.buildFindMany({
      where: {
        OR: [{ currentVersionId: { equals: { col: 'publishedVersionId' } } }, { title: 'x' }],
        AND: [{ currentVersionId: { gt: { col: 'draftVersionId' } } }],
      },
    } as never);
    assert.ok(sql.includes('"current_version_id" = "published_version_id"'), sql);
    assert.ok(sql.includes('"current_version_id" > "draftVersionId"'), sql);
    assert.deepEqual(params, ['x']);
  });

  it('works inside a relation some: table-qualified against the target', () => {
    const q = makeQuery('documents', schema());
    const { sql, params } = q.buildFindMany({
      where: { versions: { some: { parentId: { not: { col: 'supersedesId' } } } } },
    } as never);
    assert.ok(sql.includes('"versions"."parent_id" != "versions"."supersedes_id"'), sql);
    assert.deepEqual(params, []);
  });

  it('works inside with.where: alias-qualified against the relation alias', () => {
    const q = makeQuery('documents', schema());
    const { sql, params } = q.buildFindMany({
      with: { versions: { where: { parentId: { equals: { col: 'supersedesId' } } } } },
    } as never);
    assert.ok(sql.includes('t0."parent_id" = t0."supersedes_id"'), sql);
    assert.deepEqual(params, []);
  });
});

describe('column-ref where: cache safety', () => {
  it('double-run identity: cache hit collects identical SQL and params', () => {
    const q = makeQuery('documents', schema());
    const args = {
      where: { currentVersionId: { not: { col: 'publishedVersionId' } }, title: { contains: 'a' } },
      with: { versions: { where: { parentId: { equals: { col: 'supersedesId' } } } } },
    } as never;
    const first = q.buildFindMany(args);
    const second = q.buildFindMany(args);
    assert.equal(second.sql, first.sql);
    assert.deepEqual(second.params, first.params);
    assert.deepEqual(first.params, ['%a%']);
  });

  it('distinct referenced columns produce distinct SQL (never share a cache entry)', () => {
    const q = makeQuery('documents', schema());
    const a = q.buildFindMany({ where: { currentVersionId: { equals: { col: 'publishedVersionId' } } } } as never);
    const b = q.buildFindMany({ where: { currentVersionId: { equals: { col: 'draftVersionId' } } } } as never);
    assert.notEqual(a.sql, b.sql);
    assert.ok(a.sql.includes('"published_version_id"'), a.sql);
    assert.ok(b.sql.includes('"draftVersionId"'), b.sql);
  });

  it('fingerprintWhere distinguishes the referenced field and ref-vs-value shape', () => {
    const q = makeQuery('documents', schema());
    const fpRefA = q.fingerprintWhere({ currentVersionId: { equals: { col: 'publishedVersionId' } } });
    const fpRefB = q.fingerprintWhere({ currentVersionId: { equals: { col: 'draftVersionId' } } });
    const fpValue = q.fingerprintWhere({ currentVersionId: { equals: 42 } });
    assert.notEqual(fpRefA, fpRefB);
    assert.notEqual(fpRefA, fpValue);
    assert.notEqual(fpRefB, fpValue);
  });
});
