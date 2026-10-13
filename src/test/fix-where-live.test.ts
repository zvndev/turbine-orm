/**
 * The fix-where rules against real engines: PostgreSQL (DATABASE_URL), MySQL
 * (MYSQL_URL), SQLite (node:sqlite) and embedded PowDB, on the fixture in
 * fix-where-engines.ts. Each of these shapes used to return or write the wrong
 * rows rather than fail:
 *
 *   - `posts: { some: null }` matched every row;
 *   - `deleteMany({ where: { NOT: { OR: [] } } })` deleted the table;
 *   - `cursor: {}` restarted the walk with a different order;
 *   - `findFirst({ orderBy, offset })` picked among ties at random;
 *   - `data: { not: { gt: 1 } }` compared against the document `{"gt":1}`;
 *   - on MySQL, `data: { a: 1 }` matched nothing and `NOT` of it everything.
 */

import assert from 'node:assert/strict';
import { describe } from 'node:test';
import { UnsupportedFeatureError, ValidationError } from '../errors.js';
import { jsonValue } from '../query/json-value.js';
import { UNSAFE } from '../query/types.js';
import {
  DATABASE_URL,
  type EngineHandle,
  HAVE_NODE_SQLITE,
  ids,
  MYSQL_URL,
  openMysql,
  openPostgres,
  openPowdb,
  openSqlite,
  powdbEmbeddedLoads,
} from './fix-where-engines.js';
import { type GatedRunners, skipGate } from './helpers.js';

// biome-ignore lint/suspicious/noExplicitAny: table accessors are untyped here
type Any = any;

const POWDB = await powdbEmbeddedLoads();

// One skip gate per engine, each with its own literal reason, so the skip-gate
// guard can read every reason and TURBINE_REQUIRE_ENGINE can force each suite.
const ENGINES: [EngineHandle['name'], GatedRunners, () => Promise<EngineHandle>][] = [
  ['postgresql', skipGate(!DATABASE_URL, 'requires DATABASE_URL'), () => openPostgres()],
  [
    'mysql',
    skipGate(!MYSQL_URL, 'requires MYSQL_URL / MYSQL_TEST_URL pointing at a MySQL 8 server'),
    () => openMysql(),
  ],
  ['sqlite', skipGate(!HAVE_NODE_SQLITE, 'turbine-orm/sqlite requires node:sqlite (Node >= 22.5)'), () => openSqlite()],
  [
    'powdb',
    skipGate(!POWDB, 'requires @zvndev/powdb-embedded (no prebuilt binary on this platform)'),
    () => openPowdb(),
  ],
];

function isE003(err: unknown): boolean {
  return err instanceof ValidationError;
}

for (const [name, gate, open] of ENGINES) {
  const { it, before, after } = gate;

  describe(`fix-where live: ${name}`, () => {
    let h: EngineHandle;
    const users = (): Any => h.db.table('fw_users');
    before(async () => {
      h = await open();
    });
    after(async () => {
      await h?.close();
    });

    it('some: {} and none: {} split the rows by whether they have posts', async () => {
      assert.deepEqual(ids(await users().findMany({ where: { posts: { some: {} } } })), [1, 2, 4]);
      assert.deepEqual(ids(await users().findMany({ where: { posts: { none: {} } } })), [3, 5, 6]);
    });

    it('some: null and every: 5 are refused instead of matching every row', async () => {
      await assert.rejects(users().findMany({ where: { posts: { some: null } } }), isE003);
      await assert.rejects(users().findMany({ where: { posts: { every: 5 } } }), isE003);
      await assert.rejects(users().deleteMany({ where: { posts: { none: null } } }), isE003);
      assert.equal(await users().count(), 6, 'nothing was deleted');
    });

    it('an always-true where is refused by deleteMany and updateMany, and nothing changes', async () => {
      for (const where of [{ NOT: { OR: [] } }, { id: { notIn: [] } }, { posts: { none: { OR: [] } } }]) {
        await assert.rejects(users().deleteMany({ where }), isE003, JSON.stringify(where));
        await assert.rejects(users().updateMany({ where, data: { name: 'zz' } }), isE003, JSON.stringify(where));
      }
      assert.equal(await users().count(), 6);
      assert.equal(await users().count({ where: { name: 'zz' } }), 0);
    });

    it('allowFullTableScan: UNSAFE still writes every row', async () => {
      try {
        const result = await users().updateMany({
          where: { id: { notIn: [] } },
          data: { name: 'all' },
          allowFullTableScan: UNSAFE,
        });
        assert.equal(result.count, 6);
      } finally {
        await h.reset();
      }
    });

    it('an always-false where deletes nothing and is not refused', async () => {
      const result = await users().deleteMany({ where: { OR: [] } });
      assert.equal(result.count, 0);
      assert.equal(await users().count(), 6);
    });

    // PowDB has no cursor paging (E017); its refusals of malformed cursors are below.
    for (const orderBy of name === 'powdb' ? [] : ([{ tenant: 'asc' }, { score: 'asc' }, { score: 'desc' }] as const)) {
      it(`a cursor walk ordered by ${JSON.stringify(orderBy)} visits every row once, in the full order`, async () => {
        const field = Object.keys(orderBy)[0] as string;
        // The tiebreaker follows the last term's direction.
        const dir = Object.values(orderBy)[0];
        const expected = (await users().findMany({ orderBy: [orderBy, { id: dir }] })).map((r: Any) => Number(r.id));
        assert.equal(expected.length, 6);
        const seen: number[] = [];
        let page = await users().findMany({ orderBy, limit: 2 });
        for (let guard = 0; page.length > 0 && guard < 10; guard++) {
          seen.push(...page.map((r: Any) => Number(r.id)));
          const last = page[page.length - 1];
          page = await users().findMany({ orderBy, limit: 2, cursor: { id: last.id } });
        }
        assert.deepEqual(seen, expected, `walk by ${field}`);
      });
    }

    it('cursor: {} and cursor: null are refused rather than restarting the walk', async () => {
      await assert.rejects(users().findMany({ orderBy: { tenant: 'asc' }, limit: 2, cursor: {} }), isE003);
      await assert.rejects(users().findMany({ orderBy: { tenant: 'asc' }, limit: 2, cursor: null }), isE003);
      await assert.rejects(
        users().findMany({ orderBy: { tenant: 'asc' }, limit: 2, cursor: { id: undefined } }),
        isE003,
      );
      await assert.rejects(users().findMany({ orderBy: { tenant: 'asc' }, limit: 2, cursor: { id: null } }), isE003);
    });

    it('findFirst with an offset breaks ties by the primary key', async () => {
      for (let offset = 0; offset < 6; offset++) {
        const row = await users().findFirst({ orderBy: { tenant: 'asc' }, offset });
        assert.equal(Number(row?.id), offset + 1, `offset ${offset}`);
      }
    });

    it('not with an operator-only object on a JSON column is refused', async () => {
      await assert.rejects(users().findMany({ where: { data: { not: { gt: 1 } } } }), isE003);
      await assert.rejects(users().findMany({ where: { data: { not: { contains: { a: 1 } } } } }), isE003);
    });

    if (name === 'postgresql' || name === 'mysql') {
      it('not against a document, written either supported way, excludes that document', async () => {
        // Row 6 holds exactly {"a":1}; row 4 holds NULL, which NOT (...) leaves out.
        assert.deepEqual(ids(await users().findMany({ where: { data: { not: { equals: { a: 1 } } } } })), [1, 2, 3, 5]);
        assert.deepEqual(ids(await users().findMany({ where: { data: { not: jsonValue({ a: 1 }) } } })), [1, 2, 3, 5]);
      });

      it('a bare document matches the equal document, in any key order, and NOT of it the rest', async () => {
        assert.deepEqual(ids(await users().findMany({ where: { data: { a: 1 } } })), [6]);
        assert.deepEqual(ids(await users().findMany({ where: { data: { equals: { a: 1 } } } })), [6]);
        assert.deepEqual(ids(await users().findMany({ where: { data: { tags: ['x'], a: 1 } } })), [1]);
        assert.deepEqual(ids(await users().findMany({ where: { NOT: { data: { a: 1 } } } })), [1, 2, 3, 5]);
        // `contains` is the containment filter, not a document with that key.
        assert.deepEqual(ids(await users().findMany({ where: { data: { contains: { a: 1 } } } })), [1, 6]);
      });
    }

    if (name === 'powdb') {
      it('whole-document comparison stays unsupported (E017), so the written alternatives say so', async () => {
        await assert.rejects(
          users().findMany({ where: { data: { not: { equals: { a: 1 } } } } }),
          (err: unknown) => err instanceof UnsupportedFeatureError,
        );
      });
    }
  });
}
