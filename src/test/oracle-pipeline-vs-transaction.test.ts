/**
 * Oracle 5: pipeline() vs $transaction([...]) on database state.
 *
 * Both run a batch of deferred queries atomically: either every statement's
 * effect is durable, or none is. The batches here include slots that fail in
 * every way a slot can: a lookup that finds nothing (`...OrThrow`), an update or
 * delete that matches no row, a unique, check or foreign-key violation, and an
 * optimistic-lock mismatch.
 *
 * A batch that fails is allowed to be rejected in either shape (the error
 * classes may differ). What it is not allowed to do is leave a trace. After each
 * run the tables are read back with raw SQL and compared with:
 *   - the initial state, for a batch with a failing slot
 *   - the state a hand-written SQL transaction produces, for a batch that succeeds
 *
 * Comparing pipeline() with $transaction() alone would pass if both were wrong
 * the same way; both are therefore compared with the raw state.
 *
 * Run: DATABASE_URL=postgres://... npx tsx --test src/test/oracle-pipeline-vs-transaction.test.ts
 */

import { describe } from 'node:test';
import type pg from 'pg';
import { skipGate } from './helpers.js';
import { DATABASE_URL, SKIP } from './oracle/env.js';
import { Failures } from './oracle/failures.js';
import { dumpJson, rawReader, rawWriter, runScript } from './oracle/raw.js';
import {
  attempt,
  describeError,
  introspectTables,
  isTurbineError,
  makeClient,
  type OracleClient,
  show,
  stable,
} from './oracle/util.js';

const FILE = 'oracle-pipeline-vs-transaction.test.ts';
const { it, before, after } = skipGate(SKIP, 'DATABASE_URL not set');

const ACC = 'orc_t_accounts';
const LOG = 'orc_t_log';

const DDL = `
DROP TABLE IF EXISTS ${LOG}, ${ACC} CASCADE;
CREATE TABLE ${ACC} (
  id int PRIMARY KEY,
  owner text NOT NULL UNIQUE,
  balance int NOT NULL CHECK (balance >= 0),
  version int NOT NULL DEFAULT 1
);
CREATE TABLE ${LOG} (
  id serial PRIMARY KEY,
  account_id int NOT NULL REFERENCES ${ACC}(id),
  note text NOT NULL
);
`;

const SEED = `
TRUNCATE ${LOG}, ${ACC} RESTART IDENTITY;
INSERT INTO ${ACC} VALUES (1, 'alice', 100, 1), (2, 'bob', 50, 1), (3, 'carol', 0, 1);
`;

interface Scenario {
  name: string;
  /** Deferred queries for the batch, built against the client under test. */
  build: (db: OracleClient) => unknown[];
  /** Hand-written equivalent for a batch that succeeds; omitted for one that must fail. */
  raw?: string[];
}

const acc = (db: OracleClient) => db.t(ACC);
const log = (db: OracleClient) => db.t(LOG);

const SCENARIOS: Scenario[] = [
  {
    name: 'every slot succeeds',
    build: (db) => [
      acc(db).buildUpdate({ where: { id: 1 }, data: { balance: { decrement: 10 } } }),
      acc(db).buildUpdate({ where: { id: 2 }, data: { balance: { increment: 10 } } }),
      log(db).buildCreate({ data: { accountId: 1, note: 'transfer' } }),
      acc(db).buildFindUniqueOrThrow({ where: { id: 1 } }),
    ],
    raw: [
      `UPDATE ${ACC} SET balance = balance - 10 WHERE id = 1`,
      `UPDATE ${ACC} SET balance = balance + 10 WHERE id = 2`,
      `INSERT INTO ${LOG} (account_id, note) VALUES (1, 'transfer')`,
    ],
  },
  {
    name: 'zero-row updateMany and deleteMany are not failures',
    build: (db) => [
      acc(db).buildUpdateMany({ where: { owner: 'nobody' }, data: { balance: 1 } }),
      acc(db).buildDeleteMany({ where: { id: 99 } }),
      log(db).buildCreate({ data: { accountId: 2, note: 'still written' } }),
    ],
    raw: [`INSERT INTO ${LOG} (account_id, note) VALUES (2, 'still written')`],
  },
  {
    name: 'optimistic lock matches',
    build: (db) => [
      acc(db).buildUpdate({
        where: { id: 1 },
        data: { balance: 90 },
        optimisticLock: { field: 'version', expected: 1 },
      }),
      log(db).buildCreate({ data: { accountId: 1, note: 'locked write' } }),
    ],
    raw: [
      `UPDATE ${ACC} SET balance = 90, version = version + 1 WHERE id = 1 AND version = 1`,
      `INSERT INTO ${LOG} (account_id, note) VALUES (1, 'locked write')`,
    ],
  },
  {
    name: 'findUniqueOrThrow finds nothing in the last slot',
    build: (db) => [
      acc(db).buildUpdate({ where: { id: 1 }, data: { balance: { decrement: 10 } } }),
      acc(db).buildFindUniqueOrThrow({ where: { id: 99 } }),
    ],
  },
  {
    name: 'findUniqueOrThrow finds nothing in the first slot',
    build: (db) => [
      acc(db).buildFindUniqueOrThrow({ where: { id: 99 } }),
      acc(db).buildUpdate({ where: { id: 1 }, data: { balance: { decrement: 10 } } }),
    ],
  },
  {
    name: 'findUniqueOrThrow finds nothing in the middle, writes on both sides',
    build: (db) => [
      acc(db).buildUpdate({ where: { id: 1 }, data: { balance: { decrement: 10 } } }),
      acc(db).buildFindUniqueOrThrow({ where: { id: 99 } }),
      acc(db).buildUpdate({ where: { id: 2 }, data: { balance: { increment: 10 } } }),
      log(db).buildCreate({ data: { accountId: 1, note: 'after the miss' } }),
    ],
  },
  {
    name: 'findFirstOrThrow finds nothing',
    build: (db) => [
      acc(db).buildUpdate({ where: { id: 1 }, data: { balance: { decrement: 10 } } }),
      acc(db).buildFindFirstOrThrow({ where: { owner: 'nobody' } }),
    ],
  },
  {
    name: 'update matches no row',
    build: (db) => [
      log(db).buildCreate({ data: { accountId: 1, note: 'before' } }),
      acc(db).buildUpdate({ where: { id: 99 }, data: { balance: 1 } }),
    ],
  },
  {
    name: 'delete matches no row',
    build: (db) => [
      log(db).buildCreate({ data: { accountId: 1, note: 'before' } }),
      acc(db).buildDelete({ where: { id: 99 } }),
    ],
  },
  {
    name: 'optimistic lock mismatch',
    build: (db) => [
      log(db).buildCreate({ data: { accountId: 1, note: 'before' } }),
      acc(db).buildUpdate({
        where: { id: 1 },
        data: { balance: 0 },
        optimisticLock: { field: 'version', expected: 7 },
      }),
      acc(db).buildUpdate({ where: { id: 2 }, data: { balance: 0 } }),
    ],
  },
  {
    name: 'unique violation',
    build: (db) => [
      acc(db).buildUpdate({ where: { id: 1 }, data: { balance: { decrement: 10 } } }),
      acc(db).buildCreate({ data: { id: 10, owner: 'bob', balance: 1 } }),
    ],
  },
  {
    name: 'check violation',
    build: (db) => [
      log(db).buildCreate({ data: { accountId: 3, note: 'before' } }),
      acc(db).buildUpdate({ where: { id: 3 }, data: { balance: { decrement: 5 } } }),
    ],
  },
  {
    name: 'foreign-key violation',
    build: (db) => [
      acc(db).buildUpdate({ where: { id: 1 }, data: { balance: { decrement: 10 } } }),
      log(db).buildCreate({ data: { accountId: 999, note: 'orphan' } }),
    ],
  },
];

let db: OracleClient;
let reader: pg.Client;
let writer: pg.Client;

async function snapshot(): Promise<string> {
  const accounts = await dumpJson(reader, ACC);
  const logRows = (await dumpJson(reader, LOG, 'note, account_id')).map((r) => ({
    accountId: r.account_id,
    note: r.note,
  }));
  return stable({ accounts, log: logRows });
}

async function reset(): Promise<void> {
  await writer.query(SEED);
}

describe('oracle: pipeline() and $transaction([...]) are all-or-nothing, on database state', () => {
  before(async () => {
    await runScript(DATABASE_URL!, DDL);
    const schema = await introspectTables(DATABASE_URL!, [ACC, LOG]);
    db = makeClient(DATABASE_URL!, schema);
    reader = await rawReader(DATABASE_URL!);
    writer = await rawWriter(DATABASE_URL!);
  });

  after(async () => {
    await db?.disconnect();
    await reader?.end();
    await writer?.end();
    if (!SKIP) await runScript(DATABASE_URL!, `DROP TABLE IF EXISTS ${LOG}, ${ACC} CASCADE`);
  });

  for (const scenario of SCENARIOS) {
    it(scenario.name, async () => {
      const failures = new Failures(FILE);
      await reset();
      const initial = await snapshot();
      let expectedState = initial;
      if (scenario.raw) {
        await writer.query(['BEGIN', ...scenario.raw, 'COMMIT'].join(';\n'));
        expectedState = await snapshot();
        await reset();
      }
      const mustSucceed = scenario.raw !== undefined;
      const outcomes: Record<string, { ok: boolean; value?: unknown; error?: unknown }> = {};

      for (const [label, run] of [
        ['pipeline', (qs: unknown[]) => (db.pipeline as (q: unknown[]) => Promise<unknown>)(qs)],
        ['$transaction', (qs: unknown[]) => (db.$transaction as (q: unknown[]) => Promise<unknown>)(qs)],
      ] as const) {
        await reset();
        const result = await attempt(() => run(scenario.build(db)));
        outcomes[label] = result.ok ? { ok: true, value: result.value } : { ok: false, error: result.error };
        const state = await snapshot();

        failures.checked(2);
        if (mustSucceed && !result.ok) {
          failures.add(`${label}: rejected a batch with no failing slot`, describeError(result.error));
        } else if (!mustSucceed && result.ok) {
          failures.add(
            `${label}: resolved although a slot fails`,
            `resolved with ${stable(result.value).slice(0, 200)}`,
          );
        } else if (!result.ok && !isTurbineError(result.error)) {
          failures.add(`${label}: rejected with an untyped error`, describeError(result.error));
        }
        if (state !== expectedState) {
          failures.add(
            `${label}: database state is wrong after ${mustSucceed ? 'a successful' : 'a FAILED'} batch`,
            `expected ${mustSucceed ? 'the state a raw SQL transaction produces' : 'the initial state (nothing durable)'}\n` +
              `expected ${expectedState}\n` +
              `actual   ${state}\n` +
              `outcome  ${result.ok ? 'resolved' : describeError(result.error)}`,
          );
        }
      }

      // The two entry points must also agree with each other on the same input.
      failures.checked();
      if (outcomes.pipeline?.ok !== outcomes.$transaction?.ok) {
        failures.add(
          'pipeline and $transaction disagree on success',
          `pipeline ${outcomes.pipeline?.ok ? 'resolved' : 'rejected'}, $transaction ${outcomes.$transaction?.ok ? 'resolved' : 'rejected'}`,
        );
      } else if (outcomes.pipeline?.ok && stable(outcomes.pipeline.value) !== stable(outcomes.$transaction?.value)) {
        failures.add(
          'pipeline and $transaction resolve to different results',
          `pipeline ${show(outcomes.pipeline.value).slice(0, 300)}\n$transaction ${show(outcomes.$transaction?.value).slice(0, 300)}`,
        );
      }
      failures.assertClean(scenario.name, 5);
    });
  }
});
