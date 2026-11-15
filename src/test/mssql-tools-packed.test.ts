/** Real packed outputs and optional peer lifecycle fixtures; no native service claim. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { it } from 'node:test';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
it('checks packed SQL Server catalog lifecycle, strict ESM/CJS declarations and absent optional driver', {
  timeout: 180_000,
}, () => {
  const dir = mkdtempSync(join(tmpdir(), 'turbine-mssql-tools-packed-'));
  const run = (command: string, args: string[], cwd = dir, extra: Record<string, string> = {}) => {
    const result = spawnSync(command, args, {
      cwd,
      encoding: 'utf8',
      timeout: 60_000,
      env: { ...process.env, DATABASE_URL: '', MSSQL_TOOLS_LOG: join(dir, 'events.jsonl'), ...extra },
    });
    assert.equal(result.status, 0, result.stdout + result.stderr + String(result.error ?? ''));
  };
  try {
    const staging = join(dir, 'staging');
    mkdirSync(staging);
    const manifest = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'));
    delete manifest.scripts;
    writeFileSync(join(staging, 'package.json'), JSON.stringify(manifest));
    for (const format of ['esm', 'cjs']) {
      run(
        join(repo, 'node_modules/.bin/tsc'),
        [
          '-p',
          join(repo, format === 'esm' ? 'tsconfig.json' : 'tsconfig.cjs.json'),
          '--outDir',
          join(staging, format === 'esm' ? 'dist' : 'dist/cjs'),
        ],
        repo,
      );
    }
    mkdirSync(join(staging, 'scripts'));
    copyFileSync(join(repo, 'scripts/finish-cjs-build.mjs'), join(staging, 'scripts/finish-cjs-build.mjs'));
    run(process.execPath, [join(staging, 'scripts/finish-cjs-build.mjs')], staging);
    run('npm', ['pack', '--ignore-scripts', '--pack-destination', dir], staging);
    const modules = join(dir, 'node_modules');
    const installed = join(modules, 'turbine-orm');
    mkdirSync(installed, { recursive: true });
    run('tar', ['-xzf', join(dir, `turbine-orm-${manifest.version}.tgz`), '--strip-components=1', '-C', installed]);
    symlinkSync(join(repo, 'node_modules/pg'), join(modules, 'pg'), 'dir');
    const fixture = join(modules, 'mssql');
    mkdirSync(fixture);
    writeFileSync(join(fixture, 'package.json'), '{"name":"mssql","version":"0.0.0","main":"index.cjs"}');
    copyFileSync(join(repo, 'src/test/fixtures/mssql-tools-driver.cjs'), join(fixture, 'index.cjs'));
    for (const format of ['esm', 'cjs']) {
      const path = join(installed, format === 'esm' ? 'dist/cli/mssql-tools.js' : 'dist/cjs/cli/mssql-tools.js');
      for (const mode of [
        '',
        'hostile-schema',
        'connect-fail',
        'connect-delay',
        'pool-error',
        'query-fail',
        'query-delay',
        'close-fail',
      ]) {
        writeFileSync(join(dir, 'events.jsonl'), '');
        run(process.execPath, [join(repo, 'tooling/sql-server-tools/driver-cases.mjs'), path], dir, {
          MSSQL_TOOLS_MODE: mode,
        });
      }
      run(process.execPath, [join(repo, 'tooling/sql-server-tools/integration.mjs'), installed, format]);
      const consumer = join(dir, format);
      mkdirSync(consumer);
      writeFileSync(join(consumer, 'package.json'), JSON.stringify({ type: format === 'esm' ? 'module' : 'commonjs' }));
      const extension = format === 'esm' ? 'mts' : 'cts';
      const source = `
import { createMssqlToolPool, introspectMssqlToolClient, releaseMssqlToolClient } from '../node_modules/turbine-orm/${format === 'esm' ? 'dist' : 'dist/cjs'}/cli/mssql-tools.js';
async function main() {
  const pool = createMssqlToolPool('mssql://host/fixture', 'app');
  const client = await pool.connect();
  const metadata = await introspectMssqlToolClient(client, { include: ['users'] });
  const column: string = metadata.tables.users!.columns[0]!.name;
  if (!column) throw new Error('missing catalog identity');
  await releaseMssqlToolClient(client);
  await pool.end();
}
// @ts-expect-error the catalog read remains asynchronous
const tables = introspectMssqlToolClient({} as never, {}).tables;
void main();
`;
      // Keep the type-only negative assertion out of emitted runtime.
      writeFileSync(
        join(consumer, `usage.${extension}`),
        source.replace(
          'const tables = introspectMssqlToolClient({} as never, {}).tables;',
          'if (false) { const tables = introspectMssqlToolClient({} as never, {}).tables; void tables; }',
        ),
      );
      writeFileSync(
        join(consumer, 'tsconfig.json'),
        JSON.stringify({
          compilerOptions: {
            target: 'ES2023',
            module: 'NodeNext',
            moduleResolution: 'NodeNext',
            strict: true,
            exactOptionalPropertyTypes: true,
            skipLibCheck: false,
            types: ['node'],
            typeRoots: [join(repo, 'node_modules/@types')],
          },
          include: [`usage.${extension}`],
        }),
      );
      run(join(repo, 'node_modules/.bin/tsc'), ['-p', join(consumer, 'tsconfig.json')]);
      run(process.execPath, [join(consumer, `usage.${format === 'esm' ? 'mjs' : 'cjs'}`)]);
      rmSync(fixture, { recursive: true });
      writeFileSync(join(dir, 'events.jsonl'), '');
      run(process.execPath, [join(repo, 'tooling/sql-server-tools/driver-cases.mjs'), path], dir, {
        MSSQL_TOOLS_MODE: 'no-driver',
      });
      mkdirSync(fixture);
      writeFileSync(join(fixture, 'package.json'), '{"name":"mssql","version":"0.0.0","main":"index.cjs"}');
      copyFileSync(join(repo, 'src/test/fixtures/mssql-tools-driver.cjs'), join(fixture, 'index.cjs'));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
