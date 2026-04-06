/**
 * turbine-orm — Atomic update operator tests
 *
 * Verifies Prisma-style atomic update operators on `update` and `updateMany`:
 *   - { set: V }                     → col = $n
 *   - { increment: n }               → col = col + $n
 *   - { decrement: n }               → col = col - $n
 *   - { multiply: n }                → col = col * $n
 *   - { divide: n }                  → col = col / $n
 *
 * Build-only tests (no DB) verify SQL shape and param numbering.
 * Integration tests (require DATABASE_URL) verify real atomic semantics
 * against a live Postgres, including concurrent increments.
 *
 * Run:
 *   npx tsx --test src/test/update-operators.test.ts
 *   DATABASE_URL=postgres://... npx tsx --test src/test/update-operators.test.ts
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { TurbineClient } from '../client.js';
import { ValidationError } from '../errors.js';
import { introspect } from '../introspect.js';
import { QueryInterface } from '../query.js';
import type { ColumnMetadata, SchemaMetadata, TableMetadata } from '../schema.js';

// ---------------------------------------------------------------------------
// Build-only test harness (no DB needed) — mirrors stress.test.ts helpers
// ---------------------------------------------------------------------------

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

function mockTable(tableName: string, columns: { name: string; field: string; pgType?: string }[]): TableMetadata {
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
    relations: {},
    indexes: [],
  };
}

function buildSchema(): SchemaMetadata {
  const tables: Record<string, TableMetadata> = {};
  tables.posts = mockTable('posts', [
    { name: 'id', field: 'id' },
    { name: 'title', field: 'title', pgType: 'text' },
    { name: 'view_count', field: 'viewCount', pgType: 'int4' },
    { name: 'price', field: 'price', pgType: 'numeric' },
    { name: 'metadata', field: 'metadata', pgType: 'jsonb' },
    { name: 'name', field: 'name', pgType: 'text' },
    { name: 'published', field: 'published', pgType: 'bool' },
  ]);
  return { tables, enums: {} };
}

function makeQuery<T extends object = Record<string, unknown>>(
  tableName: string,
  schema: SchemaMetadata,
): QueryInterface<T> {
  return new QueryInterface<T>(null as any, tableName, schema);
}

// ---------------------------------------------------------------------------
// 1. Build-only tests — verify SQL shape and param numbering
// ---------------------------------------------------------------------------

describe('update operators: SQL build (no DB)', () => {
  it('increment: 1 produces col = col + $1', () => {
    const q = makeQuery('posts', buildSchema());
    const deferred = q.buildUpdate({
      where: { id: 5 },
      data: { viewCount: { increment: 1 } },
    });
    assert.match(deferred.sql, /UPDATE "posts" SET "view_count" = "view_count" \+ \$1 WHERE "id" = \$2 RETURNING \*/);
    assert.deepEqual(deferred.params, [1, 5]);
  });

  it('decrement: 5 produces col = col - $1', () => {
    const q = makeQuery('posts', buildSchema());
    const deferred = q.buildUpdate({
      where: { id: 5 },
      data: { viewCount: { decrement: 5 } },
    });
    assert.match(deferred.sql, /SET "view_count" = "view_count" - \$1 WHERE "id" = \$2/);
    assert.deepEqual(deferred.params, [5, 5]);
  });

  it('multiply: 1.1 produces col = col * $1', () => {
    const q = makeQuery('posts', buildSchema());
    const deferred = q.buildUpdate({
      where: { id: 1 },
      data: { price: { multiply: 1.1 } },
    });
    assert.match(deferred.sql, /SET "price" = "price" \* \$1 WHERE "id" = \$2/);
    assert.deepEqual(deferred.params, [1.1, 1]);
  });

  it('divide: 2 produces col = col / $1', () => {
    const q = makeQuery('posts', buildSchema());
    const deferred = q.buildUpdate({
      where: { id: 1 },
      data: { price: { divide: 2 } },
    });
    assert.match(deferred.sql, /SET "price" = "price" \/ \$1 WHERE "id" = \$2/);
    assert.deepEqual(deferred.params, [2, 1]);
  });

  it('set: value produces col = $1 (no self-reference)', () => {
    const q = makeQuery('posts', buildSchema());
    const deferred = q.buildUpdate({
      where: { id: 1 },
      data: { name: { set: 'Alice' } },
    });
    assert.match(deferred.sql, /SET "name" = \$1 WHERE "id" = \$2/);
    // Must NOT have a self-reference like `"name" = "name" = $1`
    assert.ok(!/"name" = "name"/.test(deferred.sql));
    assert.deepEqual(deferred.params, ['Alice', 1]);
  });

  it('mixed: operator + plain value in same call with correct param numbering', () => {
    const q = makeQuery('posts', buildSchema());
    const deferred = q.buildUpdate({
      where: { id: 5 },
      data: { viewCount: { increment: 1 }, title: 'New title' },
    });
    // Both clauses present, plain value next to operator
    assert.match(deferred.sql, /"view_count" = "view_count" \+ \$1/);
    assert.match(deferred.sql, /"title" = \$2/);
    assert.match(deferred.sql, /WHERE "id" = \$3/);
    assert.deepEqual(deferred.params, [1, 'New title', 5]);
  });

  it('WHERE clause param numbering continues after SET (multi-arg case)', () => {
    const q = makeQuery('posts', buildSchema());
    const deferred = q.buildUpdate({
      where: { published: true, id: { gt: 10 } },
      data: { viewCount: { increment: 2 }, title: 'x' },
    });
    // SET uses $1, $2; WHERE uses $3, $4 in some order
    assert.match(deferred.sql, /"view_count" = "view_count" \+ \$1/);
    assert.match(deferred.sql, /"title" = \$2/);
    // Both WHERE params should reference $3 and $4
    assert.ok(/\$3/.test(deferred.sql));
    assert.ok(/\$4/.test(deferred.sql));
    assert.equal(deferred.params.length, 4);
    assert.equal(deferred.params[0], 2);
    assert.equal(deferred.params[1], 'x');
  });

  it('updateMany with increment works identically', () => {
    const q = makeQuery('posts', buildSchema());
    const deferred = q.buildUpdateMany({
      where: { published: true },
      data: { viewCount: { increment: 1 } },
    });
    assert.match(deferred.sql, /UPDATE "posts" SET "view_count" = "view_count" \+ \$1 WHERE "published" = \$2/);
    // updateMany does NOT have RETURNING *
    assert.ok(!/RETURNING/.test(deferred.sql));
    assert.deepEqual(deferred.params, [1, true]);
  });

  it('plain JSON object (multi-key) is treated as a value, NOT an operator', () => {
    const q = makeQuery('posts', buildSchema());
    const deferred = q.buildUpdate({
      where: { id: 1 },
      // Plain JSONB payload — not an operator, even though it's an object
      data: { metadata: { foo: 'bar', baz: 42 } as unknown as never },
    });
    // Should be an absolute SET, not a self-reference
    assert.match(deferred.sql, /SET "metadata" = \$1 WHERE "id" = \$2/);
    assert.ok(!/"metadata" = "metadata"/.test(deferred.sql));
    assert.deepEqual(deferred.params, [{ foo: 'bar', baz: 42 }, 1]);
  });

  it('multi-key object containing an operator key is still plain JSON', () => {
    const q = makeQuery('posts', buildSchema());
    // { increment: 1, foo: 2 } has a recognized operator key but also another
    // key — real operator objects have EXACTLY one key, so this is JSON.
    const deferred = q.buildUpdate({
      where: { id: 1 },
      data: { metadata: { increment: 1, foo: 2 } as unknown as never },
    });
    assert.match(deferred.sql, /SET "metadata" = \$1 WHERE "id" = \$2/);
    assert.ok(!/"metadata" = "metadata"/.test(deferred.sql));
    assert.deepEqual(deferred.params, [{ increment: 1, foo: 2 }, 1]);
  });

  it('non-number increment value throws ValidationError', () => {
    const q = makeQuery('posts', buildSchema());
    assert.throws(
      () =>
        q.buildUpdate({
          where: { id: 1 },
          // biome-ignore lint/suspicious/noExplicitAny: intentionally testing invalid input
          data: { viewCount: { increment: 'not a number' as any } },
        }),
      (err: unknown) => {
        assert.ok(err instanceof ValidationError, 'should be ValidationError');
        assert.match((err as Error).message, /increment/);
        return true;
      },
    );
  });

  it('non-finite (NaN) multiply value throws ValidationError', () => {
    const q = makeQuery('posts', buildSchema());
    assert.throws(
      () =>
        q.buildUpdate({
          where: { id: 1 },
          data: { price: { multiply: Number.NaN } },
        }),
      ValidationError,
    );
  });

  it('null value is still a plain SET (not an operator)', () => {
    const q = makeQuery('posts', buildSchema());
    const deferred = q.buildUpdate({
      where: { id: 1 },
      data: { metadata: null as unknown as never },
    });
    assert.match(deferred.sql, /SET "metadata" = \$1/);
    assert.deepEqual(deferred.params, [null, 1]);
  });

  it('set operator works on non-numeric type (back-compat with plain value)', () => {
    const q = makeQuery('posts', buildSchema());
    const explicit = q.buildUpdate({
      where: { id: 1 },
      data: { title: { set: 'hello' } },
    });
    const implicit = q.buildUpdate({
      where: { id: 1 },
      data: { title: 'hello' },
    });
    // Both should produce the same SQL and params
    assert.equal(explicit.sql, implicit.sql);
    assert.deepEqual(explicit.params, implicit.params);
  });
});

// ---------------------------------------------------------------------------
// 2. Integration tests — require DATABASE_URL, run against real Postgres
// ---------------------------------------------------------------------------

const DATABASE_URL = process.env.DATABASE_URL;
const SKIP = !DATABASE_URL;
if (SKIP) {
  console.log('\u26A0 Skipping update-operator integration tests: DATABASE_URL not set');
}

let db: TurbineClient;
let schema: SchemaMetadata;

const testFn = SKIP ? describe.skip : describe;

testFn('update operators: integration', () => {
  // A post we create in `before` and mutate across tests.
  let postId: number;
  // A user ID we borrow for FK purposes
  let userId: number;
  let orgId: number;

  before(async () => {
    schema = await introspect({ connectionString: DATABASE_URL! });
    db = new TurbineClient({ connectionString: DATABASE_URL!, poolSize: 5 }, schema);
    await db.connect();

    // Borrow any existing user/org for FK references
    const user = (await db.table('users').findMany({ limit: 1 }))[0] as Record<string, unknown> | undefined;
    if (!user) throw new Error('no users in test DB');
    userId = user.id as number;
    orgId = user.orgId as number;

    // Create an isolated post we own for this test suite
    const post = (await db.table('posts').create({
      data: {
        userId,
        orgId,
        title: 'update-operators-test',
        content: 'body',
        published: false,
        viewCount: 100,
      },
    })) as Record<string, unknown>;
    postId = post.id as number;
  });

  after(async () => {
    if (postId) {
      await db
        .table('posts')
        .delete({ where: { id: postId } })
        .catch(() => {});
    }
    await db.disconnect();
  });

  it('increment: viewCount increases by exact amount', async () => {
    const before = (await db.table('posts').findUnique({ where: { id: postId } })) as Record<string, unknown>;
    const startVc = before.viewCount as number;

    const updated = (await db.table('posts').update({
      where: { id: postId },
      data: { viewCount: { increment: 7 } },
    })) as Record<string, unknown>;

    assert.equal(updated.viewCount, startVc + 7);
    // RETURNING * should give us the new value
    const verify = (await db.table('posts').findUnique({ where: { id: postId } })) as Record<string, unknown>;
    assert.equal(verify.viewCount, startVc + 7);
  });

  it('decrement: viewCount decreases by exact amount', async () => {
    const before = (await db.table('posts').findUnique({ where: { id: postId } })) as Record<string, unknown>;
    const startVc = before.viewCount as number;

    const updated = (await db.table('posts').update({
      where: { id: postId },
      data: { viewCount: { decrement: 3 } },
    })) as Record<string, unknown>;

    assert.equal(updated.viewCount, startVc - 3);
  });

  it('mixed: operator + plain value in the same update', async () => {
    const updated = (await db.table('posts').update({
      where: { id: postId },
      data: { viewCount: { increment: 10 }, title: 'new-title' },
    })) as Record<string, unknown>;
    assert.equal(updated.title, 'new-title');
    assert.ok(typeof updated.viewCount === 'number');
  });

  it('updateMany: increments across multiple rows', async () => {
    // Create two more posts so we can updateMany them
    const a = (await db.table('posts').create({
      data: {
        userId,
        orgId,
        title: 'many-a',
        content: 'x',
        published: true,
        viewCount: 0,
      },
    })) as Record<string, unknown>;
    const b = (await db.table('posts').create({
      data: {
        userId,
        orgId,
        title: 'many-b',
        content: 'x',
        published: true,
        viewCount: 0,
      },
    })) as Record<string, unknown>;

    try {
      const result = await db.table('posts').updateMany({
        where: { id: { in: [a.id as number, b.id as number] } },
        data: { viewCount: { increment: 5 } },
      });
      assert.equal(result.count, 2);

      const after = (await db.table('posts').findMany({
        where: { id: { in: [a.id as number, b.id as number] } },
      })) as Record<string, unknown>[];
      for (const row of after) {
        assert.equal(row.viewCount, 5);
      }
    } finally {
      await db.table('posts').deleteMany({
        where: { id: { in: [a.id as number, b.id as number] } },
      });
    }
  });

  it('concurrent atomic increments: final value equals sum (proves atomicity)', async () => {
    // Snapshot current value
    const before = (await db.table('posts').findUnique({ where: { id: postId } })) as Record<string, unknown>;
    const startVc = before.viewCount as number;

    // Fire 10 concurrent +1 increments
    const N = 10;
    await Promise.all(
      Array.from({ length: N }, () =>
        db.table('posts').update({
          where: { id: postId },
          data: { viewCount: { increment: 1 } },
        }),
      ),
    );

    const after = (await db.table('posts').findUnique({ where: { id: postId } })) as Record<string, unknown>;
    // If this were read-modify-write it would race and miss some updates.
    // Atomic SQL `col = col + $1` guarantees exactly +N.
    assert.equal(after.viewCount, startVc + N);
  });
});
