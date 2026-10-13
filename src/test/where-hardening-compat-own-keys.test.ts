/**
 * prisma-compat reads its map, the schema and caller keys as OWN properties.
 *
 * Prisma model and field names may be `constructor`, `toString` or
 * `valueOf`, and a map read with plain bracket access answers those from
 * `Object.prototype`: a scalar field called `constructor` would be taken for a
 * relation, the `constructor` accessor of a model named `Constructor` would
 * never be created, and a caller key the map does not know would resolve to a
 * function. A caller key spelled `__proto__` (an ordinary own key out of
 * `JSON.parse`) assigned onto a rebuilt argument object replaces its prototype
 * and drops the filter, so a `findMany` would return every row.
 *
 * Build-only, plus a live block that needs DATABASE_URL.
 *
 * Run: DATABASE_URL=... npx tsx --test src/test/where-hardening-compat-own-keys.test.ts
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import pg from 'pg';
import { TurbineClient } from '../client.js';
import { ValidationError } from '../errors.js';
import { introspect } from '../introspect.js';
import { type CompatTurbineClient, createPrismaCompatClient } from '../prisma-compat.js';
import type { PrismaCompatMap, SchemaMetadata } from '../schema.js';
import { makeQuery, mockTable, skipGate } from './helpers.js';

// biome-ignore lint/suspicious/noExplicitAny: the compat delegates are untyped here
type Any = any;

function schema(): SchemaMetadata {
  const owners = mockTable('wh_ok_owners', [
    { name: 'id', field: 'id' },
    { name: 'name', field: 'name', pgType: 'text' },
  ]);
  const records = mockTable(
    'wh_ok_records',
    [
      { name: 'id', field: 'id' },
      { name: 'constructor', field: 'constructor', pgType: 'text' },
      { name: 'to_string', field: 'toString', pgType: 'text' },
      { name: 'owner_id', field: 'ownerId' },
    ],
    {
      whOkOwner: {
        type: 'belongsTo',
        name: 'whOkOwner',
        from: 'wh_ok_records',
        to: 'wh_ok_owners',
        foreignKey: 'owner_id',
        referenceKey: 'id',
      },
    },
  );
  return { enums: {}, tables: { wh_ok_owners: owners, wh_ok_records: records } };
}

function compatMap(ownerRelation: string): PrismaCompatMap {
  return {
    enums: {},
    models: {
      Constructor: {
        table: 'wh_ok_records',
        accessor: 'whOkRecords',
        fields: { id: 'id', constructor: 'constructor', toString: 'toString', ownerId: 'ownerId' },
        relations: { owner: { name: ownerRelation, cardinality: 'one' } },
        compoundUniques: {},
      },
      Owner: {
        table: 'wh_ok_owners',
        accessor: 'whOkOwners',
        fields: { id: 'id', name: 'name' },
        relations: {},
        compoundUniques: {},
      },
    },
  };
}

/** A client whose model ops build real SQL via `makeQuery` (null pool). */
function sqlDb(s: SchemaMetadata): CompatTurbineClient {
  const table = (name: string) => makeQuery(name, s) as Any;
  return {
    schema: s,
    table,
    $transaction: (async (fn: (tx: unknown) => unknown) => fn({ table })) as Any,
  } as unknown as CompatTurbineClient;
}

function compatClient(): Any {
  const s = schema();
  return createPrismaCompatClient(sqlDb(s) as unknown as TurbineClient, compatMap('whOkOwner'));
}

/** Build the SQL a lazy delegate call would run, without executing it. */
function sqlOf(promise: unknown): { sql: string; params: unknown[] } {
  const deferred = (promise as Any)[Object.getOwnPropertySymbols(promise as object)[0] as symbol];
  return deferred.build();
}

function refusedNaming(key: string) {
  return (err: unknown): boolean => {
    assert.ok(err instanceof ValidationError, `expected ValidationError, got ${String(err)}`);
    assert.equal(err.code, 'TURBINE_E003');
    assert.ok(err.message.includes(`"${key}"`), err.message);
    return true;
  };
}

describe('prisma-compat: map lookups are own-key reads', () => {
  it('a model named Constructor gets its `constructor` accessor, on the client and inside $transaction', async () => {
    const compat = compatClient();
    assert.equal(typeof compat.constructor.findMany, 'function', 'not Object.prototype.constructor');
    assert.equal(compat.constructor, compat.Constructor);
    const inTx = await compat.$transaction(async (tx: Any) => typeof tx.constructor.findMany);
    assert.equal(inTx, 'function');
  });

  it('fields named `constructor` and `toString` are scalar fields, not relations', () => {
    const compat = compatClient();
    const { sql, params } = sqlOf(compat.Constructor.findMany({ where: { constructor: 'a', toString: 'b' } }));
    assert.match(
      sql,
      /WHERE \("wh_ok_records"\."constructor" = \$1 AND "wh_ok_records"\."to_string" = \$2\)|"constructor" = \$1 AND "to_string" = \$2/,
      sql,
    );
    assert.deepEqual(params, ['a', 'b']);
    const ordered = sqlOf(
      compat.Constructor.findMany({ orderBy: { constructor: 'desc' }, select: { toString: true } }),
    );
    assert.match(ordered.sql, /ORDER BY "constructor" DESC/, ordered.sql);
    assert.match(ordered.sql, /"to_string"/, ordered.sql);
  });

  it('a caller key the map does not know reaches core by its own name', () => {
    const compat = compatClient();
    assert.throws(() => sqlOf(compat.Owner.findMany({ where: { constructor: 'a' } })), refusedNaming('constructor'));
    assert.throws(() => sqlOf(compat.Owner.findMany({ where: { valueOf: 1 } })), refusedNaming('valueOf'));
  });

  it('a `__proto__` key from parsed input is refused, never dropped', () => {
    const compat = compatClient();
    const where = JSON.parse('{"__proto__": {"id": 1}}');
    assert.throws(() => sqlOf(compat.Owner.deleteMany({ where })), refusedNaming('__proto__'));
    assert.throws(() => sqlOf(compat.Owner.findMany({ where })), refusedNaming('__proto__'));
    const beside = JSON.parse('{"id": 1, "__proto__": {"name": "x"}}');
    assert.throws(
      () => sqlOf(compat.Owner.updateMany({ where: beside, data: { name: 'y' } })),
      refusedNaming('__proto__'),
    );
    const data = JSON.parse('{"name": "x", "__proto__": {"id": 9}}');
    assert.throws(() => sqlOf(compat.Owner.create({ data })), refusedNaming('__proto__'));
  });

  it('core refuses a `__proto__` where key itself, including below the undefined-pruning copy', () => {
    const q = makeQuery('wh_ok_owners', schema());
    assert.throws(
      () => q.buildDeleteMany({ where: JSON.parse('{"__proto__": {"id": 1}}') } as Any),
      refusedNaming('__proto__'),
    );
    const withUndefined = JSON.parse('{"__proto__": {"id": 1}}');
    withUndefined.name = undefined;
    assert.throws(() => q.buildFindMany({ where: withUndefined } as Any), refusedNaming('__proto__'));
  });
});

const DATABASE_URL = process.env.DATABASE_URL;
const live = skipGate(!DATABASE_URL, 'requires DATABASE_URL');

async function runSql(statements: string[]): Promise<void> {
  const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 1 });
  try {
    for (const sql of statements) await pool.query(sql);
  } finally {
    await pool.end();
  }
}

describe('prisma-compat: rows of a model with fields named like Object.prototype members (live)', () => {
  let db: TurbineClient;
  let compat: Any;

  live.before(async () => {
    await runSql([
      'DROP TABLE IF EXISTS wh_ok_records, wh_ok_owners',
      'CREATE TABLE wh_ok_owners (id int PRIMARY KEY, name text NOT NULL)',
      'CREATE TABLE wh_ok_records (id int PRIMARY KEY, "constructor" text, to_string text, owner_id int REFERENCES wh_ok_owners(id))',
      "INSERT INTO wh_ok_owners VALUES (1, 'ada')",
      "INSERT INTO wh_ok_records VALUES (1, 'c1', 's1', 1), (2, 'c2', 's2', NULL)",
    ]);
    const s = await introspect({ connectionString: DATABASE_URL!, include: ['wh_ok_owners', 'wh_ok_records'] });
    const rel = Object.values(s.tables.wh_ok_records!.relations).find((r) => r.type === 'belongsTo');
    assert.ok(rel, 'introspection found the belongsTo relation');
    db = new TurbineClient({ connectionString: DATABASE_URL!, poolSize: 1, warnOnUnlimited: false }, s);
    compat = createPrismaCompatClient(db, compatMap(rel.name));
  });

  live.after(async () => {
    await db?.disconnect();
    await runSql(['DROP TABLE IF EXISTS wh_ok_records, wh_ok_owners']);
  });

  live.it('reshapes `constructor` and `toString` as the scalar values they are', async () => {
    const rows = await compat.constructor.findMany({ include: { owner: true }, orderBy: { id: 'asc' } });
    assert.deepEqual(rows, [
      { id: 1, constructor: 'c1', toString: 's1', ownerId: 1, owner: { id: 1, name: 'ada' } },
      { id: 2, constructor: 'c2', toString: 's2', ownerId: null, owner: null },
    ]);
    for (const row of rows) assert.ok(Object.hasOwn(row, 'constructor'));
  });

  live.it('reads and writes through the transaction-scoped `constructor` accessor', async () => {
    const updated = await compat.$transaction(async (tx: Any) =>
      tx.constructor.update({ where: { id: 2 }, data: { constructor: 'c2b' }, select: { constructor: true } }),
    );
    assert.deepEqual(updated, { constructor: 'c2b' });
  });
});
