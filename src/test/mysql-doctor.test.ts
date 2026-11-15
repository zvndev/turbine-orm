import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { resolveConfig } from '../cli/config.js';
import {
  assertMysqlDoctorArguments,
  cmdMysqlDoctor,
  collectMysqlDoctor,
  formatMysqlDoctor,
  type MysqlDoctorSnapshot,
} from '../cli/mysql-doctor.js';
import { createMysqlToolPool } from '../cli/mysql-tools.js';
import type { PgCompatPoolClient } from '../pg-types.js';

const inheritedDatabaseUrl = process.env.DATABASE_URL;
beforeEach(() => {
  delete process.env.DATABASE_URL;
});
afterEach(() => {
  if (inheritedDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = inheritedDatabaseUrl;
});

const peer = createRequire(import.meta.url)('mysql2/promise');
const url = 'mysql://reader:password-marker@127.0.0.1:3306/app';
const codes = [
  'MYSQL_RUNTIME',
  'MYSQL_VISIBILITY',
  'MYSQL_SCOPE',
  'MYSQL_ENGINES',
  'MYSQL_CONSTRAINTS',
  'MYSQL_FOREIGN_KEYS',
  'MYSQL_INDEXES',
  'MYSQL_MIGRATIONS',
];
const idx = (table: string, name: string, column: string | null, prefix: number | null = null, seq = 1) => ({
  TABLE_NAME: table,
  INDEX_NAME: name,
  COLUMN_NAME: column,
  SUB_PART: prefix,
  SEQ_IN_INDEX: seq,
  NON_UNIQUE: name === 'PRIMARY' ? 0 : 1,
  EXPRESSION: column === null ? "concat('expression-secret', label)" : null,
  INDEX_COMMENT: 'comment-secret',
  INDEX_TYPE: 'BTREE',
  IS_VISIBLE: 'YES',
  COLLATION: 'A',
});
function fixture() {
  const state = {
    modes: 'STRICT_TRANS_TABLES,NO_ENGINE_SUBSTITUTION',
    version: '8.4.0',
    foreignKeyChecks: 1,
    visibility: true,
    fail: '',
    counts: { applied: 2 as number | string, dirty: 0 },
    released: 0,
    opens: 0,
    catalog: ['children', 'parents', '_turbine_migrations', '_turbine_migration_state'].map((TABLE_NAME) => ({
      TABLE_NAME,
      ENGINE: 'InnoDB',
      TABLE_TYPE: 'BASE TABLE',
    })),
    indexes: [
      idx('parents', 'PRIMARY', 'id'),
      idx('children', 'PRIMARY', 'id'),
      idx('children', 'child_parent', 'parent_id'),
      idx('children', 'mixed', 'label', 3),
      idx('children', 'mixed', null, null, 2),
    ],
    keys: [
      {
        TABLE_NAME: 'children',
        CONSTRAINT_NAME: 'child_parent_fk',
        COLUMN_NAME: 'parent_id',
        ORDINAL_POSITION: 1,
        REFERENCED_TABLE_SCHEMA: 'app',
        REFERENCED_TABLE_NAME: 'parents',
        REFERENCED_COLUMN_NAME: 'id',
        target_local: 1,
      },
    ],
  };
  const calls: string[] = [];
  const rows = (sql: string) => {
    calls.push(sql);
    if (state.fail && sql.includes(state.fail)) throw new Error('native password-marker row-secret endpoint-secret');
    if (sql.includes('VERSION()'))
      return [{ version: state.version, sql_mode: state.modes, foreign_key_checks: state.foreignKeyChecks }];
    if (sql.includes('information_schema.TABLES')) return state.catalog;
    if (sql.includes('information_schema.COLUMNS'))
      return ['children', 'parents'].flatMap((TABLE_NAME) =>
        ['id', 'parent_id', 'label'].map((COLUMN_NAME) => ({
          TABLE_NAME,
          COLUMN_NAME,
          DATA_TYPE: 'int',
          COLUMN_TYPE: 'int',
          IS_NULLABLE: 'NO',
          COLUMN_KEY: COLUMN_NAME === 'id' ? 'PRI' : '',
          COLUMN_DEFAULT: 'default-secret',
          EXTRA: '',
          GENERATION_EXPRESSION: '',
          CHARACTER_MAXIMUM_LENGTH: null,
        })),
      );
    if (sql.includes('information_schema.STATISTICS'))
      return sql.includes("INDEX_NAME = 'PRIMARY'")
        ? state.indexes.filter((row) => row.INDEX_NAME === 'PRIMARY')
        : state.indexes;
    if (sql.includes('information_schema.KEY_COLUMN_USAGE'))
      return sql.includes("CONSTRAINT_NAME = 'PRIMARY'")
        ? ['children', 'parents'].map((TABLE_NAME) => ({ TABLE_NAME, COLUMN_NAME: 'id', ORDINAL_POSITION: 1 }))
        : state.keys;
    if (sql.includes('COUNT(*)'))
      return [{ n: sql.includes('_turbine_migration_state') ? state.counts.dirty : state.counts.applied }];
    return [];
  };
  const connection = {
    async query(sql: string) {
      return [rows(sql), []];
    },
    async execute(sql: string) {
      return [rows(sql), []];
    },
    on() {},
    destroy() {
      state.released++;
    },
  };
  return {
    state,
    calls,
    connection,
    async snapshot(): Promise<{ snapshot: MysqlDoctorSnapshot; close(): Promise<void> }> {
      const pool = createMysqlToolPool(url, 'app');
      const client = await pool.connect();
      const query = (async (sql: string) => {
        const result = rows(sql);
        return { rows: result, rowCount: result.length };
      }) as PgCompatPoolClient['query'];
      return {
        snapshot: {
          client,
          schema: 'app',
          query,
          async assertVisibility() {
            if (!state.visibility) throw new Error('account-secret grant-secret');
          },
        },
        async close() {
          client.release();
          await pool.end();
        },
      };
    },
  };
}
const check = (report: Awaited<ReturnType<typeof collectMysqlDoctor>>, code: string) =>
  report.checks.find((value) => value.code === code)!;

describe('scoped MySQL doctor', () => {
  it('keeps deterministic ordered structural facts, covers primary keys, and withholds schema literals', async (t) => {
    const f = fixture();
    t.mock.method(peer, 'createConnection', async () => f.connection);
    const owned = await f.snapshot();
    try {
      const a = await collectMysqlDoctor(owned.snapshot);
      const b = await collectMysqlDoctor(owned.snapshot);
      assert.deepEqual(a, b);
      assert.deepEqual(
        a.checks.map((c) => c.code),
        codes,
      );
      assert.equal(a.ok, true);
      assert.equal(check(a, 'MYSQL_MIGRATIONS').facts.appliedCount, 2);
      const indexes = check(a, 'MYSQL_INDEXES').facts as {
        foreignKeys: { targetCoverage: string }[];
        indexes: { columns: string[]; keys: unknown[] }[];
      };
      assert.equal(indexes.foreignKeys[0]!.targetCoverage, 'observed-primary-leading-columns');
      assert.ok(indexes.indexes.some((index) => index.keys.length === 2));
      assert.doesNotMatch(
        JSON.stringify(a) + formatMysqlDoctor(a),
        /password-marker|expression-secret|default-secret|comment-secret|endpoint-secret|row-secret/,
      );
      assert.equal(f.state.released, 0, 'collector does not release the supplied snapshot');
      assert.ok(f.calls.includes('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY'));
      assert.ok(f.calls.length > 10);
      assert.ok(
        f.calls.every(
          (sql) => !/^(?:ANALYZE|EXPLAIN|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|SET SESSION|SET GLOBAL)/i.test(sql),
        ),
      );
    } finally {
      await owned.close();
    }
    assert.equal(f.state.released, 1);
  });
  it('refuses unproved visibility before reading catalogs, even if catalogs would be empty', async (t) => {
    const f = fixture();
    f.state.visibility = false;
    f.state.catalog = [];
    t.mock.method(peer, 'createConnection', async () => f.connection);
    const owned = await f.snapshot();
    try {
      const report = await collectMysqlDoctor(owned.snapshot);
      assert.equal(report.ok, false);
      assert.equal(check(report, 'MYSQL_VISIBILITY').status, 'unknown');
      assert.equal(check(report, 'MYSQL_SCOPE').facts.reason, 'not-assessed');
      assert.equal(
        f.calls.some((sql) => sql.includes('information_schema')),
        false,
      );
      assert.doesNotMatch(JSON.stringify(report), /account-secret|grant-secret/);
    } finally {
      await owned.close();
    }
  });
  for (const mode of ['', 'NO_BACKSLASH_ESCAPES,STRICT_TRANS_TABLES'])
    it(`observes sql_mode ${mode || '(empty)'}`, async (t) => {
      const f = fixture();
      f.state.modes = mode;
      t.mock.method(peer, 'createConnection', async () => f.connection);
      const owned = await f.snapshot();
      try {
        const report = await collectMysqlDoctor(owned.snapshot);
        assert.deepEqual(check(report, 'MYSQL_RUNTIME').facts.sqlModes, mode.split(',').filter(Boolean).sort());
        assert.equal(report.ok, true);
      } finally {
        await owned.close();
      }
    });
  it('preserves unknown opaque coverage and external or excluded FK targets', async (t) => {
    const f = fixture();
    f.state.indexes = f.state.indexes.filter((index) => index.INDEX_NAME !== 'child_parent');
    t.mock.method(peer, 'createConnection', async () => f.connection);
    const owned = await f.snapshot();
    try {
      const a = await collectMysqlDoctor(owned.snapshot, { include: ['children'] });
      const facts = check(a, 'MYSQL_INDEXES').facts as {
        foreignKeys: { sourceCoverage: string; targetCoverage: string }[];
      };
      assert.equal(facts.foreignKeys[0]!.sourceCoverage, 'unknown-opaque-keys');
      assert.equal(facts.foreignKeys[0]!.targetCoverage, 'unknown-outside-scope');
      assert.equal(check(a, 'MYSQL_INDEXES').status, 'unknown');
      f.state.keys[0]!.target_local = 0;
      const b = await collectMysqlDoctor(owned.snapshot);
      assert.match(JSON.stringify(check(b, 'MYSQL_INDEXES').facts), /external-database/);
    } finally {
      await owned.close();
    }
  });
  it('reports absent structural coverage without claiming an index is necessary', async (t) => {
    const f = fixture();
    f.state.indexes = f.state.indexes.filter((index) => index.INDEX_NAME === 'PRIMARY');
    t.mock.method(peer, 'createConnection', async () => f.connection);
    const owned = await f.snapshot();
    try {
      const report = await collectMysqlDoctor(owned.snapshot);
      assert.equal(check(report, 'MYSQL_INDEXES').status, 'warn');
      assert.match(JSON.stringify(check(report, 'MYSQL_INDEXES').facts), /not-observed/);
    } finally {
      await owned.close();
    }
  });
  it('does not count an invisible or prefix key as full leading-column coverage', async (t) => {
    const f = fixture();
    const index = f.state.indexes.find((row) => row.INDEX_NAME === 'child_parent')!;
    index.IS_VISIBLE = 'NO';
    t.mock.method(peer, 'createConnection', async () => f.connection);
    const owned = await f.snapshot();
    try {
      assert.equal(check(await collectMysqlDoctor(owned.snapshot), 'MYSQL_INDEXES').status, 'unknown');
      index.IS_VISIBLE = 'YES';
      index.SUB_PART = 3;
      assert.equal(check(await collectMysqlDoctor(owned.snapshot), 'MYSQL_INDEXES').status, 'unknown');
    } finally {
      await owned.close();
    }
  });
  it('reports nontransactional engines, disabled FK enforcement and unknown modes truthfully', async (t) => {
    const f = fixture();
    f.state.catalog[0]!.ENGINE = 'MyISAM';
    f.state.foreignKeyChecks = 0;
    f.state.modes = 'mode-secret';
    t.mock.method(peer, 'createConnection', async () => f.connection);
    const owned = await f.snapshot();
    try {
      const report = await collectMysqlDoctor(owned.snapshot);
      for (const code of ['MYSQL_RUNTIME', 'MYSQL_ENGINES', 'MYSQL_FOREIGN_KEYS'])
        assert.equal(check(report, code).status, 'warn');
      assert.doesNotMatch(JSON.stringify(report), /mode-secret/);
      assert.equal(report.ok, false);
      f.state.catalog[0]!.ENGINE = 'NDB';
      assert.equal(check(await collectMysqlDoctor(owned.snapshot), 'MYSQL_ENGINES').status, 'unknown');
    } finally {
      await owned.close();
    }
  });
  it('marks missing migration tables unknown and dirty journals failed without exposing their rows', async (t) => {
    const f = fixture();
    t.mock.method(peer, 'createConnection', async () => f.connection);
    const owned = await f.snapshot();
    try {
      f.state.counts.dirty = 1;
      assert.equal(check(await collectMysqlDoctor(owned.snapshot), 'MYSQL_MIGRATIONS').status, 'fail');
      f.state.catalog = f.state.catalog.filter((row) => !row.TABLE_NAME.startsWith('_turbine'));
      const report = await collectMysqlDoctor(owned.snapshot);
      assert.equal(check(report, 'MYSQL_MIGRATIONS').status, 'unknown');
      assert.equal(check(report, 'MYSQL_MIGRATIONS').facts.dirtyCount, null);
    } finally {
      await owned.close();
    }
  });
  for (const failure of ['information_schema.COLUMNS', 'target_local', "INDEX_NAME = 'PRIMARY'", 'COUNT(*)'])
    it(`retains failed reports and earlier facts after ${failure}`, async (t) => {
      const f = fixture();
      t.mock.method(peer, 'createConnection', async () => f.connection);
      const owned = await f.snapshot();
      try {
        f.state.fail = failure;
        const report = await collectMysqlDoctor(owned.snapshot);
        assert.equal(report.ok, false);
        assert.equal(check(report, 'MYSQL_RUNTIME').status, 'pass');
        assert.equal(report.checks.filter((c) => c.status === 'fail').length, 1);
        assert.doesNotMatch(JSON.stringify(report), /password-marker|row-secret|endpoint-secret/);
      } finally {
        await owned.close();
      }
    });
  it('rejects unsafe count coercion and tracking views', async (t) => {
    const f = fixture();
    t.mock.method(peer, 'createConnection', async () => f.connection);
    const owned = await f.snapshot();
    try {
      f.state.counts.applied = '9007199254740993';
      assert.equal(check(await collectMysqlDoctor(owned.snapshot), 'MYSQL_MIGRATIONS').status, 'fail');
      f.state.catalog.find((row) => row.TABLE_NAME === '_turbine_migrations')!.TABLE_TYPE = 'VIEW';
      assert.equal(check(await collectMysqlDoctor(owned.snapshot), 'MYSQL_MIGRATIONS').status, 'unknown');
    } finally {
      await owned.close();
    }
  });
  it('uses native identifier quoting without sql_mode-dependent literals', async (t) => {
    const f = fixture();
    t.mock.method(peer, 'createConnection', async () => f.connection);
    const owned = await f.snapshot();
    try {
      owned.snapshot.schema = 'back`tick';
      await collectMysqlDoctor(owned.snapshot);
      assert.ok(f.calls.some((sql) => sql.includes('`back``tick`.`_turbine_migrations`')));
      owned.snapshot.schema = 'a'.repeat(65);
      assert.equal(check(await collectMysqlDoctor(owned.snapshot), 'MYSQL_MIGRATIONS').status, 'fail');
    } finally {
      await owned.close();
    }
  });
  it('withholds an unrecognized runtime and never proceeds to visibility', async () => {
    let called = false;
    const query = (async () => ({
      rows: [{ version: '9.0.0-secret', sql_mode: '' }],
      rowCount: 1,
    })) as PgCompatPoolClient['query'];
    const report = await collectMysqlDoctor({
      client: {} as PgCompatPoolClient,
      schema: 'app',
      query,
      async assertVisibility() {
        called = true;
      },
    });
    assert.equal(report.ok, false);
    assert.equal(called, false);
    assert.doesNotMatch(JSON.stringify(report), /9.0.0-secret/);
  });
  it('refuses PG-only flags, swallowed operands and positional arguments before any checkout', async (t) => {
    const mock = t.mock.method(peer, 'createConnection', async () => {
      throw new Error('must not connect');
    });
    const args = { command: 'doctor', positional: [] };
    for (const flag of [
      '--fix',
      '--unused',
      '--audit',
      '--min-scans',
      '--metrics-url',
      '--no-plan-divergence',
      '--allow-pooler',
      '--no-concurrently',
      '--schema-file',
      '--json=1',
    ])
      assert.throws(() => assertMysqlDoctorArguments(args, ['doctor', flag]), /MySQL/);
    assert.throws(() => assertMysqlDoctorArguments({ ...args, subcommand: 'unexpected' }), /MySQL/);
    assert.throws(() => assertMysqlDoctorArguments(args, ['doctor', '--url', '--fix']), /MySQL/);
    assert.throws(() => assertMysqlDoctorArguments({ ...args, positional: ['unexpected'] }), /MySQL/);
    await assert.rejects(
      cmdMysqlDoctor({ ...args, fix: false } as typeof args, resolveConfig({ engine: 'mysql', url }, {}), async () => {
        throw new Error('must not collect');
      }),
      /MySQL/,
    );
    assert.equal(mock.mock.callCount(), 0);
  });
  it('adapter releases its own checkout and pool after collector or output failures', async (t) => {
    const f = fixture();
    t.mock.method(peer, 'createConnection', async () => f.connection);
    const config = resolveConfig({ engine: 'mysql', url }, {});
    await assert.rejects(
      cmdMysqlDoctor({ command: 'doctor', positional: [] }, config, async () => {
        throw new Error('collector failure');
      }),
      /collector failure/,
    );
    assert.equal(f.state.released, 1);
  });
});

describe('MySQL doctor adapter output ownership', () => {
  it('closes its snapshot after output fails and withholds native connection errors', async (t) => {
    const f = fixture();
    t.mock.method(peer, 'createConnection', async () => f.connection);
    const config = resolveConfig({ engine: 'mysql', url }, {});
    t.mock.method(console, 'log', () => {
      throw new Error('output failure');
    });
    await assert.rejects(
      cmdMysqlDoctor({ command: 'doctor', positional: [], json: true }, config, async () => ({
        formatVersion: 1,
        engine: 'mysql',
        ok: false,
        checks: [],
        limitations: [],
      })),
      /output failure/,
    );
    assert.equal(f.state.released, 1);
    t.mock.method(peer, 'createConnection', async () => {
      throw new Error('password-marker endpoint-secret');
    });
    await assert.rejects(
      cmdMysqlDoctor({ command: 'doctor', positional: [] }, config, async () => {
        throw new Error('must not collect');
      }),
      (error: Error) => {
        assert.doesNotMatch(error.message, /password-marker|endpoint-secret/);
        assert.match(error.message, /MySQL read-only tool/);
        return true;
      },
    );
  });
});
