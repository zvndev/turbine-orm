/**
 * The MCP server's index metadata is `turbine generate`'s index metadata.
 *
 * The server introspects for itself, and it used to build its index list with
 * no `partial` flag. A PARTIAL unique index over a junction's two foreign keys
 * (`UNIQUE (a, b) WHERE a = 1`) therefore read as a table-wide junction key,
 * the server derived a `lefts.rights` manyToMany that the generated client
 * does not have, and `compile_query` compiled a join that returned the same
 * right row twice. Both surfaces now build the metadata with
 * `indexMetadataFromDefinition`, so they agree on unique, partial and columns.
 *
 * Run: DATABASE_URL=... npx tsx --test src/test/mcp-index-metadata.test.ts
 */

import assert from 'node:assert/strict';
import { describe } from 'node:test';
import pg from 'pg';
import { runReadOnlyTool } from '../cli/mcp.js';
import { introspect } from '../introspect.js';
import { skipGate } from './helpers.js';

const PG_URL = process.env.DATABASE_URL;
const gate = skipGate(!PG_URL, 'DATABASE_URL not set');

describe('mcp: index metadata matches introspection', () => {
  // A database of its own: other suites introspect the shared one in parallel.
  const DB = 'turbine_mcp_index_metadata';
  const url = PG_URL ? PG_URL.replace(/\/[^/?]+(\?|$)/, `/${DB}$1`) : '';

  async function admin(sql: string): Promise<void> {
    const client = new pg.Client({ connectionString: PG_URL });
    await client.connect();
    try {
      await client.query(sql);
    } finally {
      await client.end();
    }
  }

  gate.before(async () => {
    await admin(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
    await admin(`CREATE DATABASE ${DB}`);
    const raw = new pg.Client({ connectionString: url });
    await raw.connect();
    try {
      await raw.query(`
        CREATE TABLE lefts (id int PRIMARY KEY);
        CREATE TABLE rights (id int PRIMARY KEY);
        CREATE TABLE links (a int REFERENCES lefts(id), b int REFERENCES rights(id));
        CREATE UNIQUE INDEX partial_pair ON links (a, b) WHERE a = 1;
        INSERT INTO lefts VALUES (2);
        INSERT INTO rights VALUES (3);
        INSERT INTO links VALUES (2, 3), (2, 3);
        -- A control: the same junction under a table-wide unique index.
        CREATE TABLE ups (id int PRIMARY KEY);
        CREATE TABLE downs (id int PRIMARY KEY);
        CREATE TABLE pairs (up_id int REFERENCES ups(id), down_id int REFERENCES downs(id));
        CREATE UNIQUE INDEX pairs_key ON pairs (up_id, down_id);
        -- And a unique index with an expression key.
        CREATE TABLE tags (id int PRIMARY KEY, kind text, slug text);
        CREATE UNIQUE INDEX tags_kind_slug ON tags (kind, lower(slug));
      `);
    } finally {
      await raw.end();
    }
  });

  gate.after(async () => {
    await admin(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
  });

  const tool = (name: string, args: Record<string, unknown>) =>
    runReadOnlyTool({ url, schema: 'public', migrationsDir: 'migrations' }, name, args as never) as Promise<
      Record<string, unknown>
    >;
  const relationTypes = (detail: Record<string, unknown>) =>
    Object.fromEntries((detail.relations as { name: string; type: string }[]).map((r) => [r.name, r.type]));

  gate.it('a partial unique junction index derives no manyToMany, as in generate', async () => {
    const schema = await introspect({ connectionString: url, logger: {} });
    assert.equal(schema.tables.lefts!.relations.rights, undefined);
    const lefts = await tool('table_detail', { table: 'lefts' });
    assert.equal(relationTypes(lefts).rights, undefined, 'the server must not invent the relation');
    assert.deepEqual(
      relationTypes(lefts),
      Object.fromEntries(Object.entries(schema.tables.lefts!.relations).map(([n, r]) => [n, r.type])),
    );
    // And compile_query refuses it by name instead of compiling a duplicating join.
    const compiled = await tool('compile_query', {
      table: 'lefts',
      operation: 'findMany',
      args: { where: { id: 2 }, with: { rights: true }, limit: 10 },
    });
    assert.equal(compiled.sql, undefined);
    assert.match(JSON.stringify(compiled), /TURBINE_E005/);
  });

  gate.it('a table-wide unique junction index still derives the manyToMany on both surfaces', async () => {
    const schema = await introspect({ connectionString: url, logger: {} });
    assert.equal(schema.tables.ups!.relations.downs?.type, 'manyToMany');
    assert.equal(relationTypes(await tool('table_detail', { table: 'ups' })).downs, 'manyToMany');
  });

  gate.it('the index display reports the partial predicate and the database flag', async () => {
    const links = await tool('table_detail', { table: 'links' });
    const index = (links.indexes as Record<string, unknown>[]).find((i) => i.name === 'partial_pair');
    assert.equal(index?.partial, true);
    assert.equal(index?.unique, true);
    assert.deepEqual(index?.columns, ['a', 'b']);
    assert.match(String(index?.definition), /WHERE \(predicate withheld\)$/);
    // An expression key is reported withheld, and the index is UNIQUE in the database.
    const tags = await tool('table_detail', { table: 'tags' });
    const expr = (tags.indexes as Record<string, unknown>[]).find((i) => i.name === 'tags_kind_slug');
    assert.deepEqual([expr?.unique, expr?.columns, expr?.columnsWithheld], [true, ['kind'], true]);
  });

  gate.it('compile_query does not take a column of an expression unique index as a unique key', async () => {
    const compiled = await tool('compile_query', {
      table: 'tags',
      operation: 'findUnique',
      args: { where: { kind: 'a' } },
    });
    assert.equal(compiled.sql, undefined);
    assert.match(JSON.stringify(compiled), /TURBINE_E003/);
  });
});
