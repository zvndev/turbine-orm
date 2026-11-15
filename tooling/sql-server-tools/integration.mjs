/**
 * Run after building:
 * node tooling/sql-server-tools/integration.mjs /absolute/path/to/package [esm|cjs]
 * Uses an observable driver fixture, never a live database.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(process.argv[2] ?? '.');
const format = process.argv[3] === 'cjs' ? 'dist/cjs' : 'dist';
const require = createRequire(join(root, 'package.json'));
const driver = require('mssql');
const original = driver.ConnectionPool;
const fixture = createRequire(import.meta.url)('../../src/test/fixtures/mssql-tools-driver.cjs');
const scratch = mkdtempSync(join(tmpdir(), 'turbine-mssql-tools-integration-'));
const oldLog = process.env.MSSQL_TOOLS_LOG;
const oldMode = process.env.MSSQL_TOOLS_MODE;
process.env.MSSQL_TOOLS_LOG = join(scratch, 'events.jsonl');
process.env.MSSQL_TOOLS_MODE = '';
writeFileSync(process.env.MSSQL_TOOLS_LOG, '');
driver.ConnectionPool = fixture.ConnectionPool;
const events = () => readFileSync(process.env.MSSQL_TOOLS_LOG, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
try {
  const { runReadOnlyTool, startMcpServer } = await import(pathToFileURL(join(root, format, 'cli/mcp.js')).href);
  const { runToolCommand } = await import(pathToFileURL(join(root, format, 'cli/tool-command.js')).href);
  const options = { engine: 'mssql', url: 'mssql://host/fixture', schema: 'app', migrationsDir: join(scratch, 'migrations') };
  const caps = await runReadOnlyTool({ ...options, url: '' }, 'engine_capabilities');
  assert.equal(caps.engine, 'mssql');
  assert.equal(caps.connectivity, 'not-probed');
  assert.equal(caps.transport.transactions, false);
  assert.equal(caps.sql.readOnlyTransactions, false);
  assert.equal(caps.tools.filter((tool) => tool.implemented).length, 8);
  const explanation = await runReadOnlyTool({ ...options, url: '' }, 'explain_error', { code: 'E003' });
  assert.equal(explanation.code, 'TURBINE_E003');
  assert.equal(events().length, 0);
  for (const name of ['sample_rows', 'explain_query', 'table_stats', 'migrate_status']) {
    await assert.rejects(runReadOnlyTool(options, name, { table: 'users' }), /not implemented/);
  }
  await assert.rejects(runReadOnlyTool(options, 'compile_query', { sql: 'DELETE FROM users' }), /never accepts SQL/);
  await assert.rejects(runReadOnlyTool(options, 'compile_query', { table: 'users', args: { lock: 'update' } }), /lock/);
  assert.equal(events().length, 0, 'refusals must precede driver construction');
  assert.throws(() => startMcpServer(options, { pool: {} }), /injected pool/);
  const overview = await runReadOnlyTool(options, 'schema_overview');
  assert.deepEqual(overview.tables.map((table) => table.name), ['posts', 'users']);
  assert.ok(overview.tables.every((table) => table.estimatedRows === null));
  const detail = await runReadOnlyTool(options, 'table_detail', { table: 'users' });
  for (const name of ['derived', 'row_version']) {
    assert.equal(detail.columns.find((column) => column.name === name).isGeneratedStored, true);
  }
  assert.equal(detail.columns.find((column) => column.name === 'email').isGeneratedStored, false);
  assert.equal(detail.indexes[0].partial, true);
  assert.equal(detail.indexes[0].definitionWithheld, true);
  assert.doesNotMatch(JSON.stringify(detail), /private-default|private-filter|private-computed/);
  const graph = await runReadOnlyTool(options, 'relation_graph');
  assert.match(JSON.stringify(graph), /posts/);
  assert.match(JSON.stringify(graph), /users/);
  const path = await runReadOnlyTool(options, 'find_join_path', { from: 'posts', to: 'users' });
  assert.equal(path.found, true);
  const compiled = await runToolCommand({ command: 'compile', subcommand: JSON.stringify({ table: 'users', args: { where: { displayName: 'caller text' }, with: { posts: true }, limit: 2 } }), positional: [] }, options);
  assert.equal(compiled.ok, true);
  assert.equal(compiled.executed, false);
  assert.match(compiled.sql, /@p1/);
  assert.match(compiled.sql, /FOR JSON PATH/);
  assert.ok(compiled.params.includes('caller text'));
  assert.doesNotMatch(compiled.sql, /caller text/);
  await assert.rejects(runReadOnlyTool(options, 'compile_query', { table: 'users', operation: 'deleteMany', args: {} }), /operation/);
  writeFileSync(join(scratch, 'metadata.ts'), "export const schema = { tables: { users: { columns: [{ name: 'email', pii: true }] } } };");
  await assert.rejects(runReadOnlyTool({ ...options, metadataDir: scratch }, 'compile_query', { table: 'users', args: { where: { email: 'private@example.test' } } }), /PII|hidden|tagged/i);
  writeFileSync(join(scratch, 'metadata.ts'), 'unreadable metadata');
  await assert.rejects(runReadOnlyTool({ ...options, metadataDir: scratch }, 'compile_query', { table: 'users', args: { where: { id: 1 } } }), /PII|tag|metadata/i);
  const input = new PassThrough();
  const output = new PassThrough();
  let answer = '';
  output.on('data', (chunk) => { answer += chunk.toString(); });
  const server = startMcpServer(options, { input, output });
  try {
    input.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) + '\n');
    await new Promise((resolve) => setImmediate(resolve));
    const list = JSON.parse(answer.trim()).result.tools;
    assert.equal(list.length, 8);
    assert.ok(!list.some((tool) => tool.name === 'sample_rows'));
  } finally { await server.dispose(); }
  const all = events();
  assert.ok(all.filter((event) => event.event === 'query').length > 0);
  assert.equal(all.filter((event) => event.event === 'construct').length, all.filter((event) => event.event === 'close').length);
  for (const read of all.filter((event) => event.event === 'query')) {
    assert.match(read.sql, /^SELECT /);
    assert.match(read.sql, /sys\.|INFORMATION_SCHEMA\./);
    assert.deepEqual(read.params, { p1: 'app' });
    assert.doesNotMatch(read.sql, /BEGIN|COMMIT|ROLLBACK|SET /);
  }
  console.log('SQL Server shared integration cases passed (' + format + ').');
} finally {
  driver.ConnectionPool = original;
  if (oldLog === undefined) delete process.env.MSSQL_TOOLS_LOG; else process.env.MSSQL_TOOLS_LOG = oldLog;
  if (oldMode === undefined) delete process.env.MSSQL_TOOLS_MODE; else process.env.MSSQL_TOOLS_MODE = oldMode;
  rmSync(scratch, { recursive: true, force: true });
}
