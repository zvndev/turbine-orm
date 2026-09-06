/**
 * turbine-orm, Generated output must TYPECHECK against the library it ships with
 *
 * Regression test for the v0.28.x "incorrectly extends" break: the base
 * `TurbineClient.$transaction` gained a batch-array overload in v0.26, but the
 * generator's interface-merge for the typed client kept emitting only the
 * callback signature. A merged interface member must be compatible with the
 * base class member ON ITS OWN (TS2415), so every `turbine generate` output
 * failed `tsc` in user projects, while this repo's own string-pin tests
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

const DOCUMENTS = table(
  'documents',
  [
    col('id', 'int8', 'number', { hasDefault: true }),
    // Prisma-style quoted camelCase FK columns, both point at document_versions.
    col('currentVersionId', 'int8', 'number | null', { nullable: true }),
    col('publishedVersionId', 'int8', 'number | null', { nullable: true }),
    // Scalar column whose field equals the stripped relation name of
    // currentVersionId → forces the deterministic `Rel` suffix path.
    col('currentVersion', 'text', 'string | null', { nullable: true }),
  ],
  ['id'],
);

const DOCUMENT_VERSIONS = table(
  'document_versions',
  [col('id', 'int8', 'number', { hasDefault: true }), col('body', 'text', 'string')],
  ['id'],
);

// Documented call forms need a table with a natural-key PK (a `text` primary
// key with no default must be REQUIRED in `*Create`) and a two-hop to-one
// chain (`comments -> post -> user`) for the relation `orderBy` form.
const USERS = table(
  'users',
  [col('id', 'int8', 'number', { hasDefault: true, isGenerated: true }), col('email', 'text', 'string')],
  ['id'],
);

const TAGS = table('tags', [col('slug', 'text', 'string'), col('label', 'text', 'string')], ['slug']);

const POSTS = table(
  'posts',
  [
    col('id', 'int8', 'number', { hasDefault: true, isGenerated: true }),
    col('user_id', 'int8', 'number'),
    col('title', 'text', 'string'),
  ],
  ['id'],
);

const COMMENTS = table(
  'comments',
  [
    col('id', 'int8', 'number', { hasDefault: true, isGenerated: true }),
    col('post_id', 'int8', 'number'),
    col('body', 'text', 'string'),
  ],
  ['id'],
);

const FOREIGN_KEYS: ForeignKeyEntry[] = [
  {
    sourceTable: 'documents',
    sourceColumns: ['currentVersionId'],
    targetTable: 'document_versions',
    targetColumns: ['id'],
    constraintName: 'documents_currentVersionId_fkey',
  },
  {
    sourceTable: 'documents',
    sourceColumns: ['publishedVersionId'],
    targetTable: 'document_versions',
    targetColumns: ['id'],
    constraintName: 'documents_publishedVersionId_fkey',
  },
  {
    sourceTable: 'posts',
    sourceColumns: ['user_id'],
    targetTable: 'users',
    targetColumns: ['id'],
    constraintName: 'posts_user_id_fkey',
  },
  {
    sourceTable: 'comments',
    sourceColumns: ['post_id'],
    targetTable: 'posts',
    targetColumns: ['id'],
    constraintName: 'comments_post_id_fkey',
  },
];

const RELATION_TABLES = [DOCUMENTS, DOCUMENT_VERSIONS, USERS, TAGS, POSTS, COMMENTS];

// Derive relations exactly the way `turbine generate` introspection does
// (silencing the expected collision warning for `currentVersion`).
{
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    const derived = buildRelationsFromForeignKeys(
      FOREIGN_KEYS,
      new Map(RELATION_TABLES.map((t) => [t.name, new Set(t.columns.map((c) => c.field))])),
    );
    for (const t of RELATION_TABLES) t.relations = derived.get(t.name) ?? {};
  } finally {
    console.warn = originalWarn;
  }
}

// Compile-time usage file dropped next to the generated output: pins that the
// scalar FK fields stay targetable AND the disambiguated relations exist.
const T4_USAGE = `
import type { RelationDescriptor } from 'turbine-orm';
import type {
  Document,
  DocumentCreate,
  DocumentRelations,
  DocumentVersion,
  DocumentVersionRelations,
} from './types.js';

// Scalar FK columns are still first-class writable fields.
export const create: DocumentCreate = {
  currentVersionId: 1,
  publishedVersionId: null,
  currentVersion: 'draft',
};

// The belongsTo relations exist under their column-derived (suffix-stripped,
// collision-disambiguated) names, never shadowing the scalars.
export type CurrentVersionRel = DocumentRelations['currentVersionRel'];
export type PublishedVersionRel = DocumentRelations['publishedVersion'];
type AssertOne<T extends RelationDescriptor<DocumentVersion, 'one', DocumentVersionRelations>> = T;
export type _one = AssertOne<PublishedVersionRel>;

// The reverse hasMany side gets one distinct relation per FK column. These
// keep main's LEGACY derivation (the raw column with '_by_' composition -
// collision-free, so it must survive a regen unchanged; N-1a).
export type ByCurrent = DocumentVersionRelations['documentsByCurrentVersionId'];
export type ByPublished = DocumentVersionRelations['documentsByPublishedVersionId'];
type AssertMany<T extends RelationDescriptor<Document, 'many', DocumentRelations>> = T;
export type _many = AssertMany<ByCurrent>;
`;

// Every call form the docs show on a generated client, in one consumer file.
// Each line here is a sentence somewhere in the public docs; the file exists so
// that a base-class signature change (return type, callback parameter type,
// constructor arity) fails THIS test instead of a reader's `tsc`.
const CALL_FORMS_USAGE = `
import { TurbineClient as BaseTurbineClient } from 'turbine-orm';
import { SCHEMA, TurbineClient, turbine } from './index.js';
import type { TagCreate } from './types.js';

declare const db: TurbineClient;

// Read-your-own-write: the primary-pinned view keeps the generated accessors.
export async function primaryRead(): Promise<string | undefined> {
  const user = await db.$primary().users.findFirst({ where: { email: 'a@b.com' } });
  return user?.email;
}

// RLS shorthand: the session callback receives the TYPED transaction client.
export async function sessionRead(): Promise<string | undefined> {
  const rows = await db.$withSession({ 'app.current_tenant': 1 }, (tx) => tx.users.findMany());
  return rows[0]?.email;
}

// The base class takes (config, schema); the generated subclass and factory take config only.
export const base = new BaseTurbineClient({ connectionString: 'postgres://localhost/app' }, SCHEMA);
export const generated = new TurbineClient({ connectionString: 'postgres://localhost/app' });
export const viaFactory = turbine({ connectionString: 'postgres://localhost/app' });

// A text primary key with no default and no identity is REQUIRED on create.
export const tag: TagCreate = { slug: 'ts', label: 'TypeScript' };
// @ts-expect-error slug has no default, so omitting it must not compile
export const tagWithoutPk: TagCreate = { label: 'TypeScript' };
`;

// Two-hop to-one relation ordering, documented as "the chain can be more than
// one hop long". The builder accepts any depth; the public type must too.
const TWO_HOP_ORDER_BY_USAGE = `
import type { TurbineClient } from './index.js';

declare const db: TurbineClient;

export const ordered = db.comments.findMany({ orderBy: { post: { user: { email: 'asc' } } } });
`;

const SCHEMA: SchemaMetadata = {
  enums: {},
  tables: {
    documents: DOCUMENTS,
    document_versions: DOCUMENT_VERSIONS,
    users: USERS,
    tags: TAGS,
    posts: POSTS,
    comments: COMMENTS,
  },
};

/**
 * Write a freshly generated client plus the given consumer files into a temp
 * project and run `tsc --noEmit` over it against the CURRENT source types.
 * Returns the tsc output so a failing assertion quotes the real diagnostics.
 */
function typecheckGenerated(consumers: Record<string, string>): { status: number | null; output: string } {
  const dir = mkdtempSync(join(tmpdir(), 'turbine-gen-typecheck-'));
  try {
    writeFileSync(join(dir, 'types.ts'), generateTypes(SCHEMA), 'utf-8');
    writeFileSync(join(dir, 'metadata.ts'), generateMetadata(SCHEMA), 'utf-8');
    writeFileSync(join(dir, 'index.ts'), generateIndex(SCHEMA), 'utf-8');
    for (const [name, source] of Object.entries(consumers)) writeFileSync(join(dir, name), source, 'utf-8');
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
          // Compile the generated output against the CURRENT source types -
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
    return { status: result.status, output: `${result.stdout}\n${result.stderr}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('generated client typechecks against the shipped client types', () => {
  it('tsc --noEmit passes on generate output plus the documented call forms', () => {
    // T-4 gate: same-target FK columns must yield strict-clean, targetable
    // types. Call-forms gate: $primary(), $withSession, both constructor
    // arities and a required natural-key PK, all as the docs write them.
    const result = typecheckGenerated({ 'usage.ts': T4_USAGE, 'call-forms.ts': CALL_FORMS_USAGE });
    assert.equal(result.status, 0, `generated client failed to typecheck:\n${result.output}`);
  });

  it('a two-hop to-one relation orderBy typechecks on the generated client', () => {
    const result = typecheckGenerated({ 'two-hop.ts': TWO_HOP_ORDER_BY_USAGE });
    assert.equal(result.status, 0, `two-hop relation orderBy failed to typecheck:\n${result.output}`);
  });
});
