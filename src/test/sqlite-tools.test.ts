import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { PassThrough } from 'node:stream';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { type CompileQueryReport, compileQueryPlan, SEALED_POOL } from '../cli/compile-query.js';
import { type McpServerOptions, runReadOnlyTool, startMcpServer } from '../cli/mcp.js';
import { createSqliteToolPool, introspectSqliteToolClient, sqliteToolRuntime } from '../cli/sqlite-tools.js';
import { discoverToolCapabilities, toolEngine } from '../cli/tool-capabilities.js';
import { runToolCommand } from '../cli/tool-command.js';
import { generateMetadata } from '../generate.js';
import { introspectSqliteDatabase, SqlitePool, sqliteDialect } from '../sqlite.js';
import { skipGate } from './helpers.js';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const Database: typeof DatabaseSync | undefined = (() => {
  try {
    return createRequire(import.meta.url)('node:sqlite').DatabaseSync;
  } catch {
    return undefined;
  }
})();
const sqlite = skipGate(!sqliteToolRuntime().available, 'SQLite tools require node:sqlite readOnly (Node >= 22.12)');

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'turbine-sqlite-tools-'));
  const path = join(dir, 'app.sqlite');
  const db = new Database!(path);
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, display_name TEXT NOT NULL, email TEXT, api_key TEXT);
    CREATE TABLE posts (id INTEGER PRIMARY KEY, user_id INTEGER REFERENCES users(id), title TEXT);
    CREATE INDEX public_names ON users(display_name) WHERE email = 'partial-literal@example.test';
    CREATE INDEX expression_names ON users((display_name || 'expression-literal'));
    INSERT INTO users VALUES (1, 'First', 'tagged@example.test', 'secret-one'), (2, 'Second', 'other@example.test', 'secret-two');
    INSERT INTO posts VALUES (1, 1, 'Actual post');
  `);
  const metadata = introspectSqliteDatabase(db);
  metadata.tables.users!.columns.find((column) => column.name === 'email')!.pii = true;
  // PII metadata needs column tags; the live index catalog is read independently.
  metadata.tables.users!.indexes = [];
  writeFileSync(join(dir, 'metadata.ts'), generateMetadata(metadata, { noTimestamp: true }));
  db.close();
  const options: McpServerOptions = {
    engine: 'sqlite',
    url: path,
    schema: 'main',
    migrationsDir: join(dir, 'migrations'),
    metadataDir: dir,
  };
  return { dir, path, options, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

interface Reply {
  result?: { content?: { text: string }[]; tools?: { name: string }[] };
  error?: { code: number; message: string; data?: unknown };
}

function harness(options: McpServerOptions) {
  const input = new PassThrough();
  const output = new PassThrough();
  const handle = startMcpServer(options, { input, output });
  let id = 0;
  const rpc = (method: string, params?: unknown): Promise<Reply> =>
    new Promise((resolve) => {
      output.once('data', (chunk: Buffer) => resolve(JSON.parse(chunk.toString()) as Reply));
      input.write(`${JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params })}\n`);
    });
  return {
    rpc,
    call: (name: string, args = {}) => rpc('tools/call', { name, arguments: args }),
    dispose: handle.dispose,
  };
}

function payload<T>(reply: Reply): T {
  assert.equal(reply.error, undefined, JSON.stringify(reply.error));
  const value = reply.result?.content?.[0]?.text;
  assert.ok(value, 'tool returned no content');
  return JSON.parse(value) as T;
}

async function compile(options: McpServerOptions, args: Record<string, unknown>): Promise<CompileQueryReport> {
  return (await runReadOnlyTool(options, 'compile_query', { table: 'users', ...args })) as CompileQueryReport;
}

describe('effective tool capability contract', () => {
  it('refuses malformed native doctor arguments before checking out a connection', async () => {
    for (const engine of ['sqlite', 'mysql', 'mssql'] as const) {
      const options: McpServerOptions = {
        engine,
        url: engine === 'sqlite' ? '/missing-doctor.sqlite' : `${engine}://localhost/app`,
        schema: engine === 'sqlite' ? 'main' : 'app',
        migrationsDir: '',
      };
      for (const args of [null, [], 'SELECT secret', { sql: 'SELECT secret' }, { fix: true }]) {
        await assert.rejects(runReadOnlyTool(options, 'doctor_report', args as never), /takes no arguments/);
      }
    }
    await assert.rejects(
      runToolCommand(
        { command: 'doctor', positional: [] },
        {
          engine: 'mysql',
          url: '',
          schema: '',
          migrationsDir: '',
        },
      ),
      /require SQLite/,
    );
    await assert.rejects(
      runToolCommand(
        { command: 'doctor', subcommand: 'repair', positional: [] },
        {
          engine: 'sqlite',
          url: '',
          schema: 'main',
          migrationsDir: '',
        },
      ),
      /no positional/,
    );
  });

  it('keeps native network discovery connection-free and refuses unavailable tool operations', async () => {
    for (const engine of ['mysql', 'mssql'] as const) {
      const options: McpServerOptions = { engine, url: '', schema: '', migrationsDir: '' };
      const facts = discoverToolCapabilities(engine);
      assert.equal(facts.databaseVersion, null);
      assert.equal(facts.connectivity, 'not-probed');
      assert.equal(facts.transport.transactions, engine === 'mysql');
      assert.equal(
        facts.transport.readOnlyEnforcement,
        engine === 'mysql' ? 'transaction-read-only-consistent-snapshot' : 'fixed-catalog-queries-only',
      );
      const discovery = await runToolCommand({ command: 'capabilities', positional: [] }, options);
      assert.deepEqual(discovery, facts);
      const error = (await runReadOnlyTool(options, 'explain_error', { code: 'E003' })) as { code: string };
      assert.equal(error.code, 'TURBINE_E003');
      assert.equal(facts.tools.find((tool) => tool.name === 'doctor_report')?.implemented, true);
      for (const tool of ['explain_query', 'table_stats', 'migrate_status']) {
        await assert.rejects(
          runReadOnlyTool({ ...options, url: `${engine}://localhost/app`, schema: 'app' }, tool),
          /not implemented/,
        );
      }
      if (engine === 'mssql')
        await assert.rejects(
          runReadOnlyTool({ ...options, url: 'mssql://localhost/app', schema: 'app' }, 'sample_rows'),
          /not implemented/,
        );
    }
  });
  it('derives dialect facts and distinguishes SQLite read-only files from read-only transactions', () => {
    const facts = discoverToolCapabilities('sqlite');
    assert.equal(facts.schemaVersion, 1);
    assert.equal(facts.scope, 'read-only-tools');
    assert.equal(facts.sql.readOnlyTransactions, sqliteDialect.capabilities.readOnlyTransactions);
    assert.equal(facts.sql.readOnlyTransactions, false);
    assert.equal(facts.transport.readOnlyEnforcement, 'database-open-read-only');
    assert.equal(facts.transport.pipeline, false);
    assert.equal(facts.transport.cursors, false);
    assert.equal(facts.connectivity, 'not-probed');
    assert.equal(facts.sql.maxInsertRows, 'unbounded');
    assert.equal(facts.runtime.available, sqliteToolRuntime().available);
    assert.deepEqual(
      facts.tools.filter((tool) => !tool.implemented).map((tool) => tool.name),
      ['migrate_status', 'explain_query', 'table_stats'],
    );
    assert.ok(facts.tools.filter((tool) => !tool.implemented).every((tool) => !tool.available && tool.reason));
  });

  it('does not certify an injected PostgreSQL transport or unknown server version', () => {
    const facts = discoverToolCapabilities('postgresql', true);
    assert.equal(facts.databaseVersion, null);
    assert.equal(facts.databaseVersionSource, 'unknown');
    assert.equal(facts.transport.sessions, null);
    assert.equal(facts.transport.transactions, null);
    assert.equal(facts.transport.readOnlyEnforcement, 'requested-transaction-read-only-unverified');
    assert.equal(toolEngine('mysql'), 'mysql');
    assert.equal(toolEngine('mssql'), 'mssql');
    assert.throws(() => toolEngine('unknown'), /support engines/);
  });

  it('runtime refusals remain explicit and connection-free tools remain available without native SQLite', async (t) => {
    const options: McpServerOptions = { engine: 'sqlite', url: '/unused.sqlite', schema: 'main', migrationsDir: '' };
    const descriptor = Object.getOwnPropertyDescriptor(process.versions, 'node')!;
    Object.defineProperty(process.versions, 'node', { ...descriptor, value: '20.19.0' });
    try {
      const facts = discoverToolCapabilities('sqlite');
      assert.equal(facts.runtime.available, false);
      assert.equal(facts.databaseVersion, null);
      assert.ok(facts.tools.filter((tool) => tool.needsDatabase).every((tool) => !tool.available && tool.reason));
      assert.ok(facts.tools.filter((tool) => !tool.needsDatabase).every((tool) => tool.available));
      await assert.rejects(runReadOnlyTool(options, 'schema_overview'), /node:sqlite.*22.12/);
      const error = (await runReadOnlyTool(options, 'explain_error', { code: 'E003' })) as { code: string };
      assert.equal(error.code, 'TURBINE_E003');
    } finally {
      Object.defineProperty(process.versions, 'node', descriptor);
    }
    const module = createRequire(import.meta.url)('node:module') as {
      _load: (request: string, ...args: unknown[]) => unknown;
    };
    const original = module._load.bind(module);
    t.mock.method(module, '_load', (request: string, ...args: unknown[]) => {
      if (request === 'node:sqlite') throw new Error('native SQLite unavailable');
      return original(request, ...args);
    });
    assert.equal(sqliteToolRuntime().available, false);
  });

  it('CLI tools refuse malformed or extra operands instead of silently dropping them', async () => {
    const options: McpServerOptions = { engine: 'sqlite', url: '', schema: 'main', migrationsDir: '' };
    for (const args of [
      { command: 'schema', subcommand: 'users', positional: ['ignored'] },
      { command: 'capabilities', subcommand: 'ignored', positional: [] },
      { command: 'unknown-tool', positional: [] },
    ])
      await assert.rejects(runToolCommand(args, options), /positional|Unknown/);
  });

  it('discovery and the shared error catalog work without a database path or runtime', async () => {
    const options: McpServerOptions = { engine: 'sqlite', url: '', schema: 'main', migrationsDir: '' };
    const discovery = (await runReadOnlyTool(options, 'engine_capabilities')) as { engine: string };
    assert.equal(discovery.engine, 'sqlite');
    const error = (await runReadOnlyTool(options, 'explain_error', { code: 'E003' })) as {
      code: string;
      howToFix: string[];
    };
    assert.equal(error.code, 'TURBINE_E003');
    assert.ok(error.howToFix.length > 0);
    await assert.rejects(runReadOnlyTool(options, 'explain_error', { code: 'E999' }), /not a Turbine error code/);
  });
});

describe('SQLite real read-only tool workflows', () => {
  sqlite.it('doctor MCP withholds native checkout failure diagnostics', async (t) => {
    const f = fixture();
    t.after(f.cleanup);
    const h = harness(f.options);
    t.mock.method(SqlitePool.prototype, 'connect', async () => {
      throw new Error(`native-open-private ${f.path}`);
    });
    try {
      const reply = await h.call('doctor_report');
      assert.equal(reply.error?.code, -32603);
      assert.match(String(reply.error?.data), /SQLite doctor failed/);
      assert.doesNotMatch(JSON.stringify(reply), /native-open-private/);
      assert.ok(!JSON.stringify(reply).includes(f.path));
    } finally {
      await h.dispose();
    }
  });
  sqlite.it(
    'reports native index facts for quoted names and mixed expression keys without parsing identifiers as SQL',
    async (t) => {
      const f = fixture();
      t.after(f.cleanup);
      const db = new Database!(f.path);
      db.exec(`
      CREATE INDEX "quoted'partial" ON users(display_name) WHERE email = 'predicate-canary';
      CREATE INDEX "ordinary WHERE name" ON users(display_name);
      CREATE INDEX "odd ""quote""(name)" ON users(display_name);
      CREATE INDEX mixed_keys ON users(display_name, (email || 'mixed-expression-canary'));
      CREATE TABLE odd_columns ("(expression withheld)" TEXT, "odd'name" TEXT);
      CREATE INDEX odd_columns_idx ON odd_columns("(expression withheld)", "odd'name");
    `);
      db.close();
      const before = readFileSync(f.path);
      const h = harness(f.options);
      t.after(h.dispose);
      type Detail = {
        indexes: {
          name: string;
          partial: boolean;
          columns: string[];
          columnsWithheld: boolean;
          definitionWithheld: boolean;
        }[];
      };
      const detail = payload<Detail>(await h.call('table_detail', { table: 'users' }));
      for (const [name, partial] of [
        ["quoted'partial", true],
        ['ordinary WHERE name', false],
        ['odd "quote"(name)', false],
      ] as const) {
        const index = detail.indexes.find((index) => index.name === name)!;
        assert.ok(index);
        assert.equal(index.partial, partial, name);
        assert.deepEqual(index.columns, ['display_name']);
        assert.equal(index.columnsWithheld, false, name);
        assert.equal(index.definitionWithheld, false, name);
      }
      const mixed = detail.indexes.find((index) => index.name === 'mixed_keys')!;
      assert.deepEqual(mixed.columns, ['display_name']);
      assert.equal(mixed.columnsWithheld, true);
      assert.equal(mixed.definitionWithheld, true);
      const odd = payload<Detail>(await h.call('table_detail', { table: 'odd_columns' })).indexes[0]!;
      assert.deepEqual(odd.columns, ['(expression withheld)', "odd'name"]);
      assert.equal(odd.columnsWithheld, false);
      assert.equal(odd.definitionWithheld, false);
      assert.doesNotMatch(JSON.stringify(detail), /predicate-canary|mixed-expression-canary/);
      assert.deepEqual(readFileSync(f.path), before);
    },
  );
  sqlite.it('schema and relation tools observe real catalogs and refuse unavailable PG tools', async (t) => {
    const f = fixture();
    t.after(f.cleanup);
    const h = harness(f.options);
    t.after(h.dispose);
    const overview = payload<{ tables: { name: string; estimatedRows: null; columns: number }[] }>(
      await h.call('schema_overview'),
    );
    assert.deepEqual(
      overview.tables.map((table) => table.name),
      ['posts', 'users'],
    );
    assert.ok(overview.tables.every((table) => table.columns > 0 && table.estimatedRows === null));
    const detail = payload<{
      columns: { name: string }[];
      indexes: { name: string; partial: boolean; columnsWithheld: boolean }[];
    }>(await h.call('table_detail', { table: 'users' }));
    assert.ok(detail.columns.some((column) => column.name === 'display_name'));
    assert.equal(detail.indexes.find((index) => index.name === 'public_names')?.partial, true);
    assert.equal(detail.indexes.find((index) => index.name === 'expression_names')?.columnsWithheld, true);
    assert.doesNotMatch(JSON.stringify(detail), /partial-literal|expression-literal/);
    const graph = payload<{ tables: unknown[] }>(await h.call('relation_graph'));
    assert.equal(graph.tables.length, 2);
    const path = payload<{ paths: unknown[] }>(await h.call('find_join_path', { from: 'users', to: 'posts' }));
    assert.ok(path.paths.length > 0);
    const tools = (await h.rpc('tools/list')).result!.tools!;
    assert.ok(tools.some((tool) => tool.name === 'compile_query'));
    for (const name of ['explain_query', 'table_stats', 'migrate_status']) {
      assert.ok(!tools.some((tool) => tool.name === name));
      const reply = await h.call(name, { table: 'users' });
      assert.equal(reply.error?.code, -32602);
      assert.match(reply.error!.message, /not implemented.*sqlite/);
    }
    const facts = payload<ReturnType<typeof discoverToolCapabilities>>(await h.call('engine_capabilities'));
    assert.deepEqual(
      new Set(tools.map((tool) => tool.name)),
      new Set(facts.tools.filter((tool) => tool.implemented).map((tool) => tool.name)),
    );
    assert.equal((await h.call('table_detail', { table: 'not_users' })).error?.code, -32602);
  });

  sqlite.it(
    'compiles the SQLite dialect, executes the returned SQL independently, and never executes a user query while compiling',
    async (t) => {
      const f = fixture();
      t.after(f.cleanup);
      const recorded: string[] = [];
      const original = SqlitePool.prototype.connect;
      t.mock.method(SqlitePool.prototype, 'connect', async function (this: SqlitePool) {
        const client = await original.call(this);
        const query = client.query.bind(client);
        client.query = (sql, params) => {
          recorded.push(sql);
          return query(sql, params);
        };
        return client;
      });
      const report = await compile(f.options, {
        args: { select: { id: true, displayName: true }, where: { id: { in: [2] } }, limit: 4 },
      });
      assert.equal(report.ok, true);
      if (!report.ok) throw new Error('compile failed');
      assert.match(report.sql, /json_each/);
      assert.equal(report.preparedStatement.named, false);
      assert.ok(recorded.length > 0);
      assert.ok(
        recorded.every((sql) => ['BEGIN', 'COMMIT'].includes(sql)),
        'compile must only use the snapshot transaction via the pool',
      );
      const db = new Database!(f.path);
      const pool = new SqlitePool(db);
      try {
        const actual = await pool.query(report.sql, report.params);
        assert.deepEqual(
          actual.rows.map((row: { id: number; display_name: string }) => ({ ...row })),
          [{ id: 2, display_name: 'Second' }],
        );
      } finally {
        await pool.end();
      }
      await assert.rejects(async () => SEALED_POOL.query(report.sql), /must never execute/);
      const invalid = await compile(f.options, { args: { where: { nonexistent: 1 } } });
      assert.equal(invalid.ok, false);
      if (invalid.ok) throw new Error('invalid field compiled');
      assert.equal(invalid.error.code, 'TURBINE_E003');
      assert.ok(invalid.error.howToFix!.length > 0);
      await assert.rejects(compile(f.options, { args: { distinctOn: ['displayName'] } }), /does not recognize/);
    },
  );

  sqlite.it('compiler reports follow transport facts when the SQLite dialect is renamed', (t) => {
    const f = fixture();
    t.after(f.cleanup);
    const db = new Database!(f.path, { readOnly: true });
    let metadata: ReturnType<typeof introspectSqliteDatabase>;
    try {
      metadata = introspectSqliteDatabase(db);
    } finally {
      db.close();
    }
    const input = {
      metadata,
      table: metadata.tables.users!,
      operation: 'findMany' as const,
      args: { select: { id: true }, limit: 1 },
    };
    const original = compileQueryPlan({ ...input, dialect: sqliteDialect });
    const renamed = compileQueryPlan({ ...input, dialect: { ...sqliteDialect, name: 'custom-dialect' } });
    assert.equal(original.ok, true);
    assert.deepEqual(renamed, original);
  });

  sqlite.it('compiles counts, aggregates, groups and relations through existing builders', async (t) => {
    const f = fixture();
    t.after(f.cleanup);
    const db = new Database!(f.path);
    const pool = new SqlitePool(db);
    try {
      for (const [operation, args] of [
        ['count', { where: { id: { gte: 1 } } }],
        ['aggregate', { _sum: { id: true } }],
        ['groupBy', { by: ['displayName'], _count: { _all: true } }],
        ['findUnique', { where: { id: 1 }, with: { posts: true }, relationLoadStrategy: 'join' }],
        ['findFirst', { orderBy: { id: 'asc' } }],
      ] as const) {
        const report = await compile(f.options, { operation, args });
        assert.equal(report.ok, true, JSON.stringify(report));
        if (!report.ok) throw new Error('compile failed');
        const result = await pool.query(report.sql, report.params);
        assert.ok(result.rows.length > 0, operation);
        if (operation === 'count') assert.equal(Number(result.rows[0].count), 2);
        if (operation === 'findUnique') {
          assert.match(JSON.stringify(result.rows), /Actual post/);
          assert.match(report.statements.note, /JSON subqueries/);
        }
      }
    } finally {
      await pool.end();
    }
  });

  sqlite.it(
    'projects tagged and secret values out of sampling and refuses predicate or aggregate probes',
    async (t) => {
      const f = fixture();
      t.after(f.cleanup);
      const h = harness(f.options);
      t.after(h.dispose);
      const sampleSql: string[] = [];
      const original = SqlitePool.prototype.connect;
      t.mock.method(SqlitePool.prototype, 'connect', async function (this: SqlitePool) {
        const client = await original.call(this);
        const query = client.query.bind(client);
        client.query = (sql, params) => {
          sampleSql.push(sql);
          return query(sql, params);
        };
        return client;
      });
      const sample = payload<{
        rowCount: number;
        rows: { display_name: string; email: string; api_key: string }[];
        redactedColumns: string[];
        piiTagSource: { state: string };
      }>(await h.call('sample_rows', { table: 'users' }));
      assert.equal(sample.rowCount, 2);
      assert.equal(sample.rows[0]!.display_name, 'First');
      assert.equal(sample.rows[0]!.email, '•• redacted ••');
      assert.equal(sample.rows[0]!.api_key, '•• redacted ••');
      assert.deepEqual(new Set(sample.redactedColumns), new Set(['email', 'api_key']));
      assert.equal(sample.piiTagSource.state, 'ok');
      const selects = sampleSql.filter((sql) => sql.startsWith('SELECT'));
      assert.equal(selects.length, 1);
      assert.doesNotMatch(selects[0]!, /email|api_key/);
      const control = new Database!(f.path);
      assert.equal(
        (control.prepare('SELECT api_key FROM users WHERE id=1').get() as { api_key: string }).api_key,
        'secret-one',
      );
      control.close();
      assert.doesNotMatch(JSON.stringify(sample), /tagged@example|secret-one|secret-two/);
      for (const args of [
        { where: { email: 'tagged@example.test' } },
        { orderBy: { apiKey: 'asc' } },
        { with: { posts: { where: { user: { email: 'tagged@example.test' } } } } },
      ]) {
        const reply = await h.call('compile_query', { table: 'users', args });
        assert.equal(reply.error?.code, -32602, JSON.stringify(reply));
        assert.doesNotMatch(JSON.stringify(reply), /tagged@example\.test/);
      }
      const aggregate = await h.call('compile_query', {
        table: 'users',
        operation: 'aggregate',
        args: { _min: { email: true } },
      });
      assert.equal(aggregate.error?.code, -32602);
      const safe = payload<{ ok: boolean }>(
        await h.call('compile_query', { table: 'users', args: { where: { displayName: 'First' } } }),
      );
      assert.equal(safe.ok, true);
    },
  );

  sqlite.it('runs the scoped single-shot doctor on the actual owned read-only transport', async (t) => {
    const f = fixture();
    t.after(f.cleanup);
    const report = (await runToolCommand({ command: 'doctor', positional: [] }, f.options)) as {
      engine: string;
      formatVersion: number;
      checks: { code: string }[];
    };
    assert.equal(report.engine, 'sqlite');
    assert.equal(report.formatVersion, 1);
    assert.ok(report.checks.some((check) => check.code === 'SQLITE_FK_CHILD_INDEX'));
    assert.doesNotMatch(JSON.stringify(report), /tagged@example|secret-one|secret-two/);
  });

  sqlite.it('unreadable metadata fails closed; absent metadata reports the weaker name-only boundary', async (t) => {
    const f = fixture();
    t.after(f.cleanup);
    writeFileSync(join(f.dir, 'metadata.ts'), 'export const SCHEMA = "not generated metadata";');
    const unreadable = (await runReadOnlyTool(f.options, 'sample_rows', { table: 'users' })) as {
      rows: Record<string, unknown>[];
      piiTagSource: { state: string };
    };
    assert.equal(unreadable.piiTagSource.state, 'tags-unreadable');
    assert.equal(unreadable.rows.length, 2);
    assert.ok(Object.values(unreadable.rows[0]!).every((value) => value === '•• redacted ••'));
    await assert.rejects(compile(f.options, { args: { where: { id: 1 } } }), /PII|tag/i);
    rmSync(join(f.dir, 'metadata.ts'));
    const absent = (await runReadOnlyTool(f.options, 'sample_rows', { table: 'users' })) as {
      rows: { email: string; api_key: string }[];
      piiTagSource: { state: string };
    };
    assert.equal(absent.piiTagSource.state, 'no-metadata-file');
    assert.equal(absent.rows[0]!.email, 'tagged@example.test');
    assert.equal(absent.rows[0]!.api_key, '•• redacted ••');
  });

  sqlite.it('refuses writes, raw SQL and locking reads before accessing a missing database', async (t) => {
    const f = fixture();
    t.after(f.cleanup);
    const options = { ...f.options, url: join(f.dir, 'missing.sqlite') };
    for (const args of [
      { table: 'users', operation: 'deleteMany' },
      { sql: 'DROP TABLE users' },
      { table: 'users', args: { lock: 'update' } },
      { table: 'users', args: [] },
    ])
      await assert.rejects(runReadOnlyTool(options, 'compile_query', args), /operation|SQL|lock|args/i);
    assert.equal(existsSync(options.url), false);
    await assert.rejects(runReadOnlyTool(options, 'schema_overview'), /existing database/);
    assert.equal(existsSync(options.url), false);
    for (const path of [
      ':memory:',
      'postgres://user:secret@localhost/db',
      'mysql://localhost/db',
      'file:db?mode=rwc',
    ]) {
      await assert.rejects(
        runReadOnlyTool({ ...options, url: path }, 'schema_overview'),
        /persistent|PostgreSQL|network|query parameters/,
      );
    }
    assert.throws(() => startMcpServer(f.options, { pool: SEALED_POOL }), /injected pool/);
    assert.throws(() => createSqliteToolPool(f.path, 'attached'), /schema "main"/);
  });

  sqlite.it('native read-only enforcement blocks actual writes and tool ownership closes every handle', async (t) => {
    const f = fixture();
    t.after(f.cleanup);
    const original = readFileSync(f.path);
    const pool = createSqliteToolPool(`file://${f.path}`, 'main');
    const first = await pool.connect();
    const second = await pool.connect();
    assert.equal(introspectSqliteToolClient(first, {}).tables.users!.name, 'users');
    await first.query('BEGIN');
    await assert.rejects(first.query("UPDATE users SET display_name = 'tampered' WHERE id = 1"), /readonly|read.only/i);
    await first.query('ROLLBACK');
    assert.equal(
      (await second.query<{ display_name: string }>('SELECT display_name FROM users WHERE id = 1')).rows[0]!
        .display_name,
      'First',
    );
    first.release();
    first.release();
    await assert.rejects(first.query('SELECT 1'), /released/);
    await pool.end();
    await pool.end();
    await assert.rejects(second.query('SELECT 1'), /released/);
    await assert.rejects(pool.connect(), /closed/);
    assert.deepEqual(readFileSync(f.path), original);
    const control = new Database!(f.path);
    control.exec("UPDATE users SET display_name = 'Changed' WHERE id=1");
    assert.equal(
      (control.prepare('SELECT display_name FROM users WHERE id=1').get() as { display_name: string }).display_name,
      'Changed',
    );
    control.close();
    assert.notDeepEqual(readFileSync(f.path), original, 'negative control must actually change the database');
  });

  sqlite.it('closes a checkout that races shutdown and leaves no owned native handle alive', async (t) => {
    const f = fixture();
    t.after(f.cleanup);
    let closed = 0;
    const original = Database!.prototype.close;
    t.mock.method(Database!.prototype, 'close', function (this: DatabaseSync) {
      closed++;
      return original.call(this);
    });
    const pool = createSqliteToolPool(f.path, 'main');
    const pending = pool.connect();
    await pool.end();
    await assert.rejects(pending, /closed/);
    assert.equal(closed, 1);
    await assert.rejects(pool.query('SELECT 1'), /scoped read-only/);
  });

  sqlite.it('retains failed checkout cleanup until the pool can close its native handle', async (t) => {
    const f = fixture();
    t.after(f.cleanup);
    const close = Database!.prototype.close;
    let captured: DatabaseSync | undefined;
    let attempts = 0;
    const mock = t.mock.method(Database!.prototype, 'close', function (this: DatabaseSync) {
      captured = this;
      if (++attempts === 1) throw new Error('native cleanup unavailable');
      return close.call(this);
    });
    t.mock.method(SqlitePool.prototype, 'connect', async () => {
      throw new Error('checkout unavailable');
    });
    const pool = createSqliteToolPool(f.path, 'main');
    try {
      await assert.rejects(pool.connect(), /checkout and cleanup failed/);
      assert.equal(captured?.isOpen, true, 'failed native close prerequisite');
      await pool.end();
      assert.equal(captured?.isOpen, false);
      assert.equal(attempts, 2);
    } finally {
      mock.mock.restore();
      await pool.end();
    }
  });

  sqlite.it('pool shutdown attempts every handle and retains failed closes for an explicit retry', async (t) => {
    const f = fixture();
    t.after(f.cleanup);
    const pool = createSqliteToolPool(f.path, 'main');
    const first = await pool.connect();
    const second = await pool.connect();
    const close = Database!.prototype.close;
    const handles: DatabaseSync[] = [];
    const mock = t.mock.method(Database!.prototype, 'close', function (this: DatabaseSync) {
      handles.push(this);
      if (handles.length === 1) throw new Error('first handle close unavailable');
      return close.call(this);
    });
    try {
      await assert.rejects(pool.end(), /SQLite tool cleanup failed/);
      assert.equal(handles.length, 2, 'a failed close must not prevent another handle from closing');
      assert.equal(handles[0]!.isOpen, true);
      assert.equal(handles[1]!.isOpen, false);
      await assert.rejects(first.query('SELECT 1'), /released/);
      await assert.rejects(second.query('SELECT 1'), /released/);
      assert.throws(() => introspectSqliteToolClient(first, {}), /active SQLite tool/);
      await pool.end();
      assert.equal(handles[0]!.isOpen, false);
      assert.equal(handles.length, 3);
    } finally {
      mock.mock.restore();
      await pool.end();
    }
  });

  sqlite.it('the actual CLI MCP process returns schema, compile and error payloads over stdio', async (t) => {
    const f = fixture();
    t.after(f.cleanup);
    const before = readFileSync(f.path);
    const child = spawn(
      process.execPath,
      [
        '--import',
        join(repo, 'node_modules/tsx/dist/loader.mjs'),
        join(repo, 'src/cli/index.ts'),
        'mcp',
        '--engine',
        'sqlite',
        '--url',
        f.path,
        '--out',
        f.dir,
      ],
      {
        cwd: f.dir,
        env: { ...process.env, DATABASE_URL: '', NO_COLOR: '1' },
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 10_000,
      },
    );
    t.after(() => {
      if (child.exitCode === null) child.kill();
    });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const replies: Reply[] = [];
    let buffer = '';
    const completion = new Promise<void>((resolve, reject) => {
      child.on('error', reject);
      child.stdout.on('data', (chunk: Buffer) => {
        buffer += chunk.toString();
        for (let next = buffer.indexOf('\n'); next !== -1; next = buffer.indexOf('\n')) {
          replies.push(JSON.parse(buffer.slice(0, next)) as Reply);
          buffer = buffer.slice(next + 1);
          if (replies.length === 3) child.stdin.end();
        }
      });
      child.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`MCP exited ${code}: ${stderr}`));
      });
    });
    for (const [index, [name, args]] of [
      ['schema_overview', {}],
      ['compile_query', { table: 'users', args: { where: { id: 1 } } }],
      ['explain_error', { code: 'E003' }],
    ].entries())
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: '2.0', id: index + 1, method: 'tools/call', params: { name, arguments: args } })}\n`,
      );
    await completion;
    assert.equal(replies.length, 3);
    const results = replies.map((reply) => payload<Record<string, unknown>>(reply));
    assert.ok(results.some((result) => Array.isArray(result.tables) && result.tables.length === 2));
    assert.ok(results.some((result) => result.ok === true && result.executed === false));
    assert.ok(results.some((result) => result.code === 'TURBINE_E003'));
    assert.deepEqual(readFileSync(f.path), before);
  });

  sqlite.it('single-shot CLI emits real schema, compile and catalog JSON with no writes', async (t) => {
    const f = fixture();
    t.after(f.cleanup);
    const original = readFileSync(f.path);
    const run = (args: string[]) =>
      spawnSync(
        process.execPath,
        [
          '--import',
          join(repo, 'node_modules/tsx/dist/loader.mjs'),
          join(repo, 'src/cli/index.ts'),
          ...args,
          '--engine',
          'sqlite',
          '--url',
          f.path,
          '--out',
          f.dir,
        ],
        {
          cwd: f.dir,
          encoding: 'utf8',
          env: { ...process.env, DATABASE_URL: '', NO_COLOR: '1' },
          timeout: 30_000,
        },
      );
    for (const args of [
      ['schema'],
      ['schema', 'users'],
      ['compile', '{"table":"users","args":{"where":{"id":1}}}'],
      ['capabilities'],
      ['explain-error', 'E003'],
    ]) {
      const result = run(args);
      assert.equal(result.status, 0, result.stderr + result.stdout);
      const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
      assert.ok(Object.keys(parsed).length > 0);
      if (args[0] === 'compile') {
        assert.equal(parsed.ok, true);
        assert.equal(parsed.executed, false);
      }
    }
    const refused = run(['compile', '{"table":"users","operation":"delete"}']);
    assert.equal(refused.status, 1);
    assert.match(refused.stdout + refused.stderr, /operation must be/);
    const extra = run(['schema', 'users', 'ignored']);
    assert.equal(extra.status, 1);
    assert.deepEqual(readFileSync(f.path), original);
    await assert.rejects(
      runToolCommand({ command: 'compile', subcommand: 'null', positional: [] }, f.options),
      /JSON object/,
    );
    await assert.rejects(
      runToolCommand({ command: 'compile', subcommand: '{', positional: [] }, f.options),
      /one JSON object/,
    );
  });
});
