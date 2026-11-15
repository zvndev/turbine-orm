/**
 * Interleaved headline suite. Every selected arm passes an exact independent
 * preflight before warmup or timing. See README.md for setup and semantics.
 *
 * DATABASE_URL=postgres://localhost:5432/turbine_bench npx tsx bench-interleaved.ts
 * ROUNDS=200 WARMUP=20 STREAM_ROUNDS=15 INCLUDE_RC=1
 * TURBINE_JSON=object|positional TURBINE_STREAM=rows|batches
 */
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { asc, count, desc, eq, gt, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { asc as rcAsc, count as rcCount, eq as rcEq, gt as rcGt, sql as rcSql } from 'drizzle-rc';
import { drizzle as drizzleRc } from 'drizzle-rc/node-postgres';
import { makeDefaultRqbMapper, makeJitRqbMapper } from 'drizzle-rc/relations';
import pg from 'pg';
import { TurbineClient } from '../generated/turbine/index.js';
import { type Arm, Bench } from './bench-harness.js';
import { dashboardOrder, dashboardReads, rawDashboard, turbineDashboard } from './dashboard.js';
import { assertExact, type HeadlineScenario, headlineNames, verifyHeadline } from './equivalence.js';
import * as schema from './schema.js';
import * as rcSchema from './schema-rc.js';
import { observedPgIdentity } from './pg-admission.js';
import { HEADLINE_SEMANTICS } from './semantics.js';

const BATCH = 1000;

export async function runHeadline(
  options: {
    verifyOnly?: boolean;
    includeNoJit?: boolean;
    mutate?: (scenarios: HeadlineScenario[]) => void;
    reportPath?: string;
  } = {},
) {
  const report = {
    headlineSemantics: HEADLINE_SEMANTICS,
    provenance: observedPgIdentity(),
    runtime: observedPgIdentity()?.runtime ?? { node: process.version, executable: process.execPath },
    settings: { rounds: 0, warmup: 0, streamRounds: 0 },
    armProfile: options.includeNoJit ? ('rc-nojit-control' as const) : ('original' as const),
    status: 'running',
    timing: !options.verifyOnly,
    catalog: [] as { scenario: string; arms: string[]; note?: string }[],
    results: [] as Bench['results'],
    cleanup: { closed: false },
    error: undefined as string | undefined,
    driftSamples: [] as Bench['probes'],
    driftHead: undefined as number | undefined,
    driftMid: undefined as number | undefined,
    driftTail: undefined as number | undefined,
  };
  const url = process.env['DATABASE_URL'] ?? 'postgres://localhost:5432/turbine_bench';
  const rounds = parseInt(process.env['ROUNDS'] ?? '200', 10);
  const warmup = parseInt(process.env['WARMUP'] ?? '20', 10);
  const streamRounds = parseInt(process.env['STREAM_ROUNDS'] ?? '15', 10);
  report.settings = { rounds, warmup, streamRounds };
  const includeRc = options.includeNoJit || process.env['INCLUDE_RC'] !== '0';
  const json = process.env['TURBINE_JSON'];
  const stream = process.env['TURBINE_STREAM'] ?? 'rows';
  if (json !== undefined && json !== 'object' && json !== 'positional')
    throw new Error('TURBINE_JSON must be object or positional');
  if (stream !== 'rows' && stream !== 'batches') throw new Error('TURBINE_STREAM must be rows or batches');
  for (const [key, n] of Object.entries({ ROUNDS: rounds, WARMUP: warmup, STREAM_ROUNDS: streamRounds })) {
    if (!Number.isSafeInteger(n) || n < (key === 'WARMUP' ? 0 : 1)) throw new Error(`${key} has an invalid count`);
  }
  // Every measured PG arm uses this benchmark's locked driver and pool limit.
  // The package's default-owned driver profile is a separate comparison.
  const pools = Array.from({ length: 6 }, () => new pg.Pool({ connectionString: url, max: 10 }));
  const [prismaPool, drizzlePool, rawPool, rcPool, noJitPool, turbinePool] = pools as [
    pg.Pool,
    pg.Pool,
    pg.Pool,
    pg.Pool,
    pg.Pool,
    pg.Pool,
  ];
  const turbine = new TurbineClient({
    pool: turbinePool,
    preparedStatements: true,
    logging: false,
    ...(json ? { jsonEncoding: json } : {}),
  });
  const prisma = new PrismaClient({ adapter: new PrismaPg(prismaPool) });
  const drizzleDb = drizzle(drizzlePool, { schema });
  const rcDb = drizzleRc({ client: rcPool, relations: rcSchema.relations, jit: true });
  const noJitDb = drizzleRc({ client: noJitPool, relations: rcSchema.relations, jit: false });
  let failure: unknown;
  try {
    await turbine.connect();
    if (turbine.pool !== turbinePool || !turbine.users.buildFindMany({ limit: 1 }).preparedName)
      throw new Error('Benchmark requires the matched supplied-pool and named Turbine statement profile.');
    const relationSql = turbine.users.buildFindMany({ limit: 1, with: { posts: true } }).sql;
    const emitted = relationSql.includes('json_build_array')
      ? 'positional'
      : relationSql.includes('json_build_object')
        ? 'object'
        : 'unknown';
    if (emitted === 'unknown' || (json && emitted !== json))
      throw new Error('Relation JSON encoding does not match the requested arm');
    console.log(`Turbine arm: jsonEncoding='${emitted}' (${json ? 'forced' : 'client default'}), stream=${stream}`);
    console.log(
      'PG pool profile: shared locked pg driver, separate pools, max=10; Turbine uses a caller-owned pool and named statements.',
    );
    if (includeRc) {
      const mapper = (db: unknown) =>
        (db as { dialect?: { mapperGenerators?: { relationalRows?: unknown } } }).dialect?.mapperGenerators
          ?.relationalRows;
      if (mapper(rcDb) !== makeJitRqbMapper) throw new Error('Drizzle RC JIT mapper is not engaged');
      if (options.includeNoJit && mapper(noJitDb) !== makeDefaultRqbMapper)
        throw new Error('RC no-jit control is not using the default mapper');
      const probe = makeJitRqbMapper({
        selection: [{ key: 'id', field: rcSchema.users.id, fieldType: 'Column' }],
        isFirst: false,
        parseJson: false,
        parseJsonIfString: false,
        rootJsonMappers: false,
        arrayModeRoot: false,
      });
      const body = (probe as typeof probe & { body?: string }).body;
      if (!body?.includes('jitRqbMapper')) throw new Error('RC JIT mapper did not produce a compiled function body');
    }
    // The no-jit control uses every RC arm definition below, changing only its client.
    const rcClients = includeRc
      ? [
          { name: 'Drizzle RC', db: rcDb },
          ...(options.includeNoJit ? [{ name: 'Drizzle RC (no jit)', db: noJitDb }] : []),
        ]
      : [];
    const scenarios: HeadlineScenario[] = [];
    const add = (
      index: number,
      arms: Arm[],
      rc: (db: typeof rcDb) => Arm['fn'],
      extra?: HeadlineScenario['options'],
    ) => {
      scenarios.push({
        scenario: headlineNames[index]!,
        arms: [...arms, ...rcClients.map(({ name, db }) => ({ name, fn: rc(db) }))],
        options: extra,
      });
    };
    add(
      0,
      [
        { name: 'Turbine', fn: () => turbine.users.findMany({ limit: 100, orderBy: { id: 'asc' } }) },
        { name: 'Prisma 7', fn: () => prisma.user.findMany({ take: 100, orderBy: { id: 'asc' } }) },
        { name: 'Drizzle', fn: () => drizzleDb.query.users.findMany({ limit: 100, orderBy: asc(schema.users.id) }) },
        { name: 'Raw', fn: () => rawPool.query('SELECT * FROM users ORDER BY id ASC LIMIT 100') },
      ],
      (db) => () => db.query.users.findMany({ limit: 100, orderBy: { id: 'asc' } }),
    );

    // The raw nested control matches both Turbine's emitted encoding and its decoded payload.
    const fields = [
      'id',
      'user_id',
      'org_id',
      'title',
      'content',
      'published',
      'view_count',
      'created_at',
      'updated_at',
    ];
    const keys = ['id', 'userId', 'orgId', 'title', 'content', 'published', 'viewCount', 'createdAt', 'updatedAt'];
    const rawL2Sql = (encoding: 'object' | 'positional') => {
      const cells = fields.map((f, i) => (encoding === 'object' ? `'${keys[i]}', p.${f}` : `p.${f}`)).join(', ');
      return `SELECT u.*, COALESCE((SELECT json_agg(json_build_${encoding === 'object' ? 'object' : 'array'}(${cells}) ORDER BY p.id ASC) FROM posts p WHERE p.user_id = u.id), '[]'::json) AS posts FROM users u ORDER BY u.id ASC LIMIT 50`;
    };
    const rawL2 = async (encoding: 'object' | 'positional') => {
      const res = await rawPool.query(rawL2Sql(encoding));
      for (const row of res.rows)
        row.posts = (row.posts as (unknown[] | Record<string, unknown>)[]).map((p) => {
          const post = Array.isArray(p) ? Object.fromEntries(keys.map((k, i) => [k, p[i]])) : { ...p };
          post.createdAt = new Date(post.createdAt as string);
          post.updatedAt = new Date(post.updatedAt as string);
          return post;
        });
      return res.rows;
    };
    // Exact comparison, including every nested column and order, in both encodings.
    assertExact('Raw L2 object/positional control', await rawL2('object'), await rawL2('positional'));
    add(
      1,
      [
        {
          name: 'Turbine',
          fn: () =>
            turbine.users.findMany({ limit: 50, orderBy: { id: 'asc' }, with: { posts: { orderBy: { id: 'asc' } } } }),
        },
        {
          name: 'Prisma 7',
          fn: () =>
            prisma.user.findMany({ take: 50, orderBy: { id: 'asc' }, include: { posts: { orderBy: { id: 'asc' } } } }),
        },
        {
          name: 'Drizzle',
          fn: () =>
            drizzleDb.query.users.findMany({
              limit: 50,
              orderBy: asc(schema.users.id),
              with: { posts: { orderBy: asc(schema.posts.id) } },
            }),
        },
        { name: 'Raw', fn: () => rawL2(emitted) },
      ],
      (db) => () =>
        db.query.users.findMany({ limit: 50, orderBy: { id: 'asc' }, with: { posts: { orderBy: { id: 'asc' } } } }),
    );
    add(
      2,
      [
        {
          name: 'Turbine',
          fn: () =>
            turbine.users.findMany({
              limit: 10,
              orderBy: { id: 'asc' },
              with: { posts: { limit: 5, orderBy: { id: 'asc' }, with: { comments: { orderBy: { id: 'asc' } } } } },
            }),
        },
        {
          name: 'Prisma 7',
          fn: () =>
            prisma.user.findMany({
              take: 10,
              orderBy: { id: 'asc' },
              include: {
                posts: { take: 5, orderBy: { id: 'asc' }, include: { comments: { orderBy: { id: 'asc' } } } },
              },
            }),
        },
        {
          name: 'Drizzle',
          fn: () =>
            drizzleDb.query.users.findMany({
              limit: 10,
              orderBy: asc(schema.users.id),
              with: {
                posts: {
                  limit: 5,
                  orderBy: asc(schema.posts.id),
                  with: { comments: { orderBy: asc(schema.comments.id) } },
                },
              },
            }),
        },
      ],
      (db) => () =>
        db.query.users.findMany({
          limit: 10,
          orderBy: { id: 'asc' },
          with: { posts: { limit: 5, orderBy: { id: 'asc' }, with: { comments: { orderBy: { id: 'asc' } } } } },
        }),
    );
    add(
      3,
      [
        { name: 'Turbine', fn: () => turbine.users.findUnique({ where: { id: 1 } }) },
        { name: 'Prisma 7', fn: () => prisma.user.findUnique({ where: { id: 1n } }) },
        { name: 'Drizzle', fn: () => drizzleDb.query.users.findFirst({ where: eq(schema.users.id, 1) }) },
        { name: 'Raw', fn: () => rawPool.query('SELECT * FROM users WHERE id = $1', [1]) },
      ],
      (db) => () => db.query.users.findFirst({ where: { id: 1 } }),
    );
    add(
      4,
      [
        {
          name: 'Turbine',
          fn: () =>
            turbine.users.findUnique({
              where: { id: 1 },
              with: { posts: { orderBy: { id: 'asc' }, with: { comments: { orderBy: { id: 'asc' } } } } },
            }),
        },
        {
          name: 'Prisma 7',
          fn: () =>
            prisma.user.findUnique({
              where: { id: 1n },
              include: { posts: { orderBy: { id: 'asc' }, include: { comments: { orderBy: { id: 'asc' } } } } },
            }),
        },
        {
          name: 'Drizzle',
          fn: () =>
            drizzleDb.query.users.findFirst({
              where: eq(schema.users.id, 1),
              with: {
                posts: { orderBy: asc(schema.posts.id), with: { comments: { orderBy: asc(schema.comments.id) } } },
              },
            }),
        },
      ],
      (db) => () =>
        db.query.users.findFirst({
          where: { id: 1 },
          with: { posts: { orderBy: { id: 'asc' }, with: { comments: { orderBy: { id: 'asc' } } } } },
        }),
    );
    add(
      5,
      [
        { name: 'Turbine', fn: () => turbine.users.count() },
        { name: 'Prisma 7', fn: () => prisma.user.count() },
        { name: 'Drizzle', fn: () => drizzleDb.select({ value: count() }).from(schema.users) },
        { name: 'Raw', fn: () => rawPool.query('SELECT count(*) FROM users') },
      ],
      (db) => () => db.select({ value: rcCount() }).from(rcSchema.users),
    );

    add(
      6,
      [
        {
          name: 'Turbine',
          fn: async (_i, observe) => {
            let n = 0;
            if (stream === 'batches') {
              for await (const batch of turbine.comments.findManyStreamBatches({
                batchSize: BATCH,
                orderBy: { id: 'asc' },
              }))
                for (const row of batch) {
                  observe?.(row);
                  n++;
                }
            } else {
              for await (const row of turbine.comments.findManyStream({ batchSize: BATCH, orderBy: { id: 'asc' } })) {
                observe?.(row);
                n++;
              }
            }
            return n;
          },
        },
        {
          name: 'Prisma 7',
          fn: async (_i, observe) => {
            let n = 0;
            let cursor: { id: bigint } | undefined;
            for (;;) {
              const batch = await prisma.comment.findMany({
                take: BATCH,
                ...(cursor ? { cursor, skip: 1 } : {}),
                orderBy: { id: 'asc' },
              });
              for (const row of batch) {
                observe?.(row);
                n++;
              }
              if (batch.length < BATCH) break;
              cursor = { id: batch[batch.length - 1]!.id };
            }
            return n;
          },
        },
        {
          name: 'Drizzle',
          fn: async (_i, observe) => {
            let n = 0;
            let last = 0;
            for (;;) {
              const batch = await drizzleDb
                .select()
                .from(schema.comments)
                .where(gt(schema.comments.id, last))
                .orderBy(asc(schema.comments.id))
                .limit(BATCH);
              for (const row of batch) {
                observe?.(row);
                n++;
                last = row.id;
              }
              if (batch.length < BATCH) break;
            }
            return n;
          },
        },
        {
          name: 'Raw',
          fn: async (_i, observe) => {
            let n = 0;
            let last: unknown = 0;
            for (;;) {
              const batch = (
                await rawPool.query('SELECT * FROM comments WHERE id > $1 ORDER BY id ASC LIMIT $2', [last, BATCH])
              ).rows;
              for (const row of batch) {
                observe?.(row);
                n++;
                last = row.id;
              }
              if (batch.length < BATCH) break;
            }
            return n;
          },
        },
      ],
      (db) => async (_i, observe) => {
        let n = 0;
        let last = 0;
        for (;;) {
          const batch = await db
            .select()
            .from(rcSchema.comments)
            .where(rcGt(rcSchema.comments.id, last))
            .orderBy(rcAsc(rcSchema.comments.id))
            .limit(BATCH);
          for (const row of batch) {
            observe?.(row);
            n++;
            last = row.id;
          }
          if (batch.length < BATCH) break;
        }
        return n;
      },
      {
        rounds: streamRounds,
        warmup: 1,
        note: 'ARMS DIFFER: Turbine uses a server cursor; other arms use independent keyset pages. All return the same ordered rows on the static fixture. TURBINE_STREAM=batches selects the batch API.',
      },
    );

    add(
      7,
      [
        {
          name: 'Turbine',
          fn: () => turbine.posts.update({ where: { id: 1 }, data: { viewCount: { increment: 1 } } }),
        },
        {
          name: 'Prisma 7',
          fn: () => prisma.post.update({ where: { id: 1n }, data: { viewCount: { increment: 1 } } }),
        },
        {
          name: 'Drizzle',
          fn: () =>
            drizzleDb
              .update(schema.posts)
              .set({ viewCount: sql`${schema.posts.viewCount} + 1` })
              .where(eq(schema.posts.id, 1))
              .returning(),
        },
        {
          name: 'Raw',
          fn: () => rawPool.query('UPDATE posts SET view_count = view_count + 1 WHERE id = $1 RETURNING *', [1]),
        },
      ],
      (db) => () =>
        db
          .update(rcSchema.posts)
          .set({ viewCount: rcSql`${rcSchema.posts.viewCount} + 1` })
          .where(rcEq(rcSchema.posts.id, 1))
          .returning(),
    );

    for (const mode of ['independent', 'transaction'] as const) {
      const deferred = () =>
        [
          turbine.users.buildFindUnique({ where: { id: 1 } }),
          turbine.posts.buildCount({ where: { userId: 1 } }),
          turbine.comments.buildCount({ where: { userId: 1 } }),
          turbine.posts.buildFindMany({ where: { userId: 1 }, orderBy: [...dashboardOrder], limit: 5 }),
          turbine.users.buildCount(),
        ] as const;
      const prismaQueries = () =>
        [
          prisma.user.findUnique({ where: { id: 1n } }),
          prisma.post.count({ where: { userId: 1n } }),
          prisma.comment.count({ where: { userId: 1n } }),
          prisma.post.findMany({ where: { userId: 1n }, orderBy: [...dashboardOrder], take: 5 }),
          prisma.user.count(),
        ] as const;
      const stableReads = (db: Pick<typeof drizzleDb, 'query' | 'select'>) => ({
        user: () => db.query.users.findFirst({ where: eq(schema.users.id, 1) }),
        postCount: () => db.select({ v: count() }).from(schema.posts).where(eq(schema.posts.userId, 1)),
        commentCount: () => db.select({ v: count() }).from(schema.comments).where(eq(schema.comments.userId, 1)),
        recentPosts: () =>
          db.query.posts.findMany({
            where: eq(schema.posts.userId, 1),
            orderBy: [desc(schema.posts.createdAt), desc(schema.posts.id)],
            limit: 5,
          }),
        userCount: () => db.select({ v: count() }).from(schema.users),
      });
      add(
        mode === 'independent' ? 8 : 9,
        [
          {
            name: 'Turbine',
            fn: () => turbineDashboard(turbine, deferred(), mode),
          },
          {
            name: 'Prisma 7',
            fn: () =>
              mode === 'independent'
                ? Promise.all(prismaQueries())
                : prisma.$transaction([...prismaQueries()], { isolationLevel: 'ReadCommitted' }),
          },
          {
            name: 'Drizzle',
            fn: () =>
              mode === 'independent'
                ? dashboardReads(stableReads(drizzleDb), mode)
                : drizzleDb.transaction((tx) => dashboardReads(stableReads(tx), mode), {
                    isolationLevel: 'read committed',
                  }),
          },
          { name: 'Raw', fn: () => rawDashboard(rawPool, mode) },
        ],
        (db) => () => {
          const reads = (tx: Pick<typeof rcDb, 'query' | 'select'>) => ({
            user: () => tx.query.users.findFirst({ where: { id: 1 } }),
            postCount: () => tx.select({ v: rcCount() }).from(rcSchema.posts).where(rcEq(rcSchema.posts.userId, 1)),
            commentCount: () =>
              tx.select({ v: rcCount() }).from(rcSchema.comments).where(rcEq(rcSchema.comments.userId, 1)),
            recentPosts: () =>
              tx.query.posts.findMany({ where: { userId: 1 }, orderBy: { createdAt: 'desc', id: 'desc' }, limit: 5 }),
            userCount: () => tx.select({ v: rcCount() }).from(rcSchema.users),
          });
          return mode === 'independent'
            ? dashboardReads(reads(db), mode)
            : db.transaction((tx) => dashboardReads(reads(tx), mode), { isolationLevel: 'read committed' });
        },
        {
          note:
            mode === 'independent'
              ? 'Independent reads: no atomicity or shared-snapshot guarantee. Turbine pipelines; competitors use concurrent pool reads.'
              : 'Every arm uses one explicit READ COMMITTED transaction on one pinned connection. READ COMMITTED does not promise a shared snapshot across statements.',
        },
      );
    }
    add(
      10,
      [
        { name: 'Turbine', fn: (i) => turbine.users.findUnique({ where: { id: (i % 50) + 1 } }) },
        { name: 'Prisma 7', fn: (i) => prisma.user.findUnique({ where: { id: BigInt((i % 50) + 1) } }) },
        { name: 'Drizzle', fn: (i) => drizzleDb.query.users.findFirst({ where: eq(schema.users.id, (i % 50) + 1) }) },
        { name: 'Raw', fn: (i) => rawPool.query('SELECT * FROM users WHERE id = $1', [(i % 50) + 1]) },
      ],
      (db) => (i) => db.query.users.findFirst({ where: { id: (i % 50) + 1 } }),
    );

    options.mutate?.(scenarios);
    report.catalog = scenarios.map((s) => ({
      scenario: s.scenario,
      arms: s.arms.map((a) => a.name),
      note: s.options?.note,
    }));

    const requiredRc = [...(includeRc ? ['Drizzle RC'] : []), ...(options.includeNoJit ? ['Drizzle RC (no jit)'] : [])];
    if (requiredRc.some((name) => !scenarios.some((s) => s.arms.some((a) => a.name === name))))
      throw new Error('RC participation was required by the selected headline profile');

    // Independent driver parser: Turbine's global int8 parser must not round the oracle.
    await verifyHeadline(scenarios, {
      query: (text, values) =>
        rawPool.query({
          text,
          values,
          types: {
            getTypeParser: (oid: number, format?: string) =>
              oid === 20 ? (v: string) => v : pg.types.getTypeParser(oid, format as 'text'),
          },
        }),
    });
    const prepared = await turbinePool.query('SELECT name FROM pg_prepared_statements');
    if (!prepared.rows.length)
      throw new Error('The supplied Turbine pool did not execute native named statements during preflight.');
    console.log(`Native named statements observed on the Turbine backend: ${prepared.rows.length}.`);
    report.status = 'passed';
    if (!options.verifyOnly) {
      const bench = new Bench({ rounds, warmup });
      report.results = bench.results;
      console.log(`ROUNDS=${rounds} WARMUP=${warmup} STREAM_ROUNDS=${streamRounds} Node ${process.version}`);
      const driftHead = await bench.driftProbe(rawPool, 'head');
      let driftMid = driftHead;
      for (const [i, scenario] of scenarios.entries()) {
        if (i === 5) driftMid = await bench.driftProbe(rawPool, 'mid');
        await bench.interleave(scenario.scenario, scenario.arms, scenario.options);
      }
      const driftTail = await bench.driftProbe(rawPool, 'tail');
      bench.reportDrift([driftHead, driftMid, driftTail]);
      Object.assign(report, { driftHead, driftMid, driftTail, driftSamples: bench.probes });
    }
  } catch (error) {
    report.status = 'failed';
    report.error = String(error);
    failure = error;
  } finally {
    const clients = await Promise.allSettled([turbine.disconnect(), prisma.$disconnect()]);
    const ended = await Promise.allSettled(pools.map((pool) => pool.end()));
    const failures = [...clients, ...ended].filter((r) => r.status === 'rejected').map((r) => r.reason);
    report.cleanup.closed = failures.length === 0;
    if (failures.length) {
      report.status = 'failed';
      failure = new AggregateError([...(failure ? [failure] : []), ...failures], 'Headline execution/cleanup failed');
      report.error = [report.error, ...failures.map(String)].filter(Boolean).join('; ');
    }
    if (options.reportPath) writeFileSync(options.reportPath, `${JSON.stringify(report, null, 2)}\n`);
  }
  if (failure) throw failure;
  if (!options.verifyOnly) {
    console.log('\n=== JSON ===');
    console.log(JSON.stringify(report, null, 2));
  }
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runHeadline({ verifyOnly: process.argv.includes('--preflight'), reportPath: process.env.HEADLINE_REPORT }).catch(
    (error) => {
      console.error('Benchmark error:', error);
      process.exitCode = 1;
    },
  );
}
