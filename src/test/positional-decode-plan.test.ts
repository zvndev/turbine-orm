/**
 * The positional decode plan (`makePositionalRowParser`, query/relations.ts)
 * against the reference path it replaces (`makeReferencePositionalParser`).
 *
 * The plan turns each positional relation array straight into its parsed row
 * in one pass. The reference decodes the array into a keyed object, copies it
 * to decode its JSON-wire columns, and runs that through `parseRow` and
 * `parseNestedRow`. The plan is only worth having if its rows are the
 * reference's rows, so every test here compares the two STRICTLY: key order,
 * prototypes, `Object.is` on every primitive (NaN, -0), `getTime()` on every
 * Date (Invalid Date included), bytes on every Buffer, and on a throw the error
 * class, code and message.
 *
 *   1. A seeded generative differential over random `with` shapes (select,
 *      omit, PII, depth, to-one, to-many) and random positional payloads,
 *      most of them well formed and the rest deliberately not (a payload that
 *      is not JSON, a to-many that is not an array, an object where an array
 *      belongs, short arrays, `_count__` columns, a relation column missing as
 *      it is under `'auto'`), on several client configurations.
 *   2. The declined shapes: each layout the plan refuses is refused, and the
 *      query still decodes through the reference.
 *   3. The `parseDbDate` fast path, against the previous implementation kept
 *      here as the oracle, over the temporal shapes Postgres renders.
 *   4. On PostgreSQL: real rows with temporal edge cases (BC, five-digit
 *      years, infinity, zone-less vs zoned, `date`) decoded by the plan, by the
 *      reference over the SAME driver result, by the object encoding and by the
 *      batched strategy.
 *
 * Every comparison asserts first that the plan was actually taken, because a
 * plan that silently declined would compare the reference with itself.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import pgDriver from 'pg';
import { TurbineClient } from '../client.js';
import { introspect } from '../introspect.js';
import type { QueryInterfaceOptions } from '../query/deferred.js';
import {
  buildRelationShapes,
  makeNestedParser,
  makePositionalRowParser,
  makeReferencePositionalParser,
} from '../query/relations.js';
import type { WithClause } from '../query/types.js';
import { parseDbDate } from '../query/utils.js';
import type { BuilderCtx } from '../query/where.js';
import type { RelationDef, SchemaMetadata, TableMetadata } from '../schema.js';
import { makeQuery, mockTable, skipGate } from './helpers.js';

// ---------------------------------------------------------------------------
// Strict comparison
// ---------------------------------------------------------------------------

function assertIdentical(actual: unknown, expected: unknown, path: string): void {
  if (typeof actual !== typeof expected) {
    assert.fail(`${path}: typeof ${typeof actual} vs ${typeof expected}`);
  }
  if (actual === null || expected === null || typeof actual !== 'object') {
    assert.ok(Object.is(actual, expected), `${path}: ${String(actual)} vs ${String(expected)}`);
    return;
  }
  const a = actual as Record<string, unknown>;
  const e = expected as Record<string, unknown>;
  assert.equal(Object.getPrototypeOf(a), Object.getPrototypeOf(e), `${path}: different prototypes`);
  if (a instanceof Date) {
    assert.ok(
      Object.is(a.getTime(), (e as unknown as Date).getTime()),
      `${path}: ${a.getTime()} vs ${(e as unknown as Date).getTime()}`,
    );
    return;
  }
  if (Buffer.isBuffer(a)) {
    assert.ok(a.equals(e as unknown as Buffer), `${path}: buffers differ`);
    return;
  }
  const keysA = Object.keys(a);
  const keysE = Object.keys(e);
  assert.deepEqual(keysA, keysE, `${path}: keys or key order differ`);
  for (const key of keysA) assertIdentical(a[key], e[key], `${path}.${key}`);
}

type Outcome = { ok: true; value: unknown } | { ok: false; error: string };

function outcome(fn: () => unknown): Outcome {
  try {
    return { ok: true, value: fn() };
  } catch (err) {
    const e = err as Error & { code?: unknown; invariant?: unknown };
    return { ok: false, error: `${e.constructor.name}|${String(e.code)}|${String(e.invariant)}|${e.message}` };
  }
}

function assertSameOutcome(plan: Outcome, reference: Outcome, label: string): void {
  if (!reference.ok || !plan.ok) {
    assert.deepEqual(plan, reference, `${label}: outcomes differ`);
    return;
  }
  assertIdentical(plan.value, reference.value, label);
}

// ---------------------------------------------------------------------------
// Fixture schema (build-only)
// ---------------------------------------------------------------------------

function rel(
  type: RelationDef['type'],
  name: string,
  from: string,
  to: string,
  foreignKey: string,
  referenceKey = 'id',
): RelationDef {
  return { type, name, from, to, foreignKey, referenceKey };
}

function withDates(meta: TableMetadata, columns: string[]): TableMetadata {
  return { ...meta, dateColumns: new Set(columns) };
}

/**
 * Relations are declared in an order that is NOT alphabetical (`posts` before
 * `comments`, `profile` before `articles`), because `with` shapes are built in
 * sorted order and the reference decodes in declaration order: the plan's
 * relation-order branch only runs when the two differ.
 */
const schema: SchemaMetadata = {
  enums: { mood: ['ok', 'sad'] },
  tables: {
    authors: withDates(
      mockTable(
        'authors',
        [
          { name: 'id', field: 'id' },
          { name: 'name', field: 'name', pgType: 'text' },
          { name: 'created_at', field: 'createdAt', pgType: 'timestamptz' },
          { name: 'born', field: 'born', pgType: 'date' },
          { name: 'email', field: 'email', pgType: 'text', pii: true },
        ],
        {
          profile: rel('hasOne', 'profile', 'authors', 'profiles', 'author_id'),
          posts: rel('hasMany', 'posts', 'authors', 'posts', 'author_id'),
          articles: rel('hasMany', 'articles', 'authors', 'posts', 'author_id'),
        },
      ),
      ['created_at', 'born'],
    ),
    profiles: withDates(
      mockTable(
        'profiles',
        [
          { name: 'id', field: 'id' },
          { name: 'author_id', field: 'authorId' },
          { name: 'bio', field: 'bio', pgType: 'text' },
          { name: 'secret', field: 'secret', pgType: 'text', pii: true },
          { name: 'seen_at', field: 'seenAt', pgType: 'timestamp' },
        ],
        { author: rel('belongsTo', 'author', 'profiles', 'authors', 'author_id') },
      ),
      ['seen_at'],
    ),
    posts: withDates(
      mockTable(
        'posts',
        [
          { name: 'id', field: 'id' },
          { name: 'author_id', field: 'authorId' },
          { name: 'title', field: 'title', pgType: 'text' },
          { name: 'score', field: 'score', pgType: 'float8' },
          { name: 'scores', field: 'scores', pgType: '_float8' },
          { name: 'ratio', field: 'ratio', pgType: 'numeric' },
          { name: 'moods', field: 'moods', pgType: '_mood' },
          { name: 'data', field: 'data', pgType: 'jsonb' },
          { name: 'raw', field: 'raw', pgType: 'bytea' },
          { name: 'day', field: 'day', pgType: 'date' },
          { name: 'stamps', field: 'stamps', pgType: '_timestamptz' },
          { name: 'published_at', field: 'publishedAt', pgType: 'timestamp' },
          { name: 'created_at', field: 'createdAt', pgType: 'timestamptz' },
        ],
        {
          comments: rel('hasMany', 'comments', 'posts', 'comments', 'post_id'),
          author: rel('belongsTo', 'author', 'posts', 'authors', 'author_id'),
        },
      ),
      ['day', 'stamps', 'published_at', 'created_at'],
    ),
    comments: withDates(
      mockTable(
        'comments',
        [
          { name: 'id', field: 'id' },
          { name: 'post_id', field: 'postId' },
          { name: 'body', field: 'body', pgType: 'text' },
          { name: 'created_at', field: 'createdAt', pgType: 'timestamptz' },
        ],
        { post: rel('belongsTo', 'post', 'comments', 'posts', 'post_id') },
      ),
      ['created_at'],
    ),
  },
};

function ctxOf(options: QueryInterfaceOptions): BuilderCtx {
  const q = makeQuery('authors', schema, { warnOnUnlimited: false, logger: {}, ...options });
  return (q as unknown as { ctx: BuilderCtx }).ctx;
}

// ---------------------------------------------------------------------------
// Seeded generators
// ---------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = <T>(rng: () => number, xs: readonly T[]): T => xs[Math.floor(rng() * xs.length)]!;
const chance = (rng: () => number, p: number) => rng() < p;

/** The temporal renderings Postgres produces (and a few it does not), as strings. */
const TEMPORAL_STRINGS = [
  '2026-07-07T17:15:41.896+00:00',
  '2026-07-07T17:15:41+05:30',
  '2026-07-07T17:15:41.123456-04:00',
  '2026-07-07 17:15:41+02',
  '2026-07-07 17:15:41-0430',
  '2026-07-07T17:15:41.896',
  '2026-07-07 17:15:41',
  '2026-07-07T17:15:41Z',
  '2026-07-07',
  '0044-03-15',
  '0044-03-15 BC',
  '0044-03-15T12:00:00+00:00 BC',
  '12345-01-01',
  '12345-01-01T00:00:00+00:00',
  '1850-01-01T00:00:00-04:56:02',
  'infinity',
  '-infinity',
  '2026-07-07T17:15:41+0a:00',
  '2026-07-07T17:15:41x05:30',
  'not a date',
  '',
];

const SCALAR_POOL: readonly unknown[] = [
  null,
  0,
  -0,
  1,
  42.5,
  Number.MAX_SAFE_INTEGER,
  true,
  false,
  'text',
  '9007199254740993',
  '1000.5000',
  '\\xdeadbeef',
  'NaN',
  'Infinity',
  '-Infinity',
  '{ok,sad}',
  '{"a":1}',
  [1, 2],
  ['NaN', 1.5],
  ['2026-07-07T17:15:41+00:00', 'infinity'],
  { nested: [1, 'x'] },
];

function scalar(rng: () => number): unknown {
  if (chance(rng, 0.4)) return pick(rng, TEMPORAL_STRINGS);
  return structuredClone(pick(rng, SCALAR_POOL));
}

interface ShapeLike {
  keys: string[];
  nested: Record<string, ShapeLike>;
  cardinality: 'one' | 'many';
}

/** A positional array for `shape`: one cell per key, nested slots recursing. */
function positionalRow(rng: () => number, shape: ShapeLike, depth: number): unknown[] {
  const row = shape.keys.map((key) => {
    const nested = shape.nested[key];
    return nested ? relationPayload(rng, nested, depth + 1, false) : scalar(rng);
  });
  // A short array (a missing trailing cell) is read as `undefined` by both.
  if (chance(rng, 0.05)) row.length = Math.max(0, row.length - 1);
  return row;
}

/** A relation value: mostly well formed, sometimes deliberately not. */
function relationPayload(rng: () => number, shape: ShapeLike, depth: number, topLevel: boolean): unknown {
  const r = rng();
  let value: unknown;
  if (r < 0.06) value = null;
  else if (r < 0.08) value = undefined;
  else if (r < 0.1) value = { id: 1, created_at: '2026-07-07T17:15:41+00:00' };
  else if (r < 0.11) value = 7;
  else if (r < 0.12) value = 'null';
  else if (shape.cardinality === 'one') value = positionalRow(rng, shape, depth);
  else {
    const n = Math.floor(rng() * 4);
    const items: unknown[] = [];
    for (let i = 0; i < n; i++) {
      const q = rng();
      items.push(
        q < 0.05
          ? null
          : q < 0.08
            ? { id: 2, created_at: '2026-07-07 17:15:41' }
            : q < 0.1
              ? 'loose'
              : positionalRow(rng, shape, depth),
      );
    }
    value = items;
  }
  // The driver hands the top-level json column over parsed or as text; a
  // nested slot is occasionally a string too, and occasionally not JSON.
  if (topLevel || chance(rng, 0.05)) {
    if (chance(rng, 0.03)) return '[[1, "unterminated';
    if (value !== undefined && chance(rng, 0.5)) return JSON.stringify(value);
  }
  return value;
}

const RELATION_FIELDS: Record<string, readonly string[]> = {
  profiles: ['id', 'authorId', 'bio', 'secret', 'seenAt'],
  posts: [
    'id',
    'authorId',
    'title',
    'score',
    'scores',
    'ratio',
    'moods',
    'data',
    'raw',
    'day',
    'stamps',
    'publishedAt',
    'createdAt',
  ],
  comments: ['id', 'postId', 'body', 'createdAt'],
  authors: ['id', 'name', 'createdAt', 'born', 'email'],
};

function relationSpec(
  rng: () => number,
  table: string,
  depth: number,
  includePii: boolean,
): true | Record<string, unknown> {
  if (chance(rng, 0.25)) return true;
  const spec: Record<string, unknown> = {};
  const fields = RELATION_FIELDS[table]!.filter((f) => includePii || (f !== 'secret' && f !== 'email'));
  const projection = rng();
  if (projection < 0.3) {
    const keep = fields.filter(() => chance(rng, 0.5));
    spec.select = Object.fromEntries((keep.length ? keep : ['id']).map((f) => [f, true]));
  } else if (projection < 0.5) {
    spec.omit = Object.fromEntries(fields.filter(() => chance(rng, 0.3)).map((f) => [f, true]));
  }
  if (depth < 3) {
    const meta = schema.tables[table]!;
    const nested: Record<string, unknown> = {};
    for (const [name, def] of Object.entries(meta.relations)) {
      if (chance(rng, 0.45)) nested[name] = relationSpec(rng, def.to, depth + 1, includePii);
    }
    if (Object.keys(nested).length > 0) spec.with = nested;
  }
  return spec;
}

function withClauseFor(rng: () => number, includePii: boolean): WithClause {
  const clause: Record<string, unknown> = {};
  for (const [name, def] of Object.entries(schema.tables.authors!.relations)) {
    if (chance(rng, 0.7)) clause[name] = relationSpec(rng, def.to, 1, includePii);
  }
  if (Object.keys(clause).length === 0) clause.posts = true;
  return clause as WithClause;
}

function topRow(rng: () => number, shapes: Record<string, ShapeLike>): Record<string, unknown> {
  const row: Record<string, unknown> = {
    id: pick(rng, [1, '9007199254740993', null]),
    name: scalar(rng),
    created_at: chance(rng, 0.7) ? new Date(Date.UTC(2026, 6, 7, 17, 15, 41)) : scalar(rng),
    born: chance(rng, 0.7) ? new Date(Date.UTC(1990, 0, 1)) : scalar(rng),
  };
  if (chance(rng, 0.15)) row._count__posts = pick(rng, ['3', 3, '0']);
  for (const [name, shape] of Object.entries(shapes)) {
    // Missing entirely, as a relation the 'auto' strategy batched is.
    if (chance(rng, 0.05)) continue;
    row[name] = relationPayload(rng, shape, 1, true);
  }
  return row;
}

const CONFIGS: readonly [string, QueryInterfaceOptions][] = [
  ['default', {}],
  ['utcTimestamps: false', { utcTimestamps: false }],
  ["temporalInfinity: 'null'", { temporalInfinity: 'null' }],
];

const envSeed = process.env.TURBINE_FUZZ_SEED;
const SEEDS: readonly number[] = envSeed ? [Number(envSeed) >>> 0] : [11, 2026, 0xdec0de];
const CASES = process.env.TURBINE_FUZZ_CASES ? Number(process.env.TURBINE_FUZZ_CASES) : 200;

// ---------------------------------------------------------------------------
// 1. Generative differential
// ---------------------------------------------------------------------------

describe('positional decode plan: generative differential against the reference', () => {
  for (const [label, options] of CONFIGS) {
    for (const seed of SEEDS) {
      test(`${label}, seed ${seed}: ${CASES} queries, rows identical to the reference`, () => {
        const rng = mulberry32(seed);
        const ctx = ctxOf(options);
        let planned = 0;
        let comparedRows = 0;
        let nestedRows = 0;
        let thrown = 0;
        for (let i = 0; i < CASES; i++) {
          const includePii = chance(rng, 0.2);
          const withClause = withClauseFor(rng, includePii);
          const repro = `seed=${seed} case=${i} config=${label} with=${JSON.stringify(withClause)}`;
          const shapes = buildRelationShapes(ctx, 'authors', withClause, includePii);
          const plan = makePositionalRowParser(ctx, 'authors', shapes);
          // This fixture has no colliding names, so every shape must be planned:
          // a decline here would compare the reference with itself.
          assert.ok(plan, `the plan declined a well-formed shape: ${repro}`);
          planned += 1;
          const reference = makeReferencePositionalParser(ctx, shapes);
          for (let r = 0; r < 4; r++) {
            const row = topRow(rng, shapes as unknown as Record<string, ShapeLike>);
            const fromPlan = outcome(() => plan(structuredClone(row)));
            const fromReference = outcome(() => reference(structuredClone(row)));
            assertSameOutcome(fromPlan, fromReference, `${repro} row=${r} input=${JSON.stringify(row)}`);
            if (!fromReference.ok) {
              thrown += 1;
              continue;
            }
            comparedRows += 1;
            for (const name of Object.keys(shapes)) {
              const value = (fromReference.value as Record<string, unknown>)[name];
              if (Array.isArray(value) ? value.some((v) => typeof v === 'object' && v !== null) : value) {
                nestedRows += 1;
              }
            }
          }
        }
        assert.equal(planned, CASES);
        // Anti-vacuity: rows were compared, nested rows were actually produced,
        // and the malformed-payload branch was reached.
        assert.ok(comparedRows > CASES, `only ${comparedRows} rows compared`);
        assert.ok(nestedRows > CASES, `only ${nestedRows} rows carried a decoded relation`);
        assert.ok(thrown > 0, 'no case reached the relation-payload error path');
      });
    }
  }

  test("nested relations decode in the reference's order, so the same relation is reported", () => {
    // `posts` declares `comments` before `author`; the `with` shape sorts them
    // the other way. With both nested payloads unparseable, the reference
    // throws for the one it reaches first, so the plan must reach it first too.
    const ctx = ctxOf({});
    const withClause = { posts: { select: { id: true }, with: { author: true, comments: true } } } as WithClause;
    const shapes = buildRelationShapes(ctx, 'authors', withClause, false);
    assert.deepEqual(shapes.posts!.keys, ['id', 'author', 'comments']);
    const plan = makePositionalRowParser(ctx, 'authors', shapes)!;
    const row = { id: 1, posts: [[1, '{bad', '[bad']] };
    const fromReference = outcome(() => makeReferencePositionalParser(ctx, shapes)(structuredClone(row)));
    assert.ok(!fromReference.ok && fromReference.error.includes('"comments"'), JSON.stringify(fromReference));
    assertSameOutcome(
      outcome(() => plan(structuredClone(row))),
      fromReference,
      'nested error order',
    );
    // And on good payloads the keys stay in shape order.
    const good = { id: 1, posts: [[1, [1, 'a', null, null, null], [[2, 1, 'c', null]]]] };
    const parsed = plan(good) as { posts: Record<string, unknown>[] };
    assert.deepEqual(Object.keys(parsed.posts[0]!), ['id', 'author', 'comments']);
    assertIdentical(parsed, makeReferencePositionalParser(ctx, shapes)(structuredClone(good)), 'good payload');
  });

  test('a relation column the row does not own (inherited, or not enumerable) is not read', () => {
    // The reference reads relation columns off `{ ...row }`, which holds the
    // row's own enumerable properties only.
    const ctx = ctxOf({});
    const shapes = buildRelationShapes(ctx, 'authors', { posts: true, profile: true }, false);
    const plan = makePositionalRowParser(ctx, 'authors', shapes)!;
    const reference = makeReferencePositionalParser(ctx, shapes);
    const make = () => {
      const row = Object.create({ posts: '[[1]]' }) as Record<string, unknown>;
      row.id = 1;
      Object.defineProperty(row, 'profile', { value: '[1]', enumerable: false });
      return row;
    };
    const expected = reference(make());
    assert.deepEqual(Object.keys(expected), ['id']);
    assertIdentical(plan(make()), expected, 'inherited / non-enumerable');
  });

  test('the parsed rows are not the input objects (the plan allocates its own rows)', () => {
    const ctx = ctxOf({});
    const shapes = buildRelationShapes(ctx, 'authors', { posts: { select: { id: true, title: true } } }, false);
    const plan = makePositionalRowParser(ctx, 'authors', shapes)!;
    const payload = [[1, 't']];
    const row = { id: 1, name: 'a', posts: payload };
    const parsed = plan(row);
    assert.deepEqual(parsed, { id: 1, name: 'a', posts: [{ id: 1, title: 't' }] });
    assert.deepEqual(row.posts, [[1, 't']], 'the driver row must not be mutated');
  });
});

// ---------------------------------------------------------------------------
// 2. Declined shapes
// ---------------------------------------------------------------------------

describe('positional decode plan: shapes it declines still decode through the reference', () => {
  function oneTable(
    columns: { name: string; field: string; pgType?: string }[],
    extra: Record<string, RelationDef> = {},
  ) {
    return {
      enums: {},
      tables: {
        users: mockTable('users', [{ name: 'id', field: 'id' }], {
          items: rel('hasMany', 'items', 'users', 'items', 'user_id'),
          ...extra,
        }),
        items: mockTable('items', columns, { owner: rel('belongsTo', 'owner', 'items', 'users', 'user_id') }),
      },
    } as SchemaMetadata;
  }

  const cases: [string, SchemaMetadata, WithClause][] = [
    [
      'two columns mapping to one field',
      oneTable([
        { name: 'id', field: 'id' },
        { name: 'user_id', field: 'title' },
        { name: 'title', field: 'title', pgType: 'text' },
      ]),
      { items: true },
    ],
    [
      'a column field named like a relation of its table',
      oneTable([
        { name: 'id', field: 'id' },
        { name: 'owner', field: 'owner', pgType: 'text' },
      ]),
      { items: true },
    ],
    [
      'a `_count__` column field',
      oneTable([
        { name: 'id', field: 'id' },
        { name: '_count__x', field: '_count__x', pgType: 'text' },
      ]),
      { items: true },
    ],
    [
      'an integer-like column field',
      oneTable([
        { name: 'id', field: 'id' },
        { name: '7', field: '7', pgType: 'text' },
      ]),
      { items: true },
    ],
    [
      // The field is plain (`seven`), only the KEY is integer-like, which
      // `Object.keys` lists first: only the key check catches this one.
      'an integer-like key whose field is plain',
      oneTable([
        { name: 'id', field: 'id' },
        { name: '7', field: 'seven', pgType: 'text' },
        { name: 'n', field: '7', pgType: 'text' },
      ]),
      { items: { select: { id: true, 7: true } } } as WithClause,
    ],
    [
      'a column field that resolves through Object.prototype',
      oneTable([
        { name: 'id', field: 'id' },
        { name: 'constructor', field: 'constructor', pgType: 'text' },
      ]),
      { items: true },
    ],
    [
      'a top-level relation named like a column',
      oneTable([{ name: 'id', field: 'id' }], { id: rel('hasMany', 'id', 'users', 'items', 'user_id') }),
      { items: true, id: true } as WithClause,
    ],
  ];

  for (const [label, s, withClause] of cases) {
    test(`${label}: declined, and the query decodes as the reference does`, () => {
      const q = makeQuery('users', s, { warnOnUnlimited: false, logger: {} });
      const ctx = (q as unknown as { ctx: BuilderCtx }).ctx;
      assert.equal(ctx.jsonEncoding, 'positional');
      const shapes = buildRelationShapes(ctx, 'users', withClause, false);
      assert.equal(makePositionalRowParser(ctx, 'users', shapes), undefined, 'the plan should have declined');
      const keys = shapes.items!.keys;
      const row: Record<string, unknown> = { id: 1, items: JSON.stringify([keys.map((_, i) => `v${i}`)]) };
      if (shapes.id) row.id = '[]';
      const parser = makeNestedParser(ctx, withClause, false, null);
      const reference = makeReferencePositionalParser(ctx, shapes);
      const expected = outcome(() => reference(structuredClone(row)));
      assertSameOutcome(
        outcome(() => parser(structuredClone(row))),
        expected,
        label,
      );
      // The colliding scalar is re-read as a relation by the reference (and so
      // throws); every other case decodes its one item.
      if (expected.ok) {
        const items = (expected.value as Record<string, unknown>).items;
        assert.ok(Array.isArray(items) && items.length === 1, 'nothing was decoded');
      } else {
        assert.match(expected.error, /relation-payload-json/);
      }
    });
  }

  // Two guards whose shapes no earlier check reaches. Each test compares the
  // rows FIRST, so a deleted guard fails on the wrong row it produces rather
  // than only on the decline assertion after it.
  function declinedRowsMatch(s: SchemaMetadata, withClause: WithClause, items: unknown[][]) {
    const q = makeQuery('users', s, { warnOnUnlimited: false, logger: {} });
    const ctx = (q as unknown as { ctx: BuilderCtx }).ctx;
    const shapes = buildRelationShapes(ctx, 'users', withClause, false);
    const row = { id: 1, items: JSON.stringify(items) };
    const expected = makeReferencePositionalParser(ctx, shapes)(structuredClone(row));
    const actual = makeNestedParser(ctx, withClause, false, null)(structuredClone(row));
    assertIdentical(actual, expected, 'declined shape');
    assert.equal(makePositionalRowParser(ctx, 'users', shapes), undefined, 'the plan should have declined');
    return { shapes, item: (expected.items as Record<string, unknown>[])[0]! };
  }

  test('two DISTINCT keys reaching one field through reverseColumnMap: declined', () => {
    // Column `a_col` (float8) has field `title`, and column `title` (text) has
    // field `heading`. The relation's keys are `title` and `heading`, both
    // distinct, but parseRow maps the key `title` through reverseColumnMap to
    // `heading`, so both land on `heading` with different cell kinds (float,
    // plain). The reference keeps the LAST write as written; a plan would run
    // the float decode over it and turn the text 'NaN' into NaN.
    const s = oneTable([
      { name: 'id', field: 'id' },
      { name: 'a_col', field: 'title', pgType: 'float8' },
      { name: 'title', field: 'heading', pgType: 'text' },
    ]);
    const { shapes, item } = declinedRowsMatch(s, { items: true }, [[7, 1.5, 'NaN']]);
    assert.deepEqual(shapes.items!.keys, ['id', 'title', 'heading']);
    assert.deepEqual(Object.keys(item), ['id', 'heading']);
    assert.equal(item.heading, 'NaN', 'the text column keeps its text');
  });

  test('a nested relation slot parseRow would copy under another field: declined', () => {
    // `items` has a column named `owner` (field `ownerLabel`) and a relation
    // named `owner`. With the column left out by `select`, the relation slot's
    // key `owner` reaches parseRow, which files it under `ownerLabel`, so the
    // reference row carries BOTH `ownerLabel` (the slot copied through) and
    // `owner` (the parsed relation). Only the nested-slot check sees this.
    const s = oneTable([
      { name: 'id', field: 'id' },
      { name: 'user_id', field: 'userId' },
      { name: 'owner', field: 'ownerLabel', pgType: 'text' },
    ]);
    const withClause = { items: { select: { id: true }, with: { owner: true } } } as WithClause;
    const { shapes, item } = declinedRowsMatch(s, withClause, [[7, [1]]]);
    assert.deepEqual(shapes.items!.keys, ['id', 'owner']);
    assert.deepEqual(Object.keys(item), ['id', 'ownerLabel', 'owner']);
  });

  test('a hand-built ctx without the decode hooks takes the reference path', () => {
    const ctx = ctxOf({});
    const bare = { ...ctx, rowDecodePlan: undefined } as unknown as BuilderCtx;
    const shapes = buildRelationShapes(ctx, 'authors', { posts: true }, false);
    assert.equal(makePositionalRowParser(bare, 'authors', shapes), undefined);
    assert.ok(makePositionalRowParser(ctx, 'authors', shapes));
  });
});

// ---------------------------------------------------------------------------
// 3. The parseDbDate fast path
// ---------------------------------------------------------------------------

/** The pre-fast-path implementation, verbatim, as the oracle. */
function referenceParseDbDate(value: string): Date {
  const TZ_SUFFIX_RE = /(?:Z|[+-]\d{2}(?::?\d{2})?)$/;
  const common = (): Date => {
    if (!value.includes(':')) return new Date(value);
    if (TZ_SUFFIX_RE.test(value)) {
      return new Date(value.replace(/([+-]\d{2})(\d{2})$/, '$1:$2').replace(/([+-]\d{2})$/, '$1:00'));
    }
    return new Date(`${value.replace(' ', 'T')}Z`);
  };
  const date = common();
  // The general fallback is unchanged and shared, so route the invalid case
  // through the module's own parser: only the common half is under test.
  return Number.isNaN(date.getTime()) ? parseDbDate(value) : date;
}

describe('parseDbDate: the ±HH:MM fast path is the general path for that shape', () => {
  test('every Postgres temporal rendering parses to the same instant as before', () => {
    const rng = mulberry32(0x7135);
    const years = ['2026', '0001', '0044', '1850', '9999', '12345', '275760'];
    const times = ['', 'T00:00:00', ' 23:59:59', 'T17:15:41.896', 'T17:15:41.123456', ' 04:05:06.7', 'T17:15'];
    const offsets = [
      '',
      'Z',
      '+00:00',
      '-00:00',
      '+05:30',
      '-04:00',
      '+14:00',
      '-12:45',
      '+02',
      '-0430',
      '+0530',
      '-04:56:02',
      '+5:30',
      '+0a:00',
      'x05:30',
      '+05:3',
      '+05-30',
      '-05+30',
    ];
    const suffixes = ['', ' BC'];
    let compared = 0;
    let fastShape = 0;
    for (const y of years) {
      for (const t of times) {
        for (const o of offsets) {
          for (const s of suffixes) {
            const month = String(1 + Math.floor(rng() * 12)).padStart(2, '0');
            const day = String(1 + Math.floor(rng() * 28)).padStart(2, '0');
            const value = `${y}-${month}-${day}${t}${t ? o : ''}${s}`;
            const got = parseDbDate(value).getTime();
            const want = referenceParseDbDate(value).getTime();
            assert.ok(Object.is(got, want), `${value}: ${got} vs ${want}`);
            compared += 1;
            if (/[+-]\d\d:\d\d$/.test(value)) fastShape += 1;
          }
        }
      }
    }
    // Not Postgres renderings, but V8's lenient parser reads them differently
    // with and without the general path's normalizing, so they pin every
    // character the fast path checks (the colon position included).
    const nearMisses = ['Mar 4 2026 23:59:59+05.30', 'Mar 4 2026 23:59:59-05 30', 'Mar 4 2026 23:59:59+05,30'];
    for (const value of [
      'infinity',
      '-infinity',
      '',
      ':',
      '+05:30',
      'x+05:30',
      '2026-07-07',
      '05:30:00+05:30',
      ...nearMisses,
    ]) {
      assert.ok(Object.is(parseDbDate(value).getTime(), referenceParseDbDate(value).getTime()), value);
    }
    assert.ok(compared > 1000 && fastShape > 200, `compared ${compared}, fast-path shapes ${fastShape}`);
    // Pinned instants, independent of the process time zone: a zone-less
    // value whose tail merely looks like an offset (`T17:15`) is still UTC.
    assert.equal(parseDbDate('2026-07-07T17:15').getTime(), Date.UTC(2026, 6, 7, 17, 15));
    assert.equal(parseDbDate('2026-07-07T17:15:41.896+05:30').getTime(), Date.UTC(2026, 6, 7, 11, 45, 41, 896));
    assert.equal(parseDbDate('0044-03-15T12:00:00+00:00 BC').getUTCFullYear(), -43);
  });
});

// ---------------------------------------------------------------------------
// 4. PostgreSQL: real rows, temporal edge cases
// ---------------------------------------------------------------------------

const PG_URL = process.env.DATABASE_URL;
const pgGate = skipGate(!PG_URL, 'DATABASE_URL not set');

const DDL = `
DROP TABLE IF EXISTS decodeplan_children CASCADE;
DROP TABLE IF EXISTS decodeplan_parents CASCADE;
CREATE TABLE decodeplan_parents (
  id      BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  label   TEXT NOT NULL,
  made_at TIMESTAMPTZ
);
CREATE TABLE decodeplan_children (
  id        BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  parent_id BIGINT NOT NULL REFERENCES decodeplan_parents(id),
  ord       INTEGER NOT NULL,
  at_tz     TIMESTAMPTZ,
  at_local  TIMESTAMP,
  on_day    DATE,
  big       BIGINT,
  amount    NUMERIC(30,10),
  score     DOUBLE PRECISION,
  doc       JSONB,
  blob      BYTEA,
  tags      TEXT[]
);
CREATE INDEX ON decodeplan_children(parent_id);
INSERT INTO decodeplan_parents (label, made_at) VALUES
  ('a', '2026-07-07 17:15:41.896+00'), ('b', NULL), ('c', 'infinity'), ('empty', '0044-03-15 12:00:00+00 BC');
INSERT INTO decodeplan_children (parent_id, ord, at_tz, at_local, on_day, big, amount, score, doc, blob, tags) VALUES
  (1, 1, '2026-07-07 17:15:41.896+00', '2026-07-07 17:15:41.896', '2026-07-07', 9007199254740993, 12345678901234567890.0123456789, 'NaN', '{"k":[1,2]}', '\\xdeadbeef', '{a,b}'),
  (1, 2, '2026-01-01 00:00:00.000001+05:30', '1999-12-31 23:59:59.999999', '2000-02-29', -9223372036854775808, 0.1, 'Infinity', 'null', '\\x', '{}'),
  (1, 3, 'infinity', 'infinity', 'infinity', 1, -1, '-Infinity', '[]', NULL, NULL),
  (2, 1, '-infinity', '-infinity', '-infinity', NULL, NULL, NULL, NULL, NULL, NULL),
  (2, 2, '0044-03-15 12:00:00+00 BC', '0044-03-15 12:00:00 BC', '0044-03-15 BC', 2, 2, 2.5, '"s"', NULL, '{"x y"}'),
  (3, 1, '12345-01-01 00:00:00+00', '12345-01-01 00:00:00', '12345-01-01', 3, 3, -0.0, '{}', NULL, NULL),
  (3, 2, '1850-01-01 00:00:00-04:56:02', '1850-01-01 00:00:00', '1850-01-01', 4, 4, 1e300, '1', NULL, NULL),
  (3, 3, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL);
`;

describe('positional decode plan on PostgreSQL: temporal and value edge cases', () => {
  let db: TurbineClient;
  let schemaPg: SchemaMetadata;

  pgGate.before(async () => {
    const client = new pgDriver.Client({ connectionString: PG_URL! });
    await client.connect();
    try {
      await client.query(DDL);
    } finally {
      await client.end();
    }
    schemaPg = await introspect({ connectionString: PG_URL! });
    db = new TurbineClient(
      { connectionString: PG_URL!, poolSize: 2, warnOnUnlimited: false, temporalInfinity: 'preserve', logger: {} },
      schemaPg,
    );
    await db.connect();
  });

  pgGate.after(async () => {
    await db?.disconnect();
    const client = new pgDriver.Client({ connectionString: PG_URL! });
    await client.connect();
    try {
      await client.query(
        'DROP TABLE IF EXISTS decodeplan_children CASCADE; DROP TABLE IF EXISTS decodeplan_parents CASCADE;',
      );
    } finally {
      await client.end();
    }
  });

  const shapes: [string, WithClause][] = [
    ['to-many, every column', { decodeplanChildren: { orderBy: { ord: 'asc' } } } as WithClause],
    [
      'to-many with select, nested to-one back to the parent',
      {
        decodeplanChildren: {
          select: { ord: true, onDay: true, atTz: true, big: true },
          orderBy: { ord: 'desc' },
          with: { decodeplanParent: true },
        },
      } as WithClause,
    ],
    [
      'to-many with omit and a limit',
      { decodeplanChildren: { omit: { blob: true, doc: true }, orderBy: { ord: 'asc' }, limit: 2 } } as WithClause,
    ],
  ];

  for (const [label, withClause] of shapes) {
    pgGate.it(`${label}: plan, reference, object encoding and batched return identical rows`, async () => {
      const table = db.table('decodeplan_parents') as unknown as {
        buildFindMany(a: unknown): { sql: string; params: unknown[]; transform(r: unknown): unknown[] };
        findMany(a: unknown): Promise<unknown[]>;
        ctx: BuilderCtx;
      };
      const args = { orderBy: { id: 'asc' }, with: withClause };
      const deferred = table.buildFindMany(args);
      assert.match(deferred.sql, /json_build_array/, 'the default encoding is positional');
      const ctx = table.ctx;
      const relShapes = buildRelationShapes(ctx, 'decodeplan_parents', withClause, false);
      assert.ok(makePositionalRowParser(ctx, 'decodeplan_parents', relShapes), 'the plan declined this shape');

      const raw = await db.pool.query(deferred.sql, deferred.params as unknown[]);
      assert.equal(raw.rows.length, 4, 'fixture rows missing');
      const viaPlan = deferred.transform(raw);
      const viaReference = (raw.rows as Record<string, unknown>[]).map(makeReferencePositionalParser(ctx, relShapes));
      assertIdentical(viaPlan, viaReference, `${label}: plan vs reference`);

      const viaObject = await table.findMany({ ...args, jsonEncoding: 'object' });
      assertIdentical(viaPlan, viaObject, `${label}: positional vs object encoding`);
      const viaBatched = await table.findMany({ ...args, relationLoadStrategy: 'batched' });
      assertIdentical(viaPlan, viaBatched, `${label}: join vs batched`);

      // Anti-vacuity: the edge values really reached the decoder.
      const kids = (viaPlan as Record<string, unknown>[]).flatMap(
        (p) => p.decodeplanChildren as Record<string, unknown>[],
      );
      assert.ok(kids.length >= 6, 'too few child rows decoded');
      const days = kids.map((k) => k.onDay);
      assert.ok(
        days.some((d) => d === Number.POSITIVE_INFINITY || d === Number.NEGATIVE_INFINITY),
        'no infinity date decoded',
      );
      assert.ok(
        days.some((d) => d instanceof Date && d.getUTCFullYear() < 0),
        'no BC date decoded',
      );
      assert.ok(
        days.some((d) => d instanceof Date && d.getUTCFullYear() > 9999),
        'no five-digit year decoded',
      );
    });
  }
});
