/**
 * A unique foreign key's reverse relation must come out the same on every
 * engine: a to-one (`hasOne`), named as PostgreSQL names it.
 *
 * For `profiles.user_id INTEGER UNIQUE REFERENCES users(id)` the PostgreSQL
 * introspector derives `users.profile`. SQLite, MySQL and SQL Server used to
 * derive `users.profiles`, because they named the relation as a to-many and
 * changed its type afterwards, and `defineSchema` metadata never made it a
 * to-one at all. `with: { profile: true }` then worked on one engine and was
 * E005 on the others, for the same schema.
 *
 * THE MECHANISM. Each case is ONE portable spec, rendered to PostgreSQL, MySQL
 * and SQLite DDL and to a `defineSchema` twin, so the engines cannot be handed
 * subtly different schemas. Every engine is held to the same expected relation
 * set, PostgreSQL included: PostgreSQL is the reference, and the integration
 * job is what proves the expected values are what it really derives.
 *
 * The second half pins the cross-engine differences that are KNOWN and left
 * alone (docs/engines.md lists them), each with every engine's exact output, so
 * changing one of them is a deliberate act that fails here first.
 *
 * WHERE IT RUNS. Code-first and node:sqlite in the unit lane; better-sqlite3
 * when the optional binding loads (CI names it with TURBINE_SQLITE_BINDING_PEER,
 * and TURBINE_REQUIRE_SQLITE_BINDING=1 turns a missing binding into a failure);
 * PostgreSQL when DATABASE_URL is set (integration-tests); MySQL when MYSQL_URL
 * is set (mysql-integration). Each server engine gets its OWN database, so this
 * file cannot race the suites that share the URL's database.
 */

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import { after, before, describe, it } from 'node:test';
import type { BetterSqlite3Database } from '../better-sqlite3.js';
import { type RelationDef, type SchemaMetadata, snakeToCamel } from '../schema.js';
import { defineSchema } from '../schema-builder.js';
import { schemaDefToMetadata } from '../schema-metadata.js';
import { type GatedRunners, skipGate } from './helpers.js';

// ---------------------------------------------------------------------------
// Portable schema spec
// ---------------------------------------------------------------------------

interface ColSpec {
  name: string;
  /** `int` is INTEGER / INT; `text` is VARCHAR(64) on the servers and TEXT on SQLite. */
  type: 'int' | 'text';
  notNull?: boolean;
  /** A single-column UNIQUE constraint. */
  unique?: boolean;
}

interface FkSpec {
  /** Omitted: the engine's default constraint name. */
  name?: string;
  columns: string[];
  table: string;
  references: string[];
  onDelete?: 'cascade';
}

interface TableSpec {
  name: string;
  columns: ColSpec[];
  primaryKey?: string[];
  /** Table-level UNIQUE constraints. */
  unique?: string[][];
  /** Plain UNIQUE indexes (not constraints). */
  uniqueIndexes?: string[][];
  foreignKeys?: FkSpec[];
}

interface NormRelation {
  type: RelationDef['type'];
  to: string;
  foreignKey: string | string[];
  referenceKey: string | string[];
  through?: { table: string; sourceKey: string | string[]; targetKey: string | string[] };
  onDelete?: string;
  onUpdate?: string;
}

type Relations = Record<string, Record<string, NormRelation>>;
type Engine = 'postgres' | 'mysql' | 'sqlite';
type HarnessName = 'code-first' | 'node:sqlite' | 'better-sqlite3' | 'postgres' | 'mysql';

interface Case {
  name: string;
  tables: TableSpec[];
  /** Why the case has no `defineSchema` twin, when it has none. */
  noCodeFirst?: string;
  /** What PostgreSQL derives, the reference every engine is held to. */
  expected: Relations;
}

interface KnownDifference {
  name: string;
  tables: TableSpec[];
  /** Each harness's exact output. The SQLite drivers share one value. */
  expected: Partial<Record<HarnessName | 'sqlite', Relations>>;
}

const id = (): ColSpec => ({ name: 'id', type: 'int', notNull: true });
const int = (name: string, extra: Partial<ColSpec> = {}): ColSpec => ({ name, type: 'int', ...extra });
const text = (name: string, extra: Partial<ColSpec> = {}): ColSpec => ({ name, type: 'text', ...extra });
const fk = (columns: string | string[], table: string, references: string | string[] = 'id', extra = {}): FkSpec => ({
  columns: [columns].flat(),
  table,
  references: [references].flat(),
  ...extra,
});
const t = (name: string, columns: ColSpec[], extra: Partial<TableSpec> = {}): TableSpec => ({
  name,
  columns,
  primaryKey: ['id'],
  ...extra,
});

const belongsTo = (to: string, foreignKey: string | string[], referenceKey: string | string[] = 'id') =>
  ({ type: 'belongsTo', to, foreignKey, referenceKey }) as NormRelation;
const hasMany = (to: string, foreignKey: string | string[], referenceKey: string | string[] = 'id') =>
  ({ type: 'hasMany', to, foreignKey, referenceKey }) as NormRelation;
const hasOne = (to: string, foreignKey: string | string[], referenceKey: string | string[] = 'id') =>
  ({ type: 'hasOne', to, foreignKey, referenceKey }) as NormRelation;
const manyToMany = (to: string, table: string, sourceKey: string, targetKey: string) =>
  ({
    type: 'manyToMany',
    to,
    foreignKey: 'id',
    referenceKey: 'id',
    through: { table, sourceKey, targetKey },
  }) as NormRelation;

// ---------------------------------------------------------------------------
// The cases: a foreign key over exactly a unique key of its own table
// ---------------------------------------------------------------------------

const USERS = t('users', [id(), text('name', { notNull: true })]);

const CASES: Case[] = [
  {
    name: 'unique foreign key',
    tables: [
      USERS,
      t('profiles', [id(), int('user_id', { notNull: true, unique: true }), text('bio')], {
        foreignKeys: [fk('user_id', 'users')],
      }),
    ],
    expected: {
      users: { profile: hasOne('profiles', 'user_id') },
      profiles: { user: belongsTo('users', 'user_id') },
    },
  },
  {
    name: 'nullable unique foreign key',
    tables: [
      USERS,
      t('profiles', [id(), int('user_id', { unique: true }), text('bio')], { foreignKeys: [fk('user_id', 'users')] }),
    ],
    expected: {
      users: { profile: hasOne('profiles', 'user_id') },
      profiles: { user: belongsTo('users', 'user_id') },
    },
  },
  {
    name: 'foreign key covered by a unique index, not a constraint',
    tables: [
      USERS,
      t('avatars', [id(), int('user_id', { notNull: true }), text('url')], {
        uniqueIndexes: [['user_id']],
        foreignKeys: [fk('user_id', 'users')],
      }),
    ],
    expected: {
      users: { avatar: hasOne('avatars', 'user_id') },
      avatars: { user: belongsTo('users', 'user_id') },
    },
  },
  {
    name: 'foreign key that is also the primary key',
    tables: [
      USERS,
      t('user_details', [int('user_id', { notNull: true }), text('bio')], {
        primaryKey: ['user_id'],
        foreignKeys: [fk('user_id', 'users')],
      }),
    ],
    expected: {
      users: { userDetail: hasOne('user_details', 'user_id') },
      user_details: { user: belongsTo('users', 'user_id') },
    },
  },
  {
    name: 'foreign keys to a unique non-primary column',
    tables: [
      t('accounts', [id(), text('code', { notNull: true, unique: true })]),
      t('invoices', [id(), text('account_code', { notNull: true })], {
        foreignKeys: [fk('account_code', 'accounts', 'code')],
      }),
      t('account_settings', [id(), text('account_code', { notNull: true, unique: true })], {
        foreignKeys: [fk('account_code', 'accounts', 'code')],
      }),
    ],
    expected: {
      accounts: {
        invoices: hasMany('invoices', 'account_code', 'code'),
        accountSetting: hasOne('account_settings', 'account_code', 'code'),
      },
      invoices: { account: belongsTo('accounts', 'account_code', 'code') },
      account_settings: { account: belongsTo('accounts', 'account_code', 'code') },
    },
  },
  {
    name: 'two unique foreign keys from one table to the same target',
    tables: [
      t('people', [id(), text('name')]),
      t(
        'couples',
        [id(), int('partner_a_id', { notNull: true, unique: true }), int('partner_b_id', { unique: true })],
        {
          foreignKeys: [fk('partner_a_id', 'people'), fk('partner_b_id', 'people')],
        },
      ),
    ],
    expected: {
      people: {
        coupleByPartnerA: hasOne('couples', 'partner_a_id'),
        coupleByPartnerB: hasOne('couples', 'partner_b_id'),
      },
      couples: { partnerA: belongsTo('people', 'partner_a_id'), partnerB: belongsTo('people', 'partner_b_id') },
    },
  },
  {
    // The singular `node` is the belongsTo's name, so the to-one falls back to
    // the plural, on PostgreSQL and therefore everywhere.
    name: 'self-relation over a unique foreign key',
    tables: [
      t('nodes', [id(), int('successor_id', { unique: true }), text('label')], {
        foreignKeys: [fk('successor_id', 'nodes')],
      }),
    ],
    expected: {
      nodes: { node: belongsTo('nodes', 'successor_id'), nodes: hasOne('nodes', 'successor_id') },
    },
  },
  {
    name: 'self-relations, one of them unique',
    tables: [
      t('employees', [id(), int('manager_id'), int('mentor_id', { unique: true }), text('name')], {
        foreignKeys: [fk('manager_id', 'employees'), fk('mentor_id', 'employees')],
      }),
    ],
    expected: {
      employees: {
        manager: belongsTo('employees', 'manager_id'),
        employeesByManager: hasMany('employees', 'manager_id'),
        mentor: belongsTo('employees', 'mentor_id'),
        employeeByMentor: hasOne('employees', 'mentor_id'),
      },
    },
  },
  {
    // One unique column, two foreign keys to two parents: each is decided on
    // its own, and both are to-one.
    name: 'one unique column referencing two parents',
    tables: [
      USERS,
      t('accounts', [id(), text('label')]),
      t('profiles', [id(), int('owner_id', { notNull: true, unique: true })], {
        foreignKeys: [fk('owner_id', 'users'), fk('owner_id', 'accounts')],
      }),
    ],
    noCodeFirst: 'defineSchema `references` names one target per column',
    expected: {
      users: { profile: hasOne('profiles', 'owner_id') },
      accounts: { profile: hasOne('profiles', 'owner_id') },
      profiles: { user: belongsTo('users', 'owner_id'), account: belongsTo('accounts', 'owner_id') },
    },
  },
  {
    name: 'composite unique foreign key',
    tables: [
      t('orders', [int('tenant_id', { notNull: true }), int('id', { notNull: true }), text('ref')], {
        primaryKey: ['tenant_id', 'id'],
      }),
      t('order_lines', [id(), int('tenant_id', { notNull: true }), int('order_id', { notNull: true })], {
        foreignKeys: [fk(['tenant_id', 'order_id'], 'orders', ['tenant_id', 'id'])],
      }),
      t('shipments', [id(), int('tenant_id', { notNull: true }), int('order_id', { notNull: true })], {
        unique: [['tenant_id', 'order_id']],
        foreignKeys: [fk(['tenant_id', 'order_id'], 'orders', ['tenant_id', 'id'])],
      }),
    ],
    noCodeFirst: 'defineSchema `references` is single-column',
    expected: {
      orders: {
        orderLines: hasMany('order_lines', ['tenant_id', 'order_id'], ['tenant_id', 'id']),
        shipment: hasOne('shipments', ['tenant_id', 'order_id'], ['tenant_id', 'id']),
      },
      order_lines: { order: belongsTo('orders', ['tenant_id', 'order_id'], ['tenant_id', 'id']) },
      shipments: { order: belongsTo('orders', ['tenant_id', 'order_id'], ['tenant_id', 'id']) },
    },
  },
];

// ---------------------------------------------------------------------------
// Known differences, left alone deliberately. None involves a unique foreign
// key, and each output here is what the engine derived before the to-one change
// as well.
// ---------------------------------------------------------------------------

const KNOWN_DIFFERENCES: KnownDifference[] = [
  {
    // PostgreSQL accepts a two-column UNIQUE index in place of a junction's
    // primary key (Prisma's implicit many-to-many tables have none). The other
    // engines, and code-first, need the primary key.
    name: 'junction table keyed by a unique index, no primary key',
    tables: [
      t('posts', [id(), text('title')]),
      t('tags', [id(), text('label')]),
      t('post_tag_links', [int('post_id', { notNull: true }), int('tag_id', { notNull: true })], {
        primaryKey: [],
        uniqueIndexes: [['post_id', 'tag_id']],
        foreignKeys: [fk('post_id', 'posts'), fk('tag_id', 'tags')],
      }),
    ],
    expected: (() => {
      const base: Relations = {
        posts: { postTagLinks: hasMany('post_tag_links', 'post_id') },
        tags: { postTagLinks: hasMany('post_tag_links', 'tag_id') },
        post_tag_links: { post: belongsTo('posts', 'post_id'), tag: belongsTo('tags', 'tag_id') },
      };
      return {
        postgres: {
          ...base,
          posts: { ...base.posts, tags: manyToMany('tags', 'post_tag_links', 'post_id', 'tag_id') },
          tags: { ...base.tags, posts: manyToMany('posts', 'post_tag_links', 'tag_id', 'post_id') },
        },
        sqlite: base,
        mysql: base,
        'code-first': base,
      };
    })(),
  },
  {
    // PostgreSQL and code-first carry onDelete / onUpdate; the other engines'
    // introspectors do not read referential actions.
    name: 'referential actions',
    tables: [
      USERS,
      t('posts', [id(), int('user_id', { notNull: true })], {
        foreignKeys: [fk('user_id', 'users', 'id', { onDelete: 'cascade' })],
      }),
    ],
    expected: (() => {
      const plain: Relations = {
        users: { posts: hasMany('posts', 'user_id') },
        posts: { user: belongsTo('users', 'user_id') },
      };
      const withActions: Relations = {
        users: { posts: { ...hasMany('posts', 'user_id'), onDelete: 'cascade' } },
        posts: { user: { ...belongsTo('users', 'user_id'), onDelete: 'cascade' } },
      };
      return { postgres: withActions, 'code-first': withActions, sqlite: plain, mysql: plain };
    })(),
  },
  {
    // Two composite foreign keys to one target are named from their constraint
    // names, and each engine names an unnamed constraint differently:
    // PostgreSQL `returns_tenant_id_order_id_fkey`, MySQL `returns_ibfk_1`,
    // SQLite keeps no name (the introspector uses `fk_<table>_<id>`).
    name: 'two composite foreign keys to one target, unnamed',
    tables: [
      t('orders', [int('tenant_id', { notNull: true }), int('id', { notNull: true })], {
        primaryKey: ['tenant_id', 'id'],
      }),
      t(
        'returns',
        [id(), int('tenant_id', { notNull: true }), int('order_id', { notNull: true }), int('replacement_id')],
        {
          foreignKeys: [
            fk(['tenant_id', 'order_id'], 'orders', ['tenant_id', 'id']),
            fk(['tenant_id', 'replacement_id'], 'orders', ['tenant_id', 'id']),
          ],
        },
      ),
    ],
    expected: (() => {
      const original = ['tenant_id', 'order_id'];
      const replacement = ['tenant_id', 'replacement_id'];
      const ref = ['tenant_id', 'id'];
      return {
        postgres: {
          orders: {
            returnsByReturnsTenantIdOrderId: hasMany('returns', original, ref),
            returnsByReturnsTenantIdReplacementId: hasMany('returns', replacement, ref),
          },
          returns: {
            returnsTenantIdOrderId: belongsTo('orders', original, ref),
            returnsTenantIdReplacementId: belongsTo('orders', replacement, ref),
          },
        },
        // PRAGMA foreign_key_list numbers the LAST declared foreign key 0.
        sqlite: {
          orders: {
            returnsByReturns_0: hasMany('returns', replacement, ref),
            returnsByReturns_1: hasMany('returns', original, ref),
          },
          returns: {
            returns_0: belongsTo('orders', replacement, ref),
            returns_1: belongsTo('orders', original, ref),
          },
        },
        mysql: {
          orders: {
            returnsByReturnsIbfk_1: hasMany('returns', original, ref),
            returnsByReturnsIbfk_2: hasMany('returns', replacement, ref),
          },
          returns: {
            returnsIbfk_1: belongsTo('orders', original, ref),
            returnsIbfk_2: belongsTo('orders', replacement, ref),
          },
        },
      };
    })(),
  },
  {
    // Two relations that want one name: the first foreign key in catalog order
    // keeps it, and the catalogs order foreign keys differently. PostgreSQL
    // walks (source table, constraint name); SQLite walks table names, then
    // PRAGMA foreign_key_list ids, which number the LAST declared key 0. Here
    // `notes.user` is wanted by a key to `user` (declared first, its
    // constraint name sorts first) and a key to `users`.
    name: 'a contested name within one table (SQLite catalog order)',
    tables: [
      t('user', [id(), text('handle')]),
      USERS,
      t('notes', [id(), int('owner'), int('user_id')], {
        foreignKeys: [
          fk('owner', 'user', 'id', { name: 'notes_a_owner' }),
          fk('user_id', 'users', 'id', { name: 'notes_z_user' }),
        ],
      }),
    ],
    expected: (() => {
      const userFirst: Relations = {
        user: { notes: hasMany('notes', 'owner') },
        users: { notes: hasMany('notes', 'user_id') },
        notes: { user: belongsTo('user', 'owner'), userRel: belongsTo('users', 'user_id') },
      };
      const usersFirst: Relations = {
        user: { notes: hasMany('notes', 'owner') },
        users: { notes: hasMany('notes', 'user_id') },
        notes: { user: belongsTo('users', 'user_id'), userRel: belongsTo('user', 'owner') },
      };
      return { postgres: userFirst, mysql: userFirst, 'code-first': userFirst, sqlite: usersFirst };
    })(),
  },
  {
    // The same race across two tables. MySQL walks constraint names alone,
    // whichever table they belong to, so `a_users_post` (on `users`) runs
    // before `z_post_owner` (on `post`), which PostgreSQL and SQLite reach
    // first because `post` sorts before `users`. Both want `users.post`.
    name: 'a contested name across tables (MySQL catalog order)',
    tables: [
      t('posts', [id(), text('title')]),
      t('users', [id(), int('post_id')], { foreignKeys: [fk('post_id', 'posts', 'id', { name: 'a_users_post' })] }),
      t('post', [id(), int('owner_id')], { foreignKeys: [fk('owner_id', 'users', 'id', { name: 'z_post_owner' })] }),
    ],
    expected: (() => {
      const postTableFirst: Relations = {
        posts: { users: hasMany('users', 'post_id') },
        users: { postRel: belongsTo('posts', 'post_id'), post: hasMany('post', 'owner_id') },
        post: { user: belongsTo('users', 'owner_id') },
      };
      const usersTableFirst: Relations = {
        posts: { users: hasMany('users', 'post_id') },
        users: { post: belongsTo('posts', 'post_id'), postRel: hasMany('post', 'owner_id') },
        post: { user: belongsTo('users', 'owner_id') },
      };
      return {
        postgres: postTableFirst,
        sqlite: postTableFirst,
        mysql: usersTableFirst,
        'code-first': usersTableFirst,
      };
    })(),
  },
];

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function columnType(col: ColSpec, engine: Engine): string {
  if (col.type === 'int') return engine === 'mysql' ? 'INT' : 'INTEGER';
  return engine === 'sqlite' ? 'TEXT' : 'VARCHAR(64)';
}

const quote = (name: string, engine: Engine) => (engine === 'mysql' ? `\`${name}\`` : `"${name}"`);

/** CREATE TABLE / CREATE UNIQUE INDEX statements, parents first in spec order. */
function renderDdl(tables: TableSpec[], engine: Engine): string[] {
  const q = (n: string) => quote(n, engine);
  const list = (cols: string[]) => cols.map(q).join(', ');
  const out: string[] = [];
  for (const table of tables) {
    const parts = table.columns.map(
      (c) => `${q(c.name)} ${columnType(c, engine)}${c.notNull ? ' NOT NULL' : ''}${c.unique ? ' UNIQUE' : ''}`,
    );
    if (table.primaryKey?.length) parts.push(`PRIMARY KEY (${list(table.primaryKey)})`);
    for (const u of table.unique ?? []) parts.push(`UNIQUE (${list(u)})`);
    for (const f of table.foreignKeys ?? []) {
      parts.push(
        `${f.name ? `CONSTRAINT ${q(f.name)} ` : ''}FOREIGN KEY (${list(f.columns)}) REFERENCES ${q(f.table)} (${list(f.references)})${f.onDelete ? ' ON DELETE CASCADE' : ''}`,
      );
    }
    out.push(`CREATE TABLE ${q(table.name)} (${parts.join(', ')})`);
    for (const [i, cols] of (table.uniqueIndexes ?? []).entries()) {
      out.push(`CREATE UNIQUE INDEX ${q(`ux_${table.name}_${i}`)} ON ${q(table.name)} (${list(cols)})`);
    }
  }
  return out;
}

/** The `defineSchema` twin: accessor and field keys are camelCase, DDL names snake_case. */
function codeFirstMetadata(tables: TableSpec[]): SchemaMetadata {
  const def: Record<string, Record<string, unknown>> = {};
  for (const table of tables) {
    const columns: Record<string, unknown> = {};
    const composite = (table.primaryKey?.length ?? 0) > 1;
    for (const col of table.columns) {
      const ref = table.foreignKeys?.find((f) => f.columns.length === 1 && f.columns[0] === col.name);
      const target = ref ? `${ref.table}.${ref.references[0]}` : undefined;
      columns[snakeToCamel(col.name)] = {
        type: col.type === 'int' ? 'integer' : 'text',
        ...(!composite && table.primaryKey?.[0] === col.name ? { primaryKey: true } : {}),
        ...(col.notNull ? { notNull: true } : {}),
        ...(col.unique ? { unique: true } : {}),
        ...(target ? { references: ref?.onDelete ? { target, onDelete: ref.onDelete } : target } : {}),
      };
    }
    if (composite) columns.primaryKey = table.primaryKey!.map(snakeToCamel);
    // A table-level UNIQUE and a UNIQUE index are both a declared unique index here.
    const uniques = [...(table.unique ?? []), ...(table.uniqueIndexes ?? [])];
    if (uniques.length > 0)
      columns.indexes = uniques.map((cols) => ({ columns: cols.map(snakeToCamel), unique: true }));
    def[snakeToCamel(table.name)] = columns;
  }
  return schemaDefToMetadata(defineSchema(def as never));
}

/** Reduce introspected relations to the fields the parity contract covers. */
function normalize(schema: SchemaMetadata): Relations {
  const out: Relations = {};
  for (const [tableName, table] of Object.entries(schema.tables)) {
    const rels: Record<string, NormRelation> = {};
    for (const [key, rel] of Object.entries(table.relations)) {
      assert.equal(rel.name, key, `${tableName}.${key}: RelationDef.name must equal its key`);
      assert.equal(rel.from, tableName, `${tableName}.${key}: RelationDef.from must be its own table`);
      rels[key] = {
        type: rel.type,
        to: rel.to,
        foreignKey: rel.foreignKey,
        referenceKey: rel.referenceKey,
        ...(rel.through
          ? {
              through: { table: rel.through.table, sourceKey: rel.through.sourceKey, targetKey: rel.through.targetKey },
            }
          : {}),
        ...(rel.onDelete ? { onDelete: rel.onDelete } : {}),
        ...(rel.onUpdate ? { onUpdate: rel.onUpdate } : {}),
      };
    }
    if (Object.keys(rels).length > 0) out[tableName] = rels;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Engine harnesses
// ---------------------------------------------------------------------------

interface Harness {
  name: HarnessName;
  runners: GatedRunners;
  setup?(): Promise<void>;
  teardown?(): Promise<void>;
  /** Create the tables in a fresh namespace and introspect it. */
  introspect(tables: TableSpec[], slot: string): Promise<SchemaMetadata>;
}

const silent = { logger: {} };

// node:sqlite is a builtin only on Node >= 22.5: probe it without a static import.
const DatabaseSync: (new (path: string) => DatabaseSyncType) | undefined = (() => {
  try {
    return createRequire(process.cwd())('node:sqlite').DatabaseSync;
  } catch {
    return undefined;
  }
})();

// The optional binding, installed by CI outside the checkout (see
// cross-engine-correctness.test.ts for the same probe).
const BetterSqlite3: (new (path: string) => BetterSqlite3Database) | undefined = (() => {
  try {
    return createRequire(import.meta.url)(process.env.TURBINE_SQLITE_BINDING_PEER ?? 'better-sqlite3');
  } catch (error) {
    if (process.env.TURBINE_REQUIRE_SQLITE_BINDING === '1') throw error;
    return undefined;
  }
})();

const DATABASE_URL = process.env.DATABASE_URL ?? '';
const MYSQL_URL = process.env.MYSQL_URL ?? process.env.MYSQL_TEST_URL ?? '';
const DB_NAME = 'turbine_unique_fk_parity';

const HARNESSES: Harness[] = [
  {
    name: 'code-first',
    runners: { it, before, after },
    async introspect(tables) {
      return codeFirstMetadata(tables);
    },
  },
  {
    name: 'node:sqlite',
    runners: skipGate(!DatabaseSync, 'turbine-orm/sqlite requires node:sqlite (Node >= 22.5)'),
    async introspect(tables) {
      const { introspectSqliteDatabase } = await import('../sqlite.js');
      const db = new DatabaseSync!(':memory:');
      try {
        for (const stmt of renderDdl(tables, 'sqlite')) db.exec(stmt);
        return introspectSqliteDatabase(db, silent);
      } finally {
        db.close();
      }
    },
  },
  {
    name: 'better-sqlite3',
    runners: skipGate(!BetterSqlite3, 'requires the optional better-sqlite3 peer (set TURBINE_SQLITE_BINDING_PEER)'),
    async introspect(tables) {
      const { introspectBetterSqlite3Database } = await import('../better-sqlite3.js');
      const db = new BetterSqlite3!(':memory:');
      try {
        for (const stmt of renderDdl(tables, 'sqlite')) db.exec(stmt);
        return introspectBetterSqlite3Database(db, silent);
      } finally {
        db.close();
      }
    },
  },
  (() => {
    // biome-ignore lint/suspicious/noExplicitAny: pg pool, loaded only when gated on.
    let pool: any;
    let url = '';
    return {
      name: 'postgres',
      runners: skipGate(!DATABASE_URL, 'requires DATABASE_URL pointing at a PostgreSQL server'),
      async setup() {
        const { default: pg } = await import('pg');
        const admin = new pg.Client({ connectionString: DATABASE_URL });
        await admin.connect();
        try {
          const found = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [DB_NAME]);
          if (found.rowCount === 0) await admin.query(`CREATE DATABASE ${DB_NAME}`);
        } finally {
          await admin.end();
        }
        const u = new URL(DATABASE_URL);
        u.pathname = `/${DB_NAME}`;
        url = u.toString();
        pool = new pg.Pool({ connectionString: url, max: 1 });
      },
      async teardown() {
        await pool?.end();
      },
      async introspect(tables, slot) {
        const { introspect } = await import('../introspect.js');
        const schema = `ufk_${slot}`;
        await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
        await pool.query(`CREATE SCHEMA ${schema}`);
        const client = await pool.connect();
        try {
          // Transaction-scoped search_path, so no session state outlives the case.
          await client.query('BEGIN');
          await client.query(`SELECT set_config('search_path', $1, true)`, [schema]);
          for (const stmt of renderDdl(tables, 'postgres')) await client.query(stmt);
          await client.query('COMMIT');
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        } finally {
          client.release();
        }
        try {
          return await introspect({ connectionString: url, schema, ...silent });
        } finally {
          await pool.query(`DROP SCHEMA ${schema} CASCADE`);
        }
      },
    } satisfies Harness;
  })(),
  (() => {
    // biome-ignore lint/suspicious/noExplicitAny: mysql2 module, loaded only when gated on.
    let mysql: any;
    let base: Record<string, unknown> = {};
    return {
      name: 'mysql',
      runners: skipGate(!MYSQL_URL, 'requires MYSQL_URL / MYSQL_TEST_URL pointing at a MySQL 8 server'),
      async setup() {
        mysql = await import('mysql2/promise');
        const u = new URL(MYSQL_URL);
        base = {
          host: u.hostname,
          port: u.port ? Number(u.port) : 3306,
          user: decodeURIComponent(u.username),
          password: decodeURIComponent(u.password),
        };
      },
      async introspect(tables, slot) {
        const { MysqlPool, introspectMysqlWith } = await import('../mysql.js');
        // One database per case: MySQL's database is the namespace introspection reads.
        const database = `${DB_NAME}_${slot}`;
        const admin = await mysql.createConnection(base);
        try {
          await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
          await admin.query(`CREATE DATABASE \`${database}\``);
        } finally {
          await admin.end();
        }
        const raw = mysql.createPool({ ...base, database, namedPlaceholders: true, connectionLimit: 1 });
        try {
          for (const stmt of renderDdl(tables, 'mysql')) await raw.query(stmt);
          const pool = new MysqlPool(raw);
          return await introspectMysqlWith(
            async (sql, params) => (await pool.query(sql, params)).rows,
            database,
            silent,
          );
        } finally {
          await raw.query(`DROP DATABASE \`${database}\``);
          await raw.end();
        }
      },
    } satisfies Harness;
  })(),
];

// ---------------------------------------------------------------------------
// The contract
// ---------------------------------------------------------------------------

for (const h of HARNESSES) {
  // From skipGate: an engine that cannot be reached registers skipped tests and
  // no-op hooks, and one a CI job requires fails the file instead.
  const { it, before, after } = h.runners;
  describe(`unique foreign key parity: ${h.name}`, () => {
    before(async () => {
      await h.setup?.();
    });
    after(async () => {
      await h.teardown?.();
    });
    for (const [index, c] of CASES.entries()) {
      const skip = h.name === 'code-first' && c.noCodeFirst ? c.noCodeFirst : false;
      it(c.name, { skip }, async () => {
        const actual = normalize(await h.introspect(c.tables, `p${index}`));
        assert.deepEqual(actual, c.expected, `${h.name} derives different relations for "${c.name}"`);
      });
    }
    for (const [index, k] of KNOWN_DIFFERENCES.entries()) {
      const key = h.name === 'node:sqlite' || h.name === 'better-sqlite3' ? 'sqlite' : h.name;
      const expected = k.expected[key];
      // A shape the code-first path cannot express has no code-first value.
      it(`known difference: ${k.name}`, { skip: expected ? false : 'not expressible on this path' }, async () => {
        const actual = normalize(await h.introspect(k.tables, `k${index}`));
        assert.deepEqual(actual, expected, `${h.name} changed a known cross-engine difference: "${k.name}"`);
      });
    }
  });
}
