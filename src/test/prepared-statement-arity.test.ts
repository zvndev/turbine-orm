/**
 * turbine-orm: variable-arity shapes never take a named prepared statement
 *
 * Every distinct SQL text Turbine emits is parsed on the server as a NAMED
 * prepared statement (the name is a hash of the text) and is never DEALLOCATEd.
 * The client-side template cache is an LRU bounded at 1,000 entries; the SERVER
 * side has no bound, and each pooled connection accumulates its own. Measured
 * against a live PostgreSQL 16 before the fix:
 *
 *   before                       prepared=  0   CachedPlan MB = 0.0
 *   after 600 distinct arities   prepared=600   CachedPlan MB = 20.9
 *   after 200 reuses of one      prepared=600   CachedPlan MB = 20.9  (nothing reclaimed)
 *
 * That needs no identifier and no value from the caller, only the ability to
 * vary the ARITY of a boolean combinator: one branch of a `where.OR` per item
 * of a UI multi-select is one extra parenthesized condition in the SQL text,
 * hence one more permanent server-side statement per distinct length.
 *
 * The fix sends those shapes UNNAMED (an empty `preparedName`, which
 * `queryWithTimeout` reads as "use the plain text form"), the same mechanism the
 * per-query `forceCustomPlan` option uses. It changes no SQL text.
 *
 * These tests pin the four things that must stay true:
 *   1. a combinator array (at any depth, in a where or a having) is unnamed,
 *   2. everything else, including a long `in` list, keeps its name,
 *   3. the decision survives the SQL cache (a warmed entry cannot regain a name),
 *   4. Turbine's OWN synthesized `AND` (the global-filter merge) is not counted,
 *      or every query on a table with a global filter would lose its name.
 *
 * ## The second channel: caller-controlled key ORDER
 *
 * Arity is one way to make the SQL text a function of the request, and the
 * arity rule closed only that one. The other is ORDER, which needs no array at
 * all: `select: { a, b }` and `select: { b, a }` are the same query and two
 * different statements. Measured on PostgreSQL 16, a SEVEN-column table, one
 * connection, with the arity fix already in place:
 *
 *   baseline                            prepared=    0   CachedPlanSource= 0.0 MB
 *   after 5040 select permutations      prepared= 5040   CachedPlanSource=39.4 MB
 *   after 300 varying-arity ORs         prepared= 5040   CachedPlanSource=39.4 MB
 *   after 5040 distinct permutations    prepared=10080   CachedPlanSource=59.1 MB
 *   720 reordered PATCH bodies (update) prepared=  720   CachedPlanSource= 2.8 MB
 *
 * The write row is the realistic one: `JSON.parse` preserves insertion order,
 * so `update({ where, data: JSON.parse(reqBody) })` hands a request body the
 * SET-clause column order. After the fix each of those rows is ONE statement.
 *
 * Two remedies, chosen per site by one question, is this order semantically
 * meaningful:
 *   - NO  (`select` / `omit` projections, write `data` column lists), the list
 *     is emitted in the TABLE's own column order, see `canonicalColumnOrder` /
 *     `canonicalWriteEntries` in query/utils.ts.
 *   - YES (`orderBy`, and `distinct`, whose list is re-emitted as the leading
 *     terms of an ORDER BY), the statement goes UNNAMED instead, which changes
 *     no SQL text and so cannot change which row a caller gets back.
 *
 * THE INVARIANT, pinned by the property test at the bottom of this file: for
 * any two query args that are semantically equivalent up to key order, Turbine
 * emits the same SQL text or an unnamed statement.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { QueryInterface } from '../query/index.js';
import type { SchemaMetadata } from '../schema.js';
import { makeQuery, mockTable } from './helpers.js';

function schema(): SchemaMetadata {
  return {
    enums: {},
    tables: {
      users: mockTable(
        'users',
        [
          { name: 'id', field: 'id' },
          { name: 'age', field: 'age', pgType: 'int4' },
          { name: 'name', field: 'name', pgType: 'text' },
          { name: 'tenant_id', field: 'tenantId' },
        ],
        {
          posts: {
            name: 'posts',
            type: 'hasMany',
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
    },
  };
}

/** The prepared-statement name a findMany would execute under. */
function nameFor(q: QueryInterface<Record<string, unknown>>, args: Record<string, unknown>): string | undefined {
  return q.buildFindMany(args as never).preparedName;
}

describe('prepared statements: caller-written combinator arrays go unnamed', () => {
  it('a fixed-shape where keeps a named statement', () => {
    const q = makeQuery('users', schema());
    const name = nameFor(q, { where: { age: 30 } });
    assert.ok(name && name.length > 0, `expected a prepared name, got ${JSON.stringify(name)}`);
    assert.match(name, /^t_[0-9a-f]{16}$/);
  });

  it('an OR array is unnamed at every arity, and the SQL still differs per arity', () => {
    const q = makeQuery('users', schema());
    const one = q.buildFindMany({ where: { OR: [{ age: 1 }] } } as never);
    const two = q.buildFindMany({ where: { OR: [{ age: 1 }, { age: 2 }] } } as never);
    const three = q.buildFindMany({ where: { OR: [{ age: 1 }, { age: 2 }, { age: 3 }] } } as never);

    // The premise: each arity is a DIFFERENT statement. That is exactly why an
    // unbounded arity is an unbounded number of server-side statements.
    assert.notEqual(one.sql, two.sql);
    assert.notEqual(two.sql, three.sql);

    for (const [arity, deferred] of [
      [1, one],
      [2, two],
      [3, three],
    ] as const) {
      assert.equal(deferred.preparedName, '', `OR arity ${arity} must not be named`);
    }
  });

  it('an AND array is unnamed too', () => {
    const q = makeQuery('users', schema());
    assert.equal(q.buildFindMany({ where: { AND: [{ age: 1 }, { name: 'a' }] } } as never).preparedName, '');
  });

  it('a combinator NESTED inside a relation filter is unnamed', () => {
    const q = makeQuery('users', schema());
    const deferred = q.buildFindMany({
      where: { posts: { some: { OR: [{ title: 'a' }, { title: 'b' }] } } },
    } as never);
    assert.equal(deferred.preparedName, '');
  });

  it('a combinator inside a relation `with` where is unnamed', () => {
    const q = makeQuery('users', schema());
    const deferred = q.buildFindMany({
      with: { posts: { where: { OR: [{ title: 'a' }, { title: 'b' }] } } },
    } as never);
    assert.equal(deferred.preparedName, '');
  });

  it('a long `in` list keeps its name (one bound array param, one shape)', () => {
    // The whole point of scoping this to combinators: `in` binds `= ANY($1)`,
    // so a 1-element and a 1000-element list are the SAME statement.
    const q = makeQuery('users', schema());
    const small = q.buildFindMany({ where: { age: { in: [1] } } } as never);
    const big = q.buildFindMany({
      where: { age: { in: Array.from({ length: 1000 }, (_, i) => i) } },
    } as never);
    assert.equal(small.sql, big.sql);
    assert.ok(small.preparedName && small.preparedName.length > 0);
    assert.equal(small.preparedName, big.preparedName);
  });

  it('NOT is not an array shape and keeps its name (its depth is capped instead)', () => {
    const q = makeQuery('users', schema());
    const name = nameFor(q, { where: { NOT: { age: 5 } } });
    assert.ok(name && name.length > 0);
  });

  it('the verdict survives the SQL cache: a warmed OR entry never regains a name', () => {
    const q = makeQuery('users', schema());
    const cold = q.buildFindMany({ where: { OR: [{ age: 1 }, { age: 2 }] } } as never);
    const warm = q.buildFindMany({ where: { OR: [{ age: 9 }, { age: 8 }] } } as never);
    assert.equal(cold.sql, warm.sql, 'same shape, different values: must be one cache entry');
    assert.equal(q.cacheStats().hits, 1, 'expected the second build to HIT the cache');
    assert.equal(warm.preparedName, '', 'a cache hit must reuse the unnamed entry');
  });

  it("Turbine's own global-filter AND wrapper does NOT unname the statement", () => {
    // The merge produces `{ AND: [userWhere, globalFilter] }`. Counting that as
    // caller-written arity would take EVERY query on a globally-filtered table
    // off named statements, i.e. penalise exactly the multi-tenant setups this
    // rule protects.
    const q = makeQuery('users', schema(), { globalFilters: { users: { tenantId: 7 } } });
    const name = nameFor(q, { where: { age: 30 } });
    assert.ok(name && name.length > 0, `global-filter merge must stay named, got ${JSON.stringify(name)}`);
    // ...and the filter really was merged in (otherwise this proves nothing).
    assert.match(q.buildFindMany({ where: { age: 30 } } as never).sql, /"tenant_id"/);
  });

  it('a global-filtered table with a caller OR is still unnamed', () => {
    const q = makeQuery('users', schema(), { globalFilters: { users: { tenantId: 7 } } });
    assert.equal(q.buildFindMany({ where: { OR: [{ age: 1 }, { age: 2 }] } } as never).preparedName, '');
  });

  it('groupBy carries no prepared name at all, so a having OR cannot accumulate statements', () => {
    // groupBy/aggregate assemble their SQL directly instead of going through
    // `acquireSql`, so they are outside the named-statement path entirely. This
    // pins that fact: the HAVING marking is defensive against a future rerouting,
    // and if groupBy ever gains a prepared name this assertion is what says so.
    const q = makeQuery('users', schema());
    const plain = q.buildGroupBy({ by: ['tenantId'], having: { _count: { gt: 1 } } } as never);
    assert.equal(plain.preparedName, undefined);

    const combinator = q.buildGroupBy({
      by: ['tenantId'],
      having: { OR: [{ _count: { gt: 1 } }, { age: { _min: { gt: 2 } } }] },
    } as never);
    assert.equal(combinator.preparedName, undefined);
  });

  it('count / aggregate honour the same rule', () => {
    const q = makeQuery('users', schema());
    assert.equal(q.buildCount({ where: { OR: [{ age: 1 }, { age: 2 }] } } as never).preparedName, '');
    const q2 = makeQuery('users', schema());
    assert.ok((q2.buildCount({ where: { age: 1 } } as never).preparedName ?? '').length > 0);
  });

  it('an unnamed shape does not leak onto the NEXT query built on the same accessor', () => {
    const q = makeQuery('users', schema());
    q.buildFindMany({ where: { OR: [{ age: 1 }, { age: 2 }] } } as never);
    const after = nameFor(q, { where: { age: 30 } });
    assert.ok(after && after.length > 0, 'a fixed-shape query after a variable-arity one must still be named');
  });

  it('an empty OR array contributes no combinator and stays named', () => {
    // `{ OR: [] }` is skipped by the canonical walk entirely (no SQL, no params,
    // no fingerprint token), so there is no arity to be variable.
    const q = makeQuery('users', schema());
    const name = nameFor(q, { where: { age: 1, OR: [] } });
    assert.ok(name && name.length > 0);
  });
});

describe('prepared statements: the unnamed name reaches the driver', () => {
  it('an empty preparedName makes queryWithTimeout use the plain (text, values) form', async () => {
    const calls: unknown[] = [];
    const pool = {
      query: (a: unknown, b?: unknown) => {
        calls.push(b === undefined ? a : { text: a, values: b, plain: true });
        return Promise.resolve({ rows: [], rowCount: 0, command: 'SELECT', oid: 0, fields: [] });
      },
      // biome-ignore lint/suspicious/noExplicitAny: minimal pg-compatible stub
    } as any;
    const { QueryInterface } = await import('../query/index.js');
    const q = new QueryInterface<Record<string, unknown>>(pool, 'users', schema(), undefined, {
      warnOnUnlimited: false,
    });

    await q.findMany({ where: { age: 1 } } as never);
    await q.findMany({ where: { OR: [{ age: 1 }, { age: 2 }] } } as never);

    const fixed = calls[0] as { name?: string };
    const variable = calls[1] as { plain?: boolean };
    assert.ok(typeof fixed === 'object' && typeof fixed.name === 'string' && fixed.name.length > 0);
    assert.equal(variable.plain, true, 'the OR query must go out as an unnamed statement');
  });
});

describe('prepared statements: a long orderBy goes unnamed', () => {
  // Same unbounded-statement mechanism as the combinator arrays above, reached
  // through the other caller-supplied list that is written into the SQL text
  // one comma-separated term per element. Measured against the landed
  // combinator fix, `orderBy: [{id:'asc'}] x n` still minted one named
  // statement per n:
  //
  //   n=1  t_6803f864062a0f8e   ORDER BY "id" ASC
  //   n=2  t_706d79d2c8851810   ORDER BY "id" ASC, "id" ASC
  //   n=8  t_ab8a96bf9a2be2ac   ORDER BY "id" ASC x8
  //
  // Two rules answer it, and they answer different halves. Repetition is
  // removed outright (nothing can repeat, so the length is bounded by the
  // table's width); what is left is the PERMUTATION space of distinct columns,
  // which the length cap here bounds.

  it('one, two and three sort keys keep their names', () => {
    // The shapes application code actually writes: a single sort, a sort plus a
    // primary-key tiebreak for stable pagination, and the widest hand-written
    // form (category, then recency, then tiebreak).
    const q = makeQuery('users', schema());
    for (const orderBy of [
      [{ age: 'asc' }],
      [{ age: 'desc' }, { id: 'asc' }],
      [{ name: 'asc' }, { age: 'desc' }, { id: 'asc' }],
    ]) {
      const name = nameFor(q, { orderBy });
      assert.ok(name && name.length > 0, `expected a name for a ${orderBy.length}-key sort, got ${name}`);
    }
  });

  it('a fourth sort key takes the statement off its name', () => {
    const q = makeQuery('users', schema());
    const four = q.buildFindMany({
      orderBy: [{ name: 'asc' }, { age: 'desc' }, { tenantId: 'asc' }, { id: 'asc' }],
    } as never);
    assert.equal(four.preparedName, '', 'a 4-key sort is an advanced-sort UI, not hand-written code');
    // The SQL itself is unchanged: this rule moves no text, it only decides
    // whether the text is parsed under a name the server keeps forever.
    assert.match(four.sql, /ORDER BY "name" ASC, "age" DESC, "tenant_id" ASC, "id" ASC/);
  });

  it('the object form counts the same as the array form', () => {
    const q = makeQuery('users', schema());
    assert.equal(
      q.buildFindMany({ orderBy: { name: 'asc', age: 'desc', tenantId: 'asc', id: 'asc' } } as never).preparedName,
      '',
    );
  });

  it('a long orderBy inside a `with` clause counts too', () => {
    // A relation's orderBy comes from the same request body and its terms land
    // in the same statement. Note the repeat: relation orderBys are capped but
    // deliberately NOT deduped (see buildRelationOrderClause), so four entries
    // is four terms even on a three-column table.
    const q = makeQuery('users', schema());
    const built = q.buildFindMany({
      with: {
        posts: { orderBy: [{ title: 'asc' }, { userId: 'desc' }, { id: 'asc' }, { id: 'desc' }] },
      },
    } as never);
    assert.equal(built.preparedName, '');
  });

  it('a three-key relation orderBy keeps the statement named', () => {
    const q = makeQuery('users', schema());
    const built = q.buildFindMany({
      with: { posts: { orderBy: [{ title: 'asc' }, { userId: 'desc' }, { id: 'asc' }] } },
    } as never);
    assert.ok((built.preparedName ?? '').length > 0);
  });

  it('a long sort that dedupes back under the cap keeps its name', () => {
    // Order of operations: redundant terms are dropped BEFORE the length is
    // counted, so the stable-pagination pattern colliding on the primary key
    // does not quietly cost the query its prepared statement.
    const q = makeQuery('users', schema());
    const built = q.buildFindMany({
      orderBy: [{ name: 'asc' }, { age: 'desc' }, { id: 'asc' }, { id: 'desc' }],
    } as never);
    assert.ok((built.preparedName ?? '').length > 0);
    assert.match(built.sql, /ORDER BY "name" ASC, "age" DESC, "id" ASC$/);
  });

  it('the verdict survives a cache hit', () => {
    const q = makeQuery('users', schema());
    const args = { orderBy: [{ name: 'asc' }, { age: 'desc' }, { tenantId: 'asc' }, { id: 'asc' }] };
    assert.equal(q.buildFindMany(args as never).preparedName, '');
    assert.equal(q.buildFindMany(args as never).preparedName, '', 'a warmed template must not regain a name');
  });
});

// ---------------------------------------------------------------------------
// The ORDER channel
// ---------------------------------------------------------------------------

/** Every ordering of `items`. */
function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [[...items]];
  const out: T[][] = [];
  for (let i = 0; i < items.length; i++) {
    const rest = [...items.slice(0, i), ...items.slice(i + 1)];
    for (const p of permutations(rest)) out.push([items[i]!, ...p]);
  }
  return out;
}

/** `['a','b'] -> { a: true, b: true }`, insertion order preserved. */
function flags(keys: readonly string[]): Record<string, boolean> {
  return Object.fromEntries(keys.map((k) => [k, true]));
}

/** Distinct non-empty prepared names produced across every ordering of `keys`. */
function namesAcrossPermutations(
  keys: readonly string[],
  build: (perm: string[]) => { sql: string; preparedName?: string },
): { names: Set<string>; sqls: Set<string>; total: number } {
  const names = new Set<string>();
  const sqls = new Set<string>();
  const perms = permutations(keys);
  for (const perm of perms) {
    const d = build(perm);
    sqls.add(d.sql);
    if (d.preparedName) names.add(d.preparedName);
  }
  return { names, sqls, total: perms.length };
}

const FOUR = ['name', 'age', 'tenantId', 'id'] as const;

describe('prepared statements: caller-controlled key ORDER cannot mint statements', () => {
  it('every ordering of one `select` is ONE named statement', () => {
    // 24 permutations of a 4-field projection. Before canonicalization this was
    // 24 distinct SQL texts and 24 permanent server-side statements; a
    // seven-column table gives 5,040 of them, measured at 39.4 MB.
    const q = makeQuery('users', schema());
    const { names, sqls, total } = namesAcrossPermutations(FOUR, (perm) =>
      q.buildFindMany({ select: flags(perm) } as never),
    );
    assert.equal(total, 24);
    assert.equal(sqls.size, 1, `expected one SQL text, got ${sqls.size}: ${[...sqls].join(' | ')}`);
    assert.equal(names.size, 1, `expected one prepared statement, got ${names.size}`);
  });

  it('the emitted SELECT list is the TABLE order, whatever the caller wrote', () => {
    const q = makeQuery('users', schema());
    const built = q.buildFindMany({ select: { tenantId: true, id: true, name: true } } as never);
    assert.match(built.sql, /^SELECT "users"\."id", "users"\."name", "users"\."tenant_id" FROM "users"/);
  });

  it('a relation `select` inside `with` is canonical too', () => {
    // This one ALSO closes a lockstep hazard: `withFingerprint` already sorted
    // the relation's select keys, so the cache key was permutation-invariant
    // while the SQL was not, and the second permutation was served the first
    // one's statement. Under `jsonEncoding: 'positional'` that decoded values
    // into the wrong fields (the emitted array order came from the cached SQL,
    // the decoder from the current args).
    const q = makeQuery('users', schema());
    const { names, sqls } = namesAcrossPermutations(['title', 'id', 'userId'], (perm) =>
      q.buildFindMany({ with: { posts: { select: flags(perm) } } } as never),
    );
    assert.equal(sqls.size, 1);
    assert.equal(names.size, 1);
  });

  it('every ordering of one write `data` is ONE named statement', () => {
    const q = makeQuery('users', schema());
    const { names, sqls, total } = namesAcrossPermutations(['name', 'age', 'tenantId'], (perm) =>
      q.buildUpdate({ where: { id: 1 }, data: Object.fromEntries(perm.map((f) => [f, 'x'])) } as never),
    );
    assert.equal(total, 6);
    assert.equal(sqls.size, 1, `expected one SQL text, got: ${[...sqls].join(' | ')}`);
    assert.equal(names.size, 1);
  });

  it('the SET list is in table order, so a forwarded PATCH body cannot pick it', () => {
    const q = makeQuery('users', schema());
    // JSON.parse preserves insertion order: this IS what reaches `data` when a
    // handler forwards a request body.
    const body = JSON.parse('{"tenantId":"t","name":"n","age":3}');
    const built = q.buildUpdate({ where: { id: 1 }, data: body } as never);
    assert.match(built.sql, /SET "age" = \$1, "name" = \$2, "tenant_id" = \$3 /);
    // Params follow the same order, so the cached statement and its binds agree.
    assert.deepEqual(built.params, [3, 'n', 't', 1]);
  });

  it('updateMany follows the same rule', () => {
    const q = makeQuery('users', schema());
    const { names, sqls } = namesAcrossPermutations(['name', 'age', 'tenantId'], (perm) =>
      q.buildUpdateMany({ where: { id: 1 }, data: Object.fromEntries(perm.map((f) => [f, 'x'])) } as never),
    );
    assert.equal(sqls.size, 1);
    assert.equal(names.size, 1);
  });

  it('two spellings of one column collapse in a projection', () => {
    // `userId` and `user_id` are both legal on an introspected schema and
    // resolve to the same column; the SELECT list used to name it twice.
    const q = makeQuery('posts', schema());
    const built = q.buildFindMany({ select: { userId: true, user_id: true, id: true } } as never);
    assert.match(built.sql, /^SELECT "posts"\."id", "posts"\."user_id" FROM "posts"/);
  });

  it('a multi-column `distinct` is UNNAMED, and its SQL text is untouched', () => {
    // The other remedy. `DISTINCT ON`'s list is re-emitted as the leading terms
    // of the inner ORDER BY, and with no `orderBy` at all PostgreSQL's choice of
    // representative row is explicitly unpredictable, so reordering it could
    // hand a caller a different row. Withholding the name changes no text.
    const q = makeQuery('users', schema());
    const { names, sqls, total } = namesAcrossPermutations(['name', 'age', 'tenantId'], (perm) =>
      q.buildFindMany({ distinct: perm } as never),
    );
    assert.equal(total, 6);
    assert.equal(sqls.size, 6, 'the SQL must still differ per ordering: this rule moves no text');
    assert.equal(names.size, 0, 'and not one of those texts may be parsed under a name');
  });

  it('a single-column `distinct` keeps its name (one ordering, no permutation space)', () => {
    const q = makeQuery('users', schema());
    const built = q.buildFindMany({ distinct: ['tenantId'] } as never);
    assert.ok((built.preparedName ?? '').length > 0, 'the common single-column case must not pay for this rule');
  });

  it('a `distinct` that dedupes down to one column keeps its name', () => {
    // Repeats are dropped upstream, so the rule sees real columns only.
    const original = console.warn;
    console.warn = () => {};
    try {
      const q = makeQuery('users', schema());
      const built = q.buildFindMany({ distinct: ['tenantId', 'tenant_id'] } as never);
      assert.ok((built.preparedName ?? '').length > 0);
    } finally {
      console.warn = original;
    }
  });

  it('the distinct verdict survives a cache hit', () => {
    const q = makeQuery('users', schema());
    const args = { distinct: ['name', 'age'] };
    assert.equal(q.buildFindMany(args as never).preparedName, '');
    assert.equal(q.buildFindMany(args as never).preparedName, '', 'a warmed template must not regain a name');
  });
});

// ---------------------------------------------------------------------------
// The invariant, as a property
// ---------------------------------------------------------------------------

/** Deterministic PRNG, so a failure is reproducible from the seed alone. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher-Yates against the seeded PRNG. */
function shuffle<T>(rng: () => number, items: readonly T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/** Re-key an object in the given key order. Values are shared by reference. */
function reorder(obj: Record<string, unknown>, order: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of order) out[k] = obj[k];
  return out;
}

/**
 * Rebuild `args` with every ORDER-INSENSITIVE key list shuffled, and nothing
 * else touched. `orderBy` is deliberately absent from this walk: permuting it
 * is not a semantics-preserving rewrite, so it is outside the invariant.
 */
function permuteArgs(rng: () => number, args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...args };
  for (const key of ['select', 'omit', 'where', 'cursor', 'data'] as const) {
    const value = out[key];
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const obj = value as Record<string, unknown>;
      out[key] = reorder(obj, shuffle(rng, Object.keys(obj)));
    }
  }
  if (Array.isArray(out.distinct)) out.distinct = shuffle(rng, out.distinct as string[]);
  if (out.with && typeof out.with === 'object') {
    const w = out.with as Record<string, unknown>;
    const permuted: Record<string, unknown> = {};
    for (const relName of shuffle(rng, Object.keys(w))) {
      const spec = w[relName];
      permuted[relName] = spec && typeof spec === 'object' ? permuteArgs(rng, spec as Record<string, unknown>) : spec;
    }
    out.with = permuted;
  }
  return out;
}

/** One randomly generated findMany arg set, plus the operation to build it with. */
function generateArgs(rng: () => number): { op: 'findMany' | 'update'; args: Record<string, unknown> } {
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rng() * xs.length)]!;
  const some = <T>(xs: readonly T[], min = 1): T[] => {
    const shuffled = shuffle(rng, xs);
    return shuffled.slice(0, Math.max(min, Math.floor(rng() * xs.length) + 1));
  };
  const userFields = ['id', 'age', 'name', 'tenantId'] as const;
  const postFields = ['id', 'userId', 'title'] as const;

  if (rng() < 0.3) {
    // A write: `data` is the SET list, `where` the predicate.
    return {
      op: 'update',
      args: {
        where: { id: 1 },
        data: Object.fromEntries(some(userFields.filter((f) => f !== 'id')).map((f) => [f, 'v'])),
      },
    };
  }

  const args: Record<string, unknown> = {};
  const projection = rng();
  if (projection < 0.35) args.select = flags(some(userFields));
  else if (projection < 0.6) args.omit = flags(some(userFields.filter((f) => f !== 'id')));
  if (rng() < 0.5) args.where = Object.fromEntries(some(userFields).map((f) => [f, 1]));
  if (rng() < 0.3) args.distinct = some(userFields);
  // orderBy is generated but NEVER permuted (see permuteArgs): it is here so
  // the invariant is exercised on statements that carry one.
  if (rng() < 0.3 && !args.distinct) args.orderBy = [{ [pick(userFields)]: pick(['asc', 'desc'] as const) }];
  if (rng() < 0.4) {
    args.with = { posts: rng() < 0.5 ? true : { select: flags(some(postFields)) } };
  }
  if (rng() < 0.3) args.limit = 10;
  return { op: 'findMany', args };
}

describe('prepared statements: the ordering invariant, as a property', () => {
  it('semantically equivalent args emit the same SQL, or no name at all', () => {
    // THE RULE: reordering keys that carry no meaning must not be able to
    // produce a second permanent server-side statement. It is satisfied either
    // by emitting identical text (canonicalization) or by emitting no name
    // (the variable-arity mechanism). A failure here is a NEW channel of the
    // same class the 5,040-statement measurement came from.
    const rng = mulberry32(0x5eed);
    const original = console.warn;
    console.warn = () => {};
    try {
      for (let i = 0; i < 400; i++) {
        // A fresh accessor per case, so a cache HIT can never be what makes two
        // orderings agree: each build compiles from cold.
        const { op, args } = generateArgs(rng);
        const permuted = permuteArgs(rng, args);
        const a =
          op === 'update'
            ? makeQuery('users', schema()).buildUpdate(args as never)
            : makeQuery('users', schema()).buildFindMany(args as never);
        const b =
          op === 'update'
            ? makeQuery('users', schema()).buildUpdate(permuted as never)
            : makeQuery('users', schema()).buildFindMany(permuted as never);

        if (a.sql === b.sql) continue;
        const detail = `case ${i} (${op})\n  args     = ${JSON.stringify(args)}\n  permuted = ${JSON.stringify(permuted)}\n  sqlA = ${a.sql}\n  sqlB = ${b.sql}`;
        assert.equal(a.preparedName, '', `different SQL from a key permutation, and A is NAMED.\n${detail}`);
        assert.equal(b.preparedName, '', `different SQL from a key permutation, and B is NAMED.\n${detail}`);
      }
    } finally {
      console.warn = original;
    }
  });

  it('the generator really does produce both outcomes (otherwise it proves nothing)', () => {
    // A property test that only ever hits one branch is a test of nothing. This
    // pins that the corpus contains BOTH a permutation pair that collapses to
    // one SQL text and one that stays distinct and unnamed.
    const rng = mulberry32(0x5eed);
    let identical = 0;
    let unnamedDivergent = 0;
    const original = console.warn;
    console.warn = () => {};
    try {
      for (let i = 0; i < 400; i++) {
        const { op, args } = generateArgs(rng);
        const permuted = permuteArgs(rng, args);
        const a =
          op === 'update'
            ? makeQuery('users', schema()).buildUpdate(args as never)
            : makeQuery('users', schema()).buildFindMany(args as never);
        const b =
          op === 'update'
            ? makeQuery('users', schema()).buildUpdate(permuted as never)
            : makeQuery('users', schema()).buildFindMany(permuted as never);
        if (a.sql === b.sql) identical++;
        else unnamedDivergent++;
      }
    } finally {
      console.warn = original;
    }
    assert.ok(identical > 50, `expected many collapsing pairs, got ${identical}`);
    assert.ok(unnamedDivergent > 5, `expected some unnamed-divergent pairs (distinct), got ${unnamedDivergent}`);
  });
});
