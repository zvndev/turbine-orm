/**
 * turbine-orm: JSON filter strictness + substring operators.
 *
 * Regression cover for a silent-wrong-results bug: a `JsonFilter` carrying an
 * operator the builder did not recognize compiled to NO predicate at all, so
 * the query returned every row of the table. `isJsonFilter` fires on the
 * presence of `path`, and `buildJsonFilterClauses` only emitted a clause per
 * key it knew, so an unknown key produced an empty clause list that simply
 * disappeared. Inside an `AND` it dropped that conjunct, which widens a tenant
 * scope written that way to the whole table. The same typo on a scalar column
 * had always thrown.
 *
 * The Prisma spelling `string_contains` was the shape that surfaced it: a
 * migrator reasonably expects either the operator to work or an error, and got
 * "every row" instead.
 *
 * Run: npx tsx --test src/test/json-filter-strict.test.ts
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ValidationError } from '../errors.js';
import type { SchemaMetadata } from '../schema.js';
import { makeQuery, mockTable } from './helpers.js';

function docsSchema(): SchemaMetadata {
  const docs = mockTable('docs', [
    { name: 'id', field: 'id' },
    { name: 'meta', field: 'meta', pgType: 'jsonb' },
    { name: 'title', field: 'title', pgType: 'text' },
  ]);
  return { enums: {}, tables: { docs } };
}

// biome-ignore lint/suspicious/noExplicitAny: exercising filter shapes the public types reject
const q = () => makeQuery('docs', docsSchema()) as any;

describe('JSON filter: an unrecognized operator is refused, never dropped', () => {
  it('rejects the Prisma spelling and names the turbine one', () => {
    assert.throws(
      () => q().buildFindMany({ where: { meta: { path: ['title'], string_contains: 'x' } } }),
      (err: unknown) => {
        assert.ok(err instanceof ValidationError);
        assert.equal(err.code, 'TURBINE_E003');
        assert.match(err.message, /Unknown JSON filter operator "string_contains"/);
        assert.match(err.message, /Did you mean `stringContains`\?/);
        return true;
      },
    );
  });

  it('rejects an arbitrary unknown key and lists what is supported', () => {
    assert.throws(
      () => q().buildFindMany({ where: { meta: { path: ['a'], totally_made_up: 1 } } }),
      (err: unknown) => {
        assert.ok(err instanceof ValidationError);
        assert.match(err.message, /Unknown JSON filter operator "totally_made_up"/);
        assert.match(err.message, /Supported operators: .*stringContains/);
        return true;
      },
    );
  });

  it('rejects a `path` that compares nothing', () => {
    assert.throws(
      () => q().buildFindMany({ where: { meta: { path: ['a'] } } }),
      (err: unknown) => {
        assert.ok(err instanceof ValidationError);
        assert.match(err.message, /selects a `path` but has no comparison/);
        return true;
      },
    );
  });

  it('rejects `path` + `mode` with no comparison (mode is a modifier, not an operator)', () => {
    assert.throws(
      () => q().buildFindMany({ where: { meta: { path: ['a'], mode: 'insensitive' } } }),
      /selects a `path` but has no comparison/,
    );
  });

  it('THE BUG: an unknown operator no longer widens an AND by dropping a conjunct', () => {
    // Previously: WHERE "id" = $1, the JSON conjunct vanished and the query
    // returned every row matching only the first term.
    assert.throws(
      () => q().buildFindMany({ where: { AND: [{ id: 1 }, { meta: { path: ['x'], bogus: 1 } }] } }),
      /Unknown JSON filter operator "bogus"/,
    );
  });

  it('the check also runs on the cache-hit param-collect path', () => {
    // Same QueryInterface, same fingerprint shape: the second call takes the
    // warmed-cache branch, which collects params without rebuilding SQL. It
    // must validate too, or a warmed cache reintroduces the bug.
    const qi = q();
    qi.buildFindMany({ where: { meta: { path: ['t'], stringContains: 'a' } } });
    assert.throws(
      () => qi.buildFindMany({ where: { meta: { path: ['t'], string_contains: 'a' } } }),
      /Unknown JSON filter operator/,
    );
  });

  it('a scalar column keeps its own unknown-operator error', () => {
    assert.throws(() => q().buildFindMany({ where: { id: { bogus: 1 } } }), /Unknown operator "bogus"/);
  });
});

describe('JSON filter: substring operators', () => {
  it('stringContains compiles to an escaped LIKE on the extracted path', () => {
    const { sql, params } = q().buildFindMany({ where: { meta: { path: ['title'], stringContains: 'ello' } } });
    assert.match(sql, /#>> \$1::text\[\] LIKE \$2 ESCAPE '\\'/);
    assert.deepEqual(params, [['title'], '%ello%']);
  });

  it('stringStartsWith / stringEndsWith anchor the pattern', () => {
    assert.deepEqual(q().buildFindMany({ where: { meta: { path: ['t'], stringStartsWith: 'a' } } }).params, [
      ['t'],
      'a%',
    ]);
    assert.deepEqual(q().buildFindMany({ where: { meta: { path: ['t'], stringEndsWith: 'z' } } }).params, [
      ['t'],
      '%z',
    ]);
  });

  it('LIKE metacharacters in the operand are escaped, not treated as wildcards', () => {
    const { params } = q().buildFindMany({ where: { meta: { path: ['t'], stringContains: '100%_x' } } });
    assert.deepEqual(params, [['t'], '%100\\%\\_x%']);
  });

  it('mode: insensitive routes through the dialect', () => {
    const { sql } = q().buildFindMany({
      where: { meta: { path: ['t'], stringContains: 'a', mode: 'insensitive' } },
    });
    assert.match(sql, /ILIKE/);
  });

  it('the path is bound once and shared with a range operator on the same filter', () => {
    const { params } = q().buildFindMany({
      where: { meta: { path: ['n'], gt: 1, stringContains: 'a' } },
    });
    // path, then the range value, then the LIKE pattern, one path param total.
    assert.deepEqual(params, [['n'], 1, '%a%']);
  });

  it('requires a path, and requires a string operand', () => {
    assert.throws(() => q().buildFindMany({ where: { meta: { stringContains: 'a' } } }), /requires a `path`/);
    assert.throws(
      () => q().buildFindMany({ where: { meta: { path: ['t'], stringContains: 5 } } }),
      /requires a string/,
    );
  });

  it('does not disturb the existing operators', () => {
    assert.deepEqual(q().buildFindMany({ where: { meta: { path: ['t'], equals: 'v' } } }).params, [['t'], 'v']);
    assert.deepEqual(q().buildFindMany({ where: { meta: { hasKey: 'k' } } }).params, ['k']);
    assert.match(q().buildFindMany({ where: { meta: { contains: { a: 1 } } } }).sql, /@>/);
  });

  it('a scalar `contains` on a text column still means LIKE, unchanged', () => {
    const { sql, params } = q().buildFindMany({ where: { title: { contains: 'x' } } });
    assert.match(sql, /"title" LIKE \$1 ESCAPE '\\'/);
    assert.deepEqual(params, ['%x%']);
  });
});
