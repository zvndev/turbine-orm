import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { generateIndex, generateMetadata, generateTypes } from '../generate.js';
import { introspect } from '../introspect.js';
import { introspectMysql, introspectMysqlWith, type MysqlRowExecutor, mysqlDialect, turbineMysql } from '../mysql.js';
import type { SchemaMetadata } from '../schema.js';
import { skipGate } from './helpers.js';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const MYSQL_URL = process.env.MYSQL_URL ?? process.env.MYSQL_TEST_URL ?? '';
const native = skipGate(!MYSQL_URL, 'MySQL metadata needs MYSQL_URL pointing at a disposable MySQL 8 server');
const fixture = readFileSync(new URL('./fixtures/mysql-introspection-metadata.sql', import.meta.url), 'utf8');

function column(table: string, name: string, extra = '', overrides: Record<string, unknown> = {}) {
  return {
    TABLE_NAME: table,
    COLUMN_NAME: name,
    DATA_TYPE: 'int',
    COLUMN_TYPE: 'int',
    IS_NULLABLE: 'NO',
    COLUMN_KEY: '',
    COLUMN_DEFAULT: null,
    EXTRA: extra,
    CHARACTER_MAXIMUM_LENGTH: null,
    CHARACTER_SET_NAME: null,
    COLLATION_NAME: null,
    GENERATION_EXPRESSION: '',
    ...overrides,
  };
}

function catalog(
  overrides: {
    child?: Record<string, unknown>;
    parent?: Record<string, unknown>;
    index?: Record<string, unknown>;
    referencedSchema?: string;
  } = {},
): MysqlRowExecutor {
  return async (sql, params) => {
    assert.deepEqual(params, ['catalog_canary']);
    if (sql.includes('information_schema.TABLES')) return [{ TABLE_NAME: 'parents' }, { TABLE_NAME: 'profiles' }];
    if (sql.includes('information_schema.COLUMNS')) {
      assert.match(sql, /GENERATION_EXPRESSION/);
      return [column('parents', 'id', '', overrides.parent), column('profiles', 'parent_id', '', overrides.child)];
    }
    if (sql.includes("CONSTRAINT_NAME = 'PRIMARY'"))
      return [{ TABLE_NAME: 'parents', COLUMN_NAME: 'id', ORDINAL_POSITION: 1 }];
    if (sql.includes('REFERENCED_TABLE_NAME IS NOT NULL')) {
      assert.match(sql, /REFERENCED_TABLE_SCHEMA = :p1/);
      return [
        {
          TABLE_NAME: 'profiles',
          COLUMN_NAME: 'parent_id',
          ORDINAL_POSITION: 1,
          REFERENCED_TABLE_SCHEMA: overrides.referencedSchema ?? 'catalog_canary',
          REFERENCED_TABLE_NAME: 'parents',
          REFERENCED_COLUMN_NAME: 'id',
          CONSTRAINT_NAME: 'fk_profile',
        },
      ];
    }
    if (sql.includes('information_schema.TABLE_CONSTRAINTS')) return [];
    assert.match(sql, /information_schema.STATISTICS/);
    assert.match(sql, /SUB_PART, EXPRESSION, COLLATION, INDEX_TYPE, IS_VISIBLE, INDEX_COMMENT/);
    return [
      {
        TABLE_NAME: 'profiles',
        INDEX_NAME: 'uq_profile',
        NON_UNIQUE: 0,
        COLUMN_NAME: 'parent_id',
        SEQ_IN_INDEX: 1,
        SUB_PART: null,
        EXPRESSION: null,
        COLLATION: 'A',
        INDEX_TYPE: 'BTREE',
        IS_VISIBLE: 'YES',
        INDEX_COMMENT: '',
        ...overrides.index,
      },
    ];
  };
}

describe('MySQL catalog metadata boundaries', () => {
  it('names a proven to-one as PostgreSQL does and honors the legacy array opt-out', async () => {
    const schema = await introspectMysqlWith(catalog(), 'catalog_canary', { logger: {} });
    const legacy = await introspectMysqlWith(catalog(), 'catalog_canary', { logger: {}, legacyToManyUniques: true });
    assert.deepEqual(Object.keys(schema.tables.parents!.relations), ['profile']);
    assert.equal(schema.tables.parents!.relations.profile!.type, 'hasOne');
    assert.deepEqual(Object.keys(legacy.tables.parents!.relations), ['profiles']);
    assert.equal(legacy.tables.parents!.relations.profiles!.type, 'hasMany');
    assert.equal(schema.tables.profiles!.relations.parent!.type, 'belongsTo');
  });

  it('keeps unknown, mismatched and differently collated comparison domains as arrays', async () => {
    const text = {
      COLUMN_TYPE: 'varchar(20)',
      DATA_TYPE: 'varchar',
      CHARACTER_SET_NAME: 'utf8mb4',
      COLLATION_NAME: 'utf8mb4_0900_ai_ci',
    };
    for (const overrides of [
      { child: { COLUMN_TYPE: 'bigint' } },
      { child: text },
      { child: { ...text, COLLATION_NAME: 'utf8mb4_bin' }, parent: text },
      { child: { ...text, COLLATION_NAME: null }, parent: text },
      { child: { COLUMN_TYPE: 'double' }, parent: { COLUMN_TYPE: 'double' } },
    ]) {
      // A key that does not prove a to-one keeps the to-many, plural name.
      const schema = await introspectMysqlWith(catalog(overrides), 'catalog_canary', { logger: {} });
      assert.equal(schema.tables.parents!.relations.profiles!.type, 'hasMany', JSON.stringify(overrides));
      assert.equal(schema.tables.parents!.relations.profile, undefined, JSON.stringify(overrides));
    }
    const schema = await introspectMysqlWith(catalog({ child: text, parent: text }), 'catalog_canary', { logger: {} });
    assert.equal(schema.tables.parents!.relations.profile!.type, 'hasOne');
  });

  it('retains opaque native index facts and never claims prefix/functional keys are plain or partial', async () => {
    for (const index of [{ SUB_PART: 3 }, { COLUMN_NAME: null, EXPRESSION: 'lower(`parent_id`)' }]) {
      const schema = await introspectMysqlWith(catalog({ index }), 'catalog_canary', { logger: {} });
      const table = schema.tables.profiles!;
      assert.deepEqual(table.uniqueColumns, []);
      assert.deepEqual(table.indexes[0]!.columns, []);
      assert.equal(table.indexes[0]!.partial, undefined);
      const facts = JSON.parse(table.indexes[0]!.definition.replace(/^MySQL index metadata: /, ''));
      assert.equal(facts.type, 'BTREE');
      assert.equal(facts.keys.length, 1);
      assert.equal(facts.keys[0].prefixLength, index.SUB_PART ?? null);
      assert.equal(facts.keys[0].expression, index.EXPRESSION ?? null);
      assert.equal(schema.tables.parents!.relations.profiles!.type, 'hasMany');
    }
  });

  it('distinguishes default expressions, identity and virtual/stored computed write flags', async () => {
    for (const extra of ['VIRTUAL GENERATED', 'STORED GENERATED']) {
      const schema = await introspectMysqlWith(
        catalog({ child: { EXTRA: extra, GENERATION_EXPRESSION: '(`parent_id` * 2)' } }),
        'catalog_canary',
      );
      const c = schema.tables.profiles!.columns[0]!;
      assert.equal(c.isGeneratedStored, true);
      assert.equal(c.isGenerated, false);
      assert.equal(c.hasDefault, true);
      assert.match(c.generationExpression!, /parent_id/);
    }
    for (const [child, expected] of [
      [{ EXTRA: 'DEFAULT_GENERATED', COLUMN_DEFAULT: 'uuid()' }, [true, false, false]],
      [{ EXTRA: 'auto_increment' }, [true, true, false]],
      [{ IS_NULLABLE: 'YES' }, [true, false, false]],
      [{}, [false, false, false]],
    ] as const) {
      const schema = await introspectMysqlWith(catalog({ child }), 'catalog_canary');
      const c = schema.tables.profiles!.columns[0]!;
      assert.deepEqual([c.hasDefault, c.isGenerated, !!c.isGeneratedStored], expected);
    }
  });

  it('excludes cross-database FKs even when a local table shares the target name', async () => {
    const schema = await introspectMysqlWith(catalog({ referencedSchema: 'other_db' }), 'catalog_canary');
    assert.deepEqual(Object.keys(schema.tables.parents!.relations), []);
    assert.deepEqual(Object.keys(schema.tables.profiles!.relations), []);
  });
});

function checked(command: string, args: string[], cwd = repo): string {
  const r = spawnSync(command, args, { cwd, encoding: 'utf8', timeout: 120_000 });
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}\n${r.error ?? ''}`);
  return r.stdout;
}

describe('MySQL native introspection metadata', () => {
  native.it('observes native canaries, catalog facts, computed write guards and strict ESM/CJS consumers', async () => {
    const mysql = await import('mysql2/promise');
    const url = new URL(MYSQL_URL);
    const admin = await mysql.createConnection(MYSQL_URL);
    const database = `turbine_metadata_${process.pid}_${Date.now()}`;
    const externalDatabase = `${database}_external`;
    const q = (name: string) => `\`${name.replaceAll('`', '``')}\``;
    let raw: Awaited<ReturnType<typeof mysql.createConnection>> | undefined;
    let client: Awaited<ReturnType<typeof turbineMysql>> | undefined;
    try {
      await admin.query(`CREATE DATABASE ${q(database)}`);
      await admin.query(`CREATE DATABASE ${q(externalDatabase)}`);
      url.pathname = `/${database}`;
      raw = await mysql.createConnection({ uri: url.href, namedPlaceholders: true });
      const server = (await raw.query('SELECT VERSION() AS version, @@sql_mode AS mode'))[0] as {
        version: string;
        mode: string;
      }[];
      assert.match(server[0]!.version, /^8\./, 'native MySQL 8 required');
      if (process.env.MYSQL_METADATA_EXPECT_VERSION)
        assert.equal(server[0]!.version, process.env.MYSQL_METADATA_EXPECT_VERSION);
      console.log(`Metadata native canary: ${server[0]!.version}; mode=${server[0]!.mode}`);
      for (const statement of fixture
        .split(';')
        .map((s) => s.trim())
        .filter(Boolean))
        await raw.query(statement);
      await raw.query(`CREATE TABLE ${q(externalDatabase)}.metadata_parents (id INT PRIMARY KEY)`);
      await raw.query(`CREATE TABLE metadata_cross_profiles (parent_id INT UNIQUE,
        FOREIGN KEY (parent_id) REFERENCES ${q(externalDatabase)}.metadata_parents(id))`);
      const exec: MysqlRowExecutor = async (sql, params) => {
        const bindings: Record<string, string> = {};
        for (const [i, param] of params.entries()) {
          assert.ok(typeof param === 'string');
          bindings[`p${i + 1}`] = param;
        }
        return (await raw!.query(sql, bindings))[0] as Record<string, unknown>[];
      };
      const schema = await introspectMysqlWith(exec, database, { logger: {} });
      assert.equal(Object.keys(schema.tables).length, 18);
      assert.equal(schema.tables.metadata_view, undefined);
      assert.deepEqual(Object.keys(schema.tables.metadata_cross_profiles!.relations), []);
      assert.equal(schema.tables.metadata_parents!.relations.metadataCrossProfiles, undefined);
      const again = await introspectMysql({
        connectionString: url.href,
        schema: database,
        logger: {},
        legacyToManyUniques: true,
      });
      assert.equal(again.tables.metadata_parents!.relations.metadataProfiles!.type, 'hasMany');
      const filtered = await introspect({
        connectionString: url.href,
        schema: database,
        dialect: mysqlDialect,
        logger: {},
        include: ['metadata_parents', 'metadata_profiles'],
        legacyToManyUniques: true,
        relationNames: { metadata_parents: { metadataProfiles: 'profileDetails' } },
      });
      assert.deepEqual(Object.keys(filtered.tables), ['metadata_parents', 'metadata_profiles']);
      assert.equal(filtered.tables.metadata_parents!.relations.profileDetails!.type, 'hasMany');
      const parents = schema.tables.metadata_parents!;
      // A to-one is named with the singular, as the PostgreSQL introspector names it.
      for (const name of ['metadataProfile', 'metadataPrimaryProfile', 'metadataIndexedProfile'])
        assert.equal(parents.relations[name]!.type, 'hasOne', name);
      for (const name of ['metadataExpressionProfiles', 'metadataSupersetProfiles'])
        assert.equal(parents.relations[name]!.type, 'hasMany', name);
      assert.deepEqual(Object.keys(again.tables.metadata_parents!.relations).sort(), [
        'metadataExpressionProfiles',
        'metadataIndexedProfiles',
        'metadataPrimaryProfiles',
        'metadataProfiles',
        'metadataSupersetProfiles',
      ]);
      assert.equal(schema.tables.metadata_composite_parents!.relations.metadataCompositeLink!.type, 'hasOne');
      assert.deepEqual(schema.tables.metadata_composite_parents!.primaryKey, ['code', 'tenant_id']);
      assert.deepEqual(schema.tables.metadata_composite_links!.uniqueColumns, []);
      assert.equal(schema.tables.metadata_text_parents!.relations.metadataTextProfile!.type, 'hasOne');
      assert.equal(schema.tables.metadata_text_parents!.relations.metadataLengthProfiles!.type, 'hasMany');
      assert.equal(schema.tables.metadata_float_parents!.relations.metadataFloatProfiles!.type, 'hasMany');

      await raw.query('INSERT INTO metadata_parents VALUES (1), (2)');
      await raw.query('INSERT INTO metadata_profiles(parent_id) VALUES (1), (NULL), (NULL)');
      await assert.rejects(raw.query('INSERT INTO metadata_profiles(parent_id) VALUES (1)'), /Duplicate entry/);
      await raw.query('INSERT INTO metadata_primary_profiles VALUES (1)');
      await assert.rejects(raw.query('INSERT INTO metadata_primary_profiles VALUES (1)'), /Duplicate entry/);
      await raw.query('INSERT INTO metadata_indexed_profiles(parent_id) VALUES (1)');
      await assert.rejects(raw.query('INSERT INTO metadata_indexed_profiles(parent_id) VALUES (1)'), /Duplicate entry/);
      await raw.query("INSERT INTO metadata_expression_profiles(parent_id, label) VALUES (1, 'a'), (1, 'b')");
      await raw.query('INSERT INTO metadata_superset_profiles(parent_id, scope) VALUES (1, 1), (1, 2)');
      await raw.query("INSERT INTO metadata_text_parents VALUES ('a')");
      await raw.query("INSERT INTO metadata_text_profiles VALUES ('A')");
      await assert.rejects(raw.query("INSERT INTO metadata_text_profiles VALUES ('a')"), /Duplicate entry/);
      await assert.rejects(
        raw.query(`CREATE TABLE metadata_bad_collation (
          parent_id VARCHAR(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin UNIQUE,
          FOREIGN KEY (parent_id) REFERENCES metadata_text_parents(id))`),
        /incompatible/,
      );
      await raw.query("INSERT INTO metadata_composite_parents VALUES (7, 'a')");
      await raw.query("INSERT INTO metadata_composite_links VALUES (7, 'A')");
      await assert.rejects(raw.query("INSERT INTO metadata_composite_links VALUES (7, 'a')"), /Duplicate entry/);

      for (const [table, name] of [
        ['metadata_prefix_keys', 'uq_prefix'],
        ['metadata_expression_profiles', 'uq_expression'],
      ]) {
        const metadata = schema.tables[table!]!;
        const index = metadata.indexes.find((i) => i.name === name)!;
        assert.ok(index, name);
        assert.deepEqual(index.columns, []);
        assert.deepEqual(metadata.uniqueColumns, []);
        assert.equal(index.partial, undefined);
        const facts = JSON.parse(index.definition.replace(/^MySQL index metadata: /, ''));
        if (name === 'uq_prefix') assert.equal(facts.keys[0].prefixLength, 3);
        else {
          assert.equal(facts.keys.length, 3);
          assert.match(facts.keys[1].expression, /lower/);
        }
      }
      const hidden = schema.tables.metadata_native_indexes!.indexes.find((i) => i.name === 'ix_hidden')!;
      assert.deepEqual(hidden.columns, ['title']);
      const hiddenFacts = JSON.parse(hidden.definition.replace(/^MySQL index metadata: /, ''));
      assert.deepEqual(
        [hiddenFacts.type, hiddenFacts.visible, hiddenFacts.comment, hiddenFacts.keys[0].order],
        ['BTREE', 'NO', 'hidden native fact', 'D'],
      );
      assert.match(
        schema.tables.metadata_native_indexes!.indexes.find((i) => i.name === 'ix_fulltext')!.definition,
        /FULLTEXT/,
      );
      await raw.query("INSERT INTO metadata_prefix_keys(email) VALUES ('abc1')");
      await assert.rejects(raw.query("INSERT INTO metadata_prefix_keys(email) VALUES ('abc2')"), /Duplicate entry/);
      await assert.rejects(
        raw.query('CREATE INDEX ix_partial ON metadata_profiles(parent_id) WHERE parent_id IS NOT NULL'),
        /syntax/,
      );
      assert.ok(
        Object.values(schema.tables)
          .flatMap((t) => t.indexes)
          .every((i) => i.partial === undefined),
      );

      const defaults = schema.tables.metadata_defaults!.columns;
      assert.deepEqual(
        defaults.map((c) => [c.name, c.nullable, c.hasDefault, !!c.isGenerated, !!c.isGeneratedStored]),
        [
          ['id', false, true, true, false],
          ['required_count', false, false, false, false],
          ['optional_text', true, true, false, false],
          ['explicit_null', true, true, false, false],
          ['literal_text', false, true, false, false],
          ['zero_count', false, true, false, false],
          ['token', false, true, false, false],
          ['touched', false, true, false, false],
        ],
      );
      await assert.rejects(raw.query('INSERT INTO metadata_defaults () VALUES ()'), /required_count/);
      await raw.query('INSERT INTO metadata_defaults(required_count) VALUES (4)');
      const defaultRow = (await raw.query('SELECT * FROM metadata_defaults'))[0] as Record<string, unknown>[];
      assert.deepEqual(
        [
          defaultRow[0]!.optional_text,
          defaultRow[0]!.explicit_null,
          defaultRow[0]!.literal_text,
          defaultRow[0]!.zero_count,
        ],
        [null, null, "a,b'c", 0],
      );
      assert.match(String(defaultRow[0]!.token), /^[\da-f-]{36}$/);
      for (const name of ['virtual_total', 'stored_total']) {
        const c = schema.tables.metadata_generated!.columns.find((c) => c.name === name)!;
        assert.equal(c.hasDefault, true);
        assert.equal(c.isGeneratedStored, true);
        assert.equal(c.isGenerated, false);
        assert.match(c.generationExpression!, /quantity/);
        await assert.rejects(
          raw.query(`INSERT INTO metadata_generated(quantity, ${q(name)}) VALUES (4, 8)`),
          /generated column/,
        );
      }

      client = await turbineMysql(url.href, schema, { logger: {}, warnOnUnlimited: false });
      const computed = await client.table('metadata_generated').create({ data: { quantity: 4 } });
      assert.deepEqual([computed.virtualTotal, computed.storedTotal], [8, 12]);
      for (const data of [
        { quantity: 4, virtualTotal: 8 },
        { quantity: 4, stored_total: 12 },
      ]) {
        await assert.rejects(client.table('metadata_generated').create({ data }), /database computes/);
        await assert.rejects(
          client.table('metadata_generated').update({ where: { id: computed.id }, data }),
          /database computes/,
        );
        await assert.rejects(client.table('metadata_generated').createMany({ data: [data] }), /database computes/);
      }
      const rows = await client
        .table('metadata_parents')
        .findMany({ orderBy: { id: 'asc' }, with: { metadataProfile: true, metadataExpressionProfiles: true } });
      assert.equal(rows.length, 2);
      assert.equal((rows[0]!.metadataProfile as Record<string, unknown>).parentId, 1);
      assert.equal((rows[0]!.metadataExpressionProfiles as unknown[]).length, 2);
      assert.equal(rows[1]!.metadataProfile, null);
      const stored = (await raw.query('SELECT COUNT(*) AS n FROM metadata_generated'))[0] as { n: number }[];
      assert.equal(stored[0]!.n, 1, 'rejected computed writes must have no native effects');
      for (const emitter of [generateIndex, generateTypes, generateMetadata])
        assert.equal(
          emitter(schema, { target: 'mysql', noTimestamp: true }),
          emitter(await introspectMysqlWith(exec, database, { logger: {} }), { target: 'mysql', noTimestamp: true }),
        );
      strictConsumers(schema, url.href);
    } finally {
      await client?.disconnect();
      await raw?.end();
      await admin.query(`DROP DATABASE IF EXISTS ${q(database)}`);
      await admin.query(`DROP DATABASE IF EXISTS ${q(externalDatabase)}`);
      await admin.end();
    }
  });
});

function strictConsumers(schema: SchemaMetadata, url: string): void {
  const root = mkdtempSync(join(tmpdir(), 'turbine-mysql-metadata-consumer-'));
  try {
    // Source database jobs have no dist prerequisite. Compile into this test's
    // own package, never depend on or overwrite a concurrent test's build.
    const pkg = join(root, 'package');
    mkdirSync(join(pkg, 'scripts'), { recursive: true });
    writeFileSync(join(pkg, 'package.json'), readFileSync(join(repo, 'package.json')));
    writeFileSync(join(pkg, 'scripts/finish-cjs-build.mjs'), readFileSync(join(repo, 'scripts/finish-cjs-build.mjs')));
    checked(join(repo, 'node_modules/.bin/tsc'), ['-p', join(repo, 'tsconfig.json'), '--outDir', join(pkg, 'dist')]);
    checked(join(repo, 'node_modules/.bin/tsc'), [
      '-p',
      join(repo, 'tsconfig.cjs.json'),
      '--outDir',
      join(pkg, 'dist/cjs'),
    ]);
    checked(process.execPath, [join(pkg, 'scripts/finish-cjs-build.mjs')]);
    mkdirSync(join(root, 'node_modules'));
    symlinkSync(pkg, join(root, 'node_modules/turbine-orm'), 'dir');
    for (const peer of ['pg', 'mysql2'])
      symlinkSync(join(repo, 'node_modules', peer), join(root, 'node_modules', peer), 'dir');
    for (const format of ['module', 'commonjs']) {
      const dir = join(root, format);
      mkdirSync(join(dir, 'generated'), { recursive: true });
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ type: format }));
      for (const [name, emitter] of [
        ['index', generateIndex],
        ['types', generateTypes],
        ['metadata', generateMetadata],
      ] as const)
        writeFileSync(join(dir, 'generated', `${name}.ts`), emitter(schema, { target: 'mysql', noTimestamp: true }));
      writeFileSync(
        join(dir, 'tsconfig.json'),
        JSON.stringify({
          compilerOptions: {
            strict: true,
            exactOptionalPropertyTypes: true,
            skipLibCheck: false,
            target: 'ES2023',
            module: 'NodeNext',
            moduleResolution: 'NodeNext',
            outDir: 'out',
            typeRoots: [join(repo, 'node_modules/@types')],
            types: ['node'],
          },
          include: ['**/*.ts'],
          exclude: ['out'],
        }),
      );
      const valid = `import assert from 'node:assert/strict';
import { turbine } from './generated/index.js';
async function main() {
  const db = await turbine(${JSON.stringify(url)}, { logger: {}, warnOnUnlimited: false });
  try {
    const computed = await db.metadataGenerated.create({ data: { quantity: 5 } });
    const n: number | null = computed.virtualTotal;
    assert.equal(n, 10); assert.equal(computed.storedTotal, 15);
    await assert.rejects(db.metadataGenerated.create({ data: { quantity: 1, virtualTotal: 2 } as never }), /database computes/);
    await assert.rejects(db.metadataGenerated.update({ where: { id: computed.id }, data: { storedTotal: 3 } as never }), /database computes/);
    const parent = await db.metadataParents.findFirst({ where: { id: 1 }, with: { metadataProfile: true, metadataExpressionProfiles: true } });
    const id: number | null | undefined = parent?.metadataProfile?.parentId;
    const many: number | undefined = parent?.metadataExpressionProfiles[0]?.id;
    assert.equal(id, 1); assert.ok(many);
    const checks = () => {
      void db.metadataDefaults.create({ data: { requiredCount: 3 } });
      void db.metadataProfiles.create({ data: {} });
      void db.metadataGenerated.create({ data: { id: 100, quantity: 1 } });
    }; void checks;
  } finally { await db.disconnect(); }
}
void main();
`;
      const invalid = [
        'db.metadataDefaults.create({ data: {} });',
        'db.metadataPrimaryProfiles.create({ data: {} });',
        'db.metadataGenerated.create({ data: { quantity: 1, virtualTotal: 2 } });',
        'db.metadataGenerated.update({ where: { id: 1 }, data: { storedTotal: 3 } });',
        'db.metadataParents.findFirst({ with: { metadataProfile: true } }).then((p) => p?.metadataProfile?.[0]);',
        'db.metadataParents.findFirst({ with: { metadataExpressionProfiles: true } }).then((p) => p?.metadataExpressionProfiles?.id);',
        'db.metadataExpressionProfiles.findUnique({ where: { parentId_scope: { parentId: 1, scope: 0 } } });',
      ];
      writeFileSync(join(dir, 'usage.ts'), valid);
      const bad = `import { turbine } from './generated/index.js';\nasync function invalid() { const db = await turbine(${JSON.stringify(url)});\n${invalid.map((s) => `// @ts-expect-error invalid metadata consumer\n${s}`).join('\n')}\n}\nvoid invalid;`;
      writeFileSync(join(dir, 'invalid.ts'), bad);
      checked(join(repo, 'node_modules/.bin/tsc'), ['-p', dir]);
      checked(process.execPath, [join(dir, 'out/usage.js')], dir);
      writeFileSync(join(dir, 'invalid.ts'), bad.replaceAll('// @ts-expect-error invalid metadata consumer', ''));
      const broken = spawnSync(join(repo, 'node_modules/.bin/tsc'), ['-p', dir, '--noEmit'], {
        encoding: 'utf8',
        timeout: 120_000,
      });
      assert.notEqual(broken.status, 0, 'invalid metadata consumer unexpectedly compiled');
      for (const statement of invalid) {
        const line = bad.slice(0, bad.indexOf(statement)).split('\n').length;
        assert.ok(
          broken.stdout.includes(`invalid.ts(${line},`),
          `No diagnostic for ${statement}\n${broken.stdout}\n${broken.stderr}`,
        );
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
