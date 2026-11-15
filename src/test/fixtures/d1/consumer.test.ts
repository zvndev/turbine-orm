import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { generateIndex, generateMetadata, generateTypes } from '../../../generate.js';
import { schemaDefToMetadata } from '../../../schema-metadata.js';
import { unpackD1 } from './packed.js';
import { definition } from './schema.js';

// Positive consumers execute the actual archive without export overlays.
test('D1 generated ESM/CJS consumers have strict types and execute with irrelevant drivers omitted', () => {
  const root = mkdtempSync(join(tmpdir(), 'turbine-d1-consumer-'));
  try {
    const destination = unpackD1(root);
    const manifest = JSON.parse(readFileSync(join(destination, 'package.json'), 'utf8'));
    const d1Export = manifest.exports['./d1'];
    // Only Node declarations are available. No pg, optional engines or Worker runtime dependency.
    mkdirSync(join(root, 'node_modules/@types'), { recursive: true });
    symlinkSync(resolve('node_modules/@types/node'), join(root, 'node_modules/@types/node'));
    symlinkSync(resolve('node_modules/undici-types'), join(root, 'node_modules/undici-types'));
    const workers = process.env.TURBINE_D1_WORKERS_TYPES_DIR ?? resolve('node_modules/@cloudflare/workers-types');
    mkdirSync(join(root, 'node_modules/@cloudflare'), { recursive: true });
    symlinkSync(workers, join(root, 'node_modules/@cloudflare/workers-types'));
    const schema = schemaDefToMetadata(definition);
    for (const format of ['module', 'commonjs']) {
      const directory = join(root, format);
      mkdirSync(join(directory, 'generated'), { recursive: true });
      writeFileSync(join(directory, 'package.json'), JSON.stringify({ type: format }));
      writeFileSync(join(directory, 'generated/index.ts'), generateIndex(schema));
      writeFileSync(join(directory, 'generated/types.ts'), generateTypes(schema));
      writeFileSync(join(directory, 'generated/metadata.ts'), generateMetadata(schema));
      const consumer = `import { turbineD1, type D1DatabaseBinding } from 'turbine-orm/d1';
import type { D1Database } from '@cloudflare/workers-types';
import type { TurbineClient } from './generated/index.js';
import { SCHEMA } from './generated/metadata.js';
declare const binding: D1Database;
const shape: D1DatabaseBinding = binding;
void shape;
const db = turbineD1<TurbineClient>(binding, SCHEMA);
async function run() {
  const rows = await db.users.findMany({ select: { name: true }, with: { posts: { select: { title: true } } } });
  const name: string = rows[0]!.name;
  const title: string = rows[0]!.posts[0]!.title;
  // @ts-expect-error selecting name does not expose active
  rows[0]!.active;
  const [created, count] = await db.$batch([db.posts.buildCreate({ data: { userId: 1, title: 'Hi', visible: true } }), db.users.buildCount()]);
  const id: number = created.id;
  const total: number = count;
  // @ts-expect-error generated relation result retains its string field type
  const wrong: number = rows[0]!.posts[0]!.title;
  // @ts-expect-error generated create requires title
  db.posts.create({ data: { userId: 1, visible: true } });
  return {name, title, id, total};
}
void run;
`;
      writeFileSync(join(directory, 'consumer.ts'), consumer);
      const args = [
        '--strict',
        '--skipLibCheck',
        'false',
        '--noEmit',
        '--module',
        'NodeNext',
        '--moduleResolution',
        'NodeNext',
        '--target',
        'ES2023',
        '--types',
        'node',
        join(directory, 'consumer.ts'),
      ];
      execFileSync(process.execPath, [resolve('node_modules/typescript/bin/tsc'), ...args], {
        cwd: root,
        encoding: 'utf8',
        stdio: 'pipe',
      });
      // Omission control: without the D1 export, the same consumer must not typecheck.
      delete manifest.exports['./d1'];
      writeFileSync(join(destination, 'package.json'), JSON.stringify(manifest));
      const absent = spawnSync(process.execPath, [resolve('node_modules/typescript/bin/tsc'), ...args], {
        cwd: root,
        encoding: 'utf8',
      });
      assert.notEqual(absent.status, 0);
      assert.match(absent.stdout, /Cannot find module 'turbine-orm\/d1'/);
      manifest.exports['./d1'] = d1Export;
      writeFileSync(join(destination, 'package.json'), JSON.stringify(manifest));
      const extension = format === 'module' ? 'mjs' : 'cjs';
      const script = `${format === 'module' ? "import { turbineD1 } from 'turbine-orm/d1';" : "const { turbineD1 } = require('turbine-orm/d1');"}
const assert = ${format === 'module' ? "(await import('node:assert/strict')).default" : "require('node:assert/strict')"};
const requireDriver = ${format === 'module' ? "(await import('node:module')).createRequire(import.meta.url)" : 'require'};
for (const driver of ['pg','pg-pool','pg-types','mysql2','mssql','@neondatabase/serverless','@libsql/client','miniflare']) assert.throws(() => requireDriver(driver), {code:'MODULE_NOT_FOUND'});
const binding = { prepare() { return { bind() { return this; }, async all() { return {success:true,results:[{count:2}],meta:{changes:0,duration:0,last_row_id:0}}; } }; }, async batch(statements) { return Promise.all(statements.map(s=>s.all())); } };
(async()=> { const db = turbineD1(binding, ${JSON.stringify(schema)}, {warnOnUnlimited:false});
if (await db.table('users').count() !== 2) throw new Error('count mismatch');
await db.disconnect(); process.stdout.write('D1_CONSUMER_OK'); })().catch(e=>{console.error(e);process.exitCode=1;});`;
      const path = join(directory, `runtime.${extension}`);
      writeFileSync(path, script);
      assert.equal(
        execFileSync(process.execPath, [path], { cwd: root, encoding: 'utf8', stdio: 'pipe' }),
        'D1_CONSUMER_OK',
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
