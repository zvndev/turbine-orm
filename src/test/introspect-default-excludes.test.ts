/**
 * turbine-orm: Default table exclusions (F12)
 *
 * Unit tests for `applyTableFilters` / `defaultExcludedTablesPresent`, the
 * single authority that turns a raw table list into the introspected set:
 * include filter, then user exclude, then the DEFAULT_EXCLUDED_TABLES
 * bookkeeping-table drop, with `include` as the escape hatch.
 *
 * Run: npx tsx --test src/test/introspect-default-excludes.test.ts
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { applyTableFilters, DEFAULT_EXCLUDED_TABLES, defaultExcludedTablesPresent } from '../introspect.js';

describe('DEFAULT_EXCLUDED_TABLES', () => {
  it('is exactly Turbine + Prisma bookkeeping tables', () => {
    assert.deepEqual([...DEFAULT_EXCLUDED_TABLES], ['_turbine_migrations', '_prisma_migrations', '_turbine_metrics']);
  });
});

describe('applyTableFilters', () => {
  it('drops the default bookkeeping tables with no options', () => {
    const out = applyTableFilters(['users', 'posts', '_turbine_migrations', '_prisma_migrations', '_turbine_metrics']);
    assert.deepEqual(out, ['users', 'posts']);
  });

  it('keeps a default-excluded table when it is explicitly included', () => {
    const out = applyTableFilters(['users', '_prisma_migrations'], { include: ['users', '_prisma_migrations'] });
    assert.deepEqual(out, ['users', '_prisma_migrations']);
  });

  it('include filter keeps only the named tables (defaults still dropped)', () => {
    const out = applyTableFilters(['users', 'posts', '_turbine_migrations'], { include: ['users'] });
    assert.deepEqual(out, ['users']);
  });

  it('applies the user exclude filter', () => {
    const out = applyTableFilters(['users', 'posts', 'audit'], { exclude: ['audit'] });
    assert.deepEqual(out, ['users', 'posts']);
  });

  it('composes include, exclude, and defaults', () => {
    const out = applyTableFilters(['users', 'posts', 'audit', '_turbine_metrics', '_prisma_migrations'], {
      include: ['users', 'posts', 'audit', '_prisma_migrations'],
      exclude: ['audit'],
    });
    // include keeps the four named; exclude drops audit; defaults drop
    // _turbine_metrics but NOT _prisma_migrations (explicitly included).
    assert.deepEqual(out, ['users', 'posts', '_prisma_migrations']);
  });

  it('never blanket-excludes a non-listed leading-underscore table', () => {
    const out = applyTableFilters(['users', '_my_audit', '_turbine_migrations']);
    assert.deepEqual(out, ['users', '_my_audit']);
  });

  it('does not mutate the input array', () => {
    const input = ['users', '_turbine_migrations'];
    applyTableFilters(input);
    assert.deepEqual(input, ['users', '_turbine_migrations']);
  });
});

describe('defaultExcludedTablesPresent', () => {
  it('reports the default tables that were present and dropped', () => {
    assert.deepEqual(defaultExcludedTablesPresent(['users', '_turbine_migrations', '_prisma_migrations']), [
      '_turbine_migrations',
      '_prisma_migrations',
    ]);
  });

  it('excludes a default table that was re-added via include', () => {
    assert.deepEqual(
      defaultExcludedTablesPresent(['_turbine_migrations', '_prisma_migrations'], { include: ['_prisma_migrations'] }),
      ['_turbine_migrations'],
    );
  });

  it('returns [] when no bookkeeping tables are present', () => {
    assert.deepEqual(defaultExcludedTablesPresent(['users', 'posts']), []);
  });
});
