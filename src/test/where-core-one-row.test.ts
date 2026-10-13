/**
 * The one-row guard (`findUnique`, `update`, `delete`, `upsert` identity) is
 * satisfied only by a plain scalar or `{ equals: <scalar> }` on every column of
 * a unique key.
 *
 * Each refused shape below used to count as "pinned", and each one matches more
 * than one row: a column reference compiles to `"id" = "id"` (every row), an
 * insensitive match covers every casing, and a range or list is a set. With a
 * write attached, `delete({ where: { id: { equals: col('id') } } })` deleted
 * the table and reported one row.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ValidationError } from '../errors.js';
import { col } from '../query/column-ref.js';
import { upsertWhereMatchesCreate, whereIdentifiesOneRow } from '../query/compound-unique.js';
import { makeQuery } from './helpers.js';
import { accounts, whereCoreSchema } from './where-core-fixture.js';

const schema = whereCoreSchema();
const accountsMeta = schema.tables.accounts!;
const membershipsMeta = schema.tables.memberships!;

describe('what identifies one row', () => {
  const refused: [string, Record<string, unknown>][] = [
    ['a column reference', { id: { equals: col('id') } }],
    ['a parsed { col }', { id: JSON.parse('{"equals":{"col":"id"}}') }],
    ['a bare column reference', { id: col('id') }],
    ['equals with mode insensitive', { email: { equals: 'a@b.c', mode: 'insensitive' } }],
    ['a list', { id: { in: [1] } }],
    ['a closed range', { id: { gte: 1, lte: 1 } }],
    ['a bare array', { id: [1] }],
    ['an empty object', { id: {} }],
    ['null', { id: null }],
    ['equals null', { id: { equals: null } }],
    ['NaN', { id: Number.NaN }],
    ['a key inside OR', { OR: [{ id: 1 }] }],
    ['a non-unique column', { name: 'x' }],
  ];
  for (const [label, where] of refused) {
    it(`refuses ${label}`, () => assert.equal(whereIdentifiesOneRow(accountsMeta, where), false));
  }

  const accepted: [string, Record<string, unknown>][] = [
    ['a number', { id: 1 }],
    ['a bigint', { id: 1n }],
    ['a string', { id: '1' }],
    ['equals', { id: { equals: 1 } }],
    ['equals with mode default', { id: { equals: 1, mode: 'default' } }],
    ['a unique non-key column', { email: 'a@b.c' }],
    ['the key beside a narrowing predicate', { id: 1, name: { contains: 'x' } }],
  ];
  for (const [label, where] of accepted) {
    it(`accepts ${label}`, () => assert.equal(whereIdentifiesOneRow(accountsMeta, where), true));
  }

  it('a compound key needs every column', () => {
    assert.equal(whereIdentifiesOneRow(membershipsMeta, { orgId: 1 }), false);
    assert.equal(whereIdentifiesOneRow(membershipsMeta, { orgId: 1, userId: col('orgId') }), false);
    assert.equal(whereIdentifiesOneRow(membershipsMeta, { orgId: 1, userId: 2 }), true);
  });
});

describe('the guard at each operation', () => {
  const selfRef = { id: { equals: col('id') } };

  it('findUnique', () => {
    assert.throws(
      () => accounts().buildFindUnique({ where: selfRef } as never),
      /findUnique on "accounts" refused: the `where` clause does not identify a single row/,
    );
  });

  it('delete', () => {
    assert.throws(
      () => accounts().buildDelete({ where: selfRef } as never),
      (err: unknown) => {
        assert.ok(err instanceof ValidationError);
        assert.match(err.message, /delete on "accounts" refused/);
        assert.match(err.message, /use `deleteMany` if you meant "every row matching a filter"/);
        return true;
      },
    );
  });

  it('update', () => {
    assert.throws(
      () => accounts().buildUpdate({ where: selfRef, data: { age: 1 } } as never),
      /update on "accounts" refused/,
    );
  });

  it('upsert', () => {
    assert.throws(
      () => accounts().buildUpsert({ where: selfRef, create: { id: 1 }, update: { age: 1 } } as never),
      /upsert on "accounts" refused/,
    );
  });

  it('an insensitive email is not an identity for delete', () => {
    assert.throws(
      () => accounts().buildDelete({ where: { email: { equals: 'A@B.C', mode: 'insensitive' } } } as never),
      /delete on "accounts" refused/,
    );
  });

  it('a compound key still resolves through its selector', () => {
    const q = makeQuery('memberships', schema);
    const { sql } = q.buildFindUnique({ where: { orgId_userId: { orgId: 1, userId: 2 } } } as never);
    assert.match(sql, /"org_id" = \$\d+ AND "user_id" = \$\d+/);
  });
});

describe('upsert: does one conflict statement mean what the call says', () => {
  it('a where key that create leaves out means a lookup, never ON CONFLICT', () => {
    assert.equal(upsertWhereMatchesCreate(membershipsMeta, { orgId: 1, userId: 2 }, { orgId: 1 }), false);
  });

  it('every where key pinned to the value create inserts', () => {
    assert.equal(upsertWhereMatchesCreate(membershipsMeta, { orgId: 1, userId: 2 }, { orgId: 1, userId: 2 }), true);
    assert.equal(upsertWhereMatchesCreate(membershipsMeta, { orgId: 1, userId: 2 }, { orgId: 1, userId: 3 }), false);
  });
});
