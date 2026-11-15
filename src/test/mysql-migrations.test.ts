import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';
import type { Connection } from 'mysql2/promise';
import {
  inspectMysqlMigrationDeploy,
  migrateMysqlDeploy,
  migrateMysqlDown,
  migrateMysqlStatus,
  migrateMysqlUp,
  planMysqlMigrationRollback,
  recoverMysqlMigration,
} from '../cli/mysql-migrate.js';
import { parseMysqlMigrationStatements, scanMysqlMigrationDestructive } from '../cli/mysql-migrate-sql.js';
import { skipGate } from './helpers.js';

const mode = { noBackslashEscapes: false, ansiQuotes: false };
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const MYSQL_URL = process.env.MYSQL_URL ?? process.env.MYSQL_TEST_URL ?? '';
const { it: liveIt } = skipGate(!MYSQL_URL, 'requires MYSQL_URL pointing at a disposable MySQL 8 server');

describe('MySQL migration SQL policy', () => {
  it('splits native strings, backticks, hash comments and non-nesting comments', () => {
    const statements = parseMysqlMigrationStatements(
      "# header\nCREATE TABLE `semi;table` (`v` TEXT); INSERT INTO `semi;table` VALUES ('one;two\\'three'); -- comment\n/* outer /* inner */ INSERT INTO `semi;table` VALUES ('last');",
      mode,
    );
    assert.equal(statements.length, 3);
    assert.match(statements[0]!.sql, /`semi;table`/);
    assert.match(statements[1]!.sql, /one;two/);
    assert.doesNotMatch(statements[1]!.normalized, /one;two/);
    assert.match(statements[2]!.normalized, /^INSERT/);
  });

  it('uses the connection SQL mode for ANSI quotes and backslash literals', () => {
    const nativeMode = { noBackslashEscapes: true, ansiQuotes: true };
    assert.equal(
      parseMysqlMigrationStatements('CREATE TABLE "q" (v TEXT); INSERT INTO "q" VALUES (\'backslash\\\');', nativeMode)
        .length,
      2,
    );
    assert.throws(() => parseMysqlMigrationStatements("INSERT INTO t VALUES ('backslash\\');", mode), /Unterminated/);
    assert.throws(() => parseMysqlMigrationStatements('DROP TABLE "_turbine_migrations";', nativeMode), /metadata/);
  });

  it('refuses executable comments, malformed quotes and control statements', () => {
    for (const sql of [
      '/*!80000 DROP TABLE t */',
      '/*M! DROP TABLE t */',
      '/*+ hint */ CREATE TABLE t(id INT)',
      '/* unclosed',
      "INSERT INTO t VALUES ('unclosed)",
      'BEGIN',
      'COMMIT',
      'ROLLBACK',
      'SET autocommit=0',
      'USE other',
      'DELIMITER $$',
      'CALL procedure_name()',
      'CREATE TRIGGER t BEFORE INSERT ON x FOR EACH ROW SET @a=1',
      'REPLACE INTO t VALUES (1)',
    ]) {
      assert.throws(() => parseMysqlMigrationStatements(sql, mode), sql);
    }
  });

  it('guards metadata, lock ownership, other databases, variables and non-InnoDB engines', () => {
    for (const sql of [
      'DROP TABLE `_TURBINE_MIGRATIONS`',
      'INSERT INTO _turbine_migration_state VALUES (1)',
      'CREATE TABLE t (id INT REFERENCES _turbine_migrations(id))',
      'INSERT INTO t VALUES (RELEASE_ALL_LOCKS())',
      'INSERT INTO t VALUES (`RELEASE_ALL_LOCKS`())',
      'INSERT INTO t VALUES (`GET_LOCK`(1,0))',
      "INSERT INTO t VALUES (GET_LOCK('other',0))",
      'ALTER TABLE t ENGINE=MyISAM',
      'ALTER TABLE t ENGINE=InnoDB ENGINE=MyISAM',
      'CREATE TABLE other.t(id INT)',
      'INSERT INTO t SELECT * FROM other.x',
      'DROP TABLE x, other.y',
      'INSERT INTO t VALUES (@session_variable)',
      'CREATE TEMPORARY TABLE t(id INT)',
    ]) {
      assert.throws(() => parseMysqlMigrationStatements(sql, mode), sql);
    }
    assert.equal(
      parseMysqlMigrationStatements("INSERT INTO t VALUES ('_turbine_migrations; RELEASE_LOCK()');", mode).length,
      1,
      'literal contents are data',
    );
    assert.equal(parseMysqlMigrationStatements('CREATE TABLE t(n DECIMAL(8,2)) ENGINE=InnoDB;', mode).length, 1);
  });

  it('detects destructive MySQL rewrites while ignoring literal/comment lookalikes', () => {
    for (const sql of [
      'ALTER TABLE t MODIFY v INT',
      'ALTER TABLE t CHANGE v v2 INT',
      'ALTER TABLE t CONVERT TO CHARACTER SET utf8mb4',
      'ALTER TABLE items TRUNCATE PARTITION p0',
      'ALTER TABLE 123items DROP COLUMN label',
      'ALTER TABLE items RENAME moved',
      'ALTER TABLE items ADD COLUMN label TEXT',
      'TRUNCATE TABLE t',
      'DROP TABLE `odd;table`',
      'DELETE FROM t WHERE id=1',
      'UPDATE t SET v=1',
      'UPDATE t SET v=1 WHERE 1--2',
      'INSERT INTO t VALUES (1) ON DUPLICATE KEY UPDATE v=2',
    ]) {
      assert.ok(scanMysqlMigrationDestructive(parseMysqlMigrationStatements(sql, mode)).length > 0, sql);
    }
    assert.deepEqual(
      scanMysqlMigrationDestructive(
        parseMysqlMigrationStatements("INSERT INTO t VALUES ('DROP TABLE x'); # DELETE FROM t", mode),
      ),
      [],
    );
  });

  it('validates URL/options before trying any connection and keeps credentials out of errors', async () => {
    for (const url of [
      'postgres://secret:private@localhost/db',
      'mysql://secret:private@localhost/',
      'mysql://secret:private@localhost/db?multipleStatements=true',
      'mysql://secret:private@localhost/db/other',
    ]) {
      await assert.rejects(migrateMysqlUp(url, '/missing'), (error: Error) => {
        assert.match(error.message, /mysql:\/\/ URL/);
        assert.doesNotMatch(error.message, /secret|private/);
        return true;
      });
    }
    for (const step of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])
      await assert.rejects(migrateMysqlUp('mysql://localhost/db', '/missing', { step }), /positive safe integer/);
    for (const lockWaitMs of [-1, 1.5, 2147483648])
      await assert.rejects(migrateMysqlUp('mysql://localhost/db', '/missing', { lockWaitMs }), /lockWaitMs/);
    await assert.rejects(migrateMysqlUp('mysql://localhost/db', '/missing', { schema: 'other' }), /schema must match/);
    await assert.rejects(migrateMysqlUp('mysql://localhost/db', '/missing', { force: true }), /force reapplication/);
  });
});

interface Fixture {
  connection: Connection;
  url: string;
  dir: string;
  database: string;
  write(name: string, up: string, down?: string): string;
  query(sql: string, values?: (string | number | null)[]): Promise<Array<Record<string, unknown>>>;
}

async function fixture(body: (fixture: Fixture) => Promise<void>): Promise<void> {
  const { createConnection } = await import('mysql2/promise');
  const base = new URL(MYSQL_URL);
  const database = `turbine_migrate_${process.pid}_${randomBytes(5).toString('hex')}`;
  const config = {
    host: base.hostname,
    port: Number(base.port || 3306),
    user: decodeURIComponent(base.username),
    password: decodeURIComponent(base.password),
    timezone: 'Z',
  };
  const admin = await createConnection(config);
  const dir = mkdtempSync(join(tmpdir(), 'turbine-mysql-migrations-'));
  let connection: Connection | undefined;
  try {
    await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);
    connection = await createConnection({ ...config, database });
    const url = new URL(base);
    url.pathname = `/${database}`;
    url.search = '';
    url.hash = '';
    await body({
      connection,
      url: url.href,
      dir,
      database,
      write(name, up, down = '') {
        const path = join(dir, `${name}.sql`);
        writeFileSync(path, `-- migration\n-- UP\n${up}\n-- DOWN\n${down}\n`);
        return path;
      },
      async query(sql, values) {
        return (values ? await connection!.execute(sql, values) : await connection!.query(sql))[0] as Array<
          Record<string, unknown>
        >;
      },
    });
  } finally {
    await connection?.end();
    await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
    await admin.end();
    rmSync(dir, { recursive: true, force: true });
  }
}

const one = '20260101000000_create_items';
const two = '20260102000000_change_items';

describe('native MySQL migration lifecycle', () => {
  for (const scenario of [
    {
      initial:
        'CREATE TABLE items(id INT) ENGINE=InnoDB PARTITION BY RANGE(id) (PARTITION p0 VALUES LESS THAN (10), PARTITION p1 VALUES LESS THAN MAXVALUE); INSERT INTO items VALUES (1),(11)',
      alter: 'ALTER TABLE items TRUNCATE PARTITION p0',
      query: 'SELECT * FROM items ORDER BY id',
      before: [{ id: 1 }, { id: 11 }],
      after: [{ id: 11 }],
    },
    {
      initial: "CREATE TABLE 123items(id INT, label VARCHAR(20)); INSERT INTO 123items VALUES (1,'kept')",
      alter: 'ALTER TABLE 123items DROP COLUMN label',
      query: 'SELECT * FROM 123items',
      before: [{ id: 1, label: 'kept' }],
      after: [{ id: 1 }],
    },
    {
      initial: 'CREATE TABLE items(id INT); INSERT INTO items VALUES (1)',
      alter: 'ALTER TABLE items RENAME moved',
      query: 'SELECT * FROM items',
      before: [{ id: 1 }],
      after: [{ id: 1 }],
      afterQuery: 'SELECT * FROM moved',
    },
  ]) {
    liveIt(`requires consent before native effects: ${scenario.alter}`, async () =>
      fixture(async (f) => {
        f.write(one, scenario.initial);
        await migrateMysqlUp(f.url, f.dir);
        f.write(two, scenario.alter);
        await assert.rejects(migrateMysqlUp(f.url, f.dir), /destructive SQL/);
        assert.deepEqual(await f.query(scenario.query), scenario.before);
        assert.equal((await inspectMysqlMigrationDeploy(f.url, f.dir)).dirty, null);
        const applied = await migrateMysqlUp(f.url, f.dir, { allowDestructive: true });
        assert.equal(applied.applied.length, 1);
        assert.equal(applied.errors.length, 0);
        assert.ok(applied.destructive.length > 0);
        assert.deepEqual(await f.query(scenario.afterQuery ?? scenario.query), scenario.after);
      }),
    );
  }

  liveIt(
    'refuses quoted lock functions during complete-batch preflight with no application or tracking effects',
    async () =>
      fixture(async (f) => {
        f.write(one, 'CREATE TABLE items(id INT); INSERT INTO items VALUES (`RELEASE_ALL_LOCKS`())');
        await assert.rejects(migrateMysqlUp(f.url, f.dir), /Unsupported MySQL migration control/);
        assert.deepEqual(await f.query('SHOW TABLES'), []);
      }),
  );
  liveIt('inspects fresh databases without creating history or journal tables', async () =>
    fixture(async (f) => {
      f.write(one, 'CREATE TABLE items(id INT PRIMARY KEY)');
      const plan = await inspectMysqlMigrationDeploy(f.url, f.dir);
      assert.equal(plan.pending.length, 1);
      assert.deepEqual(plan.mismatches, []);
      assert.equal(plan.dirty, null);
      assert.equal((await migrateMysqlStatus(f.url, f.dir))[0]!.applied, false);
      assert.deepEqual(await f.query('SHOW TABLES'), []);
    }),
  );

  liveIt('runs UP/status/DOWN with real unique, autoincrement, JSON and collation effects', async () =>
    fixture(async (f) => {
      const path = f.write(
        one,
        `CREATE TABLE items(id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, code VARCHAR(60) COLLATE utf8mb4_0900_ai_ci UNIQUE, payload JSON NOT NULL) ENGINE=InnoDB;
INSERT INTO items(code,payload) VALUES ('Alpha',JSON_OBJECT('ok',true));`,
        'DROP TABLE items;',
      );
      const result = await migrateMysqlUp(f.url, f.dir);
      assert.deepEqual(result.errors, []);
      assert.equal(result.applied.length, 1);
      assert.equal(result.noTransaction.length, 1);
      const [row] = await f.query("SELECT id, JSON_EXTRACT(payload,'$.ok') AS ok FROM items WHERE code='alpha'");
      assert.equal(Number(row!.id), 1);
      assert.equal(String(row!.ok), 'true');
      await assert.rejects(f.connection.query("INSERT INTO items(code,payload) VALUES ('alpha','{}')"), /Duplicate/);
      await assert.rejects(
        f.connection.query("INSERT INTO items(code,payload) VALUES ('other','invalid JSON')"),
        /JSON/,
      );
      const [history] = await f.query('SELECT name,checksum,applied_at FROM _turbine_migrations');
      assert.equal(history!.checksum, hash(readFileSync(path, 'utf8')));
      assert.ok(history!.applied_at instanceof Date);
      assert.equal((await migrateMysqlStatus(f.url, f.dir))[0]!.checksumValid, true);
      assert.deepEqual(await f.query('SELECT * FROM _turbine_migration_state'), []);
      assert.deepEqual(
        (await planMysqlMigrationRollback(f.url, f.dir)).map((file) => file.name),
        [one],
      );
      await assert.rejects(migrateMysqlDown(f.url, f.dir), /allowDestructive/);
      assert.equal((await f.query('SELECT COUNT(*) AS n FROM items'))[0]!.n, 1);
      const down = await migrateMysqlDown(f.url, f.dir, { allowDestructive: true });
      assert.equal(down.rolledBack.length, 1);
      assert.deepEqual(down.errors, []);
      await assert.rejects(f.connection.query('SELECT * FROM items'), /doesn't exist/);
      assert.deepEqual(await f.query('SELECT * FROM _turbine_migrations'), []);
      assert.equal((await migrateMysqlStatus(f.url, f.dir))[0]!.applied, false);
    }),
  );

  liveIt('preflights the complete batch and requires consent before any mutation', async () =>
    fixture(async (f) => {
      f.write(one, 'CREATE TABLE items(id INT)');
      const bad = f.write(two, 'COMMIT;');
      await assert.rejects(migrateMysqlUp(f.url, f.dir), /Unsupported/);
      assert.deepEqual(await f.query('SHOW TABLES'), []);
      writeFileSync(bad, '-- UP\nCREATE TABLE other(id INT); DROP TABLE other;');
      await assert.rejects(migrateMysqlUp(f.url, f.dir), /allowDestructive/);
      await assert.rejects(
        migrateMysqlUp(f.url, f.dir, { allowDestructive: 'false' as unknown as boolean }),
        /allowDestructive/,
      );
      assert.deepEqual(await f.query('SHOW TABLES'), []);
      const deployed = await migrateMysqlDeploy(f.url, f.dir);
      assert.equal(deployed.applied.length, 2);
      assert.deepEqual(deployed.errors, []);
      assert.equal(deployed.destructive.length, 1);
    }),
  );

  liveIt('persists partial DDL/data, refuses retry and requires exact explicit recovery', async () =>
    fixture(async (f) => {
      const path = f.write(
        one,
        'CREATE TABLE items(id INT PRIMARY KEY); INSERT INTO items VALUES (1); INSERT INTO items VALUES (1);',
      );
      const original = readFileSync(path, 'utf8');
      const result = await migrateMysqlUp(f.url, f.dir);
      assert.equal(result.applied.length, 0);
      assert.equal(result.errors.length, 1);
      assert.match(result.errors[0]!.error, /No rollback is claimed/);
      assert.deepEqual(await f.query('SELECT * FROM items'), [{ id: 1 }]);
      assert.deepEqual(await f.query('SELECT * FROM _turbine_migrations'), []);
      const [status] = await migrateMysqlStatus(f.url, f.dir);
      assert.equal(status!.applied, false);
      assert.equal(status!.dirty!.completedStatements, 2);
      assert.equal(status!.dirty!.totalStatements, 3);
      const dirty = (await inspectMysqlMigrationDeploy(f.url, f.dir)).dirty!;
      const recovery = {
        name: dirty.name,
        checksum: dirty.checksum,
        outcome: 'rolled-back' as const,
        acknowledgePartialDdl: true as const,
      };
      await assert.rejects(
        migrateMysqlUp(f.url, f.dir, { allowDrift: true, allowDestructive: true }),
        /Automatic retry is refused/,
      );
      await assert.rejects(recoverMysqlMigration(f.url, f.dir, { ...recovery, checksum: 'bad' }), /exact dirty/);
      await assert.rejects(
        recoverMysqlMigration(f.url, f.dir, { ...recovery, acknowledgePartialDdl: false as unknown as true }),
        /acknowledgePartialDdl/,
      );
      writeFileSync(path, `${original}\n-- edited`);
      await assert.rejects(recoverMysqlMigration(f.url, f.dir, recovery), /unchanged/);
      writeFileSync(path, original);
      await f.connection.query('DROP TABLE items');
      await recoverMysqlMigration(f.url, f.dir, recovery);
      assert.equal((await inspectMysqlMigrationDeploy(f.url, f.dir)).dirty, null);
      f.write(one, 'CREATE TABLE items(id INT PRIMARY KEY); INSERT INTO items VALUES (2);');
      assert.equal((await migrateMysqlUp(f.url, f.dir)).applied.length, 1);
      assert.deepEqual(await f.query('SELECT * FROM items'), [{ id: 2 }]);
    }),
  );

  liveIt('can finalize a manually reconciled partial UP as applied', async () =>
    fixture(async (f) => {
      f.write(one, 'CREATE TABLE items(id INT); INSERT INTO absent_table VALUES (1)');
      assert.equal((await migrateMysqlUp(f.url, f.dir)).errors.length, 1);
      const dirty = (await inspectMysqlMigrationDeploy(f.url, f.dir)).dirty!;
      await f.connection.query('CREATE TABLE absent_table(id INT)');
      await f.connection.query('INSERT INTO absent_table VALUES (1)');
      await recoverMysqlMigration(f.url, f.dir, {
        name: dirty.name,
        checksum: dirty.checksum,
        outcome: 'applied',
        acknowledgePartialDdl: true,
      });
      assert.equal((await migrateMysqlStatus(f.url, f.dir))[0]!.checksumValid, true);
      assert.equal((await migrateMysqlUp(f.url, f.dir)).applied.length, 0);
      assert.deepEqual(await f.query('SELECT * FROM absent_table'), [{ id: 1 }]);
    }),
  );

  liveIt('keeps completed earlier files when a later file fails', async () =>
    fixture(async (f) => {
      f.write(one, 'CREATE TABLE items(id INT PRIMARY KEY); INSERT INTO items VALUES (1)');
      f.write(two, 'ALTER TABLE items ADD COLUMN label VARCHAR(20); INSERT INTO absent_table VALUES (2)');
      const result = await migrateMysqlDeploy(f.url, f.dir);
      assert.deepEqual(
        result.applied.map((file) => file.name),
        [one],
      );
      assert.equal(result.errors.length, 1);
      assert.deepEqual(await f.query('SELECT * FROM items'), [{ id: 1, label: null }]);
      assert.deepEqual(
        (await f.query('SELECT name FROM _turbine_migrations')).map((row) => row.name),
        [one],
      );
      assert.equal((await inspectMysqlMigrationDeploy(f.url, f.dir)).dirty!.name, two);
    }),
  );

  liveIt('keeps history after partial DOWN and supports explicit reconciled removal', async () =>
    fixture(async (f) => {
      f.write(
        one,
        "CREATE TABLE items(id INT, label VARCHAR(20)); INSERT INTO items VALUES (1,'kept')",
        'ALTER TABLE items DROP COLUMN label; INSERT INTO absent_table VALUES (1)',
      );
      assert.equal((await migrateMysqlUp(f.url, f.dir)).applied.length, 1);
      const result = await migrateMysqlDown(f.url, f.dir, { allowDestructive: true });
      assert.equal(result.rolledBack.length, 0);
      assert.equal(result.errors.length, 1);
      assert.deepEqual(await f.query('SELECT * FROM items'), [{ id: 1 }]);
      const [status] = await migrateMysqlStatus(f.url, f.dir);
      assert.equal(status!.applied, true);
      assert.equal(status!.dirty!.direction, 'down');
      await assert.rejects(migrateMysqlDown(f.url, f.dir, { allowDestructive: true }), /Automatic retry/);
      await f.connection.query('DROP TABLE items');
      await recoverMysqlMigration(f.url, f.dir, {
        name: status!.dirty!.name,
        checksum: status!.dirty!.checksum,
        outcome: 'rolled-back',
        acknowledgePartialDdl: true,
      });
      assert.deepEqual(await f.query('SELECT * FROM _turbine_migrations'), []);
      assert.equal((await inspectMysqlMigrationDeploy(f.url, f.dir)).dirty, null);
    }),
  );

  liveIt('refuses drift and missing files; explicit UP drift consent rebaselines exact bytes', async () =>
    fixture(async (f) => {
      const path = f.write(one, 'CREATE TABLE items(id INT)', 'DROP TABLE items');
      await migrateMysqlUp(f.url, f.dir);
      const original = readFileSync(path, 'utf8');
      writeFileSync(path, `${original}\n-- intentional edit`);
      assert.equal((await migrateMysqlStatus(f.url, f.dir))[0]!.checksumValid, false);
      assert.equal((await inspectMysqlMigrationDeploy(f.url, f.dir)).mismatches[0]!.type, 'modified');
      await assert.rejects(migrateMysqlDeploy(f.url, f.dir, { allowDrift: true }), /checksum|modified/i);
      await assert.rejects(migrateMysqlUp(f.url, f.dir), /checksum|modified/i);
      await assert.rejects(
        migrateMysqlUp(f.url, f.dir, { allowDrift: 'false' as unknown as boolean }),
        /checksum|modified/i,
      );
      const result = await migrateMysqlUp(f.url, f.dir, { allowDrift: true });
      assert.deepEqual(result.rebaselined, [{ name: one, from: hash(original), to: hash(readFileSync(path, 'utf8')) }]);
      assert.equal((await migrateMysqlStatus(f.url, f.dir))[0]!.checksumValid, true);
      unlinkSync(path);
      const [status] = await migrateMysqlStatus(f.url, f.dir);
      assert.equal(status!.missingFile, true);
      assert.equal(status!.applied, true);
      for (const run of [migrateMysqlUp, migrateMysqlDown])
        await assert.rejects(run(f.url, f.dir, { allowDrift: true, allowDestructive: true }), /deleted from disk/i);
      assert.equal((await f.query('SELECT COUNT(*) AS n FROM _turbine_migrations'))[0]!.n, 1);
    }),
  );

  liveIt('upgrades only verified legacy checksums and preserves binary migration-name identity', async () =>
    fixture(async (f) => {
      const first = '20260101000000_Alpha';
      const second = '20260101000000_alpha';
      const third = '20260101000000_alpha ';
      const fourth = "20260101000000_café's";
      const fifth = '20260101000000_álpha';
      const path = f.write(first, 'CREATE TABLE items(id INT)');
      f.write(second, 'INSERT INTO items VALUES (2)');
      f.write(third, 'INSERT INTO items VALUES (3)');
      f.write(fourth, 'INSERT INTO items VALUES (4)');
      f.write(fifth, 'INSERT INTO items VALUES (5)');
      assert.equal((await migrateMysqlUp(f.url, f.dir)).applied.length, 5);
      const content = readFileSync(path, 'utf8');
      let legacy = 0;
      for (let i = 0; i < content.length; i++) legacy = ((legacy << 5) - legacy + content.charCodeAt(i)) | 0;
      await f.connection.query('UPDATE _turbine_migrations SET checksum=? WHERE name=?', [
        Math.abs(legacy).toString(36),
        first,
      ]);
      assert.equal((await migrateMysqlStatus(f.url, f.dir))[0]!.checksumValid, true);
      await migrateMysqlUp(f.url, f.dir);
      const records = await f.query('SELECT name,checksum FROM _turbine_migrations ORDER BY id');
      assert.deepEqual(
        records.map((row) => row.name),
        [first, third, second, fourth, fifth],
      );
      assert.equal(records[0]!.checksum, hash(content));
      await f.connection.query('UPDATE _turbine_migrations SET checksum=? WHERE name=?', ['wrong', first]);
      await assert.rejects(migrateMysqlUp(f.url, f.dir), /checksum|modified/i);
    }),
  );

  liveIt('honors steps, reports out-of-order files and runs DOWN in actual application order', async () =>
    fixture(async (f) => {
      f.write(two, 'CREATE TABLE items(id INT PRIMARY KEY)', 'DROP TABLE items');
      await migrateMysqlUp(f.url, f.dir);
      f.write(one, 'INSERT INTO items VALUES (1)', 'DELETE FROM items WHERE id=1');
      const third = '20260103000000_later';
      f.write(third, 'INSERT INTO items VALUES (3)', 'DELETE FROM items WHERE id=3');
      const result = await migrateMysqlUp(f.url, f.dir, { step: 1 });
      assert.deepEqual(
        result.applied.map((file) => file.name),
        [one],
      );
      assert.deepEqual(result.outOfOrder, [{ applied: `${one}.sql`, newestPrior: `${two}.sql` }]);
      assert.deepEqual(
        (await planMysqlMigrationRollback(f.url, f.dir, { step: 2 })).map((file) => file.name),
        [one, two],
      );
      assert.equal((await migrateMysqlDown(f.url, f.dir, { allowDestructive: true })).rolledBack[0]!.name, one);
      assert.deepEqual(await f.query('SELECT * FROM items'), []);
      assert.equal((await migrateMysqlStatus(f.url, f.dir)).filter((status) => status.applied).length, 1);
    }),
  );

  liveIt('refuses empty DOWN and malformed metadata before applying any effects', async () =>
    fixture(async (f) => {
      f.write(one, 'CREATE TABLE items(id INT)');
      await migrateMysqlUp(f.url, f.dir);
      await assert.rejects(migrateMysqlDown(f.url, f.dir), /no executable DOWN/);
      await f.connection.query(
        'ALTER TABLE _turbine_migrations MODIFY name VARCHAR(255) COLLATE utf8mb4_0900_ai_ci NOT NULL',
      );
      await assert.rejects(migrateMysqlStatus(f.url, f.dir), /incompatible name/);
      assert.deepEqual(await f.query('SELECT * FROM items'), []);
      assert.equal((await f.query('SELECT COUNT(*) AS n FROM _turbine_migrations'))[0]!.n, 1);
    }),
  );

  liveIt('refuses history triggers and incoming foreign keys', async () =>
    fixture(async (f) => {
      f.write(one, 'CREATE TABLE items(id INT)');
      await migrateMysqlUp(f.url, f.dir);
      await f.connection.query(
        'CREATE TRIGGER metadata_trigger BEFORE DELETE ON _turbine_migrations FOR EACH ROW SET @unused=1',
      );
      await assert.rejects(migrateMysqlUp(f.url, f.dir), /triggers or foreign keys/);
      await f.connection.query('DROP TRIGGER metadata_trigger');
      await f.connection.query(
        'CREATE TABLE metadata_child(id BIGINT UNSIGNED, FOREIGN KEY(id) REFERENCES _turbine_migrations(id) ON DELETE CASCADE)',
      );
      await assert.rejects(migrateMysqlStatus(f.url, f.dir), /triggers or foreign keys/);
      await f.connection.query('DROP TABLE metadata_child');
      assert.equal((await migrateMysqlStatus(f.url, f.dir))[0]!.applied, true);
    }),
  );

  liveIt('refuses indirect stored-program effects before mutating rows or metadata', async () =>
    fixture(async (f) => {
      f.write(one, 'CREATE TABLE items(id INT)');
      assert.equal((await migrateMysqlUp(f.url, f.dir)).applied.length, 1);
      f.write(two, 'INSERT INTO items VALUES (2)');
      await f.connection.query(
        'CREATE TRIGGER indirect_metadata BEFORE INSERT ON items FOR EACH ROW DELETE FROM _turbine_migrations',
      );
      await assert.rejects(migrateMysqlUp(f.url, f.dir), /stored triggers or routines/);
      assert.deepEqual(await f.query('SELECT * FROM items'), []);
      assert.equal((await f.query('SELECT COUNT(*) AS n FROM _turbine_migrations'))[0]!.n, 1);
      assert.equal((await migrateMysqlStatus(f.url, f.dir)).filter((status) => status.applied).length, 1);
      await f.connection.query('DROP TRIGGER indirect_metadata');
      await f.connection.query(
        'CREATE FUNCTION indirect_function() RETURNS INT DETERMINISTIC RETURN RELEASE_ALL_LOCKS()',
      );
      await assert.rejects(migrateMysqlUp(f.url, f.dir), /stored triggers or routines/);
      assert.deepEqual(await f.query('SELECT * FROM items'), []);
      await f.connection.query('DROP FUNCTION indirect_function');
      assert.equal((await migrateMysqlUp(f.url, f.dir)).applied.length, 1);
      assert.deepEqual(await f.query('SELECT * FROM items'), [{ id: 2 }]);
    }),
  );

  liveIt('requires native UPDATE consent even for numeric predicates the PG scanner cannot classify', async () =>
    fixture(async (f) => {
      f.write(one, 'CREATE TABLE items(id INT, value INT); INSERT INTO items VALUES (1,0),(2,0)');
      await migrateMysqlUp(f.url, f.dir);
      f.write(two, 'UPDATE items SET value=7 WHERE 1--2');
      await assert.rejects(migrateMysqlUp(f.url, f.dir), /allowDestructive/);
      assert.deepEqual(await f.query('SELECT * FROM items ORDER BY id'), [
        { id: 1, value: 0 },
        { id: 2, value: 0 },
      ]);
      assert.equal((await migrateMysqlUp(f.url, f.dir, { allowDestructive: true })).applied.length, 1);
      assert.deepEqual(await f.query('SELECT * FROM items ORDER BY id'), [
        { id: 1, value: 7 },
        { id: 2, value: 7 },
      ]);
    }),
  );

  liveIt('owns the native advisory lock across implicit commits and closes it on failures', async () =>
    fixture(async (f) => {
      f.write(one, 'CREATE TABLE items(id INT)');
      const lockName = `turbine:${hash(f.database).slice(0, 56)}`;
      await f.connection.query('SELECT GET_LOCK(?,0)', [lockName]);
      await assert.rejects(migrateMysqlUp(f.url, f.dir), /migration lock/);
      assert.deepEqual(await f.query('SHOW TABLES'), []);
      let waits = 0;
      let release!: Promise<unknown>;
      const result = await migrateMysqlUp(f.url, f.dir, {
        lockWaitMs: 1000,
        onLockWait() {
          waits++;
          release = f.connection.query('SELECT RELEASE_LOCK(?)', [lockName]);
        },
      });
      await release;
      assert.equal(waits, 1);
      assert.equal(result.applied.length, 1);
      assert.equal((await f.query('SELECT IS_FREE_LOCK(?) AS free', [lockName]))[0]!.free, 1);
      f.write(two, 'INSERT INTO nonexistent VALUES (1)');
      assert.equal((await migrateMysqlUp(f.url, f.dir)).errors.length, 1);
      assert.equal((await f.query('SELECT IS_FREE_LOCK(?) AS free', [lockName]))[0]!.free, 1);
    }),
  );

  liveIt(
    'retains a dirty journal after process/connection loss and never automatically replays SQL',
    { timeout: 15_000 },
    async () =>
      fixture(async (f) => {
        f.write(one, 'CREATE TABLE crash_hold(value INT); INSERT INTO crash_hold(value) VALUES (SLEEP(30))');
        const runner = pathToFileURL(join(process.cwd(), 'src/cli/mysql-migrate.ts')).href;
        const script = `import {migrateMysqlUp} from ${JSON.stringify(runner)}; await migrateMysqlUp(process.env.MYSQL_MIGRATION_CHILD_URL, process.env.MYSQL_MIGRATION_CHILD_DIR);`;
        const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
          env: { ...process.env, MYSQL_MIGRATION_CHILD_URL: f.url, MYSQL_MIGRATION_CHILD_DIR: f.dir },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let errors = '';
        child.stderr.on('data', (chunk) => {
          errors += String(chunk);
        });
        const exited = new Promise<void>((resolve) => child.on('exit', () => resolve()));
        let nativeId: number | undefined;
        try {
          const deadline = Date.now() + 8000;
          while (Date.now() < deadline) {
            const [process] = await f.query(
              "SELECT ID FROM information_schema.PROCESSLIST WHERE DB=? AND INFO LIKE 'INSERT INTO crash_hold%'",
              [f.database],
            );
            if (process) {
              nativeId = Number(process.ID);
              break;
            }
            await new Promise((resolve) => setTimeout(resolve, 20));
          }
          assert.ok(nativeId, `native migration did not reach the observable blocked statement: ${errors}`);
          const lockName = `turbine:${hash(f.database).slice(0, 56)}`;
          assert.equal(
            Number((await f.query('SELECT IS_USED_LOCK(?) AS owner', [lockName]))[0]!.owner),
            nativeId,
            'one native connection owns both DDL/SQL and the lock',
          );
          child.kill('SIGKILL');
          await exited;
          await f.connection.query(`KILL CONNECTION ${nativeId}`);
          nativeId = undefined;
          // KILL returns before the server ends the thread and frees its lock.
          const released = Date.now() + 10_000;
          while ((await f.query('SELECT IS_USED_LOCK(?) AS owner', [lockName]))[0]!.owner !== null) {
            assert.ok(Date.now() < released, 'killed migration connection still holds the lock after 10 s');
            await new Promise((resolve) => setTimeout(resolve, 20));
          }
          const [status] = await migrateMysqlStatus(f.url, f.dir);
          assert.equal(status!.dirty!.completedStatements, 1);
          assert.equal(status!.dirty!.totalStatements, 2);
          const uncertainRows = await f.query('SELECT * FROM crash_hold');
          // Interrupting SLEEP may still commit an INSERT after its client
          // dies. The journal is a lower bound of confirmed responses only.
          assert.ok(uncertainRows.length <= 1);
          if (uncertainRows.length) assert.deepEqual(uncertainRows, [{ value: 1 }]);
          assert.deepEqual(await f.query('SELECT * FROM _turbine_migrations'), []);
          await assert.rejects(migrateMysqlUp(f.url, f.dir), /Automatic retry is refused/);
          unlinkSync(join(f.dir, `${one}.sql`));
          const [missing] = await migrateMysqlStatus(f.url, f.dir);
          assert.equal(missing!.missingFile, true);
          assert.equal(missing!.dirty!.name, one);
        } finally {
          child.kill('SIGKILL');
          await exited;
          if (nativeId) await f.connection.query(`KILL CONNECTION ${nativeId}`).catch(() => {});
        }
      }),
  );
});
