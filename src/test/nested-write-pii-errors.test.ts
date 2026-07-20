/**
 * turbine-orm: PII-safe nested-write "no row found" errors
 *
 * The nested-write engine's connect/update failures used to embed the raw
 * user-supplied `where` / `connect` target via `JSON.stringify(target)`, e.g.
 * `connect on "author": no users row found matching {"email":"alice@x.com"}`.
 * That leaks PII into logs, contradicting the rest of the error system, where
 * NotFoundError shows only WHERE KEYS in the default 'safe' mode.
 *
 * These messages now go through `describeTargetForMessage`, which honors the
 * global ErrorMessageMode exactly like NotFoundError: 'safe' shows only key
 * names (`keys [email]`); 'verbose' shows the full JSON.
 */

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { setErrorMessageMode, ValidationError } from '../errors.js';
import { executeNestedCreate, executeNestedUpdate, type NestedWriteContext } from '../nested-write.js';
import type { SchemaMetadata } from '../schema.js';
import { mockTable } from './helpers.js';

function schema(): SchemaMetadata {
  const users = mockTable(
    'users',
    [
      { name: 'id', field: 'id' },
      { name: 'email', field: 'email', pgType: 'text' },
      { name: 'name', field: 'name', pgType: 'text' },
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
  const posts = mockTable(
    'posts',
    [
      { name: 'id', field: 'id' },
      { name: 'user_id', field: 'userId' },
      { name: 'title', field: 'title', pgType: 'text' },
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
  return { enums: {}, tables: { users, posts } };
}

/**
 * A mock transaction whose `findUnique` ALWAYS returns null, so every
 * connect / update-existence probe misses and the "no row found" path fires.
 */
function makeCtx(): NestedWriteContext {
  // biome-ignore lint/suspicious/noExplicitAny: mock transaction for unit tests
  const table = (name: string): any => ({
    async create(args: { data: Record<string, unknown> }) {
      return { id: 1, ...args.data };
    },
    async createMany(args: { data: Record<string, unknown>[] }) {
      return args.data.map((d, i) => ({ id: i + 1, ...d }));
    },
    async update(args: { where: Record<string, unknown>; data: Record<string, unknown> }) {
      return { id: 1, ...args.where, ...args.data };
    },
    async updateMany() {
      return { count: 1 };
    },
    async delete(args: { where: Record<string, unknown> }) {
      return args.where;
    },
    async deleteMany() {
      return { count: 1 };
    },
    async findMany() {
      return [];
    },
    async findUnique() {
      return null;
    },
  });
  return { schema: schema(), tx: { table } };
}

// Every test in this file mutates the global error-message mode; always reset
// to the 'safe' default so the module-global cannot leak across tests.
afterEach(() => setErrorMessageMode('safe'));

describe('nested-write PII-safe errors: safe mode (default)', () => {
  it('belongsTo connect miss shows the key name, not the value', async () => {
    const ctx = makeCtx();
    await assert.rejects(
      () =>
        executeNestedCreate(ctx, 'posts', {
          title: 'Hello',
          author: { connect: { email: 'alice@secret.example.com' } },
        }),
      (err: Error) => {
        assert.ok(err instanceof ValidationError);
        assert.ok(err.message.includes('keys [email]'), err.message);
        assert.ok(!err.message.includes('alice@secret.example.com'), `leaked value: ${err.message}`);
        return true;
      },
    );
  });

  it('hasMany connect miss shows the key name, not the value', async () => {
    const ctx = makeCtx();
    await assert.rejects(
      () => executeNestedUpdate(ctx, 'users', { id: 1 }, { name: 'Renamed', posts: { connect: [{ id: 999 }] } }),
      (err: Error) => {
        assert.ok(err instanceof ValidationError);
        assert.ok(err.message.includes('keys [id]'), err.message);
        assert.ok(!err.message.includes('999'), `leaked value: ${err.message}`);
        return true;
      },
    );
  });

  it('update-existence miss shows the key name, not the value', async () => {
    const ctx = makeCtx();
    await assert.rejects(
      // Relation-only data (no scalars) forces the findUnique existence probe,
      // which misses and throws the update "no row found" error.
      () => executeNestedUpdate(ctx, 'users', { email: 'ghost@secret.example.com' }, { posts: { create: [] } }),
      (err: Error) => {
        assert.ok(err instanceof ValidationError);
        assert.ok(err.message.includes('keys [email]'), err.message);
        assert.ok(!err.message.includes('ghost@secret.example.com'), `leaked value: ${err.message}`);
        return true;
      },
    );
  });
});

describe('nested-write PII-safe errors: verbose mode', () => {
  it('belongsTo connect miss includes the full JSON when verbose', async () => {
    setErrorMessageMode('verbose');
    const ctx = makeCtx();
    await assert.rejects(
      () =>
        executeNestedCreate(ctx, 'posts', {
          title: 'Hello',
          author: { connect: { email: 'alice@secret.example.com' } },
        }),
      (err: Error) => {
        assert.ok(err instanceof ValidationError);
        assert.ok(err.message.includes('{"email":"alice@secret.example.com"}'), err.message);
        return true;
      },
    );
  });
});
