/**
 * turbine-orm, relation JSON parse-failure handling (no DB).
 *
 * `parseNestedRow` (query/relations.ts) used to catch a JSON parse failure,
 * `console.warn` with no NODE_ENV gate and no dedupe, then assign the RAW
 * STRING to the relation field. Two defects in six lines:
 *
 *   1. The warn sits inside the per-relation loop, which runs once per row per
 *      relation, so one 10,000-row page emitted 10,000 production warnings.
 *   2. The substitution was silent and type-violating: the caller received a
 *      `string` where the generated type promises `Post[]`, and found out at
 *      the first `.map`, arbitrarily far from the query that produced it.
 *
 * The fix throws instead, and gates + dedupes the diagnostic warn.
 *
 * Run: npx tsx --test src/test/relation-parse-failure.test.ts
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { ValidationError } from '../errors.js';
import { QueryInterface } from '../query/index.js';
import { resetWarnOnce, WARN_NS } from '../query/warn-registry.js';
import type { SchemaMetadata, TableMetadata } from '../schema.js';
import { mockTable } from './helpers.js';

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

function buildSchema(): SchemaMetadata {
  const tables: Record<string, TableMetadata> = {};

  tables.users = mockTable(
    'users',
    [
      { name: 'id', field: 'id' },
      { name: 'name', field: 'name', pgType: 'text' },
    ],
    {
      posts: {
        type: 'hasMany',
        name: 'posts',
        from: 'users',
        to: 'posts',
        foreignKey: 'user_id',
        referenceKey: 'id',
      },
    },
  );

  tables.posts = mockTable(
    'posts',
    [
      { name: 'id', field: 'id' },
      { name: 'title', field: 'title', pgType: 'text' },
      { name: 'user_id', field: 'userId' },
    ],
    {},
  );

  return { tables, enums: {} };
}

function makeInterface(): QueryInterface<Record<string, unknown>> {
  return new QueryInterface<Record<string, unknown>>(
    // biome-ignore lint/suspicious/noExplicitAny: build-only interface, no pool is touched
    null as any,
    'users',
    buildSchema(),
  );
}

/**
 * Run one findMany transform whose `posts` relation column carries a payload
 * that is not valid JSON, capturing whatever the parse path writes to
 * `console.warn`.
 *
 * `rowsFor` lets a caller replay the SAME failure many times in one transform,
 * which is how the dedupe claim is actually tested: a per-row warn would emit
 * once per element.
 */
function parseMalformed(
  qi: QueryInterface<Record<string, unknown>>,
  rowCount = 1,
): { warnings: string[]; thrown: unknown } {
  const warnings: string[] = [];
  const origWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(String(args[0]));
  };

  // biome-ignore lint/suspicious/noExplicitAny: mock schema carries no field types
  const deferred = qi.buildFindMany({ with: { posts: true } as any });
  const rows = Array.from({ length: rowCount }, (_, i) => ({
    id: i + 1,
    name: 'Alice',
    posts: 'not valid json',
  }));

  let thrown: unknown;
  try {
    deferred.transform({ rows, command: '', rowCount: rows.length, oid: 0, fields: [] });
  } catch (err) {
    thrown = err;
  } finally {
    console.warn = origWarn;
  }

  return { warnings, thrown };
}

// ---------------------------------------------------------------------------
// Behaviour
// ---------------------------------------------------------------------------

describe('relation parse failure behaviour', () => {
  it('throws a ValidationError instead of substituting the raw value', () => {
    resetWarnOnce(WARN_NS.relationParseFailure);
    const { thrown } = parseMalformed(makeInterface());

    assert.ok(thrown instanceof ValidationError, 'a payload that will not parse must be an error, not a row');
    assert.equal((thrown as ValidationError).code, 'TURBINE_E003');
    assert.match((thrown as ValidationError).message, /"posts"/, 'the message must name the relation');
    assert.match((thrown as ValidationError).message, /"users"/, 'the message must name the table');
    assert.ok((thrown as ValidationError).cause instanceof Error, 'the underlying parse error is kept as the cause');
  });

  it('warns once for a page of many failing rows, not once per row', () => {
    resetWarnOnce(WARN_NS.relationParseFailure);
    // The throw ends the transform on the first row, so a per-row warn is not
    // observable through one call. Drive the SAME (table, relation) key through
    // three independent transforms instead: an undeduped warn says it three
    // times, the deduped one says it once.
    const qi = makeInterface();
    const first = parseMalformed(qi);
    const second = parseMalformed(qi);
    const third = parseMalformed(makeInterface());

    assert.equal(first.warnings.length, 1, 'the first failure must say something');
    assert.match(first.warnings[0] as string, /not valid JSON/);
    assert.equal(second.warnings.length, 0, 'the second failure on the same relation must be silent');
    assert.equal(third.warnings.length, 0, 'the registry is process-wide, not per client');

    // Every call still threw; dedupe suppresses the diagnostic, never the error.
    for (const run of [first, second, third]) {
      assert.ok(run.thrown instanceof ValidationError);
    }
  });

  it('emits no warn at all under NODE_ENV=production, but still throws', () => {
    resetWarnOnce(WARN_NS.relationParseFailure);
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const { warnings, thrown } = parseMalformed(makeInterface());
      assert.equal(warnings.length, 0, 'a production process must not be told once per page either');
      assert.ok(thrown instanceof ValidationError, 'the refusal is not a dev-only diagnostic');
    } finally {
      if (prev === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = prev;
    }
  });

  it('leaves a well-formed relation payload alone (negative control)', () => {
    resetWarnOnce(WARN_NS.relationParseFailure);
    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(String(args[0]));
    };
    try {
      const qi = makeInterface();
      // biome-ignore lint/suspicious/noExplicitAny: mock schema carries no field types
      const deferred = qi.buildFindMany({ with: { posts: true } as any });
      const result = deferred.transform({
        rows: [{ id: 1, name: 'Alice', posts: '[{"id": 7, "title": "Hi", "user_id": 1}]' }],
        command: '',
        rowCount: 1,
        oid: 0,
        fields: [],
      });
      // biome-ignore lint/suspicious/noExplicitAny: untyped mock row
      const row = result[0] as any;
      assert.ok(Array.isArray(row.posts), 'a valid payload still parses to an array');
      assert.equal(row.posts.length, 1);
      assert.equal(row.posts[0].title, 'Hi');
      assert.equal(warnings.length, 0, 'a healthy read says nothing');
    } finally {
      console.warn = origWarn;
    }
  });
});

// ---------------------------------------------------------------------------
// Shape of the source, so the gate cannot be removed while the behaviour tests
// keep passing by accident (a throw with an ungated per-row warn above it would
// satisfy every assertion in the first block except the dedupe one).
// ---------------------------------------------------------------------------

describe('relation parse failure handling', () => {
  const src = readFileSync(new URL('../query/relations.ts', import.meta.url), 'utf8');

  it('gates the parse-failure warn on NODE_ENV and dedupes it', () => {
    // The warn sits inside parseNestedRow's per-relation loop, which runs once
    // per row per relation. Ungated and undeduped, one page of 10,000 rows is
    // 10,000 console.warn calls in production.
    const anchor = src.indexOf('WARN_NS.relationParseFailure');
    assert.notEqual(anchor, -1, 'the parse-failure warn namespace must be used in relations.ts');
    const catchBlock = src.slice(anchor - 600, anchor + 900);
    assert.match(catchBlock, /shouldWarnOnce\(WARN_NS\.relationParseFailure/, 'warn must be deduped');
    assert.match(catchBlock, /NODE_ENV/, 'warn must be gated on NODE_ENV');
    assert.match(catchBlock, /throw new ValidationError/, 'the failure must propagate, not be swallowed');
  });

  it('does not silently substitute the raw value for a parsed relation', () => {
    assert.doesNotMatch(
      src,
      /Using raw value\./,
      'a failed parse must not hand back a string where the type promises an array',
    );
  });
});
