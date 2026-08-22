/**
 * MCP server: the agent-facing graph / stats / error tools.
 *
 * `relation_graph`, `find_join_path`, `table_stats` and `explain_error` exist to
 * answer the four questions an agent pointed at an unfamiliar Turbine schema
 * otherwise burns a whole context window on: what relations exist and what are
 * they CALLED, how do I get from this table to that one, how big is this table,
 * and what does this error code mean. Three of them read the catalog; the fourth
 * reads nothing at all.
 *
 * These drive the REAL JSON-RPC line handler over a mock pg.Pool, the same way
 * mcp-pii.test.ts and studio-write.test.ts do: real dispatch, real metadata
 * load, real relation derivation, real PII tag scan, real SQL. Nothing here
 * needs a database.
 *
 * The invariant every one of them is pinned against: READ-ONLY and
 * PII-REDACTED. A tool that emits a mutation, or that hands out a hidden
 * column's value, does not ship. The last two describes test exactly that.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, it } from 'node:test';
import type pg from 'pg';
import { buildRelations, type McpServerOptions, shortestJoinPaths, startMcpServer } from '../cli/mcp.js';
import { TurbineError, TurbineErrorCode } from '../errors.js';
import { generateMetadata } from '../generate.js';
import type { FindManyArgs } from '../query/index.js';
import { type ColumnMetadata, type SchemaMetadata, snakeToCamel, type TableMetadata } from '../schema.js';
import { makeQuery, mockTable } from './helpers.js';

// ---------------------------------------------------------------------------
// Catalog fixture
//
// One schema exercising every shape the graph tools have to get right:
//   comments -> posts -> users -> orgs        a 3-hop chain
//   posts -> users TWICE (author_id/editor_id) two equal-length paths
//   posts <-> tags through post_tags          an auto-derived many-to-many
//   users.manager_id -> users                 a self-relation
//   users.session_id -> sessions              a SECRET-NAMED join key
//   audit_log                                 reachable from nothing
// ---------------------------------------------------------------------------

interface Recorded {
  sql: string;
  params?: unknown[];
}

interface ColumnRow {
  table_name: string;
  column_name: string;
  udt_name: string;
  data_type: string;
  is_nullable: string;
  column_default: string | null;
  is_identity: string;
  character_maximum_length: number | null;
}

function col(table: string, name: string, udt = 'int4'): ColumnRow {
  return {
    table_name: table,
    column_name: name,
    udt_name: udt,
    data_type: udt === 'int4' ? 'integer' : 'text',
    is_nullable: 'YES',
    column_default: null,
    is_identity: 'NO',
    character_maximum_length: null,
  };
}

const TABLE_NAMES = ['audit_log', 'comments', 'orgs', 'post_tags', 'posts', 'sessions', 'tags', 'users'];

const COLUMNS: ColumnRow[] = [
  col('orgs', 'id'),
  col('orgs', 'name', 'text'),
  col('users', 'id'),
  col('users', 'org_id'),
  col('users', 'manager_id'),
  col('users', 'session_id'),
  col('users', 'email', 'text'),
  col('users', 'name', 'text'),
  col('posts', 'id'),
  col('posts', 'author_id'),
  col('posts', 'editor_id'),
  col('posts', 'title', 'text'),
  col('comments', 'id'),
  col('comments', 'post_id'),
  col('comments', 'body', 'text'),
  col('tags', 'id'),
  col('tags', 'label', 'text'),
  col('post_tags', 'post_id'),
  col('post_tags', 'tag_id'),
  col('sessions', 'id'),
  col('audit_log', 'id'),
  col('audit_log', 'action', 'text'),
];

const PRIMARY_KEYS = [
  { table_name: 'orgs', column_name: 'id' },
  { table_name: 'users', column_name: 'id' },
  { table_name: 'posts', column_name: 'id' },
  { table_name: 'comments', column_name: 'id' },
  { table_name: 'tags', column_name: 'id' },
  { table_name: 'sessions', column_name: 'id' },
  { table_name: 'audit_log', column_name: 'id' },
  // Composite PK over the two FK columns: the shape auto-m2m derivation needs.
  { table_name: 'post_tags', column_name: 'post_id' },
  { table_name: 'post_tags', column_name: 'tag_id' },
];

function fk(oid: string, from: string, fromCol: string, to: string, toCol = 'id') {
  return {
    constraint_oid: oid,
    source_table: from,
    source_column: fromCol,
    target_table: to,
    target_column: toCol,
    constraint_name: `${from}_${fromCol}_fkey`,
  };
}

const FOREIGN_KEYS = [
  fk('1', 'users', 'org_id', 'orgs'),
  fk('2', 'users', 'manager_id', 'users'),
  fk('3', 'users', 'session_id', 'sessions'),
  fk('4', 'posts', 'author_id', 'users'),
  fk('5', 'posts', 'editor_id', 'users'),
  fk('6', 'comments', 'post_id', 'posts'),
  fk('7', 'post_tags', 'post_id', 'posts'),
  fk('8', 'post_tags', 'tag_id', 'tags'),
];

const INDEX_ROWS: Record<string, unknown>[] = [
  {
    tablename: 'users',
    indexname: 'users_pkey',
    indexdef: 'CREATE UNIQUE INDEX users_pkey ON public.users USING btree (id)',
  },
  {
    tablename: 'users',
    indexname: 'users_email_idx',
    indexdef: 'CREATE INDEX users_email_idx ON public.users USING btree (email)',
  },
  {
    // A partial index whose predicate embeds a real stored value.
    tablename: 'users',
    indexname: 'users_vip_idx',
    indexdef: `CREATE INDEX users_vip_idx ON public.users USING btree (name) WHERE (email = 'ceo@example.com')`,
  },
  {
    tablename: 'posts',
    indexname: 'posts_pkey',
    indexdef: 'CREATE UNIQUE INDEX posts_pkey ON public.posts USING btree (id)',
  },
];

/**
 * pg_class rows for the stats query. `audit_log` is deliberately absent from the
 * ANALYZEd set (reltuples -1) so the never-analyzed branch has a subject.
 */
const CLASS_ROWS: Record<string, unknown>[] = [
  { relname: 'users', reltuples: '1200', relpages: '48', total_size: '196608', table_size: '98304', index_count: '3' },
  {
    relname: 'posts',
    reltuples: '9500',
    relpages: '310',
    total_size: '2621440',
    table_size: '2523136',
    index_count: '1',
  },
  { relname: 'audit_log', reltuples: '-1', relpages: '0', total_size: '8192', table_size: '0', index_count: '1' },
];

/**
 * The one stored VALUE in this fixture, planted in every place a catalog read
 * can carry real data out of the database: a partial index predicate, an
 * expression index key, and a sampled row. Asserting its absence from a whole
 * serialized reply is the property the agent tools are actually pinned against,
 * and it is checked by stringifying the reply rather than by naming fields, so a
 * new field cannot slip past the assertion the way `emailIdx.columns` did.
 */
const PII_VALUE = 'ceo@example.com';

function route(sql: string, indexRows: Record<string, unknown>[]): Record<string, unknown>[] {
  if (sql.includes('information_schema.tables')) return TABLE_NAMES.map((table_name) => ({ table_name }));
  if (sql.includes('information_schema.columns')) return COLUMNS as unknown as Record<string, unknown>[];
  if (sql.includes("'PRIMARY KEY'")) return PRIMARY_KEYS;
  // pg_catalog FK query, matched on its contype predicate and BEFORE any generic
  // pg_class branch, which it would otherwise fall through to.
  if (sql.includes("con.contype = 'f'")) return FOREIGN_KEYS;
  if (sql.includes("'UNIQUE'")) return [];
  if (sql.includes('FROM pg_indexes')) return indexRows;
  if (sql.includes('pg_enum')) return [];
  if (sql.includes('pg_total_relation_size')) return CLASS_ROWS;
  if (sql.includes('to_regclass')) return [{ exists: false }];
  // A DELIBERATELY LEAKY driver for the sample_rows read: every column comes
  // back populated, `email` included, whatever the projection asked for. The
  // protection under test is that the tool never asks for it AND never emits it,
  // so a fixture that only returns what was projected would prove neither half.
  if (/^SELECT .* FROM "public"\."users"/.test(sql)) {
    return [{ id: 1, org_id: 1, manager_id: null, session_id: 7, email: PII_VALUE, name: 'Ada' }];
  }
  return [];
}

function makePool(recorded: Recorded[], indexRows: Record<string, unknown>[]): pg.Pool {
  const client = {
    query(sql: string, params?: unknown[]) {
      recorded.push({ sql, params });
      const rows = route(sql, indexRows);
      return Promise.resolve({ rows, rowCount: rows.length, fields: [] });
    },
    release() {},
  };
  return {
    connect() {
      return Promise.resolve(client);
    },
    on() {},
    end() {
      return Promise.resolve();
    },
  } as unknown as pg.Pool;
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface ToolReply {
  result?: { content: { type: string; text: string }[] };
  error?: { code: number; message: string; data?: unknown };
}

function readOne(output: PassThrough): Promise<ToolReply> {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const onData = (chunk: Buffer | string) => {
      buffer += chunk.toString();
      const nl = buffer.indexOf('\n');
      if (nl === -1) return;
      output.off('data', onData);
      output.off('error', onError);
      try {
        resolve(JSON.parse(buffer.slice(0, nl)) as ToolReply);
      } catch (err) {
        reject(err);
      }
    };
    const onError = (err: Error) => {
      output.off('data', onData);
      reject(err);
    };
    output.on('data', onData);
    output.on('error', onError);
  });
}

function createHarness(options: Partial<McpServerOptions> = {}, indexRows: Record<string, unknown>[] = INDEX_ROWS) {
  const recorded: Recorded[] = [];
  const input = new PassThrough();
  const output = new PassThrough();
  const handle = startMcpServer(
    {
      url: 'postgres://example.invalid/turbine',
      schema: 'public',
      migrationsDir: join(tmpdir(), 'turbine-mcp-no-such-migrations'),
      ...options,
    },
    { input, output, pool: makePool(recorded, indexRows) },
  );

  let id = 0;
  const rpc = (method: string, params?: Record<string, unknown>): Promise<ToolReply> => {
    id++;
    const reply = readOne(output);
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return reply;
  };
  const call = (name: string, args: Record<string, unknown> = {}): Promise<ToolReply> =>
    rpc('tools/call', { name, arguments: args });

  return { call, rpc, recorded, dispose: () => handle.dispose() };
}

function payload(reply: ToolReply): Record<string, unknown> {
  assert.equal(reply.error, undefined, `unexpected JSON-RPC error: ${JSON.stringify(reply.error)}`);
  const text = reply.result?.content[0]?.text;
  assert.ok(text, 'tool result carried no text content');
  return JSON.parse(text) as Record<string, unknown>;
}

interface GraphEdge {
  name: string;
  type: string;
  from: string;
  to: string;
  foreignKey: string | string[];
  referenceKey: string | string[];
  through: { table: string; sourceKey: string | string[]; targetKey: string | string[] } | null;
  selfRelation: boolean;
}

interface GraphTable {
  table: string;
  hops: number | null;
  relationCount: number;
  relations: GraphEdge[];
}

interface JoinPath {
  hops: number;
  relations: GraphEdge[];
  relationNames: string[];
  withClause: string;
  code: string;
  resultShape: string;
  crossesManyToMany: boolean;
  returnsArray: boolean;
}

function graphTables(result: Record<string, unknown>): GraphTable[] {
  return result.tables as GraphTable[];
}

function joinPaths(result: Record<string, unknown>): JoinPath[] {
  return result.paths as JoinPath[];
}

/**
 * The fixture as real `SchemaMetadata`, derived through the SAME
 * `buildRelations` the server goes through, so the relation names in it are
 * exactly the ones `find_join_path` returned. This is what lets the emitted
 * clause be handed to the core query builder rather than merely eyeballed.
 */
function fixtureMetadata(): SchemaMetadata {
  const specsByTable = new Map<string, { name: string; field: string; pgType: string }[]>();
  for (const row of COLUMNS) {
    const list = specsByTable.get(row.table_name) ?? [];
    list.push({ name: row.column_name, field: snakeToCamel(row.column_name), pgType: row.udt_name });
    specsByTable.set(row.table_name, list);
  }

  const columnsByTable = new Map<string, ColumnMetadata[]>();
  for (const [table, specs] of specsByTable) columnsByTable.set(table, mockTable(table, specs).columns);

  const pkByTable = new Map<string, string[]>();
  for (const row of PRIMARY_KEYS) {
    pkByTable.set(row.table_name, [...(pkByTable.get(row.table_name) ?? []), row.column_name]);
  }

  const relations = buildRelations(
    [...specsByTable.keys()],
    columnsByTable,
    pkByTable,
    FOREIGN_KEYS,
    new Map(),
    new Map(),
  );
  const tables: Record<string, TableMetadata> = {};
  for (const [table, specs] of specsByTable) tables[table] = mockTable(table, specs, relations.get(table) ?? {});
  return { tables, enums: {} };
}

/**
 * The object the emitted `with` clause TEXT denotes, rebuilt from the relation
 * names alone. Written independently of the renderer on purpose: the renderer's
 * output is pinned by string equality elsewhere, and this exists to feed the
 * same chain to the real builder.
 */
function nestWith(names: string[]): Record<string, unknown> {
  const [head, ...rest] = names;
  if (head === undefined) return {};
  return rest.length === 0 ? { [head]: true } : { [head]: { with: nestWith(rest) } };
}

// ---------------------------------------------------------------------------
// Generated-metadata fixtures (for the code-first `pii` tag path)
// ---------------------------------------------------------------------------

/**
 * A code-first schema tagging `users.email` and `posts.author_id`.
 *
 * A FOREIGN KEY is not where a `pii` tag usually lands, and that is exactly why
 * it is here: tagging one is the only way to prove the graph tools honour the
 * tag on a JOIN KEY, which is a column belonging to a table other than the one
 * the caller asked about. Nothing else in the suite reaches that code path.
 */
function taggedSchema(): SchemaMetadata {
  const users = mockTable('users', [
    { name: 'id', field: 'id' },
    { name: 'org_id', field: 'orgId' },
    { name: 'manager_id', field: 'managerId' },
    { name: 'session_id', field: 'sessionId' },
    { name: 'email', field: 'email', pgType: 'text' },
    { name: 'name', field: 'name', pgType: 'text' },
  ]);
  for (const column of users.columns) {
    if (column.name === 'email') column.pii = true;
  }
  const posts = mockTable('posts', [
    { name: 'id', field: 'id' },
    { name: 'author_id', field: 'authorId' },
    { name: 'editor_id', field: 'editorId' },
    { name: 'title', field: 'title', pgType: 'text' },
  ]);
  for (const column of posts.columns) {
    if (column.name === 'author_id') column.pii = true;
  }
  return { tables: { users, posts }, enums: {} };
}

function withMetadataDir(source: string, fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'turbine-mcp-agent-'));
  writeFileSync(join(dir, 'metadata.ts'), source);
  return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }));
}

const TAGGED_METADATA = () => generateMetadata(taggedSchema(), { noTimestamp: true });
const UNREADABLE_METADATA = 'export const SCHEMA = "not what generate emits";';

/** Run fn with process.stderr captured (the server announces its tag state there). */
async function quietStderr<T>(fn: () => Promise<T>): Promise<T> {
  const original = process.stderr.write.bind(process.stderr);
  (process.stderr as { write: unknown }).write = () => true;
  try {
    return await fn();
  } finally {
    (process.stderr as { write: unknown }).write = original;
  }
}

// ---------------------------------------------------------------------------

describe('mcp relation_graph', () => {
  it('returns every table with its relation names, cardinalities and join keys', async () => {
    const h = createHarness();
    const result = payload(await h.call('relation_graph'));

    assert.equal(result.root, null);
    assert.equal(result.depth, null);
    assert.equal(result.tableCount, TABLE_NAMES.length);
    const tables = graphTables(result);
    assert.deepEqual(
      tables.map((t) => t.table),
      [...TABLE_NAMES].sort(),
    );

    // comments -> posts: a belongsTo carrying the real join columns.
    const comments = tables.find((t) => t.table === 'comments');
    assert.ok(comments);
    const toPosts = comments.relations.find((r) => r.to === 'posts' && r.type === 'belongsTo');
    assert.ok(toPosts, 'comments should declare a belongsTo to posts');
    assert.equal(toPosts.foreignKey, 'post_id');
    assert.equal(toPosts.referenceKey, 'id');
    assert.equal(toPosts.through, null);
    assert.equal(toPosts.selfRelation, false);

    // The auto-derived many-to-many reports its junction.
    const posts = tables.find((t) => t.table === 'posts');
    assert.ok(posts);
    const m2m = posts.relations.find((r) => r.type === 'manyToMany');
    assert.ok(m2m, 'posts <-> tags should be derived as a many-to-many');
    assert.equal(m2m.to, 'tags');
    assert.ok(m2m.through);
    assert.equal(m2m.through.table, 'post_tags');
    assert.equal(m2m.through.sourceKey, 'post_id');
    assert.equal(m2m.through.targetKey, 'tag_id');

    // A self-relation is flagged rather than left for the caller to notice.
    const users = tables.find((t) => t.table === 'users');
    assert.ok(users);
    const self = users.relations.find((r) => r.selfRelation);
    assert.ok(self, 'users.manager_id -> users should surface as a self-relation');
    assert.equal(self.from, 'users');
    assert.equal(self.to, 'users');

    // Every relation count is consistent with the list it summarizes.
    for (const table of tables) assert.equal(table.relationCount, table.relations.length);
    assert.equal(
      result.relationCount,
      tables.reduce((sum, t) => sum + t.relations.length, 0),
    );

    await h.dispose();
  });

  it('scopes to one table and honours the depth bound, naming what it did not expand', async () => {
    const h = createHarness();
    const result = payload(await h.call('relation_graph', { table: 'comments', depth: 1 }));

    assert.equal(result.root, 'comments');
    assert.equal(result.depth, 1);
    const tables = graphTables(result);
    assert.deepEqual(
      tables.map((t) => t.table),
      ['comments', 'posts'],
    );
    assert.equal(tables[0]?.hops, 0);
    assert.equal(tables[1]?.hops, 1);

    // posts reaches users/tags/post_tags, none of which were expanded at depth 1.
    // They are NAMED, so "not expanded" cannot be misread as "nothing there".
    const omitted = result.omittedBeyondDepth as string[];
    assert.deepEqual(omitted, ['post_tags', 'tags', 'users']);

    // depth 2 pulls them in.
    const deeper = payload(await h.call('relation_graph', { table: 'comments', depth: 2 }));
    assert.deepEqual(
      graphTables(deeper)
        .map((t) => t.table)
        .sort(),
      ['comments', 'post_tags', 'posts', 'tags', 'users'],
    );
    await h.dispose();
  });

  it('rejects an unknown table and lists the tables that exist', async () => {
    const h = createHarness();
    const reply = await h.call('relation_graph', { table: 'nope' });
    assert.equal(reply.error?.code, -32602);
    assert.match(reply.error?.message ?? '', /Unknown table "nope"/);
    assert.match(reply.error?.message ?? '', /Available: .*users/);
    await h.dispose();
  });

  it('rejects an empty table string and an out-of-range depth instead of guessing', async () => {
    const h = createHarness();

    // '' is a caller that meant to pass a table and computed nothing. Answering
    // the whole-schema question instead would hide the bug.
    const empty = await h.call('relation_graph', { table: '   ' });
    assert.equal(empty.error?.code, -32602);
    assert.match(empty.error?.message ?? '', /table must be a non-empty string/);

    for (const depth of [0, 11, 1.5, '2']) {
      const reply = await h.call('relation_graph', { table: 'users', depth });
      assert.equal(reply.error?.code, -32602, `depth ${JSON.stringify(depth)} should be refused`);
      assert.match(reply.error?.message ?? '', /depth must be an integer between 1 and 10/);
    }
    await h.dispose();
  });
});

describe('mcp find_join_path', () => {
  it('emits a well-formed nested `with` clause and runnable code for a 2-hop path', async () => {
    const h = createHarness();
    const result = payload(await h.call('find_join_path', { from: 'comments', to: 'users' }));

    assert.equal(result.found, true);
    assert.equal(result.sameTable, false);
    assert.equal(result.hops, 2);

    const paths = joinPaths(result);
    assert.ok(paths.length >= 1);
    for (const path of paths) {
      assert.equal(path.hops, 2);
      assert.equal(path.relationNames.length, 2);
      const [first, second] = path.relationNames as [string, string];

      // The exact literal an agent is expected to paste. Written out by hand
      // rather than re-derived, so a change in the renderer has to be noticed.
      assert.equal(path.withClause, `{\n    ${first}: {\n      with: { ${second}: true },\n    },\n  }`);
      assert.equal(path.code, `await db.comments.findMany({\n  with: ${path.withClause},\n});`);
      assert.equal(path.resultShape, `comments[].${first}.${second}`);

      // The chain is contiguous: each hop starts where the previous one ended.
      assert.equal(path.relations[0]?.from, 'comments');
      assert.equal(path.relations[0]?.to, path.relations[1]?.from);
      assert.equal(path.relations[1]?.to, 'users');
    }
    await h.dispose();
  });

  it('emits a well-formed nested `with` clause for a 3-hop path', async () => {
    const h = createHarness();
    const result = payload(await h.call('find_join_path', { from: 'comments', to: 'orgs' }));

    assert.equal(result.found, true);
    assert.equal(result.hops, 3);

    const path = joinPaths(result)[0];
    assert.ok(path);
    const [a, b, c] = path.relationNames as [string, string, string];
    assert.equal(
      path.withClause,
      `{\n    ${a}: {\n      with: {\n        ${b}: {\n          with: { ${c}: true },\n        },\n      },\n    },\n  }`,
    );
    assert.equal(path.code, `await db.comments.findMany({\n  with: ${path.withClause},\n});`);
    assert.equal(path.resultShape, `comments[].${a}.${b}.${c}`);
    assert.equal(path.relations.at(-1)?.to, 'orgs');

    // The rendered clause opens and closes cleanly: one `with:` per inner hop.
    assert.equal((path.withClause.match(/with:/g) ?? []).length, 2);
    assert.equal((path.withClause.match(/\{/g) ?? []).length, (path.withClause.match(/\}/g) ?? []).length);
    await h.dispose();
  });

  it('returns EVERY equal-length path when two foreign keys reach the same table', async () => {
    const h = createHarness();
    const result = payload(await h.call('find_join_path', { from: 'posts', to: 'users' }));

    const paths = joinPaths(result);
    assert.equal(result.pathCount, 2, 'posts.author_id and posts.editor_id are two distinct 1-hop joins');
    assert.deepEqual(
      paths.map((p) => p.hops),
      [1, 1],
    );
    // Two different relation names, i.e. genuinely different joins.
    const names = paths.map((p) => p.relationNames[0]);
    assert.equal(new Set(names).size, 2);
    for (const path of paths) {
      assert.equal(path.withClause, `{ ${path.relationNames[0]}: true }`);
    }
    const notes = result.notes as string[];
    assert.ok(
      notes.some((note) => /equal length/i.test(note)),
      'the reply must say the paths are alternatives, not duplicates',
    );
    await h.dispose();
  });

  it('counts a many-to-many as ONE hop and says the junction must not appear in the query', async () => {
    const h = createHarness();
    const result = payload(await h.call('find_join_path', { from: 'comments', to: 'tags' }));

    assert.equal(result.found, true);
    // comments -> posts -> tags (m2m), NOT comments -> posts -> post_tags -> tags.
    assert.equal(result.hops, 2);
    const path = joinPaths(result)[0];
    assert.ok(path);
    assert.equal(path.crossesManyToMany, true);
    assert.equal(path.returnsArray, true);
    assert.equal(path.relations.at(-1)?.type, 'manyToMany');
    assert.equal(path.relations.at(-1)?.through?.table, 'post_tags');
    assert.equal(path.relationNames.includes('post_tags'), false, 'the junction is never a `with` entry');
    assert.match(path.resultShape, /\[\]$/, 'a many-to-many tail returns an array');
    assert.ok((result.notes as string[]).some((note) => /junction table is joined for you/i.test(note)));
    await h.dispose();
  });

  it('returns cleanly with found:false when no chain exists, instead of throwing', async () => {
    const h = createHarness();
    const reply = await h.call('find_join_path', { from: 'comments', to: 'audit_log' });

    // Not an error: "these tables are not connected" is an ANSWER.
    assert.equal(reply.error, undefined);
    const result = payload(reply);
    assert.equal(result.found, false);
    assert.equal(result.hops, null);
    assert.equal(result.pathCount, 0);
    assert.deepEqual(result.paths, []);
    assert.match(result.reason as string, /No relation chain connects "comments" to "audit_log"/);
    await h.dispose();
  });

  it('reports not-found rather than a longer path when maxDepth cuts the chain', async () => {
    const h = createHarness();
    const result = payload(await h.call('find_join_path', { from: 'comments', to: 'orgs', maxDepth: 2 }));
    assert.equal(result.found, false);
    assert.equal(result.searchedDepth, 2);
    assert.match(result.reason as string, /within 2 hop/);
    await h.dispose();
  });

  it('stops at the node budget and says so, rather than reporting "no path"', () => {
    // The walk runs inside an open BEGIN READ ONLY on a max:2 pool, so an
    // unbounded enumeration holds a connection, not just CPU. `maxPaths` bounds
    // COMPLETE chains and does not bound the prefixes that dead-end, so the two
    // caps are not the same cap.
    //
    // Driven through the exported function with a small budget: the production
    // budget is sized so no real schema reaches it, and a fixture large enough
    // to hit 200,000 visits would prove nothing this does not.
    const metadata = fixtureMetadata();

    const complete = shortestJoinPaths(metadata, 'comments', 'orgs', 10, 5);
    assert.equal(complete.exhausted, false);
    assert.ok(complete.paths.length > 0, 'the same search completes on the real budget');

    const starved = shortestJoinPaths(metadata, 'comments', 'orgs', 10, 5, 1);
    assert.equal(starved.exhausted, true);
    // `truncated` is set as well, because "there may be more" is true either
    // way and a caller that only checks that field must not read an exhausted
    // search as a complete one.
    assert.equal(starved.truncated, true);
    assert.deepEqual(starved.paths, []);
  });

  it('reports searchExhausted: false on a search that completed', async () => {
    // The node budget bounds a walk that runs inside an open BEGIN READ ONLY on
    // a max:2 pool. The field is on EVERY reply, not only an exhausted one,
    // because "the search finished" is the fact an agent needs before it reports
    // two tables as unconnected, and an absent key reads as neither.
    const h = createHarness();
    for (const [from, to] of [
      ['comments', 'orgs'],
      ['comments', 'audit_log'],
    ] as const) {
      const result = payload(await h.call('find_join_path', { from, to, maxDepth: 10 }));
      assert.equal(result.searchExhausted, false, `${from} -> ${to}`);
    }
    await h.dispose();
  });

  it('answers a same-table query with the table SELF-relations', async () => {
    const h = createHarness();
    const result = payload(await h.call('find_join_path', { from: 'users', to: 'users' }));

    assert.equal(result.found, true);
    assert.equal(result.sameTable, true);
    const paths = joinPaths(result);
    assert.ok(paths.length >= 1, 'users.manager_id -> users is a self-relation');
    for (const path of paths) {
      assert.equal(path.hops, 1);
      assert.equal(path.relations[0]?.selfRelation, true);
      assert.equal(path.withClause, `{ ${path.relationNames[0]}: true }`);
    }
    assert.ok((result.notes as string[]).some((note) => /no join is needed/i.test(note)));

    // A table with no self-relation answers cleanly too, with no paths.
    const none = payload(await h.call('find_join_path', { from: 'orgs', to: 'orgs' }));
    assert.equal(none.found, true);
    assert.equal(none.sameTable, true);
    assert.equal(none.hops, 0);
    assert.deepEqual(none.paths, []);
    await h.dispose();
  });

  it('emits a `with` chain the CORE query builder accepts, at every depth', async () => {
    // The point of returning code instead of prose is that the code runs. This
    // hands every emitted chain to the real QueryInterface over the same derived
    // relations: a name the graph invents but `with` does not accept (the
    // TURBINE_E005 an agent would otherwise hit) fails here instead.
    const h = createHarness();
    const metadata = fixtureMetadata();

    for (const [from, to] of [
      ['comments', 'posts'],
      ['comments', 'users'],
      ['comments', 'orgs'],
      ['posts', 'tags'],
      ['comments', 'tags'],
    ] as const) {
      const result = payload(await h.call('find_join_path', { from, to }));
      const paths = joinPaths(result);
      assert.ok(paths.length > 0, `${from} -> ${to} should have a path`);
      for (const path of paths) {
        const qi = makeQuery(from, metadata);
        const args = { with: nestWith(path.relationNames) } as unknown as FindManyArgs<Record<string, unknown>>;
        const deferred = qi.buildFindMany(args);
        assert.match(deferred.sql, /json_/, `${from} -> ${to} should compile to a nested-relation select`);
        assert.ok(
          deferred.sql.includes(`"${to}"`),
          `${from} -> ${to} via ${path.relationNames.join('.')} should reach "${to}" in the SQL`,
        );
      }
    }
    await h.dispose();
  });

  it('rejects an unknown table on either end, and a missing argument', async () => {
    const h = createHarness();

    const badFrom = await h.call('find_join_path', { from: 'nope', to: 'users' });
    assert.equal(badFrom.error?.code, -32602);
    assert.match(badFrom.error?.message ?? '', /Unknown table "nope"/);

    const badTo = await h.call('find_join_path', { from: 'users', to: 'nope' });
    assert.match(badTo.error?.message ?? '', /Unknown table "nope"/);

    const missing = await h.call('find_join_path', { from: 'users' });
    assert.equal(missing.error?.code, -32602);
    assert.match(missing.error?.message ?? '', /to is required/);

    const bounds = await h.call('find_join_path', { from: 'users', to: 'orgs', maxPaths: 0 });
    assert.match(bounds.error?.message ?? '', /maxPaths must be an integer between 1 and 25/);
    await h.dispose();
  });
});

describe('mcp table_stats', () => {
  it('reports reltuples as an ESTIMATE, with pages, sizes and indexes', async () => {
    const h = createHarness();
    const result = payload(await h.call('table_stats', { table: 'users' }));

    assert.equal(result.table, 'users');
    const rowEstimate = result.rowEstimate as {
      estimatedRows: number;
      analyzed: boolean;
      source: string;
      note: string;
    };
    assert.equal(rowEstimate.estimatedRows, 1200);
    assert.equal(rowEstimate.analyzed, true);
    assert.equal(rowEstimate.source, 'pg_class.reltuples');
    // The word an agent must not drop when it repeats this number.
    assert.match(rowEstimate.note, /ESTIMATE, not a count/);
    assert.match(rowEstimate.note, /Do not report it as a row count/);

    const storage = result.storage as Record<string, unknown>;
    assert.equal(storage.relpages, 48);
    assert.equal(storage.heapBytes, 98304);
    assert.equal(storage.totalBytes, 196608);
    assert.equal(storage.heapSize, '96 KB');
    assert.equal(storage.totalSize, '192 KB');

    assert.equal(result.indexCount, 3);
    const indexes = result.indexes as { name: string; columns: string[]; unique: boolean }[];
    assert.deepEqual(indexes.map((i) => i.name).sort(), ['users_email_idx', 'users_pkey', 'users_vip_idx']);
    const pkey = indexes.find((i) => i.name === 'users_pkey');
    assert.equal(pkey?.unique, true);
    assert.deepEqual(pkey?.columns, ['id']);
    await h.dispose();
  });

  it('reports a never-analyzed table as UNKNOWN, not as empty', async () => {
    const h = createHarness();
    const result = payload(await h.call('table_stats', { table: 'audit_log' }));
    const rowEstimate = result.rowEstimate as { estimatedRows: number | null; analyzed: boolean; note: string };

    // reltuples is -1 here. Reporting 0 would be a claim ("this table is empty")
    // that an agent would act on, and it is a different claim from "unknown".
    assert.equal(rowEstimate.estimatedRows, null);
    assert.equal(rowEstimate.analyzed, false);
    assert.match(rowEstimate.note, /never been ANALYZEd/);
    assert.match(rowEstimate.note, /NOT the same as an empty table/);
    await h.dispose();
  });

  it('reports sizes as unknown for a table the stats query did not return', async () => {
    const h = createHarness();
    const result = payload(await h.call('table_stats', { table: 'comments' }));
    const rowEstimate = result.rowEstimate as { estimatedRows: number | null; analyzed: boolean };
    const storage = result.storage as Record<string, unknown>;

    assert.equal(rowEstimate.estimatedRows, null);
    assert.equal(rowEstimate.analyzed, false);
    assert.equal(storage.relpages, null);
    assert.equal(storage.heapBytes, null);
    assert.equal(storage.heapSize, 'size unknown');
    await h.dispose();
  });

  it('rejects an unknown table', async () => {
    const h = createHarness();
    const reply = await h.call('table_stats', { table: 'nope' });
    assert.equal(reply.error?.code, -32602);
    assert.match(reply.error?.message ?? '', /Unknown table "nope"/);

    const missing = await h.call('table_stats', {});
    assert.equal(missing.error?.code, -32602);
    assert.match(missing.error?.message ?? '', /table is required/);
    await h.dispose();
  });

  it('withholds an index predicate that embeds a literal value', async () => {
    const h = createHarness();
    const result = payload(await h.call('table_stats', { table: 'users' }));
    const indexes = result.indexes as { name: string; partial: boolean; definition?: string }[];

    const partial = indexes.find((i) => i.name === 'users_vip_idx');
    assert.ok(partial);
    assert.equal(partial.partial, true);
    assert.equal(partial.definition?.includes('ceo@example.com'), false);
    assert.match(partial.definition ?? '', /WHERE \(predicate withheld\)/);
    await h.dispose();
  });
});

describe('mcp index columns: a partial predicate is not a column', () => {
  /**
   * REGRESSION. `extractIndexColumns` matched `/\((.+)\)/`, which is greedy, so
   * on the one-line `… USING btree (name) WHERE (email = 'ceo@example.com')`
   * that pg_indexes emits it spanned from the key list's opening paren to the
   * PREDICATE's closing one and returned the stored value as a "column".
   * `sanitizeIndex` withheld that same value from `definition` two fields away
   * and passed `columns` through verbatim, so the redaction was decorative.
   *
   * This hits `table_detail` too, which is why it is asserted on BOTH tools:
   * the parser is shared, and only one of the two was ever tested.
   */
  it('never returns a stored predicate value as an index column', async () => {
    const h = createHarness();
    for (const [tool, key] of [
      ['table_detail', 'indexes'],
      ['table_stats', 'indexes'],
    ] as const) {
      const result = payload(await h.call(tool, { table: 'users' }));
      const indexes = result[key] as { name: string; columns: string[] }[];
      const partial = indexes.find((i) => i.name === 'users_vip_idx');
      assert.ok(partial, `${tool} should report the partial index`);
      assert.deepEqual(partial.columns, ['name'], `${tool} must report the KEY LIST, not the predicate`);
      assert.equal(
        JSON.stringify(indexes).includes('ceo@example.com'),
        false,
        `${tool} leaked a stored value out of an index definition`,
      );
    }
    await h.dispose();
  });
});

describe('mcp explain_error', () => {
  it('explains a code, accepting every spelling of it', async () => {
    const h = createHarness();
    const canonical = payload(await h.call('explain_error', { code: 'TURBINE_E003' }));

    assert.equal(canonical.code, 'TURBINE_E003');
    assert.equal(canonical.className, 'ValidationError');
    assert.equal(canonical.docsUrl, 'https://turbineorm.dev/errors#e003');
    assert.equal(canonical.retryable, false);
    assert.equal(canonical.origin, 'turbine');
    assert.ok((canonical.likelyCauses as string[]).length > 0);
    assert.ok((canonical.howToFix as string[]).length > 0);
    assert.match(canonical.catchExample as string, /import \{ ValidationError \} from 'turbine-orm';/);
    assert.match(canonical.catchExample as string, /err instanceof ValidationError/);

    for (const spelling of ['E003', 'e003', '3', '003', 'turbine_e003', ' TURBINE_E003 ']) {
      const result = payload(await h.call('explain_error', { code: spelling }));
      assert.deepEqual(result, canonical, `"${spelling}" must resolve to the same explanation`);
    }
    await h.dispose();
  });

  it('marks the two retryable codes retryable and names the SQLSTATE it was translated from', async () => {
    const h = createHarness();

    const deadlock = payload(await h.call('explain_error', { code: 'E012' }));
    assert.equal(deadlock.className, 'DeadlockError');
    assert.equal(deadlock.retryable, true);
    assert.equal(deadlock.origin, 'wrapped-pg');
    assert.equal(deadlock.sqlstate, '40P01');
    assert.ok((deadlock.howToFix as string[]).some((fix) => /withRetry/.test(fix)));

    // Optimistic locking is deliberately NOT retryable: a blind retry defeats it.
    const optimistic = payload(await h.call('explain_error', { code: 'E015' }));
    assert.equal(optimistic.className, 'OptimisticLockError');
    assert.equal(optimistic.retryable, false);
    assert.ok((optimistic.howToFix as string[]).some((fix) => /re-read the row/i.test(fix)));
    await h.dispose();
  });

  it('rejects an unknown code by handing back the whole valid set', async () => {
    const h = createHarness();

    const unknown = await h.call('explain_error', { code: 'TURBINE_E999' });
    assert.equal(unknown.error?.code, -32602);
    assert.match(unknown.error?.message ?? '', /"TURBINE_E999" is not a Turbine error code/);
    assert.match(unknown.error?.message ?? '', /TURBINE_E001/);
    assert.match(unknown.error?.message ?? '', /TURBINE_E018/);

    const garbage = await h.call('explain_error', { code: 'not-a-code' });
    assert.equal(garbage.error?.code, -32602);
    assert.match(garbage.error?.message ?? '', /is not a Turbine error code/);

    const missing = await h.call('explain_error', {});
    assert.equal(missing.error?.code, -32602);
    assert.match(missing.error?.message ?? '', /code is required/);

    const blank = await h.call('explain_error', { code: '   ' });
    assert.equal(blank.error?.code, -32602);
    await h.dispose();
  });

  it('catalogues EVERY code in errors.ts, with the docsUrl the real error carries', async () => {
    // The catalog is a `Record<TurbineErrorCode, …>`, so a missing code is a
    // compile error. This asserts the runtime half: every code answers, and the
    // URL is the one on the error an agent actually caught, not a second copy.
    const h = createHarness();
    for (const code of Object.values(TurbineErrorCode)) {
      const result = payload(await h.call('explain_error', { code }));
      assert.equal(result.code, code);
      assert.equal(result.docsUrl, new TurbineError(code, 'probe').docsUrl, `${code} docsUrl must match errors.ts`);
      assert.ok(typeof result.className === 'string' && result.className.endsWith('Error'));
      assert.ok((result.whenThrown as string).length > 0, `${code} needs a whenThrown`);
      assert.ok((result.likelyCauses as string[]).length > 0, `${code} needs at least one cause`);
      assert.ok((result.howToFix as string[]).length > 0, `${code} needs at least one fix`);
    }
    await h.dispose();
  });

  it('answers with no database access at all', async () => {
    const h = createHarness();
    payload(await h.call('explain_error', { code: 'E004' }));
    // Not one statement, not even a BEGIN: an agent holding a ConnectionError is
    // frequently talking to a database it cannot reach.
    assert.deepEqual(h.recorded, []);
    await h.dispose();
  });
});

/**
 * THE PERIMETER IS THE VALUE, NOT THE NAME.
 *
 * An earlier cut of these tools masked hidden column NAMES inside relation edges
 * and index key lists, and two tool descriptions stated that masking as a
 * protection. It was not one: the same name came back in the same reply through
 * the index `definition`, through the index `name`, through the
 * `redactedColumns` list that reported the masking, and through the relation
 * name itself (Turbine derives `session` from `session_id`), while `primaryKey`
 * was never masked at all. A column NAME is schema shape, which an agent needs
 * to write a query and which `table_detail` publishes in full.
 *
 * So the masking is gone and this describe pins what replaced it, on both sides:
 * a hidden column's NAME is returned by the graph and stats tools, and a stored
 * VALUE is returned by none of them. The value assertions stringify the WHOLE
 * reply rather than naming a field, because the test they replace asserted on
 * `emailIdx.columns` alone and therefore passed while four other fields in the
 * same object carried the name it was checking for.
 */
describe('mcp agent tools: values are the perimeter, names are not', () => {
  it('relation_graph returns a secret-named join key BY NAME, and no stored value anywhere', async () => {
    const h = createHarness();
    const result = payload(await h.call('relation_graph', { table: 'users', depth: 1 }));

    const users = graphTables(result).find((t) => t.table === 'users');
    assert.ok(users);
    const toSessions = users.relations.find((r) => r.to === 'sessions');
    assert.ok(toSessions, 'users.session_id -> sessions should be derived');
    // The join key is the thing an agent needs to reason about the relation, and
    // masking it here bought nothing: the relation NAME is derived from it.
    assert.equal(toSessions.foreignKey, 'session_id');
    assert.equal(toSessions.name, 'session');

    // Nothing claims a redaction happened, because none did.
    assert.equal('redactedColumns' in result, false);
    assert.equal('redactionReasons' in result, false);
    // ... and the reply says so in the words the tool description uses.
    assert.match(String(result.valueNote), /reads no row values/);

    const toOrgs = users.relations.find((r) => r.to === 'orgs' && r.type === 'belongsTo');
    assert.equal(toOrgs?.foreignKey, 'org_id');
    assert.equal(JSON.stringify(result).includes(PII_VALUE), false, 'a stored value reached relation_graph');
    await h.dispose();
  });

  it('relation_graph and find_join_path return a PII-TAGGED join key BY NAME, with no value', async () => {
    await withMetadataDir(TAGGED_METADATA(), async (metadataDir) => {
      await quietStderr(async () => {
        const h = createHarness({ metadataDir });

        const graph = payload(await h.call('relation_graph', { table: 'posts', depth: 1 }));
        const posts = graphTables(graph).find((t) => t.table === 'posts');
        assert.ok(posts);
        const viaAuthor = posts.relations.find(
          (r) => r.type === 'belongsTo' && r.to === 'users' && r.foreignKey === 'author_id',
        );
        assert.ok(viaAuthor, 'the posts.author_id join key is returned by name');
        assert.equal(viaAuthor.name, 'author');

        const path = payload(await h.call('find_join_path', { from: 'posts', to: 'users' }));
        assert.ok(
          joinPaths(path).some((p) => p.relations.some((r) => r.foreignKey === 'author_id')),
          'find_join_path returns the same edges as relation_graph',
        );
        assert.ok(joinPaths(path).every((p) => p.relationNames.length === 1 && p.relationNames[0]));

        // THE assertion: the whole reply, every field, no stored value.
        for (const [tool, reply] of [
          ['relation_graph', graph],
          ['find_join_path', path],
        ] as const) {
          assert.equal(JSON.stringify(reply).includes(PII_VALUE), false, `${tool} leaked a stored value`);
        }
        await h.dispose();
      });
    });
  });

  it('table_stats returns a PII-tagged index column BY NAME, and still withholds the stored predicate value', async () => {
    await withMetadataDir(TAGGED_METADATA(), async (metadataDir) => {
      await quietStderr(async () => {
        const h = createHarness({ metadataDir });
        const result = payload(await h.call('table_stats', { table: 'users' }));
        const indexes = result.indexes as { name: string; columns: string[]; partial: boolean; definition?: string }[];

        // The NAME of the tagged column is published: it is already in the index
        // NAME, in the index DEFINITION, and in table_detail's column list.
        const emailIdx = indexes.find((i) => i.name === 'users_email_idx');
        assert.deepEqual(emailIdx?.columns, ['email']);
        assert.deepEqual(indexes.find((i) => i.name === 'users_pkey')?.columns, ['id']);

        // The VALUE embedded in the partial index predicate is not, and that is
        // the protection this tool actually has. Asserted over the WHOLE reply,
        // not over one field of one index.
        const partial = indexes.find((i) => i.name === 'users_vip_idx');
        assert.equal(partial?.partial, true);
        assert.match(partial?.definition ?? '', /WHERE \(predicate withheld\)/);
        assert.equal(JSON.stringify(result).includes(PII_VALUE), false, 'table_stats leaked a stored value');

        assert.equal('redactedColumns' in result, false);
        assert.match(String(result.note), /stripped of literal values/);
        await h.dispose();
      });
    });
  });

  it('reports columnsWithheld from the list it describes, never from a length comparison', async () => {
    // `columnsWithheld` was computed by comparing lengths at one line and then
    // read by callers after a later same-length transform, so it could report
    // `false` while the reply displayed a withholding. It is derived from the
    // partition now. An EXPRESSION key is the one thing genuinely withheld from
    // `columns`, because for `(email || 'ceo@example.com')` the "column" IS the
    // stored value.
    const h = createHarness({}, [
      {
        tablename: 'users',
        indexname: 'users_pkey',
        indexdef: 'CREATE UNIQUE INDEX users_pkey ON public.users USING btree (id)',
      },
      {
        tablename: 'users',
        indexname: 'users_expr_idx',
        indexdef: `CREATE INDEX users_expr_idx ON public.users USING btree (name, (email || 'ceo@example.com'))`,
      },
    ]);
    const result = payload(await h.call('table_stats', { table: 'users' }));
    const indexes = result.indexes as { name: string; columns: string[]; columnsWithheld: boolean }[];

    const plain = indexes.find((i) => i.name === 'users_pkey');
    assert.deepEqual(plain?.columns, ['id']);
    assert.equal(plain?.columnsWithheld, false, 'nothing was withheld from a plain index');

    const expr = indexes.find((i) => i.name === 'users_expr_idx');
    assert.deepEqual(expr?.columns, ['name'], 'the expression key is not a column');
    assert.equal(expr?.columnsWithheld, true, 'the flag must report the entry that was dropped');
    assert.equal(JSON.stringify(result).includes(PII_VALUE), false, 'an expression key leaked a stored value');
    await h.dispose();
  });

  it('reports columnsWithheld for a definition it could not parse, rather than "no columns"', async () => {
    // An UNPARSABLE definition withholds the columns too, and used to say the
    // opposite. The column list is derived from the same definition, so it
    // arrives EMPTY, every per-column test in the partition passes vacuously,
    // and the reply read `columns: [], columnsWithheld: false` beside
    // `definitionWithheld: true`. An agent reads that pair as the FACT "this
    // index has no columns", which is the one thing an unreadable definition
    // cannot establish. Not knowing is a withholding, and every withholding
    // here is labelled.
    const h = createHarness({}, [
      {
        tablename: 'users',
        indexname: 'users_pkey',
        indexdef: 'CREATE UNIQUE INDEX users_pkey ON public.users USING btree (id)',
      },
      {
        tablename: 'users',
        indexname: 'users_broken_idx',
        // Unterminated key list: the parser refuses it rather than guessing.
        indexdef: 'CREATE INDEX users_broken_idx ON public.users USING btree (name',
      },
    ]);
    const result = payload(await h.call('table_stats', { table: 'users' }));
    const indexes = result.indexes as {
      name: string;
      columns: string[];
      columnsWithheld: boolean;
      definitionWithheld: boolean;
    }[];

    const broken = indexes.find((i) => i.name === 'users_broken_idx');
    assert.deepEqual(broken?.columns, [], 'nothing could be parsed out of it');
    assert.equal(broken?.definitionWithheld, true);
    assert.equal(broken?.columnsWithheld, true, 'an empty list from an unreadable definition is not "no columns"');

    // The readable index in the same reply is unaffected: the seed is per-index,
    // not a global pessimism.
    const plain = indexes.find((i) => i.name === 'users_pkey');
    assert.deepEqual(plain?.columns, ['id']);
    assert.equal(plain?.columnsWithheld, false);
    await h.dispose();
  });

  it('describes the graph and stats tools as they behave: values redacted, names not', async () => {
    // The finding this replaces was a DESCRIPTION claiming a protection the
    // server did not have, which is worse than not having it: an agent reading
    // the description would report to a user that a column name was withheld.
    const h = createHarness();
    const reply = (await h.rpc('tools/list')) as unknown as {
      result: { tools: { name: string; description: string }[] };
    };
    const byName = new Map(reply.result.tools.map((t) => [t.name, t.description]));

    for (const tool of ['relation_graph', 'table_stats']) {
      const description = byName.get(tool);
      assert.ok(description, `${tool} must be advertised`);
      assert.match(description, /Column NAMES are returned in full/, tool);
      assert.doesNotMatch(description, /name of a PII-tagged or secret-named .* is withheld/, tool);
    }
    // sample_rows is the tool that DOES protect, and still says so.
    const sampleRowsDescription = byName.get('sample_rows') ?? '';
    assert.match(sampleRowsDescription, /never fetched/);
    // ...and, since 0.76.0, says what "hidden" actually depends on. The
    // guarantee above is unconditional; the SET of hidden columns is not, and a
    // description that stated only the guarantee let an agent read
    // `redactedColumns: []` on an untagged schema as "checked, holds no PII".
    assert.match(sampleRowsDescription, /piiTagSource/, 'must point at the provenance field');
    assert.match(sampleRowsDescription, /denylist/, 'must say the name check is a fixed list');
    assert.match(sampleRowsDescription, /untrusted data/, 'rows are a prompt-injection channel and must say so');
    await h.dispose();
  });

  it('still never FETCHES or emits a hidden column VALUE from sample_rows', async () => {
    // The protection that was kept, asserted against a deliberately leaky
    // driver: the fixture returns `email` populated whatever the projection
    // asked for, so both halves have to hold - the SQL must not name the column,
    // and the reply must not carry the value it was handed anyway.
    await withMetadataDir(TAGGED_METADATA(), async (metadataDir) => {
      await quietStderr(async () => {
        const h = createHarness({ metadataDir });
        const result = payload(await h.call('sample_rows', { table: 'users', limit: 1 }));

        const select = h.recorded.find((r) => /^SELECT .* FROM "public"\."users"/.test(r.sql));
        assert.ok(select, 'sample_rows must have read the table');
        assert.equal(select.sql.includes('"email"'), false, 'a hidden column must not be projected');
        // Positive control: the projection is a real column list, so the absence
        // of "email" above is an exclusion and not an empty assertion.
        assert.ok(select.sql.includes('"name"'), 'a visible column IS projected');

        assert.equal(JSON.stringify(result).includes(PII_VALUE), false, 'sample_rows emitted a hidden value');
        assert.ok((result.redactedColumns as string[]).includes('email'));
        assert.deepEqual((result.rows as Record<string, unknown>[])[0]?.email, '•• redacted ••');
        await h.dispose();
      });
    });
  });

  it('still fails CLOSED on the tools that serve values when the tag scan fails', async () => {
    await withMetadataDir(UNREADABLE_METADATA, async (metadataDir) => {
      await quietStderr(async () => {
        const h = createHarness({ metadataDir });

        // A metadata file that exists and does not parse is indistinguishable
        // from "this schema tags nothing", so every column is treated as tagged.
        const sample = payload(await h.call('sample_rows', { table: 'users', limit: 1 }));
        assert.equal((sample.piiTagSource as { state: string }).state, 'tags-unreadable');
        assert.equal(JSON.stringify(sample.rows).includes(PII_VALUE), false);
        for (const column of sample.columns as { name: string; redacted: boolean }[]) {
          assert.equal(column.redacted, true, `${column.name} must be redacted when tags are unreadable`);
        }

        // A row ESTIMATE on a hidden column is an extraction oracle, so
        // explain_query refuses the predicate rather than assuming it is safe.
        const explained = await h.call('explain_query', { table: 'users', where: { email: 'a' } });
        assert.equal(explained.error?.code, -32602);
        assert.match(explained.error?.message ?? '', /PII tags could not be read/);

        // The graph and stats tools are unaffected: they serve no values, so
        // there is nothing for an unreadable tag file to fail closed ABOUT.
        const graph = payload(await h.call('relation_graph', { table: 'users', depth: 1 }));
        const users = graphTables(graph).find((t) => t.table === 'users');
        assert.equal(users?.relations.find((r) => r.to === 'sessions')?.foreignKey, 'session_id');
        assert.equal(JSON.stringify(graph).includes(PII_VALUE), false);

        const stats = payload(await h.call('table_stats', { table: 'users' }));
        assert.deepEqual(
          (stats.indexes as { name: string; columns: string[] }[]).find((i) => i.name === 'users_email_idx')?.columns,
          ['email'],
        );
        assert.equal(JSON.stringify(stats).includes(PII_VALUE), false);
        await h.dispose();
      });
    });
  });

  it('returns no row values from any of the new catalog tools', async () => {
    const h = createHarness();
    const replies = [
      payload(await h.call('relation_graph')),
      payload(await h.call('find_join_path', { from: 'comments', to: 'orgs' })),
      payload(await h.call('table_stats', { table: 'users' })),
    ];
    // The mock never serves row data to these tools, and they never ask: no
    // statement any of them issued selects FROM a schema table.
    const dataReads = h.recorded.filter((r) => / FROM "public"\./.test(r.sql));
    assert.deepEqual(dataReads, []);
    for (const reply of replies) assert.equal('rows' in reply, false);
    await h.dispose();
  });
});

describe('mcp agent tools: read-only', () => {
  it('emits no INSERT / UPDATE / DELETE / CREATE / ALTER / DROP in any statement', async () => {
    const h = createHarness();

    await h.call('relation_graph');
    await h.call('relation_graph', { table: 'users', depth: 3 });
    await h.call('find_join_path', { from: 'comments', to: 'orgs' });
    await h.call('find_join_path', { from: 'comments', to: 'audit_log' });
    await h.call('table_stats', { table: 'users' });
    await h.call('explain_error', { code: 'E008' });

    assert.ok(h.recorded.length > 0, 'the catalog tools must actually have queried something');

    const forbidden = /\b(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|TRUNCATE|GRANT|REVOKE|MERGE|COPY|VACUUM|ANALYZE)\b/i;
    for (const { sql } of h.recorded) {
      assert.equal(forbidden.test(sql), false, `statement is not read-only: ${sql}`);
      // Stronger than the keyword scan, which only catches what it lists: every
      // statement must be a SELECT or transaction control, full stop.
      assert.match(sql.trimStart(), /^(SELECT|BEGIN READ ONLY|COMMIT|ROLLBACK)\b/, `unexpected statement: ${sql}`);
    }

    // And every unit of work opened a READ ONLY transaction.
    const begins = h.recorded.filter((r) => r.sql === 'BEGIN READ ONLY');
    const commits = h.recorded.filter((r) => r.sql === 'COMMIT');
    assert.equal(begins.length, 5, 'one read-only transaction per catalog tool call (explain_error opens none)');
    assert.equal(commits.length, begins.length);
    await h.dispose();
  });
});
