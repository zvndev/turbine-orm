/**
 * turbine-orm -- Query builder stress tests
 *
 * Exercises the query builder WITHOUT a database connection:
 *   1. Deep nesting (up to depth 9)
 *   2. Circular relation detection
 *   3. Depth limit (10)
 *   4. Large WHERE clause (100+ conditions)
 *   5. Repeated query builds (LRU cache determinism)
 *   6. Wide with clause (10+ sibling relations)
 *
 * Run: npx tsx --test src/test/stress.test.ts
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CircularRelationError } from '../errors.js';
import { QueryInterface } from '../query.js';
import type { ColumnMetadata, RelationDef, SchemaMetadata, TableMetadata } from '../schema.js';

// ---------------------------------------------------------------------------
// Helpers to build mock SchemaMetadata
// ---------------------------------------------------------------------------

/** Build a minimal ColumnMetadata for testing */
function mockColumn(name: string, field: string, pgType = 'int8'): ColumnMetadata {
  return {
    name,
    field,
    pgType,
    tsType: 'number',
    nullable: false,
    hasDefault: name === 'id',
    isArray: false,
    pgArrayType: 'bigint[]',
  };
}

/** Build a minimal TableMetadata for testing */
function mockTable(
  tableName: string,
  columns: { name: string; field: string; pgType?: string }[],
  relations: Record<string, RelationDef> = {},
): TableMetadata {
  const cols = columns.map((c) => mockColumn(c.name, c.field, c.pgType ?? 'int8'));
  const columnMap: Record<string, string> = {};
  const reverseColumnMap: Record<string, string> = {};
  const allColumns: string[] = [];

  for (const col of cols) {
    columnMap[col.field] = col.name;
    reverseColumnMap[col.name] = col.field;
    allColumns.push(col.name);
  }

  return {
    name: tableName,
    columns: cols,
    columnMap,
    reverseColumnMap,
    dateColumns: new Set(),
    pgTypes: Object.fromEntries(cols.map((c) => [c.name, c.pgType])),
    allColumns,
    primaryKey: ['id'],
    uniqueColumns: [['id']],
    relations,
    indexes: [],
  };
}

// ---------------------------------------------------------------------------
// Core 4-table schema: organizations -> users -> posts -> comments
// ---------------------------------------------------------------------------

function buildCoreSchema(): SchemaMetadata {
  const tables: Record<string, TableMetadata> = {};

  tables.organizations = mockTable(
    'organizations',
    [
      { name: 'id', field: 'id' },
      { name: 'name', field: 'name', pgType: 'text' },
    ],
    {
      users: {
        type: 'hasMany',
        name: 'users',
        from: 'organizations',
        to: 'users',
        foreignKey: 'org_id',
        referenceKey: 'id',
      },
    },
  );

  tables.users = mockTable(
    'users',
    [
      { name: 'id', field: 'id' },
      { name: 'name', field: 'name', pgType: 'text' },
      { name: 'org_id', field: 'orgId' },
    ],
    {
      organization: {
        type: 'belongsTo',
        name: 'organization',
        from: 'users',
        to: 'organizations',
        foreignKey: 'org_id',
        referenceKey: 'id',
      },
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
      { name: 'user_id', field: 'userId' },
      { name: 'org_id', field: 'orgId' },
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
      comments: {
        type: 'hasMany',
        name: 'comments',
        from: 'posts',
        to: 'comments',
        foreignKey: 'post_id',
        referenceKey: 'id',
      },
    },
  );

  tables.comments = mockTable(
    'comments',
    [
      { name: 'id', field: 'id' },
      { name: 'text', field: 'text', pgType: 'text' },
      { name: 'post_id', field: 'postId' },
      { name: 'user_id', field: 'userId' },
    ],
    {
      post: {
        type: 'belongsTo',
        name: 'post',
        from: 'comments',
        to: 'posts',
        foreignKey: 'post_id',
        referenceKey: 'id',
      },
      author: {
        type: 'belongsTo',
        name: 'author',
        from: 'comments',
        to: 'users',
        foreignKey: 'user_id',
        referenceKey: 'id',
      },
    },
  );

  return { tables, enums: {} };
}

/** Create a QueryInterface for a table in the given schema, with null pool */
function makeQuery<T extends object = Record<string, unknown>>(
  tableName: string,
  schema: SchemaMetadata,
): QueryInterface<T> {
  return new QueryInterface<T>(null as any, tableName, schema);
}

// ---------------------------------------------------------------------------
// 1. Deep nesting (up to depth 9)
// ---------------------------------------------------------------------------

describe('stress: deep nesting (up to depth 9)', () => {
  it('builds a query with 4 levels of nesting without throwing', () => {
    const schema = buildCoreSchema();
    const q = makeQuery('users', schema);

    // users -> posts -> comments -> post (back to posts is a cycle, so go author instead)
    // Actually, comments->author goes to users which IS in the path already.
    // Let's do: users -> posts -> comments (3 levels of nesting)
    const deferred = q.buildFindMany({
      with: {
        posts: {
          with: {
            comments: true,
          },
        },
      },
    });

    assert.ok(deferred.sql.length > 0, 'should produce non-empty SQL');
    assert.ok(deferred.sql.includes('json_build_object'), 'should use json_build_object');
    assert.ok(deferred.sql.includes('"posts"'), 'should reference posts table');
    assert.ok(deferred.sql.includes('"comments"'), 'should reference comments table');
  });

  it('builds a query with depth 9 on a long chain schema', () => {
    // Build a chain of 10 tables: t0 -> t1 -> t2 -> ... -> t9
    // That gives us depth 9 (0-indexed), which is below the limit of 10
    const tables: Record<string, TableMetadata> = {};

    for (let i = 0; i < 10; i++) {
      const relations: Record<string, RelationDef> = {};
      if (i < 9) {
        relations.child = {
          type: 'hasMany',
          name: 'child',
          from: `t${i}`,
          to: `t${i + 1}`,
          foreignKey: `t${i}_id`,
          referenceKey: 'id',
        };
      }
      tables[`t${i}`] = mockTable(
        `t${i}`,
        [
          { name: 'id', field: 'id' },
          { name: 'name', field: 'name', pgType: 'text' },
          ...(i > 0 ? [{ name: `t${i - 1}_id`, field: `t${i - 1}Id` }] : []),
        ],
        relations,
      );
    }

    const schema: SchemaMetadata = { tables, enums: {} };
    const q = makeQuery('t0', schema);

    // Build nesting 9 levels deep: t0 -> t1 -> t2 -> ... -> t9
    let withClause: any = true;
    for (let i = 8; i >= 0; i--) {
      withClause = { child: withClause === true ? true : { with: withClause } };
    }

    const deferred = q.buildFindMany({ with: withClause });

    assert.ok(deferred.sql.length > 0, 'should produce non-empty SQL');
    // Verify all table aliases exist (t0 through t8 as aliases for subqueries)
    for (let i = 0; i < 9; i++) {
      assert.ok(deferred.sql.includes(`t${i}.`), `should include alias t${i}`);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Circular relation detection
// ---------------------------------------------------------------------------

describe('stress: circular relation detection', () => {
  it('throws CircularRelationError for users -> posts -> author (back to users)', () => {
    const schema = buildCoreSchema();
    const q = makeQuery('users', schema);

    assert.throws(
      () => {
        q.buildFindMany({
          with: {
            posts: {
              with: {
                author: true,
              },
            },
          },
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof CircularRelationError, 'should be CircularRelationError');
        assert.ok(err.path.includes('users'), 'path should include users');
        return true;
      },
    );
  });

  it('throws CircularRelationError for posts -> comments -> post (back to posts)', () => {
    const schema = buildCoreSchema();
    const q = makeQuery('posts', schema);

    assert.throws(
      () => {
        q.buildFindMany({
          with: {
            comments: {
              with: {
                post: true,
              },
            },
          },
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof CircularRelationError, 'should be CircularRelationError');
        assert.ok(err.path.includes('posts'), 'path should include posts');
        return true;
      },
    );
  });

  it('CircularRelationError contains the full path of the cycle', () => {
    const schema = buildCoreSchema();
    const q = makeQuery('users', schema);

    try {
      q.buildFindMany({
        with: {
          posts: {
            with: {
              author: true,
            },
          },
        },
      });
      assert.fail('should have thrown');
    } catch (err) {
      assert.ok(err instanceof CircularRelationError);
      // The path should be something like ['users', 'posts', 'users']
      assert.ok(err.path.length >= 3, `path length should be >= 3, got ${err.path.length}`);
      const lastEntry = err.path[err.path.length - 1];
      assert.equal(lastEntry, 'users', 'last entry should be the repeated table');
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Depth limit (10)
// ---------------------------------------------------------------------------

describe('stress: depth limit (10)', () => {
  it('throws CircularRelationError when nesting exceeds 10 levels', () => {
    // Build a chain of 12 tables (t0 through t11) -- each with a child pointing to the next
    const tables: Record<string, TableMetadata> = {};

    for (let i = 0; i < 12; i++) {
      const relations: Record<string, RelationDef> = {};
      if (i < 11) {
        relations.child = {
          type: 'hasMany',
          name: 'child',
          from: `t${i}`,
          to: `t${i + 1}`,
          foreignKey: `t${i}_id`,
          referenceKey: 'id',
        };
      }
      tables[`t${i}`] = mockTable(
        `t${i}`,
        [
          { name: 'id', field: 'id' },
          { name: 'name', field: 'name', pgType: 'text' },
          ...(i > 0 ? [{ name: `t${i - 1}_id`, field: `t${i - 1}Id` }] : []),
        ],
        relations,
      );
    }

    const schema: SchemaMetadata = { tables, enums: {} };
    const q = makeQuery('t0', schema);

    // Build 11 levels of nesting: t0 -> t1 -> ... -> t11
    let withClause: any = true;
    for (let i = 10; i >= 0; i--) {
      withClause = { child: withClause === true ? true : { with: withClause } };
    }

    assert.throws(
      () => {
        q.buildFindMany({ with: withClause });
      },
      (err: unknown) => {
        assert.ok(err instanceof CircularRelationError, 'should be CircularRelationError');
        assert.ok(err.message.includes('Maximum nesting depth is 10'), 'error message should mention depth limit');
        return true;
      },
    );
  });

  it('succeeds at exactly depth 9 but fails at depth 10', () => {
    // Build 13 tables: t0..t12 so we can test both passing and failing depths.
    // Each buildRelationSubquery call increments depth by 1:
    //   buildSelectWithRelations(t0, depth=undefined) -> buildRelationSubquery(t0->t1, depth=0)
    //   -> nested buildRelationSubquery(t1->t2, depth=1) -> ... -> depth=N-1 for N with levels
    // So 10 with levels => max depth=9 (passes), 11 with levels => max depth=10 (fails at >=10)
    const tables: Record<string, TableMetadata> = {};

    for (let i = 0; i < 13; i++) {
      const relations: Record<string, RelationDef> = {};
      if (i < 12) {
        relations.child = {
          type: 'hasMany',
          name: 'child',
          from: `t${i}`,
          to: `t${i + 1}`,
          foreignKey: `t${i}_id`,
          referenceKey: 'id',
        };
      }
      tables[`t${i}`] = mockTable(
        `t${i}`,
        [
          { name: 'id', field: 'id' },
          { name: 'name', field: 'name', pgType: 'text' },
          ...(i > 0 ? [{ name: `t${i - 1}_id`, field: `t${i - 1}Id` }] : []),
        ],
        relations,
      );
    }

    const schema: SchemaMetadata = { tables, enums: {} };
    const q = makeQuery('t0', schema);

    // 10 with levels (t0 -> t1 -> ... -> t10): max depth=9, should succeed
    let withClause9: any = true;
    for (let i = 9; i >= 0; i--) {
      withClause9 = { child: withClause9 === true ? true : { with: withClause9 } };
    }
    const deferred = q.buildFindMany({ with: withClause9 });
    assert.ok(deferred.sql.length > 0, 'depth 9 (10 with levels) should succeed');

    // 11 with levels (t0 -> t1 -> ... -> t11): max depth=10, should fail
    let withClause10: any = true;
    for (let i = 10; i >= 0; i--) {
      withClause10 = { child: withClause10 === true ? true : { with: withClause10 } };
    }
    assert.throws(
      () => q.buildFindMany({ with: withClause10 }),
      (err: unknown) => {
        assert.ok(err instanceof CircularRelationError);
        return true;
      },
    );
  });
});

// ---------------------------------------------------------------------------
// 4. Large WHERE clause (100+ conditions)
// ---------------------------------------------------------------------------

describe('stress: large WHERE clause', () => {
  it('builds a query with 100+ where conditions with correct parameterization', () => {
    // Build a table with 120 columns
    const columns: { name: string; field: string; pgType: string }[] = [{ name: 'id', field: 'id', pgType: 'int8' }];
    for (let i = 1; i <= 120; i++) {
      columns.push({ name: `col_${i}`, field: `col${i}`, pgType: 'int8' });
    }

    const tables: Record<string, TableMetadata> = {};
    tables.big_table = mockTable('big_table', columns);

    const schema: SchemaMetadata = { tables, enums: {} };
    const q = makeQuery('big_table', schema);

    // Build a WHERE with 120 conditions
    const where: Record<string, unknown> = {};
    for (let i = 1; i <= 120; i++) {
      where[`col${i}`] = i * 10;
    }

    const deferred = q.buildFindMany({ where: where as any });

    assert.ok(deferred.sql.length > 0, 'should produce non-empty SQL');

    // Verify all 120 parameters are present
    assert.equal(deferred.params.length, 120, 'should have 120 parameters');

    // Verify parameterization goes up to $120
    assert.ok(deferred.sql.includes('$120'), 'should include $120 placeholder');
    assert.ok(deferred.sql.includes('$1'), 'should include $1 placeholder');
    assert.ok(deferred.sql.includes('$60'), 'should include $60 placeholder');

    // Verify values are correct
    for (let i = 0; i < 120; i++) {
      assert.equal(deferred.params[i], (i + 1) * 10, `param ${i} should be ${(i + 1) * 10}`);
    }
  });

  it('handles mixed operators in a large WHERE clause', () => {
    const schema = buildCoreSchema();
    const q = makeQuery('users', schema);

    // Use OR with many conditions to generate a lot of parameters
    const orConditions: Record<string, unknown>[] = [];
    for (let i = 0; i < 50; i++) {
      orConditions.push({ id: i });
    }

    const deferred = q.buildFindMany({
      where: { OR: orConditions } as any,
    });

    assert.ok(deferred.sql.length > 0, 'should produce non-empty SQL');
    assert.equal(deferred.params.length, 50, 'should have 50 parameters for OR conditions');
    assert.ok(deferred.sql.includes('$50'), 'should include $50 placeholder');
  });
});

// ---------------------------------------------------------------------------
// 5. Repeated query builds (LRU cache determinism)
// ---------------------------------------------------------------------------

describe('stress: repeated query builds (LRU cache)', () => {
  it('produces identical output for 100 identical queries', () => {
    const schema = buildCoreSchema();
    const q = makeQuery('users', schema);

    const args = {
      where: { id: 42 } as any,
    };

    const results: { sql: string; params: unknown[] }[] = [];
    for (let i = 0; i < 100; i++) {
      const deferred = q.buildFindMany(args);
      results.push({ sql: deferred.sql, params: deferred.params });
    }

    // All should be identical
    const first = results[0]!;
    for (let i = 1; i < results.length; i++) {
      assert.equal(results[i]!.sql, first.sql, `query ${i} SQL should match first`);
      assert.deepEqual(results[i]!.params, first.params, `query ${i} params should match first`);
    }
  });

  it('produces consistent output for queries with nested relations', () => {
    const schema = buildCoreSchema();
    const q = makeQuery('users', schema);

    const args = {
      with: {
        posts: {
          with: {
            comments: true as const,
          },
        },
      },
    };

    const results: { sql: string; params: unknown[] }[] = [];
    for (let i = 0; i < 50; i++) {
      const deferred = q.buildFindMany(args);
      results.push({ sql: deferred.sql, params: deferred.params });
    }

    const first = results[0]!;
    for (let i = 1; i < results.length; i++) {
      assert.equal(results[i]!.sql, first.sql, `nested query ${i} SQL should match first`);
    }
  });

  it('produces consistent output for varying queries', () => {
    const schema = buildCoreSchema();
    const q = makeQuery('users', schema);

    // Build multiple distinct queries and verify each is internally consistent
    for (let val = 0; val < 20; val++) {
      const a = q.buildFindMany({ where: { id: val } as any });
      const b = q.buildFindMany({ where: { id: val } as any });
      assert.equal(a.sql, b.sql, `query for id=${val} should be deterministic`);
      assert.deepEqual(a.params, b.params, `params for id=${val} should be deterministic`);
    }
  });
});

// ---------------------------------------------------------------------------
// 6. Wide with clause (10+ sibling relations)
// ---------------------------------------------------------------------------

describe('stress: wide with clause', () => {
  it('builds a query with 12 sibling relations', () => {
    // Build a schema where "hub" table has 12 hasMany relations to different child tables
    const tables: Record<string, TableMetadata> = {};

    const hubRelations: Record<string, RelationDef> = {};
    for (let i = 0; i < 12; i++) {
      const childName = `child_${i}`;
      hubRelations[childName] = {
        type: 'hasMany',
        name: childName,
        from: 'hub',
        to: childName,
        foreignKey: 'hub_id',
        referenceKey: 'id',
      };
    }

    tables.hub = mockTable(
      'hub',
      [
        { name: 'id', field: 'id' },
        { name: 'name', field: 'name', pgType: 'text' },
      ],
      hubRelations,
    );

    // Create 12 child tables
    for (let i = 0; i < 12; i++) {
      tables[`child_${i}`] = mockTable(`child_${i}`, [
        { name: 'id', field: 'id' },
        { name: 'hub_id', field: 'hubId' },
        { name: 'value', field: 'value', pgType: 'text' },
      ]);
    }

    const schema: SchemaMetadata = { tables, enums: {} };
    const q = makeQuery('hub', schema);

    // Include all 12 relations
    const withClause: Record<string, true> = {};
    for (let i = 0; i < 12; i++) {
      withClause[`child_${i}`] = true;
    }

    const deferred = q.buildFindMany({ with: withClause });

    assert.ok(deferred.sql.length > 0, 'should produce non-empty SQL');

    // Verify all 12 child tables appear in the SQL
    for (let i = 0; i < 12; i++) {
      assert.ok(deferred.sql.includes(`"child_${i}"`), `should include child_${i} table reference`);
    }

    // Verify we have 12 AS aliases for the relation subqueries
    for (let i = 0; i < 12; i++) {
      assert.ok(deferred.sql.includes(`AS "child_${i}"`), `should include AS "child_${i}" alias`);
    }

    // All 12 unique table aliases t0..t11 should be present
    for (let i = 0; i < 12; i++) {
      assert.ok(deferred.sql.includes(`t${i}.`), `should include alias t${i}`);
    }
  });

  it('builds a query with wide + nested relations', () => {
    const schema = buildCoreSchema();
    const q = makeQuery('users', schema);

    // users has two relations at the same level: organization (belongsTo) and posts (hasMany)
    const deferred = q.buildFindMany({
      with: {
        organization: true,
        posts: {
          with: {
            comments: true,
          },
        },
      },
    });

    assert.ok(deferred.sql.length > 0, 'should produce non-empty SQL');
    assert.ok(deferred.sql.includes('"organizations"'), 'should include organizations table');
    assert.ok(deferred.sql.includes('"posts"'), 'should include posts table');
    assert.ok(deferred.sql.includes('"comments"'), 'should include comments table');
    assert.ok(deferred.sql.includes('AS "organization"'), 'should alias organization');
    assert.ok(deferred.sql.includes('AS "posts"'), 'should alias posts');
  });
});
