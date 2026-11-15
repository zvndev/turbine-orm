import assert from 'node:assert/strict';
import { it } from 'node:test';
import type { CliArgs } from '../cli/index.js';
import { assertMssqlDoctorArguments, collectMssqlDoctorReport } from '../cli/mssql-doctor.js';
import { createMssqlToolPool } from '../cli/mssql-tools.js';

it('refuses PostgreSQL doctor flags and positional arguments before any checkout', () => {
  const args: CliArgs = { command: 'doctor', positional: [], engine: 'mssql' };
  assert.doesNotThrow(() =>
    assertMssqlDoctorArguments({ ...args, json: true }, ['doctor', '--engine', 'mssql', '--json']),
  );
  for (const key of [
    'fix',
    'unused',
    'audit',
    'minScans',
    'metricsUrl',
    'noPlanDivergence',
    'noConcurrently',
    'allowPooler',
    'force',
    'dryRun',
  ]) {
    assert.throws(() => assertMssqlDoctorArguments({ ...args, [key]: true }), /does not support option/);
  }
  for (const raw of [
    ['doctor', '--fix'],
    ['doctor', '--schema'],
    ['doctor', '--url', '--json'],
    ['doctor', 'repair'],
  ]) {
    assert.throws(() => assertMssqlDoctorArguments(args, raw), /only|requires a value/);
  }
  assert.throws(() => assertMssqlDoctorArguments({ ...args, positional: ['repair'] }), /no positional/);
  assert.throws(() => assertMssqlDoctorArguments({ ...args, subcommand: 'repair' }), /no positional/);
});

it('requires an active owned catalog token and never calls forged SQL or release methods', async () => {
  let touched = 0;
  const fake = {
    query() {
      touched++;
      throw new Error('caller SQL reached');
    },
    release() {
      touched++;
    },
  };
  await assert.rejects(collectMssqlDoctorReport(fake as never), /active owned catalog/);
  assert.equal(touched, 0);
  const pool = createMssqlToolPool('mssql://host/catalog', 'dbo');
  assert.throws(() => pool.query('SELECT caller_value'), /fixed catalog reads only/);
  await pool.end();
  await assert.rejects(pool.connect(), /closed/);
});

it('honors native namespace identifier bounds before loading an optional driver', async () => {
  const pool = createMssqlToolPool('mssql://host/catalog', 'x'.repeat(128));
  await pool.end();
  for (const schema of ['x'.repeat(129), 'bad\nname', 'bad\0name']) {
    assert.throws(() => createMssqlToolPool('mssql://host/catalog', schema), /schema identifier/);
  }
});
