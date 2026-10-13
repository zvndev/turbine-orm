/**
 * The fx-where rules against real engines: PostgreSQL (DATABASE_URL), MySQL
 * (MYSQL_URL, in a database of its own) and SQLite (node:sqlite), on the
 * fixture in fx-where-engines.ts. Each of these used to return or write the
 * wrong rows rather than fail:
 *
 *   - `NOT: { OR: [{ id: -1 }, {}] }` matched every row (the `{}` was dropped);
 *   - on MySQL `{ resetToken: 0 }` matched `'abc'` and `'0zz'`;
 *   - on SQLite a bare JSON document matched only byte-identical text;
 *   - `{ email: { contains: '' } }` and `{ author: {} }` deleted every row;
 *   - a JSON path key holding a backslash matched nothing;
 *   - on SQLite an Invalid Date in an `in` list matched nothing.
 */

import assert from 'node:assert/strict';
import { describe } from 'node:test';
import { UnsupportedFeatureError, ValidationError } from '../errors.js';
import { col } from '../query/column-ref.js';
import { UNSAFE } from '../query/types.js';
import {
  DATABASE_URL,
  type EngineHandle,
  HAVE_NODE_SQLITE,
  ids,
  MYSQL_URL,
  openMysql,
  openPostgres,
  openSqlite,
  POSTS_TABLE,
  USERS_TABLE,
} from './fx-where-engines.js';
import { type GatedRunners, skipGate } from './helpers.js';

// biome-ignore lint/suspicious/noExplicitAny: table accessors are untyped here
type Any = any;

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
];

function isE003(err: unknown): boolean {
  return err instanceof ValidationError;
}

for (const [name, gate, open] of ENGINES) {
  const { it, before, after } = gate;

  describe(`fx-where live: ${name}`, () => {
    let h: EngineHandle;
    const users = (): Any => h.db.table(USERS_TABLE);
    const posts = (): Any => h.db.table(POSTS_TABLE);
    before(async () => {
      h = await open();
    });
    after(async () => {
      await h?.close();
    });

    it('an OR with a branch that applies no condition is TRUE, and its NOT deletes nothing', async () => {
      assert.deepEqual(ids(await users().findMany({ where: { OR: [{ id: -1 }, {}] } })), [1, 2, 3, 4]);
      assert.equal(await users().count({ where: { NOT: { OR: [{ id: -1 }, {}] } } }), 0);
      await assert.rejects(users().deleteMany({ where: { OR: [{ id: 1 }, {}] } }), isE003);
      assert.deepEqual(await posts().deleteMany({ where: { NOT: { OR: [{ id: -1 }, {}] } } }), { count: 0 });
      assert.equal(await posts().count(), 4);
    });

    it('a number or boolean compared with a text column compares as text', async () => {
      assert.deepEqual(ids(await users().findMany({ where: { resetToken: 0 } })), []);
      assert.deepEqual(ids(await users().findMany({ where: { resetToken: 1 } })), [4]);
      assert.deepEqual(ids(await users().findMany({ where: { resetToken: { in: [0, 1] } } })), [4]);
      assert.deepEqual(ids(await users().findMany({ where: { resetToken: { notIn: [0] } } })), [1, 2, 4]);
      assert.deepEqual(ids(await posts().findMany({ where: { author: { is: { resetToken: 0 } } } })), []);
      assert.deepEqual(await users().updateMany({ where: { resetToken: 0 }, data: { score: 99 } }), { count: 0 });
      if (name === 'mysql') {
        // PostgreSQL refuses a boolean against text; MySQL used to read it as 0.
        assert.deepEqual(ids(await users().findMany({ where: { resetToken: false } })), []);
        assert.deepEqual(ids(await users().findMany({ where: { resetToken: { in: [false, 0] } } })), []);
      }
    });

    it('function global filters that reach each other apply once per chain', async () => {
      const db = await h.client({
        globalFilters: {
          [USERS_TABLE]: () => ({ posts: { some: {} } }),
          [POSTS_TABLE]: () => ({ author: { is: { tenant: 1 } } }),
        },
      });
      // Users with a post whose author is in tenant 1: ann (1) and bob (2).
      assert.deepEqual(ids(await (db.table(USERS_TABLE) as Any).findMany()), [1, 2]);
      // Posts by a tenant-1 author who has a post: 1, 2, 3.
      assert.deepEqual(ids(await (db.table(POSTS_TABLE) as Any).findMany()), [1, 2, 3]);
      assert.equal(await db.table(POSTS_TABLE).count(), 3);
    });

    it('static global filters that reach each other are refused when the client is built', async () => {
      await assert.rejects(
        h.refusedClient({
          globalFilters: {
            [USERS_TABLE]: { posts: { some: {} } },
            [POSTS_TABLE]: { author: { is: { tenant: 1 } } },
          },
        }),
        /reaches "fxwh_posts" through "fxwh_users\.posts"/,
      );
    });

    it('a whole JSON document compares as JSON, or is refused (E017)', async () => {
      const reordered = { where: { data: { b: 3, a: 2 } } };
      const negated = { where: { NOT: { data: { b: 3, a: 2 } } } };
      if (name === 'sqlite') {
        await assert.rejects(users().findMany(reordered), UnsupportedFeatureError);
        await assert.rejects(users().findMany(negated), UnsupportedFeatureError);
        await assert.rejects(users().findMany({ where: { data: { not: { a: 1 } } } }), UnsupportedFeatureError);
      } else {
        assert.deepEqual(ids(await users().findMany(reordered)), [4]);
        assert.deepEqual(ids(await users().findMany(negated)), [1, 2]);
      }
    });

    it('the mass-mutation guard refuses a where that is TRUE because a column is NOT NULL', async () => {
      const refused: [Any, Record<string, unknown>][] = [
        [users(), { email: { contains: '' } }],
        [users(), { name: { startsWith: '', mode: 'insensitive' } }],
        [users(), { id: { not: null } }],
        [users(), { id: { equals: col('id') } }],
        [posts(), { title: { endsWith: '' } }],
      ];
      // SQLite enforces a declared foreign key only when the connection turned it on.
      if (name !== 'sqlite') refused.push([posts(), { author: {} }], [posts(), { author: { isNot: null } }]);
      for (const [table, where] of refused) {
        await assert.rejects(table.deleteMany({ where }), isE003, JSON.stringify(where));
        await assert.rejects(table.updateMany({ where, data: { id: 9 } }), isE003, JSON.stringify(where));
      }
      assert.equal(await users().count(), 4);
      assert.equal(await posts().count(), 4);
      // Each of those really was every row.
      assert.equal(await users().count({ where: { email: { contains: '' } } }), 4);
      assert.equal(await posts().count({ where: { author: {} } }), 4);
    });

    it('a filter on a nullable column or foreign key still narrows and runs', async () => {
      try {
        assert.deepEqual(await posts().updateMany({ where: { editor: {} }, data: { title: 'e' } }), { count: 2 });
        assert.deepEqual(await users().updateMany({ where: { resetToken: { contains: '' } }, data: { score: 1 } }), {
          count: 3,
        });
      } finally {
        await h.reset();
      }
    });

    it('allowFullTableScan: UNSAFE still writes every row', async () => {
      try {
        const result = await users().updateMany({
          where: { email: { contains: '' } },
          data: { score: 1 },
          allowFullTableScan: UNSAFE,
        });
        assert.equal(result.count, 4);
      } finally {
        await h.reset();
      }
    });

    it('`is` on a to-many relation is refused; the quantifiers on a to-one keep working', async () => {
      await assert.rejects(users().findMany({ where: { posts: { is: { title: 'p1' } } } }), /write `some`/);
      await assert.rejects(users().deleteMany({ where: { posts: { isNot: null } } }), /write `some: \{\}`/);
      assert.deepEqual(ids(await posts().findMany({ where: { author: { some: { name: 'ann' } } } })), [1, 2]);
      assert.deepEqual(ids(await posts().findMany({ where: { editor: { none: {} } } })), [1, 3]);
    });

    it('a JSON path key holding a backslash or a quote finds its value', async () => {
      assert.deepEqual(ids(await users().findMany({ where: { data: { path: ['a\\b'], equals: 2 } } })), [2]);
      assert.deepEqual(ids(await users().findMany({ where: { data: { path: ['q"k'], equals: 3 } } })), [2]);
    });

    it('`lock` and a filtered `_count` in `with` are refused', async () => {
      await assert.rejects(users().findMany({ with: { posts: { lock: 'update' } } }), /`lock` is not an option/);
      await assert.rejects(
        users().findMany({ with: { _count: { posts: { where: { title: 'p1' } } } } }),
        /`_count\.posts` in `with` on "fxwh_users" takes true/,
      );
    });

    it('an Invalid Date is refused at every operator, in a list too', async () => {
      const bad = new Date('nope');
      for (const where of [
        { createdAt: bad },
        { createdAt: { gt: bad } },
        { createdAt: { in: [bad] } },
        { createdAt: { notIn: [bad] } },
      ]) {
        await assert.rejects(users().findMany({ where }), /an Invalid Date/, JSON.stringify(where));
      }
      assert.equal(await users().count({ where: { createdAt: { notIn: [new Date(0)] } } }), 4);
    });
  });
}
