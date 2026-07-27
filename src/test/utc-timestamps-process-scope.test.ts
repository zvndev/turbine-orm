/**
 * turbine-orm, `utcTimestamps` is a PER-PROCESS decision, not a per-client one
 *
 * The flag has two halves that live in different places. The WRITE half is per
 * client (a bound `Date` on a zone-less `date` / `timestamp` column is rewritten
 * to a UTC literal, see `coerceWriteValue` in query/writes.ts). The READ half is
 * the pg type parsers for the zone-less temporal OIDs (1114, 1082, 1115, 1182),
 * and `pg.types.setTypeParser` installs ONE parser per OID for the whole
 * process, so the first client settles it for every later one. Only a
 * Turbine-OWNED pool registers the parsers, but every client reads through
 * them, so every client takes part in the agreement check.
 *
 * Before this guard, a process holding a DEFAULT client and a
 * `utcTimestamps: false` client gave the second one local-time writes and UTC
 * reads, so its own round trip came back off by the process offset with nothing
 * logged. Live proof of that shape, and of the refusal, lives in
 * date-type-metadata-resolution.integration.test.ts; these are the DB-less
 * assertions that the disagreement is refused at construction.
 *
 * Run: npx tsx --test src/test/utc-timestamps-process-scope.test.ts
 */

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import pg from 'pg';
import type { PgCompatPool } from '../client.js';
import { TurbineClient } from '../client.js';
import { ValidationError } from '../errors.js';
import type { SchemaMetadata } from '../schema.js';
import { mockTable } from './helpers.js';

/** A connection string is never dialed: pg.Pool connects lazily. */
const URL = 'postgres://user:pass@127.0.0.1:1/db';

const SCHEMA: SchemaMetadata = {
  tables: { events: mockTable('events', [{ name: 'id', field: 'id' }]) },
  enums: {},
};

/** A pool-shaped stub, enough for the constructor's external-pool branch. */
const externalPool = (): PgCompatPool =>
  ({
    query: () => Promise.resolve({ rows: [], rowCount: 0 }),
    connect: () => Promise.reject(new Error('not used')),
    end: () => Promise.resolve(),
  }) as unknown as PgCompatPool;

const clients: TurbineClient[] = [];
function make(utcTimestamps?: boolean, external = false): TurbineClient {
  const client = new TurbineClient(
    {
      ...(external ? { pool: externalPool() } : { connectionString: URL }),
      ...(utcTimestamps === undefined ? {} : { utcTimestamps }),
    },
    SCHEMA,
  );
  clients.push(client);
  return client;
}

afterEach(async () => {
  while (clients.length > 0) await clients.pop()?.disconnect();
  TurbineClient.resetUtcTimestampsForTests();
});

describe('utcTimestamps conflicts between clients in one process', () => {
  it('refuses a `false` client after a default (UTC) client', () => {
    make();
    assert.throws(
      () => make(false),
      (err: unknown) => {
        assert.ok(err instanceof ValidationError);
        assert.equal(err.code, 'TURBINE_E003');
        assert.match(err.message, /utcTimestamps: false conflicts with utcTimestamps: true/);
        // The message has to name the hazard, not just the disagreement.
        assert.match(err.message, /process-global/);
        assert.match(err.message, /read back shifted by the process offset/);
        return true;
      },
    );
  });

  it('refuses a default (UTC) client after a `false` client', () => {
    make(false);
    assert.throws(() => make(), /utcTimestamps: true conflicts with utcTimestamps: false/);
    // An explicit `true` is the same case as the implicit default.
    assert.throws(() => make(true), /utcTimestamps: true conflicts with utcTimestamps: false/);
  });

  it('allows any number of clients that agree', () => {
    make();
    make(true);
    make();
    assert.equal(clients.length, 3);
  });

  it('allows any number of clients that agree on the opt-out', () => {
    make(false);
    make(false);
    assert.equal(clients.length, 2);
  });

  it('holds external-pool clients to the same decision', () => {
    // Turbine never REGISTERS a parser for a pool it does not own (the caller's
    // driver owns that configuration), but registration is process-global, so
    // an external-pool client still READS through whatever an owned client
    // installed. Left out of the check it would write local `date` literals
    // while reading UTC ones, which walks the stored calendar day backwards one
    // day per read-modify-write cycle. So it takes part, in both directions.
    make(true, true);
    assert.throws(() => make(false, true), /utcTimestamps: false conflicts with utcTimestamps: true/);
    assert.throws(() => make(false), /utcTimestamps: false conflicts with utcTimestamps: true/);
    assert.doesNotThrow(() => make());
  });

  it('an external-pool client settles the value for a later owned one', () => {
    make(false, true);
    assert.throws(() => make(true), /utcTimestamps: true conflicts with utcTimestamps: false/);
    assert.doesNotThrow(() => make(false));
  });

  it('a process holding only external-pool clients still registers nothing', () => {
    // The check is about agreement; it does not turn an external pool into an
    // owned one. Asserted on an OID Turbine otherwise never touches.
    const before = (pg.types.getTypeParser as unknown as (oid: number, f: 'text') => unknown)(1083, 'text');
    make(true, true);
    assert.equal((pg.types.getTypeParser as unknown as (oid: number, f: 'text') => unknown)(1083, 'text'), before);
  });
});
