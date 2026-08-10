/**
 * Deep pagination and the generic-plan cliff.
 *
 * `bench-extended.ts` shows Turbine losing the deep-offset list scenario to
 * both Prisma and Drizzle (0.549 ms against 0.318 and 0.341), while WINNING the
 * same query at offset 40. The emitted SQL is equivalent in all three, so the
 * statement generator is not the explanation. This isolates the real one.
 *
 * Turbine names its prepared statements. That is what wins the hot small-query
 * scenarios: node-postgres skips `Parse` only for a statement already parsed BY
 * NAME. The cost is that PostgreSQL promotes a named statement to a value-blind
 * GENERIC plan on its sixth execution, and with `OFFSET` bound as a parameter
 * the generic plan cannot know the offset is 9,000.
 *
 * The two raw `pg` arms are the control that settles it: the SAME hand-written
 * SQL, named and unnamed. If naming is the cause, the raw named arm reproduces
 * the loss with no ORM involved at all. It does.
 *
 * Run:
 *   npx tsx deepoffset.ts
 */

import pg from 'pg';
import { TurbineClient } from '../generated/turbine/index.js';
import { median } from './bench-harness.js';

const DATABASE_URL = process.env['DATABASE_URL'] ?? 'postgresql:///turbine_bench_066?host=/tmp';
const ROUNDS = parseInt(process.env['ROUNDS'] ?? '150', 10);
const OFFSET = parseInt(process.env['OFFSET'] ?? '9000', 10);

const SQL =
  'SELECT "posts".* FROM "posts" WHERE "org_id" = $1 AND "published" = $2 ' +
  'ORDER BY "created_at" DESC, "id" DESC LIMIT $3 OFFSET $4';

async function main(): Promise<void> {
  const db = new TurbineClient({ connectionString: DATABASE_URL, logging: false });
  await db.connect();
  const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 4 });

  const args = (force?: boolean) =>
    ({
      where: { orgId: 1, published: true },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      limit: 20,
      offset: OFFSET,
      ...(force ? { forceCustomPlan: true } : {}),
    }) as never;

  const arms = [
    { name: 'Turbine named (default)', fn: () => db.posts.findMany(args()) },
    { name: 'Turbine forceCustomPlan', fn: () => db.posts.findMany(args(true)) },
    { name: 'raw pg (unnamed)', fn: () => pool.query(SQL, [1, true, 20, OFFSET]) },
    {
      name: 'raw pg (NAMED)',
      // A name is all that separates this from the arm above. node-postgres
      // sends `Parse` once for a named statement and reuses it, which is
      // exactly the condition PostgreSQL's generic-plan promotion needs.
      fn: () => pool.query({ name: 'deep_offset_probe', text: SQL, values: [1, true, 20, OFFSET] }),
    },
  ];

  for (const a of arms) for (let i = 0; i < 25; i++) await a.fn();
  const samples = new Map<string, number[]>(arms.map((a) => [a.name, []]));
  for (let r = 0; r < ROUNDS; r++) {
    for (let k = 0; k < arms.length; k++) {
      const a = arms[(r + k) % arms.length]!;
      const t = performance.now();
      await a.fn();
      samples.get(a.name)!.push(performance.now() - t);
    }
  }

  console.log(`offset=${OFFSET} rounds=${ROUNDS}\n`);
  console.log('arm                        median(ms)');
  for (const a of arms) {
    console.log(`${a.name.padEnd(26)} ${median(samples.get(a.name)!.sort((x, y) => x - y)).toFixed(3).padStart(8)}`);
  }

  await db.disconnect();
  await pool.end();
}

await main();
