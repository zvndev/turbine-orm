/**
 * What each slot of a `{ transactional: false }` pipeline reports, against a
 * real server. Each statement autocommits at its own Sync, so a statement whose
 * answer was lost may have committed (E021, never E004), an acknowledged
 * statement keeps its result, and an error the server raised at a statement's
 * implicit COMMIT stays on that statement. Also the sequential path's deadline,
 * through a supplied pool with no wire internals. The protocol path's writing
 * SELECT and explicit COMMIT are in pipeline-independent-commit-loss.integration.test.ts.
 */
import assert from 'node:assert/strict';
import net from 'node:net';
import { describe } from 'node:test';
import pg from 'pg';
import { TurbineClient } from '../client.js';
import { PipelineError, TimeoutError, TransactionOutcomeUnknownError, TurbineErrorCode } from '../errors.js';
import type { PgCompatPool, PgCompatQueryResult } from '../pg-types.js';
import { executePipeline } from '../pipeline.js';
import { skipGate } from './helpers.js';

const url = process.env.DATABASE_URL ?? '';
const { it } = skipGate(!url, 'requires DATABASE_URL pointing at disposable PostgreSQL');

/** ReadyForQuery: `Z`, then the length 5. */
const READY_FOR_QUERY = Buffer.from([0x5a, 0, 0, 0, 5]);

/**
 * A TCP proxy to the server. Once a client chunk matches `trigger`, answers
 * stop reaching the client: at once, or with `afterFirstAnswer` only after one
 * ReadyForQuery has been passed on. `cut()` closes every socket.
 */
async function startProxy(trigger: (chunk: Buffer) => boolean, afterFirstAnswer = false) {
  const target = new URL(url);
  const sockets = new Set<net.Socket>();
  const state = { triggered: false };
  const server = net.createServer((client) => {
    const upstream = net.connect(Number(target.port || 5432), target.hostname);
    sockets.add(client).add(upstream);
    let passing = true;
    const close = () => {
      client.destroy();
      upstream.destroy();
    };
    for (const socket of [client, upstream]) {
      socket.on('error', close);
      socket.on('close', close);
    }
    client.on('data', (chunk: Buffer) => {
      if (!state.triggered && trigger(chunk)) {
        state.triggered = true;
        passing = afterFirstAnswer;
      }
      upstream.write(chunk);
    });
    upstream.on('data', (chunk: Buffer) => {
      if (!passing) return;
      client.write(chunk);
      if (state.triggered && chunk.includes(READY_FOR_QUERY)) passing = false;
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const endpoint = new URL(url);
  endpoint.host = `127.0.0.1:${(server.address() as net.AddressInfo).port}`;
  return {
    url: endpoint.href,
    state,
    cut() {
      for (const socket of sockets) socket.destroy();
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

const query = (sql: string) => ({ sql, params: [], transform: (r: PgCompatQueryResult) => r.rows, tag: sql });

describe('independent pipeline slots against a real server', () => {
  async function withTable(name: string, run: (table: string, admin: pg.Client) => Promise<void>) {
    const table = `pipe_slots_${name}_${process.pid}`;
    const admin = new pg.Client({ connectionString: url });
    await admin.connect();
    try {
      await admin.query(`CREATE TABLE "${table}" (n integer)`);
      await run(table, admin);
    } finally {
      await admin.query(`DROP TABLE IF EXISTS "${table}"`);
      await admin.end();
    }
  }

  async function waitForRows(admin: pg.Client, table: string, rows: number) {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      if ((await admin.query(`SELECT count(*)::int AS n FROM "${table}"`)).rows[0].n === rows) return true;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return false;
  }

  it('reports an INSERT whose answer was lost as an unknown outcome', async () => {
    await withTable('write', async (table, admin) => {
      const proxy = await startProxy((chunk) => chunk.includes(table));
      const db = new TurbineClient({ connectionString: proxy.url, max: 1 }, { tables: {}, enums: {} });
      try {
        const pending = db.pipeline([query(`INSERT INTO "${table}" VALUES (1)`)], { transactional: false }).then(
          () => undefined,
          (error: unknown) => error,
        );
        assert.ok(await waitForRows(admin, table, 1), 'the INSERT committed while its answer was held');
        proxy.cut();
        const error = await pending;
        assert.ok(error instanceof PipelineError, `got ${String(error)}`);
        const slot = error.results[0];
        assert.ok(slot?.status === 'error' && slot.error instanceof TransactionOutcomeUnknownError);
      } finally {
        await proxy.close();
        await db.disconnect();
      }
    });
  });

  it('keeps the result of a slot acknowledged before the connection was lost', async () => {
    await withTable('acked', async (table, admin) => {
      const proxy = await startProxy((chunk) => chunk.includes(table), true);
      const db = new TurbineClient({ connectionString: proxy.url, max: 1 }, { tables: {}, enums: {} });
      try {
        const pending = db
          .pipeline(
            [
              query(`INSERT INTO "${table}" VALUES (1) RETURNING n`),
              query(`INSERT INTO "${table}" SELECT 2 FROM pg_sleep(0.3) RETURNING n`),
            ],
            { transactional: false },
          )
          .then(
            () => undefined,
            (error: unknown) => error,
          );
        assert.ok(await waitForRows(admin, table, 2), 'both statements committed');
        proxy.cut();
        const error = await pending;
        assert.ok(error instanceof PipelineError, `got ${String(error)}`);
        assert.deepEqual(error.results[0], { status: 'ok', value: [{ n: 1 }] }, 'the acknowledged slot keeps its rows');
        const slot = error.results[1];
        assert.ok(slot?.status === 'error' && slot.error instanceof TransactionOutcomeUnknownError);
        assert.equal(error.failedIndex, 1);
      } finally {
        await proxy.close();
        await db.disconnect();
      }
    });
  });

  it("keeps an error raised at a statement's implicit COMMIT on that statement", async () => {
    const parent = `pipe_slots_parent_${process.pid}`;
    const child = `pipe_slots_child_${process.pid}`;
    const admin = new pg.Client({ connectionString: url });
    const db = new TurbineClient({ connectionString: url, max: 1 }, { tables: {}, enums: {} });
    await admin.connect();
    try {
      await admin.query(`CREATE TABLE "${parent}" (id integer PRIMARY KEY)`);
      await admin.query(
        `CREATE TABLE "${child}" (id integer, parent_id integer REFERENCES "${parent}" (id) DEFERRABLE INITIALLY DEFERRED)`,
      );
      await admin.query(`INSERT INTO "${parent}" VALUES (1)`);
      const insert = (id: number, parentId: number) => ({
        sql: `INSERT INTO "${child}" VALUES (${id}, ${parentId})`,
        params: [],
        transform: (r: PgCompatQueryResult) => r.rowCount,
        tag: `child ${id}`,
      });
      // The deferred check runs at each statement's own Sync, after its
      // CommandComplete. A lone failing statement used to resolve as success.
      const lone = await db.pipeline([insert(1, 999)], { transactional: false }).then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      assert.ok('error' in lone && lone.error instanceof PipelineError, 'a statement that did not commit fails');
      const error = await db.pipeline([insert(2, 999), insert(3, 1)], { transactional: false }).then(
        () => undefined,
        (e: unknown) => e,
      );
      assert.ok(error instanceof PipelineError, `got ${String(error)}`);
      const [first, second] = error.results;
      assert.equal(
        first?.status === 'error' && (first.error as { code?: string }).code,
        TurbineErrorCode.FOREIGN_KEY_VIOLATION,
      );
      assert.deepEqual(second, { status: 'ok', value: 1 });
      assert.equal(error.failedTag, 'child 2');
      assert.deepEqual((await admin.query(`SELECT id FROM "${child}" ORDER BY id`)).rows, [{ id: 3 }]);
    } finally {
      await db.disconnect();
      await admin.query(`DROP TABLE IF EXISTS "${child}"`);
      await admin.query(`DROP TABLE IF EXISTS "${parent}"`);
      await admin.end();
    }
  });
});

describe('sequential pipeline path against a real server', () => {
  /** A supplied pool that exposes `query` / `release` and none of node-postgres's wire internals. */
  function wrapperPool(connectionString: string): PgCompatPool & { released: unknown[] } {
    const real = new pg.Pool({ connectionString, max: 1 });
    const released: unknown[] = [];
    return {
      released,
      async connect() {
        const client = await real.connect();
        client.on('error', () => {});
        return {
          query: (text: string, values?: unknown[]) => client.query(text, values),
          release: (err?: Error | boolean) => {
            released.push(err);
            client.release(err);
          },
        };
      },
      query: (text: string, values?: unknown[]) => real.query(text, values),
      end: () => real.end(),
    } as unknown as PgCompatPool & { released: unknown[] };
  }

  it('reports an independent INSERT whose answer was lost as an unknown outcome', async () => {
    const table = `pipe_seq_write_${process.pid}`;
    const admin = new pg.Client({ connectionString: url });
    await admin.connect();
    const proxy = await startProxy((chunk) => chunk.includes(table));
    const pool = wrapperPool(proxy.url);
    try {
      await admin.query(`CREATE TABLE "${table}" (n integer)`);
      const pending = executePipeline(pool, [query(`INSERT INTO "${table}" VALUES (1)`), query('SELECT 1 AS n')], {
        transactional: false,
      }).then(
        () => undefined,
        (error: unknown) => error,
      );
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        if ((await admin.query(`SELECT count(*)::int AS n FROM "${table}"`)).rows[0].n === 1) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      proxy.cut();
      const error = await pending;
      assert.ok(error instanceof PipelineError, `got ${String(error)}`);
      const [write, after] = error.results;
      assert.ok(write?.status === 'error' && write.error instanceof TransactionOutcomeUnknownError);
      assert.ok(
        after?.status === 'error' && !(after.error instanceof TransactionOutcomeUnknownError),
        'a statement the driver refused to send keeps the connection error',
      );
      assert.ok(pool.released[0] instanceof Error, 'the failed connection is released for disposal');
    } finally {
      await proxy.close();
      await pool.end();
      await admin.query(`DROP TABLE IF EXISTS "${table}"`);
      await admin.end();
    }
  });

  it('settles a batch whose COMMIT is unanswered at its deadline, with an unknown outcome', async () => {
    const table = `pipe_seq_commit_${process.pid}`;
    const admin = new pg.Client({ connectionString: url });
    await admin.connect();
    const proxy = await startProxy((chunk) => chunk.includes('COMMIT'));
    const pool = wrapperPool(proxy.url);
    try {
      await admin.query(`CREATE TABLE "${table}" (n integer)`);
      let watchdog: ReturnType<typeof setTimeout> | undefined;
      const error = await Promise.race([
        executePipeline(pool, [query(`INSERT INTO "${table}" VALUES (1)`)], { timeout: 300 }).then(
          () => undefined,
          (e: unknown) => e,
        ),
        new Promise((resolve) => {
          watchdog = setTimeout(() => resolve('still pending 2 s after a 300 ms deadline'), 2000);
        }),
      ]).finally(() => clearTimeout(watchdog));
      assert.ok(proxy.state.triggered, 'COMMIT was sent');
      assert.ok(error instanceof TimeoutError, `got ${String(error)}`);
      assert.equal(error.outcome, 'unknown');
      assert.equal(pool.released.length, 1);
      assert.equal(pool.released[0], error, 'the connection is retired with the timeout');
    } finally {
      await proxy.close();
      await pool.end();
      await admin.query(`DROP TABLE IF EXISTS "${table}"`);
      await admin.end();
    }
  });
});
