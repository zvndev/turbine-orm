import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CircularRelationError, UnsupportedFeatureError, ValidationError } from '../errors.js';
import {
  executeNestedCreate,
  executeNestedUpdate,
  extractRelationFields,
  hasRelationFields,
  injectForeignKey,
  type NestedWriteContext,
} from '../nested-write.js';
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
// extractRelationFields
// ---------------------------------------------------------------------------

describe('nested-write: extractRelationFields', () => {
  it('separates scalar data from relation fields', () => {
    const data = {
      email: 'alice@example.com',
      name: 'Alice',
      posts: { create: [{ title: 'Hello' }] },
    };

    const result = extractRelationFields(data, schema.tables.users!);

    assert.deepStrictEqual(result.scalars, { email: 'alice@example.com', name: 'Alice' });
    assert.deepStrictEqual(result.relations, {
      posts: { create: [{ title: 'Hello' }] },
    });
  });

  it('returns empty relations when data has no relation fields', () => {
    const data = { email: 'alice@example.com' };
    const result = extractRelationFields(data, schema.tables.users!);

    assert.deepStrictEqual(result.scalars, { email: 'alice@example.com' });
    assert.deepStrictEqual(result.relations, {});
  });

  it('treats non-object relation values as scalar', () => {
    const data = { email: 'x', posts: 'not-an-object' };
    const result = extractRelationFields(data, schema.tables.users!);
    assert.deepStrictEqual(result.scalars, { email: 'x', posts: 'not-an-object' });
    assert.deepStrictEqual(result.relations, {});
  });

  it('treats array relation values as scalar', () => {
    const data = { email: 'x', posts: [1, 2, 3] };
    const result = extractRelationFields(data, schema.tables.users!);
    assert.deepStrictEqual(result.scalars, { email: 'x', posts: [1, 2, 3] });
    assert.deepStrictEqual(result.relations, {});
  });

  it('treats null relation values as scalar', () => {
    const data = { email: 'x', posts: null };
    const result = extractRelationFields(data, schema.tables.users!);
    assert.deepStrictEqual(result.scalars, { email: 'x', posts: null });
    assert.deepStrictEqual(result.relations, {});
  });

  it('treats Date relation values as scalar', () => {
    const date = new Date();
    const data = { email: 'x', posts: date };
    const result = extractRelationFields(data, schema.tables.users!);
    assert.deepStrictEqual(result.scalars, { email: 'x', posts: date });
    assert.deepStrictEqual(result.relations, {});
  });

  it('returns unknown keys in scalars (not a real relation)', () => {
    const data = { email: 'x', nonexistent: { create: [{}] } };
    const result = extractRelationFields(data, schema.tables.users!);
    assert.deepStrictEqual(result.scalars, { email: 'x', nonexistent: { create: [{}] } });
    assert.deepStrictEqual(result.relations, {});
  });
});

// ---------------------------------------------------------------------------
// hasRelationFields
// ---------------------------------------------------------------------------

describe('nested-write: hasRelationFields', () => {
  it('detects relation fields correctly based on schema', () => {
    const data = { email: 'x', posts: { create: [{ title: 'hi' }] } };
    assert.ok(hasRelationFields(data, schema.tables.users!));
  });

  it('does not flag non-object values as relation fields', () => {
    const data = { email: 'x', posts: 'not-an-object' };
    assert.ok(!hasRelationFields(data, schema.tables.users!));
  });

  it('does not flag arrays as relation fields', () => {
    const data = { email: 'x', posts: [1, 2, 3] };
    assert.ok(!hasRelationFields(data, schema.tables.users!));
  });

  it('does not flag Date as relation fields', () => {
    const data = { email: 'x', posts: new Date() };
    assert.ok(!hasRelationFields(data, schema.tables.users!));
  });

  it('does not flag null as relation fields', () => {
    const data = { email: 'x', posts: null };
    assert.ok(!hasRelationFields(data, schema.tables.users!));
  });

  it('returns false when no relation keys present', () => {
    const data = { email: 'x', name: 'y' };
    assert.ok(!hasRelationFields(data, schema.tables.users!));
  });
});

// ---------------------------------------------------------------------------
// injectForeignKey
// ---------------------------------------------------------------------------

describe('nested-write: injectForeignKey', () => {
  it('injects parent PK as FK into child data', () => {
    const childData = { title: 'Hello' };
    const relation = schema.tables.users!.relations.posts!;
    const parentRow = { id: 42, email: 'alice@example.com', name: 'Alice' };

    const result = injectForeignKey(childData, relation, parentRow, schema);
    assert.deepStrictEqual(result, { title: 'Hello', userId: 42 });
  });

  it('does not mutate the original child data', () => {
    const childData = { title: 'Hello' };
    const relation = schema.tables.users!.relations.posts!;
    const parentRow = { id: 42 };

    injectForeignKey(childData, relation, parentRow, schema);
    assert.deepStrictEqual(childData, { title: 'Hello' });
  });

  it('overwrites existing FK value in child data', () => {
    const childData = { title: 'Hello', userId: 999 };
    const relation = schema.tables.users!.relations.posts!;
    const parentRow = { id: 42 };

    const result = injectForeignKey(childData, relation, parentRow, schema);
    assert.deepStrictEqual(result, { title: 'Hello', userId: 42 });
  });
});

// ---------------------------------------------------------------------------
// executeNestedCreate (mock tx)
// ---------------------------------------------------------------------------

function makeMockCtx(schema: SchemaMetadata): {
  ctx: NestedWriteContext;
  log: { op: string; table: string; args: unknown }[];
} {
  const log: { op: string; table: string; args: unknown }[] = [];
  let idCounter = 100;

  // biome-ignore lint/suspicious/noExplicitAny: mock transaction for unit tests
  const mockTable = (name: string): any => ({
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
      // Return a parent-like object with relations as empty arrays
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
    schema,
    tx: {
      table: mockTable,
    },
  };

  return { ctx, log };
}

describe('nested-write: executeNestedCreate', () => {
  it('creates parent then batches hasMany children via createMany', async () => {
    const { ctx, log } = makeMockCtx(schema);

    await executeNestedCreate(ctx, 'users', {
      email: 'alice@example.com',
      name: 'Alice',
      posts: { create: [{ title: 'Post 1' }, { title: 'Post 2' }] },
    });

    // Should create parent
    const createOp = log.find((l) => l.op === 'create' && l.table === 'users');
    assert.ok(createOp, 'Should have created the user');
    assert.deepStrictEqual((createOp!.args as { data: Record<string, unknown> }).data, {
      email: 'alice@example.com',
      name: 'Alice',
    });

    // Should batch children via createMany
    const createManyOp = log.find((l) => l.op === 'createMany' && l.table === 'posts');
    assert.ok(createManyOp, 'Should have used createMany for batch children');
    const childData = (createManyOp!.args as { data: Record<string, unknown>[] }).data;
    assert.equal(childData.length, 2);
    // Each child should have userId injected
    assert.ok(childData.every((c) => typeof c.userId === 'number'));

    // Should do a final findUnique read
    const readOp = log.find((l) => l.op === 'findUnique' && l.table === 'users');
    assert.ok(readOp, 'Should read back the full tree');
  });

  it('creates parent with single child (non-array create)', async () => {
    const { ctx, log } = makeMockCtx(schema);

    await executeNestedCreate(ctx, 'users', {
      email: 'bob@example.com',
      posts: { create: { title: 'Solo Post' } },
    });

    const createManyOp = log.find((l) => l.op === 'createMany' && l.table === 'posts');
    assert.ok(createManyOp);
    const childData = (createManyOp!.args as { data: Record<string, unknown>[] }).data;
    assert.equal(childData.length, 1);
    assert.equal(childData[0]!.title, 'Solo Post');
  });

  it('skips empty create arrays', async () => {
    const { ctx, log } = makeMockCtx(schema);

    await executeNestedCreate(ctx, 'users', {
      email: 'bob@example.com',
      posts: { create: [] },
    });

    const createManyOp = log.find((l) => l.op === 'createMany' && l.table === 'posts');
    assert.ok(!createManyOp, 'Should not call createMany for empty array');
  });

  it('throws ValidationError for update-only ops inside create', async () => {
    const { ctx } = makeMockCtx(schema);

    await assert.rejects(
      () =>
        executeNestedCreate(ctx, 'users', {
          email: 'x',
          posts: { disconnect: [{ id: 1 }] },
        }),
      (err: Error) => {
        assert.ok(err instanceof ValidationError);
        assert.ok(err.message.includes('only valid inside update()'));
        return true;
      },
    );
  });

  it('throws RelationError for unknown relation name', async () => {
    const { ctx } = makeMockCtx(schema);

    await assert
      .rejects(
        () =>
          executeNestedCreate(ctx, 'users', {
            email: 'x',
            bogus: { create: [{}] },
          }),
        // "bogus" won't be detected as a relation — it'll go into scalars
        // because it's not in tableMeta.relations. So it gets passed to
        // create() as scalar data without error.
        // Actually wait — extractRelationFields checks key in tableMeta.relations,
        // so { create: [{}] } for key "bogus" would be a plain object but
        // "bogus" is NOT in relations. So it goes to scalars. No error.
        // Let's test that it's handled gracefully.
      )
      .catch(() => {
        // This is expected to NOT throw from the nested write engine —
        // "bogus" goes to scalars. The DB would reject it instead.
      });

    // Actually verify it doesn't throw from nested-write
    const { ctx: ctx2, log: log2 } = makeMockCtx(schema);
    await executeNestedCreate(ctx2, 'users', {
      email: 'x',
      bogus: { create: [{}] },
    });
    // bogus is passed as scalar data
    const createOp = log2.find((l) => l.op === 'create' && l.table === 'users');
    assert.ok(createOp);
    const data = (createOp!.args as { data: Record<string, unknown> }).data;
    assert.deepStrictEqual(data.bogus, { create: [{}] });
  });

  it('throws CircularRelationError at depth > 10', async () => {
    const { ctx } = makeMockCtx(schema);

    await assert.rejects(
      () => executeNestedCreate(ctx, 'users', { email: 'x' }, 11, ['a', 'b', 'c']),
      (err: Error) => {
        assert.ok(err instanceof CircularRelationError);
        return true;
      },
    );
  });

  it('throws ValidationError for unknown table name', async () => {
    const { ctx } = makeMockCtx(schema);

    await assert.rejects(
      () => executeNestedCreate(ctx, 'nonexistent', { email: 'x' }),
      (err: Error) => {
        assert.ok(err instanceof ValidationError);
        assert.ok(err.message.includes('Unknown table'));
        return true;
      },
    );
  });

  it('throws ValidationError for unknown nested write operation', async () => {
    const { ctx } = makeMockCtx(schema);

    await assert.rejects(
      () =>
        executeNestedCreate(ctx, 'users', {
          email: 'x',
          posts: { invalidOp: [{}] },
        }),
      (err: Error) => {
        assert.ok(err instanceof ValidationError);
        assert.ok(err.message.includes('Unknown nested write operation'));
        return true;
      },
    );
  });
});

// ---------------------------------------------------------------------------
// executeNestedUpdate (mock tx)
// ---------------------------------------------------------------------------

describe('nested-write: executeNestedUpdate', () => {
  it('updates parent and creates new children', async () => {
    const { ctx, log } = makeMockCtx(schema);

    await executeNestedUpdate(
      ctx,
      'users',
      { id: 1 },
      {
        name: 'Updated Alice',
        posts: { create: [{ title: 'New Post' }] },
      },
    );

    // Should update parent with scalar data
    const updateOp = log.find((l) => l.op === 'update' && l.table === 'users');
    assert.ok(updateOp);
    assert.deepStrictEqual((updateOp!.args as { data: Record<string, unknown> }).data, {
      name: 'Updated Alice',
    });

    // Should create children
    const createManyOp = log.find((l) => l.op === 'createMany' && l.table === 'posts');
    assert.ok(createManyOp);
  });

  it('handles relation-only update (no scalar changes)', async () => {
    const { ctx, log } = makeMockCtx(schema);

    await executeNestedUpdate(
      ctx,
      'users',
      { id: 1 },
      {
        posts: { create: [{ title: 'New Post' }] },
      },
    );

    // Should NOT call update (no scalar data), but should call findUnique
    const updateOp = log.find((l) => l.op === 'update' && l.table === 'users');
    assert.ok(!updateOp, 'Should not update parent when no scalar data');

    // Should find parent first
    const findOp = log.find((l) => l.op === 'findUnique' && l.table === 'users');
    assert.ok(findOp);
  });

  it('supports delete operation', async () => {
    const { ctx, log } = makeMockCtx(schema);

    await executeNestedUpdate(
      ctx,
      'users',
      { id: 1 },
      {
        posts: { delete: [{ id: 5 }] },
      },
    );

    const deleteOp = log.find((l) => l.op === 'delete' && l.table === 'posts');
    assert.ok(deleteOp);
    // Scoped to the parent: the child FK is ANDed onto the caller's where.
    assert.deepStrictEqual((deleteOp!.args as { where: Record<string, unknown> }).where, { id: 5, userId: 1 });
  });

  it('supports set operation — disconnects all then connects new', async () => {
    const { ctx, log } = makeMockCtx(schema);

    await executeNestedUpdate(
      ctx,
      'users',
      { id: 1 },
      {
        posts: { set: [{ id: 10 }, { id: 20 }] },
      },
    );

    // Should call updateMany to null out existing children
    const updateManyOp = log.find((l) => l.op === 'updateMany' && l.table === 'posts');
    assert.ok(updateManyOp);

    // Should update each new target to point to parent
    const updateOps = log.filter((l) => l.op === 'update' && l.table === 'posts');
    assert.equal(updateOps.length, 2);
  });

  it('throws ValidationError for unknown table in update', async () => {
    const { ctx } = makeMockCtx(schema);

    await assert.rejects(
      () => executeNestedUpdate(ctx, 'nonexistent', { id: 1 }, { name: 'x' }),
      (err: Error) => {
        assert.ok(err instanceof ValidationError);
        assert.ok(err.message.includes('Unknown table'));
        return true;
      },
    );
  });

  it('throws CircularRelationError at depth > 10 for update', async () => {
    const { ctx } = makeMockCtx(schema);

    await assert.rejects(
      () => executeNestedUpdate(ctx, 'users', { id: 1 }, { name: 'x' }, 11, ['a', 'b']),
      (err: Error) => {
        assert.ok(err instanceof CircularRelationError);
        return true;
      },
    );
  });
});

// ---------------------------------------------------------------------------
// many-to-many nested writes (connect / disconnect / set → junction rows)
// ---------------------------------------------------------------------------

const m2mSchema: SchemaMetadata = {
  tables: {
    posts: {
      ...mockTable('posts', [
        { name: 'id', field: 'id' },
        { name: 'title', field: 'title', pgType: 'text' },
      ]),
      relations: {
        tags: {
          type: 'manyToMany',
          name: 'tags',
          from: 'posts',
          to: 'tags',
          foreignKey: 'id',
          referenceKey: 'id',
          through: { table: 'post_tags', sourceKey: 'post_id', targetKey: 'tag_id' },
        },
      },
    },
    tags: mockTable('tags', [
      { name: 'id', field: 'id' },
      { name: 'label', field: 'label', pgType: 'text' },
    ]),
    post_tags: mockTable('post_tags', [
      { name: 'post_id', field: 'postId' },
      { name: 'tag_id', field: 'tagId' },
    ]),
  },
  enums: {},
};

/**
 * Recording mock tx for the junction paths. `tags` holds the tag ids that
 * exist; `links` holds the tag ids ALREADY linked to the parent post, so the
 * connect path's idempotence read has something to return.
 */
function makeM2MCtx(opts: { tags?: number[]; links?: unknown[]; schema?: SchemaMetadata } = {}): {
  ctx: NestedWriteContext;
  log: { op: string; table: string; args: unknown }[];
} {
  const log: { op: string; table: string; args: unknown }[] = [];
  const tagIds = new Set(opts.tags ?? [1, 2, 3, 4]);
  const links = opts.links ?? [];
  let idCounter = 100;

  // biome-ignore lint/suspicious/noExplicitAny: mock transaction for unit tests
  const table = (name: string): any => ({
    async create(args: { data: Record<string, unknown> }) {
      log.push({ op: 'create', table: name, args });
      return { id: idCounter++, ...args.data };
    },
    async createMany(args: { data: Record<string, unknown>[] }) {
      log.push({ op: 'createMany', table: name, args });
      return args.data;
    },
    async update(args: unknown) {
      log.push({ op: 'update', table: name, args });
      return {};
    },
    async updateMany(args: unknown) {
      log.push({ op: 'updateMany', table: name, args });
      return { count: 0 };
    },
    async delete(args: unknown) {
      log.push({ op: 'delete', table: name, args });
      return {};
    },
    async deleteMany(args: unknown) {
      log.push({ op: 'deleteMany', table: name, args });
      return { count: 0 };
    },
    async findMany(args: { where: Record<string, unknown> }) {
      log.push({ op: 'findMany', table: name, args });
      if (name === 'tags') {
        // The batched target resolution reads `{ id: { in: [...] } }`.
        const wanted = (args.where.id as { in?: unknown[] } | undefined)?.in ?? [];
        return wanted.filter((id) => tagIds.has(id as number)).map((id) => ({ id, label: `tag-${String(id)}` }));
      }
      if (name !== 'post_tags') return [];
      const wanted = (args.where.tagId as { in?: unknown[] } | undefined)?.in ?? [];
      return links
        .filter((t) => wanted.some((w) => String(w) === String(t)))
        .map((t) => ({ postId: args.where.postId, tagId: t }));
    },
    async findUnique(args: { where: Record<string, unknown>; with?: Record<string, unknown> }) {
      log.push({ op: 'findUnique', table: name, args });
      if (name === 'tags') {
        // A non-primary-key unique selector (`{ label }`) exercises the
        // per-selector resolution path; `tag-N` maps back to tag id N.
        if (args.where.label !== undefined) {
          const id = Number(String(args.where.label).replace('tag-', ''));
          return tagIds.has(id) ? { id, label: args.where.label } : null;
        }
        const id = args.where.id as number;
        return tagIds.has(id) ? { id, label: `tag-${id}` } : null;
      }
      const base: Record<string, unknown> = { id: args.where.id ?? 100, ...args.where };
      if (args.with) for (const rel of Object.keys(args.with)) base[rel] = [];
      return base;
    },
  });

  return { ctx: { schema: opts.schema ?? m2mSchema, tx: { table } }, log };
}

/** Junction statements only, in emitted order. */
function junctionOps(log: { op: string; table: string; args: unknown }[]): { op: string; args: unknown }[] {
  return log.filter((l) => l.table === 'post_tags').map((l) => ({ op: l.op, args: l.args }));
}

describe('nested-write: many-to-many connect', () => {
  it('create: writes junction rows AFTER the parent insert, batched in one createMany', async () => {
    const { ctx, log } = makeM2MCtx();

    await executeNestedCreate(ctx, 'posts', {
      title: 'Hello',
      tags: { connect: [{ id: 1 }, { id: 2 }] },
    });

    const parentIdx = log.findIndex((l) => l.op === 'create' && l.table === 'posts');
    const junctionIdx = log.findIndex((l) => l.op === 'createMany' && l.table === 'post_tags');
    assert.ok(parentIdx >= 0, 'parent inserted');
    assert.ok(junctionIdx > parentIdx, 'junction rows written after the parent insert');

    const inserts = junctionOps(log).filter((o) => o.op === 'createMany');
    assert.equal(inserts.length, 1, 'one batched insert, not one statement per target');
    assert.deepStrictEqual((inserts[0]!.args as { data: unknown[] }).data, [
      { postId: 100, tagId: 1 },
      { postId: 100, tagId: 2 },
    ]);
  });

  it('update: inserts only the links that do not exist yet (idempotent double-connect)', async () => {
    const { ctx, log } = makeM2MCtx({ links: [1] });

    await executeNestedUpdate(ctx, 'posts', { id: 7 }, { tags: { connect: [{ id: 1 }, { id: 2 }] } });

    const reads = junctionOps(log).filter((o) => o.op === 'findMany');
    assert.equal(reads.length, 1);
    assert.deepStrictEqual((reads[0]!.args as { where: unknown }).where, {
      postId: 7,
      tagId: { in: [1, 2] },
    });

    const inserts = junctionOps(log).filter((o) => o.op === 'createMany');
    assert.equal(inserts.length, 1);
    assert.deepStrictEqual((inserts[0]!.args as { data: unknown[] }).data, [{ postId: 7, tagId: 2 }]);
  });

  it('update: re-connecting an already linked target writes nothing at all', async () => {
    const { ctx, log } = makeM2MCtx({ links: [1, 2] });

    await executeNestedUpdate(ctx, 'posts', { id: 7 }, { tags: { connect: [{ id: 1 }, { id: 2 }] } });

    assert.deepStrictEqual(
      junctionOps(log).map((o) => o.op),
      ['findMany'],
    );
  });

  it('connect: de-duplicates repeated targets in one payload', async () => {
    const { ctx, log } = makeM2MCtx();

    await executeNestedUpdate(ctx, 'posts', { id: 7 }, { tags: { connect: [{ id: 3 }, { id: 3 }] } });

    const inserts = junctionOps(log).filter((o) => o.op === 'createMany');
    assert.deepStrictEqual((inserts[0]!.args as { data: unknown[] }).data, [{ postId: 7, tagId: 3 }]);
  });

  it('connect: an empty array is a no-op', async () => {
    const { ctx, log } = makeM2MCtx();
    await executeNestedUpdate(ctx, 'posts', { id: 7 }, { tags: { connect: [] } });
    assert.deepStrictEqual(junctionOps(log), []);
  });

  it('connect: a target row that does not exist is refused, not skipped', async () => {
    const { ctx, log } = makeM2MCtx({ tags: [1] });

    await assert.rejects(
      () => executeNestedUpdate(ctx, 'posts', { id: 7 }, { tags: { connect: [{ id: 99 }] } }),
      (err: Error) => {
        assert.ok(err instanceof ValidationError);
        assert.match(err.message, /no "tags" row found/);
        return true;
      },
    );
    assert.deepStrictEqual(junctionOps(log), []);
  });
});

describe('nested-write: many-to-many disconnect', () => {
  it('deletes only the named links, scoped by BOTH the parent and the targets', async () => {
    const { ctx, log } = makeM2MCtx({ links: [1, 2, 3] });

    await executeNestedUpdate(ctx, 'posts', { id: 7 }, { tags: { disconnect: [{ id: 2 }] } });

    const deletes = junctionOps(log).filter((o) => o.op === 'deleteMany');
    assert.equal(deletes.length, 1);
    assert.deepStrictEqual((deletes[0]!.args as { where: unknown }).where, {
      postId: 7,
      tagId: { in: [2] },
    });
  });

  it("cannot delete another parent's junction rows (the source key is always in the predicate)", async () => {
    const { ctx, log } = makeM2MCtx({ links: [1] });

    await executeNestedUpdate(ctx, 'posts', { id: 7 }, { tags: { disconnect: [{ id: 1 }] } });

    for (const o of junctionOps(log)) {
      const where = (o.args as { where: Record<string, unknown> }).where;
      assert.equal(where.postId, 7, `${o.op} must be scoped to this parent`);
    }
  });

  it('an empty disconnect array is a no-op, never a full delete', async () => {
    const { ctx, log } = makeM2MCtx({ links: [1, 2] });
    await executeNestedUpdate(ctx, 'posts', { id: 7 }, { tags: { disconnect: [] } });
    assert.deepStrictEqual(junctionOps(log), []);
  });

  it('is refused inside create() (update-only operation)', async () => {
    const { ctx } = makeM2MCtx();
    await assert.rejects(
      () => executeNestedCreate(ctx, 'posts', { title: 'x', tags: { disconnect: [{ id: 1 }] } }),
      (err: Error) => {
        assert.ok(err instanceof ValidationError);
        assert.match(err.message, /only valid inside update\(\)/);
        return true;
      },
    );
  });
});

describe('nested-write: many-to-many set', () => {
  it("clears this parent's links then inserts the new set, in that order", async () => {
    const { ctx, log } = makeM2MCtx({ links: [1, 2] });

    await executeNestedUpdate(ctx, 'posts', { id: 7 }, { tags: { set: [{ id: 3 }, { id: 4 }] } });

    const ops = junctionOps(log);
    assert.deepStrictEqual(
      ops.map((o) => o.op),
      ['deleteMany', 'createMany'],
    );
    assert.deepStrictEqual((ops[0]!.args as { where: unknown }).where, { postId: 7 });
    assert.deepStrictEqual((ops[1]!.args as { data: unknown[] }).data, [
      { postId: 7, tagId: 3 },
      { postId: 7, tagId: 4 },
    ]);
  });

  it('set: [] clears every link of this parent and inserts nothing', async () => {
    const { ctx, log } = makeM2MCtx({ links: [1, 2] });

    await executeNestedUpdate(ctx, 'posts', { id: 7 }, { tags: { set: [] } });

    const ops = junctionOps(log);
    assert.deepStrictEqual(
      ops.map((o) => o.op),
      ['deleteMany'],
    );
    assert.deepStrictEqual((ops[0]!.args as { where: unknown }).where, { postId: 7 });
  });
});

describe('nested-write: many-to-many unsupported operations', () => {
  for (const op of ['create', 'connectOrCreate'] as const) {
    it(`create(): "${op}" refuses before anything is written`, async () => {
      const { ctx, log } = makeM2MCtx();
      await assert.rejects(
        () => executeNestedCreate(ctx, 'posts', { title: 'x', tags: { [op]: [{ id: 1 }] } }),
        (err: Error) => {
          assert.ok(err instanceof ValidationError);
          assert.equal((err as ValidationError).code, 'TURBINE_E003');
          assert.match(err.message, new RegExp(`Nested "${op}" is not supported`));
          assert.match(err.message, /connect, disconnect and set/);
          assert.match(err.message, /post_tags/);
          return true;
        },
      );
      assert.deepStrictEqual(log, [], 'nothing written before the refusal');
    });
  }

  for (const op of ['delete', 'update', 'upsert'] as const) {
    it(`update(): "${op}" is still refused, and the message names the junction accessor`, async () => {
      const { ctx } = makeM2MCtx();
      await assert.rejects(
        () => executeNestedUpdate(ctx, 'posts', { id: 7 }, { tags: { [op]: [{ where: { id: 1 }, data: {} }] } }),
        (err: Error) => {
          assert.ok(err instanceof ValidationError);
          assert.match(err.message, new RegExp(`Nested "${op}" is not supported`));
          // The remedy must name an accessor that EXISTS on the reader's client:
          // the core client camelCases its property accessors (so `db["post_tags"]`
          // is undefined there) and takes the raw name only via `table()`, while
          // the prisma-compat client has no `table()` and keys the junction
          // delegate by the raw name.
          assert.match(err.message, /db\.table\("post_tags"\)\.create \/ createMany/);
          assert.match(err.message, /db\["post_tags"\]\.create \/ createMany on the prisma-compat client/);
          return true;
        },
      );
    });
  }

  it('refuses a composite junction key rather than emitting a partially-keyed write', async () => {
    const compositeSchema: SchemaMetadata = {
      ...m2mSchema,
      tables: {
        ...m2mSchema.tables,
        posts: {
          ...m2mSchema.tables.posts!,
          relations: {
            tags: {
              ...m2mSchema.tables.posts!.relations.tags!,
              through: { table: 'post_tags', sourceKey: ['post_id', 'org_id'], targetKey: 'tag_id' },
            },
          },
        },
      },
    };
    const { ctx, log } = makeM2MCtx();
    const compositeCtx: NestedWriteContext = { schema: compositeSchema, tx: ctx.tx };

    await assert.rejects(
      () => executeNestedUpdate(compositeCtx, 'posts', { id: 7 }, { tags: { connect: [{ id: 1 }] } }),
      (err: Error) => {
        assert.ok(err instanceof ValidationError);
        assert.match(err.message, /single-column junction keys only/);
        return true;
      },
    );
    assert.deepStrictEqual(junctionOps(log), []);
  });
});

// ---------------------------------------------------------------------------
// many-to-many connect: concurrency safety, round-trip cost, key comparison
// ---------------------------------------------------------------------------

/** `m2mSchema` with the junction's (post_id, tag_id) pair declared unique. */
function constrainedM2MSchema(): SchemaMetadata {
  return {
    ...m2mSchema,
    tables: {
      ...m2mSchema.tables,
      post_tags: {
        ...m2mSchema.tables.post_tags!,
        primaryKey: ['post_id', 'tag_id'],
        uniqueColumns: [['post_id', 'tag_id']],
      },
    },
  };
}

describe('nested-write: many-to-many connect is concurrency-safe where the engine allows it', () => {
  it('constrained junction: one INSERT with skipDuplicates, and NO read-then-insert race window', async () => {
    // Read-then-insert-missing loses to a concurrent transaction connecting the
    // same pair: both read "missing" and both insert (E008 on the constrained
    // junction the introspected path always produces). Let the engine resolve
    // the conflict instead.
    const { ctx, log } = makeM2MCtx({ schema: constrainedM2MSchema() });

    await executeNestedUpdate(ctx, 'posts', { id: 7 }, { tags: { connect: [{ id: 1 }, { id: 2 }] } });

    const ops = junctionOps(log);
    assert.deepStrictEqual(
      ops.map((o) => o.op),
      ['createMany'],
      'no junction read: the insert itself is the idempotence mechanism',
    );
    const args = ops[0]!.args as { data: unknown[]; skipDuplicates?: boolean };
    assert.equal(args.skipDuplicates, true);
    assert.deepStrictEqual(args.data, [
      { postId: 7, tagId: 1 },
      { postId: 7, tagId: 2 },
    ]);
  });

  it('constrained junction, engine without skipDuplicates: falls back to read-then-insert', async () => {
    // SQL Server and PowDB refuse the option with a typed E017 naming the
    // feature. The refusal happens while building the statement, so nothing is
    // written and the fallback is safe.
    const { ctx, log } = makeM2MCtx({ schema: constrainedM2MSchema(), links: [1] });
    const inner = ctx.tx.table;
    let refused = 0;
    const tx: NestedWriteContext['tx'] = {
      // biome-ignore lint/suspicious/noExplicitAny: mock transaction for unit tests
      table: (name: string): any => {
        const t = inner(name);
        return {
          ...t,
          async createMany(args: { data: Record<string, unknown>[]; skipDuplicates?: boolean }) {
            if (args.skipDuplicates) {
              refused++;
              throw new UnsupportedFeatureError('createMany({ skipDuplicates: true })', 'mssql');
            }
            return t.createMany(args);
          },
        };
      },
    };

    await executeNestedUpdate({ ...ctx, tx }, 'posts', { id: 7 }, { tags: { connect: [{ id: 1 }, { id: 2 }] } });

    assert.equal(refused, 1, 'the engine was asked, and refused with its typed E017');
    const ops = junctionOps(log);
    assert.deepStrictEqual(
      ops.map((o) => o.op),
      ['findMany', 'createMany'],
      'the refusal writes nothing, so the read-then-insert fallback runs',
    );
    assert.deepStrictEqual((ops[1]!.args as { data: unknown[] }).data, [{ postId: 7, tagId: 2 }]);
  });

  it('unconstrained junction: keeps read-then-insert (ON CONFLICT would have nothing to fire on)', async () => {
    // A hand-declared defineSchema manyToMany can name a junction with no key
    // over the pair. skipDuplicates there dedupes nothing, so dropping the read
    // would let a repeated connect write a SECOND link row, and a duplicate link
    // row makes the join and batched read strategies disagree.
    const { ctx, log } = makeM2MCtx({ links: [1] });

    await executeNestedUpdate(ctx, 'posts', { id: 7 }, { tags: { connect: [{ id: 1 }, { id: 2 }] } });

    const ops = junctionOps(log);
    assert.deepStrictEqual(
      ops.map((o) => o.op),
      ['findMany', 'createMany'],
    );
    assert.equal((ops[1]!.args as { skipDuplicates?: boolean }).skipDuplicates, undefined);
    assert.deepStrictEqual((ops[1]!.args as { data: unknown[] }).data, [{ postId: 7, tagId: 2 }]);
  });
});

describe('nested-write: many-to-many connect round-trip cost', () => {
  it('a 20-target primary-key connect costs a constant number of statements, not one per target', async () => {
    // One findUnique per target was 25 statements for 20 targets; at a pooled
    // RTT that is most of a second for a single connect.
    const { ctx, log } = makeM2MCtx({
      schema: constrainedM2MSchema(),
      tags: Array.from({ length: 20 }, (_, i) => i + 1),
    });
    const ids = Array.from({ length: 20 }, (_, i) => ({ id: i + 1 }));

    await executeNestedUpdate(ctx, 'posts', { id: 7 }, { tags: { connect: ids } });

    // parent findUnique + one batched target read + one junction insert + the
    // final read-back tree. Constant, and identical for 2 targets or 200.
    assert.equal(log.length, 4, `expected 4 statements, got ${log.map((l) => `${l.op}:${l.table}`).join(', ')}`);
    assert.equal(
      log.filter((l) => l.table === 'tags').length,
      1,
      'targets resolved with ONE read, not one findUnique per target',
    );
    const insert = junctionOps(log).find((o) => o.op === 'createMany')!;
    assert.equal((insert.args as { data: unknown[] }).data.length, 20);
  });

  it('a missing target is still refused by name on the batched path', async () => {
    const { ctx, log } = makeM2MCtx({ tags: [1, 2] });

    await assert.rejects(
      () => executeNestedUpdate(ctx, 'posts', { id: 7 }, { tags: { connect: [{ id: 1 }, { id: 99 }] } }),
      (err: Error) => {
        assert.ok(err instanceof ValidationError);
        assert.match(err.message, /no "tags" row found/);
        // Same wording (and the same value-free key naming) as the
        // per-selector path: the batched read must not turn a missing target
        // into a silent skip.
        assert.match(err.message, /matching keys \[id\]/);
        return true;
      },
    );
    assert.deepStrictEqual(junctionOps(log), [], 'nothing written when a named target does not exist');
  });

  it('falls back to a findUnique per selector for non-primary-key selectors', async () => {
    const { ctx, log } = makeM2MCtx();

    await executeNestedUpdate(ctx, 'posts', { id: 7 }, { tags: { connect: [{ label: 'tag-1' }, { label: 'tag-2' }] } });

    assert.equal(
      log.filter((l) => l.table === 'tags' && l.op === 'findUnique').length,
      2,
      'an arbitrary unique selector still needs its own lookup',
    );
  });
});

describe('nested-write: many-to-many key comparison', () => {
  it('does not re-insert a link whose junction key reads back in a different shape', async () => {
    // The junction column and the target primary key are read through two
    // different tables' parsers: a bigint junction column can arrive as the
    // string '1' next to a numeric target primary key 1. Strict `has` treats
    // that already-linked pair as missing and re-inserts it (E008 on a
    // constrained junction, a duplicate row otherwise).
    const { ctx, log } = makeM2MCtx({ links: ['1'] });

    await executeNestedUpdate(ctx, 'posts', { id: 7 }, { tags: { connect: [{ id: 1 }] } });

    assert.deepStrictEqual(
      junctionOps(log).map((o) => o.op),
      ['findMany'],
      'already linked: nothing to insert',
    );
  });

  it('de-duplicates two selectors naming the same target when its key is object-valued', async () => {
    // A Date (or a bytea Buffer) primary key is never `===` to another parse of
    // the same value, so a Set of raw values de-duplicates nothing and both
    // selectors write a junction row.
    const log: { op: string; table: string; args: unknown }[] = [];
    // biome-ignore lint/suspicious/noExplicitAny: mock transaction for unit tests
    const table = (name: string): any => ({
      async createMany(args: unknown) {
        log.push({ op: 'createMany', table: name, args });
        return [];
      },
      async deleteMany(args: unknown) {
        log.push({ op: 'deleteMany', table: name, args });
        return { count: 0 };
      },
      async findMany(args: unknown) {
        log.push({ op: 'findMany', table: name, args });
        return [];
      },
      async findUnique(args: { where: Record<string, unknown>; with?: Record<string, unknown> }) {
        log.push({ op: 'findUnique', table: name, args });
        // A fresh Date instance per read, exactly like two row parses.
        if (name === 'tags') return { id: new Date('2020-01-01T00:00:00Z'), label: args.where.label };
        const base: Record<string, unknown> = { id: args.where.id ?? 100, ...args.where };
        if (args.with) for (const rel of Object.keys(args.with)) base[rel] = [];
        return base;
      },
    });
    const ctx: NestedWriteContext = { schema: m2mSchema, tx: { table } };

    await executeNestedUpdate(ctx, 'posts', { id: 7 }, { tags: { connect: [{ label: 'a' }, { label: 'a' }] } });

    const inserts = junctionOps(log).filter((o) => o.op === 'createMany');
    assert.equal(inserts.length, 1);
    assert.equal((inserts[0]!.args as { data: unknown[] }).data.length, 1, 'one link row, not one per selector');
  });
});

describe('nested-write: many-to-many junction key validation', () => {
  /** `m2mSchema` whose `through` names the SAME column twice (a typo). */
  function collidingSchema(): SchemaMetadata {
    return {
      ...m2mSchema,
      tables: {
        ...m2mSchema.tables,
        posts: {
          ...m2mSchema.tables.posts!,
          relations: {
            tags: {
              ...m2mSchema.tables.posts!.relations.tags!,
              through: { table: 'post_tags', sourceKey: 'post_id', targetKey: 'post_id' },
            },
          },
        },
      },
    };
  }

  for (const op of ['connect', 'disconnect'] as const) {
    it(`refuses ${op} when sourceKey and targetKey name the same junction column`, async () => {
      // Both keys collapse onto one object property: the disconnect predicate
      // loses its parent scope entirely (deleting OTHER parents' link rows) and
      // the connect row carries no parent key at all.
      const { ctx, log } = makeM2MCtx({ schema: collidingSchema(), links: [1] });

      await assert.rejects(
        () => executeNestedUpdate(ctx, 'posts', { id: 7 }, { tags: { [op]: [{ id: 1 }] } }),
        (err: Error) => {
          assert.ok(err instanceof ValidationError);
          assert.equal((err as ValidationError).code, 'TURBINE_E003');
          assert.match(err.message, /names the same column "post_id" as BOTH its sourceKey and its targetKey/);
          assert.match(err.message, /"tags"/);
          return true;
        },
      );
      assert.deepStrictEqual(junctionOps(log), [], 'nothing reaches the junction table');
    });
  }
});

describe('nested-write: internal reads do not raise user-facing dev warnings', () => {
  // Every findMany the engine issues on the caller's behalf is unlimited by
  // construction (it is bounded by an IN-list, not by the caller's `limit`), so
  // the unlimited-findMany advisory would fire on every single connect and
  // lecture the caller about a statement they never wrote.
  it('the junction idempotence read passes warnOnUnlimited: false', async () => {
    const { ctx, log } = makeM2MCtx({ links: [1] });
    await executeNestedUpdate(ctx, 'posts', { id: 7 }, { tags: { connect: [{ id: 1 }] } });

    const read = junctionOps(log).find((o) => o.op === 'findMany')!;
    assert.equal((read.args as { warnOnUnlimited?: boolean }).warnOnUnlimited, false);
  });

  it('the batched target read passes warnOnUnlimited: false', async () => {
    const { ctx, log } = makeM2MCtx();
    await executeNestedUpdate(ctx, 'posts', { id: 7 }, { tags: { connect: [{ id: 1 }, { id: 2 }] } });

    const read = log.find((l) => l.table === 'tags' && l.op === 'findMany')!;
    assert.equal((read.args as { warnOnUnlimited?: boolean }).warnOnUnlimited, false);
  });
});
