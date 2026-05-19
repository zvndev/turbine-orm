import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ValidationError } from '../errors.js';
import { executeNestedCreate, executeNestedUpdate, type NestedWriteContext } from '../nested-write.js';
import type { SchemaMetadata } from '../schema.js';
import { mockTable } from './helpers.js';

// ---------------------------------------------------------------------------
// Mock schema
// ---------------------------------------------------------------------------

const usersTable = mockTable('users', [
  { name: 'id', field: 'id' },
  { name: 'email', field: 'email', pgType: 'text' },
  { name: 'name', field: 'name', pgType: 'text' },
]);

const postsTable = mockTable(
  'posts',
  [
    { name: 'id', field: 'id' },
    { name: 'title', field: 'title', pgType: 'text' },
    { name: 'user_id', field: 'userId' },
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

const schema: SchemaMetadata = {
  tables: {
    users: {
      ...usersTable,
      relations: {
        posts: {
          type: 'hasMany',
          name: 'posts',
          from: 'users',
          to: 'posts',
          foreignKey: 'user_id',
          referenceKey: 'id',
        },
      },
    },
    posts: postsTable,
  },
  enums: {},
};

// ---------------------------------------------------------------------------
// Mock context builder
// ---------------------------------------------------------------------------

function makeMockCtx(
  schemaArg: SchemaMetadata,
  overrides?: {
    /** Override findUnique for a specific table (others use default behavior) */
    findUniqueOverride?: { table: string; returns: Record<string, unknown> | null };
  },
): {
  ctx: NestedWriteContext;
  log: { op: string; table: string; args: unknown }[];
} {
  const log: { op: string; table: string; args: unknown }[] = [];
  let idCounter = 100;

  // biome-ignore lint/suspicious/noExplicitAny: mock transaction for unit tests
  const mockTableFn = (name: string): any => ({
    async create(args: { data: Record<string, unknown> }) {
      log.push({ op: 'create', table: name, args });
      return { id: idCounter++, ...args.data };
    },
    async createMany(args: { data: Record<string, unknown>[] }) {
      log.push({ op: 'createMany', table: name, args });
      return args.data.map((d) => ({ id: idCounter++, ...d }));
    },
    async update(args: { where: Record<string, unknown>; data: Record<string, unknown> }) {
      log.push({ op: 'update', table: name, args });
      return { ...args.where, ...args.data };
    },
    async updateMany(args: {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
      allowFullTableScan?: boolean;
    }) {
      log.push({ op: 'updateMany', table: name, args });
      return { count: 1 };
    },
    async delete(args: { where: Record<string, unknown> }) {
      log.push({ op: 'delete', table: name, args });
      return args.where;
    },
    async deleteMany(args: { where: Record<string, unknown> }) {
      log.push({ op: 'deleteMany', table: name, args });
      return { count: 1 };
    },
    async findMany(args: { where: Record<string, unknown> }) {
      log.push({ op: 'findMany', table: name, args });
      return [];
    },
    async findUnique(args: { where: Record<string, unknown>; with?: Record<string, unknown> }) {
      log.push({ op: 'findUnique', table: name, args });
      // Override findUnique for a specific table only
      if (overrides?.findUniqueOverride && overrides.findUniqueOverride.table === name && !args.with) {
        return overrides.findUniqueOverride.returns;
      }
      // Default: return a row based on where
      const base: Record<string, unknown> = { id: args.where.id ?? 100, ...args.where };
      if (args.with) {
        for (const relName of Object.keys(args.with)) {
          base[relName] = [];
        }
      }
      return base;
    },
  });

  const ctx: NestedWriteContext = {
    schema: schemaArg,
    tx: {
      table: mockTableFn,
    },
  };

  return { ctx, log };
}

// ---------------------------------------------------------------------------
// hasMany update
// ---------------------------------------------------------------------------

describe('nested-write: hasMany update', () => {
  it('updates a single related record with where + data', async () => {
    const { ctx, log } = makeMockCtx(schema);

    await executeNestedUpdate(
      ctx,
      'users',
      { id: 1 },
      {
        posts: { update: { where: { id: 5 }, data: { title: 'Updated Title' } } },
      },
    );

    const updateOps = log.filter((l) => l.op === 'update' && l.table === 'posts');
    assert.equal(updateOps.length, 1);
    const args = updateOps[0]!.args as { where: Record<string, unknown>; data: Record<string, unknown> };
    assert.deepStrictEqual(args.where, { id: 5 });
    assert.deepStrictEqual(args.data, { title: 'Updated Title' });
  });

  it('updates multiple related records (array form)', async () => {
    const { ctx, log } = makeMockCtx(schema);

    await executeNestedUpdate(
      ctx,
      'users',
      { id: 1 },
      {
        posts: {
          update: [
            { where: { id: 5 }, data: { title: 'Title A' } },
            { where: { id: 6 }, data: { title: 'Title B' } },
          ],
        },
      },
    );

    const updateOps = log.filter((l) => l.op === 'update' && l.table === 'posts');
    assert.equal(updateOps.length, 2);
    assert.deepStrictEqual((updateOps[0]!.args as { where: Record<string, unknown> }).where, { id: 5 });
    assert.deepStrictEqual((updateOps[1]!.args as { where: Record<string, unknown> }).where, { id: 6 });
  });

  it('throws ValidationError when update is missing where', async () => {
    const { ctx } = makeMockCtx(schema);

    await assert.rejects(
      () =>
        executeNestedUpdate(
          ctx,
          'users',
          { id: 1 },
          {
            posts: { update: { data: { title: 'No Where' } } },
          },
        ),
      (err: Error) => {
        assert.ok(err instanceof ValidationError);
        assert.ok(err.message.includes('requires both "where" and "data"'));
        return true;
      },
    );
  });

  it('throws ValidationError when update is missing data', async () => {
    const { ctx } = makeMockCtx(schema);

    await assert.rejects(
      () =>
        executeNestedUpdate(
          ctx,
          'users',
          { id: 1 },
          {
            posts: { update: { where: { id: 5 } } },
          },
        ),
      (err: Error) => {
        assert.ok(err instanceof ValidationError);
        assert.ok(err.message.includes('requires both "where" and "data"'));
        return true;
      },
    );
  });
});

// ---------------------------------------------------------------------------
// hasMany upsert
// ---------------------------------------------------------------------------

describe('nested-write: hasMany upsert', () => {
  it('updates existing record when found', async () => {
    // findUnique on posts returns a row => update path
    const { ctx, log } = makeMockCtx(schema, {
      findUniqueOverride: { table: 'posts', returns: { id: 5, title: 'Old', userId: 1 } },
    });

    await executeNestedUpdate(
      ctx,
      'users',
      { id: 1 },
      {
        posts: {
          upsert: {
            where: { id: 5 },
            create: { title: 'New Post' },
            update: { title: 'Updated Post' },
          },
        },
      },
    );

    // Should findUnique to check existence (first call is for parent, second for upsert check)
    const findOps = log.filter((l) => l.op === 'findUnique');
    assert.ok(findOps.length >= 2, 'Should have at least 2 findUnique calls');

    // Should call update on posts, not create
    const updateOps = log.filter((l) => l.op === 'update' && l.table === 'posts');
    assert.equal(updateOps.length, 1);
    const args = updateOps[0]!.args as { where: Record<string, unknown>; data: Record<string, unknown> };
    assert.deepStrictEqual(args.where, { id: 5 });
    assert.deepStrictEqual(args.data, { title: 'Updated Post' });

    // Should NOT create
    const createOps = log.filter((l) => l.op === 'create' && l.table === 'posts');
    assert.equal(createOps.length, 0);
  });

  it('creates new record with FK injected when not found', async () => {
    // findUnique on posts returns null => create path
    const { ctx, log } = makeMockCtx(schema, { findUniqueOverride: { table: 'posts', returns: null } });

    await executeNestedUpdate(
      ctx,
      'users',
      { id: 1 },
      {
        posts: {
          upsert: {
            where: { id: 999 },
            create: { title: 'Brand New' },
            update: { title: 'Would Update' },
          },
        },
      },
    );

    // Should create on posts with FK injected
    const createOps = log.filter((l) => l.op === 'create' && l.table === 'posts');
    assert.equal(createOps.length, 1);
    const createArgs = createOps[0]!.args as { data: Record<string, unknown> };
    assert.equal(createArgs.data.title, 'Brand New');
    // FK should be injected (userId from parent)
    assert.ok('userId' in createArgs.data, 'FK should be injected into create data');

    // Should NOT update posts
    const updateOps = log.filter((l) => l.op === 'update' && l.table === 'posts');
    assert.equal(updateOps.length, 0);
  });

  it('throws ValidationError when upsert is missing create', async () => {
    const { ctx } = makeMockCtx(schema);

    await assert.rejects(
      () =>
        executeNestedUpdate(
          ctx,
          'users',
          { id: 1 },
          {
            posts: { upsert: { where: { id: 5 }, update: { title: 'x' } } },
          },
        ),
      (err: Error) => {
        assert.ok(err instanceof ValidationError);
        assert.ok(err.message.includes('requires "where", "create", and "update"'));
        return true;
      },
    );
  });

  it('throws ValidationError when upsert is missing update', async () => {
    const { ctx } = makeMockCtx(schema);

    await assert.rejects(
      () =>
        executeNestedUpdate(
          ctx,
          'users',
          { id: 1 },
          {
            posts: { upsert: { where: { id: 5 }, create: { title: 'x' } } },
          },
        ),
      (err: Error) => {
        assert.ok(err instanceof ValidationError);
        assert.ok(err.message.includes('requires "where", "create", and "update"'));
        return true;
      },
    );
  });
});

// ---------------------------------------------------------------------------
// belongsTo update
// ---------------------------------------------------------------------------

describe('nested-write: belongsTo update', () => {
  it('derives where from parent FK and updates related record', async () => {
    const { ctx, log } = makeMockCtx(schema);

    await executeNestedUpdate(
      ctx,
      'posts',
      { id: 10 },
      {
        author: { update: { data: { name: 'Updated Author' } } },
      },
    );

    // The parent row will be fetched first (no scalar changes) via findUnique
    // Then the belongsTo update should derive where from the parent's FK
    const updateOps = log.filter((l) => l.op === 'update' && l.table === 'users');
    assert.equal(updateOps.length, 1);
    const args = updateOps[0]!.args as { where: Record<string, unknown>; data: Record<string, unknown> };
    assert.deepStrictEqual(args.data, { name: 'Updated Author' });
    // The where should be derived from parent's FK (userId -> id on users)
    assert.ok('id' in args.where, 'Where should use the reference key on the related table');
  });

  it('throws ValidationError when belongsTo update is missing data', async () => {
    const { ctx } = makeMockCtx(schema);

    await assert.rejects(
      () =>
        executeNestedUpdate(
          ctx,
          'posts',
          { id: 10 },
          {
            author: { update: {} },
          },
        ),
      (err: Error) => {
        assert.ok(err instanceof ValidationError);
        assert.ok(err.message.includes('requires a "data" field'));
        return true;
      },
    );
  });
});

// ---------------------------------------------------------------------------
// belongsTo upsert
// ---------------------------------------------------------------------------

describe('nested-write: belongsTo upsert', () => {
  it('updates existing related record when found', async () => {
    const { ctx, log } = makeMockCtx(schema, {
      findUniqueOverride: { table: 'users', returns: { id: 5, name: 'Alice', email: 'a@b.com' } },
    });

    await executeNestedUpdate(
      ctx,
      'posts',
      { id: 10 },
      {
        author: {
          upsert: {
            where: { id: 5 },
            create: { name: 'New Author', email: 'new@b.com' },
            update: { name: 'Updated Author' },
          },
        },
      },
    );

    // Should update, not create
    const updateOps = log.filter((l) => l.op === 'update' && l.table === 'users');
    assert.ok(updateOps.length >= 1, 'Should update the related user');
    const lastUpdate = updateOps[updateOps.length - 1]!;
    const args = lastUpdate.args as { where: Record<string, unknown>; data: Record<string, unknown> };
    assert.deepStrictEqual(args.where, { id: 5 });
    assert.deepStrictEqual(args.data, { name: 'Updated Author' });

    const createOps = log.filter((l) => l.op === 'create' && l.table === 'users');
    assert.equal(createOps.length, 0, 'Should not create when record exists');
  });

  it('creates new related record and updates parent FK when not found', async () => {
    const { ctx, log } = makeMockCtx(schema, { findUniqueOverride: { table: 'users', returns: null } });

    await executeNestedUpdate(
      ctx,
      'posts',
      { id: 10 },
      {
        author: {
          upsert: {
            where: { id: 999 },
            create: { name: 'New Author', email: 'new@b.com' },
            update: { name: 'Would Update' },
          },
        },
      },
    );

    // Should create on users
    const createOps = log.filter((l) => l.op === 'create' && l.table === 'users');
    assert.equal(createOps.length, 1);
    const createArgs = createOps[0]!.args as { data: Record<string, unknown> };
    assert.equal(createArgs.data.name, 'New Author');

    // Should update parent (posts) FK to point to the new user
    const postUpdates = log.filter((l) => l.op === 'update' && l.table === 'posts');
    assert.ok(postUpdates.length >= 1, 'Should update parent FK');
  });

  it('throws ValidationError when belongsTo upsert is missing fields', async () => {
    const { ctx } = makeMockCtx(schema);

    await assert.rejects(
      () =>
        executeNestedUpdate(
          ctx,
          'posts',
          { id: 10 },
          {
            author: { upsert: { where: { id: 5 } } },
          },
        ),
      (err: Error) => {
        assert.ok(err instanceof ValidationError);
        assert.ok(err.message.includes('requires "where", "create", and "update"'));
        return true;
      },
    );
  });
});

// ---------------------------------------------------------------------------
// Validation: update/upsert rejected in create context
// ---------------------------------------------------------------------------

describe('nested-write: update/upsert validation in create context', () => {
  it('throws ValidationError for update inside create()', async () => {
    const { ctx } = makeMockCtx(schema);

    await assert.rejects(
      () =>
        executeNestedCreate(ctx, 'users', {
          email: 'x',
          posts: { update: { where: { id: 1 }, data: { title: 'x' } } },
        }),
      (err: Error) => {
        assert.ok(err instanceof ValidationError);
        assert.ok(err.message.includes('only valid inside update()'));
        return true;
      },
    );
  });

  it('throws ValidationError for upsert inside create()', async () => {
    const { ctx } = makeMockCtx(schema);

    await assert.rejects(
      () =>
        executeNestedCreate(ctx, 'users', {
          email: 'x',
          posts: { upsert: { where: { id: 1 }, create: { title: 'a' }, update: { title: 'b' } } },
        }),
      (err: Error) => {
        assert.ok(err instanceof ValidationError);
        assert.ok(err.message.includes('only valid inside update()'));
        return true;
      },
    );
  });
});
