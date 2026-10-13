/**
 * A static `globalFilters` entry is compiled when the client is built, with
 * that client's dialect, so a value the compiler refuses fails at
 * construction instead of on the first query against the table (where it
 * failed every query). No database: the client is never connected.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { TurbineClient } from '../client.js';
import type { Dialect } from '../dialect.js';
import { UnsupportedFeatureError, ValidationError } from '../errors.js';
import { mssqlDialect } from '../mssql.js';
import { mysqlDialect } from '../mysql.js';
import type { PgCompatPool } from '../pg-types.js';
import type { GlobalFilters } from '../query/index.js';
import { sqliteDialect } from '../sqlite.js';
import { fxWhereSchema } from './fx-where-engines.js';

/** A pool that is never used: construction must not touch it. */
const UNUSED_POOL = {
  query: () => {
    throw new Error('the pool was used');
  },
  connect: () => {
    throw new Error('the pool was used');
  },
  end: async () => {},
} as unknown as PgCompatPool;

function build(globalFilters: GlobalFilters, dialect?: Dialect): TurbineClient {
  const schema = fxWhereSchema(dialect ? 'json' : 'jsonb');
  return new TurbineClient({ pool: UNUSED_POOL, warnOnUnlimited: false, globalFilters, dialect }, schema);
}

const ENGINES: [string, Dialect | undefined][] = [
  ['postgresql', undefined],
  ['mysql', mysqlDialect],
  ['sqlite', sqliteDialect],
  ['mssql', mssqlDialect],
];

describe('a static global filter is compiled when the client is built', () => {
  const refused: [string, GlobalFilters][] = [
    ['an operand of the wrong shape', { fxwhPosts: { userId: { in: 5 } } }],
    ['a plain { col } object', { fxwh_posts: { userId: { equals: { col: 'editorId' } } } }],
    ['an operator object naming no operator', { fxwh_posts: { title: { mode: 'insensitive' } } }],
    ['an Invalid Date', { fxwh_users: { createdAt: { gt: new Date('nope') } } }],
    ['a misspelled column in a relation filter', { fxwh_posts: { author: { is: { tenat: 1 } } } }],
    ['a bad value in a relation filter', { fxwh_posts: { author: { is: { tenant: { in: 'x' } } } } }],
    ['an undefined value', { fxwh_posts: { userId: undefined } }],
  ];
  for (const [engine, dialect] of ENGINES) {
    for (const [label, filters] of refused) {
      it(`${engine}: refuses ${label} (E003) at construction`, () => {
        assert.throws(
          () => build(filters, dialect),
          (err: unknown) => {
            assert.ok(err instanceof ValidationError, String(err));
            assert.match(err.message, new RegExp(`globalFilters\\["${Object.keys(filters)[0]}"\\]`));
            assert.equal(err.message.match(/\[TURBINE_E003\]/g)?.length, 1, err.message);
            return true;
          },
        );
      });
    }

    it(`${engine}: accepts valid static filters, and never calls a function filter`, () => {
      const client = build(
        {
          fxwh_posts: { author: { is: { tenant: 1 } }, title: { not: '' } },
          fxwh_users: () => {
            throw new Error('a function filter was called at construction');
          },
        },
        dialect,
      );
      assert.ok(client);
    });
  }

  it('an engine without whole-document comparison refuses a static document filter (E017) at construction', () => {
    for (const dialect of [sqliteDialect, mssqlDialect]) {
      assert.throws(
        () => build({ fxwh_users: { data: { a: 1 } } }, dialect),
        (err: unknown) => {
          assert.ok(err instanceof UnsupportedFeatureError, String(err));
          assert.match(err.message, /globalFilters\["fxwh_users"\]/);
          return true;
        },
        dialect.name,
      );
    }
    assert.ok(build({ fxwh_users: { data: { a: 1 } } }, mysqlDialect));
  });
});
