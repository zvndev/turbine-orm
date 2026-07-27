/**
 * turbine-orm: how a Postgres temporal `infinity` / `-infinity` reads.
 *
 * Postgres accepts `infinity` and `-infinity` in `date`, `timestamp` and
 * `timestamptz` columns. JavaScript has no Date that means either of them, so
 * every representation the ORM could hand back is wrong in some way:
 *
 *   Invalid Date   , the pre-0.54 reading. `JSON.stringify` renders it null,
 *                    `getTime()` is NaN, and nothing says why.
 *   Infinity       , `temporalInfinity: 'preserve'`, THE DEFAULT. The declared
 *                    type is `Date`, so `row.ts.toISOString()` throws, and
 *                    `JSON.stringify` renders it null because JSON has no
 *                    infinity literal. It is LOSSLESS: the number binds back
 *                    and Postgres stores `infinity` again.
 *   null           , `temporalInfinity: 'null'`, opt-in. Serializes cleanly and
 *                    the declared type of a nullable column already permits it,
 *                    at the cost of DATA LOSS: a stored infinity and a stored
 *                    NULL become indistinguishable, so a read-modify-write over
 *                    a nullable column stores SQL NULL and the value is gone
 *                    with no error.
 *
 * Both readings are asserted here, side by side, INCLUDING the read-modify-write
 * outcome of each verified as `::text` through a raw pg client, so neither the
 * default nor the trade-off of the opt-in can change silently.
 *
 * Asserts through the PUBLIC surface (findMany / create / groupBy / aggregate
 * plus `JSON.stringify` of what the caller receives) rather than at the parser
 * seam, because a parser-seam test is exactly what let two different wrong
 * readings ship: the driver parser was correct in both, the row parser was not.
 *
 * Requires DATABASE_URL. Run:
 *   npx tsx --test src/test/temporal-infinity-reading.integration.test.ts
 */

import assert from 'node:assert/strict';
import { describe } from 'node:test';
import pg from 'pg';
import { TurbineClient } from '../client.js';
import { resetWarnOnce, WARN_NS } from '../query/warn-registry.js';
import type { RelationDef, SchemaMetadata } from '../schema.js';
import { mockTable, skipGate } from './helpers.js';

const DATABASE_URL = process.env.DATABASE_URL;
const { it, before, after } = skipGate(!DATABASE_URL, 'DATABASE_URL not set');

const PARENT = 'inf_temporal_parent';
const CHILD = 'inf_temporal_child';

const kids: RelationDef = {
  type: 'hasMany',
  name: 'kids',
  from: PARENT,
  to: CHILD,
  foreignKey: 'parent_id',
  referenceKey: 'id',
};
const parent: RelationDef = {
  type: 'belongsTo',
  name: 'parent',
  from: CHILD,
  to: PARENT,
  foreignKey: 'parent_id',
  referenceKey: 'id',
};

const metadata: SchemaMetadata = {
  tables: {
    [PARENT]: {
      ...mockTable(
        PARENT,
        [
          { name: 'id', field: 'id', pgType: 'int4' },
          { name: 'ts', field: 'ts', pgType: 'timestamp' },
          { name: 'd', field: 'd', pgType: 'date' },
          { name: 'tsarr', field: 'tsarr', pgType: '_timestamp' },
        ],
        { kids },
      ),
      dateColumns: new Set(['ts', 'd', 'tsarr']),
    },
    [CHILD]: {
      ...mockTable(
        CHILD,
        [
          { name: 'id', field: 'id', pgType: 'int4' },
          { name: 'parent_id', field: 'parentId', pgType: 'int4' },
          { name: 'ts', field: 'ts', pgType: 'timestamp' },
        ],
        { parent },
      ),
      dateColumns: new Set(['ts']),
    },
  },
  enums: {},
};

/**
 * The two readings, each with the values it must produce. `preserve` is what an
 * unset `temporalInfinity` resolves to, asserted separately below.
 */
const READINGS = [
  {
    reading: 'preserve' as const,
    label: "temporalInfinity: 'preserve' (the default)",
    plus: Number.POSITIVE_INFINITY as unknown,
    minus: Number.NEGATIVE_INFINITY as unknown,
    /** What `::text` shows after reading a row and writing it straight back. */
    afterRoundTrip: 'infinity' as string | null,
  },
  {
    reading: 'null' as const,
    label: "temporalInfinity: 'null' (opt-in)",
    plus: null as unknown,
    minus: null as unknown,
    afterRoundTrip: null as string | null,
  },
];

describe('temporal infinity readings', () => {
  /** Client with `temporalInfinity` UNSET, i.e. the default reading. */
  let db: TurbineClient;
  let raw: pg.Client;

  before(async () => {
    if (!DATABASE_URL) return;
    raw = new pg.Client(DATABASE_URL);
    await raw.connect();
    await raw.query(`DROP TABLE IF EXISTS ${CHILD}`);
    await raw.query(`DROP TABLE IF EXISTS ${PARENT}`);
    await raw.query(`CREATE TABLE ${PARENT}(id int primary key, ts timestamp, d date, tsarr timestamp[])`);
    await raw.query(`CREATE TABLE ${CHILD}(id int primary key, parent_id int references ${PARENT}(id), ts timestamp)`);
    await raw.query(
      `INSERT INTO ${PARENT} VALUES
         (1,'infinity','infinity','{infinity,-infinity}'),
         (2,'-infinity','-infinity',NULL),
         (3,'2026-07-21 01:02:03','2026-07-21','{"2026-07-21 01:02:03"}')`,
    );
    await raw.query(`INSERT INTO ${CHILD} VALUES (10,1,'infinity'),(11,3,'2026-07-21 01:02:03')`);
    db = new TurbineClient({ connectionString: DATABASE_URL }, metadata);
  });

  after(async () => {
    if (!DATABASE_URL) return;
    await db.disconnect();
    await raw.query(`DROP TABLE IF EXISTS ${CHILD}`);
    await raw.query(`DROP TABLE IF EXISTS ${PARENT}`);
    await raw.end();
  });

  /** `col::text` for one row, i.e. what Postgres actually has stored. */
  const storedText = async (id: number, col = 'ts'): Promise<string | null> => {
    const res = await raw.query(`SELECT ${col}::text AS t FROM ${PARENT} WHERE id = $1`, [id]);
    return (res.rows[0] as { t: string | null }).t;
  };

  // ---------------------------------------------------------------------------
  // Both readings, asserted symmetrically.
  // ---------------------------------------------------------------------------

  for (const r of READINGS) {
    /** A client pinned to this reading, opened per test so warnings stay scoped. */
    const withClient = async (run: (client: TurbineClient) => Promise<void>): Promise<void> => {
      const client = new TurbineClient({ connectionString: DATABASE_URL!, temporalInfinity: r.reading }, metadata);
      try {
        await run(client);
      } finally {
        await client.disconnect();
      }
    };

    it(`${r.label}: reads a scalar timestamp and date, both signs`, async () => {
      await withClient(async (client) => {
        const plus = (await client.table(PARENT).findMany({ where: { id: 1 } })) as { ts: unknown; d: unknown }[];
        assert.equal(plus[0]!.ts, r.plus);
        assert.equal(plus[0]!.d, r.plus);

        const minus = (await client.table(PARENT).findMany({ where: { id: 2 } })) as { ts: unknown; d: unknown }[];
        assert.equal(minus[0]!.ts, r.minus);
        assert.equal(minus[0]!.d, r.minus);
      });
    });

    it(`${r.label}: maps array elements, leaving finite elements alone`, async () => {
      await withClient(async (client) => {
        const rows = (await client.table(PARENT).findMany({ where: { id: 1 } })) as { tsarr: unknown[] }[];
        assert.deepEqual(rows[0]!.tsarr, [r.plus, r.minus]);

        const finite = (await client.table(PARENT).findMany({ where: { id: 3 } })) as { tsarr: Date[] }[];
        assert.ok(finite[0]!.tsarr[0] instanceof Date);
        assert.equal(finite[0]!.tsarr[0]!.toISOString(), '2026-07-21T01:02:03.000Z');
      });
    });

    it(`${r.label}: JSON.stringify renders null either way, which is what a caller sees`, async () => {
      await withClient(async (client) => {
        const rows = (await client.table(PARENT).findMany({ where: { id: 1 } })) as unknown[];
        const json = JSON.parse(JSON.stringify(rows[0])) as Record<string, unknown>;
        // JSON has no infinity literal, so the wire form is identical under both
        // readings. This is exactly why a JSON-only test cannot tell them apart
        // and why the in-memory value is asserted above and the STORED value
        // below.
        assert.equal(json.ts, null);
        assert.equal(json.d, null);
        assert.deepEqual(json.tsarr, [null, null]);
      });
    });

    it(`${r.label}: the join and batched strategies agree, top level and nested`, async () => {
      await withClient(async (client) => {
        const read = async (relationLoadStrategy: 'join' | 'batched') =>
          (await client.table(PARENT).findMany({
            where: { id: 1 },
            with: { kids: true },
            relationLoadStrategy,
          })) as { ts: unknown; kids: { ts: unknown }[] }[];

        const join = await read('join');
        const batched = await read('batched');

        // The join strategy sees the JSON string "infinity"; the batched
        // strategy sees the driver's number. A per-strategy disagreement was
        // the original defect, so both are pinned to the same value.
        assert.equal(join[0]!.ts, r.plus, 'join parent');
        assert.equal(join[0]!.kids[0]!.ts, r.plus, 'join child');
        assert.equal(batched[0]!.ts, r.plus, 'batched parent');
        assert.equal(batched[0]!.kids[0]!.ts, r.plus, 'batched child');
        assert.deepEqual(batched, join);

        // A belongsTo parent through the join strategy is a third decode path.
        const child = (await client.table(CHILD).findMany({
          where: { id: 10 },
          with: { parent: true },
          relationLoadStrategy: 'join',
        })) as { parent: { ts: unknown } }[];
        assert.equal(child[0]!.parent.ts, r.plus, 'belongsTo parent through join');
      });
    });

    it(`${r.label}: the positional wire encoding decodes to the same value`, async () => {
      const client = new TurbineClient(
        { connectionString: DATABASE_URL!, temporalInfinity: r.reading, jsonEncoding: 'positional' },
        metadata,
      );
      try {
        const rows = (await client.table(PARENT).findMany({
          where: { id: 1 },
          with: { kids: true },
          relationLoadStrategy: 'join',
        })) as { ts: unknown; kids: { ts: unknown }[] }[];
        assert.equal(rows[0]!.ts, r.plus);
        assert.equal(rows[0]!.kids[0]!.ts, r.plus);
      } finally {
        await client.disconnect();
      }
    });

    it(`${r.label}: a write projection takes the same reading`, async () => {
      await withClient(async (client) => {
        const created = (await client.table(PARENT).create({ data: { id: 20, ts: 'infinity', d: 'infinity' } })) as {
          ts: unknown;
          d: unknown;
        };
        assert.equal(created.ts, r.plus);
        assert.equal(created.d, r.plus);

        const updated = (await client.table(PARENT).update({ where: { id: 20 }, data: { ts: '-infinity' } })) as {
          ts: unknown;
        };
        assert.equal(updated.ts, r.minus);

        await client.table(PARENT).delete({ where: { id: 20 } });
      });
    });

    it(`${r.label}: groupBy keys and _min / _max take the same reading`, async () => {
      await withClient(async (client) => {
        await raw.query(`INSERT INTO ${PARENT}(id, ts) VALUES (41,'infinity'),(42,'-infinity'),(43,NULL)`);
        try {
          const groups = (await client.table(PARENT).groupBy({
            by: ['ts'],
            where: { id: { in: [41, 42, 43] } },
            _count: true,
          })) as unknown as { ts: unknown }[];

          // Postgres always groups three distinct stored values. Under
          // 'preserve' the ORM keeps them distinguishable; under 'null' all
          // three come back keyed null, so a Map built off the key keeps one of
          // the three counts. That collapse is the documented cost.
          assert.equal(groups.length, 3, 'Postgres grouped three distinct values');
          const keys = groups.map((g) => g.ts).sort((a, b) => Number(a ?? 0) - Number(b ?? 0));
          assert.deepEqual(
            keys,
            [r.minus, null, r.plus].sort((a, b) => Number(a ?? 0) - Number(b ?? 0)),
          );

          const agg = (await client.table(PARENT).aggregate({
            where: { id: { in: [41, 42, 43] } },
            _min: { ts: true },
            _max: { ts: true },
          })) as { _min: { ts: unknown }; _max: { ts: unknown } };
          assert.equal(agg._max.ts, r.plus);
          assert.equal(agg._min.ts, r.minus);
        } finally {
          await raw.query(`DELETE FROM ${PARENT} WHERE id IN (41,42,43)`);
        }
      });
    });

    it(`${r.label}: a read-modify-write ${r.reading === 'preserve' ? 'preserves' : 'destroys'} the stored value`, async () => {
      const id = r.reading === 'preserve' ? 31 : 32;
      await raw.query(`INSERT INTO ${PARENT}(id, ts) VALUES ($1,'infinity')`, [id]);
      try {
        await withClient(async (client) => {
          // The ordinary shape: read a row, spread it, write it back.
          const row = (await client.table(PARENT).findMany({ where: { id } }))[0] as Record<string, unknown>;
          const { id: _id, ...rest } = row;
          await client.table(PARENT).update({ where: { id }, data: rest });
        });
        assert.equal(
          await storedText(id),
          r.afterRoundTrip,
          r.reading === 'preserve'
            ? "'preserve' must round-trip the stored infinity"
            : "'null' stores SQL NULL over the infinity, which is the documented cost of the opt-in",
        );
      } finally {
        await raw.query(`DELETE FROM ${PARENT} WHERE id = $1`, [id]);
      }
    });

    it(`${r.label}: infinity stays writable and \`null\` still means IS NULL`, async () => {
      await withClient(async (client) => {
        // The value can be written as the JS number or as the string, under
        // either reading, so a row read under 'null' is still recoverable if you
        // know what it held.
        await client.table(PARENT).create({ data: { id: 21, ts: Number.POSITIVE_INFINITY } });
        await client.table(PARENT).create({ data: { id: 22, ts: 'infinity' } });
        assert.equal(await storedText(21), 'infinity');
        assert.equal(await storedText(22), 'infinity');

        const matched = (await client.table(PARENT).findMany({ where: { ts: 'infinity' } })) as { id: number }[];
        assert.ok(matched.some((row) => row.id === 21));
        assert.ok(matched.some((row) => row.id === 22));

        // `null` compiles to IS NULL under BOTH readings and does not match
        // these rows. Documented asymmetry, not a bug: making it match would
        // silently change every null predicate on every temporal column.
        const nulls = (await client.table(PARENT).findMany({ where: { ts: null } })) as { id: number }[];
        assert.equal(nulls.length, 0);

        await client.table(PARENT).delete({ where: { id: 21 } });
        await client.table(PARENT).delete({ where: { id: 22 } });
      });
    });

    it(`${r.label}: an ordinary timestamp and date on the same table are untouched`, async () => {
      await withClient(async (client) => {
        const rows = (await client.table(PARENT).findMany({ where: { id: 3 } })) as { ts: Date; d: Date }[];
        assert.ok(rows[0]!.ts instanceof Date);
        assert.ok(rows[0]!.d instanceof Date);
        assert.equal(rows[0]!.ts.toISOString(), '2026-07-21T01:02:03.000Z');
        assert.equal(rows[0]!.d.toISOString(), '2026-07-21T00:00:00.000Z');
      });
    });
  }

  // ---------------------------------------------------------------------------
  // The default, and its consequences.
  // ---------------------------------------------------------------------------

  it("leaving temporalInfinity unset selects 'preserve', on every read path", async () => {
    // The default is the LOSSLESS reading. 'null' reads nicer and silently
    // destroys the value on a read-modify-write, which is not a price a default
    // may charge.
    const rows = (await db.table(PARENT).findMany({
      where: { id: 1 },
      with: { kids: true },
      relationLoadStrategy: 'join',
    })) as { ts: unknown; d: unknown; tsarr: unknown[]; kids: { ts: unknown }[] }[];
    assert.equal(rows[0]!.ts, Number.POSITIVE_INFINITY);
    assert.equal(rows[0]!.d, Number.POSITIVE_INFINITY);
    assert.deepEqual(rows[0]!.tsarr, [Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]);
    assert.equal(rows[0]!.kids[0]!.ts, Number.POSITIVE_INFINITY);
  });

  it('the default round-trips a read-modify-write, which is the whole point of it', async () => {
    await raw.query(`INSERT INTO ${PARENT}(id, ts) VALUES (33,'infinity')`);
    try {
      const row = (await db.table(PARENT).findMany({ where: { id: 33 } }))[0] as Record<string, unknown>;
      const { id: _id, ...rest } = row;
      await db.table(PARENT).update({ where: { id: 33 }, data: rest });
      assert.equal(await storedText(33), 'infinity');
    } finally {
      await raw.query(`DELETE FROM ${PARENT} WHERE id = 33`);
    }
  });

  it('the default hands back a number on a Date-typed field, so Date methods throw', async () => {
    // The documented cost of 'preserve', pinned so it stays documented rather
    // than discovered. `JSON.stringify` still renders null (asserted above).
    const rows = (await db.table(PARENT).findMany({ where: { id: 1 } })) as { ts: unknown }[];
    const ts = rows[0]!.ts as unknown as Date;
    assert.equal(typeof rows[0]!.ts, 'number');
    assert.throws(() => ts.toISOString(), TypeError);
    assert.throws(() => ts.getTime(), TypeError);
  });

  // ---------------------------------------------------------------------------
  // The warning.
  // ---------------------------------------------------------------------------

  /** Capture `console.warn` around `run`, returning the infinity notices only. */
  const captureWarnings = async (run: () => Promise<unknown>): Promise<string[]> => {
    const seen: string[] = [];
    const original = console.warn;
    console.warn = (msg: unknown) => {
      seen.push(String(msg));
    };
    try {
      await run();
    } finally {
      console.warn = original;
    }
    return seen.filter((m) => m.includes('holds the Postgres value'));
  };

  it('warns once per FIELD when the option is unset and an infinity is actually read', async () => {
    // Top-level rows arrive snake_case and nested json_build_object rows arrive
    // camelCase, so keying the once-only registry on the raw row key warned
    // twice for one column. The key is the resolved field.
    resetWarnOnce(WARN_NS.temporalInfinity);
    const notices = await captureWarnings(async () => {
      await db.table(PARENT).findMany({ where: { id: 1 } });
      await db.table(PARENT).findMany({ where: { id: 2 } });
      await db.table(CHILD).findMany({ where: { id: 10 }, with: { parent: true } });
    });
    const ts = notices.filter((m) => m.includes(`${PARENT}.ts holds`));
    assert.equal(ts.length, 1, `expected exactly one warning for ${PARENT}.ts, got ${ts.length}`);

    // The text has to describe the reading actually in force, not a reading the
    // caller would only get by opting in.
    assert.match(ts[0]!, /`Infinity` \/ `-Infinity`/);
    assert.match(ts[0]!, /TypeError/);
    assert.match(ts[0]!, /JSON\.stringify/);
    assert.match(ts[0]!, /IS NULL/);
    assert.match(ts[0]!, /groupBy/);
    assert.match(ts[0]!, /temporalInfinity: 'preserve'/);
    assert.match(ts[0]!, /'null'/);
  });

  it('stays silent when no row holds an infinity', async () => {
    resetWarnOnce(WARN_NS.temporalInfinity);
    const notices = await captureWarnings(() => db.table(PARENT).findMany({ where: { id: 3 } }));
    assert.deepEqual(notices, [], 'a table with an infinity-free result must not warn');
  });

  it('warns under NODE_ENV=production, where a destructive write would commit', async () => {
    // Deliberately NOT dev-only, unlike every other warning in the codebase:
    // production is where a read-modify-write lands and where the row cannot be
    // recovered afterwards.
    resetWarnOnce(WARN_NS.temporalInfinity);
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const notices = await captureWarnings(() => db.table(PARENT).findMany({ where: { id: 1 } }));
      assert.equal(notices.length > 0, true, 'expected the infinity warning under NODE_ENV=production');
    } finally {
      if (previous === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previous;
    }
  });

  it('is silent once the reading is named explicitly, either way', async () => {
    // Naming a reading is the acknowledgement. The warning exists to surface an
    // unacknowledged trade, including an unacknowledged DEFAULT.
    for (const temporalInfinity of ['null', 'preserve'] as const) {
      resetWarnOnce(WARN_NS.temporalInfinity);
      const client = new TurbineClient({ connectionString: DATABASE_URL!, temporalInfinity }, metadata);
      try {
        const notices = await captureWarnings(() => client.table(PARENT).findMany({ where: { id: 1 } }));
        assert.deepEqual(notices, [], `expected silence under temporalInfinity: '${temporalInfinity}'`);
      } finally {
        await client.disconnect();
      }
    }
  });
});
