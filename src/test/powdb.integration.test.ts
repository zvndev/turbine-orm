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
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe } from 'node:test';
import {
  ConnectionError,
  NotNullViolationError,
  ReadOnlyError,
  TimeoutError,
  UniqueConstraintError,
  UnsupportedFeatureError,
  ValidationError,
} from '../errors.js';
import {
  capabilitiesFromVersion,
  introspectPowdbDatabase,
  PowdbJsonParam,
  parsePowdbUrl,
  powqlSchemaDDL,
  turbinePowDB,
} from '../powdb.js';
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
      // Even on the native typed wire (addon >= 0.14) these read the same JS
      // null: an absent value decodes from an `empty` cell, and a whole
      // JSON-null document decodes from a `json` cell whose value is JSON null,
      // Turbine's json decode maps both to JS null. (The raw cells DIFFER on the
      // native wire; the residual is at Turbine's JS value surface, not the
      // wire, and matches PowDB's scalarized-null contract.)
      assert.equal(byId.absent, null);
      assert.equal(byId.jsonnull, null);
    });
  });

  it('FIXED WART (native >= 0.14): a nullable str holding "null" reads back as the STRING "null", distinct from SQL NULL', async () => {
    await withDocDb(async (db) => {
      await insertDoc(db, 's1', new PowdbJsonParam({}), 'null'); // s = the string "null"
      await insertDoc(db, 's2', new PowdbJsonParam({}), null); // s = SQL null
      const rows = await db.table('doc').findMany({ orderBy: { id: 'asc' } });
      const byId = Object.fromEntries(rows.map((r: { id: string; s: unknown }) => [r.id, r.s]));
      // The legacy string wire collapsed both to null (the coerceValue wart);
      // the native typed wire (F1) keeps the literal string "null" a string and
      // an absent value null, so the two are distinguishable, matching the
      // networked native transport.
      assert.equal(byId.s1, 'null');
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

/** True when `version` (dotted, e.g. "0.18.1") is >= the `[major, minor, patch]` target. */
function serverAtLeast(version: string, [tMaj, tMin, tPatch]: [number, number, number]): boolean {
  const parts = version.split('.').map((n) => Number.parseInt(n, 10));
  const maj = parts[0] ?? 0;
  const min = parts[1] ?? 0;
  const patch = parts[2] ?? 0;
  if (maj !== tMaj) return maj > tMaj;
  if (min !== tMin) return min > tMin;
  return patch >= tPatch;
}

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

// ---------------------------------------------------------------------------
// Networked F2/F3: the design's dual-transport assertions run over the real
// native typed wire (nativeRaw auto-enabled for a >= 0.13 server). These are
// the tests whose absence let the BigInt-group-key defect ship; they prove
// group-key / coercion parity between the native wire and the legacy/embedded
// shapes, and that no native cell (bigint / raw micros) leaks into a result.
// ---------------------------------------------------------------------------

describe('powdb integration (networked): F2/F3 native-wire shapes', () => {
  /** Build a fresh live table (id/n/s/data) with a unique name, run `fn`, drop it. */
  async function withLive(cols: ColumnMetadata[], fn: (db: DB, t: string) => Promise<void>): Promise<void> {
    const t = `jnet_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e4)}`;
    const liveSchema: SchemaMetadata = { enums: {}, tables: { [t]: makeTable(t, cols) } };
    const db: DB = await turbinePowDB(powdbUrl!, liveSchema, { warnOnUnlimited: false });
    try {
      await db.raw([`drop ${t}`]).catch(() => {});
      for (const stmt of powqlSchemaDDL(liveSchema)) await db.raw([stmt]);
      await fn(db, t);
    } finally {
      await db.raw([`drop ${t}`]).catch(() => {});
      await db.disconnect();
    }
  }

  liveIt('groupBy JSON key over the native wire returns PG-text-parity STRING keys (no bigint leak)', async () => {
    await withLive(
      [
        col('id', 'id', 'string', 'text', { hasDefault: true }),
        col('data', 'data', 'Record<string, unknown>', 'jsonb', { nullable: true }),
      ],
      async (db, t) => {
        await db.table(t).create({ data: { id: 'a', data: { k: 7 } } });
        await db.table(t).create({ data: { id: 'b', data: { k: 7 } } });
        await db.table(t).create({ data: { id: 'c', data: { k: 9 } } });
        const groups = await db.table(t).groupBy({ by: [{ field: 'data', path: ['k'] }], _count: true });
        const byKey = new Map(groups.map((g: { k: unknown; _count: number }) => [g.k, g._count]));
        // Native wire: keys come back as the extracted TEXT '7'/'9' (parity with
        // embedded / PG #>>), NOT bigint 7n/9n.
        assert.equal(byKey.get('7'), 2);
        assert.equal(byKey.get('9'), 1);
        assert.ok(
          [...byKey.keys()].every((k) => typeof k === 'string'),
          'group keys are strings, not bigint',
        );
        // The common serialize-to-HTTP path must not throw on a native result.
        assert.doesNotThrow(() => JSON.stringify(groups));
      },
    );
  });

  liveIt('groupBy by a plain int column over native wire: bigint→number and _count default-selected', async () => {
    await withLive(
      [col('id', 'id', 'string', 'text', { hasDefault: true }), col('n', 'n', 'number', 'int4', { nullable: true })],
      async (db, t) => {
        await db.table(t).create({ data: { id: 'a', n: 1 } });
        await db.table(t).create({ data: { id: 'b', n: 1 } });
        await db.table(t).create({ data: { id: 'c', n: 2 } });
        // No explicit _count; SQL parity means it is still selected.
        const groups = await db.table(t).groupBy({ by: ['n'] });
        assert.ok(
          groups.every((g: { n: unknown }) => typeof g.n === 'number'),
          'int group key is a number, not bigint',
        );
        assert.ok(
          groups.every((g: { _count: unknown }) => typeof g._count === 'number'),
          '_count default-selected',
        );
        const byN = new Map(groups.map((g: { n: number; _count: number }) => [g.n, g._count]));
        assert.equal(byN.get(1), 2);
        assert.equal(byN.get(2), 1);
        assert.doesNotThrow(() => JSON.stringify(groups));
      },
    );
  });

  liveIt('a digit-string json path segment matches an ARRAY element on the live server', async () => {
    await withLive(
      [
        col('id', 'id', 'string', 'text', { hasDefault: true }),
        col('data', 'data', 'Record<string, unknown>', 'jsonb', { nullable: true }),
      ],
      async (db, t) => {
        await db.table(t).create({ data: { id: 'a', data: { tags: ['x', 'y'] } } });
        const hit = await db.table(t).findMany({ where: { data: { path: ['tags', '0'], equals: 'x' } } });
        assert.deepEqual(
          hit.map((r: { id: string }) => r.id),
          ['a'],
        );
      },
    );
  });

  liveIt(
    'native wire preserves a genuine str "null" (no legacy collapse) and str-null distinct from SQL NULL',
    async () => {
      await withLive(
        [col('id', 'id', 'string', 'text', { hasDefault: true }), col('s', 's', 'string', 'text', { nullable: true })],
        async (db, t) => {
          await db.table(t).create({ data: { id: 'lit', s: 'null' } }); // the STRING "null"
          await db.table(t).create({ data: { id: 'nul', s: null } }); // SQL NULL
          const lit = await db.table(t).findUnique({ where: { id: 'lit' } });
          const nul = await db.table(t).findUnique({ where: { id: 'nul' } });
          assert.equal(lit.s, 'null'); // native wire keeps the literal string
          assert.equal(nul.s, null); // absent stays null, distinguishable
        },
      );
    },
  );

  liveIt('introspectPowdbDatabase reads the live server real tables (documented networked flow)', async () => {
    await withLive(
      [
        col('id', 'id', 'string', 'text', { hasDefault: true }),
        col('label', 'label', 'string', 'text', { nullable: true }),
      ],
      async (db, t) => {
        const exec = async (q: string) => ({ rows: await db.raw([q]) });
        const meta = await introspectPowdbDatabase(exec, { include: [t] });
        assert.deepEqual(Object.keys(meta.tables), [t]);
        assert.ok(meta.tables[t]!.columns.some((c) => c.name === 'label'));
      },
    );
  });

  liveIt('a datetime-correlated hasMany join deep-equals the loader over the native wire', async () => {
    const suffix = `${Date.now().toString(36)}_${Math.floor(Math.random() * 1e4)}`;
    const sName = `jslot_${suffix}`;
    const eName = `jsevt_${suffix}`;
    const slot = makeTable(
      sName,
      [
        col('id', 'id', 'number', 'int8', { isGenerated: true, hasDefault: true }),
        col('at', 'at', 'Date', 'timestamptz'),
      ],
      {
        events: { type: 'hasMany', name: 'events', from: sName, to: eName, foreignKey: 'slot_at', referenceKey: 'at' },
      },
    );
    // Mark the datetime correlation column unique so the native join activates.
    slot.uniqueColumns = [['id'], ['at']];
    const dtSchema: SchemaMetadata = {
      enums: {},
      tables: {
        [sName]: slot,
        [eName]: makeTable(eName, [
          col('id', 'id', 'number', 'int8', { isGenerated: true, hasDefault: true }),
          col('slot_at', 'slotAt', 'Date', 'timestamptz'),
          col('label', 'label', 'string', 'text'),
        ]),
      },
    };
    const db: DB = await turbinePowDB(powdbUrl!, dtSchema, { warnOnUnlimited: false });
    try {
      await db.raw([`drop ${sName}`]).catch(() => {});
      await db.raw([`drop ${eName}`]).catch(() => {});
      for (const stmt of powqlSchemaDDL(dtSchema)) await db.raw([stmt]);
      const s0 = await db.table(sName).create({ data: { at: new Date('2024-01-01T00:00:00.000Z') } });
      const s1 = await db.table(sName).create({ data: { at: new Date('2024-06-15T12:30:00.000Z') } });
      await db.table(eName).createMany({
        data: [
          { slotAt: s0.at, label: 'a' },
          { slotAt: s0.at, label: 'b' },
          { slotAt: s1.at, label: 'c' },
        ],
      });
      const base = { orderBy: { id: 'asc' as const }, with: { events: true } };
      const viaJoin = await db.table(sName).findMany({ ...base, relationLoadStrategy: 'join' });
      const viaLoader = await db.table(sName).findMany({ ...base });
      assert.deepEqual(viaJoin, viaLoader);
      assert.equal(viaJoin[0].events.length, 2);
      assert.equal(viaJoin[1].events.length, 1);
    } finally {
      await db.raw([`drop ${sName}`]).catch(() => {});
      await db.raw([`drop ${eName}`]).catch(() => {});
      await db.disconnect();
    }
  });

  // A networked unique violation now arrives with the typed wire error class 8
  // (constraint_violation) on the raw driver error. wrapPowdbError maps it to
  // UniqueConstraintError (E008) via the message family first, so the class byte
  // is asserted on the preserved `.cause` — this locks the 0.18.1 upstream fix
  // (storage-raised unique violations surface class 8, not class 0/internal).
  // The class byte is a server >= 0.18.1 feature, so this soft-skips against an
  // older server pointed at by POWDB_URL (the E008 mapping itself holds via the
  // message family on every server version — see the embedded error-mapping test).
  liveIt(
    'a networked unique violation carries wireErrorClass 8 and maps to UniqueConstraintError (E008)',
    async (tc) => {
      const { Client } = (await import('@zvndev/powdb-client')) as {
        Client: { connect(o: unknown): Promise<{ serverVersion: string; close(): Promise<void> }> };
      };
      const probe = await Client.connect(parsePowdbUrl(powdbUrl!));
      const serverVersion = probe.serverVersion;
      await probe.close();
      if (!serverAtLeast(serverVersion, [0, 18, 1])) {
        tc.skip(`requires PowDB server >= 0.18.1 for wireErrorClass 8 (saw ${serverVersion})`);
        return;
      }
      await withLive([col('id', 'id', 'string', 'text', { hasDefault: true })], async (db, t) => {
        await db.table(t).create({ data: { id: 'dup' } });
        let caught: unknown;
        try {
          await db.table(t).create({ data: { id: 'dup' } });
        } catch (err) {
          caught = err;
        }
        assert.ok(caught !== undefined, 'duplicate primary key should have thrown');
        assert.ok(caught instanceof UniqueConstraintError, `expected E008, got: ${caught}`);
        assert.equal((caught as { code?: string }).code, 'TURBINE_E008');
        const cause = (caught as { cause?: { wireErrorClass?: unknown } }).cause;
        assert.equal(
          cause?.wireErrorClass,
          8,
          `expected the raw cause to carry wireErrorClass 8, saw: ${JSON.stringify(cause?.wireErrorClass)}`,
        );
      });
    },
  );

  // Null-semantics parity over the networked transport (mirror of the embedded
  // block). The `not` -> `!=` and `notIn` -> `not in (...) and is not null`
  // spellings must exclude a missing-value row on the real server too. Soft-skips
  // below server 0.18.2, the version where PowQL `!=` began excluding missing rows.
  liveIt('null-semantics parity: not / notIn / gt exclude a missing-value row over TCP', async (tc) => {
    const { Client } = (await import('@zvndev/powdb-client')) as {
      Client: { connect(o: unknown): Promise<{ serverVersion: string; close(): Promise<void> }> };
    };
    const probe = await Client.connect(parsePowdbUrl(powdbUrl!));
    const serverVersion = probe.serverVersion;
    await probe.close();
    if (!serverAtLeast(serverVersion, [0, 18, 2])) {
      tc.skip(`requires PowDB server >= 0.18.2 for != missing-value exclusion (saw ${serverVersion})`);
      return;
    }
    await withLive(
      [
        col('id', 'id', 'number', 'int4'),
        col('total', 'total', 'number', 'float8'),
        col('label', 'label', 'string', 'text', { nullable: true }),
      ],
      async (db, t) => {
        await db.table(t).create({ data: { id: 1, total: 5, label: 'a' } });
        await db.table(t).create({ data: { id: 2, total: 15, label: 'b' } });
        // Row 3 omits label (a missing value; SQL-NULL-equivalent).
        await db.raw([`insert ${t} { id := 3, total := 25 }`]);
        const ids = (rows: { id: number }[]) => rows.map((r) => Number(r.id)).sort((a, b) => a - b);
        assert.deepEqual(ids(await db.table(t).findMany({ where: { label: { not: 'a' } } })), [2]);
        assert.deepEqual(ids(await db.table(t).findMany({ where: { label: { notIn: ['a'] } } })), [2]);
        assert.deepEqual(ids(await db.table(t).findMany({ where: { label: { notIn: [] } } })), [1, 2, 3]);
        assert.deepEqual(ids(await db.table(t).findMany({ where: { total: { gt: 10 } } })), [2, 3]);
      },
    );
  });
});

// ---------------------------------------------------------------------------
// F1: embedded native typed transport (addon >= 0.14). With the pinned 0.14
// addon the embedded pool auto-routes through queryWithParams (nativeRaw on),
// so a full create/findMany round-trip must go over the native path, a genuine
// str "null" survives as a string (distinct from SQL NULL), and groupBy keys
// keep PG-text parity, mirroring the networked native-wire block above.
// ---------------------------------------------------------------------------

/** A table exercising every native cell type (str / int / float / bool / json / a nullable str). */
const nativeSchema: SchemaMetadata = {
  enums: {},
  tables: {
    app_user: makeTable('app_user', [
      col('id', 'id', 'string', 'text', { hasDefault: true }),
      col('name', 'name', 'string', 'text', { nullable: true }),
      col('age', 'age', 'number', 'int4', { nullable: true }),
      col('score', 'score', 'number', 'float8', { nullable: true }),
      col('active', 'active', 'boolean', 'bool', { nullable: true }),
      col('s', 's', 'string', 'text', { nullable: true }),
      col('data', 'data', 'Record<string, unknown>', 'jsonb', { nullable: true }),
    ]),
  },
};

async function withNativeDb(fn: (db: DB) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'powdb-native-it-'));
  const db: DB = await turbinePowDB({ embedded: dir }, nativeSchema, { warnOnUnlimited: false });
  try {
    await db.raw(['drop app_user']).catch(() => {});
    for (const stmt of powqlSchemaDDL(nativeSchema)) await db.raw([stmt]);
    await fn(db);
  } finally {
    await db.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('powdb integration (embedded): F1 native typed transport', () => {
  it('a create/findMany round-trip goes over the native path, typed values survive intact', async () => {
    await withNativeDb(async (db) => {
      const when = new Date('2026-01-02T03:04:05.000Z');
      await db.table('app_user').create({
        data: { id: 'u1', name: 'Ada', age: 30, score: 9.5, active: true, s: 'hello', data: { k: 1 } },
      });
      const [row] = await db.table('app_user').findMany({ where: { id: 'u1' } });
      // Typed cells arrive pre-typed and coerce by column: int→number,
      // float→number, bool→boolean, json→object.
      assert.equal(row.name, 'Ada');
      assert.equal(row.age, 30);
      assert.equal(typeof row.age, 'number');
      assert.equal(row.score, 9.5);
      assert.equal(row.active, true);
      assert.deepEqual(row.data, { k: 1 });
      // A JSON.stringify of the result must not throw (no bigint leak).
      assert.doesNotThrow(() => JSON.stringify(row));
      // Reference `when` so the fixture stays honest about a Date column shape.
      assert.ok(when instanceof Date);
    });
  });

  it('a genuine str "null" survives as the STRING "null", distinct from SQL NULL (native fix)', async () => {
    await withNativeDb(async (db) => {
      await db.table('app_user').create({ data: { id: 'lit', s: 'null' } }); // the STRING "null"
      await db.table('app_user').create({ data: { id: 'nul', s: null } }); // SQL NULL
      const lit = await db.table('app_user').findUnique({ where: { id: 'lit' } });
      const nul = await db.table('app_user').findUnique({ where: { id: 'nul' } });
      assert.equal(lit.s, 'null'); // native wire keeps the literal string
      assert.equal(nul.s, null); // absent stays null, distinguishable
    });
  });

  it('a JSON-null document stays distinct from an ABSENT json cell in the SAME column at the doc level', async () => {
    await withNativeDb(async (db) => {
      await db.table('app_user').create({ data: { id: 'jn', data: { a: null } } });
      await db.table('app_user').create({ data: { id: 'jm', data: {} } });
      await db.table('app_user').create({ data: { id: 'js', data: { a: 'null' } } });
      const rows = await db.table('app_user').findMany({ where: { id: { in: ['jn', 'jm', 'js'] } } });
      // {a:null} vs {} vs {a:"null"} are three DISTINCT documents on the native wire.
      const byId = Object.fromEntries(rows.map((r: { id: string; data: unknown }) => [r.id, r.data]));
      assert.deepEqual(byId.jn, { a: null });
      assert.deepEqual(byId.jm, {});
      assert.deepEqual(byId.js, { a: 'null' });
    });
  });

  it('groupBy keys keep PG-text parity on the native wire (no bigint / raw-micros leak)', async () => {
    await withNativeDb(async (db) => {
      await db.table('app_user').create({ data: { id: 'a', age: 1 } });
      await db.table('app_user').create({ data: { id: 'b', age: 1 } });
      await db.table('app_user').create({ data: { id: 'c', age: 2 } });
      // Plain int group key: bigint→number, _count default-selected.
      const groups = await db.table('app_user').groupBy({ by: ['age'] });
      assert.ok(
        groups.every((g: { age: unknown }) => typeof g.age === 'number'),
        'int group key is a number, not bigint',
      );
      const byAge = new Map(groups.map((g: { age: number; _count: number }) => [g.age, g._count]));
      assert.equal(byAge.get(1), 2);
      assert.equal(byAge.get(2), 1);
      assert.doesNotThrow(() => JSON.stringify(groups));

      // JSON group key comes back as the extracted TEXT, matching the networked
      // native transport and PG's #>> parity.
      await db.table('app_user').create({ data: { id: 'd', data: { k: 7 } } });
      await db.table('app_user').create({ data: { id: 'e', data: { k: 7 } } });
      const jgroups = await db.table('app_user').groupBy({ by: [{ field: 'data', path: ['k'] }], _count: true });
      const jByKey = new Map(jgroups.map((g: { k: unknown; _count: number }) => [g.k, g._count]));
      assert.equal(jByKey.get('7'), 2);
    });
  });
});

// ---------------------------------------------------------------------------
// F3: read-only awareness (embedded openReadOnly). Seed a directory writable,
// close it (flushing the WAL), reopen it read-only for snapshot serving: reads
// work, writes are refused and map to ReadOnlyError (E018), both the ORM
// create() path and a raw injected write that bypasses any client-side guard.
// ---------------------------------------------------------------------------

describe('powdb integration (embedded): F3 read-only target', () => {
  it('opens a directory read-only: reads work, writes map to ReadOnlyError (E018)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'powdb-ro-it-'));
    try {
      // 1) Seed the directory with a writable handle, then close it so the WAL
      //    is flushed (openReadOnly refuses a directory with a non-empty WAL).
      const writable: DB = await turbinePowDB({ embedded: dir }, nativeSchema, { warnOnUnlimited: false });
      for (const stmt of powqlSchemaDDL(nativeSchema)) await writable.raw([stmt]);
      await writable.table('app_user').create({ data: { id: 'u1', name: 'Ada', age: 30 } });
      await writable.disconnect();

      // 2) Reopen the SAME directory read-only for snapshot serving.
      const ro: DB = await turbinePowDB({ embedded: dir, readonly: true }, nativeSchema, { warnOnUnlimited: false });
      try {
        // Reads work over the read-only handle.
        const rows = await ro.table('app_user').findMany({ where: { id: 'u1' } });
        assert.equal(rows.length, 1);
        assert.equal(rows[0].name, 'Ada');

        // A create is refused and maps to ReadOnlyError (E018). (The client-side
        // fail-fast guard lives in the PowQL exec seam; whether it short-circuits
        // locally or the engine refuses, the caller sees the same typed E018.)
        await assert.rejects(
          () => ro.table('app_user').create({ data: { id: 'u2', name: 'Bob' } }),
          (err: Error & { code?: string }) => err instanceof ReadOnlyError && err.code === 'TURBINE_E018',
        );

        // A raw injected write bypasses any client-side classification and hits
        // the engine directly, its refusal still maps to ReadOnlyError (E018).
        await assert.rejects(
          () => ro.raw(['insert app_user { id := "u3", name := "Cy" } returning']),
          (err: Error & { code?: string }) => err instanceof ReadOnlyError && err.code === 'TURBINE_E018',
        );

        // The directory is unchanged, the refused writes touched nothing.
        const after = await ro.table('app_user').findMany({});
        assert.equal(after.length, 1);
      } finally {
        await ro.disconnect();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// PowDB 0.16: NUL-safe non-unique string index keys. The engine's composite
// index keys previously NUL-terminated string values, so "A" and "A\u0000" could
// interleave: indexed equality / prefix lookups / index-driven mutations could
// return or touch a neighboring value's rows. 0.16 escape-encodes the keys
// (index format v3). This locks the fix in through the ORM surface: an
// indexed column with embedded NUL bytes must behave exactly like an
// unindexed one.
// ---------------------------------------------------------------------------

const nulIdxSchema: SchemaMetadata = {
  enums: {},
  tables: {
    tagged: {
      ...makeTable(
        'tagged',
        [
          col('id', 'id', 'string', 'text', { hasDefault: true }),
          col('tag', 'tag', 'string', 'text'),
          col('n', 'n', 'number', 'int4'),
        ],
        {},
      ),
      indexes: [{ name: 'tagged_tag_idx', columns: ['tag'], unique: false, definition: '' }],
    },
  },
};

describe('powdb integration (embedded): NUL bytes in non-unique indexed strings (0.16)', () => {
  it('indexed equality, prefix, and index-driven update stay exact around embedded NULs', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'powdb-nul-it-'));
    const db: DB = await turbinePowDB({ embedded: dir }, nulIdxSchema, { warnOnUnlimited: false });
    try {
      for (const stmt of powqlSchemaDDL(nulIdxSchema)) await db.raw([stmt]);

      const tags = ['A', 'A\u0000', 'A\u0000B', 'B'];
      for (const [i, tag] of tags.entries()) await db.tagged.create({ data: { tag, n: i } });

      // Indexed equality returns EXACTLY the matching row for every neighbor.
      for (const [i, tag] of tags.entries()) {
        const rows = (await db.tagged.findMany({ where: { tag } })) as { tag: string; n: number }[];
        assert.equal(rows.length, 1, `equality on ${JSON.stringify(tag)} must match exactly one row`);
        assert.equal(rows[0]!.n, i);
        assert.equal(rows[0]!.tag, tag, 'the NUL bytes round-trip losslessly');
      }

      // Prefix lookup: every A-prefixed tag, nothing else.
      const prefixed = (await db.tagged.findMany({
        where: { tag: { startsWith: 'A' } },
        orderBy: { n: 'asc' },
      })) as { n: number }[];
      assert.deepEqual(
        prefixed.map((r) => r.n),
        [0, 1, 2],
      );

      // Index-driven mutation touches ONLY the addressed value's row.
      await db.tagged.updateMany({ where: { tag: 'A\u0000' }, data: { n: 100 } });
      const after = (await db.tagged.findMany({ orderBy: { n: 'asc' } })) as { tag: string; n: number }[];
      assert.deepEqual(
        after.map((r) => [r.tag, r.n]),
        [
          ['A', 0],
          ['A\u0000B', 2],
          ['B', 3],
          ['A\u0000', 100],
        ],
      );
    } finally {
      await db.disconnect();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Nested projections (shaped results, PowDB >= 0.18) — live through the addon.
// Gated separately: CI on a 0.17 addon skips these cleanly (the capability is
// version-derived), a >= 0.18 addon runs them against the real engine.
// ---------------------------------------------------------------------------

let embeddedNestedProjections = false;
try {
  const req = createRequire(import.meta.url);
  const pkg = JSON.parse(readFileSync(req.resolve('@zvndev/powdb-embedded/package.json'), 'utf8')) as {
    version?: string;
  };
  embeddedNestedProjections = embeddedAvailable && capabilitiesFromVersion(pkg.version).nestedProjections;
} catch {
  embeddedNestedProjections = false;
}
const { it: nestedIt } = skipGate(
  !embeddedNestedProjections,
  'requires @zvndev/powdb-embedded >= 0.18 (nested projections)',
);

const nestedSchema: SchemaMetadata = {
  enums: {},
  tables: {
    n_user: makeTable(
      'n_user',
      [
        col('id', 'id', 'string', 'text', { hasDefault: true }),
        col('name', 'name', 'string', 'text'),
        col('joined_at', 'joinedAt', 'Date', 'timestamptz', { nullable: true }),
      ],
      {
        posts: {
          type: 'hasMany',
          name: 'posts',
          from: 'n_user',
          to: 'n_post',
          foreignKey: 'author_id',
          referenceKey: 'id',
        },
        profile: {
          type: 'hasOne',
          name: 'profile',
          from: 'n_user',
          to: 'n_profile',
          foreignKey: 'user_id',
          referenceKey: 'id',
        },
      },
    ),
    n_post: makeTable(
      'n_post',
      [
        col('id', 'id', 'string', 'text', { hasDefault: true }),
        col('author_id', 'authorId', 'string', 'text'),
        col('title', 'title', 'string', 'text'),
        col('views', 'views', 'number', 'int4', { nullable: true }),
        col('draft_notes', 'draftNotes', 'string', 'text', { nullable: true, pii: true }),
      ],
      {
        author: {
          type: 'belongsTo',
          name: 'author',
          from: 'n_post',
          to: 'n_user',
          foreignKey: 'author_id',
          referenceKey: 'id',
        },
      },
    ),
    n_profile: makeTable('n_profile', [
      col('id', 'id', 'string', 'text', { hasDefault: true }),
      col('user_id', 'userId', 'string', 'text'),
      col('bio', 'bio', 'string', 'text', { nullable: true }),
    ]),
  },
};

async function withNestedDb(fn: (db: DB, sqls: string[]) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'powdb-nested-it-'));
  const db: DB = await turbinePowDB({ embedded: dir }, nestedSchema, { warnOnUnlimited: false });
  const sqls: string[] = [];
  db.$on('query', (e: { sql: string }) => sqls.push(e.sql));
  try {
    for (const stmt of powqlSchemaDDL(nestedSchema)) await db.raw([stmt]);
    // Ada: three posts + a profile; Bob: none of either.
    await db.nUser.create({ data: { id: 'u1', name: 'Ada', joinedAt: new Date('2026-01-02T03:04:05Z') } });
    await db.nUser.create({ data: { id: 'u2', name: 'Bob' } });
    await db.nProfile.create({ data: { id: 'pr1', userId: 'u1', bio: 'pioneer' } });
    await db.nPost.create({ data: { id: 'p1', authorId: 'u1', title: 'Alpha', views: 5, draftNotes: 'secret-a' } });
    await db.nPost.create({ data: { id: 'p2', authorId: 'u1', title: 'Beta', views: 50, draftNotes: 'secret-b' } });
    await db.nPost.create({ data: { id: 'p3', authorId: 'u1', title: 'Gamma', views: 20 } });
    sqls.length = 0;
    await fn(db, sqls);
  } finally {
    await db.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('powdb integration (embedded): nested projections (0.18 shaped results)', () => {
  nestedIt('loads an eligible with in ONE statement, per-parent order/limit, childless kept', async () => {
    await withNestedDb(async (db, sqls) => {
      const users = await db.nUser.findMany({
        orderBy: { id: 'asc' },
        with: {
          posts: { where: { views: { gt: 10 } }, orderBy: { views: 'desc' }, limit: 1 },
          profile: true,
        },
      });
      assert.equal(sqls.length, 1, `expected one statement, saw: ${sqls.join(' | ')}`);
      assert.match(sqls[0]!, / as t0/);
      assert.equal(users.length, 2);
      // Ada: top post by views above 10, profile object.
      assert.deepEqual(
        users[0].posts.map((p: { title: string }) => p.title),
        ['Beta'],
      );
      assert.equal(users[0].profile.bio, 'pioneer');
      // Bob: childless keeps [] and null, the row is never dropped.
      assert.deepEqual(users[1].posts, []);
      assert.equal(users[1].profile, null);
    });
  });

  nestedIt('matches the batched loaders exactly (deepEqual, dates included)', async () => {
    await withNestedDb(async (db, sqls) => {
      const args = {
        orderBy: { id: 'asc' },
        with: {
          posts: { orderBy: { views: 'asc' }, with: { author: true } },
          profile: true,
        },
      };
      const nested = await db.nUser.findMany(args);
      assert.equal(sqls.length, 1, 'nested path is a single statement');
      sqls.length = 0;
      const batched = await db.nUser.findMany({ ...args, relationLoadStrategy: 'batched' });
      assert.ok(sqls.length > 1, 'batched path issues loader statements');
      assert.deepEqual(nested, batched);
      // The multi-level author round-trips its Date through the nested JSON.
      assert.ok(nested[0].posts[0].author.joinedAt instanceof Date);
      assert.equal(nested[0].posts[0].author.joinedAt.getTime(), Date.parse('2026-01-02T03:04:05Z'));
    });
  });

  nestedIt('PII-tagged child columns stay out of the nested projection', async () => {
    await withNestedDb(async (db) => {
      const users = await db.nUser.findMany({ where: { id: 'u1' }, with: { posts: { orderBy: { views: 'asc' } } } });
      for (const p of users[0].posts) assert.ok(!('draftNotes' in p), 'pii column excluded by default');
      const revealed = await db.nUser.findMany({
        where: { id: 'u1' },
        with: { posts: { orderBy: { views: 'asc' } } },
        includePii: true,
      });
      assert.equal(revealed[0].posts[0].draftNotes, 'secret-a');
    });
  });

  nestedIt('findUnique + relation select/omit shapes match the loaders', async () => {
    await withNestedDb(async (db, sqls) => {
      const u = await db.nUser.findUnique({
        where: { id: 'u1' },
        with: { posts: { select: { title: true }, orderBy: { title: 'asc' } } },
      });
      assert.equal(sqls.length, 1);
      assert.deepEqual(u.posts, [
        { id: 'p1', title: 'Alpha' },
        { id: 'p2', title: 'Beta' },
        { id: 'p3', title: 'Gamma' },
      ]);
      const viaLoader = await db.nUser.findUnique({
        where: { id: 'u1' },
        with: { posts: { select: { title: true }, orderBy: { title: 'asc' } } },
        relationLoadStrategy: 'batched',
      });
      assert.deepEqual(u.posts, viaLoader.posts);
    });
  });
});

// ---------------------------------------------------------------------------
// Entity links + catalog v7 + null-semantics parity (PowDB >= 0.19), live
// through the embedded addon. Gated separately: CI on a pre-0.19 addon skips
// these cleanly (the capability is version-derived). Turbine does NOT consume
// links for query generation this round, so link DDL/traversal is exercised via
// raw PowQL; the null-parity block runs through the real PowqlInterface.
// ---------------------------------------------------------------------------

let embeddedEntityLinks = false;
try {
  const req = createRequire(import.meta.url);
  const pkg = JSON.parse(readFileSync(req.resolve('@zvndev/powdb-embedded/package.json'), 'utf8')) as {
    version?: string;
  };
  embeddedEntityLinks = embeddedAvailable && capabilitiesFromVersion(pkg.version).entityLinks;
} catch {
  embeddedEntityLinks = false;
}
const { it: linkIt } = skipGate(
  !embeddedEntityLinks,
  'requires @zvndev/powdb-embedded >= 0.19 (entity links / catalog v7)',
);

// l_order.label is nullable so a row can OMIT it (a missing value, PowQL's
// null-equivalent) to probe not / notIn / gt semantics against SQL parity.
const linkSchema: SchemaMetadata = {
  enums: {},
  tables: {
    l_user: makeTable('l_user', [col('id', 'id', 'number', 'int4'), col('name', 'name', 'string', 'text')]),
    l_order: makeTable('l_order', [
      col('id', 'id', 'number', 'int4'),
      col('user_id', 'userId', 'number', 'int4', { nullable: true }),
      col('total', 'total', 'number', 'float8'),
      col('label', 'label', 'string', 'text', { nullable: true }),
    ]),
  },
};

async function withLinkDb(fn: (db: DB) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'powdb-links-it-'));
  const db: DB = await turbinePowDB({ embedded: dir }, linkSchema, { warnOnUnlimited: false });
  try {
    for (const stmt of powqlSchemaDDL(linkSchema)) await db.raw([stmt]);
    // Links are declared via raw PowQL: powqlSchemaDDL deliberately does NOT emit
    // `link` DDL this round (declaring one one-way-upgrades the catalog to v7).
    await db.raw(['link l_order.user -> l_user on user_id = id']);
    await db.raw(['link l_user.orders -> l_order on id = user_id']);
    await fn(db);
  } finally {
    await db.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('powdb integration (embedded): entity links (0.19 catalog v7)', () => {
  linkIt('raw link DDL: scalar hop and to-many block traversal read through the catalog', async () => {
    await withLinkDb(async (db) => {
      await db.lUser.create({ data: { id: 1, name: 'alice' } });
      await db.lOrder.create({ data: { id: 1, userId: 1, total: 9.5, label: 'a' } });
      await db.lOrder.create({ data: { id: 2, userId: 1, total: 20.25, label: 'b' } });
      // A NULL FK order traverses to an empty scalar, never dropping the row.
      await db.raw(['insert l_order { id := 3, total := 1.0 }']);

      // Scalar to-one hop: `o.user.name` (aliased form; the published 0.19.0 bare
      // dotted-path is buggy, so turbine's future adoption would alias-qualify too).
      const scalar = (await db.raw(['l_order as o { o.id, o.user.name } order o.id asc'])) as Record<string, unknown>[];
      assert.equal(scalar.length, 3, 'null / dangling FK rows are not dropped by the hop');
      assert.equal(Number(scalar[0]!['o.id']), 1);
      assert.equal(scalar[0]!['o.user.name'], 'alice');
      assert.equal(scalar[2]!['o.user.name'], null, 'the NULL-FK order hops to an empty target');

      // To-many block traversal: `u.orders { total }` returns a per-parent array.
      const block = (await db.raw(['l_user as u { u.name, orders: u.orders { total } } order u.id asc'])) as Record<
        string,
        unknown
      >[];
      assert.equal(block.length, 1);
      assert.equal(block[0]!.name ?? block[0]!['u.name'], 'alice');
      const orders = block[0]!.orders as { total: number }[];
      assert.deepEqual(
        orders.map((o) => Number(o.total)).sort((a, b) => a - b),
        [9.5, 20.25],
      );
    });
  });

  linkIt('a declared link persists across reopen (catalog v7 is durable)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'powdb-links-reopen-'));
    let db: DB = await turbinePowDB({ embedded: dir }, linkSchema, { warnOnUnlimited: false });
    try {
      for (const stmt of powqlSchemaDDL(linkSchema)) await db.raw([stmt]);
      await db.raw(['link l_order.user -> l_user on user_id = id']);
      await db.lUser.create({ data: { id: 1, name: 'alice' } });
      await db.lOrder.create({ data: { id: 1, userId: 1, total: 9.5, label: 'a' } });
      await db.disconnect();
      // Reopen the SAME data directory: the v7 catalog (and its link) must survive.
      db = await turbinePowDB({ embedded: dir }, linkSchema, { warnOnUnlimited: false });
      const scalar = (await db.raw(['l_order as o { o.id, o.user.name }'])) as Record<string, unknown>[];
      assert.equal(scalar.length, 1);
      assert.equal(scalar[0]!['o.user.name'], 'alice', 'the link survived a reopen without re-declaration');
    } finally {
      await db.disconnect();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  linkIt(
    'null-semantics parity: not / notIn / gt through PowqlInterface match SQL on a missing-value column',
    async () => {
      await withLinkDb(async (db) => {
        await db.lUser.create({ data: { id: 1, name: 'alice' } });
        await db.lOrder.create({ data: { id: 1, userId: 1, total: 5, label: 'a' } });
        await db.lOrder.create({ data: { id: 2, userId: 1, total: 15, label: 'b' } });
        // Row 3 OMITS label entirely (a missing value). SQL treats it as NULL, so it
        // is excluded from `not`, `notIn`, and `gt` results.
        await db.raw(['insert l_order { id := 3, user_id := 1, total := 25 }']);
        const ids = (rows: { id: number }[]) => rows.map((r) => Number(r.id)).sort((a, b) => a - b);

        // not 'a' EXCLUDES the missing-label row (row 3), matching SQL (the whole
        // point of the `!=` re-spelling).
        assert.deepEqual(
          ids(await db.lOrder.findMany({ where: { label: { not: 'a' } } })),
          [2],
          'not excludes the matching row AND the missing-value row',
        );
        // notIn ['a'] likewise excludes the missing-value row (presence guard).
        assert.deepEqual(
          ids(await db.lOrder.findMany({ where: { label: { notIn: ['a'] } } })),
          [2],
          'notIn (non-empty) excludes the missing-value row',
        );
        // notIn [] matches EVERYTHING including the missing-value row (no guard).
        assert.deepEqual(
          ids(await db.lOrder.findMany({ where: { label: { notIn: [] } } })),
          [1, 2, 3],
          'notIn [] keeps the missing-value row (match-everything)',
        );
        // gt on total: a plain numeric filter, missing-value label row is unaffected.
        assert.deepEqual(ids(await db.lOrder.findMany({ where: { total: { gt: 10 } } })), [2, 3]);
      });
    },
  );
});
