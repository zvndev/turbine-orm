import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { Connection, RowDataPacket } from 'mysql2/promise';
import { runReadOnlyTool } from '../cli/mcp.js';
import type { MysqlDoctorReport } from '../cli/mysql-doctor.js';
import * as toolModule from '../cli/mysql-tools.js';
import type { PgCompatPoolClient } from '../pg-types.js';
import { skipGate } from './helpers.js';

const endpoint = process.env.MYSQL_URL ?? '';
const native = skipGate(!endpoint, 'requires MYSQL_URL pointing at an owned disposable native MySQL 8 server');
const repo = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const peer = createRequire(import.meta.url)('mysql2/promise') as typeof import('mysql2/promise');
const quote = (value: string) => `\`${value.replaceAll('`', '``')}\``;
const secret = /literal-secret|default-secret|row-secret|predicate-secret|history-secret|checksum-secret/;
const check = (report: MysqlDoctorReport, code: string) => report.checks.find((value) => value.code === code)!;

async function fixture(
  body: (f: {
    admin: Connection;
    database: string;
    url: string;
    dir: string;
    accounts: string[];
    cli(args: string[], input?: unknown[]): Promise<{ code: number | null; out: string; err: string }>;
  }) => Promise<void>,
) {
  const parsed = new URL(endpoint);
  const admin = await peer.createConnection({
    host: parsed.hostname,
    port: Number(parsed.port || 3306),
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
  });
  const database = `doctor_${randomBytes(6).toString('hex')}`;
  const dir = mkdtempSync(join(tmpdir(), 'turbine-mysql-doctor-'));
  const accounts: string[] = [];
  let error: unknown;
  try {
    await admin.query(`CREATE DATABASE ${quote(database)}`);
    await admin.query(`USE ${quote(database)}`);
    await admin.query(
      "CREATE TABLE parents(a INT, b INT, label VARCHAR(100) DEFAULT 'default-secret', PRIMARY KEY(a,b)) ENGINE=InnoDB",
    );
    await admin.query(
      'CREATE TABLE children(id INT PRIMARY KEY, a INT, b INT, CONSTRAINT child_fk FOREIGN KEY(a,b) REFERENCES parents(a,b), CONSTRAINT positive_id CHECK(id > 0)) ENGINE=InnoDB',
    );
    await admin.query("CREATE INDEX opaque_idx ON parents(label(5), (CONCAT(label,'literal-secret'))) INVISIBLE");
    await admin.query('CREATE TABLE nontransactional(id INT) ENGINE=MyISAM');
    await admin.query('CREATE TABLE _turbine_migrations(id INT PRIMARY KEY, name TEXT, checksum TEXT) ENGINE=InnoDB');
    await admin.query('CREATE TABLE _turbine_migration_state(id INT PRIMARY KEY, name TEXT) ENGINE=InnoDB');
    await admin.query("INSERT INTO _turbine_migrations VALUES(1,'history-secret','checksum-secret')");
    await admin.query("INSERT INTO parents VALUES(1,2,'row-secret')");
    await admin.query('INSERT INTO children VALUES(1,1,2)');
    parsed.pathname = `/${database}`;
    const url = parsed.toString();
    writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
    writeFileSync(join(dir, 'turbine.config.mjs'), `export default {engine:'mysql',url:${JSON.stringify(url)}};`);
    const guard = join(dir, 'no-pg.cjs');
    writeFileSync(
      guard,
      `const pg=require(${JSON.stringify(join(repo, 'node_modules/pg'))});pg.Pool=class {constructor(){throw Error('PG DISPATCH FORBIDDEN')}};`,
    );
    await body({
      admin,
      database,
      url,
      dir,
      accounts,
      async cli(args, input) {
        const child = spawn(
          process.execPath,
          [
            '--require',
            guard,
            '--import',
            join(repo, 'node_modules/tsx/dist/loader.mjs'),
            join(repo, 'src/cli/index.ts'),
            ...args,
          ],
          {
            cwd: dir,
            env: { ...process.env, DATABASE_URL: '', NO_COLOR: '1' },
            stdio: ['pipe', 'pipe', 'pipe'],
            timeout: 30000,
          },
        );
        let out = '';
        let err = '';
        child.stdout.on('data', (part) => {
          out += part;
        });
        child.stderr.on('data', (part) => {
          err += part;
        });
        if (input) {
          let seen = false;
          child.stdout.on('data', () => {
            if (!seen && out.includes('"id":2')) {
              seen = true;
              child.stdin.end();
            }
          });
          for (const request of input) child.stdin.write(`${JSON.stringify(request)}\n`);
        } else child.stdin.end();
        const [code, signal] = await once(child, 'close');
        assert.ok(signal === null, `unexpected child signal ${signal}: ${err}`);
        return { code, out, err };
      },
    });
  } catch (caught) {
    error = caught;
  }
  const cleanupErrors: unknown[] = [];
  for (const account of accounts) {
    try {
      await admin.query(`DROP USER IF EXISTS '${account}'@'%'`);
    } catch (caught) {
      cleanupErrors.push(caught);
    }
  }
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${quote(database)}`);
    const [rows] = await admin.query<RowDataPacket[]>(
      'SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?',
      [database],
    );
    assert.equal(rows.length, 0);
  } catch (caught) {
    cleanupErrors.push(caught);
  }
  try {
    await admin.end();
  } catch (caught) {
    cleanupErrors.push(caught);
    admin.destroy();
  }
  rmSync(dir, { recursive: true, force: true });
  if (error || cleanupErrors.length)
    throw new Error(
      `Native MySQL doctor assertion or cleanup failed: ${[error, ...cleanupErrors]
        .filter(Boolean)
        .map((failure) => (failure instanceof Error ? failure.stack : 'non-Error failure'))
        .join('\n')}`,
      { cause: [...(error ? [error] : []), ...cleanupErrors] },
    );
}

describe('native scoped MySQL doctor', () => {
  native.it(
    'reports actual modes, composite FKs, opaque key scope, nontransactional tables and migration facts',
    async () =>
      fixture(async (f) => {
        const report = (await runReadOnlyTool(
          { engine: 'mysql', url: f.url, schema: f.database, migrationsDir: f.dir },
          'doctor_report',
        )) as MysqlDoctorReport;
        assert.equal(report.engine, 'mysql');
        assert.equal(report.formatVersion, 1);
        assert.equal(report.ok, false);
        assert.equal(check(report, 'MYSQL_ENGINES').status, 'warn');
        assert.equal(check(report, 'MYSQL_MIGRATIONS').facts.appliedCount, 1);
        const [mode] = await f.admin.query<RowDataPacket[]>('SELECT @@session.sql_mode AS mode');
        assert.deepEqual(
          check(report, 'MYSQL_RUNTIME').facts.sqlModes,
          String(mode[0]!.mode).split(',').filter(Boolean).sort(),
        );
        const facts = check(report, 'MYSQL_INDEXES').facts as {
          foreignKeys: { columns: string[]; targetColumns: string[]; targetCoverage: string }[];
          indexes: { keys: { prefixLength: number | null; expressionWithheld: boolean }[]; partial: boolean }[];
        };
        assert.deepEqual(facts.foreignKeys[0]!.columns, ['a', 'b']);
        assert.deepEqual(facts.foreignKeys[0]!.targetColumns, ['a', 'b']);
        assert.equal(facts.foreignKeys[0]!.targetCoverage, 'observed-primary-leading-columns');
        const opaque = facts.indexes.find((index) => index.keys.some((key) => key.expressionWithheld))!;
        assert.ok(opaque);
        assert.equal(opaque.partial, false);
        assert.equal(opaque.keys[0]!.prefixLength, 5);
        assert.doesNotMatch(JSON.stringify(report), secret);
        const filtered = (await runReadOnlyTool(
          { engine: 'mysql', url: f.url, schema: f.database, include: ['parents', 'children'], migrationsDir: f.dir },
          'doctor_report',
        )) as MysqlDoctorReport;
        assert.equal(filtered.ok, true);
        assert.equal(check(filtered, 'MYSQL_SCOPE').facts.filtersApplied, true);
        await f.admin.query("INSERT INTO _turbine_migration_state VALUES(1,'history-secret')");
        const dirty = (await runReadOnlyTool(
          { engine: 'mysql', url: f.url, schema: f.database, migrationsDir: f.dir },
          'doctor_report',
        )) as MysqlDoctorReport;
        assert.equal(check(dirty, 'MYSQL_MIGRATIONS').status, 'fail');
        assert.equal(check(dirty, 'MYSQL_MIGRATIONS').facts.dirtyCount, 1);
        assert.doesNotMatch(JSON.stringify(dirty), secret);
      }),
  );
  native.it(
    'refuses table grants, active roles and partial revokes, and accepts direct complete database grants',
    async () =>
      fixture(async (f) => {
        const suffix = randomBytes(4).toString('hex');
        const names = ['limited', 'complete', 'role_reader', 'role_user', 'partial'].map((name) => `${name}_${suffix}`);
        for (const name of names) {
          await f.admin.query(`CREATE USER '${name}'@'%'`);
          f.accounts.push(name);
        }
        await f.admin.query(`GRANT SELECT ON ${quote(f.database)}.parents TO '${names[0]}'@'%'`);
        await f.admin.query(`GRANT SELECT, SHOW VIEW, TRIGGER ON ${quote(f.database)}.* TO '${names[1]}'@'%'`);
        await f.admin.query(`GRANT SELECT, SHOW VIEW, TRIGGER ON ${quote(f.database)}.* TO '${names[2]}'@'%'`);
        await f.admin.query(`GRANT '${names[2]}'@'%' TO '${names[3]}'@'%'`);
        await f.admin.query(`SET DEFAULT ROLE ALL TO '${names[3]}'@'%'`);
        // partial_revokes is global. Serialize with the seed suite's partial-revoke
        // fixture on the same server, enable it for this case, and restore it
        // after dropping the partially revoked account (MySQL refuses to turn it
        // off while one exists).
        const [lock] = await f.admin.query<RowDataPacket[]>(
          "SELECT GET_LOCK('turbine_seed_partial_revokes_fixture', 60) AS acquired",
        );
        assert.equal(Number(lock[0]!.acquired), 1);
        const [partial] = await f.admin.query<RowDataPacket[]>('SELECT @@global.partial_revokes AS enabled');
        const wasEnabled = Number(partial[0]!.enabled) === 1;
        try {
          await f.admin.query('SET GLOBAL partial_revokes=ON');
          await f.admin.query(`GRANT SELECT, SHOW VIEW, TRIGGER ON *.* TO '${names[4]}'@'%'`);
          await f.admin.query(`REVOKE SELECT ON ${quote(f.database)}.* FROM '${names[4]}'@'%'`);
          for (const [i, name] of names.entries()) {
            if (i === 2) continue;
            const url = new URL(f.url);
            url.username = name;
            url.password = '';
            const report = (await runReadOnlyTool(
              { engine: 'mysql', url: url.href, schema: f.database, migrationsDir: f.dir },
              'doctor_report',
            )) as MysqlDoctorReport;
            assert.equal(check(report, 'MYSQL_VISIBILITY').status, i === 1 ? 'pass' : 'unknown');
            if (i !== 1) {
              assert.equal(report.ok, false);
              assert.equal(check(report, 'MYSQL_SCOPE').facts.reason, 'not-assessed');
            }
            assert.doesNotMatch(JSON.stringify(report), new RegExp(names.join('|')));
          }
        } finally {
          await f.admin.query(`DROP USER IF EXISTS '${names[4]}'@'%'`);
          if (!wasEnabled) await f.admin.query('SET GLOBAL partial_revokes=OFF');
          await f.admin.query("SELECT RELEASE_LOCK('turbine_seed_partial_revokes_fixture')");
        }
      }),
  );
  native.it(
    'reuses an existing read-only snapshot without releasing it or altering pooled caller sessions',
    async (t) =>
      fixture(async (f) => {
        const original = peer.createConnection;
        const opened: Connection[] = [];
        t.mock.method(peer, 'createConnection', async (options: Parameters<typeof original>[0]) => {
          const connection = await original(options);
          opened.push(connection);
          return connection;
        });
        const pool = toolModule.createMysqlToolPool(f.url, f.database);
        const client = await pool.connect();
        const raw = opened[0]!;
        const collect = (
          toolModule as unknown as { mysqlToolDoctorReport: (client: PgCompatPoolClient) => Promise<MysqlDoctorReport> }
        ).mysqlToolDoctorReport;
        assert.equal(typeof collect, 'function', 'the native doctor integration bridge must be registered');
        try {
          const report = await collect(client);
          assert.equal(report.formatVersion, 1);
          await assert.rejects(
            raw.query('UPDATE parents SET a = 4'),
            (error: unknown) => (error as { code: string }).code === 'ER_CANT_EXECUTE_IN_READ_ONLY_TRANSACTION',
          );
          await f.admin.query("INSERT INTO _turbine_migrations VALUES(2,'history-secret','checksum-secret')");
          assert.equal(
            check(await collect(client), 'MYSQL_MIGRATIONS').facts.appliedCount,
            1,
            'existing snapshot remains stable',
          );
          assert.equal(
            (await raw.query<RowDataPacket[]>('SELECT COUNT(*) AS n FROM parents'))[0][0]!.n,
            1,
            'collector left caller snapshot usable',
          );
          await assert.rejects(client.query('SELECT 1'), /arbitrary SQL/);
        } finally {
          client.release();
          await pool.end();
        }
        const caller = peer.createPool({
          host: new URL(f.url).hostname,
          port: Number(new URL(f.url).port),
          user: decodeURIComponent(new URL(f.url).username),
          password: decodeURIComponent(new URL(f.url).password),
          connectionLimit: 1,
          database: f.database,
        });
        try {
          const [before] = await caller.query<RowDataPacket[]>(
            'SELECT @@session.sql_mode AS mode, @@session.transaction_read_only AS ro',
          );
          await runReadOnlyTool(
            { engine: 'mysql', url: f.url, schema: f.database, migrationsDir: f.dir },
            'doctor_report',
          );
          const [after] = await caller.query<RowDataPacket[]>(
            'SELECT @@session.sql_mode AS mode, @@session.transaction_read_only AS ro',
          );
          assert.deepEqual(after, before);
        } finally {
          await caller.end();
        }
        const [sessions] = await f.admin.query<RowDataPacket[]>(
          'SELECT ID FROM information_schema.PROCESSLIST WHERE DB = ? AND ID <> CONNECTION_ID()',
          [f.database],
        );
        assert.equal(sessions.length, 0);
      }),
  );
  native.it('retains a failed collection report after the owned native session is killed', async (t) =>
    fixture(async (f) => {
      const original = peer.createConnection;
      let killed = false;
      t.mock.method(peer, 'createConnection', async (options: Parameters<typeof original>[0]) => {
        const connection = await original(options);
        const query = connection.query.bind(connection);
        const execute = connection.execute.bind(connection);
        connection.execute = (async (sql: string, values?: Parameters<Connection['execute']>[1]) => {
          const result = await execute(sql, values);
          if (!killed && sql.startsWith('SELECT TABLE_NAME FROM information_schema.TABLES')) {
            killed = true;
            const [identity] = await query<RowDataPacket[]>('SELECT CONNECTION_ID() AS id');
            await f.admin.query('KILL CONNECTION ?', [Number(identity[0]!.id)]);
          }
          return result;
        }) as typeof connection.execute;
        return connection;
      });
      const report = (await runReadOnlyTool(
        { engine: 'mysql', url: f.url, schema: f.database, migrationsDir: f.dir },
        'doctor_report',
      )) as MysqlDoctorReport;
      assert.equal(killed, true);
      assert.equal(report.ok, false);
      assert.equal(check(report, 'MYSQL_RUNTIME').status, 'pass');
      assert.equal(check(report, 'MYSQL_VISIBILITY').status, 'pass');
      assert.equal(check(report, 'MYSQL_SCOPE').status, 'fail');
      assert.doesNotMatch(JSON.stringify(report), secret);
      const [sessions] = await f.admin.query<RowDataPacket[]>(
        'SELECT ID FROM information_schema.PROCESSLIST WHERE DB = ? AND ID <> CONNECTION_ID()',
        [f.database],
      );
      assert.equal(sessions.length, 0);
    }),
  );
  native.it(
    'executes actual staged doctor text/JSON and MCP processes without PostgreSQL checkout or fixture writes',
    async () =>
      fixture(async (f) => {
        const before = readdirSync(f.dir).sort();
        const json = await f.cli(['doctor', '--json']);
        assert.equal(json.code, 0, json.err);
        const report = JSON.parse(json.out) as MysqlDoctorReport;
        assert.equal(report.engine, 'mysql');
        const text = await f.cli(['doctor']);
        assert.equal(text.code, 0, text.err);
        assert.match(text.out, /MYSQL_VISIBILITY: pass/);
        assert.doesNotMatch(text.out + json.out, secret);
        for (const flags of [
          ['--fix'],
          ['--unused'],
          ['--audit'],
          ['--metrics-url', 'forbidden'],
          ['--no-plan-divergence'],
          ['--url', '--fix'],
        ]) {
          const refused = await f.cli(['doctor', ...flags]);
          assert.equal(refused.code, 1);
          assert.match(refused.out + refused.err, /MySQL|Unsupported/);
        }
        const rpc = await f.cli(
          ['mcp'],
          [
            { jsonrpc: '2.0', id: 1, method: 'tools/list' },
            { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'doctor_report', arguments: {} } },
          ],
        );
        const frames = rpc.out
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line));
        const answer = frames.find((frame) => frame.id === 2);
        assert.ok(answer?.result, rpc.out + rpc.err);
        assert.equal(JSON.parse(answer.result.content[0].text).engine, 'mysql');
        assert.ok(
          frames
            .find((frame) => frame.id === 1)
            .result.tools.some((tool: { name: string }) => tool.name === 'doctor_report'),
        );
        assert.deepEqual(readdirSync(f.dir).sort(), before);
        const [sessions] = await f.admin.query<RowDataPacket[]>(
          'SELECT ID FROM information_schema.PROCESSLIST WHERE DB = ? AND ID <> CONNECTION_ID()',
          [f.database],
        );
        assert.equal(sessions.length, 0);
      }),
  );
});
