/**
 * turbine-orm, findManyStreamBatches (build-only, no DB)
 *
 * `findManyStream` yields one row at a time, which costs one promise
 * resolution and one microtask turn PER ROW: measured over 50,000 rows that is
 * ~7 ms of pure yielding, roughly half of the stream's overhead over a
 * hand-written cursor loop. `findManyStreamBatches` is the SAME drain handed
 * out as arrays.
 *
 * "The same drain" is the whole claim, so it is what these tests assert. The
 * two methods share one `streamRaw` (every statement, the cursor, the
 * connection) and one `makeStreamRowParser` (the flatten plan, the JSON
 * encoding, the PII projection), and a regression in either sharing would show
 * up as the batch path returning DIFFERENT rows or issuing DIFFERENT SQL, both
 * of which are checked here across every row-shape the parser branches on:
 * plain scalars, `json_build_object` relations, `json_build_array` (positional)
 * relations, the `'flatten'` join projection, projections, and PII.
 *
 * The additive half matters just as much: `findManyStream` is shipped public
 * API, so its own behaviour is re-pinned here rather than trusted, including
 * the LAZINESS the refactor could plausibly have lost (it must still parse one
 * row at a time, not a batch ahead).
 *
 * Run: npx tsx --test src/test/stream-batches.test.ts
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { UniqueConstraintError, ValidationError } from '../errors.js';
import type { QueryEvent, QueryInterfaceOptions } from '../query/index.js';
import { QueryInterface, UNSAFE } from '../query/index.js';
import type { ColumnMetadata, SchemaMetadata } from '../schema.js';
import { mockTable } from './helpers.js';

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

/**
 * users (with a date column and a PII column) → org (belongsTo), posts (hasMany).
 *
 * `orgs.id` is a primary key, which is what makes `org` provably unique and so
 * eligible for the `'flatten'` join; `posts.user_id` is not, so `posts` always
 * stays on the correlated subquery. Having both in one schema means a single
 * fixture exercises the flattened and non-flattened halves of the same parser.
 */
function buildSchema(): SchemaMetadata {
  const users = mockTable(
    'users',
    [
      { name: 'id', field: 'id' },
      { name: 'name', field: 'name', pgType: 'text' },
      { name: 'email', field: 'email', pgType: 'text' },
      { name: 'org_id', field: 'orgId' },
      { name: 'created_at', field: 'createdAt', pgType: 'timestamp' },
    ],
    {
      org: { type: 'belongsTo', name: 'org', from: 'users', to: 'orgs', foreignKey: 'org_id', referenceKey: 'id' },
      posts: { type: 'hasMany', name: 'posts', from: 'users', to: 'posts', foreignKey: 'user_id', referenceKey: 'id' },
    },
  );
  users.dateColumns = new Set(['created_at']);
  // Code-first PII tag: introspection never sets it, so it has to be applied by
  // hand here exactly as `defineSchema({ pii: true })` would.
  const emailCol = users.columns.find((c: ColumnMetadata) => c.name === 'email');
  if (emailCol) emailCol.pii = true;

  return {
    tables: {
      users,
      orgs: mockTable('orgs', [
        { name: 'id', field: 'id' },
        { name: 'name', field: 'name', pgType: 'text' },
      ]),
      posts: mockTable('posts', [
        { name: 'id', field: 'id' },
        { name: 'title', field: 'title', pgType: 'text' },
        { name: 'user_id', field: 'userId' },
      ]),
    },
    enums: {},
  };
}

// ---------------------------------------------------------------------------
// Mock pool
// ---------------------------------------------------------------------------

interface Harness {
  // biome-ignore lint/suspicious/noExplicitAny: mock pool stands in for pg.Pool
  pool: any;
  /** Every statement text, in order. */
  queries: string[];
  connects: { count: number };
  releases: { count: number };
}

/** Row source: index → the RAW row the driver would hand back for that row. */
type RowAt = (index: number) => Record<string, unknown>;

/**
 * A pool serving `total` rows of `rowAt`, through either the speculative SELECT
 * or a cursor, whichever the code under test asks for. The two drains under
 * comparison each get their own harness, so identical output is evidence about
 * the code rather than about a shared buffer.
 */
function harnessFor(total: number, rowAt: RowAt): Harness {
  const queries: string[] = [];
  const connects = { count: 0 };
  const releases = { count: 0 };
  let cursorPos = 0;

  const rowsFrom = (start: number, n: number): Record<string, unknown>[] => {
    const out: Record<string, unknown>[] = [];
    for (let i = start; i < Math.min(start + n, total); i++) out.push(rowAt(i));
    return out;
  };

  // pg accepts a SQL string and the `{ name, text, values }` prepared form.
  const query = async (textOrConfig: string | { text: string }, values?: unknown[]) => {
    const text = typeof textOrConfig === 'string' ? textOrConfig : textOrConfig.text;
    queries.push(text);
    let rows: Record<string, unknown>[] = [];
    const fetch = /^FETCH (\d+) FROM/.exec(text);
    if (fetch) {
      rows = rowsFrom(cursorPos, Number(fetch[1]));
      cursorPos += rows.length;
    } else if (text.startsWith('SELECT')) {
      // The speculative fetch. Its LIMIT is the last bound parameter.
      const limit = Array.isArray(values) ? Number(values[values.length - 1]) : total;
      rows = rowsFrom(0, Number.isFinite(limit) ? limit : total);
    }
    return { rows, rowCount: rows.length };
  };

  const client = {
    query,
    release() {
      releases.count += 1;
    },
  };

  return {
    pool: {
      query,
      connect: async () => {
        connects.count += 1;
        return client;
      },
    },
    queries,
    connects,
    releases,
  };
}

/**
 * The statements a drain issued, with the cursor's unique name masked.
 *
 * The name carries `Date.now()` and a random suffix so two cursors can coexist
 * on one connection, which means two runs of the SAME drain never produce
 * byte-equal text. Masking it is what leaves the comparison about the query.
 */
function statements(harness: Harness): string[] {
  return harness.queries.map((q) => q.replace(/turbine_cursor_\d+_[a-z0-9]+/g, '<cursor>'));
}

function makeQI(harness: Harness, options?: QueryInterfaceOptions): QueryInterface<Record<string, unknown>> {
  return new QueryInterface<Record<string, unknown>>(harness.pool, 'users', buildSchema(), undefined, {
    warnOnUnlimited: false,
    ...options,
  });
}

// biome-ignore lint/suspicious/noExplicitAny: the drains take arbitrary findMany args
type Args = any;

/** Drain the per-row API. */
async function drainRows(
  total: number,
  rowAt: RowAt,
  args?: Args,
  options?: QueryInterfaceOptions,
): Promise<{ rows: Record<string, unknown>[]; harness: Harness }> {
  const harness = harnessFor(total, rowAt);
  const rows: Record<string, unknown>[] = [];
  for await (const row of makeQI(harness, options).findManyStream(args)) {
    rows.push(row as Record<string, unknown>);
  }
  return { rows, harness };
}

/** Drain the batch API, keeping the batch boundaries for inspection. */
async function drainBatches(
  total: number,
  rowAt: RowAt,
  args?: Args,
  options?: QueryInterfaceOptions,
): Promise<{ batches: Record<string, unknown>[][]; rows: Record<string, unknown>[]; harness: Harness }> {
  const harness = harnessFor(total, rowAt);
  const batches: Record<string, unknown>[][] = [];
  for await (const batch of makeQI(harness, options).findManyStreamBatches(args)) {
    batches.push(batch as Record<string, unknown>[]);
  }
  return { batches, rows: batches.flat(), harness };
}

// ---------------------------------------------------------------------------
// Row shapes, one per parser branch
// ---------------------------------------------------------------------------

const scalarRow: RowAt = (i) => ({
  id: i + 1,
  name: `u${i + 1}`,
  email: `u${i + 1}@example.com`,
  org_id: (i % 3) + 1,
  created_at: `2026-08-1${i % 10} 12:00:00`,
});

/** `jsonEncoding: 'object'` (`json_build_object`): pg hands relation columns back parsed. */
const objectEncodedRow: RowAt = (i) => ({
  ...scalarRow(i),
  org: { id: String((i % 3) + 1), name: `org${(i % 3) + 1}` },
  posts: i % 2 === 0 ? [] : [{ id: String(i), title: `p${i}`, userId: String(i + 1) }],
});

/** `jsonEncoding: 'positional'`: the same data as `json_build_array` tuples. */
const positionalEncodedRow: RowAt = (i) => ({
  ...scalarRow(i),
  posts: i % 2 === 0 ? [] : [[String(i), `p${i}`, String(i + 1)]],
});

/**
 * `relationLoadStrategy: 'flatten'`: the to-one relation arrives as prefixed
 * scalar columns plus the `f0__$k` non-null discriminator, not as JSON. Row 0
 * has no org, which is the "all-NULL join, so the relation is null" case.
 */
const flattenedRow: RowAt = (i) => ({
  ...scalarRow(i),
  f0__$k: i === 0 ? null : 1,
  f0__id: i === 0 ? null : String((i % 3) + 1),
  f0__name: i === 0 ? null : `org${(i % 3) + 1}`,
});

// ---------------------------------------------------------------------------
// A) The core claim: the same drain, handed out two ways
// ---------------------------------------------------------------------------

describe('findManyStreamBatches: identical rows and identical SQL', () => {
  /**
   * One case = one row shape x one drain size. Both drain sizes matter: at 5
   * rows the speculative fetch satisfies the whole thing and the cursor is
   * never opened, at 2,500 with `batchSize: 1000` it overflows and every row
   * comes back through DECLARE / FETCH.
   */
  const shapes: { name: string; rowAt: RowAt; args?: Args; options?: QueryInterfaceOptions }[] = [
    { name: 'plain scalars (with a date column)', rowAt: scalarRow },
    {
      name: 'object-encoded relations',
      rowAt: objectEncodedRow,
      // EXPLICIT, not inherited: PostgreSQL's default is `'positional'`, so
      // without this the "object" shape would be parsed by the positional
      // decoder and this case would silently stop being about object encoding.
      // (It would still PASS, because the two drains are compared against each
      // other, which is exactly why it has to be pinned.)
      args: { with: { org: true, posts: true } },
      options: { jsonEncoding: 'object' },
    },
    {
      name: 'positional-encoded relations',
      rowAt: positionalEncodedRow,
      args: { with: { posts: true } },
      options: { jsonEncoding: 'positional' },
    },
    {
      name: 'positional-encoded relations via the PER-QUERY option',
      // The stream builds its row parser BEFORE the statement, so a per-query
      // encoding has to reach `makeStreamRowParser` as well as `buildFindMany`
      // or the drain decodes by one plan and reads by the other.
      rowAt: positionalEncodedRow,
      args: { with: { posts: true }, jsonEncoding: 'positional' },
      options: { jsonEncoding: 'object' },
    },
    {
      name: "the 'flatten' join projection (per-query encoding)",
      // `'flatten'` needs the object encoding, and on PostgreSQL that now has to
      // be asked for: positional is the default and a flattened relation emits
      // no JSON to encode, so the plan is refused. Per query here, client-level
      // in the next case, and both have to reach `makeStreamRowParser`, which
      // builds the flatten parser before any statement is issued.
      rowAt: flattenedRow,
      args: { with: { org: true }, jsonEncoding: 'object' },
      options: { relationLoadStrategy: 'flatten' },
    },
    {
      name: "the 'flatten' join projection (client-level encoding)",
      rowAt: flattenedRow,
      args: { with: { org: true } },
      options: { relationLoadStrategy: 'flatten', jsonEncoding: 'object' },
    },
    { name: 'a select projection', rowAt: scalarRow, args: { select: { id: true, name: true } } },
    { name: 'an omit projection', rowAt: scalarRow, args: { omit: { name: true } } },
    { name: 'a where clause', rowAt: scalarRow, args: { where: { orgId: { in: [1, 2, 3] } } } },
    { name: 'PII unlocked with the UNSAFE sentinel', rowAt: scalarRow, args: { includePii: UNSAFE } },
  ];

  for (const shape of shapes) {
    for (const [label, total, batchSize] of [
      ['the speculative fast path', 5, undefined],
      ['the cursor path', 2500, 1000],
    ] as const) {
      it(`yields byte-identical rows for ${shape.name} over ${label}`, async () => {
        const args = { ...shape.args, ...(batchSize === undefined ? {} : { batchSize }) };
        const perRow = await drainRows(total, shape.rowAt, args, shape.options);
        const batched = await drainBatches(total, shape.rowAt, args, shape.options);

        assert.equal(perRow.rows.length, total, 'the per-row drain must see every row');
        assert.deepEqual(
          batched.rows,
          perRow.rows,
          'the batch path must return exactly what the per-row path returns, in order',
        );
        assert.deepEqual(
          statements(batched.harness),
          statements(perRow.harness),
          'and must get there by issuing exactly the same statements',
        );
      });
    }
  }

  it('excludes a PII column from the batch path’s statements unless it is unlocked', async () => {
    // The PII contract is enforced AT THE SQL LEVEL, so this is asserted on the
    // emitted statements rather than on the mock's rows (the mock serves
    // whatever it is told to, and would happily hand back a column the real
    // server was never asked for). The parity cases above already prove the two
    // paths emit the same SQL; this proves WHICH SQL that is, so a batch path
    // that skipped the PII decision could not pass both.
    const args = { batchSize: 1000 };
    const locked = await drainBatches(2500, scalarRow, args);
    const declare = statements(locked.harness).find((q) => q.startsWith('DECLARE'));
    assert.ok(declare, 'the drain must have opened a cursor');
    assert.equal(declare.includes('"email"'), false, 'the fixture tags email as PII, so it must not be projected');
    assert.ok(declare.includes('"name"'), 'and the untagged columns must still be');

    const unlocked = await drainBatches(2500, scalarRow, { ...args, includePii: UNSAFE });
    const unlockedDeclare = statements(unlocked.harness).find((q) => q.startsWith('DECLARE'));
    assert.ok(unlockedDeclare?.includes('"users".*'), 'the sentinel restores the unrestricted projection');
    assert.equal(unlocked.rows[0]!.email, 'u1@example.com');
  });

  it('refuses `includePii: true` on the batch path, exactly as the per-row path does', async () => {
    // The privilege options are only satisfied by the UNSAFE symbol; a plain
    // `true` is what a request body can produce, so it must throw on any path
    // that reads it.
    await assert.rejects(
      async () => {
        for await (const _ of makeQI(harnessFor(5, scalarRow)).findManyStreamBatches({ includePii: true } as Args)) {
          // unreachable
        }
      },
      (err: unknown) => err instanceof ValidationError,
    );
  });
});

// ---------------------------------------------------------------------------
// B) What a batch is
// ---------------------------------------------------------------------------

describe('findManyStreamBatches: batch shape', () => {
  it('yields arrays, not rows', async () => {
    const { batches } = await drainBatches(5, scalarRow);
    for (const batch of batches) assert.ok(Array.isArray(batch), 'every yielded value must be an array');
  });

  it('satisfies a small drain in a single batch, with no cursor', async () => {
    const { batches, harness } = await drainBatches(5, scalarRow);
    assert.equal(batches.length, 1, 'the speculative fetch already has every row');
    assert.equal(batches[0]!.length, 5);
    assert.equal(
      harness.queries.some((q) => q.startsWith('DECLARE')),
      false,
      'no cursor should be opened',
    );
  });

  it('never yields an empty batch, including on an empty result set', async () => {
    // A consumer may treat a yielded batch as non-empty, so this is a contract,
    // not an incidental property of the fixture.
    const empty = await drainBatches(0, scalarRow);
    assert.deepEqual(empty.batches, [], 'an empty result set yields nothing at all');

    // 2,000 rows at batchSize 1,000 makes the cursor's last FETCH return
    // exactly zero rows, which is where a spurious empty batch would appear.
    const exact = await drainBatches(2000, scalarRow, { batchSize: 1000 });
    assert.equal(exact.rows.length, 2000);
    for (const batch of exact.batches) assert.ok(batch.length > 0, 'no batch may be empty');
  });

  it('bounds each batch by batchSize and preserves order across boundaries', async () => {
    const { batches, rows } = await drainBatches(2500, scalarRow, { batchSize: 1000 });
    assert.equal(batches.length, 3, '1000 + 1000 + 500');
    for (const batch of batches) assert.ok(batch.length <= 1000, 'a batch may never exceed batchSize');
    assert.equal(rows.length, 2500);
    assert.deepEqual(
      rows.map((r) => r.id),
      Array.from({ length: 2500 }, (_, i) => i + 1),
      'concatenating the batches must reproduce the row order exactly',
    );
  });

  it('hands out a fresh array, never the driver’s own row buffer', async () => {
    // The batch is parsed into a new array, so a consumer that sorts or splices
    // it in place cannot reach back into the connection's buffer.
    const { batches } = await drainBatches(5, scalarRow);
    const batch = batches[0]!;
    batch.length = 0;
    const again = await drainBatches(5, scalarRow);
    assert.equal(again.batches[0]!.length, 5);
  });
});

// ---------------------------------------------------------------------------
// C) Plumbing: the shared streamRaw must behave identically for both
// ---------------------------------------------------------------------------

describe('findManyStreamBatches: cursor and connection handling', () => {
  it('closes the cursor, commits and releases when the consumer breaks early', async () => {
    const harness = harnessFor(2500, scalarRow);
    for await (const batch of makeQI(harness).findManyStreamBatches({ batchSize: 1000 })) {
      assert.equal(batch.length, 1000);
      break;
    }
    assert.ok(
      harness.queries.some((q) => q.startsWith('CLOSE')),
      'the cursor must be CLOSEd on early exit',
    );
    assert.ok(harness.queries.includes('COMMIT'), 'and the transaction committed');
    assert.equal(harness.releases.count, 1, 'and the connection released exactly once');
  });

  it('wraps a driver error into a typed turbine error', async () => {
    const harness = harnessFor(2500, scalarRow);
    const boom = Object.assign(new Error('duplicate key'), { code: '23505', constraint: 'users_pkey' });
    const inner = harness.pool.query;
    harness.pool.connect = async () => ({
      query: async (text: string, values?: unknown[]) => {
        if (text.startsWith('FETCH')) throw boom;
        return inner(text, values);
      },
      release() {},
    });
    await assert.rejects(
      async () => {
        for await (const _ of makeQI(harness).findManyStreamBatches({ batchSize: 1000 })) {
          // the first FETCH throws
        }
      },
      (err: unknown) => err instanceof UniqueConstraintError,
    );
  });

  it('tags its query events with its own action, and leaves the per-row tag alone', async () => {
    const seen: string[] = [];
    const collect: QueryInterfaceOptions = { _onQuery: (e: QueryEvent) => seen.push(e.action) };

    for await (const _ of makeQI(harnessFor(5, scalarRow), collect).findManyStreamBatches()) {
      // drain
    }
    assert.deepEqual(seen, ['findManyStreamBatches']);

    seen.length = 0;
    for await (const _ of makeQI(harnessFor(5, scalarRow), collect).findManyStream()) {
      // drain
    }
    assert.deepEqual(seen, ['findManyStream'], 'the per-row method must not start reporting the batch name');
  });
});

// ---------------------------------------------------------------------------
// D) findManyStream is unchanged, including the parts a refactor could lose
// ---------------------------------------------------------------------------

describe('findManyStream is unchanged by the batch path', () => {
  /**
   * A row whose 4th column throws when read. `parseRow` reads every column of
   * every row it is given, so this row poisons whichever row the parser
   * reaches, and WHEN it is reached is the observable difference between
   * parsing lazily and parsing a batch ahead.
   */
  const poisonAt = (bad: number): RowAt => {
    return (i) => {
      const row = scalarRow(i);
      if (i !== bad) return row;
      Object.defineProperty(row, 'created_at', {
        enumerable: true,
        get() {
          throw new Error('poisoned row');
        },
      });
      return row;
    };
  };

  it('still parses one row at a time, so an early break skips later rows entirely', async () => {
    // The per-row path must reach rows 0 and 1 before row 3 is ever parsed. A
    // version that parsed the whole batch up front would throw before yielding
    // anything, which is a real behaviour change for a consumer that breaks.
    const harness = harnessFor(5, poisonAt(3));
    const seen: unknown[] = [];
    for await (const row of makeQI(harness).findManyStream()) {
      seen.push(row);
      if (seen.length === 2) break;
    }
    assert.equal(seen.length, 2, 'two rows must come out before the poisoned one is touched');
  });

  it('and the batch path parses the batch, so it surfaces the same failure up front', async () => {
    // Stated as the deliberate trade it is: a batch is parsed before it is
    // handed over, so the poisoned row is reached even though the consumer
    // would have stopped at row 2.
    await assert.rejects(async () => {
      for await (const _ of makeQI(harnessFor(5, poisonAt(3))).findManyStreamBatches()) {
        break;
      }
    }, /poisoned row/);
  });

  it('still yields individual rows, not arrays', async () => {
    const { rows } = await drainRows(5, scalarRow);
    assert.equal(rows.length, 5);
    for (const row of rows) assert.equal(Array.isArray(row), false);
    assert.equal(rows[0]!.id, 1);
    assert.ok(rows[0]!.createdAt instanceof Date, 'date coercion still applies');
  });
});
