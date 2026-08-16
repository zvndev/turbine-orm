/**
 * Turbine ORM interleaved benchmark harness.
 *
 * Why this exists alongside bench.ts:
 *   bench.ts measures each ORM in a contiguous block (all 200 Turbine
 *   iterations, then all 200 Prisma, then all 200 Drizzle). Any drift over the
 *   life of the process (JIT state, page cache, autovacuum, thermal) is
 *   attributed to whichever arm happened to occupy that slice of wall clock.
 *
 *   This harness runs every arm ONCE PER ROUND, rotating the arm order each
 *   round, and reports the MEDIAN across rounds. It also runs a hand-written
 *   raw-SQL control arm in most scenarios, so the residual drift and the ORM
 *   overhead above raw pg can both be quantified.
 *
 * Run:
 *   DATABASE_URL="postgresql:///turbine_bench?host=/tmp" npx tsx bench-interleaved.ts
 *
 * Env:
 *   ROUNDS=200      interleaved rounds per scenario
 *   WARMUP=20       warmup calls per arm per scenario
 *   STREAM_ROUNDS=9 interleaved rounds for the 50K streaming scenario
 *   INCLUDE_RC=1    add a fifth arm, drizzle-orm 1.0.0-rc.4 with its JIT row
 *                   mapper enabled (see below)
 *
 * On INCLUDE_RC, and why it is a switch rather than always on:
 *
 *   Adding an arm is not free for the OTHER arms. Every arm runs once per round,
 *   so a fifth arm puts one more competitor's working set between each arm's
 *   consecutive calls. Measured directly while profiling 0.70.0, the identical
 *   Turbine L2 query costs 1.28 ms when the only other arms are its own phases
 *   and 2.34 ms when two Drizzle arms rotate between its calls. That is not
 *   noise, it is cache eviction, and it means a 5-arm suite CANNOT be compared
 *   number-for-number against the published 4-arm suite.
 *
 *   So the default stays exactly the four arms 0.50.0 and 0.66.0 measured, and
 *   the RC is run as a separate 5-arm suite. Both are reported. Within either
 *   suite every arm is on equal footing, which is what the interleaving is for;
 *   it is only ACROSS suites that absolute values must not be mixed.
 */

import pg from 'pg';
import { TurbineClient } from '../generated/turbine/index.js';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { eq, count as drizzleCount, gt, asc, sql } from 'drizzle-orm';
import * as schema from './schema.js';
import { drizzle as drizzleRc } from 'drizzle-rc/node-postgres';
import {
  eq as rcEq,
  count as rcCount,
  gt as rcGt,
  asc as rcAsc,
  sql as rcSql,
} from 'drizzle-rc';
import { makeJitRqbMapper } from 'drizzle-rc/relations';
import * as rcSchema from './schema-rc.js';
import { Bench } from './bench-harness.js';

const DATABASE_URL = process.env['DATABASE_URL'] ?? 'postgres://localhost:5432/turbine_bench';
const ROUNDS = parseInt(process.env['ROUNDS'] ?? '200', 10);
const WARMUP = parseInt(process.env['WARMUP'] ?? '20', 10);
const STREAM_ROUNDS = parseInt(process.env['STREAM_ROUNDS'] ?? '9', 10);
const INCLUDE_RC = process.env['INCLUDE_RC'] === '1';
/**
 * `TURBINE_JSON` overrides the Turbine arm's relation JSON wire encoding.
 *
 * UNSET IS THE POINT. Unset, the option is not passed at all and the arm runs
 * on whatever the shipping client defaults to, which is what a user actually
 * gets. That is the only configuration whose numbers may be published as
 * "Turbine". Pinning it here to a literal would mean the harness kept
 * measuring the encoding that was the default on the day the line was written,
 * and would silently go on reporting it after the default moved: exactly the
 * stale-arm failure `verify-arms.ts` exists to catch elsewhere.
 *
 * Set it to `object` or `positional` to force one encoding. Both are shipped
 * options rather than benchmark-only fast paths, and neither changes the arm
 * count, so a forced run is directly comparable to an unset one. Forcing
 * `object` is how the OLD PostgreSQL default is priced now that `positional`
 * has taken over.
 */
/**
 * `TURBINE_STREAM=batches` points the Turbine STREAM arm at
 * `findManyStreamBatches` instead of `findManyStream`.
 *
 * It is a DIFFERENT API, not a faster version of the same one, and the reason
 * it gets a switch rather than a fifth arm is the same reason INCLUDE_RC does:
 * adding an arm changes what every other arm's cache sees, so a 5-arm number
 * cannot be compared to the 4-arm table. Swapping which method the existing arm
 * calls keeps the arm count at four and changes exactly one thing.
 *
 * `findManyStream` is UNCHANGED in this release, so the default stream arm is
 * expected to sit where it sat. A batch run must therefore be labelled as the
 * batch API's number and never presented as the per-row API improving.
 */
const TURBINE_STREAM_RAW = process.env['TURBINE_STREAM'];
if (TURBINE_STREAM_RAW !== undefined && TURBINE_STREAM_RAW !== 'rows' && TURBINE_STREAM_RAW !== 'batches') {
  console.error(`TURBINE_STREAM must be 'rows' or 'batches', got ${JSON.stringify(TURBINE_STREAM_RAW)}.`);
  process.exit(1);
}
const TURBINE_STREAM = TURBINE_STREAM_RAW === 'batches' ? 'batches' : 'rows';

const TURBINE_JSON_RAW = process.env['TURBINE_JSON'];
if (TURBINE_JSON_RAW !== undefined && TURBINE_JSON_RAW !== 'object' && TURBINE_JSON_RAW !== 'positional') {
  console.error(`TURBINE_JSON must be 'object' or 'positional', got ${JSON.stringify(TURBINE_JSON_RAW)}.`);
  process.exit(1);
}
const TURBINE_JSON = TURBINE_JSON_RAW as 'object' | 'positional' | undefined;

async function main() {
  const bench = new Bench({ rounds: ROUNDS, warmup: WARMUP });
  console.log('Interleaved harness: every arm once per round, order rotated per round, medians reported.');
  console.log(`ROUNDS=${ROUNDS} WARMUP=${WARMUP} STREAM_ROUNDS=${STREAM_ROUNDS} Node ${process.version}`);

  const turbine = new TurbineClient({
    connectionString: DATABASE_URL,
    logging: false,
    // Spread, so an unset TURBINE_JSON passes NO key and the client default
    // stands. `jsonEncoding: undefined` would also fall through to the default
    // today, but it asserts nothing, and the value being measured is too
    // important to rest on a `??` staying where it is.
    ...(TURBINE_JSON ? { jsonEncoding: TURBINE_JSON } : {}),
  });
  await turbine.connect();

  /**
   * Report the encoding that was actually EMITTED, read out of the SQL, not the
   * one we believe we configured.
   *
   * The whole reason this run exists is that a default moved in src/. A harness
   * that prints its own input would have happily printed "default" while
   * benchmarking a stale dist/ (the arm resolves `turbine-orm` through
   * benchmarks/node_modules -> ../.. -> dist/, so an unbuilt tree measures old
   * code and says nothing). buildFindMany compiles the statement without
   * executing it, so this costs one SQL build and cannot be fooled.
   */
  const relationSql = (turbine.users.buildFindMany({ limit: 1, with: { posts: true } }) as { sql: string }).sql;
  const emitted = relationSql.includes('json_build_array')
    ? 'positional'
    : relationSql.includes('json_build_object')
      ? 'object'
      : 'unknown';
  if (emitted === 'unknown') {
    console.error('Could not determine the relation JSON encoding from the emitted SQL. Refusing to report numbers.');
    process.exit(1);
  }
  if (TURBINE_JSON && emitted !== TURBINE_JSON) {
    console.error(`TURBINE_JSON=${TURBINE_JSON} but the emitted SQL is ${emitted}. Refusing to report numbers.`);
    process.exit(1);
  }
  console.log(
    `Turbine arm: jsonEncoding='${emitted}' (${TURBINE_JSON ? 'forced via TURBINE_JSON' : 'client default'}), verified from emitted SQL.`,
  );
  if (TURBINE_STREAM === 'batches') {
    console.log("Turbine stream arm: findManyStreamBatches (BATCH API, not the default findManyStream).");
  }

  const prismaPool = new pg.Pool({ connectionString: DATABASE_URL, max: 10 });
  const prisma = new PrismaClient({ adapter: new PrismaPg(prismaPool) });

  const drizzlePool = new pg.Pool({ connectionString: DATABASE_URL, max: 10 });
  const drizzleDb = drizzle(drizzlePool, { schema });

  const rawPool = new pg.Pool({ connectionString: DATABASE_URL, max: 10 });

  // Drizzle 1.0.0-rc.4. NOTE the object form: `drizzleRc(pool, config)` is
  // accepted at runtime but destructures `client`/`connection` off the POOL,
  // finds neither, builds a brand-new default pg.Pool, and DISCARDS the config,
  // so `relations` and `jit` are silently dropped. That failure is invisible
  // except that the JIT assertion below catches it.
  const rcPool = new pg.Pool({ connectionString: DATABASE_URL, max: 10 });
  const rcDb = drizzleRc({ client: rcPool, relations: rcSchema.relations, jit: true });

  if (INCLUDE_RC) {
    // `jit: true` is passed through `jitCompatCheck`, which falls back to the
    // premade mappers if `new Function` is unavailable. Publishing a fallback
    // run as a JIT result would be a fabricated number, so engagement is
    // asserted by identity against the library's own exported generator rather
    // than inferred from the flag we passed in.
    const gen = (rcDb as unknown as { dialect?: { mapperGenerators?: { relationalRows?: unknown } } })
      .dialect?.mapperGenerators?.relationalRows;
    if (gen !== makeJitRqbMapper) {
      console.error(
        `Drizzle RC arm is NOT using the JIT mapper (got ${(gen as { name?: string })?.name}). ` +
          'Refusing to report it as a JIT result.',
      );
      process.exit(1);
    }
    console.log('Drizzle RC arm: JIT row mapper engagement verified.');
  }

  /** Append the Drizzle RC arm only when the 5-arm suite was asked for. */
  const withRc = <T extends { name: string; fn: (i: number) => unknown }>(
    arms: T[],
    rcArm: T,
  ): T[] => (INCLUDE_RC ? [...arms, rcArm] : arms);

  const u = await turbine.users.count();
  const p = await turbine.posts.count();
  const c = await turbine.comments.count();
  console.log(`Data: ${u} users, ${p} posts, ${c} comments`);
  if (u !== 1000 || p !== 10000 || c !== 50000) {
    console.error('SEED MISMATCH, expected 1000/10000/50000. Refusing to report numbers.');
    process.exit(1);
  }

  // Drift probe, run at the head and the tail of the suite. The difference
  // between the two is the residual drift floor for this process.
  const driftProbe = (label: string) => bench.driftProbe(rawPool, label);

  const driftHead = await driftProbe('head');

  // 1. findMany flat
  await bench.interleave('findMany, 100 users (flat)', withRc([
    { name: 'Turbine', fn: () => turbine.users.findMany({ limit: 100 }) },
    { name: 'Prisma 7', fn: () => prisma.user.findMany({ take: 100 }) },
    { name: 'Drizzle', fn: () => drizzleDb.query.users.findMany({ limit: 100 }) },
    { name: 'Raw', fn: () => rawPool.query('SELECT * FROM users LIMIT 100') },
  ], { name: 'Drizzle RC', fn: () => rcDb.query.users.findMany({ limit: 100 }) }));

  // 2. findMany L2
  //
  // THE RAW CONTROL IS ENCODING-MATCHED TO THE TURBINE ARM, and it has to be.
  //
  // This arm exists to answer "what does Turbine cost above hand-written pg".
  // It was written when Turbine emitted `json_build_object`, so it spelled the
  // nested aggregate that way too. When positional encoding became the
  // PostgreSQL default in 0.71.0, the control silently stopped matching the arm
  // it controls for: measured directly on identical rows, the object spelling
  // costs 1.83x the array spelling (`raw-l2-encoding.ts`). The control was
  // therefore doing strictly more work than the ORM it bounds, and Turbine's L2
  // "overhead" computed to 0.90x, i.e. faster than hand-written SQL. That
  // reading is not supportable, and `RESULTS-0.71.0.md` had to publish a
  // derived 1.08x instead of the recorded 1.00x to avoid quoting it.
  //
  // The fix is not to hard-code the array spelling, because then the
  // `TURBINE_JSON=object` control run would be mismatched in the other
  // direction. The statement follows `emitted`, which was read out of Turbine's
  // own compiled SQL above, so the control is matched in BOTH configurations
  // and no future encoding change can silently unmatch it again.
  //
  // Disclosed asymmetry: with the array spelling the raw arm receives nested
  // ARRAYS, while Turbine decodes them back into objects. The control therefore
  // does slightly LESS work than the ORM, which biases the overhead figure
  // UPWARD for Turbine. That is the conservative direction, which is why it is
  // acceptable; `raw-l2-encoding.ts` prices the decode separately.
  const RAW_L2_OBJECT = `
    SELECT u.*, COALESCE((
      SELECT json_agg(json_build_object('id', p.id, 'userId', p.user_id, 'orgId', p.org_id,
        'title', p.title, 'content', p.content, 'published', p.published,
        'viewCount', p.view_count, 'createdAt', p.created_at, 'updatedAt', p.updated_at))
      FROM posts p WHERE p.user_id = u.id), '[]'::json) AS posts
    FROM users u LIMIT 50`;

  const RAW_L2_ARRAY = `
    SELECT u.*, COALESCE((
      SELECT json_agg(json_build_array(p.id, p.user_id, p.org_id,
        p.title, p.content, p.published,
        p.view_count, p.created_at, p.updated_at))
      FROM posts p WHERE p.user_id = u.id), '[]'::json) AS posts
    FROM users u LIMIT 50`;

  const rawL2 = emitted === 'positional' ? RAW_L2_ARRAY : RAW_L2_OBJECT;
  console.log(
    `Raw L2 control: ${emitted === 'positional' ? 'json_build_array' : 'json_build_object'}, ` +
      `encoding-matched to the Turbine arm.`,
  );

  // The two spellings must return the same data, or the control is measuring a
  // different query rather than a different encoding. Checked here, once,
  // before anything is timed: same parent count, same total child count.
  {
    const [objRes, arrRes] = await Promise.all([
      rawPool.query(RAW_L2_OBJECT),
      rawPool.query(RAW_L2_ARRAY),
    ]);
    const childCount = (rows: any[], key: string) =>
      rows.reduce((n, r) => n + (r[key] as unknown[]).length, 0);
    const objChildren = childCount(objRes.rows, 'posts');
    const arrChildren = childCount(arrRes.rows, 'posts');
    if (objRes.rows.length !== arrRes.rows.length || objChildren !== arrChildren) {
      console.error(
        `Raw L2 encoding check FAILED: object ${objRes.rows.length} rows/${objChildren} children, ` +
          `array ${arrRes.rows.length} rows/${arrChildren} children. Refusing to report numbers.`,
      );
      process.exit(1);
    }
    console.log(
      `Raw L2 encoding check: both spellings return ${objRes.rows.length} rows / ${objChildren} children.`,
    );
  }
  await bench.interleave('findMany, 50 users + posts (L2)', withRc([
    { name: 'Turbine', fn: () => turbine.users.findMany({ limit: 50, with: { posts: true } }) },
    { name: 'Prisma 7', fn: () => prisma.user.findMany({ take: 50, include: { posts: true } }) },
    { name: 'Drizzle', fn: () => drizzleDb.query.users.findMany({ limit: 50, with: { posts: true } }) },
    { name: 'Raw', fn: () => rawPool.query(rawL2) },
  ], { name: 'Drizzle RC', fn: () => rcDb.query.users.findMany({ limit: 50, with: { posts: true } }) }));

  // 3. findMany L3 (no hand-written raw equivalent, ORM arms only)
  await bench.interleave('findMany, 10 users -> posts -> comments (L3)', withRc([
    { name: 'Turbine', fn: () => turbine.users.findMany({ limit: 10, with: { posts: { with: { comments: true }, limit: 5 } } }) },
    { name: 'Prisma 7', fn: () => prisma.user.findMany({ take: 10, include: { posts: { take: 5, include: { comments: true } } } }) },
    { name: 'Drizzle', fn: () => drizzleDb.query.users.findMany({ limit: 10, with: { posts: { limit: 5, with: { comments: true } } } }) },
  ], { name: 'Drizzle RC', fn: () => rcDb.query.users.findMany({ limit: 10, with: { posts: { limit: 5, with: { comments: true } } } }) }));

  // 4. findUnique by PK
  // NOTE: RQB v2 replaced the `eq(col, v)` where-builder with a relational
  // filter OBJECT, so the RC arm is spelled differently on purpose. It compiles
  // to the same predicate; equivalence of the returned rows is asserted by
  // verify-arms.ts before any of this is timed.
  await bench.interleave('findUnique, single user by PK', withRc([
    { name: 'Turbine', fn: () => turbine.users.findUnique({ where: { id: 1 } }) },
    { name: 'Prisma 7', fn: () => prisma.user.findUnique({ where: { id: BigInt(1) } }) },
    { name: 'Drizzle', fn: () => drizzleDb.query.users.findFirst({ where: eq(schema.users.id, 1) }) },
    { name: 'Raw', fn: () => rawPool.query('SELECT * FROM users WHERE id = $1', [1]) },
  ], { name: 'Drizzle RC', fn: () => rcDb.query.users.findFirst({ where: { id: 1 } }) }));

  // 5. findUnique nested L3
  await bench.interleave('findUnique, user + posts + comments (L3)', withRc([
    { name: 'Turbine', fn: () => turbine.users.findUnique({ where: { id: 1 }, with: { posts: { with: { comments: true } } } }) },
    { name: 'Prisma 7', fn: () => prisma.user.findUnique({ where: { id: BigInt(1) }, include: { posts: { include: { comments: true } } } }) },
    { name: 'Drizzle', fn: () => drizzleDb.query.users.findFirst({ where: eq(schema.users.id, 1), with: { posts: { with: { comments: true } } } }) },
  ], { name: 'Drizzle RC', fn: () => rcDb.query.users.findFirst({ where: { id: 1 }, with: { posts: { with: { comments: true } } } }) }));

  const driftMid = await driftProbe('mid');

  // 6. count
  await bench.interleave('count, all users', withRc([
    { name: 'Turbine', fn: () => turbine.users.count() },
    { name: 'Prisma 7', fn: () => prisma.user.count() },
    { name: 'Drizzle', fn: () => drizzleDb.select({ value: drizzleCount() }).from(schema.users) },
    { name: 'Raw', fn: () => rawPool.query('SELECT count(*) FROM users') },
  ], { name: 'Drizzle RC', fn: () => rcDb.select({ value: rcCount() }).from(rcSchema.users) }));

  // 7. streaming 50K
  const BATCH = 1000;
  await bench.interleave(
    'stream, iterate 50K comments (batch 1000)',
    withRc([
      {
        name: 'Turbine',
        fn:
          TURBINE_STREAM === 'batches'
            ? async () => {
                // Counted per ROW, exactly as the per-row arm and every
                // competitor arm counts, so the two spellings are measured on
                // identical work and the only difference is how rows leave the
                // generator.
                let n = 0;
                for await (const batch of turbine.comments.findManyStreamBatches({ batchSize: BATCH })) {
                  for (const _c of batch) n++;
                }
                return n;
              }
            : async () => {
                let n = 0;
                for await (const _c of turbine.comments.findManyStream({ batchSize: BATCH })) n++;
                return n;
              },
      },
      {
        name: 'Prisma 7',
        fn: async () => {
          let n = 0;
          let cursor: { id: bigint } | undefined;
          for (;;) {
            const batch = await prisma.comment.findMany({
              take: BATCH,
              ...(cursor ? { cursor, skip: 1 } : {}),
              orderBy: { id: 'asc' },
            });
            if (batch.length === 0) break;
            n += batch.length;
            if (batch.length < BATCH) break;
            cursor = { id: batch[batch.length - 1]!.id };
          }
          return n;
        },
      },
      {
        name: 'Drizzle',
        fn: async () => {
          let n = 0;
          let lastId = 0;
          for (;;) {
            const batch = await drizzleDb
              .select()
              .from(schema.comments)
              .where(gt(schema.comments.id, lastId))
              .orderBy(asc(schema.comments.id))
              .limit(BATCH);
            if (batch.length === 0) break;
            for (const row of batch) {
              n++;
              lastId = row.id;
            }
            if (batch.length < BATCH) break;
          }
          return n;
        },
      },
      {
        name: 'Raw',
        fn: async () => {
          let n = 0;
          let lastId = 0;
          for (;;) {
            const res = await rawPool.query(
              'SELECT * FROM comments WHERE id > $1 ORDER BY id ASC LIMIT $2',
              [lastId, BATCH],
            );
            if (res.rows.length === 0) break;
            for (const row of res.rows) {
              n++;
              lastId = Number(row.id);
            }
            if (res.rows.length < BATCH) break;
          }
          return n;
        },
      },
    ],
    {
      name: 'Drizzle RC',
      fn: async () => {
        let n = 0;
        let lastId = 0;
        for (;;) {
          const batch = await rcDb
            .select()
            .from(rcSchema.comments)
            .where(rcGt(rcSchema.comments.id, lastId))
            .orderBy(rcAsc(rcSchema.comments.id))
            .limit(BATCH);
          if (batch.length === 0) break;
          for (const row of batch) {
            n++;
            lastId = row.id;
          }
          if (batch.length < BATCH) break;
        }
        return n;
      },
    }),
    { rounds: STREAM_ROUNDS, warmup: 1 },
  );

  // 8. atomic increment
  await bench.interleave('atomic increment, posts.view_count + 1', withRc([
    { name: 'Turbine', fn: () => turbine.posts.update({ where: { id: 1 }, data: { viewCount: { increment: 1 } } }) },
    { name: 'Prisma 7', fn: () => prisma.post.update({ where: { id: BigInt(1) }, data: { viewCount: { increment: 1 } } }) },
    { name: 'Drizzle', fn: () => drizzleDb.update(schema.posts).set({ viewCount: sql`${schema.posts.viewCount} + 1` }).where(eq(schema.posts.id, 1)) },
    { name: 'Raw', fn: () => rawPool.query('UPDATE posts SET view_count = view_count + 1 WHERE id = $1', [1]) },
  ], {
    name: 'Drizzle RC',
    fn: () => rcDb.update(rcSchema.posts).set({ viewCount: rcSql`${rcSchema.posts.viewCount} + 1` }).where(rcEq(rcSchema.posts.id, 1)),
  }));

  // 9. pipeline 5-query dashboard batch
  await bench.interleave('pipeline, 5-query dashboard batch', withRc([
    {
      name: 'Turbine',
      fn: () =>
        turbine.pipeline(
          turbine.users.buildFindUnique({ where: { id: 1 } }),
          turbine.posts.buildCount({ where: { userId: 1 } }),
          turbine.comments.buildCount({ where: { userId: 1 } }),
          turbine.posts.buildFindMany({ where: { userId: 1 }, orderBy: { createdAt: 'desc' }, limit: 5 }),
          turbine.users.buildCount(),
        ),
    },
    {
      name: 'Prisma 7',
      fn: () =>
        prisma.$transaction([
          prisma.user.findUnique({ where: { id: BigInt(1) } }),
          prisma.post.count({ where: { userId: BigInt(1) } }),
          prisma.comment.count({ where: { userId: BigInt(1) } }),
          prisma.post.findMany({ where: { userId: BigInt(1) }, orderBy: { createdAt: 'desc' }, take: 5 }),
          prisma.user.count(),
        ]),
    },
    {
      name: 'Drizzle',
      fn: () =>
        drizzleDb.transaction(async (tx) => [
          await tx.query.users.findFirst({ where: eq(schema.users.id, 1) }),
          await tx.select({ v: drizzleCount() }).from(schema.posts).where(eq(schema.posts.userId, 1)),
          await tx.select({ v: drizzleCount() }).from(schema.comments).where(eq(schema.comments.userId, 1)),
          await tx.query.posts.findMany({ where: eq(schema.posts.userId, 1), limit: 5 }),
          await tx.select({ v: drizzleCount() }).from(schema.users),
        ]),
    },
    {
      name: 'Raw',
      fn: async () => {
        const client = await rawPool.connect();
        try {
          await client.query('SELECT * FROM users WHERE id = $1', [1]);
          await client.query('SELECT count(*) FROM posts WHERE user_id = $1', [1]);
          await client.query('SELECT count(*) FROM comments WHERE user_id = $1', [1]);
          await client.query('SELECT * FROM posts WHERE user_id = $1 ORDER BY created_at DESC LIMIT 5', [1]);
          await client.query('SELECT count(*) FROM users');
        } finally {
          client.release();
        }
      },
    },
  ], {
    name: 'Drizzle RC',
    fn: () =>
      rcDb.transaction(async (tx) => [
        await tx.query.users.findFirst({ where: { id: 1 } }),
        await tx.select({ v: rcCount() }).from(rcSchema.posts).where(rcEq(rcSchema.posts.userId, 1)),
        await tx.select({ v: rcCount() }).from(rcSchema.comments).where(rcEq(rcSchema.comments.userId, 1)),
        await tx.query.posts.findMany({ where: { userId: 1 }, limit: 5 }),
        await tx.select({ v: rcCount() }).from(rcSchema.users),
      ]),
  }));

  // 10. hot findUnique, rotating ids
  await bench.interleave('hot findUnique, rotating IDs', withRc([
    { name: 'Turbine', fn: (i) => turbine.users.findUnique({ where: { id: (i % 50) + 1 } }) },
    { name: 'Prisma 7', fn: (i) => prisma.user.findUnique({ where: { id: BigInt((i % 50) + 1) } }) },
    { name: 'Drizzle', fn: (i) => drizzleDb.query.users.findFirst({ where: eq(schema.users.id, (i % 50) + 1) }) },
    { name: 'Raw', fn: (i) => rawPool.query('SELECT * FROM users WHERE id = $1', [(i % 50) + 1]) },
  ], { name: 'Drizzle RC', fn: (i) => rcDb.query.users.findFirst({ where: { id: (i % 50) + 1 } }) }));

  const driftTail = await driftProbe('tail');
  bench.reportDrift([driftHead, driftMid, driftTail]);

  // Machine-readable dump for the writeup.
  console.log('\n=== JSON ===');
  console.log(JSON.stringify({ driftHead, driftMid, driftTail, results: bench.results }, null, 2));

  await turbine.disconnect();
  await prisma.$disconnect();
  await drizzlePool.end();
  await prismaPool.end();
  await rawPool.end();
  await rcPool.end();
  console.log('\nDone.');
}

main().catch((err) => {
  console.error('\nBenchmark error:', err);
  process.exit(1);
});
