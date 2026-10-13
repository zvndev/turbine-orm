/**
 * Oracle 3: findManyStream and findManyStreamBatches vs findMany, anchored to raw SQL.
 *
 * The three read paths must yield the same rows for the same args. Comparing
 * them with each other proves nothing if they share a bug, so every one of them
 * is also compared with `SELECT ... ORDER BY id LIMIT .. OFFSET ..` run through a
 * raw pg client.
 *
 * A stream has three internal shapes: a speculative first fetch that satisfies a
 * small drain in one round trip, a cursor path for larger ones, and a path that
 * skips speculation when the batch size is large. Each applies the caller's
 * `limit` and `offset` in its own way, and the boundaries between them sit at the
 * batch size. So the matrix pins result sizes at batch-1, batch and batch+1 for
 * batch sizes around the default of 1000, and a random run mixes `where`,
 * `limit`, `offset`, `select` and a `with` clause under every relation strategy.
 *
 * Run: DATABASE_URL=postgres://... npx tsx --test src/test/oracle-stream-vs-findmany.test.ts
 */

import { describe } from 'node:test';
import type pg from 'pg';
import { skipGate } from './helpers.js';
import { DATABASE_URL, rngFor, SKIP, scaled } from './oracle/env.js';
import { Failures } from './oracle/failures.js';
import { rawReader, rows as rawRows, runScript } from './oracle/raw.js';
import { describeError, introspectTables, makeClient, type OracleClient, show } from './oracle/util.js';

const FILE = 'oracle-stream-vs-findmany.test.ts';
const { it, before, after } = skipGate(SKIP, 'DATABASE_URL not set');

const ROWS_T = 'orc_s_rows';
const KIDS_T = 'orc_s_kids';
const N = scaled(1300, 3200);

const DDL = `
DROP TABLE IF EXISTS ${KIDS_T}, ${ROWS_T} CASCADE;
CREATE TABLE ${ROWS_T} (id int PRIMARY KEY, grp int NOT NULL, val text NOT NULL);
CREATE TABLE ${KIDS_T} (id int PRIMARY KEY, row_id int NOT NULL REFERENCES ${ROWS_T}(id), label text NOT NULL);
CREATE INDEX ON ${KIDS_T}(row_id);
INSERT INTO ${ROWS_T} SELECT g, g % 7, 'v' || g FROM generate_series(1, ${N}) g;
-- every third parent has no children; the rest have one or two
INSERT INTO ${KIDS_T}
  SELECT row_number() OVER (ORDER BY r.id, k), r.id, 'k' || r.id || '_' || k
  FROM ${ROWS_T} r, generate_series(1, 2) k
  WHERE r.id % 3 <> 0 AND (k = 1 OR r.id % 2 = 0);
`;

let db: OracleClient;
let reader: pg.Client;

interface WhereVariant {
  readonly label: string;
  readonly args: Record<string, unknown> | undefined;
  readonly sql: string;
}

const WHERES: WhereVariant[] = [
  { label: 'none', args: undefined, sql: 'true' },
  { label: 'grp = 3', args: { grp: 3 }, sql: 'grp = 3' },
  { label: 'id > 100', args: { id: { gt: 100 } }, sql: 'id > 100' },
  { label: 'id between 50 and 1200', args: { id: { gte: 50, lte: 1200 } }, sql: 'id BETWEEN 50 AND 1200' },
  { label: 'grp in (1,2) and id > 10', args: { grp: { in: [1, 2] }, id: { gt: 10 } }, sql: 'grp IN (1,2) AND id > 10' },
];

interface Query {
  where: WhereVariant;
  limit?: number;
  offset?: number;
  batchSize?: number;
  withKids?: boolean;
  strategy?: 'join' | 'batched' | 'auto';
  narrow?: boolean;
}

type Shaped = [number, string, number[]?];

function describeQuery(q: Query): string {
  return show({
    where: q.where.label,
    limit: q.limit,
    offset: q.offset,
    batchSize: q.batchSize,
    withKids: q.withKids,
    strategy: q.strategy,
  });
}

async function expectedRows(q: Query): Promise<Shaped[]> {
  const limit = q.limit === undefined ? '' : ` LIMIT ${q.limit}`;
  const offset = q.offset === undefined ? '' : ` OFFSET ${q.offset}`;
  const kids = q.withKids
    ? `, coalesce((SELECT json_agg(k.id ORDER BY k.id) FROM ${KIDS_T} k WHERE k.row_id = r.id), '[]'::json)::text AS kids`
    : '';
  const result = await rawRows(
    reader,
    `SELECT r.id, r.val${kids} FROM ${ROWS_T} r WHERE ${q.where.sql} ORDER BY r.id${limit}${offset}`,
  );
  return result.map((r) => {
    const base: Shaped = [Number(r.id), r.val as string];
    if (q.withKids) base.push(JSON.parse(r.kids as string) as number[]);
    return base;
  });
}

function turbineArgs(q: Query): Record<string, unknown> {
  return {
    ...(q.where.args ? { where: q.where.args } : {}),
    orderBy: { id: 'asc' },
    ...(q.limit !== undefined ? { limit: q.limit } : {}),
    ...(q.offset !== undefined ? { offset: q.offset } : {}),
    select: { id: true, val: true },
    ...(q.withKids
      ? {
          relationLoadStrategy: q.strategy ?? 'auto',
          with: { kids: { select: { id: true }, orderBy: { id: 'asc' } } },
        }
      : {}),
  };
}

const shape = (q: Query, r: Record<string, unknown>): Shaped => {
  const base: Shaped = [Number(r.id), r.val as string];
  if (q.withKids) base.push(((r.kids as { id: number }[]) ?? []).map((k) => k.id));
  return base;
};

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

describe('oracle: stream and findMany yield the rows raw SQL returns', () => {
  before(async () => {
    await runScript(DATABASE_URL!, DDL);
    const schema = await introspectTables(DATABASE_URL!, [ROWS_T, KIDS_T], { [ROWS_T]: { orcSKids: 'kids' } });
    db = makeClient(DATABASE_URL!, schema, { poolSize: 6 });
    reader = await rawReader(DATABASE_URL!);
  });

  after(async () => {
    await db?.disconnect();
    await reader?.end();
    if (!SKIP) await runScript(DATABASE_URL!, `DROP TABLE IF EXISTS ${KIDS_T}, ${ROWS_T} CASCADE`);
  });

  /** Run one query three ways and record every disagreement with the raw rows. */
  async function checkQuery(failures: Failures, q: Query): Promise<void> {
    const expected = await expectedRows(q);
    const args = turbineArgs(q);
    const table = db.t(ROWS_T);
    const label = describeQuery(q);

    failures.checked();
    try {
      const got = (await table.findMany(args)).map((r: Record<string, unknown>) => shape(q, r));
      if (!same(got, expected)) {
        failures.add('findMany differs from raw SQL', `${label}\nexpected ${expected.length} rows, got ${got.length}`);
      }
    } catch (e) {
      failures.add('findMany threw', `${label}\n${describeError(e)}`);
    }

    failures.checked();
    try {
      const got: Shaped[] = [];
      for await (const r of table.findManyStream({ ...args, ...(q.batchSize ? { batchSize: q.batchSize } : {}) })) {
        got.push(shape(q, r as Record<string, unknown>));
      }
      if (!same(got, expected)) {
        failures.add(
          'findManyStream differs from raw SQL',
          `${label}\nexpected ${expected.length} rows, yielded ${got.length}${got.length > expected.length ? ' (more than the limit allows)' : ''}`,
        );
      }
    } catch (e) {
      failures.add('findManyStream threw', `${label}\n${describeError(e)}`);
    }

    failures.checked();
    try {
      const got: Shaped[] = [];
      const sizes: number[] = [];
      for await (const batch of table.findManyStreamBatches({
        ...args,
        ...(q.batchSize ? { batchSize: q.batchSize } : {}),
      })) {
        sizes.push(batch.length);
        for (const r of batch) got.push(shape(q, r as Record<string, unknown>));
      }
      if (!same(got, expected)) {
        failures.add(
          'findManyStreamBatches differs from raw SQL',
          `${label}\nexpected ${expected.length} rows, yielded ${got.length}${got.length > expected.length ? ' (more than the limit allows)' : ''}`,
        );
      }
      const batch = q.batchSize ?? 1000;
      if (sizes.some((n) => n === 0 || n > batch)) {
        failures.add(
          'findManyStreamBatches yielded an empty or oversized batch',
          `${label}\nbatch sizes ${sizes.slice(0, 8).join(',')}...`,
        );
      }
    } catch (e) {
      failures.add('findManyStreamBatches threw', `${label}\n${describeError(e)}`);
    }
  }

  it('result sizes at batch-1, batch and batch+1, with limits below, at and above them', async () => {
    const failures = new Failures(FILE);
    // `id <= matching` fixes how many rows the filter matches BEFORE any limit, which is the
    // quantity the speculative fetch compares with the batch size.
    for (const batchSize of [1, 2, 7, 50, 999, 1000, 1001]) {
      const small = batchSize <= 7;
      const matchings = [...new Set([1, batchSize - 1, batchSize, batchSize + 1, batchSize * 2 + 1])].filter(
        (m) => m >= 1 && m <= (small ? 60 : N),
      );
      for (const matching of matchings) {
        const where: WhereVariant = {
          label: `id <= ${matching}`,
          args: { id: { lte: matching } },
          sql: `id <= ${matching}`,
        };
        const limits = [undefined, 1, 5, matching - 1, matching, matching + 1].filter((l) => l === undefined || l >= 1);
        for (const limit of [...new Set(limits)]) {
          for (const offset of [undefined, 3]) {
            await checkQuery(failures, { where, limit, offset, batchSize });
          }
        }
      }
    }
    failures.assertClean('stream size matrix', 200);
  });

  it('random where, limit, offset, select and relation strategy agree with raw SQL', async () => {
    const rng = rngFor('stream:random');
    const failures = new Failures(FILE);
    const cases = scaled(40, 400);
    for (let i = 0; i < cases; i++) {
      const q: Query = {
        where: rng.pick(WHERES),
        limit: rng.pick([undefined, 1, 5, 13, 999, 1000, 1001, 1500]),
        offset: rng.pick([undefined, 0, 3, 997, 1000]),
        batchSize: rng.pick([undefined, 1, 7, 100, 999, 1000, 1001, 5000]),
        withKids: rng.chance(0.4),
        strategy: rng.pick(['join', 'batched', 'auto'] as const),
      };
      // A one-row batch over a thousand rows is correct and slow; keep the run inside its budget.
      if (q.batchSize === 1 && (q.limit === undefined || q.limit > 50)) q.limit = 40;
      await checkQuery(failures, q);
    }
    failures.assertClean('random stream queries', cases * 3);
  });
});
