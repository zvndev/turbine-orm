/**
 * turbine-orm — Full-text search filter tests
 *
 * Tests the TextSearchFilter integration with the WHERE clause builder.
 * Verifies correct SQL generation with to_tsvector/to_tsquery, custom configs,
 * config validation, and composition with other WHERE conditions.
 *
 * Build-only tests (no DB).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ValidationError } from '../errors.js';
import type { SchemaMetadata, TableMetadata } from '../schema.js';
import { makeQuery, mockTable } from './helpers.js';

// ---------------------------------------------------------------------------
// Build-only test harness (no DB needed)
// ---------------------------------------------------------------------------

function buildSchema(): SchemaMetadata {
  const tables: Record<string, TableMetadata> = {};
  tables.posts = mockTable('posts', [
    { name: 'id', field: 'id' },
    { name: 'title', field: 'title', pgType: 'text' },
    { name: 'body', field: 'body', pgType: 'text' },
    { name: 'published', field: 'published', pgType: 'bool' },
  ]);
  return { tables, enums: {} };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TextSearchFilter', () => {
  it('generates correct SQL with default config (english)', () => {
    const q = makeQuery('posts', buildSchema());
    const { sql, params } = q.buildFindMany({
      where: { title: { search: 'hello & world' } },
    });
    assert.match(sql, /to_tsvector\('english', "title"\) @@ to_tsquery\('english', \$1\)/);
    assert.deepEqual(params, ['hello & world']);
  });

  it('respects custom text search config', () => {
    const q = makeQuery('posts', buildSchema());
    const { sql, params } = q.buildFindMany({
      where: { body: { search: 'gato', config: 'spanish' } },
    });
    assert.match(sql, /to_tsvector\('spanish', "body"\) @@ to_tsquery\('spanish', \$1\)/);
    assert.deepEqual(params, ['gato']);
  });

  it('rejects invalid config with SQL injection attempt', () => {
    const q = makeQuery('posts', buildSchema());
    assert.throws(
      () =>
        q.buildFindMany({
          where: { title: { search: 'test', config: "english'; DROP TABLE posts; --" } },
        }),
      (err: unknown) => {
        assert.ok(err instanceof ValidationError, 'should be ValidationError');
        assert.match((err as Error).message, /Invalid text search config/);
        assert.match((err as Error).message, /alphanumeric/);
        return true;
      },
    );
  });

  it('rejects config with spaces', () => {
    const q = makeQuery('posts', buildSchema());
    assert.throws(
      () =>
        q.buildFindMany({
          where: { title: { search: 'test', config: 'not valid' } },
        }),
      (err: unknown) => {
        assert.ok(err instanceof ValidationError);
        return true;
      },
    );
  });

  it('allows config with underscores', () => {
    const q = makeQuery('posts', buildSchema());
    const { sql } = q.buildFindMany({
      where: { title: { search: 'test', config: 'my_custom_config' } },
    });
    assert.match(sql, /to_tsvector\('my_custom_config'/);
  });

  it('works combined with other WHERE conditions (AND)', () => {
    const q = makeQuery('posts', buildSchema());
    const { sql, params } = q.buildFindMany({
      where: {
        title: { search: 'typescript' },
        published: true,
      },
    });
    assert.match(sql, /to_tsvector\('english', "title"\) @@ to_tsquery\('english', \$1\)/);
    assert.match(sql, /"published" = \$2/);
    assert.deepEqual(params, ['typescript', true]);
  });

  it('works with multiple text search filters on different columns', () => {
    const q = makeQuery('posts', buildSchema());
    const { sql, params } = q.buildFindMany({
      where: {
        title: { search: 'hello' },
        body: { search: 'world' },
      },
    });
    assert.match(sql, /to_tsvector\('english', "title"\) @@ to_tsquery\('english', \$1\)/);
    assert.match(sql, /to_tsvector\('english', "body"\) @@ to_tsquery\('english', \$2\)/);
    assert.deepEqual(params, ['hello', 'world']);
  });
});
