/**
 * Relation derivation parity: the same schema must give the same relations on
 * every engine Turbine introspects, and on the code-first path.
 *
 * Relation names are DERIVED (a database does not name a relationship), so each
 * introspector composes them from its own catalog facts. The engines read
 * different catalogs (pg_catalog, information_schema, PRAGMA), and when each
 * one carried its own copy of a rule they drifted: PostgreSQL named a unique
 * foreign key's reverse relation `profile` (to-one) while SQLite and MySQL
 * named the same relation `profiles`, so `with: { profile: true }` worked on one
 * engine and was E005 on the others, for the same schema.
 *
 * THE MECHANISM. Each case below is ONE portable spec, rendered to PostgreSQL,
 * MySQL and SQLite DDL and to a `defineSchema` twin, so the engines cannot be
 * handed subtly different schemas. Every engine is held to the same golden
 * relation set per case, and so is PostgreSQL itself: PostgreSQL is the
 * reference, and the integration job is what proves the golden values are what
 * it really derives. A difference on any engine fails that engine's case and
 * names it.
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
import { defaultForeignKeyConstraintName } from '../catalog-metadata.js';
import { type RelationDef, type SchemaMetadata, snakeToCamel } from '../schema.js';
import { defineSchema } from '../schema-builder.js';
import { schemaDefToMetadata } from '../schema-metadata.js';
import { declaredForeignKeyName, declaredForeignKeyNames } from '../sqlite-constraint-names.js';
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

interface Case {
  name: string;
  tables: TableSpec[];
  /** Why the case has no `defineSchema` twin, when it has none. */
  noCodeFirst?: string;
  /** What PostgreSQL derives, the reference every engine is held to. */
  expected: Relations;
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
// The cases
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
    name: 'non-unique foreign key',
    tables: [
      USERS,
      t('posts', [id(), int('user_id', { notNull: true }), text('title')], { foreignKeys: [fk('user_id', 'users')] }),
    ],
    expected: {
      users: { posts: hasMany('posts', 'user_id') },
      posts: { user: belongsTo('users', 'user_id') },
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
    name: 'foreign key that is the primary key (shared-key one-to-one)',
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
        accountSetting: hasOne('account_settings', 'account_code', 'code'),
        invoices: hasMany('invoices', 'account_code', 'code'),
      },
      invoices: { account: belongsTo('accounts', 'account_code', 'code') },
      account_settings: { account: belongsTo('accounts', 'account_code', 'code') },
    },
  },
  {
    name: 'two foreign keys from one table to the same target',
    tables: [
      USERS,
      t('messages', [id(), int('sender_id', { notNull: true }), int('recipient_id', { notNull: true }), text('body')], {
        foreignKeys: [fk('sender_id', 'users'), fk('recipient_id', 'users')],
      }),
    ],
    expected: {
      users: {
        messagesBySender: hasMany('messages', 'sender_id'),
        messagesByRecipient: hasMany('messages', 'recipient_id'),
      },
      messages: { sender: belongsTo('users', 'sender_id'), recipient: belongsTo('users', 'recipient_id') },
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
    name: 'composite foreign keys',
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
  {
    // The one shape whose relation names read the CONSTRAINT name. Unnamed, each
    // engine's catalog calls it something else (PostgreSQL
    // `returns_tenant_id_order_id_fkey`, MySQL `returns_ibfk_1`, SQLite nothing).
    name: 'two composite foreign keys to the same target, unnamed',
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
    noCodeFirst: 'defineSchema `references` is single-column',
    expected: {
      orders: {
        returnsByReturnsTenantIdOrderId: hasMany('returns', ['tenant_id', 'order_id'], ['tenant_id', 'id']),
        returnsByReturnsTenantIdReplacementId: hasMany('returns', ['tenant_id', 'replacement_id'], ['tenant_id', 'id']),
      },
      returns: {
        returnsTenantIdOrderId: belongsTo('orders', ['tenant_id', 'order_id'], ['tenant_id', 'id']),
        returnsTenantIdReplacementId: belongsTo('orders', ['tenant_id', 'replacement_id'], ['tenant_id', 'id']),
      },
    },
  },
  {
    name: 'two composite foreign keys to the same target, named',
    tables: [
      t('orders', [int('tenant_id', { notNull: true }), int('id', { notNull: true })], {
        primaryKey: ['tenant_id', 'id'],
      }),
      t(
        'returns',
        [id(), int('tenant_id', { notNull: true }), int('order_id', { notNull: true }), int('replacement_id')],
        {
          foreignKeys: [
            fk(['tenant_id', 'order_id'], 'orders', ['tenant_id', 'id'], { name: 'fk_original_order' }),
            fk(['tenant_id', 'replacement_id'], 'orders', ['tenant_id', 'id'], { name: 'fk_replacement_order' }),
          ],
        },
      ),
    ],
    noCodeFirst: 'defineSchema `references` is single-column',
    expected: {
      orders: {
        returnsByOriginalOrder: hasMany('returns', ['tenant_id', 'order_id'], ['tenant_id', 'id']),
        returnsByReplacementOrder: hasMany('returns', ['tenant_id', 'replacement_id'], ['tenant_id', 'id']),
      },
      returns: {
        originalOrder: belongsTo('orders', ['tenant_id', 'order_id'], ['tenant_id', 'id']),
        replacementOrder: belongsTo('orders', ['tenant_id', 'replacement_id'], ['tenant_id', 'id']),
      },
    },
  },
  {
    name: 'junction table, pure',
    tables: [
      t('posts', [id(), text('title')]),
      t('tags', [id(), text('label')]),
      t('post_tags', [int('post_id', { notNull: true }), int('tag_id', { notNull: true })], {
        primaryKey: ['post_id', 'tag_id'],
        foreignKeys: [fk('post_id', 'posts'), fk('tag_id', 'tags')],
      }),
    ],
    expected: {
      posts: { postTags: hasMany('post_tags', 'post_id'), tags: manyToMany('tags', 'post_tags', 'post_id', 'tag_id') },
      tags: { postTags: hasMany('post_tags', 'tag_id'), posts: manyToMany('posts', 'post_tags', 'tag_id', 'post_id') },
      post_tags: { post: belongsTo('posts', 'post_id'), tag: belongsTo('tags', 'tag_id') },
    },
  },
  {
    name: 'junction table with an extra column',
    tables: [
      t('posts', [id(), text('title')]),
      t('tags', [id(), text('label')]),
      t('post_tags', [int('post_id', { notNull: true }), int('tag_id', { notNull: true }), text('added_by')], {
        primaryKey: ['post_id', 'tag_id'],
        foreignKeys: [fk('post_id', 'posts'), fk('tag_id', 'tags')],
      }),
    ],
    expected: {
      posts: { postTags: hasMany('post_tags', 'post_id') },
      tags: { postTags: hasMany('post_tags', 'tag_id') },
      post_tags: { post: belongsTo('posts', 'post_id'), tag: belongsTo('tags', 'tag_id') },
    },
  },
  {
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
    expected: {
      posts: {
        postTagLinks: hasMany('post_tag_links', 'post_id'),
        tags: manyToMany('tags', 'post_tag_links', 'post_id', 'tag_id'),
      },
      tags: {
        postTagLinks: hasMany('post_tag_links', 'tag_id'),
        posts: manyToMany('posts', 'post_tag_links', 'tag_id', 'post_id'),
      },
      post_tag_links: { post: belongsTo('posts', 'post_id'), tag: belongsTo('tags', 'tag_id') },
    },
  },
  {
    name: 'relations competing for one name',
    tables: [
      t('users', [id(), text('name'), text('avatar')]),
      // `profile` (a table) and `profiles.user_id UNIQUE` both want `users.profile`.
      // Their constraint names sort the other way round from their tables, so a
      // catalog read in constraint order (MySQL's) would hand the name to the
      // wrong one if the derivation did not fix the order itself.
      t('profile', [id(), int('owner_id', { notNull: true })], {
        foreignKeys: [fk('owner_id', 'users', 'id', { name: 'z_profile_owner' })],
      }),
      t('profiles', [id(), int('user_id', { notNull: true, unique: true })], {
        foreignKeys: [fk('user_id', 'users', 'id', { name: 'a_profiles_user' })],
      }),
      // The to-one name `avatar` is taken by a column.
      t('avatars', [id(), int('user_id', { notNull: true, unique: true })], { foreignKeys: [fk('user_id', 'users')] }),
      // Two pure junctions between the same two tables, both wanting the same names.
      t('posts', [id(), int('author_id', { notNull: true })], { foreignKeys: [fk('author_id', 'users')] }),
      t('bookmarks', [int('user_id', { notNull: true }), int('post_id', { notNull: true })], {
        primaryKey: ['user_id', 'post_id'],
        foreignKeys: [fk('user_id', 'users'), fk('post_id', 'posts')],
      }),
      t('favorites', [int('user_id', { notNull: true }), int('post_id', { notNull: true })], {
        primaryKey: ['user_id', 'post_id'],
        foreignKeys: [fk('user_id', 'users'), fk('post_id', 'posts')],
      }),
    ],
    // The first foreign key in (source table, constraint) order keeps a contested
    // name: `profile` (the table) before `profiles`, so the to-one falls back to
    // its plural; `avatar` is a column, so the to-one is `avatars`; `bookmarks`
    // before `favorites`, and `users.posts` is the hasMany, so the junctions add
    // only `posts.users`.
    expected: {
      avatars: { user: belongsTo('users', 'user_id') },
      bookmarks: { post: belongsTo('posts', 'post_id'), user: belongsTo('users', 'user_id') },
      favorites: { post: belongsTo('posts', 'post_id'), user: belongsTo('users', 'user_id') },
      posts: {
        bookmarks: hasMany('bookmarks', 'post_id'),
        favorites: hasMany('favorites', 'post_id'),
        user: belongsTo('users', 'author_id'),
        users: manyToMany('users', 'bookmarks', 'post_id', 'user_id'),
      },
      profile: { user: belongsTo('users', 'owner_id') },
      profiles: { user: belongsTo('users', 'user_id') },
      users: {
        avatars: hasOne('avatars', 'user_id'),
        bookmarks: hasMany('bookmarks', 'user_id'),
        favorites: hasMany('favorites', 'user_id'),
        posts: hasMany('posts', 'author_id'),
        profile: hasMany('profile', 'owner_id'),
        profiles: hasOne('profiles', 'user_id'),
      },
    },
  },
  {
    // Two relations that want one name: the first foreign key in (source
    // table, constraint name) order keeps it, whatever order the catalog
    // returned them in (SQLite numbers the LAST declared key 0). Here
    // `notes.user` is wanted by a key to `user` (its constraint name sorts
    // first) and a key to `users`.
    name: 'a contested name within one table',
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
    expected: {
      user: { notes: hasMany('notes', 'owner') },
      users: { notes: hasMany('notes', 'user_id') },
      notes: { user: belongsTo('user', 'owner'), userRel: belongsTo('users', 'user_id') },
    },
  },
  {
    // The same race across two tables. MySQL's catalog orders by constraint
    // name alone, so `a_users_post` (on `users`) came before `z_post_owner`
    // (on `post`); the source table decides first. Both want `users.post`.
    name: 'a contested name across tables',
    tables: [
      t('posts', [id(), text('title')]),
      t('users', [id(), int('post_id')], { foreignKeys: [fk('post_id', 'posts', 'id', { name: 'a_users_post' })] }),
      t('post', [id(), int('owner_id')], { foreignKeys: [fk('owner_id', 'users', 'id', { name: 'z_post_owner' })] }),
    ],
    expected: {
      posts: { users: hasMany('users', 'post_id') },
      users: { postRel: belongsTo('posts', 'post_id'), post: hasMany('post', 'owner_id') },
      post: { user: belongsTo('users', 'owner_id') },
    },
  },
  {
    name: 'table names that do not singularize cleanly',
    tables: [
      t('people', [id(), text('name')]),
      t('news', [id(), int('person_id', { notNull: true, unique: true }), text('headline')], {
        foreignKeys: [fk('person_id', 'people')],
      }),
      t('statuses', [id(), int('person_id', { notNull: true }), text('body')], {
        foreignKeys: [fk('person_id', 'people')],
      }),
      t('analyses', [id(), int('person_id', { notNull: true, unique: true })], {
        foreignKeys: [fk('person_id', 'people')],
      }),
    ],
    // `singularize` strips a trailing s, es or ies: these are PostgreSQL's names.
    expected: {
      analyses: { people: belongsTo('people', 'person_id') },
      news: { people: belongsTo('people', 'person_id') },
      people: {
        analys: hasOne('analyses', 'person_id'),
        new: hasOne('news', 'person_id'),
        statuses: hasMany('statuses', 'person_id'),
      },
      statuses: { people: belongsTo('people', 'person_id') },
    },
  },
  {
    name: 'snake_case names',
    tables: [
      t('app_users', [id(), text('display_name')]),
      t('blog_posts', [id(), int('author_id', { notNull: true })], { foreignKeys: [fk('author_id', 'app_users')] }),
      t('user_settings', [id(), int('app_user_id', { notNull: true, unique: true }), text('theme_name')], {
        foreignKeys: [fk('app_user_id', 'app_users')],
      }),
    ],
    expected: {
      app_users: {
        blogPosts: hasMany('blog_posts', 'author_id'),
        userSetting: hasOne('user_settings', 'app_user_id'),
      },
      blog_posts: { appUser: belongsTo('app_users', 'author_id') },
      user_settings: { appUser: belongsTo('app_users', 'app_user_id') },
    },
  },
  {
    name: 'referential actions',
    tables: [
      USERS,
      t('posts', [id(), int('user_id', { notNull: true })], {
        foreignKeys: [fk('user_id', 'users', 'id', { onDelete: 'cascade' })],
      }),
    ],
    expected: {
      users: { posts: { ...hasMany('posts', 'user_id'), onDelete: 'cascade' } },
      posts: { user: { ...belongsTo('users', 'user_id'), onDelete: 'cascade' } },
    },
  },
];

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

type Engine = 'postgres' | 'mysql' | 'sqlite';

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
  name: string;
  runners: GatedRunners;
  setup?(): Promise<void>;
  teardown?(): Promise<void>;
  /** Create the case's tables in a fresh namespace and introspect it. */
  introspect(c: Case, index: number): Promise<SchemaMetadata>;
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
const DB_NAME = 'turbine_relation_parity';

const HARNESSES: Harness[] = [
  {
    name: 'code-first',
    runners: { it, before, after },
    async introspect(c) {
      return codeFirstMetadata(c.tables);
    },
  },
  {
    name: 'node:sqlite',
    runners: skipGate(!DatabaseSync, 'turbine-orm/sqlite requires node:sqlite (Node >= 22.5)'),
    async introspect(c) {
      const { introspectSqliteDatabase } = await import('../sqlite.js');
      const db = new DatabaseSync!(':memory:');
      try {
        for (const stmt of renderDdl(c.tables, 'sqlite')) db.exec(stmt);
        return introspectSqliteDatabase(db, silent);
      } finally {
        db.close();
      }
    },
  },
  {
    name: 'better-sqlite3',
    runners: skipGate(!BetterSqlite3, 'requires the optional better-sqlite3 peer (set TURBINE_SQLITE_BINDING_PEER)'),
    async introspect(c) {
      const { introspectBetterSqlite3Database } = await import('../better-sqlite3.js');
      const db = new BetterSqlite3!(':memory:');
      try {
        for (const stmt of renderDdl(c.tables, 'sqlite')) db.exec(stmt);
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
      async introspect(c, index) {
        const { introspect } = await import('../introspect.js');
        const schema = `rp_${index}`;
        await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
        await pool.query(`CREATE SCHEMA ${schema}`);
        const client = await pool.connect();
        try {
          // Transaction-scoped search_path, so no session state outlives the case.
          await client.query('BEGIN');
          await client.query(`SELECT set_config('search_path', $1, true)`, [schema]);
          for (const stmt of renderDdl(c.tables, 'postgres')) await client.query(stmt);
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
    };
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
      async introspect(c, index) {
        const { MysqlPool, introspectMysqlWith } = await import('../mysql.js');
        // One database per case: MySQL's database is the namespace introspection reads.
        const database = `${DB_NAME}_${index}`;
        const admin = await mysql.createConnection(base);
        try {
          await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
          await admin.query(`CREATE DATABASE \`${database}\``);
        } finally {
          await admin.end();
        }
        const raw = mysql.createPool({ ...base, database, namedPlaceholders: true, connectionLimit: 1 });
        try {
          for (const stmt of renderDdl(c.tables, 'mysql')) await raw.query(stmt);
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
    };
  })(),
];

// ---------------------------------------------------------------------------
// The parity contract
// ---------------------------------------------------------------------------

for (const h of HARNESSES) {
  // From skipGate (code-first always runs): an engine that cannot be reached
  // registers skipped tests and no-op hooks, and one a CI job requires fails the
  // file instead.
  const { it, before, after } = h.runners;
  describe(`relation derivation parity: ${h.name}`, () => {
    before(async () => {
      await h.setup?.();
    });
    after(async () => {
      await h.teardown?.();
    });
    for (const [index, c] of CASES.entries()) {
      const skip = h.name === 'code-first' && c.noCodeFirst ? c.noCodeFirst : false;
      it(c.name, { skip }, async () => {
        const actual = normalize(await h.introspect(c, index));
        if (process.env.RELATION_PARITY_DUMP) console.log(JSON.stringify({ engine: h.name, case: c.name, actual }));
        assert.deepEqual(actual, c.expected, `${h.name} derives different relations for "${c.name}"`);
      });
    }
  });
}

// ---------------------------------------------------------------------------
// Constraint names. A composite foreign key that shares its target is named
// from its constraint, and the catalogs disagree about unnamed constraints and
// (SQLite) keep no names at all, so both halves are pinned here.
// ---------------------------------------------------------------------------

describe('relation derivation parity: constraint names', () => {
  it('an unnamed foreign key takes the name PostgreSQL gives it, truncation and collisions included', () => {
    // Each expected value was read from pg_constraint on PostgreSQL 18.
    assert.equal(
      defaultForeignKeyConstraintName('order_lines', ['tenant_id', 'order_id']),
      'order_lines_tenant_id_order_id_fkey',
    );
    assert.equal(
      defaultForeignKeyConstraintName('a_child_table_whose_name_is_also_quite_long', [
        'tenant_identifier',
        'parent_identifier_column',
      ]),
      'a_child_table_whose_name_is_a_tenant_identifier_parent_ide_fkey',
    );
    assert.equal(
      defaultForeignKeyConstraintName('a_child_table_whose_name_is_also_quite_long', [
        'tenant_identifier',
        'other_parent',
      ]),
      'a_child_table_whose_name_is_a_tenant_identifier_other_pare_fkey',
    );
    assert.equal(
      defaultForeignKeyConstraintName('Ünïcode_tåble_with_a_long_nâme_éééééééééééééé', [
        'çolumn_with_accénts_éééééééééééé',
      ]),
      'Ünïcode_tåble_with_a_long__çolumn_with_accénts_ééé_fkey',
    );
    const taken = new Set<string>();
    assert.equal(defaultForeignKeyConstraintName('dup', ['a'], taken), 'dup_a_fkey');
    assert.equal(defaultForeignKeyConstraintName('dup', ['a'], taken), 'dup_a_fkey1');
  });

  it('reads SQLite constraint names from the CREATE TABLE text, table- and column-level', () => {
    const ddl = `CREATE TABLE "returns" (
      id INTEGER PRIMARY KEY, -- CONSTRAINT not_this REFERENCES nothing
      note TEXT DEFAULT 'CONSTRAINT x REFERENCES y' CHECK (length(note) > 0),
      code VARCHAR(20) CONSTRAINT Fk_Code REFERENCES "Codes" (code),
      owner_id INTEGER REFERENCES users (id),
      tenant_id INTEGER, order_id INTEGER, replacement_id INTEGER,
      /* a comment, CONSTRAINT nope FOREIGN KEY (x) REFERENCES y */
      CONSTRAINT fk_original_order FOREIGN KEY (tenant_id, order_id) REFERENCES orders (tenant_id, id) ON DELETE CASCADE,
      CONSTRAINT "Fk Replacement" FOREIGN KEY ([tenant_id], \`replacement_id\`) REFERENCES orders,
      FOREIGN KEY (owner_id) REFERENCES people (id)
    )`;
    const declared = declaredForeignKeyNames(ddl);
    assert.deepEqual(declared, [
      // A bare word folds to lower case, as PostgreSQL stores it; a quoted name keeps its case.
      { name: 'fk_code', columns: ['code'], table: 'Codes' },
      { name: 'fk_original_order', columns: ['tenant_id', 'order_id'], table: 'orders' },
      { name: 'Fk Replacement', columns: ['tenant_id', 'replacement_id'], table: 'orders' },
    ]);
    assert.equal(declaredForeignKeyName(declared, ['TENANT_ID', 'order_id'], 'ORDERS'), 'fk_original_order');
    assert.equal(declaredForeignKeyName(declared, ['owner_id'], 'users'), undefined);
    assert.equal(declaredForeignKeyName(declared, ['tenant_id'], 'orders'), undefined);
    // Two declarations over the same columns and target identify neither.
    const twice = declaredForeignKeyNames(
      'CREATE TABLE t (a INT, CONSTRAINT x FOREIGN KEY (a) REFERENCES p, CONSTRAINT y FOREIGN KEY (a) REFERENCES p)',
    );
    assert.equal(declaredForeignKeyName(twice, ['a'], 'p'), undefined);
    assert.deepEqual(declaredForeignKeyNames('CREATE TABLE t AS SELECT 1'), []);
    assert.deepEqual(declaredForeignKeyNames(''), []);
  });
});

describe('defineSchema relation order', () => {
  it("lists each table's relations in declaration order, not the derivation's sorted order", () => {
    // Sorted by source table, `comments` comes before `posts`; declared, `posts`
    // comes first. The names are the same either way, and generated files are
    // written in this order, so an unchanged schema keeps generating the same files.
    const meta = schemaDefToMetadata(
      defineSchema({
        users: { id: { type: 'serial', primaryKey: true } },
        posts: { id: { type: 'serial', primaryKey: true }, authorId: { type: 'integer', references: 'users.id' } },
        comments: {
          id: { type: 'serial', primaryKey: true },
          postId: { type: 'integer', references: 'posts.id' },
          authorId: { type: 'integer', references: 'users.id' },
        },
      }),
    );
    assert.deepEqual(Object.keys(meta.tables.users!.relations), ['posts', 'comments']);
    assert.deepEqual(Object.keys(meta.tables.posts!.relations), ['user', 'comments']);
    assert.deepEqual(Object.keys(meta.tables.comments!.relations), ['post', 'user']);
  });
});
