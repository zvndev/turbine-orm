/**
 * turbine-orm — RLS / session-context ($transaction sessionContext) tests
 *
 * Two layers:
 *
 *  1. **Unit (no DB).** Drive $transaction against a mock pool that captures
 *     every (sql, params) pair. Prove that:
 *       - each session-context entry becomes `SELECT set_config($1, $2, true)`
 *         with BOUND [name, value] params (never interpolated), applied AFTER
 *         BEGIN and before the user fn;
 *       - an invalid GUC name throws ValidationError and NEVER reaches a query
 *         (no set_config, and the transaction rolls back).
 *
 *  2. **Integration (needs DATABASE_URL).** Create a real RLS-protected table
 *     with a policy keyed on current_setting('app.current_tenant'), seed two
 *     tenants, and prove that inside
 *     $transaction(fn, { sessionContext: { 'app.current_tenant': 'A' } }) a
 *     SELECT returns ONLY tenant A's rows — and a different tenant value
 *     returns the other set. FORCE ROW LEVEL SECURITY is used so even the
 *     table owner / local superuser is subject to the policy.
 *
 * Run: DATABASE_URL=postgres://... npx tsx --test src/test/rls-session.test.ts
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { TurbineClient } from '../client.js';
import { ValidationError } from '../errors.js';
import { introspect } from '../introspect.js';
import type { SchemaMetadata } from '../schema.js';

// Minimal schema with a single table so TurbineClient constructs.
const MOCK_SCHEMA: SchemaMetadata = {
  tables: {
    widgets: {
      name: 'widgets',
      columns: {
        id: { name: 'id', type: 'number', dbType: 'int4', nullable: false, isPrimaryKey: true, hasDefault: true },
      },
      primaryKey: ['id'],
      relations: {},
      indexes: [],
    },
  },
} as unknown as SchemaMetadata;

/**
 * A mock pool whose checked-out client records every query. Good enough to
 * drive $transaction without a real database.
 */
function makeCapturingPool() {
  const captured: { sql: string; params: unknown[] }[] = [];
  const client = {
    query: async (sql: string, params?: unknown[]) => {
      captured.push({ sql, params: params ?? [] });
      return { rows: [], rowCount: 0 };
    },
    release: () => {},
  };
  const pool = {
    connect: async () => client,
    query: async (sql: string, params?: unknown[]) => {
      captured.push({ sql, params: params ?? [] });
      return { rows: [], rowCount: 0 };
    },
    end: async () => {},
  };
  return { pool, captured };
}

// ---------------------------------------------------------------------------
// Unit — no DB
// ---------------------------------------------------------------------------

describe('rls session-context (unit)', () => {
  it('emits SELECT set_config($1,$2,true) with bound [name,value] after BEGIN', async () => {
    const { pool, captured } = makeCapturingPool();
    const db = new TurbineClient({ pool: pool as never }, MOCK_SCHEMA);

    await db.$transaction(async () => 'ok', {
      sessionContext: { 'app.current_tenant': '42', 'app.current_user': 7 },
    });

    const sqls = captured.map((c) => c.sql);
    // BEGIN first, COMMIT last.
    assert.equal(sqls[0], 'BEGIN');
    assert.equal(sqls[sqls.length - 1], 'COMMIT');

    const configCalls = captured.filter((c) => c.sql === 'SELECT set_config($1, $2, true)');
    assert.equal(configCalls.length, 2, 'one set_config per session-context entry');
    assert.deepEqual(configCalls[0]!.params, ['app.current_tenant', '42']);
    // numeric value coerced to string via String(value)
    assert.deepEqual(configCalls[1]!.params, ['app.current_user', '7']);

    // set_config must come AFTER BEGIN and BEFORE COMMIT.
    const beginIdx = sqls.indexOf('BEGIN');
    const commitIdx = sqls.indexOf('COMMIT');
    const firstConfigIdx = sqls.indexOf('SELECT set_config($1, $2, true)');
    assert.ok(firstConfigIdx > beginIdx, 'set_config runs after BEGIN');
    assert.ok(firstConfigIdx < commitIdx, 'set_config runs before COMMIT');
  });

  it('coerces boolean values to string', async () => {
    const { pool, captured } = makeCapturingPool();
    const db = new TurbineClient({ pool: pool as never }, MOCK_SCHEMA);
    await db.$transaction(async () => 'ok', { sessionContext: { 'app.is_admin': true } });
    const cfg = captured.find((c) => c.sql === 'SELECT set_config($1, $2, true)');
    assert.deepEqual(cfg!.params, ['app.is_admin', 'true']);
  });

  it('an invalid GUC name throws ValidationError and never issues set_config', async () => {
    const { pool, captured } = makeCapturingPool();
    const db = new TurbineClient({ pool: pool as never }, MOCK_SCHEMA);

    await assert.rejects(
      () =>
        db.$transaction(async () => 'ok', {
          // contains a quote + semicolon — clearly not a valid GUC identifier
          sessionContext: { 'app.tenant"; DROP TABLE x; --': 'A' },
        }),
      (err: unknown) => {
        assert.ok(err instanceof ValidationError, 'expected ValidationError');
        return true;
      },
    );

    // No set_config call ever happened, and the txn rolled back (not committed).
    assert.ok(
      !captured.some((c) => c.sql === 'SELECT set_config($1, $2, true)'),
      'set_config must never run for an invalid name',
    );
    assert.ok(!captured.some((c) => c.sql === 'COMMIT'), 'transaction must NOT commit');
    assert.ok(
      captured.some((c) => c.sql === 'ROLLBACK'),
      'transaction must roll back after the validation error',
    );
  });

  it('$withSession is equivalent to $transaction with sessionContext', async () => {
    const { pool, captured } = makeCapturingPool();
    const db = new TurbineClient({ pool: pool as never }, MOCK_SCHEMA);
    await db.$withSession({ 'app.current_tenant': 'abc' }, async () => 'ok');
    const cfg = captured.find((c) => c.sql === 'SELECT set_config($1, $2, true)');
    assert.deepEqual(cfg!.params, ['app.current_tenant', 'abc']);
  });

  it('rejects a name with embedded whitespace', async () => {
    const { pool } = makeCapturingPool();
    const db = new TurbineClient({ pool: pool as never }, MOCK_SCHEMA);
    await assert.rejects(
      () => db.$transaction(async () => 'ok', { sessionContext: { 'app current': 'x' } }),
      ValidationError,
    );
  });
});

// ---------------------------------------------------------------------------
// Integration — needs DATABASE_URL
// ---------------------------------------------------------------------------

const DATABASE_URL = process.env.DATABASE_URL;
const SKIP = !DATABASE_URL;
if (SKIP) {
  console.log('⚠ Skipping rls-session integration tests: DATABASE_URL not set');
}
const testFn = SKIP ? describe.skip : describe;

testFn('rls session-context integration', () => {
  let client: TurbineClient;
  let schema: SchemaMetadata;
  // Constant identifier — baked literally into SQL strings below. Never user input.
  const TABLE = '_w3_rls_docs';
  // A NON-superuser, NON-BYPASSRLS role. The local connection role is a
  // superuser with rolbypassrls=true, which skips ALL row-level security
  // regardless of FORCE. To actually prove the policy filters, each test
  // transaction SET LOCAL ROLEs to this constrained role.
  const RLS_ROLE = 'w3_rls_role';

  before(async () => {
    // Bootstrap the RLS table on a raw connection first so introspection sees it.
    const bootstrap = new TurbineClient({ connectionString: DATABASE_URL! }, MOCK_SCHEMA);
    await bootstrap.pool.query(`DROP TABLE IF EXISTS "${TABLE}"`);
    // (Re)create a constrained role. NOBYPASSRLS is the default, but be explicit.
    await bootstrap.pool.query(`DROP ROLE IF EXISTS ${RLS_ROLE}`).catch(() => {});
    await bootstrap.pool.query(`CREATE ROLE ${RLS_ROLE} NOLOGIN NOSUPERUSER NOBYPASSRLS`);
    await bootstrap.pool.query(`
      CREATE TABLE "${TABLE}" (
        id serial PRIMARY KEY,
        tenant text NOT NULL,
        body text NOT NULL
      )
    `);
    await bootstrap.pool.query(`ALTER TABLE "${TABLE}" ENABLE ROW LEVEL SECURITY`);
    // FORCE so the table owner is ALSO subject to the policy (belt + braces;
    // the real lever here is running as a NOBYPASSRLS role).
    await bootstrap.pool.query(`ALTER TABLE "${TABLE}" FORCE ROW LEVEL SECURITY`);
    await bootstrap.pool.query(`
      CREATE POLICY tenant_isolation ON "${TABLE}"
        USING (tenant = current_setting('app.current_tenant', true))
    `);
    // The constrained role must be allowed to SELECT (RLS filters WHAT it sees).
    await bootstrap.pool.query(`GRANT SELECT ON "${TABLE}" TO ${RLS_ROLE}`);
    await bootstrap.pool.query(
      `INSERT INTO "${TABLE}" (tenant, body) VALUES ('A', 'a-one'), ('A', 'a-two'), ('B', 'b-one')`,
    );
    await bootstrap.disconnect();

    schema = await introspect({ connectionString: DATABASE_URL! });
    client = new TurbineClient({ connectionString: DATABASE_URL!, poolSize: 3 }, schema);
    await client.connect();
  });

  after(async () => {
    try {
      await client.pool.query(`DROP TABLE IF EXISTS "${TABLE}"`);
      await client.pool.query(`DROP ROLE IF EXISTS ${RLS_ROLE}`);
    } catch {
      // best-effort cleanup
    }
    await client.disconnect();
  });

  // Helper: run a SELECT on the RLS table INSIDE a $transaction with the given
  // session context. We SET LOCAL ROLE to the NOBYPASSRLS role first (also
  // transaction-local, auto-resets on COMMIT) so RLS is actually enforced, then
  // run the SELECT — both on the transaction's own connection, so the GUCs set
  // by sessionContext apply.
  const selectTenants = (ctx?: Record<string, string>) =>
    client.$transaction(
      async (tx) => {
        await tx.raw`SET LOCAL ROLE w3_rls_role`;
        return tx.raw<{ tenant: string }>`SELECT tenant FROM "_w3_rls_docs" ORDER BY id`;
      },
      ctx ? { sessionContext: ctx } : undefined,
    );

  it('sessionContext tenant=A returns only tenant A rows', async () => {
    const rows = await selectTenants({ 'app.current_tenant': 'A' });
    assert.equal(rows.length, 2, 'only tenant A rows visible');
    assert.ok(
      rows.every((r) => r.tenant === 'A'),
      'every visible row belongs to tenant A',
    );
  });

  it('sessionContext tenant=B returns only tenant B rows', async () => {
    const rows = await selectTenants({ 'app.current_tenant': 'B' });
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.tenant, 'B');
  });

  it('without sessionContext the policy filters everything out (GUC unset)', async () => {
    // With no app.current_tenant set, current_setting(..., true) is NULL, so
    // the USING clause is NULL (treated as false) and no rows are visible.
    const rows = await selectTenants();
    assert.equal(rows.length, 0, 'no tenant set -> RLS hides all rows');
  });

  it('the GUC auto-resets between transactions (is_local scoping)', async () => {
    // Set A in one transaction, then B in the next — if is_local leaked onto
    // the pooled connection, the second txn might still see A.
    await client.$transaction(async () => 'ok', { sessionContext: { 'app.current_tenant': 'A' } });
    const rows = await selectTenants({ 'app.current_tenant': 'B' });
    assert.ok(rows.every((r) => r.tenant === 'B'));
  });
});
