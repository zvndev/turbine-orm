import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import { describe } from 'node:test';
import { fileURLToPath } from 'node:url';
import { generateIndex, generateMetadata, generateTypes } from '../generate.js';
import { introspect } from '../introspect.js';
import type { SchemaMetadata } from '../schema.js';
import { introspectSqliteDatabase, sqliteDialect, turbineSqlite } from '../sqlite.js';
import { skipGate } from './helpers.js';

const DatabaseSync: typeof DatabaseSyncType | undefined = (() => {
  try {
    return createRequire(import.meta.url)('node:sqlite').DatabaseSync;
  } catch {
    return undefined;
  }
})();
const sqlite = skipGate(!DatabaseSync, 'SQLite metadata requires node:sqlite (Node >= 22.5)');
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const fixture = readFileSync(new URL('./fixtures/sqlite-metadata.sql', import.meta.url), 'utf8');

function withDatabase(check: (db: DatabaseSyncType) => void): void {
  const db = new DatabaseSync!(':memory:');
  try {
    db.exec(fixture);
    check(db);
  } finally {
    db.close();
  }
}

function facts(schema: SchemaMetadata, table: string) {
  return schema.tables[table]!.columns.map((c) => [c.name, c.nullable, c.hasDefault, c.isGenerated === true]);
}

describe('SQLite native key and introspection metadata fidelity', () => {
  sqlite.it('reproduces native generation, nullability, defaults and unique-FK boundaries', () => {
    withDatabase((db) => {
      for (const table of ['rowid_keys', 'auto_keys', 'table_rowid_keys']) {
        const row = db.prepare(`INSERT INTO ${table} DEFAULT VALUES RETURNING id`).get();
        assert.equal(row!.id, 1, table);
      }
      assert.equal(db.prepare('INSERT INTO desc_keys DEFAULT VALUES RETURNING id').get()!.id, null);
      // The rowid allocator takes precedence over a declared DEFAULT on its alias.
      assert.equal(db.prepare('INSERT INTO default_rowid_keys DEFAULT VALUES RETURNING id').get()!.id, 1);
      assert.equal(db.prepare('INSERT INTO nullable_keys DEFAULT VALUES RETURNING slug').get()!.slug, null);
      db.exec('INSERT INTO nullable_keys DEFAULT VALUES'); // NULL PK values are not unique.
      const composite = db.prepare('INSERT INTO nullable_composite_keys DEFAULT VALUES RETURNING *').get()!;
      assert.deepEqual({ ...composite }, { tenant_id: null, code: null });
      for (const table of [
        'int_keys',
        'text_keys',
        'composite_keys',
        'without_keys',
        'without_composite_keys',
        'strict_keys',
      ]) {
        assert.throws(() => db.exec(`INSERT INTO ${table} DEFAULT VALUES`), /NOT NULL constraint failed/, table);
      }
      assert.deepEqual(
        { ...db.prepare('INSERT INTO default_keys DEFAULT VALUES RETURNING *').get()! },
        {
          slug: 'new',
          count: 0,
          optional_text: null,
        },
      );
      assert.equal(db.prepare('INSERT INTO default_without_keys DEFAULT VALUES RETURNING id').get()!.id, 73);
      const generated = db.prepare('INSERT INTO generated_records(quantity) VALUES (4) RETURNING *').get()!;
      assert.deepEqual({ ...generated }, { id: 1, quantity: 4, virtual_total: 8, stored_total: 12 });
      assert.throws(
        () => db.exec('INSERT INTO generated_records(quantity, virtual_total) VALUES (4, 8)'),
        /generated column/,
      );

      db.exec('INSERT INTO parents VALUES (1), (2)');
      db.exec("INSERT INTO affinity_profiles(parent_id) VALUES ('1'), ('01')");
      db.exec("INSERT INTO numeric_parents VALUES (1); INSERT INTO any_profiles(parent_id) VALUES (1), ('1')");
      assert.equal(
        db.prepare('SELECT COUNT(*) AS n FROM any_profiles c JOIN numeric_parents p ON c.parent_id = p.id').get()!.n,
        2,
      );
      assert.equal(
        db.prepare('SELECT COUNT(*) AS n FROM affinity_profiles c JOIN parents p ON c.parent_id = p.id').get()!.n,
        2,
      );
      db.exec("INSERT INTO profiles(parent_id, label) VALUES (1, 'one'), (NULL, 'null one'), (NULL, 'null two')");
      assert.throws(() => db.exec("INSERT INTO profiles(parent_id, label) VALUES (1, 'duplicate')"), /UNIQUE/);
      db.exec('INSERT INTO primary_profiles VALUES (1)');
      assert.throws(() => db.exec('INSERT INTO primary_profiles VALUES (1)'), /UNIQUE/);
      db.exec('INSERT INTO indexed_profiles(parent_id) VALUES (1)');
      assert.throws(() => db.exec('INSERT INTO indexed_profiles(parent_id) VALUES (1)'), /UNIQUE/);
      db.exec('INSERT INTO partial_profiles(parent_id, active) VALUES (1, 0), (1, 0)');
      db.exec("INSERT INTO expression_profiles(parent_id, label) VALUES (1, 'a'), (1, 'b')");
      db.exec("INSERT INTO superset_profiles(parent_id, label) VALUES (1, 'a'), (1, 'b')");
      db.exec("INSERT INTO composite_parents VALUES (1, 'a')");
      db.exec("INSERT INTO composite_links(tenant_id, code) VALUES (1, 'a')");
      assert.throws(() => db.exec("INSERT INTO composite_links(tenant_id, code) VALUES (1, 'a')"), /UNIQUE/);
      db.exec(
        "INSERT INTO collated_parents VALUES ('a'); INSERT INTO collation_profiles(parent_id) VALUES ('a'), ('A')",
      );
      assert.equal(
        db
          .prepare('SELECT COUNT(*) AS n FROM collation_profiles c JOIN collated_parents p ON c.parent_id = p.id')
          .get()!.n,
        2,
      );
    });
  });

  sqlite.it('uses rowid/catalog facts for effective nullability and create defaults', () => {
    withDatabase((db) => {
      const schema = introspectSqliteDatabase(db, { logger: {} });
      assert.equal(Object.keys(schema.tables).length, 30);
      assert.deepEqual(facts(schema, 'text_keys'), [
        ['slug', false, false, false],
        ['label', false, false, false],
      ]);
      for (const table of ['rowid_keys', 'auto_keys', 'table_rowid_keys', 'default_rowid_keys']) {
        assert.deepEqual(facts(schema, table).slice(0, 1), [['id', false, true, true]], table);
      }
      assert.deepEqual(facts(schema, 'desc_keys'), [['id', true, false, false]]);
      assert.deepEqual(facts(schema, 'int_keys'), [['id', false, false, false]]);
      assert.deepEqual(facts(schema, 'nullable_keys'), [
        ['slug', true, false, false],
        ['note', true, false, false],
      ]);
      for (const table of ['composite_keys', 'without_composite_keys']) {
        assert.deepEqual(
          facts(schema, table),
          [
            ['tenant_id', false, false, false],
            ['code', false, false, false],
          ],
          table,
        );
      }
      assert.deepEqual(facts(schema, 'nullable_composite_keys'), [
        ['tenant_id', true, false, false],
        ['code', true, false, false],
      ]);
      assert.deepEqual(schema.tables.without_composite_keys!.primaryKey, ['code', 'tenant_id']);
      assert.deepEqual(facts(schema, 'without_keys'), [['id', false, false, false]]);
      assert.deepEqual(facts(schema, 'strict_keys'), [['slug', false, false, false]]);
      assert.deepEqual(facts(schema, 'default_keys'), [
        ['slug', false, true, false],
        ['count', false, true, false],
        ['optional_text', true, true, false],
      ]);
      assert.deepEqual(facts(schema, 'default_without_keys'), [['id', false, true, false]]);
      assert.equal(schema.tables.key_view, undefined, 'views remain outside the SQLite introspection contract');
      const generated = schema.tables.generated_records!;
      assert.deepEqual(generated.allColumns, ['id', 'quantity', 'virtual_total', 'stored_total']);
      for (const name of ['virtual_total', 'stored_total']) {
        const column = generated.columns.find((c) => c.name === name)!;
        assert.equal(column.isGeneratedStored, true, name);
        assert.equal(column.hasDefault, true, name);
      }
      for (const emitter of [generateIndex, generateMetadata, generateTypes]) {
        const options = { target: 'sqlite', noTimestamp: true } as const;
        assert.equal(emitter(schema, options), emitter(introspectSqliteDatabase(db, { logger: {} }), options));
      }
      db.exec('CREATE TEMP TABLE rowid_keys (id TEXT PRIMARY KEY) WITHOUT ROWID');
      assert.deepEqual(facts(introspectSqliteDatabase(db, { logger: {} }), 'rowid_keys'), facts(schema, 'rowid_keys'));
    });
  });

  sqlite.it('infers to-one only from full plain unique keys and names it as PostgreSQL does', () => {
    withDatabase((db) => {
      const schema = introspectSqliteDatabase(db, { logger: {} });
      const relations = schema.tables.parents!.relations;
      // A to-one is named with the singular, exactly as the PostgreSQL introspector names it.
      for (const name of ['profile', 'primaryProfile', 'indexedProfile'])
        assert.equal(relations[name]?.type, 'hasOne', name);
      for (const name of ['partialProfiles', 'expressionProfiles', 'supersetProfiles', 'affinityProfiles'])
        assert.equal(relations[name]?.type, 'hasMany', name);
      assert.equal(relations.profiles, undefined, 'a to-one is not also offered under the plural');
      assert.equal(schema.tables.profiles!.relations.parent?.type, 'belongsTo');
      assert.equal(schema.tables.composite_parents!.relations.compositeLink?.type, 'hasOne');
      assert.deepEqual(schema.tables.composite_links!.relations.compositeParent?.referenceKey, ['tenant_id', 'code']);
      assert.deepEqual(schema.tables.partial_profiles!.uniqueColumns, []);
      assert.deepEqual(schema.tables.expression_profiles!.uniqueColumns, []);
      assert.equal(schema.tables.partial_profiles!.indexes[0]!.partial, true);
      assert.deepEqual(schema.tables.expression_profiles!.indexes[0]!.columns, []);
      assert.match(schema.tables.expression_profiles!.indexes[0]!.definition, /lower\(label\)/);
      const legacy = introspectSqliteDatabase(db, { logger: {}, legacyToManyUniques: true });
      // The opt-out keeps the arrays and the plural names they had before the to-one rule.
      assert.deepEqual(Object.keys(legacy.tables.parents!.relations).sort(), [
        'affinityProfiles',
        'expressionProfiles',
        'indexedProfiles',
        'partialProfiles',
        'primaryProfiles',
        'profiles',
        'supersetProfiles',
      ]);
      assert.equal(legacy.tables.parents!.relations.profiles!.type, 'hasMany');
      assert.equal(schema.tables.collated_parents!.relations.collationProfiles?.type, 'hasMany');
      assert.equal(schema.tables.numeric_parents!.relations.anyProfiles?.type, 'hasMany');
    });
  });

  sqlite.it('preserves generic introspection filters, configured names and legacy array results', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'turbine-sqlite-catalog-options-'));
    try {
      const path = join(dir, 'metadata.db');
      const raw = new DatabaseSync!(path);
      try {
        raw.exec(fixture);
      } finally {
        raw.close();
      }
      for (const legacyToManyUniques of [false, true]) {
        const schema = await introspect({
          connectionString: path,
          dialect: sqliteDialect,
          logger: {},
          include: ['parents', 'profiles'],
          relationNames: { parents: { [legacyToManyUniques ? 'profiles' : 'profile']: 'profileDetails' } },
          legacyToManyUniques,
        });
        assert.deepEqual(Object.keys(schema.tables), ['parents', 'profiles']);
        assert.equal(schema.tables.parents!.relations.profileDetails?.type, legacyToManyUniques ? 'hasMany' : 'hasOne');
        assert.equal(schema.tables.parents!.relations.profiles, undefined);
        assert.equal(schema.tables.parents!.relations.profile, undefined);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  sqlite.it('uses corrected metadata for native create results, computed writes and nested cardinality', async () => {
    const raw = new DatabaseSync!(':memory:');
    raw.exec(fixture);
    const client = turbineSqlite(raw, introspectSqliteDatabase(raw, { logger: {} }), {
      logger: {},
      warnOnUnlimited: false,
    });
    try {
      assert.equal((await client.table('rowid_keys').create({ data: {} })).id, 1);
      await assert.rejects(client.table('text_keys').create({ data: { label: 'missing' } }), /NOT NULL/);
      assert.equal((await client.table('nullable_keys').create({ data: {} })).slug, null);
      const computed = await client.table('generated_records').create({ data: { quantity: 4 } });
      assert.equal(computed.virtualTotal, 8);
      assert.equal(computed.storedTotal, 12);
      await assert.rejects(
        client.table('generated_records').create({ data: { quantity: 4, virtualTotal: 8 } }),
        /generated/i,
      );
      await assert.rejects(
        client.table('generated_records').update({ where: { id: 1 }, data: { storedTotal: 12 } }),
        /generated/i,
      );
      raw.exec(
        "INSERT INTO parents VALUES (1), (2); INSERT INTO profiles(parent_id, label) VALUES (1, 'one'), (NULL, 'a'), (NULL, 'b')",
      );
      raw.exec('INSERT INTO partial_profiles(parent_id, active) VALUES (1, 0), (1, 0)');
      raw.exec("INSERT INTO affinity_profiles(parent_id) VALUES ('1'), ('01')");
      const rows = await client
        .table('parents')
        .findMany({ orderBy: { id: 'asc' }, with: { profile: true, partialProfiles: true, affinityProfiles: true } });
      assert.deepEqual(
        rows.map((row) => row.profile),
        [{ id: 1, parentId: 1, label: 'one' }, null],
      );
      assert.deepEqual(
        rows.map((row) => row.partialProfiles),
        [
          [
            { id: 1, parentId: 1, active: 0 },
            { id: 2, parentId: 1, active: 0 },
          ],
          [],
        ],
      );
      assert.deepEqual(
        rows.map((row) => row.affinityProfiles),
        [
          [
            { id: 1, parentId: '1' },
            { id: 2, parentId: '01' },
          ],
          [],
        ],
      );
    } finally {
      await client.disconnect();
      raw.close();
    }
  });
});

describe('strict generated SQLite metadata consumers', () => {
  sqlite.it('requires native mandatory keys, prohibits computed writes and types to-one accessors', () => {
    withDatabase((db) => {
      const schema = introspectSqliteDatabase(db, { logger: {} });
      const dir = mkdtempSync(join(tmpdir(), 'turbine-sqlite-metadata-types-'));
      try {
        mkdirSync(join(dir, 'generated'));
        const options = { target: 'sqlite', noTimestamp: true } as const;
        for (const [name, emitter] of [
          ['index', generateIndex],
          ['metadata', generateMetadata],
          ['types', generateTypes],
        ] as const) {
          writeFileSync(join(dir, 'generated', `${name}.ts`), emitter(schema, options));
        }
        writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
        writeFileSync(
          join(dir, 'tsconfig.json'),
          JSON.stringify({
            compilerOptions: {
              strict: true,
              noEmit: true,
              skipLibCheck: true,
              target: 'ES2023',
              module: 'NodeNext',
              moduleResolution: 'NodeNext',
              typeRoots: [join(repo, 'node_modules/@types')],
              types: ['node'],
              paths: {
                'turbine-orm': [join(repo, 'src/index.ts')],
                'turbine-orm/sqlite': [join(repo, 'src/sqlite.ts')],
              },
            },
            include: ['**/*.ts', join(repo, 'types/**/*.d.ts')],
          }),
        );
        const valid = `import { turbine } from './generated/index.js';
const db = turbine(':memory:');
void db.rowidKeys.create({ data: {} });
void db.autoKeys.create({ data: { id: 5 } });
void db.defaultRowidKeys.create({ data: {} });
void db.tableRowidKeys.create({ data: {} });
void db.descKeys.create({ data: { id: null } });
void db.textKeys.create({ data: { slug: 'key', label: 'text' } });
void db.nullableKeys.create({ data: {} });
void db.nullableCompositeKeys.create({ data: { tenantId: null } });
void db.compositeKeys.create({ data: { tenantId: 1, code: 'a' } });
void db.withoutKeys.create({ data: { id: 1 } });
void db.withoutCompositeKeys.create({ data: { tenantId: 1, code: 'a' } });
void db.strictKeys.create({ data: { slug: 'key' } });
void db.defaultKeys.create({ data: {} });
void db.defaultWithoutKeys.create({ data: {} });
void db.generatedRecords.create({ data: { quantity: 4 } });
async function nested() {
  const parent = await db.parents.findFirst({ with: { profile: true, indexedProfile: true, partialProfiles: true } });
  const label: string | undefined = parent?.profile?.label;
  const id: number | undefined = parent?.indexedProfile?.id;
  const many: number | undefined = parent?.partialProfiles[0]?.id;
  return label ?? String(id ?? many);
}
void nested;
`;
        const invalid = [
          "db.textKeys.create({ data: { label: 'missing key' } });",
          'db.intKeys.create({ data: {} });',
          "db.compositeKeys.create({ data: { code: 'missing tenant' } });",
          'db.compositeKeys.create({ data: { tenantId: 1 } });',
          'db.withoutKeys.create({ data: {} });',
          "db.withoutCompositeKeys.create({ data: { code: 'missing tenant' } });",
          'db.strictKeys.create({ data: {} });',
          'db.withoutKeys.create({ data: { id: null } });',
          'db.generatedRecords.create({ data: { quantity: 4, virtualTotal: 8 } });',
          'db.generatedRecords.update({ where: { id: 1 }, data: { storedTotal: 12 } });',
          'db.expressionProfiles.findUnique({ where: { parentId_scope: { parentId: 1, scope: 0 } } });',
          'db.parents.findFirst({ with: { affinityProfiles: true } }).then((p) => p?.affinityProfiles?.id);',
          'db.parents.findFirst({ with: { profile: true } }).then((p) => p?.profile?.[0]);',
          'db.parents.findFirst({ with: { partialProfiles: true } }).then((p) => p?.partialProfiles?.id);',
        ];
        const usage = valid + invalid.map((s) => `// @ts-expect-error invalid metadata consumer\n${s}\n`).join('');
        const compile = () => {
          const result = spawnSync(join(repo, 'node_modules/.bin/tsc'), ['-p', dir], {
            cwd: repo,
            encoding: 'utf8',
            timeout: 120_000,
          });
          return { status: result.status, output: `${result.stdout}\n${result.stderr}\n${result.error ?? ''}` };
        };
        writeFileSync(join(dir, 'usage.ts'), usage);
        const checked = compile();
        assert.equal(checked.status, 0, checked.output);
        writeFileSync(join(dir, 'usage.ts'), usage.replaceAll('// @ts-expect-error invalid metadata consumer', ''));
        const broken = compile();
        assert.notEqual(broken.status, 0, 'invalid inputs unexpectedly compiled');
        for (const statement of invalid) {
          const line = usage.slice(0, usage.indexOf(statement)).split('\n').length;
          assert.ok(broken.output.includes(`usage.ts(${line},`), `No diagnostic for ${statement}\n${broken.output}`);
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});
