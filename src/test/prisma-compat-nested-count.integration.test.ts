/**
 * prisma-compat relation counts below the top level and with a `where`, on a
 * real Postgres, answered as Prisma answers them. Gated on `DATABASE_URL`.
 */

import assert from 'node:assert/strict';
import { describe } from 'node:test';
import { UnsupportedFeatureError } from '../errors.js';
import { createPrismaCompatClient } from '../prisma-compat.js';
import { skipGate } from './helpers.js';
import { type ParityFixture, setupParityFixture } from './prisma-parity-fixture.js';

const url = process.env.DATABASE_URL;
const { it, before, after } = skipGate(!url, 'DATABASE_URL not set');

describe('prisma-compat nested and filtered _count (real Postgres)', () => {
  let fx: ParityFixture;
  // biome-ignore lint/suspicious/noExplicitAny: dynamic compat client shape
  let compat: any;
  let w: { id: string; name: string };
  let other: { id: string };

  before(async () => {
    if (!url) return;
    fx = await setupParityFixture(url, 'nestcount');
    compat = createPrismaCompatClient(fx.db, fx.map);
    w = await fx.seedWorkspace('counted');
    other = await fx.seedWorkspace('other');
    const member = (id: string, workspaceId: string, role: string) =>
      fx.db.rawUnsafe(
        `INSERT INTO ${fx.tables.member} (id, workspace_id, role) VALUES ($1, $2, $3)`,
        id,
        workspaceId,
        role,
      );
    const label = (id: string, workspaceId: string, name: string) =>
      fx.db.rawUnsafe(
        `INSERT INTO ${fx.tables.label} (id, workspace_id, name) VALUES ($1, $2, $3)`,
        id,
        workspaceId,
        name,
      );
    await member('m1', w.id, 'owner');
    await member('m2', w.id, 'member');
    await member('m3', other.id, 'owner');
    await label('l1', w.id, 'Bug');
    await label('l2', w.id, 'Feature');
    await label('l3', w.id, 'Bug');
    await label('l4', other.id, 'Bug');
  });

  after(async () => {
    if (fx) await fx.teardown();
  });

  it('_count under a relation select returns exactly the selected keys', async () => {
    const rows = await compat.member.findMany({
      where: { workspaceId: w.id },
      orderBy: { role: 'asc' },
      select: { id: true, workspace: { select: { name: true, _count: { select: { members: true, labels: true } } } } },
    });
    assert.deepEqual(rows, [
      { id: 'm2', workspace: { name: 'counted', _count: { members: 2, labels: 3 } } },
      { id: 'm1', workspace: { name: 'counted', _count: { members: 2, labels: 3 } } },
    ]);
  });

  it('_count under a relation include, `true` counting every to-many relation', async () => {
    const row = await compat.member.findFirst({
      where: { id: 'm3' },
      include: { workspace: { include: { _count: true } } },
    });
    assert.equal(row.role, 'owner');
    assert.equal(row.workspace.name, 'other');
    assert.deepEqual(row.workspace._count, { members: 1, labels: 1 });
  });

  it('_count two levels down, under a to-many relation', async () => {
    const ws = await compat.workspace.findMany({
      where: { id: { in: [w.id, other.id] } },
      orderBy: { name: 'asc' },
      select: {
        name: true,
        members: {
          orderBy: { id: 'asc' },
          select: { id: true, workspace: { select: { _count: { select: { labels: true } } } } },
        },
      },
    });
    assert.deepEqual(ws, [
      {
        name: 'counted',
        members: [
          { id: 'm1', workspace: { _count: { labels: 3 } } },
          { id: 'm2', workspace: { _count: { labels: 3 } } },
        ],
      },
      { name: 'other', members: [{ id: 'm3', workspace: { _count: { labels: 1 } } }] },
    ]);
  });

  it('a filtered count at the top level, with an unfiltered one beside it', async () => {
    const rows = await compat.workspace.findMany({
      where: { id: w.id },
      select: { _count: { select: { labels: { where: { name: 'Bug' } }, members: true } } },
    });
    assert.deepEqual(rows, [{ _count: { labels: 2, members: 2 } }]);
    const none = await compat.workspace.findUnique({
      where: { id: w.id },
      include: { _count: { select: { labels: { where: { name: 'Nope' } } } } },
    });
    assert.equal(none.name, 'counted');
    assert.deepEqual(none._count, { labels: 0 });
  });

  it('a filtered count below the top level', async () => {
    const rows = await compat.label.findMany({
      where: { id: 'l2' },
      select: { workspace: { select: { _count: { select: { labels: { where: { name: { not: 'Feature' } } } } } } } },
    });
    assert.deepEqual(rows, [{ workspace: { _count: { labels: 2 } } }]);
  });

  it('an unfiltered top-level count still reaches core in the same statement', async () => {
    const statements: string[] = [];
    const listen = (e: { sql: string }) => {
      statements.push(e.sql);
    };
    fx.db.$on('query', listen);
    try {
      const rows = await compat.workspace.findMany({
        where: { id: w.id },
        select: { id: true, _count: { select: { labels: true } } },
        // Pinned: under 'auto' core may itself batch an unindexed relation.
        relationLoadStrategy: 'join',
      });
      assert.deepEqual(rows, [{ id: w.id, _count: { labels: 3 } }]);
    } finally {
      fx.db.$off('query', listen);
    }
    assert.equal(statements.length, 1, statements.join('\n'));
  });

  it('a select of only relations and _count returns no scalar field', async () => {
    const rows = await compat.workspace.findMany({
      where: { id: other.id },
      select: { members: { select: { role: true } }, _count: { select: { labels: true } } },
    });
    assert.deepEqual(rows, [{ members: [{ role: 'owner' }], _count: { labels: 1 } }]);
  });

  it('an omit of the key a nested count needs still omits it', async () => {
    const row = await compat.member.findUnique({
      where: { id: 'm3' },
      include: { workspace: { omit: { id: true }, include: { _count: { select: { labels: true } } } } },
    });
    assert.equal(row.workspace.id, undefined);
    assert.deepEqual(row.workspace._count, { labels: 1 });
  });

  it('counts read on the transaction connection inside $transaction, and in a $transaction array', async () => {
    await compat.$transaction(async (tx: typeof compat) => {
      await tx.label.create({ data: { id: 'l-tx', workspaceId: other.id, name: 'Bug' } });
      const row = await tx.member.findUnique({
        where: { id: 'm3' },
        select: { workspace: { select: { _count: { select: { labels: { where: { name: 'Bug' } } } } } } },
      });
      assert.deepEqual(row, { workspace: { _count: { labels: 2 } } });
      await tx.label.delete({ where: { id: 'l-tx' } });
    });
    const [counted, plain] = await compat.$transaction([
      compat.member.findUnique({
        where: { id: 'm3' },
        select: { workspace: { select: { _count: { select: { labels: true } } } } },
      }),
      compat.member.count({ where: { workspaceId: w.id } }),
    ]);
    assert.deepEqual(counted, { workspace: { _count: { labels: 1 } } });
    assert.equal(plain, 2);
  });

  it('a nested count of a relation it cannot count is refused by name', async () => {
    await assert.rejects(
      compat.label.findMany({ select: { workspace: { select: { _count: { select: { profile: true } } } } } }),
      (err: unknown) => err instanceof UnsupportedFeatureError && /Workspace\.profile/.test(err.message),
    );
  });
});
