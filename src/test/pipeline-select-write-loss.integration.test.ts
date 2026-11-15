/** A SELECT can write through a volatile function. Fails until its lost COMMIT is classified safely. */
import assert from 'node:assert/strict';
import net from 'node:net';
import { describe } from 'node:test';
import pg from 'pg';
import { TurbineClient } from '../client.js';
import { TransactionOutcomeUnknownError } from '../errors.js';
import { skipGate } from './helpers.js';

const url = process.env.DATABASE_URL ?? '';
const { it } = skipGate(!url, 'requires DATABASE_URL pointing at disposable PostgreSQL');

describe('pipeline connection loss after a SELECT with effects', () => {
  it('reports an unknown outcome when the function wrote and COMMIT was not answered', { timeout: 15000 }, async () => {
    const suffix = process.pid;
    const table = `pipe_select_effect_${suffix}`;
    const fn = `pipe_select_write_${suffix}`;
    const target = new URL(url);
    const admin = new pg.Client({ connectionString: url });
    const sockets = new Set<net.Socket>();
    let armed = true;
    let forwardedCommit = false;
    const proxy = net.createServer((client) => {
      const upstream = net.connect(Number(target.port || 5432), target.hostname);
      sockets.add(client).add(upstream);
      const close = () => {
        client.destroy();
        upstream.destroy();
      };
      for (const socket of [client, upstream]) {
        socket.on('error', close);
        socket.on('close', close);
      }
      client.on('data', (chunk) => {
        if (armed && chunk.includes('COMMIT')) {
          armed = false;
          forwardedCommit = true;
          upstream.pause();
          upstream.write(chunk);
        } else upstream.write(chunk);
      });
      upstream.on('data', (chunk) => client.write(chunk));
    });
    let db: TurbineClient | undefined;
    await admin.connect();
    try {
      await admin.query(`CREATE TABLE "${table}" (n integer)`);
      await admin.query(`CREATE FUNCTION "${fn}"() RETURNS integer LANGUAGE plpgsql AS $$
        BEGIN INSERT INTO "${table}" VALUES (1); RETURN 1; END $$`);
      await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
      const endpoint = new URL(url);
      endpoint.host = `127.0.0.1:${(proxy.address() as net.AddressInfo).port}`;
      db = new TurbineClient({ connectionString: endpoint.href, max: 1 }, { tables: {}, enums: {} });
      const outcome = db
        .pipeline([{ sql: `SELECT "${fn}"() AS n`, params: [], transform: (r) => r.rows, tag: 'counter.write' }], {
          timeout: 5000,
        })
        .then(
          () => undefined,
          (error: unknown) => error,
        );
      let committed = false;
      for (let i = 0; i < 200; i++) {
        if ((await admin.query(`SELECT count(*)::int AS n FROM "${table}"`)).rows[0].n === 1) {
          committed = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(forwardedCommit, true);
      assert.equal(committed, true, 'the effect must be durable before cutting the unanswered connection');
      for (const socket of sockets) socket.destroy();
      const error = await outcome;
      assert.ok(error instanceof TransactionOutcomeUnknownError, `a durable write was reported as ${String(error)}`);
    } finally {
      for (const socket of sockets) socket.destroy();
      if (proxy.listening) await new Promise<void>((resolve) => proxy.close(() => resolve()));
      await db?.disconnect();
      await admin.query(`DROP FUNCTION IF EXISTS "${fn}"()`);
      await admin.query(`DROP TABLE IF EXISTS "${table}"`);
      await admin.end();
    }
  });
});
