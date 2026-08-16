/**
 * THE RULE: an argument the caller wrote must change the answer, or be refused.
 *
 * 0.72.0 applied it to NAMES (a column and a relation each have two legal
 * spellings, and which one you use must not change the answer). This file
 * covers the three places where an argument was accepted and then did nothing,
 * or did something other than what it said:
 *
 *   1. `skip` was not a Turbine key at all while `take` was, so the Prisma pair
 *      `{ take, skip }` looked accepted and silently returned page one.
 *   2. `findUnique` accepted a `where` that matched many rows and emitted
 *      `LIMIT 1` with no ordering, returning an arbitrary one of them.
 *   3. Any unrecognized key, `include` above all, was dropped in silence: the
 *      query ran, returned rows, and the relation was simply absent.
 *
 * Each of these produced a plausible-looking result, which is what makes them
 * worth a regression file of their own. A thrown error gets fixed the same day.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ValidationError } from '../errors.js';
import type { PgCompatPool } from '../pg-types.js';
import { QueryInterface } from '../query/index.js';
import type { SchemaMetadata } from '../schema.js';
import { makeQuery, mockTable } from './helpers.js';

function schema(): SchemaMetadata {
  const s: SchemaMetadata = {
    enums: {},
    tables: {
      users: mockTable(
        'users',
        [
          { name: 'id', field: 'id' },
          { name: 'email', field: 'email', pgType: 'text', unique: true },
          { name: 'tenant_id', field: 'tenantId' },
          { name: 'slug', field: 'slug', pgType: 'text' },
          { name: 'name', field: 'name', pgType: 'text' },
        ],
        {
          posts: {
            type: 'hasMany',
            name: 'posts',
            from: 'users',
            to: 'posts',
            foreignKey: 'user_id',
            referenceKey: 'id',
          },
        },
      ),
      posts: mockTable('posts', [
        { name: 'id', field: 'id' },
        { name: 'user_id', field: 'userId' },
        { name: 'title', field: 'title', pgType: 'text' },
      ]),
      // No primary key, no unique constraint: nothing can identify one row.
      events: mockTableWithoutKey(),
    },
  };
  // (tenantId, slug) is unique together, the shape a multi-tenant table has.
  s.tables.users?.uniqueColumns.push(['tenant_id', 'slug']);
  return s;
}

function mockTableWithoutKey(): ReturnType<typeof mockTable> {
  const t = mockTable('events', [
    { name: 'id', field: 'id' },
    { name: 'kind', field: 'kind', pgType: 'text' },
  ]);
  t.primaryKey = [];
  t.uniqueColumns = [];
  return t;
}

const q = () => makeQuery('users', schema());

// ---------------------------------------------------------------------------
// 1. take / skip
// ---------------------------------------------------------------------------

describe('the Prisma pagination aliases are folded, not half-recognized', () => {
  it('skip emits the same OFFSET that offset does', () => {
    const aliased = q().buildFindMany({ orderBy: { id: 'asc' }, take: 3, skip: 2 });
    const native = q().buildFindMany({ orderBy: { id: 'asc' }, limit: 3, offset: 2 });
    assert.equal(aliased.sql, native.sql);
    assert.deepEqual(aliased.params, native.params);
    // The bug this replaces: no OFFSET in the emitted SQL at all.
    assert.match(aliased.sql, /OFFSET/);
  });

  it('skip alone still emits an OFFSET', () => {
    assert.match(q().buildFindMany({ orderBy: { id: 'asc' }, skip: 5 }).sql, /OFFSET/);
  });

  it('take alone is the limit', () => {
    const a = q().buildFindMany({ orderBy: { id: 'asc' }, take: 4 });
    const b = q().buildFindMany({ orderBy: { id: 'asc' }, limit: 4 });
    assert.equal(a.sql, b.sql);
    assert.deepEqual(a.params, b.params);
  });

  it('both spellings of one bound, disagreeing, is refused', () => {
    assert.throws(
      () => q().buildFindMany({ limit: 100, take: 3 }),
      (err: unknown) => err instanceof ValidationError && /"take" and "limit"/.test((err as Error).message),
    );
    assert.throws(
      () => q().buildFindMany({ offset: 10, skip: 0 }),
      (err: unknown) => err instanceof ValidationError && /"skip" and "offset"/.test((err as Error).message),
    );
  });

  it('both spellings agreeing is accepted: there is nothing to choose between', () => {
    const both = q().buildFindMany({ orderBy: { id: 'asc' }, limit: 3, take: 3 });
    const one = q().buildFindMany({ orderBy: { id: 'asc' }, limit: 3 });
    assert.equal(both.sql, one.sql);
  });

  it('an aliased query shares the cache entry with its native spelling', () => {
    // The aliases are folded BEFORE the fingerprint, so they cannot mint a
    // second template for a statement that already exists. A fold done at each
    // read site instead would have left the fingerprint reading `undefined`.
    const qi = q();
    qi.buildFindMany({ orderBy: { id: 'asc' }, limit: 3, offset: 2 });
    const before = qi.cacheStats();
    qi.buildFindMany({ orderBy: { id: 'asc' }, take: 3, skip: 2 });
    const after = qi.cacheStats();
    assert.equal(after.hits, before.hits + 1, 'the aliased spelling must hit, not miss');
    assert.equal(after.misses, before.misses);
  });
});

// ---------------------------------------------------------------------------
// 2. findUnique must identify one row
// ---------------------------------------------------------------------------

describe('findUnique refuses a where that does not identify one row', () => {
  const refused = (where: unknown, label: string) =>
    it(`refuses ${label}`, () => {
      assert.throws(
        () => q().buildFindUnique({ where: where as never }),
        (err: unknown) =>
          err instanceof ValidationError &&
          /does not identify a single row/.test((err as Error).message) &&
          /findFirst/.test((err as Error).message),
        label,
      );
    });

  refused({ name: 'ada' }, 'a plain non-unique column');
  refused({ id: { gt: 0, lt: 5 } }, 'a range on the primary key');
  refused({ id: { in: [1, 2] } }, 'an `in` list on the primary key');
  refused({ OR: [{ id: 1 }, { id: 2 }] }, 'an OR of two keys');
  refused({ email: null }, 'a null on a unique column (many rows may be null)');
  refused({ tenantId: 1 }, 'one column of a composite unique');
  refused({ posts: { some: { title: 'x' } } }, 'a relation filter');

  const accepted = (where: unknown, label: string) =>
    it(`accepts ${label}`, () => {
      assert.match(q().buildFindUnique({ where: where as never }).sql, /WHERE/);
    });

  accepted({ id: 1 }, 'the primary key');
  accepted({ id: { equals: 1 } }, 'the primary key as an explicit equals');
  accepted({ email: 'a@b.com' }, 'a single-column unique');
  accepted({ tenantId: 1, slug: 'x' }, 'both columns of a composite unique');
  accepted({ id: 1, name: { contains: 'ada' } }, 'a key plus an extra predicate that can only narrow it');
  accepted({ tenantId_slug: { tenantId: 1, slug: 'x' } }, 'the compound-unique selector, which expands first');

  it('names the keys that would work', () => {
    assert.throws(
      () => q().buildFindUnique({ where: { name: 'ada' } as never }),
      (err: unknown) => {
        const m = (err as Error).message;
        return /`id`/.test(m) && /`email`/.test(m) && /\{ tenantId, slug \}/.test(m);
      },
    );
  });

  it('a table with no unique key at all says so, instead of advising the impossible', () => {
    const qi = makeQuery('events', schema());
    assert.throws(
      () => qi.buildFindUnique({ where: { kind: 'signup' } as never }),
      (err: unknown) =>
        err instanceof ValidationError &&
        /declares no primary key and no unique constraint/.test((err as Error).message) &&
        /findFirst/.test((err as Error).message),
    );
  });

  it('findFirst is untouched: an optional filter is its whole contract', () => {
    assert.doesNotThrow(() => q().buildFindFirst({ where: { name: 'ada' } }));
    assert.doesNotThrow(() => q().buildFindMany({ where: { name: 'ada' } }));
  });
});

// ---------------------------------------------------------------------------
// 3. unknown keys are reported
// ---------------------------------------------------------------------------

describe('an unknown query option is reported rather than silently ignored', () => {
  it('include names `with`, which is the whole reason this warning exists', async () => {
    const qi = executable();
    const warnings = await captureAsync(() => qi.findMany({ include: { posts: true } } as never));
    assert.equal(warnings.length, 1, warnings.join('\n'));
    assert.match(warnings[0] as string, /unknown option "include"/);
    assert.match(warnings[0] as string, /Turbine spells this "with"/);
  });

  it('a typo gets the nearest real option', async () => {
    const qi = executable();
    const warnings = await captureAsync(() => qi.findMany({ oderBy: { id: 'asc' } } as never));
    assert.equal(warnings.length, 1, warnings.join('\n'));
    assert.match(warnings[0] as string, /Did you mean "orderBy"\?/);
  });

  it('says nothing for a query whose every key is real', async () => {
    const qi = executable();
    const warnings = await captureAsync(() =>
      qi.findMany({ where: { id: 1 }, select: { id: true }, orderBy: { id: 'asc' }, limit: 1, take: 1 } as never),
    );
    assert.deepEqual(warnings, []);
  });

  it('says nothing for a key whose value is undefined', async () => {
    const qi = executable();
    const warnings = await captureAsync(() => qi.findMany({ include: undefined } as never));
    assert.deepEqual(warnings, []);
  });

  it('warns once per table.operation.key, not once per call', async () => {
    // A DIFFERENT table from the cases above, deliberately: the once-only
    // registry is process-wide (that is the point of it), so reusing
    // `users.findMany.include` here would measure whether an earlier test in
    // this file had already run rather than whether the dedupe works.
    const qi = executable('posts');
    const warnings = await captureAsync(async () => {
      await qi.findMany({ include: { author: true } } as never);
      await qi.findMany({ include: { author: true } } as never);
      await qi.findMany({ include: { author: true } } as never);
    });
    assert.equal(warnings.length, 1, warnings.join('\n'));
  });

  it('covers the streaming methods, which do not go through the middleware seam', async () => {
    const qi = executable('events');
    const warnings = await captureAsync(async () => {
      for await (const _ of qi.findManyStream({ include: { anything: true } } as never)) {
        // no rows come back from the fake pool
      }
    });
    assert.equal(warnings.length, 1, warnings.join('\n'));
    assert.match(warnings[0] as string, /findManyStream/);
  });

  it('is a warning and never an error: the query still runs', async () => {
    const qi = executable('events');
    await captureAsync(async () => {
      const rows = await qi.findMany({ include: { posts: true } } as never);
      assert.deepEqual(rows, []);
    });
  });
});

/**
 * A QueryInterface over a pool that answers every statement with zero rows.
 *
 * These cases have to EXECUTE rather than build: the diagnostic lives at the
 * one seam every public operation passes through, which is the execute path, so
 * a build-only test would assert nothing about the thing under test.
 */
function executable(table = 'users'): QueryInterface<Record<string, unknown>> {
  const pool = { query: async () => ({ rows: [], rowCount: 0 }) } as unknown as PgCompatPool;
  return new QueryInterface(pool, table, schema());
}

async function captureAsync(fn: () => Promise<unknown> | unknown): Promise<string[]> {
  const lines: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  };
  try {
    await fn();
  } finally {
    console.warn = original;
  }
  // The unlimited-read and unordered-page advisories are not what this suite is
  // about, and they have their own tests.
  return lines.filter((l) => l.includes('unknown option'));
}
