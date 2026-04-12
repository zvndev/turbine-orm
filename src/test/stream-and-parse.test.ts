/**
 * turbine-orm — findManyStream fast-path + parseNestedRow short-circuit tests
 *
 * Unit tests (no DB) verifying:
 *   A) findManyStream speculative fast-path avoids cursor for small results
 *   B) findManyStream falls back to cursor for large results
 *   C) parseNestedRow short-circuits for empty/null relation values
 *   D) parseNestedRow still handles non-empty relations correctly
 *
 * Run: npx tsx --test src/test/stream-and-parse.test.ts
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { QueryInterface } from '../query/index.js';
import type { SchemaMetadata, TableMetadata } from '../schema.js';
import { mockColumn, mockTable } from './helpers.js';

// ---------------------------------------------------------------------------
// Schema helpers
// ---------------------------------------------------------------------------

function buildSchemaWithRelations(): SchemaMetadata {
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
      organization: {
        type: 'belongsTo',
        name: 'organization',
        from: 'users',
        to: 'organizations',
        foreignKey: 'org_id',
        referenceKey: 'id',
      },
      comments: {
        type: 'hasMany',
        name: 'comments',
        from: 'users',
        to: 'comments',
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
    ],
    {},
  );

  tables.organizations = mockTable(
    'organizations',
    [
      { name: 'id', field: 'id' },
      { name: 'name', field: 'name', pgType: 'text' },
    ],
    {},
  );

  tables.comments = mockTable(
    'comments',
    [
      { name: 'id', field: 'id' },
      { name: 'body', field: 'body', pgType: 'text' },
      { name: 'user_id', field: 'userId' },
    ],
    {},
  );

  return { tables, enums: {} };
}

// ---------------------------------------------------------------------------
// Mock pool for findManyStream tests
// ---------------------------------------------------------------------------

interface MockClient {
  query: (text: string, values?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number }>;
  release: () => void;
}

interface MockPool {
  query: (text: string, values?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number }>;
  connect: () => Promise<MockClient>;
}

interface StreamTestHarness {
  pool: MockPool;
  queries: string[];
  released: { count: number };
}

/**
 * Creates a mock pool that records all queries and returns configurable rows.
 * `rowFactory` receives the SQL text and should return rows for that query.
 */
function createStreamMockPool(rowFactory: (sql: string) => unknown[]): StreamTestHarness {
  const queries: string[] = [];
  const released = { count: 0 };

  const clientQuery = async (text: string, _values?: unknown[]) => {
    queries.push(text);
    const rows = rowFactory(text);
    return { rows, rowCount: rows.length };
  };

  const client: MockClient = {
    query: clientQuery,
    release() {
      released.count += 1;
    },
  };

  const pool: MockPool = {
    query: clientQuery,
    connect: async () => client,
  };

  return { pool, queries, released };
}

/** Create a QueryInterface with a mock pool */
function makeStreamQuery(
  pool: MockPool,
  schema: SchemaMetadata,
  table = 'users',
): QueryInterface<Record<string, unknown>> {
  // biome-ignore lint/suspicious/noExplicitAny: mock pool for testing
  return new QueryInterface<Record<string, unknown>>(pool as any, table, schema);
}

// ---------------------------------------------------------------------------
// A) findManyStream speculative fast-path tests
// ---------------------------------------------------------------------------

describe('findManyStream: speculative fast-path', () => {
  it('small result set does NOT use DECLARE CURSOR', async () => {
    const schema = buildSchemaWithRelations();

    // Return 5 rows for speculative fetch (well under default batchSize of 1000)
    const harness = createStreamMockPool((sql) => {
      if (sql.includes('SELECT')) {
        return [
          { id: 1, name: 'Alice', email: 'a@test.com' },
          { id: 2, name: 'Bob', email: 'b@test.com' },
          { id: 3, name: 'Carol', email: 'c@test.com' },
          { id: 4, name: 'Dave', email: 'd@test.com' },
          { id: 5, name: 'Eve', email: 'e@test.com' },
        ];
      }
      return [];
    });

    const q = makeStreamQuery(harness.pool, schema);
    const rows: unknown[] = [];

    for await (const row of q.findManyStream()) {
      rows.push(row);
    }

    assert.equal(rows.length, 5, 'should yield all 5 rows');
    // Verify no cursor queries were issued
    const hasDeclare = harness.queries.some((q) => q.includes('DECLARE'));
    const hasBegin = harness.queries.some((q) => q === 'BEGIN');
    assert.equal(hasDeclare, false, 'should NOT issue DECLARE CURSOR');
    assert.equal(hasBegin, false, 'should NOT issue BEGIN');

    // Verify speculative SELECT was issued with LIMIT batchSize+1
    const selectQuery = harness.queries.find((q) => q.includes('LIMIT'));
    assert.ok(selectQuery, 'should issue a SELECT with LIMIT');
  });

  it('yields correct rows for small drain', async () => {
    const schema = buildSchemaWithRelations();
    const harness = createStreamMockPool((sql) => {
      if (sql.includes('SELECT')) {
        return [
          { id: 1, name: 'Alice', email: 'a@test.com' },
          { id: 2, name: 'Bob', email: 'b@test.com' },
        ];
      }
      return [];
    });

    const q = makeStreamQuery(harness.pool, schema);
    const rows: Record<string, unknown>[] = [];

    for await (const row of q.findManyStream({ batchSize: 10 })) {
      rows.push(row as any);
    }

    assert.equal(rows.length, 2);
    assert.equal(rows[0]!.name, 'Alice');
    assert.equal(rows[1]!.name, 'Bob');
  });

  it('exact batchSize count stays on speculative path', async () => {
    const schema = buildSchemaWithRelations();
    const batchSize = 3;

    // Return exactly batchSize rows (no overflow)
    const harness = createStreamMockPool((sql) => {
      if (sql.includes('SELECT')) {
        return [
          { id: 1, name: 'Alice', email: 'a@test.com' },
          { id: 2, name: 'Bob', email: 'b@test.com' },
          { id: 3, name: 'Carol', email: 'c@test.com' },
        ];
      }
      return [];
    });

    const q = makeStreamQuery(harness.pool, schema);
    const rows: unknown[] = [];

    for await (const row of q.findManyStream({ batchSize })) {
      rows.push(row);
    }

    assert.equal(rows.length, 3, 'should yield all 3 rows');
    assert.equal(
      harness.queries.some((q) => q.includes('DECLARE')),
      false,
      'should NOT fall back to cursor',
    );
  });

  it('overflow triggers cursor fallback', async () => {
    const schema = buildSchemaWithRelations();
    const batchSize = 3;
    let fetchCount = 0;

    const harness = createStreamMockPool((sql) => {
      if (sql.includes('FETCH')) {
        fetchCount++;
        if (fetchCount === 1) {
          // First cursor FETCH returns batchSize rows
          return [
            { id: 1, name: 'Alice', email: 'a@test.com' },
            { id: 2, name: 'Bob', email: 'b@test.com' },
            { id: 3, name: 'Carol', email: 'c@test.com' },
          ];
        }
        if (fetchCount === 2) {
          // Second FETCH returns remaining rows
          return [{ id: 4, name: 'Dave', email: 'd@test.com' }];
        }
        return [];
      }
      if (sql.includes('SELECT') && sql.includes('LIMIT')) {
        // Speculative fetch returns batchSize+1 rows (overflow!)
        return [
          { id: 1, name: 'Alice', email: 'a@test.com' },
          { id: 2, name: 'Bob', email: 'b@test.com' },
          { id: 3, name: 'Carol', email: 'c@test.com' },
          { id: 4, name: 'Dave', email: 'd@test.com' },
        ];
      }
      return [];
    });

    const q = makeStreamQuery(harness.pool, schema);
    const rows: unknown[] = [];

    for await (const row of q.findManyStream({ batchSize })) {
      rows.push(row);
    }

    assert.equal(rows.length, 4, 'should yield all 4 rows from cursor path');

    // Verify cursor path was used
    assert.ok(
      harness.queries.some((q) => q === 'BEGIN'),
      'should issue BEGIN for cursor path',
    );
    assert.ok(
      harness.queries.some((q) => q.includes('DECLARE')),
      'should issue DECLARE CURSOR',
    );
    assert.ok(
      harness.queries.some((q) => q.includes('CLOSE')),
      'should issue CLOSE cursor',
    );
    assert.ok(
      harness.queries.some((q) => q === 'COMMIT'),
      'should issue COMMIT',
    );
  });

  it('early break on small drain returns cleanly (no cursor to close)', async () => {
    const schema = buildSchemaWithRelations();
    const harness = createStreamMockPool((sql) => {
      if (sql.includes('SELECT')) {
        return [
          { id: 1, name: 'Alice', email: 'a@test.com' },
          { id: 2, name: 'Bob', email: 'b@test.com' },
          { id: 3, name: 'Carol', email: 'c@test.com' },
        ];
      }
      return [];
    });

    const q = makeStreamQuery(harness.pool, schema);
    const rows: unknown[] = [];

    for await (const row of q.findManyStream({ batchSize: 10 })) {
      rows.push(row);
      if (rows.length === 1) break; // Early break after first row
    }

    assert.equal(rows.length, 1, 'should only yield 1 row before break');
    assert.equal(
      harness.queries.some((q) => q.includes('DECLARE')),
      false,
      'no cursor to close on speculative path',
    );
  });

  it('early break on cursor path cleans up properly', async () => {
    const schema = buildSchemaWithRelations();
    const batchSize = 2;

    const harness = createStreamMockPool((sql) => {
      if (sql.includes('FETCH')) {
        // Return full batch each time (simulating large dataset)
        return [
          { id: 1, name: 'Alice', email: 'a@test.com' },
          { id: 2, name: 'Bob', email: 'b@test.com' },
        ];
      }
      if (sql.includes('SELECT') && sql.includes('LIMIT')) {
        // Overflow: return batchSize+1
        return [
          { id: 1, name: 'Alice', email: 'a@test.com' },
          { id: 2, name: 'Bob', email: 'b@test.com' },
          { id: 3, name: 'Carol', email: 'c@test.com' },
        ];
      }
      return [];
    });

    const q = makeStreamQuery(harness.pool, schema);
    const rows: unknown[] = [];

    for await (const row of q.findManyStream({ batchSize })) {
      rows.push(row);
      if (rows.length === 1) break;
    }

    assert.equal(rows.length, 1, 'should yield only 1 row before break');
    // Connection should be released
    assert.equal(harness.released.count, 1, 'connection should be released after break');
  });

  it('nested with works on speculative fetch path', async () => {
    const schema = buildSchemaWithRelations();

    const harness = createStreamMockPool((sql) => {
      if (sql.includes('SELECT')) {
        return [
          {
            id: 1,
            name: 'Alice',
            email: 'a@test.com',
            posts: '[{"id": 10, "title": "Hello", "user_id": 1}]',
          },
          {
            id: 2,
            name: 'Bob',
            email: 'b@test.com',
            posts: '[]',
          },
        ];
      }
      return [];
    });

    const q = makeStreamQuery(harness.pool, schema);
    const rows: Record<string, unknown>[] = [];

    for await (const row of q.findManyStream({ with: { posts: true }, batchSize: 10 } as any)) {
      rows.push(row as any);
    }

    assert.equal(rows.length, 2);
    // First user has posts
    const posts0 = rows[0]!.posts as unknown[];
    assert.ok(Array.isArray(posts0));
    assert.equal(posts0.length, 1);
    assert.equal((posts0[0] as any).title, 'Hello');

    // Second user has empty posts
    const posts1 = rows[1]!.posts as unknown[];
    assert.ok(Array.isArray(posts1));
    assert.equal(posts1.length, 0);

    // Should stay on speculative path
    assert.equal(
      harness.queries.some((q) => q.includes('DECLARE')),
      false,
    );
  });

  it('default batchSize is 1000', async () => {
    const schema = buildSchemaWithRelations();

    // Track params passed to pool.query
    const queryParams: unknown[][] = [];

    const pool: MockPool = {
      query: async (text: string, values?: unknown[]) => {
        if (values) queryParams.push(values);
        if (text.includes('SELECT')) {
          return { rows: [{ id: 1, name: 'Alice', email: 'a@test.com' }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      },
      connect: async () => ({
        query: async () => ({ rows: [], rowCount: 0 }),
        release: () => {},
      }),
    };

    const q = makeStreamQuery(pool, schema);

    for await (const _row of q.findManyStream()) {
      // consume
    }

    // The speculative query should use LIMIT 1001 (batchSize=1000 + 1)
    // The LIMIT value is parameterized, so check the params array
    assert.ok(queryParams.length > 0, 'should have issued a query with params');
    const limitParam = queryParams[0]!;
    assert.ok(
      limitParam.includes(1001),
      `speculative LIMIT param should be 1001, got params: ${JSON.stringify(limitParam)}`,
    );
  });
});

// ---------------------------------------------------------------------------
// B) parseNestedRow short-circuit tests
// ---------------------------------------------------------------------------

describe('parseNestedRow: short-circuit optimizations', () => {
  /**
   * We test parseNestedRow indirectly by using buildFindMany's transform,
   * which calls parseNestedRow when `with` is used.
   */

  it('empty hasMany as string "[]" returns empty array', () => {
    const schema = buildSchemaWithRelations();
    const q = new QueryInterface<Record<string, unknown>>(
      // biome-ignore lint/suspicious/noExplicitAny: mock pool for testing
      null as any,
      'users',
      schema,
    );

    const deferred = q.buildFindMany({ with: { posts: true } as any });
    const result = deferred.transform({
      rows: [{ id: 1, name: 'Alice', email: 'a@test.com', posts: '[]' }],
      command: '',
      rowCount: 1,
      oid: 0,
      fields: [],
    });

    assert.equal(result.length, 1);
    const row = result[0] as any;
    assert.ok(Array.isArray(row.posts), 'posts should be an array');
    assert.equal((row.posts as unknown[]).length, 0, 'posts should be empty');
  });

  it('null belongsTo as string "null" returns null', () => {
    const schema = buildSchemaWithRelations();
    const q = new QueryInterface<Record<string, unknown>>(
      // biome-ignore lint/suspicious/noExplicitAny: mock pool for testing
      null as any,
      'users',
      schema,
    );

    const deferred = q.buildFindMany({ with: { organization: true } as any });
    const result = deferred.transform({
      rows: [{ id: 1, name: 'Alice', email: 'a@test.com', organization: 'null' }],
      command: '',
      rowCount: 1,
      oid: 0,
      fields: [],
    });

    assert.equal(result.length, 1);
    const row = result[0] as any;
    assert.equal(row.organization, null, 'organization should be null');
  });

  it('null as JS null returns null', () => {
    const schema = buildSchemaWithRelations();
    const q = new QueryInterface<Record<string, unknown>>(
      // biome-ignore lint/suspicious/noExplicitAny: mock pool for testing
      null as any,
      'users',
      schema,
    );

    const deferred = q.buildFindMany({ with: { organization: true } as any });
    const result = deferred.transform({
      rows: [{ id: 1, name: 'Alice', email: 'a@test.com', organization: null }],
      command: '',
      rowCount: 1,
      oid: 0,
      fields: [],
    });

    assert.equal(result.length, 1);
    const row = result[0] as any;
    assert.equal(row.organization, null, 'organization should be null');
  });

  it('empty array (pre-parsed) returns empty array', () => {
    const schema = buildSchemaWithRelations();
    const q = new QueryInterface<Record<string, unknown>>(
      // biome-ignore lint/suspicious/noExplicitAny: mock pool for testing
      null as any,
      'users',
      schema,
    );

    const deferred = q.buildFindMany({ with: { posts: true } as any });
    const result = deferred.transform({
      rows: [{ id: 1, name: 'Alice', email: 'a@test.com', posts: [] }],
      command: '',
      rowCount: 1,
      oid: 0,
      fields: [],
    });

    assert.equal(result.length, 1);
    const row = result[0] as any;
    assert.ok(Array.isArray(row.posts));
    assert.equal((row.posts as unknown[]).length, 0);
  });

  it('non-empty hasMany JSON string is parsed and items run through parseRow', () => {
    const schema = buildSchemaWithRelations();
    const q = new QueryInterface<Record<string, unknown>>(
      // biome-ignore lint/suspicious/noExplicitAny: mock pool for testing
      null as any,
      'users',
      schema,
    );

    const deferred = q.buildFindMany({ with: { posts: true } as any });
    const result = deferred.transform({
      rows: [
        {
          id: 1,
          name: 'Alice',
          email: 'a@test.com',
          posts: '[{"id": 10, "title": "Hello World", "user_id": 1}]',
        },
      ],
      command: '',
      rowCount: 1,
      oid: 0,
      fields: [],
    });

    assert.equal(result.length, 1);
    const row = result[0] as any;
    const posts = row.posts as any[];
    assert.ok(Array.isArray(posts));
    assert.equal(posts.length, 1);
    assert.equal(posts[0]!.title, 'Hello World');
    // snake_case user_id should be converted to camelCase userId
    assert.equal(posts[0]!.userId, 1);
  });

  it('non-empty hasMany as pre-parsed array is mapped through parseRow', () => {
    const schema = buildSchemaWithRelations();
    const q = new QueryInterface<Record<string, unknown>>(
      // biome-ignore lint/suspicious/noExplicitAny: mock pool for testing
      null as any,
      'users',
      schema,
    );

    const deferred = q.buildFindMany({ with: { posts: true } as any });
    const result = deferred.transform({
      rows: [
        {
          id: 1,
          name: 'Alice',
          email: 'a@test.com',
          posts: [{ id: 10, title: 'Hello', user_id: 1 }],
        },
      ],
      command: '',
      rowCount: 1,
      oid: 0,
      fields: [],
    });

    assert.equal(result.length, 1);
    const row = result[0] as any;
    const posts = row.posts as any[];
    assert.ok(Array.isArray(posts));
    assert.equal(posts.length, 1);
    assert.equal(posts[0]!.title, 'Hello');
    assert.equal(posts[0]!.userId, 1);
  });

  it('non-empty belongsTo JSON string is parsed and run through parseRow', () => {
    const schema = buildSchemaWithRelations();
    const q = new QueryInterface<Record<string, unknown>>(
      // biome-ignore lint/suspicious/noExplicitAny: mock pool for testing
      null as any,
      'users',
      schema,
    );

    const deferred = q.buildFindMany({ with: { organization: true } as any });
    const result = deferred.transform({
      rows: [
        {
          id: 1,
          name: 'Alice',
          email: 'a@test.com',
          organization: '{"id": 42, "name": "Acme Corp"}',
        },
      ],
      command: '',
      rowCount: 1,
      oid: 0,
      fields: [],
    });

    assert.equal(result.length, 1);
    const row = result[0] as any;
    const org = row.organization as any;
    assert.ok(org !== null && typeof org === 'object');
    assert.equal(org.id, 42);
    assert.equal(org.name, 'Acme Corp');
  });

  it('mixed row: one empty relation and one non-empty relation', () => {
    const schema = buildSchemaWithRelations();
    const q = new QueryInterface<Record<string, unknown>>(
      // biome-ignore lint/suspicious/noExplicitAny: mock pool for testing
      null as any,
      'users',
      schema,
    );

    const deferred = q.buildFindMany({
      with: { posts: true, comments: true } as any,
    });
    const result = deferred.transform({
      rows: [
        {
          id: 1,
          name: 'Alice',
          email: 'a@test.com',
          posts: '[]',
          comments: '[{"id": 5, "body": "Great!", "user_id": 1}]',
        },
      ],
      command: '',
      rowCount: 1,
      oid: 0,
      fields: [],
    });

    assert.equal(result.length, 1);
    const row = result[0] as any;

    // posts should be empty array (short-circuited)
    assert.ok(Array.isArray(row.posts));
    assert.equal((row.posts as unknown[]).length, 0);

    // comments should be parsed
    const comments = row.comments as any[];
    assert.ok(Array.isArray(comments));
    assert.equal(comments.length, 1);
    assert.equal(comments[0]!.body, 'Great!');
    assert.equal(comments[0]!.userId, 1);
  });

  it('malformed JSON fallback preserves raw value', () => {
    const schema = buildSchemaWithRelations();
    const q = new QueryInterface<Record<string, unknown>>(
      // biome-ignore lint/suspicious/noExplicitAny: mock pool for testing
      null as any,
      'users',
      schema,
    );

    // Capture console.warn
    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(String(args[0]));
    };

    try {
      const deferred = q.buildFindMany({ with: { posts: true } as any });
      const result = deferred.transform({
        rows: [{ id: 1, name: 'Alice', email: 'a@test.com', posts: 'not valid json' }],
        command: '',
        rowCount: 1,
        oid: 0,
        fields: [],
      });

      assert.equal(result.length, 1);
      const row = result[0] as any;
      // Malformed JSON should be preserved as raw string
      assert.equal(row.posts, 'not valid json');
      // Warning should have been emitted
      assert.ok(warnings.length > 0, 'should emit a warning for malformed JSON');
      assert.ok(warnings[0]!.includes('Failed to parse JSON'));
    } finally {
      console.warn = origWarn;
    }
  });

  it('undefined relation (no column in row) is not included in output', () => {
    const schema = buildSchemaWithRelations();
    const q = new QueryInterface<Record<string, unknown>>(
      // biome-ignore lint/suspicious/noExplicitAny: mock pool for testing
      null as any,
      'users',
      schema,
    );

    // Row without any relation columns
    const deferred = q.buildFindMany({ with: { posts: true } as any });
    const result = deferred.transform({
      rows: [{ id: 1, name: 'Alice', email: 'a@test.com' }],
      command: '',
      rowCount: 1,
      oid: 0,
      fields: [],
    });

    assert.equal(result.length, 1);
    const row = result[0] as any;
    // 'posts' key should not be present since the row didn't have that column
    assert.equal('posts' in row, false, 'posts key should not exist when column is absent');
  });

  it('non-empty belongsTo as pre-parsed object is run through parseRow', () => {
    const schema = buildSchemaWithRelations();
    const q = new QueryInterface<Record<string, unknown>>(
      // biome-ignore lint/suspicious/noExplicitAny: mock pool for testing
      null as any,
      'users',
      schema,
    );

    const deferred = q.buildFindMany({ with: { organization: true } as any });
    const result = deferred.transform({
      rows: [
        {
          id: 1,
          name: 'Alice',
          email: 'a@test.com',
          organization: { id: 42, name: 'Acme Corp' },
        },
      ],
      command: '',
      rowCount: 1,
      oid: 0,
      fields: [],
    });

    assert.equal(result.length, 1);
    const row = result[0] as any;
    const org = row.organization as any;
    assert.equal(org.id, 42);
    assert.equal(org.name, 'Acme Corp');
  });
});
