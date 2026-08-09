/**
 * turbine-orm - schemaPush must not let a failed ROLLBACK hide the real error.
 *
 * The failure path issued a bare `await client.query('ROLLBACK')`. When the
 * connection has already died, that ROLLBACK throws too, and an unguarded await
 * throws the connection error out of the catch block, REPLACING the DDL error
 * being unwound. The user is then shown a dead socket instead of the constraint
 * violation or syntax error that actually failed the push, which is the one
 * piece of information they needed.
 *
 * No database: `schemaPush` builds its own `pg.Client`, so these tests stub
 * `pg.Client.prototype` for the duration of each case. Passing `precomputedDiff`
 * means `schemaDiff` never runs, so this one client is the only connection
 * involved.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import pg from 'pg';
import { defineSchema } from '../schema-builder.js';
import { type DiffResult, schemaPush } from '../schema-sql.js';

const SCHEMA_DEF = defineSchema({ widgets: { id: { type: 'serial', primaryKey: true } } });

/** A diff with one ordinary, non-destructive statement. */
function diffWithOneStatement(): DiffResult {
  return {
    create: [],
    alter: [],
    drop: [],
    statements: ['ALTER TABLE "widgets" ADD COLUMN "nick" TEXT;'],
    reverseStatements: [],
    warnings: [],
  };
}

interface StubOutcome {
  /** Thrown when the DDL statement runs, or undefined to let it succeed. */
  ddlError?: Error;
  /** Thrown when ROLLBACK runs, or undefined to let it succeed. */
  rollbackError?: Error;
  /** What `to_regnamespace` reports for the target schema. Defaults to present. */
  schemaExists?: boolean;
  /** What the connection's own `SHOW search_path` returns. */
  searchPath?: string;
}

/**
 * The statements `schemaPush` issues between BEGIN and the first DDL, pinning
 * the transaction's search_path to the schema the diff read. They are asserted
 * rather than filtered out because their PRESENCE is the fix for a push that
 * executed its DDL in a different namespace than it diffed.
 */
const PIN = [
  'SELECT to_regnamespace($1) IS NOT NULL AS present',
  'SHOW search_path',
  `SELECT set_config('search_path', $1, true)`,
];

/**
 * Replace pg.Client's connect/query/end for one call and record every statement
 * issued. Restores the real methods however the call ends.
 *
 * The stub answers the two catalog probes the pin makes, because a stub that
 * returns an empty result set for everything is not modelling a database: a
 * real server always answers `to_regnamespace` and `SHOW`, and an empty answer
 * would send push down its "this schema does not exist" path for a schema that
 * does.
 */
async function withStubbedClient<T>(
  outcome: StubOutcome,
  run: (issued: string[]) => Promise<T>,
): Promise<{ issued: string[]; result?: T; error?: unknown }> {
  const issued: string[] = [];
  const proto = pg.Client.prototype as unknown as Record<string, unknown>;
  const original = { connect: proto.connect, query: proto.query, end: proto.end };

  proto.connect = async () => undefined;
  proto.end = async () => undefined;
  proto.query = async (sql: string) => {
    issued.push(sql);
    if (sql === 'ROLLBACK' && outcome.rollbackError) throw outcome.rollbackError;
    if (sql.startsWith('ALTER TABLE') && outcome.ddlError) throw outcome.ddlError;
    if (sql.includes('to_regnamespace')) {
      return { rows: [{ present: outcome.schemaExists ?? true }], rowCount: 1 };
    }
    if (sql === 'SHOW search_path') {
      return { rows: [{ search_path: outcome.searchPath ?? '"$user", public' }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  };

  try {
    return { issued, result: await run(issued) };
  } catch (error) {
    return { issued, error };
  } finally {
    proto.connect = original.connect;
    proto.query = original.query;
    proto.end = original.end;
  }
}

describe('schemaPush ROLLBACK guard', () => {
  it('surfaces the DDL error when the ROLLBACK itself also fails', async () => {
    const ddlError = new Error('column "nick" of relation "widgets" already exists');
    const rollbackError = new Error('Connection terminated unexpectedly');

    const { issued, error } = await withStubbedClient({ ddlError, rollbackError }, () =>
      schemaPush(SCHEMA_DEF, 'postgres://stub/db', {
        precomputedDiff: diffWithOneStatement(),
        allowDestructive: true,
      }),
    );

    assert.equal(error, ddlError, 'the ORIGINAL DDL error must be what reaches the caller');
    assert.notEqual(error, rollbackError);
    assert.match((error as Error).message, /already exists/);
    // The ROLLBACK was still attempted; it is swallowed, not skipped.
    assert.deepEqual(issued, ['BEGIN', ...PIN, 'ALTER TABLE "widgets" ADD COLUMN "nick" TEXT;', 'ROLLBACK']);
  });

  it('still surfaces the DDL error when the ROLLBACK succeeds', async () => {
    const ddlError = new Error('syntax error at or near "TABL"');

    const { issued, error } = await withStubbedClient({ ddlError }, () =>
      schemaPush(SCHEMA_DEF, 'postgres://stub/db', {
        precomputedDiff: diffWithOneStatement(),
        allowDestructive: true,
      }),
    );

    assert.equal(error, ddlError);
    assert.equal(issued.at(-1), 'ROLLBACK');
  });

  it('leaves the success path alone: COMMIT, no ROLLBACK', async () => {
    const { issued, error, result } = await withStubbedClient({}, () =>
      schemaPush(SCHEMA_DEF, 'postgres://stub/db', {
        precomputedDiff: diffWithOneStatement(),
        allowDestructive: true,
      }),
    );

    assert.equal(error, undefined);
    assert.equal(result?.statementsExecuted, 1);
    assert.deepEqual(issued, ['BEGIN', ...PIN, 'ALTER TABLE "widgets" ADD COLUMN "nick" TEXT;', 'COMMIT']);
    assert.equal(issued.includes('ROLLBACK'), false);
  });
});

/**
 * The search_path pin, exercised through the same stub. The live behaviour is
 * covered in schema-diff-types.test.ts against a real server; these cases are
 * here because they need no database and so run on every commit, and because
 * the stub can assert the exact statement ORDER, which is the part that makes
 * the pin work (it has to land after BEGIN and before the first DDL).
 */
describe('schemaPush search_path pin', () => {
  it('pins even for the default public schema, where the pin used to be skipped', async () => {
    // Skipping it for `public` assumed the connection resolves to public, which
    // a role-level or connection-level search_path can make false. The diff
    // reads the configured schema unconditionally, so the write side has to.
    const { issued, error } = await withStubbedClient({ searchPath: 'app, public' }, () =>
      schemaPush(SCHEMA_DEF, 'postgres://stub/db', {
        precomputedDiff: diffWithOneStatement(),
        allowDestructive: true,
      }),
    );

    assert.equal(error, undefined);
    assert.deepEqual(issued.slice(0, 4), ['BEGIN', ...PIN]);
  });

  it('refuses before issuing any DDL when the target schema does not exist', async () => {
    // Postgres accepts a missing namespace in search_path silently and resolves
    // past it, so without this check the DDL ran in whatever came next.
    const { issued, error } = await withStubbedClient({ schemaExists: false }, () =>
      schemaPush(SCHEMA_DEF, 'postgres://stub/db', {
        precomputedDiff: diffWithOneStatement(),
        allowDestructive: true,
        schema: 'ghost',
      }),
    );

    assert.match((error as Error).message, /Schema "ghost" does not exist/);
    assert.equal(
      issued.some((s) => s.startsWith('ALTER TABLE')),
      false,
      'no DDL may be issued once the target schema is known to be missing',
    );
    assert.equal(issued.includes('SHOW search_path'), false, 'it should not get as far as reading the path');
    assert.equal(issued.at(-1), 'ROLLBACK', 'the transaction must still be unwound');
  });
});
