/** Disposable database fixtures; the caller owns the server identified by MYSQL_URL. */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import type { TestContext } from 'node:test';
import { introspectMysql } from '../mysql.js';

export const mysqlSeedUrl = process.env.MYSQL_URL ?? process.env.MYSQL_TEST_URL ?? '';

export async function mysqlSeedFixture(t: TestContext) {
  const { createConnection, createPool } = await import('mysql2/promise');
  const url = new URL(mysqlSeedUrl);
  const config = {
    host: url.hostname,
    port: Number(url.port || 3306),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
  };
  const admin = await createConnection(config);
  const database = `turbine_seed_${randomBytes(8).toString('hex')}`;
  await admin.query(`CREATE DATABASE \`${database}\``);
  const pool = createPool({
    ...config,
    database,
    namedPlaceholders: true,
    supportBigNumbers: true,
    bigNumberStrings: false,
    timezone: '+00:00',
    connectionLimit: 3,
  });
  t.after(async () => {
    await pool.end();
    try {
      await admin.query(`DROP DATABASE \`${database}\``);
    } finally {
      await admin.end();
    }
  });
  await pool.query(
    'CREATE TABLE items (id INT PRIMARY KEY, label VARCHAR(255) NOT NULL UNIQUE, n INT NOT NULL DEFAULT 1 CHECK (n > 0)) ENGINE=InnoDB',
  );
  await pool.query(
    'CREATE TABLE children (id INT PRIMARY KEY, item_id INT NOT NULL, FOREIGN KEY (item_id) REFERENCES items(id)) ENGINE=InnoDB',
  );
  url.pathname = `/${database}`;
  const schema = await introspectMysql({ connectionString: url.href, schema: database });
  const rows = async () => (await pool.query('SELECT id, label, n FROM items ORDER BY id'))[0];
  return { admin, pool, schema, rows, url: url.href, database, config };
}

/** A global grant with a schema-level revoke hides a definer trigger. */
export async function mysqlSeedPartialRevokeFixture(t: TestContext) {
  const f = await mysqlSeedFixture(t);
  const { createConnection, createPool } = await import('mysql2/promise');
  const user = `seed_${f.database.slice(-16)}`;
  const outside = `${f.database}_outside`;
  // Separate test files run concurrently in native CI. Hold a dedicated lock
  // until global configuration and all partial grants have been restored.
  const serial = await createConnection(f.config);
  let enabled: number | undefined;
  t.after(async () => {
    try {
      await serial.query(`DROP USER IF EXISTS '${user}'@'%'`);
      await serial.query(`DROP DATABASE IF EXISTS \`${outside}\``);
      if (enabled !== undefined) await serial.query(`SET GLOBAL partial_revokes=${enabled ? 'ON' : 'OFF'}`);
    } finally {
      await serial.end(); // Also releases the fixture-only advisory lock.
    }
  });
  const [lock] = await serial.query("SELECT GET_LOCK('turbine_seed_partial_revokes_fixture', 60) AS acquired");
  assert.equal((lock as { acquired: number }[])[0]!.acquired, 1);
  const [settings] = await serial.query('SELECT @@GLOBAL.partial_revokes AS enabled');
  enabled = (settings as { enabled: number }[])[0]!.enabled;
  await f.admin.query('SET GLOBAL partial_revokes=ON');
  await f.admin.query(`CREATE DATABASE \`${outside}\``);
  await f.admin.query(`CREATE TABLE \`${outside}\`.effects(id INT) ENGINE=MyISAM`);
  await f.pool.query(
    `CREATE TRIGGER hidden_trigger AFTER INSERT ON items FOR EACH ROW INSERT INTO \`${outside}\`.effects VALUES (NEW.id)`,
  );
  await f.admin.query(`CREATE USER '${user}'@'%'`);
  await f.admin.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON \`${f.database}\`.* TO '${user}'@'%'`);
  await f.admin.query(`GRANT TRIGGER ON *.* TO '${user}'@'%'`);
  await f.admin.query(`REVOKE TRIGGER ON \`${f.database}\`.* FROM '${user}'@'%'`);
  const limited = createPool({ ...f.config, user, password: '', database: f.database, namedPlaceholders: true });
  t.after(() => limited.end());
  const url = new URL(f.url);
  url.username = user;
  url.password = '';
  const effects = async () => (await f.admin.query(`SELECT * FROM \`${outside}\`.effects`))[0];
  return { ...f, limited, limitedUrl: url.href, effects };
}
