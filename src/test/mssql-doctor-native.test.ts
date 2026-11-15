/** Native catalog evidence requires an explicitly supplied SQL Server endpoint. */
import assert from 'node:assert/strict';
import { runMssqlDoctor } from '../cli/mssql-doctor.js';
import { skipGate } from './helpers.js';

const url = process.env.MSSQL_URL ?? process.env.MSSQL_TEST_URL ?? '';
const native = skipGate(!url, 'requires MSSQL_URL pointing at a SQL Server test database for native doctor evidence');
native.it(
  'collects a native SQL Server catalog report without claiming visibility or snapshot guarantees',
  async () => {
    const report = await runMssqlDoctor({ url, schema: process.env.MSSQL_TEST_SCHEMA ?? 'dbo' });
    assert.equal(report.engine, 'mssql');
    assert.equal(report.formatVersion, 1);
    assert.equal(report.ok, false);
    for (const code of [
      'MSSQL_CATALOG_SCOPE',
      'MSSQL_CATALOG_CONSISTENCY',
      'MSSQL_RUNTIME_VERSION',
      'MSSQL_MIGRATION_STATE',
    ]) {
      assert.equal(report.checks.find((check) => check.code === code)?.status, 'unknown');
    }
    assert.ok(report.limitations.length > 0);
  },
);
