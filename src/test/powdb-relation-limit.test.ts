/**
 * turbine-orm, PowDB keyed loaders: a relation `limit` / `offset` is a PER-PARENT bound
 *
 * `with: { posts: { limit: 2 } }` means "at most two posts on EACH parent". The
 * keyed loader used to spread the relation options straight into the flat child
 * fetch, so the emitted PowQL was `post filter .author_id in (...) limit 2`: two
 * posts shared across every parent in the chunk, most parents left with none,
 * no error. It shipped for the loader's whole life because the one test of the
 * shape compared the join path against the loader path, and both were wrong the
 * same way. Found by the cross-engine benchmark, where the wrong answer was the
 * fast one.
 *
 * The SQL engines' batched loader has always done this right (fetch the children
 * with `where` + `orderBy` only, slice per parent client-side), so these tests
 * pin the PowDB loader to the same rule at the STATEMENT level, with a mock pool
 * that honours `limit` the way the engine would. That last part matters: a mock
 * that returned every row regardless would make the per-parent assertions pass
 * against the very bug they exist to catch.
 *
 * Run: npx tsx --test src/test/powdb-relation-limit.test.ts
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ALL_POWDB_CAPABILITIES, type PowdbPool } from '../powdb.js';
import { PowqlInterface } from '../powql.js';
import type { ColumnMetadata, RelationDef, SchemaMetadata, TableMetadata } from '../schema.js';

function col(name: string, field: string, tsType: string, pgType: string): ColumnMetadata {
  return { name, field, pgType, tsType, nullable: false, hasDefault: false, isArray: false, pgArrayType: '' };
}

function table(name: string, columns: ColumnMetadata[], relations: Record<string, RelationDef> = {}): TableMetadata {
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
    dateColumns: new Set<string>(),
    pgTypes: Object.fromEntries(columns.map((c) => [c.name, c.pgType])),
    allColumns: columns.map((c) => c.name),
    primaryKey: ['id'],
    uniqueColumns: [['id']],
    relations,
    indexes: [],
  };
}

const schema: SchemaMetadata = {
  enums: {},
  tables: {
    app_user: table('app_user', [col('id', 'id', 'string', 'text'), col('name', 'name', 'string', 'text')], {
      posts: {
        type: 'hasMany',
        name: 'posts',
        from: 'app_user',
        to: 'post',
        foreignKey: 'author_id',
        referenceKey: 'id',
      },
    }),
    post: table('post', [
      col('id', 'id', 'string', 'text'),
      col('author_id', 'authorId', 'string', 'text'),
      col('title', 'title', 'string', 'text'),
      col('views', 'views', 'number', 'int4'),
    ]),
  },
};

const PARENTS = [
  { id: 'u1', name: 'A' },
  { id: 'u2', name: 'B' },
];
// Every child of every parent, already in the relation's `views desc` order the
// way the engine would return the flat fetch: the two parents' posts interleave.
const CHILDREN = [
  { id: 'p3', author_id: 'u1', title: 'a3', views: 30 },
  { id: 'p6', author_id: 'u2', title: 'b3', views: 25 },
  { id: 'p2', author_id: 'u1', title: 'a2', views: 20 },
  { id: 'p5', author_id: 'u2', title: 'b2', views: 15 },
  { id: 'p1', author_id: 'u1', title: 'a1', views: 10 },
  { id: 'p4', author_id: 'u2', title: 'b1', views: 5 },
];

/**
 * A mock pool that answers the parent statement with PARENTS and the child
 * statement with CHILDREN, HONOURING any `limit $n` / `offset $n` the statement
 * carries, exactly as the engine would. So a global limit on the child fetch
 * produces the wrong per-parent answer here as it does live.
 */
function mockPool() {
  const calls: { powql: string; params: unknown[] }[] = [];
  const pool = {
    capabilities: ALL_POWDB_CAPABILITIES,
    retryStaleReads: false,
    query(powql: string, params: unknown[]) {
      calls.push({ powql, params });
      let rows: Record<string, unknown>[] = powql.startsWith('post') ? [...CHILDREN] : [...PARENTS];
      const off = / offset \$(\d+)/.exec(powql);
      if (off) rows = rows.slice(Number(params[Number(off[1]) - 1]));
      const lim = / limit \$(\d+)/.exec(powql);
      if (lim) rows = rows.slice(0, Number(params[Number(lim[1]) - 1]));
      return Promise.resolve({ rows, rowCount: rows.length });
    },
  } as unknown as PowdbPool;
  return { pool, calls, child: () => calls.find((c) => c.powql.startsWith('post')) };
}

type Row = { id: string; name: string; posts: { title: string }[] };
const titles = (rows: Row[]) => rows.map((r) => `${r.id}:${r.posts.map((p) => p.title).join(',')}`);

describe('powdb keyed loader: relation limit / offset are per parent', () => {
  it('the child fetch carries the relation orderBy but NO limit and NO offset', async () => {
    const m = mockPool();
    const qi = new PowqlInterface(m.pool, 'app_user', schema, [], { warnOnUnlimited: false });
    // `offset` is not on the public WithOptions type (only `limit` is); the PowDB
    // paths accept it untyped, so the probe passes it through a cast on purpose.
    await qi.findMany({
      with: { posts: { orderBy: { views: 'desc' }, limit: 2, offset: 1 } as never },
      relationLoadStrategy: 'batched',
    });
    const child = m.child();
    assert.ok(child, 'a child fetch was issued');
    assert.match(child.powql, /^post filter \.author_id in \(/, 'flat keyed fetch');
    assert.match(child.powql, / order \.views desc/, 'the relation orderBy still shapes which rows the slice keeps');
    assert.doesNotMatch(child.powql, / limit /, 'a global limit on the flat fetch caps the TOTAL, not each parent');
    assert.doesNotMatch(child.powql, / offset /, "a global offset skips OTHER parents' children");
  });

  it('each parent gets its own top-N under the relation orderBy', async () => {
    const m = mockPool();
    const qi = new PowqlInterface(m.pool, 'app_user', schema, [], { warnOnUnlimited: false });
    const rows = (await qi.findMany({
      with: { posts: { orderBy: { views: 'desc' }, limit: 2 } },
      relationLoadStrategy: 'batched',
    })) as Row[];
    assert.deepEqual(titles(rows), ['u1:a3,a2', 'u2:b3,b2']);
  });

  it("offset walks each parent's own list", async () => {
    const m = mockPool();
    const qi = new PowqlInterface(m.pool, 'app_user', schema, [], { warnOnUnlimited: false });
    const rows = (await qi.findMany({
      with: { posts: { orderBy: { views: 'desc' }, limit: 1, offset: 1 } as never },
      relationLoadStrategy: 'batched',
    })) as Row[];
    assert.deepEqual(titles(rows), ['u1:a2', 'u2:b2']);
    const tail = (await qi.findMany({
      with: { posts: { orderBy: { views: 'desc' }, offset: 2 } as never },
      relationLoadStrategy: 'batched',
    })) as Row[];
    assert.deepEqual(titles(tail), ['u1:a1', 'u2:b1'], 'offset without limit');
  });

  it('limit 0 is an empty list on every parent and issues no child fetch at all', async () => {
    const m = mockPool();
    const qi = new PowqlInterface(m.pool, 'app_user', schema, [], { warnOnUnlimited: false });
    const rows = (await qi.findMany({ with: { posts: { limit: 0 } }, relationLoadStrategy: 'batched' })) as Row[];
    assert.deepEqual(titles(rows), ['u1:', 'u2:']);
    assert.equal(m.child(), undefined, 'nothing to fetch when the answer is [] by construction');
  });

  it('the child fetch does not inherit the client defaultLimit and does not warn as unlimited', async () => {
    // A client-level `defaultLimit` bounds the PARENT page; applied to the flat
    // child fetch it silently caps the children of the whole page at that
    // number, the same wrong answer by another route. The SQL batched loader
    // clears it for its child queries (`batchedChildOptions`); so does this one.
    const m = mockPool();
    const warned: string[] = [];
    const origWarn = console.warn;
    console.warn = (msg: string) => {
      warned.push(String(msg));
    };
    try {
      const qi = new PowqlInterface(m.pool, 'app_user', schema, [], { defaultLimit: 1, warnOnUnlimited: true });
      const rows = (await qi.findMany({ with: { posts: true }, relationLoadStrategy: 'batched' })) as Row[];
      const child = m.child();
      assert.ok(child, 'a child fetch was issued');
      assert.doesNotMatch(child.powql, / limit /, 'defaultLimit must not reach the child fetch');
      // The parent page IS bounded by defaultLimit (one parent), and that one
      // parent has every child, not `defaultLimit` of them.
      assert.deepEqual(titles(rows), ['u1:a3,a2,a1']);
      assert.deepEqual(warned, [], "an unbounded child fetch is the loader's design, not a scan to warn about");
    } finally {
      console.warn = origWarn;
    }
  });
});
