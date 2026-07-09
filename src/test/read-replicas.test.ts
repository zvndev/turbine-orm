/**
 * Read-replica routing tests (WS-E).
 *
 * No database required — every pool is a mock {@link PgCompatPool} that records
 * which pool served each query/connect. The tests assert the routing matrix:
 *
 *   - reads outside a transaction round-robin across replicas
 *   - writes, $transaction bodies, pipeline, raw/sql, $notify stay on primary
 *   - $primary() escape hatch pins everything to primary
 *   - disconnect() closes owned replica pools, leaves external replicas untouched
 *   - zero replicas configured = today's behavior (identity, no proxy)
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { type PgCompatPool, type PgCompatPoolClient, TurbineClient } from '../client.js';
import type { SchemaMetadata } from '../schema.js';
import { mockTable } from './helpers.js';

// ---------------------------------------------------------------------------
// Mock pool that records everything
// ---------------------------------------------------------------------------

interface RecordingPool extends PgCompatPool {
  readonly label: string;
  /** SQL text of every `pool.query()` call (statement-level reads/writes). */
  readonly queries: string[];
  /** SQL text run through a checked-out connection (tx / stream / pipeline). */
  readonly connQueries: string[];
  /** Number of `pool.connect()` calls. */
  connects: number;
  /** Whether `end()` was called. */
  ended: boolean;
}

function extractSql(textOrConfig: string | { text: string }): string {
  return typeof textOrConfig === 'string' ? textOrConfig : textOrConfig.text;
}

/**
 * `pool.query()` returns a generic 1-row result so statement-level read/write
 * transforms don't throw. `connect()` clients return EMPTY rows so cursor
 * streams terminate immediately and pipeline/tx transforms stay harmless — we
 * only care that routing recorded the call before any transform ran.
 */
function makeRecordingPool(label: string): RecordingPool {
  const pool: RecordingPool = {
    label,
    queries: [],
    connQueries: [],
    connects: 0,
    ended: false,
    // biome-ignore lint/suspicious/noExplicitAny: mock result shape
    query: (async (textOrConfig: any) => {
      pool.queries.push(extractSql(textOrConfig));
      return { rows: [{ id: 1, name: 'x', count: 0 }], rowCount: 1, fields: [] };
    }) as PgCompatPool['query'],
    connect: async (): Promise<PgCompatPoolClient> => {
      pool.connects++;
      return {
        // biome-ignore lint/suspicious/noExplicitAny: mock result shape
        query: (async (textOrConfig: any) => {
          pool.connQueries.push(extractSql(textOrConfig));
          return { rows: [], rowCount: 0, fields: [] };
        }) as PgCompatPoolClient['query'],
        release: () => {},
      };
    },
    end: async () => {
      pool.ended = true;
    },
  };
  return pool;
}

// ---------------------------------------------------------------------------
// Mock schema
// ---------------------------------------------------------------------------

const schema: SchemaMetadata = {
  tables: {
    users: mockTable('users', [
      { name: 'id', field: 'id' },
      { name: 'name', field: 'name', pgType: 'text' },
    ]),
  },
  enums: {},
};

function anyQueries(p: RecordingPool): boolean {
  return p.queries.length > 0 || p.connQueries.length > 0 || p.connects > 0;
}

// biome-ignore lint/suspicious/noExplicitAny: table accessor is dynamically typed on the base client
function users(db: TurbineClient): any {
  return db.table('users');
}

// ---------------------------------------------------------------------------
// Zero replicas — today's behavior, no proxy
// ---------------------------------------------------------------------------

describe('read replicas — zero configured', () => {
  it('routes everything to primary and returns a plain (non-proxy) accessor', async () => {
    const primary = makeRecordingPool('primary');
    const db = new TurbineClient({ pool: primary }, schema);

    // Same instance twice (existing table cache contract — a proxy would break this).
    assert.equal(users(db), users(db));

    await users(db)
      .findMany()
      .catch(() => {});
    await users(db)
      .create({ data: { name: 'a' } })
      .catch(() => {});

    assert.ok(primary.queries.length >= 2);
  });
});

// ---------------------------------------------------------------------------
// Read routing — round-robin across replicas
// ---------------------------------------------------------------------------

describe('read replicas — read routing', () => {
  it('round-robins reads across replicas and never touches primary', async () => {
    const primary = makeRecordingPool('primary');
    const r0 = makeRecordingPool('r0');
    const r1 = makeRecordingPool('r1');
    const db = new TurbineClient({ pool: primary, replicas: [r0, r1] }, schema);

    // 4 sequential reads → replica order [r0, r1, r0, r1].
    for (let i = 0; i < 4; i++)
      await users(db)
        .findMany()
        .catch(() => {});

    assert.equal(r0.queries.length, 2, 'r0 served reads 1 and 3');
    assert.equal(r1.queries.length, 2, 'r1 served reads 2 and 4');
    assert.equal(primary.queries.length, 0, 'primary served no reads');
  });

  it('routes every read-only operation to a replica', async () => {
    const primary = makeRecordingPool('primary');
    const r0 = makeRecordingPool('r0');
    const db = new TurbineClient({ pool: primary, replicas: [r0] }, schema);

    await users(db)
      .findMany()
      .catch(() => {});
    await users(db)
      .findFirst()
      .catch(() => {});
    await users(db)
      .findUnique({ where: { id: 1 } })
      .catch(() => {});
    await users(db)
      .findFirstOrThrow()
      .catch(() => {});
    await users(db)
      .findUniqueOrThrow({ where: { id: 1 } })
      .catch(() => {});
    await users(db)
      .count()
      .catch(() => {});
    await users(db)
      .aggregate({ _count: true })
      .catch(() => {});
    await users(db)
      .groupBy({ by: ['id'] })
      .catch(() => {});

    assert.equal(primary.queries.length, 0, 'no read hit primary');
    assert.ok(r0.queries.length >= 8, 'all reads hit replica');
  });

  it('routes findManyStream to a replica', async () => {
    const primary = makeRecordingPool('primary');
    const r0 = makeRecordingPool('r0');
    const db = new TurbineClient({ pool: primary, replicas: [r0] }, schema);

    // Mock pool.query returns a single row (<= batchSize), so the stream drains
    // via the speculative query on the replica and never reaches connect().
    for await (const _ of users(db).findManyStream()) {
      break;
    }

    assert.ok(r0.queries.length >= 1, 'stream query ran on the replica');
    assert.ok(!anyQueries(primary), 'stream did not touch primary');
  });
});

// ---------------------------------------------------------------------------
// Write / non-read routing — always primary
// ---------------------------------------------------------------------------

describe('read replicas — writes and non-reads stay on primary', () => {
  it('routes all writes to primary, never a replica', async () => {
    const primary = makeRecordingPool('primary');
    const r0 = makeRecordingPool('r0');
    const db = new TurbineClient({ pool: primary, replicas: [r0] }, schema);

    await users(db)
      .create({ data: { name: 'a' } })
      .catch(() => {});
    await users(db)
      .createMany({ data: [{ name: 'a' }] })
      .catch(() => {});
    await users(db)
      .update({ where: { id: 1 }, data: { name: 'b' } })
      .catch(() => {});
    await users(db)
      .updateMany({ where: { id: 1 }, data: { name: 'b' } })
      .catch(() => {});
    await users(db)
      .delete({ where: { id: 1 } })
      .catch(() => {});
    await users(db)
      .deleteMany({ where: { id: 1 } })
      .catch(() => {});
    await users(db)
      .upsert({ where: { id: 1 }, create: { name: 'a' }, update: { name: 'b' } })
      .catch(() => {});

    assert.equal(r0.queries.length, 0, 'no write hit a replica');
    assert.ok(primary.queries.length >= 5, 'writes hit primary');
  });

  it('runs $transaction bodies entirely on primary, including reads', async () => {
    const primary = makeRecordingPool('primary');
    const r0 = makeRecordingPool('r0');
    const db = new TurbineClient({ pool: primary, replicas: [r0] }, schema);

    await db
      .$transaction(async (tx) => {
        // biome-ignore lint/suspicious/noExplicitAny: tx table accessor dynamically typed
        await (tx as any).users.findMany().catch(() => {});
      })
      .catch(() => {});

    assert.equal(primary.connects, 1, 'transaction checked out a primary connection');
    assert.ok(!anyQueries(r0), 'transaction never touched a replica');
  });

  it('routes raw() and sql() to primary', async () => {
    const primary = makeRecordingPool('primary');
    const r0 = makeRecordingPool('r0');
    const db = new TurbineClient({ pool: primary, replicas: [r0] }, schema);

    await db.raw`SELECT 1`.catch(() => {});
    // db.sql returns a TypedSqlQuery thenable — await it (no .catch on it).
    try {
      await db.sql`SELECT 1`;
    } catch {
      // ignore — mock result shape may not satisfy the transform
    }

    assert.ok(primary.queries.length >= 2, 'raw + sql hit primary');
    assert.ok(!anyQueries(r0), 'raw/sql never touched a replica');
  });

  it('routes pipeline() to primary', async () => {
    const primary = makeRecordingPool('primary');
    const r0 = makeRecordingPool('r0');
    const db = new TurbineClient({ pool: primary, replicas: [r0] }, schema);

    await db.pipeline(users(db).buildCount(), users(db).buildCount()).catch(() => {});

    assert.ok(primary.connects >= 1 || primary.queries.length >= 1, 'pipeline hit primary');
    assert.ok(!anyQueries(r0), 'pipeline never touched a replica');
  });

  it('routes $notify to primary', async () => {
    const primary = makeRecordingPool('primary');
    const r0 = makeRecordingPool('r0');
    const db = new TurbineClient({ pool: primary, replicas: [r0] }, schema);

    await db.$notify('chan', 'payload').catch(() => {});

    assert.ok(
      primary.queries.some((q) => q.includes('pg_notify')),
      'notify hit primary',
    );
    assert.ok(!anyQueries(r0), 'notify never touched a replica');
  });
});

// ---------------------------------------------------------------------------
// $primary() escape hatch
// ---------------------------------------------------------------------------

describe('read replicas — $primary() escape', () => {
  it('pins reads to primary and caches the view instance', async () => {
    const primary = makeRecordingPool('primary');
    const r0 = makeRecordingPool('r0');
    const db = new TurbineClient({ pool: primary, replicas: [r0] }, schema);

    const p1 = db.$primary();
    const p2 = db.$primary();
    assert.equal(p1, p2, '$primary() returns a cached instance');

    // biome-ignore lint/suspicious/noExplicitAny: table accessor dynamically typed
    await (p1 as any).users.findMany().catch(() => {});

    assert.ok(primary.queries.length >= 1, 'read on $primary() view hit primary');
    assert.ok(!anyQueries(r0), 'read on $primary() view never touched a replica');
  });

  it('returns the same client when no replicas are configured', () => {
    const primary = makeRecordingPool('primary');
    const db = new TurbineClient({ pool: primary }, schema);
    assert.equal(db.$primary(), db);
  });
});

// ---------------------------------------------------------------------------
// disconnect() lifecycle
// ---------------------------------------------------------------------------

describe('read replicas — disconnect lifecycle', () => {
  it('leaves external replica pools untouched (caller owns lifecycle)', async () => {
    const primary = makeRecordingPool('primary');
    const r0 = makeRecordingPool('r0');
    const r1 = makeRecordingPool('r1');
    const db = new TurbineClient({ pool: primary, replicas: [r0, r1] }, schema);

    await db.disconnect();

    assert.equal(r0.ended, false, 'external replica r0 not ended');
    assert.equal(r1.ended, false, 'external replica r1 not ended');
    assert.equal(primary.ended, false, 'external primary not ended');
  });

  it('closes owned (string) replica pools without throwing', async () => {
    const primary = makeRecordingPool('primary');
    const db = new TurbineClient({ pool: primary, replicas: ['postgres://user:pass@127.0.0.1:5999/db'] }, schema);
    // Owned pg.Pool is never connected (lazy) — end() on an idle pool resolves.
    await assert.doesNotReject(() => db.disconnect());
  });
});
