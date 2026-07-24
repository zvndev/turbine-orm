/**
 * turbine-orm: the PII contract on the aggregate surface (build-only, no DB).
 *
 * Row projections have always excluded PII-tagged columns; aggregates used to
 * leak them. `groupBy({ by: ['email'] })` emits one row per distinct plaintext
 * email, and `_min`/`_max` return a stored cell verbatim, so both now REQUIRE
 * the same `includePii: true` opt-in reads use and otherwise throw
 * `ValidationError` (E003).
 *
 * Deliberately still allowed with no opt-in: `_count` (a count, not a value),
 * `_sum` / `_avg` (a total computed across rows), and `where` / `orderBy` /
 * `having` on PII columns (they return no values).
 *
 * Run: npx tsx --test src/test/pii-aggregates.test.ts
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ValidationError } from '../errors.js';
import { PowqlInterface } from '../powql.js';
import type { QueryInterface } from '../query/index.js';
import type { SchemaMetadata, TableMetadata } from '../schema.js';
import { makeQuery, mockTable } from './helpers.js';

/** users(id, name, email[PII], spend, profile[PII json]) */
function usersSchema(pii = true): SchemaMetadata {
  const users = mockTable('users', [
    { name: 'id', field: 'id' },
    { name: 'name', field: 'name', pgType: 'text' },
    { name: 'email', field: 'email', pgType: 'text' },
    { name: 'spend', field: 'spend', pgType: 'numeric' },
    { name: 'profile', field: 'profile', pgType: 'jsonb' },
  ]);
  if (pii) {
    setPii(users, 'email');
    setPii(users, 'profile');
  }
  return { enums: {}, tables: { users } };
}

function setPii(table: TableMetadata, columnName: string): void {
  const col = table.columns.find((c) => c.name === columnName);
  if (!col) throw new Error(`test fixture: no column "${columnName}" on "${table.name}"`);
  col.pii = true;
}

function usersQuery(pii = true): QueryInterface<Record<string, unknown>> {
  return makeQuery('users', usersSchema(pii)) as unknown as QueryInterface<Record<string, unknown>>;
}

/** Assert the thrown error is the typed E003 refusal and names the way out. */
function assertPiiRefusal(fn: () => unknown, column: string): void {
  assert.throws(fn, (err: unknown) => {
    assert.ok(err instanceof ValidationError, `expected ValidationError, got ${String(err)}`);
    assert.equal(err.code, 'TURBINE_E003');
    assert.match(err.message, new RegExp(`"${column}"`));
    assert.match(err.message, /PII-tagged/);
    assert.match(err.message, /includePii: true/);
    return true;
  });
}

// ---------------------------------------------------------------------------
// groupBy
// ---------------------------------------------------------------------------

describe('groupBy on a PII column requires includePii', () => {
  it('refuses a PII `by` key with E003', () => {
    assertPiiRefusal(() => usersQuery().buildGroupBy({ by: ['email'], _count: true }), 'email');
  });

  it('refuses a PII JSON `by` key with E003', () => {
    assertPiiRefusal(
      () =>
        usersQuery().buildGroupBy({
          // biome-ignore lint/suspicious/noExplicitAny: JSON group key shape
          by: [{ field: 'profile', path: ['city'] } as any],
          _count: true,
        }),
      'profile',
    );
  });

  it('compiles with includePii: true and groups on the raw column', () => {
    const { sql } = usersQuery().buildGroupBy({ by: ['email'], _count: true, includePii: true });
    assert.match(sql, /GROUP BY "email"/);
    assert.match(sql, /SELECT "email"/);
  });

  it('a non-PII `by` key is unaffected', () => {
    const { sql } = usersQuery().buildGroupBy({ by: ['name'], _count: true });
    assert.match(sql, /GROUP BY "name"/);
  });
});

describe('groupBy aggregates over a PII column', () => {
  it('refuses _min and _max without includePii', () => {
    assertPiiRefusal(() => usersQuery().buildGroupBy({ by: ['name'], _min: { email: true } }), 'email');
    assertPiiRefusal(() => usersQuery().buildGroupBy({ by: ['name'], _max: { email: true } }), 'email');
  });

  it('refuses a PII JSON _min target without includePii', () => {
    assertPiiRefusal(
      () =>
        usersQuery().buildGroupBy({
          by: ['name'],
          // biome-ignore lint/suspicious/noExplicitAny: JSON aggregate target shape
          _min: { city: { field: 'profile', path: ['city'], type: 'text' } as any },
        }),
      'profile',
    );
  });

  it('allows _min / _max with includePii', () => {
    const { sql } = usersQuery().buildGroupBy({ by: ['name'], _min: { email: true }, includePii: true });
    assert.match(sql, /MIN\("email"\)/);
  });

  it('allows _count / _sum / _avg over a PII column with no opt-in', () => {
    const counted = usersQuery().buildGroupBy({ by: ['name'], _count: { email: true } });
    assert.match(counted.sql, /COUNT\("email"\)/);
    const summed = usersQuery().buildGroupBy({ by: ['name'], _sum: { email: true } });
    assert.match(summed.sql, /SUM\("email"\)/);
    const averaged = usersQuery().buildGroupBy({ by: ['name'], _avg: { email: true } });
    assert.match(averaged.sql, /AVG\("email"\)/);
  });

  it('allows where / orderBy / having that reference a PII column', () => {
    const { sql } = usersQuery().buildGroupBy({
      by: ['name'],
      where: { email: { contains: '@example.com' } },
      _count: true,
      // biome-ignore lint/suspicious/noExplicitAny: HavingClause over a Record<string, unknown> entity
      having: { _count: { gt: 1 } } as any,
      orderBy: { name: 'desc' },
    });
    assert.match(sql, /WHERE "email" LIKE/);
    assert.match(sql, /HAVING/);
    assert.doesNotMatch(sql, /SELECT "email"/);
  });
});

// ---------------------------------------------------------------------------
// aggregate()
// ---------------------------------------------------------------------------

describe('aggregate _min / _max on a PII column requires includePii', () => {
  it('refuses _min and _max with E003', () => {
    assertPiiRefusal(() => usersQuery().buildAggregate({ _min: { email: true } }), 'email');
    assertPiiRefusal(() => usersQuery().buildAggregate({ _max: { email: true } }), 'email');
  });

  it('allows them with includePii: true', () => {
    const { sql } = usersQuery().buildAggregate({ _min: { email: true }, _max: { email: true }, includePii: true });
    assert.match(sql, /MIN\("email"\) AS "_min_email"/);
    assert.match(sql, /MAX\("email"\) AS "_max_email"/);
  });

  it('allows _count / _sum / _avg with no opt-in', () => {
    const { sql } = usersQuery().buildAggregate({
      _count: { email: true },
      _sum: { email: true },
      _avg: { email: true },
    });
    assert.match(sql, /COUNT\("email"\)/);
    assert.match(sql, /SUM\("email"\)/);
    assert.match(sql, /AVG\("email"\)/);
  });
});

// ---------------------------------------------------------------------------
// No drift for untagged schemas, and no cached-plan leak
// ---------------------------------------------------------------------------

describe('untagged schemas are byte-identical', () => {
  it('emits exactly the same groupBy / aggregate SQL as before the gate', () => {
    const plain = usersQuery(false);
    assert.equal(
      plain.buildGroupBy({ by: ['email'], _min: { email: true }, _count: true }).sql,
      'SELECT "email", COUNT(*)::int AS _count, MIN("email") AS "_min_email" FROM "users" GROUP BY "email"',
    );
    assert.equal(
      plain.buildAggregate({ _min: { email: true } }).sql,
      'SELECT MIN("email") AS "_min_email" FROM "users"',
    );
  });

  it('a PII schema with includePii emits that same SQL', () => {
    assert.equal(
      usersQuery().buildGroupBy({ by: ['email'], _min: { email: true }, _count: true, includePii: true }).sql,
      usersQuery(false).buildGroupBy({ by: ['email'], _min: { email: true }, _count: true }).sql,
    );
  });
});

// ---------------------------------------------------------------------------
// PowDB parity: PowqlInterface applies the same policy (one policy, all engines)
// ---------------------------------------------------------------------------

describe('PowQL aggregates apply the same PII policy', () => {
  /** A pool that fails loudly: every assertion below must throw before any exec. */
  const refusingPool = {
    query: () => {
      throw new Error('test: the PII gate must refuse before any PowQL statement runs');
    },
  } as never;

  const powqlUsers = () => new PowqlInterface(refusingPool, 'users', usersSchema());

  it('refuses a PII groupBy key, _min and _max, with E003', async () => {
    await assert.rejects(() => powqlUsers().groupBy({ by: ['email'], _count: true }), ValidationError);
    await assert.rejects(() => powqlUsers().groupBy({ by: ['name'], _min: { email: true } }), ValidationError);
    await assert.rejects(() => powqlUsers().aggregate({ _max: { email: true } }), ValidationError);
  });

  it('the refusal names the column and the opt-in', async () => {
    await assert.rejects(
      () => powqlUsers().aggregate({ _min: { email: true } }),
      (err: unknown) => {
        assert.ok(err instanceof ValidationError);
        assert.match(err.message, /"email"/);
        assert.match(err.message, /includePii: true/);
        return true;
      },
    );
  });
});

describe('includePii cannot be served from a stale plan', () => {
  it('the same interface refuses after an includePii call (aggregates never cache SQL)', () => {
    const q = usersQuery();
    // Compile the opt-in form first: if a plan were cached projection-blind,
    // the next (non-opt-in) call could be served from it.
    assert.match(q.buildGroupBy({ by: ['email'], _count: true, includePii: true }).sql, /GROUP BY "email"/);
    assertPiiRefusal(() => q.buildGroupBy({ by: ['email'], _count: true }), 'email');
    assert.match(q.buildAggregate({ _min: { email: true }, includePii: true }).sql, /MIN\("email"\)/);
    assertPiiRefusal(() => q.buildAggregate({ _min: { email: true } }), 'email');
  });
});
