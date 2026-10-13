/**
 * turbine-orm, cursor pages: the effective order, the two placements, NULLs.
 *
 * A cursor page is ordered by the caller's `orderBy` plus a primary-key
 * tiebreaker (when the orderBy does not already end in a unique key), and is
 * placed either from the cursor's own values (when they cover that order) or
 * from the row the cursor names by a unique key. Before, the seek compared only
 * the cursor's own fields against an ORDER BY that might be on other columns,
 * which skipped and repeated rows, and a NULL sort key dropped rows.
 *
 * Build-only for SQL, params, cache keys (warm vs cold, production mode) and
 * refusals; live page walks on PostgreSQL (DATABASE_URL) and SQLite in memory:
 * every seeded orderBy shape, walked page by page in both placements and both
 * inclusivities, must visit exactly the rows of one ordered findMany, once each.
 */

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import { afterEach, beforeEach, describe, it } from 'node:test';
import pg from 'pg';
import { TurbineClient } from '../client.js';
import { ValidationError } from '../errors.js';
import { introspect } from '../introspect.js';
import { mssqlDialect } from '../mssql.js';
import { mysqlDialect } from '../mysql.js';
import { resetCacheCrossCheckEnv } from '../query/builder.js';
import { CURSOR_INCLUSIVE } from '../query/normalize-args.js';
import type { SchemaMetadata, TableMetadata } from '../schema.js';
import { introspectSqliteDatabase, sqliteDialect, turbineSqlite } from '../sqlite.js';
import { makeQuery, mockTable, skipGate } from './helpers.js';

// biome-ignore lint/suspicious/noExplicitAny: the suites drive untyped accessors and args
type Any = any;

function schema(): SchemaMetadata {
  const items = mockTable('items', [
    { name: 'id', field: 'id' },
    { name: 'grp', field: 'grp' },
    { name: 'score', field: 'score' },
    { name: 'label', field: 'label', pgType: 'text' },
    { name: 'tenant_id', field: 'tenantId', pgType: 'text' },
  ]);
  for (const c of items.columns) if (c.name === 'score' || c.name === 'label') c.nullable = true;
  const logs: TableMetadata = mockTable('logs', [{ name: 'message', field: 'message', pgType: 'text' }]);
  logs.primaryKey = [];
  logs.uniqueColumns = [];
  const pairs = mockTable('pairs', [
    { name: 'org_id', field: 'orgId' },
    { name: 'seq', field: 'seq' },
    { name: 'note', field: 'note', pgType: 'text' },
  ]);
  pairs.primaryKey = ['org_id', 'seq'];
  pairs.uniqueColumns = [['org_id', 'seq']];
  return { enums: {}, tables: { items, logs, pairs } };
}

function production(): void {
  process.env.NODE_ENV = 'production';
  resetCacheCrossCheckEnv();
}
let prevEnv: string | undefined;

describe('cursor: effective order (build-only)', () => {
  it('no orderBy: the page is ordered by the primary key', () => {
    const { sql, params } = makeQuery('items', schema()).buildFindMany({ cursor: { id: 7 }, limit: 3 } as Any);
    assert.equal(sql, 'SELECT "items".* FROM "items" WHERE "items"."id" > $1 ORDER BY "id" ASC LIMIT $2');
    assert.deepEqual(params, [7, 3]);
  });

  it('a non-unique orderBy gets the primary key as tiebreaker, in the last term direction', () => {
    const { sql, params } = makeQuery('items', schema()).buildFindMany({
      cursor: { grp: 2, id: 7 },
      orderBy: { grp: 'desc' },
    } as Any);
    assert.match(
      sql,
      /WHERE \("items"\."grp" < \$1 OR \("items"\."grp" = \$1 AND "items"\."id" < \$2\)\) ORDER BY "grp" DESC, "id" DESC$/,
    );
    assert.deepEqual(params, [2, 7]);
  });

  it('an orderBy that already ends in the primary key is untouched, SQL byte for byte', () => {
    const q = makeQuery('items', schema());
    const { sql } = q.buildFindMany({ cursor: { grp: 2, id: 7 }, orderBy: [{ grp: 'asc' }, { id: 'desc' }] } as Any);
    assert.match(sql, /ORDER BY "grp" ASC, "id" DESC$/);
    assert.match(sql, /\("items"\."grp" > \$1 OR \("items"\."grp" = \$1 AND "items"\."id" < \$2\)\)/);
  });

  it('a composite primary key is the tiebreaker on every column', () => {
    const { sql } = makeQuery('pairs', schema()).buildFindMany({
      cursor: { note: 'x', orgId: 1, seq: 2 },
      orderBy: { note: 'asc' },
    } as Any);
    assert.match(sql, /ORDER BY "note" ASC, "org_id" ASC, "seq" ASC$/);
  });

  it('extra cursor fields that are not in the order are ignored in value mode', () => {
    const q = makeQuery('items', schema());
    const a = q.buildFindMany({ cursor: { id: 7 } } as Any);
    const b = q.buildFindMany({ cursor: { id: 7, grp: 99, tenantId: 't' } } as Any);
    assert.equal(b.sql, a.sql);
    assert.deepEqual(b.params, [7]);
  });
});

describe('cursor: placing the page from the row it names (build-only)', () => {
  it('a cursor that names a row but lacks an ordered value reads that row in scalar subqueries', () => {
    const { sql, params } = makeQuery('items', schema()).buildFindMany({
      cursor: { id: 7 },
      orderBy: { grp: 'asc' },
      limit: 2,
    } as Any);
    const sub = (c: string) =>
      `\\(SELECT cursor_row\\."${c}" FROM "items" cursor_row WHERE cursor_row\\."id" = \\$1\\)`;
    assert.match(
      sql,
      new RegExp(
        `WHERE \\(EXISTS \\(SELECT 1 FROM "items" cursor_row WHERE cursor_row\\."id" = \\$1\\) AND ` +
          `\\("items"\\."grp" > ${sub('grp')} OR \\("items"\\."grp" = ${sub('grp')} AND "items"\\."id" > ${sub('id')}\\)\\)\\) ` +
          'ORDER BY "grp" ASC, "id" ASC LIMIT \\$2$',
      ),
    );
    assert.deepEqual(params, [7, 2], 'the cursor value binds once and every subquery reuses it');
  });

  it('the cursor row lookup carries the table global filter, its params bound once', () => {
    const q = makeQuery('items', schema(), { globalFilters: { items: { tenantId: 't1' } } } as Any);
    const { sql, params } = q.buildFindMany({ cursor: { id: 7 }, orderBy: { grp: 'asc' } } as Any);
    assert.match(sql, /cursor_row\."id" = \$2 AND cursor_row\."tenant_id" = \$3\)/);
    assert.deepEqual(params, ['t1', 7, 't1']);
  });

  it('a cursor that neither covers the order nor names one row is refused, naming what is missing', () => {
    const q = makeQuery('items', schema());
    assert.throws(
      () => q.buildFindMany({ cursor: { grp: 2 }, orderBy: { grp: 'asc' } } as Any),
      (err: unknown) =>
        err instanceof ValidationError &&
        /the `cursor` has no value for "id"/.test(err.message) &&
        /page order \(grp asc, id asc\)/.test(err.message) &&
        /name the cursor row by \{ id \}/.test(err.message),
    );
  });

  it('a relation ordering cannot carry a cursor (E003)', () => {
    const s = schema();
    s.tables.items!.relations = {
      parent: { type: 'belongsTo', name: 'parent', from: 'items', to: 'pairs', foreignKey: 'grp', referenceKey: 'seq' },
    };
    assert.throws(
      () => makeQuery('items', s).buildFindMany({ cursor: { id: 1 }, orderBy: { parent: { note: 'asc' } } } as Any),
      /`cursor` cannot page past the orderBy entry "parent"/,
    );
  });

  it('a table with no primary key and no unique key cannot be cursor-paged (E003)', () => {
    assert.throws(
      () => makeQuery('logs', schema()).buildFindMany({ cursor: { message: 'x' } } as Any),
      /has no primary key or unique key on NOT NULL columns/,
    );
  });
});

describe('cursor: NULL sort keys (build-only)', () => {
  it('PostgreSQL writes the NULL placement out for a nullable ordered column', () => {
    const q = makeQuery('items', schema());
    const asc = q.buildFindMany({ cursor: { score: 5, id: 1 }, orderBy: { score: 'asc' } } as Any);
    assert.match(asc.sql, /ORDER BY "score" ASC NULLS LAST, "id" ASC$/);
    // NULLs sort after every value ascending, so they are "after" a non-null cursor.
    assert.match(asc.sql, /\("items"\."score" > \$1 OR "items"\."score" IS NULL\)/);
    const desc = q.buildFindMany({ cursor: { score: 5, id: 1 }, orderBy: { score: 'desc' } } as Any);
    assert.match(desc.sql, /ORDER BY "score" DESC NULLS FIRST, "id" DESC$/);
  });

  it('a NULL cursor value compares with IS NULL and binds no param', () => {
    const q = makeQuery('items', schema());
    const { sql, params } = q.buildFindMany({ cursor: { score: null, id: 4 }, orderBy: { score: 'asc' } } as Any);
    // NULLS LAST ascending: nothing sorts after NULL on `score`, so only the
    // tie on NULL remains.
    assert.match(sql, /WHERE \("items"\."score" IS NULL AND "items"\."id" > \$1\) ORDER BY/);
    assert.deepEqual(params, [4]);
    const first = q.buildFindMany({
      cursor: { score: null, id: 4 },
      orderBy: { score: { sort: 'asc', nulls: 'first' } },
    } as Any);
    assert.match(
      first.sql,
      /WHERE \("items"\."score" IS NOT NULL OR \("items"\."score" IS NULL AND "items"\."id" > \$1\)\)/,
    );
  });

  it('SQLite, MySQL and SQL Server sort NULL smallest, and the seek follows', () => {
    for (const dialect of [sqliteDialect, mysqlDialect, mssqlDialect]) {
      const q = makeQuery('items', schema(), { dialect } as Any);
      const { sql } = q.buildFindMany({ cursor: { score: null, id: 4 }, orderBy: { score: 'asc' } } as Any);
      // NULL first ascending: every non-null value is after a NULL cursor.
      assert.match(sql, /score\W? IS NOT NULL OR/, dialect.name);
      assert.doesNotMatch(sql, /NULLS (FIRST|LAST)/, `${dialect.name} writes no NULLS clause`);
    }
  });

  it('row mode on a nullable column compares NULL-aware against the cursor row', () => {
    const q = makeQuery('items', schema());
    const { sql } = q.buildFindMany({ cursor: { id: 4 }, orderBy: { score: 'asc' } } as Any);
    assert.match(sql, /\(\(SELECT cursor_row\."score" [^)]+\) IS NOT NULL AND \("items"\."score" > \(SELECT/);
    assert.match(sql, /OR \("items"\."score" IS NULL AND \(SELECT cursor_row\."score"/);
  });
});

describe('cursor: inclusive (the prisma-compat flag)', () => {
  it('reads the row the cursor names even when its values cover the order, folding equality into the last column', () => {
    const q = makeQuery('items', schema());
    const one = q.buildFindMany({ cursor: { id: 7 }, [CURSOR_INCLUSIVE]: true } as Any);
    assert.match(
      one.sql,
      /WHERE \(EXISTS \(SELECT 1 FROM "items" cursor_row WHERE cursor_row\."id" = \$1\) AND "items"\."id" >= \(SELECT cursor_row\."id" FROM "items" cursor_row WHERE cursor_row\."id" = \$1\)\) ORDER BY "id" ASC$/,
    );
    const two = q.buildFindMany({
      cursor: { grp: 2, id: 7 },
      orderBy: { grp: 'asc' },
      [CURSOR_INCLUSIVE]: true,
    } as Any);
    assert.match(two.sql, /\("items"\."grp" > \(SELECT cursor_row\."grp" [^)]+\) OR \("items"\."grp" = \(SELECT/);
    assert.match(two.sql, /AND "items"\."id" >= \(SELECT cursor_row\."id" [^)]+\)\)\)\) ORDER BY "grp" ASC, "id" ASC$/);
    assert.deepEqual(two.params, [2, 7]);
  });

  it('the flag survives the args seam copies (undefined pruning, take / skip folding)', () => {
    const { sql, params } = makeQuery('items', schema()).buildFindMany({
      where: { grp: undefined },
      cursor: { id: 3, grp: undefined },
      take: 2,
      skip: 1,
      [CURSOR_INCLUSIVE]: true,
    } as Any);
    assert.equal(
      sql,
      'SELECT "items".* FROM "items" WHERE (EXISTS (SELECT 1 FROM "items" cursor_row WHERE cursor_row."id" = $1) AND ' +
        '"items"."id" >= (SELECT cursor_row."id" FROM "items" cursor_row WHERE cursor_row."id" = $1)) ' +
        'ORDER BY "id" ASC LIMIT $2 OFFSET $3',
    );
    assert.deepEqual(params, [3, 2, 1]);
  });

  it('inclusive and exclusive never share a cached statement', () => {
    const q = makeQuery('items', schema());
    const ex = q.buildFindMany({ cursor: { id: 7 } } as Any);
    const inc = q.buildFindMany({ cursor: { id: 7 }, [CURSOR_INCLUSIVE]: true } as Any);
    assert.notEqual(ex.sql, inc.sql);
  });
});

describe('cursor: warm cache binds what the cold build binds (production mode)', () => {
  beforeEach(() => {
    prevEnv = process.env.NODE_ENV;
    production();
  });
  afterEach(() => {
    if (prevEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prevEnv;
    resetCacheCrossCheckEnv();
  });

  const shapes: [string, Record<string | symbol, unknown>, Record<string | symbol, unknown>][] = [
    [
      'value mode',
      { cursor: { grp: 1, id: 2 }, orderBy: { grp: 'desc' } },
      { cursor: { grp: 5, id: 9 }, orderBy: { grp: 'desc' } },
    ],
    ['row mode', { cursor: { id: 2 }, orderBy: { grp: 'asc' } }, { cursor: { id: 9 }, orderBy: { grp: 'asc' } }],
    [
      'null value then non-null value',
      { cursor: { score: null, id: 2 }, orderBy: { score: 'asc' } },
      { cursor: { score: 3, id: 9 }, orderBy: { score: 'asc' } },
    ],
    ['inclusive', { cursor: { id: 2 }, [CURSOR_INCLUSIVE]: true }, { cursor: { id: 9 }, [CURSOR_INCLUSIVE]: true }],
  ];
  for (const [label, first, second] of shapes) {
    it(label, () => {
      const q = makeQuery('items', schema(), { globalFilters: { items: { tenantId: 't1' } } } as Any);
      const warmed = q.buildFindMany(first as Any);
      const cold = makeQuery('items', schema(), { globalFilters: { items: { tenantId: 't1' } } } as Any).buildFindMany(
        second as Any,
      );
      const warm = q.buildFindMany(second as Any);
      assert.ok(warmed.sql.length > 0);
      assert.equal(warm.sql, cold.sql, 'one shape, one statement');
      assert.deepEqual(warm.params, cold.params, 'a cache hit binds exactly what a fresh build binds');
    });
  }
});

// ---------------------------------------------------------------------------
// Live page walks
// ---------------------------------------------------------------------------

type Row = { id: number; grp: number; score: number | null; label: string | null };

/** Deterministic rows: few groups, duplicate and NULL scores and labels. */
function seedRows(): Row[] {
  const rows: Row[] = [];
  for (let id = 1; id <= 41; id++) {
    rows.push({
      id,
      grp: id % 4,
      score: id % 5 === 0 ? null : id % 3,
      label: id % 7 === 0 ? null : `l${id % 4}`,
    });
  }
  return rows;
}

/** A tiny deterministic PRNG so a failure names a reproducible shape. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function orderShapes(withNulls: boolean): Record<string, unknown>[][] {
  const next = rng(20261012);
  const cols = ['grp', 'score', 'label'];
  const shapes: Record<string, unknown>[][] = [[]];
  for (let i = 0; i < 18; i++) {
    const n = 1 + Math.floor(next() * 3);
    const picked = [...cols].sort(() => next() - 0.5).slice(0, n);
    shapes.push(
      picked.map((c) => {
        const sort = next() < 0.5 ? 'asc' : 'desc';
        if (withNulls && c !== 'grp' && next() < 0.4) return { [c]: { sort, nulls: next() < 0.5 ? 'first' : 'last' } };
        return { [c]: sort };
      }),
    );
  }
  return shapes;
}

/** The order a cursor page uses: the shape plus `id` in the last term direction. */
function effective(shape: Record<string, unknown>[]): Record<string, unknown>[] {
  const last = shape[shape.length - 1];
  const v = last ? Object.values(last)[0] : 'asc';
  const dir = typeof v === 'string' ? v : (v as { sort: string }).sort;
  return [...shape, { id: dir }];
}

async function walk(
  acc: Any,
  shape: Record<string, unknown>[],
  mode: 'values' | 'row',
  inclusive: boolean,
  pageSize: number,
): Promise<number[]> {
  const seen: number[] = [];
  let cursor: Record<string, unknown> | undefined;
  for (let guard = 0; guard < 200; guard++) {
    // The first page has no cursor, so nothing completes its order: it states
    // the effective order itself, exactly what each cursor page then derives.
    const orderBy = cursor ? (shape.length > 0 ? shape : undefined) : effective(shape);
    const args: Record<string | symbol, unknown> = { orderBy, limit: pageSize };
    if (cursor) {
      args.cursor = cursor;
      if (inclusive) {
        args[CURSOR_INCLUSIVE] = true;
        args.offset = 1;
      }
    }
    const rows: Row[] = await acc.findMany(args);
    if (rows.length === 0) break;
    seen.push(...rows.map((r) => r.id));
    const last = rows[rows.length - 1]!;
    cursor = mode === 'row' ? { id: last.id } : { id: last.id, grp: last.grp, score: last.score, label: last.label };
  }
  return seen;
}

async function assertWalks(acc: Any, withNulls: boolean, engine: string): Promise<number> {
  let checked = 0;
  for (const shape of orderShapes(withNulls)) {
    const expected = ((await acc.findMany({ orderBy: effective(shape) })) as Row[]).map((r) => r.id);
    assert.equal(expected.length, 41);
    for (const mode of ['values', 'row'] as const) {
      for (const inclusive of [false, true]) {
        for (const pageSize of [1, 4]) {
          const got = await walk(acc, shape, mode, inclusive, pageSize);
          assert.deepEqual(
            got,
            expected,
            `${engine} ${JSON.stringify(shape)} ${mode} inclusive=${inclusive} page=${pageSize}`,
          );
          checked++;
        }
      }
    }
  }
  return checked;
}

const DATABASE_URL = process.env.DATABASE_URL;
const pgGate = skipGate(!DATABASE_URL, 'DATABASE_URL not set');
const TABLE = 'builder_seams_cursor_items';

describe('cursor page walks (live PostgreSQL)', () => {
  let pool: pg.Pool;
  let db: TurbineClient;
  pgGate.before(async () => {
    pool = new pg.Pool({ connectionString: DATABASE_URL });
    await pool.query(`DROP TABLE IF EXISTS ${TABLE}`);
    await pool.query(`CREATE TABLE ${TABLE} (id int PRIMARY KEY, grp int NOT NULL, score int, label text)`);
    for (const r of seedRows()) {
      await pool.query(`INSERT INTO ${TABLE} VALUES ($1, $2, $3, $4)`, [r.id, r.grp, r.score, r.label]);
    }
    const s = await introspect({ connectionString: DATABASE_URL! });
    db = new TurbineClient({ connectionString: DATABASE_URL!, warnOnUnlimited: false }, s);
    await db.connect();
  });
  pgGate.after(async () => {
    if (db) await db.disconnect();
    if (pool) {
      await pool.query(`DROP TABLE IF EXISTS ${TABLE}`);
      await pool.end();
    }
  });

  pgGate.it('every order shape, both placements, both inclusivities: each row exactly once, in order', async () => {
    const checked = await assertWalks(db.table(TABLE), true, 'postgresql');
    assert.equal(checked, 19 * 8);
  });

  pgGate.it('a deleted cursor row gives an empty page in row mode rather than a wrong one', async () => {
    const acc: Any = db.table(TABLE);
    // `score desc` sorts NULLs first, so with no cursor row (every subquery
    // NULL) the NULL-aware seek alone would match every non-null score.
    for (const orderBy of [{ grp: 'asc' }, { score: 'desc' }]) {
      assert.deepEqual(await acc.findMany({ cursor: { id: 100_000 }, orderBy }), [], JSON.stringify(orderBy));
    }
  });
});

const DatabaseSync: (new (path: string) => DatabaseSyncType) | undefined = (() => {
  try {
    return createRequire(process.cwd())('node:sqlite').DatabaseSync;
  } catch {
    return undefined;
  }
})();
const lite = skipGate(!DatabaseSync, 'node:sqlite requires Node >= 22.5');

describe('cursor page walks (live SQLite)', () => {
  let db: TurbineClient;
  lite.before(() => {
    const raw = new DatabaseSync!(':memory:');
    raw.exec(`CREATE TABLE ${TABLE} (id INTEGER PRIMARY KEY, grp INTEGER NOT NULL, score INTEGER, label TEXT)`);
    const insert = raw.prepare(`INSERT INTO ${TABLE} VALUES (?, ?, ?, ?)`);
    for (const r of seedRows()) insert.run(r.id, r.grp, r.score, r.label);
    db = turbineSqlite(raw, introspectSqliteDatabase(raw), { warnOnUnlimited: false });
  });
  lite.after(async () => {
    if (db) await db.disconnect();
  });

  lite.it('every order shape, both placements, both inclusivities: each row exactly once, in order', async () => {
    const checked = await assertWalks(db.table(TABLE), true, 'sqlite');
    assert.equal(checked, 19 * 8);
  });
});
