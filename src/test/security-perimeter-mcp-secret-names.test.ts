/**
 * MCP server: secret-looking column names, and catalog names in messages.
 *
 * `sample_rows` withholds, and `explain_query` / `compile_query` refuse a
 * predicate on, any column whose NAME looks like a credential, because
 * introspection never tags PII and on a database without generated metadata the
 * name is the only signal there is. The earlier rule was anchored on underscores,
 * so on a camelCase database (the default naming of a Prisma-created one) it
 * caught `apiKey` and `access_token` and returned `refreshToken`, `passwordHash`
 * and `clientSecret` verbatim.
 *
 * The second half pins that a name from the catalog, or echoed from a request,
 * is escaped (`printableCatalogName`) in every error this server writes, since a
 * message can reach a terminal or a log.
 *
 * Drives the REAL JSON-RPC line handler over a mock pg.Pool, like mcp-pii.test.ts.
 *
 * Run: npx tsx --test src/test/security-perimeter-mcp-secret-names.test.ts
 */

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, it } from 'node:test';
import type pg from 'pg';
import { looksLikeSecretName, type McpServerOptions, secretNameWords, startMcpServer } from '../cli/mcp.js';

// ---------------------------------------------------------------------------
// The rule, as a table
// ---------------------------------------------------------------------------

const SECRET: string[] = [
  // snake_case
  'api_key',
  'access_token',
  'refresh_token',
  'password_hash',
  'hashed_password',
  'client_secret',
  'otp_secret',
  'session_token',
  'session_id',
  'private_key',
  'totp_secret',
  'mfa_secret',
  'auth_token',
  // camelCase, the case that was missed
  'apiKey',
  'accessToken',
  'refreshToken',
  'passwordHash',
  'hashedPassword',
  'clientSecret',
  'otpSecret',
  'sessionToken',
  'sessionId',
  'privateKey',
  'secretKey',
  'userPassword',
  'newPassword',
  'accessKeyId',
  // PascalCase and SCREAMING_CASE
  'RefreshToken',
  'ClientSecret',
  'API_KEY',
  'APIKey',
  'REFRESH_TOKEN',
  // kebab-case
  'refresh-token',
  'x-api-key',
  'client-secret',
  // bare words, plurals, digits
  'password',
  'Password',
  'passwd',
  'secret',
  'token',
  'tokens',
  'credentials',
  'passphrase',
  'passcode',
  'jwt',
  'salt',
  'saltValue',
  'token2',
  'token_2',
  'otp1',
  'apikey',
  // one unsplittable lowercase word
  'refreshtoken',
  'passwordhash',
  'clientsecret',
  'accesskeyid',
  // deliberately conservative: the segment IS a secret word
  'tokenCount',
  'token_count',
];

const ORDINARY: string[] = [
  'id',
  'name',
  'email',
  'created_at',
  'createdAt',
  'updatedAt',
  'status',
  'displayName',
  'secretary_id',
  'secretaryId',
  'tokenizer',
  'author',
  'authorId',
  'options',
  'option',
  'potpourri',
  'passport',
  'passenger',
  'keyboard',
  'key',
  'api',
  'session',
  'sessions',
  'monkey',
  'turkey',
  'hash',
  'contentHash',
  'saltine',
  'salty',
  'assault',
  'mfaculty',
  'publicKey',
];

describe('looksLikeSecretName: a table of names, both ways', () => {
  for (const name of SECRET) {
    it(`flags ${name}`, () => {
      assert.equal(looksLikeSecretName(name), true, `${name} -> ${JSON.stringify(secretNameWords(name))}`);
    });
  }
  for (const name of ORDINARY) {
    it(`leaves ${name} alone`, () => {
      assert.equal(looksLikeSecretName(name), false, `${name} -> ${JSON.stringify(secretNameWords(name))}`);
    });
  }

  it('splits on separators, case changes, acronym edges and digits', () => {
    assert.deepEqual(secretNameWords('refreshToken'), ['refresh', 'token']);
    assert.deepEqual(secretNameWords('refresh_token'), ['refresh', 'token']);
    assert.deepEqual(secretNameWords('refresh-token'), ['refresh', 'token']);
    assert.deepEqual(secretNameWords('RefreshToken'), ['refresh', 'token']);
    assert.deepEqual(secretNameWords('APIKey'), ['api', 'key']);
    assert.deepEqual(secretNameWords('API_KEY'), ['api', 'key']);
    assert.deepEqual(secretNameWords('token2'), ['token', '2']);
    assert.deepEqual(secretNameWords('__x__'), ['x']);
  });

  it('is total: odd input never throws', () => {
    for (const name of ['', '_', '-', '123', 'é', '‮', 'a'.repeat(10_000)]) {
      assert.doesNotThrow(() => looksLikeSecretName(name));
    }
  });
});

// ---------------------------------------------------------------------------
// Mock pool
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

const col = (table: string, name: string, udt = 'text'): ColumnRow => ({
  table_name: table,
  column_name: name,
  udt_name: udt,
  data_type: udt === 'int4' ? 'integer' : 'text',
  is_nullable: 'NO',
  column_default: null,
  is_identity: 'NO',
  character_maximum_length: null,
});

const ESC = '\u001b';
const BIDI = '‮';
const HOSTILE_TABLE = `evil${ESC}[2Jtable${BIDI}`;
const HOSTILE_COLUMN = `secret${ESC}[0m`;

const COLUMNS: ColumnRow[] = [
  col('users', 'id', 'int4'),
  col('users', 'displayName'),
  col('users', 'refreshToken'),
  col('users', 'passwordHash'),
  col('users', 'clientSecret'),
  col('users', 'apiKey'),
  col('users', 'accessToken'),
  col('users', 'secretaryId'),
  col('users', 'tokenizer'),
  col('users', HOSTILE_COLUMN),
  col(HOSTILE_TABLE, 'id', 'int4'),
];

function route(sql: string): Record<string, unknown>[] {
  if (sql.includes('information_schema.tables')) return [{ table_name: 'users' }, { table_name: HOSTILE_TABLE }];
  if (sql.includes('information_schema.columns')) return COLUMNS as unknown as Record<string, unknown>[];
  if (sql.includes("'PRIMARY KEY'")) {
    return [
      { table_name: 'users', column_name: 'id' },
      { table_name: HOSTILE_TABLE, column_name: 'id' },
    ];
  }
  if (sql.includes("con.contype = 'f'")) return [];
  if (sql.includes("'UNIQUE'")) return [];
  if (sql.includes('pg_indexes')) return [];
  if (sql.includes('pg_enum')) return [];
  if (sql.includes('pg_class') && sql.includes('reltuples')) return [{ relname: 'users', reltuples: '10' }];
  if (sql.startsWith('EXPLAIN')) return [{ 'QUERY PLAN': [{ Plan: { 'Plan Rows': 1 } }] }];
  if (sql.startsWith('SELECT ') && sql.includes(' FROM "public"."users"')) {
    return [
      {
        id: 1,
        displayName: 'Ada',
        secretaryId: 7,
        tokenizer: 'wordpiece',
        refreshToken: 'rt-LIVE',
        passwordHash: 'ph-LIVE',
        clientSecret: 'cs-LIVE',
        apiKey: 'ak-LIVE',
        accessToken: 'at-LIVE',
      },
    ];
  }
  return [];
}

function makePool(recorded: Recorded[]): pg.Pool {
  const client = {
    query(sql: string, params?: unknown[]) {
      recorded.push({ sql, params });
      const rows = route(sql);
      return Promise.resolve({ rows, rowCount: rows.length, fields: [] });
    },
    release() {},
  };
  return {
    connect: () => Promise.resolve(client),
    on() {},
    end: () => Promise.resolve(),
  } as unknown as pg.Pool;
}

interface ToolReply {
  result?: { content: { type: string; text: string }[] };
  error?: { code: number; message: string };
}

function readOne(output: PassThrough): Promise<ToolReply> {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const onData = (chunk: Buffer | string) => {
      buffer += chunk.toString();
      const nl = buffer.indexOf('\n');
      if (nl === -1) return;
      output.off('data', onData);
      try {
        resolve(JSON.parse(buffer.slice(0, nl)) as ToolReply);
      } catch (err) {
        reject(err);
      }
    };
    output.on('data', onData);
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
      migrationsDir: join('/nonexistent', 'turbine-mcp-no-such-migrations'),
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

function payload(reply: ToolReply): Record<string, unknown> {
  assert.equal(reply.error, undefined, `unexpected JSON-RPC error: ${JSON.stringify(reply.error)}`);
  const text = reply.result?.content[0]?.text;
  assert.ok(text, 'tool result carried no text content');
  return JSON.parse(text) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Through the tools
// ---------------------------------------------------------------------------

const HIDDEN = ['refreshToken', 'passwordHash', 'clientSecret', 'apiKey', 'accessToken'];
const SHOWN = ['id', 'displayName', 'secretaryId', 'tokenizer'];

describe('mcp sample_rows: camelCase secret columns are withheld', () => {
  it('never fetches them, and reports why', async () => {
    const h = createHarness();
    const result = payload(await h.call('sample_rows', { table: 'users', limit: 1 }));
    const reasons = result.redactionReasons as Record<string, string>;
    for (const name of HIDDEN) assert.equal(reasons[name], 'secret-name', `${name} must be withheld`);
    for (const name of SHOWN) assert.equal(reasons[name], undefined, `${name} is an ordinary column`);

    const select = h.recorded.find((r) => r.sql.includes(' FROM "public"."users"'));
    assert.ok(select, 'the sample query ran');
    for (const name of HIDDEN) assert.equal(select.sql.includes(`"${name}"`), false, `${name} must not be fetched`);
    for (const name of SHOWN) assert.equal(select.sql.includes(`"${name}"`), true, `${name} is fetched`);

    // Nothing live reaches the reply, in any field.
    assert.doesNotMatch(JSON.stringify(result), /-LIVE/);
    await h.dispose();
  });
});

describe('mcp explain_query: a predicate on a camelCase secret column is refused', () => {
  for (const name of HIDDEN) {
    it(`refuses where on ${name}`, async () => {
      const h = createHarness();
      const reply = await h.call('explain_query', { table: 'users', where: { [name]: { startsWith: 'sk-a' } } });
      assert.equal(reply.error?.code, -32602);
      assert.match(reply.error?.message ?? '', /secret-looking name/);
      assert.equal(
        h.recorded.some((r) => r.sql.startsWith('EXPLAIN')),
        false,
        'no plan may be produced for a refused predicate',
      );
      await h.dispose();
    });
  }

  it('still plans a predicate on secretaryId, which only CONTAINS a secret word', async () => {
    const h = createHarness();
    const result = payload(await h.call('explain_query', { table: 'users', where: { secretaryId: 7 } }));
    assert.ok(result.plan);
    await h.dispose();
  });
});

describe('mcp compile_query: the same names are refused on every position', () => {
  it('refuses orderBy and where on a camelCase secret column', async () => {
    const h = createHarness();
    for (const args of [{ orderBy: { refreshToken: 'asc' } }, { where: { passwordHash: 'x' } }]) {
      const reply = await h.call('compile_query', { table: 'users', operation: 'findMany', args });
      const text = reply.error?.message ?? reply.result?.content[0]?.text ?? '';
      assert.match(text, /secret-looking name/, JSON.stringify(args));
    }
    await h.dispose();
  });
});

describe('mcp messages escape catalog names', () => {
  it('Unknown table escapes the requested name and the list of available tables', async () => {
    const h = createHarness();
    const reply = await h.call('table_detail', { table: `nope${ESC}[31m` });
    const message = reply.error?.message ?? '';
    assert.match(message, /Unknown table/);
    assert.equal(message.includes(ESC), false, 'no raw ESC in the message');
    assert.equal(message.includes(BIDI), false, 'no raw bidi override in the message');
    assert.match(message, /nope\\u001b\[31m/, 'the requested name is shown escaped');
    assert.match(message, /evil\\u001b\[2Jtable\\u202e/, 'the listed catalog table is shown escaped');
    await h.dispose();
  });

  it('a refused predicate escapes the hostile column name', async () => {
    const h = createHarness();
    const reply = await h.call('explain_query', { table: 'users', where: { [HOSTILE_COLUMN]: 'x' } });
    const message = reply.error?.message ?? '';
    assert.match(message, /secret-looking name/, 'the column really was refused for its name');
    assert.equal(message.includes(ESC), false, 'no raw ESC in the refusal');
    assert.match(message, /secret\\u001b\[0m/);
    await h.dispose();
  });

  it('a join-path message escapes the table name', async () => {
    const h = createHarness();
    const reply = await h.call('find_join_path', { from: HOSTILE_TABLE, to: HOSTILE_TABLE });
    const text = JSON.stringify(payload(reply));
    assert.match(text, /is both ends of this query/, 'the message under test was produced');
    // JSON.stringify escapes control characters itself, so look for the ESCAPED
    // form this server wrote, not for the absence of a raw byte alone.
    assert.match(text, /evil\\\\u001b\[2Jtable\\\\u202e/);
    await h.dispose();
  });
});
