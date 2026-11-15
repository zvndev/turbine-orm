/** Independent obligations of the pinned original catalogs, not facts supplied by a report. */
import assert from 'node:assert/strict';

const sqliteValues: Record<string, number> = {
  'headline-0': 100, 'headline-1': 50, 'headline-2': 10, 'headline-3': 1,
  'headline-4': 1, 'headline-5': 1, 'headline-6': 50000, 'headline-7': 1,
  'headline-8': 5, 'headline-9': 5, 'headline-10': 1,
  'large-5000': 5000, 'large-50000': 50000, 'large-wide': 1000,
  'list-page3': 20, 'list-deep': 0, 'relations-author': 500, 'relations-tags': 200,
  'relations-count': 100, 'relations-filter': 100, agg: 5, 'writes-bulk': 1000,
  'writes-update': 1, 'writes-upsert': 1, 'writes-delete': 1,
  'strategy-many': 200, 'strategy-one': 500, cold: 1, 'stream-parity': 50000, 'deep-offset': 0,
};
// 24K-row pagination corpus, page size 11; selective/final/empty and parent pages are distinct.
for (const [name, count] of Object.entries({
  tiny: 11, deep: 11, final: 5, empty: 0, 'selective-deep': 11, 'selective-final': 3,
  'selective-empty': 0, 'null-boundary': 11, 'null-cursor': 11, 'mixed-desc': 11, parents: 3,
})) for (const method of ['offset', 'provided', 'locate']) sqliteValues[`pagination-${name}-${method}`] = count;

export function sqlitePreflightValues(id: string): number {
  assert.ok(Object.hasOwn(sqliteValues, id), `Unknown SQLite correctness obligation: ${id}`);
  return sqliteValues[id]!;
}

export function mysqlPreflightInputs(id: string): number[] {
  return id === 'headline.hot' ? Array.from({ length: 50 }, (_, i) => i)
    : id === 'writes.update' || id === 'writes.upsert' ? [7, 19] : [0];
}

// Every measurement input declared by the original SQLite producer is required.
export const sqliteRequiredInputs = [
  'benchmarks/bench-sqlite.ts', 'benchmarks/sqlite-seed.ts',
  'benchmarks/sqlite-comparison-catalog.ts', 'benchmarks/sqlite-comparison-clients.ts',
  'benchmarks/sqlite-comparison-controls.ts', 'benchmarks/sqlite-comparison-types.d.ts',
  'benchmarks/postgres-pagination/corpus.mjs', 'benchmarks/sqlite-equivalence.ts',
  'benchmarks/sqlite-schema.ts', 'benchmarks/sqlite-schema-rc.ts', 'benchmarks/prisma/sqlite.prisma',
  'benchmarks/package-lock.json', 'benchmarks/comparison-versions.json', 'benchmarks/bench-harness.ts',
  'benchmarks/equivalence.ts', 'package.json', 'package-lock.json', 'src/sqlite.ts',
  'src/query/builder.ts', 'src/query/relations.ts', 'dist/sqlite.js', 'dist/query/builder.js',
  'dist/query/relations.js', 'benchmarks/generated/sqlite-turbine/runtime-identity.mjs',
  'benchmarks/generated/sqlite-turbine/index.ts', 'benchmarks/generated/sqlite-turbine/metadata.ts',
  'benchmarks/generated/sqlite-turbine/types.ts', 'benchmarks/generated/prisma-sqlite/index.js',
  'benchmarks/generated/prisma-sqlite/schema.prisma',
] as const;

export const sqliteRefusals = [
  'forceCustomPlan:TURBINE_E017', 'Prisma SQLite relationLoadStrategy join:validation refusal',
] as const;
