/** Exercise the source adapter through its real optional-peer loader with an observable driver fixture. */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';
import { collectMssqlDoctorReport } from '../cli/mssql-doctor.js';
import {
  createMssqlToolPool,
  introspectMssqlToolClient,
  mssqlToolDoctorCatalog,
  mssqlToolIndexSummary,
  releaseMssqlToolClient,
} from '../cli/mssql-tools.js';

const require = createRequire(import.meta.url);
it('observes owned native connections, async catalog reads and cleanup on each failure path', async () => {
  const driver = require('mssql');
  const original = driver.ConnectionPool;
  const fixture = require('./fixtures/mssql-tools-driver.cjs');
  const dir = mkdtempSync(join(tmpdir(), 'turbine-mssql-tools-source-'));
  const oldLog = process.env.MSSQL_TOOLS_LOG;
  const oldMode = process.env.MSSQL_TOOLS_MODE;
  driver.ConnectionPool = fixture.ConnectionPool;
  try {
    for (const mode of ['', 'query-fail', 'pool-error', 'connect-fail', 'close-fail', 'connect-delay', 'query-delay']) {
      process.env.MSSQL_TOOLS_MODE = mode;
      const log = join(dir, `${mode || 'normal'}.jsonl`);
      process.env.MSSQL_TOOLS_LOG = log;
      const pool = createMssqlToolPool('mssql://host/fixture', 'app');
      if (mode === 'connect-delay') {
        const opening = pool.connect();
        await new Promise((resolve) => setTimeout(resolve, 10));
        const rejected = assert.rejects(opening, /closed/);
        await pool.end();
        await rejected;
      } else if (mode === 'connect-fail' || mode === 'pool-error') {
        await assert.rejects(pool.connect(), /connection failed/);
        await pool.end();
      } else {
        const client = await pool.connect();
        assert.throws(() => client.query('DELETE FROM users'), /fixed catalog/);
        if (mode === 'query-fail') {
          await assert.rejects(introspectMssqlToolClient(client, {}), /catalog read failed/);
        } else if (mode === 'query-delay') {
          const work = introspectMssqlToolClient(client, {});
          await assert.rejects(introspectMssqlToolClient(client, {}), /already active/);
          const failed = assert.rejects(work, /catalog read failed|released/);
          await releaseMssqlToolClient(client);
          await failed;
        } else {
          const schema = await introspectMssqlToolClient(client, {});
          assert.deepEqual(Object.keys(schema.tables), ['posts', 'users']);
          assert.ok(Object.values(schema.tables.posts!.relations).some((relation) => relation.to === 'users'));
          const summary = mssqlToolIndexSummary(schema.tables.users!.indexes[0]!)!;
          assert.equal(summary.partial, true);
          assert.equal(summary.computed, true);
          assert.equal(summary.hypothetical, true);
          assert.equal(summary.disabled, false);
          assert.deepEqual(summary.includedColumns, ['email']);
          assert.doesNotMatch(JSON.stringify(schema), /private-default|private-computed|private-filter/);
          assert.equal(
            schema.tables.users!.columns.find((column) => column.name === 'derived')!.isGeneratedStored,
            true,
          );
          assert.equal(
            schema.tables.users!.columns.find((column) => column.name === 'row_version')!.isGeneratedStored,
            true,
          );
          const filtered = await introspectMssqlToolClient(client, { include: ['users'] });
          assert.deepEqual(Object.keys(filtered.tables), ['users']);
        }
        if (mode === 'close-fail') {
          await assert.rejects(releaseMssqlToolClient(client), /cleanup failed/);
          await assert.rejects(pool.end(), /cleanup failed/);
        } else {
          client.release();
          await releaseMssqlToolClient(client);
          await releaseMssqlToolClient(client);
          await pool.end();
        }
        await assert.rejects(introspectMssqlToolClient(client, {}), /active owned/);
      }
      const events = readFileSync(log, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      assert.equal(events.filter((event) => event.event === 'construct').length, 1);
      assert.equal(events.filter((event) => event.event === 'close').length, 1);
      assert.equal(events.at(-1).event, 'close');
      for (const event of events.filter((entry) => entry.event === 'query')) {
        assert.match(event.sql, /^SELECT /);
        assert.deepEqual(event.params, { p1: 'app' });
      }
    }
  } finally {
    driver.ConnectionPool = original;
    if (oldLog === undefined) delete process.env.MSSQL_TOOLS_LOG;
    else process.env.MSSQL_TOOLS_LOG = oldLog;
    if (oldMode === undefined) delete process.env.MSSQL_TOOLS_MODE;
    else process.env.MSSQL_TOOLS_MODE = oldMode;
    rmSync(dir, { recursive: true, force: true });
  }
});

it('corroborates ordered composite catalog facts and withholds uncertain provenance', async () => {
  const driver = require('mssql');
  const original = driver.ConnectionPool;
  const fixture = require('./fixtures/mssql-tools-driver.cjs');
  const dir = mkdtempSync(join(tmpdir(), 'turbine-mssql-doctor-source-'));
  const oldLog = process.env.MSSQL_TOOLS_LOG;
  const oldMode = process.env.MSSQL_TOOLS_MODE;
  let uncertain = false;
  driver.ConnectionPool = class extends fixture.ConnectionPool {
    request() {
      const request = super.request();
      const query = request.query.bind(request);
      request.query = async (sql: string) => {
        const result = await query(sql);
        const rows: Record<string, unknown>[] = result.recordset;
        if (
          sql.includes('c.is_computed AS IS_COMPUTED') &&
          !sql.includes('sys.indexes') &&
          !sql.includes('INFORMATION_SCHEMA.COLUMNS')
        ) {
          for (const row of rows) row.TABLE_SCHEMA = 'app';
        } else if (sql.includes('i.is_primary_key AS IS_PRIMARY_KEY')) {
          for (const row of rows) {
            if (row.COLUMN_NAME === 'derived') row.COLUMN_NAME = 'id';
            row.IS_COMPUTED = false;
            row.HAS_FILTER = false;
            row.IS_HYPOTHETICAL = false;
            row.IS_PRIMARY_KEY = false;
            row.IS_UNIQUE = false;
            row.IS_INCLUDED = false;
            if (row.COLUMN_NAME === 'email') row.KEY_ORDINAL = 2;
          }
          rows.push(
            ...['id', 'email'].map((COLUMN_NAME, i) => ({
              TABLE_NAME: 'users',
              INDEX_NAME: 'users_pkey',
              COLUMN_NAME,
              IS_PRIMARY_KEY: true,
              IS_UNIQUE: true,
              IS_INCLUDED: false,
              HAS_FILTER: false,
              IS_DISABLED: false,
              IS_HYPOTHETICAL: false,
              IS_COMPUTED: false,
              INDEX_TYPE: 'CLUSTERED',
              KEY_ORDINAL: i + 1,
            })),
          );
          if (uncertain) {
            for (const row of rows) {
              row.IS_DISABLED = 'unknown';
              if (row.COLUMN_NAME === 'email') row.KEY_ORDINAL = 4;
            }
          }
        } else if (sql.includes('INFORMATION_SCHEMA.KEY_COLUMN_USAGE')) {
          rows.push({ TABLE_NAME: 'users', COLUMN_NAME: 'email', ORDINAL_POSITION: 2 });
        } else if (sql.includes('sys.indexes')) {
          rows[0]!.COLUMN_NAME = 'id';
          rows.push({ ...rows[0], COLUMN_NAME: 'email', SEQ: 2 });
        }
        return result;
      };
      return request;
    }
  };
  try {
    process.env.MSSQL_TOOLS_LOG = join(dir, 'events.jsonl');
    process.env.MSSQL_TOOLS_MODE = '';
    for (uncertain of [false, true]) {
      const pool = createMssqlToolPool('mssql://host/fixture', 'app');
      const client = await pool.connect();
      try {
        const metadata = await introspectMssqlToolClient(client, {});
        const facts = mssqlToolDoctorCatalog(metadata)!;
        assert.equal(facts.namespace, 'app');
        assert.equal(facts.primaryKeys.users!.orderedKeysKnown, !uncertain);
        assert.equal(facts.primaryKeys.users!.disabled, uncertain ? null : false);
        const summary = mssqlToolIndexSummary(metadata.tables.users!.indexes[0]!)!;
        assert.equal(
          summary.orderedKeysKnown,
          !uncertain,
          JSON.stringify({ summary, indexes: metadata.tables.users!.indexes }),
        );
        assert.equal(summary.nativeUnique, false);
        assert.equal(summary.disabled, uncertain ? null : false);
        const report = await collectMssqlDoctorReport(client);
        assert.equal(report.ok, false, 'structural evidence cannot prove visibility or consistency');
        const keys = report.checks.filter((check) => check.code === 'MSSQL_VISIBLE_KEYS');
        assert.ok(
          keys.some(
            (check) => (check.observed as { primaryIndexEligible: boolean }).primaryIndexEligible === !uncertain,
          ),
        );
        assert.doesNotMatch(JSON.stringify(report), /private-default|private-computed|private-filter/);
      } finally {
        await releaseMssqlToolClient(client);
        await pool.end();
      }
    }
  } finally {
    driver.ConnectionPool = original;
    if (oldLog === undefined) delete process.env.MSSQL_TOOLS_LOG;
    else process.env.MSSQL_TOOLS_LOG = oldLog;
    if (oldMode === undefined) delete process.env.MSSQL_TOOLS_MODE;
    else process.env.MSSQL_TOOLS_MODE = oldMode;
    rmSync(dir, { recursive: true, force: true });
  }
});
