/**
 * The object decode plan (`makeObjectRowParser`, query/relations.ts) against
 * the reference walker it replaces (`parseNestedRow`).
 *
 * The plan turns each keyed JSON relation object straight into its parsed row
 * in one pass, from the same per-shape plan the positional decoder runs. The
 * reference discovers relation keys per row, copies each row to decode its
 * JSON-wire columns, and runs the result through `parseRow`. The plan is only
 * worth having if its rows are the reference's rows, so every test here
 * compares the two STRICTLY: key order, prototypes, `Object.is` on every
 * primitive (NaN, -0), `getTime()` on every Date (Invalid Date included),
 * bytes on every Buffer, and on a throw the error class, code and message.
 *
 *   1. A seeded generative differential over random `with` shapes (select,
 *      omit, PII, depth, every cardinality incl. manyToMany and
 *      self-relations) and random object payloads, most of them well formed
 *      and the rest deliberately not (a payload that is not JSON, a to-many
 *      that is not an array, an array item inside a to-many, extra, missing
 *      and `__proto__` keys, `_count__` columns, a relation column missing),
 *      each payload in shape key order, in MySQL's sorted key order (length,
 *      then bytes), and reversed, on several client configurations.
 *   2. The declined shapes: each layout the shared planner refuses is
 *      refused here too, and the query still decodes through the reference.
 *   3. Real engines: SQLite in the unit lane, MySQL and PostgreSQL when
 *      their URLs are set. Plan, reference (over the SAME driver result),
 *      the other encoding where there is one, and the batched and flatten
 *      strategies return identical rows, middleware and query events
 *      observing, the second call served from the SQL-template cache.
 *
 * Every comparison asserts first that the plan was actually taken, because a
 * plan that silently declined would compare the reference with itself.
 */

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, test } from 'node:test';
import pgDriver from 'pg';
import { TurbineClient } from '../client.js';
import { introspect } from '../introspect.js';
import { mssqlDialect } from '../mssql.js';
import { introspectMysqlWith, MysqlPool, mysqlDialect, turbineMysql } from '../mysql.js';
import type { QueryInterfaceOptions } from '../query/deferred.js';
import { buildRelationShapes, makeNestedParser, makeObjectRowParser, parseNestedRow } from '../query/relations.js';
import type { WithClause } from '../query/types.js';
import { resetWarnOnce, WARN_NS } from '../query/warn-registry.js';
import type { BuilderCtx } from '../query/where.js';
import type { RelationDef, SchemaMetadata, TableMetadata } from '../schema.js';
import { defineSchema } from '../schema-builder.js';
import { schemaDefToMetadata } from '../schema-metadata.js';
import { schemaToSQL } from '../schema-sql.js';
import { sqliteDialect, turbineSqlite } from '../sqlite.js';
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

/**
 * Values-only comparison for the one cross-strategy check where the engines
 * themselves already disagree on presentation (MySQL: JSON key order, and a
 * BLOB arriving through JSON as a Uint8Array instead of a Buffer). Not used
 * for any plan-vs-reference comparison.
 */
function assertSameValues(actual: unknown, expected: unknown, path: string): void {
  if (actual === null || expected === null || typeof actual !== 'object' || typeof expected !== 'object') {
    assert.ok(Object.is(actual, expected), `${path}: ${String(actual)} vs ${String(expected)}`);
    return;
  }
  if (actual instanceof Date || expected instanceof Date) {
    assert.ok(actual instanceof Date && expected instanceof Date, `${path}: date vs non-date`);
    assert.ok(Object.is((actual as Date).getTime(), (expected as Date).getTime()), `${path}: dates differ`);
    return;
  }
  if (actual instanceof Uint8Array || expected instanceof Uint8Array) {
    assert.ok(actual instanceof Uint8Array && expected instanceof Uint8Array, `${path}: bytes vs non-bytes`);
    assert.deepEqual([...(actual as Uint8Array)], [...(expected as Uint8Array)], `${path}: bytes differ`);
    return;
  }
  const a = actual as Record<string, unknown>;
  const e = expected as Record<string, unknown>;
  assert.deepEqual(Object.keys(a).sort(), Object.keys(e).sort(), `${path}: key sets differ`);
  for (const key of Object.keys(a)) assertSameValues(a[key], e[key], `${path}.${key}`);
}

function assertSameOutcome(plan: Outcome, reference: Outcome, label: string): void {
  if (!reference.ok || !plan.ok) {
    // Compare the error snapshots only; a successful value may carry Invalid
    // Dates, which deepStrictEqual reports as unequal to themselves on
    // Node 20 even when both sides are the same outcome.
    assert.equal(plan.ok, reference.ok, `${label}: one side threw and the other did not`);
    assert.equal((plan as { error: string }).error, (reference as { error: string }).error, `${label}: errors differ`);
    return;
  }
  assertIdentical(plan.value, reference.value, label);
}

/**
 * A recording logger for the warning-order comparisons: each call is kept as
 * `code|table.field`, which is the observable part of a warning.
 */
function recordingLogger(logs: string[]) {
  return {
    warn: (_message: string, context?: { code?: string; table?: string; field?: string; relation?: string }) => {
      logs.push(`${context?.code ?? ''}|${context?.table ?? ''}.${context?.field ?? context?.relation ?? ''}`);
    },
  } as never;
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
  extra?: Partial<RelationDef>,
): RelationDef {
  return { type, name, from, to, foreignKey, referenceKey: 'id', ...extra };
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
          { name: 'mentor_id', field: 'mentorId' },
          { name: 'created_at', field: 'createdAt', pgType: 'timestamptz' },
          { name: 'born', field: 'born', pgType: 'date' },
          { name: 'email', field: 'email', pgType: 'text', pii: true },
        ],
        {
          profile: rel('hasOne', 'profile', 'authors', 'profiles', 'author_id'),
          posts: rel('hasMany', 'posts', 'authors', 'posts', 'author_id'),
          articles: rel('hasMany', 'articles', 'authors', 'posts', 'author_id'),
          mentor: rel('belongsTo', 'mentor', 'authors', 'authors', 'mentor_id'),
          mentees: rel('hasMany', 'mentees', 'authors', 'authors', 'mentor_id'),
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
          { name: 'views', field: 'views', pgType: 'int8' },
          { name: 'active', field: 'active', pgType: 'bool' },
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
          tags: rel('manyToMany', 'tags', 'posts', 'tags', 'post_id', {
            through: { table: 'post_tags', sourceKey: 'post_id', targetKey: 'tag_id' },
          }),
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
    tags: mockTable('tags', [
      { name: 'id', field: 'id' },
      { name: 'label', field: 'label', pgType: 'text' },
    ]),
  },
};

function ctxOf(options: QueryInterfaceOptions, logs?: string[]): BuilderCtx {
  const q = makeQuery('authors', schema, {
    warnOnUnlimited: false,
    logger: logs ? recordingLogger(logs) : {},
    diagnostics: { mode: 'development' },
    jsonEncoding: 'object',
    ...options,
  });
  return (q as unknown as { ctx: BuilderCtx }).ctx;
}

/** Run `fn` with a clean warn-once registry and an empty log, returning both. */
function withLogs<T>(logs: string[], fn: () => T): { value: Outcome; logs: string[] } {
  resetWarnOnce();
  logs.length = 0;
  const value = outcome(fn);
  return { value, logs: [...logs] };
}

/** The reference parser the plan is held to. */
function referenceOf(ctx: BuilderCtx): (row: Record<string, unknown>) => Record<string, unknown> {
  return (row) => parseNestedRow(ctx, row, 'authors');
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
  new Date(Date.UTC(2026, 6, 7, 17, 15, 41)),
  Buffer.from([0, 1, 254, 255]),
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

type KeyOrder = 'shape' | 'mysql' | 'reverse';
const KEY_ORDERS: readonly KeyOrder[] = ['shape', 'mysql', 'reverse'];

/** MySQL renders JSON object keys sorted by length, then bytewise. */
function orderKeys(keys: readonly string[], order: KeyOrder): string[] {
  if (order === 'mysql') return [...keys].sort((a, b) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0));
  if (order === 'reverse') return [...keys].reverse();
  return [...keys];
}

/** A keyed object for `shape`: one cell per key, nested slots recursing. */
function objectRow(rng: () => number, shape: ShapeLike, depth: number, order: KeyOrder): Record<string, unknown> {
  const cells = new Map<string, unknown>();
  for (const key of shape.keys) {
    const nested = shape.nested[key];
    cells.set(key, nested ? relationPayload(rng, nested, depth + 1, false, order) : scalar(rng));
  }
  // A missing key is absent for both; an unknown key (or a nested
  // `_count__` field) must take the reference fallback, identically.
  if (chance(rng, 0.04) && shape.keys.length > 1) cells.delete(pick(rng, shape.keys));
  if (chance(rng, 0.03)) cells.set('_count__posts', pick(rng, ['2', 2]));
  if (chance(rng, 0.03)) cells.set('extra_col', scalar(rng));
  const row: Record<string, unknown> = {};
  for (const key of orderKeys([...cells.keys()], order)) row[key] = cells.get(key);
  if (chance(rng, 0.01)) {
    Object.defineProperty(row, '__proto__', {
      value: scalar(rng),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return row;
}

/** A relation value: mostly well formed, sometimes deliberately not. */
function relationPayload(
  rng: () => number,
  shape: ShapeLike,
  depth: number,
  topLevel: boolean,
  order: KeyOrder,
): unknown {
  const r = rng();
  let value: unknown;
  if (r < 0.06) value = null;
  else if (r < 0.08) value = undefined;
  else if (r < 0.1) value = { id: 1, created_at: '2026-07-07T17:15:41+00:00' };
  else if (r < 0.11) value = 7;
  else if (r < 0.12) value = chance(rng, 0.5) ? 'null' : '[]';
  else if (r < 0.16) value = objectRow(rng, shape, depth, order);
  else if (shape.cardinality === 'one') value = objectRow(rng, shape, depth, order);
  else {
    const n = Math.floor(rng() * 4);
    const items: unknown[] = [];
    for (let i = 0; i < n; i++) {
      const q = rng();
      items.push(
        q < 0.04
          ? null
          : q < 0.07
            ? { id: 2, created_at: '2026-07-07 17:15:41' }
            : q < 0.09
              ? 'loose'
              : q < 0.11
                ? [1, 'positional-looking']
                : objectRow(rng, shape, depth, order),
      );
    }
    value = items;
  }
  // The driver hands the top-level json column over parsed or as text; a
  // nested slot is occasionally a string too, and occasionally not JSON.
  if (topLevel || chance(rng, 0.05)) {
    if (chance(rng, 0.03)) return '{"id": "unterminated';
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
    'views',
    'active',
    'moods',
    'data',
    'raw',
    'day',
    'stamps',
    'publishedAt',
    'createdAt',
  ],
  comments: ['id', 'postId', 'body', 'createdAt'],
  authors: ['id', 'name', 'mentorId', 'createdAt', 'born', 'email'],
  tags: ['id', 'label'],
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
  if (chance(rng, 0.2)) spec.orderBy = { id: chance(rng, 0.5) ? 'asc' : 'desc' };
  if (chance(rng, 0.15)) spec.limit = 2;
  if (chance(rng, 0.15)) spec.where = { id: { gt: 0 } };
  if (depth < 4) {
    const meta = schema.tables[table]!;
    const nested: Record<string, unknown> = {};
    for (const [name, def] of Object.entries(meta.relations)) {
      if (chance(rng, 0.4)) nested[name] = relationSpec(rng, def.to, depth + 1, includePii);
    }
    if (Object.keys(nested).length > 0) spec.with = nested;
  }
  return spec;
}

function withClauseFor(rng: () => number, includePii: boolean): WithClause {
  const clause: Record<string, unknown> = {};
  for (const [name, def] of Object.entries(schema.tables.authors!.relations)) {
    if (chance(rng, 0.6)) clause[name] = relationSpec(rng, def.to, 1, includePii);
  }
  if (chance(rng, 0.25)) clause._count = chance(rng, 0.5) ? true : { posts: true };
  if (Object.keys(clause).length === 0) clause.posts = true;
  return clause as WithClause;
}

function topRow(rng: () => number, shapes: Record<string, ShapeLike>, order: KeyOrder): Record<string, unknown> {
  const row: Record<string, unknown> = {
    id: pick(rng, [1, '9007199254740993', null]),
    name: scalar(rng),
    created_at: chance(rng, 0.7) ? new Date(Date.UTC(2026, 6, 7, 17, 15, 41)) : scalar(rng),
    born: chance(rng, 0.7) ? new Date(Date.UTC(1990, 0, 1)) : scalar(rng),
  };
  if (chance(rng, 0.2)) row._count__posts = pick(rng, ['3', 3, '0']);
  if (chance(rng, 0.1)) row._count__articles = pick(rng, ['1', 0]);
  for (const [name, shape] of Object.entries(shapes)) {
    // Missing entirely, as a relation the 'auto' strategy batched is.
    if (chance(rng, 0.05)) continue;
    row[name] = relationPayload(rng, shape, 1, true, order);
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

describe('object decode plan: generative differential against the reference', () => {
  for (const [label, options] of CONFIGS) {
    for (const seed of SEEDS) {
      test(`${label}, seed ${seed}: ${CASES} queries, rows identical to the reference`, () => {
        const rng = mulberry32(seed);
        const logs: string[] = [];
        const ctx = ctxOf(options, logs);
        assert.equal(ctx.jsonEncoding, 'object');
        const reference = referenceOf(ctx);
        let planned = 0;
        let comparedRows = 0;
        let nestedRows = 0;
        let thrown = 0;
        let dispatched = 0;
        for (let i = 0; i < CASES; i++) {
          const includePii = chance(rng, 0.2);
          const withClause = withClauseFor(rng, includePii);
          const repro = `seed=${seed} case=${i} config=${label} with=${JSON.stringify(withClause)}`;
          const shapes = buildRelationShapes(ctx, 'authors', withClause, includePii);
          const plan = makeObjectRowParser(ctx, 'authors', shapes);
          // This fixture has no colliding names, so every shape with a planned
          // relation must be planned: a decline would compare the reference
          // with itself. A bare `_count` plans nothing and stays reference.
          if (Object.keys(shapes).length > 0) {
            assert.ok(plan, `the plan declined a well-formed shape: ${repro}`);
            planned += 1;
          }
          const parser = plan ?? reference;
          for (let r = 0; r < 4; r++) {
            const order = KEY_ORDERS[(i + r) % KEY_ORDERS.length]!;
            if (order !== 'shape') dispatched += 1;
            const row = topRow(rng, shapes as unknown as Record<string, ShapeLike>, order);
            // Logger calls are part of the comparison (warning ORDER is a
            // documented effect), with the warn-once registry reset before
            // each side so neither side inherits the other's suppressions.
            const planRun = withLogs(logs, () => parser(structuredClone(row)));
            const fromPlan = planRun.value;
            const refRun = withLogs(logs, () => reference(structuredClone(row)));
            const fromReference = refRun.value;
            assertSameOutcome(fromPlan, fromReference, `${repro} row=${r} order=${order} input=${JSON.stringify(row)}`);
            assert.deepEqual(planRun.logs, refRun.logs, `${repro} row=${r} order=${order}: logger calls differ`);
            // The public seam must produce the same rows and log calls too.
            const seamRun = withLogs(logs, () =>
              makeNestedParser(ctx, withClause, includePii, null)(structuredClone(row)),
            );
            assertSameOutcome(seamRun.value, fromReference, `${repro} row=${r} order=${order} seam`);
            assert.deepEqual(seamRun.logs, refRun.logs, `${repro} row=${r} order=${order} seam: logger calls differ`);
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
        assert.ok(planned > CASES / 2, `only ${planned} of ${CASES} queries were planned`);
        // Anti-vacuity: rows were compared, nested rows were actually produced,
        // non-shape key orders ran, and the malformed-payload branch was reached.
        assert.ok(comparedRows > CASES, `only ${comparedRows} rows compared`);
        assert.ok(nestedRows > CASES, `only ${nestedRows} rows carried a decoded relation`);
        assert.ok(dispatched > CASES, `only ${dispatched} rows used a non-shape key order`);
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
    const plan = makeObjectRowParser(ctx, 'authors', shapes)!;
    for (const order of KEY_ORDERS) {
      const post: Record<string, unknown> = {};
      const cells: Record<string, unknown> = { id: 1, author: '{bad', comments: '[bad' };
      for (const key of orderKeys(['id', 'author', 'comments'], order)) post[key] = cells[key];
      const row = { id: 1, posts: [post] };
      const fromReference = outcome(() => referenceOf(ctx)(structuredClone(row)));
      assert.ok(!fromReference.ok && fromReference.error.includes('"comments"'), JSON.stringify(fromReference));
      assertSameOutcome(
        outcome(() => plan(structuredClone(row))),
        fromReference,
        `nested error order (${order})`,
      );
    }
  });

  // The plan reads a row by position, so an engine that sorts the keys of the
  // JSON objects it builds would compile it for every query and then send
  // every row to the walker. `jsonObjectKeysAsWritten` decides: MySQL builds
  // no plan at all, and decodes exactly as the reference does either way.
  for (const [engine, dialect, plans] of [
    ['postgresql', undefined, true],
    ['sqlite', sqliteDialect, true],
    ['mssql', mssqlDialect, true],
    ['mysql', mysqlDialect, false],
  ] as const) {
    test(`a plan is ${plans ? 'built' : 'not built'} on ${engine}, and rows decode as the reference does`, () => {
      const ctx = ctxOf(dialect ? { dialect } : {});
      assert.equal(ctx.dialect.capabilities.jsonObjectKeysAsWritten, plans);
      let planned = 0;
      const counting = new Proxy(ctx, {
        get(target, key) {
          if (key !== 'rowDecodePlan') return Reflect.get(target, key);
          return (table: string, keys: readonly string[]) => {
            planned++;
            return target.rowDecodePlan?.(table, keys);
          };
        },
      });
      const withClause = { posts: { with: { comments: true } } } as WithClause;
      const shapes = buildRelationShapes(ctx, 'authors', withClause, false) as unknown as Record<string, ShapeLike>;
      for (const order of KEY_ORDERS) {
        const row = topRow(mulberry32(11), shapes, order);
        const parse = makeNestedParser(counting, withClause, false, null);
        assertSameOutcome(
          outcome(() => parse(structuredClone(row))),
          outcome(() => referenceOf(ctx)(structuredClone(row))),
          `${engine} ${order}`,
        );
      }
      assert.equal(planned > 0, plans, `${engine}: ${planned} plan lookups`);
    });
  }

  test('mysql-sorted input keys stay sorted in the output, in every nested row', () => {
    const ctx = ctxOf({});
    const withClause = { posts: { with: { comments: true } } } as WithClause;
    const shapes = buildRelationShapes(ctx, 'authors', withClause, false);
    const plan = makeObjectRowParser(ctx, 'authors', shapes)!;
    const rng = mulberry32(7);
    const row = topRow(rng, shapes as unknown as Record<string, ShapeLike>, 'mysql');
    row.posts = [
      {
        id: 1,
        day: '2026-07-07',
        data: { a: 1 },
        title: 't',
        comments: [{ id: 5, body: 'b', postId: 1, createdAt: '2026-07-07T17:15:41+00:00' }],
        authorId: 1,
        createdAt: '2026-07-07T17:15:41+00:00',
        publishedAt: '2026-07-07 17:15:41',
      },
    ];
    // Re-sort the hand-built post into MySQL order so the input order is real.
    const post = (row.posts as Record<string, unknown>[])[0]!;
    const sorted: Record<string, unknown> = {};
    for (const key of orderKeys(Object.keys(post), 'mysql')) sorted[key] = post[key];
    row.posts = [sorted];
    const expected = referenceOf(ctx)(structuredClone(row));
    const got = plan(structuredClone(row));
    assertIdentical(got, expected, 'mysql order');
    const gotPost = (got.posts as Record<string, unknown>[])[0]!;
    assert.deepEqual(Object.keys(gotPost), orderKeys(Object.keys(post), 'mysql'));
  });

  test('a self-relation chain at depth eight decodes identically', () => {
    const ctx = ctxOf({});
    let withClause: Record<string, unknown> = { mentees: true };
    for (let d = 0; d < 7; d++) withClause = { mentees: { select: { id: true, name: true }, with: withClause } };
    const clause = withClause as WithClause;
    const shapes = buildRelationShapes(ctx, 'authors', clause, false);
    const plan = makeObjectRowParser(ctx, 'authors', shapes);
    assert.ok(plan, 'the plan declined the deep self-relation chain');
    let payload: Record<string, unknown> = { id: 8, name: 'leaf', mentees: [] };
    for (let d = 7; d >= 1; d--) payload = { id: d, name: `n${d}`, mentees: [payload] };
    const row = { id: 0, name: 'root', mentees: [payload] };
    assertIdentical(plan(structuredClone(row)), referenceOf(ctx)(structuredClone(row)), 'deep chain');
    // And as JSON text, which is how SQLite hands the column over.
    const textRow = { ...row, mentees: JSON.stringify([payload]) };
    assertIdentical(plan(structuredClone(textRow)), referenceOf(ctx)(structuredClone(textRow)), 'deep chain as text');
  });

  test('the parsed rows are not the input objects (the plan allocates its own rows)', () => {
    const ctx = ctxOf({});
    const shapes = buildRelationShapes(ctx, 'authors', { posts: { select: { id: true, title: true } } }, false);
    const plan = makeObjectRowParser(ctx, 'authors', shapes)!;
    const payload = [{ id: 1, title: 't' }];
    const row = { id: 1, name: 'a', posts: payload };
    const parsed = plan(row);
    assert.deepEqual(parsed, { id: 1, name: 'a', posts: [{ id: 1, title: 't' }] });
    assert.deepEqual(row.posts, [{ id: 1, title: 't' }], 'the driver row must not be mutated');
    assert.notEqual((parsed.posts as unknown[])[0], payload[0], 'the nested row must be a fresh object');
  });
});

// ---------------------------------------------------------------------------
// 1b. Key order: only a shape-order row is planned; the rest fall back, and
// stay fallen back for the rest of the result. Logger order included.
// ---------------------------------------------------------------------------

describe('object decode plan: key order, sticky fallback and logger order', () => {
  const postsWith = { posts: { select: { id: true, publishedAt: true, createdAt: true } } } as WithClause;

  function postIn(keysInOrder: readonly string[]): Record<string, unknown> {
    const values: Record<string, unknown> = { id: 1, publishedAt: 'infinity', createdAt: '-infinity' };
    const post: Record<string, unknown> = {};
    for (const key of keysInOrder) post[key] = values[key];
    return post;
  }

  /** The temporal fields of `keys`, in that key order: the warning order the reference produces. */
  function expectedFieldWarnings(keysInOrder: readonly string[]): string[] {
    return keysInOrder
      .filter((k) => k === 'publishedAt' || k === 'createdAt')
      .map((k) => `temporal-infinity|posts.${k}`);
  }

  test('mixed in-order and out-of-order rows of one shape, in both arrival orders, match the reference on rows and logger calls', () => {
    const sequences: [string, ('shape' | 'reverse')[]][] = [
      ['ordered, permuted, ordered', ['shape', 'reverse', 'shape']],
      ['permuted, ordered', ['reverse', 'shape']],
      ['permuted only', ['reverse']],
    ];
    for (const [label, sequence] of sequences) {
      const logs: string[] = [];
      const ctx = ctxOf({}, logs);
      const shapes = buildRelationShapes(ctx, 'authors', postsWith, false);
      const keys = shapes.posts!.keys;
      assert.ok(
        keys.includes('publishedAt') && keys.includes('createdAt'),
        `fixture shape lost its temporal fields: ${keys}`,
      );
      const rows = sequence.map((order) => ({
        id: 1,
        posts: [postIn(order === 'shape' ? keys : [...keys].reverse())],
      }));
      const runAll = (parser: (r: Record<string, unknown>) => Record<string, unknown>) => () =>
        rows.map((r) => parser(structuredClone(r)));
      const plan = makeObjectRowParser(ctx, 'authors', shapes);
      assert.ok(plan, 'the plan declined the fixture shape');
      const planRun = withLogs(logs, runAll(plan));
      const refRun = withLogs(logs, runAll(referenceOf(ctx)));
      assert.ok(planRun.value.ok && refRun.value.ok, label);
      assertIdentical(
        (planRun.value as { value: unknown }).value,
        (refRun.value as { value: unknown }).value,
        `sticky ${label}: rows`,
      );
      assert.deepEqual(planRun.logs, refRun.logs, `sticky ${label}: logger calls differ`);
      // The first row's key order sets the warning order on the reference,
      // and the plan must not reorder it.
      const firstKeys = sequence[0] === 'shape' ? keys : [...keys].reverse();
      assert.deepEqual(refRun.logs, expectedFieldWarnings(firstKeys), `sticky ${label}: reference expectation drifted`);
      // Output key order is the input order of each row, permuted included.
      const outRows = (planRun.value as { value: Record<string, unknown>[] }).value;
      for (const [i, order] of sequence.entries()) {
        const wanted = order === 'shape' ? keys : [...keys].reverse();
        assert.deepEqual(
          Object.keys((outRows[i]!.posts as Record<string, unknown>[])[0]!),
          wanted,
          `sticky ${label} row ${i}: key order`,
        );
      }
    }
  });

  test('lazy plan construction: building the parser emits nothing and a construction failure falls back', () => {
    const logs: string[] = [];
    const ctx = ctxOf({}, logs);
    // An invalid nested projection: constructing the parser must not throw
    // and must not log; the invalid shape is the statement build's to
    // report, ahead of any decode. If a row still arrives, decoding falls
    // back to the reference for that query.
    const bad = { posts: { select: { nope: true } } } as unknown as WithClause;
    let parser: (row: Record<string, unknown>) => Record<string, unknown>;
    resetWarnOnce();
    logs.length = 0;
    assert.doesNotThrow(() => {
      parser = makeNestedParser(ctx, bad, false, null);
    });
    assert.deepEqual(logs, [], 'parser construction logged');
    const shapes = buildRelationShapes(ctx, 'authors', postsWith, false);
    const row = { id: 1, posts: [postIn(shapes.posts!.keys)] };
    assertIdentical(
      parser!(structuredClone(row)),
      referenceOf(ctx)(structuredClone(row)),
      'fallback after failed construction',
    );
  });

  test('a mock pool handing over reversed nested keys warns in input order (unit lane)', async () => {
    const logs: string[] = [];
    const shapes = buildRelationShapes(ctxOf({}), 'authors', postsWith, false);
    const keys = shapes.posts!.keys;
    const reversed = [...keys].reverse();
    const canned = [{ id: 1, name: 'a', posts: [postIn(reversed)] }];
    const pool = {
      async query() {
        return { rows: structuredClone(canned), rowCount: canned.length, fields: [] };
      },
      async connect() {
        return { query: async () => ({ rows: [], rowCount: 0, fields: [] }), release() {} };
      },
      async end() {},
    };
    const db = new TurbineClient(
      { pool, logger: recordingLogger(logs), diagnostics: { mode: 'development' }, warnOnUnlimited: false } as never,
      schema,
    );
    resetWarnOnce();
    logs.length = 0;
    const rows = (await db.table('authors').findMany({
      limit: 1,
      relationLoadStrategy: 'join',
      jsonEncoding: 'object',
      with: postsWith,
    } as never)) as Record<string, unknown>[];
    assert.deepEqual(logs, expectedFieldWarnings(reversed), 'warnings must follow the input (reversed) key order');
    const post = (rows[0]!.posts as Record<string, unknown>[])[0]!;
    assert.deepEqual(Object.keys(post), reversed, 'output keys must stay in input order');
    assert.ok(Object.is(post.publishedAt, Number.POSITIVE_INFINITY), 'publishedAt must decode to +Infinity');
    assert.ok(Object.is(post.createdAt, Number.NEGATIVE_INFINITY), 'createdAt must decode to -Infinity');
  });
});

// ---------------------------------------------------------------------------
// 1c. The empty relation values as JSON text: `'null'` for a to-one and `'[]'`
// for a to-many, the exact strings MySQL hands over for a missing row and an
// empty list. The reference answers both without parsing; so must the plan.
// ---------------------------------------------------------------------------

describe('object decode plan: an empty relation sent as the text null or []', () => {
  const withClause = {
    profile: { select: { id: true, bio: true } },
    posts: { select: { id: true, title: true } },
    mentor: { select: { id: true, name: true } },
  } as WithClause;

  /** Run `fn`, returning its result and every string `JSON.parse` was handed meanwhile. */
  function parsesDuring<T>(fn: () => T): { value: T; parsed: string[] } {
    const parsed: string[] = [];
    const original = JSON.parse;
    JSON.parse = ((text: string, reviver?: Parameters<typeof JSON.parse>[1]) => {
      parsed.push(text);
      return original(text, reviver);
    }) as typeof JSON.parse;
    try {
      return { value: fn(), parsed };
    } finally {
      JSON.parse = original;
    }
  }

  const rows: [string, Record<string, unknown>][] = [
    ["to-one 'null', to-many '[]'", { id: 1, name: 'a', profile: 'null', posts: '[]', mentor: 'null' }],
    ["to-many '[]' beside a real to-one", { id: 2, name: 'b', profile: '{"id":3,"bio":"x"}', posts: '[]' }],
    ["to-one 'null' beside a real to-many", { id: 3, name: 'c', posts: '[{"id":4,"title":"t"}]', mentor: 'null' }],
  ];

  for (const [label, row] of rows) {
    test(`${label}: the plan's rows and parse work are the reference's`, () => {
      const ctx = ctxOf({});
      const plan = makeObjectRowParser(ctx, 'authors', buildRelationShapes(ctx, 'authors', withClause, false));
      assert.ok(plan, 'the plan declined the shape');
      const planned = parsesDuring(() => plan(structuredClone(row)));
      const reference = parsesDuring(() => referenceOf(ctx)(structuredClone(row)));
      assertIdentical(planned.value, reference.value, label);
      // The shortcut is the reference's: neither text reaches JSON.parse on
      // either path, so the plan does the same work it does.
      assert.deepEqual(planned.parsed, reference.parsed, `${label}: JSON.parse calls differ from the reference`);
      for (const text of ['null', '[]']) {
        assert.ok(!planned.parsed.includes(text), `${label}: the plan parsed ${JSON.stringify(text)}`);
      }
    });
  }

  test("the decoded values: 'null' is null and '[]' is a fresh empty array", () => {
    const ctx = ctxOf({});
    const plan = makeObjectRowParser(ctx, 'authors', buildRelationShapes(ctx, 'authors', withClause, false))!;
    const parsed = plan({ id: 1, name: 'a', profile: 'null', posts: '[]', mentor: 'null' });
    assert.equal(parsed.profile, null);
    assert.equal(parsed.mentor, null);
    assert.deepEqual(parsed.posts, []);
    const again = plan({ id: 2, name: 'b', profile: 'null', posts: '[]', mentor: 'null' });
    assert.notEqual(again.posts, parsed.posts, 'each row must get its own empty array');
  });
});

// ---------------------------------------------------------------------------
// 2. Declined shapes, and `_count`
// ---------------------------------------------------------------------------

describe('object decode plan: shapes it declines still decode through the reference', () => {
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

  const declined: [string, SchemaMetadata, WithClause][] = [
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
      'a column field that resolves through Object.prototype',
      oneTable([
        { name: 'id', field: 'id' },
        { name: 'constructor', field: 'constructor', pgType: 'text' },
      ]),
      { items: true },
    ],
    [
      'a `__proto__` column field',
      oneTable([
        { name: 'id', field: 'id' },
        { name: '__proto__', field: '__proto__', pgType: 'text' },
      ]),
      { items: true },
    ],
  ];

  for (const [label, s, withClause] of declined) {
    test(`${label}: declined, and the query decodes as the reference does`, () => {
      const q = makeQuery('users', s, { warnOnUnlimited: false, logger: {}, jsonEncoding: 'object' });
      const ctx = (q as unknown as { ctx: BuilderCtx }).ctx;
      const shapes = buildRelationShapes(ctx, 'users', withClause, false);
      assert.equal(makeObjectRowParser(ctx, 'users', shapes), undefined, 'the plan should have declined');
      const keys = shapes.items!.keys;
      const item: Record<string, unknown> = {};
      for (const [i, key] of keys.entries()) {
        Object.defineProperty(item, key, { value: `v${i}`, enumerable: true, writable: true, configurable: true });
      }
      const row: Record<string, unknown> = { id: 1, items: [item] };
      const parser = makeNestedParser(ctx, withClause, false, null);
      const reference = (r: Record<string, unknown>) => parseNestedRow(ctx, r, 'users');
      assertSameOutcome(
        outcome(() => parser(structuredClone(row))),
        outcome(() => reference(structuredClone(row))),
        label,
      );
    });
  }

  test('a top-level relation named like a column is planned, and identical', () => {
    // The object plan needs no top-level collision decline (the positional
    // one does): both it and the reference run the scalar half over the raw
    // row and replace the relation slot after.
    const s = oneTable([{ name: 'id', field: 'id' }], { id: rel('hasMany', 'id', 'users', 'items', 'user_id') });
    const withClause = { items: true, id: true } as WithClause;
    const q = makeQuery('users', s, { warnOnUnlimited: false, logger: {}, jsonEncoding: 'object' });
    const ctx = (q as unknown as { ctx: BuilderCtx }).ctx;
    const shapes = buildRelationShapes(ctx, 'users', withClause, false);
    const plan = makeObjectRowParser(ctx, 'users', shapes);
    assert.ok(plan, 'the object plan should take this shape');
    const reference = (r: Record<string, unknown>) => parseNestedRow(ctx, r, 'users');
    for (const row of [
      { id: '[]', items: [{ id: 'a', userId: 'b' }] },
      { id: 1, items: [{ id: 'a', userId: 'b' }] },
      { id: '[{"id":"x"}]', items: '[]' },
    ]) {
      assertSameOutcome(
        outcome(() => plan(structuredClone(row))),
        outcome(() => reference(structuredClone(row))),
        JSON.stringify(row),
      );
    }
  });

  test('a bare `_count` plans nothing; `_count` beside relations folds identically', () => {
    const ctx = ctxOf({});
    const reference = referenceOf(ctx);
    const countOnly = { _count: { posts: true } } as WithClause;
    const countShapes = buildRelationShapes(ctx, 'authors', countOnly, false);
    assert.equal(
      makeObjectRowParser(ctx, 'authors', countShapes),
      undefined,
      'a bare _count must stay on the reference',
    );
    const rows: Record<string, unknown>[] = [
      { id: 1, name: 'a', _count__posts: '3' },
      { id: 2, name: 'b', _count__posts: 0, _count__articles: '12' },
      { id: 3, name: 'c' },
    ];
    for (const row of rows) {
      assertIdentical(
        makeNestedParser(ctx, countOnly, false, null)(structuredClone(row)),
        reference(structuredClone(row)),
        'count only',
      );
    }
    const mixed = { posts: { select: { id: true, title: true } }, _count: true } as WithClause;
    const mixedShapes = buildRelationShapes(ctx, 'authors', mixed, false);
    const plan = makeObjectRowParser(ctx, 'authors', mixedShapes);
    assert.ok(plan, 'relations beside _count should be planned');
    const mixedRows: Record<string, unknown>[] = [
      { id: 1, _count__posts: '2', _count__articles: 1, posts: [{ id: 9, title: 'x' }] },
      { id: 2, _count__posts: 0, posts: '[]' },
      { id: 3, posts: [{ title: 'no id', id: 4 }] },
    ];
    for (const row of mixedRows) {
      assertIdentical(
        plan(structuredClone(row)),
        reference(structuredClone(row)),
        `count+relations ${JSON.stringify(row)}`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Real engines
// ---------------------------------------------------------------------------

interface TableLike {
  buildFindMany(a: unknown): { sql: string; params: unknown[]; transform(r: unknown): unknown[] };
  findMany(a: unknown): Promise<unknown[]>;
  findUnique(a: unknown): Promise<unknown>;
  createMany(a: unknown): Promise<unknown>;
  ctx: BuilderCtx;
}

/**
 * The engine comparison every section below runs: the statement's own
 * transform (the plan) and the reference walker over the SAME driver result,
 * then the public call a second time (the SQL-template cache hit), then the
 * batched strategy. All must be the same rows, strictly.
 */
async function assertEngineIdentical(
  db: { pool: { query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> } },
  table: TableLike,
  tableName: string,
  args: Record<string, unknown>,
  label: string,
  // MySQL sorts JSON object keys, so there the join strategy's nested rows
  // and the batched strategy's flat rows already disagree on key ORDER in
  // the reference walker. The plan must preserve the join order; the
  // batched comparison there is on values only.
  batchedOrderSensitive = true,
): Promise<unknown[]> {
  const deferred = table.buildFindMany(args);
  const ctx = table.ctx;
  const withClause = args.with as WithClause;
  const shapes = buildRelationShapes(ctx, tableName, withClause, false);
  assert.ok(makeObjectRowParser(ctx, tableName, shapes), `${label}: the object plan declined this shape`);
  const raw = await db.pool.query(deferred.sql, deferred.params);
  assert.ok(raw.rows.length > 0, `${label}: fixture rows missing`);
  const viaPlan = deferred.transform(raw);
  const viaReference = raw.rows.map((r) => parseNestedRow(ctx, r, tableName));
  assertIdentical(viaPlan, viaReference, `${label}: plan vs reference over the same driver result`);
  const viaPublic = await table.findMany(args);
  assertIdentical(viaPublic, viaReference, `${label}: public call`);
  const viaCache = await table.findMany(args);
  assertIdentical(viaCache, viaReference, `${label}: template-cache hit`);
  const viaBatched = await table.findMany({ ...args, relationLoadStrategy: 'batched' });
  if (batchedOrderSensitive) assertIdentical(viaBatched, viaReference, `${label}: batched strategy`);
  else
    assertSameValues(viaBatched, viaReference, `${label}: batched strategy (values; presentation differs by engine)`);
  return viaPlan;
}

// ---- SQLite (unit lane) ----------------------------------------------------

const haveSqlite = (() => {
  try {
    createRequire(process.cwd())('node:sqlite');
    return true;
  } catch {
    return false;
  }
})();
const sqliteGate = skipGate(!haveSqlite, 'requires node:sqlite (Node >= 22.5)');

const SQLITE_DEF = defineSchema({
  odp_authors: {
    id: { type: 'integer', primaryKey: true },
    name: { type: 'text', notNull: true },
    joinedAt: { type: 'timestamp' },
    score: { type: 'double' },
  },
  odp_posts: {
    id: { type: 'integer', primaryKey: true },
    authorId: { type: 'integer', notNull: true, references: 'odp_authors.id' },
    title: { type: 'text', notNull: true },
    active: { type: 'boolean', notNull: true },
    prefs: { type: 'json' },
    big: { type: 'bigint' },
    amount: { type: 'numeric' },
    ratio: { type: 'double' },
    stamp: { type: 'timestamp' },
    day: { type: 'date' },
    data: { type: 'bytea' },
  },
  odp_comments: {
    id: { type: 'integer', primaryKey: true },
    postId: { type: 'integer', notNull: true, references: 'odp_posts.id' },
    body: { type: 'text', notNull: true },
    at: { type: 'timestamp' },
  },
} as never);
const SQLITE_SCHEMA = schemaDefToMetadata(SQLITE_DEF);

describe('object decode plan on SQLite', () => {
  let db: TurbineClient;
  let rawHandle: { close(): void } | undefined;
  // biome-ignore lint/suspicious/noExplicitAny: tables are driven by name, with no generated types
  const tbl = (name: string): TableLike & Record<string, any> => db.table(name) as never;

  sqliteGate.before(async () => {
    const { DatabaseSync } = createRequire(process.cwd())('node:sqlite') as typeof import('node:sqlite');
    const raw = new DatabaseSync(':memory:');
    rawHandle = raw;
    for (const sql of schemaToSQL(SQLITE_DEF, { dialect: sqliteDialect })) raw.exec(sql);
    db = turbineSqlite(raw as never, SQLITE_SCHEMA, { warnOnUnlimited: false });
    const stamp = new Date(Date.UTC(2026, 6, 7, 17, 15, 41, 896));
    await tbl('odp_authors').createMany({
      data: [
        { id: 1, name: 'a', joinedAt: stamp, score: 0.1 + 0.2 },
        { id: 2, name: 'b', joinedAt: null, score: null },
        { id: 3, name: 'empty', joinedAt: stamp, score: -0 },
      ],
    });
    await tbl('odp_posts').createMany({
      data: [
        {
          id: 1,
          authorId: 1,
          title: 'p1',
          active: true,
          prefs: { theme: 'dark', tags: ['x'] },
          big: 9007199254740993n,
          amount: '12345678901234567890.123',
          ratio: 1e-300,
          stamp,
          day: stamp,
          data: Buffer.from([0, 1, 254, 255]),
        },
        {
          id: 2,
          authorId: 1,
          title: 'p2',
          active: false,
          prefs: [1, null],
          big: null,
          amount: null,
          ratio: null,
          stamp: null,
          day: null,
          data: null,
        },
        {
          id: 3,
          authorId: 2,
          title: 'p3',
          active: true,
          prefs: null,
          big: -42n,
          amount: '-7.5',
          ratio: Number.POSITIVE_INFINITY,
          stamp,
          day: stamp,
          data: Buffer.from([]),
        },
      ],
    });
    await tbl('odp_comments').createMany({
      data: [
        { id: 1, postId: 1, body: 'c1', at: stamp },
        { id: 2, postId: 1, body: 'c2', at: null },
        { id: 3, postId: 3, body: 'c3', at: stamp },
      ],
    });
  });

  sqliteGate.after(async () => {
    await db?.disconnect();
    rawHandle?.close();
  });

  sqliteGate.it('authors with posts, comments and _count: plan, reference, cache and batched agree', async () => {
    const rows = await assertEngineIdentical(
      db,
      tbl('odp_authors'),
      'odp_authors',
      {
        orderBy: { id: 'asc' },
        with: {
          odpPosts: { orderBy: { id: 'asc' }, with: { odpComments: { orderBy: { id: 'asc' } } } },
          _count: { odpPosts: true },
        },
      },
      'sqlite authors',
    );
    const first = (rows as Record<string, unknown>[])[0]!;
    assert.deepEqual(first._count, { odpPosts: 2 });
    const posts = first.odpPosts as Record<string, unknown>[];
    assert.equal(posts[0]!.active, true, 'boolean-as-integer did not decode');
    assert.ok(posts[0]!.stamp instanceof Date, 'timestamp did not decode');
  });

  sqliteGate.it(
    'posts with a to-one author under select: plan, reference, cache, batched and flatten agree',
    async () => {
      const args = {
        orderBy: { id: 'asc' },
        with: { odpAuthor: { select: { id: true, name: true, joinedAt: true } } },
      };
      const rows = await assertEngineIdentical(db, tbl('odp_posts'), 'odp_posts', args, 'sqlite posts');
      const viaFlatten = await tbl('odp_posts').findMany({ ...args, relationLoadStrategy: 'flatten' });
      assertIdentical(viaFlatten, rows, 'sqlite posts: flatten strategy');
    },
  );

  sqliteGate.it('middleware and a query listener observe the planned call; rows unchanged', async () => {
    const seen: string[] = [];
    const events: { sql: string }[] = [];
    db.$use(async (params, next) => {
      seen.push(`${params.model ?? ''}.${params.action ?? ''}`);
      return next(params);
    });
    const listener = (e: { sql: string }): void => {
      events.push(e);
    };
    db.$on('query', listener as never);
    try {
      const args = { orderBy: { id: 'asc' }, with: { odpPosts: { orderBy: { id: 'asc' } } } };
      const rows = await tbl('odp_authors').findMany(args);
      const table = tbl('odp_authors');
      const shapes = buildRelationShapes(table.ctx, 'odp_authors', args.with as WithClause, false);
      assert.ok(makeObjectRowParser(table.ctx, 'odp_authors', shapes), 'plan declined');
      const deferred = table.buildFindMany(args);
      const raw = await db.pool.query(deferred.sql, deferred.params);
      assertIdentical(
        rows,
        raw.rows.map((r) => parseNestedRow(table.ctx, r, 'odp_authors')),
        'middleware-observed rows',
      );
    } finally {
      db.$off('query', listener as never);
    }
    assert.ok(seen.length >= 1, 'middleware did not observe the call');
    assert.ok(events.length >= 1, 'query listener did not observe the call');
  });

  sqliteGate.it('findUnique with relations and an empty to-many agree', async () => {
    const table = tbl('odp_authors');
    const one = (await table.findUnique({ where: { id: 3 }, with: { odpPosts: true } })) as Record<
      string,
      unknown
    > | null;
    assert.ok(one);
    assert.deepEqual(one.odpPosts, []);
    const miss = await table.findUnique({ where: { id: 99 }, with: { odpPosts: true } });
    assert.equal(miss, null);
  });
});

// ---- PostgreSQL, object encoding -------------------------------------------

const PG_URL = process.env.DATABASE_URL;
const pgGate = skipGate(!PG_URL, 'DATABASE_URL not set');

const PG_DDL = `
DROP TABLE IF EXISTS objectplan_children CASCADE;
DROP TABLE IF EXISTS objectplan_parents CASCADE;
CREATE TABLE objectplan_parents (
  id      BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  label   TEXT NOT NULL,
  made_at TIMESTAMPTZ
);
CREATE TABLE objectplan_children (
  id        BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  parent_id BIGINT NOT NULL REFERENCES objectplan_parents(id),
  ord       INTEGER NOT NULL,
  at_tz     TIMESTAMPTZ,
  at_local  TIMESTAMP,
  on_day    DATE,
  big       BIGINT,
  amount    NUMERIC(30,10),
  score     DOUBLE PRECISION,
  flag      BOOLEAN,
  doc       JSONB,
  blob      BYTEA,
  tags      TEXT[]
);
CREATE INDEX ON objectplan_children(parent_id);
INSERT INTO objectplan_parents (label, made_at) VALUES
  ('a', '2026-07-07 17:15:41.896+00'), ('b', NULL), ('c', 'infinity'), ('empty', '0044-03-15 12:00:00+00 BC');
INSERT INTO objectplan_children (parent_id, ord, at_tz, at_local, on_day, big, amount, score, flag, doc, blob, tags) VALUES
  (1, 1, '2026-07-07 17:15:41.896+00', '2026-07-07 17:15:41.896', '2026-07-07', 9007199254740993, 12345678901234567890.0123456789, 'NaN', true, '{"k":[1,2]}', '\\xdeadbeef', '{a,b}'),
  (1, 2, '2026-01-01 00:00:00.000001+05:30', '1999-12-31 23:59:59.999999', '2000-02-29', -9223372036854775808, 0.1, 'Infinity', false, 'null', '\\x', '{}'),
  (1, 3, 'infinity', 'infinity', 'infinity', 1, -1, '-Infinity', NULL, '[]', NULL, NULL),
  (2, 1, '-infinity', '-infinity', '-infinity', NULL, NULL, NULL, NULL, NULL, NULL, NULL),
  (2, 2, '0044-03-15 12:00:00+00 BC', '0044-03-15 12:00:00 BC', '0044-03-15 BC', 2, 2, 2.5, true, '"s"', NULL, '{"x y"}'),
  (3, 1, '12345-01-01 00:00:00+00', '12345-01-01 00:00:00', '12345-01-01', 3, 3, -0.0, false, '{}', NULL, NULL),
  (3, 2, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL);
`;

describe('object decode plan on PostgreSQL (object encoding)', () => {
  // A database of this section's own, for the same reason as the MySQL
  // section: nothing here may appear in another suite's introspection.
  const PG_DB = 'turbine_odp_test';
  let db: TurbineClient;
  let schemaPg: SchemaMetadata;
  let pgOdpUrl: string;

  async function pgAdmin(sql: string): Promise<void> {
    const client = new pgDriver.Client({ connectionString: PG_URL! });
    await client.connect();
    try {
      await client.query(sql);
    } finally {
      await client.end();
    }
  }

  pgGate.before(async () => {
    await pgAdmin(`DROP DATABASE IF EXISTS ${PG_DB} WITH (FORCE)`);
    await pgAdmin(`CREATE DATABASE ${PG_DB}`);
    const u = new URL(PG_URL!);
    u.pathname = `/${PG_DB}`;
    pgOdpUrl = u.toString();
    const client = new pgDriver.Client({ connectionString: pgOdpUrl });
    await client.connect();
    try {
      await client.query(PG_DDL);
    } finally {
      await client.end();
    }
    schemaPg = await introspect({ connectionString: pgOdpUrl });
    db = new TurbineClient(
      { connectionString: pgOdpUrl, poolSize: 2, warnOnUnlimited: false, temporalInfinity: 'preserve', logger: {} },
      schemaPg,
    );
    await db.connect();
  });

  pgGate.after(async () => {
    try {
      await db?.disconnect();
    } finally {
      // Even when a test above failed.
      await pgAdmin(`DROP DATABASE IF EXISTS ${PG_DB} WITH (FORCE)`);
    }
  });

  const shapes: [string, WithClause][] = [
    [
      'to-many, every column, with _count',
      { objectplanChildren: { orderBy: { ord: 'asc' } }, _count: true } as WithClause,
    ],
    [
      'to-many with select, nested to-one back to the parent',
      {
        objectplanChildren: {
          select: { ord: true, onDay: true, atTz: true, big: true },
          orderBy: { ord: 'desc' },
          with: { objectplanParent: true },
        },
      } as WithClause,
    ],
    [
      'to-many with omit, a limit and a where',
      {
        objectplanChildren: {
          omit: { blob: true, doc: true },
          orderBy: { ord: 'asc' },
          limit: 2,
          where: { ord: { gte: 1 } },
        },
      } as WithClause,
    ],
  ];

  for (const [label, withClause] of shapes) {
    pgGate.it(`${label}: plan, reference, cache, batched and the positional encoding agree`, async () => {
      const table = db.table('objectplan_parents') as unknown as TableLike;
      const args = { orderBy: { id: 'asc' }, with: withClause, jsonEncoding: 'object' as const };
      const deferred = table.buildFindMany(args);
      assert.match(deferred.sql, /json_build_object/, 'the object encoding was not used');
      const rows = await assertEngineIdentical(db, table, 'objectplan_parents', args, `pg ${label}`);
      const viaPositional = await table.findMany({ orderBy: { id: 'asc' }, with: withClause });
      assertIdentical(rows, viaPositional, `pg ${label}: object vs positional encoding`);
      // Anti-vacuity: the edge values really reached the decoder.
      const kids = (rows as Record<string, unknown>[]).flatMap(
        (p) => p.objectplanChildren as Record<string, unknown>[],
      );
      assert.ok(kids.length >= 4, 'too few child rows decoded');
    });
  }

  pgGate.it('a supplied pool whose JSON parser reverses nested keys warns in input order', async () => {
    // The child at ord 3 carries infinity in at_tz and at_local. With the
    // nested row's keys reversed by the caller's own JSON parser (a
    // documented pg extension point), the reference decodes in that
    // reversed order, so its temporal warnings come out reversed too.
    const logs: string[] = [];
    const flip = (v: unknown): unknown => {
      if (Array.isArray(v)) return v.map(flip);
      if (v !== null && typeof v === 'object') {
        return Object.fromEntries(
          Object.entries(v as Record<string, unknown>)
            .reverse()
            .map(([k, x]) => [k, flip(x)]),
        );
      }
      return v;
    };
    const builtinJson = pgDriver.types.getTypeParser(114, 'text');
    const supplied = new pgDriver.Pool({
      connectionString: pgOdpUrl,
      max: 2,
      types: {
        getTypeParser: (oid: number, format?: string) => {
          const fallback = pgDriver.types.getTypeParser(oid, format as never);
          if (oid !== 114) return fallback;
          return (text: unknown) => (typeof text !== 'string' ? fallback(text as never) : flip(builtinJson(text)));
        },
      } as never,
    });
    const custom = new TurbineClient(
      {
        pool: supplied,
        logger: recordingLogger(logs),
        diagnostics: { mode: 'development' },
        warnOnUnlimited: false,
      } as never,
      schemaPg,
    );
    try {
      const table = custom.table('objectplan_parents') as unknown as TableLike;
      const withClause = {
        objectplanChildren: { select: { ord: true, atTz: true, atLocal: true }, orderBy: { ord: 'asc' } },
      } as WithClause;
      const shapes = buildRelationShapes(table.ctx, 'objectplan_parents', withClause, false);
      const shapeKeys = shapes.objectplanChildren!.keys;
      const expected = [...shapeKeys]
        .reverse()
        .filter((k) => k === 'atTz' || k === 'atLocal')
        .map((k) => `temporal-infinity|objectplan_children.${k}`);
      resetWarnOnce(WARN_NS.temporalInfinity);
      logs.length = 0;
      const rows = (await custom
        .table('objectplan_parents')
        .findMany({ orderBy: { id: 'asc' }, with: withClause, jsonEncoding: 'object' } as never)) as Record<
        string,
        unknown
      >[];
      // The parents' own infinity column warns too; the nested-row fields
      // are the part whose order the key reversal decides.
      assert.deepEqual(
        logs.filter((l) => l.includes('objectplan_children.')),
        expected,
        'warnings must follow the reversed (input) key order',
      );
      // And the rows are the reference's rows for the same driver output.
      const deferred = table.buildFindMany({ orderBy: { id: 'asc' }, with: withClause, jsonEncoding: 'object' });
      const raw = await (
        custom as never as { pool: { query(s: string, p?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> } }
      ).pool.query(deferred.sql, deferred.params);
      assertIdentical(
        rows,
        raw.rows.map((r) => parseNestedRow(table.ctx, r, 'objectplan_parents')),
        'custom parser rows',
      );
    } finally {
      await custom.disconnect();
      await supplied.end().catch(() => {});
    }
  });

  pgGate.it('streams with an invalid nested projection behave as the statement build dictates', async () => {
    // No index on the child foreign key, so a valid relation build warns
    // unindexed-relation; the parser construction must not pre-empt that.
    const setup = new pgDriver.Client({ connectionString: pgOdpUrl });
    await setup.connect();
    try {
      await setup.query(`
        DROP TABLE IF EXISTS odps_child, odps_parent CASCADE;
        CREATE TABLE odps_parent (id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, name TEXT NOT NULL);
        CREATE TABLE odps_child (id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, parent_id BIGINT NOT NULL REFERENCES odps_parent(id), label TEXT NOT NULL);
        INSERT INTO odps_parent (name) VALUES ('one'), ('two');
        INSERT INTO odps_child (parent_id, label) VALUES (1, 'a'), (1, 'b'), (2, 'c');
      `);
    } finally {
      await setup.end();
    }
    const streamSchema = await introspect({ connectionString: pgOdpUrl });
    const relName = Object.keys(streamSchema.tables.odps_parent!.relations)[0]!;
    const codes: string[] = [];
    let acquired = 0;
    let sent = 0;
    const supplied = new pgDriver.Pool({ connectionString: pgOdpUrl, max: 1 });
    const counting = {
      query: async (...a: unknown[]) => {
        sent += 1;
        return (supplied.query as (...x: unknown[]) => Promise<unknown>)(...a);
      },
      connect: async () => {
        acquired += 1;
        const client = await supplied.connect();
        const query = client.query.bind(client);
        client.query = ((...a: unknown[]) => {
          sent += 1;
          return (query as (...x: unknown[]) => Promise<unknown>)(...a);
        }) as never;
        return client;
      },
      end: () => supplied.end(),
      on: (...a: unknown[]) => (supplied.on as (...x: unknown[]) => unknown)(...a),
    };
    const streamDb = new TurbineClient(
      {
        pool: counting,
        logger: {
          warn: (_m: string, c?: { code?: string }) => codes.push(c?.code ?? 'plain'),
          info: () => {},
          debug: () => {},
          error: () => {},
        },
        diagnostics: { mode: 'development' },
        warnOnUnlimited: false,
        preparedStatements: false,
      } as never,
      streamSchema,
    );
    const events: unknown[] = [];
    const middlewareCalls: unknown[] = [];
    streamDb.$on('query', ((e: unknown) => events.push(e)) as never);
    streamDb.$use((async (params: unknown, next: (p: unknown) => Promise<unknown>) => {
      middlewareCalls.push(params);
      return next(params);
    }) as never);
    try {
      for (const method of ['findManyStream', 'findManyStreamBatches'] as const) {
        for (const projection of [{ select: { missing: true } }, { omit: { missing: true } }]) {
          for (const extra of [{}, { idleTimeoutMs: -1 }]) {
            resetWarnOnce();
            codes.length = 0;
            acquired = 0;
            sent = 0;
            events.length = 0;
            middlewareCalls.length = 0;
            const args = { orderBy: { id: 'asc' }, jsonEncoding: 'object', ...extra, with: { [relName]: projection } };
            const label = `${method} ${Object.keys(projection)[0]} extra=${JSON.stringify(extra)}`;
            // Constructing the stream must not throw: the failure belongs
            // to the first read, after the statement build has spoken.
            const iterable = (
              streamDb.table('odps_parent') as unknown as Record<string, (a: unknown) => AsyncIterable<unknown>>
            )[method]!(args);
            let error: (Error & { code?: string }) | undefined;
            try {
              for await (const _row of iterable) break;
            } catch (err) {
              error = err as Error & { code?: string };
            }
            assert.ok(error, `${label}: expected the first read to reject`);
            assert.equal(error!.code, 'TURBINE_E003', `${label}: ${error!.message}`);
            if ('idleTimeoutMs' in extra) {
              assert.match(error!.message, /idleTimeoutMs/, `${label}: the earlier invalid option must win`);
              assert.deepEqual(codes, [], `${label}: no warning precedes the option error`);
            } else {
              assert.match(error!.message, /Unknown field "missing"/, label);
              assert.deepEqual(codes, ['unindexed-relation'], `${label}: the statement build warning comes first`);
            }
            assert.equal(acquired, 0, `${label}: a connection was checked out`);
            assert.equal(sent, 0, `${label}: a statement was sent`);
            assert.equal(events.length, 0, `${label}: a query event fired`);
            assert.equal(middlewareCalls.length, 0, `${label}: middleware ran`);
          }
        }
      }
      const alive = await streamDb.table('odps_parent').findMany({ limit: 1 } as never);
      assert.equal((alive as unknown[]).length, 1, 'the client must stay usable after rejected streams');
    } finally {
      await streamDb.disconnect();
      await supplied.end().catch(() => {});
      const teardown = new pgDriver.Client({ connectionString: pgOdpUrl });
      await teardown.connect();
      try {
        await teardown.query('DROP TABLE IF EXISTS odps_child, odps_parent CASCADE');
      } finally {
        await teardown.end();
      }
    }
  });
});

// ---- MySQL ------------------------------------------------------------------

const MYSQL_URL = process.env.MYSQL_URL ?? process.env.MYSQL_TEST_URL;
const myGate = skipGate(!MYSQL_URL, 'requires MYSQL_URL / MYSQL_TEST_URL pointing at a MySQL 8 server');

describe('object decode plan on MySQL', () => {
  // A database of this section's own: other suites introspect the shared
  // MYSQL_URL database (in parallel processes too), and must never see
  // these tables, not even between creation and teardown.
  const MY_DB = 'turbine_odp_test';
  let db: TurbineClient;
  let rawEnd: (() => Promise<void>) | undefined;
  let dropDatabase: (() => Promise<void>) | undefined;

  myGate.before(async () => {
    const { createPool } = await import('mysql2/promise');
    const u = new URL(MYSQL_URL!);
    const base = {
      host: u.hostname,
      port: Number(u.port || 3306),
      user: decodeURIComponent(u.username),
      password: decodeURIComponent(u.password),
      namedPlaceholders: true,
      timezone: 'Z',
      supportBigNumbers: true,
      bigNumberStrings: false,
    };
    const admin = createPool(base);
    try {
      await admin.query(`DROP DATABASE IF EXISTS ${MY_DB}`);
      await admin.query(`CREATE DATABASE ${MY_DB}`);
    } finally {
      await admin.end();
    }
    dropDatabase = async () => {
      const p = createPool(base);
      try {
        await p.query(`DROP DATABASE IF EXISTS ${MY_DB}`);
      } finally {
        await p.end();
      }
    };
    const raw = createPool({ ...base, database: MY_DB });
    rawEnd = () => raw.end();
    const pool = new MysqlPool(raw as never);
    await raw.query('DROP TABLE IF EXISTS odp_my_children, odp_my_parents');
    await raw.query(`CREATE TABLE odp_my_parents (
      id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY, label TEXT NOT NULL, made_at DATETIME(3) NULL
    )`);
    await raw.query(`CREATE TABLE odp_my_children (
      id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      parent_id BIGINT NOT NULL,
      ord INT NOT NULL, big BIGINT NULL, amount DECIMAL(30,10) NULL, score DOUBLE NULL,
      flag BOOLEAN NULL, doc JSON NULL, data_blob BLOB NULL, on_day DATE NULL, at_dt DATETIME(3) NULL,
      INDEX idx_odp_my_children_parent (parent_id), FOREIGN KEY (parent_id) REFERENCES odp_my_parents(id)
    )`);
    await raw.query(
      "INSERT INTO odp_my_parents (label, made_at) VALUES ('a', '2026-07-07 17:15:41.896'), ('b', NULL), ('empty', '1999-12-31 23:59:59.999')",
    );
    await raw.execute(
      'INSERT INTO odp_my_children (parent_id, ord, big, amount, score, flag, doc, data_blob, on_day, at_dt) VALUES (?,?,?,?,?,?,?,?,?,?), (?,?,?,?,?,?,?,?,?,?), (?,?,?,?,?,?,?,?,?,?)',
      [
        1,
        1,
        '9007199254740993',
        '12345678901234567890.0123456789',
        0.1 + 0.2,
        1,
        '{"k":[1,2]}',
        Buffer.from([0, 1, 254, 255]),
        '2026-07-07',
        '2026-07-07 17:15:41.896',
        1,
        2,
        null,
        null,
        null,
        0,
        null,
        null,
        null,
        null,
        2,
        1,
        '-9223372036854775808',
        '0.0000000001',
        -0,
        1,
        '[]',
        Buffer.from([]),
        '2000-02-29',
        '2000-02-29 00:00:00.000',
      ],
    );
    const meta = await introspectMysqlWith(async (sql, values) => (await pool.query(sql, values)).rows, MY_DB, {
      include: ['odp_my_parents', 'odp_my_children'],
    });
    db = await turbineMysql(pool as never, meta, { warnOnUnlimited: false } as never);
  });

  myGate.after(async () => {
    try {
      await db?.disconnect();
      await rawEnd?.();
    } finally {
      // Even when a test above failed.
      await dropDatabase?.();
    }
  });

  myGate.it(
    'parents with children and _count: plan, reference, cache and batched agree, keys in MySQL order',
    async () => {
      const table = db.table('odp_my_parents') as unknown as TableLike;
      const rows = await assertEngineIdentical(
        db as never,
        table,
        'odp_my_parents',
        {
          orderBy: { id: 'asc' },
          with: { odpMyChildren: { orderBy: { ord: 'asc' } }, _count: { odpMyChildren: true } },
        },
        'mysql parents',
        false,
      );
      const first = (rows as Record<string, unknown>[])[0]!;
      const kids = first.odpMyChildren as Record<string, unknown>[];
      assert.ok(kids.length === 2, 'fixture children missing');
      // MySQL sorts JSON object keys; the output must keep the driver's order.
      assert.deepEqual(Object.keys(kids[0]!), orderKeys(Object.keys(kids[0]!), 'mysql'));
      assert.equal(kids[0]!.flag, true, 'boolean-as-integer did not decode');
    },
  );

  myGate.it('children with a to-one parent under select and limit agree across strategies', async () => {
    const table = db.table('odp_my_children') as unknown as TableLike;
    const args = {
      orderBy: { id: 'asc' },
      with: { odpMyParent: { select: { id: true, label: true, madeAt: true } } },
    };
    const rows = await assertEngineIdentical(db as never, table, 'odp_my_children', args, 'mysql children', false);
    const viaFlatten = await table.findMany({ ...args, relationLoadStrategy: 'flatten' });
    assertIdentical(viaFlatten, rows, 'mysql children: flatten strategy');
  });
});
