import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [format, root] = process.argv.slice(2);
assert.ok(['esm', 'cjs'].includes(format) && root);
const req = createRequire(join(process.cwd(), 'consumer.cjs'));
const packagePath = join(process.cwd(), 'node_modules/turbine-orm/package.json');
const manifest = JSON.parse(readFileSync(packagePath, 'utf8'));
const target = join(packagePath, '..', manifest.exports['./sqlite'][format === 'esm' ? 'import' : 'require'].default);
const api = format === 'esm' ? await import(pathToFileURL(target)) : req('turbine-orm/sqlite');
assert.equal(typeof api.turbineSqlite, 'function');
if (format === 'cjs') assert.equal(req.resolve('turbine-orm/sqlite'), target);
// The compiled fixture statically imports the same condition. No require.resolve-to-import fallback.
const contracts = join(process.cwd(), format, 'src/test/fixtures/sqlite-durable-replay/contracts.js');
process.env.REPLAY_FORMAT = format;
process.env.REPLAY_EXAMPLE_ROOT = join(process.cwd(), format, 'examples/sqlite-durable-replay');
const module = format === 'esm' ? await import(pathToFileURL(contracts)) : req(contracts);
const groups = await module.runContracts(root);
assert.equal(groups.length, 12);
const esmApp = await import(pathToFileURL(join(process.cwd(), 'esm/examples/sqlite-durable-replay/replay.js')));
const cjsApp = req(join(process.cwd(), 'cjs/examples/sqlite-durable-replay/replay.js'));
mkdirSync(root);
const firstRaw = module.open(join(root, 'mixed.db')),
  secondRaw = module.open(join(root, 'mixed.db'));
const first = new esmApp.SqliteOrderReplay(firstRaw),
  second = new cjsApp.SqliteOrderReplay(secondRaw);
try {
  assert.throws(() => new cjsApp.SqliteOrderReplay(firstRaw), /owner/);
  await first.initialize();
  await first.append(module.command(1));
  await first.consumeBatch('a', 'mixed', async () => {
    await assert.rejects(
      second.consumeBatch('a', 'mixed', () => {}),
      /reenter/,
    );
  });
  assert.equal(await second.checkpoint('a', 'mixed'), '1');
} finally {
  await first.close();
  await second.close();
  firstRaw.close();
  secondRaw.close();
  rmSync(root, { recursive: true, force: true });
}
groups.push('mixed ESM/CJS copies share handle ownership and callback reentry');
console.log(JSON.stringify({ format, node: process.version, sqlite: process.versions.sqlite, target, groups }));
