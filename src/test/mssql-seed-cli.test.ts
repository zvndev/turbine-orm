import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, it } from 'node:test';
import { resolveConfig } from '../cli/config.js';
import type { CliArgs } from '../cli/index.js';
import { assertMssqlSeedArguments, cmdMssqlSeed } from '../cli/mssql-seed.js';

const inheritedDatabaseUrl = process.env.DATABASE_URL;
beforeEach(() => {
  delete process.env.DATABASE_URL;
});
afterEach(() => {
  if (inheritedDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = inheritedDatabaseUrl;
});

const args: CliArgs = { command: 'seed', positional: [] };
it('refuses positional/SQL/preview/control flags and missing operands before importing user code', async () => {
  for (const extra of [
    { subcommand: 'seed.js' },
    { positional: ['seed.js'] },
    { dryRun: true },
    { force: true },
    { schemaFile: './schema.ts' },
    { url: '' },
    { schema: '' },
  ]) {
    assert.throws(() => assertMssqlSeedArguments({ ...args, ...extra }), /seed.*(?:support|positional|requires)/);
  }
  for (const tokens of [
    ['seed', '--url', '--verbose'],
    ['seed', '--schema'],
    ['s', '-s', '-v'],
    ['seed', 'seed.js'],
    ['seed', '--preview'],
  ]) {
    assert.throws(() => assertMssqlSeedArguments(args, tokens), /seed.*(?:requires|takes)/);
  }
  assert.doesNotThrow(() =>
    assertMssqlSeedArguments({ ...args, schema: 'app' }, ['seed', '--engine', 'mssql', '-s', 'app', '-v']),
  );
  const dir = mkdtempSync(join(tmpdir(), 'turbine-seed-refusal-'));
  let imported = false;
  const importer = async () => {
    imported = true;
    throw new Error('must never import');
  };
  try {
    const config = resolveConfig(
      { engine: 'mssql', url: 'mssql://localhost/disposable', seedFile: join(dir, 'seed.sql') },
      {},
    );
    await assert.rejects(cmdMssqlSeed(args, config, importer), /not found/);
    writeFileSync(join(dir, 'seed.sql'), 'COMMIT; DROP TABLE users;');
    await assert.rejects(cmdMssqlSeed(args, config, importer), /SQL files are not supported/);
    await assert.rejects(cmdMssqlSeed({ ...args, dryRun: true }, config, importer), /does not support/);
    assert.equal(imported, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
