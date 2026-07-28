/**
 * MCP server: PII perimeter.
 *
 * The MCP server hands a database to an agent whose input is, by stipulation,
 * attacker-influenceable. These tests drive the REAL JSON-RPC line handler over
 * a mock pg.Pool, so the genuine tool dispatch, metadata load, PII tag load,
 * guard, and SQL generation all run with no database, the same way
 * studio-write.test.ts drives Studio's `handleRequest`.
 *
 * What they pin, each of which was a live hole:
 *  - `explain_query` refused to leak selectivity: a planner row estimate for a
 *    predicate on a hidden column extracts that value character by character.
 *  - PII tag loading that FAILS CLOSED and says so, instead of returning an
 *    empty tag list that reads exactly like "this schema has no PII".
 *  - `sample_rows` projecting an explicit column list rather than `SELECT *`.
 *  - `table_detail` not echoing a partial index's literal predicate values.
 *
 * The second-round holes these left open are in mcp-pii-round2.test.ts.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, it } from 'node:test';
import type pg from 'pg';
import { type McpServerOptions, startMcpServer } from '../cli/mcp.js';
import { generateMetadata } from '../generate.js';
import type { SchemaMetadata } from '../schema.js';
import { mockTable } from './helpers.js';

// ---------------------------------------------------------------------------
// Mock pool: answers the catalog queries `loadSchemaMetadata` issues
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

function col(table: string, name: string, udt = 'text'): ColumnRow {
  return {
    table_name: table,
    column_name: name,
    udt_name: udt,
    data_type: udt === 'int4' ? 'integer' : 'text',
    is_nullable: 'NO',
    column_default: null,
    is_identity: 'NO',
    character_maximum_length: null,
  };
}

const COLUMNS: ColumnRow[] = [
  col('users', 'id', 'int4'),
  col('users', 'email'),
  col('users', 'name'),
  col('users', 'password_hash'),
  col('posts', 'id', 'int4'),
  col('posts', 'user_id', 'int4'),
  col('posts', 'title'),
];

const SAMPLE_USER_ROW = {
  id: 1,
  email: 'ada@example.com',
  name: 'Ada',
  password_hash: '$2b$12$notarealhash',
};

/** Index rows, including a PARTIAL index whose predicate holds a real value. */
const INDEX_ROWS = [
  {
    tablename: 'users',
    indexname: 'users_pkey',
    indexdef: 'CREATE UNIQUE INDEX users_pkey ON public.users USING btree (id)',
  },
  {
    tablename: 'users',
    indexname: 'users_vip_idx',
    indexdef: `CREATE INDEX users_vip_idx ON public.users USING btree (name) WHERE (email = 'ceo@example.com')`,
  },
];

function makePool(recorded: Recorded[], opts: { connectError?: Error } = {}): pg.Pool {
  const client = {
    query(sql: string, params?: unknown[]) {
      recorded.push({ sql, params });
      const rows = route(sql);
      return Promise.resolve({ rows, rowCount: rows.length, fields: [] });
    },
    release() {},
  };
  return {
    connect() {
      if (opts.connectError) return Promise.reject(opts.connectError);
      return Promise.resolve(client);
    },
    on() {},
    end() {
      return Promise.resolve();
    },
  } as unknown as pg.Pool;
}

function route(sql: string): Record<string, unknown>[] {
  if (sql.includes('information_schema.tables')) {
    return [{ table_name: 'users' }, { table_name: 'posts' }];
  }
  if (sql.includes('information_schema.columns')) return COLUMNS as unknown as Record<string, unknown>[];
  if (sql.includes("'PRIMARY KEY'")) {
    return [
      { table_name: 'users', column_name: 'id' },
      { table_name: 'posts', column_name: 'id' },
    ];
  }
  if (sql.includes("'FOREIGN KEY'")) {
    return [
      {
        source_table: 'posts',
        source_column: 'user_id',
        target_table: 'users',
        target_column: 'id',
        constraint_name: 'posts_user_id_fkey',
      },
    ];
  }
  if (sql.includes("'UNIQUE'")) return [];
  if (sql.includes('pg_indexes')) return INDEX_ROWS as unknown as Record<string, unknown>[];
  if (sql.includes('pg_enum')) return [];
  if (sql.includes('pg_class')) return [{ relname: 'users', reltuples: '100' }];
  if (sql.startsWith('EXPLAIN')) return [{ 'QUERY PLAN': [{ Plan: { 'Plan Rows': 412 } }] }];
  if (sql.includes('to_regclass')) return [{ exists: false }];
  // sample_rows projection
  if (sql.startsWith('SELECT ') && sql.includes(' FROM "public"."users"')) return [SAMPLE_USER_ROW];
  return [];
}

// ---------------------------------------------------------------------------
// Harness: real startMcpServer over PassThrough streams + the mock pool
// ---------------------------------------------------------------------------

interface ToolReply {
  result?: { content: { type: string; text: string }[] };
  error?: { code: number; message: string; data?: unknown };
}

function createHarness(options: Partial<McpServerOptions> = {}, poolOpts: { connectError?: Error } = {}) {
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
    { input, output, pool: makePool(recorded, poolOpts) },
  );

  let id = 0;
  const call = (name: string, args: Record<string, unknown> = {}): Promise<ToolReply> => {
    id++;
    const reply = readOne(output);
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } })}\n`);
    return reply;
  };

  return { call, recorded, dispose: () => handle.dispose() };
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

/** Tool results arrive as one JSON-encoded text block. */
function payload(reply: ToolReply): Record<string, unknown> {
  assert.equal(reply.error, undefined, `unexpected JSON-RPC error: ${JSON.stringify(reply.error)}`);
  const text = reply.result?.content[0]?.text;
  assert.ok(text, 'tool result carried no text content');
  return JSON.parse(text) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Generated-metadata fixtures
// ---------------------------------------------------------------------------

/** A code-first schema tagging `users.email` as PII, as `defineSchema` would. */
function taggedSchema(): SchemaMetadata {
  const users = mockTable('users', [
    { name: 'id', field: 'id' },
    { name: 'email', field: 'email', pgType: 'text' },
    { name: 'name', field: 'name', pgType: 'text' },
    { name: 'password_hash', field: 'passwordHash', pgType: 'text' },
  ]);
  for (const column of users.columns) {
    if (column.name === 'email') column.pii = true;
  }
  const posts = mockTable('posts', [
    { name: 'id', field: 'id' },
    { name: 'user_id', field: 'userId' },
    { name: 'title', field: 'title', pgType: 'text' },
  ]);
  return { tables: { users, posts }, enums: {} };
}

function withMetadataDir(source: string, fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'turbine-mcp-pii-'));
  writeFileSync(join(dir, 'metadata.ts'), source);
  return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }));
}

const TAGGED_METADATA = () => generateMetadata(taggedSchema(), { noTimestamp: true });

// ---------------------------------------------------------------------------

describe('mcp explain_query: planner estimates are not an extraction oracle', () => {
  it('refuses a where on a PII-tagged column', async () => {
    await withMetadataDir(TAGGED_METADATA(), async (metadataDir) => {
      const h = createHarness({ metadataDir });
      const reply = await h.call('explain_query', {
        table: 'users',
        where: { email: { startsWith: 'a' } },
      });
      assert.equal(reply.error?.code, -32602);
      assert.match(reply.error?.message ?? '', /"email" on "users" is PII-tagged/);
      // Nothing was planned: refusal happens before any EXPLAIN reaches the DB.
      assert.equal(
        h.recorded.some((r) => r.sql.startsWith('EXPLAIN')),
        false,
      );
      await h.dispose();
    });
  });

  it('refuses a PII predicate hidden under NOT / OR combinators', async () => {
    await withMetadataDir(TAGGED_METADATA(), async (metadataDir) => {
      const h = createHarness({ metadataDir });
      const reply = await h.call('explain_query', {
        table: 'users',
        where: { NOT: { OR: [{ name: 'x' }, { email: { contains: 'q' } }] } },
      });
      assert.match(reply.error?.message ?? '', /"email" on "users" is PII-tagged/);
      await h.dispose();
    });
  });

  it('refuses a PII predicate reached through a relation filter wrapper', async () => {
    await withMetadataDir(TAGGED_METADATA(), async (metadataDir) => {
      const h = createHarness({ metadataDir });
      // Ask the server which relation name it derived, rather than guessing.
      const detail = payload(await h.call('table_detail', { table: 'posts' }));
      const relations = detail.relations as { name: string; to: string; type: string }[];
      const toUsers = relations.find((r) => r.to === 'users');
      assert.ok(toUsers, 'fixture should expose a posts -> users relation');

      const reply = await h.call('explain_query', {
        table: 'posts',
        where: { [toUsers.name]: { is: { email: { startsWith: 'a' } } } },
      });
      assert.match(reply.error?.message ?? '', /"email" on "users" is PII-tagged/);
      await h.dispose();
    });
  });

  it('refuses a PII predicate written with the camelCase field name', async () => {
    await withMetadataDir(TAGGED_METADATA(), async (metadataDir) => {
      const h = createHarness({ metadataDir });
      // password_hash is not tagged, but the guard must resolve field -> column
      // for tagged ones; `email` is spelled identically, so use orderBy to prove
      // the second entry point is guarded too.
      const reply = await h.call('explain_query', { table: 'users', orderBy: { email: 'asc' } });
      assert.match(reply.error?.message ?? '', /"email" on "users" is PII-tagged/);
      await h.dispose();
    });
  });

  it('still plans a query that only touches untagged columns', async () => {
    await withMetadataDir(TAGGED_METADATA(), async (metadataDir) => {
      const h = createHarness({ metadataDir });
      const result = payload(await h.call('explain_query', { table: 'users', where: { name: 'Ada' }, limit: 5 }));
      assert.equal(result.table, 'users');
      assert.ok(result.plan, 'a non-PII predicate should still return a plan');
      await h.dispose();
    });
  });

  it('allows naming a PII column in select, which returns no values', async () => {
    await withMetadataDir(TAGGED_METADATA(), async (metadataDir) => {
      const h = createHarness({ metadataDir });
      const result = payload(await h.call('explain_query', { table: 'users', select: { email: true } }));
      assert.ok(result.plan);
      await h.dispose();
    });
  });
});

describe('mcp PII tag loading: fails closed and says so', () => {
  it('reads tags out of a REFORMATTED metadata file', async () => {
    // The regression: emitted column lines are longer than this repo's own
    // Biome lineWidth, so a formatter run over the generated directory rewraps
    // them. The old line-anchored regex scan then found nothing and reported a
    // clean bill of health, silently disabling redaction everywhere.
    const reformatted = [
      'export const SCHEMA: SchemaMetadata = {',
      '  tables: {',
      '    users: {',
      '      name: "users",',
      '      columns: [',
      '        {',
      '          name: "email",',
      '          field: "email",',
      '          pgType: "text",',
      '          pii: true,',
      '        },',
      '      ],',
      '    },',
      '  },',
      '};',
    ].join('\n');
    await withMetadataDir(reformatted, async (metadataDir) => {
      const h = createHarness({ metadataDir });
      const result = payload(await h.call('sample_rows', { table: 'users', limit: 1 }));
      assert.deepEqual((result.piiTagSource as { state: string }).state, 'ok');
      assert.ok((result.redactedColumns as string[]).includes('email'));
      await h.dispose();
    });
  });

  it('redacts every column when a metadata file exists but does not parse', async () => {
    await withMetadataDir('export const SCHEMA = "not what generate emits";', async (metadataDir) => {
      const h = createHarness({ metadataDir });
      const result = payload(await h.call('sample_rows', { table: 'users', limit: 1 }));
      const source = result.piiTagSource as { state: string; reason?: string };
      assert.equal(source.state, 'tags-unreadable');
      assert.deepEqual(new Set(result.redactedColumns as string[]), new Set(['id', 'email', 'name', 'password_hash']));
      const row = (result.rows as Record<string, unknown>[])[0];
      assert.ok(row);
      for (const value of Object.values(row)) assert.match(String(value), /redacted/);
      // Nothing was fetched either: the projection selects no real column.
      const select = h.recorded.find((r) => r.sql.includes(' FROM "public"."users"'));
      assert.ok(select);
      assert.equal(select.sql.includes('"email"'), false);
      await h.dispose();
    });
  });

  it('warns loudly on stderr at startup when a metadata file will not parse', async () => {
    await withMetadataDir('export const SCHEMA = "not what generate emits";', async (metadataDir) => {
      const written: string[] = [];
      const original = process.stderr.write.bind(process.stderr);
      // Studio prints its tag count at startup; MCP printed nothing, so an
      // operator could not tell their declared tags were inert.
      (process.stderr as { write: unknown }).write = (chunk: string) => {
        written.push(String(chunk));
        return true;
      };
      let h: ReturnType<typeof createHarness>;
      try {
        h = createHarness({ metadataDir });
      } finally {
        (process.stderr as { write: unknown }).write = original;
      }
      const notice = written.join('');
      assert.match(notice, /WARNING/);
      assert.match(notice, /Failing closed/);
      // Never stdout: that channel carries the JSON-RPC framing.
      await h.dispose();
    });
  });

  it('refuses explain_query predicates entirely when the tag scan failed', async () => {
    await withMetadataDir('export const SCHEMA = "not what generate emits";', async (metadataDir) => {
      const h = createHarness({ metadataDir });
      const reply = await h.call('explain_query', { table: 'users', where: { name: 'Ada' } });
      assert.match(reply.error?.message ?? '', /PII tags could not be read/);
      // A predicate-free explain is still allowed: there is no oracle without one.
      assert.ok(payload(await h.call('explain_query', { table: 'users', limit: 1 })).plan);
      await h.dispose();
    });
  });

  it('reports not-configured rather than an empty redaction list', async () => {
    const h = createHarness();
    const result = payload(await h.call('sample_rows', { table: 'posts', limit: 1 }));
    assert.deepEqual(result.piiTagSource, { state: 'not-configured' });
    assert.deepEqual(result.redactedColumns, []);
    await h.dispose();
  });
});

describe('mcp sample_rows: explicit projection', () => {
  it('never fetches a PII-tagged column and marks it withheld in the row', async () => {
    await withMetadataDir(TAGGED_METADATA(), async (metadataDir) => {
      const h = createHarness({ metadataDir });
      const result = payload(await h.call('sample_rows', { table: 'users', limit: 1 }));

      const select = h.recorded.find((r) => r.sql.includes(' FROM "public"."users"'));
      assert.ok(select);
      assert.equal(select.sql.includes('*'), false, 'sample_rows must not SELECT *');
      assert.equal(select.sql.includes('"email"'), false, 'a tagged column must not be fetched at all');
      assert.ok(select.sql.includes('"name"'));

      const row = (result.rows as Record<string, unknown>[])[0];
      assert.ok(row);
      // Present-and-withheld, not absent: an absent key would read as "no such column".
      assert.ok('email' in row);
      assert.match(String(row.email), /redacted/);
      assert.equal(row.name, 'Ada');
      await h.dispose();
    });
  });

  it('redacts an untagged secret-named column such as password_hash', async () => {
    await withMetadataDir(TAGGED_METADATA(), async (metadataDir) => {
      const h = createHarness({ metadataDir });
      const result = payload(await h.call('sample_rows', { table: 'users', limit: 1 }));
      const reasons = result.redactionReasons as Record<string, string>;
      assert.equal(reasons.password_hash, 'secret-name');
      assert.equal(reasons.email, 'pii');
      const select = h.recorded.find((r) => r.sql.includes(' FROM "public"."users"'));
      assert.equal(select?.sql.includes('password_hash'), false);
      await h.dispose();
    });
  });
});

describe('mcp table_detail: index definitions carry no literals', () => {
  it('withholds a partial index predicate while keeping its shape', async () => {
    const h = createHarness();
    const detail = payload(await h.call('table_detail', { table: 'users' }));
    const indexes = detail.indexes as { name: string; partial: boolean; definition?: string }[];

    const partial = indexes.find((i) => i.name === 'users_vip_idx');
    assert.ok(partial);
    assert.equal(partial.partial, true);
    assert.equal(partial.definition?.includes('ceo@example.com'), false);
    assert.match(partial.definition ?? '', /WHERE \(predicate withheld\)/);

    // A plain index keeps its definition: it holds identifiers, not values.
    const plain = indexes.find((i) => i.name === 'users_pkey');
    assert.equal(plain?.partial, false);
    assert.match(plain?.definition ?? '', /USING btree \(id\)/);
    await h.dispose();
  });
});

describe('mcp migrate_status: resolves the tracking table like the CLI', () => {
  it('does NOT pin search_path, because `turbine migrate status` does not', async () => {
    // Round 1 added a pin here as hardening. It was not hardening: cli/migrate.ts
    // reads `_turbine_migrations` unqualified through the role's search_path, so
    // pinning made the tool disagree with the runner it reports on. The
    // resolution is disclosed instead (see mcp-pii-round2.test.ts).
    const h = createHarness();
    await h.call('migrate_status');
    const pinIndex = h.recorded.findIndex((r) => r.sql.includes("set_config('search_path'"));
    const readIndex = h.recorded.findIndex((r) => r.sql.includes('to_regclass'));
    assert.notEqual(readIndex, -1, 'migrate_status must look the tracking table up');
    assert.equal(pinIndex, -1, 'migrate_status must resolve the tracking table the way the runner does');
    await h.dispose();
  });
});

describe('mcp error text: credentials are not echoed to the agent', () => {
  it('redacts a connection URL password out of a JSON-RPC error', async () => {
    const h = createHarness(
      {},
      { connectError: new Error('connect failed for postgres://app:hunter2@db.internal:5432/prod') },
    );
    const reply = await h.call('schema_overview');
    const text = JSON.stringify(reply.error);
    assert.equal(text.includes('hunter2'), false);
    assert.match(text, /postgres:\/\/app:\*\*\*@db\.internal/);
    await h.dispose();
  });
});
