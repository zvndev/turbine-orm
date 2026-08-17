/**
 * The tracking-table create race, asserted as a RULE rather than fished for.
 *
 * `migrate status` and the deploy inspector deliberately hold no lock, so
 * several of them on a fresh database all run `CREATE TABLE IF NOT EXISTS`
 * concurrently. That statement is not atomic (the existence check and the
 * catalog insert are separate steps), so the losers get a hard error and
 * `ensureTrackingTable` retries once.
 *
 * Which error the loser gets is not fixed. Creating a table also creates its
 * composite row type, so depending on how far a loser got it reports a
 * duplicate relation, a duplicate type, or a unique violation on the catalog
 * index. The original set was written from what one measured run happened to
 * produce and listed only two of the three; the third (42710) reached a release
 * gate six versions later, as an intermittent failure whose message named
 * nothing.
 *
 * The live 12-way race test still exists in migrate-smoke-fixes.test.ts, and it
 * is what found the class. But it only reproduces about 12% of the time, so it
 * is a smoke test and not a gate. THIS file is the gate: one deterministic case
 * per accepted code, plus the two boundaries that must NOT be swallowed.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ensureTrackingTable, type MigrationQueryClient } from '../cli/migrate.js';
import type { PgCompatQueryResult } from '../pg-types.js';

/** Every Postgres code a losing session has been observed to report. */
const RACE_LOSER_CODES = [
  // relation "_turbine_migrations" already exists
  '42P07',
  // duplicate key value violates unique constraint "pg_type_typname_nsp_index"
  '23505',
  // type "_turbine_migrations" already exists
  '42710',
] as const;

function pgError(code: string, message = `failed with ${code}`): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

const EMPTY: PgCompatQueryResult<Record<string, unknown>> = {
  rows: [],
  rowCount: 0,
  command: 'CREATE',
  fields: [],
};

/**
 * A client that fails its first N calls with `code` and then succeeds,
 * recording how many times it was asked.
 */
function failingClient(code: string, failures: number): MigrationQueryClient & { calls: number } {
  const client = {
    calls: 0,
    async query<R = Record<string, unknown>>(): Promise<PgCompatQueryResult<R>> {
      client.calls++;
      if (client.calls <= failures) throw pgError(code);
      return EMPTY as PgCompatQueryResult<R>;
    },
  };
  return client;
}

describe('tracking-table create race', () => {
  for (const code of RACE_LOSER_CODES) {
    it(`retries once and succeeds when the losing session gets ${code}`, async () => {
      const client = failingClient(code, 1);
      await ensureTrackingTable(client);
      assert.equal(client.calls, 2, 'the create should be attempted exactly twice');
    });
  }

  it('does not swallow an error that is not this race', async () => {
    // 42501 is permission denied. Retrying it would turn a misconfigured role
    // into an infinite-looking no-op instead of a message the operator can act
    // on, so it must propagate on the FIRST failure.
    const client = failingClient('42501', 1);
    await assert.rejects(() => ensureTrackingTable(client), /42501/);
    assert.equal(client.calls, 1, 'an unrelated error must not be retried at all');
  });

  it('retries exactly once, so a persistent failure still surfaces', async () => {
    // A second failure is by definition not the race: the winner has committed
    // by the time the loser sees its error, so the retry finds the table there.
    // Retrying further would hide a real and permanent problem.
    const client = failingClient('42P07', 2);
    await assert.rejects(() => ensureTrackingTable(client), /42P07/);
    assert.equal(client.calls, 2, 'exactly one retry, then surface');
  });

  it('issues one statement when nothing races', async () => {
    const client = failingClient('42P07', 0);
    await ensureTrackingTable(client);
    assert.equal(client.calls, 1, 'the uncontended path must not pay for the retry');
  });
});
