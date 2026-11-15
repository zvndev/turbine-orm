/**
 * The extended-protocol pipeline when its connection dies mid-exchange.
 *
 * The batch is not the pg Client's active query, so the Client cannot fail it
 * when the socket goes: `runPipelined` listens for the Connection's `end` /
 * `error` itself. These drive a hand-stepped Connection through every point a
 * connection can be lost and pin what the caller is told, that the client is
 * marked for disposal, and that the Client's own listeners are restored.
 * src/test/pipeline-connection-loss.integration.test.ts covers the same
 * against a real server through a proxy that cuts the socket.
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { describe, it } from 'node:test';
import {
  ConnectionError,
  PipelineError,
  TimeoutError,
  TransactionOutcomeUnknownError,
  TransactionRolledBackError,
  TurbineErrorCode,
  UniqueConstraintError,
} from '../errors.js';
import { type PgPoolClient, pipelineClientNeedsDiscard, runPipelined } from '../pipeline-submittable.js';
import type { DeferredQuery } from '../query/index.js';

class SteppedConnection extends EventEmitter {
  readonly sent: string[] = [];
  readonly stream: { cork(): void; uncork(): void; destroy(): void } = { cork() {}, uncork() {}, destroy() {} };
  parse(query: { text: string }) {
    this.sent.push(query.text);
  }
  bind() {}
  describe() {}
  execute() {}
  sync() {
    this.sent.push('Sync');
  }
  /** Answer one statement of the batch: parse, bind, then its command tag. */
  complete(tag: string) {
    this.emit('parseComplete');
    this.emit('bindComplete');
    this.emit('commandComplete', { text: tag, command: tag.split(' ')[0] });
  }
}

function setup() {
  const connection = new SteppedConnection();
  const clientEnd = () => {};
  const clientError = () => {};
  connection.on('end', clientEnd);
  connection.on('error', clientError);
  const client = { connection, readyForQuery: true, release() {} } as unknown as PgPoolClient;
  return { connection, client, clientEnd, clientError };
}

const write = (sql = 'INSERT INTO t (n) VALUES ($1)') =>
  ({
    sql,
    params: [1],
    tag: 't.create',
    transform: (r: { rowCount: number }) => r.rowCount,
  }) as unknown as DeferredQuery<unknown>;

/** Drive a one-write transactional batch to the point where its held COMMIT has been sent. */
function toCommit() {
  const s = setup();
  const pending = runPipelined(s.client, [write()]);
  s.connection.complete('BEGIN');
  s.connection.complete('INSERT 0 1');
  s.connection.emit('readyForQuery', { status: 'T' });
  assert.deepEqual(s.connection.sent.slice(-2), ['COMMIT', 'Sync'], 'the held COMMIT was sent');
  return { ...s, pending };
}

function assertRestored(s: ReturnType<typeof setup>) {
  assert.deepEqual(s.connection.listeners('end'), [s.clientEnd], 'only the Client end listener remains');
  assert.deepEqual(s.connection.listeners('error'), [s.clientError], 'only the Client error listener remains');
  assert.equal(s.client.readyForQuery, true);
  assert.equal(pipelineClientNeedsDiscard(s.client), true, 'a lost connection is never lent out again');
}

// A batch that never settles must fail here, not hang the runner.
describe('runPipelined when the connection is lost', { timeout: 5000 }, () => {
  it('rejects with a connection error when it closes before the held COMMIT is sent', async () => {
    const s = setup();
    const pending = runPipelined(s.client, [write(), write()]);
    s.connection.complete('BEGIN');
    s.connection.complete('INSERT 0 1');
    s.connection.emit('end');
    await assert.rejects(pending, (err) => err instanceof ConnectionError && !(err instanceof PipelineError));
    assert.ok(!s.connection.sent.includes('COMMIT'), 'no COMMIT follows a lost connection');
    assertRestored(s);
  });

  it('carries the socket error when the connection fails rather than closes', async () => {
    const s = setup();
    const pending = runPipelined(s.client, [write()]);
    s.connection.emit('error', Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }));
    await assert.rejects(pending, (err) => err instanceof ConnectionError && err.sqlstate === 'ECONNRESET');
    assertRestored(s);
  });

  it('keeps the batch error when the connection closes after a statement failed', async () => {
    const s = setup();
    const pending = runPipelined(s.client, [write()]);
    s.connection.complete('BEGIN');
    s.connection.emit('errorMessage', Object.assign(new Error('duplicate key'), { code: '23505', severity: 'ERROR' }));
    s.connection.emit('end');
    await assert.rejects(pending, UniqueConstraintError);
    assertRestored(s);
  });

  // A batch of plain SELECTs sends its COMMIT with the batch, and a SELECT can
  // write through a function it calls, so an unanswered COMMIT there is an
  // unknown outcome too. src/test/pipeline-select-write-loss.integration.test.ts
  // shows the write committing on a real server.
  function selectBatch() {
    const s = setup();
    const pending = runPipelined(s.client, [write('SELECT 1'), write('SELECT 2')]);
    assert.ok(s.connection.sent.includes('COMMIT'), 'a SELECT batch sends its COMMIT with the batch');
    assert.equal(s.connection.sent.filter((m) => m === 'Sync').length, 1, 'in the one exchange');
    return { ...s, pending };
  }

  it('reports an unknown outcome for a batch of plain SELECTs, whose COMMIT went with the batch', async () => {
    const s = selectBatch();
    s.connection.complete('BEGIN');
    s.connection.emit('end');
    await assert.rejects(s.pending, (err) => {
      assert.ok(err instanceof TransactionOutcomeUnknownError, `got ${String(err)}`);
      assert.ok(err.cause instanceof ConnectionError);
      return true;
    });
    assertRestored(s);
  });

  it('reports an unknown outcome for a batch of plain SELECTs closed by a FATAL', async () => {
    const s = selectBatch();
    s.connection.complete('BEGIN');
    s.connection.complete('SELECT 1');
    const fatal = Object.assign(new Error('terminating connection due to administrator command'), {
      code: '57P01',
      severity: 'FATAL',
    });
    s.connection.emit('errorMessage', fatal);
    s.connection.emit('end');
    await assert.rejects(s.pending, (err) => err instanceof TransactionOutcomeUnknownError);
    assertRestored(s);
  });

  it('keeps the error a SELECT batch failed with, which rolled it back', async () => {
    const s = selectBatch();
    s.connection.complete('BEGIN');
    s.connection.emit('errorMessage', Object.assign(new Error('duplicate key'), { code: '23505', severity: 'ERROR' }));
    s.connection.emit('end');
    await assert.rejects(s.pending, UniqueConstraintError);
    assertRestored(s);
  });

  it('reports a rollback when a SELECT batch COMMIT was answered with the ROLLBACK tag', async () => {
    const s = selectBatch();
    for (const tag of ['BEGIN', 'SELECT 1', 'SELECT 1', 'ROLLBACK']) s.connection.complete(tag);
    s.connection.emit('end');
    await assert.rejects(s.pending, TransactionRolledBackError);
    assertRestored(s);
  });

  it('resolves a SELECT batch whose COMMIT was acknowledged before the connection closed', async () => {
    const s = selectBatch();
    for (const tag of ['BEGIN', 'SELECT 1', 'SELECT 1', 'COMMIT']) s.connection.complete(tag);
    s.connection.emit('end');
    assert.deepEqual(await s.pending, [1, 1]);
    assertRestored(s);
  });

  it('reports an unknown outcome when the held COMMIT got no answer', async () => {
    const s = toCommit();
    s.connection.emit('end');
    await assert.rejects(s.pending, (err) => {
      assert.ok(err instanceof TransactionOutcomeUnknownError);
      assert.equal(err.code, TurbineErrorCode.TRANSACTION_OUTCOME_UNKNOWN);
      assert.ok(err.cause instanceof ConnectionError);
      return true;
    });
    assertRestored(s);
  });

  it('reports an unknown outcome when the held COMMIT was answered by a FATAL', async () => {
    const s = toCommit();
    const fatal = Object.assign(new Error('terminating connection due to administrator command'), {
      code: '57P01',
      severity: 'FATAL',
    });
    s.connection.emit('errorMessage', fatal);
    s.connection.emit('end');
    await assert.rejects(s.pending, (err) => err instanceof TransactionOutcomeUnknownError);
    assertRestored(s);
  });

  it('keeps the error that answered the held COMMIT, which rolled it back', async () => {
    const s = toCommit();
    s.connection.emit('errorMessage', Object.assign(new Error('duplicate key'), { code: '23505', severity: 'ERROR' }));
    s.connection.emit('end');
    await assert.rejects(s.pending, UniqueConstraintError);
    assertRestored(s);
  });

  it('reports a rollback when the held COMMIT was answered with the ROLLBACK tag', async () => {
    const s = toCommit();
    s.connection.complete('ROLLBACK');
    s.connection.emit('end');
    await assert.rejects(s.pending, TransactionRolledBackError);
    assertRestored(s);
  });

  it('resolves when the held COMMIT was acknowledged before the connection closed', async () => {
    const s = toCommit();
    s.connection.complete('COMMIT');
    s.connection.emit('end');
    assert.deepEqual(await s.pending, [1]);
    assertRestored(s);
  });

  // Non-transactional mode: every query autocommits at its own Sync and all of
  // them went out in one write, so a query with no ReadyForQuery yet may have
  // committed. Its slot is E021, never E004 (whose advice is that a retry is
  // safe), unless the server answered it with an ERROR.
  const slotError = (err: PipelineError, i: number) => (err.results[i] as { error?: unknown }).error;

  it('reports an unfinished slot as an unknown outcome in non-transactional mode', async () => {
    const s = setup();
    const pending = runPipelined(s.client, [write(), write()], { transactional: false });
    s.connection.complete('INSERT 0 1');
    s.connection.emit('readyForQuery', { status: 'I' });
    s.connection.emit('end');
    await assert.rejects(pending, (err) => {
      assert.ok(err instanceof PipelineError);
      assert.deepEqual(err.results[0], { status: 'ok', value: 1 }, 'an acknowledged slot keeps its result');
      const unknown = slotError(err, 1);
      assert.ok(unknown instanceof TransactionOutcomeUnknownError, `got ${String(unknown)}`);
      assert.ok(unknown.cause instanceof ConnectionError, 'the connection error is the cause');
      assert.equal(err.failedIndex, 1);
      assert.equal(err.cause, unknown, 'the batch error does not carry the connection error alone');
      return true;
    });
    assertRestored(s);
  });

  it('reports a statement whose CommandComplete arrived without its ReadyForQuery as unknown', async () => {
    const s = setup();
    const pending = runPipelined(s.client, [write()], { transactional: false });
    s.connection.complete('INSERT 0 1');
    s.connection.emit('end');
    await assert.rejects(pending, (err) => {
      assert.ok(err instanceof PipelineError);
      assert.ok(slotError(err, 0) instanceof TransactionOutcomeUnknownError, 'its implicit COMMIT runs at the Sync');
      return true;
    });
    assertRestored(s);
  });

  it('reports every unanswered slot of an explicit BEGIN / INSERT / COMMIT batch as unknown', async () => {
    const s = setup();
    const pending = runPipelined(s.client, [write('BEGIN'), write(), write('COMMIT')], { transactional: false });
    s.connection.complete('BEGIN');
    s.connection.emit('readyForQuery', { status: 'T' });
    s.connection.complete('INSERT 0 1');
    s.connection.emit('readyForQuery', { status: 'T' });
    s.connection.emit('error', Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }));
    await assert.rejects(pending, (err) => {
      assert.ok(err instanceof PipelineError);
      assert.deepEqual(
        err.results.slice(0, 2).map((slot) => slot.status),
        ['ok', 'ok'],
      );
      const commit = slotError(err, 2);
      assert.ok(commit instanceof TransactionOutcomeUnknownError, 'the sent COMMIT may have committed');
      assert.ok(commit.cause instanceof ConnectionError);
      return true;
    });
    assertRestored(s);
  });

  it('keeps the ERROR the server answered an unfinished slot with', async () => {
    const s = setup();
    const pending = runPipelined(s.client, [write(), write()], { transactional: false });
    s.connection.emit('errorMessage', Object.assign(new Error('duplicate key'), { code: '23505', severity: 'ERROR' }));
    s.connection.emit('end');
    await assert.rejects(pending, (err) => {
      assert.ok(err instanceof PipelineError);
      assert.ok(slotError(err, 0) instanceof UniqueConstraintError, 'an ERROR rolled that statement back');
      assert.ok(slotError(err, 1) instanceof TransactionOutcomeUnknownError);
      assert.equal(err.failedIndex, 0);
      return true;
    });
    assertRestored(s);
  });

  it('reports an unfinished slot answered by a FATAL as unknown, with the FATAL as cause', async () => {
    const s = setup();
    const pending = runPipelined(s.client, [write()], { transactional: false });
    const fatal = Object.assign(new Error('terminating connection due to administrator command'), {
      code: '57P01',
      severity: 'FATAL',
    });
    s.connection.emit('errorMessage', fatal);
    s.connection.emit('end');
    await assert.rejects(pending, (err) => {
      assert.ok(err instanceof PipelineError);
      const unknown = slotError(err, 0);
      assert.ok(unknown instanceof TransactionOutcomeUnknownError, 'a backend can die after its commit');
      assert.equal((unknown.cause as Error).cause, fatal);
      assert.equal(err.cause, unknown);
      assert.equal(err.failedIndex, 0);
      return true;
    });
    assertRestored(s);
  });

  it("keeps an error raised at a query's implicit COMMIT on that query", async () => {
    const s = setup();
    const pending = runPipelined(s.client, [write(), write()], { transactional: false });
    // A deferred constraint is checked at the Sync's implicit COMMIT, after
    // the statement's own CommandComplete.
    s.connection.complete('INSERT 0 1');
    s.connection.emit('errorMessage', Object.assign(new Error('fk violation'), { code: '23503', severity: 'ERROR' }));
    s.connection.emit('readyForQuery', { status: 'I' });
    s.connection.complete('INSERT 0 1');
    s.connection.emit('readyForQuery', { status: 'I' });
    await assert.rejects(pending, (err) => {
      assert.ok(err instanceof PipelineError);
      assert.equal(err.results[0]?.status, 'error', 'the first statement did not commit');
      assert.equal((slotError(err, 0) as { code?: string }).code, TurbineErrorCode.FOREIGN_KEY_VIOLATION);
      assert.deepEqual(err.results[1], { status: 'ok', value: 1 }, 'the second statement is unaffected');
      assert.equal(err.failedIndex, 0);
      return true;
    });
  });

  // The timeout's own answer, `TimeoutError` with outcome 'unknown', whether the
  // destroyed stream reports its end on a later tick (a real socket) or while
  // it is being destroyed.
  for (const sync of [false, true]) {
    it(`a timeout during an unanswered held COMMIT is E002 'unknown' (${sync ? 'synchronous' : 'later'} end)`, async () => {
      const s = setup();
      s.connection.stream.destroy = () => {
        const end = () => s.connection.emit('end');
        if (sync) end();
        else setImmediate(end);
      };
      const pending = runPipelined(s.client, [write()], { timeout: 20 });
      s.connection.complete('BEGIN');
      s.connection.complete('INSERT 0 1');
      s.connection.emit('readyForQuery', { status: 'T' });
      assert.deepEqual(s.connection.sent.slice(-2), ['COMMIT', 'Sync'], 'the held COMMIT was sent');
      await assert.rejects(pending, (err) => {
        assert.ok(err instanceof TimeoutError, `got ${String(err)}`);
        assert.equal(err.outcome, 'unknown');
        return true;
      });
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(s.connection.listeners('end'), [s.clientEnd], 'only the Client end listener remains');
      assert.equal(s.client.readyForQuery, true);
    });
  }

  it('ignores a close that follows a settled batch', async () => {
    const s = toCommit();
    s.connection.complete('COMMIT');
    s.connection.emit('readyForQuery', { status: 'I' });
    assert.deepEqual(await s.pending, [1]);
    s.connection.emit('end');
    assert.equal(pipelineClientNeedsDiscard(s.client), false);
    assert.deepEqual(s.connection.listeners('end'), [s.clientEnd]);
  });
});
