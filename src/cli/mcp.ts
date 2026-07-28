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
import { registerUtcTemporalParsers } from '../query/utils.js';
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
import { applyPiiTags, loadPiiTags } from './pii-tags.js';
import { redactUrl } from './ui.js';

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
  /**
   * Directory holding generated Turbine metadata (`turbine generate`'s `out`).
   * PII tags are code-first declarations that introspection never sets, so
   * without this the server has nothing to redact against. Read as text;
   * nothing from it is executed. See `pii-tags.ts`.
   */
  metadataDir?: string;
}

export interface McpTransport {
  input?: Readable;
  output?: Writable;
  /**
   * Pre-built pool, used ONLY by the perimeter tests so they can drive the real
   * JSON-RPC line handler and the real tool handlers with no database (the same
   * reason Studio exports `handleRequest`). Production never sets it: the
   * server builds its own pool from `options.url`.
   */
  pool?: pg.Pool;
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

/**
 * Marker written in place of a hidden cell. Never `null` and never the value,
 * so the agent can tell "hidden" from "empty" (same string Studio uses).
 */
const REDACTED = '•• redacted ••';

/**
 * Column names treated as secret on NAME ALONE, on top of the code-first `pii`
 * tags. Applies to BOTH value-bearing paths: `sample_rows` never fetches such a
 * column, and `explain_query` refuses to filter or sort on one.
 *
 * `introspect.ts` deliberately never GUESSES that a column holds personal data,
 * because a wrong guess there would write a durable tag into metadata. This
 * list is the opposite trade and is why the rule differs: it never touches
 * metadata, it only decides whether the raw value can reach an LLM context
 * window. Over-redacting a column called `password_hash` costs an agent one
 * uninteresting sample value; under-redacting it hands out a credential.
 *
 * It covers the two paths TOGETHER on purpose. Hiding the bytes in one tool
 * while letting the other walk them out of the planner's row estimate is not a
 * weaker perimeter, it is no perimeter: the oracle path is the cheaper of the
 * two, since it needs no read privilege on the row and returns an answer per
 * guessed character. Both tools report exactly what they refused, so neither
 * redaction is silent.
 */
/**
 * Column names that look like they hold a credential.
 *
 * Anchored to IDENTIFIER SEGMENT boundaries (start, end, or an underscore), not
 * a bare substring. Unanchored, `secret` matched `secretary_id` and `token`
 * matched a perfectly ordinary `token_count`, so the guard refused legitimate
 * queries: a false refusal is not free here, it degrades the tool and trains
 * people to route around it.
 *
 * Deliberately still conservative in the other direction. A column whose name
 * genuinely carries a segment like `token` or `secret` is refused even when it
 * holds nothing sensitive, because this gate decides whether raw bytes, or a
 * row-count oracle over them, reach an LLM context. Renaming the column is a
 * cheaper fix than the disclosure it prevents.
 */
const SECRET_WORDS = [
  'passwd',
  'password',
  'secret',
  'token',
  'apikey',
  'api_key',
  'privatekey',
  'private_key',
  'credential',
  'credentials',
  'sessionid',
  'session_id',
  'otp',
  'mfa',
  'totp',
];
const SECRET_NAME_PATTERN = new RegExp(`(^|_)(${SECRET_WORDS.join('|')})(_|$)`, 'i');

/**
 * What the PII tag load produced, carried alongside the introspected metadata.
 *
 * `tags-unreadable` is the state this whole type exists for: a generated
 * metadata file WAS found and could not be understood. Before, that returned an
 * empty tag map, which is byte-identical to "this schema tags nothing", so the
 * server reported `redactedColumns: []` and shipped every tagged column in
 * clear. Anything reading this must fail CLOSED on `tags-unreadable`.
 */
type PiiTagStatus =
  | { state: 'not-configured' }
  | { state: 'no-metadata-file'; dir: string }
  | { state: 'tags-unreadable'; path: string; reason: string }
  | { state: 'ok'; path: string; taggedColumns: number };

interface LoadedSchema {
  metadata: SchemaMetadata;
  piiTags: PiiTagStatus;
}

/** True when tags could not be read, so nothing may be assumed to be non-PII. */
function tagsUnreadable(status: PiiTagStatus): status is Extract<PiiTagStatus, { state: 'tags-unreadable' }> {
  return status.state === 'tags-unreadable';
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
      'Run EXPLAIN (FORMAT JSON) for a schema-validated findMany query. Pass table + optional where/orderBy/limit/select, free-form SQL is rejected. A where or orderBy on a PII-tagged or secret-named column is refused: the planner row estimate would leak the value. Naming such a column in select is allowed, since EXPLAIN returns no rows.',
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
    description:
      'Read up to 50 rows from a validated table. PII-tagged and secret-named columns are never fetched; the reply lists exactly what was hidden and where the PII tags came from.',
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
  // Read zone-less `date` / `timestamp` values as UTC, as TurbineClient does on
  // a pool it owns. This server builds its own raw pool, so without it a
  // `date` sampled here is serialized at the CLI process's local midnight while
  // the application reading the same row through Turbine sees UTC midnight.
  registerUtcTemporalParsers();
  const ctx: McpContext = {
    options,
    pool: transport.pool ?? new pg.Pool({ connectionString: options.url, max: 2, idleTimeoutMillis: 10_000 }),
  };

  // An idle pooled connection that dies (server restart, proxy idle timeout)
  // emits 'error' on the POOL, which has no default listener: unhandled, it
  // takes the whole CLI process down mid-session, and the agent sees the stdio
  // transport vanish with no message. Log to stderr, never stdout: stdout is
  // the JSON-RPC framing channel and one stray line desynchronizes the client.
  // The message is redacted because pg echoes the connection string into some
  // connection failures, and this text is written where a user can see it.
  ctx.pool.on('error', (err: Error) => {
    process.stderr.write(`[turbine] mcp pool error: ${redactUrl(err.message)}\n`);
  });

  announcePiiTags(options);

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

/**
 * Say, once at startup, what the redaction is actually running on.
 *
 * `turbine studio` prints its tag count and source path; this server printed
 * nothing at all, so an operator had no way to notice that the tags they
 * declared were not in force. Everything goes to STDERR, never stdout: stdout
 * carries the JSON-RPC framing and one stray line desynchronizes the client.
 */
function announcePiiTags(options: McpServerOptions): void {
  if (!options.metadataDir) {
    process.stderr.write(
      '[turbine] mcp: no metadata directory configured, so code-first PII tags are not loaded and ' +
        'sample_rows redacts only on column name.\n',
    );
    return;
  }
  const source = loadPiiTags(options.metadataDir);
  if (!source) {
    process.stderr.write(
      `[turbine] mcp: no generated metadata found in ${options.metadataDir}, so code-first PII tags are not ` +
        'loaded. Run `turbine generate` if your schema tags PII columns.\n',
    );
    return;
  }
  if (!source.scan.ok) {
    // Loud, because this is the state that used to look like success.
    process.stderr.write(
      `[turbine] mcp WARNING: ${source.path} exists but its PII tags could not be read (${source.scan.reason}). ` +
        'Failing closed: sample_rows will redact EVERY column and explain_query will refuse where/orderBy. ' +
        'Re-run `turbine generate` to fix this.\n',
    );
    return;
  }
  process.stderr.write(`[turbine] mcp: ${source.count} PII-tagged column(s) loaded from ${source.path}\n`);
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
    const { metadata } = await loadSchemaMetadata(client, ctx.options);
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
    const { metadata } = await loadSchemaMetadata(client, ctx.options);
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
      indexes: table.indexes.map(sanitizeIndex),
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

/**
 * Index of the predicate-introducing ` WHERE `, ignoring any that sits INSIDE a
 * single-quoted string literal.
 *
 * A plain `indexOf(' WHERE ')` matches the first occurrence anywhere, so an
 * expression index whose key list embeds the text (`((email || ' WHERE '))`)
 * gets cut mid-literal. The head then no longer contains a balanced quote, the
 * literal check on it reads clean, and the literal ships. That is the exact
 * failure this function exists to prevent, arriving through the parser rather
 * than through the branch.
 *
 * Postgres escapes an embedded quote by doubling it, and a doubled quote toggles
 * the flag twice, so it needs no special case.
 */
function predicateStart(definition: string): number {
  let inLiteral = false;
  for (let i = 0; i < definition.length; i++) {
    if (definition[i] === "'") {
      inLiteral = !inLiteral;
      continue;
    }
    if (!inLiteral && definition.startsWith(' WHERE ', i)) return i;
  }
  return -1;
}

/**
 * Strip literal values out of an index definition before returning it.
 *
 * `pg_indexes.indexdef` is raw DDL, and a PARTIAL index carries its predicate
 * verbatim: `CREATE INDEX ... WHERE (email = 'ceo@example.com')` puts a real
 * stored value in the reply, and an expression index can do the same inside the
 * key list. Column names are already public in this tool's own output, so the
 * useful part is kept and only the value-bearing tail is dropped. The predicate
 * is reported as PRESENT, so the shape of the index is still legible.
 */
function sanitizeIndex(index: IndexMetadata): Record<string, unknown> {
  const definition = index.definition ?? '';
  // pg renders the predicate as a trailing ` WHERE ...` on one line, so the tail
  // from the keyword onwards is the whole predicate. Matched case-sensitively
  // and OUTSIDE string literals (see predicateStart): pg normalizes the keyword
  // to upper case, so a lower-case `where` in a quoted identifier cannot trigger
  // it, and an upper-case one inside a literal no longer can either.
  const whereAt = predicateStart(definition);
  const partial = whereAt !== -1;
  // Everything before the predicate, which is where the KEY LIST lives. Checked
  // for both index shapes: an expression index can embed a literal
  // (`lower(email || 'x')`), and it can be partial at the same time, in which
  // case dropping only the predicate still ships the literal in the key list.
  // The key-list check used to sit in the non-partial branch alone, so exactly
  // the combination this function was written for went out verbatim.
  // Double quotes are NOT a trigger: those delimit an identifier, and
  // identifiers are already returned in `columns`.
  const head = partial ? definition.slice(0, whereAt) : definition;
  const keys = keyList(head);
  const keysHoldLiteral = keys === null || /[(']/.test(keys);
  // `columns` is not a safe passthrough for an expression index: it is the key
  // list split on commas, so for `((email || 'ceo@example.com'))` the "column"
  // IS the literal. Only entries that are a bare identifier survive, and only
  // on the expression path, so an ordinary index (including one with a quoted
  // identifier holding a space) is untouched.
  const columns = keysHoldLiteral ? index.columns.filter((column) => PLAIN_IDENTIFIER.test(column)) : index.columns;
  return {
    name: index.name,
    columns,
    columnsWithheld: columns.length !== index.columns.length,
    unique: index.unique,
    partial,
    // Withholding is LABELLED, never expressed by dropping the field:
    // `JSON.stringify` omits an `undefined` value, so the agent would see an
    // index with no definition and no reason, which reads identically to an
    // index whose definition was never collected. Every other withholding in
    // this file names itself, and so does this one.
    definitionWithheld: keysHoldLiteral,
    definition: keysHoldLiteral
      ? keys === null
        ? '(definition withheld: the index definition could not be parsed, so it cannot be shown to hold no literal values)'
        : '(definition withheld: the index key list is an expression that may embed literal values)'
      : partial
        ? `${head} WHERE (predicate withheld)`
        : definition,
  };
}

/** A key-list entry that is a bare column name, so it can hold no literal. */
const PLAIN_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_$]*$/;

/**
 * The parenthesized key list of an index definition, or `null` when the
 * definition does not parse as one.
 *
 * `null` is not the same answer as an empty key list, and the caller must not
 * collapse them. This used to return `''`, which scanned clean for literals and
 * shipped the whole definition verbatim: the ONE input this function cannot
 * read is the one it waved through. Unparsable now means WITHHELD.
 */
function keyList(definition: string): string | null {
  const open = definition.indexOf('(');
  const close = definition.lastIndexOf(')');
  return open === -1 || close <= open ? null : definition.slice(open + 1, close);
}

async function migrationStatus(ctx: McpContext): Promise<unknown> {
  return withReadOnly(ctx, async (client) => {
    const files = listMigrationFiles(ctx.options.migrationsDir);
    // DELIBERATELY UNPINNED, unlike every other tool here.
    //
    // This tool's whole job is to report what `turbine migrate status` would
    // report, and the runner in cli/migrate.ts names `_turbine_migrations`
    // unqualified with no search_path of its own, so the tracking table lives
    // wherever the connecting role's search_path put it, which is frequently
    // `public` even for a project whose data schema is something else. Pinning
    // `search_path` to `--schema` here does not harden that, it ANSWERS A
    // DIFFERENT QUESTION: `turbine migrate status` would say "applied" while
    // `migrate_status` said the tracking table did not exist. Between agreeing
    // with the migration runner and imposing a rule the runner does not follow,
    // agreeing is the only one that can be right.
    //
    // The resolution is DISCLOSED instead: the reply names the schema the
    // tracking table actually resolved in, plus a note when that is not the
    // configured schema, so the divergence is visible rather than silently
    // decided either way. (`explain_query` and `sample_rows` still pin, because
    // they read the schema's own tables, not the runner's bookkeeping.)
    const trackingExists = await client.query<{ exists: boolean; table_schema: string | null }>(
      `SELECT reg.oid IS NOT NULL AS exists, n.nspname AS table_schema
       FROM (SELECT to_regclass($1) AS oid) reg
       LEFT JOIN pg_class c ON c.oid = reg.oid
       LEFT JOIN pg_namespace n ON n.oid = c.relnamespace`,
      [TRACKING_TABLE],
    );
    const trackingSchema = trackingExists.rows[0]?.table_schema ?? null;

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
      trackingTableSchema: trackingSchema,
      trackingTableNote:
        trackingSchema !== null && trackingSchema !== ctx.options.schema
          ? `Migrations are tracked in "${trackingSchema}", not the configured schema "${ctx.options.schema}". ` +
            `This is what \`turbine migrate status\` reads too: the runner resolves the tracking table through ` +
            `the connection's search_path rather than the --schema flag.`
          : undefined,
      applied: statuses.filter((status) => status.applied).length,
      pending: statuses.filter((status) => !status.applied).length,
      drifted: statuses.filter((status) => status.checksumValid === false).length,
      migrations: statuses,
    };
  });
}

async function doctorReport(ctx: McpContext): Promise<unknown> {
  return withReadOnly(ctx, async (client) => {
    const { metadata } = await loadSchemaMetadata(client, ctx.options);
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
 * EXPLAIN a schema-validated findMany query. Free-form SQL is never accepted -
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
    const { metadata, piiTags } = await loadSchemaMetadata(client, ctx.options);
    const table = requireTable(metadata, tableName);

    assertNoPiiPredicates(findManyArgs as Record<string, unknown>, table, metadata, piiTags);

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

/** Relation-filter wrappers whose body is a clause against the relation's target. */
const RELATION_FILTER_WRAPPERS = ['some', 'none', 'every', 'is', 'isNot'] as const;

/**
 * Recursion bound for the PII guard walk. Reaching it REFUSES the request, it
 * is not a quiet stop: returning at the cap would mean a payload padded with
 * enough nested `NOT` wrappers walks the guard off the end of its own recursion
 * and then hands the untouched predicate to the builder. Sits far above the
 * builder's own depth-10 relation cap, so nothing buildable is refused for
 * depth alone.
 */
const PII_GUARD_MAX_DEPTH = 32;

/**
 * Refuse an `explain_query` that filters or sorts on a hidden column: one that
 * is PII-tagged, or one whose NAME matches {@link SECRET_NAME_PATTERN}.
 *
 * The name half is not a second-best approximation of the tag half, it is the
 * same rule `sample_rows` applies, applied to the other value-bearing path.
 * Refusing to fetch `api_key` while planning `apiKey startsWith 'sk-a'` leaves
 * the value extractable through a cheaper channel than the one that was closed.
 *
 * WHY REFUSE THE PREDICATE RATHER THAN SUPPRESS THE ESTIMATES. `EXPLAIN` on a
 * PII predicate is a character-by-character extraction oracle: `startsWith: 'a'`
 * plans 412 rows, `'aa'` plans 3, and the caller here is an LLM acting on
 * attacker-influenceable input, with no execution and no rate limit to slow the
 * walk down. Suppression was the other option and is strictly weaker: the row
 * estimate is not one field to delete but the thing the whole plan is built out
 * of, and it is recoverable from `Total Cost`, from `Plan Width` x rows, from
 * the join order, and from whether the planner picked an index at all. Deleting
 * all of that leaves a tool with nothing to report, so the narrower loss is to
 * refuse the predicate. It matches the rule the rest of the codebase already
 * states: predicates on PII are allowed IN THE ORM because they return no
 * value, and that reasoning stops holding the moment the query's SELECTIVITY is
 * itself the reply. Studio drew the same line for the same reason
 * (`assertNoPiiPredicates`, and its `filters` param refuses even `isNull`,
 * because null-ness is an oracle too).
 *
 * `select` is NOT refused: explain returns no rows, and naming a column reveals
 * nothing about its contents.
 *
 * FAILS CLOSED when the tag scan failed: with no trustworthy tag list, no
 * column can be shown to be safe, so every where/orderBy is refused rather than
 * assumed harmless.
 */
function assertNoPiiPredicates(
  args: Record<string, unknown>,
  table: TableMetadata,
  metadata: SchemaMetadata,
  piiTags: PiiTagStatus,
): void {
  const hasPredicate = args.where !== undefined || args.orderBy !== undefined;
  if (tagsUnreadable(piiTags) && hasPredicate) {
    throw jsonRpcError(
      -32602,
      `PII tags could not be read from ${piiTags.path} (${piiTags.reason}), so explain_query cannot prove this ` +
        `query does not filter or sort on a PII column, and row estimates on such a column are an extraction ` +
        `oracle. Re-run \`turbine generate\`, or call explain_query without where/orderBy.`,
    );
  }

  const assertWithinDepth = (depth: number): void => {
    if (depth <= PII_GUARD_MAX_DEPTH) return;
    throw jsonRpcError(
      -32602,
      `Query is nested more than ${PII_GUARD_MAX_DEPTH} levels deep, past the point where the PII guard can ` +
        `prove it does not filter or sort on a tagged column, so it is refused. Flatten the query.`,
    );
  };

  const refuse = (owner: TableMetadata, column: string, why: string): never => {
    throw jsonRpcError(
      -32602,
      `Column "${column}" on "${owner.name}" ${why}, so it cannot be used in a where or orderBy here: ` +
        `EXPLAIN reports the planner's row estimate, and the estimate for a predicate on a hidden value ` +
        `reveals that value one character at a time. Filter on a visible column instead.`,
    );
  };

  /**
   * Why this column may not appear in a predicate, or null when it may.
   *
   * The two reasons are the two `sample_rows` already refuses to FETCH
   * (`classifyHiddenColumns`), and they are deliberately the same set: a column
   * whose bytes are too sensitive to sample is too sensitive to binary-search
   * out of the planner. A column absent from the table is not judged here, the
   * builder rejects it by name a moment later.
   */
  const hiddenReason = (owner: TableMetadata, column: string): string | null => {
    if (owner.columns.some((col) => col.name === column && col.pii === true)) return 'is PII-tagged';
    if (SECRET_NAME_PATTERN.test(column)) return 'has a secret-looking name';
    return null;
  };

  const visitClause = (node: unknown, owner: TableMetadata | undefined, depth: number): void => {
    assertWithinDepth(depth);
    if (!owner || node === null || typeof node !== 'object') return;
    // `orderBy` accepts an array of single-key objects, and so does a `NOT`
    // list. Element order carries no nesting, so the depth is unchanged.
    if (Array.isArray(node)) {
      for (const item of node) visitClause(item, owner, depth);
      return;
    }
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (key === 'AND' || key === 'OR' || key === 'NOT') {
        visitClause(value, owner, depth + 1);
        continue;
      }
      const relation = Object.hasOwn(owner.relations, key) ? owner.relations[key] : undefined;
      if (relation) {
        visitRelationValue(value, metadata.tables[relation.to], depth + 1);
        continue;
      }
      // A predicate may name a column by its camelCase field OR by its real
      // column name; both compile to the same SQL, so both have to be checked.
      const column = Object.hasOwn(owner.columnMap, key) ? owner.columnMap[key]! : key;
      const why = hiddenReason(owner, column);
      if (why) refuse(owner, column, why);
    }
  };

  /**
   * A relation predicate arrives either bare (`{ user: { email: {...} } }`) or
   * wrapped in a cardinality operator (`{ user: { is: { email: {...} } } }`),
   * and BOTH resolve against the relation's target. Walking the wrapper as if
   * `is` were a column of the target would skip the inner clause entirely, so
   * descend into every wrapper member AND into the node itself.
   */
  const visitRelationValue = (value: unknown, target: TableMetadata | undefined, depth: number): void => {
    assertWithinDepth(depth);
    if (!target || value === null || typeof value !== 'object') return;
    const node = value as Record<string, unknown>;
    for (const wrapper of RELATION_FILTER_WRAPPERS) {
      if (Object.hasOwn(node, wrapper)) visitClause(node[wrapper], target, depth + 1);
    }
    visitClause(node, target, depth);
  };

  visitClause(args.where, table, 0);
  visitClause(args.orderBy, table, 0);
}

/**
 * Extract the allowed findMany subset for explain_query (no `with` / raw SQL).
 * Returns a plain object cast at the buildFindMany call site, same pattern as Studio.
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

/**
 * Decide which of a table's columns must not leave the process, and why.
 *
 * Three independent reasons, all reported so nothing is hidden silently:
 * `pii` (a code-first tag), `secret-name` (the name-only denylist above), and
 * `tags-unreadable` (a generated metadata file exists and did not parse, so no
 * column can be shown to be untagged and EVERY column is hidden). That last one
 * is the fail-closed branch: the old code returned `redactedColumns: []` in
 * exactly that situation, which reads identically to "this table has no PII".
 */
function classifyHiddenColumns(
  table: TableMetadata,
  piiTags: PiiTagStatus,
): { hidden: Set<string>; reasons: Record<string, string> } {
  const hidden = new Set<string>();
  const reasons: Record<string, string> = {};
  const unreadable = tagsUnreadable(piiTags);
  for (const col of table.columns) {
    const reason = unreadable
      ? 'tags-unreadable'
      : col.pii === true
        ? 'pii'
        : SECRET_NAME_PATTERN.test(col.name)
          ? 'secret-name'
          : null;
    if (reason) {
      hidden.add(col.name);
      reasons[col.name] = reason;
    }
  }
  return { hidden, reasons };
}

async function sampleRows(ctx: McpContext, tableName: string, limit: number): Promise<unknown> {
  return withReadOnly(ctx, async (client) => {
    const { metadata, piiTags } = await loadSchemaMetadata(client, ctx.options);
    const table = requireTable(metadata, tableName);
    const qualifiedTable = `${quoteIdent(ctx.options.schema)}.${quoteIdent(table.name)}`;

    // Sample rows go straight into an LLM context, so hidden values are never
    // FETCHED, not merely masked after the fact. `SELECT *` used to pull every
    // column into this process and mask on the way out, which meant one missed
    // branch anywhere downstream (an error path echoing the row, a future
    // serializer) leaked the real bytes. Projecting at the SQL level is the same
    // stance `writeReturningColumns` takes for write returns.
    const { hidden, reasons } = classifyHiddenColumns(table, piiTags);
    const visible = table.columns.filter((col) => !hidden.has(col.name));
    // Every column hidden: still report the row count, without selecting data.
    const selectList = visible.length > 0 ? visible.map((col) => quoteIdent(col.name)).join(', ') : '1 AS "_"';
    const result = await client.query(`SELECT ${selectList} FROM ${qualifiedTable} LIMIT $1`, [limit]);

    // Rebuild each row in the table's own column order, so a hidden column is
    // visibly present-and-withheld rather than absent (an absent key reads like
    // "no such column" to the agent, which is a different and wrong claim).
    const rows = result.rows.map((row) => {
      const out: Record<string, unknown> = {};
      for (const col of table.columns) {
        out[col.name] = hidden.has(col.name) ? REDACTED : (row as Record<string, unknown>)[col.name];
      }
      return out;
    });

    return {
      table: table.name,
      limit,
      redactedColumns: [...hidden],
      redactionReasons: reasons,
      // Explicit so `redactedColumns: []` can never be read as "checked, and
      // this table holds no PII" when the truth is "nothing was ever checked".
      piiTagSource: piiTags,
      columns: table.columns.map((col) => ({ name: col.name, pgType: col.pgType, redacted: hidden.has(col.name) })),
      rows,
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

async function loadSchemaMetadata(client: pg.PoolClient, options: McpServerOptions): Promise<LoadedSchema> {
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

  const metadata: SchemaMetadata = { tables, enums };
  // Code-first PII tags, layered onto the live catalog. Without this the
  // redaction below has nothing to act on (introspection never infers a tag).
  //
  // The OUTCOME is returned, not discarded. The three no-tag outcomes are not
  // interchangeable: "the user never generated metadata" is a normal state,
  // while "a metadata file is sitting right there and did not parse" means the
  // user believes tags are in force while nothing is being hidden. Callers fail
  // closed on the latter (`tagsUnreadable`).
  let piiTags: PiiTagStatus = { state: 'not-configured' };
  if (options.metadataDir) {
    const source = loadPiiTags(options.metadataDir);
    if (!source) {
      piiTags = { state: 'no-metadata-file', dir: options.metadataDir };
    } else if (!source.scan.ok) {
      piiTags = { state: 'tags-unreadable', path: source.path, reason: source.scan.reason ?? 'unrecognized shape' };
    } else {
      piiTags = { state: 'ok', path: source.path, taggedColumns: applyPiiTags(metadata, source.tags) };
    }
  }
  return { metadata, piiTags };
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
 * generate` derived DIFFERENT relation names from the same database.
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
    // layer gives them a concrete union, only json/jsonb qualify as shadows.
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

/**
 * Error text for a JSON-RPC payload. Redacted because a connection failure from
 * pg quotes the connection string back verbatim, and every byte returned here
 * lands in an LLM context the operator does not control. The rest of the CLI
 * already runs its printed errors through `redactUrl`; this path did not.
 */
function errorMessage(err: unknown): string {
  return redactUrl(err instanceof Error ? err.message : String(err));
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
