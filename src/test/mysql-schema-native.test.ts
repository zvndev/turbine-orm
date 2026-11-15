import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe } from 'node:test';
import { fileURLToPath } from 'node:url';
import { type Connection, createConnection } from 'mysql2/promise';
import { parseMigrationContent } from '../cli/migrate.js';
import { createMysqlSchemaMigration, inspectMysqlSchema, planMysqlSchema } from '../cli/mysql-schema.js';
import { defineSchema, type SchemaDef } from '../schema-builder.js';
import { skipGate } from './helpers.js';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const nativeUrl = process.env.MYSQL_URL ?? process.env.MYSQL_TEST_URL ?? '';
const native = skipGate(!nativeUrl, 'requires MYSQL_URL / MYSQL_TEST_URL pointing at a disposable MySQL 8 server');
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const users = () =>
  defineSchema({
    users: {
      id: { type: 'serial', primaryKey: true },
      email: { type: 'varchar', maxLength: 100, notNull: true, unique: true },
    },
  });

async function fixture(
  body: (f: {
    connection: Connection;
    url: string;
    database: string;
    dir: string;
    migrations: string;
    query: (sql: string, values?: (string | number | null)[]) => Promise<Record<string, unknown>[]>;
    schema: (schema: SchemaDef) => void;
    cli: (args: string[]) => Promise<{ code: number | null; output: string }>;
  }) => Promise<void>,
) {
  const endpoint = new URL(nativeUrl);
  const connection = await createConnection({
    host: endpoint.hostname,
    port: Number(endpoint.port || 3306),
    user: decodeURIComponent(endpoint.username),
    password: decodeURIComponent(endpoint.password),
  });
  const database = `turbine_schema_${randomBytes(8).toString('hex')}`;
  const dir = mkdtempSync(join(tmpdir(), 'turbine-mysql-schema-'));
  // Exercise the integrated parser, configuration, schema loader and dispatch.
  const cli = join(repo, 'src/cli/index.ts');
  writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
  const migrations = join(dir, 'turbine/migrations');
  const query = async (sql: string, values?: (string | number | null)[]) =>
    (values ? (await connection.execute(sql, values))[0] : (await connection.query(sql))[0]) as Record<
      string,
      unknown
    >[];
  try {
    await connection.query(`CREATE DATABASE \`${database}\``);
    await connection.query(`USE \`${database}\``);
    endpoint.pathname = `/${database}`;
    writeFileSync(
      join(dir, 'turbine.config.mjs'),
      `export default {engine:'mysql',url:${JSON.stringify(endpoint.href)},schemaFile:'./schema.mjs'};`,
    );
    const guard = join(dir, 'no-pg.cjs');
    // Resolve pg from this worktree, even though the fixture lives in /tmp.
    writeFileSync(
      guard,
      `const pg=require(${JSON.stringify(join(repo, 'node_modules/pg'))}); pg.Pool=class {constructor(){throw Error('PG DISPATCH FORBIDDEN')}};`,
    );
    await body({
      connection,
      url: endpoint.href,
      database,
      dir,
      migrations,
      query,
      schema: (schema) => writeFileSync(join(dir, 'schema.mjs'), `export default ${JSON.stringify(schema)};`),
      cli: async (args) => {
        const child = spawn(
          process.execPath,
          ['--require', guard, '--import', join(repo, 'node_modules/tsx/dist/loader.mjs'), cli, ...args],
          {
            cwd: dir,
            env: { ...process.env, DATABASE_URL: '', NO_COLOR: '1' },
            stdio: ['ignore', 'pipe', 'pipe'],
            timeout: 25_000,
          },
        );
        let output = '';
        child.stdout.on('data', (c) => {
          output += c;
        });
        child.stderr.on('data', (c) => {
          output += c;
        });
        const [code, signal] = await once(child, 'close');
        assert.equal(signal, null, output);
        return { code, output };
      },
    });
  } finally {
    try {
      await connection.query(`DROP DATABASE IF EXISTS \`${database}\``);
    } finally {
      await connection.end();
      rmSync(dir, { recursive: true, force: true });
    }
  }
}
function ok(result: { code: number | null; output: string }, code = 0, pattern?: RegExp) {
  assert.ok(result.output.trim().length > 0, 'CLI must execute and print a result');
  assert.equal(result.code, code, result.output);
  if (pattern) assert.match(result.output, pattern);
}
const files = (dir: string) => (existsSync(dir) ? readdirSync(dir) : []);

async function baseline(f: Parameters<Parameters<typeof fixture>[0]>[0]) {
  await f.query(
    'CREATE TABLE users (id INT NOT NULL AUTO_INCREMENT PRIMARY KEY, email VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL UNIQUE) ENGINE=InnoDB',
  );
  await f.query("INSERT INTO users(email) VALUES ('kept@example.test')");
}

describe('MySQL schema diff native workflow', () => {
  native.it('refuses lossy Unicode defaults without false no-ops or new migration files', async () =>
    fixture(async (f) => {
      const desired = (value: string) =>
        defineSchema({
          users: {
            id: { type: 'serial', primaryKey: true },
            label: { type: 'varchar', maxLength: 40, default: `'${value}'` },
          },
        });
      f.schema(desired('😀'));
      ok(await f.cli(['migrate', 'create', 'unicode', '--from-diff']), 1, /ambiguous VARCHAR default/);
      assert.equal(existsSync(f.migrations), false);
      await f.query(
        "CREATE TABLE users(id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,label VARCHAR(40) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin DEFAULT '😀') ENGINE=InnoDB",
      );
      await f.query('INSERT INTO users() VALUES()');
      assert.deepEqual(await f.query('SELECT HEX(label) AS value FROM users'), [{ value: 'F09F9880' }]);
      for (const value of ['😀', '?', 'plain']) {
        f.schema(desired(value));
        ok(await f.cli(['diff', '--exit-code']), 1, /ambiguous.*default/);
        ok(await f.cli(['migrate', 'create', 'changed', '--from-diff']), 1, /ambiguous.*default/);
        assert.equal(existsSync(f.migrations), false);
      }
      await f.query('DROP TABLE users');
      f.schema(desired('é漢'));
      ok(await f.cli(['migrate', 'create', 'bmp', '--from-diff']));
      ok(await f.cli(['migrate', 'up']));
      ok(await f.cli(['diff', '--exit-code']), 0, /No supported schema changes/);
    }),
  );
  native.it('accepts complete scoped and default-role grants with native identifier quoting', async () =>
    fixture(async (f) => {
      const suffix = randomBytes(6).toString('hex');
      const users = [`scope_${suffix}`, `role_${suffix}`];
      const role = `visibility_${suffix}`;
      const database = `${f.database}_\`"quoted`;
      const q = (s: string) => `\`${s.replaceAll('`', '``')}\``;
      try {
        await f.query(`CREATE DATABASE ${q(database)}`);
        for (const user of users) await f.query(`CREATE USER '${user}'@'%'`);
        await f.query(`GRANT SELECT, SHOW VIEW, TRIGGER ON ${q(database)}.* TO '${users[0]}'@'%'`);
        await f.query(`CREATE ROLE '${role}'`);
        await f.query(`GRANT SELECT, SHOW VIEW, TRIGGER ON ${q(database)}.* TO '${role}'`);
        await f.query(`GRANT '${role}' TO '${users[1]}'@'%'`);
        await f.query(`ALTER USER '${users[1]}'@'%' DEFAULT ROLE '${role}'`);
        f.schema(defineSchema({}));
        for (const user of users) {
          const url = new URL(f.url);
          url.pathname = `/${database}`;
          url.username = user;
          url.password = '';
          writeFileSync(
            join(f.dir, 'turbine.config.mjs'),
            `export default {engine:'mysql',url:${JSON.stringify(url.href)},schemaFile:'./schema.mjs'};`,
          );
          assert.deepEqual(Object.keys((await inspectMysqlSchema(url.href)).metadata.tables), []);
          ok(await f.cli(['diff', '--exit-code']), 0, /No supported schema changes/);
          ok(await f.cli(['migrate', 'create', 'noop', '--from-diff']), 0, /No supported schema changes/);
          assert.equal(existsSync(f.migrations), false);
        }
      } finally {
        for (const user of users) await f.query(`DROP USER IF EXISTS '${user}'@'%'`);
        await f.query(`DROP ROLE IF EXISTS '${role}'`);
        await f.query(`DROP DATABASE IF EXISTS ${q(database)}`);
      }
    }),
  );
  native.it(
    'fresh schema: read-only diff, reviewed migration, actual CLI up/status/no-op/down and native FK effects',
    async () =>
      fixture(async (f) => {
        const schema = defineSchema({
          parents: {
            id: { type: 'bigserial', primaryKey: true },
            name: { type: 'varchar', maxLength: 40, default: "'O''Brien'" },
          },
          children: {
            id: { type: 'serial', primaryKey: true },
            parentId: { type: 'bigint', references: { target: 'parents.id', onDelete: 'cascade' } },
            enabled: { type: 'boolean', notNull: true, default: true },
            payload: { type: 'json' },
            note: { type: 'text' },
            day: { type: 'date' },
          },
        });
        f.schema(schema);
        ok(await f.cli(['diff', '--exit-code']), 2, /CREATE TABLE `parents`/);
        assert.deepEqual(await f.query('SHOW TABLES'), []);
        assert.equal(existsSync(f.migrations), false);
        ok(await f.cli(['migrate', 'create', 'initial', '--from-diff']), 0, /Created/);
        assert.deepEqual(await f.query('SHOW TABLES'), []);
        const file = files(f.migrations)[0]!;
        assert.match(file, /^\d{14}_initial.sql$/);
        const content = readFileSync(join(f.migrations, file), 'utf8');
        const sections = parseMigrationContent(content);
        assert.match(sections.up, /FOREIGN KEY/);
        assert.match(sections.down, /^ALTER TABLE/);
        assert.match(content, /DOWN can delete data/);
        assert.match(content, /implicitly commits/);
        ok(await f.cli(['migrate', 'up']), 1, /destructive/i);
        assert.deepEqual(
          (await f.query('SHOW TABLES')).filter((r) =>
            Object.values(r).some((v) => ['parents', 'children'].includes(String(v))),
          ),
          [],
        );
        ok(await f.cli(['migrate', 'up', '--allow-destructive']), 0, /1 migration/);
        await f.query('INSERT INTO parents () VALUES ()');
        await f.query('INSERT INTO children(parent_id,payload,day) VALUES (1,?,?)', ['{"ok":true}', '2026-01-02']);
        assert.deepEqual(await f.query('SELECT id,name FROM parents'), [{ id: 1, name: "O'Brien" }]);
        const rows = await f.query(
          "SELECT id,parent_id,enabled,CAST(JSON_EXTRACT(payload,'$.ok') AS CHAR) AS json_ok,CAST(day AS CHAR) AS day FROM children",
        );
        assert.equal(rows.length, 1);
        assert.equal(rows[0]!.enabled, 1);
        assert.equal(rows[0]!.day, '2026-01-02');
        await assert.rejects(f.query('INSERT INTO children(parent_id) VALUES (999)'), /foreign key/i);
        const history = await f.query('SELECT name,checksum FROM _turbine_migrations');
        assert.deepEqual(history, [{ name: file.slice(0, -4), checksum: sha(content) }]);
        assert.deepEqual(await f.query('SELECT * FROM _turbine_migration_state'), []);
        ok(await f.cli(['migrate', 'status', '--exit-code']), 0, /Applied/);
        ok(await f.cli(['diff', '--exit-code']), 0, /No supported schema changes/);
        ok(await f.cli(['migrate', 'create', 'noop', '--from-diff']), 0, /no migration file created/);
        assert.deepEqual(files(f.migrations), [file]);
        ok(await f.cli(['migrate', 'down']), 1, /destructive/i);
        assert.equal((await f.query('SELECT COUNT(*) AS n FROM children'))[0]!.n, 1);
        ok(await f.cli(['migrate', 'down', '--allow-destructive']), 0, /DOWN completed/);
        assert.deepEqual(await f.query('SELECT * FROM _turbine_migrations'), []);
        assert.deepEqual(
          await f.query(
            'SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME IN (?,?)',
            [f.database, 'parents', 'children'],
          ),
          [],
        );
      }),
  );
  native.it(
    'existing rows: defaulted and nullable additions, native keys, no-op scaffold and exact DOWN restoration',
    async () =>
      fixture(async (f) => {
        await baseline(f);
        const before = await f.query('SHOW CREATE TABLE users');
        const schema = users();
        Object.assign(
          schema.tables.users!.columns,
          defineSchema({
            x: {
              label: { type: 'varchar', maxLength: 30 },
              active: { type: 'boolean', notNull: true, default: false },
            },
          }).tables.x!.columns,
        );
        schema.tables.users!.indexes = [{ name: 'users_label', columns: ['label'] }];
        f.schema(schema);
        const snapshot = await inspectMysqlSchema(f.url);
        assert.equal(snapshot.metadata.tables.users!.columns.length, 2);
        ok(await f.cli(['diff', '--exit-code']), 2, /ADD COLUMN/);
        assert.equal(existsSync(f.migrations), false);
        assert.deepEqual(await f.query('SHOW CREATE TABLE users'), before);
        ok(await f.cli(['migrate', 'create', 'extend', '--from-diff']), 0, /Created/);
        ok(await f.cli(['migrate', 'up']), 1, /destructive/i);
        assert.deepEqual(await f.query('SHOW CREATE TABLE users'), before);
        ok(await f.cli(['migrate', 'up', '--allow-destructive']), 0);
        assert.deepEqual(await f.query('SELECT id,email,label,active FROM users'), [
          { id: 1, email: 'kept@example.test', label: null, active: 0 },
        ]);
        assert.equal(
          (
            await f.query(
              'SELECT INDEX_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? AND INDEX_NAME = ?',
              [f.database, 'users_label'],
            )
          ).length,
          1,
        );
        ok(await f.cli(['migrate', 'create', 'noop', '--from-diff']), 0, /no migration file created/);
        assert.equal(files(f.migrations).length, 1);
        ok(await f.cli(['migrate', 'down', '--allow-destructive']), 0);
        assert.deepEqual(await f.query('SHOW CREATE TABLE users'), before);
        assert.deepEqual(await f.query('SELECT * FROM users'), [{ id: 1, email: 'kept@example.test' }]);
        assert.deepEqual(await f.query('SELECT * FROM _turbine_migrations'), []);
      }),
  );
  native.it(
    'no-op and unsupported native definitions create no directories/files and leave exact rows/catalog/history intact',
    async () =>
      fixture(async (f) => {
        await baseline(f);
        f.schema(users());
        const initial = await f.query('SHOW CREATE TABLE users');
        const noop = await createMysqlSchemaMigration(f.url, f.migrations, 'noop', users());
        assert.equal(noop.file, undefined);
        assert.equal(existsSync(f.migrations), false);
        assert.deepEqual(await f.query('SHOW CREATE TABLE users'), initial);
        const cases = [
          ['CREATE INDEX prefix_email ON users(email(10))', 'DROP INDEX prefix_email ON users'],
          [
            'ALTER TABLE users ADD COLUMN computed INT AS (length(email)) VIRTUAL',
            'ALTER TABLE users DROP COLUMN computed',
          ],
          [
            'ALTER TABLE users ADD CONSTRAINT positive CHECK (length(email) > 0)',
            'ALTER TABLE users DROP CHECK positive',
          ],
          [
            'CREATE TRIGGER users_guard BEFORE INSERT ON users FOR EACH ROW SET NEW.email = NEW.email',
            'DROP TRIGGER users_guard',
          ],
          [
            'ALTER TABLE users MODIFY email VARCHAR(100) COLLATE utf8mb4_0900_ai_ci NOT NULL',
            'ALTER TABLE users MODIFY email VARCHAR(100) COLLATE utf8mb4_0900_bin NOT NULL',
          ],
          ['CREATE TABLE omitted (id INT)', 'DROP TABLE omitted'],
        ];
        for (const [up, down] of cases) {
          await f.query(up!);
          const before = await f.query('SHOW CREATE TABLE users');
          await assert.rejects(
            createMysqlSchemaMigration(f.url, f.migrations, 'refused', users()),
            /comparison refused/,
          );
          assert.equal(existsSync(f.migrations), false);
          assert.deepEqual(await f.query('SHOW CREATE TABLE users'), before);
          assert.deepEqual(await f.query('SELECT id,email FROM users'), [{ id: 1, email: 'kept@example.test' }]);
          assert.deepEqual(
            await f.query(
              'SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME LIKE ?',
              [f.database, '_turbine%'],
            ),
            [],
          );
          await f.query(down!);
        }
        assert.equal(planMysqlSchema(users(), await inspectMysqlSchema(f.url)).steps.length, 0);
      }),
  );
  native.it('unmodeled desired declarations refuse without importing SQL history or creating files', async () =>
    fixture(async (f) => {
      f.schema(defineSchema({ users: { id: { type: 'uuid', primaryKey: true } } }));
      ok(await f.cli(['diff']), 1, /unsupported type/);
      ok(await f.cli(['migrate', 'create', 'unsupported', '--from-diff']), 1, /unsupported type/);
      assert.equal(existsSync(f.migrations), false);
      assert.deepEqual(await f.query('SHOW TABLES'), []);
    }),
  );
  native.it(
    'pending files, drift and partial DDL block scaffolding; exact recovery uses the existing native journal',
    async () =>
      fixture(async (f) => {
        const schema = defineSchema({
          aTable: { id: { type: 'serial', primaryKey: true } },
          zTable: { id: { type: 'serial', primaryKey: true } },
        });
        f.schema(schema);
        ok(await f.cli(['migrate', 'create', 'initial', '--from-diff']), 0);
        const file = files(f.migrations)[0]!,
          path = join(f.migrations, file),
          content = readFileSync(path, 'utf8');
        ok(await f.cli(['migrate', 'create', 'duplicate', '--from-diff']), 1, /pending/);
        assert.deepEqual(files(f.migrations), [file]);
        // A concurrent change AFTER planning invalidates the reviewed file. The
        // first CREATE autocommits; the second fails, which must remain visible.
        await f.query('CREATE TABLE z_table(id INT PRIMARY KEY)');
        await f.query('INSERT INTO z_table VALUES(42)');
        ok(await f.cli(['migrate', 'up']), 1, /already exists/);
        assert.equal((await f.query('SELECT COUNT(*) AS n FROM a_table'))[0]!.n, 0);
        assert.deepEqual(await f.query('SELECT * FROM z_table'), [{ id: 42 }]);
        assert.deepEqual(await f.query('SELECT * FROM _turbine_migrations'), []);
        const journal = await f.query(
          'SELECT name,checksum,direction,completed_statements,total_statements FROM _turbine_migration_state',
        );
        assert.deepEqual(journal, [
          {
            name: file.slice(0, -4),
            checksum: sha(content),
            direction: 'up',
            completed_statements: 1,
            total_statements: 2,
          },
        ]);
        ok(await f.cli(['migrate', 'status', '--exit-code']), 2, /Dirty/);
        ok(await f.cli(['migrate', 'create', 'blocked', '--from-diff']), 1, /dirty/);
        ok(await f.cli(['migrate', 'up']), 1, /partial-DDL/);
        assert.deepEqual(files(f.migrations), [file]);
        const recovery = ['migrate', 'recover', file.slice(0, -4)];
        ok(
          await f.cli([...recovery, '0'.repeat(64), 'rolled-back', '--acknowledge-partial-ddl']),
          1,
          /checksum|match/i,
        );
        assert.deepEqual(await f.query('SELECT * FROM z_table'), [{ id: 42 }]);
        await f.query('DROP TABLE a_table');
        await f.query('DROP TABLE z_table');
        ok(await f.cli([...recovery, sha(content), 'rolled-back', '--acknowledge-partial-ddl']), 0, /no migration SQL/);
        assert.deepEqual(await f.query('SELECT * FROM _turbine_migration_state'), []);
        ok(await f.cli(['migrate', 'up']), 0);
        writeFileSync(path, `${content}\n-- modified\n`);
        ok(await f.cli(['migrate', 'create', 'drifted', '--from-diff']), 1, /drifted/);
        writeFileSync(path, content);
        ok(await f.cli(['migrate', 'status', '--exit-code']), 0);
        ok(await f.cli(['migrate', 'down', '--allow-destructive']), 0);
      }),
  );
  native.it('refuses incomplete catalog visibility instead of mistaking hidden objects for an empty schema', async () =>
    fixture(async (f) => {
      await baseline(f);
      const user = `schema_${randomBytes(6).toString('hex')}`;
      try {
        await f.query(`CREATE USER '${user}'@'%'`);
        await f.query(`GRANT SELECT ON \`${f.database}\`.users TO '${user}'@'%'`);
        const url = new URL(f.url);
        url.username = user;
        url.password = '';
        await assert.rejects(inspectMysqlSchema(url.href), /visibility grants/);
        assert.deepEqual(await f.query('SELECT * FROM users'), [{ id: 1, email: 'kept@example.test' }]);
        assert.equal(existsSync(f.migrations), false);
      } finally {
        await f.query(`DROP USER IF EXISTS '${user}'@'%'`);
      }
    }),
  );
  native.it('adds a foreign key to existing rows through the native runner and refuses changed actions', async () =>
    fixture(async (f) => {
      await f.query('CREATE TABLE parents(id INT NOT NULL PRIMARY KEY) ENGINE=InnoDB');
      await f.query('CREATE TABLE children(id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,parent_id INT) ENGINE=InnoDB');
      await f.query('INSERT INTO parents VALUES(1)');
      await f.query('INSERT INTO children(parent_id) VALUES(1)');
      const schema = defineSchema({
        parents: { id: { type: 'integer', primaryKey: true } },
        children: {
          id: { type: 'serial', primaryKey: true },
          parentId: { type: 'integer', references: { target: 'parents.id', onDelete: 'cascade' } },
        },
      });
      f.schema(schema);
      const before = await f.query('SHOW CREATE TABLE children');
      const result = await createMysqlSchemaMigration(f.url, f.migrations, 'foreign_key', schema);
      assert.deepEqual(
        result.plan.steps.map((s) => s.kind),
        ['add-index', 'add-foreign-key'],
      );
      assert.ok(result.file);
      ok(await f.cli(['migrate', 'up']), 1, /destructive/);
      assert.deepEqual(await f.query('SHOW CREATE TABLE children'), before);
      ok(await f.cli(['migrate', 'up', '--allow-destructive']), 0);
      assert.equal(planMysqlSchema(schema, await inspectMysqlSchema(f.url)).steps.length, 0);
      await assert.rejects(f.query('UPDATE children SET parent_id=99 WHERE id=1'), /foreign key/i);
      const changed = structuredClone(schema);
      changed.tables.children!.columns.parentId!.onDelete = 'restrict';
      await assert.rejects(
        createMysqlSchemaMigration(f.url, f.migrations, 'changed_action', changed),
        /foreign key change/,
      );
      assert.equal(files(f.migrations).length, 1);
      ok(await f.cli(['migrate', 'down', '--allow-destructive']), 0);
      assert.deepEqual(await f.query('SHOW CREATE TABLE children'), before);
      assert.deepEqual(await f.query('SELECT * FROM children'), [{ id: 1, parent_id: 1 }]);
    }),
  );
  native.it(
    'executes quoted identifiers, literal defaults and composite primary keys without dialect rewrites',
    async () =>
      fixture(async (f) => {
        const schema = defineSchema({
          'order`log': {
            id: { type: 'serial', primaryKey: true },
            'value`text': { type: 'varchar', maxLength: 40, default: "'O''Brien'" },
            indexes: [{ name: 'key`quote', columns: ['value`text'] }],
          },
          memberships: { groupId: { type: 'integer' }, userId: { type: 'integer' }, primaryKey: ['groupId', 'userId'] },
        });
        f.schema(schema);
        ok(await f.cli(['migrate', 'create', 'quoted', '--from-diff']), 0);
        ok(await f.cli(['migrate', 'up']), 0);
        await f.query('INSERT INTO `order``log` () VALUES()');
        assert.deepEqual(await f.query('SELECT * FROM `order``log`'), [{ id: 1, 'value`text': "O'Brien" }]);
        await f.query('INSERT INTO memberships VALUES(1,2)');
        await assert.rejects(f.query('INSERT INTO memberships VALUES(1,2)'), /Duplicate/);
        assert.equal(planMysqlSchema(schema, await inspectMysqlSchema(f.url)).steps.length, 0);
        ok(await f.cli(['diff', '--exit-code']), 0, /No supported/);
        ok(await f.cli(['migrate', 'down', '--allow-destructive']), 0);
        assert.deepEqual(await f.query('SELECT * FROM _turbine_migrations'), []);
      }),
  );
});
