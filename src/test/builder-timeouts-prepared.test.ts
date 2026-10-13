/**
 * Named prepared statements are bounded per process, so per connection.
 *
 * Every connection keeps each named statement it prepares until it closes,
 * so caller-chosen filter shapes used to grow server memory without limit.
 * Past {@link PREPARED_STATEMENT_BUDGET} distinct names a statement is sent
 * unnamed instead.
 *
 * The live half needs a reachable Postgres and creates its own table:
 *   DATABASE_URL=postgres://... npx tsx --test src/test/builder-timeouts-prepared.test.ts
 */

import assert from 'node:assert/strict';
import { describe, it as unitIt } from 'node:test';
import pg from 'pg';
import { TurbineClient } from '../client.js';
import {
  boundedPreparedName,
  PREPARED_STATEMENT_BUDGET,
  resetPreparedNameBudget,
  sqlToPreparedName,
} from '../query/utils.js';
import type { SchemaMetadata } from '../schema.js';
import { makeQuery, mockTable, skipGate } from './helpers.js';

const DATABASE_URL = process.env.DATABASE_URL;
const { it, before, after } = skipGate(!DATABASE_URL, 'DATABASE_URL not set');

const COLUMNS = ['c1', 'c2', 'c3', 'c4', 'c5', 'c6'];
const SCHEMA: SchemaMetadata = {
  enums: {},
  tables: {
    bt_shapes: mockTable('bt_shapes', [
      { name: 'id', field: 'id', pgType: 'int4' },
      ...COLUMNS.map((c) => ({ name: c, field: c, pgType: 'int4' })),
    ]),
  },
};

/** The `n`th distinct where shape over six columns: absent, equals, gt, lt or in, per column. */
function shape(n: number): Record<string, unknown> {
  const where: Record<string, unknown> = {};
  let rest = n;
  for (const c of COLUMNS) {
    const form = rest % 5;
    rest = Math.floor(rest / 5);
    if (form === 1) where[c] = 1;
    else if (form === 2) where[c] = { gt: 0 };
    else if (form === 3) where[c] = { lt: 5 };
    else if (form === 4) where[c] = { in: [1, 2] };
  }
  return where;
}

describe('prepared-statement budget', () => {
  unitIt('names statements until the budget is spent, then sends the rest unnamed', () => {
    resetPreparedNameBudget();
    for (let i = 0; i < PREPARED_STATEMENT_BUDGET; i++) {
      assert.equal(boundedPreparedName(`SELECT ${i}`), sqlToPreparedName(`SELECT ${i}`));
    }
    assert.equal(boundedPreparedName('SELECT past_the_budget'), '');
    // A statement named before the budget ran out keeps its name.
    assert.equal(boundedPreparedName('SELECT 0'), sqlToPreparedName('SELECT 0'));
    resetPreparedNameBudget();
  });

  unitIt('a built query past the budget carries no name, and its SQL is unchanged', () => {
    resetPreparedNameBudget();
    const named = makeQuery('bt_shapes', SCHEMA).buildFindMany({ where: shape(1) } as never);
    assert.match(named.preparedName ?? '', /^t_[0-9a-f]{16}$/);
    for (let i = 2; i < PREPARED_STATEMENT_BUDGET + 50; i++) {
      makeQuery('bt_shapes', SCHEMA).buildFindMany({ where: shape(i) } as never);
    }
    const late = makeQuery('bt_shapes', SCHEMA).buildFindMany({
      where: shape(PREPARED_STATEMENT_BUDGET + 60),
    } as never);
    assert.equal(late.preparedName, '');
    assert.match(late.sql, /WHERE/);
    const again = makeQuery('bt_shapes', SCHEMA).buildFindMany({ where: shape(1) } as never);
    assert.equal(again.preparedName, named.preparedName);
    resetPreparedNameBudget();
  });

  describe('live: one connection, many shapes', () => {
    let admin: pg.Client;

    before(async () => {
      admin = new pg.Client({ connectionString: DATABASE_URL });
      await admin.connect();
      await admin.query('DROP TABLE IF EXISTS bt_shapes');
      await admin.query(`CREATE TABLE bt_shapes (id int PRIMARY KEY, ${COLUMNS.map((c) => `${c} int`).join(', ')})`);
      await admin.query(
        `INSERT INTO bt_shapes SELECT g, ${COLUMNS.map(() => 'g % 4').join(', ')} FROM generate_series(1, 20) g`,
      );
    });

    after(async () => {
      await admin?.query('DROP TABLE IF EXISTS bt_shapes');
      await admin?.end();
    });

    it(`the connection holds at most ${PREPARED_STATEMENT_BUDGET} named statements after 600 shapes`, async () => {
      resetPreparedNameBudget();
      const db = new TurbineClient({ connectionString: DATABASE_URL, poolSize: 1, warnOnUnlimited: false }, SCHEMA);
      try {
        for (let i = 1; i <= 600; i++) {
          const where = shape(i);
          const rows = (await db.table('bt_shapes').findMany({ where })) as Record<string, number>[];
          const counted = await admin.query(`SELECT count(*)::int AS n FROM bt_shapes WHERE ${sqlFor(where)}`);
          const expected = counted.rows[0].n as number;
          assert.equal(rows.length, expected, `shape ${i} returned the wrong rows`);
        }
        const counted = (await db.raw`SELECT count(*)::int AS n FROM pg_prepared_statements`) as { n: number }[];
        const n = counted[0]?.n ?? 0;
        assert.ok(n <= PREPARED_STATEMENT_BUDGET, `${n} named statements on one connection`);
        assert.ok(n >= PREPARED_STATEMENT_BUDGET / 2, `only ${n} named statements: the budget names nothing`);
      } finally {
        await db.disconnect();
        resetPreparedNameBudget();
      }
    });
  });
});

/** The same filter as plain SQL, for the oracle count. */
function sqlFor(where: Record<string, unknown>): string {
  const parts = Object.entries(where).map(([c, v]) => {
    if (typeof v === 'number') return `${c} = ${v}`;
    const op = v as { gt?: number; lt?: number; in?: number[] };
    if (op.gt !== undefined) return `${c} > ${op.gt}`;
    if (op.lt !== undefined) return `${c} < ${op.lt}`;
    return `${c} IN (${(op.in ?? []).join(', ')})`;
  });
  return parts.length > 0 ? parts.join(' AND ') : 'true';
}
