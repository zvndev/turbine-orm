/** Actual normal-package D1 collision gate. All generated consumers and failures are retained. */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createConnection, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { generateD1Files } from '../../d1/generate.js';
import { defineSchema } from '../../schema-builder.js';
import { schemaDefToMetadata } from '../../schema-metadata.js';

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const archive = process.env.TURBINE_D1_GENERATION_ARCHIVE;
assert(archive && existsSync(archive), 'An actual normal archive is required');
assert.equal(sha(readFileSync(archive)), process.env.TURBINE_D1_GENERATION_SHA256);
assert(['v22.16.0', 'v24.10.0'].includes(process.version), 'Exact supported runtime required');
const root = mkdtempSync(join(tmpdir(), 'd1-record-'));
const report = {
  root,
  node: process.version,
  archive,
  archiveSha256: sha(readFileSync(archive)),
  commands: [],
  native: [],
  emissions: [],
  omissions: [],
  success: false,
};
const save = () => writeFileSync(join(root, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
const put = (path, content) => {
  assert(!existsSync(path), `Refuse existing ${path}`);
  writeFileSync(path, content);
};
let commandId = 0;
let commandCwd = root;
function run(binary, args, cwd = commandCwd, failurePattern) {
  const id = commandId++,
    c = spawnSync(binary, args, { cwd, encoding: 'utf8', timeout: 60_000 });
  put(join(root, `command-${id}.stdout`), c.stdout ?? '');
  put(join(root, `command-${id}.stderr`), c.stderr ?? '');
  report.commands.push({
    id,
    binary,
    args,
    cwd,
    status: c.status,
    signal: c.signal,
    error: c.error?.message,
    expectedFailure: !!failurePattern,
    stdout: `command-${id}.stdout`,
    stderr: `command-${id}.stderr`,
  });
  save();
  if (failurePattern) {
    assert.notEqual(c.status, 0);
    assert.match(c.stdout + c.stderr, failurePattern);
  } else assert.equal(c.status, 0, c.stdout + c.stderr);
  return c;
}
function unpack(name) {
  const path = join(root, name, 'node_modules/turbine-orm');
  mkdirSync(path, { recursive: true });
  run('/usr/bin/tar', ['-xzf', archive, '--strip-components=1', '-C', path]);
  return path;
}
const forbidden =
  /^(?:pg(?:\/|$)|pg-[^/]+|mysql2(?:\/|$)|mssql(?:\/|$)|@libsql\/|@neondatabase\/|miniflare(?:\/|$)|node:(?!async_hooks$))/;
function guard(source) {
  return {
    name: 'record-runtime-boundary',
    setup(builder) {
      builder.onResolve({ filter: /.*/ }, (args) => {
        if (forbidden.test(args.path)) throw Error(`Forbidden D1 runtime dependency: ${args.path}`);
        if (args.path === 'node:async_hooks')
          return args.namespace === 'builtin-bridge'
            ? { path: args.path, external: true }
            : { path: args.path, namespace: 'builtin-bridge' };
        if (source && args.path === 'turbine-orm/d1') return { path: resolve('src/d1.ts') };
      });
      builder.onLoad({ filter: /.*/, namespace: 'builtin-bridge' }, () => ({
        contents: "export {AsyncLocalStorage} from 'node:async_hooks';",
        loader: 'js',
      }));
    },
  };
}
const listen = (server, port) =>
  new Promise((yes, no) => {
    server.once('error', no);
    server.listen(port, '127.0.0.1', () => yes(server.address().port));
  });
const close = (server) => new Promise((yes, no) => server.close((error) => (error ? no(error) : yes())));
async function freePort(port = 0) {
  const server = createServer();
  const chosen = await listen(server, port);
  await close(server);
  return chosen;
}
async function refusedPort(port) {
  await new Promise((yes, no) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.destroy();
      no(Error('Listener survived disposal'));
    });
    socket.once('error', (error) => {
      assert.equal(error.code, 'ECONNREFUSED');
      yes();
    });
  });
}
const require = createRequire(import.meta.url);
assert.equal(require('miniflare/package.json').version, '4.20260730.0');
assert.equal(require('workerd/package.json').version, '1.20260730.1');
const { Miniflare } = require('miniflare');
const ddl = [
  'CREATE TABLE records(id INTEGER PRIMARY KEY, title TEXT NOT NULL, tenant_id INTEGER NOT NULL, active BOOLEAN NOT NULL, created_at TIMESTAMP NOT NULL, payload BLOB)',
  'CREATE TABLE record_notes(id INTEGER PRIMARY KEY, record_id INTEGER NOT NULL REFERENCES records(id), body TEXT NOT NULL)',
];
async function native(label, script, action) {
  const nativeRoot = join(root, label);
  mkdirSync(nativeRoot);
  const port = await freePort();
  const row = { label, root: nativeRoot, host: '127.0.0.1', port, freeProbe: true, closed: false };
  report.native.push(row);
  save();
  console.log(JSON.stringify({ nativeStart: label, root: nativeRoot, port, privateLoopbackOnly: true }));
  const mf = new Miniflare({
    modules: true,
    script,
    compatibilityDate: '2026-01-01',
    compatibilityFlags: ['nodejs_compat'],
    d1Databases: { DB: 'record-catalog' },
    d1Persist: join(nativeRoot, 'd1'),
    host: '127.0.0.1',
    port,
  });
  try {
    row.origin = String(await mf.ready);
    const binding = await mf.getD1Database('DB');
    for (const sql of ddl) await binding.prepare(sql).all();
    row.result = await action(mf, binding);
    return row.result;
  } finally {
    await mf.dispose();
    await refusedPort(port);
    assert.equal(await freePort(port), port);
    row.closed = true;
    row.refused = true;
    row.rebound = true;
    row.listenersAfter = execFileSync('/usr/bin/ss', ['-H', '-lntup'], { encoding: 'utf8' });
    assert.equal(row.listenersAfter, '');
    save();
  }
}
try {
  const generationLibrary = unpack('generation');
  symlinkSync(resolve('node_modules/pg'), join(root, 'generation/node_modules/pg'));
  const esm = await import(pathToFileURL(join(generationLibrary, 'dist/d1/generate.js')));
  const cjs = createRequire(join(root, 'generation/load.cjs'))('turbine-orm/d1/generate');
  const catalog = await import(pathToFileURL(join(generationLibrary, 'dist/d1/introspect.js')));
  const schema = await native(
    'catalog',
    'export default {fetch(){return new Response("catalog")}}',
    async (_mf, binding) => catalog.introspectD1(binding, { logger: {} }),
  );
  put(join(root, 'native-schema.json'), `${JSON.stringify(schema, null, 2)}\n`);
  assert(schema.tables.records && schema.tables.record_notes);
  assert.equal(schema.tables.records.columns.length, 6);
  const relation = Object.keys(schema.tables.record_notes.relations)[0];
  assert(relation);
  report.relation = relation;
  const codeFirst = schemaDefToMetadata(
    defineSchema({ records: { id: { type: 'integer', primaryKey: true }, title: { type: 'text', notNull: true } } }),
  );
  for (const input of [codeFirst, schema])
    assert.deepEqual(esm.generateD1Files(input, { noTimestamp: true }), generateD1Files(input, { noTimestamp: true }));
  assert.deepEqual(cjs.generateD1Files(schema, { noTimestamp: true }), generateD1Files(schema, { noTimestamp: true }));
  const library = unpack('consumer'),
    consumerRoot = join(root, 'consumer');
  commandCwd = consumerRoot;
  for (const name of ['@types/node', 'undici-types', '@cloudflare/workers-types']) {
    const target = join(consumerRoot, 'node_modules', name);
    mkdirSync(join(target, '..'), { recursive: true });
    symlinkSync(resolve('node_modules', name), target);
  }
  const absent = createRequire(join(consumerRoot, 'absent.cjs'));
  for (const name of ['pg', 'pg-pool', 'pg-types', 'mysql2', 'mssql', '@libsql/client', 'miniflare'])
    assert.throws(() => absent(name), { code: 'MODULE_NOT_FOUND' });
  const compiler = resolve('node_modules/typescript/bin/tsc');
  const template = readFileSync(resolve('src/test/fixtures/d1-record-consumer.ts.txt'), 'utf8')
    .replace('with:{records:true}', `with:{${relation}:true}`)
    .replace('related[0]!.records?', `related[0]!.${relation}?`);
  const negative = readFileSync(resolve('src/test/fixtures/d1-record-negative.ts.txt'), 'utf8');
  assert(!negative.includes('@ts-'));
  for (const format of ['module', 'commonjs']) {
    const dir = join(consumerRoot, format);
    mkdirSync(join(dir, 'generated'), { recursive: true });
    put(join(dir, 'package.json'), JSON.stringify({ type: format }));
    const files = (format === 'module' ? esm : cjs).generateD1Files(schema, { noTimestamp: true });
    for (const [n, v] of Object.entries(files)) {
      put(join(dir, 'generated', n), v);
      report.emissions.push({ format, name: n, sha256: sha(v) });
    }
    assert.match(files['types.ts'], /export interface Record/);
    assert.doesNotMatch(files['index.ts'], /Record<string,/);
    put(join(dir, 'consumer.ts'), template);
    put(join(dir, 'negative.ts'), negative);
    const args = [
      '--strict',
      '--skipLibCheck',
      'false',
      '--exactOptionalPropertyTypes',
      '--noUncheckedIndexedAccess',
      '--target',
      'ES2023',
      '--module',
      'NodeNext',
      '--moduleResolution',
      'NodeNext',
      '--types',
      'node',
      '--outDir',
      join(dir, 'out'),
      join(dir, 'consumer.ts'),
    ];
    run(process.execPath, [compiler, ...args]);
    const neg = run(
      process.execPath,
      [compiler, ...args.slice(0, -1), '--noEmit', join(dir, 'negative.ts')],
      consumerRoot,
      /TS2339/,
    );
    assert.equal((neg.stdout.match(/error TS/g) || []).length, 14, neg.stdout);
    assert.doesNotMatch(neg.stdout, /TS2315|TS2307|TS2688/);
    const loaded =
      format === 'module'
        ? await import(pathToFileURL(join(dir, 'out/consumer.js')))
        : createRequire(join(dir, 'load.cjs'))('./out/consumer.js');
    await native(
      `node-${format}`,
      'export default {fetch(){return new Response("node bridge")}}',
      async (_mf, binding) => {
        const result = await loaded.run(binding);
        assert.deepEqual(result, { ok: true, groups: 15 });
        return result;
      },
    );
    const graph = await build({
      entryPoints: [join(dir, 'consumer.ts')],
      bundle: true,
      write: false,
      format: 'esm',
      platform: 'neutral',
      conditions: ['workerd'],
      metafile: true,
      plugins: [guard(false)],
    });
    const inputs = Object.keys(graph.metafile.inputs);
    assert(inputs.some((p) => /\/dist\/(?:cjs\/)?d1.js$/.test(p)));
    assert(!inputs.some((p) => /\/sqlite.js$|\/node_modules\/(pg|pg-pool|pg-types)\//.test(p)));
    put(join(dir, 'worker.mjs'), graph.outputFiles[0].text);
    put(join(dir, 'graph.json'), JSON.stringify(graph.metafile, null, 2));
    await native(`worker-${format}`, graph.outputFiles[0].text, async (mf) => {
      const response = await mf.dispatchFetch('http://localhost/');
      const text = await response.text();
      assert.equal(response.status, 200, text);
      assert.deepEqual(JSON.parse(text), { ok: true, groups: 15 });
      return JSON.parse(text);
    });
    run(process.execPath, [
      compiler,
      '--strict',
      '--skipLibCheck',
      'false',
      '--target',
      'ES2023',
      '--module',
      'ESNext',
      '--moduleResolution',
      'Bundler',
      '--types',
      'node',
      '--noEmit',
      join(dir, 'consumer.ts'),
    ]);
    // Preserve a real missing-export diagnostic and restore exact installed bytes.
    const manifestPath = join(library, 'package.json'),
      original = readFileSync(manifestPath, 'utf8'),
      manifest = JSON.parse(original);
    delete manifest.exports['./d1'];
    writeFileSync(manifestPath, JSON.stringify(manifest));
    try {
      run(process.execPath, [compiler, ...args, '--noEmit'], consumerRoot, /Cannot find module 'turbine-orm\/d1'/);
      report.omissions.push({ format, missing: './d1', refused: true });
    } finally {
      writeFileSync(manifestPath, original);
    }
    // Caller-declared global Record and imported custom Record remain exact.
    const customDir = join(dir, 'custom');
    mkdirSync(join(customDir, 'generated'), { recursive: true });
    const customSchema = schemaDefToMetadata(
      defineSchema({
        notes: {
          id: { type: 'integer', primaryKey: true },
          declared: { type: 'jsonb', tsType: 'Record<string, number>', notNull: true },
          imported: { type: 'jsonb', notNull: true },
        },
      }),
    );
    const custom = (format === 'module' ? esm : cjs).generateD1Files(customSchema, {
      noTimestamp: true,
      columnTypes: { 'notes.imported': "import('../custom.js').Record<'kept'>" },
    });
    for (const [n, v] of Object.entries(custom)) put(join(customDir, 'generated', n), v);
    put(join(customDir, 'custom.ts'), 'export type Record<T>={custom:T};\n');
    put(
      join(customDir, 'consumer.ts'),
      "import type {Note} from './generated/types.js'; declare const note:Note; const n:number=note.declared.x!;const s:'kept'=note.imported.custom;void [n,s];\n",
    );
    run(process.execPath, [compiler, ...args.slice(0, -1), '--noEmit', join(customDir, 'consumer.ts')]);
    const publicDir = join(dir, 'public-override');
    mkdirSync(join(publicDir, 'generated'), { recursive: true });
    const publicSchema = schemaDefToMetadata(
      defineSchema({
        records: { id: { type: 'integer', primaryKey: true }, snapshot: { type: 'jsonb', tsType: 'Record' } },
      }),
    );
    for (const [n, v] of Object.entries(esm.generateD1Files(publicSchema, { noTimestamp: true })))
      put(join(publicDir, 'generated', n), v);
    put(
      join(publicDir, 'consumer.ts'),
      "import type {Record} from './generated/index.js';declare const row:Record;const id:number|undefined=row.snapshot?.id;void id;\n",
    );
    run(process.execPath, [compiler, ...args.slice(0, -1), '--noEmit', join(publicDir, 'consumer.ts')]);
  }
  const dir = join(consumerRoot, 'module');
  const sourceGraph = await build({
    entryPoints: [join(dir, 'consumer.ts')],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'neutral',
    metafile: true,
    plugins: [guard(true)],
  });
  assert(Object.keys(sourceGraph.metafile.inputs).some((p) => p.endsWith('src/d1.ts')));
  put(join(dir, 'source.mjs'), sourceGraph.outputFiles[0].text);
  put(join(dir, 'source-graph.json'), JSON.stringify(sourceGraph.metafile, null, 2));
  const source = await import(pathToFileURL(join(dir, 'source.mjs')));
  await native('node-source', 'export default {fetch(){return new Response("source")}}', async (_mf, binding) => {
    const result = await source.run(binding);
    assert.deepEqual(result, { ok: true, groups: 15 });
    return result;
  });
  await native('worker-source', sourceGraph.outputFiles[0].text, async (mf) => {
    const response = await mf.dispatchFetch('http://localhost/');
    const text = await response.text();
    assert.equal(response.status, 200, text);
    assert.deepEqual(JSON.parse(text), { ok: true, groups: 15 });
    return JSON.parse(text);
  });
  for (const dependency of ['pg', 'node:sqlite', 'node:fs', 'node:net', 'mysql2', 'mssql', '@libsql/client'])
    await assert.rejects(
      build({
        stdin: { contents: `import '${dependency}';`, resolveDir: dir },
        bundle: true,
        write: false,
        platform: 'neutral',
        plugins: [guard(false)],
        logLevel: 'silent',
      }),
      /Forbidden D1 runtime dependency/,
    );
  report.success = true;
  console.log(`D1_RECORD_NATIVE_PASS ${root}`);
} catch (error) {
  report.failure = String(error instanceof Error ? error.stack : error);
  throw error;
} finally {
  save();
  console.log(`Retained closed D1 Record fixture: ${root}`);
}
