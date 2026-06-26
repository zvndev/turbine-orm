import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { type Dialect, postgresDialect, QueryInterface, UnsupportedFeatureError } from '../index.js';
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
  typeToTypeScript(dialectType, nullable) {
    const base =
      {
        bigint: 'number',
        int: 'number',
        varchar: 'string',
        datetime: 'Date',
        json: 'unknown',
      }[dialectType.toLowerCase()] ?? 'unknown';
    return nullable ? `${base} | null` : base;
  },
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

const { typeToTypeScript: _typeToTypeScript, ...legacyCompatibleDialect }: Dialect = mysqlishDialect;
void _typeToTypeScript;

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
    assert.equal(postgresDialect.typeToTypeScript?.('int8', false), 'number');
    assert.equal(postgresDialect.typeToTypeScript?.('_text', true), 'string[] | null');
    assert.equal(postgresDialect.arrayType?.('int8'), 'bigint[]');
  });

  it('type mapping is owned by the active dialect contract when implemented', () => {
    assert.equal(mysqlishDialect.typeToTypeScript?.('varchar', false), 'string');
    assert.equal(mysqlishDialect.typeToTypeScript?.('datetime', true), 'Date | null');
    assert.equal(mysqlishDialect.typeToTypeScript?.('json', false), 'unknown');
  });

  it('keeps v0.13-style query dialect implementations source-compatible', () => {
    assert.equal(legacyCompatibleDialect.name, 'mysql');
    assert.equal('typeToTypeScript' in legacyCompatibleDialect, false);
    assert.equal(queryWithDialect(legacyCompatibleDialect).buildFindUnique({ where: { id: 1 } }).params[0], 1);
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

// ---------------------------------------------------------------------------
// A second non-PG fixture: a SQLite-ish dialect. Standardizes on "…" quoting
// (so identifiers overlap with PG — its forbidden set excludes that), positional
// `?`, json_object/json_group_array with json()-wrapped nested subresults, and
// aggSupportsInlineOrderBy=false (json_group_array has no ORDER BY argument).
// ---------------------------------------------------------------------------

const sqliteishDialect: Dialect = {
  ...postgresDialect,
  name: 'sqlite',
  resultStrategy: 'returning', // SQLite ≥ 3.35 has RETURNING
  supportsReturning: true,
  supportsILike: false,
  supportsVector: false,
  supportsListenNotify: false,
  supportsRLS: false,
  supportsAdvisoryLock: false,
  aggSupportsInlineOrderBy: false,
  jsonPathSupport: 'function',
  emptyJsonArrayLiteral: "json('[]')",
  nullJsonLiteral: 'NULL',
  paramPlaceholder: () => '?',
  quoteIdentifier: (name) => `"${name.replace(/"/g, '""')}"`,
  buildJsonObject: (pairs) =>
    `json_object(${pairs.map(([key, expr]) => `'${key.replace(/'/g, "''")}', ${expr}`).join(', ')})`,
  buildJsonArrayAgg: (jsonObjectExpr, orderBy) =>
    `COALESCE(json_group_array(json(${jsonObjectExpr}))${orderBy ? ` ${orderBy}` : ''}, json('[]'))`,
  // SQLite's json_group_array double-encodes nested objects, so each nested
  // subresult is json()-wrapped — the whole point of the wrapJsonSubresult hook.
  wrapJsonSubresult: (subquery, fallback) => `COALESCE(json((${subquery})), ${fallback})`,
  buildReturningClause: (selection = '*') => ` RETURNING ${selection}`,
  buildInsertStatement: (input) =>
    `INSERT INTO ${input.table} (${input.columns.join(', ')}) VALUES (${input.valuePlaceholders.join(', ')}) RETURNING *`,
  buildBulkInsertStatement(input) {
    const placeholders = input.rowValues.map((row) => `(${row.map(() => '?').join(', ')})`).join(', ');
    return {
      sql: `INSERT INTO ${input.table} (${input.columns.join(', ')}) VALUES ${placeholders} RETURNING *`,
      params: input.rowValues.flat(),
    };
  },
  buildUpsertStatement: (input) =>
    `INSERT INTO ${input.table} (${input.insertColumns.join(', ')}) VALUES (${input.valuePlaceholders.join(', ')}) ` +
    `ON CONFLICT (${input.conflictColumns.join(', ')}) DO UPDATE SET ${input.updateSetClauses.join(', ')} RETURNING *`,
  buildInsensitiveLike: (column, paramRef) => `${column} LIKE ${paramRef} COLLATE NOCASE`,
  buildJsonContains: (column, paramRef) =>
    `EXISTS (SELECT 1 FROM json_each(${column}) WHERE json_each.value = ${paramRef})`,
  buildJsonPathExtract: (column, pathParamRef) => `json_extract(${column}, ${pathParamRef})`,
  buildCorrelation(leftRef, leftColumns, rightRef, rightColumns) {
    const leftCols = Array.isArray(leftColumns) ? leftColumns : [leftColumns];
    const rightCols = Array.isArray(rightColumns) ? rightColumns : [rightColumns];
    return leftCols
      .map((col, i) => `${leftRef}.${this.quoteIdentifier(col)} = ${rightRef}.${this.quoteIdentifier(rightCols[i]!)}`)
      .join(' AND ');
  },
};

// ---------------------------------------------------------------------------
// Conformance matrix — run the SAME build-only assertions against every
// registered non-PG dialect and assert zero PostgreSQL tokens leak. PG itself
// is exercised separately as a positive control (it SHOULD emit those tokens).
// ---------------------------------------------------------------------------

const convUsers = mockTable(
  'users',
  [
    { name: 'id', field: 'id', pgType: 'int8' },
    { name: 'name', field: 'name', pgType: 'text' },
    { name: 'embedding', field: 'embedding', pgType: 'vector' },
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

const convPosts = mockTable(
  'posts',
  [
    { name: 'id', field: 'id', pgType: 'int8' },
    { name: 'user_id', field: 'userId', pgType: 'int8' },
    { name: 'title', field: 'title', pgType: 'text' },
  ],
  {
    author: {
      name: 'author',
      type: 'belongsTo',
      from: 'posts',
      to: 'users',
      foreignKey: 'user_id',
      referenceKey: 'id',
    } as RelationDef,
  },
);

const convSchema: SchemaMetadata = { tables: { users: convUsers, posts: convPosts }, enums: {} };

function convQuery(dialect: Dialect): QueryInterface<Record<string, unknown>> {
  // biome-ignore lint/suspicious/noExplicitAny: build-only test; pool is never used.
  return new QueryInterface<Record<string, unknown>>(null as any, 'users', convSchema, [], { dialect });
}

interface ConformanceFixture {
  label: string;
  dialect: Dialect;
  /** PostgreSQL-isms this engine must NEVER emit, across reads AND writes. */
  forbidden: RegExp;
  /** This engine's own parameter placeholder that SHOULD appear. */
  placeholder: RegExp;
  /** This engine's own identifier-quote form that SHOULD appear. */
  quote: RegExp;
}

const fixtures: ConformanceFixture[] = [
  {
    label: 'mysqlish',
    dialect: mysqlishDialect,
    // MySQL uses backticks + `?`, has no RETURNING / ON CONFLICT / UNNEST / ILIKE.
    forbidden: /json_agg|json_build_object|::json|ILIKE|\$\d|"users"|"posts"|RETURNING|ON CONFLICT|UNNEST/,
    placeholder: /\?/,
    quote: /`users`/,
  },
  {
    label: 'sqliteish',
    dialect: sqliteishDialect,
    // SQLite uses "…" + `?`; it DOES have RETURNING / ON CONFLICT, but never
    // json_agg / UNNEST / ILIKE / `$N` / MySQL backtick identifiers.
    forbidden: /json_agg|json_build_object|::json|ILIKE|\$\d|`users`|`posts`|UNNEST/,
    placeholder: /\?/,
    quote: /"users"/,
  },
];

describe('Dialect conformance matrix (no Postgres leakage)', () => {
  for (const fx of fixtures) {
    describe(fx.label, () => {
      // Every generated statement, across the full read/write surface.
      const statements = (): { op: string; sql: string }[] => {
        const q = convQuery(fx.dialect);
        return [
          {
            op: 'findMany',
            sql: q.buildFindMany({ where: { name: { contains: 'Ada', mode: 'insensitive' } }, limit: 5 }).sql,
          },
          { op: 'findMany+with', sql: q.buildFindMany({ with: { posts: { with: { author: true } } } }).sql },
          {
            op: 'findMany+with+orderBy',
            sql: q.buildFindMany({ with: { posts: { orderBy: { title: 'asc' }, limit: 3 } } }).sql,
          },
          { op: 'create', sql: q.buildCreate({ data: { id: 1, name: 'Ada' } }).sql },
          {
            op: 'createMany',
            sql: q.buildCreateMany({
              data: [
                { id: 1, name: 'Ada' },
                { id: 2, name: 'Grace' },
              ],
              skipDuplicates: true,
            }).sql,
          },
          {
            op: 'upsert',
            sql: q.buildUpsert({ where: { id: 1 }, create: { id: 1, name: 'Ada' }, update: { name: 'Ada L.' } }).sql,
          },
          { op: 'update', sql: q.buildUpdate({ where: { id: 1 }, data: { name: 'Ada L.' } }).sql },
          { op: 'delete', sql: q.buildDelete({ where: { id: 1 } }).sql },
        ];
      };

      it('emits no PostgreSQL tokens across the read/write surface', () => {
        for (const { op, sql } of statements()) {
          assert.doesNotMatch(sql, fx.forbidden, `${fx.label}.${op} leaked a Postgres token: ${sql}`);
        }
      });

      it('routes placeholders and identifier quoting through the dialect', () => {
        const sql = convQuery(fx.dialect).buildFindMany({ where: { id: 1 }, limit: 1 }).sql;
        assert.match(sql, fx.placeholder);
        assert.match(sql, fx.quote);
      });

      it('routes nested-relation JSON wrapping through wrapJsonSubresult', () => {
        // posts → author exercises the nested-subresult wrap hook (the to-one
        // `author` subquery embedded inside the `posts` json_object).
        const sql = convQuery(fx.dialect).buildFindMany({ with: { posts: { with: { author: true } } } }).sql;
        assert.doesNotMatch(sql, fx.forbidden);
        // The hook output is present in some engine-specific form (COALESCE here).
        assert.match(sql, /COALESCE/);
      });
    });
  }

  it('PostgreSQL positive control still emits its native tokens (byte-identical)', () => {
    const q = convQuery(postgresDialect);
    const find = q.buildFindMany({ where: { name: { contains: 'Ada', mode: 'insensitive' } }, limit: 5 });
    assert.match(find.sql, /ILIKE/);
    assert.match(find.sql, /\$1/);
    assert.match(find.sql, /"users"/);

    const withSql = q.buildFindMany({ with: { posts: { with: { author: true } } } }).sql;
    assert.match(withSql, /json_agg/);
    assert.match(withSql, /json_build_object/);
    // wrapJsonSubresult for PG is byte-identical to the historical COALESCE wrap.
    assert.match(withSql, /COALESCE\(\(SELECT json_build_object/);
    assert.match(withSql, /'\[\]'::json/);

    assert.match(q.buildCreate({ data: { id: 1, name: 'Ada' } }).sql, /RETURNING \*/);
    assert.match(q.buildDelete({ where: { id: 1 } }).sql, /RETURNING \*/);
  });

  it('gates pgvector ops behind supportsVector and throws UnsupportedFeatureError', () => {
    // biome-ignore lint/suspicious/noExplicitAny: exercising the vector orderBy surface in a build-only test
    const vectorArgs: any = { orderBy: { embedding: { distance: { to: [1, 2, 3], metric: 'l2' } } } };
    assert.throws(
      () => convQuery(sqliteishDialect).buildFindMany(vectorArgs),
      (err: unknown) =>
        err instanceof UnsupportedFeatureError && /unsupported on "sqlite"/.test((err as Error).message),
    );
    // PostgreSQL still builds the pgvector distance SQL.
    assert.match(convQuery(postgresDialect).buildFindMany(vectorArgs).sql, /<->/);
  });
});

// ---------------------------------------------------------------------------
// Result-strategy keystone — exercise the 'reselect' and 'output' execute paths
// with a MOCK driver. The PG 'returning' path stays the historical single-query
// path (covered by the integration suite).
// ---------------------------------------------------------------------------

interface MockCall {
  sql: string;
  params: unknown[];
}

function mockPool(rowsFor: (sql: string) => Record<string, unknown>[]): {
  pool: unknown;
  calls: MockCall[];
} {
  const calls: MockCall[] = [];
  const pool = {
    // biome-ignore lint/suspicious/noExplicitAny: mock query accepts string or { text, values }
    query: async (textOrConfig: any, values?: unknown[]) => {
      const sql = typeof textOrConfig === 'string' ? textOrConfig : textOrConfig.text;
      const params = typeof textOrConfig === 'string' ? (values ?? []) : (textOrConfig.values ?? []);
      calls.push({ sql, params });
      const rows = rowsFor(sql);
      return { rows, rowCount: rows.length, fields: [] };
    },
  };
  return { pool, calls };
}

function reselectQuery(pool: unknown, dialect: Dialect): QueryInterface<Record<string, unknown>> {
  return new QueryInterface<Record<string, unknown>>(
    // biome-ignore lint/suspicious/noExplicitAny: mock pool stands in for pg.Pool
    pool as any,
    'users',
    schema,
    [],
    { dialect, preparedStatements: false, sqlCache: false },
  );
}

describe('resultStrategy execution', () => {
  const reselectDialect: Dialect = { ...mysqlishDialect, resultStrategy: 'reselect' };
  const outputDialect: Dialect = {
    ...mysqlishDialect,
    resultStrategy: 'output',
    buildInsertStatement: (input) =>
      `INSERT INTO ${input.table} (${input.columns.join(', ')}) OUTPUT INSERTED.* ` +
      `VALUES (${input.valuePlaceholders.join(', ')})`,
  };

  it("'reselect' create: INSERT (no RETURNING) then SELECT by primary key", async () => {
    const { pool, calls } = mockPool((sql) => (sql.startsWith('SELECT') ? [{ id: 1, name: 'Ada' }] : []));
    const q = reselectQuery(pool, reselectDialect);
    const created = await q.create({ data: { id: 1, name: 'Ada' } });

    assert.deepEqual(created, { id: 1, name: 'Ada' });
    assert.equal(calls.length, 2);
    assert.match(calls[0]!.sql, /^INSERT INTO `users`/);
    assert.doesNotMatch(calls[0]!.sql, /RETURNING/);
    assert.match(calls[1]!.sql, /^SELECT \* FROM `users` WHERE `id` = \?$/);
    assert.deepEqual(calls[1]!.params, [1]);
  });

  it("'reselect' update: UPDATE then SELECT by the same where", async () => {
    const { pool, calls } = mockPool((sql) => (sql.startsWith('SELECT') ? [{ id: 1, name: 'Ada L.' }] : []));
    const q = reselectQuery(pool, reselectDialect);
    const updated = await q.update({ where: { id: 1 }, data: { name: 'Ada L.' } });

    assert.deepEqual(updated, { id: 1, name: 'Ada L.' });
    assert.equal(calls.length, 2);
    assert.match(calls[0]!.sql, /^UPDATE `users` SET/);
    assert.doesNotMatch(calls[0]!.sql, /RETURNING/);
    assert.match(calls[1]!.sql, /^SELECT \* FROM `users` WHERE `id` = \?$/);
  });

  it("'reselect' delete: SELECT the row first, then DELETE, returning the captured row", async () => {
    const { pool, calls } = mockPool((sql) => (sql.startsWith('SELECT') ? [{ id: 1, name: 'Ada' }] : []));
    const q = reselectQuery(pool, reselectDialect);
    const deleted = await q.delete({ where: { id: 1 } });

    assert.deepEqual(deleted, { id: 1, name: 'Ada' });
    assert.equal(calls.length, 2);
    // Pre-SELECT happens BEFORE the DELETE (the row is gone afterwards).
    assert.match(calls[0]!.sql, /^SELECT \* FROM `users` WHERE `id` = \?$/);
    assert.match(calls[1]!.sql, /^DELETE FROM `users`/);
  });

  it("'output' create: single statement returns rows directly (no reselect)", async () => {
    const { pool, calls } = mockPool((sql) => (sql.startsWith('INSERT') ? [{ id: 7, name: 'Grace' }] : []));
    const q = reselectQuery(pool, outputDialect);
    const created = await q.create({ data: { id: 7, name: 'Grace' } });

    assert.deepEqual(created, { id: 7, name: 'Grace' });
    assert.equal(calls.length, 1);
    assert.match(calls[0]!.sql, /OUTPUT INSERTED\.\*/);
  });

  it("'reselect' create falls back to the driver insert id when the PK is not supplied", async () => {
    const { pool, calls } = mockPool((sql) => (sql.startsWith('SELECT') ? [{ id: 42, name: 'Hopper' }] : []));
    // Mock INSERT result carries a driver insertId (mysql2-style).
    const wrapped = {
      // biome-ignore lint/suspicious/noExplicitAny: augment the mock to emit an insertId on INSERT
      query: async (textOrConfig: any, values?: unknown[]) => {
        // biome-ignore lint/suspicious/noExplicitAny: delegate to the base mock
        const res: any = await (pool as any).query(textOrConfig, values);
        const sql = typeof textOrConfig === 'string' ? textOrConfig : textOrConfig.text;
        if (sql.startsWith('INSERT')) res.insertId = 42;
        return res;
      },
    };
    const q = reselectQuery(wrapped, reselectDialect);
    const created = await q.create({ data: { name: 'Hopper' } });

    assert.deepEqual(created, { id: 42, name: 'Hopper' });
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[1]!.params, [42]);
  });
});
