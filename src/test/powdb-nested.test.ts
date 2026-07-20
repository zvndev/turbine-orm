/**
 * turbine-orm/powdb: nested-projection (shaped results, PowDB >= 0.18) unit
 * tests. Build-only (no server): a fake pool records every PowQL string the
 * {@link PowqlInterface} emits and returns canned rows, so these assert the
 * exact nested-block emission (aliases, correlation, per-parent order/limit/
 * offset, PII-aware projection), the eligibility fallbacks (m2m / explicit
 * 'batched' / pre-0.18 capability / to-one paging / bigint columns keep the
 * keyed loaders, silently), and the attach pass (JSON children shaped into
 * typed entities, to-one unwrap, date coercion, legacy JSON-text parse).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ALL_POWDB_CAPABILITIES, capabilitiesFromVersion, type PowdbCapabilities, type PowdbPool } from '../powdb.js';
import { PowqlInterface } from '../powql.js';
import type { ColumnMetadata, RelationDef, SchemaMetadata, TableMetadata } from '../schema.js';

// ---------------------------------------------------------------------------
// Schema fixtures
// ---------------------------------------------------------------------------

function col(
  name: string,
  field: string,
  tsType: string,
  pgType: string,
  opts: Partial<ColumnMetadata> = {},
): ColumnMetadata {
  return { name, field, pgType, tsType, nullable: false, hasDefault: false, isArray: false, pgArrayType: '', ...opts };
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
    dateColumns: new Set(columns.filter((c) => c.tsType.startsWith('Date')).map((c) => c.name)),
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
    app_user: table(
      'app_user',
      [
        col('id', 'id', 'string', 'text', { hasDefault: true }),
        col('name', 'name', 'string', 'text'),
        col('age', 'age', 'number', 'int4', { nullable: true }),
      ],
      {
        posts: {
          type: 'hasMany',
          name: 'posts',
          from: 'app_user',
          to: 'post',
          foreignKey: 'author_id',
          referenceKey: 'id',
        },
        profile: {
          type: 'hasOne',
          name: 'profile',
          from: 'app_user',
          to: 'profile',
          foreignKey: 'user_id',
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
        counters: {
          type: 'hasMany',
          name: 'counters',
          from: 'app_user',
          to: 'counter',
          foreignKey: 'user_id',
          referenceKey: 'id',
        },
        // Named exactly like the app_user column `name` — its nested block key
        // would duplicate a projected parent column key, so it must stay on the
        // loaders.
        name: {
          type: 'hasMany',
          name: 'name',
          from: 'app_user',
          to: 'post',
          foreignKey: 'author_id',
          referenceKey: 'id',
        },
      },
    ),
    post: table(
      'post',
      [
        col('id', 'id', 'string', 'text', { hasDefault: true }),
        col('author_id', 'authorId', 'string', 'text'),
        col('title', 'title', 'string', 'text'),
        col('views', 'views', 'number', 'int4', { nullable: true }),
        col('published_at', 'publishedAt', 'Date | null', 'timestamptz', { nullable: true }),
        col('email', 'email', 'string', 'text', { pii: true }),
      ],
      {
        author: {
          type: 'belongsTo',
          name: 'author',
          from: 'post',
          to: 'app_user',
          foreignKey: 'author_id',
          referenceKey: 'id',
        },
      },
    ),
    profile: table('profile', [
      col('id', 'id', 'string', 'text', { hasDefault: true }),
      col('user_id', 'userId', 'string', 'text'),
      col('bio', 'bio', 'string', 'text', { nullable: true }),
    ]),
    tag: table('tag', [
      col('id', 'id', 'string', 'text', { hasDefault: true }),
      col('label', 'label', 'string', 'text'),
    ]),
    user_tag: table(
      'user_tag',
      [col('user_id', 'userId', 'string', 'text'), col('tag_id', 'tagId', 'string', 'text')],
      {},
      ['user_id', 'tag_id'],
    ),
    // A child with a bigint-typed column: its values cannot ride a JSON array
    // losslessly, so the relation must stay on the loaders.
    counter: table('counter', [
      col('id', 'id', 'string', 'text', { hasDefault: true }),
      col('user_id', 'userId', 'string', 'text'),
      col('big', 'big', 'bigint', 'int8'),
    ]),
  },
};

// ---------------------------------------------------------------------------
// Fake pool
// ---------------------------------------------------------------------------

const CAPS_018 = capabilitiesFromVersion('0.18.0');

interface MockOptions {
  capabilities?: PowdbCapabilities;
  rows?: Record<string, unknown>[];
}

function mockPool(opts: MockOptions = {}) {
  const calls: { powql: string; params: unknown[] }[] = [];
  const rows = opts.rows ?? [{ id: '1', name: 'Ada', age: 36, posts: [] }];
  const pool = {
    capabilities: opts.capabilities ?? CAPS_018,
    retryStaleReads: false,
    readonly: false,
    query(powql: string, params: unknown[]) {
      calls.push({ powql, params });
      return Promise.resolve({ rows, rowCount: rows.length });
    },
  } as unknown as PowdbPool;
  return { pool, calls, first: () => calls[0]!, last: () => calls[calls.length - 1]! };
}

function qi(mock: ReturnType<typeof mockPool>, t = 'app_user') {
  return new PowqlInterface(mock.pool, t, schema, [], { warnOnUnlimited: false });
}

// ---------------------------------------------------------------------------
// Emission shapes
// ---------------------------------------------------------------------------

describe('powdb nested projections: emission', () => {
  it('hasMany compiles into ONE statement with a correlated nested block', async () => {
    const mock = mockPool();
    await qi(mock).findMany({ with: { posts: true } });
    assert.equal(mock.calls.length, 1, 'no loader follow-up queries');
    assert.equal(
      mock.first().powql,
      'app_user as t0 { id: t0.id, name: t0.name, age: t0.age, ' +
        'posts: post as t1 filter t1.author_id = t0.id ' +
        '{ id: t1.id, author_id: t1.author_id, title: t1.title, views: t1.views, published_at: t1.published_at } }',
    );
  });

  it('belongsTo reverses the correlation and emits limit 1', async () => {
    const mock = mockPool({ rows: [{ id: 'p1', author_id: '1', author: [{ id: '1', name: 'Ada', age: 36 }] }] });
    const posts = await qi(mock, 'post').findMany({ with: { author: true } });
    assert.match(mock.first().powql, /author: app_user as t1 filter t1\.id = t0\.author_id limit 1 \{/);
    // to-one unwraps the array to a single object.
    assert.deepEqual((posts[0] as { author?: unknown }).author, { id: '1', name: 'Ada', age: 36 });
  });

  it('hasOne emits limit 1 and unwraps [] to null', async () => {
    const mock = mockPool({ rows: [{ id: '1', name: 'Ada', age: 36, profile: [] }] });
    const users = await qi(mock).findMany({ with: { profile: true } });
    assert.match(mock.first().powql, /profile: profile as t1 filter t1\.user_id = t0\.id limit 1 \{/);
    assert.equal((users[0] as { profile?: unknown }).profile, null);
  });

  it('child where / orderBy / limit / offset bind per-parent inside the block', async () => {
    const mock = mockPool();
    // Per-relation `offset` is a PowDB-only extra (the shared WithOptions type
    // does not declare it because the SQL engines' relation subqueries do not
    // support it), so it rides through an untyped cast here.
    const withPosts = {
      posts: { where: { views: { gt: 10 } }, orderBy: { views: 'desc' }, limit: 3, offset: 1 },
    } as unknown as { posts: true };
    await qi(mock).findMany({ where: { id: 'u1' }, with: withPosts });
    const { powql, params } = mock.first();
    assert.match(powql, /^app_user as t0 filter t0\.id = \$1 \{ /);
    assert.match(
      powql,
      /posts: post as t1 filter t1\.author_id = t0\.id and \(t1\.views > \$2\) order t1\.views desc limit \$3 offset \$4 \{/,
    );
    assert.deepEqual(params, ['u1', 10, 3, 1]);
  });

  it('multi-level nesting shares the alias counter (t0/t1/t2)', async () => {
    const mock = mockPool();
    await qi(mock).findMany({ with: { posts: { with: { author: true } } } });
    assert.equal(mock.calls.length, 1);
    assert.match(
      mock.first().powql,
      /posts: post as t1 filter t1\.author_id = t0\.id \{ .*author: app_user as t2 filter t2\.id = t1\.author_id limit 1 \{/,
    );
  });

  it('PII columns are excluded from the nested projection by default, included with includePii', async () => {
    const mock = mockPool();
    await qi(mock).findMany({ with: { posts: true } });
    assert.doesNotMatch(mock.first().powql, /email/);
    const mock2 = mockPool();
    await qi(mock2).findMany({ with: { posts: true }, includePii: true });
    assert.match(mock2.first().powql, /email: t1\.email/);
  });

  it('relation select keeps the PK and honors the projection', async () => {
    const mock = mockPool();
    await qi(mock).findMany({ with: { posts: { select: { title: true } } } });
    assert.match(
      mock.first().powql,
      /posts: post as t1 filter t1\.author_id = t0\.id \{ id: t1\.id, title: t1\.title \} \}/,
    );
  });

  it('explain() wraps the same nested statement', async () => {
    const mock = mockPool({ rows: [{ plan: 'SeqScan(app_user)' }] });
    const lines = await qi(mock).explain({ with: { posts: true } });
    assert.match(mock.first().powql, /^explain app_user as t0 \{ /);
    assert.deepEqual(lines, ['SeqScan(app_user)']);
  });

  it('a plain findMany without `with` stays byte-identical (no alias)', async () => {
    const mock = mockPool();
    await qi(mock).findMany({ where: { id: 'u1' }, limit: 5 });
    assert.equal(mock.first().powql, 'app_user filter .id = $1 limit $2 { .id, .name, .age }');
  });
});

// ---------------------------------------------------------------------------
// Eligibility fallbacks (all silent: loaders produce identical output)
// ---------------------------------------------------------------------------

describe('powdb nested projections: loader fallbacks', () => {
  it('explicit relationLoadStrategy: "batched" opts out (per query)', async () => {
    const mock = mockPool();
    await qi(mock).findMany({ with: { posts: true }, relationLoadStrategy: 'batched' });
    assert.ok(mock.calls.length >= 2, 'keyed loader follow-up ran');
    assert.doesNotMatch(mock.first().powql, / as t0/);
  });

  it('a pre-0.18 engine keeps the loaders (capability off)', async () => {
    const mock = mockPool({ capabilities: capabilitiesFromVersion('0.17.0') });
    await qi(mock).findMany({ with: { posts: true } });
    assert.ok(mock.calls.length >= 2);
    assert.doesNotMatch(mock.first().powql, / as t0/);
  });

  it('an unprobed pool (ALL_POWDB_CAPABILITIES) keeps the loaders', async () => {
    const mock = mockPool({ capabilities: ALL_POWDB_CAPABILITIES });
    await qi(mock).findMany({ with: { posts: true } });
    assert.doesNotMatch(mock.first().powql, / as t0/);
  });

  it('m2m stays on the loaders; eligible siblings still nest in the same statement', async () => {
    const mock = mockPool({ rows: [{ id: '1', name: 'Ada', age: 36, posts: [], user_id: '1', tag_id: 't' }] });
    await qi(mock).findMany({ with: { posts: true, tags: true } });
    assert.match(mock.first().powql, /posts: post as t1 /, 'posts nested inline');
    assert.doesNotMatch(mock.first().powql, /tags:/);
    assert.ok(
      mock.calls.some((c) => c.powql.startsWith('user_tag ')),
      'tags went through the junction loader',
    );
  });

  it('a to-one relation with limit/offset stays on the loaders', async () => {
    const mock = mockPool({ rows: [{ id: '1', name: 'Ada', age: 36, user_id: '1' }] });
    await qi(mock).findMany({ with: { profile: { limit: 2 } } });
    assert.doesNotMatch(mock.first().powql, / as t0/);
  });

  it('a bigint-typed child column stays on the loaders (JSON cannot carry it)', async () => {
    const mock = mockPool({ rows: [{ id: '1', name: 'Ada', age: 36, user_id: '1', big: '9007199254740993' }] });
    await qi(mock).findMany({ with: { counters: true } });
    assert.doesNotMatch(mock.first().powql, / as t0/);
  });

  it('a relation whose name collides with a projected parent column stays on the loaders', async () => {
    const mock = mockPool({ rows: [{ id: '1', name: 'Ada', age: 36, author_id: '1' }] });
    await qi(mock).findMany({ with: { name: true } });
    assert.doesNotMatch(mock.first().powql, / as t0/);
  });

  it('parent distinct never nests', async () => {
    const mock = mockPool({ rows: [{ id: '1', name: 'Ada', age: 36, author_id: '1' }] });
    await qi(mock).findMany({ distinct: ['name'], with: { posts: true } });
    assert.doesNotMatch(mock.first().powql, / as t0/);
  });

  it('an ineligible descendant makes the WHOLE relation fall back', async () => {
    // posts is eligible, but its nested author carries a limit (to-one paging),
    // so the entire posts subtree stays on the loaders.
    const mock = mockPool({ rows: [{ id: '1', name: 'Ada', age: 36, author_id: '1' }] });
    await qi(mock).findMany({ with: { posts: { with: { author: { limit: 2 } } } } });
    assert.doesNotMatch(mock.first().powql, / as t0/);
  });

  it('explicit "join" strategy prefers nesting on a 0.18 engine', async () => {
    const mock = mockPool();
    await qi(mock).findMany({ with: { posts: true }, relationLoadStrategy: 'join' });
    assert.equal(mock.calls.length, 1);
    assert.match(mock.first().powql, /posts: post as t1 /);
    assert.doesNotMatch(mock.first().powql, / join /);
  });
});

// ---------------------------------------------------------------------------
// Attach pass: shaping the JSON children
// ---------------------------------------------------------------------------

describe('powdb nested projections: attach + coercion', () => {
  it('shapes children to camelCase typed entities and coerces dates from micros', async () => {
    const micros = Date.UTC(2026, 0, 2, 3, 4, 5) * 1000;
    const mock = mockPool({
      rows: [
        {
          id: '1',
          name: 'Ada',
          age: 36,
          posts: [{ id: 'p1', author_id: '1', title: 'T', views: 7, published_at: micros }],
        },
      ],
    });
    const users = await qi(mock).findMany({ with: { posts: true } });
    const post = (users[0] as { posts: Record<string, unknown>[] }).posts[0]!;
    assert.equal(post.authorId, '1', 'snake column mapped to camel field');
    assert.equal(post.views, 7);
    assert.ok(post.publishedAt instanceof Date, 'micros number became a Date');
    assert.equal((post.publishedAt as Date).getTime(), micros / 1000);
  });

  it('parses a legacy-wire JSON text cell', async () => {
    const mock = mockPool({
      rows: [{ id: '1', name: 'Ada', age: 36, posts: '[{"id":"p1","author_id":"1","title":"T","views":null}]' }],
    });
    const users = await qi(mock).findMany({ with: { posts: true } });
    const posts = (users[0] as { posts: Record<string, unknown>[] }).posts;
    assert.equal(posts.length, 1);
    assert.equal(posts[0]!.title, 'T');
    assert.equal(posts[0]!.views, null);
  });

  it('childless parents keep [] (hasMany) and null (to-one)', async () => {
    const mock = mockPool({ rows: [{ id: '1', name: 'Ada', age: 36, posts: [], profile: [] }] });
    const users = await qi(mock).findMany({ with: { posts: true, profile: true } });
    assert.deepEqual((users[0] as { posts: unknown }).posts, []);
    assert.equal((users[0] as { profile: unknown }).profile, null);
  });

  it('multi-level children shape recursively', async () => {
    const mock = mockPool({
      rows: [
        {
          id: '1',
          name: 'Ada',
          age: 36,
          posts: [{ id: 'p1', author_id: '1', title: 'T', views: 1, author: [{ id: '1', name: 'Ada', age: 36 }] }],
        },
      ],
    });
    const users = await qi(mock).findMany({ with: { posts: { with: { author: true } } } });
    const post = (users[0] as { posts: { author: { name: string } }[] }).posts[0]!;
    assert.equal(post.author.name, 'Ada', 'grandchild unwrapped to an object');
  });

  it('findUnique and findFirst take the nested path too', async () => {
    const mock = mockPool({ rows: [{ id: '1', name: 'Ada', age: 36, posts: [] }] });
    const u = await qi(mock).findUnique({ where: { id: '1' }, with: { posts: true } });
    assert.deepEqual((u as { posts: unknown }).posts, []);
    assert.equal(mock.calls.length, 1);
    assert.match(mock.first().powql, /posts: post as t1 /);
  });
});
