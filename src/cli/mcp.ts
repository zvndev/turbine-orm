import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import pg from 'pg';
import { findMissingRelationIndexes } from '../index-advisor.js';
import {
  addAutoManyToManyRelations,
  buildRelationsFromForeignKeys,
  type ForeignKeyEntry,
  isUnknownTsType,
} from '../introspect.js';
import type { FindManyArgs } from '../query/index.js';
import { QueryInterface, quoteIdent } from '../query/index.js';
import {
  type ColumnMetadata,
  type IndexMetadata,
  isDateType,
  pgArrayType,
  pgTypeToTs,
  type RelationDef,
  type SchemaMetadata,
  snakeToCamel,
  type TableMetadata,
} from '../schema.js';
import { listMigrationFiles } from './migrate.js';

/**
 * Walk up from the running script to find turbine-orm's own package.json.
 * Uses process.argv[1] instead of import.meta.url so the same code compiles
 * cleanly for both the ESM and CJS builds (same convention as cli/index.ts).
 */
function readOwnVersion(): string {
  try {
    let entry = process.argv[1] ?? '';
    try {
      entry = realpathSync(entry);
    } catch {
      // keep the raw path if realpath fails
    }
    let dir = dirname(entry);
    for (let i = 0; i < 6; i++) {
      const candidate = resolve(dir, 'package.json');
      if (existsSync(candidate)) {
        const pkg = JSON.parse(readFileSync(candidate, 'utf8')) as { name?: string; version?: string };
        if (pkg.name === 'turbine-orm' && pkg.version) return pkg.version;
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    // fall through
  }
  return '0.0.0';
}

const PROTOCOL_VERSION = '2025-06-18';
const STATEMENT_TIMEOUT = '30s';
const TRACKING_TABLE = '_turbine_migrations';

export interface McpServerOptions {
  url: string;
  schema: string;
  migrationsDir: string;
  include?: string[];
  exclude?: string[];
}

export interface McpTransport {
  input?: Readable;
  output?: Writable;
}

export interface McpServerHandle {
  dispose(): Promise<void>;
}

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: unknown;
}

interface JsonRpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

type JsonObject = Record<string, unknown>;

interface McpContext {
  options: McpServerOptions;
  pool: pg.Pool;
}

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: JsonObject;
}

const TOOLS: ToolDefinition[] = [
  {
    name: 'schema_overview',
    description: 'List tables, columns, relations, indexes, and estimated row counts for the configured schema.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'table_detail',
    description: 'Show columns, indexes, and relations for one table.',
    inputSchema: {
      type: 'object',
      properties: { table: { type: 'string' } },
      required: ['table'],
      additionalProperties: false,
    },
  },
  {
    name: 'migrate_status',
    description: 'Read migration files and the existing migration tracking table without applying migrations.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'doctor_report',
    description: 'Report missing relation indexes using Turbine metadata and the index advisor.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'explain_query',
    description:
      'Run EXPLAIN (FORMAT JSON) for a schema-validated findMany query. Pass table + optional where/orderBy/limit/select — free-form SQL is rejected.',
    inputSchema: {
      type: 'object',
      properties: {
        table: { type: 'string', description: 'Table name (must exist in the introspected schema).' },
        where: {
          type: 'object',
          description: 'findMany-style where clause; field names validated against the schema.',
        },
        orderBy: {
          description: 'findMany-style orderBy (object or array of objects); field names validated against the schema.',
        },
        limit: { type: 'number', minimum: 1, description: 'Optional row limit for the planned query.' },
        select: {
          type: 'object',
          description: 'Optional field selection map (camelCase or column names → true).',
          additionalProperties: { type: 'boolean' },
        },
      },
      required: ['table'],
      additionalProperties: false,
    },
  },
  {
    name: 'sample_rows',
    description: 'Read up to 50 rows from a validated table.',
    inputSchema: {
      type: 'object',
      properties: { table: { type: 'string' }, limit: { type: 'number', minimum: 1, maximum: 50 } },
      required: ['table'],
      additionalProperties: false,
    },
  },
];

export function startMcpServer(options: McpServerOptions, transport: McpTransport = {}): McpServerHandle {
  const input = transport.input ?? process.stdin;
  const output = transport.output ?? process.stdout;
  const ctx: McpContext = {
    options,
    pool: new pg.Pool({ connectionString: options.url, max: 2, idleTimeoutMillis: 10_000 }),
  };

  let buffer = '';
  let disposed = false;

  const write = (payload: unknown) => {
    output.write(`${JSON.stringify(payload)}\n`);
  };

  const onData = (chunk: Buffer | string) => {
    buffer += chunk.toString();
    let newlineIndex = buffer.indexOf('\n');
    while (newlineIndex !== -1) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (line) {
        handleLine(line, ctx, write).catch((err) => {
          write(errorResponse(null, -32603, 'Internal error', errorMessage(err)));
        });
      }
      newlineIndex = buffer.indexOf('\n');
    }
  };

  input.on('data', onData);

  return {
    dispose: async () => {
      if (disposed) return;
      disposed = true;
      input.off('data', onData);
      await ctx.pool.end();
    },
  };
}

async function handleLine(line: string, ctx: McpContext, write: (payload: unknown) => void): Promise<void> {
  let message: unknown;
  try {
    message = JSON.parse(line);
  } catch (err) {
    write(errorResponse(null, -32700, 'Parse error', errorMessage(err)));
    return;
  }

  if (!isJsonRpcRequest(message)) {
    write(errorResponse(null, -32600, 'Invalid Request'));
    return;
  }

  const request = message;
  const isNotification = request.id === undefined;

  try {
    const result = await dispatch(request, ctx);
    if (!isNotification) write({ jsonrpc: '2.0', id: request.id, result });
  } catch (err) {
    if (!isNotification) {
      const rpcError = toJsonRpcError(err);
      write({ jsonrpc: '2.0', id: request.id, error: rpcError });
    }
  }
}

async function dispatch(request: JsonRpcRequest, ctx: McpContext): Promise<unknown> {
  switch (request.method) {
    case 'initialize':
      return {
        protocolVersion: PROTOCOL_VERSION,
        serverInfo: { name: 'turbine-orm', version: readOwnVersion() },
        capabilities: { tools: {} },
      };
    case 'notifications/initialized':
      return null;
    case 'tools/list':
      return { tools: TOOLS };
    case 'tools/call':
      return callTool(request.params, ctx);
    case 'shutdown':
      return null;
    default:
      throw jsonRpcError(-32601, `Method not found: ${request.method}`);
  }
}

async function callTool(params: unknown, ctx: McpContext): Promise<unknown> {
  if (!isObject(params) || typeof params.name !== 'string') {
    throw jsonRpcError(-32602, 'tools/call requires a string tool name');
  }
  const args = isObject(params.arguments) ? params.arguments : {};

  let result: unknown;
  switch (params.name) {
    case 'schema_overview':
      result = await schemaOverview(ctx);
      break;
    case 'table_detail':
      result = await tableDetail(ctx, requiredString(args, 'table'));
      break;
    case 'migrate_status':
      result = await migrationStatus(ctx);
      break;
    case 'doctor_report':
      result = await doctorReport(ctx);
      break;
    case 'explain_query':
      result = await explainQuery(ctx, args);
      break;
    case 'sample_rows':
      result = await sampleRows(ctx, requiredString(args, 'table'), optionalLimit(args.limit));
      break;
    default:
      throw jsonRpcError(-32602, `Unknown tool: ${params.name}`);
  }

  return {
    content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
  };
}

async function schemaOverview(ctx: McpContext): Promise<unknown> {
  return withReadOnly(ctx, async (client) => {
    const metadata = await loadSchemaMetadata(client, ctx.options);
    const rowCounts = await estimateRows(client, ctx.options.schema);
    return {
      schema: ctx.options.schema,
      tables: Object.values(metadata.tables).map((table) => ({
        name: table.name,
        estimatedRows: rowCounts.get(table.name) ?? 0,
        columns: table.columns.length,
        primaryKey: table.primaryKey,
        indexes: table.indexes.length,
        relations: Object.keys(table.relations).length,
      })),
      enums: metadata.enums,
    };
  });
}

async function tableDetail(ctx: McpContext, tableName: string): Promise<unknown> {
  return withReadOnly(ctx, async (client) => {
    const metadata = await loadSchemaMetadata(client, ctx.options);
    const table = requireTable(metadata, tableName);
    return {
      name: table.name,
      primaryKey: table.primaryKey,
      columns: table.columns.map((column) => ({
        name: column.name,
        field: column.field,
        pgType: column.pgType,
        tsType: column.tsType,
        nullable: column.nullable,
        hasDefault: column.hasDefault,
        isGenerated: column.isGenerated ?? false,
        isArray: column.isArray,
        maxLength: column.maxLength,
      })),
      indexes: table.indexes,
      relations: Object.values(table.relations).map((relation) => ({
        name: relation.name,
        type: relation.type,
        from: relation.from,
        to: relation.to,
        foreignKey: relation.foreignKey,
        referenceKey: relation.referenceKey,
        through: relation.through,
      })),
    };
  });
}

async function migrationStatus(ctx: McpContext): Promise<unknown> {
  return withReadOnly(ctx, async (client) => {
    const files = listMigrationFiles(ctx.options.migrationsDir);
    const trackingExists = await client.query<{ exists: boolean }>(
      `SELECT to_regclass($1)::text IS NOT NULL AS exists`,
      [TRACKING_TABLE],
    );

    const applied = new Map<string, { appliedAt: Date; checksum: string }>();
    if (trackingExists.rows[0]?.exists) {
      const result = await client.query<{ name: string; applied_at: Date; checksum: string }>(
        `SELECT name, applied_at, checksum FROM ${quoteIdent(TRACKING_TABLE)} ORDER BY name`,
      );
      for (const row of result.rows) {
        applied.set(row.name, { appliedAt: row.applied_at, checksum: row.checksum });
      }
    }

    const statuses = files.map((file) => {
      const record = applied.get(file.name);
      const checksum = sha256(readFileSync(file.path, 'utf-8'));
      return {
        migration: file.filename,
        applied: !!record,
        appliedAt: record?.appliedAt?.toISOString(),
        checksumValid: record ? checksum === record.checksum : undefined,
      };
    });

    return {
      migrationsDir: ctx.options.migrationsDir,
      trackingTableExists: trackingExists.rows[0]?.exists ?? false,
      applied: statuses.filter((status) => status.applied).length,
      pending: statuses.filter((status) => !status.applied).length,
      drifted: statuses.filter((status) => status.checksumValid === false).length,
      migrations: statuses,
    };
  });
}

async function doctorReport(ctx: McpContext): Promise<unknown> {
  return withReadOnly(ctx, async (client) => {
    const metadata = await loadSchemaMetadata(client, ctx.options);
    const rowCounts = await estimateRows(client, ctx.options.schema);
    const missing = findMissingRelationIndexes(metadata).sort(
      (a, b) => (rowCounts.get(b.table) ?? 0) - (rowCounts.get(a.table) ?? 0),
    );
    return {
      schema: ctx.options.schema,
      ok: missing.length === 0,
      missingRelationIndexes: missing.map((entry) => ({
        table: entry.table,
        estimatedRows: rowCounts.get(entry.table) ?? 0,
        columns: entry.columns,
        probes: entry.probes,
        suggestedIndexName: entry.indexName,
        createSql: entry.createSql,
      })),
    };
  });
}

/**
 * EXPLAIN a schema-validated findMany query. Free-form SQL is never accepted —
 * table/field identifiers are checked against introspected metadata and the
 * SELECT is compiled by QueryInterface (same stance as Studio `/api/builder`).
 */
async function explainQuery(ctx: McpContext, args: JsonObject): Promise<unknown> {
  // Explicit rejection so agents that still send the old `{ sql }` shape get a
  // clear migration error instead of a silent "table is required".
  if ('sql' in args) {
    throw jsonRpcError(
      -32602,
      'explain_query no longer accepts free-form SQL; pass table + findMany-style args (where/orderBy/limit/select)',
    );
  }

  const tableName = requiredString(args, 'table');
  const findManyArgs = parseExplainFindManyArgs(args);

  return withReadOnly(ctx, async (client) => {
    const metadata = await loadSchemaMetadata(client, ctx.options);
    const table = requireTable(metadata, tableName);

    let deferred: ReturnType<QueryInterface<Record<string, unknown>>['buildFindMany']>;
    try {
      // Build-only: pool is unused for SQL generation (mirrors Studio).
      const qi = new QueryInterface<Record<string, unknown>>(ctx.pool, table.name, metadata, [], {
        warnOnUnlimited: false,
        sqlCache: false,
        preparedStatements: false,
      });
      deferred = qi.buildFindMany(findManyArgs);
    } catch (err) {
      // Unknown columns/operators/relations → invalid params, not internal error.
      throw jsonRpcError(-32602, err instanceof Error ? err.message : String(err));
    }

    // QueryInterface emits unqualified identifiers; pin search_path like Studio.
    await client.query(`SELECT set_config('search_path', $1, true)`, [ctx.options.schema]);
    const result = await client.query(`EXPLAIN (FORMAT JSON) ${deferred.sql}`, deferred.params);
    return {
      table: table.name,
      sql: deferred.sql,
      params: deferred.params,
      plan: result.rows[0]?.['QUERY PLAN'] ?? null,
    };
  });
}

/**
 * Extract the allowed findMany subset for explain_query (no `with` / raw SQL).
 * Returns a plain object cast at the buildFindMany call site — same pattern as Studio.
 */
function parseExplainFindManyArgs(args: JsonObject): FindManyArgs<Record<string, unknown>> {
  const findManyArgs: Record<string, unknown> = {};

  if (args.where !== undefined) {
    if (!isObject(args.where)) throw jsonRpcError(-32602, 'where must be an object');
    findManyArgs.where = args.where;
  }

  if (args.orderBy !== undefined) {
    if (typeof args.orderBy !== 'object' || args.orderBy === null) {
      throw jsonRpcError(-32602, 'orderBy must be an object or array of objects');
    }
    findManyArgs.orderBy = args.orderBy;
  }

  if (args.limit !== undefined) {
    if (typeof args.limit !== 'number' || !Number.isInteger(args.limit) || args.limit < 1) {
      throw jsonRpcError(-32602, 'limit must be a positive integer');
    }
    findManyArgs.limit = args.limit;
  }

  if (args.select !== undefined) {
    if (!isObject(args.select)) throw jsonRpcError(-32602, 'select must be an object');
    for (const [key, value] of Object.entries(args.select)) {
      if (typeof value !== 'boolean') {
        throw jsonRpcError(-32602, `select.${key} must be a boolean`);
      }
    }
    findManyArgs.select = args.select;
  }

  return findManyArgs as FindManyArgs<Record<string, unknown>>;
}

async function sampleRows(ctx: McpContext, tableName: string, limit: number): Promise<unknown> {
  return withReadOnly(ctx, async (client) => {
    const metadata = await loadSchemaMetadata(client, ctx.options);
    const table = requireTable(metadata, tableName);
    const qualifiedTable = `${quoteIdent(ctx.options.schema)}.${quoteIdent(table.name)}`;
    const result = await client.query(`SELECT * FROM ${qualifiedTable} LIMIT $1`, [limit]);
    return {
      table: table.name,
      limit,
      columns: result.fields.map((field) => ({ name: field.name, dataTypeID: field.dataTypeID })),
      rows: result.rows,
      rowCount: result.rowCount ?? result.rows.length,
    };
  });
}

async function withReadOnly<T>(ctx: McpContext, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await ctx.pool.connect();
  try {
    await client.query('BEGIN READ ONLY');
    await client.query(`SELECT set_config('statement_timeout', $1, true)`, [STATEMENT_TIMEOUT]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // ignore rollback errors; the original error is more useful.
    }
    throw err;
  } finally {
    client.release();
  }
}

async function loadSchemaMetadata(client: pg.PoolClient, options: McpServerOptions): Promise<SchemaMetadata> {
  const [tablesResult, columnsResult, pkResult, fkResult, uniqueResult, indexResult, enumResult] = await Promise.all([
    client.query<{ table_name: string }>(
      `SELECT table_name
       FROM information_schema.tables
       WHERE table_schema = $1 AND table_type = 'BASE TABLE'
       ORDER BY table_name`,
      [options.schema],
    ),
    client.query<{
      table_name: string;
      column_name: string;
      udt_name: string;
      data_type: string;
      is_nullable: string;
      column_default: string | null;
      is_identity: string;
      character_maximum_length: number | null;
    }>(
      `SELECT table_name, column_name, udt_name, data_type, is_nullable, column_default, is_identity,
              character_maximum_length
       FROM information_schema.columns
       WHERE table_schema = $1
       ORDER BY table_name, ordinal_position`,
      [options.schema],
    ),
    client.query<{ table_name: string; column_name: string }>(
      `SELECT tc.table_name, kcu.column_name
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
       WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = $1
       ORDER BY tc.table_name, kcu.ordinal_position`,
      [options.schema],
    ),
    client.query<{
      source_table: string;
      source_column: string;
      target_table: string;
      target_column: string;
      constraint_name: string;
    }>(
      `SELECT tc.table_name AS source_table, kcu.column_name AS source_column,
              ccu.table_name AS target_table, ccu.column_name AS target_column, tc.constraint_name
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
       JOIN information_schema.constraint_column_usage ccu
         ON tc.constraint_name = ccu.constraint_name AND tc.table_schema = ccu.table_schema
       WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = $1`,
      [options.schema],
    ),
    client.query<{ table_name: string; constraint_name: string; column_name: string }>(
      `SELECT tc.table_name, tc.constraint_name, kcu.column_name
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
       WHERE tc.constraint_type = 'UNIQUE' AND tc.table_schema = $1
       ORDER BY tc.table_name, tc.constraint_name, kcu.ordinal_position`,
      [options.schema],
    ),
    client.query<{ tablename: string; indexname: string; indexdef: string }>(
      `SELECT tablename, indexname, indexdef FROM pg_indexes WHERE schemaname = $1`,
      [options.schema],
    ),
    client.query<{ typname: string; enumlabel: string }>(
      `SELECT t.typname, e.enumlabel
       FROM pg_type t
       JOIN pg_enum e ON t.oid = e.enumtypid
       JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
       WHERE n.nspname = $1
       ORDER BY t.typname, e.enumsortorder`,
      [options.schema],
    ),
  ]);

  let tableNames = tablesResult.rows.map((row) => row.table_name);
  if (options.include?.length) {
    const include = new Set(options.include);
    tableNames = tableNames.filter((table) => include.has(table));
  }
  if (options.exclude?.length) {
    const exclude = new Set(options.exclude);
    tableNames = tableNames.filter((table) => !exclude.has(table));
  }
  const tableSet = new Set(tableNames);

  const columnsByTable = new Map<string, ColumnMetadata[]>();
  for (const row of columnsResult.rows) {
    if (!tableSet.has(row.table_name)) continue;
    const isNullable = row.is_nullable === 'YES';
    const isArray = row.data_type === 'ARRAY';
    const baseType = isArray ? row.udt_name.slice(1) : row.udt_name;
    const column: ColumnMetadata = {
      name: row.column_name,
      field: snakeToCamel(row.column_name),
      dialectType: row.udt_name,
      pgType: row.udt_name,
      tsType: pgTypeToTs(isArray ? row.udt_name : baseType, isNullable),
      nullable: isNullable,
      hasDefault: row.column_default !== null,
      isGenerated:
        (typeof row.column_default === 'string' && row.column_default.includes('nextval(')) ||
        row.is_identity === 'YES',
      isArray,
      arrayType: pgArrayType(baseType),
      pgArrayType: pgArrayType(baseType),
      maxLength: row.character_maximum_length ?? undefined,
    };
    const columns = columnsByTable.get(row.table_name) ?? [];
    columns.push(column);
    columnsByTable.set(row.table_name, columns);
  }

  const pkByTable = new Map<string, string[]>();
  for (const row of pkResult.rows) {
    if (!tableSet.has(row.table_name)) continue;
    const columns = pkByTable.get(row.table_name) ?? [];
    columns.push(row.column_name);
    pkByTable.set(row.table_name, columns);
  }

  const uniqueGroups = new Map<string, { table: string; columns: string[] }>();
  for (const row of uniqueResult.rows) {
    if (!tableSet.has(row.table_name)) continue;
    const key = `${row.table_name}::${row.constraint_name}`;
    const group = uniqueGroups.get(key) ?? { table: row.table_name, columns: [] };
    group.columns.push(row.column_name);
    uniqueGroups.set(key, group);
  }
  const uniqueByTable = new Map<string, string[][]>();
  for (const group of uniqueGroups.values()) {
    const entries = uniqueByTable.get(group.table) ?? [];
    entries.push(group.columns);
    uniqueByTable.set(group.table, entries);
  }

  const indexesByTable = new Map<string, IndexMetadata[]>();
  for (const row of indexResult.rows) {
    if (!tableSet.has(row.tablename)) continue;
    const columns = extractIndexColumns(row.indexdef);
    const indexes = indexesByTable.get(row.tablename) ?? [];
    indexes.push({
      name: row.indexname,
      columns,
      unique: row.indexdef.includes('UNIQUE'),
      definition: row.indexdef,
    });
    indexesByTable.set(row.tablename, indexes);
  }

  const enums: Record<string, string[]> = {};
  for (const row of enumResult.rows) {
    const labels = enums[row.typname] ?? [];
    labels.push(row.enumlabel);
    enums[row.typname] = labels;
  }

  const relationsByTable = buildRelations(tableNames, columnsByTable, pkByTable, fkResult.rows, enums);
  const tables: Record<string, TableMetadata> = {};
  for (const tableName of tableNames) {
    const columns = columnsByTable.get(tableName) ?? [];
    const columnMap: Record<string, string> = {};
    const reverseColumnMap: Record<string, string> = {};
    const dateColumns = new Set<string>();
    const dialectTypes: Record<string, string> = {};
    const pgTypes: Record<string, string> = {};
    const allColumns: string[] = [];

    for (const column of columns) {
      columnMap[column.field] = column.name;
      reverseColumnMap[column.name] = column.field;
      allColumns.push(column.name);
      dialectTypes[column.name] = column.dialectType ?? column.pgType;
      pgTypes[column.name] = column.pgType;
      const baseType = column.isArray
        ? (column.dialectType ?? column.pgType).slice(1)
        : (column.dialectType ?? column.pgType);
      if (isDateType(baseType)) dateColumns.add(column.name);
    }

    tables[tableName] = {
      name: tableName,
      columns,
      columnMap,
      reverseColumnMap,
      dateColumns,
      dialectTypes,
      pgTypes,
      allColumns,
      primaryKey: pkByTable.get(tableName) ?? [],
      uniqueColumns: uniqueByTable.get(tableName) ?? [],
      relations: relationsByTable.get(tableName) ?? {},
      indexes: indexesByTable.get(tableName) ?? [],
    };
  }

  return { tables, enums };
}

interface ForeignKeyRow {
  source_table: string;
  source_column: string;
  target_table: string;
  target_column: string;
  constraint_name: string;
}

/**
 * Group raw FK rows into constraint-level entries and delegate relation
 * naming to the SHARED introspection builder (`buildRelationsFromForeignKeys`
 * + `addAutoManyToManyRelations` in ../introspect.ts). MCP previously carried
 * a stale copy of a retired naming scheme, so `turbine mcp` and `turbine
 * generate` derived DIFFERENT relation names from the same database (N-3).
 * Exported for the parity unit test.
 */
export function buildRelations(
  tableNames: string[],
  columnsByTable: Map<string, ColumnMetadata[]>,
  pkByTable: Map<string, string[]>,
  rows: ForeignKeyRow[],
  enums: Record<string, string[]> = {},
): Map<string, Record<string, RelationDef>> {
  const tableSet = new Set(tableNames);
  const groups = new Map<string, ForeignKeyEntry>();
  for (const row of rows) {
    if (!tableSet.has(row.source_table) || !tableSet.has(row.target_table)) continue;
    const group = groups.get(row.constraint_name) ?? {
      sourceTable: row.source_table,
      sourceColumns: [],
      targetTable: row.target_table,
      targetColumns: [],
      constraintName: row.constraint_name,
    };
    group.sourceColumns.push(row.source_column);
    group.targetColumns.push(row.target_column);
    groups.set(row.constraint_name, group);
  }
  const foreignKeys = [...groups.values()];

  const columnFieldsByTable = new Map<string, Set<string>>();
  const unknownTypedFieldsByTable = new Map<string, Set<string>>();
  for (const [tbl, cols] of columnsByTable) {
    columnFieldsByTable.set(tbl, new Set(cols.map((c) => c.field)));
    // Enum-typed columns also report tsType 'unknown', but the generated type
    // layer gives them a concrete union — only json/jsonb qualify as shadows.
    unknownTypedFieldsByTable.set(
      tbl,
      new Set(cols.filter((c) => isUnknownTsType(c.tsType) && !Object.hasOwn(enums, c.pgType)).map((c) => c.field)),
    );
  }

  const relations = buildRelationsFromForeignKeys(
    foreignKeys,
    columnFieldsByTable,
    undefined,
    unknownTypedFieldsByTable,
  );
  addAutoManyToManyRelations(
    tableNames,
    foreignKeys,
    pkByTable,
    new Map(Array.from(columnsByTable, ([tbl, cols]) => [tbl, cols.map((c) => c.name)])),
    relations,
    columnFieldsByTable,
    unknownTypedFieldsByTable,
  );
  return relations;
}

async function estimateRows(client: pg.PoolClient, schema: string): Promise<Map<string, number>> {
  const result = await client.query<{ relname: string; reltuples: string }>(
    `SELECT c.relname, c.reltuples::bigint::text AS reltuples
     FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = $1 AND c.relkind = 'r'`,
    [schema],
  );
  const counts = new Map<string, number>();
  for (const row of result.rows) counts.set(row.relname, Math.max(0, Number(row.reltuples)));
  return counts;
}

function requireTable(metadata: SchemaMetadata, tableName: string): TableMetadata {
  const table = metadata.tables[tableName];
  if (!table) {
    const available = Object.keys(metadata.tables).join(', ') || '(none)';
    throw jsonRpcError(-32602, `Unknown table "${tableName}". Available: ${available}`);
  }
  return table;
}

function extractIndexColumns(indexdef: string): string[] {
  const match = indexdef.match(/\((.+)\)/);
  if (!match) return [];
  return match[1]!.split(',').map((column) =>
    column
      .trim()
      .replace(/ (ASC|DESC)$/i, '')
      .replace(/^"|"$/g, ''),
  );
}

function optionalLimit(value: unknown): number {
  if (value === undefined) return 50;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 50) {
    throw jsonRpcError(-32602, 'limit must be an integer between 1 and 50');
  }
  return value;
}

function requiredString(args: JsonObject, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw jsonRpcError(-32602, `${key} is required`);
  }
  return value;
}

function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf-8').digest('hex');
}

function isJsonRpcRequest(value: unknown): value is JsonRpcRequest {
  return isObject(value) && value.jsonrpc === '2.0' && typeof value.method === 'string';
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function jsonRpcError(code: number, message: string, data?: unknown): Error & { rpcError: JsonRpcErrorObject } {
  const err = new Error(message) as Error & { rpcError: JsonRpcErrorObject };
  err.rpcError = data === undefined ? { code, message } : { code, message, data };
  return err;
}

function toJsonRpcError(err: unknown): JsonRpcErrorObject {
  if (err instanceof Error && 'rpcError' in err) {
    return (err as Error & { rpcError: JsonRpcErrorObject }).rpcError;
  }
  return { code: -32603, message: 'Internal error', data: errorMessage(err) };
}

function errorResponse(id: string | number | null, code: number, message: string, data?: unknown): unknown {
  return { jsonrpc: '2.0', id, error: data === undefined ? { code, message } : { code, message, data } };
}

export async function runMcpServer(options: McpServerOptions): Promise<void> {
  const handle = startMcpServer(options);
  await new Promise<void>((resolve) => {
    const shutdown = async () => {
      await handle.dispose();
      resolve();
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
    process.stdin.once('end', shutdown);
  });
}
