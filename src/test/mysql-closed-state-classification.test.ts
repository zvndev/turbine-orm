/** Only mysql2's own closed-connection refusal may classify as never sent. Fails until fixed. */
import assert from 'node:assert/strict';
import { it } from 'node:test';
import { driverConnectionLoss, refusedBeforeSending } from '../errors.js';

const CLOSED = "Can't add new command when connection is in closed state";

it('classifies mysql2 closed-connection shapes by driver fields, not message text alone', () => {
  // mysql2's real refusal (`_addCommandClosedState`): fatal, no code, no errno.
  const refused = Object.assign(new Error(CLOSED), { fatal: true });
  const loss = driverConnectionLoss(refused);
  assert.ok(loss, 'the genuine closed-state refusal is a connection loss');
  assert.equal(refusedBeforeSending(loss), true);

  // A statement whose socket closed mid-flight may have committed: a loss,
  // but never a refusal.
  const sent = Object.assign(new Error('Connection lost: The server closed the connection.'), {
    code: 'PROTOCOL_CONNECTION_LOST',
    fatal: true,
  });
  const sentLoss = driverConnectionLoss(sent);
  assert.ok(sentLoss, 'a lost in-flight command is a connection loss');
  assert.equal(refusedBeforeSending(sentLoss), false);

  // A server error packet that merely carries the same words (a SIGNAL with
  // that message text) was received and answered by the server: it is
  // neither a connection loss nor a statement that was never sent.
  const answered = Object.assign(new Error(CLOSED), {
    code: 'ER_SIGNAL_EXCEPTION',
    errno: 1644,
    sqlState: '45000',
    sqlMessage: CLOSED,
    fatal: false,
  });
  assert.equal(driverConnectionLoss(answered), undefined);
});
