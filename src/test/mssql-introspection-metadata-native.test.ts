/** Requires an explicitly supplied disposable SQL Server database; fixtures never substitute for it. */
import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { mssqlMigrationConfig } from '../cli/mssql-migrate-connection.js';
import { introspectMssqlWith, type MssqlRowExecutor, mssqlDialect } from '../mssql.js';
import importOptionalPeer from '../optional-peer-import.cjs';
import { makeQuery, skipGate } from './helpers.js';

const endpoint = process.env.MSSQL_TEST_URL ?? process.env.MSSQL_URL;
const gate = skipGate(
  !endpoint,
  'requires MSSQL_URL pointing at a disposable SQL Server 2016+ database for metadata tests',
);
interface Request {
  input(name: string, value: unknown): Request;
  query(sql: string): Promise<{ recordset?: Record<string, unknown>[] }>;
}
interface Pool {
  connect(): Promise<unknown>;
  close(): Promise<unknown>;
  request(): Request;
}
interface Driver {
  ConnectionPool: new (config: unknown) => Pool;
}
async function fixture(t: TestContext) {
  const mod = (await importOptionalPeer('mssql')) as Driver & { default?: Driver };
  const pool = new (mod.default ?? mod).ConnectionPool(mssqlMigrationConfig(endpoint!));
  await pool.connect();
  const schema = `metadata_${process.pid}_${Math.random().toString(36).slice(2, 12)}] owned`;
  const external = `${schema}_other`;
  const q = mssqlDialect.quoteIdentifier;
  const ns = q(schema);
  const other = q(external);
  const owned: Array<{ schema: string; table: string }> = [];
  const schemas: string[] = [];
  const exec: MssqlRowExecutor = async (sql, params) => {
    const request = pool.request();
    params.forEach((value, i) => {
      request.input(`p${i + 1}`, value);
    });
    return (await request.query(sql)).recordset ?? [];
  };
  t.after(async () => {
    try {
      for (const object of owned.reverse()) await exec(`DROP TABLE ${q(object.schema)}.${q(object.table)}`, []);
      for (const name of schemas.reverse()) await exec(`DROP SCHEMA ${q(name)}`, []);
    } finally {
      await pool.close();
    }
  });
  for (const name of [schema, external]) {
    await exec(`CREATE SCHEMA ${q(name)}`, []);
    schemas.push(name);
  }
  const create = async (table: string, body: string, selected = schema) => {
    await exec(`CREATE TABLE ${q(selected)}.${q(table)} (${body})`, []);
    owned.push({ schema: selected, table });
  };
  await create('parents', 'id int PRIMARY KEY');
  await create('parents', 'id int PRIMARY KEY', external);
  await create(
    'profiles',
    `id int IDENTITY(1,1) PRIMARY KEY, parent_id int NULL REFERENCES ${ns}.parents(id), label nvarchar(50)`,
  );
  await exec(`CREATE UNIQUE INDEX [UQ_profile] ON ${ns}.profiles(parent_id DESC) INCLUDE(label)`, []);
  await create('primary_profiles', `parent_id int PRIMARY KEY REFERENCES ${ns}.parents(id)`);
  await create(
    'filtered_profiles',
    `id int PRIMARY KEY, parent_id int REFERENCES ${ns}.parents(id), scope int NOT NULL DEFAULT 0`,
  );
  await exec(`CREATE UNIQUE INDEX UQ_filtered ON ${ns}.filtered_profiles(parent_id) WHERE scope = 1`, []);
  await exec(
    `CREATE UNIQUE INDEX UQ_filtered_compound ON ${ns}.filtered_profiles(parent_id,scope) WHERE scope = 1`,
    [],
  );
  await create(
    'computed_profiles',
    `id int PRIMARY KEY, parent_id int REFERENCES ${ns}.parents(id), scope int NOT NULL,
    normalized AS scope * 2 PERSISTED`,
  );
  await exec(`CREATE UNIQUE INDEX UQ_computed ON ${ns}.computed_profiles(parent_id,normalized)`, []);
  await create(
    'superset_profiles',
    `id int PRIMARY KEY, parent_id int REFERENCES ${ns}.parents(id), scope int NOT NULL,
    UNIQUE(parent_id,scope)`,
  );
  await create('disabled_profiles', `id int PRIMARY KEY, parent_id int REFERENCES ${ns}.parents(id)`);
  await exec(`CREATE UNIQUE INDEX UQ_disabled ON ${ns}.disabled_profiles(parent_id)`, []);
  await exec(`ALTER INDEX UQ_disabled ON ${ns}.disabled_profiles DISABLE`, []);
  await create(
    'composite_parents',
    'tenant_id int NOT NULL, code nvarchar(20) COLLATE Latin1_General_100_CS_AS NOT NULL, PRIMARY KEY(code,tenant_id)',
  );
  await create(
    'composite_links',
    `tenant_id int NOT NULL, code nvarchar(20) COLLATE Latin1_General_100_CS_AS NOT NULL,
    PRIMARY KEY(tenant_id,code), FOREIGN KEY(code,tenant_id) REFERENCES ${ns}.composite_parents(code,tenant_id)`,
  );
  await create(
    'composite_unique_links',
    `id int PRIMARY KEY, tenant_id int NOT NULL,
    code nvarchar(20) COLLATE Latin1_General_100_CS_AS NOT NULL, UNIQUE(code,tenant_id),
    FOREIGN KEY(code,tenant_id) REFERENCES ${ns}.composite_parents(code,tenant_id)`,
  );
  await create('cross_links', `id int PRIMARY KEY, parent_id int REFERENCES ${other}.parents(id)`);
  await create(
    'generated_records',
    `id int IDENTITY(1,1) PRIMARY KEY, quantity int NOT NULL, optional_text nvarchar(50) NULL,
    default_count int NOT NULL DEFAULT 7, virtual_total AS quantity * 2, stored_total AS quantity * 3 PERSISTED,
    version rowversion, period_start datetime2 GENERATED ALWAYS AS ROW START NOT NULL DEFAULT SYSUTCDATETIME(),
    period_end datetime2 GENERATED ALWAYS AS ROW END HIDDEN NOT NULL DEFAULT CONVERT(datetime2,'9999-12-31 23:59:59.9999999'),
    PERIOD FOR SYSTEM_TIME(period_start,period_end)`,
  );
  return { schema, ns, other, exec, metadata: () => introspectMssqlWith(exec, schema, { logger: {} }) };
}

gate.it(
  'native catalog agrees with actual identity/default/nullability/computed and generated-always effects',
  { timeout: 30_000 },
  async (t) => {
    const f = await fixture(t);
    const rows = await f.exec(
      `INSERT INTO ${f.ns}.generated_records(quantity) OUTPUT INSERTED.id, INSERTED.default_count,
    INSERTED.optional_text, INSERTED.virtual_total, INSERTED.stored_total, INSERTED.version VALUES (4)`,
      [],
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.id, 1);
    assert.equal(rows[0]!.default_count, 7);
    assert.equal(rows[0]!.optional_text, null);
    assert.equal(rows[0]!.virtual_total, 8);
    assert.equal(rows[0]!.stored_total, 12);
    assert.ok(rows[0]!.version instanceof Uint8Array);
    await assert.rejects(f.exec(`INSERT INTO ${f.ns}.generated_records DEFAULT VALUES`, []));
    await assert.rejects(f.exec(`INSERT INTO ${f.ns}.generated_records(quantity,virtual_total) VALUES (4,8)`, []));
    const metadata = await f.metadata();
    const columns = metadata.tables.generated_records!.columns;
    assert.equal(columns.find((c) => c.name === 'id')!.isGenerated, true);
    assert.equal(columns.find((c) => c.name === 'quantity')!.hasDefault, false);
    assert.equal(columns.find((c) => c.name === 'default_count')!.hasDefault, true);
    assert.equal(columns.find((c) => c.name === 'optional_text')!.nullable, true);
    assert.equal(
      columns.some((c) => c.name === 'period_end'),
      false,
    );
    const query = makeQuery('generated_records', metadata, { dialect: mssqlDialect });
    for (const field of ['virtualTotal', 'storedTotal', 'version', 'periodStart']) {
      assert.equal(columns.find((c) => c.field === field)!.isGeneratedStored, true, field);
      assert.throws(() => query.buildCreate({ data: { quantity: 4, [field]: 8 } }), /generated/i);
      assert.throws(() => query.buildUpdate({ where: { id: 1 }, data: { [field]: 8 } }), /generated/i);
    }
  },
);

gate.it(
  'native uniqueness proves reverse cardinality only for active full plain keys and scoped composite FKs',
  { timeout: 30_000 },
  async (t) => {
    const f = await fixture(t);
    await f.exec(`INSERT INTO ${f.ns}.parents VALUES(1),(2)`, []);
    await f.exec(`INSERT INTO ${f.ns}.profiles(parent_id,label) VALUES(1,N'one'),(NULL,N'null')`, []);
    await assert.rejects(f.exec(`INSERT INTO ${f.ns}.profiles(parent_id) VALUES(1)`, []));
    await assert.rejects(f.exec(`INSERT INTO ${f.ns}.profiles(parent_id) VALUES(NULL)`, []));
    await f.exec(`INSERT INTO ${f.ns}.filtered_profiles VALUES(1,1,0),(2,1,0)`, []);
    await f.exec(`INSERT INTO ${f.ns}.computed_profiles(id,parent_id,scope) VALUES(1,1,1),(2,1,2)`, []);
    await f.exec(`INSERT INTO ${f.ns}.superset_profiles VALUES(1,1,1),(2,1,2)`, []);
    for (const table of ['filtered_profiles', 'computed_profiles', 'superset_profiles']) {
      const count = await f.exec(
        `SELECT COUNT(*) AS n FROM ${f.ns}.${mssqlDialect.quoteIdentifier(table)} c
      JOIN ${f.ns}.parents p ON c.parent_id=p.id WHERE p.id=1`,
        [],
      );
      assert.equal(count[0]!.n, 2, table);
    }
    await f.exec(`INSERT INTO ${f.ns}.composite_parents VALUES(1,N'a')`, []);
    await f.exec(`INSERT INTO ${f.ns}.composite_links VALUES(1,N'a')`, []);
    await assert.rejects(f.exec(`INSERT INTO ${f.ns}.composite_links VALUES(1,N'a')`, []));
    const metadata = await f.metadata();
    const rel = metadata.tables.parents!.relations;
    assert.equal(rel.profile!.type, 'hasOne');
    assert.equal(rel.primaryProfile!.type, 'hasOne');
    for (const name of ['filteredProfiles', 'computedProfiles', 'supersetProfiles', 'disabledProfiles'])
      assert.equal(rel[name]!.type, 'hasMany', name);
    assert.equal(metadata.tables.composite_parents!.relations.compositeLink!.type, 'hasOne');
    assert.equal(metadata.tables.composite_parents!.relations.compositeUniqueLink!.type, 'hasOne');
    assert.deepEqual(metadata.tables.composite_unique_links!.uniqueColumns, [['code', 'tenant_id']]);
    assert.deepEqual(metadata.tables.composite_parents!.primaryKey, ['code', 'tenant_id']);
    assert.deepEqual(metadata.tables.composite_links!.relations.compositeParent!.foreignKey, ['code', 'tenant_id']);
    assert.deepEqual(Object.keys(metadata.tables.cross_links!.relations), []);
    assert.deepEqual(metadata.tables.profiles!.uniqueColumns, [['parent_id']]);
    assert.equal(
      metadata.tables.filtered_profiles!.indexes.every((i) => i.partial),
      true,
    );
    assert.deepEqual(metadata.tables.filtered_profiles!.uniqueColumns, []);
    assert.deepEqual(metadata.tables.computed_profiles!.indexes[0]!.columns, []);
    assert.equal(metadata.tables.disabled_profiles!.indexes[0]!.unique, false);
    const legacy = await introspectMssqlWith(f.exec, f.schema, { logger: {}, legacyToManyUniques: true });
    assert.equal(legacy.tables.parents!.relations.profiles!.type, 'hasMany');
    // Legacy mode restores the plural name for the two unique-FK children; every
    // other relation keeps the name it has by default.
    const legacyNames: Record<string, string> = { profile: 'profiles', primaryProfile: 'primaryProfiles' };
    assert.deepEqual(
      Object.keys(legacy.tables.parents!.relations).sort(),
      Object.keys(rel)
        .map((name) => legacyNames[name] ?? name)
        .sort(),
    );
    assert.equal(legacy.tables.parents!.relations.primaryProfiles!.type, 'hasMany');
  },
);
