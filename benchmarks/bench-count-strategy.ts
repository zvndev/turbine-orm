/**
 * Measure the two plans for a `with: { _count: ... }` read.
 *
 * INLINE  (`relationLoadStrategy: 'join'`)    , one correlated
 *   `(SELECT COUNT(*) FROM child WHERE child.fk = parent.pk)` scalar subquery in
 *   the parent SELECT list, re-evaluated PER PARENT ROW.
 * BATCHED (`relationLoadStrategy: 'batched'`) , the parent query, then ONE
 *   `SELECT fk, COUNT(*) FROM child WHERE fk = ANY($1) GROUP BY fk` follow-up,
 *   stitched client-side. One extra round trip, one grouped scan.
 *
 * Sweeps parent-set size, child FK indexed vs unindexed, and child-row
 * distribution (uniform vs skewed). The two plans are INTERLEAVED inside each
 * cell with the order rotated per round so background load cannot bias one.
 *
 * Seed first (see benchmarks/seed-count.ts), then:
 *   DATABASE_URL=postgres://postgres:postgres@localhost:55501/countbench \
 *     npx tsx benchmarks/bench-count-strategy.ts
 *
 * Env knobs: ROUNDS (default 11), WARMUP (2), CELL_BUDGET_MS (90000),
 * MIN_ROUNDS (5), SIZES (comma list).
 */

import pg from 'pg';
import { TurbineClient } from '../src/client.js';
import { introspect } from '../src/introspect.js';

const DATABASE_URL = process.env['DATABASE_URL'] ?? 'postgres://postgres:postgres@localhost:55501/countbench';
const ROUNDS = Number(process.env['ROUNDS'] ?? 11);
const WARMUP = Number(process.env['WARMUP'] ?? 2);
const MIN_ROUNDS = Number(process.env['MIN_ROUNDS'] ?? 5);
const CELL_BUDGET_MS = Number(process.env['CELL_BUDGET_MS'] ?? 90_000);
const SIZES = (process.env['SIZES'] ?? '1,10,30,100,1000,10000').split(',').map(Number);

type Plan = 'join' | 'batched';

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  return n % 2 ? s[(n - 1) / 2]! : (s[n / 2 - 1]! + s[n / 2]!) / 2;
}

function iqr(xs: number[]): [number, number] {
  const s = [...xs].sort((a, b) => a - b);
  const at = (f: number) => s[Math.min(s.length - 1, Math.max(0, Math.round(f * (s.length - 1))))]!;
  return [at(0.25), at(0.75)];
}

function fmt(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${ms.toFixed(1)}ms`;
}

interface Cell {
  dist: string;
  indexed: boolean;
  parents: number;
  join: number;
  batched: number;
  joinN: number;
  batchedN: number;
  joinIqr: [number, number];
  batchedIqr: [number, number];
  joinStmts: number;
  batchedStmts: number;
  rows: number;
}

async function main() {
  const admin = new pg.Pool({ connectionString: DATABASE_URL, max: 2 });
  const schema = await introspect({ connectionString: DATABASE_URL });

  const parentMeta = schema.tables['item_type'];
  if (!parentMeta) throw new Error('item_type not found, run seed-count.ts first');

  // Discover the two hasMany relation names introspection derived.
  const relFor = (childTable: string): string => {
    for (const [name, rel] of Object.entries(parentMeta.relations)) {
      if (rel.type === 'hasMany' && rel.to === childTable) return name;
    }
    throw new Error(`no hasMany relation from item_type to ${childTable}`);
  };
  const dists = [
    { label: 'uniform', table: 'inventory_item', rel: relFor('inventory_item'), index: 'idx_inv_item_type_id' },
    { label: 'skewed', table: 'inventory_hot', rel: relFor('inventory_hot'), index: 'idx_inv_hot_type_id' },
  ];

  const db = new TurbineClient({ connectionString: DATABASE_URL, poolSize: 4 }, schema);
  await db.connect();

  let stmts = 0;
  db.$on('query', () => {
    stmts++;
  });

  console.log(`_count plan sweep. ROUNDS=${ROUNDS} WARMUP=${WARMUP} MIN_ROUNDS=${MIN_ROUNDS}`);
  console.log(`cell budget ${CELL_BUDGET_MS}ms per arm. Node ${process.version}`);
  console.log(`relations: ${dists.map((d) => `${d.label}=${d.rel}`).join(', ')}\n`);

  const cells: Cell[] = [];

  for (const dist of dists) {
    for (const indexed of [true, false]) {
      if (indexed) {
        await admin.query(`CREATE INDEX IF NOT EXISTS ${dist.index} ON ${dist.table} (type_id)`);
      } else {
        await admin.query(`DROP INDEX IF EXISTS ${dist.index}`);
      }
      await admin.query(`ANALYZE ${dist.table}`);

      for (const parents of SIZES) {
        const run = async (plan: Plan): Promise<{ ms: number; rows: number; stmts: number }> => {
          const before = stmts;
          const t = performance.now();
          const rows = (await db.table('item_type').findMany({
            limit: parents,
            orderBy: { id: 'asc' },
            with: { _count: { [dist.rel]: true } } as never,
            relationLoadStrategy: plan,
          })) as unknown[];
          return { ms: performance.now() - t, rows: rows.length, stmts: stmts - before };
        };

        for (let i = 0; i < WARMUP; i++) {
          await run('join');
          await run('batched');
        }

        const times: Record<Plan, number[]> = { join: [], batched: [] };
        const stmtsSeen: Record<Plan, number> = { join: 0, batched: 0 };
        let rows = 0;
        const spent: Record<Plan, number> = { join: 0, batched: 0 };

        for (let r = 0; r < ROUNDS; r++) {
          const order: Plan[] = r % 2 === 0 ? ['join', 'batched'] : ['batched', 'join'];
          for (const plan of order) {
            if (times[plan].length >= MIN_ROUNDS && spent[plan] > CELL_BUDGET_MS) continue;
            const res = await run(plan);
            times[plan].push(res.ms);
            spent[plan] += res.ms;
            stmtsSeen[plan] = res.stmts;
            rows = res.rows;
          }
        }

        const cell: Cell = {
          dist: dist.label,
          indexed,
          parents,
          join: median(times.join),
          batched: median(times.batched),
          joinN: times.join.length,
          batchedN: times.batched.length,
          joinIqr: iqr(times.join),
          batchedIqr: iqr(times.batched),
          joinStmts: stmtsSeen.join,
          batchedStmts: stmtsSeen.batched,
          rows,
        };
        cells.push(cell);
        const winner = cell.batched < cell.join ? 'BATCHED' : 'INLINE';
        const ratio = Math.max(cell.join, cell.batched) / Math.min(cell.join, cell.batched);
        console.log(
          `${dist.label.padEnd(8)} ${(indexed ? 'indexed' : 'UNINDEXED').padEnd(10)} ` +
            `parents=${String(parents).padStart(6)} rows=${String(cell.rows).padStart(6)}  ` +
            `inline=${fmt(cell.join).padStart(9)} (n=${cell.joinN})  ` +
            `batched=${fmt(cell.batched).padStart(9)} (n=${cell.batchedN})  ` +
            `${winner} ${ratio.toFixed(2)}x  stmts ${cell.joinStmts}/${cell.batchedStmts}`,
        );
      }
    }
  }

  console.log('\n\n## Full table (medians)\n');
  console.log(
    '| dist | fk index | parents | rows | inline median | inline IQR | n | batched median | batched IQR | n | winner | ratio |',
  );
  console.log('|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const c of cells) {
    const winner = c.batched < c.join ? 'batched' : 'inline';
    const ratio = Math.max(c.join, c.batched) / Math.min(c.join, c.batched);
    console.log(
      `| ${c.dist} | ${c.indexed ? 'yes' : 'no'} | ${c.parents} | ${c.rows} | ${fmt(c.join)} | ` +
        `${fmt(c.joinIqr[0])}..${fmt(c.joinIqr[1])} | ${c.joinN} | ${fmt(c.batched)} | ` +
        `${fmt(c.batchedIqr[0])}..${fmt(c.batchedIqr[1])} | ${c.batchedN} | ${winner} | ${ratio.toFixed(2)}x |`,
    );
  }

  await db.disconnect();
  await admin.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
