/**
 * turbine-orm/powdb — F2 native-join + F4 explain + readonly-guard unit tests.
 *
 * Build-only (no server): a fake pool records every PowQL string the
 * {@link PowqlInterface} emits and returns canned rows, so these assert the
 * exact join emission (aliases, `__tpk` projection, chained m2m joins, qualified
 * where), the eligibility fallbacks (parent paging / nested `with` / capability
 * gates keep the keyed loaders), the `explain` prefix + plan-line extraction,
 * and the read-only exec-seam guard — all without the addon or a socket.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ReadOnlyError, UnsupportedFeatureError, ValidationError } from '../errors.js';
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
        col('data', 'data', 'Record<string, unknown>', 'jsonb', { nullable: true }),
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
        bad: {
          type: 'hasMany',
          name: 'bad',
          from: 'app_user',
          to: 'collide',
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
        col('data', 'data', 'Record<string, unknown>', 'jsonb', { nullable: true }),
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
    // A target whose column literally named `__tpk` collides with the reserved
    // join correlation alias.
    collide: table('collide', [
      col('id', 'id', 'string', 'text', { hasDefault: true }),
      col('author_id', 'authorId', 'string', 'text'),
      col('__tpk', 'tpk', 'string', 'text', { nullable: true }),
    ]),
  },
};

// ---------------------------------------------------------------------------
// Fake pool — records emitted PowQL, returns canned rows, feature-flag knobs.
// ---------------------------------------------------------------------------

interface MockOptions {
  capabilities?: PowdbCapabilities;
  readonly?: boolean;
  rows?: Record<string, unknown>[];
}

function mockPool(opts: MockOptions = {}) {
  const calls: { powql: string; params: unknown[] }[] = [];
  let connects = 0;
  const rows = opts.rows ?? [{ id: '1' }];
  const pool = {
    capabilities: opts.capabilities ?? ALL_POWDB_CAPABILITIES,
    retryStaleReads: false,
    readonly: opts.readonly ?? false,
    query(powql: string, params: unknown[]) {
      calls.push({ powql, params });
      if (/\breturning$/.test(powql)) return Promise.resolve({ rows, rowCount: rows.length });
      if (/ update \{| delete$/.test(powql)) return Promise.resolve({ rows: [], rowCount: 1 });
      return Promise.resolve({ rows, rowCount: rows.length });
    },
    connect() {
      connects++;
      throw new Error('connect() must not be reached on a read-only begin');
    },
  } as unknown as PowdbPool;
  return {
    pool,
    calls,
    connects: () => connects,
    joinCall: () => calls.find((c) => / join /.test(c.powql)),
    last: () => calls[calls.length - 1]!,
  };
}

function qi(mock: ReturnType<typeof mockPool>, t = 'app_user') {
  return new PowqlInterface(mock.pool, t, schema, [], { warnOnUnlimited: false });
}

// A pool whose client-level default is relationLoadStrategy: 'join'.
function qiClientJoin(mock: ReturnType<typeof mockPool>, t = 'app_user') {
  return new PowqlInterface(mock.pool, t, schema, [], { relationLoadStrategy: 'join', warnOnUnlimited: false });
}

// ---------------------------------------------------------------------------
// F2: join emission shapes
// ---------------------------------------------------------------------------

describe('powdb F2: native-join emission', () => {
  it('hasMany → INNER join of target to fetched side, __tpk from parent key', async () => {
    const mock = mockPool();
    await qi(mock).findMany({ with: { posts: true }, relationLoadStrategy: 'join' });
    assert.equal(
      mock.joinCall()!.powql,
      'post as c join app_user as p on c.author_id = p.id ' +
        '{ __tpk: p.id, id: c.id, author_id: c.author_id, title: c.title, views: c.views, data: c.data }',
    );
  });

  it('belongsTo → reversed roles: target joins to the already-fetched child side', async () => {
    const mock = mockPool();
    await qi(mock, 'post').findMany({ with: { author: true }, relationLoadStrategy: 'join' });
    assert.equal(
      mock.joinCall()!.powql,
      'app_user as c join post as p on c.id = p.author_id ' +
        '{ __tpk: p.author_id, id: c.id, name: c.name, age: c.age, data: c.data }',
    );
  });

  it('hasOne → single INNER join correlated on the parent PK', async () => {
    const mock = mockPool();
    await qi(mock).findMany({ with: { profile: true }, relationLoadStrategy: 'join' });
    assert.equal(
      mock.joinCall()!.powql,
      'profile as c join app_user as p on c.user_id = p.id ' +
        '{ __tpk: p.id, id: c.id, user_id: c.user_id, bio: c.bio }',
    );
  });

  it('manyToMany → chained joins target→junction→parent, __tpk from the junction source key', async () => {
    const mock = mockPool();
    await qi(mock).findMany({ with: { tags: true }, relationLoadStrategy: 'join' });
    assert.equal(
      mock.joinCall()!.powql,
      'tag as t join user_tag as j on t.id = j.tag_id join app_user as p on j.user_id = p.id ' +
        '{ __tpk: j.user_id, id: t.id, label: t.label }',
    );
  });

  it('respects the relation select (still projects __tpk + the parent key)', async () => {
    const mock = mockPool();
    await qi(mock).findMany({ with: { posts: { select: { title: true } } }, relationLoadStrategy: 'join' });
    assert.equal(
      mock.joinCall()!.powql,
      'post as c join app_user as p on c.author_id = p.id { __tpk: p.id, id: c.id, title: c.title }',
    );
  });

  it('pushes the relation orderBy + per-parent limit into the hasMany join', async () => {
    const mock = mockPool();
    await qi(mock).findMany({
      with: { posts: { orderBy: { views: 'desc' }, limit: 3 } },
      relationLoadStrategy: 'join',
    });
    const call = mock.joinCall()!;
    assert.match(call.powql, /order c\.views desc limit \$\d+ \{ __tpk: p\.id,/);
  });
});

// ---------------------------------------------------------------------------
// F2: alias-qualified where (parent qualified `p`, relation qualified `c`)
// ---------------------------------------------------------------------------

describe('powdb F2: alias-qualified where', () => {
  it('qualifies the parent where with `p` and the relation where with `c` (incl. a JSON path)', async () => {
    const mock = mockPool();
    await qi(mock).findMany({
      where: { age: { gt: 18 } },
      with: { posts: { where: { data: { path: ['k'], equals: 'v' } } } },
      relationLoadStrategy: 'join',
    });
    const call = mock.joinCall()!;
    // Parent scalar filter, alias-qualified with p.
    assert.match(call.powql, /filter p\.age > \$\d+/);
    // Relation JSON-path filter, alias-qualified with c (path segment + value bound).
    assert.match(call.powql, /and c\.data->\$\d+ = \$\d+/);
    // Every value is a bound $N param — no inlined literals.
    assert.deepEqual(call.params, [18, 'k', 'v']);
  });

  it('a reserved-word relation target column is backtick-quoted when alias-qualified', async () => {
    // `order` is a PowQL keyword; a qualified `c.order` must become c.`order`.
    const kwSchema: SchemaMetadata = {
      enums: {},
      tables: {
        app_user: table('app_user', [col('id', 'id', 'string', 'text', { hasDefault: true })], {
          items: {
            type: 'hasMany',
            name: 'items',
            from: 'app_user',
            to: 'item',
            foreignKey: 'user_id',
            referenceKey: 'id',
          },
        }),
        item: table('item', [
          col('id', 'id', 'string', 'text', { hasDefault: true }),
          col('user_id', 'userId', 'string', 'text'),
          col('order', 'order', 'number', 'int4', { nullable: true }),
        ]),
      },
    };
    const mock = mockPool();
    const iface = new PowqlInterface(mock.pool, 'app_user', kwSchema, [], { warnOnUnlimited: false });
    await iface.findMany({ with: { items: true }, relationLoadStrategy: 'join' });
    assert.equal(
      mock.joinCall()!.powql,
      'item as c join app_user as p on c.user_id = p.id { __tpk: p.id, id: c.id, user_id: c.user_id, `order`: c.`order` }',
    );
  });
});

// ---------------------------------------------------------------------------
// F2: eligibility fallbacks (silent → loader) + capability gate (throw)
// ---------------------------------------------------------------------------

describe('powdb F2: eligibility', () => {
  it('a parent limit falls back to the keyed loader (no join emitted)', async () => {
    const mock = mockPool();
    await qi(mock).findMany({ limit: 10, with: { posts: true }, relationLoadStrategy: 'join' });
    assert.equal(mock.joinCall(), undefined);
    assert.ok(mock.calls.some((c) => /post filter .*\bin \(/.test(c.powql)));
  });

  it('a parent offset falls back to the keyed loader', async () => {
    const mock = mockPool();
    await qi(mock).findMany({ offset: 5, with: { posts: true }, relationLoadStrategy: 'join' });
    assert.equal(mock.joinCall(), undefined);
  });

  it('a nested `with` inside the relation stays on the loader', async () => {
    const mock = mockPool();
    await qi(mock).findMany({ with: { posts: { with: { author: true } } }, relationLoadStrategy: 'join' });
    assert.equal(mock.joinCall(), undefined);
  });

  it('the default (batched) strategy never joins', async () => {
    const mock = mockPool();
    await qi(mock).findMany({ with: { posts: true } });
    assert.equal(mock.joinCall(), undefined);
  });

  it('explicit per-query join on a serverJoins-false engine throws E017', async () => {
    const caps = capabilitiesFromVersion('0.12.0'); // serverJoins gated at 0.13
    assert.equal(caps.serverJoins, false);
    const mock = mockPool({ capabilities: caps });
    await assert.rejects(
      () => qi(mock).findMany({ with: { posts: true }, relationLoadStrategy: 'join' }),
      UnsupportedFeatureError,
    );
  });

  it('a client-level join default on a serverJoins-false engine silently falls back to the loader', async () => {
    const caps = capabilitiesFromVersion('0.12.0');
    const mock = mockPool({ capabilities: caps });
    // No per-query strategy — the client default is 'join', engine can't → loader.
    await qiClientJoin(mock).findMany({ with: { posts: true } });
    assert.equal(mock.joinCall(), undefined);
    assert.ok(mock.calls.some((c) => /post filter .*\bin \(/.test(c.powql)));
  });

  it('a `__tpk` column on the relation target throws ValidationError', async () => {
    const mock = mockPool();
    await assert.rejects(
      () => qi(mock).findMany({ with: { bad: true }, relationLoadStrategy: 'join' }),
      (err: unknown) => err instanceof ValidationError && /__tpk/.test((err as Error).message),
    );
  });
});

// ---------------------------------------------------------------------------
// F4: explain()
// ---------------------------------------------------------------------------

describe('powdb F4: explain', () => {
  it('prefixes `explain ` on the compiled findMany PowQL and returns the plan lines', async () => {
    const mock = mockPool({ rows: [{ plan: 'Project fields=[…]' }, { plan: '  IndexScan table=app_user' }] });
    const lines = await qi(mock).explain({ where: { age: { gt: 21 } }, limit: 5 });
    const call = mock.last();
    assert.ok(call.powql.startsWith('explain app_user filter .age > $'));
    assert.deepEqual(call.params, [21, 5]);
    assert.deepEqual(lines, ['Project fields=[…]', '  IndexScan table=app_user']);
  });

  it('drops empty plan lines', async () => {
    const mock = mockPool({ rows: [{ plan: 'SeqScan table=app_user' }, { plan: '' }] });
    const lines = await qi(mock).explain({});
    assert.deepEqual(lines, ['SeqScan table=app_user']);
  });
});

// ---------------------------------------------------------------------------
// Readonly exec-seam guard (E018)
// ---------------------------------------------------------------------------

describe('powdb: read-only guard', () => {
  it('a write refuses with E018 before any pool call', async () => {
    const mock = mockPool({ readonly: true });
    await assert.rejects(() => qi(mock).create({ data: { name: 'x' } }), ReadOnlyError);
    assert.equal(mock.calls.length, 0, 'no PowQL should reach the pool');
  });

  it('every mutation verb refuses on a read-only pool', async () => {
    for (const run of [
      () => qi(mockPool({ readonly: true })).createMany({ data: [{ name: 'a' }] }),
      () => qi(mockPool({ readonly: true })).update({ where: { id: '1' }, data: { name: 'b' } }),
      () => qi(mockPool({ readonly: true })).updateMany({ where: { id: '1' }, data: { name: 'b' } }),
      () => qi(mockPool({ readonly: true })).delete({ where: { id: '1' } }),
      () => qi(mockPool({ readonly: true })).deleteMany({ where: { id: '1' } }),
      () =>
        qi(mockPool({ readonly: true })).upsert({
          where: { id: '1' },
          create: { id: '1', name: 'a' },
          update: { name: 'b' },
        }),
    ]) {
      await assert.rejects(run, ReadOnlyError);
    }
  });

  it('a read passes through on a read-only pool', async () => {
    const mock = mockPool({ readonly: true });
    await qi(mock).findMany({ limit: 1 });
    assert.equal(mock.calls.length, 1);
  });

  it('a transaction-control begin (nested write) refuses with E018 before connect()', async () => {
    const mock = mockPool({ readonly: true });
    await assert.rejects(
      () => qi(mock).create({ data: { name: 'x', posts: { create: [{ title: 't' }] } } }),
      ReadOnlyError,
    );
    assert.equal(mock.connects(), 0, 'connect() must not be reached');
    assert.equal(mock.calls.length, 0);
  });
});
