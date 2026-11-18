/**
 * prisma-compat and core transactions on a real Postgres, in both directions:
 * `turbineOf` hands out the core client / core transaction under a compat
 * client, and `bindTransaction` runs compat calls inside a core transaction the
 * compat layer did not open. Gated on `DATABASE_URL`.
 */

import assert from 'node:assert/strict';
import { describe } from 'node:test';
import { TransactionClient } from '../client.js';
import { bindTransaction, createPrismaCompatClient, Prisma, turbineOf } from '../prisma-compat.js';
import { skipGate } from './helpers.js';
import { type ParityFixture, setupParityFixture } from './prisma-parity-fixture.js';

const url = process.env.DATABASE_URL;
const { it, before, after } = skipGate(!url, 'DATABASE_URL not set');

describe('prisma-compat transaction interop (real Postgres)', () => {
  let fx: ParityFixture;
  // biome-ignore lint/suspicious/noExplicitAny: dynamic compat client shape
  let compat: any;

  before(async () => {
    if (!url) return;
    fx = await setupParityFixture(url, 'txinterop');
    compat = createPrismaCompatClient(fx.db, fx.map);
  });

  after(async () => {
    if (fx) await fx.teardown();
  });

  const nameOf = async (id: string) =>
    (await fx.db.table<{ name: string }>(fx.tables.workspace).findUnique({ where: { id } }))?.name;

  it('turbineOf(client) is the wrapped TurbineClient, extended clients included', () => {
    assert.equal(turbineOf(compat), fx.db);
    const extended = compat.$extends({ client: { $hello: () => 'hi' } });
    assert.equal(turbineOf(extended), fx.db);
  });

  it('turbineOf(tx) is the core transaction: it sees the uncommitted write and rolls back with it', async () => {
    const w = await fx.seedWorkspace('before');
    await assert.rejects(
      compat.$transaction(async (tx: typeof compat) => {
        await tx.workspace.update({ where: { id: w.id }, data: { name: 'inside' } });
        const core = turbineOf(tx) as unknown as TransactionClient;
        assert.ok(core instanceof TransactionClient);
        const inside = await core.table<{ name: string }>(fx.tables.workspace).findUnique({ where: { id: w.id } });
        assert.equal(inside?.name, 'inside');
        await core.table(fx.tables.workspace).update({ where: { id: w.id }, data: { name: 'core-inside' } });
        assert.equal((await tx.workspace.findUnique({ where: { id: w.id } })).name, 'core-inside');
        // The base client is outside the transaction and sees the committed row.
        assert.equal(await nameOf(w.id), 'before');
        throw new Error('roll back');
      }),
      /roll back/,
    );
    assert.equal(await nameOf(w.id), 'before');
  });

  it('bindTransaction: compat delegates and raw SQL run in a core transaction it did not open', async () => {
    const w = await fx.seedWorkspace('before');
    await assert.rejects(
      fx.db.$transaction(async (core) => {
        // biome-ignore lint/suspicious/noExplicitAny: dynamic compat client shape
        const tx: any = bindTransaction(compat, core);
        await tx.workspace.update({ where: { id: w.id }, data: { name: 'bound' } });
        const seen = await core.table<{ name: string }>(fx.tables.workspace).findUnique({ where: { id: w.id } });
        assert.equal(seen?.name, 'bound');
        assert.deepEqual(await tx.$queryRaw`SELECT name FROM ${rawTable()} WHERE id = ${w.id}`, [{ name: 'bound' }]);
        await tx.label.create({ data: { workspaceId: w.id, name: 'bound-label' } });
        assert.equal(turbineOf(tx), core);
        assert.equal(await nameOf(w.id), 'before');
        throw new Error('roll back');
      }),
      /roll back/,
    );
    assert.equal(await nameOf(w.id), 'before');
    assert.equal(await compat.label.count({ where: { workspaceId: w.id } }), 0);

    await fx.db.$transaction(async (core) => {
      // biome-ignore lint/suspicious/noExplicitAny: dynamic compat client shape
      await (bindTransaction(compat, core) as any).workspace.update({
        where: { id: w.id },
        data: { name: 'committed' },
      });
    });
    assert.equal(await nameOf(w.id), 'committed');
  });

  it('a bound transaction carries extension model members and no $transaction of its own', async () => {
    const extended = compat.$extends({ model: { workspace: { kind: () => 'ext' } } });
    await fx.db.$transaction(async (core) => {
      const tx = bindTransaction(extended, core) as unknown as Record<string, unknown> & {
        workspace: { kind(): string };
      };
      assert.equal(tx.workspace.kind(), 'ext');
      assert.equal(tx.$transaction, undefined);
    });
  });

  it('refuses what it did not build', async () => {
    assert.throws(() => turbineOf({}), /turbineOf takes a client/);
    assert.throws(() => bindTransaction({}, {} as never), /bindTransaction takes a client/);
    assert.throws(() => bindTransaction(compat, fx.db as never), /core transaction client/);
    await compat.$transaction(async (tx: typeof compat) => {
      assert.throws(() => bindTransaction(tx, turbineOf(tx) as never), /not a transaction client/);
    });
  });

  // The fixture's table names are generated, never caller input.
  const rawTable = () => Prisma.raw(fx.tables.workspace);
});
