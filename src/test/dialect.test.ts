import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { type Dialect, postgresDialect, QueryInterface } from '../index.js';
import type { RelationDef, SchemaMetadata } from '../schema.js';
import { column, defineSchema, table } from '../schema-builder.js';
import { schemaToSQL } from '../schema-sql.js';
import { mockTable } from './helpers.js';

const mysqlishDialect: Dialect = {
  ...postgresDialect,
  name: 'mysql',
  emptyJsonArrayLiteral: 'JSON_ARRAY()',
  nullJsonLiteral: 'NULL',
  supportsReturning: false,
  supportsILike: false,
  jsonPathSupport: 'function',
  paramPlaceholder: () => '?',
  quoteIdentifier: (name) => `\`${name.replace(/`/g, '``')}\``,
  buildReturningClause: () => '',
  buildInsertStatement: (input) =>
    `INSERT INTO ${input.table} (${input.columns.join(', ')}) VALUES (${input.valuePlaceholders.join(', ')})`,
  buildBulkInsertStatement(input) {
    const placeholders = input.rowValues
      .map((row) => `(${row.map((_, i) => this.paramPlaceholder(i + 1)).join(', ')})`)
      .join(', ');
    const params = input.rowValues.flat();
    const firstColumn = input.columns[0] ?? 'id';
    const duplicateClause = input.skipDuplicates ? ` ON DUPLICATE KEY UPDATE ${firstColumn} = ${firstColumn}` : '';
    return {
      sql: `INSERT INTO ${input.table} (${input.columns.join(', ')}) VALUES ${placeholders}${duplicateClause}`,
      params,
    };
  },
  buildUpsertStatement: (input) =>
    `INSERT INTO ${input.table} (${input.insertColumns.join(', ')}) VALUES (${input.valuePlaceholders.join(', ')}) ON DUPLICATE KEY UPDATE ${input.updateSetClauses.join(', ')}`,
  buildJsonObject: (pairs) =>
    `JSON_OBJECT(${pairs.map(([key, expr]) => `'${key.replace(/'/g, "''")}', ${expr}`).join(', ')})`,
  buildJsonArrayAgg: (jsonObjectExpr, orderBy) =>
    `COALESCE(JSON_ARRAYAGG(${jsonObjectExpr}${orderBy ? ` ${orderBy}` : ''}), JSON_ARRAY())`,
  buildInsensitiveLike: (column, paramRef) => `LOWER(${column}) LIKE LOWER(${paramRef})`,
  buildJsonContains: (column, paramRef) => `JSON_CONTAINS(${column}, ${paramRef})`,
  buildJsonPathExtract: (column, pathParamRef) => `JSON_UNQUOTE(JSON_EXTRACT(${column}, ${pathParamRef}))`,
  buildCorrelation(leftRef, leftColumns, rightRef, rightColumns) {
    const leftCols = Array.isArray(leftColumns) ? leftColumns : [leftColumns];
    const rightCols = Array.isArray(rightColumns) ? rightColumns : [rightColumns];
    return leftCols
      .map((col, i) => `${leftRef}.${this.quoteIdentifier(col)} = ${rightRef}.${this.quoteIdentifier(rightCols[i]!)}`)
      .join(' AND ');
  },
  buildColumnType(input) {
    if (input.type === 'BIGSERIAL') return 'BIGINT AUTO_INCREMENT';
    if (input.type === 'TIMESTAMPTZ') return 'DATETIME';
    if (input.type === 'JSONB') return 'JSON';
    return postgresDialect.buildColumnType(input);
  },
  buildMigrationTrackingTable(tableName) {
    return `CREATE TABLE IF NOT EXISTS ${tableName} (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    checksum TEXT NOT NULL,
    applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  );`;
  },
  buildMigrationInsertApplied(tableName) {
    return `INSERT INTO ${tableName} (name, checksum) VALUES (?, ?) ON DUPLICATE KEY UPDATE name = name`;
  },
};

const usersTable = mockTable(
  'users',
  [
    { name: 'id', field: 'id', pgType: 'int8' },
    { name: 'name', field: 'name', pgType: 'text' },
    { name: 'metadata', field: 'metadata', pgType: 'jsonb' },
  ],
  {
    posts: {
      name: 'posts',
      type: 'hasMany',
      from: 'users',
      to: 'posts',
      foreignKey: 'user_id',
      referenceKey: 'id',
    } as RelationDef,
  },
);

const postsTable = mockTable('posts', [
  { name: 'id', field: 'id', pgType: 'int8' },
  { name: 'user_id', field: 'userId', pgType: 'int8' },
  { name: 'title', field: 'title', pgType: 'text' },
]);

const schema: SchemaMetadata = { tables: { users: usersTable, posts: postsTable }, enums: {} };

function queryWithDialect(dialect: Dialect): QueryInterface<Record<string, unknown>> {
  // biome-ignore lint/suspicious/noExplicitAny: build-only test; pool is never used.
  return new QueryInterface<Record<string, unknown>>(null as any, 'users', schema, [], { dialect });
}

describe('Dialect contract', () => {
  it('postgresDialect preserves current PostgreSQL primitives', () => {
    assert.equal(postgresDialect.paramPlaceholder(2), '$2');
    assert.equal(postgresDialect.quoteIdentifier('a"b'), '"a""b"');
    assert.equal(
      postgresDialect.buildJsonObject([['createdAt', 't0."created_at"']]),
      'json_build_object(\'createdAt\', t0."created_at")',
    );
    assert.equal(
      postgresDialect.buildJsonArrayAgg('json_build_object(\'id\', t0."id")'),
      "COALESCE(json_agg(json_build_object('id', t0.\"id\")), '[]'::json)",
    );
  });

  it('QueryInterface routes identifiers, placeholders, and LIKE through the active dialect', () => {
    const q = queryWithDialect(mysqlishDialect);
    const d = q.buildFindMany({ where: { name: { contains: 'Ada', mode: 'insensitive' } }, limit: 10 });

    assert.match(d.sql, /FROM `users`/);
    assert.match(d.sql, /LOWER\(`name`\) LIKE LOWER\(\?\) ESCAPE/);
    assert.match(d.sql, /LIMIT \?/);
    assert.doesNotMatch(d.sql, /\$1|ILIKE|"users"/);
    assert.deepEqual(d.params, ['%Ada%', 10]);
  });

  it('QueryInterface routes relation JSON generation through the active dialect', () => {
    const q = queryWithDialect(mysqlishDialect);
    const d = q.buildFindMany({ with: { posts: true }, limit: 1 });

    assert.match(d.sql, /JSON_ARRAYAGG/);
    assert.match(d.sql, /JSON_OBJECT\('id', t0\.`id`/);
    assert.match(d.sql, /COALESCE\(JSON_ARRAYAGG/);
    assert.doesNotMatch(d.sql, /json_agg|json_build_object|'\[\]'::json/);
  });

  it('QueryInterface routes JSON filter operators through the active dialect', () => {
    const q = queryWithDialect(mysqlishDialect);
    const d = q.buildFindMany({ where: { metadata: { contains: { role: 'admin' } } } });

    assert.match(d.sql, /JSON_CONTAINS\(`metadata`, \?\)/);
    assert.deepEqual(d.params, ['{"role":"admin"}']);
  });

  it('QueryInterface routes DML RETURNING, bulk insert, and upsert through the active dialect', () => {
    const q = queryWithDialect(mysqlishDialect);

    const created = q.buildCreate({ data: { id: 1, name: 'Ada' } });
    assert.equal(created.sql, 'INSERT INTO `users` (`id`, `name`) VALUES (?, ?)');
    assert.deepEqual(created.params, [1, 'Ada']);

    const bulk = q.buildCreateMany({
      data: [
        { id: 1, name: 'Ada' },
        { id: 2, name: 'Grace' },
      ],
      skipDuplicates: true,
    });
    assert.equal(
      bulk.sql,
      'INSERT INTO `users` (`id`, `name`) VALUES (?, ?), (?, ?) ON DUPLICATE KEY UPDATE `id` = `id`',
    );
    assert.deepEqual(bulk.params, [1, 'Ada', 2, 'Grace']);

    const upsert = q.buildUpsert({
      where: { id: 1 },
      create: { id: 1, name: 'Ada' },
      update: { name: 'Ada Lovelace' },
    });
    assert.equal(upsert.sql, 'INSERT INTO `users` (`id`, `name`) VALUES (?, ?) ON DUPLICATE KEY UPDATE `name` = ?');
    assert.deepEqual(upsert.params, [1, 'Ada', 'Ada Lovelace']);

    assert.doesNotMatch(`${created.sql} ${bulk.sql} ${upsert.sql}`, /RETURNING|UNNEST|ON CONFLICT|\$1/);
  });

  it('schema DDL generation routes identifiers and type names through the active dialect', () => {
    const schema = defineSchema({
      organizations: table({
        id: column.serial().primaryKey(),
        createdAt: column.timestamp().notNull().default('now()'),
      }),
      users: table({
        id: column.serial().primaryKey(),
        orgId: column.bigint().notNull().references('organizations.id'),
        profile: column.json().nullable(),
      }),
    });

    const sql = schemaToSQL(schema, { dialect: mysqlishDialect }).join('\n');

    assert.match(sql, /CREATE TABLE `organizations`/);
    assert.match(sql, /`id` BIGINT AUTO_INCREMENT PRIMARY KEY/);
    assert.match(sql, /`created_at` DATETIME NOT NULL DEFAULT NOW\(\)/);
    assert.match(sql, /`profile` JSON/);
    assert.match(sql, /REFERENCES `organizations`\(`id`\)/);
    assert.match(sql, /CREATE INDEX `idx_users_org_id` ON `users`\(`org_id`\);/);
    assert.doesNotMatch(sql, /"organizations"|BIGSERIAL|TIMESTAMPTZ|JSONB/);
  });

  it('migration tracking SQL is dialect-owned', () => {
    assert.equal(
      mysqlishDialect.buildMigrationInsertApplied('`_turbine_migrations`'),
      'INSERT INTO `_turbine_migrations` (name, checksum) VALUES (?, ?) ON DUPLICATE KEY UPDATE name = name',
    );
    assert.match(
      mysqlishDialect.buildMigrationTrackingTable('`_turbine_migrations`'),
      /id BIGINT AUTO_INCREMENT PRIMARY KEY/,
    );
    assert.doesNotMatch(mysqlishDialect.buildMigrationTrackingTable('`_turbine_migrations`'), /SERIAL|TIMESTAMPTZ/);
  });
});
