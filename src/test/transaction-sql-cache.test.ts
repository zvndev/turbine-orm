/**
 * turbine-orm: transactions share the SQL template cache (0.90.2)
 *
 * A transaction builds its own QueryInterface per table. Each one used to start
 * with an EMPTY template cache, so every statement inside every `$transaction`
 * rebuilt its SQL. The caches are now shared by every QueryInterface built from
 * one options OBJECT, for one schema and one table, and TransactionClient hands
 * all of a client's transactions the same options object.
 *
 * The key is the options object's identity, never a fingerprint of its fields:
 * options change the SQL (`defaultLimit`, `globalFilters`, ...) without being in
 * the cache key, so two configurations must never share. These tests pin both
 * halves: the sharing happens, and a different configuration is not served
 * another's SQL.
 *
 * Run: npx tsx --test src/test/transaction-sql-cache.test.ts
 */

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { describe, it } from 'node:test';
import { TurbineClient } from '../client.js';
import { txQueryOptions } from '../query/builder.js';
import { QueryInterface, type QueryInterfaceOptions } from '../query/index.js';
import type { SchemaMetadata } from '../schema.js';
import { mockTable } from './helpers.js';

/** A connection that answers every statement with no rows. */
class FakeConn extends EventEmitter {
  readonly queries: string[] = [];
  async query(sql: unknown): Promise<unknown> {
    this.queries.push(typeof sql === 'string' ? sql : String((sql as { text?: string }).text));
    return { rows: [], rowCount: 0, command: 'SELECT', fields: [] };
  }
  release(): void {}
}

function fakePool() {
  const conns: FakeConn[] = [];
  return {
    query: async () => ({ rows: [], rowCount: 0, command: 'SELECT', fields: [] }),
    connect: async () => {
      const c = new FakeConn();
      conns.push(c);
      return c;
    },
    end: async () => {},
    on() {},
    conns,
  };
}

function schema(): SchemaMetadata {
  return {
    enums: {},
    tables: {
      users: mockTable('users', [
        { name: 'id', field: 'id' },
        { name: 'name', field: 'name', pgType: 'text' },
        { name: 'org_id', field: 'orgId' },
      ]),
    },
  };
}

// biome-ignore lint/suspicious/noExplicitAny: a fake pool stands in for pg.Pool
type Any = any;

describe('transactions share the SQL template cache', () => {
  it("a second transaction's statement is a cache hit", async () => {
    const db = new TurbineClient({ pool: fakePool() as Any, warnOnUnlimited: false }, schema());
    const stats: { hits: number; misses: number }[] = [];
    for (let i = 0; i < 3; i++) {
      await db.$transaction(async (tx: Any) => {
        await tx.users.findMany({ where: { orgId: i } });
        stats.push(tx.users.cacheStats());
      });
    }
    assert.deepEqual(
      stats.map((s) => [s.hits, s.misses]),
      [
        [0, 1],
        [1, 0],
        [1, 0],
      ],
    );
  });

  it('every statement shape reads the shared cache, writes included', async () => {
    const db = new TurbineClient({ pool: fakePool() as Any, warnOnUnlimited: false }, schema());
    const build = (tx: Any, i: number) => {
      tx.users.buildCount({ where: { orgId: i } });
      tx.users.buildUpdateMany({ where: { orgId: i }, data: { name: `n${i}` } });
      tx.users.buildFindUnique({ where: { id: i } });
    };
    await db.$transaction(async (tx: Any) => build(tx, 1));
    await db.$transaction(async (tx: Any) => {
      build(tx, 2);
      assert.deepEqual(tx.users.cacheStats().hits, 3);
      assert.deepEqual(tx.users.cacheStats().misses, 0);
    });
  });
});

describe('a different configuration never shares a cache', () => {
  it('two clients over one schema object, one ordering by primary key, each emit their own SQL', async () => {
    const shared = schema();
    const plain = new TurbineClient({ pool: fakePool() as Any, warnOnUnlimited: false }, shared);
    // `implicitPkOrdering` changes the SQL and is NOT in the cache key (one
    // QueryInterface only ever sees one value), so a shared cache would serve
    // the plain client's statement here.
    const ordered = new TurbineClient(
      { pool: fakePool() as Any, implicitPkOrdering: true, warnOnUnlimited: false },
      shared,
    );
    const sqlOf = async (db: TurbineClient) => {
      let sql = '';
      await db.$transaction(async (tx: Any) => {
        sql = tx.users.buildFindMany({ where: { orgId: 1 }, limit: 10 }).sql;
      });
      return sql;
    };
    // Warm the plain client first, so a shared cache would hand its SQL on.
    const a = await sqlOf(plain);
    const b = await sqlOf(ordered);
    assert.doesNotMatch(a, /ORDER BY/);
    assert.match(b, /ORDER BY "id"/);
    assert.doesNotMatch(await sqlOf(plain), /ORDER BY/);
  });

  it('query interfaces share exactly when they share an options object and a schema object', () => {
    // The same args throughout, so the cache key is the same and only the
    // sharing decides hit or miss.
    const args = { where: { orgId: 1 }, limit: 10 };
    const s = schema();
    const options: QueryInterfaceOptions = { warnOnUnlimited: false };
    const qi = (opts: QueryInterfaceOptions | undefined, sch: SchemaMetadata = s) =>
      new QueryInterface<Any>(null as Any, 'users', sch, undefined, opts);
    const hitsAfterBuild = (q: QueryInterface<Any>) => {
      q.buildFindMany(args);
      return q.cacheStats().hits;
    };

    assert.equal(hitsAfterBuild(qi(options)), 0, 'first build warms the cache');
    assert.equal(hitsAfterBuild(qi(options)), 1, 'same options object, same schema: shared');
    // A copy is another configuration, even one whose change does not touch
    // the SQL: identity is the rule, so no list of SQL-affecting fields exists.
    assert.equal(hitsAfterBuild(qi({ ...options })), 0, 'a copied options object must not share');
    assert.equal(hitsAfterBuild(qi(options, schema())), 0, 'another schema object must not share');
    assert.equal(hitsAfterBuild(qi(undefined)), 0, 'no options keeps a private cache');
  });
});

describe('transaction options are one object per client options object', () => {
  it('every transaction, and every nested write inside one, gets the same object', () => {
    const options: QueryInterfaceOptions = { warnOnUnlimited: false };
    const tx = txQueryOptions(options);
    assert.equal(tx._txScoped, true);
    assert.equal(txQueryOptions(options), tx, 'a second transaction');
    // A nested write inside a transaction starts from the transaction's own
    // options, which are already transaction-scoped: the same object comes back,
    // so its child statements share the transaction's caches.
    assert.equal(txQueryOptions(tx), tx);
    assert.notEqual(txQueryOptions({ ...options }), tx, 'another options object is another configuration');
  });
});
