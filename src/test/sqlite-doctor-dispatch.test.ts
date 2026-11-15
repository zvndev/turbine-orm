/** Actual integrated CLI/MCP dispatch in a disposable source copy. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { describe, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { sqliteToolRuntime } from '../cli/sqlite-tools.js';
import { skipGate } from './helpers.js';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const native = skipGate(
  !sqliteToolRuntime().available,
  'SQLite doctor dispatch requires node:sqlite readOnly (Node >= 22.12)',
);

/** Test-only staging; shared production files are never edited in the checkout. */
function stage(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'turbine-sqlite-doctor-dispatch-'));
  t.after(() => {
    rmSync(root, { force: true, recursive: true });
    assert.equal(existsSync(root), false);
  });
  const staged = join(root, 'stage');
  mkdirSync(staged);
  cpSync(join(repo, 'src'), join(staged, 'src'), { recursive: true, filter: (path) => !path.includes('/src/test') });
  cpSync(join(repo, 'package.json'), join(staged, 'package.json'));
  symlinkSync(join(repo, 'node_modules'), join(staged, 'node_modules'), 'dir');
  const Database = createRequire(import.meta.url)('node:sqlite').DatabaseSync as typeof DatabaseSync;
  const path = join(root, 'app.sqlite');
  const db = new Database(path);
  try {
    db.exec(
      'CREATE TABLE parent(id INTEGER PRIMARY KEY); CREATE TABLE child(parent_id INTEGER REFERENCES parent(id));',
    );
  } finally {
    db.close();
  }
  const run = (args: string[], input?: string) =>
    spawnSync(
      process.execPath,
      ['--import', join(repo, 'node_modules/tsx/dist/loader.mjs'), join(staged, 'src/cli/index.ts'), ...args],
      {
        cwd: root,
        env: { ...process.env, DATABASE_URL: '', NO_COLOR: '1' },
        encoding: 'utf8',
        input,
        timeout: 30_000,
      },
    );
  return { root, staged, path, run };
}

describe('actual integrated SQLite doctor dispatch in disposable source staging', () => {
  native.it('actual doctor text/JSON and capability discovery reach the scoped adapter', (t) => {
    const f = stage(t);
    const before = readFileSync(f.path);
    const args = ['--engine', 'sqlite', '--url', f.path];
    const json = f.run(['doctor', '--json', ...args]);
    assert.equal(json.status, 0, json.stdout + json.stderr);
    const report = JSON.parse(json.stdout);
    assert.equal(report.formatVersion, 1);
    assert.equal(report.engine, 'sqlite');
    assert.equal(report.ok, false);
    assert.ok(
      report.checks.some(
        (check: { code: string; status: string }) => check.code === 'SQLITE_FK_CHILD_INDEX' && check.status === 'warn',
      ),
    );
    const text = f.run(['doctor', ...args]);
    assert.equal(text.status, 0, text.stdout + text.stderr);
    assert.match(text.stdout, /SQLite doctor.*read-only/);
    const facts = f.run(['capabilities', '--engine', 'sqlite']);
    assert.equal(facts.status, 0, facts.stdout + facts.stderr);
    assert.equal(
      JSON.parse(facts.stdout).tools.find((tool: { name: string }) => tool.name === 'doctor_report').implemented,
      true,
    );
    const help = f.run(['doctor', '--engine', 'sqlite', '--help']);
    assert.equal(help.status, 0, help.stdout + help.stderr);
    assert.match(help.stdout, /child-index/);
    assert.deepEqual(readFileSync(f.path), before);
  });

  native.it('actual CLI refuses PG-only flags and malformed operands before a missing-file open', (t) => {
    const f = stage(t);
    const missing = join(f.root, 'missing.sqlite');
    for (const flag of [
      '--fix',
      '--unused',
      '--audit',
      '--min-scans',
      '--metrics-url',
      '--no-plan-divergence',
      '--allow-pooler',
      '--no-concurrently',
    ]) {
      const operands = flag === '--min-scans' ? ['0'] : flag === '--metrics-url' ? ['unreachable'] : [];
      const result = f.run(['doctor', '--engine', 'sqlite', '--url', missing, flag, ...operands]);
      assert.equal(result.status, 1, result.stdout + result.stderr);
      assert.match(result.stdout + result.stderr, /SQLite doctor does not support option/);
      assert.doesNotMatch(result.stdout + result.stderr, /ENOENT|connect ECONNREFUSED/);
    }
    const malformed = f.run(['doctor', '--engine', 'sqlite', '--url', '--json']);
    assert.equal(malformed.status, 1);
    assert.match(malformed.stdout + malformed.stderr, /requires a value/);
    assert.equal(existsSync(missing), false);
  });

  native.it('missing-file CLI and MCP responses withhold filesystem paths', (t) => {
    const f = stage(t);
    const missing = join(f.root, 'private-path-canary.sqlite');
    const args = ['--engine', 'sqlite', '--url', missing];
    const cli = f.run(['doctor', '--json', ...args]);
    assert.equal(cli.status, 1);
    assert.match(cli.stderr + cli.stdout, /accessible existing database/);
    assert.doesNotMatch(cli.stderr + cli.stdout, /private-path-canary/);
    assert.ok(!(cli.stderr + cli.stdout).includes(f.root));
    const mcp = f.run(
      ['mcp', ...args],
      `${JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'doctor_report', arguments: {} } })}\n`,
    );
    assert.equal(mcp.status, 0, mcp.stderr);
    const reply = JSON.parse(mcp.stdout);
    assert.equal(reply.id, 7);
    assert.equal(reply.error.code, -32603);
    assert.match(reply.error.data, /accessible existing database/);
    assert.doesNotMatch(mcp.stderr + mcp.stdout, /private-path-canary/);
    assert.ok(!(mcp.stderr + mcp.stdout).includes(f.root));
    assert.equal(existsSync(missing), false);
  });

  native.it('config override warnings withhold SQLite paths on doctor and MCP', (t) => {
    const f = stage(t);
    writeFileSync(
      join(f.root, 'turbine.config.mjs'),
      `export default ${JSON.stringify({ engine: 'sqlite', url: join(f.root, 'config-private.sqlite') })}`,
    );
    writeFileSync(join(f.root, '.env'), `DATABASE_URL=${f.path}\n`);
    const request = `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'doctor_report', arguments: {} } })}\n`;
    for (const args of [['doctor', '--json'], ['mcp']]) {
      const result = f.run(args, args[0] === 'mcp' ? request : undefined);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stderr, /DATABASE_URL from \.env.*overriding/);
      assert.ok(!(result.stderr + result.stdout).includes(f.root));
      assert.equal(result.stdout.includes('sqlite'), true, 'actual report prerequisite');
    }
  });

  native.it(
    'actual MCP JSON discovery and doctor path withhold SQL and reject request arguments before opening',
    (t) => {
      const f = stage(t);
      const requests = [
        { jsonrpc: '2.0', id: 1, method: 'tools/list' },
        { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'doctor_report', arguments: {} } },
        {
          jsonrpc: '2.0',
          id: 3,
          method: 'tools/call',
          params: { name: 'doctor_report', arguments: { sql: 'SELECT sensitive_value' } },
        },
      ];
      const before = readFileSync(f.path);
      const result = f.run(
        ['mcp', '--engine', 'sqlite', '--url', f.path],
        `${requests.map((request) => JSON.stringify(request)).join('\n')}\n`,
      );
      assert.equal(result.status, 0, result.stdout + result.stderr);
      const replies = result.stdout
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      assert.equal(replies.length, 3);
      assert.ok(
        replies
          .find((reply) => reply.id === 1)
          .result.tools.some((tool: { name: string }) => tool.name === 'doctor_report'),
      );
      const report = JSON.parse(replies.find((reply) => reply.id === 2).result.content[0].text);
      assert.equal(report.formatVersion, 1);
      assert.equal(report.engine, 'sqlite');
      assert.ok(report.checks.length > 4);
      assert.equal(replies.find((reply) => reply.id === 3).error.code, -32602);
      assert.doesNotMatch(result.stdout, /sensitive_value|pg_catalog|pg_stats/);
      assert.deepEqual(readFileSync(f.path), before);
      const missing = join(f.root, 'missing.sqlite');
      const refused = f.run(['mcp', '--engine', 'sqlite', '--url', missing], `${JSON.stringify(requests[2])}\n`);
      assert.equal(refused.status, 0, refused.stdout + refused.stderr);
      assert.equal(JSON.parse(refused.stdout).error.code, -32602);
      assert.equal(existsSync(missing), false);
    },
  );
});
