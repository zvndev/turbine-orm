/**
 * turbine-orm — Typed raw SQL (`db.sql<T>`) tests
 *
 * Covers three things:
 *
 *  1. **Parameterization / injection safety (no DB needed).** Proves that
 *     interpolated template values become `$N` parameters and never reach the
 *     SQL text — even a malicious `"1; DROP TABLE users"` string is passed as a
 *     bound parameter, not executed.
 *
 *  2. **Integration (needs DATABASE_URL).** Runs typed queries against the seed
 *     fixture and asserts the rows / `.one()` / `.scalar()` shapes come back
 *     correct, and that an injected value is treated as data.
 *
 *  3. **Compile-time type assertions.** The returned element type matches the
 *     supplied generic; accessing a non-existent field is a `@ts-expect-error`.
 *     If inference regresses, this file fails to typecheck and `tsx --test`
 *     exits non-zero (same mechanism as with-inference.test.ts).
 *
 * Run: DATABASE_URL=postgres://... npx tsx --test src/test/typed-sql.test.ts
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { TurbineClient } from '../client.js';
import { introspect } from '../introspect.js';
import type { SchemaMetadata } from '../schema.js';
import { buildTypedSql, TypedSqlQuery } from '../typed-sql.js';
import { skipGate } from './helpers.js';

// ---------------------------------------------------------------------------
// Compile-time type assertions
// ---------------------------------------------------------------------------

type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
function assertTrue<T extends true>(): T {
  return true as T;
}

declare const db: TurbineClient;

async function typeChecks() {
  if (false as boolean) {
    // Awaited directly -> T[]
    const rows = await db.sql<{ id: number; name: string }>`SELECT id, name FROM users`;
    type Row = (typeof rows)[number];
    assertTrue<Equals<Row, { id: number; name: string }>>();
    assertTrue<Equals<Row['id'], number>>();
    // @ts-expect-error — `nope` is not a field on the supplied row type
    void rows[0]!.nope;

    // .one() -> T | null
    const one = await db.sql<{ id: number; name: string }>`SELECT id, name FROM users WHERE id = ${1}`.one();
    assertTrue<Equals<typeof one, { id: number; name: string } | null>>();
    // @ts-expect-error — must narrow null before access
    void one.id;
    if (one) {
      assertTrue<Equals<typeof one.name, string>>();
      // @ts-expect-error — `missing` is not on the row type
      void one.missing;
    }

    // .scalar() -> first value type | null (defaults to union of T's values)
    const count = await db.sql<{ count: number }>`SELECT COUNT(*)::int AS count FROM users`.scalar();
    assertTrue<Equals<typeof count, number | null>>();

    // .scalar<V>() override
    const name = await db.sql<{ name: string }>`SELECT name FROM users LIMIT 1`.scalar<string>();
    assertTrue<Equals<typeof name, string | null>>();
  }
}
void typeChecks;

// ---------------------------------------------------------------------------
// Parameterization / injection safety (no DB)
// ---------------------------------------------------------------------------

describe('typed-sql parameterization (unit)', () => {
  it('interpolated values become $N placeholders, never inlined SQL', () => {
    const orgId = 7;
    const built = (s: TemplateStringsArray, ...v: unknown[]) => buildTypedSql(s, v);
    const { sql, params } = built`SELECT id, name FROM users WHERE org_id = ${orgId}`;
    assert.equal(sql, 'SELECT id, name FROM users WHERE org_id = $1');
    assert.deepEqual(params, [7]);
  });

  it('numbers placeholders in order across multiple interpolations', () => {
    const a = 1;
    const b = 'x';
    const c = true;
    const built = (s: TemplateStringsArray, ...v: unknown[]) => buildTypedSql(s, v);
    const { sql, params } = built`SELECT * FROM t WHERE a = ${a} AND b = ${b} AND c = ${c}`;
    assert.equal(sql, 'SELECT * FROM t WHERE a = $1 AND b = $2 AND c = $3');
    assert.deepEqual(params, [1, 'x', true]);
  });

  it('a SQL-injection payload is captured as a PARAMETER, not SQL', () => {
    // The classic injection attempt. It must end up in params, and the SQL text
    // must contain only the static segments + a $1 placeholder.
    const evil = '1; DROP TABLE users';
    const built = (s: TemplateStringsArray, ...v: unknown[]) => buildTypedSql(s, v);
    const { sql, params } = built`SELECT * FROM users WHERE id = ${evil}`;
    assert.equal(sql, 'SELECT * FROM users WHERE id = $1');
    // The dangerous string is data, not code.
    assert.deepEqual(params, ['1; DROP TABLE users']);
    assert.ok(!sql.includes('DROP TABLE'), 'payload must not appear in SQL text');
  });

  it('buildTypedSql rejects a segment/value count mismatch (direct misuse)', () => {
    // The tagged-template API can't produce this, but buildTypedSql is exported,
    // so guard the directly-callable surface against placeholder/param desync.
    const fakeSegments = ['a', 'b'] as unknown as TemplateStringsArray;
    assert.throws(() => buildTypedSql(fakeSegments, [10, 20, 30]), /segment\/value count mismatch/);
  });

  it('TypedSqlQuery executes against a mock pool with bound params only', async () => {
    const captured: { sql: string; params: unknown[] }[] = [];
    const mockPool = {
      query: async (sql: string, params?: unknown[]) => {
        captured.push({ sql, params: params ?? [] });
        return { rows: [{ id: 1 }], rowCount: 1 } as never;
      },
    };
    const evil = '1; DROP TABLE users; --';
    const built = (s: TemplateStringsArray, ...v: unknown[]) => buildTypedSql(s, v);
    const { sql, params } = built`SELECT * FROM users WHERE id = ${evil}`;
    const q = new TypedSqlQuery<{ id: number }>(mockPool as never, sql, params, false);
    const rows = await q;
    assert.deepEqual(rows, [{ id: 1 }]);
    assert.equal(captured[0]!.sql, 'SELECT * FROM users WHERE id = $1');
    assert.deepEqual(captured[0]!.params, ['1; DROP TABLE users; --']);
  });
});

// ---------------------------------------------------------------------------
// Integration (needs DATABASE_URL)
// ---------------------------------------------------------------------------

const DATABASE_URL = process.env.DATABASE_URL;
const SKIP = !DATABASE_URL;
if (SKIP) {
  console.log('⚠ Skipping typed-sql integration tests: DATABASE_URL not set');
}
const testFn = describe;

testFn('typed-sql integration', () => {
  // Without DATABASE_URL these tests register as skipped (visible in the
  // reporter summary) and the before/after hooks become no-ops.
  const { it, before, after } = skipGate(SKIP, 'DATABASE_URL not set');
  let client: TurbineClient;
  let schema: SchemaMetadata;

  before(async () => {
    schema = await introspect({ connectionString: DATABASE_URL! });
    client = new TurbineClient({ connectionString: DATABASE_URL!, poolSize: 3 }, schema);
    await client.connect();
  });

  after(async () => {
    await client.disconnect();
  });

  it('await -> typed rows come back correct', async () => {
    const rows = await client.sql<{ id: number; email: string }>`
      SELECT id, email FROM users ORDER BY id LIMIT 3
    `;
    assert.equal(rows.length, 3);
    assert.equal(typeof rows[0]!.id, 'number');
    assert.equal(typeof rows[0]!.email, 'string');
    assert.equal(rows[0]!.email, 'user1@example.com');
  });

  it('interpolated value is parameterized (filters correctly)', async () => {
    const targetId = 2;
    const rows = await client.sql<{ id: number; email: string }>`
      SELECT id, email FROM users WHERE id = ${targetId}
    `;
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.id, 2);
    assert.equal(rows[0]!.email, 'user2@example.com');
  });

  it('.one() returns a single row', async () => {
    const user = await client.sql<{ id: number; name: string }>`
      SELECT id, name FROM users WHERE id = ${1}
    `.one();
    assert.notEqual(user, null);
    assert.equal(user!.id, 1);
    assert.equal(user!.name, 'Alice Admin');
  });

  it('.one() returns null when no rows match', async () => {
    const user = await client.sql<{ id: number }>`
      SELECT id FROM users WHERE id = ${999999}
    `.one();
    assert.equal(user, null);
  });

  it('.scalar() returns the first column of the first row', async () => {
    // Hermetic literal — independent of how many rows other test files have
    // inserted into the shared database.
    const total = await client.sql<{ n: number }>`
      SELECT 123::int AS n
    `.scalar();
    assert.equal(typeof total, 'number');
    assert.equal(total, 123);
  });

  it('.scalar() returns null on empty result', async () => {
    const v = await client.sql<{ id: number }>`
      SELECT id FROM users WHERE id = ${-1}
    `.scalar();
    assert.equal(v, null);
  });

  it('INJECTION SAFETY: malicious value is treated as data, users table survives', async () => {
    // Pass a classic injection payload as an interpolated value. If it were
    // string-concatenated, this would (try to) drop the table. Because it is
    // bound as a parameter, it simply becomes a (non-matching) email filter.
    const evil = "x@example.com'; DROP TABLE users; --";
    const rows = await client.sql<{ id: number }>`
      SELECT id FROM users WHERE email = ${evil}
    `;
    assert.equal(rows.length, 0); // no email matches the payload string

    // The table must still exist and be queryable afterward — proof the DROP
    // never executed. (Asserting a live query succeeds is robust to row counts
    // mutated by other test files sharing this database.)
    const alive = await client.sql<{ n: number }>`SELECT 1::int AS n FROM users LIMIT 1`.scalar<number>();
    assert.equal(alive, 1);
  });

  it('multiple interpolations bind in order', async () => {
    const rows = await client.sql<{ id: number }>`
      SELECT id FROM users WHERE id >= ${2} AND id <= ${4} ORDER BY id
    `;
    assert.deepEqual(
      rows.map((r) => r.id),
      [2, 3, 4],
    );
  });
});
