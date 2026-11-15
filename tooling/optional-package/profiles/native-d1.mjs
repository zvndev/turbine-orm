/** Real local workerd; launch this tooling process under the existing owner. */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { ddl } from './fixture.mjs';
const [consumer, root, portArg] = process.argv.slice(2);
assert.ok(consumer && root && !existsSync(root));
const port = Number(portArg);
assert.ok(port > 1024);
mkdirSync(root);
const require = createRequire(import.meta.url);
const installed = createRequire(join(consumer, 'package.json'));
const expected = JSON.parse(readFileSync(join(consumer, 'expected-namespaces.json')));
const report = { success: false, node: process.version, port, root, versions: {}, results: [] };
for (const name of ['miniflare', 'workerd', 'esbuild', '@cloudflare/workers-types']) report.versions[name] = require(`${name}/package.json`).version;
assert.equal(report.versions.miniflare, '4.20260730.0');
assert.equal(report.versions.workerd, '1.20260730.1');
const guard = {
  name: 'installed-profile-worker-boundary',
  setup(builder) {
    builder.onResolve({ filter: /.*/ }, args => {
      if (/^(?:pg(?:\/|$)|pg-[^/]+|mysql2(?:\/|$)|mssql(?:\/|$)|@libsql\/|@neondatabase\/|miniflare(?:\/|$)|node:(?!async_hooks$))/.test(args.path)) throw Error(`Forbidden Worker runtime input: ${args.path}`);
      if (args.path === 'node:async_hooks') return args.namespace === 'builtin-bridge' ? { path: args.path, external: true } : { path: args.path, namespace: 'builtin-bridge' };
    });
    builder.onLoad({ filter: /.*/, namespace: 'builtin-bridge' }, () => ({ contents: "export { AsyncLocalStorage } from 'node:async_hooks';", loader: 'js' }));
  },
};
async function native(script, body) {
  const mf = new Miniflare({ modules: true, script, compatibilityDate: '2026-01-01', compatibilityFlags: ['nodejs_compat'], d1Databases: { DB: 'optional-runtime' }, d1Persist: false, host: '127.0.0.1', port });
  try {
    const url = await mf.ready;
    report.results.push({ ready: url.toString() });
    const binding = await mf.getD1Database('DB');
    for (const sql of ddl) await binding.prepare(sql).all();
    await body(mf, binding);
  } finally { await mf.dispose(); }
}
try {
  for (const format of ['esm', 'cjs']) {
    const worker = join(consumer, format, 'worker.mjs');
    writeFileSync(worker, "import {run} from './consumer.js'; export default {async fetch(_request,env){try{return Response.json(await run(env.DB))}catch(error){return new Response(String(error.stack??error),{status:500})}}};");
    const bundle = await build({ entryPoints: [worker], bundle: true, write: false, format: 'esm', platform: 'neutral', conditions: ['workerd'], metafile: true, plugins: [guard] });
    const inputs = Object.keys(bundle.metafile.inputs);
    assert.ok(inputs.some(name => name.endsWith('/dist/d1.js') || name.endsWith('/dist/cjs/d1.js')));
    assert.ok(!inputs.some(name => /\/(?:sqlite\.js|node_modules\/(?:pg|pg-pool|pg-types)\/)/.test(name)));
    writeFileSync(join(root, `generated-${format}.js`), bundle.outputFiles[0].text);
    writeFileSync(join(root, `generated-${format}-metafile.json`), JSON.stringify(bundle.metafile, null, 2));
    await native(bundle.outputFiles[0].text, async (mf, binding) => {
      const response = await mf.dispatchFetch('http://localhost/');
      const text = await response.text();
      assert.equal(response.status, 200, text);
      assert.deepEqual(JSON.parse(text), { ok: true, groups: 17 });
      assert.equal((await binding.prepare('SELECT 1 AS alive').first()).alive, 1);
      report.results.push({ format, workerGeneratedGroups: 17, callerBindingAlive: true });
    });
    // Actual Node import/require generated factories execute against native D1,
    // independently of the bundler's Worker export resolution.
    const modulePath = join(consumer, format, 'consumer.js');
    const generated = format === 'esm' ? await import(pathToFileURL(modulePath)) : installed(modulePath);
    await native('export default {fetch(){return new Response("native binding")}}', async (_mf, binding) => {
      assert.deepEqual(await generated.run(binding), { ok: true, groups: 17 });
      report.results.push({ format, nodeGeneratedGroups: 17 });
    });
  }
  const namespaceWorker = join(consumer, 'namespace-worker.ts');
  writeFileSync(namespaceWorker, `import * as root from 'turbine-orm'; import * as d1 from 'turbine-orm/d1'; import * as sql from 'turbine-orm/sql';
import type { SchemaMetadata } from 'turbine-orm';
const schema: SchemaMetadata = root.schemaDefToMetadata(root.defineSchema({items:{id:{type:'integer',primaryKey:true}}}));
export default {async fetch(_request: unknown, env: {DB: import('turbine-orm/d1').D1DatabaseBinding}) {
const namespaces={'.':Object.keys(root).sort(),'./d1':Object.keys(d1).sort(),'./sql':Object.keys(sql).sort()};
const expected=${JSON.stringify(expected)};
if(JSON.stringify(namespaces)!==JSON.stringify(expected))throw Error('Worker namespaces '+JSON.stringify(namespaces));
const client=root.turbineD1(env.DB,schema); const rows=await client.rawUnsafe('SELECT ?1 AS "__proto__", ?2 AS "constructor", ?3 AS "toString"','own','ctor','method');
const row=rows[0]!; if(!Object.hasOwn(row,'__proto__')||row.__proto__!=='own'||Object.keys(row).join(',')!=='__proto__,constructor,toString'||Object.getPrototypeOf(row)!==Object.prototype)throw Error('own proto fields');
await client.disconnect();return Response.json({ok:true,namespaces,protoOwnKeys:true});}};`);
  // This TypeScript file is also checked strictly by the parent proof after it
  // exists; esbuild is only the runtime bundler, never the type proof.
  const bundle = await build({ entryPoints: [namespaceWorker], bundle: true, write: false, format: 'esm', platform: 'neutral', conditions: ['workerd'], metafile: true, plugins: [guard] });
  assert.ok(Object.keys(bundle.metafile.inputs).some(name => name.endsWith('/dist/unavailable-pg.js')));
  assert.ok(!Object.keys(bundle.metafile.inputs).some(name => name.endsWith('/dist/optional-pg.js')));
  writeFileSync(join(root, 'namespace-worker.js'), bundle.outputFiles[0].text);
  writeFileSync(join(root, 'namespace-metafile.json'), JSON.stringify(bundle.metafile, null, 2));
  await native(bundle.outputFiles[0].text, async mf => {
    const response = await mf.dispatchFetch('http://localhost/'); const text = await response.text();
    assert.equal(response.status, 200, text); const value = JSON.parse(text); assert.equal(value.ok, true);
    report.results.push({ workerNamespaces: value.namespaces, protoOwnKeys: value.protoOwnKeys, workerdUnavailableCondition: true });
  });
  report.success = true;
} finally {
  await new Promise((accept, reject) => { const probe = createServer(); probe.once('error', reject); probe.listen(port, '127.0.0.1', () => probe.close(accept)); });
  report.portReleased = true;
  writeFileSync(join(root, 'report.json'), JSON.stringify(report, null, 2));
}
console.log(JSON.stringify({ ok: true, node: process.version, results: report.results }));
