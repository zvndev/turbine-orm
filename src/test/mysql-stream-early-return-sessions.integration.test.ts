/**
 * A MySQL stream the caller stops early must not leave its query running on
 * the server outside the pool limit.
 *
 * Stopping a native stream discards the connection. When that only
 * half-closes a socket whose result the server is still writing, the server
 * cannot read the close: the session stays in "Sending to client" until
 * `net_write_timeout` (60 s by default), holding its metadata lock, while the
 * pool opens new connections. Enough early stops then exhaust the server's
 * `max_connections` for every client.
 */
import assert from 'node:assert/strict';
import { describe } from 'node:test';
import { introspectMysql, turbineMysql } from '../mysql.js';
import { skipGate } from './helpers.js';

const url = process.env.MYSQL_URL ?? process.env.MYSQL_TEST_URL ?? '';
const native = skipGate(!url, 'requires MYSQL_URL / MYSQL_TEST_URL pointing at a disposable MySQL 8 server');

describe('MySQL stream early return', () => {
  native.it('keeps server sessions within the pool limit after streams stopped early', { timeout: 60000 }, async () => {
    const { createConnection } = await import('mysql2/promise');
    const base = new URL(url);
    const dbName = `turbine_stream_return_${process.pid}`;
    base.pathname = '/';
    const admin = await createConnection({ uri: base.toString() });
    const sessions = async () => {
      const [rows] = await admin.query(
        'SELECT ID AS id FROM information_schema.PROCESSLIST WHERE DB = ? AND ID <> CONNECTION_ID()',
        [dbName],
      );
      return rows as { id: number }[];
    };
    await admin.query(`DROP DATABASE IF EXISTS \`${dbName}\``);
    await admin.query(`CREATE DATABASE \`${dbName}\``);
    try {
      await admin.query(
        `CREATE TABLE \`${dbName}\`.big (id INT AUTO_INCREMENT PRIMARY KEY, payload VARCHAR(300) NOT NULL)`,
      );
      // 100,000 rows of about 300 bytes: far more than socket buffers hold, so
      // the server is still writing when the consumer stops.
      await admin.query(`INSERT INTO \`${dbName}\`.big (payload)
        SELECT REPEAT('x', 300) FROM
          (SELECT 0 d UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4
           UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8 UNION ALL SELECT 9) a,
          (SELECT 0 d UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4
           UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8 UNION ALL SELECT 9) b,
          (SELECT 0 d UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4
           UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8 UNION ALL SELECT 9) c,
          (SELECT 0 d UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4
           UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8 UNION ALL SELECT 9) e,
          (SELECT 0 d UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4
           UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8 UNION ALL SELECT 9) f`);
      const dbUrl = new URL(url);
      dbUrl.pathname = `/${dbName}`;
      const schema = await introspectMysql({ connectionString: dbUrl.toString() });
      const db = await turbineMysql(dbUrl.toString(), schema, { connectionLimit: 2 });
      try {
        for (let i = 0; i < 10; i++) {
          let seen = 0;
          for await (const _row of db.table('big').findManyStream({ batchSize: 50 })) if (++seen >= 3) break;
        }
        // Give a closed session time to leave.
        let open = (await sessions()).length;
        for (let waited = 0; open > 2 && waited < 3000; waited += 250) {
          await new Promise((r) => setTimeout(r, 250));
          open = (await sessions()).length;
        }
        assert.ok(open <= 2, `${open} server sessions remain on a pool limited to 2 after 10 early stream returns`);
      } finally {
        await db.disconnect();
      }
    } finally {
      // Sessions left writing would block DROP DATABASE on their metadata lock.
      for (const { id } of await sessions()) await admin.query(`KILL ${Number(id)}`).catch(() => {});
      await admin.query(`DROP DATABASE IF EXISTS \`${dbName}\``);
      await admin.end();
    }
  });
});
