/**
 * turbine-orm, `where` key validation, end to end through the code generator
 *
 * where-key-types.test.ts pins the TYPES against hand-written mock entities.
 * This test pins the GENERATOR: it builds a schema with columns, relations in
 * BOTH directions, and a self-relation, runs the real
 * `generateTypes` / `generateMetadata` / `generateIndex`, then compiles the
 * output against the current source with a usage file full of `@ts-expect-error`
 * typos. An unused `@ts-expect-error` is itself an error, so if the emitted
 * `*Relations` map ever stops reaching `QueryInterface<T, R>`, the single
 * thing that makes `where` key-checkable, `tsc` fails here.
 *
 * No new generator emission was needed for the fix: the generator has emitted
 * `*Relations` (with the `RelationDescriptor` brand) and threaded it into the
 * typed accessors since 0.7.1. The assertions below pin exactly that contract.
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

// authors ──hasMany──> books ──belongsTo──> authors   (both directions)
// authors ──belongsTo──> authors                      (self-relation)
const AUTHORS = table(
  'authors',
  [
    col('id', 'int8', 'number', { hasDefault: true }),
    col('name', 'text', 'string'),
    col('mentor_id', 'int8', 'number | null', { nullable: true }),
  ],
  ['id'],
);

const BOOKS = table(
  'books',
  [
    col('id', 'int8', 'number', { hasDefault: true }),
    col('title', 'text', 'string'),
    col('author_id', 'int8', 'number'),
  ],
  ['id'],
);

const FOREIGN_KEYS: ForeignKeyEntry[] = [
  {
    sourceTable: 'books',
    sourceColumns: ['author_id'],
    targetTable: 'authors',
    targetColumns: ['id'],
    constraintName: 'books_author_id_fkey',
  },
  {
    sourceTable: 'authors',
    sourceColumns: ['mentor_id'],
    targetTable: 'authors',
    targetColumns: ['id'],
    constraintName: 'authors_mentor_id_fkey',
  },
];

{
  const derived = buildRelationsFromForeignKeys(
    FOREIGN_KEYS,
    new Map([
      ['authors', new Set(AUTHORS.columns.map((c) => c.field))],
      ['books', new Set(BOOKS.columns.map((c) => c.field))],
    ]),
  );
  AUTHORS.relations = derived.get('authors') ?? {};
  BOOKS.relations = derived.get('books') ?? {};
}

const SCHEMA: SchemaMetadata = { enums: {}, tables: { authors: AUTHORS, books: BOOKS } };

const USAGE = `
import { TurbineClient } from './index.js';

declare const db: TurbineClient;

export async function ok(): Promise<void> {
  // Columns, operators, combinators.
  await db.authors.findMany({ where: { name: 'a', id: { gt: 1 }, OR: [{ name: 'b' }] } });
  // hasMany relation filter (authors -> books).
  await db.authors.findMany({ where: { books: { some: { title: 'x' } } } });
  // belongsTo relation filter (books -> author), both is/isNot and bare implicit is.
  await db.books.findMany({ where: { author: { is: { name: 'a' } } } });
  await db.books.findMany({ where: { author: { name: 'a' } } });
  // Self-relation, both sides.
  await db.authors.findMany({ where: { author: { is: { name: 'a' } } } });
  await db.authors.findMany({ where: { authors: { some: { name: 'a' } } } });
  // Nested \`with\` wheres, including through the self-relation.
  await db.authors.findMany({ with: { books: { where: { title: 'x' } } } });
  await db.authors.findMany({ with: { authors: { with: { books: { where: { title: 'x' } } } } } });
  // Result inference is unchanged.
  const rows = await db.authors.findMany({ with: { books: { with: { author: true } } } });
  const title: string = rows[0]!.books[0]!.title;
  const name: string = rows[0]!.books[0]!.author!.name;
  void title;
  void name;
}

export async function typos(): Promise<void> {
  // @ts-expect-error - 'naem' is not a column or relation of Author
  await db.authors.findMany({ where: { naem: 'a' } });
  // @ts-expect-error - 'bookz' is not a relation of Author
  await db.authors.findMany({ where: { bookz: { some: { title: 'x' } } } });
  // @ts-expect-error - typo inside a hasMany relation filter
  await db.authors.findMany({ where: { books: { some: { titel: 'x' } } } });
  // @ts-expect-error - typo inside a belongsTo relation filter
  await db.books.findMany({ where: { author: { is: { naem: 'a' } } } });
  // @ts-expect-error - typo inside the self-relation filter
  await db.authors.findMany({ where: { author: { is: { naem: 'a' } } } });
  // @ts-expect-error - typo in a nested \`with\` where
  await db.authors.findMany({ with: { books: { where: { titel: 'x' } } } });
  // @ts-expect-error - typo in a nested \`with\` where through the self-relation
  await db.authors.findMany({ with: { authors: { where: { naem: 'a' } } } });
  // @ts-expect-error - typo in findUnique
  await db.books.findUnique({ where: { titel: 'x' } });
  // @ts-expect-error - typo in update
  await db.books.update({ where: { titel: 'x' }, data: {} });
}
`;

describe('generator emission keeps `where` key-checkable', () => {
  it('emits *Relations for both directions and the self-relation, threaded into the accessor', () => {
    const types = generateTypes(SCHEMA);
    const index = generateIndex(SCHEMA);

    // Both directions plus the self-relation, each carrying the
    // RelationDescriptor brand that `WhereClause<T, R>` reads.
    assert.match(types, /export interface AuthorRelations \{/);
    assert.match(types, /books: RelationDescriptor<Book, 'many', BookRelations>;/);
    assert.match(
      types,
      /author: RelationDescriptor<Author, 'one', AuthorRelations>;\n {2}authors: RelationDescriptor<Author, 'many', AuthorRelations>;/,
    );
    assert.match(types, /export interface BookRelations \{/);
    assert.match(types, /author: RelationDescriptor<Author, 'one', AuthorRelations>;/);

    // The relations map must reach the table accessor's second type argument -
    // that is the ONLY thing that makes `where` keys checkable.
    assert.match(index, /readonly authors: QueryInterface<Author, AuthorRelations>/);
    assert.match(index, /readonly books: QueryInterface<Book, BookRelations>/);
  });

  it('tsc --noEmit rejects `where` typos in the generated client (and accepts every real shape)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'turbine-where-keys-'));
    try {
      writeFileSync(join(dir, 'types.ts'), generateTypes(SCHEMA), 'utf-8');
      writeFileSync(join(dir, 'metadata.ts'), generateMetadata(SCHEMA), 'utf-8');
      writeFileSync(join(dir, 'index.ts'), generateIndex(SCHEMA), 'utf-8');
      writeFileSync(join(dir, 'usage.ts'), USAGE, 'utf-8');
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
            paths: { 'turbine-orm': [join(repoRoot, 'src', 'index.ts')] },
          },
          include: ['*.ts', join(repoRoot, 'types', '**', '*.d.ts')],
        }),
        'utf-8',
      );
      const tsc = join(repoRoot, 'node_modules', '.bin', 'tsc');
      const result = spawnSync(tsc, ['--noEmit', '-p', dir], { cwd: repoRoot, encoding: 'utf-8', timeout: 120_000 });
      assert.equal(result.status, 0, `generated client where-key gate failed:\n${result.stdout}\n${result.stderr}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
