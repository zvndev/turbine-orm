import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { postgresDialect } from '../dialect.js';
import type { PgCompatPool } from '../pg-types.js';
import { PowqlInterface } from '../powql.js';
import { QueryInterface } from '../query/builder.js';
import { tupleCursorFingerprint } from '../query/cursor-tuple.js';
import { CURSOR_INCLUSIVE } from '../query/normalize-args.js';
import type { FindManyArgs } from '../query/types.js';
import type { SchemaMetadata } from '../schema.js';
import { makeQuery, mockTable } from './helpers.js';

type Args = FindManyArgs<Record<string, unknown>>;
function schema(): SchemaMetadata {
  return {
    tables: {
      items: mockTable(
        'items',
        [
          { name: 'id', field: 'id' },
          { name: 'sort_key', field: 'sortKey', pgType: 'int4' },
          { name: 'tenant_id', field: 'tenantId', pgType: 'int4' },
        ],
        {
          children: {
            name: 'children',
            type: 'hasMany',
            from: 'items',
            to: 'children',
            foreignKey: 'item_id',
            referenceKey: 'id',
          },
        },
      ),
      children: mockTable('children', [
        { name: 'id', field: 'id' },
        { name: 'item_id', field: 'itemId' },
      ]),
    },
    enums: {},
  };
}
function page(extra: Record<string, unknown> = {}): Args {
  return {
    cursorPredicate: 'tuple',
    cursor: { sortKey: 10, id: 20 },
    orderBy: { sortKey: 'asc' },
    limit: 3,
    ...extra,
  } as Args;
}
const code = (expected: string) => (error: unknown) => {
  assert.equal((error as { code: string }).code, `TURBINE_${expected}`);
  return true;
};

describe('explicit tuple cursors', () => {
  it('preserves the default SQL, binds, prepared name, transform and cache entry', () => {
    const q = makeQuery('items', schema(), { preparedStatements: true });
    const args = { ...page({ where: { tenantId: 7 } }), cursorPredicate: undefined };
    const a = q.buildFindMany(args);
    const b = q.buildFindMany({ ...args, cursorPredicate: 'lexicographic' });
    assert.equal(
      a.sql,
      'SELECT "items".* FROM "items" WHERE "tenant_id" = $1 AND ("items"."sort_key" > $2 OR ("items"."sort_key" = $2 AND "items"."id" > $3)) ORDER BY "sort_key" ASC, "id" ASC LIMIT $4',
    );
    assert.deepEqual(a.params, [7, 10, 20, 3]);
    assert.equal(a.preparedName, 't_01068f8c017eaee7');
    assert.equal(b.sql, a.sql);
    assert.deepEqual(b.params, a.params);
    assert.equal(b.preparedName, a.preparedName);
    const result = { rows: [{ id: 21, sort_key: 10, tenant_id: 7 }], rowCount: 1 };
    assert.equal(JSON.stringify(a.transform(result)), '[{"id":21,"sortKey":10,"tenantId":7}]');
    assert.deepEqual(b.transform(result), a.transform(result));
    assert.deepEqual(q.cacheStats(), { hits: 1, misses: 1, hitRate: 0.5, size: 1 });
  });

  it('compares the entire effective mapped order with binds after WHERE', () => {
    const q = makeQuery('items', schema());
    const d = q.buildFindMany(page({ where: { tenantId: 7 } }));
    assert.equal(
      d.sql,
      'SELECT "items".* FROM "items" WHERE "tenant_id" = $1 AND ("items"."sort_key", "items"."id") > ($2, $3) ORDER BY "sort_key" ASC, "id" ASC LIMIT $4',
    );
    assert.deepEqual(d.params, [7, 10, 20, 3]);
    const desc = q.buildFindMany(page({ orderBy: { sortKey: 'desc' } }));
    assert.match(desc.sql, /\("items"\."sort_key", "items"\."id"\) < \(\$1, \$2\)/);
    assert.match(desc.sql, /ORDER BY "sort_key" DESC, "id" DESC/);
  });

  it('keeps tuple and lexicographic entries separate and recollects warm values', () => {
    const q = makeQuery('items', schema(), {
      preparedStatements: true,
      diagnostics: { mode: 'production', cacheCheck: 'off', advice: false },
    });
    const a = q.buildFindMany(page());
    const b = q.buildFindMany(page({ cursor: { id: 31, sortKey: 11 }, limit: 5 }));
    const c = q.buildFindMany({ ...page(), cursorPredicate: 'lexicographic' });
    const d = q.buildFindMany(page({ orderBy: { sortKey: 'desc' } }));
    assert.equal(b.sql, a.sql);
    assert.equal(b.preparedName, a.preparedName);
    assert.deepEqual(b.params, [11, 31, 5]);
    assert.notEqual(c.sql, a.sql);
    assert.notEqual(c.preparedName, a.preparedName);
    assert.notEqual(d.preparedName, a.preparedName);
    assert.equal(q.cacheStats().hits, 1);
    assert.equal(q.cacheStats().misses, 3);
    assert.throws(() => q.buildFindMany(page({ cursor: { id: 31 } })), code('E003'));
    assert.equal(q.cacheStats().hits, 1, 'a warm shape cannot bypass eligibility');
  });

  it('supports composite PK and unique suffixes including appended tie-breakers', () => {
    const s = schema();
    s.tables.items = mockTable(
      'items',
      [
        { name: 'org_id', field: 'orgId' },
        { name: 'seq', field: 'seq' },
        { name: 'score', field: 'score' },
      ],
      {},
      ['org_id', 'seq'],
    );
    const d = makeQuery('items', s).buildFindMany(
      page({ cursor: { score: 3, orgId: 4, seq: 5 }, orderBy: { score: 'asc' } }),
    );
    assert.match(d.sql, /\("items"\."score", "items"\."org_id", "items"\."seq"\) > \(\$1, \$2, \$3\)/);
    assert.deepEqual(d.params, [3, 4, 5, 3]);
    s.tables.items.primaryKey = [];
    s.tables.items.uniqueColumns = [['org_id', 'seq']];
    assert.equal(
      makeQuery('items', s).buildFindMany(page({ cursor: { score: 3, orgId: 4, seq: 5 }, orderBy: { score: 'asc' } }))
        .sql,
      d.sql,
    );
  });

  it('preserves relation selections, global filters and cache-hit parameter order', () => {
    const q = makeQuery('items', schema(), { globalFilters: { items: { tenantId: 7 }, children: { id: { gt: 2 } } } });
    const args = page({
      where: { id: { gt: 1 } },
      with: { children: { where: { id: { lt: 99 } }, limit: 2 } },
      jsonEncoding: 'object',
    });
    const a = q.buildFindMany(args);
    const b = q.buildFindMany(page({ ...args, cursor: { id: 30, sortKey: 12 } }));
    assert.equal(b.sql, a.sql);
    assert.deepEqual(a.params, [1, 7, 99, 2, 2, 10, 20, 3]);
    const tupleIndex = a.params.indexOf(10);
    assert.ok(tupleIndex > 0);
    assert.deepEqual(a.params.slice(tupleIndex), [10, 20, 3]);
    assert.ok(a.params.slice(0, tupleIndex).includes(7));
    assert.ok(a.params.slice(0, tupleIndex).includes(99));
    assert.ok(a.params.slice(0, tupleIndex).includes(2));
    assert.deepEqual(b.params.slice(tupleIndex), [12, 30, 3]);
    const lex = q.buildFindMany({ ...args, cursorPredicate: 'lexicographic' });
    const result = { rows: [{ id: 21, sort_key: 10, tenant_id: 7, children: [{ id: 3, item_id: 21 }] }], rowCount: 1 };
    assert.equal(JSON.stringify(a.transform(result)), JSON.stringify(lex.transform(result)));
  });

  for (const [name, extra, expected] of [
    ['missing cursor', { cursor: undefined }, 'E003'],
    ['empty cursor', { cursor: {} }, 'E003'],
    ['null cursor', { cursor: null }, 'E003'],
    ['all undefined', { cursor: { id: undefined } }, 'E003'],
    ['missing appended PK', { cursor: { sortKey: 1 } }, 'E003'],
    ['row lookup', { cursor: { id: 1 } }, 'E003'],
    ['null NOT NULL', { cursor: { id: null, sortKey: 1 } }, 'E003'],
    ['invalid mode', { cursorPredicate: 'auto' }, 'E003'],
    ['invalid number', { cursor: { sortKey: NaN, id: 1 } }, 'E003'],
    ['invalid date', { cursor: { sortKey: new Date(NaN), id: 1 } }, 'E003'],
    ['invalid direction', { orderBy: { sortKey: 'sideways' } }, 'E003'],
    ['invalid order shape', { orderBy: [null] }, 'E003'],
    ['invalid nulls', { orderBy: { sortKey: { sort: 'asc', nulls: 'smallest' } } }, 'E003'],
    ['operator cursor', { cursor: { id: 1, sortKey: { gt: 2 } } }, 'E003'],
    ['mixed directions', { orderBy: [{ sortKey: 'asc' }, { id: 'desc' }] }, 'E017'],
    ['collation', { orderBy: { sortKey: { sort: 'asc', collation: 'C' } } }, 'E017'],
    ['JSON expression', { orderBy: { sortKey: { path: ['x'], sort: 'asc' } } }, 'E017'],
    ['offset', { offset: 0 }, 'E017'],
    ['skip alias', { skip: 1 }, 'E017'],
    ['distinct', { distinct: ['id'] }, 'E017'],
    ['unique prefix', { orderBy: [{ id: 'asc' }, { sortKey: 'asc' }] }, 'E017'],
    ['inclusive', { [CURSOR_INCLUSIVE]: true }, 'E017'],
  ] as const) {
    it(`refuses ${name} on build and execute before any pool use`, async () => {
      let accesses = 0;
      const pool = {
        query: () => {
          accesses++;
          throw new Error('unexpected query');
        },
        connect: () => {
          accesses++;
          throw new Error('unexpected checkout');
        },
      } as unknown as PgCompatPool;
      const q = new QueryInterface<Record<string, unknown>>(pool, 'items', schema());
      assert.throws(() => q.buildFindMany(page(extra)), code(expected));
      await assert.rejects(q.findMany(page(extra)), code(expected));
      assert.equal(accesses, 0);
    });
  }

  for (const kind of [
    'nullable',
    'unknown nullability',
    'unsupported type',
    'unknown column metadata',
    'partial unique',
  ] as const) {
    it(`refuses ${kind} metadata without inferring a WHERE proof`, () => {
      const s = schema();
      const table = s.tables.items!;
      if (kind === 'nullable') table.columns[1]!.nullable = true;
      if (kind === 'unknown nullability')
        delete (table.columns[1] as Partial<(typeof table.columns)[number]>)!.nullable;
      if (kind === 'unsupported type') table.columns[1]!.pgType = 'jsonb';
      if (kind === 'unknown column metadata') table.columns = table.columns.filter((c) => c.name !== 'sort_key');
      if (kind === 'partial unique') {
        table.primaryKey = [];
        table.uniqueColumns = [];
        table.indexes = [
          {
            name: 'partial',
            columns: ['id'],
            unique: true,
            partial: true,
            definition: 'CREATE UNIQUE INDEX partial ON items(id) WHERE id > 0',
          },
        ];
      }
      assert.throws(
        () => makeQuery('items', s).buildFindMany(page({ where: { sortKey: { not: null } } })),
        code('E017'),
      );
    });
  }

  it('refuses nullable NULL values and unknown type provenance', () => {
    const s = schema();
    s.tables.items!.columns[1]!.nullable = true;
    assert.throws(() => makeQuery('items', s).buildFindMany(page({ cursor: { sortKey: null, id: 1 } })), code('E017'));
    s.tables.items!.columns[1]!.nullable = false;
    s.tables.items!.columns[1]!.pgTypeSchema = 'custom';
    assert.throws(() => makeQuery('items', s).buildFindMany(page()), code('E017'));
  });

  it('uses capabilities under a renamed PG dialect and refuses an omitted capability', () => {
    const renamed = { ...postgresDialect, name: 'compatible' };
    assert.match(makeQuery('items', schema(), { dialect: renamed }).buildFindMany(page()).sql, /\) > \(/);
    const { tupleCursorPredicate: _cap, ...capabilities } = postgresDialect.capabilities;
    const custom = { ...renamed, capabilities };
    assert.throws(() => makeQuery('items', schema(), { dialect: custom }).buildFindMany(page()), code('E017'));
    assert.doesNotThrow(() =>
      makeQuery('items', schema(), { dialect: custom }).buildFindMany({ ...page(), cursorPredicate: 'lexicographic' }),
    );
  });

  it('refuses nested options across join, batched, auto and flatten before checkout', async () => {
    const q = makeQuery('items', schema());
    for (const relationLoadStrategy of ['join', 'batched', 'auto', 'flatten'] as const) {
      await assert.rejects(
        q.findMany(page({ relationLoadStrategy, with: { children: { cursorPredicate: 'tuple', cursor: { id: 1 } } } })),
        code('E017'),
      );
    }
  });

  it('streams and findFirst share the validated canonical build', async () => {
    let accesses = 0;
    const pool = {
      query: () => {
        accesses++;
        throw new Error('unexpected query');
      },
      connect: () => {
        accesses++;
        throw new Error('unexpected checkout');
      },
    } as unknown as PgCompatPool;
    const q = new QueryInterface<Record<string, unknown>>(pool, 'items', schema());
    await assert.rejects(
      q
        .findManyStream(page({ cursor: { sortKey: 1 } }))
        [Symbol.asyncIterator]()
        .next(),
      code('E003'),
    );
    await assert.rejects(
      q
        .findManyStreamBatches(page({ cursor: { sortKey: 1 } }))
        [Symbol.asyncIterator]()
        .next(),
      code('E003'),
    );
    await assert.rejects(q.findFirst(page({ cursor: { sortKey: 1 } })), code('E003'));
    assert.equal(accesses, 0);
  });

  it('PowQL refuses tuple instead of silently ignoring the additive option', async () => {
    const q = new PowqlInterface(null as unknown as ConstructorParameters<typeof PowqlInterface>[0], 'items', schema());
    await assert.rejects(q.findMany(page()), code('E017'));
    await assert.rejects(q.findFirst(page()), code('E017'));
  });
});

describe('tuple cursor dense shape validation', () => {
  it('refuses declared enums whose names overlap builtin scalar tokens', () => {
    const s = schema();
    s.tables.items!.columns[1]!.pgType = 'text';
    s.tables.items!.pgTypes.sort_key = 'text';
    s.enums.text = ['z', 'a', 'm'];
    const q = makeQuery('items', s);
    const args = page({ cursor: { sortKey: 'a', id: 2 } });
    assert.doesNotThrow(() => q.buildFindMany({ ...args, cursorPredicate: 'lexicographic' }));
    assert.throws(() => q.buildFindMany(args), code('E017'));
  });

  for (const definition of [
    'CREATE UNIQUE INDEX unsafe ON items(sort_key, lower(tenant_id::text))',
    'CREATE UNIQUE INDEX unsafe ON items(sort_key COLLATE "C")',
  ]) {
    it(`does not use unverified index-only metadata as a tuple proof: ${definition}`, () => {
      const s = schema();
      const meta = s.tables.items!;
      meta.primaryKey = [];
      meta.uniqueColumns = [];
      meta.indexes = [{ name: 'unsafe', columns: ['sort_key'], unique: true, definition }];
      const args = page({ cursor: { sortKey: 1 }, orderBy: { sortKey: 'asc' } });
      const q = makeQuery('items', s);
      assert.doesNotThrow(() => q.buildFindMany({ ...args, cursorPredicate: 'lexicographic' }));
      assert.throws(() => q.buildFindMany(args), code('E017'));
    });
  }

  for (const kind of [
    'primary hole',
    'primary inherited',
    'primary type',
    'unique outer hole',
    'unique suffix hole',
    'unique suffix type',
    'columns hole',
    'indexes hole',
    'index columns hole',
  ] as const) {
    it(`refuses ${kind} metadata before key planning or pool access`, async () => {
      const s = schema(),
        meta = s.tables.items!;
      if (kind === 'primary hole') meta.primaryKey = Array(1);
      if (kind === 'primary inherited') {
        meta.primaryKey = Array(1);
        Object.setPrototypeOf(meta.primaryKey, Object.assign(Object.create(Array.prototype), { 0: 'id' }));
      }
      if (kind === 'primary type') meta.primaryKey = [null as unknown as string];
      if (kind === 'unique outer hole') meta.uniqueColumns = Array(1);
      if (kind === 'unique suffix hole') meta.uniqueColumns = [Array(1)];
      if (kind === 'unique suffix type') meta.uniqueColumns = [[3 as unknown as string]];
      if (kind === 'indexes hole') meta.indexes = Array(1);
      if (kind === 'index columns hole')
        meta.indexes = [{ name: 'bad', columns: Array(1), unique: true, definition: '' }];
      let accesses = 0;
      const pool = {
        query: () => {
          accesses++;
          throw Error('query');
        },
        connect: () => {
          accesses++;
          throw Error('checkout');
        },
      } as unknown as PgCompatPool;
      const q = new QueryInterface<Record<string, unknown>>(pool, 'items', s);
      if (kind === 'columns hole') delete meta.columns[0];
      assert.throws(() => q.buildFindMany(page()), code('E017'));
      await assert.rejects(q.findMany(page()), code('E017'));
      assert.equal(accesses, 0);
    });
  }
  it('refuses sparse and inherited order slots before normalization can drop them', () => {
    const orderBy = Array(1);
    const q = makeQuery('items', schema());
    assert.throws(() => q.buildFindMany(page({ orderBy })), code('E003'));
    Object.setPrototypeOf(orderBy, Object.assign(Object.create(Array.prototype), { 0: { sortKey: 'asc' } }));
    assert.throws(() => q.buildFindMany(page({ orderBy })), code('E003'));
  });
  it('refuses sparse canonical terms and unique suffixes without incidental TypeErrors', () => {
    const meta = schema().tables.items!;
    assert.throws(() => tupleCursorFingerprint(meta, Array(1), new Map(), {}, false), code('E017'));
    meta.uniqueColumns = [Array(1)];
    assert.throws(
      () => tupleCursorFingerprint(meta, [{ column: 'id', desc: false }], new Map([['id', 1]]), {}, false),
      code('E017'),
    );
  });
});

describe('tuple builtin scalar type boundary', () => {
  const supported = [
    'int2',
    'int4',
    'int8',
    'smallint',
    'integer',
    'bigint',
    'serial',
    'bigserial',
    'float4',
    'float8',
    'real',
    'double precision',
    'numeric',
    'decimal',
    'text',
    'varchar',
    'character varying',
    'char',
    'bpchar',
    'character',
    'uuid',
    'bool',
    'boolean',
    'date',
    'timestamp',
    'timestamptz',
    'timestamp without time zone',
    'timestamp with time zone',
  ];
  it('accepts exactly the declared builtin domains, including case variants', () => {
    assert.equal(supported.length, 28);
    for (const type of supported.flatMap((t) => [t, t.toUpperCase()])) {
      const meta = schema().tables.items!;
      meta.columns[0]!.pgType = type;
      assert.match(
        tupleCursorFingerprint(meta, [{ column: 'id', desc: false }], new Map([['id', 1]]), {}, false),
        /^tuple:/,
      );
    }
  });
  it('refuses custom, structured and near-match type tokens including line terminators', () => {
    for (const type of [
      'int',
      'int3',
      'float',
      'json',
      'jsonb',
      '_int4',
      'citext',
      'custom',
      'timestampz',
      'timestamp with time zone extra',
      ' text',
      'text ',
      'text\n',
      'text\r',
      'text\r\n',
      'text\u2028',
      'text\u2029',
    ]) {
      const meta = schema().tables.items!;
      meta.columns[0]!.pgType = type;
      assert.throws(
        () => tupleCursorFingerprint(meta, [{ column: 'id', desc: false }], new Map([['id', 1]]), {}, false),
        code('E017'),
        type,
      );
    }
  });
});
