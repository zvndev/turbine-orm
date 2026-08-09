/**
 * turbine-orm - Prisma migration: named `@map`, FK disagreement, and the
 * constructs the parser used to drop in silence.
 *
 * Four regressions, all of them SILENT before:
 *
 *   1. `@map(name: "legacy_name")` on a FIELD was ignored (only the positional
 *      form was read), so the resolver fell back to the Prisma field name. In a
 *      legacy database that name is frequently a real column of its own, so the
 *      report said `name -> name (column name)` and looked CLEAN while every
 *      read returned another column's data and every write landed in the wrong
 *      column. The same bug sat in the enum `@@map` reader.
 *   2. A `@relation(fields: [...])` naming columns no database FK uses fell
 *      through to "there is one candidate, take it", so `editor` bound to the
 *      AUTHOR foreign key and `hasUnresolved` reported complete. That is the
 *      shape `relationMode = "prisma"` produces.
 *   3. Two models resolving to ONE table were accepted; `prisma-compat` indexes
 *      relation targets by table last-writer-wins, so nested reshaping silently
 *      picked whichever model was declared last.
 *   4. `@@ignore` / `@@schema` / `@@fulltext` / `@ignore` / `Unsupported(...)` /
 *      `view` blocks were parsed and dropped with `warnings: []`, `@db.X` kept
 *      only its arguments (so Text / Uuid / Money / Citext were
 *      indistinguishable), and `Unsupported("tsvector")?` recorded
 *      `optional: false`, inverting required and optional.
 *
 * No database needed: these drive the parser and the resolver against
 * hand-built metadata.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { resolvePrismaSchema } from '../cli/prisma-resolve.js';
import { parsePrismaSchema } from '../cli/prisma-schema.js';
import type { RelationDef, SchemaMetadata, TableMetadata } from '../schema.js';

// ---------------------------------------------------------------------------
// Metadata fixtures
// ---------------------------------------------------------------------------

function table(name: string, columns: string[], relations: Record<string, RelationDef> = {}): TableMetadata {
  const columnMap: Record<string, string> = {};
  const reverseColumnMap: Record<string, string> = {};
  for (const c of columns) {
    const field = c.replace(/_([a-z])/g, (_, ch: string) => ch.toUpperCase());
    columnMap[field] = c;
    reverseColumnMap[c] = field;
  }
  return {
    name,
    entityName: name,
    primaryKey: ['id'],
    columns: columns.map((c) => ({
      name: c,
      field: reverseColumnMap[c]!,
      pgType: 'text',
      dialectType: 'text',
      tsType: 'string',
      nullable: true,
      hasDefault: false,
      isGenerated: false,
      isArray: false,
      arrayType: 'text[]',
      pgArrayType: 'text[]',
    })),
    columnMap,
    reverseColumnMap,
    allColumns: columns,
    dateColumns: [],
    dialectTypes: {},
    pgTypes: {},
    relations,
    indexes: [],
    uniqueColumns: [],
  } as unknown as TableMetadata;
}

function schemaOf(tables: TableMetadata[]): SchemaMetadata {
  return {
    tables: Object.fromEntries(tables.map((t) => [t.name, t])),
    enums: {},
  } as unknown as SchemaMetadata;
}

// ---------------------------------------------------------------------------
// 1. named @map
// ---------------------------------------------------------------------------

describe('field @map(name: "...")', () => {
  const meta = schemaOf([table('users', ['id', 'name', 'legacy_name'])]);

  it('resolves the NAMED form to the mapped column, not the Prisma field name', () => {
    const ast = parsePrismaSchema(`
      model User {
        id   String  @id
        name String? @map(name: "legacy_name")
        @@map("users")
      }
    `);
    const result = resolvePrismaSchema(ast, meta);
    const field = result.models[0]!.fields.find((f) => f.prismaName === 'name')!;
    assert.equal(field.status, 'resolved');
    assert.equal(field.column, 'legacy_name', 'the named @map argument names the column');
    assert.equal(field.turbineField, 'legacyName');
    // The trap: `name` IS a real column, so the old fallback resolved clean.
    assert.notEqual(field.column, 'name');
  });

  it('still resolves the positional form', () => {
    const ast = parsePrismaSchema(`
      model User {
        id   String  @id
        name String? @map("legacy_name")
        @@map("users")
      }
    `);
    const field = resolvePrismaSchema(ast, meta).models[0]!.fields.find((f) => f.prismaName === 'name')!;
    assert.equal(field.column, 'legacy_name');
  });

  it('reads a NAMED @@map on an enum block', () => {
    const ast = parsePrismaSchema(`
      enum Role {
        ADMIN
        @@map(name: "user_role")
      }
    `);
    assert.equal(ast.enums[0]?.map, 'user_role');
  });
});

// ---------------------------------------------------------------------------
// 2. @relation(fields: [...]) that matches no database FK
// ---------------------------------------------------------------------------

describe('@relation(fields: [...]) disagreeing with the database', () => {
  // posts has a real FK on author_id, and a plain FK-less editor_id column.
  const meta = schemaOf([
    table('users', ['id']),
    table('posts', ['id', 'author_id', 'editor_id'], {
      user: {
        type: 'belongsTo',
        name: 'user',
        from: 'posts',
        to: 'users',
        foreignKey: 'author_id',
        referenceKey: 'id',
      },
    }),
  ]);

  it('reports UNRESOLVED instead of binding to the author FK', () => {
    const ast = parsePrismaSchema(`
      model User {
        id String @id
        @@map("users")
      }
      model Post {
        id       String @id
        editorId String @map("editor_id")
        editor   User   @relation("edited", fields: [editorId], references: [id])
        @@map("posts")
      }
    `);
    const result = resolvePrismaSchema(ast, meta);
    const post = result.models.find((m) => m.prismaName === 'Post')!;
    const editor = post.relations.find((r) => r.prismaName === 'editor')!;
    assert.equal(editor.status, 'unresolved', 'positive evidence of disagreement must not be discarded');
    assert.equal(editor.turbineName, null);
    assert.match(editor.reason ?? '', /editor_id/);
    assert.match(editor.reason ?? '', /relationMode/);
    assert.equal(result.hasUnresolved, true, 'the report must not claim completeness');
    // And the bad mapping is not in the emitted map.
    assert.equal(result.map.models.Post?.relations.editor, undefined);
  });

  it('still resolves when the pinned columns DO match a database FK', () => {
    const ast = parsePrismaSchema(`
      model User {
        id String @id
        @@map("users")
      }
      model Post {
        id       String @id
        authorId String @map("author_id")
        author   User   @relation(fields: [authorId], references: [id])
        @@map("posts")
      }
    `);
    const post = resolvePrismaSchema(ast, meta).models.find((m) => m.prismaName === 'Post')!;
    const author = post.relations.find((r) => r.prismaName === 'author')!;
    assert.equal(author.status, 'resolved');
    assert.equal(author.turbineName, 'user');
  });

  it('leaves an unpinned relation field on the existing single-candidate path', () => {
    const ast = parsePrismaSchema(`
      model User {
        id    String @id
        posts Post[]
        @@map("users")
      }
      model Post {
        id     String @id
        author User
        @@map("posts")
      }
    `);
    const post = resolvePrismaSchema(ast, meta).models.find((m) => m.prismaName === 'Post')!;
    assert.equal(post.relations[0]?.status, 'resolved');
  });
});

// ---------------------------------------------------------------------------
// 3. duplicate table resolution
// ---------------------------------------------------------------------------

describe('two models resolving to one table', () => {
  it('marks BOTH unresolved and drops them from the map', () => {
    const meta = schemaOf([table('users', ['id'])]);
    const ast = parsePrismaSchema(`
      model AuthUser {
        id String @id
        @@map("users")
      }
      model PublicUser {
        id String @id
        @@map("users")
      }
    `);
    const result = resolvePrismaSchema(ast, meta);
    for (const m of result.models) {
      assert.equal(m.status, 'unresolved', `${m.prismaName} should be unresolved`);
      assert.match(m.reason ?? '', /2 models resolve to table "users"/);
    }
    assert.deepEqual(Object.keys(result.map.models), []);
    assert.equal(result.hasUnresolved, true);
  });

  it('leaves a one-to-one mapping alone', () => {
    const meta = schemaOf([table('users', ['id']), table('accounts', ['id'])]);
    const ast = parsePrismaSchema(`
      model User {
        id String @id
        @@map("users")
      }
      model Account {
        id String @id
        @@map("accounts")
      }
    `);
    const result = resolvePrismaSchema(ast, meta);
    assert.deepEqual(
      result.models.map((m) => m.status),
      ['resolved', 'resolved'],
    );
  });
});

// ---------------------------------------------------------------------------
// 4. constructs the parser used to drop silently
// ---------------------------------------------------------------------------

describe('parser notes for recognized-but-unhandled constructs', () => {
  it('preserves the native type name from @db.X', () => {
    const ast = parsePrismaSchema(`
      model User {
        id    String @id
        email String @db.VarChar(320)
        bio   String @db.Text
        ref   String @db.Uuid
      }
    `);
    const attrOf = (field: string) =>
      ast.models[0]!.fields.find((f) => f.name === field)!.attrs.find((a) => a.name === 'db')!;
    assert.equal(attrOf('email').nativeType, 'VarChar');
    assert.deepEqual(
      attrOf('email').args.map((a) => a.value),
      ['320'],
    );
    // The two that were completely indistinguishable before.
    assert.equal(attrOf('bio').nativeType, 'Text');
    assert.equal(attrOf('ref').nativeType, 'Uuid');
  });

  it('reads Unsupported("...") as OPTIONAL when it carries a trailing ?', () => {
    const ast = parsePrismaSchema(`
      model Doc {
        id     String  @id
        search Unsupported("tsvector")?
        tags   Unsupported("int4range")
      }
    `);
    const [, search, tags] = ast.models[0]!.fields;
    assert.equal(search?.type, 'Unsupported');
    assert.equal(search?.unsupported, 'tsvector');
    assert.equal(search?.optional, true, 'a nullable column must not be recorded as required');
    assert.equal(tags?.optional, false);
    assert.ok(ast.warnings.some((w) => w.includes('tsvector')));
  });

  it('warns for @@ignore, @@schema, @@fulltext and @ignore', () => {
    const ast = parsePrismaSchema(`
      model Legacy {
        id     String @id
        secret String @ignore
        @@ignore
        @@schema("auth")
        @@fulltext([secret])
      }
    `);
    const joined = ast.warnings.join('\n');
    assert.match(joined, /@@ignore/);
    assert.match(joined, /@@schema/);
    assert.match(joined, /@@fulltext/);
    assert.match(joined, /@ignore/);
  });

  it('warns that a Prisma view becomes a writable delegate', () => {
    const ast = parsePrismaSchema(`
      view ActiveUser {
        id String @id
      }
    `);
    assert.ok(
      ast.warnings.some((w) => w.includes('view ActiveUser') && /read-only/i.test(w)),
      `expected a view warning, got: ${JSON.stringify(ast.warnings)}`,
    );
  });

  it('warns for an unsupported top-level block (the branch nothing could reach)', () => {
    const ast = parsePrismaSchema(`
      composite Point {
        x Int
      }
      model User {
        id String @id
      }
    `);
    assert.ok(
      ast.warnings.some((w) => w.includes('composite Point')),
      `expected an unsupported-block warning, got: ${JSON.stringify(ast.warnings)}`,
    );
    // Still lenient: the real model is parsed.
    assert.equal(
      ast.models.some((m) => m.name === 'User'),
      true,
    );
  });

  it('stays silent for a schema using only handled constructs', () => {
    const ast = parsePrismaSchema(`
      datasource db { provider = "postgresql"  url = env("DATABASE_URL") }
      generator client { provider = "prisma-client-js" }
      enum Role { ADMIN USER }
      model User {
        id    String @id @default(uuid())
        email String @unique @map("email_address")
        posts Post[]
        @@map("users")
      }
      model Post {
        id       String @id
        authorId String
        author   User   @relation(fields: [authorId], references: [id])
        @@index([authorId])
        @@map("posts")
      }
    `);
    assert.deepEqual(ast.warnings, []);
  });
});
