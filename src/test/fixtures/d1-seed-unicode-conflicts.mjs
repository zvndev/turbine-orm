/** Installed public-CLI controls for Unicode seed conflict targets. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import net from 'node:net';
import { join, resolve } from 'node:path';
import { command } from '../../../tooling/optional-pg-transports/harness.mjs';
import { runWithShutdown } from '../../../tooling/optional-pg-transports/run.mjs';

const [output, installedConsumer] = process.argv.slice(2);
assert(output && installedConsumer);
const root = resolve(output),
  consumer = resolve(installedConsumer);
assert(!existsSync(root));
mkdirSync(root, { recursive: true });
const require = createRequire(join(consumer, 'package.json'));
const { Miniflare } = require('miniflare');
assert.equal(require('miniflare/package.json').version, '4.20260730.0');
const pkg = join(consumer, 'node_modules/turbine-orm');
const report = { node: process.version, commands: [], cells: [], ports: [] };
const hash = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const snapshot = (path, prefix = '') =>
  Object.fromEntries(
    readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
      const full = join(path, entry.name),
        name = prefix + entry.name;
      return entry.isDirectory() ? Object.entries(snapshot(full, `${name}/`)) : [[name, hash(full)]];
    }),
  );
async function free(port) {
  const server = net.createServer();
  await new Promise((ok, fail) => {
    server.once('error', fail);
    server.listen(port, '127.0.0.1', ok);
  });
  await new Promise((ok) => server.close(ok));
  report.ports.push({ port, phase: 'rebind-or-prelaunch' });
}
await runWithShutdown(report, join(root, 'report.json'), async (scope) => {
  for (const [format, port] of [
    ['esm', 60541],
    ['cjs', 60542],
  ]) {
    await free(port);
    const project = join(root, format),
      state = join(project, 'state');
    mkdirSync(project);
    symlinkSync(join(consumer, 'node_modules'), join(project, 'node_modules'), 'dir');
    writeFileSync(join(project, 'package.json'), '{"type":"module"}');
    writeFileSync(
      join(project, 'turbine.config.mjs'),
      `export default ${JSON.stringify({ engine: 'd1', d1: { binding: 'DB', databaseId: `direct-${format}`, persist: './state' }, migrationsDir: './migrations', out: './generated' })}`,
    );
    const cli = join(pkg, 'dist', ...(format === 'cjs' ? ['cjs'] : []), 'cli/index.js');
    const cell = { format, cli, cliSha256: hash(cli), checks: [], reopens: [] };
    report.cells.push(cell);
    const run = (args, env = {}) =>
      command(
        report,
        project,
        process.execPath,
        [cli, ...args],
        { ...process.env, ...env },
        { scope, timeoutMs: 120000 },
      );
    const refuse = async (args, pattern, env) => {
      let refused = false;
      try {
        await run(args, env);
      } catch {
        refused = true;
      }
      assert(refused);
      const result = report.commands.at(-1);
      assert.match(result.stdout + result.stderr, pattern);
    };
    const reopen = async (check) => {
      await free(port);
      console.info(`D1 seed Unicode/conflict native root ${state}; loopback ${port} before launch.`);
      const mf = new Miniflare({
        cf: false,
        modules: true,
        script: 'export default {fetch(){return new Response("ready")}}',
        compatibilityDate: '2026-01-01',
        host: '127.0.0.1',
        port,
        inspectorPort: 0,
        d1Databases: { DB: `direct-${format}` },
        d1Persist: state,
      });
      try {
        const origin = String(await mf.ready);
        cell.reopens.push({ origin, port });
        await check(await mf.getD1Database('DB'));
      } finally {
        await mf.dispose();
        await free(port);
      }
    };
    const plan = (table, rows) => ({ version: 1, operations: [{ table, columns: ['id', 'label'], rows }] });
    const seed = (value) => writeFileSync(join(project, 'migrations/seed.json'), JSON.stringify(value));
    await run(['init', '--yes']);
    writeFileSync(
      join(project, 'migrations/plan.json'),
      JSON.stringify([
        {
          id: '0001_conflicts',
          statements: [
            'CREATE TABLE replacing(id INTEGER PRIMARY KEY,label TEXT UNIQUE ON CONFLICT REPLACE)',
            'CREATE TABLE ignoring(id INTEGER PRIMARY KEY,label TEXT UNIQUE ON CONFLICT IGNORE)',
            "CREATE TABLE notnulls(id INTEGER PRIMARY KEY,label TEXT NOT NULL ON CONFLICT REPLACE DEFAULT 'fallback')",
            'CREATE TABLE primary_replacing(id INTEGER PRIMARY KEY ON CONFLICT REPLACE,label TEXT)',
          ],
        },
      ]),
    );
    await run(['migrate', 'deploy']);
    for (const table of ['replacing', 'ignoring', 'notnulls', 'primary_replacing']) {
      seed(plan(table, [[100, 'resident']]));
      assert.deepEqual(JSON.parse((await run(['seed'])).trim().split('\n').at(-1)), { insertedRows: 1, statements: 1 });
    }
    for (const [table, rows] of [
      [
        'replacing',
        [
          [1, 'same'],
          [2, 'same'],
        ],
      ],
      [
        'replacing',
        [
          [1, 'fresh'],
          [2, 'resident'],
        ],
      ],
      [
        'ignoring',
        [
          [1, 'fresh'],
          [2, 'resident'],
        ],
      ],
      [
        'notnulls',
        [
          [1, 'fresh'],
          [2, null],
        ],
      ],
      [
        'primary_replacing',
        [
          [1, 'fresh'],
          [100, 'overwrite'],
        ],
      ],
    ]) {
      seed(plan(table, rows));
      await refuse(['seed'], /outcome is unknown/);
      await reopen(async (db) =>
        assert.deepEqual((await db.prepare(`SELECT * FROM ${table} ORDER BY id`).all()).results, [
          { id: 100, label: 'resident' },
        ]),
      );
      cell.checks.push(`rollback-preserves-all-${table}`);
    }
    for (const label of ['\ud800', '\udfff', 'lone-\ud800-tail', '\udc00\ud800']) {
      seed(plan('replacing', [[9, label]]));
      const before = snapshot(state),
        input = readFileSync(join(project, 'migrations/seed.json'));
      await refuse(['seed'], /well-formed UTF-16/, { MINIFLARE_WORKERD_PATH: join(project, 'missing-workerd') });
      assert.deepEqual(snapshot(state), before);
      assert.deepEqual(readFileSync(join(project, 'migrations/seed.json')), input);
    }
    cell.checks.push('lone-surrogate-before-runtime-zero-persistent-effects');
    const values = ['\0snow☃', '\ud800\udc00', '\udbff\udfff', '�', 'e\u0301'];
    seed(
      plan(
        'replacing',
        values.map((label, index) => [index + 1, label]),
      ),
    );
    assert.deepEqual(JSON.parse((await run(['s'])).trim().split('\n').at(-1)), {
      insertedRows: values.length,
      statements: values.length,
    });
    await reopen(async (db) =>
      assert.deepEqual(
        (await db.prepare('SELECT id,label,hex(label) AS bytes FROM replacing WHERE id < 100 ORDER BY id').all())
          .results,
        values.map((label, index) => ({
          id: index + 1,
          label,
          bytes: Buffer.from(label).toString('hex').toUpperCase(),
        })),
      ),
    );
    cell.checks.push('unicode-pairs-nul-replacement-character-exact-native-bytes');
    assert(!existsSync(join(state, '.turbine-d1.lock')));
  }
  for (const port of [60541, 60542]) {
    await new Promise((ok, fail) => {
      const socket = net.connect(port, '127.0.0.1');
      socket.once('connect', () => {
        socket.destroy();
        fail(new Error(`listener remains ${port}`));
      });
      socket.once('error', (error) => {
        assert.equal(error.code, 'ECONNREFUSED');
        ok();
      });
    });
    await free(port);
  }
});
