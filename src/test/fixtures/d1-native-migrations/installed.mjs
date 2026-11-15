/** Strict generated consumers using actual package maps and the same owned native D1 proxy. */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { generateD1Files } from '../../../d1/generate.ts';
import { schemaDefToMetadata } from '../../../schema-metadata.ts';
import { definition } from '../d1/schema.ts';

export async function installedConsumers(db, library) {
  const root = dirname(dirname(library));
  for (const name of ['@types/node', 'undici-types', '@cloudflare/workers-types']) {
    const path = join(root, 'node_modules', name);
    mkdirSync(dirname(path), { recursive: true });
    symlinkSync(resolve('node_modules', name), path);
  }
  const files = generateD1Files(schemaDefToMetadata(definition), {});
  const results = [];
  for (const [format, extension] of [
    ['module', 'mjs'],
    ['commonjs', 'cjs'],
  ]) {
    const directory = join(root, `generated-${format}`);
    mkdirSync(join(directory, 'generated'), { recursive: true });
    writeFileSync(join(directory, 'package.json'), JSON.stringify({ type: format }));
    for (const [name, content] of Object.entries(files)) writeFileSync(join(directory, 'generated', name), content);
    writeFileSync(
      join(directory, 'consumer.ts'),
      `import { migrateD1, type D1Migration, type D1MigrationReport } from 'turbine-orm/d1/migrate';
import type { D1Database } from '@cloudflare/workers-types';
import { turbine } from './generated/index.js';
export {migrateD1};
export async function run(binding: D1Database) {
  const plan: readonly D1Migration[] = [{id:'0001_generated',statements:[
    'CREATE TABLE users(id INTEGER PRIMARY KEY,name TEXT NOT NULL,active INTEGER NOT NULL,profile TEXT,created_at TEXT NOT NULL,payload BLOB)',
    'CREATE TABLE posts(id INTEGER PRIMARY KEY,user_id INTEGER NOT NULL REFERENCES users(id),title TEXT NOT NULL,visible INTEGER NOT NULL)'
  ]}];
  const report: D1MigrationReport = await migrateD1(binding,plan);
  const db = turbine(binding,{warnOnUnlimited:false});
  const user = await db.users.create({data:{id:1,name:'Generated',active:true,createdAt:new Date('2026-01-02T03:04:05Z')}});
  const name: string = user.name;
  const [count,rows] = await db.$batch([db.users.buildCount(),db.users.buildFindMany({select:{name:true}})]);
  const n: number = count;
  const exact: string = rows[0]!.name;
  // @ts-expect-error selected result does not expose active
  rows[0]!.active;
  // @ts-expect-error migrations are not callbacks
  const invalid: D1Migration = {id:'0001_bad',statements:()=>undefined};
  void invalid;
  await db.disconnect();
  const retry = await migrateD1(binding,plan);
  const stillOwned = await binding.prepare('SELECT name FROM users').all();
  return {name,n,exact,applied:report.applied,retry:retry.applied,stillOwned:stillOwned.results};
}
`,
    );
    const args = [
      resolve('node_modules/typescript/bin/tsc'),
      '--strict',
      '--skipLibCheck',
      'false',
      '--module',
      'NodeNext',
      '--moduleResolution',
      'NodeNext',
      '--target',
      'ES2023',
      '--types',
      'node',
      '--outDir',
      join(directory, 'out'),
      join(directory, 'consumer.ts'),
    ];
    execFileSync(process.execPath, args, { cwd: root, encoding: 'utf8', timeout: 40_000 });
    const floorCompiler = process.env.D1_MIGRATION_TSC59;
    assert(floorCompiler, 'Pinned TypeScript 5.9.3 compiler required');
    assert.match(execFileSync(process.execPath, [floorCompiler, '--version'], { encoding: 'utf8' }), /5\.9\.3/);
    execFileSync(process.execPath, [floorCompiler, ...args.slice(1)], { cwd: root, encoding: 'utf8', timeout: 40_000 });
    const manifestPath = join(library, 'package.json');
    const original = readFileSync(manifestPath, 'utf8');
    const manifest = JSON.parse(original);
    delete manifest.exports['./d1/migrate'];
    try {
      writeFileSync(manifestPath, JSON.stringify(manifest));
      const control = spawnSync(process.execPath, [...args, '--noEmit'], {
        cwd: root,
        encoding: 'utf8',
        timeout: 40_000,
      });
      assert.notEqual(control.status, 0, 'omitting the optional export must fail');
      assert.match(control.stdout, /Cannot find module 'turbine-orm\/d1\/migrate'/);
    } finally {
      writeFileSync(manifestPath, original);
    }
    const consumer = join(directory, 'out/consumer.js');
    const api =
      extension === 'mjs' ? await import(pathToFileURL(consumer).href) : createRequire(import.meta.url)(consumer);
    const result = await api.run(db);
    assert.deepEqual(result, {
      name: 'Generated',
      n: 1,
      exact: 'Generated',
      applied: ['0001_generated'],
      retry: [],
      stillOwned: [{ name: 'Generated' }],
    });
    for (const table of ['posts', 'users', '_turbine_d1_migrations']) await db.prepare(`DROP TABLE ${table}`).all();
    results.push({ format, strictTypes: ['6.0.3', '5.9.3'], omissionControl: true, native: result });
  }
  return results;
}
