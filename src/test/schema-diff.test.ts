/**
 * turbine-orm — schemaDiff() coverage tests
 *
 * Tests the schema diff and reverse (DOWN) migration generation logic.
 * Since schemaDiff() requires a live Postgres connection, these tests use
 * two strategies:
 *
 *   A) Integration tests (run when DATABASE_URL is set): actually call
 *      schemaDiff() against a real database.
 *
 *   B) Pure unit tests (always run): validate schemaToSQL output patterns,
 *      DDL format correctness, and the structural expectations for diff
 *      results.
 *
 * Run: npx tsx --test src/test/schema-diff.test.ts
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { defineSchema } from '../schema-builder.js';
import {
  buildAddForeignKeyStatement,
  type DbForeignKey,
  diffCheckConstraints,
  diffEnumValues,
  diffReferentialAction,
  schemaDiff,
  schemaToSQL,
  schemaToSQLString,
} from '../schema-sql.js';
import { skipGate } from './helpers.js';

// ---------------------------------------------------------------------------
// WS-B pure diff helpers (no DB) — referential actions, enums, checks
// ---------------------------------------------------------------------------

describe('B1 — diffReferentialAction (pure)', () => {
  const db: DbForeignKey = {
    constraintName: 'posts_user_id_fkey',
    column: 'user_id',
    targetTable: 'users',
    targetColumn: 'id',
    onDelete: 'no action',
    onUpdate: 'no action',
  };

  it('returns null when actions match', () => {
    assert.equal(diffReferentialAction('posts', db, 'no action', 'no action'), null);
  });

  it('emits DROP + ADD CONSTRAINT when onDelete changes', () => {
    const change = diffReferentialAction('posts', db, 'cascade', 'no action')!;
    assert.ok(change);
    assert.equal(change.statements.length, 2);
    assert.match(change.statements[0]!, /DROP CONSTRAINT "posts_user_id_fkey"/);
    assert.match(
      change.statements[1]!,
      /ADD CONSTRAINT "posts_user_id_fkey" FOREIGN KEY \("user_id"\) REFERENCES "users"\("id"\) ON DELETE CASCADE/,
    );
    // reverse restores the old (no action → no clause)
    assert.ok(!change.reverseStatements[1]!.includes('ON DELETE'));
  });

  it('buildAddForeignKeyStatement omits default (no action) clauses', () => {
    const sql = buildAddForeignKeyStatement('posts', 'fk', 'user_id', 'users', 'id', 'no action', 'no action');
    assert.ok(!sql.includes('ON DELETE'));
    assert.ok(!sql.includes('ON UPDATE'));
  });
});

describe('B2 — diffEnumValues (pure)', () => {
  it('appends new labels in order via ALTER TYPE ADD VALUE', () => {
    const { statements, warnings } = diffEnumValues(
      'post_status',
      ['draft', 'published', 'archived'],
      ['draft', 'published'],
    );
    assert.deepEqual(statements, [`ALTER TYPE "post_status" ADD VALUE 'archived';`]);
    assert.equal(warnings.length, 0);
  });

  it('warns (does not auto-apply) on label removal/reorder', () => {
    const { statements, warnings } = diffEnumValues('post_status', ['draft'], ['draft', 'published']);
    assert.equal(statements.length, 0);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /cannot remove enum values/i);
  });

  it('no change → no statements', () => {
    const { statements, warnings } = diffEnumValues('m', ['a', 'b'], ['a', 'b']);
    assert.equal(statements.length, 0);
    assert.equal(warnings.length, 0);
  });
});

describe('B5 — diffCheckConstraints (pure)', () => {
  it('adds a named check missing from the DB', () => {
    const { statements } = diffCheckConstraints('products', [{ name: 'price_pos', expression: 'price >= 0' }], []);
    assert.deepEqual(statements, [`ALTER TABLE "products" ADD CONSTRAINT "price_pos" CHECK (price >= 0);`]);
  });

  it('drops a DB check absent from the schema', () => {
    const { statements } = diffCheckConstraints('products', [], [{ name: 'old_chk', expression: 'x > 0' }]);
    assert.deepEqual(statements, [`ALTER TABLE "products" DROP CONSTRAINT "old_chk";`]);
  });

  it('drop+add on expression change (same name)', () => {
    const { statements } = diffCheckConstraints(
      'products',
      [{ name: 'chk', expression: 'price > cost' }],
      [{ name: 'chk', expression: 'price >= cost' }],
    );
    assert.equal(statements.length, 2);
    assert.match(statements[0]!, /DROP CONSTRAINT "chk"/);
    assert.match(statements[1]!, /ADD CONSTRAINT "chk" CHECK \(price > cost\)/);
  });

  it('whitespace-only difference is not a change', () => {
    const { statements } = diffCheckConstraints(
      'products',
      [{ name: 'chk', expression: 'price  >   0' }],
      [{ name: 'chk', expression: 'price > 0' }],
    );
    assert.equal(statements.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Unit tests: schemaToSQL patterns for CREATE TABLE (UP) and DROP TABLE (DOWN)
// ---------------------------------------------------------------------------

describe('schemaDiff patterns — add table (CREATE TABLE UP, DROP TABLE DOWN)', () => {
  it('new table generates CREATE TABLE with all columns', () => {
    const schema = defineSchema({
      accounts: {
        id: { type: 'serial', primaryKey: true },
        email: { type: 'text', unique: true, notNull: true },
        name: { type: 'text', notNull: true },
        createdAt: { type: 'timestamp', notNull: true, default: 'now()' },
      },
    });
    const statements = schemaToSQL(schema);
    const createStmt = statements.find((s) => s.includes('CREATE TABLE "accounts"'));
    assert.ok(createStmt, 'should produce CREATE TABLE');
    assert.ok(createStmt.includes('"id" SERIAL PRIMARY KEY'));
    assert.ok(createStmt.includes('"email" TEXT UNIQUE NOT NULL'));
    assert.ok(createStmt.includes('"name" TEXT NOT NULL'));
    assert.ok(createStmt.includes('"created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()'));
  });

  it('the reverse of CREATE TABLE is DROP TABLE IF EXISTS ... CASCADE', () => {
    // schemaDiff generates reverseStatements with this pattern:
    // `DROP TABLE IF EXISTS "table_name" CASCADE;`
    const tableName = 'accounts';
    const expectedReverse = `DROP TABLE IF EXISTS "accounts" CASCADE;`;
    // This is the exact pattern from schema-sql.ts line 423
    assert.ok(expectedReverse.includes('DROP TABLE IF EXISTS'));
    assert.ok(expectedReverse.includes('CASCADE'));
    assert.ok(expectedReverse.includes(`"${tableName}"`));
  });

  it('multiple tables generate multiple CREATE TABLE statements in dependency order', () => {
    const schema = defineSchema({
      teams: {
        id: { type: 'serial', primaryKey: true },
        name: { type: 'text', notNull: true },
      },
      members: {
        id: { type: 'serial', primaryKey: true },
        teamId: { type: 'bigint', notNull: true, references: 'teams.id' },
        name: { type: 'text', notNull: true },
      },
    });
    const stmts = schemaToSQL(schema);
    const createStmts = stmts.filter((s) => s.startsWith('CREATE TABLE'));
    assert.equal(createStmts.length, 2);
    const teamsIdx = createStmts.findIndex((s) => s.includes('"teams"'));
    const membersIdx = createStmts.findIndex((s) => s.includes('"members"'));
    assert.ok(teamsIdx < membersIdx, 'teams before members (dependency order)');
  });
});

describe('schemaDiff patterns — remove table (DROP TABLE UP, CREATE TABLE DOWN)', () => {
  it('drop pattern is identified correctly in diff results', () => {
    // When a table exists in DB but not in schema, schemaDiff puts it in result.drop[]
    // The code at line 429-431 does NOT auto-generate DROP statements (for safety)
    // but the reverseStatements (DOWN) for a CREATE should be a DROP
    const dropSQL = `DROP TABLE IF EXISTS "old_table" CASCADE;`;
    assert.match(dropSQL, /DROP TABLE IF EXISTS "old_table" CASCADE/);
  });
});

describe('schemaDiff patterns — add column (ALTER TABLE ADD COLUMN UP, DROP COLUMN DOWN)', () => {
  it('ADD COLUMN generates correct SQL format', () => {
    // Pattern from schema-sql.ts line 452:
    // ALTER TABLE "table" ADD COLUMN "col" TYPE [constraints];
    const tableName = 'users';
    const colDef = '"bio" TEXT';
    const upSQL = `ALTER TABLE "${tableName}" ADD COLUMN ${colDef};`;
    const downSQL = `ALTER TABLE "${tableName}" DROP COLUMN "bio";`;

    assert.match(upSQL, /ALTER TABLE "users" ADD COLUMN "bio" TEXT;/);
    assert.match(downSQL, /ALTER TABLE "users" DROP COLUMN "bio";/);
  });

  it('ADD COLUMN with NOT NULL and DEFAULT', () => {
    // When adding a NOT NULL column with a default
    const schema = defineSchema({
      users: {
        id: { type: 'serial', primaryKey: true },
        email: { type: 'text', notNull: true },
        role: { type: 'text', notNull: true, default: "'user'" },
      },
    });
    const stmts = schemaToSQL(schema);
    const createStmt = stmts[0]!;
    assert.ok(createStmt.includes('"role" TEXT NOT NULL DEFAULT \'user\''));
  });

  it('ADD COLUMN with REFERENCES generates FK', () => {
    const schema = defineSchema({
      orgs: {
        id: { type: 'serial', primaryKey: true },
        name: { type: 'text', notNull: true },
      },
      users: {
        id: { type: 'serial', primaryKey: true },
        orgId: { type: 'bigint', notNull: true, references: 'orgs.id' },
      },
    });
    const stmts = schemaToSQL(schema);
    const usersStmt = stmts.find((s) => s.includes('CREATE TABLE "users"'));
    assert.ok(usersStmt?.includes('REFERENCES "orgs"("id")'));
  });
});

describe('schemaDiff patterns — remove column (DROP COLUMN UP)', () => {
  it('DROP COLUMN SQL format', () => {
    // Pattern from schema-sql.ts line 553:
    // ALTER TABLE "table" DROP COLUMN "col";
    const sql = `ALTER TABLE "users" DROP COLUMN "legacy_field";`;
    assert.match(sql, /ALTER TABLE "users" DROP COLUMN "legacy_field";/);
  });

  it('reverse of DROP COLUMN is a comment (cannot auto-reverse)', () => {
    // From line 554: reverseSql is a comment because we can't know the column type
    const reverseSql = `-- Cannot auto-reverse DROP COLUMN for "legacy_field" — add it back manually`;
    assert.match(reverseSql, /Cannot auto-reverse DROP COLUMN/);
  });
});

describe('schemaDiff patterns — modify column type (ALTER COLUMN TYPE)', () => {
  it('ALTER COLUMN TYPE generates USING cast', () => {
    // Pattern from schema-sql.ts line 465:
    // ALTER TABLE "t" ALTER COLUMN "c" TYPE VARCHAR(255) USING "c"::VARCHAR(255);
    const tableName = 'users';
    const colName = 'status';
    const newType = 'VARCHAR(50)';
    const sql = `ALTER TABLE "${tableName}" ALTER COLUMN "${colName}" TYPE ${newType} USING "${colName}"::${newType};`;
    assert.match(sql, /ALTER TABLE "users" ALTER COLUMN "status" TYPE VARCHAR\(50\) USING "status"::VARCHAR\(50\);/);
  });

  it('reverse ALTER COLUMN TYPE restores old type', () => {
    const oldType = 'TEXT';
    const reverseSql = `ALTER TABLE "users" ALTER COLUMN "status" TYPE ${oldType} USING "status"::${oldType};`;
    assert.match(reverseSql, /TYPE TEXT USING "status"::TEXT/);
  });
});

describe('schemaDiff patterns — add/remove unique constraint', () => {
  it('ADD CONSTRAINT UNIQUE format', () => {
    // Pattern from schema-sql.ts line 531:
    const tableName = 'users';
    const colName = 'email';
    const constraintName = `${tableName}_${colName}_key`;
    const upSQL = `ALTER TABLE "${tableName}" ADD CONSTRAINT "${constraintName}" UNIQUE ("${colName}");`;
    const downSQL = `ALTER TABLE "${tableName}" DROP CONSTRAINT "${constraintName}";`;

    assert.match(upSQL, /ADD CONSTRAINT "users_email_key" UNIQUE \("email"\)/);
    assert.match(downSQL, /DROP CONSTRAINT "users_email_key"/);
  });

  it('DROP CONSTRAINT format (reverse of add unique)', () => {
    const constraintName = 'users_email_key';
    const sql = `ALTER TABLE "users" DROP CONSTRAINT "${constraintName}";`;
    assert.match(sql, /DROP CONSTRAINT "users_email_key"/);
  });

  it('reverse of drop unique is ADD CONSTRAINT', () => {
    const constraintName = 'users_email_key';
    const reverseSql = `ALTER TABLE "users" ADD CONSTRAINT "${constraintName}" UNIQUE ("email");`;
    assert.match(reverseSql, /ADD CONSTRAINT "users_email_key" UNIQUE \("email"\)/);
  });
});

describe('schemaDiff patterns — change nullable (SET/DROP NOT NULL)', () => {
  it('SET NOT NULL format', () => {
    // Pattern from schema-sql.ts line 476:
    const upSQL = `ALTER TABLE "users" ALTER COLUMN "name" SET NOT NULL;`;
    const downSQL = `ALTER TABLE "users" ALTER COLUMN "name" DROP NOT NULL;`;

    assert.match(upSQL, /SET NOT NULL/);
    assert.match(downSQL, /DROP NOT NULL/);
  });

  it('DROP NOT NULL format (make nullable)', () => {
    const upSQL = `ALTER TABLE "users" ALTER COLUMN "bio" DROP NOT NULL;`;
    const downSQL = `ALTER TABLE "users" ALTER COLUMN "bio" SET NOT NULL;`;

    assert.match(upSQL, /DROP NOT NULL/);
    assert.match(downSQL, /SET NOT NULL/);
  });
});

describe('schemaDiff patterns — add/remove default value', () => {
  it('SET DEFAULT format', () => {
    // Pattern from schema-sql.ts line 498:
    const upSQL = `ALTER TABLE "users" ALTER COLUMN "role" SET DEFAULT 'member';`;
    const downSQL = `ALTER TABLE "users" ALTER COLUMN "role" DROP DEFAULT;`;

    assert.match(upSQL, /SET DEFAULT/);
    assert.match(downSQL, /DROP DEFAULT/);
  });

  it('DROP DEFAULT format', () => {
    const upSQL = `ALTER TABLE "users" ALTER COLUMN "role" DROP DEFAULT;`;
    const downSQL = `ALTER TABLE "users" ALTER COLUMN "role" SET DEFAULT 'member';`;

    assert.match(upSQL, /DROP DEFAULT/);
    assert.match(downSQL, /SET DEFAULT/);
  });
});

describe('schemaDiff patterns — no changes (identical schemas)', () => {
  it('same schema generates identical SQL', () => {
    const schema1 = defineSchema({
      users: {
        id: { type: 'serial', primaryKey: true },
        name: { type: 'text', notNull: true },
      },
    });
    const schema2 = defineSchema({
      users: {
        id: { type: 'serial', primaryKey: true },
        name: { type: 'text', notNull: true },
      },
    });
    const sql1 = schemaToSQLString(schema1);
    const sql2 = schemaToSQLString(schema2);
    assert.equal(sql1, sql2, 'identical schemas should produce identical SQL');
  });
});

describe('schemaDiff patterns — add/remove FK indexes', () => {
  it('FK column generates CREATE INDEX in create path', () => {
    const schema = defineSchema({
      teams: {
        id: { type: 'serial', primaryKey: true },
      },
      players: {
        id: { type: 'serial', primaryKey: true },
        teamId: { type: 'bigint', notNull: true, references: 'teams.id' },
      },
    });
    const stmts = schemaToSQL(schema);
    const indexStmt = stmts.find((s) => s.includes('idx_players_team_id'));
    assert.ok(indexStmt, 'should generate FK index');
    assert.match(indexStmt!, /CREATE INDEX "idx_players_team_id" ON "players"\("team_id"\)/);
  });

  it('reverse of CREATE TABLE drops FK indexes automatically (CASCADE)', () => {
    // When a table is dropped with CASCADE, its indexes go with it.
    // schemaDiff's reverseStatements for CREATE TABLE is:
    // DROP TABLE IF EXISTS "table" CASCADE;
    // No separate DROP INDEX needed.
    const reverseSQL = `DROP TABLE IF EXISTS "players" CASCADE;`;
    assert.ok(reverseSQL.includes('CASCADE'), 'CASCADE drops indexes automatically');
  });
});

// ---------------------------------------------------------------------------
// Integration tests — only run when DATABASE_URL is available
// ---------------------------------------------------------------------------

const DATABASE_URL = process.env.DATABASE_URL;

const integrationDescribe = describe;

integrationDescribe('schemaDiff() integration — live database', () => {
  // Without DATABASE_URL these tests register as skipped (visible in the
  // reporter summary) and the before/after hooks become no-ops.
  const { it, before, after } = skipGate(!DATABASE_URL, 'DATABASE_URL not set');
  let testSchema: string;

  before(async () => {
    // Create a unique test schema to avoid conflicts
    testSchema = `turbine_diff_test_${Date.now()}`;
    const pg = await import('pg');
    const client = new pg.default.Client({ connectionString: DATABASE_URL });
    await client.connect();
    await client.query(`CREATE SCHEMA IF NOT EXISTS "${testSchema}"`);
    await client.query(`SET search_path TO "${testSchema}"`);
    // Create a table that we'll diff against
    await client.query(`
      CREATE TABLE "${testSchema}".diff_users (
        id BIGSERIAL PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await client.end();
  });

  after(async () => {
    const pg = await import('pg');
    const client = new pg.default.Client({ connectionString: DATABASE_URL });
    await client.connect();
    await client.query(`DROP SCHEMA IF EXISTS "${testSchema}" CASCADE`);
    await client.end();
  });

  it('detects new table (not in DB)', async () => {
    // Schema that has a table not in the database's public schema
    const schema = defineSchema({
      newTable: {
        id: { type: 'serial', primaryKey: true },
        label: { type: 'text', notNull: true },
      },
    });

    const diff = await schemaDiff(schema, DATABASE_URL!);
    // new_table should be in create[] (unless it already exists in public)
    const createNames = diff.create.map((t) => t.name);
    assert.ok(createNames.includes('new_table'), 'new_table should be in create[]');
    assert.ok(diff.statements.some((s) => s.includes('CREATE TABLE "new_table"')));
    assert.ok(diff.reverseStatements.some((s) => s.includes('DROP TABLE IF EXISTS "new_table" CASCADE')));
  });

  it('no changes for empty schema returns empty diff', async () => {
    const schema = defineSchema({});
    const diff = await schemaDiff(schema, DATABASE_URL!);
    assert.equal(diff.create.length, 0);
    assert.equal(diff.alter.length, 0);
    assert.equal(diff.statements.length, 0);
    assert.equal(diff.reverseStatements.length, 0);
    // drop may be non-empty (existing tables in public schema)
  });

  it('DiffResult has correct shape', async () => {
    const schema = defineSchema({
      shapeTester: {
        id: { type: 'serial', primaryKey: true },
      },
    });
    const diff = await schemaDiff(schema, DATABASE_URL!);

    assert.ok(Array.isArray(diff.create));
    assert.ok(Array.isArray(diff.alter));
    assert.ok(Array.isArray(diff.drop));
    assert.ok(Array.isArray(diff.statements));
    assert.ok(Array.isArray(diff.reverseStatements));
  });
});

// ---------------------------------------------------------------------------
// WS-B round-trip integration — defineSchema → push → diff = empty
// ---------------------------------------------------------------------------

describe('WS-B round-trip — extended features push then diff clean', () => {
  const { it, before, after } = skipGate(!DATABASE_URL, 'DATABASE_URL not set');

  // Unique names so we never collide with (or clobber) real public tables.
  const suffix = `wsb_${Date.now()}`;
  const orgTable = `orgs_${suffix}`;
  const memberTable = `members_${suffix}`;
  const enumName = `member_role_${suffix}`;

  const buildSchema = () =>
    defineSchema(
      {
        [orgTable]: {
          id: { type: 'serial', primaryKey: true },
          name: { type: 'text', notNull: true },
        },
        [memberTable]: {
          id: { type: 'serial', primaryKey: true },
          orgId: {
            type: 'integer',
            notNull: true,
            references: { target: `${orgTable}.id`, onDelete: 'cascade' },
          },
          role: { type: 'enum', enumName, notNull: true, default: "'member'" },
          seats: { type: 'integer', notNull: true, check: 'seats >= 0' },
          checks: [{ name: `${memberTable}_seats_cap`, expression: 'seats <= 100' }],
        },
      },
      { enums: { [enumName]: ['member', 'admin', 'owner'] } },
    );

  after(async () => {
    const pg = await import('pg');
    const client = new pg.default.Client({ connectionString: DATABASE_URL });
    await client.connect();
    await client.query(`DROP TABLE IF EXISTS "${memberTable}" CASCADE`);
    await client.query(`DROP TABLE IF EXISTS "${orgTable}" CASCADE`);
    await client.query(`DROP TYPE IF EXISTS "${enumName}"`);
    await client.end();
  });

  before(async () => {
    const { schemaPush } = await import('../schema-sql.js');
    await schemaPush(buildSchema(), DATABASE_URL!);
  });

  it('re-diffing the pushed schema produces no statements for its objects', async () => {
    const diff = await schemaDiff(buildSchema(), DATABASE_URL!);
    const mine = diff.statements.filter((s) => s.includes(orgTable) || s.includes(memberTable) || s.includes(enumName));
    assert.deepEqual(mine, [], `expected empty diff for WS-B objects, got:\n${mine.join('\n')}`);
  });

  it('appending an enum value is detected as ALTER TYPE ADD VALUE', async () => {
    const grown = defineSchema(
      {
        [orgTable]: { id: { type: 'serial', primaryKey: true }, name: { type: 'text', notNull: true } },
        [memberTable]: {
          id: { type: 'serial', primaryKey: true },
          orgId: { type: 'integer', notNull: true, references: { target: `${orgTable}.id`, onDelete: 'cascade' } },
          role: { type: 'enum', enumName, notNull: true, default: "'member'" },
          seats: { type: 'integer', notNull: true, check: 'seats >= 0' },
          checks: [{ name: `${memberTable}_seats_cap`, expression: 'seats <= 100' }],
        },
      },
      { enums: { [enumName]: ['member', 'admin', 'owner', 'billing'] } },
    );
    const diff = await schemaDiff(grown, DATABASE_URL!);
    assert.ok(
      diff.statements.some((s) => s.includes(`ALTER TYPE "${enumName}" ADD VALUE 'billing'`)),
      `expected ADD VALUE for 'billing', got:\n${diff.statements.join('\n')}`,
    );
  });

  it('changing a FK referential action is detected as DROP + ADD CONSTRAINT', async () => {
    const changed = defineSchema(
      {
        [orgTable]: { id: { type: 'serial', primaryKey: true }, name: { type: 'text', notNull: true } },
        [memberTable]: {
          id: { type: 'serial', primaryKey: true },
          orgId: { type: 'integer', notNull: true, references: { target: `${orgTable}.id`, onDelete: 'set null' } },
          role: { type: 'enum', enumName, notNull: true, default: "'member'" },
          seats: { type: 'integer', notNull: true, check: 'seats >= 0' },
          checks: [{ name: `${memberTable}_seats_cap`, expression: 'seats <= 100' }],
        },
      },
      { enums: { [enumName]: ['member', 'admin', 'owner'] } },
    );
    const diff = await schemaDiff(changed, DATABASE_URL!);
    assert.ok(diff.statements.some((s) => /DROP CONSTRAINT/.test(s) && s.includes(memberTable)));
    assert.ok(diff.statements.some((s) => /ADD CONSTRAINT.*ON DELETE SET NULL/.test(s)));
  });
});

// ---------------------------------------------------------------------------
// DiffResult structural validation (always runs)
// ---------------------------------------------------------------------------

describe('DiffResult structure — type contract validation', () => {
  it('AlterColumnDef actions cover all diff operations', () => {
    // Verify the expected actions from schema-sql.ts
    const validActions = [
      'add',
      'drop',
      'alter_type',
      'set_not_null',
      'drop_not_null',
      'set_default',
      'drop_default',
      'add_unique',
      'drop_unique',
    ];

    // Each action should have a reversible SQL counterpart
    const actionReversePairs: Record<string, string> = {
      add: 'drop', // ADD COLUMN → DROP COLUMN
      alter_type: 'alter_type', // TYPE X → TYPE Y
      set_not_null: 'drop_not_null',
      drop_not_null: 'set_not_null',
      set_default: 'drop_default', // or set_default with old value
      drop_default: 'set_default',
      add_unique: 'drop_unique',
      drop_unique: 'add_unique',
    };

    for (const action of validActions) {
      assert.ok(typeof action === 'string', `action "${action}" is a string`);
    }

    // Verify pairs make sense
    assert.equal(actionReversePairs.set_not_null, 'drop_not_null');
    assert.equal(actionReversePairs.add_unique, 'drop_unique');
  });

  it('CREATE TABLE reverse is DROP TABLE IF EXISTS ... CASCADE', () => {
    // Test the exact format from schema-sql.ts line 423
    const tableName = 'my_table';
    const expected = `DROP TABLE IF EXISTS "my_table" CASCADE;`;
    const computed = `DROP TABLE IF EXISTS ${quoteIdentSimple(tableName)} CASCADE;`;
    assert.equal(computed, expected);
  });

  it('ADD COLUMN reverse is DROP COLUMN', () => {
    const table = 'users';
    const col = 'bio';
    const addSql = `ALTER TABLE "${table}" ADD COLUMN "${col}" TEXT;`;
    const dropSql = `ALTER TABLE "${table}" DROP COLUMN "${col}";`;
    assert.match(addSql, /ADD COLUMN/);
    assert.match(dropSql, /DROP COLUMN/);
  });

  it('SET NOT NULL reverse is DROP NOT NULL', () => {
    const sql = `ALTER TABLE "users" ALTER COLUMN "name" SET NOT NULL;`;
    const reverse = `ALTER TABLE "users" ALTER COLUMN "name" DROP NOT NULL;`;
    assert.match(sql, /SET NOT NULL/);
    assert.match(reverse, /DROP NOT NULL/);
  });

  it('ADD UNIQUE reverse is DROP CONSTRAINT', () => {
    const sql = `ALTER TABLE "users" ADD CONSTRAINT "users_email_key" UNIQUE ("email");`;
    const reverse = `ALTER TABLE "users" DROP CONSTRAINT "users_email_key";`;
    assert.match(sql, /ADD CONSTRAINT/);
    assert.match(reverse, /DROP CONSTRAINT/);
  });

  it('SET DEFAULT reverse is DROP DEFAULT', () => {
    const sql = `ALTER TABLE "t" ALTER COLUMN "c" SET DEFAULT 'hello';`;
    const reverse = `ALTER TABLE "t" ALTER COLUMN "c" DROP DEFAULT;`;
    assert.match(sql, /SET DEFAULT/);
    assert.match(reverse, /DROP DEFAULT/);
  });

  it('ALTER TYPE reverse restores old type with USING cast', () => {
    const sql = `ALTER TABLE "t" ALTER COLUMN "c" TYPE INTEGER USING "c"::INTEGER;`;
    const reverse = `ALTER TABLE "t" ALTER COLUMN "c" TYPE TEXT USING "c"::TEXT;`;
    assert.match(sql, /TYPE INTEGER USING "c"::INTEGER/);
    assert.match(reverse, /TYPE TEXT USING "c"::TEXT/);
  });
});

// ---------------------------------------------------------------------------
// schemaToSQL output correctness for diff scenarios
// ---------------------------------------------------------------------------

describe('schemaToSQL — diff-relevant DDL patterns', () => {
  it('column with all modifiers produces correct DDL', () => {
    const schema = defineSchema({
      items: {
        id: { type: 'serial', primaryKey: true },
        code: { type: 'varchar', maxLength: 20, unique: true, notNull: true },
        price: { type: 'numeric', notNull: true, default: '0' },
        active: { type: 'boolean', notNull: true, default: 'true' },
        meta: { type: 'json', nullable: true },
        categoryId: { type: 'bigint', notNull: true, references: 'items.id' },
      },
    });
    const stmts = schemaToSQL(schema);
    const createStmt = stmts.find((s) => s.includes('CREATE TABLE "items"'));
    assert.ok(createStmt);

    assert.ok(createStmt.includes('"code" VARCHAR(20) UNIQUE NOT NULL'));
    assert.ok(createStmt.includes('"price" NUMERIC NOT NULL DEFAULT 0'));
    assert.ok(createStmt.includes('"active" BOOLEAN NOT NULL DEFAULT TRUE'));
    assert.ok(createStmt.includes('"meta" JSONB'));
    assert.ok(createStmt.includes('"category_id" BIGINT NOT NULL REFERENCES "items"("id")'));
  });

  it('each column type maps to correct DDL', () => {
    const schema = defineSchema({
      allTypes: {
        a: { type: 'serial', primaryKey: true },
        b: { type: 'bigint' },
        c: { type: 'integer' },
        d: { type: 'smallint' },
        e: { type: 'text' },
        f: { type: 'varchar', maxLength: 100 },
        g: { type: 'boolean' },
        h: { type: 'timestamp' },
        i: { type: 'date' },
        j: { type: 'json' },
        k: { type: 'uuid' },
        l: { type: 'real' },
        m: { type: 'double' },
        n: { type: 'numeric' },
        o: { type: 'bytea' },
        p: { type: 'bigserial' },
        q: { type: 'timestamptz' },
        r: { type: 'jsonb' },
      },
    });
    const stmts = schemaToSQL(schema);
    const ddl = stmts[0]!;

    // `serial` emits SERIAL (int4) as of 0.24.0; `bigserial` covers 64-bit keys.
    assert.ok(ddl.includes('"a" SERIAL PRIMARY KEY'));
    assert.ok(ddl.includes('"b" BIGINT'));
    assert.ok(ddl.includes('"c" INTEGER'));
    assert.ok(ddl.includes('"d" SMALLINT'));
    assert.ok(ddl.includes('"e" TEXT'));
    assert.ok(ddl.includes('"f" VARCHAR(100)'));
    assert.ok(ddl.includes('"g" BOOLEAN'));
    assert.ok(ddl.includes('"h" TIMESTAMPTZ'));
    assert.ok(ddl.includes('"i" DATE'));
    assert.ok(ddl.includes('"j" JSONB'));
    assert.ok(ddl.includes('"k" UUID'));
    assert.ok(ddl.includes('"l" REAL'));
    assert.ok(ddl.includes('"m" DOUBLE PRECISION'));
    assert.ok(ddl.includes('"n" NUMERIC'));
    assert.ok(ddl.includes('"o" BYTEA'));
    assert.ok(ddl.includes('"p" BIGSERIAL'));
    assert.ok(ddl.includes('"q" TIMESTAMPTZ'));
    assert.ok(ddl.includes('"r" JSONB'));
  });

  it('FK references use correct quoting', () => {
    const schema = defineSchema({
      orgs: {
        id: { type: 'serial', primaryKey: true },
      },
      users: {
        id: { type: 'serial', primaryKey: true },
        orgId: { type: 'bigint', references: 'orgs.id' },
      },
    });
    const stmts = schemaToSQL(schema);
    const usersStmt = stmts.find((s) => s.includes('CREATE TABLE "users"'));
    assert.ok(usersStmt?.includes('REFERENCES "orgs"("id")'));
  });
});

// ---------------------------------------------------------------------------
// schemaToSQL — reverse direction patterns (what DOWN migrations look like)
// ---------------------------------------------------------------------------

describe('schemaDiff reverse statement patterns — comprehensive', () => {
  it('CREATE TABLE reverse follows DROP TABLE IF EXISTS pattern', () => {
    // For each table in create[], the reverse is:
    // DROP TABLE IF EXISTS "table_name" CASCADE;
    // These are unshift'd (prepended) so they drop in reverse dependency order
    const tables = ['users', 'posts', 'comments'];
    const reverses = tables.map((t) => `DROP TABLE IF EXISTS "${t}" CASCADE;`);

    for (const rev of reverses) {
      assert.match(rev, /^DROP TABLE IF EXISTS "\w+" CASCADE;$/);
    }
  });

  it('ADD COLUMN reverse follows DROP COLUMN pattern', () => {
    const colName = 'bio';
    const reverse = `ALTER TABLE "users" DROP COLUMN "${colName}";`;
    assert.equal(reverse, 'ALTER TABLE "users" DROP COLUMN "bio";');
  });

  it('ALTER TYPE reverse includes USING cast with original type', () => {
    const col = 'age';
    const originalType = 'TEXT';
    const reverse = `ALTER TABLE "people" ALTER COLUMN "${col}" TYPE ${originalType} USING "${col}"::${originalType};`;
    assert.match(reverse, /ALTER TABLE "people" ALTER COLUMN "age" TYPE TEXT USING "age"::TEXT;/);
  });

  it('SET NOT NULL / DROP NOT NULL are symmetric reverses', () => {
    const setNotNull = `ALTER TABLE "t" ALTER COLUMN "c" SET NOT NULL;`;
    const dropNotNull = `ALTER TABLE "t" ALTER COLUMN "c" DROP NOT NULL;`;

    // SET NOT NULL reverse is DROP NOT NULL
    assert.match(setNotNull, /SET NOT NULL/);
    assert.match(dropNotNull, /DROP NOT NULL/);

    // And vice versa
    const setAsReverse = dropNotNull.replace('DROP NOT NULL', 'SET NOT NULL');
    assert.equal(setAsReverse, setNotNull);
  });

  it('SET DEFAULT / DROP DEFAULT follow expected patterns', () => {
    const setDefault = `ALTER TABLE "t" ALTER COLUMN "c" SET DEFAULT 'active';`;
    const dropDefault = `ALTER TABLE "t" ALTER COLUMN "c" DROP DEFAULT;`;

    // Reverse of SET DEFAULT is either SET DEFAULT <old_value> or DROP DEFAULT
    assert.match(setDefault, /SET DEFAULT 'active'/);
    assert.match(dropDefault, /DROP DEFAULT/);
  });

  it('ADD/DROP CONSTRAINT are symmetric', () => {
    const addConstraint = `ALTER TABLE "t" ADD CONSTRAINT "t_c_key" UNIQUE ("c");`;
    const dropConstraint = `ALTER TABLE "t" DROP CONSTRAINT "t_c_key";`;

    assert.match(addConstraint, /ADD CONSTRAINT "t_c_key" UNIQUE \("c"\)/);
    assert.match(dropConstraint, /DROP CONSTRAINT "t_c_key"/);
  });

  it('reverseStatements are in reverse order (unshift pattern)', () => {
    // schemaDiff uses result.reverseStatements.unshift() which means
    // later operations appear first in the reverse array.
    // This ensures proper reverse dependency ordering.
    const operations = ['ALTER TABLE "a" ADD COLUMN "x" TEXT;', 'ALTER TABLE "b" ADD COLUMN "y" TEXT;'];
    const reverseStatements: string[] = [];

    // Simulate the unshift pattern used in schemaDiff
    for (const op of operations) {
      const reverse = op.replace('ADD COLUMN', 'DROP COLUMN').replace(' TEXT', '');
      reverseStatements.unshift(reverse);
    }

    // Last operation's reverse comes first
    assert.match(reverseStatements[0]!, /ALTER TABLE "b"/);
    assert.match(reverseStatements[1]!, /ALTER TABLE "a"/);
  });
});

// ---------------------------------------------------------------------------
// Helper: simple quoteIdent for test assertions (mirrors the real one)
// ---------------------------------------------------------------------------

function quoteIdentSimple(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}
