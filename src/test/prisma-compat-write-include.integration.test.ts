/**
 * prisma-compat writes that return relations (`include`, a relation `select`,
 * `_count`) on a real Postgres: create, update, upsert and delete, alone, in a
 * `$transaction` callback and in a `$transaction([...])` array. Gated on
 * `DATABASE_URL`.
 */

import assert from 'node:assert/strict';
import { describe } from 'node:test';
import { ValidationError } from '../errors.js';
import { createPrismaCompatClient } from '../prisma-compat.js';
import { skipGate } from './helpers.js';
import { type ParityFixture, setupParityFixture } from './prisma-parity-fixture.js';

const url = process.env.DATABASE_URL;
const { it, before, after } = skipGate(!url, 'DATABASE_URL not set');

describe('prisma-compat writes that return relations (real Postgres)', () => {
  let fx: ParityFixture;
  // biome-ignore lint/suspicious/noExplicitAny: dynamic compat client shape
  let compat: any;
  let n = 0;
  const id = (p: string) => `${p}${++n}`;

  before(async () => {
    if (!url) return;
    fx = await setupParityFixture(url, 'writeinc');
    compat = createPrismaCompatClient(fx.db, fx.map);
  });

  after(async () => {
    if (fx) await fx.teardown();
  });

  it('create with include returns the nested rows and counts it just wrote', async () => {
    const created = await compat.workspace.create({
      data: {
        name: 'proj',
        slug: id('proj-'),
        labels: {
          create: [
            { id: id('l'), name: 'B' },
            { id: id('l'), name: 'A' },
          ],
        },
      },
      include: { labels: { orderBy: { name: 'asc' } }, profile: true, _count: { select: { members: true } } },
    });
    assert.equal(created.name, 'proj');
    assert.match(created.id, /^c/);
    assert.deepEqual(
      created.labels.map((l: { name: string }) => l.name),
      ['A', 'B'],
    );
    assert.equal(created.profile, null);
    assert.deepEqual(created._count, { members: 0 });
  });

  it('update with a relation select returns exactly the selected keys', async () => {
    const w = await fx.seedWorkspace('upd');
    const updated = await compat.workspace.update({
      where: { id: w.id },
      data: { name: 'upd2', members: { create: { id: id('m'), role: 'owner' } } },
      select: { name: true, members: { select: { role: true } }, _count: { select: { labels: true } } },
    });
    assert.deepEqual(updated, { name: 'upd2', members: [{ role: 'owner' }], _count: { labels: 0 } });
  });

  it('upsert with include, on both branches', async () => {
    const slug = id('ups-');
    const createdBranch = await compat.workspace.upsert({
      where: { slug },
      create: { name: 'created', slug },
      update: { name: 'never' },
      include: { members: true },
    });
    assert.equal(createdBranch.name, 'created');
    assert.deepEqual(createdBranch.members, []);
    const updatedBranch = await compat.workspace.upsert({
      where: { slug },
      create: { name: 'never', slug },
      update: { name: 'updated' },
      include: { members: true },
    });
    assert.equal(updatedBranch.id, createdBranch.id);
    assert.equal(updatedBranch.name, 'updated');
  });

  it('delete with include returns the row and its relations as they were', async () => {
    const w = await fx.seedWorkspace('del');
    await compat.label.create({ data: { id: id('l'), workspaceId: w.id, name: 'gone' } });
    const deleted = await compat.workspace.delete({ where: { id: w.id }, include: { labels: true } });
    assert.equal(deleted.name, 'del');
    assert.deepEqual(
      deleted.labels.map((l: { name: string }) => l.name),
      ['gone'],
    );
    assert.equal(await compat.workspace.findUnique({ where: { id: w.id } }), null);
    assert.equal(await compat.label.count({ where: { workspaceId: w.id } }), 0);
  });

  it('a write that fails leaves nothing, and a missing row is still not-found', async () => {
    const w = await fx.seedWorkspace('dupe');
    await assert.rejects(
      compat.workspace.create({ data: { name: 'x', slug: w.slug }, include: { labels: true } }),
      /unique/i,
    );
    await assert.rejects(
      compat.workspace.update({ where: { id: 'missing' }, data: { name: 'x' }, include: { labels: true } }),
      /not found|E001/i,
    );
    await assert.rejects(
      compat.workspace.delete({ where: { id: 'missing' }, include: { labels: true } }),
      /E001|not found/i,
    );
  });

  it('an invalid projection is refused before anything is written', async () => {
    const slug = id('bad-');
    await assert.rejects(
      compat.workspace.create({ data: { name: 'x', slug }, include: { labelz: true } }),
      (err: unknown) => err instanceof ValidationError && /labelz/.test(err.message),
    );
    assert.equal(await compat.workspace.count({ where: { slug } }), 0);
  });

  it('inside $transaction: the read-back sees the transaction and rolls back with it', async () => {
    const w = await fx.seedWorkspace('tx');
    await assert.rejects(
      compat.$transaction(async (tx: typeof compat) => {
        const row = await tx.workspace.update({
          where: { id: w.id },
          data: { labels: { create: { id: id('l'), name: 'in-tx' } } },
          include: { labels: true },
        });
        assert.equal(row.labels.length, 1);
        throw new Error('roll back');
      }),
      /roll back/,
    );
    assert.equal(await compat.label.count({ where: { workspaceId: w.id } }), 0);
  });

  it('in a $transaction([...]) array: atomic with the other items', async () => {
    const w = await fx.seedWorkspace('batch');
    await assert.rejects(
      compat.$transaction([
        compat.workspace.update({ where: { id: w.id }, data: { name: 'batched' }, include: { labels: true } }),
        compat.workspace.create({ data: { name: 'dupe', slug: w.slug } }),
      ]),
    );
    assert.equal((await compat.workspace.findUnique({ where: { id: w.id } })).name, 'batch');
    const [row, count] = await compat.$transaction([
      compat.workspace.update({ where: { id: w.id }, data: { name: 'batched' }, include: { labels: true } }),
      compat.label.count({ where: { workspaceId: w.id } }),
    ]);
    assert.equal(row.name, 'batched');
    assert.deepEqual(row.labels, []);
    assert.equal(count, 0);
  });
});
