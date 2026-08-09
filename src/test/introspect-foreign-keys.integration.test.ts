/**
 * turbine-orm - foreign-key introspection against a live catalog (DATABASE_URL-gated).
 *
 * The FK reader used to join information_schema.key_column_usage to
 * constraint_column_usage on the constraint NAME, which is wrong in two ways
 * that only a real catalog exposes (a mock schema cannot reproduce either):
 *
 *   1. The constrained and referenced column lists have no positional link in
 *      information_schema, so a COMPOSITE foreign key came back as an N-by-N
 *      cross product. `cities(country, region_code) -> regions(country, code)`
 *      produced foreignKey ['country','country','region_code','region_code']
 *      against referenceKey ['country','code','country','code'], two of the
 *      four correlations pairing the wrong columns, so every read through the
 *      relation returned nothing and every relation filter matched nothing.
 *   2. Postgres only requires a constraint name to be unique per TABLE, so two
 *      tables in one schema may share one. Joining on the name crossed them:
 *      one table lost its FK and the other got a target column that does not
 *      exist on its table. A same-named constraint in ANOTHER schema deleted
 *      relations outright.
 *
 * Each test builds its own throwaway schema, so it is independent of whatever
 * fixture the ambient DATABASE_URL is seeded with.
 *
 * Run: DATABASE_URL=postgres://... tsx --test src/test/introspect-foreign-keys.integration.test.ts
 */

import assert from 'node:assert/strict';
import { describe } from 'node:test';
import pg from 'pg';
import { introspect } from '../introspect.js';
import { skipGate } from './helpers.js';

const DATABASE_URL = process.env.DATABASE_URL;
const { it, before, after } = skipGate(!DATABASE_URL, 'requires DATABASE_URL');

/**
 * Point a connection string at one schema via the `options` CONNECTION
 * PARAMETER. The compact `-cname=value` spelling avoids a space, which
 * URLSearchParams would encode as `+` and Postgres would then read as part of
 * the flag.
 */
function withSearchPath(url: string, schemaName: string): string {
  const u = new URL(url);
  u.searchParams.set('options', `-csearch_path=${schemaName}`);
  return u.toString();
}

/** Unique-per-run schema names so a leftover from a crashed run never collides. */
const SUFFIX = `${process.pid}_${Date.now().toString(36)}`;
const MAIN_SCHEMA = `turbine_fk_${SUFFIX}`;
const OTHER_SCHEMA = `turbine_fk_other_${SUFFIX}`;

const SETUP_SQL = `
  CREATE SCHEMA ${MAIN_SCHEMA};
  CREATE SCHEMA ${OTHER_SCHEMA};

  -- (1) composite FK, deliberately with one shared column NAME on both sides
  -- (country) and one differing pair (region_code -> code): a cross product is
  -- indistinguishable from correct pairing when every name matches.
  CREATE TABLE ${MAIN_SCHEMA}.regions (
    country text NOT NULL,
    code text NOT NULL,
    label text,
    PRIMARY KEY (country, code)
  );
  CREATE TABLE ${MAIN_SCHEMA}.cities (
    id serial PRIMARY KEY,
    name text,
    country text,
    region_code text,
    CONSTRAINT cities_region_fkey FOREIGN KEY (country, region_code)
      REFERENCES ${MAIN_SCHEMA}.regions (country, code) ON DELETE CASCADE
  );
  INSERT INTO ${MAIN_SCHEMA}.regions VALUES ('US', 'CA', 'California');
  INSERT INTO ${MAIN_SCHEMA}.cities (name, country, region_code) VALUES ('SF', 'US', 'CA');

  -- (2) two tables in ONE schema sharing a constraint name.
  CREATE TABLE ${MAIN_SCHEMA}.tags (id serial PRIMARY KEY, label text);
  CREATE TABLE ${MAIN_SCHEMA}.authors (id serial PRIMARY KEY, label text);
  CREATE TABLE ${MAIN_SCHEMA}.articles (
    id serial PRIMARY KEY,
    tag_id integer,
    CONSTRAINT shared_fk FOREIGN KEY (tag_id) REFERENCES ${MAIN_SCHEMA}.tags (id)
  );
  CREATE TABLE ${MAIN_SCHEMA}.notes (
    id serial PRIMARY KEY,
    author_id integer,
    CONSTRAINT shared_fk FOREIGN KEY (author_id) REFERENCES ${MAIN_SCHEMA}.authors (id) ON DELETE SET NULL
  );

  -- (3) a constraint in ANOTHER schema, reusing a name from this one AND
  -- referencing back into this one. information_schema's constraint_column_usage
  -- reports the REFERENCED table's schema, so this row joined onto the local
  -- constraint of the same name and contributed a second, foreign target.
  CREATE TABLE ${MAIN_SCHEMA}.products (
    id serial PRIMARY KEY,
    tag_id integer,
    CONSTRAINT products_ref_fkey FOREIGN KEY (tag_id) REFERENCES ${MAIN_SCHEMA}.tags (id)
  );
  CREATE TABLE ${OTHER_SCHEMA}.things (id serial PRIMARY KEY);
  CREATE TABLE ${OTHER_SCHEMA}.audit (
    id serial PRIMARY KEY,
    author_id integer,
    CONSTRAINT products_ref_fkey FOREIGN KEY (author_id) REFERENCES ${MAIN_SCHEMA}.authors (id)
  );

  -- (4) a reference OUT of the introspected schema.
  CREATE TABLE ${MAIN_SCHEMA}.link_refs (
    id serial PRIMARY KEY,
    thing_id integer REFERENCES ${OTHER_SCHEMA}.things (id)
  );
`;

describe('foreign-key introspection (live catalog)', () => {
  let pool: pg.Pool;
  let schema: Awaited<ReturnType<typeof introspect>>;

  before(async () => {
    pool = new pg.Pool({ connectionString: DATABASE_URL!, max: 1 });
    await pool.query(SETUP_SQL);
    schema = await introspect({ connectionString: DATABASE_URL!, schema: MAIN_SCHEMA });
  });

  after(async () => {
    if (!pool) return;
    await pool.query(`DROP SCHEMA IF EXISTS ${MAIN_SCHEMA} CASCADE`);
    await pool.query(`DROP SCHEMA IF EXISTS ${OTHER_SCHEMA} CASCADE`);
    await pool.end();
  });

  it('pairs a composite FK positionally instead of cross-joining it', () => {
    const rel = schema.tables.cities?.relations.region;
    assert.ok(
      rel,
      `expected a belongsTo relation on cities, got ${Object.keys(schema.tables.cities?.relations ?? {})}`,
    );
    assert.equal(rel.type, 'belongsTo');
    assert.equal(rel.to, 'regions');
    // Exactly TWO correlations, in declaration order, each pairing its own column.
    assert.deepEqual(rel.foreignKey, ['country', 'region_code']);
    assert.deepEqual(rel.referenceKey, ['country', 'code']);
  });

  it('carries the composite FK reverse relation with the same pairing', () => {
    const reverse = schema.tables.regions?.relations.cities;
    assert.ok(reverse, 'expected a hasMany relation on regions');
    assert.deepEqual(reverse.foreignKey, ['country', 'region_code']);
    assert.deepEqual(reverse.referenceKey, ['country', 'code']);
  });

  it('reads a composite relation back through a real query', async () => {
    // The end that mattered: with the mispaired correlations this returned
    // region: null even though the row genuinely matches. The generated SQL is
    // unqualified, so the client reaches the fixture schema through a
    // search_path CONNECTION PARAMETER (never a post-checkout SET, which would
    // poison a shared backend behind a pooler).
    const { TurbineClient } = await import('../client.js');
    const db = new TurbineClient({ connectionString: withSearchPath(DATABASE_URL!, MAIN_SCHEMA) }, schema);
    try {
      const rows = await db.table<{ id: number; name: string }>('cities').findMany({ with: { region: true } });
      assert.equal(rows.length, 1);
      const region = (rows[0] as unknown as { region: { label: string } | null }).region;
      assert.ok(region, 'expected the composite relation to resolve to a region row');
      assert.equal(region.label, 'California');

      const parents = await db.table<{ country: string }>('regions').findMany({ with: { cities: true } });
      const cities = (parents[0] as unknown as { cities: Array<{ name: string }> }).cities;
      assert.equal(cities.length, 1);
      assert.equal(cities[0]?.name, 'SF');

      // And through a relation filter, which builds its own correlation.
      const filtered = await db
        .table<{ country: string }>('regions')
        .findMany({ where: { cities: { some: { name: 'SF' } } } });
      assert.equal(filtered.length, 1);
    } finally {
      await db.disconnect();
    }
  });

  it('keeps both FKs when two tables in one schema share a constraint name', () => {
    const articles = schema.tables.articles?.relations;
    const notes = schema.tables.notes?.relations;
    assert.ok(articles?.tag, `articles lost its FK: ${Object.keys(articles ?? {})}`);
    assert.equal(articles.tag.to, 'tags');
    assert.equal(articles.tag.foreignKey, 'tag_id');
    assert.equal(articles.tag.referenceKey, 'id');

    assert.ok(notes?.author, `notes lost its FK: ${Object.keys(notes ?? {})}`);
    assert.equal(notes.author.to, 'authors');
    assert.equal(notes.author.foreignKey, 'author_id');
    assert.equal(notes.author.referenceKey, 'id');
  });

  it('attributes referential actions per constraint, not per shared name', () => {
    // Both constraints are named `shared_fk`; only the one on notes is SET NULL.
    assert.equal(schema.tables.notes?.relations.author?.onDelete, 'set null');
    assert.equal(schema.tables.articles?.relations.tag?.onDelete, undefined);
    // And the composite FK's CASCADE survives the OID-keyed lookup.
    assert.equal(schema.tables.cities?.relations.region?.onDelete, 'cascade');
  });

  it('ignores a same-named constraint in another schema that points back into this one', () => {
    // OTHER_SCHEMA.audit also declares `products_ref_fkey`, referencing
    // MAIN.authors. Its referenced table lives in THIS schema, so the old
    // name-keyed join accepted it as a second target for products' own
    // constraint: the relation came back with a duplicated correlation
    // (['tag_id','tag_id']) or pointed at authors outright.
    const rel = schema.tables.products?.relations.tag;
    assert.ok(rel, `products lost its FK: ${Object.keys(schema.tables.products?.relations ?? {})}`);
    assert.equal(rel.to, 'tags');
    assert.equal(rel.foreignKey, 'tag_id', 'a single-column FK must stay a string, not a duplicated array');
    assert.equal(rel.referenceKey, 'id');
    // The foreign table itself never becomes a relation target here.
    assert.equal(Object.keys(schema.tables).includes('audit'), false);
  });

  it('emits no relation for a reference to a table outside the introspected schema', () => {
    const refs = schema.tables.link_refs?.relations ?? {};
    assert.deepEqual(Object.keys(refs), [], 'a cross-schema FK must not bind to a table in this schema');
  });
});

// ---------------------------------------------------------------------------
// Determinism: introspection is a function of the schema, not of its history
// ---------------------------------------------------------------------------

const ORDER_A_SCHEMA = `turbine_fk_ord_a_${SUFFIX}`;
const ORDER_B_SCHEMA = `turbine_fk_ord_b_${SUFFIX}`;

/**
 * The same logical schema, with the two foreign keys added in OPPOSITE orders.
 *
 * `users` gets two children that both derive the relation name `profile`: a
 * `profiles` child whose FK column is UNIQUE (so the reverse side is `hasOne`,
 * named with the singular of the child table) and a `profile` child with a plain
 * FK (so the reverse side is `hasMany`, named after the child table). Relation
 * naming walks the FK list accumulating taken names, so whichever FK is walked
 * first WINS the contested name and the other is suffixed `Rel`.
 *
 * Creating the tables in one statement batch and the constraints in the other
 * order is what makes the two schemas differ ONLY in constraint OID allocation
 * order, which is what the introspector used to sort by.
 */
const orderedSetup = (schemaName: string, fkOrder: 'unique-first' | 'plain-first') => {
  const fkProfiles = `ALTER TABLE ${schemaName}.profiles ADD CONSTRAINT profiles_user_id_fkey
      FOREIGN KEY (user_id) REFERENCES ${schemaName}.users (id);`;
  const fkProfile = `ALTER TABLE ${schemaName}.profile ADD CONSTRAINT profile_user_id_fkey
      FOREIGN KEY (user_id) REFERENCES ${schemaName}.users (id);`;
  return `
    CREATE SCHEMA ${schemaName};
    CREATE TABLE ${schemaName}.users (id bigserial PRIMARY KEY);
    CREATE TABLE ${schemaName}.profiles (id bigserial PRIMARY KEY, user_id bigint NOT NULL UNIQUE);
    CREATE TABLE ${schemaName}.profile (id bigserial PRIMARY KEY, user_id bigint NOT NULL);
    ${fkOrder === 'unique-first' ? fkProfiles + fkProfile : fkProfile + fkProfiles}
  `;
};

/**
 * Replace the schema's own name wherever it appears in a string, so two
 * introspections of the same logical schema under DIFFERENT schema names can be
 * compared as wholes. `IndexMetadata.definition` is the raw `pg_indexes.indexdef`
 * and therefore carries the schema name verbatim; that difference is an artifact
 * of how this test expresses "the same schema twice", not a determinism defect.
 * Recurses through Sets because `dateColumns` is one.
 */
function normalizeSchemaNames<T>(value: T, schemaName: string): T {
  const scrub = (v: unknown): unknown => {
    if (typeof v === 'string') return v.split(schemaName).join('<schema>');
    if (v instanceof Set) return new Set([...v].map(scrub));
    if (Array.isArray(v)) return v.map(scrub);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, scrub(x)]));
    return v;
  };
  return scrub(value) as T;
}

describe('foreign-key introspection is independent of object creation order', () => {
  let pool: pg.Pool;
  let a: Awaited<ReturnType<typeof introspect>>;
  let b: Awaited<ReturnType<typeof introspect>>;

  before(async () => {
    pool = new pg.Pool({ connectionString: DATABASE_URL!, max: 1 });
    await pool.query(orderedSetup(ORDER_A_SCHEMA, 'unique-first'));
    await pool.query(orderedSetup(ORDER_B_SCHEMA, 'plain-first'));
    a = await introspect({ connectionString: DATABASE_URL!, schema: ORDER_A_SCHEMA });
    b = await introspect({ connectionString: DATABASE_URL!, schema: ORDER_B_SCHEMA });
  });

  after(async () => {
    if (!pool) return;
    await pool.query(`DROP SCHEMA IF EXISTS ${ORDER_A_SCHEMA} CASCADE`);
    await pool.query(`DROP SCHEMA IF EXISTS ${ORDER_B_SCHEMA} CASCADE`);
    await pool.end();
  });

  /**
   * THE determinism guarantee, stated at the top level: the same logical schema
   * introspects to the same metadata whichever order it was built in. Ordering
   * the catalog read by `con.oid` broke it, because an OID is allocation order,
   * so a database restored from a dump disagreed with one built by replaying the
   * migrations. Deep-equal over the WHOLE object rather than over the relation
   * names, since the same defect also permuted `indexes` and `checks`.
   */
  it('produces deep-equal metadata for both foreign-key creation orders', () => {
    assert.deepStrictEqual(
      normalizeSchemaNames(a.tables, ORDER_A_SCHEMA),
      normalizeSchemaNames(b.tables, ORDER_B_SCHEMA),
    );
    assert.deepStrictEqual(a.enums, b.enums);
  });

  /**
   * And the concrete consequence, spelled out. Under the old ordering, order A
   * resolved `users.profile` to a hasOne on `profiles` while order B resolved
   * the SAME name to a hasMany on `profile`: `with: { profile: true }` read a
   * different table and returned a different shape depending on how the database
   * had been built. Whichever name wins, both schemas must agree.
   */
  it('resolves the contested relation name to the same table and cardinality', () => {
    for (const [label, meta] of [
      ['order A', a],
      ['order B', b],
    ] as const) {
      const users = meta.tables.users?.relations ?? {};
      assert.equal(users.profile?.type, 'hasMany', `${label}: users.profile cardinality`);
      assert.equal(users.profile?.to, 'profile', `${label}: users.profile target table`);
      assert.equal(users.profiles?.type, 'hasOne', `${label}: users.profiles cardinality`);
      assert.equal(users.profiles?.to, 'profiles', `${label}: users.profiles target table`);
    }
  });
});

// ---------------------------------------------------------------------------
// Partitioned tables: one declared FK is one relation
// ---------------------------------------------------------------------------

const PART_SCHEMA = `turbine_fk_part_${SUFFIX}`;

/**
 * Declaring ONE foreign key against a partitioned table makes Postgres
 * materialize an extra `pg_constraint` row per partition, each pointing at that
 * partition instead of at the parent and each carrying a non-zero `conparentid`.
 * Read without that filter they introspected as extra belongsTo relations
 * (`bucketsLo`, `bucketsHi` alongside the real `bucket`), fully generated and
 * autocompleting, each resolving to `null` for every row whose parent lives in
 * the other partition.
 */
const PART_SETUP_SQL = `
  CREATE SCHEMA ${PART_SCHEMA};
  CREATE TABLE ${PART_SCHEMA}.buckets (
    id bigint NOT NULL,
    kind text NOT NULL,
    PRIMARY KEY (id, kind)
  ) PARTITION BY LIST (kind);
  CREATE TABLE ${PART_SCHEMA}.buckets_lo PARTITION OF ${PART_SCHEMA}.buckets FOR VALUES IN ('lo');
  CREATE TABLE ${PART_SCHEMA}.buckets_hi PARTITION OF ${PART_SCHEMA}.buckets FOR VALUES IN ('hi');
  CREATE TABLE ${PART_SCHEMA}.items (
    id bigserial PRIMARY KEY,
    bucket_id bigint NOT NULL,
    bucket_kind text NOT NULL,
    CONSTRAINT items_bucket_fkey FOREIGN KEY (bucket_id, bucket_kind)
      REFERENCES ${PART_SCHEMA}.buckets (id, kind)
  );
`;

describe('foreign-key introspection of a partitioned target table', () => {
  let pool: pg.Pool;
  let schema: Awaited<ReturnType<typeof introspect>>;

  before(async () => {
    pool = new pg.Pool({ connectionString: DATABASE_URL!, max: 1 });
    await pool.query(PART_SETUP_SQL);
    schema = await introspect({ connectionString: DATABASE_URL!, schema: PART_SCHEMA });
  });

  after(async () => {
    if (!pool) return;
    await pool.query(`DROP SCHEMA IF EXISTS ${PART_SCHEMA} CASCADE`);
    await pool.end();
  });

  it('emits exactly one relation per declared foreign key', () => {
    const rels = schema.tables.items?.relations ?? {};
    assert.deepEqual(
      Object.keys(rels).sort(),
      ['bucket'],
      'one declared FK to a 2-partition table must not introspect as three relations',
    );
    assert.equal(rels.bucket?.type, 'belongsTo');
    assert.equal(rels.bucket?.to, 'buckets', 'the relation targets the PARENT, never a partition');
    assert.deepEqual(rels.bucket?.foreignKey, ['bucket_id', 'bucket_kind']);
    assert.deepEqual(rels.bucket?.referenceKey, ['id', 'kind']);
  });

  it('gives the partitions themselves no phantom reverse relation', () => {
    // The clone constraints named `buckets_lo` / `buckets_hi` as targets, so the
    // partitions picked up reverse relations to `items` that the declared schema
    // never asked for.
    assert.deepEqual(Object.keys(schema.tables.buckets_lo?.relations ?? {}), []);
    assert.deepEqual(Object.keys(schema.tables.buckets_hi?.relations ?? {}), []);
    assert.equal(schema.tables.buckets?.relations.items?.type, 'hasMany');
  });
});
