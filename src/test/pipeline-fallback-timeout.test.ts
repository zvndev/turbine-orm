/** The pipeline deadline also applies when the pool has no wire protocol. Fails until fixed. */
import assert from 'node:assert/strict';
import { it } from 'node:test';
import { TimeoutError } from '../errors.js';
import type { PgCompatPool } from '../pg-types.js';
import { executePipeline } from '../pipeline.js';

it('times out an unanswered COMMIT on the sequential pipeline path with an unknown outcome', async () => {
  const sent: string[] = [];
  let answerCommit!: () => void;
  const commitAnswer = new Promise<void>((resolve) => {
    answerCommit = resolve;
  });
  let noteCommit!: () => void;
  const commitSent = new Promise<void>((resolve) => {
    noteCommit = resolve;
  });
  const client = {
    async query(text: string) {
      sent.push(text);
      if (text === 'COMMIT') {
        noteCommit();
        await commitAnswer;
      }
      return { rows: [], rowCount: 1, fields: [], command: text === 'COMMIT' ? 'COMMIT' : 'INSERT' };
    },
    release() {},
  };
  const pool = { connect: async () => client } as unknown as PgCompatPool;
  const pending = executePipeline(
    pool,
    [{ sql: 'INSERT INTO counters VALUES (1)', params: [], transform: (r) => r.rowCount, tag: 'counters.create' }],
    { timeout: 20 },
  ).then(
    (value) => ({ value, error: undefined }),
    (error: unknown) => ({ value: undefined, error }),
  );
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  try {
    await commitSent;
    const result = await Promise.race([
      pending,
      new Promise<undefined>((resolve) => {
        watchdog = setTimeout(() => resolve(undefined), 150);
      }),
    ]);
    assert.ok(result, 'the configured deadline must settle the call while COMMIT is unanswered');
    assert.ok(result.error instanceof TimeoutError);
    assert.equal(result.error.outcome, 'unknown');
    assert.deepEqual(sent, ['BEGIN', 'INSERT INTO counters VALUES (1)', 'COMMIT'], 'no rollback after a sent COMMIT');
  } finally {
    clearTimeout(watchdog);
    answerCommit();
    await pending;
  }
});

/**
 * A pool whose client answers each statement only when the test says so, so a
 * deadline can expire with a chosen statement unanswered.
 */
function heldPool(hold: (text: string) => boolean) {
  const sent: string[] = [];
  const releases: unknown[] = [];
  const answers: Array<() => void> = [];
  let noteHeld!: () => void;
  const held = new Promise<void>((resolve) => {
    noteHeld = resolve;
  });
  const client = {
    async query(text: string) {
      sent.push(text);
      if (hold(text)) {
        noteHeld();
        await new Promise<void>((resolve) => answers.push(resolve));
      }
      return { rows: [{ n: 1 }], rowCount: 1, fields: [], command: 'SELECT' };
    },
    release(err?: unknown) {
      releases.push(err);
    },
  };
  const pool = { connect: async () => client } as unknown as PgCompatPool;
  const answerAll = () => {
    for (const answer of answers.splice(0)) answer();
  };
  return { pool, sent, releases, held, answerAll };
}

const deferred = (sql: string) => ({
  sql,
  params: [],
  transform: (r: { rowCount: number | null }) => r.rowCount,
  tag: sql,
});
/** Settle `p`, or report it still pending after 300 ms, so a missing deadline fails instead of hanging. */
const settle = (p: Promise<unknown>) => {
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p.then(
      (value) => ({ value, error: undefined as unknown }),
      (error: unknown) => ({ value: undefined, error }),
    ),
    new Promise<{ value: undefined; error: unknown }>((resolve) => {
      watchdog = setTimeout(() => resolve({ value: undefined, error: 'still pending after the deadline' }), 300);
    }),
  ]).finally(() => clearTimeout(watchdog));
};
const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

for (const transactional of [true, false]) {
  const mode = transactional ? 'transactional' : 'non-transactional';

  it(`times out an unanswered statement of a ${mode} sequential batch and sends nothing after it`, async () => {
    const h = heldPool((text) => text.startsWith('INSERT INTO a'));
    const pending = settle(
      executePipeline(h.pool, [deferred('INSERT INTO a VALUES (1)'), deferred('INSERT INTO b VALUES (1)')], {
        transactional,
        timeout: 20,
      }),
    );
    try {
      await h.held;
      const { error } = await pending;
      assert.ok(error instanceof TimeoutError, `got ${String(error)}`);
      assert.equal(error.outcome, 'unknown');
      assert.equal(h.releases.length, 1);
      assert.equal(h.releases[0], error, 'the connection is released with the timeout, so the pool retires it');
      const sentAtDeadline = h.sent.length;
      h.answerAll();
      await tick();
      assert.equal(h.sent.length, sentAtDeadline, 'a late answer sends nothing: no next statement, COMMIT or ROLLBACK');
      assert.equal(h.releases.length, 1, 'a late answer cannot release again');
    } finally {
      h.answerAll();
    }
  });

  it(`a slow statement of a ${mode} sequential batch does not outlive the deadline`, async () => {
    const h = heldPool((text) => text.startsWith('SELECT'));
    const timer = setTimeout(h.answerAll, 120);
    try {
      const { error } = await settle(executePipeline(h.pool, [deferred('SELECT 1')], { transactional, timeout: 20 }));
      assert.ok(error instanceof TimeoutError, 'answering after the deadline does not resolve the call');
    } finally {
      clearTimeout(timer);
      h.answerAll();
    }
  });
}

it('times out an unanswered BEGIN of a sequential batch without sending the batch', async () => {
  const h = heldPool((text) => text === 'BEGIN');
  const pending = settle(executePipeline(h.pool, [deferred('INSERT INTO a VALUES (1)')], { timeout: 20 }));
  try {
    await h.held;
    const { error } = await pending;
    assert.ok(error instanceof TimeoutError);
    h.answerAll();
    await tick();
    assert.deepEqual(h.sent, ['BEGIN']);
    assert.equal(h.releases.length, 1);
  } finally {
    h.answerAll();
  }
});

it('a sequential batch that finishes within its deadline is unchanged', async () => {
  const h = heldPool(() => false);
  const { value } = await settle(executePipeline(h.pool, [deferred('INSERT INTO a VALUES (1)')], { timeout: 1000 }));
  assert.deepEqual(value, [1]);
  assert.deepEqual(h.sent, ['BEGIN', 'INSERT INTO a VALUES (1)', 'COMMIT']);
  assert.deepEqual(h.releases, [undefined], 'released once, for reuse');
});
