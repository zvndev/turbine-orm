/**
 * The one log code whose trigger needs a live catalog: a foreign key that
 * points into another schema (DATABASE_URL-gated). The unit file
 * fleet-logger.test.ts covers every other code and checks that this file names
 * this one.
 *
 * Run: DATABASE_URL=postgres://... tsx --test src/test/fleet-logger.integration.test.ts
 */

import assert from 'node:assert/strict';
import { describe } from 'node:test';
import pg from 'pg';
import { introspect } from '../introspect.js';
import type { TurbineLogEntry, TurbineLogger } from '../logger.js';
import { skipGate } from './helpers.js';

const DATABASE_URL = process.env.DATABASE_URL;
const { it, before, after } = skipGate(!DATABASE_URL, 'requires DATABASE_URL');

const SUFFIX = `${process.pid}_${Date.now().toString(36)}`;
const OWNER_SCHEMA = `fleet_logger_a_${SUFFIX}`;
const PET_SCHEMA = `fleet_logger_b_${SUFFIX}`;

/**
 * The text this line printed before the logger existed (captured from the
 * previous build against the same two tables), with this run's schema names.
 */
const CONSOLE_TEXT =
  `[turbine] Skipped 1 foreign key(s) referencing a table outside schema "${PET_SCHEMA}": ` +
  `pets.owner_id -> ${OWNER_SCHEMA}.owners.id. ` +
  'Generated clients address tables by bare name within one schema, so no relation is emitted for these. ' +
  'Introspect the other schema separately, or add the target table to this one.';

describe('logger: introspect-cross-schema-fk', () => {
  let pool: pg.Pool;

  before(async () => {
    pool = new pg.Pool({ connectionString: DATABASE_URL!, max: 1 });
    await pool.query(`
      CREATE SCHEMA ${OWNER_SCHEMA};
      CREATE SCHEMA ${PET_SCHEMA};
      CREATE TABLE ${OWNER_SCHEMA}.owners (id serial PRIMARY KEY);
      CREATE TABLE ${PET_SCHEMA}.pets (
        id serial PRIMARY KEY,
        owner_id integer NOT NULL REFERENCES ${OWNER_SCHEMA}.owners(id)
      );
    `);
  });

  after(async () => {
    if (!pool) return;
    await pool.query(`DROP SCHEMA IF EXISTS ${PET_SCHEMA} CASCADE`);
    await pool.query(`DROP SCHEMA IF EXISTS ${OWNER_SCHEMA} CASCADE`);
    await pool.end();
  });

  it('reaches a configured logger at warn, with the code and the count', async () => {
    const lines: { message: string; entry: TurbineLogEntry }[] = [];
    const logger: TurbineLogger = { warn: (message, entry) => lines.push({ message, entry }) };
    const schema = await introspect({ connectionString: DATABASE_URL!, schema: PET_SCHEMA, logger });
    assert.deepEqual(Object.keys(schema.tables.pets?.relations ?? {}), [], 'no relation is emitted for the reference');
    const mine = lines.filter((l) => l.entry.code === 'introspect-cross-schema-fk');
    assert.equal(mine.length, 1);
    assert.equal(mine[0]!.entry.references, 1);
    assert.equal(mine[0]!.entry.schema, PET_SCHEMA);
    assert.ok(!mine[0]!.message.startsWith('[turbine]'));
  });

  it('prints the same console line as before when no logger is set', async () => {
    const printed: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => {
      printed.push(args.map(String).join(' '));
    };
    try {
      await introspect({ connectionString: DATABASE_URL!, schema: PET_SCHEMA });
    } finally {
      console.warn = original;
    }
    assert.deepEqual(printed, [CONSOLE_TEXT]);
  });

  it('is silenced by {}', async () => {
    const printed: unknown[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => printed.push(args);
    try {
      await introspect({ connectionString: DATABASE_URL!, schema: PET_SCHEMA, logger: {} });
    } finally {
      console.warn = original;
    }
    assert.deepEqual(printed, []);
  });
});
