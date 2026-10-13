/**
 * `not` on a JSON column takes a document. An object whose keys are all
 * filter operators (`not: { gt: 1 }`, `not: { path: [...], equals: 1 }`) used
 * to be read as the literal document `{"gt":1}`, so the filter matched nearly
 * every row (and PowDB read it as a negated filter instead, a different
 * answer). It is E003 on every engine now, with the two ways to say what was
 * meant: `NOT: { col: {...} }` to negate a filter, `jsonValue({...})` or
 * `{ equals: {...} }` to compare against a document with those keys.
 *
 * MySQL: a bare document (`{ data: { a: 1 } }`) is compared as a JSON
 * document, the way `equals` already was. It was compared to a string and
 * matched nothing, and `NOT` of it matched everything.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Dialect } from '../dialect.js';
import { ValidationError } from '../errors.js';
import { mysqlDialect } from '../mysql.js';
import { capabilitiesFromVersion, type PowdbPool } from '../powdb.js';
import { PowqlInterface } from '../powql.js';
import { jsonValue } from '../query/json-value.js';
import { sqliteDialect } from '../sqlite.js';
import { fixWhereSchema } from './fix-where-engines.js';
import { makeQuery } from './helpers.js';

// biome-ignore lint/suspicious/noExplicitAny: build-only harness calls
type Any = any;

const OPERATOR_ONLY =
  /Invalid `not` on "data" for table "fw_users", a JSON column: an object whose keys are all filter operators/;
const ALTERNATIVES =
  /write `NOT: \{ data: \{ .* \} \}`.*`not: jsonValue\(\{ \.\.\. \}\)` or `not: \{ equals: \{ \.\.\. \} \}`/;

function users(dialect?: Dialect): Any {
  return makeQuery('fw_users', fixWhereSchema(dialect ? 'json' : 'jsonb'), {
    warnOnUnlimited: false,
    ...(dialect ? { dialect } : {}),
  });
}

const OPERATOR_OBJECTS: Record<string, unknown>[] = [
  { gt: 1 },
  { in: [1, 2] },
  { contains: { a: 1 } },
  { path: ['a'], equals: 1 },
  { hasKey: 'a' },
  { equals: 1, not: 2 },
];

describe('JSON `not` with an operator-only object', () => {
  const dialects: [string, Dialect | undefined][] = [
    ['postgresql', undefined],
    ['sqlite', sqliteDialect],
    ['mysql', mysqlDialect],
  ];
  for (const [name, dialect] of dialects) {
    for (const operand of OPERATOR_OBJECTS) {
      it(`${name}: not: ${JSON.stringify(operand)} is refused on the build and on the cache-hit collect`, () => {
        const q = users(dialect);
        // Warm a valid shape so a later call could take the cache path. SQLite
        // compares no whole documents, so its `not: <document>` is refused (E017)
        // and the valid shape there is a scalar.
        q.buildFindMany({ where: { data: { not: name === 'sqlite' ? 1 : { a: 1 } } } });
        assert.throws(
          () => q.buildFindMany({ where: { data: { not: operand } } }),
          (err: unknown) => {
            assert.ok(err instanceof ValidationError, String(err));
            assert.match(err.message, OPERATOR_ONLY);
            assert.match(err.message, ALTERNATIVES);
            return true;
          },
        );
      });
    }
  }

  it('is refused in a mutation where, where it would have matched nearly every row', () => {
    assert.throws(() => users().buildDeleteMany({ where: { data: { not: { gt: 1 } } } }), OPERATOR_ONLY);
  });

  it('the written alternatives compile to a document comparison', () => {
    const q = users();
    const viaEquals = q.buildFindMany({ where: { data: { not: { equals: { gt: 1 } } } } });
    assert.equal(viaEquals.sql, 'SELECT "fw_users".* FROM "fw_users" WHERE NOT ("data"::jsonb = $1::jsonb)');
    assert.deepEqual(viaEquals.params, ['{"gt":1}']);
    const viaJsonValue = q.buildFindMany({ where: { data: { not: jsonValue({ gt: 1 }) } } });
    assert.equal(viaJsonValue.sql, viaEquals.sql);
    assert.deepEqual(viaJsonValue.params, viaEquals.params);
    // A document whose keys are not all operators is a document, as before.
    const mixed = q.buildFindMany({ where: { data: { not: { gt: 1, a: 2 } } } });
    assert.equal(mixed.sql, viaEquals.sql);
    assert.deepEqual(mixed.params, ['{"gt":1,"a":2}']);
    // And the negated filter is spelled with NOT.
    const negated = q.buildFindMany({ where: { NOT: { data: { path: ['a'], equals: 1 } } } });
    assert.match(negated.sql, /WHERE NOT \(/);
  });

  it('a lone `equals` is the document wrapper, not an operator object', () => {
    const q = users();
    assert.equal(
      q.buildFindMany({ where: { data: { not: { equals: 1 } } } }).sql,
      'SELECT "fw_users".* FROM "fw_users" WHERE NOT ("data"::jsonb = $1::jsonb)',
    );
  });

  it('PowDB refuses it too, rather than reading it as a negated filter', async () => {
    const calls: string[] = [];
    const pool = {
      capabilities: capabilitiesFromVersion('0.18.0'),
      retryStaleReads: false,
      readonly: false,
      query(text: string) {
        calls.push(text);
        return Promise.resolve({ rows: [], rowCount: 0 });
      },
    } as unknown as PowdbPool;
    const qi = new PowqlInterface(pool, 'fw_users', fixWhereSchema(), [], { warnOnUnlimited: false }) as Any;
    for (const operand of OPERATOR_OBJECTS) {
      await assert.rejects(qi.findMany({ where: { data: { not: operand } } }), OPERATOR_ONLY, JSON.stringify(operand));
    }
    assert.deepEqual(calls, []);
  });
});

describe('MySQL: a bare JSON document compares as a document', () => {
  it('bare and equals compile to the same document comparison', () => {
    const q = users(mysqlDialect);
    const bare = q.buildFindMany({ where: { data: { a: 1 } } });
    const equals = q.buildFindMany({ where: { data: { equals: { a: 1 } } } });
    assert.equal(bare.sql, 'SELECT `fw_users`.* FROM `fw_users` WHERE `data` = CAST(:p1 AS JSON)');
    assert.equal(bare.sql, equals.sql);
    assert.deepEqual(bare.params, ['{"a":1}']);
    assert.deepEqual(bare.params, equals.params);
  });

  it('a cache hit binds the new document', () => {
    const q = users(mysqlDialect);
    q.buildFindMany({ where: { data: { a: 1 } } });
    const hit = q.buildFindMany({ where: { data: { b: 2 } } });
    assert.deepEqual(hit.params, ['{"b":2}']);
  });

  it('inside NOT and inside a relation filter', () => {
    const q = users(mysqlDialect);
    assert.equal(
      q.buildFindMany({ where: { NOT: { data: { a: 1 } } } }).sql,
      'SELECT `fw_users`.* FROM `fw_users` WHERE NOT (`data` = CAST(:p1 AS JSON))',
    );
    const posts = makeQuery('fw_posts', fixWhereSchema('json'), {
      warnOnUnlimited: false,
      dialect: mysqlDialect,
    }) as Any;
    const nested = posts.buildFindMany({ where: { author: { is: { data: { a: 1 } } } } });
    assert.match(nested.sql, /`fw_users`\.`data` = CAST\(:p1 AS JSON\)/);
    assert.deepEqual(nested.params, ['{"a":1}']);
  });

  it('PostgreSQL is unchanged: the document binds as JSON', () => {
    const pg = users().buildFindMany({ where: { data: { a: 1 } } });
    assert.equal(pg.sql, 'SELECT "fw_users".* FROM "fw_users" WHERE "data" = $1');
    assert.deepEqual(pg.params, [{ a: 1 }]);
  });
});
