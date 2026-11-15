import assert from 'node:assert/strict';
import { it } from 'node:test';
import { TransactionOutcomeUnknownError } from '../errors.js';
import { createRecovery } from '../neon-ws/recovery.js';

it('WS recovery: a reason that ends an unanswered COMMIT is the cause of E021, with the unknown state', async () => {
  const recovery = createRecovery(false);
  recovery.commitSent();
  let sent = false;
  assert.equal(
    await recovery.rollback(
      false,
      async () => {
        sent = true;
      },
      2000,
    ),
    false,
  );
  assert.equal(sent, false);
  const reason = new Error('caller signal reason');
  let ended = '';
  const logs: string[] = [];
  const reported = recovery.finish(
    {
      end: (how) => {
        ended = how;
      },
    },
    false,
    reason,
    {
      debug: (_message, entry) => {
        logs.push(entry.code);
      },
    },
  );
  assert.ok(reported instanceof TransactionOutcomeUnknownError, `got ${String(reported)}`);
  assert.equal(reported.cause, reason);
  assert.equal(ended, 'ended with an unknown outcome');
  assert.deepEqual(logs, ['transaction-outcome-unknown']);
});

it('confirmed cleanup preserves an undefined thrown value and unrelated errors', () => {
  const recovery = createRecovery(false);
  const state = { end: () => {} };
  assert.equal(recovery.finish(state, true, undefined), undefined);
  const reason = new Error('callback failed');
  assert.equal(recovery.finish(state, true, reason), reason);
  const timeout = recovery.timeoutError(100);
  const confirmed = recovery.finish(state, true, timeout) as typeof timeout;
  assert.equal(confirmed.outcome, 'not-executed');
  assert.match(confirmed.message, /rollback was confirmed/);
  assert.doesNotMatch(confirmed.message, /cancelled/);
});

it('a server ROLLBACK command tag clears COMMIT uncertainty', async () => {
  const recovery = createRecovery(false);
  recovery.commitSent();
  recovery.commitSent(true);
  let sent = false;
  assert.equal(
    await recovery.rollback(
      false,
      async () => {
        sent = true;
      },
      2000,
    ),
    true,
  );
  assert.equal(sent, true);
});

it('caller-managed cleanup waits for rollback even when a statement is running', async () => {
  const recovery = createRecovery(true);
  assert.throws(() => recovery.assertTimeout(1), /Cannot cancel or destroy/);
  recovery.assertTimeout(0);
  const pooled = createRecovery(false);
  pooled.assertTimeout(1);
  let release!: () => void;
  let ended = false;
  const rollback = recovery.rollback(
    true,
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    0,
  );
  void rollback.then(() => {
    ended = true;
  });
  await Promise.resolve();
  assert.equal(ended, false);
  release();
  assert.equal(await rollback, true);
});

it('a pooled running statement cannot claim rollback or server cancellation', async () => {
  const recovery = createRecovery(false);
  let sent = false;
  assert.equal(
    await recovery.rollback(
      true,
      async () => {
        sent = true;
      },
      2000,
    ),
    false,
  );
  assert.equal(sent, false);
  const error = recovery.timeoutError(100);
  assert.equal(error.outcome, 'unknown');
  assert.match(error.message, /not confirmed/);
});
