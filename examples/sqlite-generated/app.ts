import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { defineSchema, schemaToSQL } from 'turbine-orm';
import { sqliteDialect } from 'turbine-orm/sqlite';
import { type TurbineClient, turbine } from './generated/index.js';
import { tables } from './schema.js';

// Run after generate.ts. Queries are asynchronous; construction and SQLite I/O
// use the synchronous node:sqlite driver. This creates a fresh in-memory DB.
async function exercise(db: TurbineClient): Promise<void> {
  assert.equal(db instanceof Promise, false);
  for (const statement of schemaToSQL(defineSchema(tables), { dialect: sqliteDialect })) {
    await db.rawUnsafe(statement);
  }
  const user = await db.users.create({
    data: {
      email: 'reader@example.com',
      displayName: 'Reader',
      posts: { create: { title: 'First', comments: { create: { body: 'Hello' } } } },
    },
  });
  const rows = await db.users.findMany({
    select: { email: true },
    with: { posts: { select: { title: true, score: true }, with: { comments: { select: { body: true } } } } },
  });
  assert.deepEqual(rows, [
    { email: 'reader@example.com', posts: [{ title: 'First', score: 0, comments: [{ body: 'Hello' }] }] },
  ]);
  const post = await db.posts.findFirstOrThrow();
  const changed = await db.posts.update({ where: { id: post.id }, data: { score: { increment: 2 } } });
  assert.equal(changed.score, 2);
  await db.$transaction(async (tx) => {
    await tx.users.update({ where: { id: user.id }, data: { displayName: 'Committed' } });
    await tx.$transaction(async (inner) => {
      await inner.posts.update({ where: { id: post.id }, data: { score: { increment: 3 } } });
    });
    await assert.rejects(
      tx.$transaction(async (inner) => {
        await inner.posts.update({ where: { id: post.id }, data: { title: 'Undone' } });
        throw new Error('rollback savepoint');
      }),
      /rollback savepoint/,
    );
    assert.equal((await tx.posts.findUniqueOrThrow({ where: { id: post.id } })).title, 'First');
  });
  await assert.rejects(
    db.$transaction(async (tx) => {
      await tx.$transaction(async (inner) => {
        await inner.comments.create({ data: { postId: post.id, body: 'Undone' } });
      });
      await tx.users.update({ where: { id: user.id }, data: { displayName: 'Undone' } });
      throw new Error('rollback transaction');
    }),
    /rollback transaction/,
  );
  assert.deepEqual(await db.posts.findMany({ select: { title: true, score: true } }), [{ title: 'First', score: 5 }]);
  assert.equal((await db.users.findUniqueOrThrow({ where: { id: user.id } })).displayName, 'Committed');
  assert.equal(await db.comments.count(), 1);
  const [users, count] = await db.$transaction([db.users.buildFindMany(), db.comments.buildCount()]);
  assert.equal(users[0]?.email, 'reader@example.com');
  assert.equal(count, 1);
  await assert.rejects(db.$notify('updates', 'test'), { code: 'TURBINE_E017' });
  await assert.rejects(
    db.$withSession({ tenant: 1 }, async (tx) => tx.users.count()),
    { code: 'TURBINE_E017' },
  );
}

async function main(): Promise<void> {
  const owned = turbine(':memory:', { logger: {}, busyTimeoutMs: undefined, globalFilters: undefined });
  try {
    await exercise(owned);
  } finally {
    await owned.disconnect();
  }
  await assert.rejects(owned.users.count(), { code: 'TURBINE_E004' });

  // Passing an open handle preserves external ownership.
  const handle = new DatabaseSync(':memory:');
  try {
    const external = turbine(handle, { logger: {} });
    try {
      await exercise(external);
    } finally {
      await external.end();
    }
    assert.equal(handle.prepare('SELECT count(*) AS count FROM users').get()?.count, 1);
    assert.equal(handle.prepare('SELECT 1 AS ok').get()?.ok, 1);
  } finally {
    handle.close();
  }
  console.log('SQLite generated client: nested reads/writes, updates, savepoints, rollback, and ownership passed.');
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
