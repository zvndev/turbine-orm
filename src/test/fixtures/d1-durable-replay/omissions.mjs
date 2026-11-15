/** Run against separate real D1 tenant keys, never a mock persistence engine. */
import { check, command, rejects } from './contract.mjs';

const gate = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
export async function omissions(api, db) {
  const { ReplayApp } = api;
  const source = new ReplayApp(db);
  await source.append('omission_ack', command());
  await source.append('omission_ack', command('2'));
  // Replaces exactly the ack assertion with an unconditional native SELECT.
  // Every result remains real; only the missing condition changes behavior.
  const noAckGuard = {
    prepare: (sql) => db.prepare(sql),
    async batch(st) {
      if (st.length === 4) {
        return db.batch([st[0], db.prepare('SELECT 1 AS admitted'), st[2], st[3]]);
      }
      return db.batch(st);
    },
  };
  const slow = new ReplayApp(noAckGuard),
    fast = new ReplayApp(db),
    entered = gate(),
    release = gate();
  const short = slow.deliver(
    'omission_ack',
    'warehouse',
    () => {
      entered.resolve();
      return release.promise;
    },
    { limit: 1 },
  );
  await entered.promise;
  check((await fast.deliver('omission_ack', 'warehouse', () => {})) === 2, 'Omission control setup');
  release.resolve();
  check((await short) === 1, 'Omitted guard must permit stale ack');
  check(
    (await fast.checkpoint('omission_ack', 'warehouse')) === 1,
    'Missing CAS guard control must expose actual checkpoint regression',
  );
  // Native atomicity omission: splitting a batch allows the business row to escape a later failure.
  const split = {
    prepare: (sql) => db.prepare(sql),
    async batch(st) {
      if (st.length === 6) {
        await db.batch(st.slice(0, 3));
        throw Error('lost second half');
      }
      return db.batch(st);
    },
  };
  const fractured = new ReplayApp(split);
  await rejects(() => fractured.append('omission_atomic', command()));
  check(
    (await db.prepare("SELECT * FROM replay_orders WHERE tenant='omission_atomic'").all()).results.length === 1,
    'Split omission must leak business effect',
  );
  check(
    (await db.prepare("SELECT * FROM replay_events WHERE tenant='omission_atomic'").all()).results.length === 0,
    'Split omission missing outbox',
  );
  for (const app of [source, slow, fast, fractured]) await app.close();
  return {
    omittedAckGuard: 'native checkpoint regressed 2 to 1',
    omittedAtomicBatch: 'business row escaped without event',
  };
}
