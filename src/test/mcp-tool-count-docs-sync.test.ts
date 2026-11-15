/**
 * The MCP tool counts the README and the site state, per engine, match the
 * registry `tools/list` filters by.
 *
 * The README said "eight for SQLite" while the server listed nine, and the
 * site said "eleven" after a twelfth tool shipped. Each count is derived here
 * from `READ_ONLY_TOOLS` and `toolSupported`, the same pair `tools/list`
 * uses, so no number is written in this file.
 *
 * Run: npx tsx --test src/test/mcp-tool-count-docs-sync.test.ts
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { READ_ONLY_TOOLS, type ToolEngine, toolSupported } from '../cli/tool-capabilities.js';

const root = new URL('../../', import.meta.url);
const read = (p: string): string => readFileSync(new URL(p, root), 'utf8');

const WORDS = [
  'zero',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'eleven',
  'twelve',
];

function word(n: number): string {
  const w = WORDS[n];
  assert.ok(w, `${n} tools has no number word here; extend WORDS`);
  return w;
}

function count(engine: ToolEngine): number {
  return READ_ONLY_TOOLS.filter((name) => toolSupported(engine, name)).length;
}

const pg = count('postgresql');
const sqlite = count('sqlite');
const mysql = count('mysql');
const mssql = count('mssql');

describe('documented MCP tool counts match the tool registry', () => {
  it('derives a nonzero count for every engine (anti-vacuous)', () => {
    for (const n of [pg, sqlite, mysql, mssql]) assert.ok(n > 0);
    assert.equal(pg, READ_ONLY_TOOLS.length, 'PostgreSQL exposes every implemented tool');
  });

  it('README states each engine count', () => {
    const readme = read('README.md');
    const sqliteMysql =
      sqlite === mysql
        ? `${word(sqlite)} for SQLite and MySQL`
        : `${word(sqlite)} for SQLite, ${word(mysql)} for MySQL`;
    for (const expected of [
      `read-only MCP server (${word(pg)} tools on PostgreSQL)`,
      `exposes ${word(pg)} read-only MCP tools for PostgreSQL, ${sqliteMysql} and ${word(mssql)} for SQL Server`,
      `${pg} PostgreSQL / ${sqlite} SQLite / ${mysql} MySQL / ${mssql} SQL Server read-only tools`,
    ]) {
      assert.ok(readme.includes(expected), `README.md must say "${expected}"`);
    }
  });

  it('the site MCP and AI-agents pages state the same counts', () => {
    const mcp = read('site/app/(docs)/mcp/page.mdx');
    const agents = read('site/app/(docs)/ai-agents/page.mdx');
    assert.ok(mcp.includes(`server with ${word(pg)} tools`), 'MCP page description');
    assert.ok(mcp.includes(`Those are the ${word(pg)} tools on PostgreSQL.`), 'MCP page per-engine paragraph');
    assert.equal(sqlite, mysql, 'the MCP page states one count for SQLite and MySQL; reword it if they differ');
    assert.ok(mcp.includes(`the server lists ${word(sqlite)} (`), 'MCP page SQLite and MySQL count');
    assert.ok(mcp.includes(`\`--engine mssql\` ${word(mssql)} (`), 'MCP page SQL Server count');
    for (const name of READ_ONLY_TOOLS) {
      assert.ok(mcp.includes(`| \`${name}\` |`), `MCP page tool table must list ${name}`);
    }
    assert.ok(agents.includes(`gives an agent ${word(pg)} read-only tools`), 'AI-agents page count');
  });

  it('`turbine mcp --help` states the same counts', () => {
    const cli = read('src/cli/index.ts');
    assert.equal(sqlite, mysql, 'the help text states one count for SQLite and MySQL; reword it if they differ');
    for (const expected of [
      `on stdin/stdout and exposes ${word(pg)}`,
      `SQLite and MySQL expose ${word(sqlite)} tools; SQL Server exposes ${word(mssql)} `,
    ]) {
      assert.ok(cli.includes(expected), `src/cli/index.ts must say "${expected}"`);
    }
  });
});
