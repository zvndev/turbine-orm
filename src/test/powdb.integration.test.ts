/**
 * turbine-orm/powdb — LIVE integration tests through the REAL in-process
 * `@zvndev/powdb-embedded` napi addon (no server, no socket — runs anywhere the
 * prebuilt binary loads).
 *
 * The whole suite is gated on the addon loading: on a platform without a
 * prebuilt binary (musl / Windows / Intel-mac) the `import()` throws and every
 * test registers as skipped via {@link skipGate}, so `npm run test:unit` stays
 * green without the addon and CI on a supported runner exercises the real
 * engine. Each test opens its own `mkdtemp` data dir and cleans it up.
 *
 * Coverage (the release-hardening fixes):
 *   - RETURNING column-order round-trip (schema column order ≠ insert-arg order)
 *   - error-class mapping (unique / not-null / type-mismatch / parse → typed)
 *   - empty-where guard on the COMPILED filter (FIX 1)
 *   - transactions: single-level commit + rollback
 *   - nested `tx.$transaction` and re-entrant `db.$transaction` throw typed (FIX 2)
 *   - independent concurrent `db.$transaction` calls queue FIFO and all succeed (T-7)
 *   - COLD-CLIENT same-tick `db.$transaction` burst: zero false E017 (dogfood item 3)
 *   - disconnect() really closes the owned pool (dogfood item 1)
 *   - chunked relation load over > MAX_RELATION_KEYS parents (FIX 4)
 *   - E017 unsupported guards (vector / cursor stream)
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe } from 'node:test';
import {
  ConnectionError,
  NotNullViolationError,
  TimeoutError,
  UniqueConstraintError,
  UnsupportedFeatureError,
  ValidationError,
} from '../errors.js';
import { introspectPowdbDatabase, PowdbJsonParam, powqlSchemaDDL, turbinePowDB } from '../powdb.js';
import type { ColumnMetadata, RelationDef, SchemaMetadata, TableMetadata } from '../schema.js';
import { skipGate } from './helpers.js';

// ---------------------------------------------------------------------------
// Addon availability gate — skip cleanly when the prebuilt binary is absent.
// ---------------------------------------------------------------------------

let embeddedAvailable = false;
try {
  const mod = (await import('@zvndev/powdb-embedded')) as { Database?: { open?: unknown } };
  embeddedAvailable = typeof mod?.Database?.open === 'function';
} catch {
  embeddedAvailable = false;
}
const { it } = skipGate(!embeddedAvailable, 'requires @zvndev/powdb-embedded (no prebuilt binary on this platform)');

// ---------------------------------------------------------------------------
// Schema fixture — column order deliberately ≠ the order writes pass args, so
// the RETURNING round-trip proves columns are matched by name, not position.
// ---------------------------------------------------------------------------

function col(
  name: string,
  field: string,
  tsType: string,
  pgType: string,
  opts: Partial<ColumnMetadata> = {},
): ColumnMetadata {
  return {
    name,
    field,
    pgType,
    tsType,
    nullable: false,
    hasDefault: false,
    isArray: false,
    pgArrayType: 'text[]',
    ...opts,
  };
}

function makeTable(
  name: string,
  columns: ColumnMetadata[],
  relations: Record<string, RelationDef> = {},
  pk = 'id',
): TableMetadata {
  const columnMap: Record<string, string> = {};
  const reverseColumnMap: Record<string, string> = {};
  for (const c of columns) {
    columnMap[c.field] = c.name;
    reverseColumnMap[c.name] = c.field;
  }
  return {
    name,
    columns,
    columnMap,
    reverseColumnMap,
    dateColumns: new Set(columns.filter((c) => c.tsType.startsWith('Date')).map((c) => c.name)),
    pgTypes: Object.fromEntries(columns.map((c) => [c.name, c.pgType])),
    allColumns: columns.map((c) => c.name),
    primaryKey: [pk],
    uniqueColumns: [[pk]],
    relations,
    indexes: [],
  };
}

const schema: SchemaMetadata = {
  enums: {},
  tables: {
    // Column order: id, email, name, age, score, created_at — writes below pass
    // them in a DIFFERENT order, exercising name-keyed RETURNING.
    app_user: makeTable(
      'app_user',
      [
        col('id', 'id', 'string', 'text', { hasDefault: true }),
        col('email', 'email', 'string', 'text'),
        col('name', 'name', 'string', 'text', { nullable: true }),
        col('age', 'age', 'number', 'int4', { nullable: true }),
        col('score', 'score', 'number', 'float8', { nullable: true }),
        col('created_at', 'createdAt', 'Date', 'timestamptz', { nullable: true }),
      ],
      {
        posts: {
          type: 'hasMany',
          name: 'posts',
          from: 'app_user',
          to: 'post',
          foreignKey: 'author_id',
          referenceKey: 'id',
        },
      },
    ),
    post: makeTable(
      'post',
      [
        col('id', 'id', 'string', 'text', { hasDefault: true }),
        col('author_id', 'authorId', 'string', 'text'),
        col('title', 'title', 'string', 'text'),
      ],
      {
        author: {
          type: 'belongsTo',
          name: 'author',
          from: 'post',
          to: 'app_user',
          foreignKey: 'author_id',
          referenceKey: 'id',
        },
      },
    ),
  },
};

// ---------------------------------------------------------------------------
// Per-test harness — fresh data dir + schema DDL, torn down after.
// ---------------------------------------------------------------------------

// biome-ignore lint/suspicious/noExplicitAny: TurbineClient table accessors are dynamically typed at this seam.
type DB = any;

async function withDb(fn: (db: DB) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'powdb-it-'));
  const db: DB = await turbinePowDB({ embedded: dir }, schema, { warnOnUnlimited: false });
  try {
    for (const t of Object.keys(schema.tables)) await db.raw([`drop ${t}`]).catch(() => {});
    for (const stmt of powqlSchemaDDL(schema)) await db.raw([stmt]);
    await fn(db);
  } finally {
    await db.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('powdb integration (embedded)', () => {
  // KEEP THIS TEST FIRST. The cold-client bug (ITEM 3) only bit when NO
  // transaction had ever run in the process/context: acquire()'s enterWith()
  // planted call #1's live re-entrancy marker where sibling same-tick calls
  // could see it, so 9/10 were falsely rejected E017, and one warm-up
  // transaction masked it (its pruned `done` marker changed the propagation
  // shape). Any earlier transaction in this file would be exactly such a
  // warm-up; runner isolation (one process per test file) plus first place in
  // declaration order keeps this genuinely cold. The leak's visibility is
  // runtime-dependent (ALS enterWith propagation differs across Node
  // versions/runtimes); the deterministic reduction lives in powdb.test.ts
  // ('re-entrancy marker never leaks into the caller context').
  it('COLD CLIENT: cold client, 10 db.$transaction calls in ONE synchronous tick, all succeed with zero E017', async () => {
    await withDb(async (db) => {
      const ps = Array.from({ length: 10 }, (_, i) =>
        db.$transaction(async (tx: DB) => {
          const created = await tx.table('app_user').create({ data: { email: `cold${i}@x`, name: `C${i}` } });
          return created.email;
        }),
      );
      const results = await Promise.all(ps);
      assert.deepEqual(
        results,
        Array.from({ length: 10 }, (_, i) => `cold${i}@x`),
        'every same-tick transaction committed, FIFO, no false re-entrancy',
      );
      assert.equal(await db.table('app_user').count({ where: { email: { startsWith: 'cold' } } }), 10);
    });
  });

  it('COLD CLIENT: sequential transactions from one long-lived context never chain into false E017', async () => {
    await withDb(async (db) => {
      for (let i = 0; i < 5; i++) {
        const out = await db.$transaction(async (tx: DB) => {
          await tx.table('app_user').create({ data: { email: `seq${i}@x` } });
          return i;
        });
        assert.equal(out, i);
      }
      assert.equal(await db.table('app_user').count({ where: { email: { startsWith: 'seq' } } }), 5);
    });
  });

  it('OWNED POOL: disconnect() really closes the OWNED embedded pool (queries afterwards fail typed)', async () => {
    // client.ts sees TurbineConfig.pool as external and skips pool.end();
    // before the fix, turbinePowDB's owned path never patched disconnect(),
    // so the pool outlived it (on the networked transport that left a live
    // socket holding the process open for powdb-server's 300s idle timeout).
    const dir = mkdtempSync(join(tmpdir(), 'powdb-it-close-'));
    const db: DB = await turbinePowDB({ embedded: dir }, schema, { warnOnUnlimited: false });
    try {
      for (const stmt of powqlSchemaDDL(schema)) await db.raw([stmt]);
      await db.table('app_user').create({ data: { email: 'pre-close@x' } });
      await db.disconnect();
      await assert.rejects(() => db.table('app_user').count({}), ConnectionError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('syncMode:"normal" (addon ≥0.7.1) opens and round-trips a write', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'powdb-it-sync-'));
    const db: DB = await turbinePowDB({ embedded: dir, syncMode: 'normal' }, schema, { warnOnUnlimited: false });
    try {
      for (const stmt of powqlSchemaDDL(schema)) await db.raw([stmt]);
      const u = await db.table('app_user').create({ data: { name: 'Norm', email: 'norm@x', age: 1, score: 1.5 } });
      assert.equal(u.email, 'norm@x');
      const found = await db.table('app_user').findUnique({ where: { email: 'norm@x' } });
      assert.equal(found.name, 'Norm');
    } finally {
      await db.disconnect();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('create/findUnique round-trips columns by NAME despite arg order ≠ schema order', async () => {
    await withDb(async (db) => {
      const created = await db.table('app_user').create({
        // arg order: age, email, score, name — NOT the schema column order
        data: { age: 42, email: 'ada@x', score: 9.5, name: 'Ada' },
      });
      assert.equal(created.email, 'ada@x');
      assert.equal(created.name, 'Ada');
      assert.equal(created.age, 42);
      assert.equal(created.score, 9.5);
      assert.ok(typeof created.id === 'string' && created.id.length > 0);

      const found = await db.table('app_user').findUnique({ where: { email: 'ada@x' } });
      assert.equal(found.id, created.id);
      assert.equal(found.age, 42);
      assert.equal(found.score, 9.5);
    });
  });

  it('createMany + findMany returns real rows (RETURNING, multi-row)', async () => {
    await withDb(async (db) => {
      const rows = await db.table('app_user').createMany({
        data: [
          { email: 'a@x', name: 'A', age: 1 },
          { email: 'b@x', name: 'B', age: 2 },
        ],
      });
      assert.equal(rows.length, 2);
      const all = await db.table('app_user').findMany({ orderBy: { age: 'asc' }, limit: 10 });
      assert.deepEqual(
        all.map((u: { name: string }) => u.name),
        ['A', 'B'],
      );
    });
  });

  it('maps unique / not-null / type-mismatch errors to typed Turbine errors', async () => {
    await withDb(async (db) => {
      await db.table('app_user').create({ data: { id: 'dup', email: 'dup@x', name: 'Dup' } });
      // unique — same PK
      await assert.rejects(
        () => db.table('app_user').create({ data: { id: 'dup', email: 'dup2@x', name: 'X' } }),
        UniqueConstraintError,
      );
      // not-null — omit required email
      await assert.rejects(
        () => db.table('app_user').create({ data: { name: 'NoEmail' } as never }),
        NotNullViolationError,
      );
      // type mismatch — string into an int column
      await assert.rejects(
        () => db.table('app_user').create({ data: { email: 'z@x', age: 'not-a-number' } as never }),
        ValidationError,
      );
    });
  });

  it('FIX 1: empty-where guard refuses compiled-empty filters and mutates nothing', async () => {
    await withDb(async (db) => {
      await db.table('app_user').createMany({
        data: [
          { email: 'g1@x', age: 10 },
          { email: 'g2@x', age: 20 },
          { email: 'g3@x', age: 30 },
        ],
      });
      const cases: Record<string, unknown>[] = [
        { OR: [] },
        { AND: [] },
        { NOT: {} },
        {},
        { id: undefined },
        { OR: [{ name: undefined }] },
      ];
      for (const where of cases) {
        await assert.rejects(
          () => db.table('app_user').updateMany({ where, data: { age: 0 } }),
          ValidationError,
          `expected guard to reject ${JSON.stringify(where)}`,
        );
        await assert.rejects(
          () => db.table('app_user').deleteMany({ where }),
          ValidationError,
          `expected delete guard to reject ${JSON.stringify(where)}`,
        );
      }
      // nothing was mutated/deleted
      assert.equal(await db.table('app_user').count({}), 3);

      // a REAL predicate still works
      const r = await db.table('app_user').updateMany({ where: { email: 'g1@x' }, data: { age: 111 } });
      assert.equal(r.count, 1);
      const g1 = await db.table('app_user').findUnique({ where: { email: 'g1@x' } });
      assert.equal(g1.age, 111);

      // explicit opt-in still allowed
      const all = await db.table('app_user').updateMany({ where: {}, allowFullTableScan: true, data: { age: 7 } });
      assert.equal(all.count, 3);
    });
  });

  it('single-level $transaction commits and rolls back', async () => {
    await withDb(async (db) => {
      await db.$transaction(async (tx: DB) => {
        await tx.table('app_user').create({ data: { email: 'commit@x', name: 'C' } });
      });
      assert.ok(await db.table('app_user').findUnique({ where: { email: 'commit@x' } }));

      await assert.rejects(
        () =>
          db.$transaction(async (tx: DB) => {
            await tx.table('app_user').create({ data: { email: 'rollback@x', name: 'R' } });
            throw new Error('force rollback');
          }),
        /force rollback/,
      );
      assert.equal(await db.table('app_user').findUnique({ where: { email: 'rollback@x' } }), null);
    });
  });

  it('FIX 2: nested tx.$transaction throws UnsupportedFeatureError (savepoint override)', async () => {
    await withDb(async (db) => {
      await assert.rejects(
        () =>
          db.$transaction(async (tx: DB) => {
            await tx.table('app_user').create({ data: { email: 'outer@x' } });
            await tx.$transaction(async () => {});
          }),
        UnsupportedFeatureError,
      );
    });
  });

  it('FIX 2: re-entrant db.$transaction throws (pool single-writer guard), does not hang', async () => {
    await withDb(async (db) => {
      const guarded = Promise.race([
        db.$transaction(async (tx: DB) => {
          await tx.table('app_user').create({ data: { email: 'reouter@x' } });
          await db.$transaction(async (inner: DB) => {
            await inner.table('app_user').create({ data: { email: 'reinner@x' } });
          });
        }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('HANG: re-entrant tx did not return')), 8000)),
      ]);
      await assert.rejects(() => guarded, UnsupportedFeatureError);
      // the pool still works afterwards (flag cleared)
      assert.equal(typeof (await db.table('app_user').count({})), 'number');
    });
  });

  it('T-7: 10 concurrent db.$transaction writers all succeed (FIFO queue, no E017)', async () => {
    await withDb(async (db) => {
      // The dogfood failure shape: 10-way concurrent transactional creates
      // used to fail ~54% of the time on the begin-while-active guard. They
      // now queue on the single-writer gate and run one at a time.
      const results = await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          db.$transaction(async (tx: DB) => {
            const created = await tx.table('app_user').create({ data: { email: `queued${i}@x`, name: `Q${i}` } });
            return created.email;
          }),
        ),
      );
      assert.equal(new Set(results).size, 10, 'every concurrent transaction committed');
      const count = await db.table('app_user').count({ where: { email: { startsWith: 'queued' } } });
      assert.equal(count, 10);
    });
  });

  it('FIX 4: chunked relation load returns every child over > MAX_RELATION_KEYS parents', async () => {
    await withDb(async (db) => {
      const N = 1200; // > MAX_RELATION_KEYS (1000) → at least two chunks
      const users = Array.from({ length: N }, (_, i) => ({ id: `u${i}`, email: `bulk${i}@x`, age: i }));
      for (let i = 0; i < users.length; i += 300) {
        await db.table('app_user').createMany({ data: users.slice(i, i + 300) });
      }
      const posts = users.map((u, i) => ({ id: `p${i}`, authorId: u.id, title: `T${i}` }));
      for (let i = 0; i < posts.length; i += 300) {
        await db.table('post').createMany({ data: posts.slice(i, i + 300) });
      }
      const loaded = await db.table('app_user').findMany({
        where: { email: { startsWith: 'bulk' } },
        with: { posts: true },
        limit: 5000,
      });
      assert.equal(loaded.length, N);
      assert.ok(loaded.every((u: { posts: unknown[] }) => Array.isArray(u.posts) && u.posts.length === 1));
      const totalChildren = loaded.reduce((s: number, u: { posts: unknown[] }) => s + u.posts.length, 0);
      assert.equal(totalChildren, N);
    });
  });

  // -------------------------------------------------------------------------
  // Adversarial-review regressions: stray ROLLBACK after a failed BEGIN must
  // never touch the OTHER transaction on the single shared engine handle, and
  // cross-pool nesting must not defeat the re-entrancy marker.
  // -------------------------------------------------------------------------

  it('REVIEW 1: a queued tx timing out (E002) never rolls back the OTHER open transaction', async () => {
    // Live-reproduced corruption shape: tx2's begin times out in the FIFO
    // queue, its $transaction catch used to fire a best-effort ROLLBACK that
    // the embedded pool forwarded to the ONE shared handle — discarding tx1's
    // first write, autocommitting its second, and failing its COMMIT (E003).
    const dir = mkdtempSync(join(tmpdir(), 'powdb-it-gate-'));
    const db: DB = await turbinePowDB({ embedded: dir }, schema, {
      warnOnUnlimited: false,
      transactionQueueTimeoutMs: 150,
    });
    try {
      for (const stmt of powqlSchemaDDL(schema)) await db.raw([stmt]);
      const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
      const tx1 = db.$transaction(async (tx: DB) => {
        await tx.table('app_user').create({ data: { email: 'atomic-a@x', name: 'A' } });
        await sleep(450); // hold the gate well past tx2's 150ms queue timeout
        await tx.table('app_user').create({ data: { email: 'atomic-b@x', name: 'B' } });
      });
      await sleep(50); // let tx1's begin own the gate before tx2 queues behind it
      const tx2 = db.$transaction(async (tx: DB) => {
        await tx.table('app_user').create({ data: { email: 'late@x' } });
      });
      const [r1, r2] = await Promise.allSettled([tx1, tx2]);
      assert.equal(
        r1.status,
        'fulfilled',
        `tx1 must commit atomically, got: ${r1.status === 'rejected' ? (r1 as PromiseRejectedResult).reason : ''}`,
      );
      assert.equal(r2.status, 'rejected', 'tx2 must fail with the queue timeout');
      const reason = (r2 as PromiseRejectedResult).reason;
      assert.ok(reason instanceof TimeoutError, `tx2 error must be TimeoutError, got: ${reason}`);
      assert.equal(reason.code, 'TURBINE_E002');
      // BOTH tx1 rows present — the repro had A silently discarded and B autocommitted.
      assert.ok(await db.table('app_user').findUnique({ where: { email: 'atomic-a@x' } }), 'tx1 first write kept');
      assert.ok(await db.table('app_user').findUnique({ where: { email: 'atomic-b@x' } }), 'tx1 second write kept');
      assert.equal(await db.table('app_user').findUnique({ where: { email: 'late@x' } }), null, 'tx2 wrote nothing');
    } finally {
      await db.disconnect();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('REVIEW 1: a fire-and-forget db.$transaction inside a tx callback leaves the outer tx atomic', async () => {
    await withDb(async (db) => {
      let innerErr: unknown;
      await db.$transaction(async (tx: DB) => {
        await tx.table('app_user').create({ data: { email: 'ff-a@x' } });
        // Fire-and-forget: NOT awaited before the outer tx's next write. Its
        // re-entrant begin throws E017; the failed $transaction must not emit
        // a stray ROLLBACK onto the shared handle (which used to discard
        // ff-a@x and autocommit ff-b@x).
        const inner = db
          .$transaction(async (t2: DB) => {
            await t2.table('app_user').create({ data: { email: 'ff-inner@x' } });
          })
          .catch((e: unknown) => {
            innerErr = e;
          });
        await tx.table('app_user').create({ data: { email: 'ff-b@x' } });
        await inner; // settle before commit so the assertions are deterministic
      });
      assert.ok(innerErr instanceof UnsupportedFeatureError, `inner tx must throw E017, got: ${innerErr}`);
      assert.ok(await db.table('app_user').findUnique({ where: { email: 'ff-a@x' } }), 'outer first write kept');
      assert.ok(await db.table('app_user').findUnique({ where: { email: 'ff-b@x' } }), 'outer second write kept');
      assert.equal(await db.table('app_user').findUnique({ where: { email: 'ff-inner@x' } }), null);
    });
  });

  it('REVIEW 2: cross-pool nesting — inner re-entrant begin on the OUTER pool throws E017 instantly', async () => {
    // dbA tx → dbB tx → dbA tx. dbB's ALS marker used to SHADOW dbA's
    // (single-slot store), so the inner dbA begin queued behind dbA's own
    // open transaction and deadlocked until the queue timeout. The chained
    // marker walk must throw re-entrant E017 immediately instead.
    const dirA = mkdtempSync(join(tmpdir(), 'powdb-it-xpa-'));
    const dirB = mkdtempSync(join(tmpdir(), 'powdb-it-xpb-'));
    const opts = { warnOnUnlimited: false, transactionQueueTimeoutMs: 10_000 };
    const dbA: DB = await turbinePowDB({ embedded: dirA }, schema, opts);
    const dbB: DB = await turbinePowDB({ embedded: dirB }, schema, opts);
    try {
      for (const stmt of powqlSchemaDDL(schema)) await dbA.raw([stmt]);
      for (const stmt of powqlSchemaDDL(schema)) await dbB.raw([stmt]);
      const start = Date.now();
      await assert.rejects(
        dbA.$transaction(async (txA: DB) => {
          await txA.table('app_user').create({ data: { email: 'xp-a@x' } });
          await dbB.$transaction(async (txB: DB) => {
            await txB.table('app_user').create({ data: { email: 'xp-b@x' } });
            await dbA.$transaction(async () => {}); // re-entrant on dbA through dbB's context
          });
        }),
        UnsupportedFeatureError,
      );
      const elapsed = Date.now() - start;
      assert.ok(elapsed < 2000, `re-entrancy must be detected instantly, took ${elapsed}ms (queue timeout is 10s)`);
      // Both pools rolled back cleanly.
      assert.equal(await dbA.table('app_user').findUnique({ where: { email: 'xp-a@x' } }), null);
      assert.equal(await dbB.table('app_user').findUnique({ where: { email: 'xp-b@x' } }), null);
      // Both pools still usable afterwards.
      assert.equal(typeof (await dbA.table('app_user').count({})), 'number');
      assert.equal(typeof (await dbB.table('app_user').count({})), 'number');
    } finally {
      await dbA.disconnect();
      await dbB.disconnect();
      rmSync(dirA, { recursive: true, force: true });
      rmSync(dirB, { recursive: true, force: true });
    }
  });

  it('REVIEW 2: plain single-pool re-entrancy still throws E017 instantly (fast path kept)', async () => {
    // withDb's default queue timeout is 30s — a regression that queues the
    // re-entrant begin instead of throwing would blow this timing bound.
    await withDb(async (db) => {
      const start = Date.now();
      await assert.rejects(
        db.$transaction(async () => {
          await db.$transaction(async () => {});
        }),
        UnsupportedFeatureError,
      );
      assert.ok(Date.now() - start < 2000, 'single-pool re-entrancy must not wait on the queue timeout');
    });
  });

  it('E017: pgvector filters and cursor streaming are unsupported', async () => {
    await withDb(async (db) => {
      await assert.rejects(
        () =>
          db.table('app_user').findMany({
            where: { score: { distance: { to: [1], metric: 'cosine', lt: 1 } } } as never,
          }),
        UnsupportedFeatureError,
      );
      await assert.rejects(() => db.table('app_user').findManyStream().next(), UnsupportedFeatureError);
    });
  });
});

// ---------------------------------------------------------------------------
// Phase B (v0.23.0) — auto/server-generated PKs, manyToMany reads + filters,
// nested writes, composite-key upsert. Own schema (auto-int PKs + a junction).
// These exercise the live engine; the relation-filter cases also guard the
// PowDB subquery-result-cache bug (Turbine resolves filters to literal lists).
// ---------------------------------------------------------------------------

function composite(name: string, columns: ColumnMetadata[], pk: string[]): TableMetadata {
  return { ...makeTable(name, columns), primaryKey: pk, uniqueColumns: [] };
}

const pbSchema: SchemaMetadata = {
  enums: {},
  tables: {
    member: makeTable(
      'member',
      [
        col('id', 'id', 'number', 'int8', { isGenerated: true, hasDefault: true }),
        col('name', 'name', 'string', 'text'),
      ],
      {
        posts: {
          type: 'hasMany',
          name: 'posts',
          from: 'member',
          to: 'ppost',
          foreignKey: 'member_id',
          referenceKey: 'id',
        },
        tags: {
          type: 'manyToMany',
          name: 'tags',
          from: 'member',
          to: 'ptag',
          foreignKey: 'id',
          referenceKey: 'id',
          through: { table: 'member_tag', sourceKey: 'member_id', targetKey: 'tag_id' },
        },
      },
    ),
    ppost: makeTable(
      'ppost',
      [
        col('id', 'id', 'number', 'int8', { isGenerated: true, hasDefault: true }),
        col('member_id', 'memberId', 'number', 'int8'),
        col('title', 'title', 'string', 'text'),
      ],
      {
        author: {
          type: 'belongsTo',
          name: 'author',
          from: 'ppost',
          to: 'member',
          foreignKey: 'member_id',
          referenceKey: 'id',
        },
      },
    ),
    ptag: makeTable('ptag', [
      col('id', 'id', 'number', 'int8', { isGenerated: true, hasDefault: true }),
      col('label', 'label', 'string', 'text'),
    ]),
    member_tag: composite(
      'member_tag',
      [col('member_id', 'memberId', 'number', 'int8'), col('tag_id', 'tagId', 'number', 'int8')],
      ['member_id', 'tag_id'],
    ),
    pscore: composite(
      'pscore',
      [
        col('member_id', 'memberId', 'number', 'int8'),
        col('tag_id', 'tagId', 'number', 'int8'),
        col('points', 'points', 'number', 'int8'),
      ],
      ['member_id', 'tag_id'],
    ),
  },
};

async function withPb(fn: (db: DB) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'powdb-pb-'));
  const db: DB = await turbinePowDB({ embedded: dir, syncMode: 'normal' }, pbSchema, { warnOnUnlimited: false });
  try {
    for (const stmt of powqlSchemaDDL(pbSchema)) await db.raw([stmt]);
    await fn(db);
  } finally {
    await db.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('powdb integration: Phase B', () => {
  it('auto/server-generated int PK — create/createMany assign monotonic ids', async () => {
    await withPb(async (db) => {
      const a = await db.table('member').create({ data: { name: 'Ada' } });
      const b = await db.table('member').create({ data: { name: 'Bob' } });
      assert.equal(typeof a.id, 'number');
      assert.equal(b.id, a.id + 1);
      const many = await db.table('member').createMany({ data: [{ name: 'Cy' }, { name: 'Di' }] });
      assert.equal(many.length, 2);
      assert.notEqual(many[0].id, many[1].id);
    });
  });

  it('manyToMany nested reads — junction loader stitches targets (empty array, not null)', async () => {
    await withPb(async (db) => {
      const ada = await db.table('member').create({ data: { name: 'Ada' } });
      const bob = await db.table('member').create({ data: { name: 'Bob' } });
      const cy = await db.table('member').create({ data: { name: 'Cy' } });
      const red = await db.table('ptag').create({ data: { label: 'red' } });
      const blue = await db.table('ptag').create({ data: { label: 'blue' } });
      await db.table('member_tag').createMany({
        data: [
          { memberId: ada.id, tagId: red.id },
          { memberId: ada.id, tagId: blue.id },
          { memberId: bob.id, tagId: blue.id },
        ],
      });
      const rows = await db.table('member').findMany({
        where: { id: { in: [ada.id, bob.id, cy.id] } },
        orderBy: { id: 'asc' },
        with: { tags: true },
      });
      const by = Object.fromEntries(rows.map((r: { name: string }) => [r.name, r]));
      assert.equal(by.Ada.tags.length, 2);
      assert.deepEqual(by.Ada.tags.map((t: { label: string }) => t.label).sort(), ['blue', 'red']);
      assert.equal(by.Bob.tags.length, 1);
      assert.ok(Array.isArray(by.Cy.tags) && by.Cy.tags.length === 0);
    });
  });

  it('manyToMany relation filters — some/none/every resolve correctly and DETERMINISTICALLY', async () => {
    await withPb(async (db) => {
      const ada = await db.table('member').create({ data: { name: 'Ada' } });
      const bob = await db.table('member').create({ data: { name: 'Bob' } });
      const cy = await db.table('member').create({ data: { name: 'Cy' } });
      const red = await db.table('ptag').create({ data: { label: 'red' } });
      const blue = await db.table('ptag').create({ data: { label: 'blue' } });
      await db.table('member_tag').createMany({
        data: [
          { memberId: ada.id, tagId: red.id },
          { memberId: ada.id, tagId: blue.id },
          { memberId: bob.id, tagId: blue.id },
        ],
      });
      const names = (rs: { name: string }[]) =>
        rs
          .map((r) => r.name)
          .sort()
          .join(',');
      // Run red BEFORE blue — the pre-cache-bug ordering that returned stale rows.
      assert.equal(names(await db.table('member').findMany({ where: { tags: { some: { label: 'red' } } } })), 'Ada');
      assert.equal(
        names(await db.table('member').findMany({ where: { tags: { some: { label: 'blue' } } } })),
        'Ada,Bob',
      );
      assert.equal(names(await db.table('member').findMany({ where: { tags: { none: { label: 'blue' } } } })), 'Cy');
      assert.equal(
        names(await db.table('member').findMany({ where: { tags: { every: { label: 'blue' } } } })),
        'Bob,Cy',
      );
      void cy;
    });
  });

  it('hasMany/belongsTo relation filters resolve to literal lists (no stale IN-subquery)', async () => {
    await withPb(async (db) => {
      const ada = await db.table('member').create({ data: { name: 'Ada' } });
      const bob = await db.table('member').create({ data: { name: 'Bob' } });
      await db.table('ppost').createMany({
        data: [
          { memberId: ada.id, title: 'x' },
          { memberId: bob.id, title: 'y' },
        ],
      });
      // querying by different titles back-to-back must NOT return stale results
      const x = await db.table('member').findMany({ where: { posts: { some: { title: 'x' } } } });
      const y = await db.table('member').findMany({ where: { posts: { some: { title: 'y' } } } });
      assert.deepEqual(
        x.map((m: { name: string }) => m.name),
        ['Ada'],
      );
      assert.deepEqual(
        y.map((m: { name: string }) => m.name),
        ['Bob'],
      );
    });
  });

  it('nested writes — hasMany create + belongsTo create/connect, atomic rollback on failure', async () => {
    await withPb(async (db) => {
      const eve = await db
        .table('member')
        .create({ data: { name: 'Eve', posts: { create: [{ title: 'P1' }, { title: 'P2' }] } } });
      const full = await db.table('member').findUnique({ where: { id: eve.id }, with: { posts: true } });
      assert.equal(full.posts.length, 2);
      assert.ok(full.posts.every((p: { memberId: number }) => p.memberId === eve.id));
      const post = await db
        .table('ppost')
        .create({ data: { title: 'byFrank', author: { create: { name: 'Frank' } } } });
      const frank = await db.table('member').findFirst({ where: { name: 'Frank' } });
      assert.equal(post.memberId, frank.id);
      // atomic: a failing nested create rolls back the parent
      const dupe = post.id;
      let threw = false;
      try {
        await db
          .table('member')
          .create({ data: { name: 'Zed', posts: { create: [{ title: 'ok' }, { id: dupe, title: 'dupe' }] } } });
      } catch {
        threw = true;
      }
      assert.ok(threw);
      assert.equal((await db.table('member').findMany({ where: { name: 'Zed' } })).length, 0);
    });
  });

  it('composite-key upsert — insert then update branch, exactly one row', async () => {
    await withPb(async (db) => {
      const ins = await db.table('pscore').upsert({
        where: { memberId: 1, tagId: 2 },
        create: { memberId: 1, tagId: 2, points: 10 },
        update: { points: 99 },
      });
      assert.equal(ins.points, 10);
      const upd = await db.table('pscore').upsert({
        where: { memberId: 1, tagId: 2 },
        create: { memberId: 1, tagId: 2, points: 10 },
        update: { points: 99 },
      });
      assert.equal(upd.points, 99);
      const rows = await db.table('pscore').findMany({ where: { memberId: 1, tagId: 2 } });
      assert.equal(rows.length, 1);
    });
  });
});

// ---------------------------------------------------------------------------
// F3 / B1: native `json` document round-trip on the EMBEDDED transport
//
// The embedded addon exposes only the legacy string wire (its rows are
// `string[][]`), so the acceptance here is: json document CONTENTS are lossless
// (distinct canonical JSON texts parse back to distinct objects), while the
// documented CELL-level residuals (a top-level JSON-null document vs an absent
// value both render `null`; a nullable str "null" collapses) are asserted
// explicitly so a future native embedded surface flips them loudly.
//
// Writes go through raw PowQL carrying a PowdbJsonParam (the embedded pool
// materializes it via encodePowqlLiteral); the read path exercises the real
// findMany -> coerceValue json parsing. The create()/findMany json write path
// (param() constructing PowdbJsonParam for a json column) lands with F1.
// ---------------------------------------------------------------------------

const docSchema: SchemaMetadata = {
  enums: {},
  tables: {
    doc: makeTable(
      'doc',
      [
        col('id', 'id', 'string', 'text', { hasDefault: true }),
        col('data', 'data', 'Record<string, unknown>', 'jsonb', { nullable: true }),
        col('s', 's', 'string', 'text', { nullable: true }),
      ],
      {},
    ),
  },
};

async function withDocDb(fn: (db: DB) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'powdb-json-it-'));
  const db: DB = await turbinePowDB({ embedded: dir }, docSchema, { warnOnUnlimited: false });
  try {
    await db.raw([`drop doc`]).catch(() => {});
    for (const stmt of powqlSchemaDDL(docSchema)) await db.raw([stmt]);
    await fn(db);
  } finally {
    await db.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Insert one doc row via raw PowQL, encoding `data` as a json document. */
async function insertDoc(db: DB, id: string, data: PowdbJsonParam | null, s?: string | null): Promise<void> {
  if (s === undefined) {
    await db.raw(['insert doc { id := ', ', data := ', ' } returning'], id, data);
  } else {
    await db.raw(['insert doc { id := ', ', data := ', ', s := ', ' } returning'], id, data, s);
  }
}

describe('powdb integration (embedded): json document round-trip', () => {
  it('ACCEPTANCE: {a:null} vs {} vs {a:"null"} read back as three DISTINCT documents', async () => {
    await withDocDb(async (db) => {
      await insertDoc(db, 'd1', new PowdbJsonParam({ a: null }));
      await insertDoc(db, 'd2', new PowdbJsonParam({}));
      await insertDoc(db, 'd3', new PowdbJsonParam({ a: 'null' }));
      const rows = await db.table('doc').findMany({ orderBy: { id: 'asc' } });
      assert.deepEqual(
        rows.map((r: { data: unknown }) => r.data),
        [{ a: null }, {}, { a: 'null' }],
        'json contents are lossless and mutually distinct on the embedded transport',
      );
    });
  });

  it('round-trips nested documents, arrays, and int/float/bool distinctions', async () => {
    await withDocDb(async (db) => {
      const doc = { n: 7, f: 2.5, b: true, arr: [1, 2, { deep: 'x' }], nested: { k: null } };
      await insertDoc(db, 'x1', new PowdbJsonParam(doc));
      const [row] = await db.table('doc').findMany({ where: { id: 'x1' } });
      assert.deepEqual(row.data, doc);
    });
  });

  it('DOCUMENTED RESIDUAL: an absent json column and a JSON-null document both read null on embedded', async () => {
    await withDocDb(async (db) => {
      // Absent value (data := null).
      await insertDoc(db, 'absent', null);
      // A top-level JSON-null document.
      await insertDoc(db, 'jsonnull', new PowdbJsonParam(null));
      const rows = await db.table('doc').findMany({ orderBy: { id: 'asc' } });
      const byId = Object.fromEntries(rows.map((r: { id: string; data: unknown }) => [r.id, r.data]));
      // Both collapse to null on the legacy string wire (fixed only on the
      // native networked transport). If a future embedded native surface lands,
      // THIS assertion flips loudly and forces the mapping to be revisited.
      assert.equal(byId.absent, null);
      assert.equal(byId.jsonnull, null);
    });
  });

  it('DOCUMENTED WART: a nullable str holding "null" reads null on the embedded legacy wire', async () => {
    await withDocDb(async (db) => {
      await insertDoc(db, 's1', new PowdbJsonParam({}), 'null'); // s = the string "null"
      await insertDoc(db, 's2', new PowdbJsonParam({}), null); // s = SQL null
      const rows = await db.table('doc').findMany({ orderBy: { id: 'asc' } });
      const byId = Object.fromEntries(rows.map((r: { id: string; s: unknown }) => [r.id, r.s]));
      // Legacy-wire wart: indistinguishable on embedded (both null). The native
      // networked transport keeps "null" a string (covered by the pool unit test).
      assert.equal(byId.s1, null);
      assert.equal(byId.s2, null);
    });
  });
});

// ---------------------------------------------------------------------------
// F4a: doc-field expression index DDL. The real embedded engine must ACCEPT
// the `alter T add index (.data->"seg")` statements powqlSchemaDDL emits, and
// an index-backed path query returns the right rows (an index must never
// change results). Doc index DDL is executed via powqlSchemaDDL(db.raw).
// ---------------------------------------------------------------------------

/** A `doc` table with a doc-field index (path `data->ns->value`) and a unique one on `data->ext`. */
const idxSchema: SchemaMetadata = {
  enums: {},
  tables: {
    doc: {
      ...makeTable(
        'doc',
        [
          col('id', 'id', 'string', 'text', { hasDefault: true }),
          col('data', 'data', 'Record<string, unknown>', 'jsonb', { nullable: true }),
        ],
        {},
      ),
      indexes: [
        { name: 'doc_data_ns_value_idx', columns: ['data'], unique: false, definition: '', docPath: ['ns', 'value'] },
        { name: 'doc_data_ext_idx', columns: ['data'], unique: true, definition: '', docPath: ['ext'] },
      ],
    },
  },
};

describe('powdb integration (embedded): doc-field expression index DDL', () => {
  it('the engine accepts the emitted doc-field index DDL and index-backed queries return correct rows', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'powdb-idx-it-'));
    const db: DB = await turbinePowDB({ embedded: dir }, idxSchema, { warnOnUnlimited: false });
    try {
      const ddl = powqlSchemaDDL(idxSchema);
      // The emitted DDL must include the parenthesized doc-field statements.
      assert.ok(
        ddl.some((s) => s === 'alter doc add index (.data->"ns"->"value")'),
        `expected doc index DDL, got:\n${ddl.join('\n')}`,
      );
      assert.ok(ddl.some((s) => s === 'alter doc add unique (.data->"ext")'));
      // The real engine ACCEPTS every statement (a malformed path would throw).
      for (const stmt of ddl) await db.raw([stmt]);

      // Seed docs and query over the indexed path via raw PowQL (F1's ORM-level
      // JsonFilter lands separately; the index must not alter results either way).
      await db.raw(
        ['insert doc { id := ', ', data := ', ' } returning'],
        'a',
        new PowdbJsonParam({ ns: { value: 7 }, ext: 'x1' }),
      );
      await db.raw(
        ['insert doc { id := ', ', data := ', ' } returning'],
        'b',
        new PowdbJsonParam({ ns: { value: 9 }, ext: 'x2' }),
      );

      const hit = (await db.raw(['doc filter .data->"ns"->"value" = 7 { .id }'])) as { id: string }[];
      assert.deepEqual(
        hit.map((r) => r.id),
        ['a'],
      );
      const miss = (await db.raw(['doc filter .data->"ns"->"value" = 8 { .id }'])) as { id: string }[];
      assert.deepEqual(miss, []);

      // The unique doc-field index is enforced by the engine: a duplicate `ext`
      // value is rejected, and the engine's "unique expression index violation"
      // message maps to UniqueConstraintError (E008) like the regular
      // "unique constraint violation" wording.
      await assert.rejects(
        () => db.raw(['insert doc { id := ', ', data := ', ' } returning'], 'c', new PowdbJsonParam({ ext: 'x1' })),
        (err: Error & { code?: string }) => err.code === 'TURBINE_E008',
      );

      // The drop path works (design mentions `alter … drop index`).
      await db.raw(['alter doc drop index (.data->"ns"->"value")']);
      const stillHit = (await db.raw(['doc filter .data->"ns"->"value" = 9 { .id }'])) as { id: string }[];
      assert.deepEqual(
        stillHit.map((r) => r.id),
        ['b'],
      ); // results unchanged after drop
    } finally {
      await db.disconnect();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// F1 / F2: JSON path filters, ordering, and grouped aggregates against the real
// embedded 0.13 engine. Writes go through the real create() path (param() wraps
// the object in a PowdbJsonParam); reads/filters/orders/groups exercise the full
// PowqlInterface emission end-to-end.
// ---------------------------------------------------------------------------

const jsonSchema: SchemaMetadata = {
  enums: {},
  tables: {
    jdoc: makeTable('jdoc', [
      col('id', 'id', 'string', 'text', { hasDefault: true }),
      col('data', 'data', 'Record<string, unknown>', 'jsonb', { nullable: true }),
      col('region', 'region', 'string', 'text', { nullable: true }),
    ]),
    // Parent/child pair for the relation-filter-with-JSON-inner-where test.
    owner: makeTable('owner', [col('id', 'id', 'string', 'text', { hasDefault: true })], {
      items: { type: 'hasMany', name: 'items', from: 'owner', to: 'item', foreignKey: 'owner_id', referenceKey: 'id' },
    }),
    item: makeTable('item', [
      col('id', 'id', 'string', 'text', { hasDefault: true }),
      col('owner_id', 'ownerId', 'string', 'text'),
      col('data', 'data', 'Record<string, unknown>', 'jsonb', { nullable: true }),
    ]),
  },
};

async function withJsonDb(fn: (db: DB) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'powdb-json2-it-'));
  const db: DB = await turbinePowDB({ embedded: dir }, jsonSchema, { warnOnUnlimited: false });
  try {
    for (const t of ['jdoc', 'owner', 'item']) await db.raw([`drop ${t}`]).catch(() => {});
    for (const stmt of powqlSchemaDDL(jsonSchema)) await db.raw([stmt]);
    await fn(db);
  } finally {
    await db.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Seed the five canonical docs from the design (section 0). */
async function seedJdocs(db: DB): Promise<void> {
  await db.table('jdoc').create({ data: { id: 'jnull', data: { a: null } } });
  await db.table('jdoc').create({ data: { id: 'jmiss', data: {} } });
  await db.table('jdoc').create({ data: { id: 'jstr', data: { a: 'null' } } });
  await db.table('jdoc').create({ data: { id: 'jnum', data: { a: 7, k: 2, f: 2.5 } } });
  await db.table('jdoc').create({ data: { id: 'jbool', data: { a: true } } });
}

describe('powdb integration (embedded): F1 JsonFilter where round-trip', () => {
  it('equals matches the exact typed value (int 7)', async () => {
    await withJsonDb(async (db) => {
      await seedJdocs(db);
      const rows = await db.table('jdoc').findMany({ where: { data: { path: ['a'], equals: 7 } } });
      assert.deepEqual(
        rows.map((r: { id: string }) => r.id),
        ['jnum'],
      );
    });
  });

  it('equals: null matches JSON null AND a missing key', async () => {
    await withJsonDb(async (db) => {
      await seedJdocs(db);
      const rows = await db.table('jdoc').findMany({
        where: { data: { path: ['a'], equals: null } },
        orderBy: { id: 'asc' },
      });
      // jnull (a:null) + jmiss (no key). NOT jstr (a:"null"), NOT jnum/jbool.
      assert.deepEqual(rows.map((r: { id: string }) => r.id).sort(), ['jmiss', 'jnull']);
    });
  });

  it('range op (gt) coerces int/float numerically', async () => {
    await withJsonDb(async (db) => {
      await seedJdocs(db);
      const rows = await db.table('jdoc').findMany({ where: { data: { path: ['f'], gt: 2 } } });
      assert.deepEqual(
        rows.map((r: { id: string }) => r.id),
        ['jnum'],
      ); // f:2.5 > 2
    });
  });

  it('hasKey tests top-level key existence (includes keys holding JSON null)', async () => {
    await withJsonDb(async (db) => {
      await seedJdocs(db);
      const rows = await db.table('jdoc').findMany({ where: { data: { hasKey: 'a' } }, orderBy: { id: 'asc' } });
      // Every doc with an "a" key: jnull, jstr, jnum, jbool. NOT jmiss.
      assert.deepEqual(rows.map((r: { id: string }) => r.id).sort(), ['jbool', 'jnull', 'jnum', 'jstr']);
    });
  });

  it('a hostile path segment round-trips as a no-match filter, never a parse error', async () => {
    await withJsonDb(async (db) => {
      await seedJdocs(db);
      const rows = await db.table('jdoc').findMany({ where: { data: { path: ['a"; drop', '$1'], equals: 1 } } });
      assert.deepEqual(rows, []);
    });
  });

  it('a JSON inner where inside a relation filter resolves client-side', async () => {
    await withJsonDb(async (db) => {
      await db.table('owner').create({ data: { id: 'o1' } });
      await db.table('owner').create({ data: { id: 'o2' } });
      await db.table('item').create({ data: { id: 'i1', ownerId: 'o1', data: { kind: 'x' } } });
      await db.table('item').create({ data: { id: 'i2', ownerId: 'o2', data: { kind: 'y' } } });
      const owners = await db.table('owner').findMany({
        where: { items: { some: { data: { path: ['kind'], equals: 'x' } } } },
        orderBy: { id: 'asc' },
      });
      assert.deepEqual(
        owners.map((o: { id: string }) => o.id),
        ['o1'],
      );
    });
  });
});

describe('powdb integration (embedded): F2 JSON-path orderBy', () => {
  it('orders by a JSON path asc/desc with missing/JSON-null keys LAST in both directions', async () => {
    await withJsonDb(async (db) => {
      // vals: v1=3, v2=1, jn=json-null, jm=missing → asc [v2,v1,jn,jm-ish], nulls last.
      await db.table('jdoc').create({ data: { id: 'v1', data: { w: 3 } } });
      await db.table('jdoc').create({ data: { id: 'v2', data: { w: 1 } } });
      await db.table('jdoc').create({ data: { id: 'jn', data: { w: null } } });
      await db.table('jdoc').create({ data: { id: 'jm', data: {} } });
      const asc = await db.table('jdoc').findMany({ orderBy: { data: { path: ['w'] } } });
      const desc = await db.table('jdoc').findMany({ orderBy: { data: { path: ['w'], direction: 'desc' } } });
      // Present keys sort by value; missing/null cluster LAST in BOTH directions.
      assert.deepEqual(
        asc.slice(0, 2).map((r: { id: string }) => r.id),
        ['v2', 'v1'],
      );
      assert.deepEqual(
        desc.slice(0, 2).map((r: { id: string }) => r.id),
        ['v1', 'v2'],
      );
      for (const rows of [asc, desc]) {
        const tail = rows
          .slice(2)
          .map((r: { id: string }) => r.id)
          .sort();
        assert.deepEqual(tail, ['jm', 'jn'], 'missing + json-null sort last');
      }
    });
  });

  it('type:numeric casts JSON STRING numbers so "9" < "10"', async () => {
    await withJsonDb(async (db) => {
      await db.table('jdoc').create({ data: { id: 's9', data: { w: '9' } } });
      await db.table('jdoc').create({ data: { id: 's10', data: { w: '10' } } });
      const rows = await db.table('jdoc').findMany({
        where: { data: { hasKey: 'w' } },
        orderBy: { data: { path: ['w'], type: 'numeric' } },
      });
      assert.deepEqual(
        rows.map((r: { id: string }) => r.id),
        ['s9', 's10'],
      );
    });
  });
});

describe('powdb integration (embedded): F2 JSON groupBy', () => {
  it('groups {a:null} / {} / {a:"null"} into THREE result groups (null / "null" disambiguated)', async () => {
    await withJsonDb(async (db) => {
      await seedJdocs(db);
      const groups = await db.table('jdoc').groupBy({ by: [{ field: 'data', path: ['a'] }], _count: true });
      const byKey = new Map<unknown, number>(groups.map((g: { a: unknown; _count: number }) => [g.a, g._count]));
      // The empty-set group (JSON null + missing) = jnull + jmiss → 2 under `null`.
      assert.equal(byKey.get(null), 2);
      // The string-"null" group = jstr → 1 under the STRING "null".
      assert.equal(byKey.get('null'), 1);
      // Value groups render as strings (parity with PG #>> text keys).
      assert.equal(byKey.get('7'), 1);
      assert.equal(byKey.get('true'), 1);
    });
  });

  it('aggregate + orderBy over projection alias (_count desc) and JSON _sum target', async () => {
    await withJsonDb(async (db) => {
      // Two regions with numeric json amounts.
      await db.table('jdoc').create({ data: { id: 'r1', region: 'us', data: { amt: 10 } } });
      await db.table('jdoc').create({ data: { id: 'r2', region: 'us', data: { amt: 5 } } });
      await db.table('jdoc').create({ data: { id: 'r3', region: 'eu', data: { amt: 3 } } });
      const byCount = await db.table('jdoc').groupBy({
        by: ['region'],
        _count: true,
        _sum: { amt: { field: 'data', path: ['amt'] } },
        orderBy: { _count: 'desc' },
      });
      assert.deepEqual(
        byCount.map((g: { region: string }) => g.region),
        ['us', 'eu'],
      );
      const us = byCount.find((g: { region: string }) => g.region === 'us');
      assert.equal(us._count, 2);
      assert.equal(us._sum.amt, 15); // 10 + 5
    });
  });

  it('HAVING over count(*) filters whole groups', async () => {
    await withJsonDb(async (db) => {
      await db.table('jdoc').create({ data: { id: 'h1', region: 'a' } });
      await db.table('jdoc').create({ data: { id: 'h2', region: 'a' } });
      await db.table('jdoc').create({ data: { id: 'h3', region: 'b' } });
      const groups = await db.table('jdoc').groupBy({
        by: ['region'],
        _count: true,
        having: { _count: { gt: 1 } },
      });
      assert.deepEqual(
        groups.map((g: { region: string }) => g.region),
        ['a'],
      );
    });
  });
});

// ---------------------------------------------------------------------------
// F4b: describe-based introspection. Introspect a live embedded database via
// `introspectPowdbDatabase(exec)` (exec built from the client's `raw` tagged
// template) and assert the SchemaMetadata shape, then prove a generated-style
// workflow (introspect → open a fresh client on the introspected metadata →
// query) round-trips.
// ---------------------------------------------------------------------------

/** A `widget` table exercising every read-mapped PowQL type + a doc index (invisible to describe). */
const wSchema: SchemaMetadata = {
  enums: {},
  tables: {
    widget: {
      ...makeTable(
        'widget',
        [
          col('id', 'id', 'string', 'text', { hasDefault: true }),
          col('label', 'label', 'string', 'text', { nullable: true }),
          col('qty', 'qty', 'number', 'int4', { nullable: true }),
          col('score', 'score', 'number', 'float8', { nullable: true }),
          col('active', 'active', 'boolean', 'bool', { nullable: true }),
          col('data', 'data', 'Record<string, unknown>', 'jsonb', { nullable: true }),
        ],
        {},
      ),
      // A secondary unique column (beyond the PK) + an invisible doc-field index.
      uniqueColumns: [['id'], ['label']],
      indexes: [{ name: 'widget_data_k_idx', columns: ['data'], unique: false, definition: '', docPath: ['k'] }],
    },
  },
};

describe('powdb integration (embedded): describe-based introspection', () => {
  it('introspects columns/types/nullability/PK-heuristic/unique and hides expression indexes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'powdb-introspect-it-'));
    const db: DB = await turbinePowDB({ embedded: dir }, wSchema, { warnOnUnlimited: false });
    try {
      for (const stmt of powqlSchemaDDL(wSchema)) await db.raw([stmt]);

      const exec = async (powql: string) => ({ rows: await db.raw([powql]) });
      const meta = await introspectPowdbDatabase(exec);

      const widget = meta.tables.widget!;
      assert.ok(widget, 'widget table introspected');
      assert.deepEqual(widget.allColumns, ['id', 'label', 'qty', 'score', 'active', 'data']);

      const byName = Object.fromEntries(widget.columns.map((c) => [c.name, c]));
      // PK column: non-nullable, str.
      assert.equal(byName.id!.nullable, false);
      assert.equal(byName.id!.tsType, 'string');
      // Nullable columns carry the ` | null` suffix (introspection convention).
      assert.equal(byName.label!.tsType, 'string | null');
      assert.equal(byName.qty!.nullable, true);
      assert.equal(byName.qty!.tsType, 'number | null');
      assert.equal(byName.qty!.dialectType, 'int');
      assert.equal(byName.score!.dialectType, 'float');
      assert.equal(byName.active!.tsType, 'boolean | null');
      // json column maps to unknown + dialectType json (so isJsonColumn classifies it).
      assert.equal(byName.data!.tsType, 'unknown | null');
      assert.equal(byName.data!.dialectType, 'json');

      // PK heuristic: first non-nullable unique column, preferring `id`.
      assert.deepEqual(widget.primaryKey, ['id']);
      // Every `unique` column is a singleton unique set (id + label).
      assert.deepEqual(widget.uniqueColumns.map((u) => u[0]).sort(), ['id', 'label']);
      // Relations are always empty (PowDB has no declared FKs).
      assert.deepEqual(widget.relations, {});
      // The doc-field expression index is invisible to `describe` → absent.
      assert.ok(!widget.indexes.some((i) => i.docPath), 'expression indexes do not round-trip');
      // The two column-level unique indexes (id, label) DO appear.
      assert.deepEqual(
        widget.indexes
          .filter((i) => i.unique)
          .map((i) => i.columns[0])
          .sort(),
        ['id', 'label'],
      );
    } finally {
      await db.disconnect();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('generated-style workflow: introspect one db, then drive a fresh db from ONLY the introspected metadata', async () => {
    // The embedded addon keeps a data dir open until GC (no explicit close), so
    // reopening the SAME dir in one process is unreliable. Instead this proves
    // the full generated-style loop: introspect db1 → the introspected metadata
    // provisions (powqlSchemaDDL) and drives CRUD on a fresh db2 in its own dir.
    const dir1 = mkdtempSync(join(tmpdir(), 'powdb-introspect-src-'));
    const dir2 = mkdtempSync(join(tmpdir(), 'powdb-introspect-gen-'));
    const db1: DB = await turbinePowDB({ embedded: dir1 }, wSchema, { warnOnUnlimited: false });
    let meta: SchemaMetadata;
    try {
      for (const stmt of powqlSchemaDDL(wSchema)) await db1.raw([stmt]);
      // Introspect the live database into fresh metadata (no rows needed; the
      // catalog shape is what drives the generated client).
      meta = await introspectPowdbDatabase(async (q: string) => ({ rows: await db1.raw([q]) }));
    } finally {
      await db1.disconnect();
    }

    // Drive a brand-new database from ONLY the introspected metadata.
    const db2: DB = await turbinePowDB({ embedded: dir2 }, meta, { warnOnUnlimited: false });
    try {
      // 1) The introspected metadata provisions the schema (json column + PK).
      for (const stmt of powqlSchemaDDL(meta)) await db2.raw([stmt]);
      // 2) Seed via raw PowQL (the ORM-level json write path lands with F1); the
      //    json column rides in a PowdbJsonParam the embedded pool materializes.
      await db2.raw(
        [
          'insert widget { id := ',
          ', label := ',
          ', qty := ',
          ', score := ',
          ', active := ',
          ', data := ',
          ' } returning',
        ],
        'w1',
        'Ada',
        5,
        1.5,
        true,
        new PowdbJsonParam({ k: 1 }),
      );
      // 3) Query through the TurbineClient built on the introspected metadata.
      const rows = await db2.table('widget').findMany({ where: { id: 'w1' } });
      assert.equal(rows.length, 1);
      const row = rows[0]!;
      assert.equal(row.id, 'w1');
      assert.equal(row.label, 'Ada');
      assert.equal(row.qty, 5);
      assert.equal(row.score, 1.5);
      assert.equal(row.active, true);
      assert.deepEqual(row.data, { k: 1 }); // json read-coercion via introspected dialectType
      // findUnique by the heuristic PK works (proves primaryKey: ['id'] resolved).
      const one = await db2.table('widget').findUnique({ where: { id: 'w1' } });
      assert.equal(one.label, 'Ada');
    } finally {
      await db2.disconnect();
      rmSync(dir1, { recursive: true, force: true });
      rmSync(dir2, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Networked live server (opt-in). Proves param-in-segment JSON filters over the
// real binary TCP transport (design V1). Skip-gated on POWDB_URL so CI, which
// has no server, never runs it. Run locally with:
//   POWDB_URL=powdb://127.0.0.1:5599 npx tsx --test src/test/powdb.integration.test.ts
// ---------------------------------------------------------------------------

const powdbUrl = process.env.POWDB_URL;
const { it: liveIt } = skipGate(!powdbUrl, 'set POWDB_URL to run the live networked PowDB suite');

describe('powdb integration (networked): F1 param-in-segment JSON filters over TCP', () => {
  liveIt('binds `.data->$1->$2 = $3` path segments as params on a live server', async () => {
    const db: DB = await turbinePowDB(powdbUrl!, jsonSchema, { warnOnUnlimited: false });
    const suffix = Date.now().toString(36);
    const t = `jdoc_${suffix}`;
    const liveSchema: SchemaMetadata = {
      enums: {},
      tables: {
        [t]: makeTable(t, [
          col('id', 'id', 'string', 'text', { hasDefault: true }),
          col('data', 'data', 'Record<string, unknown>', 'jsonb', { nullable: true }),
        ]),
      },
    };
    const liveDb: DB = await turbinePowDB(powdbUrl!, liveSchema, { warnOnUnlimited: false });
    try {
      for (const stmt of powqlSchemaDDL(liveSchema)) await liveDb.raw([stmt]);
      await liveDb.table(t).create({ data: { id: 'a', data: { ns: { value: 7 } } } });
      await liveDb.table(t).create({ data: { id: 'b', data: { ns: { value: 9 } } } });
      const hit = await liveDb.table(t).findMany({ where: { data: { path: ['ns', 'value'], equals: 7 } } });
      assert.deepEqual(
        hit.map((r: { id: string }) => r.id),
        ['a'],
      );
      const miss = await liveDb.table(t).findMany({ where: { data: { path: ['ns', 'value'], equals: 8 } } });
      assert.deepEqual(miss, []);
      const ordered = await liveDb
        .table(t)
        .findMany({ orderBy: { data: { path: ['ns', 'value'], direction: 'desc' } } });
      assert.deepEqual(
        ordered.map((r: { id: string }) => r.id),
        ['b', 'a'],
      );
    } finally {
      await liveDb.raw([`drop ${t}`]).catch(() => {});
      await liveDb.disconnect();
      await db.disconnect();
    }
  });
});
