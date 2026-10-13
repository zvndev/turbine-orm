/**
 * The cross-engine battery's one schema and one seed.
 *
 * The schema is code-first (`defineSchema`) and every engine builds its tables
 * from it through Turbine's own DDL path (`schemaToSQL` for the SQL engines,
 * `powqlSchemaDDL` for PowDB), so a DDL mapping bug is a finding here rather
 * than something a hand-written per-engine DDL hides. Every engine reads the
 * same `SchemaMetadata` (`schemaDefToMetadata`), so a difference in a result is
 * a difference in the engine path, not in introspection.
 *
 * Table names carry an `oe_` prefix so the battery can share a database with
 * other suites without touching their tables. Ids are always written
 * explicitly, so no result depends on an engine's identity sequence.
 *
 * The seed is chosen to make engines disagree where they can: NULLs in every
 * nullable column, duplicate sort keys, mixed case and non-ASCII text, LIKE
 * metacharacters, millisecond timestamps across a DST change, bigint past
 * 2^53, numerics past double precision, JSON objects and arrays, relation keys
 * that are bigints past 2^53, and binary keys that are not valid UTF-8.
 *
 * The binary-keyed tables and the enum table are created only on an engine
 * that can hold them ({@link CAPABILITY_TABLES}); see `gaps` in harness.ts.
 */

import type { SchemaMetadata } from '../../../schema.js';
import { defineSchema, type SchemaDef } from '../../../schema-builder.js';
import { schemaDefToMetadata } from '../../../schema-metadata.js';

const BASE_TABLES = {
  oe_orgs: {
    id: { type: 'integer', primaryKey: true },
    name: { type: 'text', notNull: true },
    slug: { type: 'varchar', maxLength: 40, notNull: true, unique: true },
  },
  oe_users: {
    id: { type: 'integer', primaryKey: true },
    orgId: { type: 'integer', notNull: true, references: 'oe_orgs.id' },
    email: { type: 'varchar', maxLength: 120, notNull: true, unique: true },
    name: { type: 'text', notNull: true },
    nickname: { type: 'text' },
    age: { type: 'integer' },
    score: { type: 'double' },
    balance: { type: 'numeric' },
    big: { type: 'bigint' },
    active: { type: 'boolean', notNull: true },
    createdAt: { type: 'timestamptz', notNull: true },
    birthday: { type: 'date' },
    prefs: { type: 'json' },
    token: { type: 'uuid' },
  },
  oe_profiles: {
    id: { type: 'integer', primaryKey: true },
    userId: { type: 'integer', notNull: true, unique: true, references: 'oe_users.id' },
    bio: { type: 'text' },
  },
  oe_posts: {
    id: { type: 'integer', primaryKey: true },
    userId: { type: 'integer', references: 'oe_users.id' },
    orgId: { type: 'integer', notNull: true, references: 'oe_orgs.id' },
    title: { type: 'text', notNull: true },
    views: { type: 'integer', notNull: true },
    rating: { type: 'double' },
    published: { type: 'boolean', notNull: true },
    publishedAt: { type: 'timestamptz' },
    meta: { type: 'json' },
  },
  oe_comments: {
    id: { type: 'integer', primaryKey: true },
    postId: { type: 'integer', notNull: true, references: 'oe_posts.id' },
    userId: { type: 'integer', references: 'oe_users.id' },
    orgId: { type: 'integer', notNull: true },
    body: { type: 'text', notNull: true },
    likes: { type: 'integer' },
  },
  oe_big_parents: {
    id: { type: 'bigint', primaryKey: true },
    name: { type: 'text', notNull: true },
  },
  oe_big_kids: {
    id: { type: 'integer', primaryKey: true },
    parentId: { type: 'bigint', notNull: true, references: 'oe_big_parents.id' },
    label: { type: 'text', notNull: true },
  },
};

const ENUM_TABLE_DEFS = {
  oe_tags: {
    id: { type: 'integer', primaryKey: true },
    status: { type: 'enum', enumName: 'oe_status', notNull: true, default: "'active'" },
    previous: { type: 'enum', enumName: 'oe_status' },
  },
};

/**
 * The battery's one enum. `it's` needs its quote doubled in every engine's
 * DDL, and `int` is a label MySQL's type mapper would read as a type name.
 * PostgreSQL declares it with CREATE TYPE; every other engine on the column.
 */
const ENUMS = { oe_status: ['active', 'paused', "it's", 'int'] } as const;

const BINARY_TABLE_DEFS = {
  oe_bin_parents: {
    id: { type: 'bytea', primaryKey: true, maxLength: 16 },
    name: { type: 'text', notNull: true },
  },
  oe_bin_kids: {
    id: { type: 'integer', primaryKey: true },
    parentId: { type: 'bytea', maxLength: 16, notNull: true, references: 'oe_bin_parents.id' },
    label: { type: 'text', notNull: true },
  },
};

/**
 * A capability some engine lacks. Each one's tables are created only on an
 * engine that has it; see `gaps` in harness.ts.
 */
export type Capability = 'binary' | 'enum';

const CAPABILITY_TABLE_DEFS: Record<Capability, Record<string, unknown>> = {
  binary: BINARY_TABLE_DEFS,
  enum: ENUM_TABLE_DEFS,
};

/** The tables each capability adds. */
export const CAPABILITY_TABLES: Readonly<Record<Capability, ReadonlySet<string>>> = {
  binary: new Set(Object.keys(BINARY_TABLE_DEFS)),
  enum: new Set(Object.keys(ENUM_TABLE_DEFS)),
};

/** The fixture without the tables of the given capabilities. */
export function fixtureWithout(gaps: readonly Capability[]): { def: SchemaDef; schema: SchemaMetadata } {
  const tables: Record<string, unknown> = { ...BASE_TABLES };
  for (const [capability, defs] of Object.entries(CAPABILITY_TABLE_DEFS)) {
    if (!gaps.includes(capability as Capability)) Object.assign(tables, defs);
  }
  const def = defineSchema(tables as never, { enums: ENUMS });
  return { def, schema: schemaDefToMetadata(def) };
}

const FULL = fixtureWithout([]);
export const DEF: SchemaDef = FULL.def;
export const SCHEMA: SchemaMetadata = FULL.schema;

/** Children first: the order a reset deletes in. Seeding walks it backwards. */
export const TABLES_CHILD_FIRST = [
  'oe_bin_kids',
  'oe_bin_parents',
  'oe_big_kids',
  'oe_big_parents',
  'oe_tags',
  'oe_comments',
  'oe_posts',
  'oe_profiles',
  'oe_users',
  'oe_orgs',
] as const;

const at = (iso: string) => new Date(iso);
/** A 16-byte key. These two differ only in a first byte that is not valid UTF-8 on its own. */
const key = (first: number) => Buffer.from([first, ...Array.from({ length: 14 }, () => 0), 10]);

export const SEED: Record<(typeof TABLES_CHILD_FIRST)[number], Record<string, unknown>[]> = {
  oe_orgs: [
    { id: 1, name: 'Acme', slug: 'acme' },
    { id: 2, name: 'Globex', slug: 'globex' },
    { id: 3, name: 'Initech', slug: 'initech' },
  ],
  oe_users: [
    {
      id: 1,
      orgId: 1,
      email: 'alice@example.com',
      name: 'Alice',
      nickname: 'ally',
      age: 34,
      score: 9.5,
      balance: '12.34',
      big: 9007199254740993n,
      active: true,
      createdAt: at('2026-03-08T06:59:59.999Z'),
      birthday: at('1990-01-31T00:00:00.000Z'),
      prefs: { theme: 'dark', tags: ['a', 'b'] },
      token: '0b5e2c1a-9f3d-4c6e-8a7b-1d2e3f405162',
    },
    {
      id: 2,
      orgId: 1,
      email: 'bob@example.com',
      name: 'bob',
      nickname: null,
      age: 27,
      score: 7.25,
      balance: '7.50',
      big: -5n,
      active: false,
      createdAt: at('2026-03-29T01:30:00.123Z'),
      birthday: null,
      prefs: null,
      token: null,
    },
    {
      id: 3,
      orgId: 1,
      email: 'carol@example.com',
      name: 'Carol 50% off_now',
      nickname: 'cc',
      age: null,
      score: null,
      balance: '100',
      big: null,
      active: true,
      createdAt: at('2025-12-31T23:59:59.999Z'),
      birthday: at('2000-02-29T00:00:00.000Z'),
      prefs: { theme: 'light' },
      token: null,
    },
    {
      id: 4,
      orgId: 2,
      email: 'dave@example.com',
      name: 'Émile',
      nickname: 'ally',
      age: 34,
      score: 9.5,
      balance: '0.1',
      big: 7n,
      active: true,
      createdAt: at('2026-01-15T12:00:00.000Z'),
      birthday: at('1985-07-04T00:00:00.000Z'),
      prefs: { theme: 'dark' },
      token: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
    },
    {
      id: 5,
      orgId: 2,
      email: 'erin@example.com',
      name: 'emile',
      nickname: null,
      age: 19,
      score: -1,
      balance: null,
      big: 1n,
      active: false,
      createdAt: at('2026-01-15T12:00:00.000Z'),
      birthday: null,
      prefs: [1, 2, 3],
      token: null,
    },
    {
      id: 6,
      orgId: 3,
      email: 'frank@example.com',
      name: 'back\\slash',
      nickname: 'Ally',
      age: 51,
      score: 0,
      balance: '12345678901234567890.123456789',
      big: 0n,
      active: true,
      createdAt: at('2024-02-29T00:00:00.000Z'),
      birthday: at('1973-12-01T00:00:00.000Z'),
      prefs: {},
      token: null,
    },
  ],
  oe_profiles: [
    { id: 1, userId: 1, bio: 'Founder' },
    { id: 2, userId: 2, bio: null },
    { id: 3, userId: 4, bio: 'Designer' },
  ],
  oe_posts: [
    {
      id: 1,
      userId: 1,
      orgId: 1,
      title: 'Hello World',
      views: 100,
      rating: 4.5,
      published: true,
      publishedAt: at('2026-02-01T10:00:00.250Z'),
      meta: { lang: 'en', n: 1 },
    },
    {
      id: 2,
      userId: 1,
      orgId: 1,
      title: 'second post',
      views: 75,
      rating: null,
      published: true,
      publishedAt: at('2026-02-02T10:00:00.000Z'),
      meta: { lang: 'fr', n: 2 },
    },
    {
      id: 3,
      userId: 1,
      orgId: 1,
      title: 'Draft',
      views: 0,
      rating: 3,
      published: false,
      publishedAt: null,
      meta: null,
    },
    {
      id: 4,
      userId: 2,
      orgId: 1,
      title: '100% Sure_thing',
      views: 42,
      rating: 2.5,
      published: true,
      publishedAt: at('2026-03-01T00:00:00.000Z'),
      meta: { lang: 'en', n: 3 },
    },
    {
      id: 5,
      userId: 4,
      orgId: 2,
      title: 'Globex news',
      views: 60,
      rating: 5,
      published: true,
      publishedAt: at('2026-02-15T08:30:00.000Z'),
      meta: { lang: 'de', n: 4 },
    },
    {
      id: 6,
      userId: null,
      orgId: 2,
      title: 'orphan',
      views: 60,
      rating: 1,
      published: false,
      publishedAt: null,
      meta: null,
    },
    {
      id: 7,
      userId: 5,
      orgId: 2,
      title: 'hello again',
      views: 5,
      rating: null,
      published: true,
      publishedAt: at('2026-02-20T00:00:00.000Z'),
      meta: { lang: 'en', n: 5 },
    },
  ],
  oe_comments: [
    { id: 1, postId: 1, userId: 2, orgId: 1, body: 'Nice post!', likes: 3 },
    { id: 2, postId: 1, userId: 3, orgId: 1, body: 'I agree', likes: null },
    { id: 3, postId: 2, userId: 2, orgId: 1, body: 'Solid follow up', likes: 0 },
    { id: 4, postId: 4, userId: 1, orgId: 1, body: 'Approved', likes: 10 },
    { id: 5, postId: 5, userId: null, orgId: 2, body: 'anonymous', likes: 1 },
    { id: 6, postId: 5, userId: 5, orgId: 2, body: 'thanks', likes: null },
    { id: 7, postId: 7, userId: 4, orgId: 2, body: 'reply', likes: 2 },
  ],
  oe_big_parents: [
    { id: 9007199254740993n, name: 'snow' },
    { id: 9007199254740992n, name: 'rain' },
    { id: 5n, name: 'sun' },
  ],
  oe_big_kids: [
    { id: 1, parentId: 9007199254740993n, label: 'k1' },
    { id: 2, parentId: 9007199254740993n, label: 'k2' },
    { id: 3, parentId: 9007199254740992n, label: 'k3' },
    { id: 4, parentId: 5n, label: 'k4' },
  ],
  oe_tags: [
    { id: 1, status: 'active', previous: null },
    { id: 2, status: "it's", previous: 'paused' },
    { id: 3, status: 'int', previous: 'active' },
    { id: 4, status: 'paused', previous: "it's" },
  ],
  oe_bin_parents: [
    { id: key(0xff), name: 'p1' },
    { id: key(0xfe), name: 'p2' },
  ],
  oe_bin_kids: [
    { id: 1, parentId: key(0xff), label: 'b1' },
    { id: 2, parentId: key(0xfe), label: 'b2' },
    { id: 3, parentId: key(0xfe), label: 'b3' },
  ],
};
