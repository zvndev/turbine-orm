/**
 * turbine-orm — Relation filter field validation tests
 *
 * Build-only tests (no DB) that verify unknown fields in relation filters
 * (some/every/none) throw a clear ValidationError instead of passing through
 * to Postgres and producing cryptic "column does not exist" errors.
 *
 * Run: npx tsx --test src/test/relation-filter-validation.test.ts
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ValidationError } from '../errors.js';
import type { SchemaMetadata, TableMetadata } from '../schema.js';
import { makeQuery, mockTable } from './helpers.js';

function buildSchema(): SchemaMetadata {
  const tables: Record<string, TableMetadata> = {};

  tables.users = mockTable(
    'users',
    [
      { name: 'id', field: 'id' },
      { name: 'name', field: 'name', pgType: 'text' },
      { name: 'email', field: 'email', pgType: 'text' },
    ],
    {
      posts: {
        type: 'hasMany',
        name: 'posts',
        from: 'users',
        to: 'posts',
        foreignKey: 'user_id',
        referenceKey: 'id',
      },
    },
  );

  tables.posts = mockTable(
    'posts',
    [
      { name: 'id', field: 'id' },
      { name: 'title', field: 'title', pgType: 'text' },
      { name: 'published', field: 'published', pgType: 'bool' },
      { name: 'user_id', field: 'userId', pgType: 'int8' },
    ],
    {
      author: {
        type: 'belongsTo',
        name: 'author',
        from: 'posts',
        to: 'users',
        foreignKey: 'user_id',
        referenceKey: 'id',
      },
    },
  );

  return { tables, enums: {} };
}

describe('relation filter field validation', () => {
  describe('valid fields pass through without error', () => {
    it('some: valid field works', () => {
      const q = makeQuery('users', buildSchema());
      assert.doesNotThrow(() =>
        q.buildFindMany({
          where: { posts: { some: { title: 'hello' } } } as never,
        }),
      );
    });

    it('none: valid field works', () => {
      const q = makeQuery('users', buildSchema());
      assert.doesNotThrow(() =>
        q.buildFindMany({
          where: { posts: { none: { published: true } } } as never,
        }),
      );
    });

    it('every: valid field works', () => {
      const q = makeQuery('users', buildSchema());
      assert.doesNotThrow(() =>
        q.buildFindMany({
          where: { posts: { every: { published: true } } } as never,
        }),
      );
    });

    it('camelCase field that maps to a snake_case column works', () => {
      const q = makeQuery('users', buildSchema());
      assert.doesNotThrow(() =>
        q.buildFindMany({
          where: { posts: { some: { userId: 1 } } } as never,
        }),
      );
    });
  });

  describe('invalid/typo fields throw ValidationError', () => {
    it('some: typo field throws ValidationError with table name', () => {
      const q = makeQuery('users', buildSchema());
      assert.throws(
        () =>
          q.buildFindMany({
            where: { posts: { some: { tittle: 'hello' } } } as never,
          }),
        (err: unknown) => {
          assert.ok(err instanceof ValidationError, 'should be ValidationError');
          assert.match((err as Error).message, /tittle/);
          assert.match((err as Error).message, /posts/);
          return true;
        },
      );
    });

    it('none: unknown field throws ValidationError', () => {
      const q = makeQuery('users', buildSchema());
      assert.throws(
        () =>
          q.buildFindMany({
            where: { posts: { none: { nonExistent: true } } } as never,
          }),
        (err: unknown) => {
          assert.ok(err instanceof ValidationError, 'should be ValidationError');
          assert.match((err as Error).message, /nonExistent/);
          assert.match((err as Error).message, /posts/);
          return true;
        },
      );
    });

    it('every: unknown field throws ValidationError', () => {
      const q = makeQuery('users', buildSchema());
      assert.throws(
        () =>
          q.buildFindMany({
            where: { posts: { every: { bogusField: 'val' } } } as never,
          }),
        (err: unknown) => {
          assert.ok(err instanceof ValidationError, 'should be ValidationError');
          assert.match((err as Error).message, /bogusField/);
          assert.match((err as Error).message, /posts/);
          return true;
        },
      );
    });

    it('error message includes known fields for debugging', () => {
      const q = makeQuery('users', buildSchema());
      assert.throws(
        () =>
          q.buildFindMany({
            where: { posts: { some: { typo: 'x' } } } as never,
          }),
        (err: unknown) => {
          const msg = (err as Error).message;
          // Should list the known fields from the target table
          assert.match(msg, /title/);
          assert.match(msg, /published/);
          assert.match(msg, /userId/);
          return true;
        },
      );
    });

    it('operator on an invalid field also throws', () => {
      const q = makeQuery('users', buildSchema());
      assert.throws(
        () =>
          q.buildFindMany({
            where: { posts: { some: { badCol: { gt: 5 } } } } as never,
          }),
        (err: unknown) => {
          assert.ok(err instanceof ValidationError, 'should be ValidationError');
          assert.match((err as Error).message, /badCol/);
          assert.match((err as Error).message, /posts/);
          return true;
        },
      );
    });

    it('null check on an invalid field throws', () => {
      const q = makeQuery('users', buildSchema());
      assert.throws(
        () =>
          q.buildFindMany({
            where: { posts: { some: { fakeField: null } } } as never,
          }),
        (err: unknown) => {
          assert.ok(err instanceof ValidationError, 'should be ValidationError');
          assert.match((err as Error).message, /fakeField/);
          return true;
        },
      );
    });
  });
});
