/**
 * A transactional `pipeline()` whose connection dies must settle.
 *
 * On a Turbine-owned node-postgres pool the batch takes the extended-query
 * pipeline path, which owns the connection's message events while it waits
 * for ReadyForQuery. A socket that closes without a backend message (a
 * network drop, a terminated backend, a server restart) must reject the call
 * and give the pool slot back; without a `timeout` it used to wait forever,
 * holding its checkout. Lost before the COMMIT is sent, nothing committed and
 * the call is a connection error; lost after it, the outcome is unknown
 * (E021). src/test/pipeline-connection-loss.test.ts covers every branch with
 * a stepped connection.
 *
 * Run: DATABASE_URL=postgres://... npx tsx --test src/test/pipeline-connection-loss.integration.test.ts
 */
import assert from 'node:assert/strict';
import net from 'node:net';
import { describe } from 'node:test';
import pg from 'pg';
import { TurbineClient } from '../client.js';
import { introspect } from '../introspect.js';
import { skipGate } from './helpers.js';

const DATABASE_URL = process.env.DATABASE_URL ?? '';
const { it } = skipGate(!DATABASE_URL, 'DATABASE_URL not set');

/** A TCP proxy to the database that destroys both sockets on the first client chunk containing `marker`. */
async function killingProxy(marker: string): Promise<{ port: number; close: () => void }> {
  const target = new URL(DATABASE_URL);
  let armed = true;
  const sockets = new Set<net.Socket>();
  const server = net.createServer((client) => {
    const upstream = net.connect(Number(target.port || 5432), target.hostname);
    sockets.add(client).add(upstream);
    const kill = () => {
      client.destroy();
      upstream.destroy();
    };
    client.on('data', (chunk) => {
      if (armed && chunk.includes(marker)) {
        armed = false;
        kill();
        return;
      }
      upstream.write(chunk);
    });
    upstream.on('data', (chunk) => client.write(chunk));
    for (const s of [client, upstream]) {
      s.on('error', kill);
      s.on('close', kill);
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: (server.address() as net.AddressInfo).port,
    close: () => {
      for (const s of sockets) s.destroy();
      server.close();
    },
  };
}

describe('pipeline() on a connection that dies', () => {
  for (const [label, marker, code] of [
    ['while the batch is sent', 'INSERT', 'TURBINE_E004'],
    ['when COMMIT is sent', 'COMMIT', 'TURBINE_E021'],
  ] as const) {
    it(`rejects instead of waiting forever (${label})`, { timeout: 30000 }, async () => {
      const table = `pipeline_loss_${process.pid}_${marker.toLowerCase()}`;
      const admin = new pg.Client({ connectionString: DATABASE_URL });
      await admin.connect();
      await admin.query(`DROP TABLE IF EXISTS "${table}"`);
      await admin.query(`CREATE TABLE "${table}" (id serial PRIMARY KEY, note text NOT NULL)`);
      const proxy = await killingProxy(marker);
      const url = new URL(DATABASE_URL);
      url.host = `127.0.0.1:${proxy.port}`;
      const schema = await introspect({ connectionString: DATABASE_URL, include: [table] });
      const db = new TurbineClient({ connectionString: url.toString(), max: 1 }, schema);
      try {
        const q = db.table(table);
        const outcome = await Promise.race([
          db.pipeline([q.buildCreate({ data: { note: 'a' } }), q.buildCreate({ data: { note: 'b' } })]).then(
            () => 'resolved',
            (err: unknown) => `rejected: ${(err as { code?: string })?.code ?? (err as Error)?.name}`,
          ),
          new Promise<string>((resolve) => setTimeout(() => resolve('did not settle within 10 s'), 10000)),
        ]);
        assert.equal(outcome, `rejected: ${code}`, `pipeline() ${outcome}`);
        // The proxy cut the socket before the COMMIT reached the server, and a
        // pool of one answers again, so the checkout was given back.
        const count = await Promise.race([
          q.count(),
          new Promise<string>((resolve) => setTimeout(() => resolve('pool slot not returned within 5 s'), 5000)),
        ]);
        assert.equal(count, 0);
      } finally {
        await Promise.race([db.disconnect().catch(() => {}), new Promise((r) => setTimeout(r, 2000))]);
        proxy.close();
        await admin.query(`DROP TABLE IF EXISTS "${table}"`);
        await admin.end();
      }
    });
  }
});
