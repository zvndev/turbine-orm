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
import { defaultForeignKeyConstraintName, foreignKeyConstraintNames, postgresIdentifier } from '../catalog-metadata.js';
import { type RelationDef, type SchemaMetadata, snakeToCamel } from '../schema.js';
import { defineSchema } from '../schema-builder.js';
import { schemaDefToMetadata } from '../schema-metadata.js';
import { declaredForeignKeys, nameSqliteForeignKeys } from '../sqlite-constraint-names.js';
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
  /** Named CHECK and UNIQUE constraints. */
  constraints?: ({ name: string; check: string } | { name: string; unique: string[] })[];
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
  /**
   * Engines that derive something else, for a reason docs/relation-names.md
   * states, and what they derive and read instead.
   */
  differsOn?: { engines: string[]; expected: Relations; rows?: unknown[] };
  /**
   * Rows to insert (portable INSERT statements) and a read to run through each
   * engine's client: a relation name has to select the same rows everywhere,
   * not only exist.
   */
  query?: { insert: string[]; table: string; args: Record<string, unknown>; rows: unknown[] };
}

const upperFirst = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
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
const ORDERS_AB = t('orders', [int('a', { notNull: true }), int('b', { notNull: true })], { primaryKey: ['a', 'b'] });
const PARENTS_AB_CD = t('parents', [int('a', { notNull: true }), int('b', { notNull: true }), int('c'), int('d')], {
  primaryKey: ['a', 'b'],
  unique: [['c', 'd']],
});
const LINKS_XY = (...foreignKeys: FkSpec[]) => t('links', [int('x'), int('y')], { primaryKey: [], foreignKeys });
const XY = ['x', 'y'];
const AB = ['a', 'b'];
const CD = ['c', 'd'];
const LONG_A = `${'shipment_reference_'.repeat(3)}one`;
const LONG_B = `${'shipment_reference_'.repeat(3)}two`;
/** As much of `links_x_<column>` as PostgreSQL keeps when it adds `_fkey`. */
const LONG_BASE = 'linksXShipmentReferenceShipmentReferenceShipmentRef';
const TAG_COLUMNS = [...'abcdefghi'].map((c) => `tag_${c}_id`);
const cascade = (relation: NormRelation): NormRelation => ({ ...relation, onDelete: 'cascade' });
/** A table with no foreign key whose CHECK is named like `links`'s first default. */
const AAA_CHECK = t('aaa', [int('x')], { primaryKey: [], constraints: [{ name: 'links_x_y_fkey', check: 'x > 0' }] });
/** `links`'s two keys over `(x, y)` with nothing holding their defaults. */
const UNMOVED: Relations = {
  links: { linksXY: belongsTo('parents', XY, AB), linksXYFkey1: belongsTo('parents', XY, CD) },
  parents: { linksByLinksXY: hasMany('links', XY, AB), linksByLinksXYFkey1: hasMany('links', XY, CD) },
};
const LINKS_QUERY = {
  insert: ['INSERT INTO parents VALUES (1, 2, 3, 4), (5, 6, 1, 2)', 'INSERT INTO links VALUES (1, 2)'],
  table: 'links',
  args: { with: { linksXYFkey1: true } },
};
/** 64 bytes, and 65 bytes of two-byte characters: PostgreSQL keeps 63 bytes, never part of a character. */
const LONG_ASCII_NAME = `fk_${'a'.repeat(61)}`;
const LONG_UTF8_NAME = `fk_${'é'.repeat(31)}`;

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
  // The cases below read a composite foreign key's CONSTRAINT name off
  // PostgreSQL. SQLite keeps names only in its CREATE TABLE text, MySQL and SQL
  // Server generate their own, so each engine has to arrive at the name
  // PostgreSQL gives the same declarations.
  {
    name: 'two named composite foreign keys over the same columns, to different keys of one target',
    tables: [
      PARENTS_AB_CD,
      LINKS_XY(fk(XY, 'parents', AB, { name: 'fk_one' }), fk(XY, 'parents', CD, { name: 'fk_two' })),
    ],
    noCodeFirst: 'defineSchema `references` is single-column',
    expected: {
      links: { one: belongsTo('parents', XY, AB), two: belongsTo('parents', XY, CD) },
      parents: { linksByOne: hasMany('links', XY, AB), linksByTwo: hasMany('links', XY, CD) },
    },
  },
  {
    name: 'two named composite foreign keys that are otherwise identical',
    tables: [
      PARENTS_AB_CD,
      LINKS_XY(
        fk(XY, 'parents', AB, { name: 'fk_kept', onDelete: 'cascade' }),
        fk(XY, 'parents', AB, { name: 'fk_copy' }),
      ),
    ],
    noCodeFirst: 'defineSchema `references` is single-column',
    expected: {
      links: { kept: cascade(belongsTo('parents', XY, AB)), copy: belongsTo('parents', XY, AB) },
      parents: { linksByKept: cascade(hasMany('links', XY, AB)), linksByCopy: hasMany('links', XY, AB) },
    },
  },
  {
    // PostgreSQL names the unnamed key `returns_tenant_y_fkey1`, because the
    // explicit name is taken. It refuses the statement if the explicit name is
    // declared after the key whose default it is.
    name: "an explicit constraint name equal to another key's default name",
    tables: [
      ORDERS_AB,
      t('returns', [int('tenant'), int('x'), int('y')], {
        primaryKey: [],
        foreignKeys: [
          fk(['tenant', 'x'], 'orders', AB, { name: 'returns_tenant_y_fkey' }),
          fk(['tenant', 'y'], 'orders', AB, { onDelete: 'cascade' }),
        ],
      }),
    ],
    noCodeFirst: 'defineSchema `references` is single-column',
    expected: {
      returns: {
        returnsTenantY: belongsTo('orders', ['tenant', 'x'], AB),
        returnsTenantYFkey1: cascade(belongsTo('orders', ['tenant', 'y'], AB)),
      },
      orders: {
        returnsByReturnsTenantY: hasMany('returns', ['tenant', 'x'], AB),
        returnsByReturnsTenantYFkey1: cascade(hasMany('returns', ['tenant', 'y'], AB)),
      },
    },
  },
  {
    name: 'explicit constraint names in the form MySQL generates',
    tables: [
      ORDERS_AB,
      t('returns', [int('x'), int('y'), int('z')], {
        primaryKey: [],
        foreignKeys: [
          fk(XY, 'orders', AB, { name: 'returns_ibfk_1' }),
          fk(['x', 'z'], 'orders', AB, { name: 'returns_ibfk_2' }),
        ],
      }),
    ],
    noCodeFirst: 'defineSchema `references` is single-column',
    expected: {
      returns: { returnsIbfk_1: belongsTo('orders', XY, AB), returnsIbfk_2: belongsTo('orders', ['x', 'z'], AB) },
      orders: {
        returnsByReturnsIbfk_1: hasMany('returns', XY, AB),
        returnsByReturnsIbfk_2: hasMany('returns', ['x', 'z'], AB),
      },
    },
    // MySQL's catalog keeps no flag for a name it generated, and it generates
    // exactly these, so both read as unnamed keys and take PostgreSQL's
    // default names.
    differsOn: {
      engines: ['mysql'],
      expected: {
        returns: { returnsXY: belongsTo('orders', XY, AB), returnsXZ: belongsTo('orders', ['x', 'z'], AB) },
        orders: {
          returnsByReturnsXY: hasMany('returns', XY, AB),
          returnsByReturnsXZ: hasMany('returns', ['x', 'z'], AB),
        },
      },
    },
  },
  {
    // Both default to `links_x_y_fkey`; the first declared keeps it and the
    // second takes `links_x_y_fkey1`. Declared the other way round (next case),
    // the names change places, on PostgreSQL and so everywhere.
    name: 'two unnamed composite foreign keys over the same columns',
    tables: [PARENTS_AB_CD, LINKS_XY(fk(XY, 'parents', AB), fk(XY, 'parents', CD))],
    noCodeFirst: 'defineSchema `references` is single-column',
    expected: {
      links: { linksXY: belongsTo('parents', XY, AB), linksXYFkey1: belongsTo('parents', XY, CD) },
      parents: { linksByLinksXY: hasMany('links', XY, AB), linksByLinksXYFkey1: hasMany('links', XY, CD) },
    },
  },
  {
    name: 'two unnamed composite foreign keys over the same columns, declared the other way round',
    tables: [PARENTS_AB_CD, LINKS_XY(fk(XY, 'parents', CD), fk(XY, 'parents', AB))],
    noCodeFirst: 'defineSchema `references` is single-column',
    expected: {
      links: { linksXY: belongsTo('parents', XY, CD), linksXYFkey1: belongsTo('parents', XY, AB) },
      parents: { linksByLinksXY: hasMany('links', XY, CD), linksByLinksXYFkey1: hasMany('links', XY, AB) },
    },
  },
  {
    // `links_x_<50 characters>` is as much of each default as fits in 63 bytes,
    // so the two collide and the second declared takes the counter.
    name: 'unnamed composite foreign keys whose default names are cut to the same 63 bytes',
    tables: [
      ORDERS_AB,
      t('links', [int('x'), int(LONG_A), int(LONG_B)], {
        primaryKey: [],
        foreignKeys: [fk(['x', LONG_A], 'orders', AB), fk(['x', LONG_B], 'orders', AB)],
      }),
    ],
    noCodeFirst: 'defineSchema `references` is single-column',
    expected: {
      links: {
        [LONG_BASE]: belongsTo('orders', ['x', LONG_A], AB),
        [`${LONG_BASE.slice(0, -1)}Fkey1`]: belongsTo('orders', ['x', LONG_B], AB),
      },
      orders: {
        [`linksBy${upperFirst(LONG_BASE)}`]: hasMany('links', ['x', LONG_A], AB),
        [`linksBy${upperFirst(LONG_BASE.slice(0, -1))}Fkey1`]: hasMany('links', ['x', LONG_B], AB),
      },
    },
  },
  {
    // MySQL numbers unnamed keys `links_ibfk_1` to `links_ibfk_11` in
    // declaration order, and its catalog lists `links_ibfk_10` before
    // `links_ibfk_2`.
    name: 'more than nine unnamed foreign keys from one table',
    tables: [
      PARENTS_AB_CD,
      t('tags', [id()]),
      t('links', [int('x'), int('y'), ...TAG_COLUMNS.map((c) => int(c))], {
        primaryKey: [],
        foreignKeys: [
          fk(TAG_COLUMNS[0]!, 'tags'),
          fk(XY, 'parents', CD),
          ...TAG_COLUMNS.slice(1).map((c) => fk(c, 'tags')),
          fk(XY, 'parents', AB),
        ],
      }),
    ],
    noCodeFirst: 'defineSchema `references` is single-column',
    expected: {
      links: {
        linksXY: belongsTo('parents', XY, CD),
        linksXYFkey1: belongsTo('parents', XY, AB),
        ...Object.fromEntries(TAG_COLUMNS.map((c) => [snakeToCamel(c.slice(0, -3)), belongsTo('tags', c)])),
      },
      parents: { linksByLinksXY: hasMany('links', XY, CD), linksByLinksXYFkey1: hasMany('links', XY, AB) },
      tags: Object.fromEntries(
        TAG_COLUMNS.map((c) => [`linksBy${upperFirst(snakeToCamel(c.slice(0, -3)))}`, hasMany('links', c)]),
      ),
    },
  },
  {
    // `box_items.item_id` and `box.items_item_id` both default to
    // `box_items_item_id_fkey`; PostgreSQL gives the second table's the counter.
    // Only one of them cascades.
    name: 'two tables whose default constraint names are the same',
    tables: [
      t('items', [id()]),
      t('box_items', [id(), int('item_id')], { foreignKeys: [fk('item_id', 'items', 'id', { onDelete: 'cascade' })] }),
      t('box', [id(), int('items_item_id')], { foreignKeys: [fk('items_item_id', 'items')] }),
    ],
    expected: {
      items: { boxItems: cascade(hasMany('box_items', 'item_id')), box: hasMany('box', 'items_item_id') },
      box_items: { item: cascade(belongsTo('items', 'item_id')) },
      box: { item: belongsTo('items', 'items_item_id') },
    },
  },
  {
    // PostgreSQL creates a table's CHECK, UNIQUE and PRIMARY KEY constraints
    // before naming any foreign key, so a CHECK named like the first default
    // pushes both keys up the counter. The read shows the name selects the same
    // parent on every engine.
    name: "a CHECK constraint named like a foreign key's default name",
    tables: [
      PARENTS_AB_CD,
      t('links', [int('x'), int('y')], {
        primaryKey: [],
        constraints: [{ name: 'links_x_y_fkey', check: 'x > 0' }],
        foreignKeys: [fk(XY, 'parents', AB), fk(XY, 'parents', CD)],
      }),
    ],
    noCodeFirst: 'defineSchema `references` is single-column',
    expected: {
      links: { linksXYFkey1: belongsTo('parents', XY, AB), linksXYFkey2: belongsTo('parents', XY, CD) },
      parents: { linksByLinksXYFkey1: hasMany('links', XY, AB), linksByLinksXYFkey2: hasMany('links', XY, CD) },
    },
    query: {
      insert: ['INSERT INTO parents VALUES (1, 2, 3, 4), (5, 6, 1, 2)', 'INSERT INTO links VALUES (1, 2)'],
      table: 'links',
      args: { with: { linksXYFkey1: true } },
      rows: [{ x: 1, y: 2, linksXYFkey1: { a: 1, b: 2, c: 3, d: 4 } }],
    },
  },
  {
    // The same CHECK on another table, created after `links`. PostgreSQL names
    // `links`'s keys before the CHECK exists, so nothing moves. SQLite lists
    // `aaa` first, and its CHECK must not move `links`'s names either.
    name: "another table's CHECK named like a foreign key's default, created later",
    tables: [PARENTS_AB_CD, LINKS_XY(fk(XY, 'parents', AB), fk(XY, 'parents', CD)), AAA_CHECK],
    noCodeFirst: 'defineSchema `references` is single-column',
    expected: UNMOVED,
    query: { ...LINKS_QUERY, rows: [{ x: 1, y: 2, linksXYFkey1: { a: 5, b: 6, c: 1, d: 2 } }] },
  },
  {
    // Created first, the CHECK does move PostgreSQL's names, as one in `links`
    // would. No other catalog records the order tables were created in, so off
    // PostgreSQL a default avoids only its own table's other constraints.
    name: "another table's CHECK named like a foreign key's default, created earlier",
    tables: [PARENTS_AB_CD, AAA_CHECK, LINKS_XY(fk(XY, 'parents', AB), fk(XY, 'parents', CD))],
    noCodeFirst: 'defineSchema `references` is single-column',
    expected: {
      links: { linksXYFkey1: belongsTo('parents', XY, AB), linksXYFkey2: belongsTo('parents', XY, CD) },
      parents: { linksByLinksXYFkey1: hasMany('links', XY, AB), linksByLinksXYFkey2: hasMany('links', XY, CD) },
    },
    query: { ...LINKS_QUERY, rows: [{ x: 1, y: 2, linksXYFkey1: { a: 1, b: 2, c: 3, d: 4 } }] },
    differsOn: {
      engines: ['node:sqlite', 'better-sqlite3', 'mysql'],
      expected: UNMOVED,
      rows: [{ x: 1, y: 2, linksXYFkey1: { a: 5, b: 6, c: 1, d: 2 } }],
    },
  },
  {
    name: "a UNIQUE constraint named like a foreign key's default name",
    tables: [
      PARENTS_AB_CD,
      t('links', [int('x'), int('y'), int('w')], {
        primaryKey: [],
        constraints: [{ name: 'links_x_y_fkey', unique: ['w'] }],
        foreignKeys: [fk(XY, 'parents', CD), fk(XY, 'parents', AB)],
      }),
    ],
    noCodeFirst: 'defineSchema `references` is single-column',
    expected: {
      links: { linksXYFkey1: belongsTo('parents', XY, CD), linksXYFkey2: belongsTo('parents', XY, AB) },
      parents: { linksByLinksXYFkey1: hasMany('links', XY, CD), linksByLinksXYFkey2: hasMany('links', XY, AB) },
    },
  },
  {
    name: 'explicit constraint names longer than 63 bytes',
    tables: [
      PARENTS_AB_CD,
      t('links', [int('x'), int('y'), int('z')], {
        primaryKey: [],
        foreignKeys: [
          fk(XY, 'parents', AB, { name: LONG_ASCII_NAME }),
          fk(['x', 'z'], 'parents', AB, { name: LONG_UTF8_NAME }),
        ],
      }),
    ],
    noCodeFirst: 'defineSchema `references` is single-column',
    expected: {
      links: {
        ['a'.repeat(60)]: belongsTo('parents', XY, AB),
        ['é'.repeat(30)]: belongsTo('parents', ['x', 'z'], AB),
      },
      parents: {
        [`linksByA${'a'.repeat(59)}`]: hasMany('links', XY, AB),
        // `snakeToCamel` capitalizes only an ASCII letter after `_`.
        [`linksBy_${'é'.repeat(30)}`]: hasMany('links', ['x', 'z'], AB),
      },
    },
  },
  {
    // The automatic many-to-many joins the junction to the target's primary
    // key, so through a key that references another unique column
    // (`tags.code`) it returned tags the junction does not reference. No
    // engine derives it.
    name: 'junction table whose foreign key references a non-primary-key column',
    tables: [
      t('posts', [id()]),
      t('tags', [id(), int('code', { unique: true })]),
      t('links', [int('post_id', { notNull: true }), int('tag_code', { notNull: true })], {
        primaryKey: [],
        unique: [['post_id', 'tag_code']],
        foreignKeys: [fk('post_id', 'posts'), fk('tag_code', 'tags', 'code')],
      }),
    ],
    expected: {
      posts: { links: hasMany('links', 'post_id') },
      tags: { links: hasMany('links', 'tag_code', 'code') },
      links: { post: belongsTo('posts', 'post_id'), tag: belongsTo('tags', 'tag_code', 'code') },
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
    for (const k of table.constraints ?? []) {
      parts.push(`CONSTRAINT ${q(k.name)} ${'check' in k ? `CHECK (${k.check})` : `UNIQUE (${list(k.unique)})`}`);
    }
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
  /** Create the case's tables (and its query's rows) in a fresh namespace, introspect it, and run its query. */
  introspect(c: Case, index: number): Promise<{ schema: SchemaMetadata; rows?: unknown }>;
}

// biome-ignore lint/suspicious/noExplicitAny: each engine's client, typed by the metadata only at runtime.
const runQuery = (client: { table(name: string): any }, q: NonNullable<Case['query']>) =>
  client.table(q.table).findMany(q.args);

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
      return { schema: codeFirstMetadata(c.tables) };
    },
  },
  {
    name: 'node:sqlite',
    runners: skipGate(!DatabaseSync, 'turbine-orm/sqlite requires node:sqlite (Node >= 22.5)'),
    async introspect(c) {
      const { introspectSqliteDatabase, turbineSqlite } = await import('../sqlite.js');
      const db = new DatabaseSync!(':memory:');
      try {
        for (const stmt of [...renderDdl(c.tables, 'sqlite'), ...(c.query?.insert ?? [])]) db.exec(stmt);
        const schema = introspectSqliteDatabase(db, silent);
        if (!c.query) return { schema };
        const client = turbineSqlite(db, schema, silent);
        try {
          return { schema, rows: await runQuery(client, c.query) };
        } finally {
          await client.disconnect();
        }
      } finally {
        db.close();
      }
    },
  },
  {
    name: 'better-sqlite3',
    runners: skipGate(!BetterSqlite3, 'requires the optional better-sqlite3 peer (set TURBINE_SQLITE_BINDING_PEER)'),
    async introspect(c) {
      const { introspectBetterSqlite3Database, turbineBetterSqlite3 } = await import('../better-sqlite3.js');
      const db = new BetterSqlite3!(':memory:');
      try {
        for (const stmt of [...renderDdl(c.tables, 'sqlite'), ...(c.query?.insert ?? [])]) db.exec(stmt);
        const schema = introspectBetterSqlite3Database(db, silent);
        if (!c.query) return { schema };
        const client = await turbineBetterSqlite3(db, schema, silent);
        try {
          return { schema, rows: await runQuery(client, c.query) };
        } finally {
          await client.disconnect();
        }
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
          for (const stmt of [...renderDdl(c.tables, 'postgres'), ...(c.query?.insert ?? [])]) await client.query(stmt);
          await client.query('COMMIT');
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        } finally {
          client.release();
        }
        try {
          const metadata = await introspect({ connectionString: url, schema, ...silent });
          if (!c.query) return { schema: metadata };
          const { default: pg } = await import('pg');
          const { TurbineClient } = await import('../client.js');
          // The case's schema as a connection parameter of a pool of its own,
          // never a session SET.
          const casePool = new pg.Pool({ connectionString: url, max: 1, options: `-c search_path=${schema}` });
          try {
            return {
              schema: metadata,
              rows: await runQuery(new TurbineClient({ pool: casePool, ...silent }, metadata), c.query),
            };
          } finally {
            await casePool.end();
          }
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
        const { MysqlPool, introspectMysqlWith, mysqlDialect } = await import('../mysql.js');
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
          for (const stmt of [...renderDdl(c.tables, 'mysql'), ...(c.query?.insert ?? [])]) await raw.query(stmt);
          const pool = new MysqlPool(raw);
          const schema = await introspectMysqlWith(
            async (sql, params) => (await pool.query(sql, params)).rows,
            database,
            silent,
          );
          if (!c.query) return { schema };
          const { TurbineClient } = await import('../client.js');
          const client = new TurbineClient(
            { pool, dialect: mysqlDialect, preparedStatements: false, ...silent },
            schema,
          );
          return { schema, rows: await runQuery(client, c.query) };
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
        const { schema, rows } = await h.introspect(c, index);
        const actual = normalize(schema);
        if (process.env.RELATION_PARITY_DUMP) console.log(JSON.stringify({ engine: h.name, case: c.name, actual }));
        const differs = c.differsOn?.engines.includes(h.name) ? c.differsOn : undefined;
        // Rows first: a relation that selects another parent is the failure
        // that matters. Every harness but code-first (no database) reads them.
        if (c.query && h.name !== 'code-first') {
          assert.deepEqual(
            JSON.parse(JSON.stringify(rows ?? null)),
            differs?.rows ?? c.query.rows,
            `${h.name} reads other rows for "${c.name}"`,
          );
        }
        assert.deepEqual(
          actual,
          differs?.expected ?? c.expected,
          `${h.name} derives different relations for "${c.name}"`,
        );
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

  it('reads SQLite foreign keys from the CREATE TABLE text, table- and column-level, named or not', () => {
    const ddl = `CREATE TABLE "returns" (
      id INTEGER PRIMARY KEY, -- CONSTRAINT not_this REFERENCES nothing
      note TEXT DEFAULT 'CONSTRAINT x REFERENCES y' CHECK (length(note) > 0),
      code VARCHAR(20) CONSTRAINT Fk_Code REFERENCES "Codes" (code),
      owner_id INTEGER CONSTRAINT owner_nn NOT NULL REFERENCES users (id) REFERENCES people,
      tenant_id INTEGER, order_id INTEGER, replacement_id INTEGER, label TEXT CONSTRAINT Ñame REFERENCES labels,
      /* a comment, CONSTRAINT nope FOREIGN KEY (x) REFERENCES y */
      CONSTRAINT fk_original_order FOREIGN KEY (tenant_id, order_id) REFERENCES orders (tenant_id, id) ON DELETE CASCADE,
      CONSTRAINT "Fk Replacement" FOREIGN KEY ([tenant_id], \`replacement_id\`) REFERENCES orders,
      FOREIGN KEY (owner_id) REFERENCES people (id),
      CONSTRAINT not_a_key CHECK (id > 0)
    )`;
    assert.deepEqual(declaredForeignKeys(ddl), [
      // A bare word folds to lower case (ASCII only, as PostgreSQL folds it in
      // UTF-8); a quoted name keeps its case.
      { name: 'fk_code', columns: ['code'], table: 'Codes', references: ['code'] },
      // `owner_nn` names the NOT NULL, so both references are unnamed.
      { columns: ['owner_id'], table: 'users', references: ['id'] },
      { columns: ['owner_id'], table: 'people', references: [] },
      { name: 'Ñame', columns: ['label'], table: 'labels', references: [] },
      {
        name: 'fk_original_order',
        columns: ['tenant_id', 'order_id'],
        table: 'orders',
        references: ['tenant_id', 'id'],
      },
      { name: 'Fk Replacement', columns: ['tenant_id', 'replacement_id'], table: 'orders', references: [] },
      { columns: ['owner_id'], table: 'people', references: ['id'] },
    ]);
    assert.deepEqual(declaredForeignKeys('CREATE TABLE t AS SELECT 1'), []);
    assert.deepEqual(declaredForeignKeys(''), []);
  });

  // A key as `PRAGMA foreign_key_list` lists it, `references` empty where the clause names none.
  const pragmaKey = (columns: string[], table: string, references: string[] = []) => ({
    sourceTable: 't',
    sourceColumns: columns,
    targetTable: table,
    targetColumns: references,
    constraintName: '',
  });
  // `keys` in declaration order; SQLite's PRAGMA lists them the other way round.
  const nameKeys = (ddl: string, keys: ReturnType<typeof pragmaKey>[], taken = new Set<string>()) => {
    nameSqliteForeignKeys('t', ddl, [...keys].reverse(), taken);
    return keys.map((k) => k.constraintName);
  };

  it('matches a SQLite declaration by child columns, target and referenced columns', () => {
    const ddl =
      'CREATE TABLE t (A INT, b INT, CONSTRAINT one FOREIGN KEY (a, b) REFERENCES P (x, y), ' +
      'CONSTRAINT two FOREIGN KEY (a, b) REFERENCES p (z, w), FOREIGN KEY (a, b) REFERENCES q)';
    assert.deepEqual(
      nameKeys(ddl, [
        pragmaKey(['A', 'b'], 'P', ['x', 'y']),
        pragmaKey(['A', 'b'], 'p', ['Z', 'W']),
        pragmaKey(['A', 'b'], 'q'),
      ]),
      ['one', 'two', 't_A_b_fkey'],
    );
    // The referenced columns, not the position, decide: listed in an order
    // other than SQLite's, each key still takes its own declaration's name.
    const two = [pragmaKey(['A', 'b'], 'p', ['z', 'w']), pragmaKey(['A', 'b'], 'P', ['x', 'y'])];
    nameSqliteForeignKeys('t', ddl, [...two, pragmaKey(['A', 'b'], 'q')], new Set());
    assert.deepEqual(
      two.map((k) => k.constraintName),
      ['two', 'one'],
    );
    // And a clause the reader misses costs only its own key's name: the
    // second key here is in table constraints with no comma between them.
    const missed =
      'CREATE TABLE t (x INT, y INT, CONSTRAINT fk_one FOREIGN KEY (x, y) REFERENCES p (a, b) ' +
      'CONSTRAINT fk_two FOREIGN KEY (x, y) REFERENCES p (c, d))';
    assert.deepEqual(
      nameKeys(missed, [pragmaKey(['x', 'y'], 'p', ['a', 'b']), pragmaKey(['x', 'y'], 'p', ['c', 'd'])]),
      ['fk_one', 't_x_y_fkey'],
    );
  });

  it('pairs identical SQLite declarations in declaration order, and names none of an identity it cannot read', () => {
    const twice =
      'CREATE TABLE t (a INT, CONSTRAINT x FOREIGN KEY (a) REFERENCES p, CONSTRAINT y FOREIGN KEY (a) REFERENCES p)';
    assert.deepEqual(nameKeys(twice, [pragmaKey(['a'], 'p'), pragmaKey(['a'], 'p')]), ['x', 'y']);
    // SQLite accepts table constraints with no comma between them, which this
    // reader does not split: of three keys to `p` it reads two, so neither
    // declared name can be paired, and both stay reserved.
    const unread =
      'CREATE TABLE t (a INT, CONSTRAINT t_a_fkey FOREIGN KEY (a) REFERENCES p, CONSTRAINT y FOREIGN KEY (a) REFERENCES p FOREIGN KEY (a) REFERENCES p)';
    assert.deepEqual(nameKeys(unread, [pragmaKey(['a'], 'p'), pragmaKey(['a'], 'p'), pragmaKey(['a'], 'p')]), [
      't_a_fkey1',
      't_a_fkey2',
      't_a_fkey3',
    ]);
  });

  it('reserves every constraint name a SQLite statement declares, as PostgreSQL 18 does, but not a named DEFAULT', () => {
    // Read from pg_constraint on PostgreSQL 18: a named NOT NULL, UNIQUE and
    // CHECK hold their names; a name on DEFAULT creates no constraint.
    const ddl =
      'CREATE TABLE t (a INT CONSTRAINT t_a_fkey NOT NULL, b INT CONSTRAINT t_b_fkey DEFAULT 0, ' +
      'c INT CONSTRAINT t_c_fkey UNIQUE, d INT, CONSTRAINT t_d_fkey CHECK (d > 0), FOREIGN KEY (a) REFERENCES p, ' +
      'FOREIGN KEY (b) REFERENCES p, FOREIGN KEY (c) REFERENCES p, FOREIGN KEY (d) REFERENCES p)';
    assert.deepEqual(
      nameKeys(ddl, [pragmaKey(['a'], 'p'), pragmaKey(['b'], 'p'), pragmaKey(['c'], 'p'), pragmaKey(['d'], 'p')]),
      ['t_a_fkey1', 't_b_fkey', 't_c_fkey1', 't_d_fkey1'],
    );
  });

  it('cuts explicit and reserved names to 63 bytes of UTF-8, as PostgreSQL stores them', () => {
    assert.equal(postgresIdentifier(`fk_${'a'.repeat(61)}`), `fk_${'a'.repeat(60)}`);
    // 65 bytes of two-byte characters keep 63: the last whole character fits in 62.
    assert.equal(postgresIdentifier(`fk_${'é'.repeat(31)}`), `fk_${'é'.repeat(30)}`);
    assert.equal(postgresIdentifier(`${'€'.repeat(21)}x`), '€'.repeat(21));
    // A 64-byte CHECK name that cuts to a key's 63-byte default holds it, and
    // an explicit name keeps its first 63 bytes.
    const column = 'c'.repeat(70);
    const fullDefault = defaultForeignKeyConstraintName('t', [column]);
    assert.equal(fullDefault.length, 63);
    assert.deepEqual(
      foreignKeyConstraintNames('t', [{ columns: [column], name: undefined }], new Set(), [`${fullDefault}x`]),
      [defaultForeignKeyConstraintName('t', [column], new Set([fullDefault]))],
    );
    const long = `t_a_fkey${'z'.repeat(56)}`;
    assert.deepEqual(foreignKeyConstraintNames('t', [{ columns: ['a'], name: long }], new Set()), [long.slice(0, 63)]);
  });

  it('reserves every explicit name before choosing a default, wherever it is declared', () => {
    // PostgreSQL refuses this statement (the default `t_a_fkey` is taken by the
    // time the explicit one is added); SQLite and MySQL accept it, and the
    // explicit key keeps its name.
    const ddl =
      'CREATE TABLE t (a INT, b INT, FOREIGN KEY (a) REFERENCES p, CONSTRAINT t_a_fkey FOREIGN KEY (b) REFERENCES p)';
    assert.deepEqual(nameKeys(ddl, [pragmaKey(['a'], 'p'), pragmaKey(['b'], 'p')]), ['t_a_fkey1', 't_a_fkey']);
    // Another table's CHECK, UNIQUE and other names stay its own; only
    // foreign-key names, explicit or chosen, are shared with the next table.
    const shared = new Set<string>();
    assert.deepEqual(
      foreignKeyConstraintNames('aaa', [{ columns: ['x'], name: undefined }], shared, ['links_x_y_fkey']),
      ['aaa_x_fkey'],
    );
    assert.deepEqual([...shared], ['aaa_x_fkey']);
    assert.deepEqual(foreignKeyConstraintNames('links', [{ columns: ['x', 'y'], name: undefined }], shared), [
      'links_x_y_fkey',
    ]);
    // One set for the schema: a name another table took is taken here too.
    const taken = new Set(['t_a_fkey']);
    assert.deepEqual(nameKeys('CREATE TABLE t (a INT REFERENCES p)', [pragmaKey(['a'], 'p')], taken), ['t_a_fkey1']);
    assert.deepEqual(
      foreignKeyConstraintNames(
        'links',
        [
          { columns: ['x', 'y'], name: undefined },
          { columns: ['x', 'y'], name: 'links_x_y_fkey' },
          { columns: ['x', 'y'], name: undefined },
        ],
        new Set(),
      ),
      ['links_x_y_fkey1', 'links_x_y_fkey', 'links_x_y_fkey2'],
    );
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
