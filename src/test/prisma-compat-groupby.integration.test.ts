/**
 * groupBy parity on a real Postgres, through prisma-compat and core: a Date in
 * `having` in a non-UTC process. Gated on `DATABASE_URL`.
 */

import assert from 'node:assert/strict';
import { describe } from 'node:test';
import { createPrismaCompatClient } from '../prisma-compat.js';
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
});
