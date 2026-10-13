/**
 * turbine-orm: the write bind seam for JSON columns and value shapes, at the
 * SQL + params level (no database).
 *
 * The live counterpart (`writes-json-live.test.ts`) proves the stored values;
 * this file pins what each builder binds, the cache-hit param path, the
 * per-engine scope of each refusal, and the bind-parameter limit.
 *
 * Run: npx tsx --test src/test/writes-json-build.test.ts
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Dialect } from '../dialect.js';
import { maxBindParameters } from '../dialect.js';
import { ValidationError } from '../errors.js';
import { mssqlDialect } from '../mssql.js';
import { mysqlDialect } from '../mysql.js';
import { isJsonValue, jsonValue } from '../query/json-value.js';
import type { SchemaMetadata } from '../schema.js';
import { sqliteDialect } from '../sqlite.js';
import { makeQuery, mockTable } from './helpers.js';

function schema(): SchemaMetadata {
  const docs = mockTable('docs', [
    { name: 'id', field: 'id', pgType: 'int4' },
    { name: 'slug', field: 'slug', pgType: 'text', unique: true },
    { name: 'title', field: 'title', pgType: 'text' },
    { name: 'n', field: 'n', pgType: 'int4' },
    { name: 'data', field: 'data', pgType: 'jsonb' },
    { name: 'doc', field: 'doc', pgType: 'json' },
    { name: 'tags', field: 'tags', pgType: '_text' },
    { name: 'mood', field: 'mood', pgType: 'mood_t' },
    { name: 'updated_at', field: 'updatedAt', pgType: 'timestamptz' },
  ]);
  docs.columns.find((c) => c.name === 'updated_at')!.updatedAt = true;
  return { enums: {}, tables: { docs } };
}

const q = (dialect?: Dialect) =>
  makeQuery<Record<string, unknown>>('docs', schema(), dialect ? { dialect } : undefined);

describe('jsonValue', () => {
  it('is branded with a registry symbol that JSON.parse cannot produce', () => {
    assert.equal(isJsonValue(jsonValue('x')), true);
    assert.equal(isJsonValue(JSON.parse('{"value":"x"}')), false);
    assert.equal(isJsonValue({ value: 'x', toJSON: () => 'x' }), false);
    assert.equal((jsonValue(1) as unknown as Record<symbol, unknown>)[Symbol.for('turbine-orm.jsonValue')], true);
    assert.ok(Object.isFrozen(jsonValue({})));
  });

  it('serializes as its value when it reaches a serializer unresolved', () => {
    assert.equal(JSON.stringify(jsonValue('hello')), '"hello"');
    assert.equal(JSON.stringify({ a: jsonValue([1]) }), '{"a":[1]}');
    const toPostgres = (jsonValue(null) as unknown as { toPostgres: () => string }).toPostgres;
    assert.equal(toPostgres(), 'null');
  });
});

describe('create / createMany / upsert bind JSON text for arrays and jsonValue', () => {
  it('create binds an array as JSON text, a string and an object by identity', () => {
    const obj = { a: 1 };
    const raw = '{"b":2}';
    const built = q().buildCreate({ data: { data: [1, [2]], doc: [], title: 't' } });
    // Params follow the table's column order: title, data, doc.
    assert.deepEqual(built.params, ['t', '[1,[2]]', '[]'], 'jsonb and json arrays bound as JSON text');
    const second = q().buildCreate({ data: { data: obj, doc: raw } });
    assert.equal(second.params[0], obj, 'an object is bound by identity: the driver serializes it');
    assert.equal(second.params[1], raw, 'a string is raw JSON text, bound untouched');
  });

  it('jsonValue binds JSON.stringify of its value; jsonValue(null) is the text "null"', () => {
    assert.deepEqual(q().buildCreate({ data: { data: jsonValue('hello') } }).params, ['"hello"']);
    assert.deepEqual(q().buildCreate({ data: { data: jsonValue(null) } }).params, ['null']);
    assert.deepEqual(q().buildCreate({ data: { data: null } }).params, [null], 'bare null stays SQL NULL');
  });

  it('a value with no JSON form is E003 naming the column', () => {
    assert.throws(
      () => q().buildCreate({ data: { data: [1n] } }),
      (e: unknown) => e instanceof ValidationError && /"docs\.data".*bigint/.test(e.message),
    );
  });

  it('createMany keeps the UNNEST form for json columns, with one JSON text cell per row', () => {
    const built = q().buildCreateMany({ data: [{ data: [1, 2, 3] }, { data: [] }, { data: { k: 1 } }] });
    assert.equal(built.sql, 'INSERT INTO "docs" ("data") SELECT * FROM UNNEST($1::jsonb[]) RETURNING *');
    assert.deepEqual(built.params, [['[1,2,3]', '[]', { k: 1 }]]);
    for (const cell of (built.params[0] as unknown[]).slice(0, 2)) {
      assert.equal(typeof cell, 'string', 'no JS array reaches the UNNEST transpose');
    }
  });

  it('upsert binds arrays on both halves and stamps updatedAt in the conflict UPDATE', () => {
    const built = q().buildUpsert({
      where: { slug: 's' },
      create: { slug: 's', data: ['c'] },
      update: { data: ['u'] },
    });
    assert.match(built.sql, /DO UPDATE SET "data" = \$3, "updated_at" = \$4/);
    assert.deepEqual(built.params.slice(0, 3), ['s', '["c"]', '["u"]']);
    assert.ok(built.params[3] instanceof Date, 'updatedAt stamped with a client-side Date');
  });

  it('an explicit updatedAt in upsert update wins over the stamp', () => {
    const when = new Date(0);
    const built = q().buildUpsert({ where: { slug: 's' }, create: { slug: 's' }, update: { updatedAt: when } });
    assert.match(built.sql, /DO UPDATE SET "updated_at" = \$2 RETURNING/);
    assert.equal(built.params[1], when);
  });
});

describe('every engine binds the same JSON text', () => {
  it('arrays on a json column and jsonValue anywhere bind JSON.stringify on all four SQL engines', () => {
    for (const dialect of [undefined, sqliteDialect, mysqlDialect, mssqlDialect]) {
      const name = dialect?.name ?? 'postgresql';
      assert.deepEqual(q(dialect).buildCreate({ data: { data: [1, 'a'] } }).params, ['[1,"a"]'], name);
      assert.deepEqual(q(dialect).buildCreate({ data: { data: jsonValue('s') } }).params, ['"s"'], name);
      // A text column holding JSON (SQL Server nvarchar, SQLite TEXT) gets the
      // same serialization from jsonValue.
      assert.deepEqual(q(dialect).buildCreate({ data: { title: jsonValue({ a: 1 }) } }).params, ['{"a":1}'], name);
    }
  });
});

describe('update: only `set` is an operator on a json column', () => {
  it('compiles `{ increment: 1 }` on jsonb as the JSON value, on int as arithmetic', () => {
    const built = q().buildUpdate({ where: { id: 1 }, data: { data: { increment: 1 }, n: { increment: 1 } } });
    // SET follows the table's column order: n, data, then the updatedAt stamp.
    assert.match(built.sql, /SET "n" = "n" \+ \$1, "data" = \$2, "updated_at" = \$3 WHERE/);
    assert.deepEqual(built.params.slice(0, 2), [1, { increment: 1 }]);
  });

  it('`{ set: v }` unwraps on a json column, arrays serialized', () => {
    const built = q().buildUpdate({ where: { id: 1 }, data: { data: { set: [1] } } });
    assert.deepEqual(built.params.slice(0, 1), ['[1]']);
  });

  it('a cache HIT binds exactly what a fresh build binds (fingerprint, build and collector agree)', () => {
    const qi = q();
    const args = (v: number) => ({ where: { id: 1 }, data: { data: { multiply: v }, doc: [v], n: { decrement: v } } });
    const first = qi.buildUpdate(args(2));
    const second = qi.buildUpdate(args(3));
    assert.equal(first.sql, second.sql);
    assert.deepEqual(second.params.slice(0, 3), [3, { multiply: 3 }, '[3]']);
    assert.equal(second.params[4], 1);
    // updateMany shares the SET helpers.
    const m1 = qi.buildUpdateMany({ where: { id: 1 }, data: { data: { divide: 1 } } });
    const m2 = qi.buildUpdateMany({ where: { id: 2 }, data: { data: { divide: 4 } } });
    assert.equal(m1.sql, m2.sql);
    assert.deepEqual([m2.params[0], m2.params[2]], [{ divide: 4 }, 2]);
  });
});

describe('objects and arrays bound to a scalar column', () => {
  const refused = (fn: () => unknown, re: RegExp) =>
    assert.throws(fn, (e: unknown) => e instanceof ValidationError && re.test(e.message));

  it('PostgreSQL refuses them on every write path with E003 naming the column and the fix', () => {
    refused(
      () => q().buildCreate({ data: { title: { first: 'A', last: 'B' } } }),
      /object to "docs\.title" \(column type text\).*jsonValue/,
    );
    refused(() => q().buildCreate({ data: { title: { set: 'A' } } }), /update data only/);
    refused(() => q().buildCreate({ data: { n: [1] } }), /an array to "docs\.n" \(column type int4\)/);
    refused(() => q().buildCreateMany({ data: [{ title: { a: 1 } }] }), /"docs\.title"/);
    refused(() => q().buildUpdate({ where: { id: 1 }, data: { title: { a: 1, b: 2 } } }), /"docs\.title"/);
    refused(() => q().buildUpdate({ where: { id: 1 }, data: { title: { set: { a: 1 } } } }), /"docs\.title"/);
    refused(() => q().buildUpdateMany({ where: { id: 1 }, data: { title: ['x'] } }), /"docs\.title"/);
    refused(
      () => q().buildUpsert({ where: { slug: 's' }, create: { slug: 's', title: { a: 1 } }, update: { n: 1 } }),
      /"docs\.title"/,
    );
  });

  it('a misspelled operator keeps its own, more specific message', () => {
    refused(
      () => q().buildUpdate({ where: { id: 1 }, data: { n: { incremnt: 1 } } }),
      /Unknown update operator "incremnt"/,
    );
  });

  it('accepts Dates, Buffers, bigint, class instances, array columns, and types it cannot vouch for', () => {
    class Money {
      constructor(readonly cents: number) {}
    }
    const qi = q();
    qi.buildCreate({ data: { updatedAt: new Date(0), n: 5n, title: Buffer.from('x') } });
    qi.buildCreate({ data: { tags: ['a', 'b'], n: new Money(1) as unknown as number } });
    qi.buildCreate({ data: { mood: { custom: true } } }); // enum/domain/extension type: not refused
  });

  it('is PostgreSQL-only: SQLite, MySQL and SQL Server keep JSON-in-text', () => {
    for (const dialect of [sqliteDialect, mysqlDialect, mssqlDialect]) {
      const built = q(dialect).buildCreate({ data: { title: { a: 1 } } });
      assert.ok(
        built.params.some((p) => typeof p === 'object'),
        `${dialect.name} binds the object`,
      );
    }
  });
});

describe('optimisticLock is refused where it is not applied', () => {
  const lock = { field: 'n', expected: 0 };
  it('updateMany names the where + increment equivalent', () => {
    assert.throws(
      () => q().buildUpdateMany({ where: { id: 1 }, data: { title: 'x' }, optimisticLock: lock } as never),
      (e: unknown) =>
        e instanceof ValidationError && /n: expected/.test(e.message) && /n: \{ increment: 1 \}/.test(e.message),
    );
  });
  it('upsert names the read-then-update equivalent', () => {
    assert.throws(
      () =>
        q().buildUpsert({
          where: { slug: 's' },
          create: { slug: 's' },
          update: { n: 1 },
          optimisticLock: lock,
        } as never),
      (e: unknown) => e instanceof ValidationError && /update\(\{ where, data, optimisticLock \}\)/.test(e.message),
    );
  });
});

describe('createMany past the bind-parameter limit', () => {
  it('knows each engine limit, and none for an unknown dialect name', () => {
    assert.equal(maxBindParameters({ name: 'postgresql' }), 65535);
    assert.equal(maxBindParameters({ name: 'mysql' }), 65535);
    assert.equal(maxBindParameters({ name: 'sqlite' }), 32766);
    assert.equal(maxBindParameters({ name: 'mssql' }), 2098);
    assert.equal(maxBindParameters({ name: 'toString' }), undefined);
    assert.equal(maxBindParameters({ name: 'sqlite', maxBindParameters: 999 }), 999);
  });

  it('PostgreSQL VALUES form (array column present) refuses with E003, limit and chunk size', () => {
    const rows = Array.from({ length: 32768 }, (_, i) => ({ title: `t${i}`, tags: ['a'] }));
    assert.throws(
      () => q().buildCreateMany({ data: rows }),
      (e: unknown) =>
        e instanceof ValidationError &&
        /65536 bind parameters/.test(e.message) &&
        /limit of 65535/.test(e.message) &&
        /chunks of at most 32767/.test(e.message),
    );
    // One row fewer fits exactly.
    assert.equal(q().buildCreateMany({ data: rows.slice(1) }).params.length, 65534);
  });

  it('the UNNEST form is never limited by row count', () => {
    const rows = Array.from({ length: 70000 }, (_, i) => ({ title: `t${i}`, data: [i] }));
    assert.equal(q().buildCreateMany({ data: rows }).params.length, 2);
  });

  it('SQLite refuses past 32766', () => {
    const rows = Array.from({ length: 16384 }, (_, i) => ({ title: `t${i}`, n: i }));
    assert.throws(() => q(sqliteDialect).buildCreateMany({ data: rows }), /limit of 32766/);
    assert.equal(q(sqliteDialect).buildCreateMany({ data: rows.slice(1) }).params.length, 32766);
  });
});
