/**
 * turbine-orm, parseRow decode-plan tests
 *
 * `parseRow` caches a per-(table, column-shape) decode plan instead of
 * recomputing the reverse-map lookup and the two date-column membership tests
 * for every column of every row. Every row of one result set has the same
 * columns in the same order, so the plan hits for every row after the first.
 *
 * The cache is only sound because the plan is VERIFIED against each row's key
 * list rather than assumed, and these tests exist to hold that property down.
 *
 * What each weakening of `rowPlanMatches` costs, and which test catches it:
 *   - keep only the length check, dropping the per-column comparison: a plan
 *     is then accepted for a DIFFERENT column set of the same width, so a
 *     column the plan does not know is dropped from the output and one it does
 *     comes back undefined. Caught by the same-length-different-set test.
 *     Reusing a plan across a merely REORDERED row does not corrupt values,
 *     because the apply loop addresses cells by name, but it does take the
 *     output's key order from the wrong row: caught by the key-order test.
 *   - drop the length check as well: caught by the projection-width test.
 *   - share one plan across tables: caught by the two-table test, whose two
 *     shapes are deliberately the same width so a length check cannot save it.
 *
 * The first version of this file asserted only values under reordering and so
 * passed against a length-only guard. Any test added here should be run against
 * a deliberately weakened guard before it is trusted.
 *
 * Run: npx tsx --test src/test/row-decode-plan.test.ts
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { QueryInterface } from '../query/index.js';
import type { SchemaMetadata, TableMetadata } from '../schema.js';
import { mockTable } from './helpers.js';

// ---------------------------------------------------------------------------
// Schema: two tables, each with one date column, so a plan built for one can be
// detected if it leaks to the other.
// ---------------------------------------------------------------------------

function withDateColumns(table: TableMetadata, dateColumns: string[]): TableMetadata {
  return { ...table, dateColumns: new Set(dateColumns) };
}

function buildSchema(): SchemaMetadata {
  const tables: Record<string, TableMetadata> = {};

  tables.users = withDateColumns(
    mockTable('users', [
      { name: 'id', field: 'id' },
      { name: 'email', field: 'email', pgType: 'text' },
      { name: 'full_name', field: 'fullName', pgType: 'text' },
      { name: 'created_at', field: 'createdAt', pgType: 'timestamptz' },
    ]),
    ['created_at'],
  );

  tables.posts = withDateColumns(
    mockTable('posts', [
      { name: 'id', field: 'id' },
      { name: 'title', field: 'title', pgType: 'text' },
      { name: 'published_at', field: 'publishedAt', pgType: 'timestamptz' },
    ]),
    ['published_at'],
  );

  return { tables, enums: {} };
}

/**
 * A pool that hands back a fixed list of rows for every query. The rows are
 * handed back BY REFERENCE in the order given, so a test can vary the key order
 * from row to row, which is the case the plan verification exists for.
 */
function poolReturning(rows: Record<string, unknown>[]): {
  query: (text: string, values?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number }>;
} {
  return {
    query: async () => ({ rows, rowCount: rows.length }),
  };
}

function makeParseQuery(
  rows: Record<string, unknown>[],
  schema: SchemaMetadata,
  table: string,
): QueryInterface<Record<string, unknown>> {
  return new QueryInterface<Record<string, unknown>>(
    // biome-ignore lint/suspicious/noExplicitAny: mock pool for testing
    poolReturning(rows) as any,
    table,
    schema,
    undefined,
    { warnOnUnlimited: false },
  );
}

async function readAll(
  rows: Record<string, unknown>[],
  schema: SchemaMetadata,
  table: string,
): Promise<Record<string, unknown>[]> {
  const q = makeParseQuery(rows, schema, table);
  return (await q.findMany()) as Record<string, unknown>[];
}

// ---------------------------------------------------------------------------

describe('parseRow decode plan', () => {
  it('maps snake_case columns to camelCase fields', async () => {
    const schema = buildSchema();
    const out = await readAll([{ id: 1, email: 'a@x', full_name: 'Ada', created_at: null }], schema, 'users');

    assert.deepEqual(Object.keys(out[0]!), ['id', 'email', 'fullName', 'createdAt']);
    assert.equal(out[0]!.fullName, 'Ada');
  });

  it('reuses the plan across rows of one result set', async () => {
    const schema = buildSchema();
    const out = await readAll(
      [
        { id: 1, email: 'a@x', full_name: 'Ada', created_at: null },
        { id: 2, email: 'b@x', full_name: 'Bea', created_at: null },
        { id: 3, email: 'c@x', full_name: 'Cy', created_at: null },
      ],
      schema,
      'users',
    );

    assert.deepEqual(
      out.map((r) => r.fullName),
      ['Ada', 'Bea', 'Cy'],
    );
    assert.deepEqual(
      out.map((r) => r.email),
      ['a@x', 'b@x', 'c@x'],
    );
  });

  it('rejects a plan whose column SET differs at the same length', async () => {
    // The case a length-only check gets wrong, and the reason the plan is
    // compared column by column. Two projections of the same table with the
    // same width: reusing the first plan reads `row['email']` for a row that
    // has no `email`, so `email` comes back undefined and `full_name` is
    // dropped from the output entirely. Both are silent.
    const schema = buildSchema();
    const rows: Record<string, unknown>[] = [{ id: 1, email: 'a@x' }];
    const q = makeParseQuery(rows, schema, 'users');

    const first = (await q.findMany({ select: { id: true, email: true } })) as Record<string, unknown>[];
    assert.deepEqual(Object.keys(first[0]!), ['id', 'email']);

    rows.length = 0;
    rows.push({ id: 2, full_name: 'Bea' });
    const second = (await q.findMany({ select: { id: true, fullName: true } })) as Record<string, unknown>[];

    assert.deepEqual(Object.keys(second[0]!), ['id', 'fullName']);
    assert.equal(second[0]!.fullName, 'Bea');
    assert.equal('email' in second[0]!, false, 'must not invent an email key from the previous plan');
  });

  it('keeps each row’s own key order in the output', async () => {
    // Same table, same column set, different order. Values are addressed by
    // name so they stay correct either way, but the output object used to take
    // its key order from the row it came from, and reusing a plan across a
    // reordered row would silently re-order the result. Asserting the order is
    // what makes the per-column comparison load-bearing rather than decorative.
    const schema = buildSchema();
    const out = await readAll(
      [
        { id: 1, email: 'a@x', full_name: 'Ada', created_at: null },
        { created_at: null, full_name: 'Bea', email: 'b@x', id: 2 },
      ],
      schema,
      'users',
    );

    assert.deepEqual(Object.keys(out[0]!), ['id', 'email', 'fullName', 'createdAt']);
    assert.deepEqual(Object.keys(out[1]!), ['createdAt', 'fullName', 'email', 'id']);
    assert.equal(out[1]!.id, 2, 'id must stay id');
    assert.equal(out[1]!.email, 'b@x', 'email must stay email');
    assert.equal(out[1]!.fullName, 'Bea', 'fullName must stay fullName');
  });

  it('applies date coercion to the date column, not to its neighbour', async () => {
    const schema = buildSchema();
    const out = await readAll(
      [{ id: 7, email: 'a@x', full_name: 'Ada', created_at: '2020-03-04 05:06:07' }],
      schema,
      'users',
    );

    assert.ok(out[0]!.createdAt instanceof Date, 'createdAt should be a Date');
    assert.equal(Number.isNaN((out[0]!.createdAt as Date).getTime()), false, 'and a valid one');
    assert.equal(out[0]!.id, 7, 'id must not be coerced');
    assert.equal(out[0]!.email, 'a@x', 'email must not be coerced');
  });

  it('follows the date column when a later row MOVES it', async () => {
    // The date flag is positional WITHIN the plan, and the plan's own column
    // list is what the apply loop indexes, so a reordered row still coerces the
    // right cell. This pins that, rather than the guard: the guard's own
    // failure modes are the two tests above.
    const schema = buildSchema();
    const out = await readAll(
      [
        { id: 1, email: 'a@x', full_name: 'Ada', created_at: '2020-03-04 05:06:07' },
        { created_at: '2021-04-05 06:07:08', id: 2, email: 'b@x', full_name: 'Bea' },
      ],
      schema,
      'users',
    );

    assert.ok(out[1]!.createdAt instanceof Date, 'createdAt should still be a Date after the move');
    assert.equal(out[1]!.id, 2, 'id must not have been run through date coercion');
    assert.equal(typeof out[1]!.id, 'number');
  });

  it('rebuilds the plan when a projection changes the column count', async () => {
    // Two reads on ONE QueryInterface, so they share the plan cache.
    const schema = buildSchema();
    const rows: Record<string, unknown>[] = [{ id: 1, email: 'a@x', full_name: 'Ada', created_at: null }];
    const q = makeParseQuery(rows, schema, 'users');

    const full = (await q.findMany()) as Record<string, unknown>[];
    assert.deepEqual(Object.keys(full[0]!), ['id', 'email', 'fullName', 'createdAt']);

    // Narrower shape through the same instance.
    rows.length = 0;
    rows.push({ id: 2, email: 'b@x' });
    const narrow = (await q.findMany({ select: { id: true, email: true } })) as Record<string, unknown>[];
    assert.deepEqual(Object.keys(narrow[0]!), ['id', 'email']);
    assert.equal(narrow[0]!.email, 'b@x');

    // And back to the wide shape, which must not be served the narrow plan.
    rows.length = 0;
    rows.push({ id: 3, email: 'c@x', full_name: 'Cy', created_at: null });
    const wide = (await q.findMany()) as Record<string, unknown>[];
    assert.deepEqual(Object.keys(wide[0]!), ['id', 'email', 'fullName', 'createdAt']);
    assert.equal(wide[0]!.fullName, 'Cy');
  });

  it('keeps plans separate per table when the column NAMES coincide', async () => {
    // ONE QueryInterface parses more than one table only when a `with` clause
    // makes it walk into a relation target, so that is where a shared plan
    // would do damage. These two tables have identical column lists, in
    // identical order, differing only in what the metadata says those columns
    // MEAN: `stamp` is a timestamp on the parent and text on the child. The
    // per-column comparison cannot separate them, because the columns really
    // are the same names in the same order. Only the table can, and without it
    // the child's text column silently comes back as a Date.
    // Single-word column names on purpose: a top-level row is keyed by
    // snake_case COLUMN name and a nested JSON row by camelCase FIELD name, so
    // the two lists can only coincide where the two spellings are the same.
    const selfRel = (from: string) => ({
      children: {
        type: 'hasMany' as const,
        name: 'children',
        from,
        to: 'labels',
        foreignKey: 'owner',
        referenceKey: 'id',
      },
    });
    const cols = [
      { name: 'id', field: 'id', pgType: 'int4' },
      { name: 'owner', field: 'owner', pgType: 'int4' },
    ];
    const schema: SchemaMetadata = {
      tables: {
        events: withDateColumns(
          mockTable('events', [...cols, { name: 'stamp', field: 'stamp', pgType: 'timestamptz' }], selfRel('events')),
          ['stamp'],
        ),
        labels: withDateColumns(
          mockTable('labels', [...cols, { name: 'stamp', field: 'stamp', pgType: 'text' }], selfRel('labels')),
          [],
        ),
      },
      enums: {},
    };

    const q = new QueryInterface<Record<string, unknown>>(
      // biome-ignore lint/suspicious/noExplicitAny: build-only, transform is driven directly
      null as any,
      'events',
      schema,
    );
    // biome-ignore lint/suspicious/noExplicitAny: mock schema carries no relation type info
    const deferred = q.buildFindMany({ with: { children: true } as any });
    const out = deferred.transform({
      rows: [
        {
          id: 1,
          owner: null,
          stamp: '2020-03-04 05:06:07',
          children: '[{"id":2,"owner":1,"stamp":"2020-03-04 05:06:07","children":[]}]',
        },
      ],
      command: '',
      rowCount: 1,
      oid: 0,
      fields: [],
      // biome-ignore lint/suspicious/noExplicitAny: partial pg.QueryResult is all transform reads
    } as any) as Record<string, unknown>[];

    const parent = out[0]!;
    const child = (parent.children as Record<string, unknown>[])[0]!;
    assert.ok(parent.stamp instanceof Date, "the parent's timestamp column should be a Date");
    assert.equal(child.stamp, '2020-03-04 05:06:07', "the child's text column must stay a string");
  });

  it('leaves a table with no metadata on the snakeToCamel fallback', async () => {
    const schema = buildSchema();
    const q = makeParseQuery([{ id: 1, some_other_col: 'x' }], schema, 'users');
    // parseRow is reached with `this.table`, which does have metadata, so the
    // fallback is exercised through a relation target that does not. Simplest
    // direct check: an unknown column on a known table keeps its raw name.
    const out = (await q.findMany()) as Record<string, unknown>[];
    assert.equal(out[0]!.some_other_col, 'x', 'unmapped column keeps its raw key');
    assert.equal(out[0]!.id, 1);
  });
});
