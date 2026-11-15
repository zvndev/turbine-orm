/**
 * `schemaDiff` compares defaults and CHECK expressions with the text OUTSIDE
 * string literals folded, never the literals themselves.
 *
 * It used to lower-case a whole default and collapse every whitespace run in a
 * CHECK, literals included, so `DEFAULT 'UPPER'` equalled a declared
 * `'upper'` and `CHECK (v <> 'a  b')` equalled `v <> 'a b'`: a real change was
 * reported as none. And a default was taken for a sequence when its text
 * contained `nextval(` anywhere, so `DEFAULT 'nextval(fake)'` was excluded from
 * the comparison as "sequence-backed".
 *
 * The controls are real defaults PostgreSQL stores in a rewritten form
 * (`'A0EE...'` comes back lower-cased as `'a0ee...'::uuid`, `now()` as typed,
 * `'free'` as `'free'::text`): those still compare equal and produce nothing.
 *
 * Run: DATABASE_URL=... npx tsx --test src/test/schema-diff-literals.test.ts
 */

import assert from 'node:assert/strict';
import { describe } from 'node:test';
import pg from 'pg';
import { stripCheckWrapper } from '../introspect.js';
import { defineSchema } from '../schema-builder.js';
import { type DiffResult, diffCheckConstraints, schemaDiff } from '../schema-sql.js';
import { skipGate } from './helpers.js';

const PG_URL = process.env.DATABASE_URL;
const gate = skipGate(!PG_URL, 'DATABASE_URL not set');

describe('schemaDiff: literals are values', () => {
  // A database of its own: other suites diff the shared one in parallel.
  const DB = 'turbine_schema_diff_literals';
  const url = PG_URL ? PG_URL.replace(/\/[^/?]+(\?|$)/, `/${DB}$1`) : '';
  let diff: DiffResult;
  let storedCheck: string;

  async function admin(sql: string): Promise<void> {
    const client = new pg.Client({ connectionString: PG_URL });
    await client.connect();
    try {
      await client.query(sql);
    } finally {
      await client.end();
    }
  }

  const declared = defineSchema(
    {
      defaults: {
        id: { type: 'integer', primaryKey: true },
        value: { type: 'text', default: "'replacement'" },
        upperValue: { type: 'text', default: "'upper'" },
        label: { type: 'enum', enumName: 'mood', default: "'active'" },
        // Controls: equal pairs, as a user writes them.
        plan: { type: 'text', default: "'free'" },
        createdAt: { type: 'timestamptz', default: 'now()' },
        updatedAt: { type: 'timestamptz', default: 'CURRENT_TIMESTAMP' },
        active: { type: 'boolean', default: 'false' },
        qty: { type: 'integer', default: '0' },
        ratio: { type: 'numeric', default: '1.5' },
        token: { type: 'uuid', default: 'gen_random_uuid()' },
        quote: { type: 'text', default: "'it''s'" },
        spaced: { type: 'text', default: "'a  b'" },
        mixed: { type: 'text', default: "'MiXeD'" },
        extId: { type: 'uuid', default: "'A0EEBC99-9C0B-4EF8-BB6D-6BB9BD380A11'" },
        blob: { type: 'bytea', default: "'\\xDEADBEEF'" },
        sameLabel: { type: 'enum', enumName: 'mood', default: "'Active'" },
        // A sequence default with no declared default is left alone.
        seqId: { type: 'bigint' },
        seqCast: { type: 'integer' },
      },
      checks: {
        v: { type: 'text' },
        n: { type: 'integer' },
        checks: [
          { name: 'ck', expression: "v <> 'a b'::text" },
          { name: 'ck_same', expression: 'n > 0' },
          { name: 'ck_upper', expression: "V  <>  'A  B'::TEXT" },
        ],
      },
    },
    { enums: { mood: ['Active', 'active'] } },
  );

  gate.before(async () => {
    await admin(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
    await admin(`CREATE DATABASE ${DB}`);
    const raw = new pg.Client({ connectionString: url });
    await raw.connect();
    try {
      await raw.query(`
        CREATE SEQUENCE shared_seq;
        CREATE TYPE mood AS ENUM ('Active', 'active');
        CREATE TABLE defaults (
          id integer PRIMARY KEY,
          value text DEFAULT 'nextval(fake)',
          upper_value text DEFAULT 'UPPER',
          label mood DEFAULT 'Active',
          plan text DEFAULT 'free',
          created_at timestamptz DEFAULT now(),
          updated_at timestamptz DEFAULT CURRENT_TIMESTAMP,
          active boolean DEFAULT false,
          qty integer DEFAULT 0,
          ratio numeric DEFAULT 1.5,
          token uuid DEFAULT gen_random_uuid(),
          quote text DEFAULT 'it''s',
          spaced text DEFAULT 'a  b',
          mixed text DEFAULT 'MiXeD',
          ext_id uuid DEFAULT 'A0EEBC99-9C0B-4EF8-BB6D-6BB9BD380A11',
          blob bytea DEFAULT '\\xDEADBEEF',
          same_label mood DEFAULT 'Active',
          seq_id bigint DEFAULT nextval('shared_seq'),
          seq_cast integer DEFAULT nextval('shared_seq')::integer
        );
        CREATE TABLE checks (
          v text,
          n integer,
          CONSTRAINT ck CHECK (v <> 'a  b'),
          CONSTRAINT ck_same CHECK (n > 0),
          CONSTRAINT ck_upper CHECK (v <> 'A  B')
        );
      `);
      storedCheck = (await raw.query(`SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conname = 'ck'`))
        .rows[0].d;
    } finally {
      await raw.end();
    }
    diff = await schemaDiff(declared, url);
  });

  gate.after(async () => {
    await admin(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
  });

  const defaultStatements = (column: string) =>
    diff.statements.filter((s) => s.includes(`ALTER COLUMN "${column}"`) && /DEFAULT/.test(s));

  gate.it('a string default that contains nextval( is an ordinary default', () => {
    assert.deepEqual(defaultStatements('value'), [
      `ALTER TABLE "defaults" ALTER COLUMN "value" SET DEFAULT 'replacement';`,
    ]);
    const sequences = (diff.notCompared ?? []).filter((n) => n.startsWith('sequence-backed'));
    assert.deepEqual(sequences, [
      'sequence-backed defaults on "defaults" (seq_id, seq_cast): the database default is a sequence, which is never ' +
        'compared or changed',
    ]);
  });

  gate.it('a default differing only by case inside the literal is a change', () => {
    assert.deepEqual(defaultStatements('upper_value'), [
      `ALTER TABLE "defaults" ALTER COLUMN "upper_value" SET DEFAULT 'upper';`,
    ]);
    // An enum's labels are case-sensitive too.
    assert.deepEqual(defaultStatements('label'), [`ALTER TABLE "defaults" ALTER COLUMN "label" SET DEFAULT 'active';`]);
  });

  gate.it('ordinary equal defaults, including ones PostgreSQL rewrites, produce nothing', () => {
    for (const column of [
      'plan',
      'created_at',
      'updated_at',
      'active',
      'qty',
      'ratio',
      'token',
      'quote',
      'spaced',
      'mixed',
      'ext_id',
      'blob',
      'same_label',
      'seq_id',
      'seq_cast',
    ]) {
      assert.deepEqual(defaultStatements(column), [], column);
    }
  });

  gate.it('a CHECK differing only by whitespace inside the literal is reported', () => {
    assert.equal(storedCheck, "CHECK ((v <> 'a  b'::text))");
    const warnings = (diff.warnings ?? []).filter((w) => w.includes('check constraint'));
    assert.deepEqual(
      warnings.map((w) => /check constraint "(\w+)"/.exec(w)?.[1]),
      ['ck'],
      'ck changed; ck_same and ck_upper differ only outside their literals',
    );
    // The explicit diff helper replaces it.
    const { statements } = diffCheckConstraints(
      'checks',
      [{ name: 'ck', expression: "v <> 'a b'::text" }],
      [{ name: 'ck', expression: stripCheckWrapper(storedCheck) }],
    );
    assert.deepEqual(statements, [
      'ALTER TABLE "checks" DROP CONSTRAINT "ck";',
      `ALTER TABLE "checks" ADD CONSTRAINT "ck" CHECK (v <> 'a b'::text);`,
    ]);
    // The stored text itself compares equal.
    assert.deepEqual(
      diffCheckConstraints(
        'checks',
        [{ name: 'ck', expression: "v  <>  'a  b'::TEXT" }],
        [{ name: 'ck', expression: stripCheckWrapper(storedCheck) }],
      ).statements,
      [],
    );
  });
});
