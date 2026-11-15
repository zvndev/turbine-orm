import assert from 'node:assert/strict';
import mysql from 'mysql2/promise';
import { turbine } from './index.js';

async function main() {
  const url = process.env.MYSQL_COMPARISON_URL!;
  const endpoint = new URL(url);
  const raw = mysql.createPool({
    host: endpoint.hostname,
    port: Number(endpoint.port),
    user: 'root',
    database: endpoint.pathname.slice(1),
    namedPlaceholders: true,
    timezone: 'Z',
    supportBigNumbers: true,
    bigNumberStrings: false,
  });
  const db = await turbine(raw, { logger: {}, warnOnUnlimited: false });
  try {
    const user = await db.users.findUnique({ where: { id: 1 } });
    assert.ok(user);
    assert.equal(user.email, 'user1@bench.example.com');
    assert.ok(user.createdAt instanceof Date);
    const counts = await db.users.findMany({ orderBy: { id: 'asc' }, limit: 100, with: { _count: { posts: true } } });
    assert.equal(counts.length, 100);
    for (const row of counts) assert.equal(row._count.posts, 10);
    const sentinel = new Error('generated rollback');
    await assert.rejects(
      db.$transaction(async (tx) => {
        const written = await tx.benchWrites.create({
          data: {
            orgId: 1,
            slug: 'generated-rollback',
            label: 'generated',
            amount: 5,
            active: true,
            createdAt: new Date('2024-02-29T12:34:56Z'),
          },
        });
        assert.equal(written.active, true);
        assert.equal(written.amount, 5);
        throw sentinel;
      }),
      (error) => error === sentinel,
    );
    assert.equal(await db.benchWrites.findUnique({ where: { slug: 'generated-rollback' } }), null);
    // biome-ignore lint/correctness/noConstantCondition: compile-only invalid inputs must never execute.
    if (false) {
      // @ts-expect-error generated relation names stay closed.
      await db.users.findMany({ with: { absentRelation: true } });
      // @ts-expect-error generated scalar fields stay closed.
      await db.users.findMany({ where: { absentColumn: 1 } });
      // @ts-expect-error integer column does not admit object JSON filters.
      await db.users.findMany({ where: { id: { hasKey: 'x' } } });
      // @ts-expect-error generated write columns retain boolean types.
      await db.benchWrites.update({ where: { id: 1 }, data: { active: 'true' } });
      // @ts-expect-error generated global filters retain column names.
      await turbine(raw, { globalFilters: { users: { absentColumn: 1 } } });
      // @ts-expect-error generated methods retain selected field types.
      const amount: number = user.email;
      void amount;
    }
    await db.disconnect();
    const [rows] = await raw.query<mysql.RowDataPacket[]>('SELECT 1 AS alive');
    assert.equal(rows[0]!.alive, 1);
    console.log(
      JSON.stringify({
        passed: true,
        node: process.version,
        generatedTypedFactory: true,
        negativeTypes: 6,
        callerPoolSurvives: true,
      }),
    );
  } finally {
    await db.disconnect();
    await raw.end();
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
