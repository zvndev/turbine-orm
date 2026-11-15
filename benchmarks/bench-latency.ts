/** Original latency topology: TCP delay proxy -> PG Unix socket, including RTT0. */
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { asc, count, desc, eq, sql as stableSql } from 'drizzle-orm';
import { count as rcCount, eq as rcEq, sql as rcSql } from 'drizzle-rc';
import pg from 'pg';
import { summarizeSamples } from './bench-harness.js';
import * as schema from './schema.js';
import * as rcSchema from './schema-rc.js';
import {
  execute,
  expectedDashboard,
  fixture,
  integer,
  isMain,
  LATENCY_SCENARIOS,
  measure,
  output,
  type Report,
  type Resources,
  type RunOptions,
  type Scenario,
  verify,
} from './secondary-contract.js';
import { startDelayProxy } from './secondary-proxy.js';

export async function transactionFailureControls(r: Resources) {
  const result = [];
  for (const role of ['turbine', 'prisma', 'stable', 'rc', 'raw'] as const) {
    const fail = async (query: (sql: string) => Promise<unknown>) => {
      await query(
        "INSERT INTO bench_writes(id,org_id,slug,label,amount) OVERRIDING SYSTEM VALUE VALUES (-70001,1,'secondary-rollback','rollback',17)",
      );
      await query('SELECT 1/0');
    };
    assert.equal(
      (await r.pools.raw.query('SELECT count(*)::int AS n FROM bench_writes WHERE id=-70001')).rows[0]!.n,
      0,
      'Rollback sentinel collision',
    );
    const { trace } = await r.observer.capture(async () => {
      await assert.rejects(
        async () => {
          if (role === 'turbine') await r.turbine.$transaction(async (tx) => fail((sql) => tx.rawUnsafe(sql)));
          else if (role === 'prisma') await r.prisma.$transaction(async (tx) => fail((sql) => tx.$queryRawUnsafe(sql)));
          else if (role === 'stable')
            await r.stable.transaction(async (tx) => fail((sql) => tx.execute(stableSql.raw(sql))));
          else if (role === 'rc') await r.rc.transaction(async (tx) => fail((sql) => tx.execute(rcSql.raw(sql))));
          else {
            const client = await r.pools.raw.connect();
            try {
              await client.query('BEGIN');
              await fail((sql) => client.query(sql));
              await client.query('COMMIT');
            } catch (error) {
              await client.query('ROLLBACK');
              throw error;
            } finally {
              client.release();
            }
          }
        },
        (error: unknown) => {
          let current = error;
          for (let n = 0; n < 8 && current; n++) {
            if (/division by zero|22012/.test(String(current))) return true;
            current = (current as { cause?: unknown }).cause;
          }
          return false;
        },
      );
    });
    assert.ok(
      trace.commands.some((c) => c.sql === 'SELECT 1/0' && c.error),
      'Transaction fault never reached PostgreSQL',
    );
    assert.match(trace.commands.at(-1)!.sql, /^rollback/i, 'Failed transaction did not roll back');
    const client = await r.pools[role].connect();
    try {
      assert.equal(
        (await client.query('SELECT 42 AS n')).rows[0]!.n,
        42,
        'Pool was returned in an aborted transaction',
      );
    } finally {
      client.release();
    }
    assert.equal(
      (await r.pools.raw.query('SELECT count(*)::int AS n FROM bench_writes WHERE id=-70001')).rows[0]!.n,
      0,
      'Failed transaction persisted its write',
    );
    result.push({ role, passed: true, restoredSentinelId: -70001, trace });
  }
  const write = r.turbine.users.buildCount();
  write.sql =
    "INSERT INTO bench_writes(id,org_id,slug,label,amount) OVERRIDING SYSTEM VALUE VALUES (-70003,1,'secondary-pipeline-rollback','rollback',19)";
  write.params = [];
  write.tag = 'benchWrites.create';
  const bad = r.turbine.users.buildCount();
  bad.sql = 'SELECT 1/0';
  bad.params = [];
  const { trace } = await r.observer.capture(async () => {
    await assert.rejects(r.turbine.pipeline(write, bad), /division by zero|22012/);
  });
  assert.ok(
    trace.completions.some((c) => c.tag === 'INSERT 0 1'),
    'Pipeline failure control never wrote its sentinel',
  );
  assert.ok(
    trace.completions.some((c) => c.tag === 'ROLLBACK'),
    'Failed pipeline did not roll back',
  );
  assert.equal(
    (await r.pools.raw.query('SELECT count(*)::int AS n FROM bench_writes WHERE id=-70003')).rows[0]!.n,
    0,
    'Failed pipeline persisted its write',
  );
  await r.pools.turbine.query('SELECT 42');
  result.push({ role: 'turbine', passed: true, restoredSentinelId: -70003, trace });
  const idle = (
    await r.pools.raw.query(
      "SELECT pid FROM pg_stat_activity WHERE pid=ANY($1::int[]) AND state LIKE 'idle in transaction%'",
      [[...r.observer.pids]],
    )
  ).rows;
  assert.deepEqual(idle, [], 'Transaction controls left an idle transaction');
  return result;
}

export async function proxyFailureControl(socketPath: string) {
  const proxy = await startDelayProxy(socketPath, 25);
  const pool = new pg.Pool({
    host: '127.0.0.1',
    port: proxy.port,
    database: process.env['PGDATABASE'] ?? 'turbine_bench',
    user: process.env['PGUSER'] ?? process.env['USER'],
    max: 1,
    connectionTimeoutMillis: 3000,
  });
  try {
    await pool.query('SELECT 1');
    const client = await pool.connect();
    client.on('error', () => {}); // The forced transport failure also emits on the checked-out client.
    try {
      await client.query('BEGIN');
      await client.query(
        "INSERT INTO bench_writes(id,org_id,slug,label,amount) OVERRIDING SYSTEM VALUE VALUES (-70002,1,'secondary-proxy-rollback','rollback',23)",
      );
      const failed = client.query('SELECT pg_sleep(1)');
      // The promise rejection handler is installed before breaking the transport.
      const rejection = assert.rejects(failed, /connection|terminated|closed|ECONNRESET/i);
      proxy.disconnect();
      await rejection;
    } finally {
      client.release(true);
    }
    assert.equal(
      (await pool.query('SELECT count(*)::int AS n FROM bench_writes WHERE id=-70002')).rows[0]!.n,
      0,
      'Transport failure persisted an uncommitted write',
    );
  } finally {
    await pool.end();
    await proxy.close();
  }
  return proxy.facts();
}

export async function runLatency(options: RunOptions = {}): Promise<Report> {
  const rtts = (process.env['RTTS'] ?? '0,1,5,25').split(',').map(Number);
  assert.deepEqual(rtts, [0, 1, 5, 25], 'Original latency catalog requires RTT0/1/5/25');
  const rounds = integer('ROUNDS', 25);
  const warmup = integer('WARMUP', 3, 0);
  const socket = process.env['PGSOCKET'] ?? '/tmp/.s.PGSQL.5432';
  const database = process.env['PGDATABASE'] ?? 'turbine_bench';
  const user = process.env['PGUSER'] ?? process.env['USER'] ?? 'postgres';
  const reports: Report[] = [];
  let current: Report | undefined;
  let failure: unknown;
  try {
    for (const rtt of rtts) {
      const proxy = await startDelayProxy(socket, rtt);
      try {
        const url = `postgresql://${encodeURIComponent(user)}@127.0.0.1:${proxy.port}/${encodeURIComponent(database)}`;
        current = await execute(
          'latency',
          url,
          { ...options, reportPath: undefined },
          async (r, report, verifyOnly) => {
            // Capture the report even when execute throws, so finally can retain cleanup facts.
            current = report;
            report.rttMs = rtt;
            report.topology =
              'TCP proxy to native Unix socket; half RTT per direction, no bandwidth/jitter model; RTT0 includes proxy cost';
            const f = await fixture(r.pools.raw);
            report.fixture = { fingerprint: f.fingerprint, counts: f.counts };
            const roots = f.users.slice(0, 50);
            const nested = roots.map((u) => ({
              ...u,
              posts: f.posts.filter((p) => String(p.user_id) === String(u.id)),
            }));
            const countScalar = (rows: { v: number }[]) => {
              assert.equal(rows.length, 1);
              return rows[0]!.v;
            };
            const rawDashboard = async () => {
              const client = await r.pools.raw.connect();
              try {
                await client.query('BEGIN');
                const user = (await client.query('SELECT * FROM users WHERE id=$1', [1])).rows[0];
                const posts = (await client.query('SELECT count(*)::int AS v FROM posts WHERE user_id=$1', [1]))
                  .rows[0]!.v;
                const comments = (await client.query('SELECT count(*)::int AS v FROM comments WHERE user_id=$1', [1]))
                  .rows[0]!.v;
                const recent = (
                  await client.query(
                    'SELECT * FROM posts WHERE user_id=$1 ORDER BY created_at DESC,id DESC LIMIT $2',
                    [1, 5],
                  )
                ).rows;
                const users = (await client.query('SELECT count(*)::int AS v FROM users')).rows[0]!.v;
                await client.query('COMMIT');
                return [user, posts, comments, recent, users];
              } catch (error) {
                await client.query('ROLLBACK');
                throw error;
              } finally {
                client.release();
              }
            };
            const scenarios: Scenario[] = [
              {
                scenario: LATENCY_SCENARIOS[0],
                expected: f.users[0],
                note: 'Complete unique row, same PK predicate and supplied pg pool profile.',
                arms: [
                  {
                    name: 'Turbine',
                    preparedName: r.turbine.users.buildFindUnique({ where: { id: 1 } }).preparedName,
                    role: 'turbine',
                    route: 'named',
                    strategy: 'findUnique, named',
                    fn: () => r.turbine.users.findUnique({ where: { id: 1 } }),
                  },
                  {
                    name: 'Prisma 7',
                    role: 'prisma',
                    route: 'read',
                    strategy: 'Prisma7 adapter-pg',
                    fn: () => r.prisma.user.findUnique({ where: { id: 1n } }),
                  },
                  {
                    name: 'Drizzle',
                    role: 'stable',
                    route: 'read',
                    strategy: 'stable RQB',
                    fn: () => r.stable.query.users.findFirst({ where: eq(schema.users.id, 1) }),
                  },
                  {
                    name: 'Drizzle RC',
                    role: 'rc',
                    route: 'read',
                    strategy: 'RC RQB v2, JIT',
                    fn: () => r.rc.query.users.findFirst({ where: { id: 1 } }),
                  },
                  {
                    name: 'Raw',
                    role: 'raw',
                    route: 'unnamed',
                    strategy: 'native pg unnamed',
                    fn: async () => (await r.pools.raw.query('SELECT * FROM users WHERE id=$1', [1])).rows[0],
                  },
                ],
              },
              {
                scenario: LATENCY_SCENARIOS[1],
                expected: nested,
                note: 'First 50 users by id, every full post by id. Join/batched/auto and Prisma join/query remain separate strategies.',
                arms: [
                  ...(['join', 'batched', 'auto'] as const).map((strategy) => ({
                    name: `Turbine ${strategy}`,
                    role: 'turbine' as const,
                    route: (strategy === 'batched' ? 'batched' : 'join') as 'batched' | 'join',
                    strategy: `Turbine ${strategy}`,
                    fn: () =>
                      r.turbine.users.findMany({
                        limit: 50,
                        orderBy: { id: 'asc' },
                        with: { posts: { orderBy: { id: 'asc' } } },
                        relationLoadStrategy: strategy,
                      }),
                  })),
                  ...(['join', 'query'] as const).map((strategy) => ({
                    name: strategy === 'join' ? 'Prisma 7' : 'Prisma 7 query',
                    role: 'prisma' as const,
                    route: (strategy === 'join' ? 'join' : 'batched') as 'join' | 'batched',
                    strategy: `Prisma ${strategy}`,
                    fn: () =>
                      r.prisma.user.findMany({
                        take: 50,
                        orderBy: { id: 'asc' },
                        include: { posts: { orderBy: { id: 'asc' } } },
                        relationLoadStrategy: strategy,
                      }),
                  })),
                  {
                    name: 'Drizzle',
                    role: 'stable',
                    route: 'join',
                    strategy: 'stable RQB lateral join',
                    fn: () =>
                      r.stable.query.users.findMany({
                        limit: 50,
                        orderBy: asc(schema.users.id),
                        with: { posts: { orderBy: asc(schema.posts.id) } },
                      }),
                  },
                  {
                    name: 'Drizzle RC',
                    role: 'rc',
                    route: 'join',
                    strategy: 'RC RQB v2 JIT',
                    fn: () =>
                      r.rc.query.users.findMany({
                        limit: 50,
                        orderBy: { id: 'asc' },
                        with: { posts: { orderBy: { id: 'asc' } } },
                      }),
                  },
                  {
                    name: 'Raw',
                    role: 'raw',
                    route: 'join',
                    strategy: 'native pg lateral JSON join',
                    fn: async () =>
                      (
                        await r.pools.raw.query(
                          `SELECT u.*, COALESCE(p.posts,'[]'::json) posts
                FROM (SELECT * FROM users ORDER BY id ASC LIMIT $1) u
                LEFT JOIN LATERAL (SELECT json_agg(row_to_json(p) ORDER BY p.id ASC) posts FROM posts p WHERE p.user_id=u.id) p ON true ORDER BY u.id ASC`,
                          [50],
                        )
                      ).rows,
                  },
                ],
              },
              {
                scenario: LATENCY_SCENARIOS[2],
                expected: expectedDashboard(f),
                note: 'Five complete ordered values. Turbine pipeline is one extended-protocol flush with BEGIN/five reads/COMMIT; transaction arms pay BEGIN/five reads/COMMIT. Transport costs are strategy costs, not five equivalent wire routes.',
                arms: [
                  {
                    name: 'Turbine pipeline',
                    role: 'turbine',
                    route: 'pipeline',
                    strategy: 'five reads in one extended-protocol pipeline',
                    fn: () =>
                      r.turbine.pipeline(
                        r.turbine.users.buildFindUnique({ where: { id: 1 } }),
                        r.turbine.posts.buildCount({ where: { userId: 1 } }),
                        r.turbine.comments.buildCount({ where: { userId: 1 } }),
                        r.turbine.posts.buildFindMany({
                          where: { userId: 1 },
                          orderBy: { createdAt: 'desc', id: 'desc' },
                          limit: 5,
                        }),
                        r.turbine.users.buildCount(),
                      ),
                  },
                  {
                    name: 'Prisma 7 $tx',
                    role: 'prisma',
                    route: 'transaction',
                    strategy: 'Prisma7 array transaction',
                    fn: () =>
                      r.prisma.$transaction([
                        r.prisma.user.findUnique({ where: { id: 1n } }),
                        r.prisma.post.count({ where: { userId: 1n } }),
                        r.prisma.comment.count({ where: { userId: 1n } }),
                        r.prisma.post.findMany({
                          where: { userId: 1n },
                          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
                          take: 5,
                        }),
                        r.prisma.user.count(),
                      ]),
                  },
                  {
                    name: 'Drizzle tx',
                    role: 'stable',
                    route: 'transaction',
                    strategy: 'stable native transaction',
                    fn: () =>
                      r.stable.transaction(async (tx) => [
                        await tx.query.users.findFirst({ where: eq(schema.users.id, 1) }),
                        countScalar(
                          await tx.select({ v: count() }).from(schema.posts).where(eq(schema.posts.userId, 1)),
                        ),
                        countScalar(
                          await tx.select({ v: count() }).from(schema.comments).where(eq(schema.comments.userId, 1)),
                        ),
                        await tx.query.posts.findMany({
                          where: eq(schema.posts.userId, 1),
                          orderBy: [desc(schema.posts.createdAt), desc(schema.posts.id)],
                          limit: 5,
                        }),
                        countScalar(await tx.select({ v: count() }).from(schema.users)),
                      ]),
                  },
                  {
                    name: 'Drizzle RC tx',
                    role: 'rc',
                    route: 'transaction',
                    strategy: 'RC native transaction and RQB v2 JIT',
                    fn: () =>
                      r.rc.transaction(async (tx) => [
                        await tx.query.users.findFirst({ where: { id: 1 } }),
                        countScalar(
                          await tx.select({ v: rcCount() }).from(rcSchema.posts).where(rcEq(rcSchema.posts.userId, 1)),
                        ),
                        countScalar(
                          await tx
                            .select({ v: rcCount() })
                            .from(rcSchema.comments)
                            .where(rcEq(rcSchema.comments.userId, 1)),
                        ),
                        await tx.query.posts.findMany({
                          where: { userId: 1 },
                          orderBy: { createdAt: 'desc', id: 'desc' },
                          limit: 5,
                        }),
                        countScalar(await tx.select({ v: rcCount() }).from(rcSchema.users)),
                      ]),
                  },
                  {
                    name: 'Raw tx',
                    role: 'raw',
                    route: 'transaction',
                    strategy: 'native pg transaction',
                    fn: rawDashboard,
                  },
                ],
              },
            ];
            options.mutate?.(scenarios);
            await verify(r, scenarios, report);
            // Correctness probes, not a timing campaign. Connection startup is excluded.
            await r.pools.raw.query('SELECT 1');
            const probes = [];
            for (let i = 0; i < 5; i++) {
              const start = performance.now();
              await r.pools.raw.query('SELECT 1');
              probes.push(performance.now() - start);
            }
            const probeStats = summarizeSamples(
              'raw transport diagnostic',
              probes,
              process.env.BENCH_RETAIN_SAMPLES === '1',
            );
            const measured = probeStats.median;
            assert.ok(rtt === 0 || measured >= rtt * 0.7, 'Injected RTT did not reach the wire');
            report.transportProbe = {
              n: 5,
              medianMs: measured,
              injectedRttMs: rtt,
              diagnosticOnly: true,
              samples: probeStats,
            };
            report.failureControls = await transactionFailureControls(r);
            r.observer.disable();
            if (!verifyOnly) {
              await measure(scenarios, report, rounds, warmup);
            }
            assert.equal(
              (await fixture(r.pools.raw)).fingerprint,
              f.fingerprint,
              'Latency suite changed stored values',
            );
          },
        );
      } catch (error) {
        failure = error;
      } finally {
        const facts = await proxy.close();
        if (current) {
          current.proxyCleanup = facts;
          reports.push(current);
        }
      }
      if (failure) break;
    }
    if (!failure && current) current.proxyFailureControl = await proxyFailureControl(socket);
  } catch (error) {
    failure = error;
  }
  assert.ok(current, 'Latency setup failed before a report could be created');
  const report: Report = {
    ...current,
    suite: 'latency',
    status: failure ? 'failed' : 'passed',
    rtts,
    rounds,
    warmup,
    verified: reports.flatMap((r) => r.verified.map((v) => ({ ...v, rttMs: r.rttMs }))),
    results: reports.flatMap((r) => r.results.map((s) => ({ ...s, rttMs: r.rttMs }))),
    runs: reports,
    cleanup: {
      closed: reports.every((r) => r.cleanup.closed && (r.proxyCleanup as { closed: boolean }).closed),
      sessionPids: reports.flatMap((r) => r.cleanup.sessionPids),
    },
    ...(failure ? { error: String(failure) } : {}),
  };
  if (options.reportPath) writeFileSync(options.reportPath, `${JSON.stringify(report, null, 2)}\n`);
  if (failure) throw failure;
  return report;
}

if (isMain(import.meta.url)) {
  runLatency({ verifyOnly: process.argv.includes('--preflight'), reportPath: process.env['SECONDARY_REPORT'] })
    .then(output)
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}
