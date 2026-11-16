/**
 * MySQL introspection proves a foreign key to-one only when the child's
 * foreign-key columns are EXACTLY its primary key or one of its unique keys,
 * and each column pair compares the way the enforced key does. Two ways that
 * proof could be granted on too little:
 *
 *   1. A unique key the same size as the foreign key that shares only some of
 *      its columns: `UNIQUE (tenant_id, slot)` beside
 *      `FOREIGN KEY (tenant_id, code)` lets many rows reference one parent.
 *   2. A column the catalog did not describe: with nothing to compare, the
 *      pair is not known to compare like the key, so nothing is proven. The
 *      catalog really does this: `information_schema.COLUMNS` lists only the
 *      columns the connected user holds a privilege on, while
 *      `KEY_COLUMN_USAGE` still lists the foreign key and its referenced
 *      column.
 *
 * Each case runs against a recorded catalog in the unit lane, and against a
 * real MySQL 8 server when MYSQL_URL is set.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { introspectMysqlWith, type MysqlRowExecutor } from '../mysql.js';
import type { SchemaMetadata } from '../schema.js';
import { skipGate } from './helpers.js';

const MYSQL_URL = process.env.MYSQL_URL ?? process.env.MYSQL_TEST_URL ?? '';
const native = skipGate(!MYSQL_URL, 'MySQL metadata needs MYSQL_URL pointing at a disposable MySQL 8 server');

const SCHEMA = 'unique_fk_canary';

function column(table: string, name: string) {
  return {
    TABLE_NAME: table,
    COLUMN_NAME: name,
    DATA_TYPE: 'int',
    COLUMN_TYPE: 'int',
    IS_NULLABLE: 'YES',
    COLUMN_KEY: '',
    COLUMN_DEFAULT: null,
    EXTRA: '',
    CHARACTER_MAXIMUM_LENGTH: null,
    CHARACTER_SET_NAME: null,
    COLLATION_NAME: null,
    GENERATION_EXPRESSION: '',
  };
}

function uniqueIndex(table: string, name: string, columns: string[]) {
  return columns.map((columnName, i) => ({
    TABLE_NAME: table,
    INDEX_NAME: name,
    NON_UNIQUE: 0,
    COLUMN_NAME: columnName,
    SEQ_IN_INDEX: i + 1,
    SUB_PART: null,
    EXPRESSION: null,
    COLLATION: 'A',
    INDEX_TYPE: 'BTREE',
    IS_VISIBLE: 'YES',
    INDEX_COMMENT: '',
  }));
}

interface Recorded {
  tables: string[];
  columns: ReturnType<typeof column>[];
  primaryKeys: [table: string, column: string][];
  foreignKey: { table: string; columns: string[]; parent: string; parentColumns: string[] };
  indexes: ReturnType<typeof uniqueIndex>;
}

/** A catalog answering exactly what `recorded` holds, the way information_schema does. */
function recordedCatalog(recorded: Recorded): MysqlRowExecutor {
  return async (sql, params) => {
    assert.deepEqual(params, [SCHEMA]);
    if (sql.includes('information_schema.TABLES')) return recorded.tables.map((t) => ({ TABLE_NAME: t }));
    if (sql.includes('information_schema.COLUMNS')) return recorded.columns;
    if (sql.includes("CONSTRAINT_NAME = 'PRIMARY'"))
      return recorded.primaryKeys.map(([t, c], i) => ({ TABLE_NAME: t, COLUMN_NAME: c, ORDINAL_POSITION: i + 1 }));
    if (sql.includes('REFERENCED_TABLE_NAME IS NOT NULL')) {
      const fk = recorded.foreignKey;
      return fk.columns.map((c, i) => ({
        TABLE_NAME: fk.table,
        COLUMN_NAME: c,
        ORDINAL_POSITION: i + 1,
        REFERENCED_TABLE_SCHEMA: SCHEMA,
        REFERENCED_TABLE_NAME: fk.parent,
        REFERENCED_COLUMN_NAME: fk.parentColumns[i],
        CONSTRAINT_NAME: `fk_${fk.table}`,
      }));
    }
    // Constraint names only reserve names; these single-column keys read none.
    if (sql.includes('information_schema.TABLE_CONSTRAINTS')) return [];
    assert.match(sql, /information_schema\.STATISTICS/);
    return recorded.indexes;
  };
}

/** Every relation as `table.relation: type`, for one readable comparison. */
function relationTypes(schema: SchemaMetadata): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [table, meta] of Object.entries(schema.tables))
    for (const [name, rel] of Object.entries(meta.relations)) out[`${table}.${name}`] = rel.type;
  return out;
}

/** `tenants(tenant_id, code)` and `links` holding `FOREIGN KEY (tenant_id, code)` with `UNIQUE (<unique>)`. */
function compositeKeyCatalog(unique: string[]): Recorded {
  return {
    tables: ['links', 'tenants'],
    columns: [
      column('links', 'id'),
      column('links', 'tenant_id'),
      column('links', 'code'),
      column('links', 'slot'),
      column('tenants', 'tenant_id'),
      column('tenants', 'code'),
    ],
    primaryKeys: [
      ['links', 'id'],
      ['tenants', 'tenant_id'],
      ['tenants', 'code'],
    ],
    foreignKey: {
      table: 'links',
      columns: ['tenant_id', 'code'],
      parent: 'tenants',
      parentColumns: ['tenant_id', 'code'],
    },
    indexes: uniqueIndex('links', 'uq_links', unique),
  };
}

/** `parents(id)` and `profiles(parent_id UNIQUE)`, with the described columns limited to `described`. */
function hiddenColumnCatalog(described: [table: string, column: string][]): Recorded {
  return {
    tables: ['parents', 'profiles'],
    columns: described.map(([t, c]) => column(t, c)),
    primaryKeys: [['parents', 'id']],
    foreignKey: { table: 'profiles', columns: ['parent_id'], parent: 'parents', parentColumns: ['id'] },
    indexes: uniqueIndex('profiles', 'uq_parent', ['parent_id']),
  };
}

describe('MySQL to-one proof: key membership is every foreign-key column', () => {
  it('a unique key sharing one of two foreign-key columns proves nothing: the relation stays to-many', async () => {
    const schema = await introspectMysqlWith(recordedCatalog(compositeKeyCatalog(['tenant_id', 'slot'])), SCHEMA, {
      logger: {},
    });
    assert.deepEqual(relationTypes(schema), { 'links.tenant': 'belongsTo', 'tenants.links': 'hasMany' });
  });

  it('a unique key over exactly the foreign-key columns, in either order, proves the to-one (control)', async () => {
    for (const unique of [
      ['tenant_id', 'code'],
      ['code', 'tenant_id'],
    ]) {
      const schema = await introspectMysqlWith(recordedCatalog(compositeKeyCatalog(unique)), SCHEMA, { logger: {} });
      assert.deepEqual(
        relationTypes(schema),
        { 'links.tenant': 'belongsTo', 'tenants.link': 'hasOne' },
        unique.join(', '),
      );
    }
  });
});

describe('MySQL to-one proof: a column the catalog did not describe is refused', () => {
  it('the referenced column undescribed (a column-level grant hides it): to-many', async () => {
    const schema = await introspectMysqlWith(
      recordedCatalog(hiddenColumnCatalog([['profiles', 'parent_id']])),
      SCHEMA,
      { logger: {} },
    );
    assert.equal(schema.tables.parents!.relations.profiles?.type, 'hasMany', JSON.stringify(relationTypes(schema)));
    assert.equal(schema.tables.parents!.relations.profile, undefined);
  });

  it('the foreign-key column undescribed: to-many', async () => {
    const schema = await introspectMysqlWith(recordedCatalog(hiddenColumnCatalog([['parents', 'id']])), SCHEMA, {
      logger: {},
    });
    assert.equal(schema.tables.parents!.relations.profiles?.type, 'hasMany', JSON.stringify(relationTypes(schema)));
    assert.equal(schema.tables.parents!.relations.profile, undefined);
  });

  it('both columns described: the same key proves the to-one (control)', async () => {
    const schema = await introspectMysqlWith(
      recordedCatalog(
        hiddenColumnCatalog([
          ['parents', 'id'],
          ['profiles', 'parent_id'],
        ]),
      ),
      SCHEMA,
      { logger: {} },
    );
    assert.equal(schema.tables.parents!.relations.profile?.type, 'hasOne', JSON.stringify(relationTypes(schema)));
  });
});

describe('MySQL to-one proof on a native catalog', () => {
  native.it('a partially overlapping unique key and a column hidden by a grant both keep the to-many', async () => {
    const mysql = await import('mysql2/promise');
    const database = `turbine_unique_fk_${process.pid}_${Date.now()}`;
    const user = `tufk_${process.pid}_${Date.now() % 100000}`;
    const password = `pw_${process.pid}_${Date.now()}`;
    const q = (name: string) => `\`${name.replaceAll('`', '``')}\``;
    const admin = await mysql.createConnection(MYSQL_URL);
    const opened: Awaited<ReturnType<typeof mysql.createConnection>>[] = [];
    const connectAs = async (url: URL) => {
      const conn = await mysql.createConnection({ uri: url.href, namedPlaceholders: true });
      opened.push(conn);
      const exec: MysqlRowExecutor = async (sql, params) => {
        const bindings: Record<string, string> = {};
        for (const [i, param] of params.entries()) bindings[`p${i + 1}`] = String(param);
        return (await conn.query(sql, bindings))[0] as Record<string, unknown>[];
      };
      return exec;
    };
    let userCreated = false;
    try {
      const version = ((await admin.query('SELECT VERSION() AS v'))[0] as { v: string }[])[0]!.v;
      assert.match(version, /^8\./, 'native MySQL 8 required');
      await admin.query(`CREATE DATABASE ${q(database)}`);
      await admin.query(`USE ${q(database)}`);
      for (const statement of [
        'CREATE TABLE tenants (tenant_id INT, code INT, PRIMARY KEY (tenant_id, code))',
        `CREATE TABLE links (id INT PRIMARY KEY, tenant_id INT, code INT, slot INT,
           UNIQUE KEY uq_slot (tenant_id, slot),
           FOREIGN KEY (tenant_id, code) REFERENCES tenants (tenant_id, code))`,
        `CREATE TABLE exact_links (id INT PRIMARY KEY, tenant_id INT, code INT,
           UNIQUE KEY uq_exact (code, tenant_id),
           FOREIGN KEY (tenant_id, code) REFERENCES tenants (tenant_id, code))`,
        'CREATE TABLE parents (id INT PRIMARY KEY, label INT)',
        `CREATE TABLE profiles (id INT PRIMARY KEY, parent_id INT UNIQUE,
           FOREIGN KEY (parent_id) REFERENCES parents (id))`,
      ])
        await admin.query(statement);

      const full = new URL(MYSQL_URL);
      full.pathname = `/${database}`;
      const schema = await introspectMysqlWith(await connectAs(full), database, { logger: {} });
      const types = relationTypes(schema);
      // The unique key shares tenant_id with the foreign key and nothing more.
      assert.equal(types['tenants.links'], 'hasMany', JSON.stringify(types));
      assert.equal(types['tenants.link'], undefined, JSON.stringify(types));
      assert.equal(types['tenants.exactLink'], 'hasOne', JSON.stringify(types));
      // Every column visible: the single-column key proves the to-one.
      assert.equal(types['parents.profile'], 'hasOne', JSON.stringify(types));

      // A user who may read parents.label but not parents.id: COLUMNS omits
      // parents.id while KEY_COLUMN_USAGE still lists the foreign key to it.
      await admin.query(`CREATE USER ?@'%' IDENTIFIED BY ?`, [user, password]);
      userCreated = true;
      await admin.query(`GRANT SELECT (label) ON ${q(database)}.parents TO ?@'%'`, [user]);
      await admin.query(`GRANT SELECT ON ${q(database)}.profiles TO ?@'%'`, [user]);
      const narrow = new URL(full.href);
      narrow.username = user;
      narrow.password = password;
      const narrowExec = await connectAs(narrow);
      const described = await narrowExec(
        'SELECT TABLE_NAME, COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = :p1 ORDER BY TABLE_NAME, COLUMN_NAME',
        [database],
      );
      assert.deepEqual(
        described.map((r) => `${r.TABLE_NAME}.${r.COLUMN_NAME}`),
        ['parents.label', 'profiles.id', 'profiles.parent_id'],
        'the grant should hide parents.id from information_schema.COLUMNS',
      );
      const hidden = await introspectMysqlWith(narrowExec, database, { logger: {} });
      const hiddenTypes = relationTypes(hidden);
      assert.equal(hiddenTypes['profiles.parent'], 'belongsTo', 'the foreign key should still be listed');
      assert.equal(hiddenTypes['parents.profiles'], 'hasMany', JSON.stringify(hiddenTypes));
      assert.equal(hiddenTypes['parents.profile'], undefined, JSON.stringify(hiddenTypes));
    } finally {
      for (const conn of opened) await conn.end().catch(() => {});
      if (userCreated) await admin.query(`DROP USER IF EXISTS ?@'%'`, [user]).catch(() => {});
      await admin.query(`DROP DATABASE IF EXISTS ${q(database)}`).catch(() => {});
      await admin.end();
    }
  });
});
