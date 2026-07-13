/**
 * turbine-orm — Generated output must TYPECHECK against the library it ships with
 *
 * Regression test for the v0.28.x "incorrectly extends" break: the base
 * `TurbineClient.$transaction` gained a batch-array overload in v0.26, but the
 * generator's interface-merge for the typed client kept emitting only the
 * callback signature. A merged interface member must be compatible with the
 * base class member ON ITS OWN (TS2415), so every `turbine generate` output
 * failed `tsc` in user projects — while this repo's own string-pin tests
 * stayed green, because the template still matched itself.
 *
 * String pins can't catch template ↔ client-type drift; only compiling the
 * generated output against the real source types can. This test runs `tsc
 * --noEmit` over a freshly generated client with `turbine-orm` path-mapped to
 * `src/index.ts`.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { generateIndex, generateMetadata, generateTypes } from '../generate.js';
import { buildRelationsFromForeignKeys, type ForeignKeyEntry } from '../introspect.js';
import type { ColumnMetadata, SchemaMetadata, TableMetadata } from '../schema.js';

// ---------------------------------------------------------------------------
// T-4 fixture: two FK columns to the SAME target table, with Prisma-style
// quoted camelCase column names, PLUS a scalar column (`currentVersion`) whose
// field collides with one FK's stripped relation name. Relations are derived
// through the REAL introspection naming path (buildRelationsFromForeignKeys)
// so this test gates the full pipeline: FK naming → codegen → tsc --strict.
// ---------------------------------------------------------------------------

function col(name: string, pgType: string, tsType: string, opts?: Partial<ColumnMetadata>): ColumnMetadata {
  return {
    name,
    field: name.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()),
    pgType,
    tsType,
    nullable: false,
    hasDefault: false,
    isArray: false,
    pgArrayType: `${pgType}[]`,
    ...opts,
  };
}

function table(name: string, columns: ColumnMetadata[], primaryKey: string[]): TableMetadata {
  const columnMap: Record<string, string> = {};
  const reverseColumnMap: Record<string, string> = {};
  const pgTypes: Record<string, string> = {};
  for (const c of columns) {
    columnMap[c.field] = c.name;
    reverseColumnMap[c.name] = c.field;
    pgTypes[c.name] = c.pgType;
  }
  return {
    name,
    columns,
    columnMap,
    reverseColumnMap,
    dateColumns: new Set<string>(),
    pgTypes,
    allColumns: columns.map((c) => c.name),
    primaryKey,
    uniqueColumns: [],
    indexes: [],
    isView: false,
    relations: {},
  };
}

const MODEL_INSTANCES = table(
  'model_instances',
  [
    col('id', 'int8', 'number', { hasDefault: true }),
    // Prisma-style quoted camelCase FK columns — both point at model_instance_versions.
    col('currentVersionId', 'int8', 'number | null', { nullable: true }),
    col('publishedVersionId', 'int8', 'number | null', { nullable: true }),
    // Scalar column whose field equals the stripped relation name of
    // currentVersionId → forces the deterministic `Rel` suffix path.
    col('currentVersion', 'text', 'string | null', { nullable: true }),
  ],
  ['id'],
);

const MODEL_INSTANCE_VERSIONS = table(
  'model_instance_versions',
  [col('id', 'int8', 'number', { hasDefault: true }), col('body', 'text', 'string')],
  ['id'],
);

const T4_FOREIGN_KEYS: ForeignKeyEntry[] = [
  {
    sourceTable: 'model_instances',
    sourceColumns: ['currentVersionId'],
    targetTable: 'model_instance_versions',
    targetColumns: ['id'],
    constraintName: 'model_instances_currentVersionId_fkey',
  },
  {
    sourceTable: 'model_instances',
    sourceColumns: ['publishedVersionId'],
    targetTable: 'model_instance_versions',
    targetColumns: ['id'],
    constraintName: 'model_instances_publishedVersionId_fkey',
  },
];

// Derive relations exactly the way `turbine generate` introspection does
// (silencing the expected collision warning for `currentVersion`).
{
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    const derived = buildRelationsFromForeignKeys(
      T4_FOREIGN_KEYS,
      new Map([
        ['model_instances', new Set(MODEL_INSTANCES.columns.map((c) => c.field))],
        ['model_instance_versions', new Set(MODEL_INSTANCE_VERSIONS.columns.map((c) => c.field))],
      ]),
    );
    MODEL_INSTANCES.relations = derived.get('model_instances') ?? {};
    MODEL_INSTANCE_VERSIONS.relations = derived.get('model_instance_versions') ?? {};
  } finally {
    console.warn = originalWarn;
  }
}

// Compile-time usage file dropped next to the generated output: pins that the
// scalar FK fields stay targetable AND the disambiguated relations exist.
const T4_USAGE = `
import type { RelationDescriptor } from 'turbine-orm';
import type {
  ModelInstance,
  ModelInstanceCreate,
  ModelInstanceRelations,
  ModelInstanceVersion,
  ModelInstanceVersionRelations,
} from './types.js';

// Scalar FK columns are still first-class writable fields.
export const create: ModelInstanceCreate = {
  currentVersionId: 1,
  publishedVersionId: null,
  currentVersion: 'draft',
};

// The belongsTo relations exist under their column-derived (suffix-stripped,
// collision-disambiguated) names, never shadowing the scalars.
export type CurrentVersionRel = ModelInstanceRelations['currentVersionRel'];
export type PublishedVersionRel = ModelInstanceRelations['publishedVersion'];
type AssertOne<T extends RelationDescriptor<ModelInstanceVersion, 'one', ModelInstanceVersionRelations>> = T;
export type _one = AssertOne<PublishedVersionRel>;

// The reverse hasMany side gets one distinct relation per FK column. These
// keep main's LEGACY derivation (the raw column with '_by_' composition —
// collision-free, so it must survive a regen unchanged; N-1a).
export type ByCurrent = ModelInstanceVersionRelations['modelInstancesByCurrentVersionId'];
export type ByPublished = ModelInstanceVersionRelations['modelInstancesByPublishedVersionId'];
type AssertMany<T extends RelationDescriptor<ModelInstance, 'many', ModelInstanceRelations>> = T;
export type _many = AssertMany<ByCurrent>;
`;

const SCHEMA: SchemaMetadata = {
  enums: {},
  tables: {
    model_instances: MODEL_INSTANCES,
    model_instance_versions: MODEL_INSTANCE_VERSIONS,
    users: {
      name: 'users',
      columns: [
        {
          name: 'id',
          field: 'id',
          pgType: 'int8',
          tsType: 'number',
          nullable: false,
          hasDefault: true,
          isArray: false,
          pgArrayType: 'bigint[]',
        },
        {
          name: 'email',
          field: 'email',
          pgType: 'text',
          tsType: 'string',
          nullable: false,
          hasDefault: false,
          isArray: false,
          pgArrayType: 'text[]',
        },
      ],
      columnMap: { id: 'id', email: 'email' },
      reverseColumnMap: { id: 'id', email: 'email' },
      dateColumns: new Set<string>(),
      pgTypes: { id: 'int8', email: 'text' },
      allColumns: ['id', 'email'],
      primaryKey: ['id'],
      uniqueColumns: [],
      indexes: [],
      isView: false,
      relations: {},
    },
  },
};

describe('generated client typechecks against the shipped client types', () => {
  it('tsc --noEmit passes on generate output (pins $transaction overload parity)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'turbine-gen-typecheck-'));
    try {
      writeFileSync(join(dir, 'types.ts'), generateTypes(SCHEMA), 'utf-8');
      writeFileSync(join(dir, 'metadata.ts'), generateMetadata(SCHEMA), 'utf-8');
      writeFileSync(join(dir, 'index.ts'), generateIndex(SCHEMA), 'utf-8');
      // T-4 gate: same-target FK columns must yield strict-clean, targetable types.
      writeFileSync(join(dir, 'usage.ts'), T4_USAGE, 'utf-8');
      const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
      writeFileSync(
        join(dir, 'tsconfig.json'),
        JSON.stringify({
          compilerOptions: {
            strict: true,
            noEmit: true,
            skipLibCheck: true,
            target: 'ES2022',
            module: 'NodeNext',
            moduleResolution: 'NodeNext',
            // Compile the generated output against the CURRENT source types —
            // this is exactly what drifts when the client class changes shape.
            paths: { 'turbine-orm': [join(repoRoot, 'src', 'index.ts')] },
          },
          // The repo's ambient shims (pg/lib/*) must ride along, same as the
          // main tsconfig's include of types/**/*.d.ts.
          include: ['*.ts', join(repoRoot, 'types', '**', '*.d.ts')],
        }),
        'utf-8',
      );
      const tsc = join(repoRoot, 'node_modules', '.bin', 'tsc');
      const result = spawnSync(tsc, ['--noEmit', '-p', dir], {
        cwd: repoRoot,
        encoding: 'utf-8',
        timeout: 120_000,
      });
      assert.equal(result.status, 0, `generated client failed to typecheck:\n${result.stdout}\n${result.stderr}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
