/**
 * groupBy and raw SQL parity on a real Postgres, through prisma-compat and
 * core: a Date in `having`, and in raw SQL, in a non-UTC process; and groupBy
 * result rows that carry only the blocks the call asked for. Gated on
 * `DATABASE_URL`.
 */

import assert from 'node:assert/strict';
import { describe } from 'node:test';
import { createPrismaCompatClient, Prisma } from '../prisma-compat.js';
import { skipGate } from './helpers.js';
import { type ParityFixture, setupParityFixture } from './prisma-parity-fixture.js';

const url = process.env.DATABASE_URL;
const { it, before, after } = skipGate(!url, 'DATABASE_URL not set');

describe('groupBy parity (real Postgres)', () => {
  let fx: ParityFixture;
  // biome-ignore lint/suspicious/noExplicitAny: dynamic compat client shape
  let compat: any;

  before(async () => {
    if (!url) return;
    fx = await setupParityFixture(url, 'groupby');
    compat = createPrismaCompatClient(fx.db, fx.map);
  });

  after(async () => {
    if (fx) await fx.teardown();
  });

  /** Run `fn` with the process in a zone hours away from UTC. */
  async function inNewYork<T>(fn: () => Promise<T>): Promise<T> {
    const previous = process.env.TZ;
    process.env.TZ = 'America/New_York';
    try {
      assert.notEqual(new Date(Date.UTC(2024, 0, 15)).getTimezoneOffset(), 0, 'the process zone really changed');
      return await fn();
    } finally {
      if (previous === undefined) delete process.env.TZ;
      else process.env.TZ = previous;
    }
  }

  it('a Date in having matches its stored zone-less timestamp in a non-UTC process', async () => {
    const w = await fx.seedWorkspace('having');
    await fx.db.rawUnsafe(
      `INSERT INTO ${fx.tables.member} (id, workspace_id, role, created_at) VALUES ($1, $2, 'owner', '2024-01-15 12:00:00.123')`,
      `hm-${w.id}`,
      w.id,
    );
    const at = (await compat.member.findFirstOrThrow({ where: { workspaceId: w.id } })).createdAt as Date;
    assert.equal(at.toISOString(), '2024-01-15T12:00:00.123Z');
    await inNewYork(async () => {
      const rows = await compat.member.groupBy({
        by: ['workspaceId'],
        where: { workspaceId: w.id },
        having: { createdAt: { _max: { equals: at } } },
        _max: { createdAt: true },
      });
      assert.equal(rows.length, 1, 'the stored maximum equals the Date read back');
      assert.equal(rows[0]._max.createdAt.getTime(), at.getTime());
      const core = await fx.db.table(fx.tables.member).groupBy({
        by: ['workspaceId'],
        where: { workspaceId: w.id },
        having: { createdAt: { _min: { gte: at, lte: at } } },
      } as never);
      assert.equal(core.length, 1);
      // And the where side agrees, as it always did.
      assert.equal(await compat.member.count({ where: { workspaceId: w.id, createdAt: at } }), 1);
    });
  });

  it('a Date in raw SQL compares as UTC in a non-UTC process, as Prisma binds it', async () => {
    const w = await fx.seedWorkspace('raw-date');
    await fx.db.rawUnsafe(
      `INSERT INTO ${fx.tables.member} (id, workspace_id, role, created_at) VALUES ($1, $2, 'owner', '2024-01-15 12:00:00.123')`,
      `rd-${w.id}`,
      w.id,
    );
    const at = new Date('2024-01-15T12:00:00.123Z');
    const table = Prisma.raw(fx.tables.member);
    await inNewYork(async () => {
      assert.deepEqual(
        await compat.$queryRaw`SELECT count(*)::int AS n FROM ${table} WHERE workspace_id = ${w.id} AND created_at = ${at}`,
        [{ n: 1 }],
      );
      assert.deepEqual(
        await compat.$queryRawUnsafe(
          `SELECT count(*)::int AS n FROM ${fx.tables.member} WHERE workspace_id = $1 AND created_at = $2`,
          w.id,
          at,
        ),
        [{ n: 1 }],
      );
      await compat.$transaction(async (tx: typeof compat) => {
        assert.equal(
          await tx.$executeRaw`UPDATE ${table} SET role = 'admin' WHERE workspace_id = ${w.id} AND created_at = ${at}`,
          1,
        );
      });
      // A timestamptz comparison is right too: the ISO text carries its zone.
      assert.deepEqual(
        await compat.$queryRaw`SELECT (${at}::timestamptz = '2024-01-15T12:00:00.123Z'::timestamptz) AS same`,
        [{ same: true }],
      );
    });
  });

  it('groupBy rows carry only the blocks that were asked for', async () => {
    const w = await fx.seedWorkspace('blocks');
    for (const [id, name] of [
      ['b1', 'x'],
      ['b2', 'x'],
      ['b3', 'y'],
    ]) {
      await fx.db.rawUnsafe(
        `INSERT INTO ${fx.tables.label} (id, workspace_id, name) VALUES ($1, $2, $3)`,
        `${id}-${w.id}`,
        w.id,
        name,
      );
    }
    const where = { workspaceId: w.id };
    assert.deepEqual(await compat.label.groupBy({ by: ['name'], where, orderBy: { name: 'asc' } }), [
      { name: 'x' },
      { name: 'y' },
    ]);
    assert.deepEqual(await compat.label.groupBy({ by: ['name'], where, _count: true, orderBy: { name: 'asc' } }), [
      { name: 'x', _count: 2 },
      { name: 'y', _count: 1 },
    ]);
    assert.deepEqual(
      await compat.label.groupBy({ by: ['name'], where, _count: { _all: true }, orderBy: { name: 'asc' } }),
      [
        { name: 'x', _count: { _all: 2 } },
        { name: 'y', _count: { _all: 1 } },
      ],
    );
    // Ordering by the count still works without returning it.
    assert.deepEqual(await compat.label.groupBy({ by: ['name'], where, orderBy: { _count: 'desc' } }), [
      { name: 'x' },
      { name: 'y' },
    ]);
    assert.deepEqual(
      await compat.label.groupBy({ by: ['name'], where, _max: { color: true }, orderBy: { name: 'asc' } }),
      [
        { name: 'x', _max: { color: null } },
        { name: 'y', _max: { color: null } },
      ],
    );
  });
});
