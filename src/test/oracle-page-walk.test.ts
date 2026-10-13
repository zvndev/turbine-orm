/**
 * Oracle 2: page-walk invariant.
 *
 * Walk a table page by page and every row must be visited exactly once, in the
 * order raw SQL `ORDER BY ..., id` returns them. The oracle is a plain
 * `SELECT id ... ORDER BY` through a raw pg client; nothing about the expected
 * order comes from the library.
 *
 * The table is built to break pagination: few distinct values, so most sort keys
 * tie, and a quarter of every sortable column is NULL, so a page boundary often
 * lands inside a run of NULLs. Order shapes are random: one to three columns,
 * either direction, optional explicit NULLS FIRST/LAST, with and without the
 * primary key as the last term.
 *
 * When the order lacks the primary key, the library supplies one for the pages
 * that follow a cursor, and which direction it takes is not asserted. The first
 * page (which has no cursor) names the key itself, and a walk passes when the
 * pages agree with raw SQL under either direction of that key.
 *
 * Walks:
 *   offset      limit/offset and take/skip (only when the order ends in the key,
 *               since an order with ties has no single correct page boundary)
 *   cursor      a cursor carrying every order column plus the key
 *   key cursor  `cursor: { id }`, the usual "continue after this row" idiom
 *   partial     the order's columns without the key: an exact walk, or a typed
 *               E003 that names what is missing. Never a silently wrong page.
 *   compat      Prisma semantics through turbine-orm/prisma-compat:
 *               `cursor: { id }, skip: 1` (the cursor row is INCLUDED, skip drops it)
 *
 * Run: DATABASE_URL=postgres://... npx tsx --test src/test/oracle-page-walk.test.ts
 */

import assert from 'node:assert/strict';
import { describe } from 'node:test';
import type pg from 'pg';
import { createPrismaCompatClient } from '../prisma-compat.js';
import type { PrismaCompatMap } from '../schema.js';
import { skipGate } from './helpers.js';
import { DATABASE_URL, rngFor, SKIP, scaled } from './oracle/env.js';
import { Failures } from './oracle/failures.js';
import { ids, rawReader, runScript } from './oracle/raw.js';
import type { Rng } from './oracle/rng.js';
import { describeError, introspectTables, makeClient, type OracleClient, show } from './oracle/util.js';
import { camel } from './oracle/where-model.js';

const FILE = 'oracle-page-walk.test.ts';
const { it, before, after } = skipGate(SKIP, 'DATABASE_URL not set');

const TABLE = 'orc_p_items';
const ROWS = scaled(120, 600);
const SHAPES = scaled(24, 160);

const DDL = `
DROP TABLE IF EXISTS ${TABLE} CASCADE;
CREATE TABLE ${TABLE} (
  id int PRIMARY KEY,
  grp int,
  score int,
  name text,
  ts timestamptz,
  flag boolean
);
`;

const NAMES = ['ann', 'bob', 'cy', 'dee', 'eve', 'fay'];
const STAMPS = Array.from({ length: 8 }, (_, i) => `2024-01-0${i + 1}T12:00:00Z`);

function seedSql(rng: Rng): string {
  const lit = (v: string | number | boolean | null): string =>
    v === null ? 'NULL' : typeof v === 'string' ? `'${v}'` : String(v);
  const maybe = <T>(p: number, v: T): T | null => (rng.chance(p) ? null : v);
  const out: string[] = [];
  for (let id = 1; id <= ROWS; id++) {
    out.push(
      `INSERT INTO ${TABLE} VALUES (${id}, ${lit(maybe(0.25, rng.int(1, 4)))}, ${lit(maybe(0.25, rng.int(0, 6)))}, ${lit(
        maybe(0.2, rng.pick(NAMES)),
      )}, ${lit(maybe(0.25, rng.pick(STAMPS)))}, ${lit(maybe(0.25, rng.chance(0.5)))});`,
    );
  }
  return out.join('\n');
}

const COLUMNS = ['grp', 'score', 'name', 'ts', 'flag'] as const;

interface Term {
  field: string;
  dir: 'asc' | 'desc';
  nulls?: 'first' | 'last';
}

function randomOrder(rng: Rng, withKey: boolean | undefined): Term[] {
  // A key-only order has no NULLs and no ties: the walk every implementation must get right.
  if (rng.chance(0.1)) return [{ field: 'id', dir: rng.pick(['asc', 'desc'] as const) }];
  const cols = rng.sample(COLUMNS, rng.int(1, 3));
  const terms: Term[] = cols.map((field) => {
    const t: Term = { field, dir: rng.pick(['asc', 'desc'] as const) };
    if (rng.chance(0.3)) t.nulls = rng.pick(['first', 'last'] as const);
    return t;
  });
  const key = withKey ?? rng.chance(0.4);
  if (key) terms.push({ field: 'id', dir: rng.pick(['asc', 'desc'] as const) });
  return terms;
}

const hasKey = (order: Term[]): boolean => order.some((t) => t.field === 'id');

type Tie = 'asc' | 'desc';

/**
 * The order the first page of a cursor walk is fetched with. A page request with
 * no cursor has nothing to continue from, so when the caller's order lacks the
 * key the first page names it explicitly; every later page then continues from
 * that page's last row using the caller's order as written.
 */
const withKey = (order: Term[], tie: Tie): Term[] => (hasKey(order) ? order : [...order, { field: 'id', dir: tie }]);

/** The tie-break directions a walk may legitimately follow: only one exists when the order names the key. */
const tiesFor = (order: Term[]): Tie[] => (hasKey(order) ? ['asc'] : ['asc', 'desc']);

const toOrderBy = (order: Term[]) =>
  order.map((t) => ({ [t.field]: t.nulls ? { sort: t.dir, nulls: t.nulls } : t.dir }));

/** The oracle's ORDER BY: the caller's terms, then the key (in `tie` direction) when absent. */
function sqlOrder(order: Term[], tie: Tie): string {
  const terms = order.map(
    (t) => `${t.field} ${t.dir.toUpperCase()}${t.nulls ? ` NULLS ${t.nulls.toUpperCase()}` : ''}`,
  );
  if (!hasKey(order)) terms.push(`id ${tie.toUpperCase()}`);
  return terms.join(', ');
}

function describeOrder(order: Term[]): string {
  return show(toOrderBy(order));
}

let db: OracleClient;
let reader: pg.Client;
let compat: { [model: string]: { findMany(args: unknown): Promise<{ id: number }[]> } };

describe('oracle: page walks visit every row once, in ORDER BY order', () => {
  before(async () => {
    await runScript(DATABASE_URL!, DDL + seedSql(rngFor('page-walk:data')));
    const schema = await introspectTables(DATABASE_URL!, [TABLE]);
    db = makeClient(DATABASE_URL!, schema);
    reader = await rawReader(DATABASE_URL!);

    const map: PrismaCompatMap = {
      enums: {},
      models: {
        Item: {
          table: TABLE,
          accessor: camel(TABLE),
          fields: { id: 'id', grp: 'grp', score: 'score', name: 'name', ts: 'ts', flag: 'flag' },
          relations: {},
          compoundUniques: {},
        },
      },
    };
    compat = createPrismaCompatClient(db, map) as unknown as typeof compat;
  });

  after(async () => {
    await db?.disconnect();
    await reader?.end();
    if (!SKIP) await runScript(DATABASE_URL!, `DROP TABLE IF EXISTS ${TABLE} CASCADE`);
  });

  type Page = Record<string, unknown>[];

  /**
   * Fetch pages until a short page, collecting ids. `next` builds the next
   * request from the last row (or the page index, for offset walks).
   */
  async function walk(
    pageSize: number,
    fetchPage: (pageIndex: number, last: Page[number] | undefined) => Promise<Page>,
  ): Promise<{ visited: number[]; error?: unknown }> {
    const visited: number[] = [];
    let last: Page[number] | undefined;
    const maxPages = Math.ceil(ROWS / pageSize) + 4;
    for (let p = 0; p < maxPages; p++) {
      let page: Page;
      try {
        page = await fetchPage(p, last);
      } catch (error) {
        return { visited, error };
      }
      for (const r of page) visited.push(Number(r.id));
      if (page.length < pageSize) return { visited };
      last = page[page.length - 1];
    }
    return { visited }; // did not terminate within the bound: reported as a length mismatch
  }

  /** What is wrong with a finished walk, or null when it visited exactly the expected rows in order. */
  function diff(
    order: Term[],
    pageSize: number,
    expected: number[],
    got: { visited: number[]; error?: unknown },
    extra: string,
  ): { kind: string; detail: string } | null {
    if (got.error !== undefined) {
      return {
        kind: 'threw',
        detail: `order ${describeOrder(order)} page ${pageSize}${extra}\nafter ${got.visited.length} rows: ${describeError(got.error)}`,
      };
    }
    const same = got.visited.length === expected.length && got.visited.every((v, i) => v === expected[i]);
    if (same) return null;
    const firstBad = got.visited.findIndex((v, i) => v !== expected[i]);
    const where =
      firstBad >= 0
        ? `first divergence at position ${firstBad}: got id ${got.visited[firstBad]}, expected id ${expected[firstBad]}`
        : `the walk stopped early after ${got.visited.length} rows (a page came back short or empty)`;
    return {
      kind: 'wrong rows',
      detail:
        `order ${describeOrder(order)} page ${pageSize}${extra}\n` +
        `visited ${got.visited.length} rows (${new Set(got.visited).size} distinct) of ${expected.length}\n` +
        `${where}\n` +
        `ids never visited: ${
          expected
            .filter((x) => !got.visited.includes(x))
            .slice(0, 12)
            .join(',') || 'none'
        }`,
    };
  }

  /**
   * Run one walk per legitimate tie-break direction. It passes when any one of
   * them matches raw SQL exactly; otherwise every variant's divergence is reported.
   * With `allowRefusal`, a walk that ends in a typed E003 on every variant is an
   * acceptable answer too (the library declined rather than guess).
   */
  async function walkVariants(
    failures: Failures,
    kind: string,
    order: Term[],
    pageSize: number,
    run: (tie: Tie) => Promise<{ visited: number[]; error?: unknown }>,
    allowRefusal = false,
  ): Promise<'exact' | 'refused' | 'failed'> {
    failures.checked();
    const problems: { kind: string; detail: string }[] = [];
    const errors: unknown[] = [];
    for (const tie of tiesFor(order)) {
      const got = await run(tie);
      const problem = diff(
        order,
        pageSize,
        await expectedOrder(order, tie),
        got,
        hasKey(order) ? '' : `\nfirst page tie-break: id ${tie}`,
      );
      if (problem === null) return 'exact';
      if (got.error !== undefined) errors.push(got.error);
      problems.push(problem);
    }
    const allThrew = errors.length === problems.length;
    if (allowRefusal && allThrew && errors.every((e) => (e as { code?: string }).code === 'TURBINE_E003'))
      return 'refused';
    failures.add(
      `${kind}: ${allThrew ? (allowRefusal ? 'threw something other than a typed E003' : 'threw') : 'wrong rows'}`,
      problems.map((p) => p.detail).join('\n  ---\n'),
    );
    return 'failed';
  }

  const expectedOrder = (order: Term[], tie: Tie): Promise<number[]> =>
    ids(reader, `SELECT id FROM ${TABLE} ORDER BY ${sqlOrder(order, tie)}`);
  const cursorOf = (order: Term[], row: Page[number]): Record<string, unknown> =>
    Object.fromEntries([...order.map((t) => t.field), ...(hasKey(order) ? [] : ['id'])].map((f) => [f, row[f]]));

  it('offset and take/skip walks (order ends in the key) match the raw ORDER BY', async () => {
    const rng = rngFor('page-walk:offset');
    const failures = new Failures(FILE);
    for (let s = 0; s < SHAPES; s++) {
      const order = randomOrder(rng, true);
      const pageSize = rng.pick([3, 7, 16, 50]);
      await walkVariants(failures, 'limit/offset walk', order, pageSize, () =>
        walk(pageSize, (p) =>
          db.t(TABLE).findMany({ orderBy: toOrderBy(order), limit: pageSize, offset: p * pageSize }),
        ),
      );
      await walkVariants(failures, 'take/skip walk', order, pageSize, () =>
        walk(pageSize, (p) => db.t(TABLE).findMany({ orderBy: toOrderBy(order), take: pageSize, skip: p * pageSize })),
      );
    }
    failures.assertClean('offset walks', SHAPES * 2);
  });

  it('cursor walks carrying every order column plus the key match the raw ORDER BY', async () => {
    const rng = rngFor('page-walk:cursor-full');
    const failures = new Failures(FILE);
    for (let s = 0; s < SHAPES; s++) {
      const order = randomOrder(rng, undefined);
      const pageSize = rng.pick([3, 7, 16, 50]);
      await walkVariants(failures, 'full-key cursor walk', order, pageSize, (tie) =>
        walk(pageSize, (_p, last) =>
          db.t(TABLE).findMany({
            orderBy: toOrderBy(last ? order : withKey(order, tie)),
            limit: pageSize,
            ...(last ? { cursor: cursorOf(order, last) } : {}),
          }),
        ),
      );
    }
    failures.assertClean('full-key cursor walks', SHAPES);
  });

  it('cursor { id } walks (continue after this row) match the raw ORDER BY', async () => {
    const rng = rngFor('page-walk:cursor-key');
    const failures = new Failures(FILE);
    for (let s = 0; s < SHAPES; s++) {
      const order = randomOrder(rng, undefined);
      const pageSize = rng.pick([3, 7, 16, 50]);
      await walkVariants(failures, 'key-only cursor walk', order, pageSize, (tie) =>
        walk(pageSize, (_p, last) =>
          db.t(TABLE).findMany({
            orderBy: toOrderBy(last ? order : withKey(order, tie)),
            limit: pageSize,
            ...(last ? { cursor: { id: last.id } } : {}),
          }),
        ),
      );
    }
    failures.assertClean('key-only cursor walks', SHAPES);
  });

  it('a cursor with the order columns but not the key: exact walk or typed E003, never wrong pages', async () => {
    const rng = rngFor('page-walk:cursor-partial');
    const failures = new Failures(FILE);
    let exact = 0;
    let refused = 0;
    for (let s = 0; s < SHAPES; s++) {
      const order = randomOrder(rng, false);
      const pageSize = rng.pick([3, 7, 16]);
      const outcome = await walkVariants(
        failures,
        'partial cursor walk',
        order,
        pageSize,
        (tie) =>
          walk(pageSize, (_p, last) =>
            db.t(TABLE).findMany({
              orderBy: toOrderBy(last ? order : withKey(order, tie)),
              limit: pageSize,
              ...(last ? { cursor: Object.fromEntries(order.map((t) => [t.field, last[t.field]])) } : {}),
            }),
          ),
        true,
      );
      if (outcome === 'exact') exact++;
      if (outcome === 'refused') refused++;
    }
    failures.tally(`refused with E003: ${refused}, walked exactly: ${exact}`);
    failures.assertClean('partial-cursor walks', SHAPES);
  });

  it('prisma-compat: cursor { id } with skip 1 visits every row once', async () => {
    const rng = rngFor('page-walk:compat');
    const failures = new Failures(FILE);
    for (let s = 0; s < SHAPES; s++) {
      const order = randomOrder(rng, undefined);
      const pageSize = rng.pick([3, 7, 16, 50]);
      await walkVariants(failures, 'prisma-compat cursor+skip walk', order, pageSize, (tie) =>
        walk(pageSize, (_p, last) =>
          compat.Item!.findMany({
            orderBy: toOrderBy(last ? order : withKey(order, tie)),
            take: pageSize,
            ...(last ? { cursor: { id: last.id }, skip: 1 } : {}),
          }),
        ),
      );
    }
    failures.assertClean('prisma-compat cursor walks', SHAPES);
  });

  it('walks are not vacuous: the oracle table has ties and NULLs in every sortable column', async () => {
    for (const col of COLUMNS) {
      const r = await reader.query(
        `SELECT count(*) FILTER (WHERE ${col} IS NULL) AS nulls, count(DISTINCT ${col}) AS distinct_values, count(*) AS total FROM ${TABLE}`,
      );
      const row = r.rows[0] as { nulls: string; distinct_values: string; total: string };
      assert.ok(Number(row.nulls) > 0, `${col} has no NULLs, so a page boundary can never land inside a NULL run`);
      assert.ok(
        Number(row.distinct_values) * 4 < Number(row.total),
        `${col} has too few ties (${row.distinct_values} distinct of ${row.total})`,
      );
    }
  });
});
