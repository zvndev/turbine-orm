/**
 * Code-first column tags reach the generated client.
 *
 * `pii`, `updatedAt` and `maxLength` exist only in the `defineSchema()` file:
 * the database has no column for them. `turbine generate` builds the client from
 * introspection, so before the overlay a project that tagged a column `pii: true`
 * and ran `push` then `generate` got a client that RETURNED that column by
 * default and never stamped `updatedAt`, with no message about either.
 *
 * Unit half: `extractCodeFirstColumnTags` / `applyCodeFirstColumnTags`, pure.
 * Live half (DATABASE_URL): the real CLI pushes a schema file, generates a client
 * into a temp project, and the generated metadata drives a real client.
 *
 * Run: DATABASE_URL=... npx tsx --test src/test/codegen-cli-code-first-tags.test.ts
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { applyCodeFirstColumnTags, type CodeFirstTagMap, extractCodeFirstColumnTags } from '../cli/code-first-tags.js';
import { TurbineClient } from '../client.js';
import { introspect } from '../introspect.js';
import { UNSAFE } from '../query/index.js';
import type { ColumnMetadata, SchemaMetadata, TableMetadata } from '../schema.js';
import { defineSchema } from '../schema-builder.js';
import { makeProject, type Project, SRC } from './codegen-cli-fixture.js';
import { skipGate } from './helpers.js';

// ---------------------------------------------------------------------------
// Unit: extract + apply
// ---------------------------------------------------------------------------

function column(name: string, extra: Partial<ColumnMetadata> = {}): ColumnMetadata {
  return {
    name,
    field: name,
    pgType: 'text',
    tsType: 'string',
    nullable: false,
    hasDefault: false,
    isArray: false,
    pgArrayType: 'text[]',
    ...extra,
  };
}

function table(name: string, columns: ColumnMetadata[]): TableMetadata {
  return {
    name,
    columns,
    columnMap: Object.fromEntries(columns.map((c) => [c.field, c.name])),
    reverseColumnMap: Object.fromEntries(columns.map((c) => [c.name, c.field])),
    dateColumns: new Set<string>(),
    pgTypes: Object.fromEntries(columns.map((c) => [c.name, c.pgType])),
    allColumns: columns.map((c) => c.name),
    primaryKey: ['id'],
    uniqueColumns: [],
    indexes: [],
    isView: false,
    relations: {},
  };
}

function introspected(): SchemaMetadata {
  return {
    enums: {},
    tables: {
      users: table('users', [column('id', { pgType: 'int4' }), column('email'), column('updated_at'), column('nick')]),
    },
  };
}

describe('extractCodeFirstColumnTags', () => {
  it('keys tags by database table and column name', () => {
    const def = defineSchema({
      users: {
        id: { type: 'serial', primaryKey: true },
        email: { type: 'text', pii: true },
        updatedAt: { type: 'timestamptz', updatedAt: true },
        nick: { type: 'varchar', maxLength: 20 },
        settings: { type: 'jsonb', tsType: '{ theme: string }' },
        plain: { type: 'text' },
      },
    });
    const tags = extractCodeFirstColumnTags(def);
    assert.deepEqual([...tags.keys()], ['users']);
    const users = tags.get('users');
    assert.deepEqual(users?.get('email'), { pii: true });
    assert.deepEqual(users?.get('updated_at'), { updatedAt: true });
    assert.deepEqual(users?.get('nick'), { maxLength: 20 });
    assert.deepEqual(users?.get('settings'), { tsType: '{ theme: string }' });
    assert.equal(users?.has('plain'), false, 'an untagged column must not appear');
    assert.equal(users?.has('id'), false);
  });

  it('a schema with no tags yields an empty map', () => {
    assert.equal(
      extractCodeFirstColumnTags(defineSchema({ users: { id: { type: 'serial', primaryKey: true } } })).size,
      0,
    );
  });
});

describe('applyCodeFirstColumnTags', () => {
  const tags = (
    spec: Record<string, Record<string, { pii?: true; updatedAt?: true; maxLength?: number; tsType?: string }>>,
  ) => new Map(Object.entries(spec).map(([t, cols]) => [t, new Map(Object.entries(cols))])) as CodeFirstTagMap;

  it('sets pii and updatedAt on the named columns and counts them', () => {
    const schema = introspected();
    const applied = applyCodeFirstColumnTags(
      schema,
      tags({ users: { email: { pii: true }, updated_at: { updatedAt: true } } }),
    );
    const users = schema.tables.users!;
    assert.equal(users.columns.find((c) => c.name === 'email')?.pii, true);
    assert.equal(users.columns.find((c) => c.name === 'updated_at')?.updatedAt, true);
    assert.equal(users.columns.find((c) => c.name === 'nick')?.pii, undefined);
    assert.deepEqual(applied, { tables: 1, pii: 1, updatedAt: 1, maxLength: 0, columnTypes: {} });
  });

  it('maxLength only fills a gap: the length the database reported wins', () => {
    const schema = introspected();
    schema.tables.users!.columns.find((c) => c.name === 'nick')!.maxLength = 20;
    const applied = applyCodeFirstColumnTags(
      schema,
      tags({ users: { nick: { maxLength: 99 }, email: { maxLength: 50 } } }),
    );
    const users = schema.tables.users!;
    assert.equal(users.columns.find((c) => c.name === 'nick')?.maxLength, 20);
    assert.equal(users.columns.find((c) => c.name === 'email')?.maxLength, 50);
    assert.equal(applied.maxLength, 1);
  });

  it('a pii tag on a column the database lacks is an error that names it and the nearest column', () => {
    assert.throws(
      () =>
        applyCodeFirstColumnTags(introspected(), tags({ users: { emial: { pii: true } } }), {
          source: './turbine/schema.ts',
        }),
      (err: unknown) => {
        assert.equal((err as { code?: string }).code, 'TURBINE_E003');
        const message = (err as Error).message;
        assert.match(message, /column "emial" on table "users" is not in the database/);
        assert.match(message, /did you mean "email"\?/);
        assert.match(message, /turbine push/);
        assert.match(message, /\.\/turbine\/schema\.ts/);
        return true;
      },
    );
  });

  it('a pii tag on a table the database lacks is an error that names it and the nearest table', () => {
    assert.throws(
      () => applyCodeFirstColumnTags(introspected(), tags({ usrs: { email: { pii: true } } })),
      /table "usrs" is not in the database \(did you mean "users"\?\)/,
    );
  });

  it('reports every problem at once, not the first', () => {
    assert.throws(
      () =>
        applyCodeFirstColumnTags(
          introspected(),
          tags({ users: { emial: { pii: true }, updated_att: { updatedAt: true } }, nope: { x: { pii: true } } }),
        ),
      (err: unknown) => {
        const message = (err as Error).message;
        assert.match(message, /"emial"/);
        assert.match(message, /"updated_att"/);
        assert.match(message, /table "nope"/);
        return true;
      },
    );
  });

  it('a name that is an Object.prototype member is not found in the schema', () => {
    assert.throws(
      () =>
        applyCodeFirstColumnTags(
          introspected(),
          new Map([['constructor', new Map([['email', { pii: true as const }]])]]) as CodeFirstTagMap,
        ),
      /table "constructor" is not in the database/,
    );
  });

  it('a maxLength-only tag on a missing table or column is skipped, not an error', () => {
    const schema = introspected();
    const applied = applyCodeFirstColumnTags(
      schema,
      tags({ users: { gone: { maxLength: 5 } }, missing: { x: { maxLength: 5 } } }),
    );
    assert.deepEqual(applied, { tables: 0, pii: 0, updatedAt: 0, maxLength: 0, columnTypes: {} });
  });

  it('returns a declared tsType as a generator columnTypes entry, without touching the column', () => {
    const schema = introspected();
    const applied = applyCodeFirstColumnTags(
      schema,
      tags({ users: { nick: { tsType: '{ first: string }' }, gone: { tsType: 'number' } } }),
    );
    assert.deepEqual(applied.columnTypes, { 'users.nick': '{ first: string }' });
    assert.equal(applied.tables, 1);
    assert.equal(schema.tables.users!.columns.find((c) => c.name === 'nick')?.tsType, 'string');
  });

  it('a table the caller filtered out of the client is skipped, not an error', () => {
    const schema = introspected();
    const applied = applyCodeFirstColumnTags(schema, tags({ audit_log: { actor: { pii: true } } }), {
      inScope: (name) => name !== 'audit_log',
    });
    assert.equal(applied.pii, 0);
  });

  it('control: the same tag on that table IS an error while it is in scope', () => {
    assert.throws(
      () =>
        applyCodeFirstColumnTags(introspected(), tags({ audit_log: { actor: { pii: true } } }), {
          inScope: () => true,
        }),
      /table "audit_log" is not in the database/,
    );
  });
});

// ---------------------------------------------------------------------------
// Live: push, generate, run
// ---------------------------------------------------------------------------

const DATABASE_URL = process.env.DATABASE_URL;
const live = skipGate(!DATABASE_URL, 'requires DATABASE_URL');

const SUFFIX = `${process.pid}_${Date.now().toString(36)}`;
const USERS = `cgcli_users_${SUFFIX}`;
const NOT_INCLUDED = `cgcli_not_included_${SUFFIX}`;

const SCHEMA_FILE = `
import { defineSchema } from ${JSON.stringify(SRC.schemaBuilder)};
export default defineSchema({
  ${USERS}: {
    id: { type: 'serial', primaryKey: true },
    email: { type: 'text', notNull: true, pii: true },
    name: { type: 'varchar', maxLength: 40, notNull: true },
    updatedAt: { type: 'timestamptz', notNull: true, default: 'now()', updatedAt: true },
    settings: { type: 'jsonb', tsType: '{ theme: string; beta?: boolean }' },
    meta: { type: 'jsonb' },
  },
});
`;

describe('turbine generate applies the schema file tags (live)', () => {
  let project: Project;
  let pool: pg.Pool;
  let metadataPath: string;

  before(async () => {
    if (!DATABASE_URL) return;
    pool = new pg.Pool({ connectionString: DATABASE_URL, max: 2 });
    await pool.query(`CREATE TABLE IF NOT EXISTS "${NOT_INCLUDED}" (id int PRIMARY KEY, data text)`);
    project = makeProject('code-first-tags', { databaseUrl: DATABASE_URL });
    project.write('turbine/schema.ts', SCHEMA_FILE);
    project.write(
      'turbine.config.js',
      `export default { include: [${JSON.stringify(USERS)}], out: './generated/turbine', columnTypes: ${JSON.stringify({
        [`${USERS}.meta`]: 'Record<string, number>',
        // A table the database has but the include filter leaves out: dropped, not an
        // unknown-table error. A key naming a table the database does NOT have is a
        // typo and is refused (fix-cli-commands.test.ts).
        [`${NOT_INCLUDED}.data`]: 'string',
      })} };\n`,
    );
    const push = project.cli(['push']);
    assert.equal(push.status, 0, `push failed:\n${push.output}`);
    metadataPath = join(project.dir, 'generated', 'turbine', 'metadata.ts');
  });

  after(async () => {
    if (!pool) return;
    await pool.query(`DROP TABLE IF EXISTS "${USERS}" CASCADE`);
    await pool.query(`DROP TABLE IF EXISTS "${NOT_INCLUDED}"`);
    await pool.end();
    project?.cleanup();
  });

  /** A client built on the generated metadata, plus the row it inserted. */
  async function generatedClient() {
    const mod = (await import(`${pathToFileURL(metadataPath).href}?t=${Date.now()}`)) as { SCHEMA: SchemaMetadata };
    return new TurbineClient({ connectionString: DATABASE_URL!, poolSize: 2 }, mod.SCHEMA);
  }

  live.it('generate reports the tags it applied and writes them into metadata.ts', () => {
    const run = project.cli(['generate']);
    assert.equal(run.status, 0, `generate failed:\n${run.output}`);
    assert.match(run.output, /applied column tags from \.\/turbine\/schema\.ts: 1 pii, 1 updatedAt, 1 tsType/);
    // A schema-file tsType and a config columnTypes entry both reach the generated row type.
    const types = readFileSync(join(project.dir, 'generated', 'turbine', 'types.ts'), 'utf-8');
    assert.match(types, /settings: \{ theme: string; beta\?: boolean \} \| null;/);
    assert.match(types, /meta: Record<string, number> \| null;/);
    const metadata = readFileSync(metadataPath, 'utf-8');
    assert.match(metadata, /pii: true/);
    assert.match(metadata, /updatedAt: true/);
  });

  live.it('the generated client excludes the pii column by default and returns it under includePii', async () => {
    const db = await generatedClient();
    try {
      await pool.query(`INSERT INTO "${USERS}" (email, name, updated_at) VALUES ('a@example.test', 'A', '2000-01-01')`);
      const users = db.table<{ id: number; email?: string; name: string }>(USERS);
      const [row] = await users.findMany({ where: { name: 'A' }, limit: 10 });
      assert.ok(row, 'the inserted row was not found');
      assert.equal('email' in row, false, `the pii column was returned by default: ${JSON.stringify(row)}`);
      // Naming the column in `select` is not enough: only the UNSAFE symbol unlocks it.
      await assert.rejects(
        () => users.findMany({ where: { name: 'A' }, select: { email: true, name: true }, limit: 10 }),
        /names "email", which is tagged PII/,
      );
      const [withEmail] = await users.findMany({
        where: { name: 'A' },
        select: { email: true, name: true },
        includePii: UNSAFE,
        limit: 10,
      });
      assert.equal(withEmail?.email, 'a@example.test');
    } finally {
      await db.disconnect();
    }
  });

  live.it('the generated client stamps updatedAt on update', async () => {
    const db = await generatedClient();
    try {
      await pool.query(`INSERT INTO "${USERS}" (email, name, updated_at) VALUES ('b@example.test', 'B', '2000-01-01')`);
      const users = db.table<{ id: number; name: string; updatedAt: Date }>(USERS);
      const [before] = await users.findMany({ where: { name: 'B' }, limit: 10 });
      assert.ok(before);
      assert.ok(before.updatedAt < new Date('2001-01-01'), 'the fixture row should start in 2000');
      const updated = await users.update({ where: { id: before.id }, data: { name: 'B2' } });
      assert.ok(updated.updatedAt > new Date('2020-01-01'), `updatedAt was not stamped: ${String(updated.updatedAt)}`);
    } finally {
      await db.disconnect();
    }
  });

  live.it('control: a client built from introspection alone has neither behavior', async () => {
    const schema = await introspect({ connectionString: DATABASE_URL!, include: [USERS] });
    const db = new TurbineClient({ connectionString: DATABASE_URL!, poolSize: 2 }, schema);
    try {
      await pool.query(`INSERT INTO "${USERS}" (email, name, updated_at) VALUES ('c@example.test', 'C', '2000-01-01')`);
      const users = db.table<{ id: number; email?: string; name: string; updatedAt: Date }>(USERS);
      const [row] = await users.findMany({ where: { name: 'C' }, limit: 10 });
      assert.ok(row);
      assert.equal(row.email, 'c@example.test', 'introspection alone should return the column the overlay hides');
      const updated = await users.update({ where: { id: row.id }, data: { name: 'C2' } });
      assert.ok(updated.updatedAt < new Date('2001-01-01'), 'introspection alone should not stamp updatedAt');
    } finally {
      await db.disconnect();
    }
  });

  live.it('a tag on a column the database lacks fails generate and writes nothing', () => {
    project.write('turbine/typo.ts', SCHEMA_FILE.replace('email: { type', 'emial: { type'));
    const run = project.cli(['generate', '--schema-file', './turbine/typo.ts', '--out', './generated/typo']);
    assert.notEqual(run.status, 0, run.output);
    assert.match(run.output, /column "emial" on table "cgcli_users_[^"]+" is not in the database/);
    assert.match(run.output, /did you mean "email"\?/);
    assert.equal(existsSync(join(project.dir, 'generated', 'typo')), false, 'a failed generate must not write files');
  });

  live.it('a tag on a table the database lacks fails generate', () => {
    project.write('turbine/typo-table.ts', SCHEMA_FILE.replace(USERS, `${USERS}x`));
    // The table is named in `include`, so it is in scope for the client and must exist.
    const run = project.cli([
      'generate',
      '--schema-file',
      './turbine/typo-table.ts',
      '--include',
      `${USERS},${USERS}x`,
      '--out',
      './generated/typo2',
    ]);
    assert.notEqual(run.status, 0, run.output);
    assert.match(run.output, /table "cgcli_users_[^"]+x" is not in the database/);
  });

  live.it('a configured schema file that does not exist fails generate', () => {
    const run = project.cli(['generate', '--schema-file', './turbine/missing.ts', '--out', './generated/missing']);
    assert.notEqual(run.status, 0, run.output);
    assert.match(run.output, /Schema file not found: \.\/turbine\/missing\.ts/);
    assert.equal(existsSync(join(project.dir, 'generated', 'missing')), false);
  });

  live.it('a schema file that throws when loaded fails generate with its message', () => {
    project.write('turbine/broken.ts', `throw new Error('schema file is broken');\n`);
    const run = project.cli(['generate', '--schema-file', './turbine/broken.ts', '--out', './generated/broken']);
    assert.notEqual(run.status, 0, run.output);
    assert.match(run.output, /schema file is broken/);
    assert.equal(existsSync(join(project.dir, 'generated', 'broken')), false);
  });

  live.it('a tag on a table the include filter leaves out is not an error', () => {
    project.write(
      'turbine/other.ts',
      `${SCHEMA_FILE.replace(/\}\);\s*$/, '')}  cgcli_not_pushed_${SUFFIX}: {\n    id: { type: 'serial', primaryKey: true },\n    secret: { type: 'text', pii: true },\n  },\n});\n`,
    );
    const run = project.cli(['generate', '--schema-file', './turbine/other.ts', '--out', './generated/other']);
    assert.equal(run.status, 0, run.output);
    assert.match(run.output, /1 pii, 1 updatedAt/);
  });

  live.it('a database-first project with no schema file generates without tags', () => {
    const bare = makeProject('code-first-none', { databaseUrl: DATABASE_URL });
    try {
      bare.write('turbine.config.js', `export default { include: [${JSON.stringify(USERS)}] };\n`);
      const run = bare.cli(['generate', '--out', './generated/turbine']);
      assert.equal(run.status, 0, run.output);
      assert.doesNotMatch(run.output, /applied column tags/);
      assert.doesNotMatch(readFileSync(join(bare.dir, 'generated', 'turbine', 'metadata.ts'), 'utf-8'), /pii: true/);
    } finally {
      bare.cleanup();
    }
  });
});
