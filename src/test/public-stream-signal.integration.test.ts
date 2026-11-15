/** Live public cancellation oracles. Only disposable engine databases are supported. */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { describe } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createPool } from 'mysql2/promise';
import pg from 'pg';
import { TurbineClient } from '../client.js';
import { turbineMysql } from '../mysql.js';
import type { SchemaMetadata } from '../schema.js';
import { mockTable, skipGate } from './helpers.js';

for (const engine of ['postgres', 'mysql'] as const) {
  // Module-scope admission must fail the process when a native job requires it.
  const url = engine === 'postgres' ? process.env.DATABASE_URL : process.env.MYSQL_URL;
  const gate =
    engine === 'postgres'
      ? skipGate(!url, 'requires DATABASE_URL pointing at disposable PostgreSQL')
      : skipGate(!url, 'requires MYSQL_URL pointing at disposable MySQL 8');
  describe(`${engine}: live public stream cancellation`, () => {
    const suffix = `${process.pid}_${randomBytes(4).toString('hex')}`;
    const items = `cancel_items_${suffix}`;
    const slow = `cancel_slow_${suffix}`;
    const boundary = `cancel_boundary_${suffix}`;
    const quote = (s: string) => (engine === 'postgres' ? `"${s}"` : `\`${s}\``);
    const schema: SchemaMetadata = {
      tables: Object.fromEntries(
        [items, slow, boundary].map((name) => [
          name,
          mockTable(name, [
            { name: 'id', field: 'id', pgType: 'int' },
            { name: 'waited', field: 'waited', pgType: 'text' },
          ]),
        ]),
      ),
      enums: {},
    };
    let db: TurbineClient;
    let pgPool: pg.Pool | undefined;
    let mysqlPool: ReturnType<typeof createPool> | undefined;
    let observer: pg.Client | undefined;
    const raw = async (sql: string) => db.rawUnsafe(sql);
    const table = () => db.table<{ id: number; waited: string }>(items);
    const slowTable = () => db.table<{ id: number; waited: string }>(slow);
    gate.before(async () => {
      if (engine === 'postgres') {
        pgPool = new pg.Pool({ connectionString: url, max: 1, application_name: `cancel_${suffix}` });
        observer = new pg.Client({ connectionString: url });
        await observer.connect();
        db = new TurbineClient({ pool: pgPool, warnOnUnlimited: false, logger: {} }, schema);
      } else {
        mysqlPool = createPool({ uri: url!, connectionLimit: 1 });
        db = await turbineMysql(mysqlPool, schema, { warnOnUnlimited: false, logger: {} });
      }
      await raw(`CREATE TABLE ${quote(items)} (id INT PRIMARY KEY, waited TEXT)`);
      await raw(`INSERT INTO ${quote(items)} VALUES (1, 'first'), (2, 'second'), (3, 'third'), (4, 'fourth')`);
      await raw(
        `CREATE VIEW ${quote(slow)} AS SELECT id, ${engine === 'postgres' ? 'pg_sleep(10)::text' : 'CAST(SLEEP(0.15) AS CHAR)'} AS waited FROM ${quote(items)}`,
      );
    });
    gate.before(async () => {
      if (engine === 'postgres')
        await raw(`CREATE VIEW ${quote(boundary)} AS SELECT 1 AS id, pg_sleep(0.06)::text AS waited`);
    });
    gate.after(async () => {
      try {
        if (db) {
          if (engine === 'postgres') await raw(`DROP VIEW IF EXISTS ${quote(boundary)}`);
          await raw(`DROP VIEW IF EXISTS ${quote(slow)}`);
          await raw(`DROP TABLE IF EXISTS ${quote(items)}`);
          await db.disconnect();
        }
        if (pgPool)
          assert.equal((await pgPool.query('SELECT 73 AS ok')).rows[0].ok, 73, 'supplied pg pool remains caller owned');
        if (mysqlPool)
          assert.equal(
            ((await mysqlPool.query('SELECT 73 AS ok'))[0] as { ok: number }[])[0]!.ok,
            73,
            'supplied mysql pool remains caller owned',
          );
      } finally {
        await observer?.end();
        await pgPool?.end();
        await mysqlPool?.end();
      }
    });
    async function waitRunning() {
      const until = Date.now() + 4000;
      while (Date.now() < until) {
        if (observer) {
          const rows = (
            await observer.query("SELECT query FROM pg_stat_activity WHERE application_name=$1 AND state='active'", [
              `cancel_${suffix}`,
            ])
          ).rows;
          if (rows.some((r) => /^FETCH /.test(r.query))) return;
        } else {
          // Observe the actual server process, independently of the one-slot borrowed pool.
          const watch = createPool({ uri: url!, connectionLimit: 1 });
          try {
            const rows = (await watch.query('SHOW PROCESSLIST'))[0] as { Info: string | null }[];
            if (rows.some((r) => r.Info?.includes(slow) && /SELECT/i.test(r.Info))) return;
          } finally {
            await watch.end();
          }
        }
        await delay(5);
      }
      assert.fail('the actual slow stream must be running on the server before abort');
    }
    for (const method of ['findManyStream', 'findManyStreamBatches'] as const) {
      gate.it(
        `${method} cancels the live request and recovers the one-slot borrowed pool`,
        { timeout: 8000 },
        async () => {
          const c = new AbortController();
          const reason = { stop: 'live pending request' };
          const stream = slowTable()[method]({ signal: c.signal, batchSize: 2, idleTimeoutMs: 0 });
          const pending = assert.rejects(stream.next(), (error) => error === reason);
          try {
            await waitRunning();
            c.abort(reason);
            await pending;
          } finally {
            c.abort(reason);
            await stream.return(undefined);
          }
          assert.equal((await raw('SELECT 37 AS ok'))[0]!.ok, 37);
          if (observer) {
            const active = (
              await observer.query(
                "SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name=$1 AND state <> 'idle'",
                [`cancel_${suffix}`],
              )
            ).rows[0].n;
            assert.equal(active, 0, 'no active PostgreSQL statement after confirmed cancellation');
          } else {
            const watch = createPool({ uri: url!, connectionLimit: 1 });
            try {
              let remaining = 1;
              const deadline = Date.now() + 3000;
              while (remaining && Date.now() < deadline) {
                remaining = ((await watch.query('SHOW PROCESSLIST'))[0] as { Info: string | null }[]).filter((r) =>
                  r.Info?.includes(slow),
                ).length;
                if (remaining) await delay(5);
              }
              assert.equal(
                remaining,
                0,
                'bounded residual MySQL work must finish; socket abort alone is not a server KILL',
              );
            } finally {
              await watch.end();
            }
          }

          if (pgPool) {
            assert.equal(pgPool.waitingCount, 0);
            assert.equal(pgPool.totalCount, pgPool.idleCount);
          }
          assert.equal((await table().findMany({ orderBy: { id: 'asc' } })).length, 4);
        },
      );
      gate.it(
        `${method} abort between pulls discards buffered rows and returns the checkout without a pull`,
        async () => {
          const c = new AbortController();
          const reason = new Error('live buffered cancel');
          const stream = table()[method]({ signal: c.signal, batchSize: 2 });
          assert.equal((await stream.next()).done, false);
          c.abort(reason);
          // A one-slot pool makes premature release and leaked ownership observable.
          assert.equal((await raw('SELECT 41 AS ok'))[0]!.ok, 41);
          await assert.rejects(stream.next(), (error) => error === reason);
        },
      );
      gate.it(`${method} early return preserves uncommitted work and outer rollback owns the effects`, async () => {
        await assert.rejects(
          db.$transaction(async (tx) => {
            await tx.rawUnsafe(`UPDATE ${quote(items)} SET waited='inside' WHERE id=1`);
            const c = new AbortController();
            const stream = tx
              .table<{ id: number; waited: string }>(items)
              [method]({ signal: c.signal, orderBy: { id: 'asc' }, batchSize: 2 });
            const value = (await stream.next()).value!;
            assert.equal((Array.isArray(value) ? value[0]! : value).waited, 'inside');
            await stream.return(undefined);
            assert.equal((await tx.rawUnsafe(`SELECT waited FROM ${quote(items)} WHERE id=1`))[0]!.waited, 'inside');
            throw new Error('outer rollback');
          }),
          /outer rollback/,
        );
        assert.equal((await raw(`SELECT waited FROM ${quote(items)} WHERE id=1`))[0]!.waited, 'first');
      });
      gate.it(
        `${method} active transactional cancellation prevents partial work from committing`,
        { timeout: 8000 },
        async () => {
          const c = new AbortController();
          const reason = new Error('transaction cancel');
          await assert.rejects(
            db.$transaction(async (tx) => {
              await tx.rawUnsafe(`UPDATE ${quote(items)} SET waited='must rollback' WHERE id=1`);
              const stream = tx.table(slow)[method]({ signal: c.signal, batchSize: 2 });
              const pending = assert.rejects(stream.next(), (error) => error === reason);
              try {
                await waitRunning();
                c.abort(reason);
                await pending;
              } finally {
                c.abort(reason);
                await stream.return(undefined);
              }
              // Even a swallowed stream error must not commit the earlier update.
            }),
          );
          assert.equal((await raw(`SELECT waited FROM ${quote(items)} WHERE id=1`))[0]!.waited, 'first');
        },
      );
    }
    if (engine === 'postgres') {
      for (const method of ['findManyStream', 'findManyStreamBatches'] as const)
        for (const abort of [false, true]) {
          gate.it(`${method}: later admissions are refused before ReadyForQuery, abort=${abort}`, async () => {
            const c = new AbortController();
            const reason = new Error('only the cursor may be cancelled');
            let verifiedBoundary = false;
            const transaction = db.$transaction(async (tx) => {
              const stream = tx.table(boundary)[method]({ signal: c.signal, batchSize: 1 });
              const pending = stream.next().then(
                (value) => ({ value }),
                (error) => ({ error }),
              );
              await waitRunning();
              const driver = (pgPool as unknown as { _clients: { connection: NodeJS.EventEmitter }[] })._clients[0]!;
              let reachedBoundary = false;
              const atReady = () => {
                reachedBoundary = true;
                if (abort) c.abort(reason);
              };
              driver.connection.once('readyForQuery', atReady);
              try {
                await assert.rejects(tx.rawUnsafe('SELECT pg_sleep(0.1), 909 AS ok'), /otherwise idle/);
                const answer = await pending;
                assert.equal(reachedBoundary, true);
                verifiedBoundary = true;
                if (abort) assert.equal('error' in answer && answer.error, reason);
                else assert.ok('value' in answer);
              } finally {
                driver.connection.removeListener('readyForQuery', atReady);
                await stream.return(undefined);
              }
              if (!abort) assert.equal((await tx.rawUnsafe('SELECT 909 AS ok'))[0]!.ok, 909);
            });
            if (abort) await assert.rejects(transaction);
            else await transaction;
            assert.equal(verifiedBoundary, true, 'the actual ReadyForQuery boundary was tested');
            assert.equal((await raw('SELECT 911 AS ok'))[0]!.ok, 911);
          });
        }
      gate.it('a cancellable cursor refuses concurrent statements without cancelling their work', async () => {
        await db.$transaction(async (tx) => {
          const running = tx.rawUnsafe('SELECT pg_sleep(0.05), 67 AS ok');
          const c = new AbortController();
          await assert.rejects(tx.table(items).findManyStream({ signal: c.signal }).next(), /otherwise idle/);
          c.abort();
          assert.equal((await running)[0]!.ok, 67);
          assert.equal((await tx.rawUnsafe('SELECT 69 AS ok'))[0]!.ok, 69);
        });
      });
      gate.it('abort during savepoint admission sends no cancel to the other block', async () => {
        await db.$transaction(async (tx) => {
          const block = tx.$transaction(async (inner) => {
            assert.equal((await inner.rawUnsafe('SELECT pg_sleep(0.05), 71 AS ok'))[0]!.ok, 71);
          });
          const c = new AbortController();
          const reason = new Error('queued stream abort');
          const stream = tx.table(items).findManyStream({ signal: c.signal });
          const pending = assert.rejects(stream.next(), (error) => error === reason);
          c.abort(reason);
          await pending;
          await block;
          assert.equal((await tx.rawUnsafe('SELECT 79 AS ok'))[0]!.ok, 79);
        });
      });
      gate.it('saved buffered cursor rows refuse after transaction and savepoint completion', async () => {
        for (const nested of [false, true]) {
          let stream: AsyncGenerator<unknown, void, undefined> | undefined;
          await db.$transaction(async (tx) => {
            const open = async (handle: typeof tx) => {
              stream = handle.table(items).findManyStream({ signal: new AbortController().signal, batchSize: 2 });
              assert.equal((await stream.next()).done, false);
            };
            if (nested) {
              await tx.$transaction(open);
              await assert.rejects(stream!.next(), /savepoint block that has ended/);
            } else await open(tx);
          });
          if (!nested) await assert.rejects(stream!.next(), /transaction.*(?:committed|ended)/i);
          assert.equal((await raw('SELECT 83 AS ok'))[0]!.ok, 83);
        }
      });
      gate.it(
        'savepoint cancellation rolls back only its block and preserves the outer transaction',
        { timeout: 8000 },
        async () => {
          await db.$transaction(async (tx) => {
            await tx.rawUnsafe(`UPDATE ${quote(items)} SET waited='outer' WHERE id=2`);
            const c = new AbortController();
            const reason = new Error('savepoint cancel');
            await assert.rejects(
              tx.$transaction(async (inner) => {
                await inner.rawUnsafe(`UPDATE ${quote(items)} SET waited='inner' WHERE id=1`);
                const stream = inner.table(slow).findManyStream({ signal: c.signal, batchSize: 2 });
                const pending = assert.rejects(stream.next(), (error) => error === reason);
                try {
                  await waitRunning();
                  c.abort(reason);
                  await pending;
                  throw reason;
                } finally {
                  c.abort(reason);
                  await stream.return(undefined);
                }
              }),
            );
            assert.equal((await tx.rawUnsafe(`SELECT waited FROM ${quote(items)} WHERE id=1`))[0]!.waited, 'first');
            assert.equal((await tx.rawUnsafe(`SELECT waited FROM ${quote(items)} WHERE id=2`))[0]!.waited, 'outer');
          });
          await raw(`UPDATE ${quote(items)} SET waited='second' WHERE id=2`);
        },
      );
    }
  });
}
