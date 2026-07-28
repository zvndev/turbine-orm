/**
 * MCP server: second-round PII perimeter holes.
 *
 * Round 1 closed part of each of these. What survived, and what this file pins:
 *
 *  - `explain_query` refused a predicate only on a code-first `pii` tag, while
 *    `sample_rows` ALSO refuses to fetch a secret-NAMED column (api_key,
 *    password, token, ...). So the exact column sample_rows would not show was
 *    walkable one character at a time through the planner's row estimate, which
 *    is the cheaper oracle of the two.
 *  - `scanPiiTags` reported `ok: true` for a TRUNCATED metadata file (an
 *    interrupted `turbine generate`, a disk-full write, a merge conflict),
 *    because it only ever checked that it had seen a `tables:` map and one
 *    column, never that the object structure closed.
 *  - `sanitizeIndex` withheld an expression index's literal only in the
 *    NON-partial branch, so a partial expression index returned its key list,
 *    literal and all. It also withheld by deleting the field, which
 *    `JSON.stringify` drops, leaving no trace that anything was withheld.
 *  - `migrate_status` pinned `search_path`, which `turbine migrate status` does
 *    not, so the two disagreed about whether migrations were applied.
 *
 * As in mcp-pii.test.ts, these drive the REAL JSON-RPC line handler over a mock
 * pg.Pool: real dispatch, real metadata load, real tag scan, real SQL build.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, it } from 'node:test';
import type pg from 'pg';
import { type McpServerOptions, startMcpServer } from '../cli/mcp.js';
import { scanPiiTags } from '../cli/pii-tags.js';
import { generateMetadata } from '../generate.js';
import type { SchemaMetadata } from '../schema.js';
import { mockTable } from './helpers.js';

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
  col('users', 'api_key'),
  col('users', 'session_id'),
  // Round 3. Both of these were REFUSED by the unanchored substring rule:
  // `secret` inside `secretary_id`, `token` inside `token_count`.
  col('users', 'secretary_id'),
  col('users', 'token_count'),
];

/** An EXPRESSION index that is ALSO partial: both halves can hold a literal. */
const INDEX_ROWS = [
  {
    tablename: 'users',
    indexname: 'users_pkey',
    indexdef: 'CREATE UNIQUE INDEX users_pkey ON public.users USING btree (id)',
  },
  {
    tablename: 'users',
    indexname: 'users_expr_idx',
    indexdef: `CREATE INDEX users_expr_idx ON public.users USING btree ((email || 'ceo@example.com')) WHERE (id > 5)`,
  },
  {
    tablename: 'users',
    indexname: 'users_expr_plain_idx',
    indexdef: `CREATE INDEX users_expr_plain_idx ON public.users USING btree (lower((email || 'vip@example.com')))`,
  },
  // Round 3. The key-list literal CONTAINS the predicate keyword, so a plain
  // `indexOf(' WHERE ')` splits inside the literal instead of at the predicate.
  {
    tablename: 'users',
    indexname: 'users_where_literal_idx',
    indexdef: `CREATE INDEX users_where_literal_idx ON public.users USING btree ((email || ' WHERE board@example.com')) WHERE (id > 5)`,
  },
  // Round 3. Nothing parses as a key list, which used to scan clean.
  {
    tablename: 'users',
    indexname: 'users_unparsable_idx',
    indexdef: 'CREATE INDEX users_unparsable_idx ON public.users USING btree [truncated cfo@example.com',
  },
];

/**
 * Mock pool that EMULATES search_path resolution rather than answering the
 * question the test is about.
 *
 * The tracking table really lives in `public`. An unqualified `to_regclass`
 * therefore resolves it only while the connection's search_path still includes
 * `public`, exactly as Postgres behaves: pin search_path to `app` and the same
 * lookup finds nothing. That is the divergence between `turbine migrate status`
 * (no pin) and a pinned `migrate_status`, and it is reproduced here rather than
 * hard-coded.
 */
function makePool(recorded: Recorded[]): pg.Pool {
  let searchPath = 'public';
  const client = {
    query(sql: string, params?: unknown[]) {
      recorded.push({ sql, params });
      if (sql.includes("set_config('search_path'")) searchPath = String(params?.[0] ?? '');
      const rows = route(sql, searchPath);
      return Promise.resolve({ rows, rowCount: rows.length, fields: [] });
    },
    release() {},
  };
  return {
    connect() {
      searchPath = 'public';
      return Promise.resolve(client);
    },
    on() {},
    end() {
      return Promise.resolve();
    },
  } as unknown as pg.Pool;
}

function route(sql: string, searchPath: string): Record<string, unknown>[] {
  if (sql.includes('information_schema.tables')) return [{ table_name: 'users' }];
  if (sql.includes('information_schema.columns')) return COLUMNS as unknown as Record<string, unknown>[];
  if (sql.includes("'PRIMARY KEY'")) return [{ table_name: 'users', column_name: 'id' }];
  if (sql.includes("'FOREIGN KEY'")) return [];
  if (sql.includes("'UNIQUE'")) return [];
  if (sql.includes('pg_indexes')) return INDEX_ROWS as unknown as Record<string, unknown>[];
  if (sql.includes('pg_enum')) return [];
  if (sql.includes('pg_class') && sql.includes('reltuples')) return [{ relname: 'users', reltuples: '100' }];
  if (sql.startsWith('EXPLAIN')) return [{ 'QUERY PLAN': [{ Plan: { 'Plan Rows': 412 } }] }];
  if (sql.includes('to_regclass')) {
    const visible = searchPath.split(',').some((part) => part.trim() === 'public');
    return [{ exists: visible, table_schema: visible ? 'public' : null }];
  }
  if (sql.includes('_turbine_migrations')) return [];
  if (sql.startsWith('SELECT ') && sql.includes(' FROM "public"."users"')) {
    return [{ id: 1, email: 'ada@example.com', name: 'Ada' }];
  }
  return [];
}

interface ToolReply {
  result?: { content: { type: string; text: string }[] };
  error?: { code: number; message: string; data?: unknown };
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

function payload(reply: ToolReply): Record<string, unknown> {
  assert.equal(reply.error, undefined, `unexpected JSON-RPC error: ${JSON.stringify(reply.error)}`);
  const text = reply.result?.content[0]?.text;
  assert.ok(text, 'tool result carried no text content');
  return JSON.parse(text) as Record<string, unknown>;
}

/** Code-first schema tagging nothing: the secret-name rule must stand alone. */
function untaggedSchema(): SchemaMetadata {
  const users = mockTable('users', [
    { name: 'id', field: 'id' },
    { name: 'email', field: 'email', pgType: 'text' },
    { name: 'name', field: 'name', pgType: 'text' },
    { name: 'api_key', field: 'apiKey', pgType: 'text' },
    { name: 'session_id', field: 'sessionId', pgType: 'text' },
  ]);
  return { tables: { users }, enums: {} };
}

function withMetadataDir(source: string, fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'turbine-mcp-pii2-'));
  writeFileSync(join(dir, 'metadata.ts'), source);
  return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }));
}

const UNTAGGED_METADATA = () => generateMetadata(untaggedSchema(), { noTimestamp: true });

// ---------------------------------------------------------------------------

describe('mcp explain_query: secret-NAMED columns are oracles too', () => {
  it('refuses a where on a secret-named column that carries no pii tag', async () => {
    await withMetadataDir(UNTAGGED_METADATA(), async (metadataDir) => {
      const h = createHarness({ metadataDir });
      const reply = await h.call('explain_query', { table: 'users', where: { apiKey: { startsWith: 'sk-a' } } });
      assert.equal(reply.error?.code, -32602);
      assert.match(reply.error?.message ?? '', /"api_key" on "users"/);
      assert.match(reply.error?.message ?? '', /secret-looking name/);
      assert.equal(
        h.recorded.some((r) => r.sql.startsWith('EXPLAIN')),
        false,
        'no plan may be produced for a refused predicate',
      );
      await h.dispose();
    });
  });

  it('refuses the snake_case spelling and an orderBy just the same', async () => {
    await withMetadataDir(UNTAGGED_METADATA(), async (metadataDir) => {
      const h = createHarness({ metadataDir });
      const byColumn = await h.call('explain_query', { table: 'users', where: { session_id: 'abc' } });
      assert.match(byColumn.error?.message ?? '', /"session_id" on "users"/);
      const bySort = await h.call('explain_query', { table: 'users', orderBy: { apiKey: 'asc' } });
      assert.match(bySort.error?.message ?? '', /"api_key" on "users"/);
      await h.dispose();
    });
  });

  it('refuses even with no metadata directory at all, matching sample_rows', async () => {
    // The name rule never depended on generated metadata, and neither half of
    // the perimeter may: an operator who never ran `turbine generate` still
    // gets the oracle closed.
    const h = createHarness();
    const reply = await h.call('explain_query', { table: 'users', where: { apiKey: 'sk-live-1' } });
    assert.match(reply.error?.message ?? '', /"api_key" on "users"/);
    await h.dispose();
  });

  it('still plans a query on an ordinary column', async () => {
    const h = createHarness();
    const result = payload(await h.call('explain_query', { table: 'users', where: { name: 'Ada' }, limit: 5 }));
    assert.ok(result.plan, 'an ordinary predicate must still be planned');
    await h.dispose();
  });

  it('still allows naming a secret column in select, which returns no values', async () => {
    const h = createHarness();
    assert.ok(payload(await h.call('explain_query', { table: 'users', select: { apiKey: true } })).plan);
    await h.dispose();
  });
});

describe('scanPiiTags: a truncated metadata file fails closed', () => {
  it('reports ok: false when the object structure never closes', () => {
    const truncated = `export const SCHEMA = { tables: { users: { columns: [ { name: 'email', field: 'email', pii: true`;
    const scan = scanPiiTags(truncated);
    assert.equal(scan.ok, false, 'an interrupted `turbine generate` must not read as a clean scan');
    assert.match(scan.reason ?? '', /truncat|unclosed|unterminated/i);
  });

  it('reports ok: false when the file ends inside a string literal', () => {
    const cut = `export const SCHEMA = { tables: { users: { columns: [ { name: 'ema`;
    const scan = scanPiiTags(cut);
    assert.equal(scan.ok, false);
  });

  it('reports ok: false when the file ends inside a block comment', () => {
    const cut = `${generateMetadata(untaggedSchema(), { noTimestamp: true })}\n/* trailing`;
    assert.equal(scanPiiTags(cut).ok, false);
  });

  it('still reports ok: true for a complete generated file', () => {
    const scan = scanPiiTags(generateMetadata(untaggedSchema(), { noTimestamp: true }));
    assert.equal(scan.ok, true, scan.reason ?? 'complete generated metadata must scan cleanly');
    assert.ok(scan.columnsSeen > 0);
  });

  it('makes the MCP server fail closed on a truncated file', async () => {
    const truncated = `export const SCHEMA = { tables: { users: { columns: [ { name: 'email', field: 'email', pii: true`;
    await withMetadataDir(truncated, async (metadataDir) => {
      const h = createHarness({ metadataDir });
      const result = payload(await h.call('sample_rows', { table: 'users', limit: 1 }));
      assert.equal((result.piiTagSource as { state: string }).state, 'tags-unreadable');
      assert.deepEqual(
        new Set(result.redactedColumns as string[]),
        new Set(['id', 'email', 'name', 'api_key', 'session_id', 'secretary_id', 'token_count']),
      );
      await h.dispose();
    });
  });
});

describe('mcp table_detail: index literals never reach the reply', () => {
  it('withholds a PARTIAL expression index whole, and says it did', async () => {
    const h = createHarness();
    const detail = payload(await h.call('table_detail', { table: 'users' }));
    const indexes = detail.indexes as { name: string; definition?: string; definitionWithheld?: boolean }[];

    const expr = indexes.find((i) => i.name === 'users_expr_idx');
    assert.ok(expr);
    assert.equal(JSON.stringify(expr).includes('ceo@example.com'), false, 'a stored value must not be echoed');
    assert.equal(expr.definitionWithheld, true, 'the withholding must be labelled, not a missing key');
    assert.match(expr.definition ?? '', /withheld/);
    await h.dispose();
  });

  it('labels a withheld non-partial expression index the same way', async () => {
    const h = createHarness();
    const detail = payload(await h.call('table_detail', { table: 'users' }));
    const indexes = detail.indexes as { name: string; definition?: string; definitionWithheld?: boolean }[];

    const expr = indexes.find((i) => i.name === 'users_expr_plain_idx');
    assert.ok(expr);
    assert.equal(JSON.stringify(expr).includes('vip@example.com'), false);
    assert.equal(expr.definitionWithheld, true);
    assert.match(expr.definition ?? '', /withheld/);

    const plain = indexes.find((i) => i.name === 'users_pkey');
    assert.equal(plain?.definitionWithheld, false);
    assert.match(plain?.definition ?? '', /USING btree \(id\)/);
    await h.dispose();
  });
});

describe('mcp migrate_status: agrees with `turbine migrate status`', () => {
  it('resolves the tracking table the way the CLI does, and discloses where', async () => {
    // The tracking table lives in `public`; the server is pointed at `app`.
    // `turbine migrate status` reads the name unqualified, so it finds it.
    const h = createHarness({ schema: 'app' });
    const result = payload(await h.call('migrate_status'));
    assert.equal(result.trackingTableExists, true, 'must not disagree with `turbine migrate status`');
    assert.equal(result.trackingTableSchema, 'public');
    // And the disagreement with the configured schema is disclosed, not hidden.
    assert.match(String(result.trackingTableNote ?? ''), /app/);
    await h.dispose();
  });

  it('adds no note when the tracking table resolves inside the configured schema', async () => {
    const h = createHarness();
    const result = payload(await h.call('migrate_status'));
    assert.equal(result.trackingTableExists, true);
    assert.equal(result.trackingTableSchema, 'public');
    assert.equal(result.trackingTableNote, undefined);
    await h.dispose();
  });
});

// ---------------------------------------------------------------------------
// Round 3: what round 2's own fixes still let through
// ---------------------------------------------------------------------------

describe('mcp table_detail: the index parser itself fails closed', () => {
  it('does not split on a ` WHERE ` that lives inside the key list literal', async () => {
    // Round 2 checked the key list for literals in BOTH branches, which is
    // right, but computed the boundary with `indexOf(' WHERE ')`. When the
    // literal itself contains the keyword, the split lands mid-literal, the
    // head no longer holds the opening quote, and the scan reads clean. The
    // fix that closed the branch gap was defeated by the parser under it.
    const h = createHarness();
    const detail = payload(await h.call('table_detail', { table: 'users' }));
    const indexes = detail.indexes as { name: string; definition?: string; definitionWithheld?: boolean }[];

    const idx = indexes.find((i) => i.name === 'users_where_literal_idx');
    assert.ok(idx);
    assert.equal(JSON.stringify(idx).includes('board@example.com'), false, 'the key-list literal must not be echoed');
    assert.equal(idx.definitionWithheld, true);
    await h.dispose();
  });

  it('withholds a definition it cannot parse, rather than passing it through', async () => {
    // An unparsable key list used to read as an EMPTY one, which holds no
    // literal by definition, so the one input the parser could not read was
    // the one it returned verbatim.
    const h = createHarness();
    const detail = payload(await h.call('table_detail', { table: 'users' }));
    const indexes = detail.indexes as { name: string; definition?: string; definitionWithheld?: boolean }[];

    const idx = indexes.find((i) => i.name === 'users_unparsable_idx');
    assert.ok(idx);
    assert.equal(JSON.stringify(idx).includes('cfo@example.com'), false);
    assert.equal(idx.definitionWithheld, true);
    assert.match(idx.definition ?? '', /could not be parsed/);
    await h.dispose();
  });
});

describe('mcp explain_query: the secret-name rule matches names, not substrings', () => {
  it('plans a predicate on secretary_id, which merely CONTAINS "secret"', async () => {
    // The rule was an unanchored substring test, so this column was
    // hard-refused (-32602) against a schema that tags nothing. A false
    // refusal is not free: it makes the tool look broken on ordinary columns
    // and teaches people to route around the guard entirely.
    const h = createHarness();
    const result = payload(await h.call('explain_query', { table: 'users', where: { secretaryId: '7' } }));
    assert.ok(result.plan, 'an ordinary column must still be planned');
    await h.dispose();
  });

  it('still refuses a column whose own name segment IS a secret word', async () => {
    // The other direction of the same boundary. `token_count` stays refused on
    // purpose: the segment is real, and this gate decides whether an
    // extraction oracle over the column is opened, so it errs toward refusing.
    const h = createHarness();
    const reply = await h.call('explain_query', { table: 'users', where: { tokenCount: '3' } });
    assert.match(reply.error?.message ?? '', /secret-looking name/);
    await h.dispose();
  });

  for (const field of ['apiKey', 'sessionId'] as const) {
    it(`still refuses ${field}, which the rule always caught`, async () => {
      const h = createHarness();
      const reply = await h.call('explain_query', { table: 'users', where: { [field]: 'x' } });
      assert.match(reply.error?.message ?? '', /secret-looking name/);
      await h.dispose();
    });
  }
});
