/**
 * MCP server: `compile_query`, the build half of the ORM with the execute half
 * removed.
 *
 * Every `build*()` method on `QueryInterface` returns a `DeferredQuery` and
 * nothing runs until something executes it, so an agent can be shown the exact
 * statement its args produce, with the real parameter list, without touching a
 * row. These tests drive the REAL JSON-RPC line handler over a mock pool, the
 * same way mcp-agent-tools.test.ts and studio-write.test.ts do: real dispatch,
 * real metadata load, real relation derivation, real PII guard, real SQL.
 *
 * THE INVARIANT, and it is the one the whole tool rests on: NOTHING IS
 * EXECUTED. The pool below THROWS on any statement that is not a catalog read
 * or a transaction keyword, so a compiled SELECT reaching the driver fails the
 * test by construction rather than by an assertion someone has to remember to
 * write. `SEALED_POOL` closes the same hole one level down: the compile core
 * is handed a pool whose every method throws, so there is no live connection in
 * scope for a statement to escape down even in principle.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, it } from 'node:test';
import type pg from 'pg';
import { collectAggregateColumnNames, compileQueryPlan, SEALED_POOL } from '../cli/compile-query.js';
import { buildRelations, type McpServerOptions, startMcpServer } from '../cli/mcp.js';
import { generateMetadata } from '../generate.js';
import { type ColumnMetadata, type SchemaMetadata, snakeToCamel, type TableMetadata } from '../schema.js';
import { mockTable } from './helpers.js';

// ---------------------------------------------------------------------------
// Catalog fixture
//
//   orgs   <- users   <- posts <- comments        a 3-hop chain
//   users.email                                    PII-tagged (code-first)
//   users.api_key                                  secret-named
//   posts.author_id / comments.post_id             UNINDEXED probe columns
//   users.org_id                                   indexed probe column
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

const TABLE_NAMES = ['comments', 'orgs', 'posts', 'users'];

const COLUMNS: ColumnRow[] = [
  col('orgs', 'id'),
  col('orgs', 'name', 'text'),
  col('users', 'id'),
  col('users', 'org_id'),
  col('users', 'email', 'text'),
  col('users', 'api_key', 'text'),
  col('users', 'name', 'text'),
  col('posts', 'id'),
  col('posts', 'author_id'),
  col('posts', 'title', 'text'),
  col('posts', 'views'),
  col('comments', 'id'),
  col('comments', 'post_id'),
  col('comments', 'body', 'text'),
];

const PRIMARY_KEYS = [
  { table_name: 'orgs', column_name: 'id' },
  { table_name: 'users', column_name: 'id' },
  { table_name: 'posts', column_name: 'id' },
  { table_name: 'comments', column_name: 'id' },
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
  fk('2', 'posts', 'author_id', 'users'),
  fk('3', 'comments', 'post_id', 'posts'),
];

/**
 * `users.org_id` is indexed; `posts.author_id` and `comments.post_id` are not.
 * That asymmetry is the subject of the unindexed-probe advice test: with every
 * probe indexed the advice would never fire, and with none of them indexed a
 * blanket bug would look like a pass.
 */
const INDEX_ROWS: Record<string, unknown>[] = [
  {
    tablename: 'orgs',
    indexname: 'orgs_pkey',
    indexdef: 'CREATE UNIQUE INDEX orgs_pkey ON public.orgs USING btree (id)',
  },
  {
    tablename: 'users',
    indexname: 'users_pkey',
    indexdef: 'CREATE UNIQUE INDEX users_pkey ON public.users USING btree (id)',
  },
  {
    tablename: 'users',
    indexname: 'users_org_id_idx',
    indexdef: 'CREATE INDEX users_org_id_idx ON public.users USING btree (org_id)',
  },
  {
    tablename: 'posts',
    indexname: 'posts_pkey',
    indexdef: 'CREATE UNIQUE INDEX posts_pkey ON public.posts USING btree (id)',
  },
  {
    tablename: 'comments',
    indexname: 'comments_pkey',
    indexdef: 'CREATE UNIQUE INDEX comments_pkey ON public.comments USING btree (id)',
  },
];

const CLASS_ROWS: Record<string, unknown>[] = [
  { relname: 'users', reltuples: '1200', relpages: '48', total_size: '196608', table_size: '98304', index_count: '2' },
];

/** Catalog reads (and the read-only transaction wrapper) this tool is allowed to issue. */
function routeCatalog(sql: string): Record<string, unknown>[] | null {
  if (sql.includes('information_schema.tables')) return TABLE_NAMES.map((table_name) => ({ table_name }));
  if (sql.includes('information_schema.columns')) return COLUMNS as unknown as Record<string, unknown>[];
  if (sql.includes("'PRIMARY KEY'")) return PRIMARY_KEYS;
  if (sql.includes("con.contype = 'f'")) return FOREIGN_KEYS;
  if (sql.includes("'UNIQUE'")) return [];
  if (sql.includes('FROM pg_indexes')) return INDEX_ROWS;
  if (sql.includes('pg_enum')) return [];
  if (sql.includes('pg_total_relation_size')) return CLASS_ROWS;
  if (sql.includes('to_regclass')) return [{ exists: false }];
  if (/^(BEGIN READ ONLY|COMMIT|ROLLBACK)$/.test(sql.trim())) return [];
  if (sql.includes("set_config('statement_timeout'")) return [];
  if (sql.includes("set_config('search_path'")) return [];
  return null;
}

/**
 * A pool that answers CATALOG reads and THROWS on anything else.
 *
 * This is the "no query executed" assertion, expressed as the harness rather
 * than as a check at the end of one test: a compiled SELECT (or an EXPLAIN of
 * one, or a stray `SET`) reaching this driver from ANY compile_query test fails
 * that test with a message naming the statement.
 */
function makePool(recorded: Recorded[]): pg.Pool {
  const client = {
    query(sql: string, params?: unknown[]) {
      recorded.push({ sql, params });
      const rows = routeCatalog(sql);
      if (rows === null) {
        return Promise.reject(
          new Error(`compile_query executed a statement, which it must never do: <${sql.slice(0, 300)}>`),
        );
      }
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

function createHarness(options: Partial<McpServerOptions> = {}) {
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
    { input, output, pool: makePool(recorded) },
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

function compile(
  h: ReturnType<typeof createHarness>,
  table: string,
  args: Record<string, unknown> = {},
  operation?: string,
): Promise<ToolReply> {
  return h.call('compile_query', operation === undefined ? { table, args } : { table, operation, args });
}

interface CompiledPlan {
  relationLoadStrategy: { requested: string | null; effective: string; note: string };
  relationCount: number;
  relationDepth: number;
  relations: {
    path: string;
    name: string;
    type: string;
    to: string;
    depth: number;
    returnsArray: boolean;
    limit: number | null;
    unindexedProbe: { table: string; columns: string[]; createSql: string } | null;
  }[];
  relationsTruncated: boolean;
  hasWhere: boolean;
  hasOrderBy: boolean;
  bounded: boolean;
  limit: number | null;
  boundedBy: string | null;
  readsEveryRow: boolean;
}

function plan(result: Record<string, unknown>): CompiledPlan {
  return result.plan as CompiledPlan;
}

function adviceCodes(result: Record<string, unknown>): string[] {
  return (result.advice as { code: string }[]).map((entry) => entry.code);
}

// ---------------------------------------------------------------------------
// Generated-metadata fixture, so the code-first `pii` tag path is live
// ---------------------------------------------------------------------------

/** The fixture schema with `users.email` tagged, as `turbine generate` would emit it. */
function taggedSchema(): SchemaMetadata {
  const users = mockTable('users', [
    { name: 'id', field: 'id' },
    { name: 'org_id', field: 'orgId' },
    { name: 'email', field: 'email', pgType: 'text' },
    { name: 'api_key', field: 'apiKey', pgType: 'text' },
    { name: 'name', field: 'name', pgType: 'text' },
  ]);
  for (const column of users.columns) {
    if (column.name === 'email') column.pii = true;
  }
  return { tables: { users }, enums: {} };
}

function withMetadataDir(source: string, fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'turbine-mcp-compile-'));
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

/** The fixture as real SchemaMetadata, derived through the SAME relation builder the server uses. */
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

// ---------------------------------------------------------------------------

describe('mcp compile_query: nothing is executed', () => {
  it('compiles a findMany and never sends the compiled statement to the driver', async () => {
    const h = createHarness();
    const result = payload(await compile(h, 'posts', { where: { views: { gt: 10 } }, limit: 5 }));

    assert.equal(result.ok, true);
    assert.equal(result.executed, false);
    const sql = result.sql as string;
    assert.match(sql, /^SELECT .* FROM "posts"/);
    assert.match(sql, /WHERE "views" > \$1/);
    assert.match(sql, /LIMIT \$2/);

    // The compiled statement is not among the statements the driver saw, and no
    // statement the driver saw reads a fixture table.
    const seen = h.recorded.map((entry) => entry.sql);
    assert.ok(!seen.includes(sql), 'the compiled SQL must never reach the driver');
    assert.ok(
      seen.every((statement) => routeCatalog(statement) !== null),
      `only catalog reads may be issued, saw: ${JSON.stringify(seen.filter((s) => routeCatalog(s) === null))}`,
    );
    await h.dispose();
  });

  it('the compile core needs no pool at all: SEALED_POOL refuses every call', async () => {
    assert.throws(() => SEALED_POOL.query('SELECT 1'), /sealed pool/);
    assert.throws(() => SEALED_POOL.connect(), /sealed pool/);
    assert.throws(() => SEALED_POOL.end(), /sealed pool/);

    // ...and compiling through it still produces SQL, which is the whole point:
    // the build path provably does not read.
    const metadata = fixtureMetadata();
    const table = metadata.tables.posts;
    assert.ok(table);
    const report = compileQueryPlan({ metadata, table, operation: 'findMany', args: { limit: 1 } });
    assert.equal(report.ok, true);
    if (report.ok) assert.match(report.sql, /FROM "posts"/);
  });

  it('does not disguise a non-Turbine error as a query verdict', () => {
    const metadata = fixtureMetadata();
    const table = metadata.tables.posts;
    assert.ok(table);
    // Only a TurbineError is an ANSWER. Anything else is a bug or a malformed
    // request and has to propagate, or it would be reported to the agent as
    // "your query is invalid" when the query was fine.
    const args: Record<string, unknown> = {};
    Object.defineProperty(args, 'where', {
      enumerable: true,
      get() {
        throw new RangeError('not a Turbine failure');
      },
    });
    assert.throws(() => compileQueryPlan({ metadata, table, operation: 'findMany', args }), RangeError);
  });

  it('withholds a parameter it cannot serialize rather than throwing on it', () => {
    const metadata = fixtureMetadata();
    const table = metadata.tables.posts;
    assert.ok(table);
    // `JSON.stringify` throws on a BigInt, which the driver would nonetheless
    // bind happily. The echo must not take the whole reply down with it.
    const report = compileQueryPlan({ metadata, table, operation: 'findMany', args: { where: { views: 10n } } });
    assert.equal(report.ok, true);
    if (!report.ok) return;
    assert.equal(report.paramsTruncated, true);
    assert.deepEqual(report.params, ['(value withheld: not JSON-serializable)']);
  });
});

describe('mcp compile_query: what it reports', () => {
  it('describes a nested with clause: SQL, statement count, depth and per-relation shape', async () => {
    const h = createHarness();
    const result = payload(
      await compile(h, 'orgs', {
        with: { users: { limit: 3, with: { posts: true } } },
        limit: 10,
        relationLoadStrategy: 'join',
      }),
    );

    assert.equal(result.ok, true);
    assert.match(result.sql as string, /json_agg/);
    assert.deepEqual(result.statements, {
      compiled: 1,
      atExecution: 1,
      note: 'One statement: every relation is a correlated json_agg subquery inside the SELECT above.',
    });

    const p = plan(result);
    assert.equal(p.relationCount, 2);
    assert.equal(p.relationDepth, 2);
    assert.equal(p.relationsTruncated, false);
    assert.deepEqual(
      p.relations.map((relation) => [relation.path, relation.type, relation.to, relation.depth, relation.limit]),
      [
        ['users', 'hasMany', 'users', 1, 3],
        ['users.posts', 'hasMany', 'posts', 2, null],
      ],
    );
    assert.equal(p.relationLoadStrategy.requested, 'join');
    assert.equal(p.relationLoadStrategy.effective, 'join');
    assert.equal(p.bounded, true);
    assert.equal(p.limit, 10);
    assert.equal(p.boundedBy, 'limit');
    await h.dispose();
  });

  it('counts one follow-up statement per relation under batched, and refuses to guess under auto', async () => {
    const h = createHarness();
    const batched = payload(
      await compile(h, 'orgs', { with: { users: { with: { posts: true } } }, relationLoadStrategy: 'batched' }),
    );
    const batchedStatements = batched.statements as { compiled: number; atExecution: number | null };
    assert.equal(batchedStatements.compiled, 1);
    assert.equal(batchedStatements.atExecution, 3);

    // No strategy named: the client default is `auto`, whose per-relation split
    // is decided at execute time, so the count is reported as unknown rather
    // than as a number that happens to be wrong.
    const auto = payload(await compile(h, 'orgs', { with: { users: true } }));
    const autoStatements = auto.statements as { atExecution: number | null; note: string };
    assert.equal(autoStatements.atExecution, null);
    assert.match(autoStatements.note, /Between 1 and 2/);
    assert.equal(plan(auto).relationLoadStrategy.effective, 'auto');
    assert.equal(plan(auto).relationLoadStrategy.requested, null);
    await h.dispose();
  });

  it('echoes the bound parameters the caller supplied, in order', async () => {
    const h = createHarness();
    const result = payload(
      await compile(h, 'posts', { where: { title: { contains: 'draft' }, views: { gte: 2 } }, limit: 7 }),
    );
    assert.equal(result.paramCount, 3);
    assert.deepEqual(result.params, ['%draft%', 2, 7]);
    assert.equal(result.paramsTruncated, false);
    await h.dispose();
  });

  it('summarizes an oversized parameter instead of dropping it, so $N still lines up', async () => {
    const h = createHarness();
    const long = 'x'.repeat(5000);
    const result = payload(await compile(h, 'posts', { where: { title: long }, limit: 1 }));
    assert.equal(result.paramCount, 2);
    assert.equal(result.paramsTruncated, true);
    const params = result.params as unknown[];
    assert.equal(params.length, 2, 'a withheld value keeps its slot');
    assert.match(String(params[0]), /truncated, 5000 chars/);
    assert.equal(params[1], 1);
    await h.dispose();
  });

  it('flags an unbounded read, a filterless scan and an unindexed relation probe', async () => {
    const h = createHarness();
    const result = payload(await compile(h, 'users', { with: { posts: true }, relationLoadStrategy: 'join' }));

    const codes = adviceCodes(result);
    assert.ok(codes.includes('unbounded-read'), `expected unbounded-read, got ${codes.join(', ')}`);
    assert.ok(codes.includes('no-filter'), `expected no-filter, got ${codes.join(', ')}`);
    assert.ok(codes.includes('unindexed-relation-probe'), `expected unindexed probe, got ${codes.join(', ')}`);

    const probe = plan(result).relations[0]?.unindexedProbe;
    assert.ok(probe, 'posts.author_id has no index in the fixture');
    assert.equal(probe.table, 'posts');
    assert.deepEqual(probe.columns, ['author_id']);
    assert.match(probe.createSql, /CREATE INDEX .* ON "posts" \("author_id"\)/);
    await h.dispose();
  });

  it('reports an indexed probe as indexed, so the warning means something', async () => {
    const h = createHarness();
    // users.org -> orgs is a belongsTo probing orgs(id), the primary key.
    const result = payload(await compile(h, 'users', { with: { org: true }, limit: 1 }));
    assert.equal(plan(result).relations[0]?.unindexedProbe, null);
    assert.ok(!adviceCodes(result).includes('unindexed-relation-probe'));
    assert.ok(!adviceCodes(result).includes('unbounded-read'));
    await h.dispose();
  });

  it('reports whether the shape executes as a named or an unnamed prepared statement', async () => {
    const h = createHarness();
    const fixedShape = payload(await compile(h, 'posts', { where: { views: 1 }, limit: 1 }));
    const named = fixedShape.preparedStatement as { named: boolean; name: string | null };
    assert.equal(named.named, true);
    assert.match(String(named.name), /^t_[0-9a-f]{16}$/);

    // A caller-written OR ARRAY writes its LENGTH into the SQL text, so the
    // shape is variable-arity and must execute unnamed.
    const variable = payload(await compile(h, 'posts', { where: { OR: [{ views: 1 }, { views: 2 }] }, limit: 1 }));
    const unnamed = variable.preparedStatement as { named: boolean; name: string | null };
    assert.equal(unnamed.named, false);
    assert.equal(unnamed.name, null);
    assert.ok(adviceCodes(variable).includes('unnamed-prepared-statement'));
    await h.dispose();
  });

  it('compiles findFirst as a LIMIT 1 read and says what bounds it', async () => {
    const h = createHarness();
    const result = payload(await compile(h, 'posts', { where: { views: 1 } }, 'findFirst'));
    assert.equal(result.ok, true);
    assert.match(result.sql as string, /LIMIT \$2/);
    assert.equal(plan(result).boundedBy, 'findFirst (LIMIT 1)');
    // A findFirst is bounded by construction, so it never draws the
    // unbounded-read warning a findMany with the same where would.
    assert.ok(!adviceCodes(result).includes('unbounded-read'));
    await h.dispose();
  });

  it('warns about an unbounded findMany even when it is filtered', async () => {
    const h = createHarness();
    const result = payload(await compile(h, 'posts', { where: { views: { gt: 1 } } }));
    const unbounded = (result.advice as { code: string; message: string }[]).find(
      (entry) => entry.code === 'unbounded-read',
    );
    assert.ok(unbounded);
    assert.match(unbounded.message, /every row matching the filter/);
    // The filterless-scan note does NOT fire: there IS a predicate here.
    assert.ok(!adviceCodes(result).includes('no-filter'));
    await h.dispose();
  });

  it('says a `with` clause costs no extra statement on an aggregate-shaped read', async () => {
    const h = createHarness();
    const result = payload(await compile(h, 'orgs', { with: { users: true } }, 'count'));
    assert.deepEqual(result.statements, {
      compiled: 1,
      atExecution: 1,
      note: 'A count loads no relations, so a `with` clause here does not add statements.',
    });
    await h.dispose();
  });

  it('describes the flatten plan as one statement with a silent per-relation fallback', async () =>
    quietStderr(async () => {
      const h = createHarness();
      const result = payload(
        await compile(h, 'posts', { with: { user: true }, relationLoadStrategy: 'flatten', limit: 1 }),
      );
      const statements = result.statements as { atExecution: number; note: string };
      assert.equal(statements.atExecution, 1);
      assert.match(statements.note, /LEFT JOIN/);
      assert.equal(plan(result).relationLoadStrategy.effective, 'flatten');
      await h.dispose();
    }));

  it('warns when the with clause is nested deeper than the join plan can carry cheaply', async () =>
    quietStderr(async () => {
      const h = createHarness();
      const result = payload(
        await compile(h, 'orgs', {
          with: {
            users: {
              with: { posts: { with: { comments: { with: { post: { with: { user: { with: { org: true } } } } } } } } },
            },
          },
          limit: 1,
        }),
      );
      assert.equal(plan(result).relationDepth, 6);
      const deep = (result.advice as { code: string; message: string }[]).find((entry) => entry.code === 'deep-with');
      assert.ok(deep, `expected deep-with, got ${adviceCodes(result).join(', ')}`);
      assert.match(deep.message, /6 levels deep/);
      await h.dispose();
    }));

  it('compiles count, aggregate and groupBy, and never a write', async () => {
    const h = createHarness();

    const counted = payload(await compile(h, 'posts', { where: { views: { gt: 1 } } }, 'count'));
    assert.match(counted.sql as string, /^SELECT .*COUNT\(\*\)/);
    assert.equal(plan(counted).bounded, true);

    const aggregated = payload(await compile(h, 'posts', { _count: true, _avg: { views: true } }, 'aggregate'));
    assert.match(aggregated.sql as string, /AVG\("views"\)/);

    const grouped = payload(
      await compile(h, 'posts', { by: ['authorId'], _count: true, orderBy: { _count: 'desc' } }, 'groupBy'),
    );
    assert.match(grouped.sql as string, /GROUP BY "author_id"/);

    for (const operation of ['create', 'update', 'delete', 'upsert', 'updateMany', 'deleteMany']) {
      const reply = await compile(h, 'posts', { data: { title: 'x' } }, operation);
      assert.equal(reply.result, undefined, `${operation} must not compile`);
      assert.equal(reply.error?.code, -32602);
      assert.match(String(reply.error?.message), /operation must be one of/);
    }
    await h.dispose();
  });
});

describe('mcp compile_query: a failed compile is an answer', () => {
  it('returns TURBINE_E003 for an unknown column as a successful tool result', async () => {
    const h = createHarness();
    const result = payload(await compile(h, 'posts', { where: { titel: 'x' } }));

    assert.equal(result.ok, false);
    const error = result.error as Record<string, unknown>;
    assert.equal(error.code, 'TURBINE_E003');
    assert.equal(error.className, 'ValidationError');
    assert.match(String(error.message), /titel/);
    assert.match(String(error.docsUrl), /turbineorm\.dev\/errors#e003$/);
    assert.ok(Array.isArray(error.howToFix) && error.howToFix.length > 0, 'the catalog fix list is folded in');
    await h.dispose();
  });

  it('returns TURBINE_E005 for an unknown relation, not a transport error', async () => {
    const h = createHarness();
    const reply = await compile(h, 'posts', { with: { autor: true } });
    assert.equal(reply.error, undefined, 'an unknown relation is an answer, not a JSON-RPC failure');
    const result = payload(reply);
    assert.equal(result.ok, false);
    assert.equal((result.error as Record<string, unknown>).code, 'TURBINE_E005');
    await h.dispose();
  });

  it('returns the empty-where guard (E003) for a findUnique with no predicate', async () => {
    const h = createHarness();
    const result = payload(await compile(h, 'posts', { where: { id: undefined } }, 'findUnique'));
    assert.equal(result.ok, false);
    assert.equal((result.error as Record<string, unknown>).code, 'TURBINE_E003');
    await h.dispose();
  });

  it('compiles a findUnique that does carry a predicate', async () => {
    const h = createHarness();
    const result = payload(await compile(h, 'posts', { where: { id: 7 } }, 'findUnique'));
    assert.equal(result.ok, true);
    assert.match(result.sql as string, /WHERE "id" = \$1/);
    assert.deepEqual(result.params, [7]);
    assert.equal(plan(result).boundedBy, 'findUnique (a unique where matches one row)');
    await h.dispose();
  });
});

describe('mcp compile_query: the PII guard', () => {
  it('refuses a where on a PII-tagged column', async () =>
    quietStderr(async () => {
      await withMetadataDir(TAGGED_METADATA(), async (metadataDir) => {
        const h = createHarness({ metadataDir });
        const reply = await compile(h, 'users', { where: { email: { startsWith: 'a' } } });
        assert.equal(reply.result, undefined);
        assert.equal(reply.error?.code, -32602);
        assert.match(String(reply.error?.message), /"email" on "users" is PII-tagged/);
        await h.dispose();
      });
    }));

  it('refuses an orderBy on a secret-named column with no generated metadata at all', async () =>
    quietStderr(async () => {
      const h = createHarness();
      const reply = await compile(h, 'users', { orderBy: { apiKey: 'asc' }, limit: 1 });
      assert.equal(reply.result, undefined);
      assert.match(String(reply.error?.message), /"api_key" on "users" has a secret-looking name/);
      await h.dispose();
    }));

  it('refuses a hidden column named through a relation, one level down', async () =>
    quietStderr(async () => {
      await withMetadataDir(TAGGED_METADATA(), async (metadataDir) => {
        const h = createHarness({ metadataDir });
        // `posts.author_id -> users` derives the relation name `user`.
        const reply = await compile(h, 'posts', { where: { user: { is: { email: 'x@example.com' } } } });
        assert.equal(reply.result, undefined);
        assert.match(String(reply.error?.message), /"email" on "users" is PII-tagged/);
        await h.dispose();
      });
    }));

  it('refuses a hidden column as a groupBy key, where the shared walker cannot reach', async () =>
    quietStderr(async () => {
      await withMetadataDir(TAGGED_METADATA(), async (metadataDir) => {
        const h = createHarness({ metadataDir });
        const reply = await compile(h, 'users', { by: ['email'], _count: true }, 'groupBy');
        assert.equal(reply.result, undefined);
        assert.match(String(reply.error?.message), /cannot be used as a group key/);
        await h.dispose();
      });
    }));

  it('refuses a hidden column as an aggregate target', async () =>
    quietStderr(async () => {
      const h = createHarness();
      const reply = await compile(h, 'users', { _max: { apiKey: true } }, 'aggregate');
      assert.equal(reply.result, undefined);
      assert.match(String(reply.error?.message), /has a secret-looking name/);
      await h.dispose();
    }));

  it('allows a hidden column in select, which returns no value here at all', async () =>
    quietStderr(async () => {
      await withMetadataDir(TAGGED_METADATA(), async (metadataDir) => {
        const h = createHarness({ metadataDir });
        const result = payload(await compile(h, 'users', { select: { id: true, email: true }, limit: 1 }));
        assert.equal(result.ok, true);
        assert.match(result.sql as string, /"email"/);
        await h.dispose();
      });
    }));

  it('compiles the core PII projection rule, so an unqualified read cannot pull a tagged column', async () =>
    quietStderr(async () => {
      await withMetadataDir(TAGGED_METADATA(), async (metadataDir) => {
        const h = createHarness({ metadataDir });
        const result = payload(await compile(h, 'users', { limit: 1 }));
        assert.equal(result.ok, true);
        // The tag is enforced at the SQL level by core, and this tool shows the
        // real statement, so the absence of `email` here is the ORM's own
        // default projection rather than anything this file does.
        assert.ok(
          !(result.sql as string).includes('"email"'),
          `default projection must omit a PII column: ${result.sql}`,
        );
        assert.match(
          result.sql as string,
          /"api_key"/,
          'a secret-NAMED column is not a core tag, so core still selects it',
        );
        await h.dispose();
      });
    }));

  it('fails closed when the generated metadata exists and cannot be parsed', async () =>
    quietStderr(async () => {
      await withMetadataDir(UNREADABLE_METADATA, async (metadataDir) => {
        const h = createHarness({ metadataDir });
        const refused = await compile(h, 'posts', { where: { views: 1 } });
        assert.equal(refused.result, undefined);
        assert.match(String(refused.error?.message), /PII tags could not be read/);

        // A compile that names no column is still answerable.
        const allowed = payload(await compile(h, 'posts', { limit: 1 }));
        assert.equal(allowed.ok, true);
        await h.dispose();
      });
    }));

  it('refuses a query shape the guard does not recognize rather than compiling it', async () => {
    const h = createHarness();
    const reply = await compile(h, 'posts', { where: { user: { lurking: { email: 'x' } } } });
    assert.equal(reply.result, undefined);
    assert.match(String(reply.error?.message), /does not recognize "lurking"/);
    await h.dispose();
  });
});

describe('mcp compile_query: request surface', () => {
  it('is advertised by tools/list with a read-only, no-execution description', async () => {
    const h = createHarness();
    const reply = (await h.rpc('tools/list')) as unknown as {
      result: { tools: { name: string; description: string; inputSchema: Record<string, unknown> }[] };
    };
    const tool = reply.result.tools.find((entry) => entry.name === 'compile_query');
    assert.ok(tool, 'compile_query must be advertised');
    assert.match(tool.description, /WITHOUT running it/);
    assert.match(tool.description, /READ OPERATIONS ONLY/);
    const properties = tool.inputSchema.properties as Record<string, { enum?: string[] }>;
    assert.deepEqual(properties.operation?.enum, [
      'findMany',
      'findUnique',
      'findFirst',
      'count',
      'aggregate',
      'groupBy',
    ]);
    await h.dispose();
  });

  it('rejects free-form SQL by naming the surface that does not exist', async () => {
    const h = createHarness();
    const reply = await h.call('compile_query', { table: 'posts', sql: 'SELECT 1' });
    assert.equal(reply.error?.code, -32602);
    assert.match(String(reply.error?.message), /never accepts SQL; it PRODUCES it/);
    await h.dispose();
  });

  it('rejects a non-object args and an unknown table', async () => {
    const h = createHarness();
    const badArgs = await h.call('compile_query', { table: 'posts', args: 42 });
    assert.match(String(badArgs.error?.message), /args must be an object/);

    const badTable = await compile(h, 'nope');
    assert.match(String(badTable.error?.message), /Unknown table "nope"/);
    await h.dispose();
  });

  it('defaults to findMany and to empty args', async () => {
    const h = createHarness();
    const result = payload(await h.call('compile_query', { table: 'orgs' }));
    assert.equal(result.operation, 'findMany');
    assert.equal(result.ok, true);
    assert.equal(plan(result).hasWhere, false);
    assert.equal(plan(result).readsEveryRow, true);
    await h.dispose();
  });
});

describe('compile-query: the aggregate name harvest', () => {
  it('harvests keys and string values from every aggregate position except where', () => {
    const names = collectAggregateColumnNames({
      where: { secretColumn: 1 },
      by: ['region', { field: 'payload', path: ['a'], alias: 'k' }],
      _min: { email: true },
      having: { _count: { gt: 5 } },
      orderBy: { _count: 'desc' },
    });
    // Every position a column name can occupy: a `by` array element, a JSON
    // group key's `field`, an aggregate block key, a HAVING key, an orderBy key.
    for (const expected of ['region', 'payload', 'email', '_count']) {
      assert.ok(names.includes(expected), `expected the harvest to include "${expected}"`);
    }
    // Values are harvested too, since `by`'s and `pick.by`'s column names live
    // there rather than in a key.
    for (const expected of ['a', 'k', 'desc']) {
      assert.ok(names.includes(expected), `expected the harvest to include the value "${expected}"`);
    }
    assert.ok(!names.includes('secretColumn'), '`where` is left to the shared walker');
    // The TOP-LEVEL arg keys are not column positions, so they are not harvested
    // and cannot produce a false refusal on a table with a column named `by`.
    assert.ok(!names.includes('by'), 'a top-level arg key is not a column position');
    assert.ok(!names.includes('orderBy'), 'a top-level arg key is not a column position');
  });

  it('refuses a pathologically nested args object rather than walking off its own stack', () => {
    let nested: Record<string, unknown> = { by: ['x'] };
    for (let i = 0; i < 200; i++) nested = { _min: nested };
    assert.throws(() => collectAggregateColumnNames(nested), /nested more than 32 levels deep/);
  });
});
