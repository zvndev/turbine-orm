/**
 * turbine-orm — `_count: { _all: true }` record form (finding 9)
 *
 * Build-only SQL + transform assertions for the reserved `_all` COUNT(*) key on
 * BOTH `aggregate` and `groupBy`. Scalar `_count: true` stays byte-identical.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { SchemaMetadata } from '../schema.js';
import { makeQuery, mockTable } from './helpers.js';

function schema(): SchemaMetadata {
  return {
    enums: {},
    tables: {
      users: mockTable('users', [
        { name: 'id', field: 'id' },
        { name: 'org_id', field: 'orgId' },
        { name: 'email', field: 'email', pgType: 'text' },
      ]),
    },
  };
}

describe('aggregate _count: { _all: true }', () => {
  it('emits COUNT(*) AS "_count__all" and transforms to { _count: { _all: n } }', () => {
    const q = makeQuery('users', schema());
    const { sql, transform } = q.buildAggregate({ _count: { _all: true } } as never);
    assert.match(sql, /COUNT\(\*\)::int AS "_count__all"/);
    // The double-underscore alias must never collide with a real column count.
    assert.doesNotMatch(sql, /AS "_count_all"(?!_)/);
    const out = transform({ rows: [{ _count__all: 7 }] } as never);
    assert.deepEqual(out, { _count: { _all: 7 } });
  });

  it('mixed _all + field yields COUNT(*) and COUNT(col) with a merged record', () => {
    const q = makeQuery('users', schema());
    const { sql, transform } = q.buildAggregate({ _count: { _all: true, email: true } } as never);
    assert.match(sql, /COUNT\(\*\)::int AS "_count__all"/);
    assert.match(sql, /COUNT\("email"\)::int AS "_count_email"/);
    const out = transform({ rows: [{ _count__all: 5, _count_email: 3 }] } as never);
    assert.deepEqual(out, { _count: { _all: 5, email: 3 } });
  });

  it('scalar _count: true is byte-identical to before', () => {
    const q = makeQuery('users', schema());
    const { sql, transform } = q.buildAggregate({ _count: true } as never);
    assert.match(sql, /COUNT\(\*\)::int AS _count\b/);
    assert.doesNotMatch(sql, /_count__all/);
    assert.deepEqual(transform({ rows: [{ _count: 42 }] } as never), { _count: 42 });
  });

  it('per-field record without _all still works (pre-existing shape unchanged)', () => {
    const q = makeQuery('users', schema());
    const { sql, transform } = q.buildAggregate({ _count: { email: true } } as never);
    assert.match(sql, /COUNT\("email"\)::int AS "_count_email"/);
    assert.doesNotMatch(sql, /_count__all/);
    assert.deepEqual(transform({ rows: [{ _count_email: 9 }] } as never), { _count: { email: 9 } });
  });
});

describe('groupBy _count: { _all: true }', () => {
  it('record form nests { _all, field } per group', () => {
    const q = makeQuery('users', schema());
    const { sql, transform } = q.buildGroupBy({ by: ['orgId'], _count: { _all: true } } as never);
    assert.match(sql, /COUNT\(\*\)::int AS "_count__all"/);
    // The scalar `_count` column is NOT emitted for the record form.
    assert.doesNotMatch(sql, /COUNT\(\*\)::int AS _count\b/);
    const out = transform({ rows: [{ org_id: 1, _count__all: 4 }] } as never);
    assert.deepEqual(out, [{ orgId: 1, _count: { _all: 4 } }]);
  });

  it('record form with _all + a field key', () => {
    const q = makeQuery('users', schema());
    const { sql, transform } = q.buildGroupBy({ by: ['orgId'], _count: { _all: true, email: true } } as never);
    assert.match(sql, /COUNT\(\*\)::int AS "_count__all"/);
    assert.match(sql, /COUNT\("email"\)::int AS "_count_email"/);
    const out = transform({ rows: [{ org_id: 2, _count__all: 6, _count_email: 5 }] } as never);
    assert.deepEqual(out, [{ orgId: 2, _count: { _all: 6, email: 5 } }]);
  });

  it('scalar _count: true stays a number (byte-identical to before)', () => {
    const q = makeQuery('users', schema());
    const { sql, transform } = q.buildGroupBy({ by: ['orgId'], _count: true } as never);
    assert.match(sql, /COUNT\(\*\)::int AS _count\b/);
    assert.doesNotMatch(sql, /_count__all/);
    assert.deepEqual(transform({ rows: [{ org_id: 3, _count: 11 }] } as never), [{ orgId: 3, _count: 11 }]);
  });

  it('omitted _count still defaults to the scalar COUNT(*) column', () => {
    const q = makeQuery('users', schema());
    const { sql } = q.buildGroupBy({ by: ['orgId'] } as never);
    assert.match(sql, /COUNT\(\*\)::int AS _count\b/);
    assert.doesNotMatch(sql, /_count__all/);
  });

  it('orderBy _count and having _count compile when the record form contains _all', () => {
    const q = makeQuery('users', schema());
    const { sql } = q.buildGroupBy({
      by: ['orgId'],
      _count: { _all: true },
      orderBy: { _count: 'desc' },
      having: { _count: { gt: 1 } },
    } as never);
    assert.match(sql, /COUNT\(\*\)::int AS "_count__all"/);
    assert.match(sql, /ORDER BY COUNT\(\*\) DESC/);
    assert.match(sql, /HAVING COUNT\(\*\) > \$1/);
  });

  it('ordering by _count with a record form lacking _all is rejected (COUNT(*) not selected)', () => {
    const q = makeQuery('users', schema());
    assert.throws(
      () => q.buildGroupBy({ by: ['orgId'], _count: { email: true }, orderBy: { _count: 'desc' } } as never),
      /_count is not selected/,
    );
  });
});
