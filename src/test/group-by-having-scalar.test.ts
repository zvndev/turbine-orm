/**
 * turbine-orm, groupBy `having` SCALAR filters + combinators
 *
 * `having` accepts a filter on the GROUPED value itself alongside the
 * aggregate filters (`having: { typeId: { not: null } }` →
 * `HAVING "type_id" IS NOT NULL`), plus AND / OR / NOT at any depth. A scalar
 * filter is legal only on a `by` group key: on any other column it throws
 * ValidationError E003, because a non-grouped column cannot be referenced in
 * HAVING at all.
 *
 * Three layers here:
 *   1. an aggregate-only corpus pinned to its exact pre-change SQL (the scalar
 *      surface must not move one byte of the aggregate surface),
 *   2. build-only SQL for every scalar shape (no DB),
 *   3. integration (DATABASE_URL) over a fixture whose row sets were measured
 *      against the same queries in Prisma.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import pg from 'pg';
import { TurbineClient } from '../client.js';
import { ValidationError } from '../errors.js';
import { introspect } from '../introspect.js';
import type { SchemaMetadata, TableMetadata } from '../schema.js';
import { makeQuery, mockTable, skipGate } from './helpers.js';

// ---------------------------------------------------------------------------
// Build-only schema
// ---------------------------------------------------------------------------

interface Item {
  id: number;
  typeId: number | null;
  bucket: string;
  amount: number;
  meta: Record<string, unknown>;
}

function buildSchema(): SchemaMetadata {
  const tables: Record<string, TableMetadata> = {};
  tables.having_item = mockTable('having_item', [
    { name: 'id', field: 'id', pgType: 'int4' },
    { name: 'type_id', field: 'typeId', pgType: 'int4' },
    { name: 'bucket', field: 'bucket', pgType: 'text' },
    { name: 'amount', field: 'amount', pgType: 'int4' },
    { name: 'meta', field: 'meta', pgType: 'jsonb' },
  ]);
  return { tables, enums: {} };
}

/** A build-only QueryInterface over {@link buildSchema}. */
function q() {
  return makeQuery<Item>('having_item', buildSchema());
}

// ---------------------------------------------------------------------------
// 1. The aggregate-only surface must stay byte-identical
// ---------------------------------------------------------------------------

/**
 * Every aggregate-only `having` shape, with the EXACT SQL and params the
 * builder emitted before scalar filters existed (captured from the previous
 * commit's builder). Any drift here means the scalar branch leaked into the
 * aggregate path.
 */
const AGGREGATE_ONLY_CORPUS: {
  name: string;
  // biome-ignore lint/suspicious/noExplicitAny: build-only corpus over loose groupBy args
  args: any;
  sql: string;
  params: unknown[];
}[] = [
  {
    name: '_count gt',
    args: { by: ['bucket'], _count: true, having: { _count: { gt: 5 } } },
    sql: 'SELECT "bucket", COUNT(*)::int AS _count FROM "having_item" GROUP BY "bucket" HAVING COUNT(*) > $1',
    params: [5],
  },
  {
    name: '_count bare number',
    args: { by: ['bucket'], having: { _count: 3 } },
    sql: 'SELECT "bucket", COUNT(*)::int AS _count FROM "having_item" GROUP BY "bucket" HAVING COUNT(*) = $1',
    params: [3],
  },
  {
    name: '_count in',
    args: { by: ['bucket'], having: { _count: { in: [1, 2, 3] } } },
    sql: 'SELECT "bucket", COUNT(*)::int AS _count FROM "having_item" GROUP BY "bucket" HAVING COUNT(*) = ANY($1)',
    params: [[1, 2, 3]],
  },
  {
    name: '_count notIn',
    args: { by: ['bucket'], having: { _count: { notIn: [1] } } },
    sql: 'SELECT "bucket", COUNT(*)::int AS _count FROM "having_item" GROUP BY "bucket" HAVING COUNT(*) != ALL($1)',
    params: [[1]],
  },
  {
    name: '_sum gte',
    args: { by: ['bucket'], _sum: { amount: true }, having: { amount: { _sum: { gte: 100 } } } },
    sql:
      'SELECT "bucket", COUNT(*)::int AS _count, SUM("amount") AS "_sum_amount" FROM "having_item" ' +
      'GROUP BY "bucket" HAVING SUM("amount") >= $1',
    params: [100],
  },
  {
    name: '_avg lte',
    args: { by: ['bucket'], having: { amount: { _avg: { lte: 5 } } } },
    sql: 'SELECT "bucket", COUNT(*)::int AS _count FROM "having_item" GROUP BY "bucket" HAVING AVG("amount") <= $1',
    params: [5],
  },
  {
    name: '_min + _max on one field',
    args: { by: ['bucket'], having: { amount: { _min: { gt: 1 }, _max: { lt: 9 } } } },
    sql:
      'SELECT "bucket", COUNT(*)::int AS _count FROM "having_item" GROUP BY "bucket" ' +
      'HAVING MIN("amount") > $1 AND MAX("amount") < $2',
    params: [1, 9],
  },
  {
    name: 'per-column _count',
    args: { by: ['bucket'], having: { amount: { _count: { gt: 2 } } } },
    sql: 'SELECT "bucket", COUNT(*)::int AS _count FROM "having_item" GROUP BY "bucket" HAVING COUNT("amount") > $1',
    params: [2],
  },
  {
    name: 'top-level _count + field aggregate',
    args: { by: ['bucket'], having: { _count: { gt: 1 }, amount: { _sum: { lte: 500 } } } },
    sql:
      'SELECT "bucket", COUNT(*)::int AS _count FROM "having_item" GROUP BY "bucket" ' +
      'HAVING COUNT(*) > $1 AND SUM("amount") <= $2',
    params: [1, 500],
  },
  {
    name: 'every comparison operator',
    args: {
      by: ['bucket'],
      having: { amount: { _sum: { equals: 1, not: 2, gt: 3, gte: 4, lt: 5, lte: 6, in: [7], notIn: [8] } } },
    },
    sql:
      'SELECT "bucket", COUNT(*)::int AS _count FROM "having_item" GROUP BY "bucket" ' +
      'HAVING SUM("amount") = $1 AND SUM("amount") != $2 AND SUM("amount") > $3 AND SUM("amount") >= $4 ' +
      'AND SUM("amount") < $5 AND SUM("amount") <= $6 AND SUM("amount") = ANY($7) AND SUM("amount") != ALL($8)',
    params: [1, 2, 3, 4, 5, 6, [7], [8]],
  },
  {
    name: 'where + having param numbering',
    args: { by: ['bucket'], where: { typeId: 7 }, having: { _count: { gt: 2 } } },
    sql:
      'SELECT "bucket", COUNT(*)::int AS _count FROM "having_item" WHERE "type_id" = $1 ' +
      'GROUP BY "bucket" HAVING COUNT(*) > $2',
    params: [7, 2],
  },
  {
    name: 'having + orderBy',
    args: { by: ['bucket'], _count: true, having: { _count: { gt: 1 } }, orderBy: { bucket: 'asc' } },
    sql:
      'SELECT "bucket", COUNT(*)::int AS _count FROM "having_item" GROUP BY "bucket" ' +
      'HAVING COUNT(*) > $1 ORDER BY "bucket" ASC',
    params: [1],
  },
  {
    name: 'having + limit/offset',
    args: { by: ['bucket'], _count: true, having: { _count: { gt: 1 } }, limit: 10, offset: 5 },
    sql:
      'SELECT "bucket", COUNT(*)::int AS _count FROM "having_item" GROUP BY "bucket" ' +
      'HAVING COUNT(*) > $1 LIMIT $2 OFFSET $3',
    params: [1, 10, 5],
  },
  {
    name: 'JSON-path aggregate alias',
    args: {
      by: ['bucket'],
      _sum: { total: { field: 'meta', path: ['n'] } },
      having: { total: { _sum: { gt: 3 } } },
    },
    sql:
      'SELECT "bucket", COUNT(*)::int AS _count, SUM(("meta" #>> $1::text[])::numeric) AS "_sum_total" ' +
      'FROM "having_item" GROUP BY "bucket" HAVING SUM(("meta" #>> $1::text[])::numeric) > $2',
    params: [['n'], 3],
  },
  {
    name: 'JSON group key + aggregate having',
    args: { by: [{ field: 'meta', path: ['tier'], alias: 'tier' }], _count: true, having: { _count: { gt: 1 } } },
    sql:
      'SELECT ("meta" #>> $1::text[]) AS "tier", COUNT(*)::int AS _count FROM "having_item" ' +
      'GROUP BY "meta" #>> $1::text[] HAVING COUNT(*) > $2',
    params: [['tier'], 1],
  },
  {
    name: 'empty having emits no HAVING',
    args: { by: ['bucket'], having: {} },
    sql: 'SELECT "bucket", COUNT(*)::int AS _count FROM "having_item" GROUP BY "bucket"',
    params: [],
  },
];

describe('groupBy having, aggregate-only SQL is unchanged', () => {
  for (const entry of AGGREGATE_ONLY_CORPUS) {
    it(`emits the pinned SQL for ${entry.name}`, () => {
      const { sql, params } = q().buildGroupBy(entry.args);
      assert.equal(sql, entry.sql);
      assert.deepEqual(params, entry.params);
    });
  }
});

// ---------------------------------------------------------------------------
// 2. Scalar having, SQL generation
// ---------------------------------------------------------------------------

describe('groupBy having, scalar filters on grouped columns', () => {
  it('compiles `not: null` on a group key into HAVING IS NOT NULL', () => {
    const { sql, params } = q().buildGroupBy({
      by: ['typeId'],
      _count: true,
      _sum: { amount: true },
      having: { typeId: { not: null } },
    });
    assert.match(sql, /GROUP BY "type_id" HAVING "type_id" IS NOT NULL$/);
    assert.deepEqual(params, []);
    // The predicate belongs to HAVING, never WHERE (Prisma emits it the same way).
    assert.ok(!sql.includes('WHERE'), 'a scalar having must not be rewritten into WHERE');
  });

  it('a bare value is equality shorthand, and a bare null is IS NULL', () => {
    const eq = q().buildGroupBy({ by: ['bucket'], having: { bucket: 'c' } });
    assert.match(eq.sql, /HAVING "bucket" = \$1$/);
    assert.deepEqual(eq.params, ['c']);

    const isNull = q().buildGroupBy({ by: ['typeId'], having: { typeId: null } });
    assert.match(isNull.sql, /HAVING "type_id" IS NULL$/);
    assert.deepEqual(isNull.params, []);
  });

  it('reuses the WHERE operator surface: in / notIn / contains / insensitive', () => {
    const inList = q().buildGroupBy({ by: ['bucket'], having: { bucket: { in: ['a', 'c'] } } });
    assert.match(inList.sql, /HAVING "bucket" = ANY\(\$1\)$/);
    assert.deepEqual(inList.params, [['a', 'c']]);

    const notIn = q().buildGroupBy({ by: ['bucket'], having: { bucket: { notIn: ['a'] } } });
    assert.match(notIn.sql, /HAVING "bucket" != ALL\(\$1\)$/);

    const contains = q().buildGroupBy({ by: ['bucket'], having: { bucket: { contains: '50%' } } });
    assert.match(contains.sql, /HAVING "bucket" LIKE \$1 ESCAPE/);
    // The LIKE escaping is inherited from the WHERE compiler, not reimplemented.
    assert.deepEqual(contains.params, ['%50\\%%']);

    const insensitive = q().buildGroupBy({
      by: ['bucket'],
      having: { bucket: { startsWith: 'A', mode: 'insensitive' } },
    });
    assert.match(insensitive.sql, /HAVING "bucket" ILIKE \$1 ESCAPE/);
    assert.deepEqual(insensitive.params, ['A%']);
  });

  it('ANDs a scalar filter and an aggregate filter given for the same field', () => {
    const { sql, params } = q().buildGroupBy({
      by: ['bucket'],
      having: { bucket: { not: 'a', _count: { gt: 1 } } },
    });
    assert.match(sql, /HAVING "bucket" != \$1 AND COUNT\("bucket"\) > \$2$/);
    assert.deepEqual(params, ['a', 1]);
  });

  it('ANDs a scalar filter on one field with an aggregate filter on another', () => {
    const { sql, params } = q().buildGroupBy({
      by: ['bucket'],
      having: { bucket: { not: 'a' }, amount: { _sum: { gt: 5 } } },
    });
    assert.match(sql, /HAVING "bucket" != \$1 AND SUM\("amount"\) > \$2$/);
    assert.deepEqual(params, ['a', 5]);
  });

  it('numbers HAVING params after the WHERE params', () => {
    const { sql, params } = q().buildGroupBy({
      by: ['typeId'],
      where: { amount: { gt: 6 } },
      having: { typeId: { in: [1, 2] } },
    });
    assert.match(sql, /WHERE "amount" > \$1 /);
    assert.match(sql, /HAVING "type_id" = ANY\(\$2\)$/);
    assert.deepEqual(params, [6, [1, 2]]);
  });

  it('never interpolates a scalar having value into the SQL string', () => {
    const { sql } = q().buildGroupBy({ by: ['bucket'], having: { bucket: "x'); DROP TABLE having_item; --" } });
    assert.ok(!sql.includes('DROP TABLE'), 'value must be parameterized, never interpolated');
    assert.match(sql, /HAVING "bucket" = \$1$/);
  });

  it('supports a scalar filter on a JSON-path group key', () => {
    const { sql, params } = q().buildGroupBy({
      by: [{ field: 'meta', path: ['tier'], alias: 'tier' }],
      // biome-ignore lint/suspicious/noExplicitAny: `tier` is a JSON group alias, not a column of Item
      having: { tier: { not: null } } as any,
    });
    // The grouped extract expression is re-emitted (same bound $1 path param).
    assert.match(sql, /HAVING \("meta" #>> \$1::text\[\]\) IS NOT NULL$/);
    assert.deepEqual(params, [['tier']]);
  });
});

// ---------------------------------------------------------------------------
// 3. Combinators
// ---------------------------------------------------------------------------

describe('groupBy having, AND / OR / NOT', () => {
  it('mixes a scalar and an aggregate predicate under OR', () => {
    const { sql, params } = q().buildGroupBy({
      by: ['bucket'],
      having: { OR: [{ bucket: 'a' }, { amount: { _sum: { gt: 5 } } }] },
    });
    assert.match(sql, /HAVING \("bucket" = \$1 OR SUM\("amount"\) > \$2\)$/);
    assert.deepEqual(params, ['a', 5]);
  });

  it('negates a nested clause with NOT', () => {
    const { sql, params } = q().buildGroupBy({ by: ['bucket'], having: { NOT: { bucket: 'a' } } });
    assert.match(sql, /HAVING NOT \("bucket" = \$1\)$/);
    assert.deepEqual(params, ['a']);
  });

  it('nests AND over OR at depth', () => {
    const { sql, params } = q().buildGroupBy({
      by: ['bucket'],
      having: { AND: [{ OR: [{ bucket: 'a' }, { bucket: 'c' }] }, { amount: { _avg: { gt: 1 } } }] },
    });
    assert.match(sql, /HAVING \("bucket" = \$1 OR "bucket" = \$2\) AND AVG\("amount"\) > \$3$/);
    assert.deepEqual(params, ['a', 'c', 1]);
  });

  it('drops an all-undefined combinator instead of emitting an empty HAVING', () => {
    const { sql } = q().buildGroupBy({
      by: ['bucket'],
      having: { OR: [{ bucket: undefined }], AND: [{}] },
    });
    assert.ok(!sql.includes('HAVING'), 'no predicate survived, so no HAVING is emitted');
  });

  it('refuses a non-object combinator condition', () => {
    assert.throws(
      // biome-ignore lint/suspicious/noExplicitAny: deliberately invalid combinator payload
      () => q().buildGroupBy({ by: ['bucket'], having: { OR: ['bucket'] as any } }),
      (err: unknown) => err instanceof ValidationError && /having "OR"/.test((err as Error).message),
    );
  });
});

// ---------------------------------------------------------------------------
// 4. Validation
// ---------------------------------------------------------------------------

describe('groupBy having, scalar validation', () => {
  it('refuses a scalar filter on a column that is not in `by`', () => {
    assert.throws(
      () => q().buildGroupBy({ by: ['bucket'], having: { typeId: { not: null } } }),
      (err: unknown) => {
        assert.ok(err instanceof ValidationError, 'should be ValidationError');
        const msg = (err as Error).message;
        assert.match(msg, /having on "typeId"/);
        assert.match(msg, /not one of the `by` group keys \[bucket\]/);
        // The message must point at the two real fixes plus the aggregate form.
        assert.match(msg, /move it to `where`/);
        assert.match(msg, /add "typeId" to `by`/);
        assert.match(msg, /_count/);
        return true;
      },
    );
  });

  it('refuses a bare-value scalar filter on a column that is not in `by`', () => {
    assert.throws(
      () => q().buildGroupBy({ by: ['bucket'], having: { amount: 5 } }),
      (err: unknown) => err instanceof ValidationError && /not one of the `by` group keys/.test((err as Error).message),
    );
  });

  it('still allows an AGGREGATE filter on a column that is not in `by`', () => {
    const { sql, params } = q().buildGroupBy({ by: ['bucket'], having: { amount: { _avg: { gt: 1 } } } });
    assert.match(sql, /HAVING AVG\("amount"\) > \$1$/);
    assert.deepEqual(params, [1]);
  });

  it('rejects a misspelled aggregate key instead of treating it as a scalar operator', () => {
    assert.throws(
      // biome-ignore lint/suspicious/noExplicitAny: deliberately misspelled aggregate
      () => q().buildGroupBy({ by: ['bucket'], having: { amount: { _sumX: { gt: 1 } } as any } }),
      (err: unknown) => {
        assert.ok(err instanceof ValidationError);
        assert.match((err as Error).message, /Unknown aggregate "_sumX"/);
        return true;
      },
    );
  });

  it('rejects an unknown scalar operator on a grouped column', () => {
    assert.throws(
      // biome-ignore lint/suspicious/noExplicitAny: deliberately misspelled operator
      () => q().buildGroupBy({ by: ['bucket'], having: { bucket: { startWith: 'a' } as any } }),
      (err: unknown) => {
        assert.ok(err instanceof ValidationError);
        assert.match((err as Error).message, /Unknown operator "startWith"/);
        return true;
      },
    );
  });

  it('rejects an unknown column outright, before any group-key reasoning', () => {
    assert.throws(
      // biome-ignore lint/suspicious/noExplicitAny: deliberately unknown column
      () => q().buildGroupBy({ by: ['bucket'], having: { nope: { gt: 1 } } as any }),
      (err: unknown) => err instanceof ValidationError,
    );
  });
});

// ---------------------------------------------------------------------------
// 5. Integration (requires DATABASE_URL)
//
// Fixture and expected row sets are the ones the same queries return from
// Prisma against the same rows.
// ---------------------------------------------------------------------------

const DATABASE_URL = process.env.DATABASE_URL;
const SKIP = !DATABASE_URL;
if (SKIP) {
  console.log('⚠ Skipping groupBy having scalar integration tests: DATABASE_URL not set');
}

describe('groupBy having scalar, integration', () => {
  const { it, before, after } = skipGate(SKIP, 'DATABASE_URL not set');
  let db: TurbineClient;
  const TABLE = '_having_scalar_item';

  before(async () => {
    const setup = new pg.Client({ connectionString: DATABASE_URL! });
    await setup.connect();
    try {
      await setup.query(`DROP TABLE IF EXISTS ${TABLE}`);
      await setup.query(
        `CREATE TABLE ${TABLE} (
           id serial PRIMARY KEY,
           type_id int,
           bucket text NOT NULL,
           amount int NOT NULL,
           meta jsonb NOT NULL DEFAULT '{}'::jsonb
         )`,
      );
      await setup.query(
        `INSERT INTO ${TABLE} (type_id, bucket, amount, meta) VALUES
           (1,    'a', 10,  '{"tier":"gold"}'),
           (NULL, 'a', 100, '{"tier":"gold"}'),
           (NULL, 'b', 5,   '{"tier":"silver"}'),
           (2,    'c', 7,   '{}'),
           (2,    'c', 3,   '{}')`,
      );
    } finally {
      await setup.end();
    }
    const schema = await introspect({ connectionString: DATABASE_URL! });
    db = new TurbineClient({ connectionString: DATABASE_URL!, poolSize: 3 }, schema);
    await db.connect();
  });

  after(async () => {
    if (db) await db.disconnect();
    const teardown = new pg.Client({ connectionString: DATABASE_URL! });
    await teardown.connect();
    try {
      await teardown.query(`DROP TABLE IF EXISTS ${TABLE}`);
    } finally {
      await teardown.end();
    }
  });

  const items = () => db.table<Item>(TABLE);
  const buckets = (rows: Record<string, unknown>[]) => rows.map((r) => r.bucket as string).sort();

  it('drops the NULL group that the same query without `having` keeps', async () => {
    const baseline = (await items().groupBy({
      by: ['typeId'],
      _count: true,
      _sum: { amount: true },
    })) as Record<string, unknown>[];
    assert.equal(baseline.length, 3, 'baseline keeps the typeId = NULL group');
    assert.ok(
      baseline.some((r) => r.typeId === null),
      'baseline must contain the NULL group',
    );

    const filtered = (await items().groupBy({
      by: ['typeId'],
      _count: true,
      _sum: { amount: true },
      having: { typeId: { not: null } },
    })) as Record<string, unknown>[];
    // Prisma returns [{ typeId: 2, _count: 2, _sum: 10 }, { typeId: 1, _count: 1, _sum: 10 }].
    const byType = new Map(filtered.map((r) => [Number(r.typeId), r]));
    assert.deepEqual([...byType.keys()].sort(), [1, 2]);
    assert.equal(byType.get(1)!._count, 1);
    assert.equal((byType.get(1)!._sum as Record<string, unknown>).amount, 10);
    assert.equal(byType.get(2)!._count, 2);
    assert.equal((byType.get(2)!._sum as Record<string, unknown>).amount, 10);
  });

  it('filters by an aggregate exactly as before', async () => {
    const rows = (await items().groupBy({
      by: ['bucket'],
      _sum: { amount: true },
      having: { amount: { _sum: { gt: 10 } } },
    })) as Record<string, unknown>[];
    assert.deepEqual(buckets(rows), ['a']);
    assert.equal((rows[0]!._sum as Record<string, unknown>).amount, 110);
  });

  it('combines a scalar and an aggregate predicate', async () => {
    const rows = (await items().groupBy({
      by: ['bucket'],
      _sum: { amount: true },
      having: { bucket: { not: 'a' }, amount: { _sum: { gt: 5 } } },
    })) as Record<string, unknown>[];
    assert.deepEqual(buckets(rows), ['c']);
    assert.equal((rows[0]!._sum as Record<string, unknown>).amount, 10);
  });

  it('coexists with `where` on another column, filtering rows then groups', async () => {
    const rows = (await items().groupBy({
      by: ['typeId'],
      where: { amount: { gt: 6 } },
      _count: true,
      having: { typeId: { not: null } },
    })) as Record<string, unknown>[];
    assert.deepEqual(
      rows.map((r) => Number(r.typeId)).sort(),
      [1, 2],
      'rows with amount > 6 are grouped, then the NULL group is dropped',
    );
  });

  it('filters on a column that is BOTH in `where` and in `having`', async () => {
    // where narrows rows to buckets a/c, having then keeps only bucket c.
    const rows = (await items().groupBy({
      by: ['bucket'],
      where: { bucket: { in: ['a', 'c'] } },
      _count: true,
      having: { bucket: { not: 'a' } },
    })) as Record<string, unknown>[];
    assert.deepEqual(buckets(rows), ['c']);
    assert.equal(rows[0]!._count, 2);
  });

  it('supports in / insensitive scalar operators over real rows', async () => {
    const inList = (await items().groupBy({
      by: ['bucket'],
      having: { bucket: { in: ['a', 'c'] } },
    })) as Record<string, unknown>[];
    assert.deepEqual(buckets(inList), ['a', 'c']);

    const insensitive = (await items().groupBy({
      by: ['bucket'],
      having: { bucket: { startsWith: 'A', mode: 'insensitive' } },
    })) as Record<string, unknown>[];
    assert.deepEqual(buckets(insensitive), ['a']);
  });

  it('evaluates a scalar OR an aggregate under OR', async () => {
    // bucket a survives on the name, bucket c on SUM(amount) = 10 > 5, bucket b (5) fails both.
    const rows = (await items().groupBy({
      by: ['bucket'],
      _sum: { amount: true },
      having: { OR: [{ bucket: 'a' }, { amount: { _sum: { gt: 5 } } }] },
    })) as Record<string, unknown>[];
    assert.deepEqual(buckets(rows), ['a', 'c']);
  });

  it('filters a JSON-path group key by its grouped value', async () => {
    const rows = (await items().groupBy({
      by: [{ field: 'meta', path: ['tier'], alias: 'tier' }],
      _count: true,
      // biome-ignore lint/suspicious/noExplicitAny: `tier` is a JSON group alias, not a column of Item
      having: { tier: { not: null } } as any,
    })) as Record<string, unknown>[];
    assert.deepEqual(
      rows.map((r) => r.tier as string).sort(),
      ['gold', 'silver'],
      'the two rows with no tier group under NULL and are dropped',
    );
  });

  it('refuses a scalar predicate on a non-grouped column before it reaches the database', async () => {
    await assert.rejects(
      () => items().groupBy({ by: ['bucket'], having: { typeId: { not: null } } }),
      (err: unknown) => err instanceof ValidationError,
    );
  });
});
