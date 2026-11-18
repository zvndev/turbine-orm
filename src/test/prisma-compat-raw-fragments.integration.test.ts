/**
 * prisma-compat raw SQL fragments on a real Postgres: a lone fragment
 * argument, fragments nested in a template, and fragments from another
 * library's `Prisma` namespace (opted into by `prismaNamespace`). Gated on
 * `DATABASE_URL`.
 */

import assert from 'node:assert/strict';
import { describe } from 'node:test';
import { createPrismaCompatClient, Prisma } from '../prisma-compat.js';
import { skipGate } from './helpers.js';
import { type ParityFixture, setupParityFixture } from './prisma-parity-fixture.js';

const url = process.env.DATABASE_URL;
const { it, before, after } = skipGate(!url, 'DATABASE_URL not set');

describe('prisma-compat raw fragments (real Postgres)', () => {
  let fx: ParityFixture;
  // biome-ignore lint/suspicious/noExplicitAny: dynamic compat client shape
  let compat: any;

  before(async () => {
    if (!url) return;
    fx = await setupParityFixture(url, 'rawfrag');
    compat = createPrismaCompatClient(fx.db, fx.map);
  });

  after(async () => {
    if (fx) await fx.teardown();
  });

  it('a lone Prisma.sql fragment argument is the statement, not an empty one', async () => {
    const w = await fx.seedWorkspace('lone');
    assert.deepEqual(await compat.$queryRaw(Prisma.sql`SELECT ${7}::int AS n`), [{ n: 7 }]);
    assert.deepEqual(
      await compat.$queryRaw(Prisma.sql`SELECT id FROM ${Prisma.raw(fx.tables.workspace)} WHERE slug = ${w.slug}`),
      [{ id: w.id }],
    );
    assert.equal(
      await compat.$executeRaw(
        Prisma.sql`UPDATE ${Prisma.raw(fx.tables.workspace)} SET name = ${'x'} WHERE id = ${w.id}`,
      ),
      1,
    );
    assert.deepEqual(await compat.$queryRaw(Prisma.raw('SELECT 1 AS one')), [{ one: 1 }]);
  });

  it('a lone fragment runs on the transaction connection inside $transaction', async () => {
    const w = await fx.seedWorkspace('tx-lone');
    await compat.$transaction(async (tx: typeof compat) => {
      await tx.$executeRaw(
        Prisma.sql`UPDATE ${Prisma.raw(fx.tables.workspace)} SET name = ${'in-tx'} WHERE id = ${w.id}`,
      );
      assert.deepEqual(
        await tx.$queryRaw(Prisma.sql`SELECT name FROM ${Prisma.raw(fx.tables.workspace)} WHERE id = ${w.id}`),
        [{ name: 'in-tx' }],
      );
    });
  });

  it('a fragment argument with further arguments is refused, not half-read', async () => {
    await assert.rejects(compat.$queryRaw(Prisma.sql`SELECT ${1}::int AS n`, 2), /takes the fragment alone/);
  });
});
