import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createClient } from '@libsql/client/node';
import { generateLibsqlFiles } from '../libsql/generate.js';
import { introspectLibsql } from '../libsql/introspect.js';
import type { LibsqlLocalClient } from '../libsql/pool.js';
import { turbineLibsql } from '../libsql.js';
import { assertConstraintNameRelations, CONSTRAINT_NAME_DDL } from './fixtures/constraint-name-shapes.js';

// Required native prerequisite: import/open errors fail; there is no skip path.
const ddl = readFileSync(new URL('./fixtures/libsql-introspection.sql', import.meta.url), 'utf8');
async function withCatalog(check: (client: ReturnType<typeof createClient>) => Promise<void>) {
  const client = createClient({ url: ':memory:', intMode: 'bigint', concurrency: 1 });
  try {
    await client.executeMultiple(ddl);
    await check(client);
  } finally {
    client.close();
    assert.equal(client.closed, true);
  }
}
const prototypeName = '__proto__';
const source = (client: LibsqlLocalClient) => ({ client, url: ':memory:' });

test('native local libSQL names composite foreign keys as PostgreSQL names the same declarations', async () => {
  const client = createClient({ url: ':memory:', intMode: 'bigint', concurrency: 1 });
  try {
    for (const statement of CONSTRAINT_NAME_DDL) await client.execute(statement);
    assertConstraintNameRelations(await introspectLibsql(source(client), { logger: {} }), 'libSQL');
  } finally {
    client.close();
  }
});

test('kept native prototype column names survive typed writes and row decoding', async () => {
  await withCatalog(async (client) => {
    await client.execute(
      'CREATE TABLE prototype_rows (id INTEGER PRIMARY KEY, "__proto__" TEXT NOT NULL, constructor TEXT, toString TEXT)',
    );
    const metadata = await introspectLibsql(source(client), { include: ['prototype_rows'], keepColumnNames: true });
    const db = await turbineLibsql(source(client), metadata, { logger: {}, warnOnUnlimited: false });
    try {
      const data = { ['__proto__']: 'native value', constructor: 'constructor value', toString: 'toString value' };
      const created = await db.table('prototype_rows').create({ data });
      const selected = await db.table('prototype_rows').findFirst({ where: { id: created.id } });
      for (const row of [created, selected]) {
        assert.ok(row);
        assert.equal(Object.getPrototypeOf(row), Object.prototype);
        assert.equal(Object.hasOwn(row, '__proto__'), true);
        assert.equal(row[prototypeName], 'native value');
        assert.equal(row.constructor, 'constructor value');
        assert.equal(row.toString, 'toString value');
        assert.deepEqual(Object.getOwnPropertyDescriptor(row, '__proto__'), {
          value: 'native value',
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
    } finally {
      await db.disconnect();
    }
  });
});

test('native local libSQL catalog preserves effective key/default/generated metadata', async (t) => {
  await withCatalog(async (client) => {
    t.diagnostic(
      `Node ${process.version}; native libSQL SQLite fork ${(await client.execute('SELECT sqlite_version()')).rows[0]?.[0]}`,
    );
    const schema = await introspectLibsql(source(client), { logger: {} });
    const facts = (table: string) =>
      schema.tables[table]!.columns.map((c) => [
        c.name,
        c.nullable,
        c.hasDefault,
        c.isGenerated === true,
        c.isGeneratedStored === true,
      ]);
    for (const table of ['rowid_keys', 'auto_keys', 'table_rowid_keys', 'default_rowid_keys'])
      assert.deepEqual(facts(table)[0], ['id', false, true, true, false]);
    assert.deepEqual(facts('desc_keys'), [['id', true, false, false, false]]);
    assert.deepEqual(facts('without_keys'), [['id', false, false, false, false]]);
    assert.deepEqual(facts('strict_keys'), [['slug', false, false, false, false]]);
    assert.deepEqual(facts('nullable_composite_keys'), [
      ['tenant_id', true, false, false, false],
      ['code', true, false, false, false],
    ]);
    assert.deepEqual(schema.tables.without_composite_keys!.primaryKey, ['code', 'tenant_id']);
    for (const name of ['virtual_total', 'stored_total']) {
      assert.deepEqual(
        facts('generated_records').find((c) => c[0] === name),
        [name, true, true, false, true],
      );
      assert.equal(
        schema.tables.generated_records!.columns.find((c) => c.name === name)!.generationExpression,
        undefined,
      );
    }
    assert.deepEqual(
      schema.tables.default_keys!.columns.map((c) => c.defaultValue),
      ["'new'", '0', 'NULL'],
    );
    assert.deepEqual(
      schema.tables.tricky_defaults!.columns.map((c) => c.defaultValue),
      [null, 'FALSE', "'quoted'"],
    );
    assert.equal(schema.tables.key_view, undefined);
    assert.equal(schema.tables.sqlite_sequence, undefined);
    assert.ok(schema.tables.sqliteXuser, 'literal sqlite_ prefix only');
    assert.deepEqual(schema.tables.audit_events!.dateColumns, new Set(['event_at']));
    assert.equal(schema.tables.audit_events!.columns[1]!.tsType, 'Uint8Array');
    assert.equal(client.closed, false);
  });
});

test('native local catalog proves unique-FK cardinality only for full compatible plain keys', async () => {
  await withCatalog(async (client) => {
    const schema = await introspectLibsql(source(client), { logger: {} });
    const relations = schema.tables.parents!.relations;
    // A to-one is named with the singular, as the PostgreSQL introspector names it.
    for (const name of ['profile', 'primaryProfile', 'indexedProfile', 'caseLink', 'mixedCaseChildren'])
      assert.equal(relations[name]?.type, 'hasOne', name);
    for (const name of ['partialProfiles', 'expressionProfiles', 'supersetProfiles', 'affinityProfiles'])
      assert.equal(relations[name]?.type, 'hasMany', name);
    assert.equal(schema.tables.numeric_parents!.relations.anyProfiles?.type, 'hasMany');
    assert.equal(schema.tables.collated_parents!.relations.collationProfiles?.type, 'hasMany');
    assert.equal(schema.tables.collated_parents!.relations.binaryChildren?.type, 'hasMany');
    assert.equal(schema.tables.composite_parents!.relations.compositeLink?.type, 'hasOne');
    assert.deepEqual(schema.tables.composite_links!.relations.compositeParent?.foreignKey, ['tenant_id', 'code']);
    assert.deepEqual(schema.tables.composite_links!.relations.compositeParent?.referenceKey, ['tenant_id', 'code']);
    assert.deepEqual(schema.tables.case_links!.relations.parent?.referenceKey, 'id');
    assert.deepEqual(schema.tables.mixed_case_children!.relations.parent?.foreignKey, 'parent_id');
    assert.deepEqual(schema.tables.partial_profiles!.uniqueColumns, []);
    assert.deepEqual(schema.tables.expression_profiles!.indexes[0]!.columns, []);
    assert.equal(schema.tables.partial_profiles!.indexes[0]!.partial, true);
    assert.match(schema.tables.expression_profiles!.indexes[0]!.definition, /lower\(label\)/);
    assert.equal(schema.tables.profiles!.indexes[0]!.definition, '', 'no invented auto-index DDL');
    const legacy = await introspectLibsql(source(client), { logger: {}, legacyToManyUniques: true });
    // The opt-out keeps the arrays and the plural names they had before the to-one rule.
    assert.deepEqual(Object.keys(legacy.tables.parents!.relations).sort(), [
      'affinityProfiles',
      'caseLinks',
      'expressionProfiles',
      'indexedProfiles',
      'mixedCaseChildren',
      'partialProfiles',
      'primaryProfiles',
      'profiles',
      'supersetProfiles',
    ]);
    assert.equal(legacy.tables.parents!.relations.profiles?.type, 'hasMany');
    await client.executeMultiple(
      "INSERT INTO parents VALUES (1); INSERT INTO affinity_profiles(parent_id) VALUES ('1'), ('01'); INSERT INTO partial_profiles(parent_id,active) VALUES (1,0),(1,0);",
    );
    assert.equal(
      (await client.execute('SELECT count(*) FROM affinity_profiles c JOIN parents p ON c.parent_id=p.id'))
        .rows[0]?.[0],
      2n,
    );
  });
});

test('quoted/Unicode and prototype names remain catalog data; temp shadows never replace main', async () => {
  await withCatalog(async (client) => {
    await client.execute('CREATE TEMP TABLE parents (wrong TEXT)');
    const schema = await introspectLibsql(source(client), { logger: {} });
    assert.deepEqual(schema.tables["quote'表"]!.allColumns, ['key"part', 'café']);
    assert.equal(schema.tables["quote'表"]!.indexes[0]!.name, 'index\'"é');
    assert.deepEqual(schema.tables.parents!.allColumns, ['id']);
    assert.deepEqual(schema.tables[prototypeName]!.allColumns, ['constructor', 'toString']);
    assert.equal(Object.getPrototypeOf(schema.tables), null);
    assert.equal(Object.getPrototypeOf(schema.tables[prototypeName]!.columnMap), null);
    assert.deepEqual(await introspectLibsql(source(client), { logger: {} }), schema);
  });
});

test('filters, relation renames and raw column names reuse existing metadata conventions', async () => {
  await withCatalog(async (client) => {
    const schema = await introspectLibsql(source(client), {
      logger: {},
      include: ['parents', 'profiles'],
      relationNames: { parents: { profile: 'details' } },
    });
    assert.deepEqual(Object.keys(schema.tables), ['parents', 'profiles']);
    assert.equal(schema.tables.parents!.relations.details?.type, 'hasOne');
    assert.equal(schema.tables.parents!.relations.profiles, undefined);
    assert.deepEqual(
      Object.keys(
        (await introspectLibsql(source(client), { include: ['parents', 'profiles'], exclude: ['profiles'] })).tables,
      ),
      ['parents'],
    );
    await assert.rejects(
      introspectLibsql(source(client), {
        include: ['parents', 'profiles'],
        relationNames: { profiles: { parent: 'parentId' } },
      }),
      /column already uses field/,
    );
    await client.execute('CREATE TABLE collisions (created_at TEXT, "createdAt" TEXT)');
    await assert.rejects(introspectLibsql(source(client), { logger: {} }), /Field collision/);
    const raw = await introspectLibsql(source(client), { include: ['collisions'], keepColumnNames: true });
    assert.deepEqual(
      raw.tables.collisions!.columnMap,
      Object.assign(Object.create(null), { created_at: 'created_at', createdAt: 'createdAt' }),
    );
    assert.equal(client.closed, false);
  });
});

test('actual native writes obey introspected generated columns and nested cardinality', async () => {
  await withCatalog(async (client) => {
    const schema = await introspectLibsql(source(client), { logger: {} });
    const db = await turbineLibsql(source(client), schema, { logger: {}, warnOnUnlimited: false });
    try {
      const row = await db.table('generated_records').create({ data: { quantity: 4 } });
      assert.equal(row.virtualTotal, 8);
      assert.equal(row.storedTotal, 12);
      await assert.rejects(
        db.table('generated_records').create({ data: { quantity: 4, virtualTotal: 8 } }),
        /generated/i,
      );
      await assert.rejects(
        db.table('generated_records').update({ where: { id: 1 }, data: { storedTotal: 8 } }),
        /generated/i,
      );
      await client.executeMultiple(
        "INSERT INTO parents VALUES (1),(2); INSERT INTO profiles(parent_id,label) VALUES (1,'one'); INSERT INTO partial_profiles(parent_id,active) VALUES (1,0),(1,0);",
      );
      const rows = await db
        .table('parents')
        .findMany({ orderBy: { id: 'asc' }, with: { profile: true, partialProfiles: true } });
      assert.deepEqual(
        rows.map((r) => r.profile),
        [{ id: 1, parentId: 1, label: 'one' }, null],
      );
      assert.deepEqual(
        rows.map((r) => (r.partialProfiles as unknown[]).length),
        [2, 0],
      );
      assert.throws(() => generateLibsqlFiles(schema, { noTimestamp: true }), /not a valid TypeScript identifier/);
      const options = { include: ['parents', 'profiles', 'generated_records'], logger: {} };
      assert.deepEqual(
        generateLibsqlFiles(await introspectLibsql(source(client), options), { noTimestamp: true }),
        generateLibsqlFiles(await introspectLibsql(source(client), options), { noTimestamp: true }),
      );
    } finally {
      await db.disconnect();
      assert.equal(client.closed, false);
    }
  });
});

test('owned file clients close on success and catalog error; supplied clients stay open on all failures', async () => {
  const root = mkdtempSync(join(tmpdir(), 'turbine-libsql-introspection-'));
  const url = `file:${join(root, 'catalog.db')}`;
  const client = createClient({ url, intMode: 'bigint' });
  try {
    await client.execute('CREATE TABLE records (id INTEGER PRIMARY KEY)');
    assert.deepEqual(Object.keys((await introspectLibsql(url)).tables), ['records']);
    await assert.rejects(introspectLibsql(url, { relationNames: { missing: { no: 'other' } } }), /unknown table/);
    await assert.rejects(introspectLibsql({ client, url }, { relationNames: { missing: {} } }), /unknown table/);
    assert.equal(client.closed, false);
    await client.execute('DROP TABLE records');
    assert.equal((await client.execute('PRAGMA integrity_check')).rows[0]?.[0], 'ok');
  } finally {
    client.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('remote, sync, non-main/view/virtual scopes and unknown configuration explicitly refuse', async () => {
  for (const url of [
    'libsql://example.invalid',
    'https://example.invalid',
    'file://remote/db',
    'file:db?syncUrl=x',
    'file:db#hash',
  ])
    await assert.rejects(introspectLibsql(url), /local|Remote/);
  for (const options of [
    { schema: 'temp' },
    { schema: 'other' },
    { includeViews: true },
    { syncUrl: 'x' },
    { authToken: 'x' },
    { dialect: {} },
  ])
    await assert.rejects(introspectLibsql(':memory:', options as never), /not supported|implemented/i);
  await withCatalog(async (client) => {
    await assert.rejects(introspectLibsql({ ...source(client), syncUrl: 'x' } as never), /only client and url/);
    await assert.rejects(introspectLibsql(source(client), { include: ['key_view'] }), /View introspection/);
    await client.execute("ATTACH DATABASE ':memory:' AS extra");
    await assert.rejects(introspectLibsql(source(client)), /Attached database/);
    await client.execute('DETACH DATABASE extra');
    await client.execute('CREATE VIRTUAL TABLE search USING fts5(body)');
    await assert.rejects(introspectLibsql(source(client)), /Virtual or shadow/);
    assert.deepEqual(Object.keys((await introspectLibsql(source(client), { include: ['parents'] })).tables), [
      'parents',
    ]);
    assert.equal(client.closed, false);
  });
});

test('wrong integer mode, closed handles, malformed FKs and unsafe catalog identifiers fail explicitly', async () => {
  const numberClient = createClient({ url: ':memory:', intMode: 'number' });
  try {
    await assert.rejects(introspectLibsql(source(numberClient)), /bigint|safely|big integer/i);
    assert.equal(numberClient.closed, false);
  } finally {
    numberClient.close();
  }
  await assert.rejects(introspectLibsql(source(numberClient)), /open native local client/);
  await withCatalog(async (client) => {
    await client.execute('CREATE TABLE broken (ref INTEGER REFERENCES parents(missing))');
    await assert.rejects(introspectLibsql(source(client), { logger: {} }), /Unresolvable/);
    await client.execute('DROP TABLE broken');
    await client.execute('CREATE TABLE unkeyed_parent (label TEXT)');
    await client.execute('CREATE TABLE unkeyed_child (ref TEXT REFERENCES unkeyed_parent)');
    await assert.rejects(introspectLibsql(source(client), { logger: {} }), /Unresolvable/);
    await client.execute('DROP TABLE unkeyed_child');
    await client.execute('DROP TABLE unkeyed_parent');
    await client.execute('CREATE TABLE "unsafe\nname" (id INTEGER)');
    await assert.rejects(introspectLibsql(source(client), { logger: {} }), /control|unsafe/i);
    assert.equal(client.closed, false);
  });
});

test('schema-version changes reject an inconsistent catalog without closing supplied client', async () => {
  await withCatalog(async (client) => {
    let versions = 0;
    const wrapped: LibsqlLocalClient = {
      get closed() {
        return client.closed;
      },
      protocol: client.protocol,
      close: () => {
        throw new Error('caller-owned close');
      },
      batch: client.batch.bind(client),
      transaction: client.transaction.bind(client),
      execute: async (statement) => {
        if (statement.sql === 'PRAGMA main.schema_version' && ++versions === 2)
          await client.execute('CREATE TABLE changed_during_read (id INTEGER)');
        return client.execute(statement);
      },
    };
    await assert.rejects(introspectLibsql(source(wrapped), { logger: {} }), /catalog changed/);
    assert.equal(client.closed, false);
  });
});
