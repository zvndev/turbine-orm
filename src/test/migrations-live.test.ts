/**
 * Schema diff behavior that has to be seen against a real Postgres:
 *
 *   - a dropped column's DOWN is an IRREVERSIBLE note
 *   - ADD COLUMN ... NOT NULL with no default warns and names the backfill recipe
 *   - lossless widenings are applied by `push` without the destructive gate, and
 *     narrowings are still refused
 *   - an enum value is inserted where the schema declares it
 *   - "in sync" lists what the diff does not compare, and Turbine's own
 *     bookkeeping table is not an "extra table"
 *
 * Needs DATABASE_URL (a direct endpoint). Each test file works in its own
 * Postgres schema, so nothing outside it is read or written.
 *
 * Run: DATABASE_URL=... npx tsx --test src/test/migrations-live.test.ts
 */

import assert from 'node:assert/strict';
import { after, before, describe } from 'node:test';
import pg from 'pg';
import { buildDiffMigrationBody } from '../cli/migrate.js';
import { defineSchema } from '../schema-builder.js';
import { DestructivePushRefusal, NEVER_COMPARED, schemaDiff, schemaPush } from '../schema-sql.js';
import { skipGate } from './helpers.js';

const DATABASE_URL = process.env.DATABASE_URL ?? '';
const live = skipGate(!DATABASE_URL, 'requires DATABASE_URL');

const SCHEMA = `mig_live_${process.pid}_${Date.now().toString(36)}`;

describe('schemaDiff against a live database', () => {
  let pool: pg.Pool;

  /** Column type as information_schema reports it, e.g. `character varying(100)`. */
  async function columnType(table: string, column: string): Promise<string> {
    const r = await pool.query<{ t: string }>(
      `SELECT format_type(a.atttypid, a.atttypmod) AS t
       FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1 AND c.relname = $2 AND a.attname = $3`,
      [SCHEMA, table, column],
    );
    return r.rows[0]!.t;
  }

  async function reset(): Promise<void> {
    await pool.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await pool.query(`CREATE SCHEMA "${SCHEMA}"`);
  }

  const diff = (schema: ReturnType<typeof defineSchema>) => schemaDiff(schema, DATABASE_URL, { schema: SCHEMA });
  const push = (schema: ReturnType<typeof defineSchema>, allowDestructive = false) =>
    schemaPush(schema, DATABASE_URL, { schema: SCHEMA, allowDestructive });

  before(async () => {
    if (!DATABASE_URL) return;
    pool = new pg.Pool({ connectionString: DATABASE_URL, max: 2 });
    await reset();
  });

  after(async () => {
    if (!pool) return;
    await pool.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await pool.end();
  });

  // -------------------------------------------------------------------------
  // Dropped columns
  // -------------------------------------------------------------------------

  live.it('a dropped column has an IRREVERSIBLE note as its DOWN, naming the column and its old type', async () => {
    await reset();
    await push(
      defineSchema({ users: { id: { type: 'serial', primaryKey: true }, bio: { type: 'varchar', maxLength: 80 } } }),
    );

    const d = await diff(defineSchema({ users: { id: { type: 'serial', primaryKey: true } } }));
    assert.equal(d.statements.length, 1);
    assert.match(d.statements[0]!, /DROP COLUMN "bio"/);
    assert.equal(d.reverseStatements.length, 1, 'every UP drop has exactly one DOWN entry');
    const note = d.reverseStatements[0]!;
    assert.match(note, /^-- IRREVERSIBLE: this migration drops "users"\."bio"/);
    assert.match(note, /cannot be restored automatically/);
    assert.match(note, /-- ALTER TABLE "users" ADD COLUMN "bio" VARCHAR\(80\);/);
    assert.ok(
      note.split('\n').every((line) => line.startsWith('--')),
      'the note is comments only, never SQL that pretends to restore the data',
    );

    const body = buildDiffMigrationBody(d);
    assert.match(body.down, /IRREVERSIBLE/);
    assert.doesNotMatch(body.down, /write manually/, 'the generic placeholder is replaced by the specific one');
  });

  live.it('three drops produce three notes', async () => {
    await reset();
    await push(
      defineSchema({
        users: {
          id: { type: 'serial', primaryKey: true },
          a: { type: 'text' },
          b: { type: 'text' },
          c: { type: 'text' },
        },
      }),
    );
    const d = await diff(defineSchema({ users: { id: { type: 'serial', primaryKey: true } } }));
    const drops = d.statements.filter((s) => /DROP COLUMN/.test(s)).length;
    const notes = d.reverseStatements.filter((s) => s.startsWith('-- IRREVERSIBLE')).length;
    assert.equal(drops, 3);
    assert.equal(notes, 3);
  });

  // -------------------------------------------------------------------------
  // NOT NULL without a default
  // -------------------------------------------------------------------------

  live.it('ADD COLUMN NOT NULL without a default warns and points at the backfill recipe', async () => {
    await reset();
    await push(defineSchema({ users: { id: { type: 'serial', primaryKey: true } } }));

    const d = await diff(
      defineSchema({ users: { id: { type: 'serial', primaryKey: true }, handle: { type: 'text', notNull: true } } }),
    );
    assert.equal(d.statements.length, 1);
    const warning = (d.warnings ?? []).find((w) => /"users"\."handle"/.test(w));
    assert.ok(warning, `no warning for the NOT NULL column: ${JSON.stringify(d.warnings)}`);
    assert.match(warning, /NOT NULL with no default/);
    assert.match(warning, /--recipe backfill/);
    assert.ok(!warning.includes('—'));
  });

  live.it('no warning when the column has a default, is nullable, or is a serial', async () => {
    await reset();
    await push(defineSchema({ users: { id: { type: 'serial', primaryKey: true } } }));

    const d = await diff(
      defineSchema({
        users: {
          id: { type: 'serial', primaryKey: true },
          withDefault: { type: 'text', notNull: true, default: "'x'" },
          nullable: { type: 'text' },
          counter: { type: 'serial' },
        },
      }),
    );
    assert.equal(d.statements.length, 3);
    assert.deepEqual(
      (d.warnings ?? []).filter((w) => /NOT NULL with no default/.test(w)),
      [],
    );
  });

  // -------------------------------------------------------------------------
  // Widening casts
  // -------------------------------------------------------------------------

  live.it('push applies lossless widenings without the destructive gate', async () => {
    await reset();
    await push(
      defineSchema({
        items: {
          id: { type: 'serial', primaryKey: true },
          qty: { type: 'integer' },
          label: { type: 'varchar', maxLength: 50 },
          note: { type: 'varchar', maxLength: 20 },
          price: { type: 'integer' },
        },
      }),
    );
    await pool.query(`INSERT INTO "${SCHEMA}".items (qty, label, note, price) VALUES (7, 'abc', 'hello', 5)`);

    const widened = defineSchema({
      items: {
        id: { type: 'serial', primaryKey: true },
        qty: { type: 'bigint' },
        label: { type: 'varchar', maxLength: 100 },
        note: { type: 'text' },
        price: { type: 'numeric' },
      },
    });
    const d = await diff(widened);
    assert.equal(d.alter[0]!.columns.filter((c) => c.action === 'alter_type').length, 4);
    assert.equal(d.widenings?.length, 4, JSON.stringify(d.widenings));
    assert.deepEqual(d.widenings!.map((w) => `${w.from}>${w.to}`).sort(), [
      'INTEGER>BIGINT',
      'INTEGER>NUMERIC',
      'VARCHAR(20)>TEXT',
      'VARCHAR(50)>VARCHAR(100)',
    ]);

    // No allowDestructive: a refusal here is the bug.
    const result = await push(widened);
    assert.equal(result.statementsExecuted, 4);
    assert.equal(await columnType('items', 'qty'), 'bigint');
    assert.equal(await columnType('items', 'label'), 'character varying(100)');
    assert.equal(await columnType('items', 'note'), 'text');
    assert.equal(await columnType('items', 'price'), 'numeric');
    const row = await pool.query(`SELECT qty::text, label, note, price::text FROM "${SCHEMA}".items`);
    assert.deepEqual(row.rows[0], { qty: '7', label: 'abc', note: 'hello', price: '5' });
  });

  live.it('narrowings and cross-family changes are still refused', async () => {
    await reset();
    await push(
      defineSchema({
        items: {
          id: { type: 'serial', primaryKey: true },
          qty: { type: 'bigint' },
          label: { type: 'varchar', maxLength: 100 },
          code: { type: 'text' },
          n: { type: 'numeric' },
        },
      }),
    );

    for (const [column, next] of [
      ['qty', { type: 'integer' }],
      ['label', { type: 'varchar', maxLength: 10 }],
      ['code', { type: 'varchar', maxLength: 10 }],
      ['n', { type: 'integer' }],
      ['label', { type: 'integer' }],
    ] as const) {
      const cols: Record<string, unknown> = {
        id: { type: 'serial', primaryKey: true },
        qty: { type: 'bigint' },
        label: { type: 'varchar', maxLength: 100 },
        code: { type: 'text' },
        n: { type: 'numeric' },
        [column]: next,
      };
      const schema = defineSchema({ items: cols } as never);
      const d = await diff(schema);
      assert.deepEqual(d.widenings, [], `${column} -> ${JSON.stringify(next)} must not count as a widening`);
      await assert.rejects(push(schema), DestructivePushRefusal, `${column} -> ${JSON.stringify(next)}`);
    }
  });

  // -------------------------------------------------------------------------
  // Enums
  // -------------------------------------------------------------------------

  async function enumOrder(name: string): Promise<string[]> {
    const r = await pool.query<{ enumlabel: string }>(
      `SELECT e.enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
       JOIN pg_namespace n ON n.oid = t.typnamespace
       WHERE n.nspname = $1 AND t.typname = $2 ORDER BY e.enumsortorder`,
      [SCHEMA, name],
    );
    return r.rows.map((x) => x.enumlabel);
  }

  const withLevels = (labels: string[]) =>
    defineSchema(
      { tickets: { id: { type: 'serial', primaryKey: true }, level: { type: 'enum', enumName: 'mig_level' } } },
      { enums: { mig_level: labels } },
    );

  live.it('a new enum value lands where the schema declares it, and the order survives', async () => {
    await reset();
    await push(withLevels(['low', 'high']));
    assert.deepEqual(await enumOrder('mig_level'), ['low', 'high']);

    const d = await diff(withLevels(['first', 'low', 'mid', 'high', 'last']));
    assert.deepEqual(d.statements, [
      `ALTER TYPE "mig_level" ADD VALUE 'first' BEFORE 'low';`,
      `ALTER TYPE "mig_level" ADD VALUE 'mid' AFTER 'low';`,
      `ALTER TYPE "mig_level" ADD VALUE 'last';`,
    ]);
    await push(withLevels(['first', 'low', 'mid', 'high', 'last']));
    assert.deepEqual(await enumOrder('mig_level'), ['first', 'low', 'mid', 'high', 'last']);

    const again = await diff(withLevels(['first', 'low', 'mid', 'high', 'last']));
    assert.deepEqual(again.statements, []);
    assert.deepEqual(
      (again.warnings ?? []).filter((w) => /Enum/.test(w)),
      [],
    );
  });

  live.it('a reorder warns that Postgres cannot do it in place, and emits no statement', async () => {
    await reset();
    await push(withLevels(['low', 'mid', 'high']));
    const d = await diff(withLevels(['high', 'mid', 'low']));
    assert.deepEqual(d.statements, []);
    const warning = (d.warnings ?? []).find((w) => /Enum "mig_level"/.test(w));
    assert.ok(warning, JSON.stringify(d.warnings));
    assert.match(warning, /cannot reorder enum values in place/);
  });

  // -------------------------------------------------------------------------
  // "In sync" honesty
  // -------------------------------------------------------------------------

  live.it("Turbine's own tracking table is not an extra table", async () => {
    await reset();
    const schema = defineSchema({ users: { id: { type: 'serial', primaryKey: true } } });
    await push(schema);
    await pool.query(
      `CREATE TABLE "${SCHEMA}"._turbine_migrations (id serial primary key, name text not null unique, checksum text not null)`,
    );
    await pool.query(`CREATE TABLE "${SCHEMA}".leftover (id int)`);
    const d = await diff(schema);
    assert.deepEqual(d.drop, ['leftover'], 'only the user table is reported');
  });

  live.it('an empty diff still lists what was never compared', async () => {
    await reset();
    await push(defineSchema({ users: { id: { type: 'serial', primaryKey: true }, email: { type: 'text' } } }));
    // Things a human put in the database that the schema file never mentions.
    await pool.query(`CREATE INDEX users_email_lower ON "${SCHEMA}".users (lower(email))`);
    await pool.query(`ALTER TABLE "${SCHEMA}".users ADD CONSTRAINT email_len CHECK (length(email) < 100)`);

    // The schema now calls `id` a plain integer, while the database keeps the
    // sequence default it got as a serial: the diff leaves that default alone.
    const schema = defineSchema({ users: { id: { type: 'integer', primaryKey: true }, email: { type: 'text' } } });
    const d = await diff(schema);
    assert.deepEqual(d.statements, [], 'the diff genuinely has nothing to apply');
    const notCompared = d.notCompared ?? [];
    assert.ok(
      notCompared.some((n) => /indexes on "users" \(users_email_lower\)/.test(n)),
      `undeclared index not named: ${JSON.stringify(notCompared)}`,
    );
    assert.ok(
      notCompared.some((n) => /CHECK constraints on "users" \(email_len\)/.test(n)),
      `unnamed-in-schema CHECK not named: ${JSON.stringify(notCompared)}`,
    );
    assert.ok(
      notCompared.some((n) => /sequence-backed defaults on "users" \(id\)/.test(n)),
      `sequence default not named: ${JSON.stringify(notCompared)}`,
    );
    assert.ok(notCompared.includes(NEVER_COMPARED));
  });

  live.it('a table that declares its indexes does not list them as uncompared', async () => {
    await reset();
    const schema = defineSchema({
      users: { id: { type: 'serial', primaryKey: true }, email: { type: 'text' }, indexes: [{ columns: ['email'] }] },
    } as never);
    await push(schema);
    const d = await diff(schema);
    assert.deepEqual(
      (d.notCompared ?? []).filter((n) => /^indexes on/.test(n)),
      [],
    );
  });
});
