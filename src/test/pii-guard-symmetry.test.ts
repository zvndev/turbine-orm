/**
 * The PII guard must accept exactly the set of queries the BUILDER resolves.
 *
 * `cli/pii-predicate-guard.ts` is the one walker deciding whether caller-supplied
 * `findMany` args filter, sort, page, or de-duplicate on a hidden column. It is a
 * refusal gate in front of a compiler it does not own, so its only real property
 * is agreement: for any args, the set of names the guard SEES must be the set of
 * names the builder RESOLVES. Every position where the two disagree is a hole,
 * and it is a silent one, because the query still runs and still returns rows.
 *
 * Two disagreements shipped, and this file is the regression net for the class
 * rather than for the two instances.
 *
 *   H1, SPELLING. Since 0.72 a relation answers to its declared name
 *   (`blogPosts`) and to the table spelling anyone reads off the DDL
 *   (`blog_posts`), resolved by `resolveRelation`. The guard looked relations up
 *   by exact match and `continue`d on a miss, so the snake spelling walked
 *   straight past it: `where: { blog_posts: { some: { authorEmail: … } } }` was
 *   answered while the declared spelling of the byte-identical query was
 *   refused. Studio's redaction walk had the same exact-match lookup on the same
 *   tree, so both halves failed together and the value came back in the clear.
 *
 *   H2, SHAPE. JS coerces a property key to a string, so
 *   `Object.hasOwn(columnMap, ['email'])` is TRUE and the builder resolves
 *   `distinct: [['email']]` to the same column as `distinct: ['email']`, with
 *   byte-identical SQL. The guard tested `typeof field === 'string'` and SKIPPED
 *   anything else, so only one of the two spellings of one query was refused.
 *
 * THE SHAPE OF THIS SUITE, borrowed from `relation-spelling-symmetry.test.ts`:
 * one list of surfaces, the same questions asked of every one of them by
 * construction.
 *
 *   1. the builder RESOLVES the hidden name through this surface (so the
 *      surface is real, and a refusal below is not refusing a broken query);
 *   2. the guard REFUSES the declared spelling;
 *   3. the snake spelling compiles to BYTE-IDENTICAL SQL and params, i.e. it is
 *      the same query and not merely another accepted one;
 *   4. the guard REFUSES the snake spelling too; and
 *   5. the same surface naming a VISIBLE column is ACCEPTED under both
 *      spellings, so a refusal is about the hidden column and not about the
 *      spelling. Without (5) a guard that refused everything would pass (2) and
 *      (4).
 *
 * The fixture uses MULTI-WORD relation names and MULTI-WORD PII columns
 * throughout. Every Studio and MCP fixture in the tree used single-word names
 * (`posts`, `author`, `email`), whose two spellings are the same string, which
 * is precisely why nothing failed while both holes were open.
 */

import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { describe, it } from 'node:test';
import type pg from 'pg';
import { assertNoPiiPredicates } from '../cli/pii-predicate-guard.js';
import { handleRequest, PII_REDACTED, type StudioContext, type StudioOptions } from '../cli/studio.js';
import type { DeferredQuery } from '../query/deferred.js';
import { resolveRelation } from '../query/utils.js';
import type { RelationDef, SchemaMetadata, TableMetadata } from '../schema.js';
import { makeQuery, mockTable } from './helpers.js';

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const BLOG_POSTS_REL: RelationDef = {
  type: 'hasMany',
  name: 'blogPosts',
  from: 'authors',
  to: 'blog_posts',
  foreignKey: 'author_id',
  referenceKey: 'id',
};

const BLOG_AUTHOR_REL: RelationDef = {
  type: 'belongsTo',
  name: 'blogAuthor',
  from: 'blog_posts',
  to: 'authors',
  foreignKey: 'author_id',
  referenceKey: 'id',
};

function buildSchema(): SchemaMetadata {
  const authors = mockTable(
    'authors',
    [
      { name: 'id', field: 'id' },
      { name: 'display_name', field: 'displayName', pgType: 'text' },
      { name: 'contact_email', field: 'contactEmail', pgType: 'text', pii: true },
    ],
    { blogPosts: BLOG_POSTS_REL },
  );
  const blogPosts = mockTable(
    'blog_posts',
    [
      { name: 'id', field: 'id' },
      { name: 'author_id', field: 'authorId' },
      { name: 'head_line', field: 'headLine', pgType: 'text' },
      { name: 'author_email', field: 'authorEmail', pgType: 'text', pii: true },
    ],
    { blogAuthor: BLOG_AUTHOR_REL },
  );
  return { tables: { authors, blog_posts: blogPosts }, enums: {} };
}

const schema = buildSchema();
const authorsMeta = schema.tables.authors as TableMetadata;
const postsMeta = schema.tables.blog_posts as TableMetadata;

/** The two spellings of each relation, plus a name that is neither. */
const MANY = { root: 'authors', declared: 'blogPosts', snake: 'blog_posts', bogus: 'blog_postz' };
const ONE = { root: 'blog_posts', declared: 'blogAuthor', snake: 'blog_author', bogus: 'blog_auther' };

/** Hidden and visible column of each table, in both spellings. */
const COLUMNS = {
  authors: { hidden: 'contactEmail', hiddenColumn: 'contact_email', visible: 'displayName' },
  blog_posts: { hidden: 'authorEmail', hiddenColumn: 'author_email', visible: 'headLine' },
};

// ---------------------------------------------------------------------------
// The two things under test, driven directly
// ---------------------------------------------------------------------------

type Verdict = { ok: true } | { ok: false; kind: 'column' | 'shape' | 'depth'; detail: string };

/**
 * Run the shared walker with a Studio-shaped host (a code-first `pii` tag is the
 * only reason a column is hidden) and report the verdict rather than throwing,
 * so a test can assert on WHICH refusal fired.
 */
function guard(args: Record<string, unknown>, tableName: string): Verdict {
  const table = schema.tables[tableName];
  assert.ok(table, `fixture has no table "${tableName}"`);
  try {
    assertNoPiiPredicates(args, table, {
      metadata: schema,
      hiddenReason: (owner, column) =>
        owner.columns.some((c) => c.name === column && c.pii === true) ? 'is PII-tagged' : null,
      refuseColumn: (owner, column, why) => {
        throw new GuardRefusal('column', `${owner.name}.${column} ${why}`);
      },
      refuseDepth: (maxDepth) => {
        throw new GuardRefusal('depth', `deeper than ${maxDepth}`);
      },
      refuseShape: (owner, key) => {
        throw new GuardRefusal('shape', `${owner.name}.${key}`);
      },
    });
    return { ok: true };
  } catch (err) {
    if (err instanceof GuardRefusal) return { ok: false, kind: err.kind, detail: err.detail };
    throw err;
  }
}

class GuardRefusal extends Error {
  constructor(
    readonly kind: 'column' | 'shape' | 'depth',
    readonly detail: string,
  ) {
    super(`${kind}: ${detail}`);
  }
}

/** Compile the same args the guard was asked about. Throws exactly as the builder does. */
function compile(args: Record<string, unknown>, tableName: string): DeferredQuery<unknown> {
  return makeQuery(tableName, schema).buildFindMany(args as never);
}

// ---------------------------------------------------------------------------
// Surfaces. Each names a relation (the variable) and a column of that
// relation's TARGET (hidden or visible), so one entry answers all five
// questions.
// ---------------------------------------------------------------------------

interface Surface {
  name: string;
  /** Defaults to the to-many trio; to-one surfaces carry their own. */
  trio?: typeof MANY;
  build: (relation: string, column: string) => Record<string, unknown>;
}

const SURFACES: Surface[] = [
  {
    name: 'with: relation where',
    build: (r, c) => ({ with: { [r]: { where: { [c]: { startsWith: 'a' } } } } }),
  },
  {
    name: 'with: relation orderBy',
    build: (r, c) => ({ with: { [r]: { orderBy: { [c]: 'asc' }, limit: 3 } } }),
  },
  {
    name: 'with: relation where under a combinator',
    build: (r, c) => ({ with: { [r]: { where: { OR: [{ id: 1 }, { [c]: { contains: '@' } }] } } } }),
  },
  {
    name: 'with: nested level, TARGET table',
    trio: ONE,
    build: (r, c) => ({ with: { blogPosts: { with: { [r]: { where: { [c]: { equals: 'x' } } } } } } }),
  },
  {
    name: 'where: relation filter (some)',
    build: (r, c) => ({ where: { [r]: { some: { [c]: { startsWith: 'a' } } } } }),
  },
  {
    name: 'where: relation filter (none)',
    build: (r, c) => ({ where: { [r]: { none: { [c]: { equals: 'x' } } } } }),
  },
  {
    name: 'where: relation filter (every)',
    build: (r, c) => ({ where: { [r]: { every: { [c]: { not: null } } } } }),
  },
  {
    name: 'where: relation filter under OR',
    build: (r, c) => ({ where: { OR: [{ id: 1 }, { [r]: { some: { [c]: { contains: '@' } } } }] } }),
  },
  {
    name: 'where: to-one relation filter (bare)',
    trio: ONE,
    build: (r, c) => ({ where: { [r]: { [c]: { startsWith: 'a' } } } }),
  },
  {
    name: 'where: to-one relation filter (is wrapper)',
    trio: ONE,
    build: (r, c) => ({ where: { [r]: { is: { [c]: { startsWith: 'a' } } } } }),
  },
  {
    name: 'orderBy: to-one relation target column',
    trio: ONE,
    build: (r, c) => ({ orderBy: { [r]: { [c]: 'asc' } } }),
  },
  {
    name: 'orderBy: pick-row through a to-many relation',
    build: (r, c) => ({ orderBy: { [r]: { pick: { orderBy: { id: 'asc' } }, by: c } } }),
  },
  {
    name: 'orderBy: pick-row, hidden column in pick.where',
    build: (r, c) => ({
      orderBy: { [r]: { pick: { orderBy: { id: 'asc' }, where: { [c]: { startsWith: 'a' } } }, by: 'id' } },
    }),
  },
];

const trioOf = (s: Surface) => s.trio ?? MANY;
const columnsOf = (s: Surface) => {
  // The column named by a surface belongs to the relation's TARGET table.
  const trio = trioOf(s);
  const target = trio === ONE ? 'authors' : 'blog_posts';
  return COLUMNS[target];
};

// ---------------------------------------------------------------------------
// Fixture sanity. Every one of these guards an assertion below against passing
// for the wrong reason.
// ---------------------------------------------------------------------------

describe('PII guard symmetry: the fixture can actually prove something', () => {
  it('every relation name is multi-word, so its two spellings differ', () => {
    for (const trio of [MANY, ONE]) {
      assert.notEqual(trio.declared, trio.snake);
      assert.notEqual(trio.declared, trio.bogus);
    }
  });

  it('the snake spelling is NOT itself a declared relation', () => {
    // Otherwise the "accepts the snake spelling" arm would resolve through the
    // exact-match branch and the resolution rule would go untested.
    assert.equal(authorsMeta.relations[MANY.snake], undefined);
    assert.equal(postsMeta.relations[ONE.snake], undefined);
    assert.equal(resolveRelation(authorsMeta.relations, MANY.snake)?.name, MANY.declared);
    assert.equal(resolveRelation(postsMeta.relations, ONE.snake)?.name, ONE.declared);
  });

  it('every PII column is multi-word, so its field and column spellings differ', () => {
    for (const t of [COLUMNS.authors, COLUMNS.blog_posts]) {
      assert.notEqual(t.hidden, t.hiddenColumn);
    }
  });

  it('the hidden columns are tagged and the visible ones are not', () => {
    const tagged = (t: TableMetadata, name: string) => t.columns.find((c) => c.name === name)?.pii === true;
    assert.ok(tagged(authorsMeta, 'contact_email'));
    assert.ok(tagged(postsMeta, 'author_email'));
    assert.equal(tagged(authorsMeta, 'display_name'), false);
    assert.equal(tagged(postsMeta, 'head_line'), false);
  });

  it('covers every surface exactly once (no duplicate entries masking a gap)', () => {
    assert.equal(new Set(SURFACES.map((s) => s.name)).size, SURFACES.length);
  });
});

// ---------------------------------------------------------------------------
// H1: the five questions, asked of every surface
// ---------------------------------------------------------------------------

describe('PII guard symmetry: every relation surface, both spellings', () => {
  for (const surface of SURFACES) {
    const { declared, snake } = trioOf(surface);
    const { root } = trioOf(surface);
    const cols = columnsOf(surface);
    const rootTable = surface.trio === ONE && surface.name.includes('nested') ? 'authors' : root;

    it(`${surface.name}: the builder RESOLVES the hidden column through this surface`, () => {
      // Without this, a refusal below could be refusing a query that never
      // reached the hidden column at all.
      const sql = compile(surface.build(declared, cols.hidden), rootTable).sql;
      assert.match(
        sql,
        new RegExp(`"${cols.hiddenColumn}"`),
        `${surface.name}: expected the compiled SQL to reference "${cols.hiddenColumn}"`,
      );
    });

    it(`${surface.name}: refuses the declared spelling "${declared}"`, () => {
      const v = guard(surface.build(declared, cols.hidden), rootTable);
      assert.equal(v.ok, false, `${surface.name}: guard allowed a hidden column under "${declared}"`);
    });

    it(`${surface.name}: both spellings compile to identical SQL and params`, () => {
      const a = compile(surface.build(declared, cols.hidden), rootTable);
      const b = compile(surface.build(snake, cols.hidden), rootTable);
      assert.equal(b.sql, a.sql, `${surface.name}: "${snake}" compiled differently from "${declared}"`);
      assert.deepEqual(b.params, a.params);
    });

    it(`${surface.name}: refuses the table spelling "${snake}" too`, () => {
      const v = guard(surface.build(snake, cols.hidden), rootTable);
      assert.equal(
        v.ok,
        false,
        `${surface.name}: the guard allowed "${snake}" while refusing "${declared}", and the two compile to ` +
          `byte-identical SQL, so the snake spelling is an unguarded route to the same hidden column`,
      );
    });

    it(`${surface.name}: ACCEPTS a visible column under both spellings`, () => {
      for (const name of [declared, snake]) {
        const v = guard(surface.build(name, cols.visible), rootTable);
        assert.equal(
          v.ok,
          true,
          `${surface.name}: refused a visible column under "${name}" (${v.ok ? '' : `${v.kind}: ${v.detail}`})`,
        );
      }
    });
  }
});

describe('PII guard symmetry: the hidden column in both of ITS spellings', () => {
  // The column rule (`resolveColumnName`) is the older half of the same idea:
  // a predicate may name a column by its camelCase field or by the column name.
  for (const spelling of ['contactEmail', 'contact_email']) {
    for (const relName of [MANY.declared, MANY.snake]) {
      it(`refuses where.${relName}.some.${spelling}`, () => {
        const v = guard({ where: { [relName]: { some: { id: 1 } } }, orderBy: { [spelling]: 'asc' } }, 'authors');
        assert.equal(v.ok, false);
      });
    }
  }
});

// ---------------------------------------------------------------------------
// H2: field-list shapes. The builder resolves by property-key coercion; the
// guard tested `typeof === 'string'`.
// ---------------------------------------------------------------------------

describe('PII guard symmetry: distinct, string and nested-array forms', () => {
  const HIDDEN = COLUMNS.authors.hidden;
  const HIDDEN_COL = COLUMNS.authors.hiddenColumn;
  const VISIBLE = COLUMNS.authors.visible;

  it('the coercion the builder relies on is real (this is the mechanism)', () => {
    // `Object.hasOwn(map, ['contactEmail'])` coerces the array key to the string
    // "contactEmail". If this ever stops being true the rest of this block is
    // testing nothing, so assert it directly rather than inferring it.
    const key = [HIDDEN] as unknown as string;
    assert.equal(Object.hasOwn(authorsMeta.columnMap, key), true);
    assert.equal(authorsMeta.columnMap[key], HIDDEN_COL);
  });

  it('both forms compile to byte-identical SQL naming the hidden column', () => {
    const a = compile({ distinct: [HIDDEN] }, 'authors');
    const b = compile({ distinct: [[HIDDEN]] }, 'authors');
    assert.match(a.sql, new RegExp(`DISTINCT ON \\("${HIDDEN_COL}"\\)`));
    assert.equal(b.sql, a.sql, 'the nested-array form is the same query, so it must get the same verdict');
    assert.deepEqual(b.params, a.params);
  });

  it('refuses the string form', () => {
    const v = guard({ distinct: [HIDDEN] }, 'authors');
    assert.equal(v.ok, false);
    assert.equal(v.ok === false && v.kind, 'column');
  });

  it('refuses the column-name spelling', () => {
    const v = guard({ distinct: [HIDDEN_COL] }, 'authors');
    assert.equal(v.ok, false);
    assert.equal(v.ok === false && v.kind, 'column');
  });

  it('refuses the nested-array form', () => {
    const v = guard({ distinct: [[HIDDEN]] }, 'authors');
    assert.equal(v.ok, false, 'distinct: [["contactEmail"]] emits the same SQL as the string form');
  });

  it('refuses a non-string element even on a VISIBLE column (fail closed on the shape)', () => {
    // A field list holds field NAMES. An element that is not one cannot be shown
    // to name a visible column, whatever the builder happens to coerce it to
    // today, so the shape is refused rather than the resolved name checked.
    const v = guard({ distinct: [[VISIBLE]] }, 'authors');
    assert.equal(v.ok, false);
    assert.equal(v.ok === false && v.kind, 'shape');
  });

  it('refuses a truthy non-array distinct', () => {
    const v = guard({ distinct: HIDDEN }, 'authors');
    assert.equal(v.ok, false);
    assert.equal(v.ok === false && v.kind, 'shape');
  });

  it('still ACCEPTS an ordinary distinct on visible columns', () => {
    // The fix must not turn `distinct` off: over-refusal here would be a real
    // regression on the Studio Query tab.
    const v = guard({ distinct: [VISIBLE, 'id'] }, 'authors');
    assert.equal(v.ok, true);
    assert.match(compile({ distinct: [VISIBLE, 'id'] }, 'authors').sql, /DISTINCT ON \("display_name", "id"\)/);
  });

  for (const [label, value] of [
    ['undefined', undefined],
    ['null', null],
    ['empty array', []],
  ] as const) {
    it(`accepts a falsy/empty distinct (${label}), matching the builder's own gate`, () => {
      // The builder gates on `args.distinct && args.distinct.length > 0`, so
      // these compile to no DISTINCT at all. Refusing them would refuse a query
      // that names nothing.
      assert.equal(guard({ distinct: value }, 'authors').ok, true);
      assert.doesNotMatch(compile({ distinct: value }, 'authors').sql, /DISTINCT/);
    });
  }
});

describe('PII guard symmetry: other value-position name shapes', () => {
  it('refuses a pick-row `by` that carries a structure instead of a name', () => {
    const v = guard(
      { orderBy: { [MANY.declared]: { pick: { orderBy: { id: 'asc' } }, by: [COLUMNS.blog_posts.hidden] } } },
      'authors',
    );
    assert.equal(v.ok, false);
    assert.equal(v.ok === false && v.kind, 'shape');
  });

  it('refuses a pick-row `by` whose { field } is not a string', () => {
    const v = guard(
      {
        orderBy: {
          [MANY.snake]: { pick: { orderBy: { id: 'asc' } }, by: { field: [COLUMNS.blog_posts.hidden], path: ['a'] } },
        },
      },
      'authors',
    );
    assert.equal(v.ok, false);
    assert.equal(v.ok === false && v.kind, 'shape');
  });

  it('still accepts a pick-row `by` naming a visible column, under either spelling', () => {
    for (const relName of [MANY.declared, MANY.snake]) {
      const v = guard(
        { orderBy: { [relName]: { pick: { orderBy: { id: 'asc' } }, by: COLUMNS.blog_posts.visible } } },
        'authors',
      );
      assert.equal(v.ok, true, `refused a visible pick-row \`by\` under "${relName}"`);
    }
  });

  it('an unknown relation name is left to the builder under both conventions', () => {
    // Neither spelling of a bogus name resolves, so the guard has nothing to
    // judge and the builder reports it by name (E005). Widening what resolves
    // must not widen what is ACCEPTED.
    for (const bogus of [MANY.bogus, ONE.bogus, '__proto__', 'constructor']) {
      assert.equal(resolveRelation(authorsMeta.relations, bogus), undefined, `"${bogus}" must not resolve`);
    }
    assert.throws(() => compile({ with: { [MANY.bogus]: true } }, 'authors'));
  });
});

// ---------------------------------------------------------------------------
// Studio, end to end. The guard is only half of H1: `select` on a PII column is
// deliberately PERMITTED because the values are redacted on the way out, so the
// redaction walk is the whole protection for that shape, and it had the same
// exact-match lookup on the same tree.
// ---------------------------------------------------------------------------

const HOST = '127.0.0.1';
const ORIGIN = `http://${HOST}:0`;
const TOKEN = 'test-token';
const SECRET = 'ada@example.com';

interface RecordedResponse {
  status: number;
  body: string;
  json: unknown;
}

function makeRes(): { res: ServerResponse; done: Promise<RecordedResponse> } {
  let resolveDone!: (r: RecordedResponse) => void;
  const done = new Promise<RecordedResponse>((r) => {
    resolveDone = r;
  });
  let status = 0;
  const res = {
    setHeader() {
      /* no-op */
    },
    writeHead(s: number) {
      status = s;
      return this;
    },
    end(payload?: string) {
      const body = payload ?? '';
      let json: unknown = null;
      try {
        json = body ? JSON.parse(body) : null;
      } catch {
        json = null;
      }
      resolveDone({ status, body, json });
    },
  } as unknown as ServerResponse;
  return { res, done };
}

function makeReq(body: unknown): IncomingMessage {
  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  return {
    method: 'POST',
    url: '/api/builder',
    headers: { 'x-turbine-token': TOKEN, origin: ORIGIN },
    async *[Symbol.asyncIterator]() {
      yield payload;
    },
  } as unknown as IncomingMessage;
}

/** BEGIN + statement_timeout + search_path + the data query + COMMIT. */
function makePool(dataRows: unknown[]): pg.Pool {
  const programmed: Array<{ rows?: unknown[] }> = [{}, {}, {}, { rows: dataRows }, {}];
  let next = 0;
  const client = {
    async query() {
      const rows = programmed[next++]?.rows ?? [];
      return { rows, rowCount: rows.length, fields: [] };
    },
    release() {
      /* no-op */
    },
  };
  return {
    async connect() {
      return client;
    },
    async query() {
      return { rows: [], rowCount: 0, fields: [] };
    },
    async end() {
      /* no-op */
    },
  } as unknown as pg.Pool;
}

function makeCtx(pool: pg.Pool, showPii = false): StudioContext {
  const options: StudioOptions = {
    url: 'postgres://fake',
    schema: 'public',
    port: 0,
    host: HOST,
    openBrowser: false,
    stateDir: tmpdir(),
    showPii,
  };
  return {
    pool,
    metadata: buildSchema(),
    options,
    authToken: TOKEN,
    stateDir: tmpdir(),
    statementTimeout: { sql: `SELECT set_config('statement_timeout', $1, true)`, params: ['30s'] },
    rateLimiter: new Map(),
    writable: false,
    showPii,
  } as StudioContext;
}

async function apiBuilder(ctx: StudioContext, table: string, args: unknown): Promise<RecordedResponse> {
  const { res, done } = makeRes();
  await handleRequest(makeReq({ table, args }), res, ctx);
  return done;
}

/**
 * One parent row whose relation column carries the positional encoding the
 * builder's own transform expects: `[id, author_email]` for `select: { id,
 * authorEmail }`. The relation column comes back under the alias the builder
 * emits, which is the DECLARED name whichever spelling the caller wrote.
 */
const REL_ROWS = [{ id: 1, display_name: 'Ada', blogPosts: [[7, SECRET]] }];
const REL_SELECT = { select: { id: true, authorEmail: true } };

describe('Studio /api/builder: nested PII is redacted under BOTH relation spellings', () => {
  it('the fixture actually carries the secret (anti-vacuous)', async () => {
    // With --show-pii the plaintext must be in the body. If it is not, every
    // "does not contain the secret" assertion below passes for free.
    const r = await apiBuilder(makeCtx(makePool(REL_ROWS), true), 'authors', {
      with: { [MANY.declared]: REL_SELECT },
    });
    assert.equal(r.status, 200, r.body);
    assert.ok(r.body.includes(SECRET), 'the fixture returned no PII value, so redaction proves nothing');
  });

  for (const relName of [MANY.declared, MANY.snake]) {
    it(`redacts the nested PII cell for with: { ${relName}: { select: { authorEmail } } }`, async () => {
      const r = await apiBuilder(makeCtx(makePool(REL_ROWS)), 'authors', { with: { [relName]: REL_SELECT } });
      assert.equal(r.status, 200, r.body);
      assert.ok(
        !r.body.includes(SECRET),
        `the PII value was served in the clear under the "${relName}" spelling: ${r.body}`,
      );
      assert.ok(r.body.includes(PII_REDACTED), 'expected the redaction marker in place of the value');
    });
  }

  it('both spellings produce the same response body', async () => {
    const a = await apiBuilder(makeCtx(makePool(REL_ROWS)), 'authors', { with: { [MANY.declared]: REL_SELECT } });
    const b = await apiBuilder(makeCtx(makePool(REL_ROWS)), 'authors', { with: { [MANY.snake]: REL_SELECT } });
    const strip = (s: string) => s.replace(/"elapsedMs":\d+/, '"elapsedMs":0');
    assert.equal(strip(b.body), strip(a.body));
  });

  it('refuses a relation-filter predicate on a hidden column under BOTH spellings', async () => {
    for (const relName of [MANY.declared, MANY.snake]) {
      const r = await apiBuilder(makeCtx(makePool([])), 'authors', {
        where: { [relName]: { some: { authorEmail: { startsWith: 'a' } } } },
      });
      assert.equal(r.status, 400, `"${relName}" was not refused: ${r.body}`);
      assert.match(String((r.json as { error: string }).error), /PII-tagged and redacted/);
    }
  });

  it('refuses distinct on a hidden column in BOTH the string and nested-array forms', async () => {
    for (const distinct of [[COLUMNS.authors.hidden], [[COLUMNS.authors.hidden]]]) {
      const r = await apiBuilder(makeCtx(makePool([])), 'authors', { distinct });
      assert.equal(r.status, 400, `${JSON.stringify(distinct)} was not refused: ${r.body}`);
    }
  });

  it('leaves a visible-column query alone under both spellings', async () => {
    for (const relName of [MANY.declared, MANY.snake]) {
      const r = await apiBuilder(makeCtx(makePool(REL_ROWS)), 'authors', {
        where: { [relName]: { some: { headLine: { contains: 'x' } } } },
        limit: 1,
      });
      assert.equal(r.status, 200, `"${relName}" was refused for a visible column: ${r.body}`);
    }
  });
});
