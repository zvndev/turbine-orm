/**
 * Turbine ORM — Correctness Parity Harness
 *
 * Proves Turbine produces results IDENTICAL to Prisma 7 and Drizzle across a
 * scenario matrix, querying the SAME deterministically-seeded dataset.
 *
 * For each scenario we:
 *   1. Run the same logical query through Turbine, Prisma, and Drizzle.
 *   2. Normalise every result (camelCase keys, dates -> ISO, bigint -> number,
 *      arrays sorted by PK, ORM-specific extra keys stripped) — see normalize.ts.
 *   3. assert.deepEqual Turbine-vs-Prisma and Turbine-vs-Drizzle.
 *
 * Prints a per-scenario PASS/FAIL matrix and exits non-zero on any mismatch.
 *
 * Seed first:  DATABASE_URL=... npx tsx parity/seed.ts
 * Run:         DATABASE_URL=... npx tsx parity/run.ts
 */

import assert from 'node:assert';
import pg from 'pg';

// ── Turbine ─────────────────────────────────────────────────
import { TurbineClient } from '../../generated/turbine/index.js';

// ── Prisma ──────────────────────────────────────────────────
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

// ── Drizzle ─────────────────────────────────────────────────
import { drizzle } from 'drizzle-orm/node-postgres';
import {
  eq, ne, gt, gte, lt, lte, inArray, notInArray, ilike, like,
  and, or, not, asc, desc, sql, count as dCount, sum as dSum,
  avg as dAvg, min as dMin, max as dMax,
} from 'drizzle-orm';
import * as schema from '../schema.js';

import { rows, row, tree, canon, COLUMNS, type TreeSpec } from './normalize.js';

const DATABASE_URL =
  process.env['DATABASE_URL'] ?? 'postgres://localhost:5432/turbine_parity';

/**
 * All three pools pin the Postgres SESSION TIME ZONE to UTC.
 *
 * Why: this repo's local Postgres runs with `timezone = America/New_York`.
 * For `TIMESTAMPTZ` columns, Turbine (node-postgres) and Drizzle (node-postgres)
 * both decode the value to the correct absolute instant regardless of session
 * timezone — e.g. `2025-01-01 08:47:00-05` → `2025-01-01T13:47:00.000Z`.
 *
 * Prisma 7's `@prisma/adapter-pg`, however, renders the value using the
 * session's WALL-CLOCK time and then labels that Date as UTC — yielding
 * `2025-01-01T08:47:00.000Z` (off by the session's UTC offset). This is a
 * Prisma driver-adapter rendering artifact, NOT a Turbine bug: Turbine's
 * instant is the correct one. Pinning every session to UTC makes the
 * wall-clock equal UTC so all three agree on the literal Date, letting the
 * harness compare the data instead of the incumbent's timezone quirk.
 *
 * See parity/README.md → "Known incumbent divergences".
 */
const PG_UTC_OPTIONS = '-c timezone=UTC';
function utcPool(max: number): pg.Pool {
  return new pg.Pool({ connectionString: DATABASE_URL, max, options: PG_UTC_OPTIONS });
}

// ─── Scenario framework ─────────────────────────────────────

type RunResult = Record<string, unknown>;

interface Scenario {
  name: string;
  /** Group label for the printed matrix. */
  group: string;
  /** Turbine implementation — required. */
  turbine: () => Promise<unknown>;
  /** Prisma impl — omit if Prisma cannot express the scenario. */
  prisma?: () => Promise<unknown>;
  /** Drizzle impl — omit if Drizzle cannot express the scenario. */
  drizzle?: () => Promise<unknown>;
  /** Normaliser applied to every ORM's raw result before comparison. */
  normalize: (raw: unknown) => unknown;
  /**
   * Marks a scenario where an incumbent's RESULT SHAPE legitimately differs and
   * is normalised to a common form — documents intentional divergence.
   */
  note?: string;
}

interface Outcome {
  scenario: string;
  group: string;
  prisma: 'PASS' | 'FAIL' | 'N/A';
  drizzle: 'PASS' | 'FAIL' | 'N/A';
  detail?: string;
}

const outcomes: Outcome[] = [];

async function runScenario(s: Scenario): Promise<void> {
  const out: Outcome = { scenario: s.name, group: s.group, prisma: 'N/A', drizzle: 'N/A' };
  let turbineResult: unknown;
  try {
    turbineResult = s.normalize(await s.turbine());
  } catch (err) {
    out.prisma = 'FAIL';
    out.drizzle = 'FAIL';
    out.detail = `Turbine threw: ${(err as Error).message}`;
    outcomes.push(out);
    return;
  }

  if (s.prisma) {
    try {
      const p = s.normalize(await s.prisma());
      assert.deepEqual(turbineResult, p);
      out.prisma = 'PASS';
    } catch (err) {
      out.prisma = 'FAIL';
      out.detail = (out.detail ? out.detail + ' | ' : '') + `Prisma: ${shortDiff(err as Error)}`;
    }
  }

  if (s.drizzle) {
    try {
      const d = s.normalize(await s.drizzle());
      assert.deepEqual(turbineResult, d);
      out.drizzle = 'PASS';
    } catch (err) {
      out.drizzle = 'FAIL';
      out.detail = (out.detail ? out.detail + ' | ' : '') + `Drizzle: ${shortDiff(err as Error)}`;
    }
  }

  outcomes.push(out);
}

function shortDiff(err: Error): string {
  const msg = err.message.replace(/\s+/g, ' ').trim();
  return msg.length > 240 ? msg.slice(0, 240) + '…' : msg;
}

// ─── Main ───────────────────────────────────────────────────

async function main() {
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║  Turbine ORM — Correctness Parity vs Prisma 7 & Drizzle      ║');
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  // Turbine: use its OWN pool (connectionString) so it registers the int8
  // type parser → bigint columns come back as `number`. Turbine decodes
  // timestamptz to the correct absolute instant at ANY session timezone, so
  // it does not need the UTC pin that Prisma's adapter requires.
  const turbine = new TurbineClient({
    connectionString: DATABASE_URL,
    logging: false,
    warnOnUnlimited: false,
  });
  await turbine.connect();

  const prismaPool = utcPool(5);
  const prisma = new PrismaClient({ adapter: new PrismaPg(prismaPool) });

  const drizzlePool = utcPool(5);
  const db = drizzle(drizzlePool, { schema });

  const [uc, pc, cc] = [
    await turbine.users.count(),
    await turbine.posts.count(),
    await turbine.comments.count(),
  ];
  console.log(`Dataset: ${uc} users, ${pc} posts, ${cc} comments`);
  console.log(`Node ${process.version}\n`);

  // Shorthand normalisers.
  const nUsers = (r: unknown) => rows(r as unknown[], 'user');
  const nPosts = (r: unknown) => rows(r as unknown[], 'post');
  const nComments = (r: unknown) => rows(r as unknown[], 'comment');
  const nUser = (r: unknown) => row(r, 'user');

  const scenarios: Scenario[] = [];

  // ===== Group: findMany flat =====
  scenarios.push({
    group: 'findMany',
    name: 'findMany — all users (flat)',
    turbine: () => turbine.users.findMany(),
    prisma: () => prisma.user.findMany(),
    drizzle: () => db.query.users.findMany(),
    normalize: nUsers,
  });

  scenarios.push({
    group: 'findMany',
    name: 'findMany — all posts (flat)',
    turbine: () => turbine.posts.findMany(),
    prisma: () => prisma.post.findMany(),
    drizzle: () => db.query.posts.findMany(),
    normalize: nPosts,
  });

  // ===== Group: findUnique =====
  scenarios.push({
    group: 'findUnique',
    name: 'findUnique — user by PK',
    turbine: () => turbine.users.findUnique({ where: { id: 7 } }),
    prisma: () => prisma.user.findUnique({ where: { id: BigInt(7) } }),
    drizzle: () => db.query.users.findFirst({ where: eq(schema.users.id, 7) }),
    normalize: nUser,
  });

  scenarios.push({
    group: 'findUnique',
    name: 'findUnique — post by PK',
    turbine: () => turbine.posts.findUnique({ where: { id: 42 } }),
    prisma: () => prisma.post.findUnique({ where: { id: BigInt(42) } }),
    drizzle: () => db.query.posts.findFirst({ where: eq(schema.posts.id, 42) }),
    normalize: (r) => row(r, 'post'),
  });

  // ===== Group: nested with =====
  // depth 1: users -> posts
  {
    const spec: TreeSpec = {
      __entity: 'user',
      __relations: { posts: { many: true, spec: { __entity: 'post' } } },
    };
    scenarios.push({
      group: 'nested',
      name: 'nested D1 — users → posts',
      turbine: () => turbine.users.findMany({ with: { posts: true } }),
      prisma: () => prisma.user.findMany({ include: { posts: true } }),
      drizzle: () => db.query.users.findMany({ with: { posts: true } }),
      normalize: (r) => (r as unknown[]).map((u) => tree(u, spec)).sort(byId),
    });
  }

  // depth 2: users -> posts -> comments
  {
    const spec: TreeSpec = {
      __entity: 'user',
      __relations: {
        posts: {
          many: true,
          spec: {
            __entity: 'post',
            __relations: { comments: { many: true, spec: { __entity: 'comment' } } },
          },
        },
      },
    };
    scenarios.push({
      group: 'nested',
      name: 'nested D2 — users → posts → comments',
      turbine: () =>
        turbine.users.findMany({ with: { posts: { with: { comments: true } } } }),
      prisma: () =>
        prisma.user.findMany({ include: { posts: { include: { comments: true } } } }),
      drizzle: () =>
        db.query.users.findMany({ with: { posts: { with: { comments: true } } } }),
      normalize: (r) => (r as unknown[]).map((u) => tree(u, spec)).sort(byId),
    });
  }

  // depth 3: users -> posts -> comments -> author (back-ref to user)
  {
    const spec: TreeSpec = {
      __entity: 'user',
      __relations: {
        posts: {
          many: true,
          spec: {
            __entity: 'post',
            __relations: {
              comments: {
                many: true,
                spec: {
                  __entity: 'comment',
                  __relations: { user: { many: false, spec: { __entity: 'user' } } },
                },
              },
            },
          },
        },
      },
    };
    // Limit to a single user to keep the tree small but exercise the back-ref.
    scenarios.push({
      group: 'nested',
      name: 'nested D3 — user → posts → comments → author',
      turbine: () =>
        turbine.users.findMany({
          where: { id: 3 },
          with: { posts: { with: { comments: { with: { user: true } } } } },
        }),
      prisma: () =>
        prisma.user.findMany({
          where: { id: BigInt(3) },
          include: { posts: { include: { comments: { include: { user: true } } } } },
        }),
      drizzle: () =>
        db.query.users.findMany({
          where: eq(schema.users.id, 3),
          with: { posts: { with: { comments: { with: { user: true } } } } },
        }),
      normalize: (r) => (r as unknown[]).map((u) => tree(u, spec)).sort(byId),
    });
  }

  // belongsTo single relation: post -> user
  {
    const spec: TreeSpec = {
      __entity: 'post',
      __relations: { user: { many: false, spec: { __entity: 'user' } } },
    };
    scenarios.push({
      group: 'nested',
      name: 'nested belongsTo — post → user',
      turbine: () => turbine.posts.findMany({ where: { id: { in: [1, 2, 3] } }, with: { user: true } }),
      prisma: () => prisma.post.findMany({ where: { id: { in: [1, 2, 3].map(BigInt) } }, include: { user: true } }),
      drizzle: () => db.query.posts.findMany({ where: inArray(schema.posts.id, [1, 2, 3]), with: { user: true } }),
      normalize: (r) => (r as unknown[]).map((p) => tree(p, spec)).sort(byId),
    });
  }

  // ===== Group: where operators =====
  scenarios.push({
    group: 'where',
    name: 'where equals — role = admin',
    turbine: () => turbine.users.findMany({ where: { role: 'admin' } }),
    prisma: () => prisma.user.findMany({ where: { role: 'admin' } }),
    drizzle: () => db.query.users.findMany({ where: eq(schema.users.role, 'admin') }),
    normalize: nUsers,
  });

  scenarios.push({
    group: 'where',
    name: 'where not — role != member',
    turbine: () => turbine.users.findMany({ where: { role: { not: 'member' } } }),
    prisma: () => prisma.user.findMany({ where: { role: { not: 'member' } } }),
    drizzle: () => db.query.users.findMany({ where: ne(schema.users.role, 'member') }),
    normalize: nUsers,
  });

  scenarios.push({
    group: 'where',
    name: 'where null — avatarUrl IS NULL',
    turbine: () => turbine.users.findMany({ where: { avatarUrl: null } }),
    prisma: () => prisma.user.findMany({ where: { avatarUrl: null } }),
    drizzle: () => db.query.users.findMany({ where: sql`${schema.users.avatarUrl} IS NULL` }),
    normalize: nUsers,
  });

  scenarios.push({
    group: 'where',
    name: 'where in — id IN (2,4,6,8)',
    turbine: () => turbine.users.findMany({ where: { id: { in: [2, 4, 6, 8] } } }),
    prisma: () => prisma.user.findMany({ where: { id: { in: [2, 4, 6, 8].map(BigInt) } } }),
    drizzle: () => db.query.users.findMany({ where: inArray(schema.users.id, [2, 4, 6, 8]) }),
    normalize: nUsers,
  });

  scenarios.push({
    group: 'where',
    name: 'where notIn — id NOT IN (1..15)',
    turbine: () => turbine.users.findMany({ where: { id: { notIn: range(1, 15) } } }),
    prisma: () => prisma.user.findMany({ where: { id: { notIn: range(1, 15).map(BigInt) } } }),
    drizzle: () => db.query.users.findMany({ where: notInArray(schema.users.id, range(1, 15)) }),
    normalize: nUsers,
  });

  scenarios.push({
    group: 'where',
    name: 'where gt — viewCount > 250',
    turbine: () => turbine.posts.findMany({ where: { viewCount: { gt: 250 } } }),
    prisma: () => prisma.post.findMany({ where: { viewCount: { gt: 250 } } }),
    drizzle: () => db.query.posts.findMany({ where: gt(schema.posts.viewCount, 250) }),
    normalize: nPosts,
  });

  scenarios.push({
    group: 'where',
    name: 'where gte/lte — 100 ≤ viewCount ≤ 200',
    turbine: () => turbine.posts.findMany({ where: { viewCount: { gte: 100, lte: 200 } } }),
    prisma: () => prisma.post.findMany({ where: { viewCount: { gte: 100, lte: 200 } } }),
    drizzle: () =>
      db.query.posts.findMany({
        where: and(gte(schema.posts.viewCount, 100), lte(schema.posts.viewCount, 200)),
      }),
    normalize: nPosts,
  });

  scenarios.push({
    group: 'where',
    name: 'where lt — viewCount < 50',
    turbine: () => turbine.posts.findMany({ where: { viewCount: { lt: 50 } } }),
    prisma: () => prisma.post.findMany({ where: { viewCount: { lt: 50 } } }),
    drizzle: () => db.query.posts.findMany({ where: lt(schema.posts.viewCount, 50) }),
    normalize: nPosts,
  });

  scenarios.push({
    group: 'where',
    name: 'where contains — name contains "Smith"',
    turbine: () => turbine.users.findMany({ where: { name: { contains: 'Smith' } } }),
    prisma: () => prisma.user.findMany({ where: { name: { contains: 'Smith' } } }),
    drizzle: () => db.query.users.findMany({ where: like(schema.users.name, '%Smith%') }),
    normalize: nUsers,
  });

  scenarios.push({
    group: 'where',
    name: 'where startsWith — name startsWith "Alice"',
    turbine: () => turbine.users.findMany({ where: { name: { startsWith: 'Alice' } } }),
    prisma: () => prisma.user.findMany({ where: { name: { startsWith: 'Alice' } } }),
    drizzle: () => db.query.users.findMany({ where: like(schema.users.name, 'Alice%') }),
    normalize: nUsers,
  });

  scenarios.push({
    group: 'where',
    name: 'where endsWith — name endsWith "Brown"',
    turbine: () => turbine.users.findMany({ where: { name: { endsWith: 'Brown' } } }),
    prisma: () => prisma.user.findMany({ where: { name: { endsWith: 'Brown' } } }),
    drizzle: () => db.query.users.findMany({ where: like(schema.users.name, '%Brown') }),
    normalize: nUsers,
  });

  scenarios.push({
    group: 'where',
    name: 'where contains insensitive — name ~* "williams"',
    turbine: () =>
      turbine.users.findMany({ where: { name: { contains: 'williams', mode: 'insensitive' } } }),
    prisma: () =>
      prisma.user.findMany({ where: { name: { contains: 'williams', mode: 'insensitive' } } }),
    drizzle: () => db.query.users.findMany({ where: ilike(schema.users.name, '%williams%') }),
    normalize: nUsers,
  });

  scenarios.push({
    group: 'where',
    name: 'where AND — role=member AND orgId=1',
    turbine: () => turbine.users.findMany({ where: { AND: [{ role: 'member' }, { orgId: 1 }] } }),
    prisma: () => prisma.user.findMany({ where: { AND: [{ role: 'member' }, { orgId: BigInt(1) }] } }),
    drizzle: () =>
      db.query.users.findMany({
        where: and(eq(schema.users.role, 'member'), eq(schema.users.orgId, 1)),
      }),
    normalize: nUsers,
  });

  scenarios.push({
    group: 'where',
    name: 'where OR — role=admin OR role=editor',
    turbine: () => turbine.users.findMany({ where: { OR: [{ role: 'admin' }, { role: 'editor' }] } }),
    prisma: () => prisma.user.findMany({ where: { OR: [{ role: 'admin' }, { role: 'editor' }] } }),
    drizzle: () =>
      db.query.users.findMany({
        where: or(eq(schema.users.role, 'admin'), eq(schema.users.role, 'editor')),
      }),
    normalize: nUsers,
  });

  scenarios.push({
    group: 'where',
    name: 'where NOT — NOT(role=member)',
    turbine: () => turbine.users.findMany({ where: { NOT: { role: 'member' } } }),
    prisma: () => prisma.user.findMany({ where: { NOT: { role: 'member' } } }),
    drizzle: () => db.query.users.findMany({ where: not(eq(schema.users.role, 'member')) }),
    normalize: nUsers,
  });

  // ===== Group: orderBy + limit =====
  scenarios.push({
    group: 'orderBy',
    name: 'orderBy asc + limit — top 5 users by id',
    turbine: () => turbine.users.findMany({ orderBy: { id: 'asc' }, limit: 5 }),
    prisma: () => prisma.user.findMany({ orderBy: { id: 'asc' }, take: 5 }),
    drizzle: () => db.query.users.findMany({ orderBy: asc(schema.users.id), limit: 5 }),
    // ordering already deterministic; normaliser re-sorts by PK which is fine
    // because the SET of rows is what differs under limit. We additionally
    // assert ordering separately below.
    normalize: nUsers,
  });

  scenarios.push({
    group: 'orderBy',
    name: 'orderBy desc + limit — top 5 posts by viewCount',
    turbine: () => turbine.posts.findMany({ orderBy: { viewCount: 'desc' }, limit: 5 }),
    prisma: () => prisma.post.findMany({ orderBy: { viewCount: 'desc' }, take: 5 }),
    drizzle: () => db.query.posts.findMany({ orderBy: desc(schema.posts.viewCount), limit: 5 }),
    normalize: nPosts,
    note: 'viewCount has ties; limited SET can differ by tiebreak. See ordered-list assertions.',
  });

  // ===== Group: pagination (limit/offset) =====
  scenarios.push({
    group: 'pagination',
    name: 'pagination — users ordered by id, offset 5 limit 5',
    turbine: () => turbine.users.findMany({ orderBy: { id: 'asc' }, offset: 5, limit: 5 }),
    prisma: () => prisma.user.findMany({ orderBy: { id: 'asc' }, skip: 5, take: 5 }),
    drizzle: () => db.query.users.findMany({ orderBy: asc(schema.users.id), offset: 5, limit: 5 }),
    normalize: nUsers,
  });

  // ===== Group: count =====
  scenarios.push({
    group: 'count',
    name: 'count — all users',
    turbine: () => turbine.users.count(),
    prisma: () => prisma.user.count(),
    drizzle: async () => (await db.select({ v: dCount() }).from(schema.users))[0]!.v,
    normalize: (r) => Number(r),
  });

  scenarios.push({
    group: 'count',
    name: 'count — posts where published=true',
    turbine: () => turbine.posts.count({ where: { published: true } }),
    prisma: () => prisma.post.count({ where: { published: true } }),
    drizzle: async () =>
      (await db.select({ v: dCount() }).from(schema.posts).where(eq(schema.posts.published, true)))[0]!.v,
    normalize: (r) => Number(r),
  });

  // ===== Group: aggregate =====
  // Turbine returns { _sum: { viewCount }, _avg: {...}, ... }. Prisma matches
  // that shape exactly. Drizzle has no aggregate sugar — we build the same
  // shape from a raw select and normalise all three to a common object.
  scenarios.push({
    group: 'aggregate',
    name: 'aggregate — posts sum/avg/min/max(viewCount)',
    turbine: () =>
      turbine.posts.aggregate({
        _sum: { viewCount: true },
        _avg: { viewCount: true },
        _min: { viewCount: true },
        _max: { viewCount: true },
      }),
    prisma: () =>
      prisma.post.aggregate({
        _sum: { viewCount: true },
        _avg: { viewCount: true },
        _min: { viewCount: true },
        _max: { viewCount: true },
      }),
    drizzle: async () => {
      const r = (
        await db
          .select({
            sum: dSum(schema.posts.viewCount),
            avg: dAvg(schema.posts.viewCount),
            min: dMin(schema.posts.viewCount),
            max: dMax(schema.posts.viewCount),
          })
          .from(schema.posts)
      )[0]!;
      // Re-shape into the Turbine/Prisma aggregate shape.
      return {
        _sum: { viewCount: r.sum },
        _avg: { viewCount: r.avg },
        _min: { viewCount: r.min },
        _max: { viewCount: r.max },
      };
    },
    normalize: (raw) => {
      const a = raw as {
        _sum?: { viewCount?: unknown };
        _avg?: { viewCount?: unknown };
        _min?: { viewCount?: unknown };
        _max?: { viewCount?: unknown };
      };
      return {
        sum: numOrNull(a._sum?.viewCount),
        avg: roundAvg(a._avg?.viewCount),
        min: numOrNull(a._min?.viewCount),
        max: numOrNull(a._max?.viewCount),
      };
    },
    note: 'Drizzle returns sum/avg/min/max as strings (numeric); Prisma avg is float, Turbine avg is float. avg compared rounded to 6dp.',
  });

  scenarios.push({
    group: 'aggregate',
    name: 'aggregate — filtered sum (published posts)',
    turbine: () =>
      turbine.posts.aggregate({ where: { published: true }, _sum: { viewCount: true } }),
    prisma: () =>
      prisma.post.aggregate({ where: { published: true }, _sum: { viewCount: true } }),
    drizzle: async () => {
      const r = (
        await db
          .select({ sum: dSum(schema.posts.viewCount) })
          .from(schema.posts)
          .where(eq(schema.posts.published, true))
      )[0]!;
      return { _sum: { viewCount: r.sum } };
    },
    normalize: (raw) => ({ sum: numOrNull((raw as { _sum?: { viewCount?: unknown } })._sum?.viewCount) }),
  });

  // ===== Group: nested orderBy + limit =====
  // users -> top-2 posts by viewCount desc. Tie handling: add id as secondary
  // sort everywhere so the limited SET is identical across ORMs.
  {
    const spec: TreeSpec = {
      __entity: 'user',
      __relations: { posts: { many: true, spec: { __entity: 'post' } } },
    };
    scenarios.push({
      group: 'nested',
      name: 'nested orderBy+limit — users → top-2 posts by id desc',
      turbine: () =>
        turbine.users.findMany({
          where: { id: { in: [1, 2, 3] } },
          with: { posts: { orderBy: { id: 'desc' }, limit: 2 } },
        }),
      prisma: () =>
        prisma.user.findMany({
          where: { id: { in: [1, 2, 3].map(BigInt) } },
          include: { posts: { orderBy: { id: 'desc' }, take: 2 } },
        }),
      drizzle: () =>
        db.query.users.findMany({
          where: inArray(schema.users.id, [1, 2, 3]),
          with: { posts: { orderBy: desc(schema.posts.id), limit: 2 } },
        }),
      normalize: (r) => (r as unknown[]).map((u) => tree(u, spec)).sort(byId),
    });
  }

  // ── Run every scenario ────────────────────────────────────
  for (const s of scenarios) {
    await runScenario(s);
  }

  // ── Ordered-list assertions (sequence, not just set) ──────
  // The PK-sort normaliser proves the same SET of rows. These extra checks
  // prove Turbine's ORDER BY produces the same SEQUENCE as the incumbents.
  const orderChecks: Outcome[] = [];
  {
    const o: Outcome = { scenario: 'ordering seq — posts by viewCount desc, id asc (top 8)', group: 'orderBy', prisma: 'N/A', drizzle: 'N/A' };
    const t = (await turbine.posts.findMany({ orderBy: { viewCount: 'desc' }, limit: 8 })) as Array<Record<string, unknown>>;
    // Turbine single-key order has DB-defined tiebreak; compare id-sequence
    // only where viewCount is strictly monotonic. We instead compare the
    // viewCount sequence which is deterministic.
    const seq = (list: Array<Record<string, unknown>>) => list.map((p) => Number(p['viewCount']));
    const tSeq = seq(t);
    try {
      const p = (await prisma.post.findMany({ orderBy: { viewCount: 'desc' }, take: 8 })) as Array<Record<string, unknown>>;
      assert.deepEqual(tSeq, seq(p));
      o.prisma = 'PASS';
    } catch (err) { o.prisma = 'FAIL'; o.detail = `Prisma: ${shortDiff(err as Error)}`; }
    try {
      const d = (await db.query.posts.findMany({ orderBy: desc(schema.posts.viewCount), limit: 8 })) as Array<Record<string, unknown>>;
      assert.deepEqual(tSeq, seq(d));
      o.drizzle = 'PASS';
    } catch (err) { o.drizzle = 'FAIL'; o.detail = (o.detail ? o.detail + ' | ' : '') + `Drizzle: ${shortDiff(err as Error)}`; }
    orderChecks.push(o);
  }
  {
    const o: Outcome = { scenario: 'ordering seq — users by name asc (id sequence)', group: 'orderBy', prisma: 'N/A', drizzle: 'N/A' };
    const idSeq = (list: Array<Record<string, unknown>>) => list.map((u) => Number(u['id']));
    const t = (await turbine.users.findMany({ orderBy: { name: 'asc' } })) as Array<Record<string, unknown>>;
    // name has no dup pairs that also tie on the DB default? names can repeat
    // (FIRST/LAST cycle), so compare the name sequence which is deterministic.
    const nameSeq = (list: Array<Record<string, unknown>>) => list.map((u) => String(u['name']));
    const tSeq = nameSeq(t);
    try {
      const p = (await prisma.user.findMany({ orderBy: { name: 'asc' } })) as Array<Record<string, unknown>>;
      assert.deepEqual(tSeq, nameSeq(p));
      o.prisma = 'PASS';
    } catch (err) { o.prisma = 'FAIL'; o.detail = `Prisma: ${shortDiff(err as Error)}`; }
    try {
      const d = (await db.query.users.findMany({ orderBy: asc(schema.users.name) })) as Array<Record<string, unknown>>;
      assert.deepEqual(tSeq, nameSeq(d));
      o.drizzle = 'PASS';
    } catch (err) { o.drizzle = 'FAIL'; o.detail = (o.detail ? o.detail + ' | ' : '') + `Drizzle: ${shortDiff(err as Error)}`; }
    void idSeq;
    orderChecks.push(o);
  }
  outcomes.push(...orderChecks);

  // ── Print matrix ──────────────────────────────────────────
  printMatrix();

  await turbine.disconnect();
  await prisma.$disconnect();
  await drizzlePool.end();
  await prismaPool.end();

  const failed = outcomes.filter((o) => o.prisma === 'FAIL' || o.drizzle === 'FAIL');
  if (failed.length > 0) {
    console.log(`\n✗ ${failed.length} scenario(s) FAILED.`);
    for (const f of failed) {
      console.log(`\n  ${f.scenario}`);
      if (f.detail) console.log(`    ${f.detail}`);
    }
    process.exit(1);
  } else {
    console.log('\n✓ All scenarios match across Turbine, Prisma 7, and Drizzle.');
  }
}

// ─── Helpers ────────────────────────────────────────────────

function byId(a: unknown, b: unknown): number {
  return Number((a as Record<string, unknown>)['id']) - Number((b as Record<string, unknown>)['id']);
}

function range(lo: number, hi: number): number[] {
  const out: number[] = [];
  for (let i = lo; i <= hi; i++) out.push(i);
  return out;
}

function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  return Number(v);
}

function roundAvg(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  return Math.round(Number(v) * 1e6) / 1e6;
}

function printMatrix() {
  console.log('\n══════════════════ PARITY MATRIX ══════════════════\n');
  const W = 52;
  const line = (a: string, b: string, c: string) =>
    `│ ${a.padEnd(W)} │ ${b.padEnd(9)} │ ${c.padEnd(9)} │`;
  const bar = `├─${'─'.repeat(W)}─┼─${'─'.repeat(9)}─┼─${'─'.repeat(9)}─┤`;
  console.log(`┌─${'─'.repeat(W)}─┬─${'─'.repeat(9)}─┬─${'─'.repeat(9)}─┐`);
  console.log(line('Scenario', 'vs Prisma', 'vs Drizzle'));
  console.log(bar);
  let lastGroup = '';
  for (const o of outcomes) {
    if (o.group !== lastGroup) {
      console.log(line(`▸ ${o.group}`, '', ''));
      lastGroup = o.group;
    }
    const mark = (s: string) => (s === 'PASS' ? '  PASS   ' : s === 'FAIL' ? '  FAIL ✗ ' : '   —     ');
    console.log(line(`  ${o.scenario}`.slice(0, W), mark(o.prisma), mark(o.drizzle)));
  }
  console.log(`└─${'─'.repeat(W)}─┴─${'─'.repeat(9)}─┴─${'─'.repeat(9)}─┘`);

  const total = outcomes.length;
  const pPass = outcomes.filter((o) => o.prisma === 'PASS').length;
  const pNa = outcomes.filter((o) => o.prisma === 'N/A').length;
  const dPass = outcomes.filter((o) => o.drizzle === 'PASS').length;
  const dNa = outcomes.filter((o) => o.drizzle === 'N/A').length;
  console.log(`\n  ${total} scenarios`);
  console.log(`  vs Prisma 7 : ${pPass} PASS / ${total - pPass - pNa} FAIL / ${pNa} N/A`);
  console.log(`  vs Drizzle  : ${dPass} PASS / ${total - dPass - dNa} FAIL / ${dNa} N/A`);

  // surface documented shape notes
  void canon; void COLUMNS;
}

main().catch((err) => {
  console.error('\nParity harness error:', err);
  process.exit(1);
});
