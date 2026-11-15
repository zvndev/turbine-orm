/** Independent slots must not promise safe retries after an unanswered commit. Fails until fixed. */
import assert from 'node:assert/strict';
import net from 'node:net';
import { describe } from 'node:test';
import pg from 'pg';
import { TurbineClient } from '../client.js';
import { PipelineError, TransactionOutcomeUnknownError } from '../errors.js';
import type { PgCompatQueryResult } from '../pg-types.js';
import { skipGate } from './helpers.js';

const url = process.env.DATABASE_URL ?? '';
const { it } = skipGate(!url, 'requires DATABASE_URL pointing at disposable PostgreSQL');

describe('independent pipeline slots after a lost commit response', () => {
  for (const explicit of [false, true]) {
    it(`reports an unknown slot outcome after ${explicit ? 'explicit' : 'implicit'} COMMIT`, async () => {
      const table = `pipe_independent_effect_${process.pid}_${Number(explicit)}`;
      const fn = `pipe_independent_write_${process.pid}_${Number(explicit)}`;
      const target = new URL(url);
      const admin = new pg.Client({ connectionString: url });
      const sockets = new Set<net.Socket>();
      let blocked = false;
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
          if (!blocked && chunk.includes(explicit ? 'COMMIT' : fn)) {
            blocked = true;
            forwardedCommit = chunk.includes('COMMIT');
            upstream.pause();
          }
          upstream.write(chunk);
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
        const query = (sql: string) => ({ sql, params: [], transform: (r: PgCompatQueryResult) => r.rows, tag: sql });
        const queries = explicit
          ? [query('BEGIN'), query(`INSERT INTO "${table}" VALUES (1)`), query('COMMIT')]
          : [query(`SELECT "${fn}"() AS n`)];
        const pending = db.pipeline(queries, { transactional: false, timeout: 5000 }).then(
          () => undefined,
          (error: unknown) => error,
        );
        const deadline = Date.now() + 3000;
        let durable = false;
        while (Date.now() < deadline) {
          if ((await admin.query(`SELECT count(*)::int AS n FROM "${table}"`)).rows[0].n === 1) {
            durable = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        assert.ok(blocked, 'the proxy suppressed the result');
        assert.ok(durable, 'an independent connection observed the committed effect before the cut');
        if (explicit) assert.ok(forwardedCommit, 'the COMMIT was sent');
        for (const socket of sockets) socket.destroy();
        const error = await pending;
        assert.ok(error instanceof PipelineError);
        const slot = error.results.at(-1);
        assert.equal(slot?.status, 'error');
        assert.ok(
          slot?.status === 'error' && slot.error instanceof TransactionOutcomeUnknownError,
          `the durable slot must report E021, got ${slot?.status === 'error' ? slot.error.message : 'no error slot'}`,
        );
      } finally {
        for (const socket of sockets) socket.destroy();
        await new Promise<void>((resolve) => proxy.close(() => resolve()));
        await db?.disconnect();
        await admin.query(`DROP FUNCTION IF EXISTS "${fn}"()`);
        await admin.query(`DROP TABLE IF EXISTS "${table}"`);
        await admin.end();
      }
    });
  }
});
