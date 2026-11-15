/**
 * ENUM labels with supplementary Unicode on a real MySQL 8 server.
 *
 * The `information_schema` catalog text for a column type is utf8mb3, so a
 * label holding a character outside the BMP comes back with `?` in its place
 * even though the stored definition and every row are intact. Introspection
 * issues SELECTs only: such a column is marked `enumLabelsUnrecoverable`,
 * warned about by name, and generated as `string`, and labels declared
 * explicitly outrank the marker.
 *
 * What each connection sent is read back from the server's general log, so
 * "SELECT only" is observed rather than inferred. The log is a global setting: it is switched on under an
 * advisory lock and restored afterwards, the way the seed fixture handles
 * `partial_revokes`, and each check reads only rows written by this file's
 * own users.
 *
 * Run: MYSQL_URL=mysql://user@host:3306/db \
 *   npx tsx --test src/test/mysql-enum-supplementary.integration.test.ts
 */

import assert from 'node:assert/strict';
import { describe } from 'node:test';
import type { TurbineClient } from '../client.js';
import { generateTypes, generateZod } from '../generate.js';
import type { TurbineLogger } from '../logger.js';
import type { SchemaMetadata } from '../schema.js';
import { skipGate } from './helpers.js';

const MYSQL_URL = process.env.MYSQL_URL ?? process.env.MYSQL_TEST_URL ?? '';
const { it, before, after } = skipGate(!MYSQL_URL, 'requires MYSQL_URL / MYSQL_TEST_URL pointing at a MySQL 8 server');

const DATABASE = 'turbine_mysql_enum_supp';
const MOOD_LABELS = ['plain', '雪🙂', '😀', '𐍈x', 'a𝄞b', 'has?mark', "q'x", 'a,b', ''];
const MODE_LABELS = ['雪🙂', 'back\\slash', "it's"];
// Two labels with the same lossy catalog form, and a literal question mark.
const TWIN_LABELS = ['雪🙂', '雪😀', '?'];
const ODD_TABLE = 'tab ` "\'';
const ODD_COLUMN = 'col ` "\'';
const ODD_LABELS = ['雪🙂', 'a,b', "it's"];
// A user that exists only for this file, so the general log can be read per user.
const SUFFIX = `${process.pid.toString(36)}${Date.now().toString(36)}`.slice(-10);
const READ_USER = `tes_read_${SUFFIX}`;

const quote = (name: string): string => `\`${name.replaceAll('`', '``')}\``;
const literal = (label: string): string => `'${label.replaceAll('\\', '\\\\').replaceAll("'", "''")}'`;

interface Warning {
  message: string;
  code: string;
}

describe('ENUM supplementary labels (live MySQL)', () => {
  // biome-ignore lint/suspicious/noExplicitAny: mysql2 pool shape, loaded dynamically
  let rawPool: any;
  // biome-ignore lint/suspicious/noExplicitAny: mysql2 connection shape, loaded dynamically
  let serial: any;
  // biome-ignore lint/suspicious/noExplicitAny: mysql2 connection options, loaded dynamically
  let server: any;
  let logSettings: { general: number; output: string } | undefined;

  /** The connection string for `user` (no password). */
  function urlFor(user: string): string {
    const url = new URL(MYSQL_URL);
    url.username = user;
    url.password = '';
    url.pathname = `/${DATABASE}`;
    return url.toString();
  }

  /** The current server time, the lower bound of a general-log read. */
  async function now(): Promise<string> {
    const [rows] = await serial.query('SELECT DATE_FORMAT(NOW(6), "%Y-%m-%d %H:%i:%s.%f") AS t');
    return (rows as { t: string }[])[0]!.t;
  }

  /** Every statement `user` sent since `since`, in order, as the general log recorded it. */
  async function sentBy(user: string, since: string): Promise<string[]> {
    const [rows] = await serial.query(
      `SELECT CONVERT(argument USING utf8mb4) AS stmt FROM mysql.general_log
       WHERE user_host LIKE ? AND event_time >= ? AND command_type IN ('Query', 'Execute')
       ORDER BY event_time`,
      [`${user}[%`, since],
    );
    return (rows as { stmt: string }[]).map((r) => r.stmt.trim());
  }

  async function introspectAs(
    user: string,
    options: { include?: string[] } = {},
  ): Promise<{ schema: SchemaMetadata; warnings: Warning[]; sent: string[] }> {
    const { introspectMysql } = await import('../mysql.js');
    const warnings: Warning[] = [];
    const logger: TurbineLogger = { warn: (message, entry) => warnings.push({ message, code: entry.code }) };
    const since = await now();
    const schema = await introspectMysql({
      connectionString: urlFor(user),
      schema: DATABASE,
      include: options.include,
      logger,
    });
    return { schema, warnings, sent: await sentBy(user, since) };
  }

  const marked = (schema: SchemaMetadata, table: string, column: string) =>
    schema.tables[table]!.columns.find((c) => c.name === column)!.enumLabelsUnrecoverable;

  /** `schema` without the table whose name is not a TypeScript identifier, for generation. */
  const generatable = (schema: SchemaMetadata): SchemaMetadata => {
    const { [ODD_TABLE]: _odd, ...tables } = schema.tables;
    const enums = Object.fromEntries(Object.entries(schema.enums).filter(([key]) => !key.startsWith(`${ODD_TABLE}.`)));
    return { tables, enums };
  };

  before(async () => {
    const { createConnection, createPool } = await import('mysql2/promise');
    const url = new URL(MYSQL_URL);
    server = {
      host: url.hostname,
      port: url.port ? Number(url.port) : 3306,
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      charset: 'utf8mb4',
    };
    // Test files run concurrently in native CI; hold the lock until the
    // general log settings are restored in `after`.
    serial = await createConnection(server);
    const [lock] = await serial.query("SELECT GET_LOCK('turbine_enum_supplementary_general_log', 60) AS acquired");
    assert.equal((lock as { acquired: number }[])[0]!.acquired, 1);
    const [settings] = await serial.query('SELECT @@GLOBAL.general_log AS general, @@GLOBAL.log_output AS output');
    logSettings = (settings as { general: number; output: string }[])[0]!;
    await serial.query("SET GLOBAL log_output = 'TABLE'");
    await serial.query('SET GLOBAL general_log = ON');

    await serial.query(`DROP DATABASE IF EXISTS ${quote(DATABASE)}`);
    await serial.query(`CREATE DATABASE ${quote(DATABASE)} CHARACTER SET utf8mb4`);
    rawPool = createPool({
      ...server,
      database: DATABASE,
      namedPlaceholders: true,
      supportBigNumbers: true,
      timezone: 'Z',
      connectionLimit: 4,
    });
    const lits = (labels: string[]) => labels.map(literal).join(',');
    await rawPool.query(
      `CREATE TABLE docs (id INT AUTO_INCREMENT PRIMARY KEY, mood ENUM(${lits(MOOD_LABELS)}) NOT NULL, note VARCHAR(40)) ENGINE=InnoDB`,
    );
    await rawPool.query(
      `CREATE TABLE docs_mb3 (id INT AUTO_INCREMENT PRIMARY KEY, kind ENUM('a?b','雪') CHARACTER SET utf8mb3 NOT NULL) ENGINE=InnoDB`,
    );
    await rawPool.query(
      `CREATE TABLE twins (id INT PRIMARY KEY, v ENUM(${lits(TWIN_LABELS)}) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin) ENGINE=InnoDB`,
    );
    await rawPool.query(
      `CREATE TABLE ${quote(ODD_TABLE)} (id INT PRIMARY KEY, ${quote(ODD_COLUMN)} ENUM(${lits(ODD_LABELS)})) ENGINE=InnoDB`,
    );
    await rawPool.query(`CREATE TABLE shadowed (id INT PRIMARY KEY, mood ENUM('雪🙂')) ENGINE=InnoDB`);
    // Second SQL mode the MySQL suites cover: the same physical labels are
    // declared on a session where backslashes are literal and identifiers
    // take double quotes; introspection must read back the same values.
    const conn = await createConnection({ ...server, database: DATABASE });
    await conn.query("SET SESSION sql_mode = 'ANSI_QUOTES,NO_BACKSLASH_ESCAPES,STRICT_TRANS_TABLES'");
    await conn.query(
      `CREATE TABLE "mode_docs" ("id" INT AUTO_INCREMENT PRIMARY KEY, "mood" ENUM('雪🙂','back\\slash','it''s') NOT NULL) ENGINE=InnoDB`,
    );
    await conn.end();

    await serial.query(`DROP USER IF EXISTS '${READ_USER}'@'%'`);
    await serial.query(`CREATE USER '${READ_USER}'@'%'`);
    await serial.query(`GRANT SELECT ON ${quote(DATABASE)}.* TO '${READ_USER}'@'%'`);
  });

  after(async () => {
    if (!serial) return;
    try {
      await serial.query(`DROP USER IF EXISTS '${READ_USER}'@'%'`);
      await serial.query(`DROP DATABASE IF EXISTS ${quote(DATABASE)}`);
      if (logSettings) {
        await serial.query(`SET GLOBAL general_log = ${logSettings.general ? 'ON' : 'OFF'}`);
        await serial.query('SET GLOBAL log_output = ?', [logSettings.output]);
      }
    } finally {
      await rawPool?.end();
      await serial.end(); // Also releases the advisory lock.
    }
  });

  it('the catalog text is the damaged one (the premise on MySQL 8.4)', async () => {
    const [rows] = await rawPool.query(
      `SELECT COLUMN_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = '${DATABASE}' AND TABLE_NAME = 'docs' AND COLUMN_NAME = 'mood'`,
    );
    assert.match((rows as { COLUMN_TYPE: string }[])[0]!.COLUMN_TYPE, /雪\?/);
  });

  it('introspection sends SELECTs only, marks every suspect column and names it', async () => {
    const { schema, warnings, sent } = await introspectAs(READ_USER);
    assert.ok(sent.length >= 5, sent.join('\n'));
    assert.deepEqual(
      sent.filter((stmt) => !/^SELECT\b/i.test(stmt)),
      [],
    );
    for (const [table, column] of [
      ['docs', 'mood'],
      ['mode_docs', 'mood'],
      ['twins', 'v'],
      [ODD_TABLE, ODD_COLUMN],
    ] as const) {
      assert.equal(Object.hasOwn(schema.enums, `${table}.${column}`), false, `${table}.${column}`);
      assert.equal(marked(schema, table, column), true, `${table}.${column}`);
      assert.ok(
        warnings.some(
          (w) =>
            w.code === 'introspect-enum-labels-unrecoverable' &&
            w.message.includes(`"${table}.${column}"`) &&
            // The one way to exact literal types, for CLI and library users.
            w.message.includes(`columnTypes: { "${table}.${column}"`) &&
            w.message.includes(`schema.enums["${table}.${column}"]`),
        ),
        `${table}.${column}`,
      );
    }
    assert.ok(warnings.every((w) => !/recoverEnumLabels|TEMPORARY/.test(w.message)));
    // BMP-only: the catalog text is exact, and the literal ? stays a label.
    assert.deepEqual(schema.enums['docs_mb3.kind'], ['a?b', '雪']);
    const types = generateTypes(generatable(schema), { target: 'mysql', noTimestamp: true });
    assert.match(types, /mood: string;/);
    assert.doesNotMatch(types, /雪\?/);
    assert.match(generateZod(generatable(schema), { target: 'mysql', noTimestamp: true }), /mood: z\.string\(\)/);
  });

  it('introspectMysqlWith sends SELECTs only, whatever TEMPORARY table the session holds', async () => {
    const { MysqlPool, introspectMysqlWith } = await import('../mysql.js');
    const { createConnection } = await import('mysql2/promise');
    // biome-ignore lint/suspicious/noExplicitAny: mysql2 connection shape, loaded dynamically
    const conn: any = await createConnection({ ...server, database: DATABASE, namedPlaceholders: true });
    try {
      // A TEMPORARY table that shadows `shadowed` on this session, with a
      // different label of the same lossy form: still marked, never trusted.
      await conn.query("CREATE TEMPORARY TABLE shadowed (id INT, mood ENUM('雪😀') CHARACTER SET utf8mb4)");
      const sent: string[] = [];
      const exec = async (sql: string, params: unknown[]) => {
        sent.push(sql);
        const [rows] = await conn.query(sql, Object.fromEntries(params.map((p, i) => [`p${i + 1}`, p])));
        return rows as Record<string, unknown>[];
      };
      const warnings: Warning[] = [];
      const schema = await introspectMysqlWith(exec, DATABASE, {
        include: ['shadowed', 'docs'],
        logger: { warn: (message, entry) => warnings.push({ message, code: entry.code }) },
      });
      assert.equal(Object.hasOwn(schema.enums, 'shadowed.mood'), false);
      assert.equal(marked(schema, 'shadowed', 'mood'), true);
      assert.equal(marked(schema, 'docs', 'mood'), true);
      assert.equal(warnings.length, 2);
      assert.deepEqual(
        sent.filter((stmt) => !/^SELECT\b/.test(stmt)),
        [],
      );

      // A pooled executor that hops sessions gets the same answer.
      const pool = new MysqlPool(rawPool);
      const pooled = await introspectMysqlWith(async (sql, params) => (await pool.query(sql, params)).rows, DATABASE, {
        include: ['docs'],
        logger: {},
      });
      assert.equal(marked(pooled, 'docs', 'mood'), true);
    } finally {
      await conn.end();
    }
  });

  it('declared labels outrank the marker: exact union and zod enum, and they round-trip as data', async () => {
    const { schema: introspected } = await introspectAs(READ_USER);
    // In code: an `enums` entry on the introspected metadata before generate().
    const schema: SchemaMetadata = {
      ...introspected,
      enums: { ...introspected.enums, 'docs.mood': MOOD_LABELS, 'mode_docs.mood': MODE_LABELS, 'twins.v': TWIN_LABELS },
    };
    assert.equal(marked(schema, 'docs', 'mood'), true);
    const types = generateTypes(generatable(schema), { target: 'mysql', noTimestamp: true });
    assert.ok(types.includes("'雪🙂'"), types);
    assert.ok(types.includes("'𐍈x'"), types);
    assert.doesNotMatch(types, /mood: string;/);
    assert.ok(generateZod(generatable(schema), { target: 'mysql', noTimestamp: true }).includes("'😀'"));
    // With the CLI: a `columnTypes` entry, which outranks the marker as well.
    const overridden = generateTypes(generatable(introspected), {
      target: 'mysql',
      noTimestamp: true,
      columnTypes: { 'docs.mood': "'雪🙂' | '😀'" },
    });
    assert.ok(overridden.includes("mood: '雪🙂' | '😀';"), overridden);

    const { MysqlPool, turbineMysql } = await import('../mysql.js');
    const pool = new MysqlPool(rawPool);
    const db = (await turbineMysql(pool, schema)) as unknown as TurbineClient;
    try {
      const docs = db.table<Record<string, unknown>>('docs');
      for (const mood of ['雪🙂', '😀', '𐍈x', 'a𝄞b']) {
        const created = await docs.create({ data: { mood, note: 'x' } });
        assert.equal(created.mood, mood);
        const found = await docs.findFirst({ where: { mood } });
        assert.equal(found?.mood, mood);
      }
    } finally {
      await db.disconnect();
    }
  });
});
