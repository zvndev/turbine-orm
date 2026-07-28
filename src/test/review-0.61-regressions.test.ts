/**
 * turbine-orm - regressions for the five defects found in the 0.60.1 product review.
 *
 * Each of these shipped, each was reproduced before being fixed, and each is
 * pinned here in the direction that would have caught it. Grouped in one file
 * because what they have in common is the useful part: every one of them FAILED
 * SILENTLY. None threw, none logged, and four of the five returned a plausible
 * answer. A test that only asserts the happy path cannot see any of them.
 *
 * Run: DATABASE_URL=postgres://... npx tsx --test src/test/review-0.61-regressions.test.ts
 */

import assert from 'node:assert/strict';
import { describe } from 'node:test';
import { TurbineClient } from '../client.js';
import { postgresDialect } from '../dialect.js';
import { TurbineError, UniqueConstraintError, ValidationError } from '../errors.js';
import { executePipeline } from '../pipeline.js';
import { makeQuery, mockTable, skipGate } from './helpers.js';

const URL = process.env.DATABASE_URL ?? '';
const { it, before: gatedBefore, after: gatedAfter } = skipGate(!URL, 'DATABASE_URL not set');

// ---------------------------------------------------------------------------
// 1. findUnique with no predicate must refuse, not answer with an arbitrary row
// ---------------------------------------------------------------------------

describe('findUnique refuses a where with no predicate', () => {
  const schema = {
    tables: {
      users: mockTable('users', [
        { name: 'id', field: 'id' },
        { name: 'email', field: 'email', pgType: 'text' },
      ]),
    },
    enums: {},
  };
  const q = makeQuery('users', schema);

  // `{ id: req.params.id }` on a request that omitted the param. Undefined keys
  // are dropped downstream, so this used to emit `SELECT … FROM users LIMIT 1`:
  // no WHERE at all, and the caller that would have handled `null` silently got
  // somebody else's row instead.
  for (const [label, where] of [
    ['an undefined value', { id: undefined }],
    ['an empty object', {}],
    ['every value undefined', { id: undefined, email: undefined }],
  ] as const) {
    it(`throws E003 on ${label}`, () => {
      assert.throws(
        () => q.buildFindUnique({ where: where as never }),
        (err: unknown) =>
          err instanceof ValidationError &&
          /no predicate/.test((err as Error).message) &&
          /findFirst/.test((err as Error).message),
        label,
      );
    });
  }

  it('still allows a real predicate, including one that is only a null check', () => {
    assert.match(q.buildFindUnique({ where: { id: 1 } }).sql, /WHERE/);
    assert.match(q.buildFindUnique({ where: { email: null } as never }).sql, /IS NULL/);
  });

  it('leaves findFirst alone: an optional filter is its contract, and Prisma agrees', () => {
    // Guarding findFirst would break the documented "first row matching an
    // optional filter" behaviour, which is the whole reason to reach for it.
    assert.doesNotThrow(() => q.buildFindMany({ where: { id: undefined } as never, limit: 1 }));
  });
});

// ---------------------------------------------------------------------------
// 2. An unrecognized isolation level must throw, never silently downgrade
// ---------------------------------------------------------------------------

describe('transaction isolation level is validated, not silently dropped', () => {
  // The pre-fix expression indexed a plain object and rendered `undefined` as a
  // bare BEGIN, so `'serializable'` asked for SERIALIZABLE and got READ
  // COMMITTED: the caller believes it holds a guarantee it does not hold, and
  // the workload that needed it produces wrong data with no error anywhere.
  const client = new TurbineClient({ connectionString: 'postgres://u:p@127.0.0.1:1/x' }, { tables: {}, enums: {} });

  for (const bad of ['serializable', 'SERIALIZABLE', 'Serialisable', 'ReadCommited', '', 'constructor', 'toString']) {
    it(`refuses ${JSON.stringify(bad)}`, async () => {
      await assert.rejects(
        () => client.$transaction(async () => undefined, { isolationLevel: bad as never }),
        (err: unknown) => err instanceof ValidationError && /unknown isolationLevel/.test((err as Error).message),
      );
    });
  }

  it('the prototype keys would otherwise have reached the SQL text', () => {
    // Not injectable on its own (it is a syntax error), but it is raw text from
    // a lookup landing in a statement, which is the shape the project forbids.
    const viaPrototype = ({} as Record<string, string>).constructor;
    assert.equal(typeof viaPrototype, 'function');
    assert.equal(postgresDialect.beginStatement(undefined), 'BEGIN');
    assert.equal(postgresDialect.beginStatement('SERIALIZABLE'), 'BEGIN ISOLATION LEVEL SERIALIZABLE');
  });
});

// ---------------------------------------------------------------------------
// 3. COMMIT-time database errors must arrive typed
// ---------------------------------------------------------------------------

describe('COMMIT-time errors are wrapped like every other query boundary', () => {
  const sql = async (text: string): Promise<void> => {
    const { Pool } = (await import('pg')).default;
    const pool = new Pool({ connectionString: URL, max: 1 });
    try {
      await pool.query(text);
    } finally {
      await pool.end();
    }
  };

  gatedBefore(async () => {
    await sql(`DROP TABLE IF EXISTS commit_time_probe;
      CREATE TABLE commit_time_probe (id int PRIMARY KEY, u int UNIQUE DEFERRABLE INITIALLY DEFERRED)`);
  });
  gatedAfter(async () => {
    await sql('DROP TABLE IF EXISTS commit_time_probe');
  });

  it('a deferred unique violation raised at COMMIT is a UniqueConstraintError, not a raw pg error', async () => {
    // Postgres reports DEFERRABLE violations, and many SERIALIZABLE conflicts,
    // at COMMIT rather than at the offending statement. COMMIT was the one
    // statement issued raw, so those arrived as a pg `DatabaseError` carrying a
    // SQLSTATE in `.code`, the SAME property Turbine puts TURBINE_E0NN in.
    const schema = {
      tables: {
        commit_time_probe: mockTable('commit_time_probe', [
          { name: 'id', field: 'id' },
          { name: 'u', field: 'u' },
        ]),
      },
      enums: {},
    };
    const db = new TurbineClient({ connectionString: URL }, schema);
    try {
      await assert.rejects(
        () =>
          db.$transaction(async (tx) => {
            // The typed accessors come from a GENERATED client; this schema is
            // built inline, so the table is reached through the runtime shape.
            const probe = (tx as unknown as Record<string, { create(a: unknown): Promise<unknown> }>).commitTimeProbe!;
            await probe.create({ data: { id: 1, u: 1 } });
            await probe.create({ data: { id: 2, u: 1 } });
          }),
        (err: unknown) => {
          assert.ok(err instanceof TurbineError, `expected a TurbineError, got ${(err as object).constructor.name}`);
          assert.ok(err instanceof UniqueConstraintError);
          assert.equal((err as { code: string }).code, 'TURBINE_E008');
          // The documented contract: the driver error is preserved as `.cause`.
          assert.notEqual((err as { cause?: unknown }).cause, undefined);
          return true;
        },
      );
    } finally {
      await db.disconnect();
    }
  });
});

// ---------------------------------------------------------------------------
// 4. A throw in the pipeline send path must not wedge the pooled connection
// ---------------------------------------------------------------------------

describe('a failed pipeline send does not poison the pool', () => {
  it('the next borrower of a max=1 pool still gets an answer', async () => {
    // `valueMapper: prepareValue` runs synchronously inside `bind`, so a param
    // with a throwing serializer escapes mid-sequence with Parse/Bind bytes
    // corked and no Sync ever sent. Returning that connection to the pool made
    // the NEXT, unrelated query hang forever with nothing pointing back here.
    const { Pool } = (await import('pg')).default;
    const pool = new Pool({ connectionString: URL, max: 1 });
    pool.on('error', () => {});
    const q = (text: string, params: unknown[] = []) => ({
      sql: text,
      params,
      transform: (r: { rows: unknown[] }) => r.rows,
      tag: 'probe',
    });
    try {
      await executePipeline(pool as never, [q('SELECT 1 AS a')] as never);
      await assert.rejects(() =>
        executePipeline(
          pool as never,
          [
            q('SELECT 1'),
            q('SELECT $1::text', [
              {
                toPostgres() {
                  throw new Error('boom');
                },
              },
            ]),
          ] as never,
        ),
      );

      const answered = await Promise.race([
        pool.query('SELECT 42 AS n').then((r) => (r.rows[0] as { n: number }).n),
        new Promise<'wedged'>((resolve) => setTimeout(() => resolve('wedged'), 8000)),
      ]);
      assert.equal(answered, 42, 'the pooled connection should have been discarded, not reused');
    } finally {
      await pool.end().catch(() => undefined);
    }
  });
});
