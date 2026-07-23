/**
 * turbine-orm, Prisma compound-unique `where` selectors (finding 7)
 *
 * Build-only assertions that a synthetic selector key (`orgId_userId`) expands to
 * its column conjunction across findUnique / update / delete / upsert, is
 * byte-identical to the spelled-out form (and shares its SQL cache entry), and
 * that real fields always win over a colliding synthetic name.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ValidationError } from '../errors.js';
import type { SchemaMetadata, TableMetadata } from '../schema.js';
import { makeQuery, mockTable } from './helpers.js';

/** A `memberships` table with a composite UNIQUE constraint on (org_id, user_id). */
function schema(overrides?: (t: TableMetadata) => void): SchemaMetadata {
  const memberships = mockTable('memberships', [
    { name: 'id', field: 'id' },
    { name: 'org_id', field: 'orgId' },
    { name: 'user_id', field: 'userId' },
    { name: 'role', field: 'role', pgType: 'text' },
  ]);
  memberships.primaryKey = ['id'];
  memberships.uniqueColumns = [['id'], ['org_id', 'user_id']];
  overrides?.(memberships);
  return { enums: {}, tables: { memberships } };
}

describe('compound-unique selector, findUnique', () => {
  it('expands to the column conjunction, byte-identical to the spelled-out form', () => {
    const q = makeQuery('memberships', schema());
    const compound = q.buildFindUnique({ where: { orgId_userId: { orgId: 1, userId: 2 } } } as never);
    const spelled = q.buildFindUnique({ where: { orgId: 1, userId: 2 } } as never);
    assert.match(compound.sql, /WHERE "org_id" = \$1 AND "user_id" = \$2 LIMIT 1$/);
    assert.equal(compound.sql, spelled.sql, 'expanded selector must build identical SQL');
    assert.deepEqual(compound.params, [1, 2]);
    assert.deepEqual(spelled.params, [1, 2]);
  });

  it('the snake_case alias resolves to the same expansion', () => {
    const q = makeQuery('memberships', schema());
    const snake = q.buildFindUnique({ where: { org_id_user_id: { orgId: 5, userId: 6 } } } as never);
    assert.match(snake.sql, /WHERE "org_id" = \$1 AND "user_id" = \$2 LIMIT 1$/);
    assert.deepEqual(snake.params, [5, 6]);
  });

  it('a wrong member set throws a clear E003 naming the required members', () => {
    const q = makeQuery('memberships', schema());
    assert.throws(
      () => q.buildFindUnique({ where: { orgId_userId: { orgId: 1 } } } as never),
      (err: unknown) => err instanceof ValidationError && /must supply exactly \{ orgId, userId \}/.test(err.message),
    );
  });

  it('a real column that collides with a synthetic name is never expanded', () => {
    // Give the table a real field literally named `orgId_userId`.
    const q = makeQuery(
      'memberships',
      schema((t) => {
        t.columns.push({
          name: 'org_user_key',
          field: 'orgId_userId',
          pgType: 'int8',
          tsType: 'number',
          nullable: false,
          hasDefault: false,
          isArray: false,
          pgArrayType: 'bigint[]',
        });
        t.columnMap.orgId_userId = 'org_user_key';
        t.reverseColumnMap.org_user_key = 'orgId_userId';
        t.allColumns.push('org_user_key');
      }),
    );
    const { sql, params } = q.buildFindUnique({ where: { orgId_userId: 42 } } as never);
    assert.match(sql, /WHERE "org_user_key" = \$1 LIMIT 1$/);
    assert.deepEqual(params, [42]);
  });

  it('a member also given directly is AND-wrapped, never clobbered', () => {
    const q = makeQuery('memberships', schema());
    const { sql, params } = q.buildFindUnique({
      where: { orgId: 9, orgId_userId: { orgId: 9, userId: 3 } },
    } as never);
    // orgId is present twice (outer + selector) → the expansion goes under AND so
    // neither value is clobbered: BOTH org_id constraints and user_id survive.
    assert.match(sql, /"org_id" = \$\d+ AND "org_id" = \$\d+/);
    assert.match(sql, /"user_id" = \$\d+/);
    assert.deepEqual(params, [9, 9, 3]);
  });
});

describe('compound-unique selector, writes', () => {
  it('update expands the where before the empty-guard and SET compile', () => {
    const q = makeQuery('memberships', schema());
    const { sql, params } = q.buildUpdate({
      where: { orgId_userId: { orgId: 1, userId: 2 } },
      data: { role: 'admin' },
    } as never);
    assert.match(sql, /WHERE "org_id" = \$2 AND "user_id" = \$3/);
    assert.deepEqual(params, ['admin', 1, 2]);
  });

  it('delete expands the where', () => {
    const q = makeQuery('memberships', schema());
    const { sql, params } = q.buildDelete({ where: { orgId_userId: { orgId: 7, userId: 8 } } } as never);
    assert.match(sql, /WHERE "org_id" = \$1 AND "user_id" = \$2/);
    assert.deepEqual(params, [7, 8]);
  });

  it('upsert derives the conflict target from the expanded members', () => {
    const q = makeQuery('memberships', schema());
    const { sql } = q.buildUpsert({
      where: { orgId_userId: { orgId: 1, userId: 2 } },
      create: { orgId: 1, userId: 2, role: 'member' },
      update: { role: 'member' },
    } as never);
    assert.match(sql, /ON CONFLICT \("org_id", "user_id"\)/);
  });
});

describe('compound-unique selector, code-first declared unique index', () => {
  it('sources the selector from a composite UNIQUE index (defineSchema path)', () => {
    // No composite uniqueColumns, only a declared unique index carries it.
    const s = schema((t) => {
      t.uniqueColumns = [['id']];
      t.indexes = [
        { name: 'uq_org_user', columns: ['org_id', 'user_id'], unique: true, definition: '', declared: true },
      ];
    });
    const q = makeQuery('memberships', s);
    const { sql, params } = q.buildFindUnique({ where: { orgId_userId: { orgId: 3, userId: 4 } } } as never);
    assert.match(sql, /WHERE "org_id" = \$1 AND "user_id" = \$2 LIMIT 1$/);
    assert.deepEqual(params, [3, 4]);
  });
});
