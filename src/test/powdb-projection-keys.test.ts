/**
 * turbine-orm/powdb: projection KEYS and dotted-reference quoting.
 *
 * These assert the returned OBJECT, not the emitted statement, which is the
 * whole point: PowDB's existing projection tests all assert the PowQL text, and
 * that is exactly why the bug below survived. `projectedColumns` force-adds the
 * primary key for internal use (upsert reselects by it, the m2m loader keys its
 * target map on it, the join path correlates through it), which is correct, but
 * nothing took it back off the entity. So:
 *
 *   SQL engines  select { name: true }  ->  SELECT "users"."name"
 *                omit   { id:   true }  ->  SELECT "users"."name"
 *   PowDB        select { name: true }  ->  { id, name }
 *                omit   { id:   true }  ->  { id, ... }
 *
 * i.e. `omit: { id: true }` returned the column the caller asked to hide. All
 * five PowDB paths did it (top-level find, batched loader, native join, nested
 * projection, link path). The link path was the only one carrying a strip at
 * all, and the strip was dead: it asked "did the caller select the PK" of the
 * column list taken AFTER the force-add, which always answers yes. So there was
 * one strip in the tree and it had never run.
 *
 * The second half covers the dotted-reference quoting boundary: a column name
 * outside PowQL's bare-identifier grammar used to be interpolated RAW into
 * `.name`, the one identifier site in the engine with no quoting at all.
 *
 * Run: npx tsx --test src/test/powdb-projection-keys.test.ts
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ALL_POWDB_CAPABILITIES, capabilitiesFromVersion, type PowdbPool } from '../powdb.js';
import { PowqlInterface } from '../powql.js';
import type { ColumnMetadata, RelationDef, SchemaMetadata, TableMetadata } from '../schema.js';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

function col(name: string, field: string, opts: Partial<ColumnMetadata> = {}): ColumnMetadata {
  return {
    name,
    field,
    pgType: 'text',
    tsType: 'string',
    nullable: false,
    hasDefault: false,
    isArray: false,
    pgArrayType: '',
    ...opts,
  };
}

function table(
  name: string,
  columns: ColumnMetadata[],
  relations: Record<string, RelationDef> = {},
  pk: string[] = ['id'],
): TableMetadata {
  const columnMap: Record<string, string> = {};
  const reverseColumnMap: Record<string, string> = {};
  for (const c of columns) {
    columnMap[c.field] = c.name;
    reverseColumnMap[c.name] = c.field;
  }
  return {
    name,
    columns,
    columnMap,
    reverseColumnMap,
    dateColumns: new Set(),
    pgTypes: Object.fromEntries(columns.map((c) => [c.name, c.pgType])),
    allColumns: columns.map((c) => c.name),
    primaryKey: pk,
    uniqueColumns: pk.length === 1 ? [pk] : [],
    relations,
    indexes: [],
  };
}

const schema: SchemaMetadata = {
  enums: {},
  tables: {
    app_user: table('app_user', [col('id', 'id', { hasDefault: true }), col('name', 'name')], {
      posts: {
        type: 'hasMany',
        name: 'posts',
        from: 'app_user',
        to: 'post',
        foreignKey: 'author_id',
        referenceKey: 'id',
      },
      tags: {
        type: 'manyToMany',
        name: 'tags',
        from: 'app_user',
        to: 'tag',
        foreignKey: 'id',
        referenceKey: 'id',
        through: { table: 'user_tag', sourceKey: 'user_id', targetKey: 'tag_id' },
      },
    }),
    post: table('post', [col('id', 'id', { hasDefault: true }), col('author_id', 'authorId'), col('title', 'title')]),
    tag: table('tag', [col('id', 'id', { hasDefault: true }), col('label', 'label')]),
    user_tag: table('user_tag', [col('user_id', 'userId'), col('tag_id', 'tagId')], {}, ['user_id', 'tag_id']),
  },
};

// ---------------------------------------------------------------------------
// Mock pool: routes canned rows by the leading table name of each statement,
// so a multi-statement plan (loader, m2m) gets sensible rows per hop. Rows are
// deliberately returned WITH the primary key, because that is what the engine
// really returns: the projection asked for it.
// ---------------------------------------------------------------------------

function mockPool(rowsFor: Record<string, Record<string, unknown>[]>, version = '0.20.0') {
  const calls: { powql: string; params: unknown[] }[] = [];
  const pool = {
    capabilities: version === 'all' ? ALL_POWDB_CAPABILITIES : capabilitiesFromVersion(version),
    retryStaleReads: false,
    readonly: false,
    query(powql: string, params: unknown[]) {
      calls.push({ powql, params });
      // The leading table ref: `upsert T …`, `` `T` as t0 … ``, or `T filter …`.
      const m = /^(?:upsert\s+)?(?:`([^`]+)`|([A-Za-z_][A-Za-z0-9_]*))/.exec(powql);
      const head = m?.[1] ?? m?.[2] ?? '';
      const rows = rowsFor[head] ?? [];
      return Promise.resolve({ rows, rowCount: rows.length });
    },
    connect() {
      throw new Error('connect() must not be reached');
    },
  } as unknown as PowdbPool;
  return { pool, calls, first: () => calls[0]!, find: (re: RegExp) => calls.find((c) => re.test(c.powql)) };
}

const qi = (
  mock: ReturnType<typeof mockPool>,
  t = 'app_user',
  opts: Record<string, unknown> = {},
  // biome-ignore lint/suspicious/noExplicitAny: PowqlInterface is generic over a row shape these fixtures do not declare.
): any => new PowqlInterface(mock.pool, t, schema, [], { warnOnUnlimited: false, ...opts });

// ---------------------------------------------------------------------------
// Top-level projection
// ---------------------------------------------------------------------------

describe('powdb projection keys: the internally-forced PK is stripped from the entity', () => {
  it('select without the PK returns ONLY the selected fields', async () => {
    const mock = mockPool({ post: [{ id: 'p1', title: 'hello' }] });
    const rows = await qi(mock, 'post').findMany({ select: { title: true } });
    assert.deepEqual(Object.keys(rows[0]), ['title']);
    // The FETCH still asks for the PK, which is the half that must not change:
    // reselect and relation stitching depend on it.
    assert.match(mock.first().powql, /\{ \.id, \.title \}/);
  });

  it('omit of the PK actually hides it', async () => {
    const mock = mockPool({ post: [{ id: 'p1', author_id: 'u1', title: 'hello' }] });
    const rows = await qi(mock, 'post').findMany({ omit: { id: true } });
    assert.ok(
      !('id' in rows[0]),
      `omit: { id: true } returned the column it was asked to hide: ${Object.keys(rows[0])}`,
    );
    assert.deepEqual(Object.keys(rows[0]).sort(), ['authorId', 'title']);
    assert.match(mock.first().powql, /\.id/);
  });

  it('keeps the PK when the caller DID select it', async () => {
    const mock = mockPool({ post: [{ id: 'p1', title: 'hello' }] });
    const rows = await qi(mock, 'post').findMany({ select: { id: true, title: true } });
    assert.deepEqual(Object.keys(rows[0]).sort(), ['id', 'title']);
  });

  it('a default projection is unchanged', async () => {
    const mock = mockPool({ post: [{ id: 'p1', author_id: 'u1', title: 'hello' }] });
    const rows = await qi(mock, 'post').findMany({});
    assert.deepEqual(Object.keys(rows[0]).sort(), ['authorId', 'id', 'title']);
  });

  it('findUnique and findFirst strip identically to findMany', async () => {
    for (const method of ['findUnique', 'findFirst'] as const) {
      const mock = mockPool({ post: [{ id: 'p1', title: 'hello' }] });
      const row = await qi(mock, 'post')[method]({ where: { title: 'hello' }, select: { title: true } });
      assert.deepEqual(Object.keys(row), ['title'], method);
    }
  });
});

// ---------------------------------------------------------------------------
// Relation paths: all four must agree
// ---------------------------------------------------------------------------

describe('powdb projection keys: every relation path agrees with the top level', () => {
  it('batched loader child', async () => {
    const mock = mockPool({
      app_user: [{ id: 'u1', name: 'ann' }],
      post: [{ id: 'p1', author_id: 'u1', title: 'hello' }],
    });
    const rows = await qi(mock).findMany({
      with: { posts: { select: { title: true } } },
      relationLoadStrategy: 'batched',
    });
    const child = (rows[0].posts as Record<string, unknown>[])[0]!;
    // Neither the forced PK nor the loader's forced correlation column.
    assert.deepEqual(Object.keys(child), ['title']);
  });

  it('native join child', async () => {
    // Pinned below 0.18 so nested projections are unavailable and `'join'`
    // really compiles the INNER PowQL join rather than preferring nesting.
    const mock = mockPool(
      {
        app_user: [{ id: 'u1', name: 'ann' }],
        post: [{ __tpk: 'u1', id: 'p1', title: 'hello' }],
      },
      '0.17.0',
    );
    const rows = await qi(mock).findMany({
      with: { posts: { select: { title: true } } },
      relationLoadStrategy: 'join',
    });
    const child = (rows[0].posts as Record<string, unknown>[])[0]!;
    assert.deepEqual(Object.keys(child), ['title']);
  });

  it('nested-projection child', async () => {
    // The 0.18+ default: the relation compiles INTO the parent statement.
    const mock = mockPool({
      app_user: [{ id: 'u1', name: 'ann', posts: [{ id: 'p1', title: 'hello' }] }],
    });
    const rows = await qi(mock).findMany({ with: { posts: { select: { title: true } } } });
    const nested = mock.first().powql;
    assert.match(nested, /posts: post as t1/, 'expected the nested-projection plan');
    const child = (rows[0].posts as Record<string, unknown>[])[0]!;
    assert.deepEqual(Object.keys(child), ['title']);
  });

  it('m2m loader still stitches when the target PK is not selected', async () => {
    // The hazard the strip creates: this loader keys `targetByPk` on the
    // TARGET's own primary key, so it has to force the PK into its own fetch
    // and take it off after stitching. Without that, stripping inside the
    // child findMany would key every target on "undefined" and the relation
    // would come back empty for every parent, which is the 0.63 bug.
    const mock = mockPool({
      app_user: [{ id: 'u1', name: 'ann' }],
      user_tag: [{ user_id: 'u1', tag_id: 't1' }],
      tag: [{ id: 't1', label: 'red' }],
    });
    const rows = await qi(mock).findMany({ with: { tags: { select: { label: true } } } });
    const tags = rows[0].tags as Record<string, unknown>[];
    assert.equal(tags.length, 1, 'the m2m relation must still stitch');
    assert.deepEqual(Object.keys(tags[0]!), ['label']);
  });

  it('m2m loader refuses the same projection shapes the top level refuses', async () => {
    const mock = mockPool({
      app_user: [{ id: 'u1', name: 'ann' }],
      user_tag: [{ user_id: 'u1', tag_id: 't1' }],
      tag: [],
    });
    await assert.rejects(
      () => qi(mock).findMany({ with: { tags: { select: {} } } }),
      /names no fields|selects no fields|TURBINE_E003/,
    );
  });
});

// ---------------------------------------------------------------------------
// Link paths: the fifth relation path, and the one whose strip was dead
// ---------------------------------------------------------------------------

describe('powdb projection keys: the scalar link path', () => {
  // A belongsTo whose child projection carries a bigint column, which is the
  // only shape `planLinkPathRelation` adopts (a JSON nested block cannot carry
  // int8, so nested projections have already declined it).
  const linkSchema: SchemaMetadata = {
    enums: {},
    tables: {
      article: table(
        'article',
        [col('id', 'id', { hasDefault: true }), col('author_id', 'authorId'), col('title', 'title')],
        {
          author: {
            type: 'belongsTo',
            name: 'author',
            from: 'article',
            to: 'writer',
            foreignKey: 'author_id',
            referenceKey: 'id',
          },
        },
      ),
      writer: table('writer', [
        col('id', 'id', { hasDefault: true }),
        col('hits', 'hits', { pgType: 'int8', tsType: 'bigint' }),
        col('name', 'name'),
      ]),
    },
  };

  const LINK_ROW = {
    owner: 'article',
    name: 'author',
    target: 'writer',
    local_key: 'author_id',
    target_key: 'id',
    cardinality: 'to-one',
  };

  // biome-ignore lint/suspicious/noExplicitAny: see qi() above.
  const linkQi = (mock: ReturnType<typeof mockPool>): any =>
    new PowqlInterface(mock.pool, 'article', linkSchema, [], { warnOnUnlimited: false });

  it('compiles the link path for a bigint child column', async () => {
    const mock = mockPool({
      schema: [LINK_ROW],
      article: [{ id: 'a1', author_id: 'w1', title: 'hello', l1_id: 'w1', l1_hits: 7 }],
    });
    const rows = await linkQi(mock).findMany({ with: { author: { select: { hits: true } } } });
    // Precondition for the assertion below: this really is the link plan, not a
    // loader or a nested block. Without it the next test proves nothing. (The
    // first statement is the lazy `schema links` snapshot, so search the calls.)
    assert.ok(
      mock.find(/l1_hits: t0\.author\.hits/),
      `expected the scalar link-path plan, got: ${mock.calls.map((c) => c.powql).join(' | ')}`,
    );
    assert.equal(mock.calls.length, 2, 'the link path is one statement, no loader follow-up');
    assert.deepEqual(rows[0].author, { hits: 7 });
  });

  it('strips the forced PK from the link-path child', async () => {
    const mock = mockPool({
      schema: [LINK_ROW],
      article: [{ id: 'a1', author_id: 'w1', title: 'hello', l1_id: 'w1', l1_hits: 7 }],
    });
    const rows = await linkQi(mock).findMany({ with: { author: { select: { hits: true } } } });
    const child = rows[0].author as Record<string, unknown>;
    // This is the regression. `pkProjected` used to be read off the ALREADY
    // force-added column list, so it was always true and the strip below it
    // never ran; the caller got { id, hits } for `select: { hits: true }`.
    assert.deepEqual(
      Object.keys(child),
      ['hits'],
      `the forced PK leaked into the link-path child: ${Object.keys(child)}`,
    );
  });

  it('omit of the PK hides it on the link-path child too', async () => {
    const mock = mockPool({
      schema: [LINK_ROW],
      article: [{ id: 'a1', author_id: 'w1', title: 'hello', l1_id: 'w1', l1_hits: 7, l1_name: 'ann' }],
    });
    const rows = await linkQi(mock).findMany({ with: { author: { omit: { id: true } } } });
    const child = rows[0].author as Record<string, unknown>;
    assert.ok(!('id' in child), `omit returned the column it was asked to hide: ${Object.keys(child)}`);
    assert.deepEqual(Object.keys(child).sort(), ['hits', 'name']);
  });

  it('keeps the PK when the caller selected it', async () => {
    const mock = mockPool({
      schema: [LINK_ROW],
      article: [{ id: 'a1', author_id: 'w1', title: 'hello', l1_id: 'w1', l1_hits: 7 }],
    });
    const rows = await linkQi(mock).findMany({ with: { author: { select: { id: true, hits: true } } } });
    assert.deepEqual(Object.keys(rows[0].author as object).sort(), ['hits', 'id']);
  });

  it('a dangling hop is still null, not a stripped empty object', async () => {
    const mock = mockPool({
      schema: [LINK_ROW],
      article: [{ id: 'a1', author_id: null, title: 'hello', l1_id: null, l1_hits: null }],
    });
    const rows = await linkQi(mock).findMany({ with: { author: { select: { hits: true } } } });
    assert.equal(rows[0].author, null);
  });
});

// ---------------------------------------------------------------------------
// Dotted-reference quoting
// ---------------------------------------------------------------------------

describe('powdb dotted references: a non-bare column name is quoted, keywords stay bare', () => {
  const oddSchema: SchemaMetadata = {
    enums: {},
    tables: {
      thing: table('thing', [
        col('id', 'id', { hasDefault: true }),
        // Outside POWQL_BARE_IDENT: emitted raw, this carried a space straight
        // into the statement.
        col('full name', 'fullName'),
        // A PowQL keyword: the dotted position bypasses keyword lookup, so this
        // must STAY bare, which is the documented <= 0.9 compatibility rule.
        col('order', 'order'),
      ]),
    },
  };
  // biome-ignore lint/suspicious/noExplicitAny: see qi() above.
  const oddQi = (mock: ReturnType<typeof mockPool>): any =>
    new PowqlInterface(mock.pool, 'thing', oddSchema, [], { warnOnUnlimited: false });

  it('quotes a column name the bare-identifier grammar rejects', async () => {
    const mock = mockPool({ thing: [] });
    await oddQi(mock).findMany({ where: { fullName: 'x' }, orderBy: { fullName: 'asc' } });
    const powql = mock.first().powql;
    assert.match(powql, /filter \.`full name` = \$1/);
    assert.match(powql, /order \.`full name` asc/);
    assert.match(powql, /\{ \.id, \.`full name`, \.order \}/);
    // And nothing raw survives: a bare `.full name` would put a space (and the
    // rest of the name) into the statement's syntax.
    assert.ok(!/\.full name/.test(powql), `raw name leaked into the statement: ${powql}`);
  });

  it('leaves a keyword column bare in the dotted position', async () => {
    const mock = mockPool({ thing: [] });
    await oddQi(mock).findMany({ where: { order: 1 } });
    // `.order` parses on every engine version; quoting it would break the
    // pre-0.10 engines that have no backticks at all.
    assert.match(mock.first().powql, /filter \.order = \$1/);
  });

  it('refuses a name PowQL cannot represent at all', async () => {
    const backtickSchema: SchemaMetadata = {
      enums: {},
      tables: { t: table('t', [col('id', 'id', { hasDefault: true }), col('a`b', 'aB')]) },
    };
    const mock = mockPool({ t: [] });
    // biome-ignore lint/suspicious/noExplicitAny: see qi() above.
    const backtickQi: any = new PowqlInterface(mock.pool, 't', backtickSchema, [], { warnOnUnlimited: false });
    await assert.rejects(() => backtickQi.findMany({}), /backtick/);
  });
});
