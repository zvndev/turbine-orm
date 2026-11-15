import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createClient } from '@libsql/client/node';
import { assertLibsqlSeedArguments, cmdLibsqlSeed } from '../cli/libsql-seed-command.js';
import { introspectLibsql } from '../libsql/introspect.js';

test('libSQL seed refuses unsupported flags and original tokens before resolving a project', () => {
  const args = { command: 'seed', positional: [], engine: 'libsql' };
  assert.doesNotThrow(() => assertLibsqlSeedArguments(args, ['seed', '--engine', 'libsql', '-v']));
  for (const argv of [
    ['seed', '--engine'],
    ['seed', '--url', '--help'],
    ['seed', '--dry-run'],
    ['seed', '--preview'],
    ['seed', '--schema', 'main'],
    ['seed', 'seed.sql'],
    ['seed', '--url', 'libsql://remote'],
    ['seed', '--url', 'file:local?syncUrl=x'],
    ['seed', '--engine', 'sqlite'],
    ['seed', '--sync-url', 'x'],
  ])
    assert.throws(() => assertLibsqlSeedArguments(args, argv));
  for (const extra of [{ dryRun: true }, { preview: true }, { schema: 'main' }, { syncUrl: 'x' }]) {
    assert.throws(() => assertLibsqlSeedArguments({ ...args, ...extra }), /does not support/);
  }
  assert.throws(() => assertLibsqlSeedArguments({ ...args, positional: ['seed.sql'] }), /positional/);
  assert.throws(() => assertLibsqlSeedArguments({ ...args, url: '' }), /local|Remote/);
});

test('project validation precedes module side effects; SQL files, missing seeds and mismatched URLs refuse', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'turbine-libsql-seed-command-'));
  const seedFile = join(dir, 'seed.mjs');
  const marker = join(dir, 'imported');
  const config = { engine: 'libsql', url: `file:${join(dir, 'existing.db')}`, seedFile };
  const args = { command: 'seed', positional: [], engine: 'libsql' };
  const schema = { tables: {}, enums: {} };
  try {
    await writeFile(
      seedFile,
      `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'imported'); export default () => {};`,
    );
    await assert.rejects(
      cmdLibsqlSeed(args, config, async () => {
        throw new Error('project prerequisite missing');
      }),
      /prerequisite/,
    );
    await assert.rejects(readFile(marker), /ENOENT/);
    await assert.rejects(
      cmdLibsqlSeed(args, config, async () => ({ url: 'file:other.db', schema })),
      /must match/,
    );
    await assert.rejects(readFile(marker), /ENOENT/);
    const sql = join(dir, 'seed.sql');
    await writeFile(sql, 'SELECT 1');
    await assert.rejects(
      cmdLibsqlSeed(args, { ...config, seedFile: sql }, async () => assert.fail('must not resolve')),
      /SQL seed files/,
    );
    await assert.rejects(
      cmdLibsqlSeed(args, { ...config, seedFile: join(dir, 'missing.mjs') }, async () =>
        assert.fail('must not resolve'),
      ),
      /not found/,
    );
    await assert.rejects(
      cmdLibsqlSeed(args, { ...config, engine: 'sqlite' }, async () => assert.fail('must not resolve')),
      /engine libsql/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('command imports ESM/CJS/TS callback modules, persists writes, and rolls back failures', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'turbine-libsql-seed-modules-'));
  const url = `file:${join(dir, 'data.db')}`;
  const initial = createClient({ url, intMode: 'bigint' });
  await initial.execute('CREATE TABLE items(id INTEGER PRIMARY KEY, label TEXT)');
  initial.close();
  const schema = await introspectLibsql(url);
  const args = { command: 'seed', positional: [], engine: 'libsql' };
  const resolveProject = async () => ({ url, schema });
  try {
    for (const [id, ext] of ['mjs', 'cjs', 'mts', 'cts', 'js', 'ts'].entries()) {
      const seedFile = join(dir, `seed.${ext}`);
      const prefix = ext === 'cjs' || ext === 'cts' || ext === 'js' ? 'module.exports =' : 'export default';
      await writeFile(
        seedFile,
        `${prefix} async (tx) => { await tx.rawUnsafe('INSERT INTO items VALUES($1, $2)', ${id}, '${ext}'); };`,
      );
      await cmdLibsqlSeed(args, { engine: 'libsql', url, seedFile }, resolveProject);
    }
    const seedFile = join(dir, 'failure.mjs');
    await writeFile(
      seedFile,
      "export default async tx => { await tx.rawUnsafe(\"INSERT INTO items VALUES(99, 'rollback')\"); throw new Error('callback failed'); }",
    );
    await assert.rejects(cmdLibsqlSeed(args, { engine: 'libsql', url, seedFile }, resolveProject), /callback failed/);
    const invalid = join(dir, 'invalid.mjs');
    await writeFile(invalid, 'export default 42;');
    await assert.rejects(cmdLibsqlSeed(args, { engine: 'libsql', url, seedFile: invalid }, resolveProject), /callable/);
    const verify = createClient({ url, intMode: 'bigint' });
    try {
      assert.deepEqual(
        (await verify.execute('SELECT label FROM items ORDER BY id')).rows.map((row) => row[0]),
        ['mjs', 'cjs', 'mts', 'cts', 'js', 'ts'],
      );
    } finally {
      verify.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
