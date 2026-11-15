import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, it, type TestContext } from 'node:test';
import { resolveConfig } from '../cli/config.js';
import {
  assertSqliteDoctorArguments,
  cmdSqliteDoctor,
  collectSqliteDoctorReport,
  runSqliteDoctor,
  type SqliteDoctorReport,
} from '../cli/sqlite-doctor.js';
import { createSqliteToolPool, sqliteToolRuntime } from '../cli/sqlite-tools.js';
import type { PgCompatPoolClient } from '../pg-types.js';
import { SqlitePool } from '../sqlite.js';
import { skipGate } from './helpers.js';

const inheritedDatabaseUrl = process.env.DATABASE_URL;
beforeEach(() => {
  delete process.env.DATABASE_URL;
});
afterEach(() => {
  if (inheritedDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = inheritedDatabaseUrl;
});

const Database: typeof DatabaseSync | undefined = (() => {
  try {
    return createRequire(import.meta.url)('node:sqlite').DatabaseSync;
  } catch {
    return undefined;
  }
})();
const native = skipGate(!sqliteToolRuntime().available, 'SQLite doctor requires node:sqlite readOnly (Node >= 22.12)');

function fixture(t: TestContext, sql = '') {
  const dir = mkdtempSync(join(tmpdir(), 'turbine-sqlite-doctor-'));
  const path = join(dir, 'app.sqlite');
  t.after(() => {
    rmSync(dir, { force: true, recursive: true });
    assert.equal(existsSync(dir), false);
    // Removing a Unix file does not close its handle. Inspect the process's
    // actual descriptors independently after fixture removal as well.
    if (existsSync('/proc/self/fd')) {
      const paths = readdirSync('/proc/self/fd').flatMap((fd) => {
        try {
          return [readlinkSync(`/proc/self/fd/${fd}`)];
        } catch {
          return [];
        }
      });
      assert.ok(!paths.some((value) => value.startsWith(dir)), 'fixture descriptor survived cleanup');
    }
  });
  const db = new Database!(path);
  try {
    if (sql) db.exec(sql);
  } finally {
    db.close();
  }
  return { path, dir };
}

function fkChecks(report: SqliteDoctorReport, table: string) {
  const checks = report.checks.filter((check) => check.code === 'SQLITE_FK_CHILD_INDEX' && check.facts.table === table);
  assert.ok(checks.length > 0, `missing FK observations for ${table}`);
  return checks;
}

describe('SQLite doctor argument perimeter', () => {
  it('refuses every PostgreSQL option and positional request before inspecting a missing file', async () => {
    const config = resolveConfig({ engine: 'sqlite', url: '/missing-doctor-perimeter.sqlite' }, {});
    for (const [key, value] of Object.entries({
      fix: true,
      noConcurrently: true,
      unused: true,
      audit: true,
      minScans: 0,
      metricsUrl: 'unreachable',
      noPlanDivergence: true,
      allowPooler: true,
      sql: 'SELECT 1',
    })) {
      await assert.rejects(
        cmdSqliteDoctor({ command: 'doctor', positional: [], [key]: value }, config, []),
        /does not support option/,
      );
    }
    assert.throws(
      () => assertSqliteDoctorArguments({ command: 'doctor', positional: [], subcommand: 'SELECT' }),
      /option|positional/,
    );
    assert.throws(
      () => assertSqliteDoctorArguments({ command: 'doctor', positional: [] }, ['doctor', '--url', '--json']),
      /requires a value/,
    );
    assert.throws(
      () => assertSqliteDoctorArguments({ command: 'doctor', positional: [] }, ['doctor', '--fix']),
      /does not support argument/,
    );
    assert.equal(existsSync(config.url), false);
  });
});

describe('native scoped SQLite doctor', () => {
  native.it(
    'observes runtime, settings and a real empty database without changing bytes or creating files',
    async (t) => {
      const f = fixture(t);
      const before = readFileSync(f.path);
      const first = await runSqliteDoctor({ url: f.path });
      const second = await runSqliteDoctor({ url: f.path });
      assert.deepEqual(second, first, 'the same catalog produces a deterministic report');
      assert.equal(first.formatVersion, 1);
      assert.equal(first.engine, 'sqlite');
      assert.equal(first.ok, true);
      assert.equal(first.checks.find((check) => check.code === 'SQLITE_RUNTIME')!.facts.node, process.versions.node);
      assert.match(String(first.checks[0]!.facts.databaseVersion), /^3\./);
      assert.equal(first.checks.find((check) => check.code === 'SQLITE_JOURNAL_MODE')!.facts.value, 'delete');
      assert.equal(first.checks.find((check) => check.code === 'SQLITE_FOREIGN_KEYS')!.facts.value, 1);
      assert.equal(first.checks.find((check) => check.code === 'SQLITE_CATALOG')!.facts.tablesObserved, 0);
      assert.equal(first.checks.at(-1)!.facts.visibility, 'absent');
      assert.deepEqual(readFileSync(f.path), before);
      assert.deepEqual(readdirSync(f.dir), ['app.sqlite']);
    },
  );

  native.it('leaves caller snapshot and handles open and reports connection facts without changing them', async (t) => {
    const f = fixture(
      t,
      'CREATE TABLE parent(id INTEGER PRIMARY KEY); CREATE TABLE child(p INTEGER REFERENCES parent(id));',
    );
    const pool = createSqliteToolPool(f.path, 'main');
    const client = await pool.connect();
    try {
      // This is fixture configuration, outside the collector.
      await client.query('PRAGMA foreign_keys = OFF');
      await client.query('BEGIN');
      const sql: string[] = [];
      const query = client.query.bind(client);
      t.mock.method(client, 'query', (text: string, values?: unknown[]) => {
        sql.push(text);
        return query(text, values);
      });
      const result = await collectSqliteDoctorReport(client);
      assert.equal(result.ok, false);
      assert.equal(result.checks.find((check) => check.code === 'SQLITE_FOREIGN_KEYS')!.status, 'warn');
      assert.ok(sql.length > 5);
      assert.ok(sql.every((text) => !/^(BEGIN|COMMIT|ROLLBACK|ANALYZE|VACUUM)\b|PRAGMA\s+.*=/i.test(text)));
      assert.ok(sql.every((text) => !/FROM\s+(?:"?(?:parent|child)"?)(?:\s|$)/i.test(text)));
      assert.equal((await client.query('PRAGMA foreign_keys')).rows[0]!.foreign_keys, 0);
      // A second BEGIN must still fail: collector did not finish the snapshot.
      await assert.rejects(client.query('BEGIN'), /within a transaction/);
      await client.query('ROLLBACK');
      await assert.rejects(client.query('CREATE TABLE forbidden(id INTEGER)'), /readonly|read.only/i);
      assert.equal((await client.query('SELECT 17 AS value')).rows[0]!.value, 17);
    } finally {
      client.release();
      await pool.end();
    }
    await assert.rejects(client.query('SELECT 1'), /released/);
  });

  native.it('never sends PostgreSQL queries or checks out an arbitrary executor', async () => {
    const calls: string[] = [];
    const fake: PgCompatPoolClient = {
      async query(text) {
        calls.push(text);
        throw new Error('must not execute');
      },
      release() {
        calls.push('release');
      },
    };
    const result = await collectSqliteDoctorReport(fake);
    assert.equal(result.ok, false);
    assert.equal(result.checks.at(-1)!.code, 'SQLITE_CATALOG');
    assert.equal(result.checks.at(-1)!.status, 'unknown');
    assert.deepEqual(calls, []);
  });

  native.it(
    'requires complete composite left prefixes, accepting equality-column permutations and unique/primary keys',
    async (t) => {
      const f = fixture(
        t,
        `
      CREATE TABLE parent(a INTEGER, b INTEGER, PRIMARY KEY(a,b));
      CREATE TABLE covered(a INTEGER, b INTEGER, extra TEXT, FOREIGN KEY(a,b) REFERENCES parent(a,b));
      CREATE UNIQUE INDEX covering_unique ON covered(a,b,extra);
      CREATE TABLE reversed(a INTEGER, b INTEGER, FOREIGN KEY(a,b) REFERENCES parent(a,b));
      CREATE INDEX reversed_key ON reversed(b,a);
      CREATE TABLE suffix(a INTEGER, b INTEGER, extra TEXT, FOREIGN KEY(a,b) REFERENCES parent(a,b));
      CREATE INDEX wrong_prefix ON suffix(extra,a,b);
      CREATE TABLE short(a INTEGER, b INTEGER, FOREIGN KEY(a,b) REFERENCES parent(a,b));
      CREATE INDEX too_short ON short(a);
      CREATE TABLE repeated(a INTEGER,b INTEGER,FOREIGN KEY(a,b) REFERENCES parent(a,b));
      CREATE INDEX repeated_keys ON repeated(a,a,b);
      CREATE TABLE primary_covered(a INTEGER,b INTEGER,PRIMARY KEY(a,b),FOREIGN KEY(a,b) REFERENCES parent(a,b)) WITHOUT ROWID;
      CREATE TABLE rowid_covered(a INTEGER PRIMARY KEY REFERENCES parent(a));
    `,
      );
      const result = await runSqliteDoctor({ url: f.path });
      assert.equal(fkChecks(result, 'covered')[0]!.status, 'pass');
      assert.deepEqual(fkChecks(result, 'covered')[0]!.facts.indexes, ['covering_unique']);
      assert.equal(fkChecks(result, 'reversed')[0]!.status, 'pass');
      assert.deepEqual(fkChecks(result, 'reversed')[0]!.facts.indexes, ['reversed_key']);
      // Independently ask the native planner about the equality permutation.
      // EXPLAIN QUERY PLAN does not execute or scan the fixture's user rows.
      const db = new Database!(f.path, { readOnly: true });
      try {
        const plan = db.prepare('EXPLAIN QUERY PLAN SELECT rowid FROM reversed WHERE a=? AND b=?').all(1, 2);
        assert.ok(plan.length > 0);
        assert.ok(plan.some((row) => /SEARCH reversed USING COVERING INDEX reversed_key/.test(String(row.detail))));
      } finally {
        db.close();
      }
      assert.equal(fkChecks(result, 'primary_covered')[0]!.status, 'pass');
      assert.equal(fkChecks(result, 'rowid_covered')[0]!.facts.rowidAlias, true);
      assert.equal(fkChecks(result, 'repeated')[0]!.status, 'unknown');
      for (const name of ['suffix', 'short']) {
        assert.equal(fkChecks(result, name)[0]!.status, 'warn');
        assert.equal(fkChecks(result, name)[0]!.facts.coverage, 'no-structural-left-prefix');
      }
    },
  );

  native.it('keeps expression positions and partial predicates opaque and withholds literal SQL', async (t) => {
    const f = fixture(
      t,
      `
      CREATE TABLE parent(a INTEGER,b INTEGER,PRIMARY KEY(a,b));
      CREATE TABLE partial(a INTEGER,b INTEGER, FOREIGN KEY(a,b) REFERENCES parent(a,b));
      CREATE INDEX partial_key ON partial(a,b) WHERE b <> 'predicate-canary';
      CREATE TABLE expression_first(a INTEGER,b INTEGER, FOREIGN KEY(a,b) REFERENCES parent(a,b));
      CREATE INDEX expression_key ON expression_first((a || 'expression-canary'), b);
      CREATE TABLE expression_suffix(a INTEGER,b INTEGER, FOREIGN KEY(a,b) REFERENCES parent(a,b));
      CREATE INDEX suffix_key ON expression_suffix(a,b,(a || 'suffix-canary'));
      CREATE TABLE defaults(a INTEGER DEFAULT 'default-canary');
    `,
    );
    const result = await runSqliteDoctor({ url: f.path });
    assert.equal(fkChecks(result, 'partial')[0]!.status, 'unknown');
    assert.equal(fkChecks(result, 'expression_first')[0]!.status, 'unknown');
    assert.equal(fkChecks(result, 'expression_suffix')[0]!.status, 'pass');
    assert.doesNotMatch(JSON.stringify(result), /predicate-canary|expression-canary|suffix-canary|default-canary/);
  });

  native.it('supports hostile quoted identifiers and multiple FK groups without conflating them', async (t) => {
    const f = fixture(
      t,
      `
      CREATE TABLE "parent' WHERE )"("id""x" INTEGER PRIMARY KEY);
      CREATE TABLE "child' WHERE )"("fk""x" INTEGER REFERENCES "parent' WHERE )"("id""x"),
        other INTEGER REFERENCES "parent' WHERE )"("id""x"));
      CREATE INDEX "index' WHERE )" ON "child' WHERE )"("fk""x");
    `,
    );
    const result = await runSqliteDoctor({ url: f.path });
    const checks = fkChecks(result, "child' WHERE )");
    assert.equal(checks.length, 2);
    assert.equal(checks.find((check) => (check.facts.columns as string[])[0] === 'fk"x')!.status, 'pass');
    assert.equal(checks.find((check) => (check.facts.columns as string[])[0] === 'other')!.status, 'warn');
    const db = new Database!(f.path, { readOnly: true });
    assert.equal(db.prepare("SELECT count(*) AS n FROM main.sqlite_schema WHERE type='table'").get()!.n, 2);
    db.close();
  });

  native.it('does not infer a missing index when native index metadata is incomplete', async (t) => {
    const f = fixture(
      t,
      `CREATE TABLE p(id INTEGER PRIMARY KEY); CREATE TABLE c(p INTEGER REFERENCES p(id)); CREATE INDEX cp ON c(p);`,
    );
    const pool = createSqliteToolPool(f.path, 'main');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const query = client.query.bind(client);
      t.mock.method(client, 'query', (text: string, values?: unknown[]) => {
        if (/index_xinfo/.test(text)) return Promise.resolve({ rows: [], rowCount: 0 });
        return query(text, values);
      });
      const result = await collectSqliteDoctorReport(client);
      assert.equal(fkChecks(result, 'c')[0]!.status, 'unknown');
      assert.equal(result.ok, false);
      await client.query('ROLLBACK');
    } finally {
      client.release();
      await pool.end();
    }
  });

  native.it(
    'reports tracking visibility and storage facts without claiming dirty or checksum correctness',
    async (t) => {
      const f = fixture(
        t,
        `
      CREATE TABLE _turbine_migrations(id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, applied_at TEXT NOT NULL, checksum TEXT NOT NULL);
      INSERT INTO _turbine_migrations VALUES(1,'migration-name-canary','time-canary','checksum-canary');
    `,
      );
      const before = readFileSync(f.path);
      const result = await runSqliteDoctor({ url: f.path });
      const tracking = result.checks.at(-1)!;
      assert.equal(tracking.code, 'SQLITE_MIGRATION_TRACKING');
      assert.equal(tracking.facts.rowsInspected, 1);
      assert.equal(tracking.facts.dirtyState, 'unknown');
      assert.equal(tracking.facts.checksumsVerified, false);
      assert.doesNotMatch(JSON.stringify(result), /migration-name-canary|time-canary|checksum-canary/);
      assert.deepEqual(readFileSync(f.path), before);
    },
  );

  native.it(
    'reports bounded or noncanonical history as incomplete, including views and dirty extensions',
    async (t) => {
      for (const sql of [
        `CREATE VIEW _turbine_migrations AS SELECT 'view-literal-canary' AS name`,
        'CREATE TABLE _turbine_migrations(id INTEGER PRIMARY KEY, dirty INTEGER)',
        `CREATE TABLE _turbine_migrations(id INTEGER PRIMARY KEY,name TEXT NOT NULL UNIQUE,applied_at TEXT NOT NULL,checksum TEXT NOT NULL);
       WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<101)
       INSERT INTO _turbine_migrations SELECT x,'m'||x,'t','c' FROM n`,
      ]) {
        const f = fixture(t, sql);
        const result = await runSqliteDoctor({ url: f.path });
        assert.equal(result.checks.at(-1)!.status, 'unknown');
        assert.equal(result.ok, false);
        assert.doesNotMatch(JSON.stringify(result), /view-literal-canary/);
      }
    },
  );

  for (const [name, definition, extra] of [
    ['missing uniqueness', 'id INTEGER PRIMARY KEY, name TEXT NOT NULL', ''],
    [
      'partial uniqueness',
      'id INTEGER PRIMARY KEY, name TEXT NOT NULL',
      'CREATE UNIQUE INDEX partial_history ON _turbine_migrations(name) WHERE id > 0',
    ],
    ['composite primary key', 'id INTEGER, name TEXT NOT NULL UNIQUE, PRIMARY KEY(id,name)', ''],
    [
      'tracking trigger',
      'id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE',
      'CREATE TRIGGER history_trigger AFTER INSERT ON _turbine_migrations BEGIN SELECT 1; END',
    ],
    [
      'incoming foreign key',
      'id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE',
      'CREATE TABLE dependent(history_id INTEGER REFERENCES _turbine_migrations(id))',
    ],
  ]) {
    native.it(`refuses noncanonical tracking with ${name} before inspecting stored rows`, async (t) => {
      const f = fixture(
        t,
        `CREATE TABLE _turbine_migrations(checksum TEXT NOT NULL, applied_at TEXT NOT NULL, ${definition}); ${extra}`,
      );
      const pool = createSqliteToolPool(f.path, 'main');
      const client = await pool.connect();
      const query = client.query.bind(client);
      const statements: string[] = [];
      t.mock.method(client, 'query', (text: string, values?: unknown[]) => {
        statements.push(text);
        return query(text, values);
      });
      try {
        const result = await collectSqliteDoctorReport(client);
        const tracking = result.checks.at(-1)!;
        assert.equal(result.ok, false);
        assert.equal(tracking.status, 'unknown');
        assert.equal(tracking.facts.visibility, 'noncanonical');
        assert.ok(statements.length > 0);
        assert.ok(!statements.some((sql) => sql.includes('typeof(id)')), 'noncanonical history rows were inspected');
      } finally {
        client.release();
        await pool.end();
      }
    });
  }

  native.it('withholds failed native diagnostics and never releases the caller on query failure', async (t) => {
    const f = fixture(t);
    const pool = createSqliteToolPool(f.path, 'main');
    const client = await pool.connect();
    const query = client.query.bind(client);
    try {
      await client.query('BEGIN');
      const mocked = t.mock.method(client, 'query', async () => {
        throw new Error('failure-literal-canary');
      });
      const result = await collectSqliteDoctorReport(client);
      assert.equal(result.ok, false);
      assert.ok(result.checks.some((check) => check.status === 'unknown'));
      assert.doesNotMatch(JSON.stringify(result), /failure-literal-canary/);
      mocked.mock.restore();
      await query('ROLLBACK');
      assert.equal((await client.query('SELECT 1 AS n')).rows[0]!.n, 1);
    } finally {
      client.release();
      await pool.end();
    }
  });

  native.it('handles readonly, zero-byte, missing and malformed files without creating sidecars', async (t) => {
    const f = fixture(t, 'CREATE TABLE p(id INTEGER PRIMARY KEY)');
    chmodSync(f.path, 0o444);
    const before = readFileSync(f.path);
    assert.equal((await runSqliteDoctor({ url: f.path })).engine, 'sqlite');
    assert.deepEqual(readFileSync(f.path), before);
    const missing = join(f.dir, 'missing.sqlite');
    await assert.rejects(runSqliteDoctor({ url: missing }), (error: Error) => {
      assert.match(error.message, /accessible existing database/);
      assert.ok(!error.message.includes(f.dir));
      return true;
    });
    assert.equal(existsSync(missing), false);
    const empty = join(f.dir, 'empty.sqlite');
    writeFileSync(empty, '');
    assert.equal((await runSqliteDoctor({ url: empty })).engine, 'sqlite');
    assert.equal(readFileSync(empty).length, 0);
    const bad = join(f.dir, 'bad.sqlite');
    writeFileSync(bad, 'not a database');
    const result = await runSqliteDoctor({ url: bad });
    assert.equal(result.ok, false);
    assert.ok(result.checks.some((check) => check.status === 'unknown'));
    assert.deepEqual(readdirSync(f.dir).sort(), ['app.sqlite', 'bad.sqlite', 'empty.sqlite']);
  });

  native.it('reports a busy catalog as unknown and releases its owned handle', async (t) => {
    const f = fixture(t, 'CREATE TABLE p(id INTEGER PRIMARY KEY)');
    const writer = new Database!(f.path);
    try {
      writer.exec('BEGIN EXCLUSIVE');
      const result = await runSqliteDoctor({ url: f.path });
      assert.equal(result.ok, false);
      assert.ok(result.checks.some((check) => check.code === 'SQLITE_CATALOG' && check.status === 'unknown'));
      writer.exec('ROLLBACK');
    } finally {
      writer.close();
    }
    assert.equal(
      (await runSqliteDoctor({ url: f.path })).checks.find((check) => check.code === 'SQLITE_CATALOG')!.status,
      'pass',
    );
  });

  native.it(
    'refuses WAL files without existing sidecars and reads active owned WAL snapshots without creating files',
    async (t) => {
      const f = fixture(t, 'CREATE TABLE p(id INTEGER PRIMARY KEY)');
      const writer = new Database!(f.path);
      writer.exec('PRAGMA journal_mode=WAL; INSERT INTO p VALUES(1)');
      try {
        const files = readdirSync(f.dir).sort();
        assert.ok(files.includes('app.sqlite-wal') && files.includes('app.sqlite-shm'));
        const result = await runSqliteDoctor({ url: f.path });
        assert.equal(result.checks.find((check) => check.code === 'SQLITE_JOURNAL_MODE')!.facts.value, 'wal');
        assert.deepEqual(readdirSync(f.dir).sort(), files);
      } finally {
        writer.close();
      }
      assert.deepEqual(readdirSync(f.dir), ['app.sqlite']);
      await assert.rejects(runSqliteDoctor({ url: f.path }), /existing WAL and SHM/);
      assert.deepEqual(readdirSync(f.dir), ['app.sqlite']);
    },
  );

  native.it('closes the file when checkout construction fails', async (t) => {
    const f = fixture(t);
    let closed = 0;
    const close = Database!.prototype.close;
    t.mock.method(Database!.prototype, 'close', function (this: DatabaseSync) {
      closed++;
      return close.call(this);
    });
    t.mock.method(SqlitePool.prototype, 'connect', async () => {
      throw new Error('checkout failed');
    });
    await assert.rejects(runSqliteDoctor({ url: f.path }), (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.match(error.message, /SQLite doctor failed/);
      assert.match(error.errors[0].message, /checkout failed/);
      return true;
    });
    assert.equal(closed, 1);
  });

  native.it('retries native close before relinquishing owned cleanup and retains the first failure', async (t) => {
    const f = fixture(t);
    const close = Database!.prototype.close;
    let captured: DatabaseSync | undefined;
    let attempts = 0;
    const mock = t.mock.method(Database!.prototype, 'close', function (this: DatabaseSync) {
      captured = this;
      if (++attempts === 1) throw new Error('before native close');
      return close.call(this);
    });
    try {
      await assert.rejects(runSqliteDoctor({ url: f.path }), (error: unknown) => {
        assert.ok(error instanceof AggregateError);
        assert.match(error.errors[0].message, /before native close/);
        assert.equal((error as AggregateError & { report: SqliteDoctorReport }).report.engine, 'sqlite');
        return true;
      });
      assert.equal(attempts, 2, 'pool shutdown must retry the unclosed native handle');
      assert.ok(captured);
      const database = captured;
      assert.throws(() => database.prepare('SELECT 1'), /not open|closed/);
    } finally {
      mock.mock.restore();
      if (captured?.isOpen) close.call(captured);
    }
  });

  native.it('retains the report when owned teardown reports a failure and attempts cleanup', async (t) => {
    const f = fixture(t);
    const close = Database!.prototype.close;
    let closed = 0;
    t.mock.method(Database!.prototype, 'close', function (this: DatabaseSync) {
      closed++;
      close.call(this);
      throw new Error('close failed after native close');
    });
    await assert.rejects(runSqliteDoctor({ url: f.path }), (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      const retained = (error as AggregateError & { report: SqliteDoctorReport }).report;
      assert.equal(retained.engine, 'sqlite');
      assert.ok(retained.checks.length >= 5);
      assert.equal(error.errors.length, 1);
      return true;
    });
    assert.equal(closed, 1);
  });
});
