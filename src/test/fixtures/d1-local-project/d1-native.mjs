/** Actual installed D1 binding, generated clients, migration parity and fault controls. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runD1MigrationContract } from '../d1-native-migrations/contract.ts';

export async function nativeProof({ root, consumer, project, library, run, report }) {
  const require = createRequire(join(consumer, 'package.json'));
  const { Miniflare } = require('miniflare');
  const { build } = require('esbuild');
  const migrate = require('turbine-orm/d1/migrate');
  const status = require(join(library, 'dist/cjs/cli/d1-migrations.js'));
  const executable = createRequire(require.resolve('miniflare'))('workerd').default;
  const workerd = (await run(consumer, ['--version'], executable)).trim();
  const evidence = {
    workerd,
    workerdPath: executable,
    workerdSha256: createHash('sha256').update(readFileSync(executable)).digest('hex'),
    node: process.version,
    ports: [],
    formats: [],
    parity: [],
    disposed: false,
  };
  async function runtime(
    persist,
    script = 'export default {fetch(){return new Response("ready")}}',
    id = 'turbine-local',
  ) {
    const probe = createServer();
    await new Promise((ok, fail) => {
      probe.once('error', fail);
      probe.listen(0, '127.0.0.1', ok);
    });
    const port = probe.address().port;
    await new Promise((ok) => probe.close(ok));
    console.log(
      `D1 native owned service before launch: ${persist}, DB=${id}, 127.0.0.1:${port}; inspector 127.0.0.1:0`,
    );
    evidence.ports.push(port);
    return new Miniflare({
      modules: true,
      script,
      compatibilityDate: '2026-01-01',
      compatibilityFlags: ['nodejs_compat'],
      d1Databases: { DB: id },
      d1Persist: persist,
      host: '127.0.0.1',
      port,
      inspectorPort: 0,
    });
  }
  const configGraph = await build({
    entryPoints: [join(library, 'dist/cli/config.js')],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'esm',
    packages: 'external',
    metafile: true,
  });
  const configInputs = Object.keys(configGraph.metafile.inputs);
  assert(configInputs.some((p) => p.endsWith('/cli/d1-config.js')));
  assert(
    !configInputs.some((p) =>
      /d1-local|d1-project|optional-peer|d1\/(?:migrate|generate|introspect)|miniflare/.test(p),
    ),
  );
  writeFileSync(join(root, 'config-only-graph.json'), JSON.stringify(configGraph.metafile, null, 2));
  evidence.configOnlyNoRuntimeGraph = true;
  let mf;
  try {
    mf = await runtime(join(project, '.turbine/d1'));
    let binding = await mf.getD1Database('DB');
    const expected = [
      { id: 1, label: 'first' },
      { id: 2, label: 'second' },
    ];
    assert.deepEqual((await binding.prepare('SELECT * FROM items ORDER BY id').all()).results, expected);
    for (const format of ['module', 'commonjs']) {
      const directory = join(consumer, `strict-${format}`);
      mkdirSync(join(directory, 'generated'), { recursive: true });
      writeFileSync(join(directory, 'package.json'), JSON.stringify({ type: format }));
      for (const name of ['index.ts', 'metadata.ts', 'types.ts'])
        copyFileSync(join(project, 'generated-next', name), join(directory, 'generated', name));
      writeFileSync(
        join(directory, 'consumer.ts'),
        `import type {D1Database} from '@cloudflare/workers-types';import {turbine} from './generated/index.js';\nexport async function run(binding:D1Database){const db=turbine(binding,{warnOnUnlimited:false});const rows=await db.items.findMany({orderBy:{id:'asc'}});const label:string=rows[0]!.label;void label;\n// @ts-expect-error D1 generated row has no missing field\nrows[0]!.missing;\nawait db.disconnect();return rows;}\n`,
      );
      const args = [
        join(consumer, 'node_modules/typescript/bin/tsc'),
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
      await run(consumer, args);
      const api =
        format === 'module'
          ? await import(pathToFileURL(join(directory, 'out/consumer.js')).href)
          : require(join(directory, 'out/consumer.js'));
      assert.deepEqual(await api.run(binding), expected);
      const worker = join(directory, 'worker.mjs');
      writeFileSync(
        worker,
        "import {run} from './out/consumer.js';export default {async fetch(_req,env){return Response.json(await run(env.DB))}};",
      );
      const bundle = await build({
        entryPoints: [worker],
        bundle: true,
        write: false,
        format: 'esm',
        platform: 'neutral',
        conditions: ['workerd'],
        metafile: true,
        plugins: [
          {
            name: 'builtin-bridge',
            setup(b) {
              b.onResolve({ filter: /^node:async_hooks$/ }, (a) =>
                a.namespace === 'builtin-bridge'
                  ? { path: a.path, external: true }
                  : { path: a.path, namespace: 'builtin-bridge' },
              );
              b.onLoad({ filter: /.*/, namespace: 'builtin-bridge' }, () => ({
                contents: "export {AsyncLocalStorage} from 'node:async_hooks';",
                loader: 'js',
              }));
            },
          },
        ],
      });
      const inputs = Object.keys(bundle.metafile.inputs);
      assert(inputs.some((p) => p.endsWith(format === 'module' ? '/dist/d1.js' : '/dist/cjs/d1.js')));
      assert(!inputs.some((p) => /node_modules\/(pg|pg-[^/]+|miniflare|@libsql|mysql2|mssql)\//.test(p)));
      writeFileSync(join(root, `generated-${format}-graph.json`), JSON.stringify(bundle.metafile, null, 2));
      await mf.dispose();
      mf = await runtime(join(project, '.turbine/d1'), bundle.outputFiles[0].text);
      const response = await mf.dispatchFetch('http://localhost/');
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), expected);
      binding = await mf.getD1Database('DB');
      evidence.formats.push({ format, strict: true, skipLibCheck: false, installedNode: true, workerd: true });
    }
    await mf.dispose();
    mf = await runtime(
      join(root, 'native-contract'),
      'export default {fetch(){return new Response("ready")}}',
      'd1-local-project-contract',
    );
    binding = await mf.getD1Database('DB');
    evidence.reviewedContract = await runD1MigrationContract(binding, migrate.migrateD1);
    assert.equal(evidence.reviewedContract.count, 18);
    const plan = [
      { id: '0001_items', statements: ['CREATE TABLE items(id INTEGER PRIMARY KEY,label TEXT)'] },
      { id: '0002_row', statements: ["INSERT INTO items VALUES(1,'one')"] },
    ];
    const first = await status.inspectD1Migrations(binding, plan);
    assert.equal(first.historyState, 'uninitialized');
    assert.deepEqual(
      (await binding.prepare("SELECT name FROM sqlite_schema WHERE name='_turbine_d1_migrations'").all()).results,
      [],
    );
    await migrate.migrateD1(binding, plan);
    assert.deepEqual(
      (await status.inspectD1Migrations(binding, plan)).applied,
      (await migrate.migrateD1(binding, plan)).alreadyApplied,
    );
    const positive = await status.inspectD1Migrations(binding, plan);
    evidence.parity.push({ case: 'canonical', status: positive });
    for (const changed of [
      plan.slice(0, 1),
      [{ ...plan[0], statements: ['CREATE TABLE items(id INTEGER PRIMARY KEY,label TEXT NOT NULL)'] }, plan[1]],
      [plan[1], plan[0]],
      [...plan, { id: '0003_bad', statements: ['PRAGMA user_version=2'] }],
    ]) {
      await assert.rejects(status.inspectD1Migrations(binding, changed));
      await assert.rejects(migrate.migrateD1(binding, changed));
    }
    evidence.parity.push({ case: 'missing/changed/reordered/invalid-pending', refusedByBoth: true });
    const journal = (await binding.prepare('SELECT * FROM _turbine_d1_migrations ORDER BY position').all()).results;
    for (const mutation of [
      'DELETE FROM _turbine_d1_migrations WHERE position=2',
      "UPDATE _turbine_d1_migrations SET checksum=printf('%064d',0) WHERE position=0",
      'UPDATE _turbine_d1_migrations SET position=5 WHERE position=2',
      "UPDATE _turbine_d1_migrations SET id='0009_changed' WHERE position=2",
    ]) {
      await binding.prepare(mutation).all();
      await assert.rejects(status.inspectD1Migrations(binding, plan));
      await assert.rejects(migrate.migrateD1(binding, plan));
      await binding.prepare('DELETE FROM _turbine_d1_migrations').all();
      for (const row of journal)
        await binding
          .prepare('INSERT INTO _turbine_d1_migrations VALUES(?,?,?)')
          .bind(row.position, row.id, row.checksum)
          .all();
    }
    evidence.parity.push({ case: 'deleted-suffix/head/gap/id-tamper', refusedByBoth: true });
    await binding.prepare('CREATE TRIGGER user_trigger AFTER INSERT ON items BEGIN SELECT 1; END').all();
    await assert.rejects(status.inspectD1Migrations(binding, plan));
    await assert.rejects(migrate.migrateD1(binding, plan));
    await binding.prepare('DROP TRIGGER user_trigger').all();
    const canonicalSql = (
      await binding.prepare("SELECT sql FROM sqlite_schema WHERE name='_turbine_d1_migrations'").all()
    ).results[0].sql;
    await binding.prepare('DROP TABLE _turbine_d1_migrations').all();
    await binding.prepare('CREATE TABLE _turbine_d1_migrations(position INTEGER,id TEXT,checksum TEXT)').all();
    await assert.rejects(status.inspectD1Migrations(binding, plan), /schema mismatch/);
    await assert.rejects(migrate.migrateD1(binding, plan));
    await binding.prepare('DROP TABLE _turbine_d1_migrations').all();
    await binding.prepare(canonicalSql).all();
    for (const row of journal)
      await binding
        .prepare('INSERT INTO _turbine_d1_migrations VALUES(?,?,?)')
        .bind(row.position, row.id, row.checksum)
        .all();
    evidence.parity.push({ case: 'noncanonical-journal-schema', refusedByBoth: true });
    const reads = [];
    const traced = {
      prepare(sql) {
        reads.push(sql);
        return binding.prepare(sql);
      },
      batch(statements) {
        return binding.batch(statements);
      },
    };
    await status.inspectD1Migrations(traced, plan);
    assert(reads.every((sql) => sql.startsWith('SELECT ')));
    evidence.readOnlySql = true;
    await assert.rejects(
      status.inspectD1Migrations(
        {
          prepare: (sql) => binding.prepare(sql),
          batch: async (statements) => (await binding.batch(statements)).slice(1),
        },
        plan,
      ),
      /could not be read/,
    );
    const next = [...plan, { id: '0003_next', statements: ["INSERT INTO items VALUES(2,'two')"] }];
    await assert.rejects(
      migrate.migrateD1(
        {
          prepare: (sql) => binding.prepare(sql),
          batch: async (statements) => (await binding.batch(statements)).slice(1),
        },
        next,
      ),
      (e) => e.outcome === 'unknown',
    );
    assert.deepEqual(
      (await status.inspectD1Migrations(binding, next)).applied,
      next.map((p) => p.id),
    );
    assert.deepEqual((await migrate.migrateD1(binding, next)).applied, []);
    evidence.partialResponseReconciled = true;
    // Discovery races must refuse; no writes are smuggled into the status wrapper.
    let raced = false;
    const racing = {
      prepare(sql) {
        const prepared = binding.prepare(sql);
        if (raced) return prepared;
        return {
          bind: (...values) => prepared.bind(...values),
          async all() {
            const result = await prepared.all();
            if (!raced) {
              raced = true;
              await binding.prepare('CREATE TABLE raced(id INTEGER PRIMARY KEY)').all();
            }
            return result;
          },
        };
      },
      batch: (statements) => binding.batch(statements),
    };
    await assert.rejects(status.inspectD1Migrations(racing, next), /schema changed/);
    await binding.prepare('DROP TABLE raced').all();
    evidence.statusDiscoveryRaceRefused = true;
    return evidence;
  } finally {
    await mf?.dispose();
    evidence.disposed = true;
    report.native = evidence;
  }
}
