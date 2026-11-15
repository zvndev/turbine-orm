/**
 * turbine-orm - real-world-shaped schemas, end to end (DATABASE_URL-gated).
 *
 * Index reading, relation derivation and code generation each have unit
 * suites, but nothing took a whole framework-shaped schema (Prisma Migrate,
 * Rails, Django, a Supabase-style auth/public split, a multi-tenant index
 * zoo, declarative partitioning, awkward identifiers, a type zoo, the
 * relation-shape catalogue) from the live catalog through `turbine
 * generate` to a running client. This file is that seam:
 *
 *   1. Each fixture under fixtures/real-world/ loads into its OWN database
 *      (created and dropped here), so the suite is independent of whatever
 *      the ambient DATABASE_URL is seeded with.
 *   2. The introspected metadata is asserted as explicit expectations, the
 *      facts that are easy to read wrong and expensive when wrong: which
 *      indexes really are unique keys and over which columns, which are
 *      partial, which defaults really are sequences, and which relations
 *      exist with which name and cardinality (many-to-many detection
 *      included, and its refusal where the junction is not pure).
 *   3. For the Prisma, Rails, SaaS-index and relations fixtures the client
 *      is generated with the same `generate()` the CLI calls, typechecked
 *      under `strict` with `skipLibCheck: false`, and driven through a
 *      relation sweep: every table flat, every relation one level deep,
 *      `count()`, and `findUnique` by every full unique key.
 *   4. A dedicated case generates and typechecks a client for tables
 *      literally named `records` and `dates`, whose entity names shadow
 *      the built-in `Record` and `Date` types.
 *
 * PostgreSQL only. The fixtures use nothing newer than PostgreSQL 14
 * syntax, and the suite runs in every DATABASE_URL lane (the 14 to 18
 * integration matrix and coverage). The CockroachDB job sets
 * TURBINE_TEST_ENGINE=cockroachdb and runs only its own named files; when
 * that variable names CockroachDB this suite skips itself outright,
 * because the corpus (contrib extensions, exclusion constraints,
 * declarative partitioning) is PostgreSQL-specific. The PgBouncer job
 * sets PGBOUNCER_URL, not DATABASE_URL, and likewise runs only its own
 * files, so the DATABASE_URL gate keeps this suite out of it; it needs a
 * direct endpoint, since it creates databases.
 *
 * Run: DATABASE_URL=postgres://... tsx --test src/test/real-world-schemas.integration.test.ts
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import pg from 'pg';
import { generate } from '../generate.js';
import { introspect } from '../introspect.js';
import type { IndexMetadata, RelationDef, SchemaMetadata, TableMetadata } from '../schema.js';
import { skipGate } from './helpers.js';

const DATABASE_URL = process.env.DATABASE_URL;
const { it, before, after } = skipGate(!DATABASE_URL, 'DATABASE_URL not set');

const COCKROACH = /cockroach/i.test(process.env.TURBINE_TEST_ENGINE ?? '');
const SKIP_ON_COCKROACH = COCKROACH
  ? 'PostgreSQL catalog corpus (contrib extensions, partitions, exclusion constraints); not run on CockroachDB'
  : false;

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');
const FIXTURE_DIR = join(HERE, 'fixtures', 'real-world');
const SUFFIX = `${process.pid}_${Date.now().toString(36)}`;

// ---------------------------------------------------------------------------
// Database-per-fixture harness
// ---------------------------------------------------------------------------

function urlForDb(dbName: string): string {
  const u = new URL(DATABASE_URL!);
  u.pathname = `/${dbName}`;
  return u.toString();
}

async function withAdmin<T>(fn: (pool: pg.Pool) => Promise<T>): Promise<T> {
  const pool = new pg.Pool({ connectionString: DATABASE_URL!, max: 1 });
  try {
    return await fn(pool);
  } finally {
    await pool.end();
  }
}

interface CorpusContext {
  url: string;
  schema: SchemaMetadata;
}

/**
 * Register one fixture's suite: create its database, load the SQL,
 * introspect `public`, run the caller's assertions, drop the database.
 * A load or introspection failure names the fixture instead of surfacing
 * as an unrelated catalog error.
 */
function corpus(fixture: string, define: (get: () => CorpusContext) => void): void {
  const label = fixture.replace(/\.sql$/, '');
  const dbName = `turbine_rw_${label.replace(/[^a-z0-9]+/g, '_')}_${SUFFIX}`;
  describe(`real-world corpus: ${label}`, { skip: SKIP_ON_COCKROACH }, () => {
    let ctx: CorpusContext | undefined;
    before(async () => {
      await withAdmin(async (admin) => {
        await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
        await admin.query(`CREATE DATABASE ${dbName}`);
      });
      const url = urlForDb(dbName);
      const pool = new pg.Pool({ connectionString: url, max: 1 });
      try {
        await pool.query(readFileSync(join(FIXTURE_DIR, fixture), 'utf-8'));
      } catch (err) {
        throw new Error(`fixture ${fixture} failed to load: ${err instanceof Error ? err.message : err}`);
      } finally {
        await pool.end();
      }
      const schema = await introspect({ connectionString: url, schema: 'public', logger: {} });
      ctx = { url, schema };
    });
    after(async () => {
      await withAdmin(async (admin) => {
        await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
      });
    });
    define(() => {
      assert.ok(ctx, `${label}: corpus was not loaded`);
      return ctx;
    });
  });
}

// ---------------------------------------------------------------------------
// Metadata expectation helpers. Every helper fails with the table, the
// object, and what was actually read, so a red run says what changed.
// ---------------------------------------------------------------------------

function tableOf(schema: SchemaMetadata, name: string): TableMetadata {
  const t = schema.tables[name];
  assert.ok(t, `expected table ${name} in introspection, got: ${Object.keys(schema.tables).sort().join(', ')}`);
  return t;
}

function indexOf(schema: SchemaMetadata, tableName: string, indexName: string): IndexMetadata {
  const t = tableOf(schema, tableName);
  const ix = t.indexes.find((i) => i.name === indexName);
  assert.ok(
    ix,
    `expected index ${indexName} on ${tableName}, got: ${t.indexes
      .map((i) => i.name)
      .sort()
      .join(', ')}`,
  );
  return ix;
}

function expectIndex(
  schema: SchemaMetadata,
  tableName: string,
  indexName: string,
  expected: { unique: boolean; columns: string[]; partial?: boolean },
): void {
  const ix = indexOf(schema, tableName, indexName);
  assert.equal(ix.unique, expected.unique, `${tableName}.${indexName}: unique flag (definition: ${ix.definition})`);
  assert.deepEqual(ix.columns, expected.columns, `${tableName}.${indexName}: key columns`);
  assert.equal(
    ix.partial ?? false,
    expected.partial ?? false,
    `${tableName}.${indexName}: partial flag (definition: ${ix.definition})`,
  );
}

/**
 * The full unique keys of a table, as findUnique/update/delete see them: a
 * UNIQUE index (the primary key's included) that is not partial, rendered
 * as one sorted "a+b" string per key. Expression uniques never appear
 * here because introspection already reports them `unique: false`.
 */
function uniqueKeySets(schema: SchemaMetadata, tableName: string): string[] {
  const t = tableOf(schema, tableName);
  const sets = new Set<string>();
  for (const ix of t.indexes) {
    if (ix.unique && !(ix.partial ?? false) && ix.columns.length > 0) sets.add(ix.columns.join('+'));
  }
  return [...sets].sort();
}

function expectUniqueKeys(schema: SchemaMetadata, tableName: string, expected: string[]): void {
  assert.deepEqual(uniqueKeySets(schema, tableName), [...expected].sort(), `${tableName}: full unique keys`);
}

function relationOf(schema: SchemaMetadata, tableName: string, relationName: string): RelationDef {
  const t = tableOf(schema, tableName);
  const rel = t.relations[relationName];
  assert.ok(
    rel,
    `expected relation ${tableName}.${relationName}, got: ${Object.keys(t.relations).sort().join(', ') || '(none)'}`,
  );
  return rel;
}

function expectRelation(
  schema: SchemaMetadata,
  tableName: string,
  relationName: string,
  expected: {
    type: RelationDef['type'];
    to: string;
    foreignKey?: string | string[];
    referenceKey?: string | string[];
    through?: { table: string; sourceKey: string; targetKey: string };
  },
): void {
  const rel = relationOf(schema, tableName, relationName);
  const where = `${tableName}.${relationName}`;
  assert.equal(rel.type, expected.type, `${where}: cardinality`);
  assert.equal(rel.to, expected.to, `${where}: target table`);
  if (expected.foreignKey !== undefined) assert.deepEqual(rel.foreignKey, expected.foreignKey, `${where}: foreignKey`);
  if (expected.referenceKey !== undefined) {
    assert.deepEqual(rel.referenceKey, expected.referenceKey, `${where}: referenceKey`);
  }
  if (expected.through !== undefined) assert.deepEqual(rel.through, expected.through, `${where}: junction`);
}

/** No table in the schema reads a many-to-many through the given junction. */
function expectNoManyToManyThrough(schema: SchemaMetadata, junctionTable: string): void {
  for (const [tableName, t] of Object.entries(schema.tables)) {
    for (const [relationName, rel] of Object.entries(t.relations)) {
      assert.notEqual(
        rel.through?.table,
        junctionTable,
        `${tableName}.${relationName} must not be a many-to-many through ${junctionTable}`,
      );
    }
  }
}

function columnOf(schema: SchemaMetadata, tableName: string, columnName: string) {
  const t = tableOf(schema, tableName);
  const col = t.columns.find((c) => c.name === columnName);
  assert.ok(col, `expected column ${tableName}.${columnName}, got: ${t.columns.map((c) => c.name).join(', ')}`);
  return col;
}

/**
 * Which defaults are sequences (or identities): `isGenerated` is the flag
 * code generation reads to keep a column out of required insert input, so
 * a literal that merely mentions `nextval(` must not set it.
 */
function expectSequenceDefault(
  schema: SchemaMetadata,
  tableName: string,
  columnName: string,
  generated: boolean,
): void {
  const col = columnOf(schema, tableName, columnName);
  assert.equal(
    col.isGenerated ?? false,
    generated,
    `${tableName}.${columnName}: isGenerated (sequence/identity default)`,
  );
}

// ---------------------------------------------------------------------------
// Generate + strict typecheck + relation sweep
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

interface SweepAccessor {
  findMany(args?: unknown): Promise<Row[]>;
  findUnique(args: unknown): Promise<Row | null>;
  count(): Promise<number>;
}

type SweepClient = Record<string, unknown> & { disconnect(): Promise<unknown> };

/**
 * Generate the client for one introspected schema into a temp project
 * under the repo root (the generator refuses an outDir outside it, and
 * `turbine-orm` self-references the built package from there), typecheck
 * it exactly as a strict consumer would, and return a live client.
 * The caller owns cleanup through the returned `close`.
 */
async function generateTypecheckAndConnect(
  label: string,
  ctx: CorpusContext,
): Promise<{ client: SweepClient; close: () => Promise<void> }> {
  const root = mkdtempSync(join(REPO_ROOT, `.turbine-rw-${label}-`));
  try {
    generate({ schema: ctx.schema, outDir: join(root, 'generated'), noTimestamp: true });
    writeFileSync(
      join(root, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          strict: true,
          noEmit: true,
          skipLibCheck: false,
          target: 'ES2022',
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          types: ['node'],
          typeRoots: [join(REPO_ROOT, 'node_modules', '@types')],
        },
        include: ['generated/**/*.ts'],
      }),
      'utf-8',
    );
    const tsc = spawnSync(join(REPO_ROOT, 'node_modules', '.bin', 'tsc'), ['-p', root], {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
      timeout: 180_000,
    });
    assert.equal(
      tsc.status,
      0,
      `${label}: generated client failed tsc --strict --skipLibCheck false:\n${tsc.stdout}\n${tsc.stderr}`,
    );
    const gen = (await import(pathToFileURL(join(root, 'generated', 'index.ts')).href)) as {
      turbine: (config: { connectionString: string }) => SweepClient;
    };
    const client = gen.turbine({ connectionString: ctx.url });
    return {
      client,
      close: async () => {
        await client.disconnect().catch(() => {});
        rmSync(root, { recursive: true, force: true });
      },
    };
  } catch (err) {
    rmSync(root, { recursive: true, force: true });
    throw err;
  }
}

/** The generated client's accessor for a table: camelCase first, raw name second. */
function accessorFor(client: SweepClient, tableName: string): SweepAccessor {
  const camel = tableName.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
  for (const key of [camel, tableName]) {
    const acc = client[key] as SweepAccessor | undefined;
    if (acc && typeof acc.findMany === 'function') return acc;
  }
  assert.fail(`generated client has no accessor for table ${tableName} (tried ${camel}, ${tableName})`);
}

/**
 * The sweep: every seeded table read flat, with every relation one level
 * deep, counted, and found by every full unique key. Row counts are the
 * fixture's seed counts, written out per corpus, so a join that drops or
 * duplicates parents fails by table and relation name.
 */
async function relationSweep(
  label: string,
  schema: SchemaMetadata,
  client: SweepClient,
  expectedCounts: Record<string, number>,
): Promise<void> {
  assert.deepEqual(
    Object.keys(schema.tables).sort(),
    Object.keys(expectedCounts).sort(),
    `${label}: introspected table set`,
  );
  for (const [tableName, expected] of Object.entries(expectedCounts)) {
    const t = tableOf(schema, tableName);
    const acc = accessorFor(client, tableName);
    const flat = await acc.findMany({ limit: 5 });
    assert.equal(flat.length, Math.min(expected, 5), `${label}.${tableName}: flat findMany row count`);
    assert.equal(await acc.count(), expected, `${label}.${tableName}: count()`);
    for (const relationName of Object.keys(t.relations).sort()) {
      const rows = await acc.findMany({ limit: 5, with: { [relationName]: true } });
      assert.equal(rows.length, flat.length, `${label}.${tableName} with ${relationName}: parent row count`);
      for (const row of rows) {
        assert.ok(relationName in row, `${label}.${tableName} with ${relationName}: relation key present on every row`);
      }
    }
    const fieldOf = new Map(t.columns.map((c) => [c.name, c.field]));
    const keys = new Map<string, string[]>();
    if (t.primaryKey.length > 0) keys.set(t.primaryKey.join('+'), t.primaryKey);
    for (const ix of t.indexes) {
      if (ix.unique && !(ix.partial ?? false) && ix.columns.length > 0) keys.set(ix.columns.join('+'), ix.columns);
    }
    for (const cols of keys.values()) {
      // A key only identifies a row when some seeded row fills every column
      // (a fully-null unique token column cannot be looked up, by design).
      const sample = flat.find((row) =>
        cols.every((c) => row[fieldOf.get(c)!] !== null && row[fieldOf.get(c)!] !== undefined),
      );
      if (!sample) continue;
      const where: Row = {};
      for (const c of cols) where[fieldOf.get(c)!] = sample[fieldOf.get(c)!];
      const found = await acc.findUnique({ where });
      assert.ok(found, `${label}.${tableName}: findUnique by (${cols.join(', ')}) must find the seeded row`);
    }
  }
}

// ---------------------------------------------------------------------------
// Prisma Migrate shape
// ---------------------------------------------------------------------------

corpus('prisma.sql', (get) => {
  it('excludes the framework migration table and reads the enum', () => {
    const { schema } = get();
    assert.equal(
      schema.tables._prisma_migrations,
      undefined,
      '_prisma_migrations is a default-excluded internal table and must not surface as an accessor',
    );
    assert.deepEqual({ ...schema.enums }, { Role: ['USER', 'ADMIN'] }, 'prisma: enums');
    assert.equal(columnOf(schema, 'User', 'role').pgType, 'Role', 'User.role keeps its enum type');
    expectSequenceDefault(schema, 'User', 'id', true);
  });

  it('reads unique keys and the implicit junction unique', () => {
    const { schema } = get();
    expectIndex(schema, 'User', 'User_email_key', { unique: true, columns: ['email'] });
    expectIndex(schema, '_CategoryToPost', '_CategoryToPost_AB_unique', { unique: true, columns: ['A', 'B'] });
    expectIndex(schema, '_CategoryToPost', '_CategoryToPost_B_index', { unique: false, columns: ['B'] });
    expectIndex(schema, 'Like', 'Like_userId_postId_key', { unique: true, columns: ['userId', 'postId'] });
    expectIndex(schema, 'Post', 'Post_authorId_idx', { unique: false, columns: ['authorId'] });
    expectUniqueKeys(schema, 'User', ['email', 'id']);
    expectUniqueKeys(schema, '_CategoryToPost', ['A+B']);
    assert.deepEqual(tableOf(schema, '_CategoryToPost').primaryKey, [], 'the Prisma junction has no primary key');
    assert.deepEqual(tableOf(schema, 'Account').primaryKey, ['provider', 'providerAccountId'], 'Account compound PK');
  });

  it('detects the implicit many-to-many and the one-to-one profile', () => {
    const { schema } = get();
    expectRelation(schema, 'Category', 'Post', {
      type: 'manyToMany',
      to: 'Post',
      through: { table: '_CategoryToPost', sourceKey: 'A', targetKey: 'B' },
    });
    expectRelation(schema, 'Post', 'Category', {
      type: 'manyToMany',
      to: 'Category',
      through: { table: '_CategoryToPost', sourceKey: 'B', targetKey: 'A' },
    });
    expectRelation(schema, 'User', 'Profile', { type: 'hasOne', to: 'Profile', foreignKey: 'userId' });
    expectRelation(schema, 'Profile', 'User', { type: 'belongsTo', to: 'User', foreignKey: 'userId' });
    expectRelation(schema, 'Post', 'User', { type: 'belongsTo', to: 'User', foreignKey: 'authorId' });
  });

  it('generated client typechecks strict and sweeps every relation', { timeout: 180_000 }, async () => {
    const ctx = get();
    const { client, close } = await generateTypecheckAndConnect('prisma', ctx);
    try {
      await relationSweep('prisma', ctx.schema, client, {
        Account: 1,
        Category: 2,
        Like: 2,
        Post: 2,
        Profile: 1,
        Session: 1,
        User: 2,
        _CategoryToPost: 3,
      });
      const users = await accessorFor(client, 'User').findMany({ with: { Profile: true }, orderBy: { id: 'asc' } });
      const aliceProfile = users[0]?.Profile as Row | null;
      assert.equal(aliceProfile?.bio, 'hello', 'prisma: the hasOne profile resolves to one object');
      assert.equal(users[1]?.Profile, null, 'prisma: a user without a profile reads null, not an empty array');
      const categories = await accessorFor(client, 'Category').findMany({
        with: { Post: true },
        orderBy: { id: 'asc' },
      });
      const techPosts = (categories[0]!.Post as Row[]).map((p) => p.title).sort();
      assert.deepEqual(techPosts, ['Draft', 'First post'], 'prisma: many-to-many through _CategoryToPost');
    } finally {
      await close();
    }
  });
});

// ---------------------------------------------------------------------------
// Rails shape
// ---------------------------------------------------------------------------

corpus('rails.sql', (get) => {
  it('keeps framework bookkeeping tables as ordinary tables', () => {
    const { schema } = get();
    assert.deepEqual(tableOf(schema, 'schema_migrations').primaryKey, ['version'], 'schema_migrations PK');
    assert.deepEqual(tableOf(schema, 'ar_internal_metadata').primaryKey, ['key'], 'ar_internal_metadata PK');
  });

  it('does not read the lower(email) expression unique as a unique key on email', () => {
    const { schema } = get();
    const ix = indexOf(schema, 'users', 'index_users_on_lower_email');
    assert.match(ix.definition, /UNIQUE/, 'the database index itself is unique over the expression');
    expectIndex(schema, 'users', 'index_users_on_lower_email', { unique: false, columns: [] });
    expectIndex(schema, 'users', 'index_users_on_reset_password_token', {
      unique: true,
      columns: ['reset_password_token'],
    });
    expectUniqueKeys(schema, 'users', ['id', 'reset_password_token']);
    expectIndex(schema, 'posts', 'index_posts_on_status_and_published_at', {
      unique: false,
      columns: ['status', 'published_at'],
      partial: true,
    });
    expectSequenceDefault(schema, 'users', 'id', true);
  });

  it('leaves polymorphic (type, id) pairs as scalars, with no invented relation', () => {
    const { schema } = get();
    assert.deepEqual(
      Object.keys(tableOf(schema, 'comments').relations),
      ['user'],
      'comments has only its real FK relation; commentable_type/id is not a relation',
    );
    assert.equal(columnOf(schema, 'comments', 'commentable_type').field, 'commentableType');
    assert.deepEqual(Object.keys(tableOf(schema, 'taggings').relations), ['tag'], 'taggings relations');
    expectIndex(schema, 'active_storage_attachments', 'index_active_storage_attachments_uniqueness', {
      unique: true,
      columns: ['record_type', 'record_id', 'name', 'blob_id'],
    });
    expectUniqueKeys(schema, 'active_storage_blobs', ['id', 'key']);
  });

  it('generated client typechecks strict and sweeps every relation', { timeout: 180_000 }, async () => {
    const ctx = get();
    const { client, close } = await generateTypecheckAndConnect('rails', ctx);
    try {
      await relationSweep('rails', ctx.schema, client, {
        active_storage_attachments: 1,
        active_storage_blobs: 1,
        ar_internal_metadata: 1,
        comments: 3,
        posts: 2,
        schema_migrations: 2,
        taggings: 2,
        tags: 2,
        users: 2,
      });
      const users = accessorFor(client, 'users');
      await assert.rejects(
        users.findUnique({ where: { email: 'Alice@Example.com' } }),
        /unique/,
        'rails: email is unique only through lower(email), so it must not identify one row',
      );
      const alice = await users.findUnique({ where: { id: 1 } });
      assert.equal(alice?.email, 'Alice@Example.com', 'rails: findUnique by the real primary key');
    } finally {
      await close();
    }
  });
});

// ---------------------------------------------------------------------------
// Django shape
// ---------------------------------------------------------------------------

corpus('django.sql', (get) => {
  it('reads pattern-ops indexes as plain non-unique column indexes', () => {
    const { schema } = get();
    for (const [tableName, indexName, col] of [
      ['auth_group', 'auth_group_name_like', 'name'],
      ['auth_user', 'auth_user_username_like', 'username'],
      ['blog_post', 'blog_post_slug_like', 'slug'],
    ] as const) {
      expectIndex(schema, tableName, indexName, { unique: false, columns: [col] });
      assert.match(indexOf(schema, tableName, indexName).definition, /varchar_pattern_ops/, `${indexName} opclass`);
    }
    expectUniqueKeys(schema, 'django_content_type', ['app_label+model', 'id']);
    expectUniqueKeys(schema, 'blog_post', ['id', 'slug+publish']);
    assert.deepEqual(tableOf(schema, 'django_session').primaryKey, ['session_key'], 'django_session PK');
  });

  it('keeps relations for deferrable foreign keys', () => {
    const { schema } = get();
    expectRelation(schema, 'auth_permission', 'djangoContentType', {
      type: 'belongsTo',
      to: 'django_content_type',
      foreignKey: 'content_type_id',
    });
    expectRelation(schema, 'blog_post', 'authUser', { type: 'belongsTo', to: 'auth_user', foreignKey: 'author_id' });
    expectRelation(schema, 'auth_user_groups', 'authUser', {
      type: 'belongsTo',
      to: 'auth_user',
      foreignKey: 'user_id',
    });
  });

  it('does not promote surrogate-keyed link tables to many-to-many', () => {
    const { schema } = get();
    for (const junction of ['auth_group_permissions', 'auth_user_groups', 'auth_user_user_permissions']) {
      expectNoManyToManyThrough(schema, junction);
      assert.deepEqual(tableOf(schema, junction).primaryKey, ['id'], `${junction} keeps its surrogate PK`);
    }
    const manyToMany = Object.values(schema.tables).flatMap((t) =>
      Object.entries(t.relations).filter(([, r]) => r.type === 'manyToMany'),
    );
    assert.deepEqual(manyToMany, [], 'django: no table pair here is a pure many-to-many');
    expectRelation(schema, 'auth_group', 'authUserGroups', {
      type: 'hasMany',
      to: 'auth_user_groups',
      foreignKey: 'group_id',
    });
  });
});

// ---------------------------------------------------------------------------
// Supabase-style shape (auth schema beside public)
// ---------------------------------------------------------------------------

corpus('supabase.sql', (get) => {
  it('introspects public only and binds no relation across the schema boundary', () => {
    const { schema } = get();
    assert.deepEqual(
      Object.keys(schema.tables).sort(),
      ['documents', 'profiles', 'team_members', 'teams', 'todos'],
      'supabase: public tables only (auth.users stays outside)',
    );
    for (const [tableName, t] of Object.entries(schema.tables)) {
      for (const [relationName, rel] of Object.entries(t.relations)) {
        const fk = Array.isArray(rel.foreignKey) ? rel.foreignKey : [rel.foreignKey];
        assert.ok(
          !fk.includes('owner_id'),
          `${tableName}.${relationName} must not bind the cross-schema owner_id FK to a public table`,
        );
      }
    }
    expectRelation(schema, 'todos', 'profile', { type: 'belongsTo', to: 'profiles', foreignKey: 'profile_id' });
  });

  it('distinguishes identity, uuid defaults and payload junctions', () => {
    const { schema } = get();
    expectSequenceDefault(schema, 'todos', 'id', true);
    assert.equal(columnOf(schema, 'todos', 'id').pgType, 'int8', 'todos identity type');
    const teamId = columnOf(schema, 'teams', 'id');
    assert.equal(teamId.hasDefault, true, 'teams.id has a gen_random_uuid() default');
    expectSequenceDefault(schema, 'teams', 'id', false);
    assert.deepEqual(tableOf(schema, 'team_members').primaryKey, ['team_id', 'profile_id'], 'team_members PK');
    expectNoManyToManyThrough(schema, 'team_members');
    expectRelation(schema, 'teams', 'teamMembers', { type: 'hasMany', to: 'team_members', foreignKey: 'team_id' });
    expectIndex(schema, 'documents', 'docs_search_gin', { unique: false, columns: ['search'] });
    expectIndex(schema, 'documents', 'docs_meta_gin', { unique: false, columns: ['metadata'] });
    assert.ok(
      (tableOf(schema, 'profiles').checks ?? []).some((c) => c.name === 'username_length'),
      'profiles keeps its named CHECK constraint',
    );
  });
});

// ---------------------------------------------------------------------------
// Multi-tenant SaaS index zoo
// ---------------------------------------------------------------------------

corpus('saas-indexes.sql', (get) => {
  it('keeps expression and partial uniques out of the unique-key set', () => {
    const { schema } = get();
    expectIndex(schema, 'users', 'users_tenant_lower_email_key', { unique: false, columns: ['tenant_id'] });
    expectIndex(schema, 'users', 'users_tenant_email_active_key', {
      unique: true,
      columns: ['tenant_id', 'email'],
      partial: true,
    });
    expectIndex(schema, 'users', 'users_one_owner_per_tenant', { unique: true, columns: ['tenant_id'], partial: true });
    expectIndex(schema, 'api_keys', 'api_keys_one_default', { unique: true, columns: ['tenant_id'], partial: true });
    expectUniqueKeys(schema, 'users', ['id']);
    expectUniqueKeys(schema, 'api_keys', ['id', 'token_hash']);
  });

  it('reads INCLUDE, ordering, access-method and exclusion indexes by their keys alone', () => {
    const { schema } = get();
    expectIndex(schema, 'users', 'users_id_include_email', { unique: true, columns: ['id'] });
    expectIndex(schema, 'users', 'users_recent_idx', {
      unique: false,
      columns: ['tenant_id', 'last_login_at', 'created_at'],
    });
    expectIndex(schema, 'users', 'users_email_hash', { unique: false, columns: ['email'] });
    expectIndex(schema, 'users', 'users_created_brin', { unique: false, columns: ['created_at'] });
    expectIndex(schema, 'users', 'users_settings_gin', { unique: false, columns: ['settings'] });
    expectIndex(schema, 'users', 'users_settings_path_gin', { unique: false, columns: ['settings'] });
    expectIndex(schema, 'users', 'users_deleted_partial_idx', {
      unique: false,
      columns: ['deleted_at'],
      partial: true,
    });
    expectIndex(schema, 'bookings', 'no_overlap', { unique: false, columns: ['room_id', 'during'] });
    expectUniqueKeys(schema, 'bookings', ['id']);
    expectUniqueKeys(schema, 'rooms', ['id', 'tenant_id+name']);
    expectUniqueKeys(schema, 'webhook_endpoints', ['id', 'tenant_id+url']);
    expectIndex(schema, 'webhook_endpoints', 'wh_events_gin', { unique: false, columns: ['events'] });
    expectSequenceDefault(schema, 'users', 'id', true);
    expectSequenceDefault(schema, 'tenants', 'id', false);
    assert.equal(columnOf(schema, 'tenants', 'id').hasDefault, true, 'tenants.id uuid default');
  });

  it('generated client typechecks strict and sweeps every relation', { timeout: 180_000 }, async () => {
    const ctx = get();
    const { client, close } = await generateTypecheckAndConnect('saas', ctx);
    try {
      await relationSweep('saas', ctx.schema, client, {
        api_keys: 2,
        bookings: 2,
        rooms: 2,
        tenants: 2,
        users: 3,
        webhook_endpoints: 1,
      });
      const users = accessorFor(client, 'users');
      await assert.rejects(
        users.findUnique({ where: { tenantId: '11111111-1111-4111-8111-111111111111' } }),
        /unique/,
        'saas: tenant alone is unique only partially and through lower(email), so it identifies nothing',
      );
      await assert.rejects(
        users.findUnique({ where: { tenantId: '11111111-1111-4111-8111-111111111111', email: 'Ada@Acme.example' } }),
        /unique/,
        'saas: (tenant, email) is unique only over non-deleted rows, so it identifies nothing table-wide',
      );
      const tenants = await accessorFor(client, 'tenants').findMany({
        with: { users: true },
        orderBy: { name: 'asc' },
      });
      assert.equal((tenants[0]!.users as Row[]).length, 2, 'saas: Acme has its two seeded users');
    } finally {
      await close();
    }
  });
});

// ---------------------------------------------------------------------------
// Partitioning, identity and generated columns
// ---------------------------------------------------------------------------

corpus('timeseries.sql', (get) => {
  it('lists partitioned parents with their partitions, each holding the declared PK', () => {
    const { schema } = get();
    assert.deepEqual(
      Object.keys(schema.tables).sort(),
      [
        'audit_log',
        'audit_log_p0',
        'audit_log_p1',
        'audit_log_p2',
        'audit_log_p3',
        'devices',
        'events',
        'events_eu',
        'events_other',
        'events_us',
        'metrics',
        'metrics_2026_01',
        'metrics_2026_02',
        'metrics_default',
        'readings',
      ],
      'timeseries: parents and partitions are all introspected tables',
    );
    for (const name of ['metrics', 'metrics_2026_01', 'metrics_2026_02', 'metrics_default']) {
      assert.deepEqual(tableOf(schema, name).primaryKey, ['device_id', 'ts', 'metric'], `${name} PK`);
    }
    assert.deepEqual(tableOf(schema, 'events').primaryKey, ['region', 'id'], 'events PK');
    assert.deepEqual(tableOf(schema, 'audit_log').primaryKey, ['id'], 'audit_log PK');
    expectIndex(schema, 'metrics', 'metrics_metric_ts_idx', { unique: false, columns: ['metric', 'ts'] });
  });

  it('reads identity columns as generated and STORED columns as computed', () => {
    const { schema } = get();
    expectSequenceDefault(schema, 'devices', 'id', true);
    expectSequenceDefault(schema, 'readings', 'id', true);
    expectSequenceDefault(schema, 'events', 'id', true);
    for (const [tableName, col] of [
      ['readings', 'fahrenheit'],
      ['metrics', 'value_x100'],
      ['events', 'payload_size'],
    ] as const) {
      assert.equal(
        columnOf(schema, tableName, col).isGeneratedStored,
        true,
        `${tableName}.${col} is a GENERATED ALWAYS AS ... STORED column`,
      );
    }
    expectRelation(schema, 'readings', 'device', { type: 'belongsTo', to: 'devices', foreignKey: 'device_id' });
    assert.deepEqual(
      Object.keys(tableOf(schema, 'metrics').relations),
      [],
      'metrics.device_id declares no foreign key, so it is not a relation',
    );
  });
});

// ---------------------------------------------------------------------------
// Awkward names
// ---------------------------------------------------------------------------

corpus('awkward-names.sql', (get) => {
  it('does not let index or column name text change an index meaning', () => {
    const { schema } = get();
    expectIndex(schema, 'weird', 'IDX_UNIQUE_kind', { unique: false, columns: ['kind'] });
    expectIndex(schema, 'weird', 'USING btree (kind)', { unique: true, columns: ['slug'] });
    expectIndex(schema, 'weird', 'weird_owner_unique', { unique: true, columns: ['owner_id DESC'] });
    expectIndex(schema, 'weird', 'weird_uniquecol_idx', { unique: false, columns: ['UNIQUE_col'] });
    expectIndex(schema, 'weird', 'weird_mixed_key', {
      unique: true,
      columns: ['MixedCase', 'dot.name'],
      partial: true,
    });
    expectUniqueKeys(schema, 'weird', ['id', 'owner_id DESC', 'slug']);
  });

  it('does not read a nextval mention inside a literal default as a sequence', () => {
    const { schema } = get();
    for (const col of ['notes', 'fakeseq']) {
      assert.equal(columnOf(schema, 'weird', col).hasDefault, true, `weird.${col} keeps its literal default`);
      expectSequenceDefault(schema, 'weird', col, false);
    }
    expectSequenceDefault(schema, 'weird', 'id', true);
  });

  it('keeps reserved-word relations and refuses to generate for non-identifier tables', () => {
    const { schema } = get();
    expectRelation(schema, 'records', 'userRel', { type: 'belongsTo', to: 'user', foreignKey: 'user' });
    expectRelation(schema, 'order', 'userRel', { type: 'belongsTo', to: 'user', foreignKey: 'user' });
    const root = mkdtempSync(join(REPO_ROOT, '.turbine-rw-awkward-'));
    try {
      assert.throws(
        () => generate({ schema, outDir: join(root, 'generated'), noTimestamp: true }),
        (err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          assert.match(msg, /E003/, 'refusal carries its error code');
          assert.match(msg, /not a valid TypeScript identifier/, 'refusal says why');
          assert.match(msg, /123numbers|Order Details/, 'refusal names an offending table');
          return true;
        },
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Type zoo
// ---------------------------------------------------------------------------

corpus('types.sql', (get) => {
  it('maps enums, enum arrays, extension and range types by their catalog types', () => {
    const { schema } = get();
    assert.deepEqual({ ...schema.enums }, { mood: ['sad', 'ok', 'happy'] }, 'types: enums');
    const cases: Array<[string, string]> = [
      ['current_mood', 'mood'],
      ['mood_history', '_mood'],
      ['email', 'citext'],
      ['attrs', 'hstore'],
      ['favorite', 'inventory_item'],
      ['availability', 'daterange'],
      ['prices', 'numrange'],
      ['tags', '_text'],
      ['matrix', '_int4'],
      ['uuids', '_uuid'],
      ['birth_year', 'int4'],
    ];
    for (const [col, pgType] of cases) {
      assert.equal(columnOf(schema, 'persons', col).pgType, pgType, `persons.${col} catalog type`);
    }
    for (const col of ['mood_history', 'tags', 'matrix', 'uuids']) {
      assert.equal(columnOf(schema, 'persons', col).isArray, true, `persons.${col} is an array column`);
    }
    expectIndex(schema, 'persons', 'persons_moods_gin', { unique: false, columns: ['mood_history'] });
    expectIndex(schema, 'persons', 'persons_attrs_gin', { unique: false, columns: ['attrs'] });
    expectIndex(schema, 'persons', 'persons_email_key', { unique: true, columns: ['email'] });
  });

  it('reads shared, renamed and width serial sequences as generated, literal nextval text as not', () => {
    const { schema } = get();
    for (const tableName of ['shared_a', 'shared_b', 'renamed_t', 'smalls', 'bigs', 'serials']) {
      assert.equal(columnOf(schema, tableName, 'id').hasDefault, true, `${tableName}.id has its sequence default`);
      expectSequenceDefault(schema, tableName, 'id', true);
    }
    assert.equal(columnOf(schema, 'smalls', 'id').pgType, 'int2', 'smallserial width');
    assert.equal(columnOf(schema, 'bigs', 'id').pgType, 'int8', 'bigserial width');
    for (const col of ['fake_default', 'fake_default2', 'doc']) {
      assert.equal(columnOf(schema, 'persons', col).hasDefault, true, `persons.${col} keeps its default`);
      expectSequenceDefault(schema, 'persons', col, false);
    }
    assert.equal(columnOf(schema, 'persons', 'real_next').hasDefault, false, 'persons.real_next has no default at all');
    const checkNames = (tableOf(schema, 'persons').checks ?? []).map((c) => c.name).sort();
    assert.deepEqual(checkNames, ['mood_check', 'spaced_check'], 'persons named CHECK constraints');
  });
});

// ---------------------------------------------------------------------------
// Relation shapes
// ---------------------------------------------------------------------------

corpus('relations.sql', (get) => {
  it('names self-references, paired FKs, and unique-non-PK references', () => {
    const { schema } = get();
    expectRelation(schema, 'categories', 'category', { type: 'belongsTo', to: 'categories', foreignKey: 'parent_id' });
    expectRelation(schema, 'categories', 'categories', { type: 'hasMany', to: 'categories', foreignKey: 'parent_id' });
    expectRelation(schema, 'messages', 'sender', { type: 'belongsTo', to: 'users', foreignKey: 'sender_id' });
    expectRelation(schema, 'messages', 'recipient', { type: 'belongsTo', to: 'users', foreignKey: 'recipient_id' });
    expectRelation(schema, 'users', 'messagesBySender', { type: 'hasMany', to: 'messages', foreignKey: 'sender_id' });
    expectRelation(schema, 'users', 'messagesByRecipient', {
      type: 'hasMany',
      to: 'messages',
      foreignKey: 'recipient_id',
    });
    expectRelation(schema, 'invitations', 'inviteeEmailRel', {
      type: 'belongsTo',
      to: 'users',
      foreignKey: 'invitee_email',
      referenceKey: 'email',
    });
    expectRelation(schema, 'matches', 'matchesHomeLeagueHomeTeam', {
      type: 'belongsTo',
      to: 'league_teams',
      foreignKey: ['home_league', 'home_team'],
      referenceKey: ['league', 'team'],
    });
    expectRelation(schema, 'league_teams', 'matchesByMatchesAwayLeagueAwayTeam', {
      type: 'hasMany',
      to: 'matches',
      foreignKey: ['away_league', 'away_team'],
      referenceKey: ['league', 'team'],
    });
  });

  it('reads unique foreign keys as one-to-one on the parent side', () => {
    const { schema } = get();
    expectRelation(schema, 'users', 'profile', { type: 'hasOne', to: 'profiles', foreignKey: 'user_id' });
    expectRelation(schema, 'users', 'userSetting', { type: 'hasOne', to: 'user_settings', foreignKey: 'user_id' });
    assert.deepEqual(tableOf(schema, 'user_settings').primaryKey, ['user_id'], 'shared-PK one-to-one PK');
    expectRelation(schema, 'users', 'coupleByPartnerA', { type: 'hasOne', to: 'couples', foreignKey: 'partner_a_id' });
    expectRelation(schema, 'users', 'coupleByPartnerB', { type: 'hasOne', to: 'couples', foreignKey: 'partner_b_id' });
  });

  it('detects many-to-many only on the pure junction, not on payload, surrogate or partial junctions', () => {
    const { schema } = get();
    expectRelation(schema, 'users', 'tags', {
      type: 'manyToMany',
      to: 'tags',
      through: { table: 'user_tags', sourceKey: 'user_id', targetKey: 'tag_id' },
    });
    expectRelation(schema, 'tags', 'users', {
      type: 'manyToMany',
      to: 'users',
      through: { table: 'user_tags', sourceKey: 'tag_id', targetKey: 'user_id' },
    });
    expectNoManyToManyThrough(schema, 'enrollments');
    expectNoManyToManyThrough(schema, 'follows');
    expectNoManyToManyThrough(schema, 'flag_links');
    assert.deepEqual(Object.keys(tableOf(schema, 'students').relations), ['enrollments'], 'students relations');
    assert.deepEqual(Object.keys(tableOf(schema, 'courses').relations), ['enrollments'], 'courses relations');
    assert.deepEqual(tableOf(schema, 'enrollments').primaryKey, ['student_id', 'course_id'], 'enrollments PK');
    expectIndex(schema, 'flag_links', 'flag_links_pair_partial_key', {
      unique: true,
      columns: ['user_id', 'tag_id'],
      partial: true,
    });
    expectUniqueKeys(schema, 'flag_links', []);
    expectRelation(schema, 'users', 'flagLinks', { type: 'hasMany', to: 'flag_links', foreignKey: 'user_id' });
  });

  it('generated client typechecks strict and sweeps every relation', { timeout: 180_000 }, async () => {
    const ctx = get();
    const { client, close } = await generateTypecheckAndConnect('relations', ctx);
    try {
      await relationSweep('relations', ctx.schema, client, {
        categories: 4,
        countries: 2,
        couples: 1,
        courses: 2,
        enrollments: 3,
        flag_links: 2,
        follows: 3,
        invitations: 1,
        league_teams: 3,
        matches: 1,
        messages: 2,
        profiles: 2,
        students: 2,
        tags: 2,
        user_settings: 1,
        user_tags: 3,
        users: 3,
      });
      const users = accessorFor(client, 'users');
      const ada = await users.findUnique({ where: { ssn: '111' }, with: { tags: true, profile: true } });
      assert.equal(ada?.email, 'ada@example.com', 'relations: findUnique by a unique non-PK column');
      assert.deepEqual(
        (ada!.tags as Row[]).map((t) => t.name).sort(),
        ['admin', 'beta'],
        'relations: pure-junction many-to-many rows',
      );
      assert.equal((ada?.profile as Row | null)?.bio, 'bio a', 'relations: hasOne profile row');
      const roots = await accessorFor(client, 'categories').findMany({
        where: { name: 'root' },
        with: { categories: true },
      });
      assert.equal((roots[0]!.categories as Row[]).length, 2, 'relations: self-referencing tree children');
    } finally {
      await close();
    }
  });
});

// ---------------------------------------------------------------------------
// Tables literally named `records` and `dates`
// ---------------------------------------------------------------------------

describe('real-world corpus: records and dates', { skip: SKIP_ON_COCKROACH }, () => {
  const dbName = `turbine_rw_records_dates_${SUFFIX}`;
  let ctx: CorpusContext | undefined;

  before(async () => {
    await withAdmin(async (admin) => {
      await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
      await admin.query(`CREATE DATABASE ${dbName}`);
    });
    const url = urlForDb(dbName);
    const pool = new pg.Pool({ connectionString: url, max: 1 });
    try {
      await pool.query(`
        CREATE TABLE records (id serial PRIMARY KEY, recorded_on date, payload jsonb,
          created_at timestamptz NOT NULL DEFAULT now());
        CREATE TABLE dates (id serial PRIMARY KEY, record_id int REFERENCES records(id),
          on_date date NOT NULL, label text);
        INSERT INTO records (recorded_on, payload) VALUES ('2026-01-01', '{"a": 1}'), ('2026-01-02', NULL);
        INSERT INTO dates (record_id, on_date, label) VALUES (1, '2026-02-01', 'x'), (1, '2026-02-02', 'y'), (2, '2026-02-03', 'z');
      `);
    } finally {
      await pool.end();
    }
    ctx = { url, schema: await introspect({ connectionString: url, schema: 'public', logger: {} }) };
  });

  after(async () => {
    await withAdmin(async (admin) => {
      await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    });
  });

  it('generates a client whose Record and Date entity names keep the built-in types', {
    timeout: 180_000,
  }, async () => {
    assert.ok(ctx, 'records/dates corpus was not loaded');
    // The typecheck inside generateTypecheckAndConnect is the assertion:
    // with the entity types named Record and Date, a generated file that
    // leaves bare `Record<...>` or `Date` meaning the global fails
    // `tsc --strict --skipLibCheck false` (TS2315 / wrong-type) outright.
    const { client, close } = await generateTypecheckAndConnect('records-dates', ctx);
    try {
      await relationSweep('records-dates', ctx.schema, client, { dates: 3, records: 2 });
      const rows = await accessorFor(client, 'records').findMany({ with: { dates: true }, orderBy: { id: 'asc' } });
      assert.equal((rows[0]!.dates as Row[]).length, 2, 'records: nested dates read through the generated client');
      assert.ok(rows[0]?.recordedOn instanceof Date, 'records: a date column still reads as a real Date');
    } finally {
      await close();
    }
  });
});
