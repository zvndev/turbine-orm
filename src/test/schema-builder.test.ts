/**
 * @batadata/turbine — Schema builder tests
 *
 * Tests the schema definition API and SQL generation:
 *   1. Builds the benchmark schema using defineSchema + table + column
 *   2. Generates SQL and verifies CREATE TABLE statements
 *   3. Tests schemaToSQL output matches the reference schema.sql
 *
 * Run: npm run build && DATABASE_URL=postgres://localhost:5432/turbine_bench npx tsx --test src/test/schema-builder.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { defineSchema, table, column, ColumnBuilder } from '../schema-builder.js';
import { schemaToSQL, schemaToSQLString } from '../schema-sql.js';

// ---------------------------------------------------------------------------
// Build the benchmark schema (mirrors turbine/sql/schema.sql)
// ---------------------------------------------------------------------------

const benchmarkSchema = defineSchema({
  organizations: table({
    id: column.serial().primaryKey(),
    name: column.text().notNull(),
    slug: column.text().unique().notNull(),
    plan: column.text().notNull().default("'free'"),
    createdAt: column.timestamp().notNull().default('now()'),
  }),

  users: table({
    id: column.serial().primaryKey(),
    orgId: column.bigint().notNull().references('organizations.id'),
    email: column.text().unique().notNull(),
    name: column.text().notNull(),
    role: column.text().notNull().default("'member'"),
    avatarUrl: column.text().nullable(),
    lastLoginAt: column.timestamp().nullable(),
    createdAt: column.timestamp().notNull().default('now()'),
  }),

  posts: table({
    id: column.serial().primaryKey(),
    userId: column.bigint().notNull().references('users.id'),
    orgId: column.bigint().notNull().references('organizations.id'),
    title: column.text().notNull(),
    content: column.text().notNull(),
    published: column.boolean().notNull().default('false'),
    viewCount: column.integer().notNull().default('0'),
    createdAt: column.timestamp().notNull().default('now()'),
    updatedAt: column.timestamp().notNull().default('now()'),
  }),

  comments: table({
    id: column.serial().primaryKey(),
    postId: column.bigint().notNull().references('posts.id'),
    userId: column.bigint().notNull().references('users.id'),
    body: column.text().notNull(),
    createdAt: column.timestamp().notNull().default('now()'),
  }),
});

// ---------------------------------------------------------------------------
// ColumnBuilder unit tests
// ---------------------------------------------------------------------------

describe('ColumnBuilder', () => {
  it('creates a serial primary key', () => {
    const config = column.serial().primaryKey().build();
    assert.equal(config.type, 'BIGSERIAL');
    assert.equal(config.isPrimaryKey, true);
  });

  it('creates a text column with NOT NULL and UNIQUE', () => {
    const config = column.text().notNull().unique().build();
    assert.equal(config.type, 'TEXT');
    assert.equal(config.isNotNull, true);
    assert.equal(config.isUnique, true);
  });

  it('creates a column with default', () => {
    const config = column.text().notNull().default("'free'").build();
    assert.equal(config.defaultValue, "'free'");
  });

  it('creates a column with references', () => {
    const config = column.bigint().notNull().references('users.id').build();
    assert.equal(config.type, 'BIGINT');
    assert.equal(config.isNotNull, true);
    assert.equal(config.referencesTarget, 'users.id');
  });

  it('creates a nullable timestamp', () => {
    const config = column.timestamp().nullable().build();
    assert.equal(config.type, 'TIMESTAMPTZ');
    assert.equal(config.isNullable, true);
  });

  it('creates a boolean with default false', () => {
    const config = column.boolean().notNull().default('false').build();
    assert.equal(config.type, 'BOOLEAN');
    assert.equal(config.isNotNull, true);
    assert.equal(config.defaultValue, 'false');
  });

  it('creates integer with default 0', () => {
    const config = column.integer().notNull().default('0').build();
    assert.equal(config.type, 'INTEGER');
    assert.equal(config.defaultValue, '0');
  });

  it('creates timestamp with default now()', () => {
    const config = column.timestamp().notNull().default('now()').build();
    assert.equal(config.type, 'TIMESTAMPTZ');
    assert.equal(config.defaultValue, 'now()');
  });

  it('supports all column types', () => {
    assert.equal(column.serial().build().type, 'BIGSERIAL');
    assert.equal(column.bigint().build().type, 'BIGINT');
    assert.equal(column.integer().build().type, 'INTEGER');
    assert.equal(column.smallint().build().type, 'SMALLINT');
    assert.equal(column.text().build().type, 'TEXT');
    assert.equal(column.boolean().build().type, 'BOOLEAN');
    assert.equal(column.timestamp().build().type, 'TIMESTAMPTZ');
    assert.equal(column.json().build().type, 'JSONB');
    assert.equal(column.uuid().build().type, 'UUID');
    assert.equal(column.real().build().type, 'REAL');
    assert.equal(column.doublePrecision().build().type, 'DOUBLE PRECISION');
    assert.equal(column.numeric().build().type, 'NUMERIC');
    assert.equal(column.bytea().build().type, 'BYTEA');
    assert.equal(column.date().build().type, 'DATE');
  });

  it('supports varchar with length', () => {
    const config = column.varchar(255).notNull().build();
    assert.equal(config.type, 'VARCHAR');
    assert.equal(config.maxLength, 255);
  });

  it('supports method chaining in any order', () => {
    const a = column.text().notNull().unique().default("'x'").build();
    const b = column.text().unique().default("'x'").notNull().build();
    assert.equal(a.isNotNull, b.isNotNull);
    assert.equal(a.isUnique, b.isUnique);
    assert.equal(a.defaultValue, b.defaultValue);
  });
});

// ---------------------------------------------------------------------------
// table() and defineSchema() tests
// ---------------------------------------------------------------------------

describe('defineSchema', () => {
  it('stamps table names from keys', () => {
    assert.equal(benchmarkSchema.tables['organizations']!.name, 'organizations');
    assert.equal(benchmarkSchema.tables['users']!.name, 'users');
    assert.equal(benchmarkSchema.tables['posts']!.name, 'posts');
    assert.equal(benchmarkSchema.tables['comments']!.name, 'comments');
  });

  it('has correct number of tables', () => {
    assert.equal(Object.keys(benchmarkSchema.tables).length, 4);
  });

  it('organizations has 5 columns', () => {
    assert.equal(Object.keys(benchmarkSchema.tables['organizations']!.columns).length, 5);
  });

  it('users has 8 columns', () => {
    assert.equal(Object.keys(benchmarkSchema.tables['users']!.columns).length, 8);
  });

  it('posts has 9 columns', () => {
    assert.equal(Object.keys(benchmarkSchema.tables['posts']!.columns).length, 9);
  });

  it('comments has 5 columns', () => {
    assert.equal(Object.keys(benchmarkSchema.tables['comments']!.columns).length, 5);
  });
});

// ---------------------------------------------------------------------------
// schemaToSQL — DDL generation tests
// ---------------------------------------------------------------------------

describe('schemaToSQL', () => {
  const statements = schemaToSQL(benchmarkSchema);

  it('generates CREATE TABLE and CREATE INDEX statements', () => {
    const createTables = statements.filter((s) => s.startsWith('CREATE TABLE'));
    const createIndexes = statements.filter((s) => s.startsWith('CREATE INDEX'));
    assert.equal(createTables.length, 4);
    // FK indexes: users.org_id, posts.user_id, posts.org_id, comments.post_id, comments.user_id
    assert.equal(createIndexes.length, 5);
  });

  it('organizations table comes before users (dependency order)', () => {
    const createTables = statements.filter((s) => s.startsWith('CREATE TABLE'));
    const orgIdx = createTables.findIndex((s) => s.includes('"organizations"'));
    const userIdx = createTables.findIndex((s) => s.includes('"users"'));
    assert.ok(orgIdx < userIdx, 'organizations should come before users');
  });

  it('users table comes before posts (dependency order)', () => {
    const createTables = statements.filter((s) => s.startsWith('CREATE TABLE'));
    const userIdx = createTables.findIndex((s) => s.includes('"users"'));
    const postIdx = createTables.findIndex((s) => s.includes('"posts"'));
    assert.ok(userIdx < postIdx, 'users should come before posts');
  });

  it('posts table comes before comments (dependency order)', () => {
    const createTables = statements.filter((s) => s.startsWith('CREATE TABLE'));
    const postIdx = createTables.findIndex((s) => s.includes('"posts"'));
    const commentIdx = createTables.findIndex((s) => s.includes('"comments"'));
    assert.ok(postIdx < commentIdx, 'posts should come before comments');
  });

  it('generates correct organizations table', () => {
    const orgSQL = statements.find((s) => s.includes('"organizations"'));
    assert.ok(orgSQL, 'should have organizations CREATE TABLE');
    assert.ok(orgSQL.includes('"id" BIGSERIAL PRIMARY KEY'), 'should have id BIGSERIAL PRIMARY KEY');
    assert.ok(orgSQL.includes('"name" TEXT NOT NULL'), 'should have name TEXT NOT NULL');
    assert.ok(orgSQL.includes('"slug" TEXT UNIQUE NOT NULL'), 'should have slug TEXT UNIQUE NOT NULL');
    assert.ok(orgSQL.includes("\"plan\" TEXT NOT NULL DEFAULT 'free'"), "should have plan with default 'free'");
    assert.ok(orgSQL.includes('"created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()'), 'should have created_at with DEFAULT NOW()');
  });

  it('generates correct users table', () => {
    const usersSQL = statements.find((s) => s.includes('"users"'));
    assert.ok(usersSQL, 'should have users CREATE TABLE');
    assert.ok(usersSQL.includes('"id" BIGSERIAL PRIMARY KEY'), 'should have id column');
    assert.ok(usersSQL.includes('"org_id" BIGINT NOT NULL'), 'should convert orgId to org_id');
    assert.ok(usersSQL.includes('REFERENCES "organizations"("id")'), 'should have FK reference');
    assert.ok(usersSQL.includes('"email" TEXT UNIQUE NOT NULL'), 'should have email');
    assert.ok(usersSQL.includes("\"role\" TEXT NOT NULL DEFAULT 'member'"), 'should have role default');
    assert.ok(usersSQL.includes('"avatar_url" TEXT'), 'should convert avatarUrl to avatar_url');
    assert.ok(usersSQL.includes('"last_login_at" TIMESTAMPTZ'), 'should convert lastLoginAt to last_login_at');
  });

  it('generates correct posts table', () => {
    const postsSQL = statements.find((s) => s.includes('CREATE TABLE "posts"'));
    assert.ok(postsSQL, 'should have posts CREATE TABLE');
    assert.ok(postsSQL.includes('"user_id" BIGINT NOT NULL REFERENCES "users"("id")'), 'should have user FK');
    assert.ok(postsSQL.includes('"org_id" BIGINT NOT NULL REFERENCES "organizations"("id")'), 'should have org FK');
    assert.ok(postsSQL.includes('"published" BOOLEAN NOT NULL DEFAULT FALSE'), 'should have published boolean');
    assert.ok(postsSQL.includes('"view_count" INTEGER NOT NULL DEFAULT 0'), 'should have view_count');
    assert.ok(postsSQL.includes('"updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()'), 'should have updated_at');
  });

  it('generates correct comments table', () => {
    const commentsSQL = statements.find((s) => s.includes('CREATE TABLE "comments"'));
    assert.ok(commentsSQL, 'should have comments CREATE TABLE');
    assert.ok(commentsSQL.includes('"post_id" BIGINT NOT NULL REFERENCES "posts"("id")'), 'should have post FK');
    assert.ok(commentsSQL.includes('"user_id" BIGINT NOT NULL REFERENCES "users"("id")'), 'should have user FK');
    assert.ok(commentsSQL.includes('"body" TEXT NOT NULL'), 'should have body');
  });

  it('generates FK indexes', () => {
    const indexes = statements.filter((s) => s.startsWith('CREATE INDEX'));
    const indexNames = indexes.map((s) => {
      const match = s.match(/CREATE INDEX "([^"]+)"/);
      return match ? match[1] : '';
    });
    assert.ok(indexNames.includes('idx_users_org_id'), 'should index users.org_id');
    assert.ok(indexNames.includes('idx_posts_user_id'), 'should index posts.user_id');
    assert.ok(indexNames.includes('idx_posts_org_id'), 'should index posts.org_id');
    assert.ok(indexNames.includes('idx_comments_post_id'), 'should index comments.post_id');
    assert.ok(indexNames.includes('idx_comments_user_id'), 'should index comments.user_id');
  });

  it('camelCase field names convert to snake_case in SQL', () => {
    const fullSQL = schemaToSQLString(benchmarkSchema);
    // camelCase names should NOT appear in the SQL
    assert.ok(!fullSQL.includes('orgId'), 'should not have camelCase orgId');
    assert.ok(!fullSQL.includes('userId'), 'should not have camelCase userId');
    assert.ok(!fullSQL.includes('avatarUrl'), 'should not have camelCase avatarUrl');
    assert.ok(!fullSQL.includes('lastLoginAt'), 'should not have camelCase lastLoginAt');
    assert.ok(!fullSQL.includes('viewCount'), 'should not have camelCase viewCount');
    assert.ok(!fullSQL.includes('createdAt'), 'should not have camelCase createdAt');
    assert.ok(!fullSQL.includes('updatedAt'), 'should not have camelCase updatedAt');
    assert.ok(!fullSQL.includes('postId'), 'should not have camelCase postId');
    // snake_case names SHOULD appear
    assert.ok(fullSQL.includes('org_id'), 'should have snake_case org_id');
    assert.ok(fullSQL.includes('user_id'), 'should have snake_case user_id');
    assert.ok(fullSQL.includes('avatar_url'), 'should have snake_case avatar_url');
    assert.ok(fullSQL.includes('last_login_at'), 'should have snake_case last_login_at');
    assert.ok(fullSQL.includes('view_count'), 'should have snake_case view_count');
    assert.ok(fullSQL.includes('created_at'), 'should have snake_case created_at');
    assert.ok(fullSQL.includes('updated_at'), 'should have snake_case updated_at');
    assert.ok(fullSQL.includes('post_id'), 'should have snake_case post_id');
  });
});

// ---------------------------------------------------------------------------
// Verify generated SQL matches reference schema.sql
// ---------------------------------------------------------------------------

describe('schema.sql compatibility', () => {
  it('generated SQL has all tables from reference schema', () => {
    const fullSQL = schemaToSQLString(benchmarkSchema);
    assert.ok(fullSQL.includes('CREATE TABLE "organizations"'), 'has organizations');
    assert.ok(fullSQL.includes('CREATE TABLE "users"'), 'has users');
    assert.ok(fullSQL.includes('CREATE TABLE "posts"'), 'has posts');
    assert.ok(fullSQL.includes('CREATE TABLE "comments"'), 'has comments');
  });

  it('generated SQL has all columns from reference schema', () => {
    const fullSQL = schemaToSQLString(benchmarkSchema);

    // organizations columns
    assert.ok(fullSQL.includes('"id" BIGSERIAL PRIMARY KEY'), 'org.id');
    assert.ok(fullSQL.includes('"name" TEXT NOT NULL'), 'org.name');
    assert.ok(fullSQL.includes('"slug" TEXT UNIQUE NOT NULL'), 'org.slug');

    // users columns
    assert.ok(fullSQL.includes('"org_id" BIGINT NOT NULL'), 'users.org_id');
    assert.ok(fullSQL.includes('"email" TEXT UNIQUE NOT NULL'), 'users.email');
    assert.ok(fullSQL.includes('"avatar_url" TEXT'), 'users.avatar_url');
    assert.ok(fullSQL.includes('"last_login_at" TIMESTAMPTZ'), 'users.last_login_at');

    // posts columns
    assert.ok(fullSQL.includes('"title" TEXT NOT NULL'), 'posts.title');
    assert.ok(fullSQL.includes('"content" TEXT NOT NULL'), 'posts.content');
    assert.ok(fullSQL.includes('"published" BOOLEAN NOT NULL DEFAULT FALSE'), 'posts.published');
    assert.ok(fullSQL.includes('"view_count" INTEGER NOT NULL DEFAULT 0'), 'posts.view_count');

    // comments columns
    assert.ok(fullSQL.includes('"body" TEXT NOT NULL'), 'comments.body');
  });

  it('generated SQL has all FK references from reference schema', () => {
    const fullSQL = schemaToSQLString(benchmarkSchema);
    assert.ok(fullSQL.includes('REFERENCES "organizations"("id")'), 'FK to organizations');
    assert.ok(fullSQL.includes('REFERENCES "users"("id")'), 'FK to users');
    assert.ok(fullSQL.includes('REFERENCES "posts"("id")'), 'FK to posts');
  });

  it('generated SQL has all FK indexes from reference schema', () => {
    const fullSQL = schemaToSQLString(benchmarkSchema);
    assert.ok(fullSQL.includes('idx_users_org_id'), 'index on users.org_id');
    assert.ok(fullSQL.includes('idx_posts_user_id'), 'index on posts.user_id');
    assert.ok(fullSQL.includes('idx_posts_org_id'), 'index on posts.org_id');
    assert.ok(fullSQL.includes('idx_comments_post_id'), 'index on comments.post_id');
    assert.ok(fullSQL.includes('idx_comments_user_id'), 'index on comments.user_id');
  });
});

// ---------------------------------------------------------------------------
// Object-based schema format (NEW primary API)
// ---------------------------------------------------------------------------

// Build same benchmark schema using object format
const benchmarkSchemaObjects = defineSchema({
  organizations: {
    id:        { type: 'serial', primaryKey: true },
    name:      { type: 'text', notNull: true },
    slug:      { type: 'text', unique: true, notNull: true },
    plan:      { type: 'text', notNull: true, default: "'free'" },
    createdAt: { type: 'timestamp', notNull: true, default: 'now()' },
  },
  users: {
    id:          { type: 'serial', primaryKey: true },
    orgId:       { type: 'bigint', notNull: true, references: 'organizations.id' },
    email:       { type: 'text', unique: true, notNull: true },
    name:        { type: 'text', notNull: true },
    role:        { type: 'text', notNull: true, default: "'member'" },
    avatarUrl:   { type: 'text', nullable: true },
    lastLoginAt: { type: 'timestamp', nullable: true },
    createdAt:   { type: 'timestamp', notNull: true, default: 'now()' },
  },
  posts: {
    id:        { type: 'serial', primaryKey: true },
    userId:    { type: 'bigint', notNull: true, references: 'users.id' },
    orgId:     { type: 'bigint', notNull: true, references: 'organizations.id' },
    title:     { type: 'text', notNull: true },
    content:   { type: 'text', notNull: true },
    published: { type: 'boolean', notNull: true, default: 'false' },
    viewCount: { type: 'integer', notNull: true, default: '0' },
    createdAt: { type: 'timestamp', notNull: true, default: 'now()' },
    updatedAt: { type: 'timestamp', notNull: true, default: 'now()' },
  },
  comments: {
    id:        { type: 'serial', primaryKey: true },
    postId:    { type: 'bigint', notNull: true, references: 'posts.id' },
    userId:    { type: 'bigint', notNull: true, references: 'users.id' },
    body:      { type: 'text', notNull: true },
    createdAt: { type: 'timestamp', notNull: true, default: 'now()' },
  },
});

describe('defineSchema (object format)', () => {
  it('stamps table names from keys', () => {
    assert.equal(benchmarkSchemaObjects.tables['organizations']!.name, 'organizations');
    assert.equal(benchmarkSchemaObjects.tables['users']!.name, 'users');
    assert.equal(benchmarkSchemaObjects.tables['posts']!.name, 'posts');
    assert.equal(benchmarkSchemaObjects.tables['comments']!.name, 'comments');
  });

  it('resolves column types correctly', () => {
    const orgCols = benchmarkSchemaObjects.tables['organizations']!.columns;
    assert.equal(orgCols['id']!.type, 'BIGSERIAL');
    assert.equal(orgCols['id']!.isPrimaryKey, true);
    assert.equal(orgCols['name']!.type, 'TEXT');
    assert.equal(orgCols['name']!.isNotNull, true);
    assert.equal(orgCols['slug']!.isUnique, true);
    assert.equal(orgCols['plan']!.defaultValue, "'free'");
    assert.equal(orgCols['createdAt']!.defaultValue, 'now()');
  });

  it('resolves references', () => {
    const userCols = benchmarkSchemaObjects.tables['users']!.columns;
    assert.equal(userCols['orgId']!.referencesTarget, 'organizations.id');
    assert.equal(userCols['orgId']!.isNotNull, true);
  });

  it('resolves nullable', () => {
    const userCols = benchmarkSchemaObjects.tables['users']!.columns;
    assert.equal(userCols['avatarUrl']!.isNullable, true);
    assert.equal(userCols['lastLoginAt']!.isNullable, true);
  });

  it('generates identical SQL to fluent builder format', () => {
    const fluentSQL = schemaToSQLString(benchmarkSchema);
    const objectSQL = schemaToSQLString(benchmarkSchemaObjects);
    assert.equal(fluentSQL, objectSQL, 'Object format should produce identical DDL');
  });

  it('supports all column types', () => {
    const schema = defineSchema({
      allTypes: {
        a: { type: 'serial' },
        b: { type: 'bigint' },
        c: { type: 'integer' },
        d: { type: 'smallint' },
        e: { type: 'text' },
        f: { type: 'varchar', maxLength: 255 },
        g: { type: 'boolean' },
        h: { type: 'timestamp' },
        i: { type: 'date' },
        j: { type: 'json' },
        k: { type: 'uuid' },
        l: { type: 'real' },
        m: { type: 'double' },
        n: { type: 'numeric' },
        o: { type: 'bytea' },
      },
    });
    const cols = schema.tables['allTypes']!.columns;
    assert.equal(cols['a']!.type, 'BIGSERIAL');
    assert.equal(cols['b']!.type, 'BIGINT');
    assert.equal(cols['c']!.type, 'INTEGER');
    assert.equal(cols['d']!.type, 'SMALLINT');
    assert.equal(cols['e']!.type, 'TEXT');
    assert.equal(cols['f']!.type, 'VARCHAR');
    assert.equal(cols['f']!.maxLength, 255);
    assert.equal(cols['g']!.type, 'BOOLEAN');
    assert.equal(cols['h']!.type, 'TIMESTAMPTZ');
    assert.equal(cols['i']!.type, 'DATE');
    assert.equal(cols['j']!.type, 'JSONB');
    assert.equal(cols['k']!.type, 'UUID');
    assert.equal(cols['l']!.type, 'REAL');
    assert.equal(cols['m']!.type, 'DOUBLE PRECISION');
    assert.equal(cols['n']!.type, 'NUMERIC');
    assert.equal(cols['o']!.type, 'BYTEA');
  });

  it('defaults omitted flags to false/null', () => {
    const schema = defineSchema({
      minimal: {
        id: { type: 'serial' },
      },
    });
    const col = schema.tables['minimal']!.columns['id']!;
    assert.equal(col.isPrimaryKey, false);
    assert.equal(col.isNotNull, false);
    assert.equal(col.isNullable, false);
    assert.equal(col.isUnique, false);
    assert.equal(col.defaultValue, null);
    assert.equal(col.referencesTarget, null);
    assert.equal(col.maxLength, null);
  });

  it('works with empty schema', () => {
    const schema = defineSchema({});
    assert.equal(Object.keys(schema.tables).length, 0);
  });
});

// ---------------------------------------------------------------------------
// Edge cases (legacy builder format — still supported)
// ---------------------------------------------------------------------------

describe('edge cases', () => {
  it('single table with no references (legacy builder)', () => {
    const schema = defineSchema({
      settings: {
        id: { type: 'serial', primaryKey: true },
        key: { type: 'text', unique: true, notNull: true },
        value: { type: 'json', nullable: true },
      },
    });
    const sql = schemaToSQL(schema);
    assert.equal(sql.length, 1);
    assert.ok(sql[0]!.includes('CREATE TABLE "settings"'));
    assert.ok(sql[0]!.includes('"value" JSONB'));
  });

  it('varchar column with max length', () => {
    const schema = defineSchema({
      items: {
        id: { type: 'serial', primaryKey: true },
        code: { type: 'varchar', maxLength: 10, unique: true, notNull: true },
      },
    });
    const sql = schemaToSQL(schema);
    assert.ok(sql[0]!.includes('"code" VARCHAR(10)'));
  });

  it('uuid primary key', () => {
    const schema = defineSchema({
      events: {
        id: { type: 'uuid', primaryKey: true, default: 'gen_random_uuid()' },
        name: { type: 'text', notNull: true },
      },
    });
    const sql = schemaToSQL(schema);
    assert.ok(sql[0]!.includes('"id" UUID PRIMARY KEY DEFAULT GEN_RANDOM_UUID()'));
  });

  it('self-referencing table', () => {
    const schema = defineSchema({
      categories: {
        id: { type: 'serial', primaryKey: true },
        parentId: { type: 'bigint', nullable: true, references: 'categories.id' },
        name: { type: 'text', notNull: true },
      },
    });
    const sql = schemaToSQL(schema);
    assert.ok(sql[0]!.includes('REFERENCES "categories"("id")'));
    assert.ok(sql.some((s) => s.includes('"idx_categories_parent_id"')));
  });

  it('empty schema generates no statements', () => {
    const schema = defineSchema({});
    const sql = schemaToSQL(schema);
    assert.equal(sql.length, 0);
  });

  it('schemaToSQLString returns well-formatted string', () => {
    const schema = defineSchema({
      tags: {
        id: { type: 'serial', primaryKey: true },
        name: { type: 'text', unique: true, notNull: true },
      },
    });
    const sqlStr = schemaToSQLString(schema);
    assert.ok(sqlStr.endsWith('\n'), 'should end with newline');
    assert.ok(sqlStr.includes('CREATE TABLE "tags"'), 'should have table');
  });
});
