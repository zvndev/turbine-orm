/**
 * turbine-orm: nested belongsTo update with a NULL parent foreign key
 *
 * `processBelongsToUpdate` used to derive its `where` straight from the
 * parent's FK values. When that FK is NULL the predicate compiled to
 * `refField IS NULL` and the UPDATE hit EVERY row of the related table whose
 * reference key is null. It now routes through the same correlation helper
 * every sibling operation uses, which reports not-found instead.
 *
 * Run: npx tsx --test src/test/nested-write-belongs-to-null-fk.test.ts
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { NotFoundError } from '../errors.js';
import { executeNestedUpdate, type NestedWriteContext } from '../nested-write.js';
import type { SchemaMetadata } from '../schema.js';
import { mockTable } from './helpers.js';

const schema: SchemaMetadata = {
  tables: {
    users: mockTable('users', [
      { name: 'id', field: 'id' },
      { name: 'name', field: 'name', pgType: 'text' },
    ]),
    posts: mockTable(
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
    ),
  },
  enums: {},
};

interface LogEntry {
  op: string;
  table: string;
  args: unknown;
}

/**
 * Recording mock transaction. `parentRow` is what the parent write returns,
 * so a test can hand back a post whose `userId` is null / absent.
 */
function makeMockCtx(parentRow: Record<string, unknown>): {
  ctx: NestedWriteContext;
  log: LogEntry[];
} {
  const log: LogEntry[] = [];

  // biome-ignore lint/suspicious/noExplicitAny: mock transaction for unit tests
  const table = (name: string): any => ({
    async create(args: unknown) {
      log.push({ op: 'create', table: name, args });
      return { id: 1 };
    },
    async update(args: { where: Record<string, unknown>; data: Record<string, unknown> }) {
      log.push({ op: 'update', table: name, args });
      return name === 'posts' ? parentRow : { ...args.where, ...args.data };
    },
    async findUnique(args: { where: Record<string, unknown> }) {
      log.push({ op: 'findUnique', table: name, args });
      return name === 'posts' ? parentRow : { ...args.where };
    },
    async findMany(args: unknown) {
      log.push({ op: 'findMany', table: name, args });
      return [];
    },
  });

  return { ctx: { schema, tx: { table } as NestedWriteContext['tx'] }, log };
}

describe('nested-write: belongsTo update with a null parent FK', () => {
  it('issues NO update on the related table and throws NotFoundError', async () => {
    const { ctx, log } = makeMockCtx({ id: 7, title: 'orphan', userId: null });

    await assert.rejects(
      () =>
        executeNestedUpdate(ctx, 'posts', { id: 7 }, { title: 'orphan', author: { update: { data: { name: 'X' } } } }),
      (err: unknown) => {
        assert.ok(err instanceof NotFoundError, `expected NotFoundError, got ${String(err)}`);
        assert.equal(err.operation, 'nested update');
        return true;
      },
    );

    const userUpdates = log.filter((l) => l.op === 'update' && l.table === 'users');
    assert.deepEqual(userUpdates, [], 'must not update the related table when the parent FK is null');
  });

  it('still updates the related row when the parent FK is set', async () => {
    const { ctx, log } = makeMockCtx({ id: 7, title: 'owned', userId: 42 });

    await executeNestedUpdate(ctx, 'posts', { id: 7 }, { title: 'owned', author: { update: { data: { name: 'X' } } } });

    const userUpdate = log.find((l) => l.op === 'update' && l.table === 'users');
    assert.ok(userUpdate, 'related row should be updated');
    assert.deepEqual((userUpdate.args as { where: Record<string, unknown> }).where, { id: 42 });
  });
});
