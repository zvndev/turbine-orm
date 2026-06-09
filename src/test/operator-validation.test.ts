/**
 * turbine-orm — Strict operator validation tests
 *
 * Build-only tests (no DB) that verify TASK-2.2: passing a JSON or array
 * filter operator on a column whose type does not support it now throws
 * `ValidationError` instead of silently dropping the filter.
 *
 * The previous behaviour fell through to plain equality (or no-op), wasting
 * hours of debugging time when a user mistyped a column name or schema
 * mismatch slipped through.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ValidationError } from '../errors.js';
import type { SchemaMetadata, TableMetadata } from '../schema.js';
import { makeQuery, mockTable } from './helpers.js';

function buildSchema(): SchemaMetadata {
  const tables: Record<string, TableMetadata> = {};
  tables.posts = mockTable('posts', [
    { name: 'id', field: 'id' },
    { name: 'title', field: 'title', pgType: 'text' },
    { name: 'metadata', field: 'metadata', pgType: 'jsonb' },
    { name: 'tags', field: 'tags', pgType: '_text' },
    { name: 'view_count', field: 'viewCount', pgType: 'int4' },
  ]);
  return { tables, enums: {} };
}

describe('strict operator validation', () => {
  describe('JSON operators', () => {
    it('throws when `path` is used on a non-JSON column', () => {
      const q = makeQuery('posts', buildSchema());
      assert.throws(
        () => q.buildFindMany({ where: { title: { path: ['nope'], equals: 'x' } } as never }),
        (err: unknown) => {
          assert.ok(err instanceof ValidationError, 'should be ValidationError');
          assert.match((err as Error).message, /title/);
          assert.match((err as Error).message, /JSON/);
          assert.match((err as Error).message, /'path'/);
          return true;
        },
      );
    });

    it('throws when `equals` (JSON) is used on a non-JSON column', () => {
      const q = makeQuery('posts', buildSchema());
      assert.throws(
        () => q.buildFindMany({ where: { title: { equals: { foo: 1 } } as never } }),
        (err: unknown) => {
          assert.ok(err instanceof ValidationError);
          assert.match((err as Error).message, /JSON/);
          assert.match((err as Error).message, /'equals'/);
          return true;
        },
      );
    });

    it('throws when `hasKey` is used on a non-JSON column', () => {
      const q = makeQuery('posts', buildSchema());
      assert.throws(
        () => q.buildFindMany({ where: { title: { hasKey: 'foo' } as never } }),
        (err: unknown) => {
          assert.ok(err instanceof ValidationError);
          assert.match((err as Error).message, /JSON/);
          assert.match((err as Error).message, /'hasKey'/);
          return true;
        },
      );
    });

    it('does NOT throw when JSON operators target an actual jsonb column', () => {
      const q = makeQuery('posts', buildSchema());
      assert.doesNotThrow(() => q.buildFindMany({ where: { metadata: { hasKey: 'foo' } } as never }));
      assert.doesNotThrow(() =>
        q.buildFindMany({
          where: { metadata: { path: ['user', 'name'], equals: 'kirby' } } as never,
        }),
      );
    });

    it('still allows `contains` on text columns (LIKE) — no false positive', () => {
      const q = makeQuery('posts', buildSchema());
      // `contains` overlaps between WhereOperator (LIKE) and JsonFilter; the
      // ambiguous case must continue to fall through to LIKE on text columns.
      assert.doesNotThrow(() => q.buildFindMany({ where: { title: { contains: 'foo' } } }));
    });
  });

  describe('Array operators', () => {
    it('throws when `has` is used on a non-array column', () => {
      const q = makeQuery('posts', buildSchema());
      assert.throws(
        () => q.buildFindMany({ where: { title: { has: 'foo' } as never } }),
        (err: unknown) => {
          assert.ok(err instanceof ValidationError);
          assert.match((err as Error).message, /array/);
          assert.match((err as Error).message, /'has'/);
          return true;
        },
      );
    });

    it('throws when `hasEvery` is used on a numeric column', () => {
      const q = makeQuery('posts', buildSchema());
      assert.throws(
        () => q.buildFindMany({ where: { viewCount: { hasEvery: [1, 2] } as never } }),
        (err: unknown) => {
          assert.ok(err instanceof ValidationError);
          assert.match((err as Error).message, /array/);
          assert.match((err as Error).message, /'hasEvery'/);
          return true;
        },
      );
    });

    it('throws when `hasSome` is used on a JSON column (array op != JSON op)', () => {
      const q = makeQuery('posts', buildSchema());
      assert.throws(
        () => q.buildFindMany({ where: { metadata: { hasSome: ['x'] } as never } }),
        (err: unknown) => {
          assert.ok(err instanceof ValidationError);
          assert.match((err as Error).message, /array/);
          return true;
        },
      );
    });

    it('throws when `isEmpty` is used on a non-array column', () => {
      const q = makeQuery('posts', buildSchema());
      assert.throws(
        () => q.buildFindMany({ where: { title: { isEmpty: true } as never } }),
        (err: unknown) => {
          assert.ok(err instanceof ValidationError);
          assert.match((err as Error).message, /array/);
          return true;
        },
      );
    });

    it('does NOT throw when array operators target an actual array column', () => {
      const q = makeQuery('posts', buildSchema());
      assert.doesNotThrow(() => q.buildFindMany({ where: { tags: { has: 'foo' } } as never }));
      assert.doesNotThrow(() => q.buildFindMany({ where: { tags: { hasEvery: ['a', 'b'] } } as never }));
      assert.doesNotThrow(() => q.buildFindMany({ where: { tags: { isEmpty: true } } as never }));
    });

    it('builds precise SQL for `isEmpty` true and false', () => {
      const q = makeQuery('posts', buildSchema());

      const empty = q.buildFindMany({ where: { tags: { isEmpty: true } } as never });
      assert.match(empty.sql, /COALESCE\(cardinality\("tags"\), 0\) = 0/);
      assert.deepEqual(empty.params, []);

      // Same QueryInterface instance intentionally exercises the SQL cache; the
      // parameterless boolean must be part of the fingerprint because it changes SQL.
      const nonEmpty = q.buildFindMany({ where: { tags: { isEmpty: false } } as never });
      assert.match(nonEmpty.sql, /cardinality\("tags"\) > 0/);
      assert.deepEqual(nonEmpty.params, []);
    });
  });

  describe('Unknown where operators', () => {
    it('throws on a misspelled operator instead of silently returning wrong rows', () => {
      const q = makeQuery('posts', buildSchema());
      // `startWith` is a typo for `startsWith`. The old behaviour fell through to
      // `title = $1` with the operator object as the value — silently zero rows.
      assert.throws(
        () => q.buildFindMany({ where: { title: { startWith: 'x' } } as never }),
        (err: unknown) => {
          assert.ok(err instanceof ValidationError, 'should be ValidationError');
          assert.match((err as Error).message, /\[turbine\]/);
          assert.match((err as Error).message, /title/);
          assert.match((err as Error).message, /startWith/);
          // Lists the supported operators so the typo is obvious.
          assert.match((err as Error).message, /startsWith/);
          return true;
        },
      );
    });

    it('throws on a completely unknown operator key', () => {
      const q = makeQuery('posts', buildSchema());
      assert.throws(
        () => q.buildFindMany({ where: { title: { weird: 'x' } } as never }),
        (err: unknown) => {
          assert.ok(err instanceof ValidationError);
          assert.match((err as Error).message, /weird/);
          return true;
        },
      );
    });

    it('throws on an empty filter object', () => {
      const q = makeQuery('posts', buildSchema());
      assert.throws(
        () => q.buildFindMany({ where: { title: {} } as never }),
        (err: unknown) => {
          assert.ok(err instanceof ValidationError);
          assert.match((err as Error).message, /title/);
          return true;
        },
      );
    });

    it('does NOT throw for valid operators or mode', () => {
      const q = makeQuery('posts', buildSchema());
      assert.doesNotThrow(() => q.buildFindMany({ where: { title: { startsWith: 'x' } } }));
      assert.doesNotThrow(() => q.buildFindMany({ where: { title: { gt: 'a', lt: 'z' } } }));
      assert.doesNotThrow(() => q.buildFindMany({ where: { title: { contains: 'x', mode: 'insensitive' } } }));
    });

    it('does NOT throw for plain equality, bare arrays, or JSON-column object equality', () => {
      const q = makeQuery('posts', buildSchema());
      assert.doesNotThrow(() => q.buildFindMany({ where: { title: 'exact' } }));
      // Bare array on an array column → equality, not an operator object.
      assert.doesNotThrow(() => q.buildFindMany({ where: { tags: ['a', 'b'] } as never }));
      // Arbitrary object on a jsonb column is a legitimate equality value.
      assert.doesNotThrow(() => q.buildFindMany({ where: { metadata: { foo: 'bar' } } as never }));
    });
  });

  describe('orderBy field validation', () => {
    it('throws a consistent [turbine] error listing known fields', () => {
      const q = makeQuery('posts', buildSchema());
      assert.throws(
        () => q.buildFindMany({ orderBy: { bogus: 'asc' } as never }),
        (err: unknown) => {
          assert.ok(err instanceof ValidationError);
          assert.match((err as Error).message, /\[turbine\]/);
          assert.match((err as Error).message, /orderBy/);
          assert.match((err as Error).message, /bogus/);
          assert.match((err as Error).message, /Known fields/);
          return true;
        },
      );
    });
  });

  describe('select / omit shape validation', () => {
    it('throws a clear error when select is an array instead of an object', () => {
      const q = makeQuery('posts', buildSchema());
      assert.throws(
        () => q.buildFindMany({ select: ['id', 'title'] as never }),
        (err: unknown) => {
          assert.ok(err instanceof ValidationError);
          assert.match((err as Error).message, /select/);
          assert.match((err as Error).message, /object/);
          return true;
        },
      );
    });

    it('throws a clear error when omit is an array instead of an object', () => {
      const q = makeQuery('posts', buildSchema());
      assert.throws(
        () => q.buildFindMany({ omit: ['id'] as never }),
        (err: unknown) => {
          assert.ok(err instanceof ValidationError);
          assert.match((err as Error).message, /omit/);
          return true;
        },
      );
    });

    it('does NOT throw for the correct object shape', () => {
      const q = makeQuery('posts', buildSchema());
      assert.doesNotThrow(() => q.buildFindMany({ select: { id: true, title: true } }));
      assert.doesNotThrow(() => q.buildFindMany({ omit: { metadata: true } } as never));
    });
  });
});
