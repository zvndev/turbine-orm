/**
 * turbine-orm - schemaDiff column-type comparison and schema scoping.
 *
 * Three regressions, one pure suite plus one live suite:
 *
 *   1. `schemaDiff` hardcoded the `public` namespace in all eight of its
 *      catalog reads while every other command honored the configured schema.
 *      Against a table in `app` the diff saw nothing and emitted CREATE TABLE
 *      (a duplicate in public); with a legacy copy still sitting in public it
 *      read THAT one and emitted ALTER / DROP COLUMN against the wrong table.
 *   2. The type check compared `udt_name` only, so `varchar(10)` against a
 *      database `VARCHAR(255)` produced no statement and no warning: push
 *      reported "already in sync" for a schema that genuinely differed.
 *   3. The emitted statement always carried `USING col::type`. An EXPLICIT cast
 *      to `varchar(n)` TRUNCATES, where the plain assignment cast raises
 *      "value too long" and stops the migration. The generated USING turned
 *      Postgres's own refusal into silent data amputation.
 *
 * The live half needs DATABASE_URL and builds its own throwaway schemas.
 *
 * Run: DATABASE_URL=postgres://... tsx --test src/test/schema-diff-types.test.ts
 */

import assert from 'node:assert/strict';
import { it as always, describe } from 'node:test';
import pg from 'pg';
import { defineSchema } from '../schema-builder.js';
import { type DbColumnType, planTypeChange, schemaDiff, schemaPush } from '../schema-sql.js';
import { skipGate } from './helpers.js';

const DATABASE_URL = process.env.DATABASE_URL;
const { it, before, after } = skipGate(!DATABASE_URL, 'requires DATABASE_URL');

/** A ColumnConfig as `defineSchema` produces it, for the pure planner tests. */
function column(overrides: Record<string, unknown>) {
  const def = defineSchema({ t: { c: { type: 'text', ...overrides } as never } });
  return def.tables.t!.columns.c!;
}

function dbCol(overrides: Partial<DbColumnType> & { udtName: string }): DbColumnType {
  return { maxLength: null, numericPrecision: null, numericScale: null, formattedType: null, ...overrides };
}

// ---------------------------------------------------------------------------
// planTypeChange (pure)
// ---------------------------------------------------------------------------

describe('planTypeChange: length and precision', () => {
  always('sees a VARCHAR length NARROWING that udt_name comparison missed', () => {
    const plan = planTypeChange(
      column({ type: 'varchar', maxLength: 10 }),
      dbCol({ udtName: 'varchar', maxLength: 255 }),
      'nick',
    );
    assert.equal(plan.kind, 'alter');
    assert.equal(plan.kind === 'alter' && plan.needsUsing, false);
    assert.match(plan.kind === 'alter' ? (plan.loss ?? '') : '', /longer than 10 characters/);
    assert.match(plan.kind === 'alter' ? (plan.loss ?? '') : '', /FAIL/);
  });

  always('sees a VARCHAR length WIDENING (the "value too long at runtime" direction)', () => {
    const plan = planTypeChange(
      column({ type: 'varchar', maxLength: 255 }),
      dbCol({ udtName: 'varchar', maxLength: 10 }),
      'nick',
    );
    assert.equal(plan.kind, 'alter');
    // Widening loses nothing, so no loss sentence.
    assert.equal(plan.kind === 'alter' ? plan.loss : 'x', undefined);
  });

  always('treats an unbounded declared VARCHAR against a bounded column as a change', () => {
    const plan = planTypeChange(column({ type: 'varchar' }), dbCol({ udtName: 'varchar', maxLength: 50 }), 'nick');
    assert.equal(plan.kind, 'alter');
  });

  always('emits nothing when the VARCHAR lengths agree', () => {
    assert.equal(
      planTypeChange(column({ type: 'varchar', maxLength: 50 }), dbCol({ udtName: 'varchar', maxLength: 50 }), 'nick')
        .kind,
      'none',
    );
    assert.equal(
      planTypeChange(column({ type: 'varchar' }), dbCol({ udtName: 'varchar', maxLength: null }), 'nick').kind,
      'none',
    );
  });

  always('WARNS on numeric precision instead of rewriting away a constraint it cannot declare', () => {
    const plan = planTypeChange(
      column({ type: 'numeric' }),
      dbCol({ udtName: 'numeric', numericPrecision: 4, numericScale: 2 }),
      'price',
    );
    assert.equal(plan.kind, 'warn');
    assert.match(plan.kind === 'warn' ? plan.reason : '', /numeric\(4, 2\)/);
  });

  always('does not mistake an integer type for a declared numeric precision', () => {
    // information_schema reports numeric_precision 32 for int4; that is not a
    // modifier anyone wrote, and diffing it would emit churn on every push.
    assert.equal(
      planTypeChange(
        column({ type: 'integer' }),
        dbCol({ udtName: 'int4', numericPrecision: 32, numericScale: 0 }),
        'n',
      ).kind,
      'none',
    );
  });
});

describe('planTypeChange: USING is only for casts that need one', () => {
  always('omits USING within the string family', () => {
    const plan = planTypeChange(column({ type: 'varchar', maxLength: 10 }), dbCol({ udtName: 'text' }), 'nick');
    assert.equal(plan.kind === 'alter' && plan.needsUsing, false);
  });

  always('omits USING within the numeric family, and names the rounding', () => {
    const plan = planTypeChange(column({ type: 'integer' }), dbCol({ udtName: 'numeric' }), 'qty');
    assert.equal(plan.kind === 'alter' && plan.needsUsing, false);
    assert.match(plan.kind === 'alter' ? (plan.loss ?? '') : '', /ROUNDED/);
  });

  always('omits USING within the temporal family, and names the dropped time', () => {
    const plan = planTypeChange(column({ type: 'date' }), dbCol({ udtName: 'timestamptz' }), 'day');
    assert.equal(plan.kind === 'alter' && plan.needsUsing, false);
    assert.match(plan.kind === 'alter' ? (plan.loss ?? '') : '', /time-of-day component .* DROPPED/);
  });

  always('KEEPS USING when the conversion crosses type families', () => {
    const plan = planTypeChange(column({ type: 'uuid' }), dbCol({ udtName: 'text' }), 'id');
    assert.equal(plan.kind === 'alter' && plan.needsUsing, true);
  });

  always('KEEPS USING for an enum target', () => {
    const plan = planTypeChange(column({ type: 'enum', enumName: 'role' }), dbCol({ udtName: 'text' }), 'role');
    assert.equal(plan.kind === 'alter' && plan.needsUsing, true);
  });

  always('never touches a serial column', () => {
    assert.equal(planTypeChange(column({ type: 'serial' }), dbCol({ udtName: 'int8' }), 'id').kind, 'none');
  });
});

// ---------------------------------------------------------------------------
// Modifiers information_schema cannot report: an array element's length and a
// pgvector dimension count. Both read out of the catalog's format_type
// rendering, and both used to make the diff say "already in sync".
// ---------------------------------------------------------------------------

describe('planTypeChange: array columns', () => {
  always('sees an array element LENGTH narrowing that information_schema reports as null', () => {
    // The bug: character_maximum_length is NULL for `varchar(255)[]` (the
    // modifier belongs to the element type), so comparing it against a declared
    // varchar(5)[] produced kind 'none', no statement and no warning.
    const plan = planTypeChange(
      column({ type: 'varchar', maxLength: 5, array: true }),
      dbCol({ udtName: '_varchar', formattedType: 'character varying(255)[]' }),
      'tags',
    );
    assert.equal(plan.kind, 'alter');
    assert.equal(plan.kind === 'alter' && plan.needsUsing, false);
    assert.match(plan.kind === 'alter' ? (plan.loss ?? '') : '', /array elements/);
    assert.match(plan.kind === 'alter' ? (plan.loss ?? '') : '', /longer than 5 characters/);
  });

  always('emits nothing when the array element lengths agree', () => {
    assert.equal(
      planTypeChange(
        column({ type: 'varchar', maxLength: 255, array: true }),
        dbCol({ udtName: '_varchar', formattedType: 'character varying(255)[]' }),
        'tags',
      ).kind,
      'none',
    );
    // Unbounded on both sides: `character varying[]` carries no modifier.
    assert.equal(
      planTypeChange(
        column({ type: 'varchar', array: true }),
        dbCol({ udtName: '_varchar', formattedType: 'character varying[]' }),
        'tags',
      ).kind,
      'none',
    );
  });

  always('omits USING within an array family, and names the loss', () => {
    // text[] -> varchar(5)[] used to emit `USING "c"::VARCHAR(5)[]`, which
    // truncated every element, and describeTypeLoss returned nothing because
    // both array udts mapped to a null family.
    const plan = planTypeChange(
      column({ type: 'varchar', maxLength: 5, array: true }),
      dbCol({ udtName: '_text', formattedType: 'text[]' }),
      'tags',
    );
    assert.equal(plan.kind, 'alter');
    assert.equal(plan.kind === 'alter' && plan.needsUsing, false);
    assert.match(plan.kind === 'alter' ? (plan.loss ?? '') : '', /array elements .* longer than 5/);
  });

  always('KEEPS USING between a scalar and an array of the same element family', () => {
    // There is no automatic cast from `text` to `varchar[]`, so treating these
    // as one family would emit a plain ALTER that cannot run.
    const plan = planTypeChange(
      column({ type: 'varchar', maxLength: 5, array: true }),
      dbCol({ udtName: 'text', formattedType: 'text' }),
      'tags',
    );
    assert.equal(plan.kind === 'alter' && plan.needsUsing, true);
  });

  always('names the array target readably in a cross-family loss sentence', () => {
    const plan = planTypeChange(
      column({ type: 'uuid', array: true }),
      dbCol({ udtName: '_text', formattedType: 'text[]' }),
      'ids',
    );
    assert.equal(plan.kind, 'alter');
    assert.match(plan.kind === 'alter' ? (plan.loss ?? '') : '', /valid uuid\[\] literal/);
  });
});

describe('planTypeChange: pgvector dimensions', () => {
  always('sees a dimension change that has no information_schema column at all', () => {
    const plan = planTypeChange(
      column({ type: 'vector', dimensions: 1536 }),
      dbCol({ udtName: 'vector', formattedType: 'vector(3)' }),
      'embedding',
    );
    assert.equal(plan.kind, 'alter');
    assert.match(plan.kind === 'alter' ? (plan.loss ?? '') : '', /exactly 1536 dimensions/);
    assert.match(plan.kind === 'alter' ? (plan.loss ?? '') : '', /FAILS/);
  });

  always('emits nothing when the dimensions agree', () => {
    assert.equal(
      planTypeChange(
        column({ type: 'vector', dimensions: 3 }),
        dbCol({ udtName: 'vector', formattedType: 'vector(3)' }),
        'embedding',
      ).kind,
      'none',
    );
  });
});

describe('planTypeChange: time of day is not the temporal family', () => {
  always('treats time -> date as a conversion Postgres cannot do at all', () => {
    // `time` used to sit in the `temporal` family with date and the timestamps,
    // whose contract is that every pair has an assignment cast. pg_cast has NO
    // entry between them in either direction, so the plain ALTER the family
    // implied was unrunnable and carried no warning saying so.
    const plan = planTypeChange(column({ type: 'date' }), dbCol({ udtName: 'time', formattedType: 'time' }), 'at');
    assert.equal(plan.kind, 'alter');
    assert.equal(plan.kind === 'alter' && plan.needsUsing, true);
    assert.match(plan.kind === 'alter' ? (plan.loss ?? '') : '', /NO cast from time to date/);
    assert.match(plan.kind === 'alter' ? (plan.loss ?? '') : '', /ALWAYS FAILS/);
  });

  always('keeps the date/timestamp/timestamptz family intact', () => {
    const plan = planTypeChange(
      column({ type: 'timestamptz' }),
      dbCol({ udtName: 'date', formattedType: 'date' }),
      'at',
    );
    assert.equal(plan.kind === 'alter' && plan.needsUsing, false);
  });
});

// ---------------------------------------------------------------------------
// Live: schema scoping and the emitted statements
// ---------------------------------------------------------------------------

const SUFFIX = `${process.pid}_${Date.now().toString(36)}`;
const APP_SCHEMA = `turbine_diff_${SUFFIX}`;
const PIN_SCHEMA = `turbine_pin_${SUFFIX}`;
const HELPER_SCHEMA = `turbine_helper_${SUFFIX}`;
const TYPES_SCHEMA = `turbine_types_${SUFFIX}`;

/**
 * The same database, reached over a connection whose OWN `search_path` leads
 * somewhere else first. This is how a role-level `search_path` (or a managed
 * provider's `"$user", public, extensions` default) reaches Turbine, and it is
 * the setting every schema-scoping bug in this file hinges on. Done through the
 * connection string rather than `ALTER ROLE` so the tests leave no trace
 * outside their own throwaway schemas.
 */
function urlWithSearchPath(path: string): string {
  const url = new URL(DATABASE_URL!);
  url.searchParams.set('options', `-c search_path=${path}`);
  return url.toString();
}

const SCHEMA_DEF = defineSchema({
  widgets: {
    id: { type: 'serial', primaryKey: true },
    nick: { type: 'varchar', maxLength: 10 },
  },
});

describe('schemaDiff honors the configured Postgres schema (live)', () => {
  let client: pg.Client;

  before(async () => {
    client = new pg.Client({ connectionString: DATABASE_URL! });
    await client.connect();
    await client.query(`CREATE SCHEMA ${APP_SCHEMA}`);
    // The table exists ONLY in the dedicated schema, with a wider column than
    // the schema declares. A public-only diff sees no table at all.
    await client.query(`CREATE TABLE ${APP_SCHEMA}.widgets (id serial PRIMARY KEY, nick VARCHAR(255))`);
    await client.query(`INSERT INTO ${APP_SCHEMA}.widgets (nick) VALUES ('a_very_long_nickname_here')`);
  });

  after(async () => {
    if (!client) return;
    await client.query(`DROP SCHEMA IF EXISTS ${APP_SCHEMA} CASCADE`);
    await client.end();
  });

  it('finds the table in a non-public schema instead of proposing a duplicate CREATE', async () => {
    const diff = await schemaDiff(SCHEMA_DEF, DATABASE_URL!, { schema: APP_SCHEMA });
    assert.deepEqual(diff.create, [], 'the table exists; nothing should be created');
    const creates = diff.statements.filter((s) => /^CREATE TABLE/i.test(s));
    assert.deepEqual(creates, []);
  });

  it('emits the length change the udt-only comparison reported as "in sync"', async () => {
    const diff = await schemaDiff(SCHEMA_DEF, DATABASE_URL!, { schema: APP_SCHEMA });
    const alters = diff.statements.filter((s) => /ALTER COLUMN "nick" TYPE/i.test(s));
    assert.equal(alters.length, 1, `expected one type change, got: ${JSON.stringify(diff.statements)}`);
    assert.match(alters[0]!, /TYPE VARCHAR\(10\)/);
  });

  it('emits the plain ALTER with no USING, so Postgres refuses the truncation itself', async () => {
    const diff = await schemaDiff(SCHEMA_DEF, DATABASE_URL!, { schema: APP_SCHEMA });
    const alter = diff.statements.find((s) => /ALTER COLUMN "nick" TYPE/i.test(s))!;
    assert.doesNotMatch(alter, /USING/i, 'a same-family narrowing must not carry an explicit truncating cast');
    // And the warning names the specific loss rather than "may truncate or fail".
    const warning = (diff.warnings ?? []).find((w) => w.includes('"nick"'));
    assert.ok(warning, `expected a loss warning, got: ${JSON.stringify(diff.warnings)}`);
    assert.match(warning, /longer than 10 characters/);
  });

  it('is still caught by the destructive gate', async () => {
    const diff = await schemaDiff(SCHEMA_DEF, DATABASE_URL!, { schema: APP_SCHEMA });
    await assert.rejects(
      () => schemaPush(SCHEMA_DEF, DATABASE_URL!, { precomputedDiff: diff, schema: APP_SCHEMA }),
      /DESTRUCTIVE/,
    );
  });

  it('FAILS the migration instead of amputating the row when applied', async () => {
    const diff = await schemaDiff(SCHEMA_DEF, DATABASE_URL!, { schema: APP_SCHEMA });
    await assert.rejects(
      () =>
        schemaPush(SCHEMA_DEF, DATABASE_URL!, { precomputedDiff: diff, allowDestructive: true, schema: APP_SCHEMA }),
      /too long/i,
    );
    const rows = await client.query(`SELECT nick, length(nick) AS len FROM ${APP_SCHEMA}.widgets`);
    assert.equal(rows.rows[0]?.nick, 'a_very_long_nickname_here', 'the row must be untouched');
    assert.equal(Number(rows.rows[0]?.len), 25);
  });

  it('applies unqualified DDL into the configured schema, not public', async () => {
    // A brand-new table in the same schema: without the transaction-local
    // search_path pin, `CREATE TABLE "gadgets"` lands in public.
    const withNewTable = defineSchema({
      widgets: { id: { type: 'serial', primaryKey: true }, nick: { type: 'varchar', maxLength: 255 } },
      gadgets: { id: { type: 'serial', primaryKey: true } },
    });
    await schemaPush(withNewTable, DATABASE_URL!, { schema: APP_SCHEMA });
    const here = await client.query(`SELECT to_regclass($1) AS oid`, [`${APP_SCHEMA}.gadgets`]);
    const there = await client.query(`SELECT to_regclass('public.gadgets') AS oid`);
    assert.ok(here.rows[0]?.oid, 'gadgets must exist in the configured schema');
    assert.equal(there.rows[0]?.oid, null, 'gadgets must NOT have been created in public');
  });
});

// ---------------------------------------------------------------------------
// Live: the search_path pin. The three cases below are one bug each, all in the
// same call, all of which end the same way: the DDL executes somewhere other
// than where the diff READ, so push reports success and the NEXT push dies with
// "already exists" and never recovers.
// ---------------------------------------------------------------------------

describe('schemaPush pins the search_path it diffed (live)', () => {
  let client: pg.Client;

  before(async () => {
    client = new pg.Client({ connectionString: DATABASE_URL! });
    await client.connect();
    await client.query(`CREATE SCHEMA ${PIN_SCHEMA}`);
    await client.query(`CREATE SCHEMA ${HELPER_SCHEMA}`);
    // Stands in for an extension function living in its own schema (pgvector,
    // citext, postgis on a managed provider). Reachable only through the
    // CONNECTION's search_path, never through the target schema.
    await client.query(
      `CREATE FUNCTION ${HELPER_SCHEMA}.looks_ok(t text) RETURNS boolean
       AS $$ SELECT t IS NULL OR length(t) < 100 $$ LANGUAGE sql IMMUTABLE`,
    );
  });

  after(async () => {
    if (!client) return;
    await client.query(`DROP SCHEMA IF EXISTS ${PIN_SCHEMA} CASCADE`);
    await client.query(`DROP SCHEMA IF EXISTS ${HELPER_SCHEMA} CASCADE`);
    await client.query(`DROP TABLE IF EXISTS public.pin_default_${SUFFIX}`);
    // Only ever created if the missing-schema guard regresses, which is exactly
    // when a leaked table in public would be hardest to notice.
    await client.query(`DROP TABLE IF EXISTS public.pin_missing_${SUFFIX}`);
    await client.end();
  });

  it('creates in the schema it diffed even with NO schema configured', async () => {
    // The pin used to be skipped entirely for the default `public` target, on
    // the reasoning that public is where an unqualified CREATE goes anyway.
    // With a role-level search_path it is not: the diff read public (its reads
    // bind the name, unconditionally) and the DDL landed in the first entry of
    // the connection's own path. Nothing here passes a `schema` option, which
    // is the documented default and the whole point.
    const table = `pin_default_${SUFFIX}`;
    const def = defineSchema({ [table]: { id: { type: 'serial', primaryKey: true } } } as never);
    const url = urlWithSearchPath(`${PIN_SCHEMA},public`);

    await schemaPush(def, url);
    const placed = await client.query(`SELECT to_regclass($1) AS elsewhere, to_regclass($2) AS in_public`, [
      `${PIN_SCHEMA}.${table}`,
      `public.${table}`,
    ]);
    assert.equal(placed.rows[0]?.elsewhere, null, 'the DDL must not follow the connection search_path');
    assert.ok(placed.rows[0]?.in_public, 'the DDL must land in the schema the diff read');

    // The consequence that made this unrecoverable: a second push must be a
    // no-op, not "relation already exists".
    const second = await schemaPush(def, url);
    assert.equal(second.statementsExecuted, 0, 'the second push must find the table it created');
  });

  it('refuses a target schema that does not exist instead of writing to public', async () => {
    // Postgres accepts a missing namespace in search_path without complaint and
    // simply skips it during resolution, so this used to report success with
    // every table created in public.
    const table = `pin_missing_${SUFFIX}`;
    const def = defineSchema({ [table]: { id: { type: 'serial', primaryKey: true } } } as never);
    const missing = `turbine_absent_${SUFFIX}`;

    await assert.rejects(
      () => schemaPush(def, DATABASE_URL!, { schema: missing }),
      (err: Error) => {
        assert.match(err.message, new RegExp(`Schema "${missing}" does not exist`));
        return true;
      },
    );
    const leaked = await client.query(`SELECT to_regclass($1) AS oid`, [`public.${table}`]);
    assert.equal(leaked.rows[0]?.oid, null, 'a refused push must not have created anything in public');
  });

  it('keeps the connection search_path reachable, so types elsewhere still resolve', async () => {
    // The pin replaced the caller's path with `"<target>", public`, so a CHECK
    // calling a function in another schema (the shape of every extension
    // installed outside public) stopped resolving under a pin the same DDL did
    // not need without one.
    const table = `pin_helper_${SUFFIX}`;
    const def = defineSchema({
      [table]: {
        id: { type: 'serial', primaryKey: true },
        label: { type: 'text', check: 'looks_ok(label)' },
      },
    } as never);
    const url = urlWithSearchPath(`public,${HELPER_SCHEMA}`);

    await schemaPush(def, url, { schema: PIN_SCHEMA });
    const placed = await client.query(`SELECT to_regclass($1) AS oid`, [`${PIN_SCHEMA}.${table}`]);
    assert.ok(placed.rows[0]?.oid, 'the table must exist in the configured schema');
  });
});

// ---------------------------------------------------------------------------
// Live: a type change that would lose data must FAIL at the database. Removing
// the USING was only half of it, and two whole classes of column were getting
// neither half.
// ---------------------------------------------------------------------------

describe('lossy type changes fail loudly rather than truncating (live)', () => {
  let client: pg.Client;

  before(async () => {
    client = new pg.Client({ connectionString: DATABASE_URL! });
    await client.connect();
    await client.query(`CREATE SCHEMA ${TYPES_SCHEMA}`);
    await client.query(`CREATE TABLE ${TYPES_SCHEMA}.docs (id serial PRIMARY KEY, payload jsonb)`);
    await client.query(`INSERT INTO ${TYPES_SCHEMA}.docs (payload) VALUES ('{"a": 12345}')`);
    await client.query(`CREATE TABLE ${TYPES_SCHEMA}.tagged (id serial PRIMARY KEY, tags VARCHAR(255)[])`);
    await client.query(`INSERT INTO ${TYPES_SCHEMA}.tagged (tags) VALUES (ARRAY['0123456789'])`);
    await client.query(`CREATE TYPE ${TYPES_SCHEMA}."MixedCase" AS ENUM ('a', 'b')`);
    await client.query(`CREATE TABLE ${TYPES_SCHEMA}.moods (id serial PRIMARY KEY, mood ${TYPES_SCHEMA}."MixedCase")`);
  });

  after(async () => {
    if (!client) return;
    await client.query(`DROP SCHEMA IF EXISTS ${TYPES_SCHEMA} CASCADE`);
    await client.end();
  });

  it('casts to the unbounded base so a cross-family narrowing cannot amputate', async () => {
    // jsonb -> VARCHAR(5) kept emitting `USING "payload"::VARCHAR(5)`, and an
    // explicit cast to a bounded type TRUNCATES: `{"a": 12345}` became `{"a":`,
    // while the warning claimed the statement would fail. Casting to the
    // unbounded base leaves the length check to the assignment into the column.
    const def = defineSchema({
      docs: { id: { type: 'serial', primaryKey: true }, payload: { type: 'varchar', maxLength: 5 } },
    });
    const diff = await schemaDiff(def, DATABASE_URL!, { schema: TYPES_SCHEMA });
    const alter = diff.statements.find((s) => /ALTER COLUMN "payload" TYPE/i.test(s));
    assert.ok(alter, `expected a type change, got: ${JSON.stringify(diff.statements)}`);
    assert.match(alter, /USING "payload"::TEXT;/, 'the USING must target the unbounded base type');
    assert.doesNotMatch(alter, /USING "payload"::VARCHAR/i);

    await assert.rejects(
      () => schemaPush(def, DATABASE_URL!, { precomputedDiff: diff, allowDestructive: true, schema: TYPES_SCHEMA }),
      /too long/i,
    );
    const rows = await client.query(`SELECT payload::text AS v FROM ${TYPES_SCHEMA}.docs`);
    assert.equal(rows.rows[0]?.v, '{"a": 12345}', 'the row must be untouched');

    // And the warning has to describe what actually happened.
    const warning = (diff.warnings ?? []).find((w) => w.includes('"payload"'));
    assert.ok(warning, `expected a loss warning, got: ${JSON.stringify(diff.warnings)}`);
    assert.match(warning, /longer than 5 characters/);
    assert.match(warning, /FAIL/);
  });

  it('sees an array element length change at all, and refuses to truncate it', async () => {
    // `varchar(255)[]` against a declared `varchar(5)[]` produced no statement
    // and no warning: information_schema reports character_maximum_length NULL
    // for an array, so push said "already in sync" for a schema that differed.
    const def = defineSchema({
      tagged: { id: { type: 'serial', primaryKey: true }, tags: { type: 'varchar', maxLength: 5, array: true } },
    });
    const diff = await schemaDiff(def, DATABASE_URL!, { schema: TYPES_SCHEMA });
    const alter = diff.statements.find((s) => /ALTER COLUMN "tags" TYPE/i.test(s));
    assert.ok(alter, `expected a type change, got: ${JSON.stringify(diff.statements)}`);
    assert.match(alter, /TYPE VARCHAR\(5\)\[\]/);
    assert.doesNotMatch(alter, /USING/i, 'the array assignment cast enforces the bound per element');

    const warning = (diff.warnings ?? []).find((w) => w.includes('"tags"'));
    assert.ok(warning, `expected a loss warning, got: ${JSON.stringify(diff.warnings)}`);
    assert.match(warning, /array elements/);

    await assert.rejects(
      () => schemaPush(def, DATABASE_URL!, { precomputedDiff: diff, allowDestructive: true, schema: TYPES_SCHEMA }),
      /too long/i,
    );
    const rows = await client.query(`SELECT tags FROM ${TYPES_SCHEMA}.tagged`);
    assert.deepEqual(rows.rows[0]?.tags, ['0123456789'], 'the array elements must be untouched');
  });

  it('writes a reverse statement that names a mixed-case type correctly', async () => {
    // The reverse type came from `udtName.toUpperCase()`, an UNQUOTED
    // identifier: `"MixedCase"` became `MIXEDCASE`, which Postgres folds to
    // `mixedcase`, so every DOWN on an enum with a capital in it failed with
    // `type "mixedcase" does not exist`.
    const def = defineSchema({ moods: { id: { type: 'serial', primaryKey: true }, mood: { type: 'text' } } });
    const diff = await schemaDiff(def, DATABASE_URL!, { schema: TYPES_SCHEMA });
    const reverse = diff.reverseStatements.find((s) => /ALTER COLUMN "mood" TYPE/i.test(s));
    assert.ok(reverse, `expected a reverse type change, got: ${JSON.stringify(diff.reverseStatements)}`);
    assert.match(reverse, /"MixedCase"/, 'the enum name must keep its case and its quotes');

    // Proof it is runnable, not just well-spelled: apply the forward statement
    // and then the reverse, inside a transaction that is rolled back.
    const forward = diff.statements.find((s) => /ALTER COLUMN "mood" TYPE/i.test(s))!;
    await client.query('BEGIN');
    try {
      await client.query(`SELECT set_config('search_path', $1, true)`, [`"${TYPES_SCHEMA}"`]);
      await client.query(forward);
      await client.query(reverse);
    } finally {
      await client.query('ROLLBACK');
    }
  });
});
