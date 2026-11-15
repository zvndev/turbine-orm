/**
 * Original named/unnamed deep-offset comparison. Plans are observed, never
 * inferred from a sixth-execution rule. The original 9000 offset is retained;
 * with the original fixture its org1/published result is explicitly empty.
 */
import assert from 'node:assert/strict';
import { and, desc, eq } from 'drizzle-orm';
import * as schema from './schema.js';
import {
  assertRoute,
  DEEP_SCENARIO,
  exact,
  execute,
  fixture,
  integer,
  isMain,
  measure,
  newest,
  output,
  type RunOptions,
  type Scenario,
  type Trace,
  verify,
} from './secondary-contract.js';

const SQL =
  'SELECT "posts".* FROM "posts" WHERE "org_id" = $1 AND "published" = $2 ' +
  'ORDER BY "created_at" DESC, "id" DESC LIMIT $3 OFFSET $4';

export async function runDeepOffset(options: RunOptions = {}) {
  const rounds = integer('ROUNDS', 150);
  const warmup = integer('WARMUP', 25, 0);
  const offset = integer('OFFSET', 9000, 0);
  const url = process.env['DATABASE_URL'] ?? 'postgresql:///turbine_bench?host=/tmp';
  return execute('deepoffset', url, options, async (r, report, verifyOnly) => {
    const f = await fixture(r.pools.raw);
    report.fixture = { fingerprint: f.fingerprint, counts: f.counts };
    const matching = f.posts.filter((p) => String(p.org_id) === '1' && p.published === true).sort(newest);
    assert.equal(matching.length, 1400, 'Original published org1 fixture mismatch');
    const scenarios: Scenario[] = [...new Set([40, offset])].map((skip) => {
      const args = {
        where: { orgId: 1, published: true },
        orderBy: [{ createdAt: 'desc' as const }, { id: 'desc' as const }],
        limit: 20,
        offset: skip,
      };
      const expected = matching.slice(skip, skip + 20);
      return {
        scenario: skip === offset ? DEEP_SCENARIO : 'list, published posts in org 1, newest first (page 3)',
        expected,
        note: `offset=${skip}, limit=20, matches=${matching.length}, returned=${expected.length}. ${expected.length ? 'Complete nonempty page, ordered by createdAt DESC/id DESC.' : 'Empty page is the original workload, not evidence of full deep-page materialization.'} Named/unnamed paths and server plan counters are observed; no generic-plan promotion is assumed.`,
        arms: [
          {
            name: 'Turbine named',
            preparedName: r.turbine.posts.buildFindMany(args).preparedName,
            role: 'turbine',
            route: 'named',
            strategy: 'supplied-pool findMany with preparedStatements=true',
            fn: () => r.turbine.posts.findMany(args),
          },
          {
            name: 'Turbine forceCustomPlan',
            role: 'turbine',
            route: 'unnamed',
            strategy: 'forceCustomPlan=true, unnamed extended protocol',
            fn: () => r.turbine.posts.findMany({ ...args, forceCustomPlan: true }),
          },
          {
            name: 'raw pg (unnamed)',
            role: 'raw',
            route: 'unnamed',
            strategy: 'identical native SQL, unnamed',
            fn: async () => (await r.pools.raw.query(SQL, [1, true, 20, skip])).rows,
          },
          {
            name: 'raw pg (NAMED)',
            role: 'raw',
            route: 'named',
            strategy: 'identical native SQL, named',
            fn: async () =>
              (await r.pools.raw.query({ name: 'secondary_deep_offset', text: SQL, values: [1, true, 20, skip] })).rows,
          },
          {
            name: 'Drizzle',
            role: 'stable',
            route: 'unnamed',
            strategy: 'stable RQB, unnamed',
            fn: () =>
              r.stable.query.posts.findMany({
                where: and(eq(schema.posts.orgId, 1), eq(schema.posts.published, true)),
                orderBy: [desc(schema.posts.createdAt), desc(schema.posts.id)],
                limit: 20,
                offset: skip,
              }),
          },
          {
            name: 'Drizzle RC',
            role: 'rc',
            route: 'unnamed',
            strategy: 'RC RQB v2, JIT, unnamed',
            fn: () =>
              r.rc.query.posts.findMany({
                where: { orgId: 1, published: true },
                orderBy: { createdAt: 'desc', id: 'desc' },
                limit: 20,
                offset: skip,
              }),
          },
          {
            name: 'Prisma 7',
            role: 'prisma',
            route: 'unnamed',
            strategy: 'Prisma7 adapter-pg, unnamed',
            fn: () =>
              r.prisma.post.findMany({
                where: { orgId: 1n, published: true },
                orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
                take: 20,
                skip,
              }),
          },
        ],
      } satisfies Scenario;
    });
    options.mutate?.(scenarios);
    await verify(r, scenarios, report);
    // Warm named reuse is a correctness observation, not a performance sample.
    const reuse = [];
    for (const arm of scenarios.at(-1)!.arms) {
      const traces: Trace[] = [];
      for (let n = 0; n < 7; n++) {
        const { value, trace } = await r.observer.capture(() => arm.fn(n));
        // Empty original page is accompanied by the independently checked nonempty page above.
        exact(`prepared reuse/${arm.name}/${n}`, value, scenarios.at(-1)!.expected);
        assertRoute(trace, arm.role, arm.route);
        traces.push(trace);
      }
      const plans = (
        await r.pools[arm.role].query(
          'SELECT name, statement, generic_plans::int, custom_plans::int FROM pg_prepared_statements ORDER BY name',
        )
      ).rows;
      if (arm.route === 'named')
        assert.ok(
          plans.some((p) => p.name === traces[0]!.commands[0]!.name && p.generic_plans + p.custom_plans >= 8),
          'Named plan was not retained and reused on its backend',
        );
      reuse.push({ arm: arm.name, traces, plans });
    }
    report.planObservations = reuse;
    report.offset = offset;
    report.matchingRows = matching.length;
    report.rounds = rounds;
    report.warmup = warmup;
    r.observer.disable();
    if (!verifyOnly) {
      await measure(scenarios, report, rounds, warmup);
    }
    assert.equal((await fixture(r.pools.raw)).fingerprint, f.fingerprint, 'Deep-offset reads changed stored values');
  });
}

if (isMain(import.meta.url)) {
  runDeepOffset({ verifyOnly: process.argv.includes('--preflight'), reportPath: process.env['SECONDARY_REPORT'] })
    .then(output)
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}
